#!/usr/bin/env python3
"""
Python rewrite of AfifRana/ar-proxy for AgentRouter + GitHub Copilot BYOK.

Uses only the Python standard library.

Defaults:
  listen:   http://127.0.0.1:8317
  upstream: https://agentrouter.org

It:
- forwards Copilot requests to AgentRouter
- forces the User-Agent expected by AgentRouter
- forces Accept-Encoding: identity
- filters malformed SSE frames that can break Copilot's stream parser

Environment variables:
  AR_PROXY_PORT       default 8317
  AR_PROXY_HOST       default 127.0.0.1
  AR_UPSTREAM         default https://agentrouter.org
  AR_USER_AGENT       default claude-cli/0.0.0 (external, cli) (node/v20.0.0)
  AR_VERBOSE          1 enables verbose logging
  AR_LOG              1 logs request/response metadata and bodies
  AR_LOG_SECRETS      1 disables header redaction (not recommended)
  AR_LOG_BODY_LIMIT   default 65536
"""

import argparse
import http.client
import http.server
import json
import os
import ssl
import time
from urllib.parse import urlsplit

DEFAULT_USER_AGENT = "claude-cli/0.0.0 (external, cli) (node/v20.0.0)"

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
}

SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "api-key", "x-api-key",
    "cookie", "set-cookie", "openai-organization",
}

CONFIG = None


def env_bool(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    def __init__(self, args):
        self.host = os.getenv("AR_PROXY_HOST", "127.0.0.1")
        self.port = int(os.getenv("AR_PROXY_PORT", "8317"))
        self.upstream = os.getenv("AR_UPSTREAM", "https://agentrouter.org").rstrip("/")
        self.user_agent = os.getenv("AR_USER_AGENT", DEFAULT_USER_AGENT)
        self.verbose = args.verbose or env_bool("AR_VERBOSE")
        self.log = args.log or env_bool("AR_LOG")
        self.log_secrets = env_bool("AR_LOG_SECRETS")
        self.log_body_limit = int(os.getenv("AR_LOG_BODY_LIMIT", "65536"))

        parsed = urlsplit(self.upstream)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"Invalid AR_UPSTREAM: {self.upstream}")

        self.scheme = parsed.scheme
        self.hostname = parsed.hostname
        self.port_upstream = parsed.port or (443 if parsed.scheme == "https" else 80)
        self.base_path = parsed.path.rstrip("/")


def vlog(*args):
    if CONFIG.verbose:
        print("[ar-proxy]", *args, flush=True)


def tlog(*args):
    if CONFIG.log:
        print("[ar-proxy]", *args, flush=True)


def redact(headers):
    out = {}
    for k, v in headers.items():
        out[k] = "<redacted>" if (
            not CONFIG.log_secrets and k.lower() in SENSITIVE_HEADERS
        ) else v
    return out


def make_connection():
    if CONFIG.scheme == "https":
        return http.client.HTTPSConnection(
            CONFIG.hostname,
            CONFIG.port_upstream,
            timeout=120,
            context=ssl.create_default_context(),
        )
    return http.client.HTTPConnection(
        CONFIG.hostname,
        CONFIG.port_upstream,
        timeout=120,
    )


def upstream_headers(handler):
    headers = {}
    for key, value in handler.headers.items():
        low = key.lower()
        if low in HOP_BY_HOP or low == "user-agent":
            continue
        headers[key] = value

    headers["User-Agent"] = CONFIG.user_agent
    headers["Accept-Encoding"] = "identity"
    return headers


