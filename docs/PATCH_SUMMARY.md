# AgentRouter Proxy Patch Summary

**Purpose:** Make GitHub Copilot Chat work with AgentRouter without touching `extension.js`.

`ar-proxy` sits between Copilot Chat and AgentRouter as a local HTTP proxy
(`node/proxy.js`, `python/proxy.py`). Point `chatLanguageModels.json` at the
proxy address instead of AgentRouter directly. It applies two fixes in
transit, so no manual edits to Copilot's `extension.js` are needed.

## Fix 1: Force the AgentRouter User-Agent header

**Location:** `node/proxy.js` → `buildUpstreamHeaders()`, `python/proxy.py` → equivalent header handling

**What it does:**
- Strips whatever User-Agent the incoming request has (Copilot normalises or drops custom User-Agent headers before they reach the network layer)
- Sets its own upstream User-Agent header, taken from `CONFIG.userAgent` (env var `AR_USER_AGENT`, default `claude-cli/0.0.0 (external, cli) (node/v20.0.0)`)

**Why needed:**
- AgentRouter rejects requests with "unauthorized client detected" unless that specific User-Agent is present
- Copilot Chat does not expose a way to set this header itself

**Result:** Every request forwarded to AgentRouter carries the expected User-Agent, regardless of what Copilot Chat sent.

## Fix 2: Drop malformed SSE frames

**Location:** `node/proxy.js` → `createSseSanitizer()` / `flushFrame()`, `python/proxy.py` → equivalent SSE filtering

**What it does:**
- Buffers each SSE frame from the upstream response and parses its `data:` payload as JSON
- If the payload is not valid JSON, or parses to something other than an object (e.g. `null`), the frame is dropped instead of forwarded
- `[DONE]` and non-data frames (comments/pings) always pass through

**Why needed:**
- Some AgentRouter responses contain empty or non-object JSON chunks
- Copilot Chat's stream parser crashes on these with: `TypeError: Cannot read properties of null (reading 'usage')`
- That crash aborted the entire chat response

**Result:** Malformed chunks are filtered out before Copilot ever sees them, so the stream parser no longer crashes.
