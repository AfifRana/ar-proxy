# ar-proxy

A local proxy for AgentRouter + GitHub Copilot Chat BYOK (Bring Your Own Key). This tool eliminates the need for manual patches to `extension.js`.

## Purpose

This proxy server provides two critical fixes for AgentRouter integration with GitHub Copilot Chat:

1. **Forces AgentRouter User-Agent**: Preserves the correct User-Agent header that Copilot would otherwise strip or normalize.
2. **Fixes malformed SSE chunks**: Drops malformed Server-Sent Events (SSE) chunks that crash the stream parser with "Cannot read properties of null (reading 'usage')" errors.

## Installation

```bash
npm install
```

## Usage

### Quick Start

Run the proxy in the foreground:

```bash
npm start
```

Or use Node directly:

```bash
node proxy.js
```

### Windows (Minimized Window)

Run the included batch script to start the proxy in a minimized window:

```bash
start-proxy.cmd
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
AR_PROXY_PORT=8320 AR_VERBOSE=1 npm start
```

**Log all traffic to a file:**

```bash
AR_LOG_FILE=traffic.log npm start
```

**Custom upstream server:**

```bash
AR_UPSTREAM=https://custom-agentrouter.example.com npm start
```

**Windows batch with arguments:**

```bash
start-proxy.cmd --log --verbose
```

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
node proxy.js --verbose
# or
AR_VERBOSE=1 npm start
```

### Full Traffic Logging

Logs complete request and response details (headers and bodies):

```bash
node proxy.js --log
# or
node proxy.js --log-file=traffic.log
```

Limit logged body size:

```bash
node proxy.js --log --log-body-limit=16384
```

## License

See LICENSE file for details.

## Support

For issues or questions, refer to the AgentRouter documentation or the project's issue tracker.
