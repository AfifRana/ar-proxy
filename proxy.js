#!/usr/bin/env node
'use strict';

/**
 * AgentRouter proxy for GitHub Copilot Chat BYOK.
 *
 * Replaces two manual patches to extension.js:
 *   1. Forces the AgentRouter User-Agent (Copilot strips/normalises it).
 *   2. Drops malformed SSE chunks that crash the stream parser
 *      ("Cannot read properties of null (reading 'usage')").
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const util = require('util');
const { URL } = require('url');

const argv = process.argv.slice(2);

function hasFlag(...names) {
  return argv.some((arg) => names.includes(arg));
}

function flagValue(name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('-')) {
    return argv[index + 1];
  }
  return undefined;
}

const logFile = flagValue('--log-file') || process.env.AR_LOG_FILE || '';

const CONFIG = {
  port: Number(process.env.AR_PROXY_PORT || 8317),
  host: process.env.AR_PROXY_HOST || '127.0.0.1',
  // upstream: process.env.AR_UPSTREAM || 'https://agentrouter.org/v1',
  upstream: process.env.AR_UPSTREAM || 'https://agentrouter.org',
  userAgent:
    process.env.AR_USER_AGENT ||
    'claude-cli/0.0.0 (external, cli) (node/v20.0.0)',
  verbose: process.env.AR_VERBOSE === '1' || hasFlag('-v', '--verbose'),
  // Full traffic dump: request/response status, headers and bodies.
  log: process.env.AR_LOG === '1' || hasFlag('--log') || Boolean(logFile),
  logFile,
  logBodyLimit: Number(
    flagValue('--log-body-limit') || process.env.AR_LOG_BODY_LIMIT || 64 * 1024
  ),
  // Off by default so API keys never land in a log file.
  logSecrets: process.env.AR_LOG_SECRETS === '1' || hasFlag('--log-secrets'),
};

const upstreamUrl = new URL(CONFIG.upstream);
const upstreamBasePath = upstreamUrl.pathname.replace(/\/+$/, '');
const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

// Copilot sets these itself; they must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function log(...args) {
  if (CONFIG.verbose) console.log('[ar-proxy]', ...args);
}

const logStream = CONFIG.logFile
  ? fs.createWriteStream(CONFIG.logFile, { flags: 'a' })
  : null;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'cookie',
  'set-cookie',
  'openai-organization',
]);

function trace(...args) {
  if (!CONFIG.log) return;
  const line = `[ar-proxy ${new Date().toISOString()}] ${args
    .map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: null })))
    .join(' ')}`;
  if (logStream) logStream.write(line + '\n');
  else console.log(line);
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CONFIG.logSecrets && SENSITIVE_HEADERS.has(key.toLowerCase())) {
      out[key] = '<redacted>';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function formatBody(chunks, byteLength) {
  if (byteLength === 0) return '<empty>';
  const body = Buffer.concat(chunks).toString('utf8');
  const suffix =
    byteLength > CONFIG.logBodyLimit
      ? `\n<truncated, ${byteLength} bytes total>`
      : '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2) + suffix;
  } catch {
    return body + suffix;
  }
}

/** Collects up to logBodyLimit bytes for tracing without buffering whole streams. */
function createBodyRecorder() {
  const chunks = [];
  let captured = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (captured >= CONFIG.logBodyLimit) return;
      const slice = chunk.slice(0, CONFIG.logBodyLimit - captured);
      chunks.push(slice);
      captured += slice.length;
    },
    format() {
      return formatBody(chunks, total);
    },
  };
}

let requestSeq = 0;

function buildUpstreamHeaders(incoming) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'user-agent') continue; // replaced below
    headers[key] = value;
  }
  headers['User-Agent'] = CONFIG.userAgent;
  headers['Accept-Encoding'] = 'identity'; // keep SSE frames readable
  return headers;
}

/**
 * Rewrites an SSE stream, discarding frames whose JSON payload is not an
 * object. Everything else (including `[DONE]`) passes through untouched.
 */