class SseSanitizer:
    def __init__(self):
        self.buffer = b""

    @staticmethod
    def sanitize(frame):
        if not frame:
            return None

        frame = frame.replace(b"\r", b"")
        data_lines = [x for x in frame.split(b"\n") if x.startswith(b"data:")]

        if not data_lines:
            return frame + b"\n\n"

        payload = b"".join(x[5:].strip() for x in data_lines)

        if payload == b"[DONE]":
            return frame + b"\n\n"

        try:
            value = json.loads(payload.decode("utf-8"))
        except Exception:
            vlog("dropped unparsable SSE frame:", payload[:200])
            return None

        if not isinstance(value, (dict, list)):
            vlog("dropped null/non-object SSE frame:", payload[:200])
            return None

        return frame + b"\n\n"

    def feed(self, chunk):
        self.buffer += chunk
        out = []

        while True:
            i1 = self.buffer.find(b"\n\n")
            i2 = self.buffer.find(b"\r\n\r\n")
            indexes = [i for i in (i1, i2) if i != -1]
            if not indexes:
                break

            idx = min(indexes)
            sep_len = 4 if self.buffer[idx:idx+4] == b"\r\n\r\n" else 2
            frame = self.buffer[:idx]
            self.buffer = self.buffer[idx + sep_len:]

            cleaned = self.sanitize(frame)
            if cleaned is not None:
                out.append(cleaned)

        return out

    def finish(self):
        rest = self.buffer.strip()
        self.buffer = b""
        if not rest:
            return []
        cleaned = self.sanitize(rest)
        return [cleaned] if cleaned is not None else []


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if CONFIG.verbose:
            super().log_message(fmt, *args)

    def handle_proxy(self):
        incoming_path = self.path if self.path.startswith("/") else "/" + self.path
        target_path = CONFIG.base_path + incoming_path

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""

        headers = upstream_headers(self)
        if body:
            headers["Content-Length"] = str(len(body))

        vlog(self.command, incoming_path, "->", f"{CONFIG.hostname}{target_path}")

        if CONFIG.log:
            tlog("client headers:", redact(dict(self.headers)))
            tlog("upstream headers:", redact(headers))
            if body:
                tlog("request body:", body[:CONFIG.log_body_limit].decode("utf-8", "replace"))

        conn = make_connection()

        try:
            conn.request(
                self.command,
                target_path,
                body=body if body else None,
                headers=headers,
            )
            resp = conn.getresponse()

            response_headers = {}
            for key, value in resp.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    response_headers[key] = value

            content_type = resp.getheader("Content-Type", "")
            is_sse = "text/event-stream" in content_type.lower()

            if CONFIG.log:
                tlog("upstream status:", resp.status, resp.reason)
                tlog("upstream response headers:", redact(response_headers))

            self.send_response(resp.status, resp.reason)

            if is_sse:
                response_headers.pop("Content-Length", None)
                response_headers.pop("content-length", None)
                response_headers["Connection"] = "close"

            for key, value in response_headers.items():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)

            self.end_headers()

            if self.command == "HEAD":
                return

            if not is_sse:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                self.wfile.flush()
                return

            sanitizer = SseSanitizer()
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                for frame in sanitizer.feed(chunk):
                    self.wfile.write(frame)
                    self.wfile.flush()

            for frame in sanitizer.finish():
                self.wfile.write(frame)

            self.wfile.flush()
            self.close_connection = True

        except Exception as exc:
            vlog("proxy error:", repr(exc))
            payload = json.dumps({"error": {"message": f"proxy: {exc}"}}).encode()
            try:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True
            except Exception:
                pass
        finally:
            conn.close()

    do_GET = handle_proxy
    do_POST = handle_proxy
    do_PUT = handle_proxy
    do_PATCH = handle_proxy
    do_DELETE = handle_proxy
    do_OPTIONS = handle_proxy
    do_HEAD = handle_proxy


def main():
    global CONFIG

    parser = argparse.ArgumentParser(
        description="AgentRouter proxy for GitHub Copilot BYOK"
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--log", action="store_true")
    args = parser.parse_args()

    CONFIG = Config(args)

    server = http.server.ThreadingHTTPServer((CONFIG.host, CONFIG.port), ProxyHandler)

    print(f"ar-proxy listening on http://{CONFIG.host}:{CONFIG.port}")
    print(f"  upstream:   {CONFIG.upstream}")
    print(f"  user-agent: {CONFIG.user_agent}")
    print("Point GitHub Copilot Custom Endpoint/base URL to this address.")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping proxy...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
