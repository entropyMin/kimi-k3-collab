# Kimi K3 Collab

This cross-platform Codex plugin lets the main Codex task collaborate directly with persistent Kimi K3. It borrows the useful foreground-event and durable-background-job pattern from OpenAI's `codex-plugin-cc` without adding a second Codex model as a forwarding subagent.

The Kimi server remains the source of truth. Every job verifies that the server-selected model is `kimi-code/k3`. Job snapshots and readable action traces are stored under `$KIMI_CODE_HOME/codex-jobs` (default: `~/.kimi-code/codex-jobs`).

Foreground work uses one `collaborate_with_k3` MCP call. The MCP server reopens bounded WebSocket windows internally, forwards genuine K3 actions as progress notifications, and returns the durable original Markdown report. No model turn polls status or decides to call `watch` again.

Background work uses `start_k3_job`, which returns immediately and starts a detached event follower that records K3 actions. `get_k3_status`, `get_k3_result`, and `cancel_k3_job` run only on explicit user request. They return readable text; transport JSON stays in structured MCP content.

Event delivery is at-least-once, so a few action lines can repeat after forced recovery. The final report is fetched from the durable Kimi session and is not reconstructed from progress lines.

## Requirements

- Node.js 18.18 or newer on Windows, macOS, or Linux.
- Kimi Code CLI with local-server support (`0.26.0` tested), installed and authenticated.
- A Codex build with personal plugins and MCP support.

The bridge uses only the Node.js standard library; no npm install is required. It finds Kimi on `PATH` or under `$KIMI_CODE_HOME/bin` (default: `~/.kimi-code/bin`). Set `KIMI_CODE_BIN` only when the executable lives elsewhere.

Analysis jobs keep Kimi plan mode disabled and use manual permission mode. Built-in read-only inspection tools proceed normally; shell and mutation approval requests are rejected with feedback so K3 can recover and finish the review instead of terminating. Execute-mode allowlists are explicit instructions to K3, not an operating-system sandbox, so Codex must review the resulting diff.

## Foreground

```text
collaborate_with_k3 {
  prompt: "Review this design.",
  mode: "analyze",
  focus: "engineering",
  cwd: "/path/to/project"
}
```

Resume an interrupted foreground call with its durable session ID:

```text
collaborate_with_k3 { session_id: "SESSION" }
```

## Background

```text
start_k3_job {
  prompt: "Review this design.",
  mode: "analyze",
  focus: "engineering",
  cwd: "/path/to/project"
}
```

Later, only when the user asks:

```text
get_k3_status { session_id: "SESSION" }
get_k3_result { session_id: "SESSION" }
cancel_k3_job { session_id: "SESSION" }
```

## Local installation

```sh
git clone https://github.com/entropyMin/kimi-k3-collab "$HOME/plugins/kimi-k3-collab"
node "$HOME/plugins/kimi-k3-collab/scripts/self-test.mjs"
```

Register that directory as `kimi-k3-collab` in the personal Codex marketplace, install `kimi-k3-collab@personal`, and start a new Codex task so the updated skill and MCP tools are loaded.