function createSseSanitizer(onWrite) {
  let buffer = '';

  function flushFrame(frame) {
    if (!frame) return;

    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'));

    // Comments / non-data frames (e.g. ping) pass through.
    if (dataLines.length === 0) {
      onWrite(frame + '\n\n');
      return;
    }

    const payload = dataLines
      .map((line) => line.slice(5).trim())
      .join('');

    if (payload === '[DONE]') {
      onWrite(frame + '\n\n');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      log('dropped unparsable SSE frame:', payload.slice(0, 200));
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      log('dropped null/non-object SSE frame:', payload.slice(0, 200));
      return;
    }

    onWrite(frame + '\n\n');
  }

  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        flushFrame(buffer.slice(0, index).replace(/\r/g, ''));
        buffer = buffer.slice(index + 2);
      }
    },
    end() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) flushFrame(rest.replace(/\r/g, ''));
    },
  };
}

const server = http.createServer((req, res) => {
  const incomingPath = req.url.startsWith('/') ? req.url : `/${req.url}`;
  const targetPath = upstreamBasePath + incomingPath;
  const id = ++requestSeq;
  const startedAt = Date.now();

  log(req.method, incomingPath, '->', upstreamUrl.host + targetPath);

  const upstreamHeaders = buildUpstreamHeaders(req.headers);

  if (CONFIG.log) {
    trace(`#${id} <-- ${req.method} ${incomingPath}`);
    trace(`#${id} client request headers`, redactHeaders(req.headers));
    trace(
      `#${id} --> ${req.method} ${upstreamUrl.protocol}//${upstreamUrl.host}${targetPath}`
    );
    trace(`#${id} upstream request headers`, redactHeaders(upstreamHeaders));

    const reqBody = createBodyRecorder();
    req.on('data', (chunk) => reqBody.push(chunk));
    req.on('end', () => trace(`#${id} request body:\n${reqBody.format()}`));
  }

  const upstreamReq = https.request(
    {
      agent,
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      method: req.method,
      path: targetPath,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        responseHeaders[key] = value;
      }

      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isSse = contentType.includes('text/event-stream');

      if (CONFIG.log) {
        trace(
          `#${id} <-- upstream ${upstreamRes.statusCode} ${
            upstreamRes.statusMessage || ''
          } (${isSse ? 'sse' : contentType || 'no content-type'})`
        );
        trace(
          `#${id} upstream response headers`,
          redactHeaders(upstreamRes.headers)
        );

        const resBody = createBodyRecorder();
        upstreamRes.on('data', (chunk) => resBody.push(chunk));
        upstreamRes.on('end', () =>
          trace(
            `#${id} response body (${Date.now() - startedAt}ms):\n${resBody.format()}`
          )
        );
      }

      if (!isSse) {
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }

      delete responseHeaders['content-length'];
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      res.flushHeaders?.();

      const sanitizer = createSseSanitizer((frame) => {
        if (CONFIG.log) trace(`#${id} sse -> client:\n${frame.trimEnd()}`);
        res.write(frame);
      });
      upstreamRes.on('data', (chunk) => sanitizer.push(chunk));
      upstreamRes.on('end', () => {
        sanitizer.end();
        res.end();
      });
      upstreamRes.on('error', (err) => {
        log('upstream stream error:', err.message);
        trace(`#${id} upstream stream error: ${err.message}`);
        res.end();
      });
    }
  );

  upstreamReq.on('error', (err) => {
    log('upstream request error:', err.message);
    trace(`#${id} upstream request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: `proxy: ${err.message}` } }));
  });

  req.pipe(upstreamReq);
});

server.on('clientError', (err, socket) => {
  log('client error:', err.message);
  socket.destroy();
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`ar-proxy listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  upstream:   ${CONFIG.upstream}`);
  console.log(`  user-agent: ${CONFIG.userAgent}`);
  console.log(
    `  logging:    ${
      CONFIG.log
        ? `on -> ${CONFIG.logFile || 'stdout'} (bodies up to ${
            CONFIG.logBodyLimit
          } bytes${CONFIG.logSecrets ? ', secrets shown' : ', secrets redacted'})`
        : 'off (use --log or --log-file=<path>)'
    }`
  );
  console.log('Point chatLanguageModels.json baseUrl/url at this address.');
});
