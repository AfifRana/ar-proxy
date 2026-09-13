# ar-proxy

A local proxy for AgentRouter + GitHub Copilot Chat BYOK (Bring Your Own Key). This tool eliminates the need for manual patches to `extension.js`.

## Purpose

This proxy server provides two critical fixes for AgentRouter integration with GitHub Copilot Chat:

1. **Forces AgentRouter User-Agent**: Preserves the correct User-Agent header that Copilot would otherwise strip or normalize.
2. **Fixes malformed SSE chunks**: Drops malformed Server-Sent Events (SSE) chunks that crash the stream parser with "Cannot read properties of null (reading 'usage')" errors.

## Project Layout

```
node/           Node.js implementation (proxy.js, package.json)
python/         Python implementation (proxy.py, standard library only)
start-proxy.cmd Windows launcher, picks the language to run
```

## Installation

No separate install step is required to try the proxy — see [Quick Start](#quick-start) below. If you want to run the Node.js implementation directly (rather than through `start-proxy.cmd`), install its dependencies first:

```bash
cd node
npm install
```

The Python implementation only uses the standard library, so there's nothing to install for it.

Both implementations share the same defaults:

- Listen address: `127.0.0.1:8317`
- Upstream: `https://agentrouter.org`
- AgentRouter User-Agent: `claude-cli/0.0.0 (external, cli) (node/v20.0.0)`
- Malformed SSE frames are filtered before they reach Copilot

## Usage

### Quick Start

Run the included launcher, which starts the proxy in a minimized window:

```bash
start-proxy.cmd
```

Pick an implementation explicitly, or forward flags to it:

```bash
start-proxy.cmd node
start-proxy.cmd python
start-proxy.cmd python --verbose
```

It defaults to Node.js when no implementation is given. Set `AR_PROXY_LANG=python` (or `node`) to change the default without passing an argument each time.

### Run a specific implementation directly

Use this to run one implementation in the foreground, e.g. for development or on macOS/Linux where `start-proxy.cmd` doesn't apply.

**Node.js:**

```bash
cd node
npm start
# or: node proxy.js
```

**Python:**

```bash
python python/proxy.py
# or: python3 python/proxy.py
```

## Configuration

Configure the proxy using environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AR_PROXY_PORT` | `8317` | Port to listen on |
| `AR_PROXY_HOST` | `127.0.0.1` | Host to bind to |
| `AR_UPSTREAM` | `https://agentrouter.org` | Upstream AgentRouter URL |
| `AR_USER_AGENT` | `claude-cli/0.0.0 (external, cli) (node/v20.0.0)` | User-Agent header to send upstream |
| `AR_VERBOSE` | `0` | Set to `1` to enable verbose output (can also use `-v` or `--verbose` flag) |
| `AR_LOG` | `0` | Set to `1` to log full traffic (request/response status, headers, and bodies) |
| `AR_LOG_FILE` | (empty) | Write traffic logs to a file instead of stdout |
| `AR_LOG_BODY_LIMIT` | `65536` (64KB) | Maximum body size to log (in bytes) |

### Examples

**Start on port 8320 with verbose logging:**

```bash
AR_PROXY_PORT=8320 AR_VERBOSE=1 node node/proxy.js
AR_PROXY_PORT=8320 AR_VERBOSE=1 python python/proxy.py
```

**Log all traffic to a file:**

```bash
node node/proxy.js --log-file=traffic.log
python python/proxy.py --log-file=traffic.log
```

**Custom upstream server:**

```bash
AR_UPSTREAM=https://custom-agentrouter.example.com node node/proxy.js
AR_UPSTREAM=https://custom-agentrouter.example.com python python/proxy.py
```

**Windows launcher with arguments:**

```bash
start-proxy.cmd node --log --verbose
start-proxy.cmd python --verbose
```

(The same environment variables apply when running via `npm start` from the `node/` folder.)

## How It Works

The proxy acts as a man-in-the-middle between Copilot Chat and AgentRouter:

1. Listens on the configured host and port (default: `127.0.0.1:8317`)
2. Accepts incoming requests from Copilot Chat
3. Forwards requests to the upstream AgentRouter server
4. Fixes the User-Agent header to match AgentRouter requirements
5. Filters malformed SSE chunks from responses
6. Streams the cleaned response back to the client

## Logging

### Verbose Mode

Shows basic request/response information:

```bash
node node/proxy.js --verbose
python python/proxy.py --verbose
```

### Full Traffic Logging

Logs complete request and response details (headers and bodies):

```bash
node node/proxy.js --log
python python/proxy.py --log
# or write to a file
node node/proxy.js --log-file=traffic.log
python python/proxy.py --log-file=traffic.log
```

Limit logged body size:

```bash
node node/proxy.js --log --log-body-limit=16384
python python/proxy.py --log --log-body-limit=16384
```

## License

See LICENSE file for details.

## Support

For issues or questions, refer to the AgentRouter documentation or the project's issue tracker.
