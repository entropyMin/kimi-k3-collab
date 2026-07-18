# Kimi K3 Collab

Kimi K3 Collab lets Codex start a persistent `kimi-code/k3` session and stream K3's authentic Markdown, tool calls, tasks, and subagents into an MCP App. The panel consumes Kimi's pushed events directly instead of asking Codex to rewrite them as a subagent transcript.

The plugin is cross-platform and uses only the Node.js standard library. It does not add a forwarding model, a React build, or a status polling loop.

## How it works

1. `start_k3_collaboration` creates a verified K3 session and returns immediately.
2. The plugin's MCP server keeps one authenticated loopback WebSocket open for that Kimi session.
3. Codex renders `ui://kimi-k3/live-session-v3.html` as an MCP App component.
4. The component receives raw Kimi frames through the official MCP Apps host bridge and renders Markdown, tools, tasks, subagents, and state changes inside Codex.
5. The user or Codex can send a deliberate follow-up to the same session with `send_k3_message`.

The Kimi server remains the source of truth. Session snapshots are stored under `$KIMI_CODE_HOME/codex-jobs` (default: `~/.kimi-code/codex-jobs`).

## What users see

- K3's original messages and Markdown
- Real file, search, tool, task, and subagent activity supported by Kimi Code
- Direct input to the same K3 session
- Full-screen and browser fallbacks

This is an MCP App panel, not a native Codex subagent identity. Codex can exchange explicit messages with K3 while the user sees Kimi's original event stream directly.

## No polling

Normal collaboration has no model-driven status loop or token-consuming retries:

- Starting a session returns immediately.
- Kimi pushes events into one persistent server-side WebSocket.
- The private app-only `receive_k3_events` call waits until an event arrives, then returns a batch through the host bridge. The component renews this long-held receive without a Codex model turn.
- A relay with no panel receives for three minutes closes its socket and releases its bounded event buffer.
- `get_k3_status` and `get_k3_result` are explicit fallback tools only.
- Network reconnects may occur after a broken event connection. Reconnect is recovery, not scheduled polling.

## Security

- The bridge accepts only `127.0.0.1`, `localhost`, or `::1` Kimi server locks.
- The component never receives the Kimi bearer token as a connection credential; the browser-fallback URL in component-only `_meta` embeds it in the URL fragment.
- The token is never returned in model-visible text or `structuredContent`.
- Only the authenticated **Open Kimi Code** browser-fallback URL is placed in component-only tool-result `_meta`.
- The MCP App makes no loopback HTTP, WebSocket, or iframe connection. Its CSP has no loopback connect allowlist.
- `receive_k3_events` is private, app-only, and unavailable to the model.
- The panel does not embed Kimi Code as an iframe. **Open Kimi Code** remains an authenticated browser fallback.
- Execute-mode path allowlists are instructions to K3, not an operating-system sandbox. Codex must review the resulting diff.

## Requirements

- Node.js 18.18 or newer on Windows, macOS, or Linux
- Kimi Code CLI with local-server and Web UI support (`0.26.0` tested), installed and authenticated
- A Codex or ChatGPT host with personal plugins, MCP, and MCP Apps UI support

The bridge finds Kimi on `PATH` or under `$KIMI_CODE_HOME/bin` (default: `~/.kimi-code/bin`). Set `KIMI_CODE_BIN` only when the executable lives elsewhere.

## Start a collaboration

```text
start_k3_collaboration {
  prompt: "Review this architecture and challenge the failure modes.",
  mode: "analyze",
  focus: "engineering",
  cwd: "/path/to/project"
}
```

For authorized edits:

```text
start_k3_collaboration {
  prompt: "Implement the approved change and verify it.",
  mode: "execute",
  focus: "general",
  cwd: "/path/to/project",
  allowed_paths: ["src", "tests"]
}
```

## Continue the same session

```text
send_k3_message {
  session_id: "SESSION",
  prompt: "Codex disagrees with the retry policy. Compare both options."
}
```

Reopen the direct panel:

```text
open_k3_panel { session_id: "SESSION" }
```

Omit `session_id` to open the latest recorded session.

## Explicit fallback tools

Use these only when the user asks Codex to inspect or stop the K3 session:

```text
get_k3_status { session_id: "SESSION" }
get_k3_result { session_id: "SESSION" }
cancel_k3_job { session_id: "SESSION" }
```

## Host fallback

MCP Apps-compatible hosts with app-initiated tool calls render the pushed event panel inline. The component does not need loopback network access. If a host lacks the MCP Apps tool bridge, use **Open Kimi Code**; the fallback opens the same authenticated session.

CLI clients without MCP Apps UI still expose the control tools and readable fallback results, but they cannot render the live panel.

## Local installation

```sh
git clone https://github.com/entropyMin/kimi-k3-collab.git kimi-k3-collab
cd kimi-k3-collab
node scripts/self-test.mjs
```

Register that directory as `kimi-k3-collab` in the personal Codex marketplace, install `kimi-k3-collab@personal`, and start a new Codex task so the updated skill, tools, and MCP resource are loaded.
