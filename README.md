# Kimi K3 Collab

Kimi K3 Collab lets Codex and persistent `kimi-code/k3` work on complementary tasks at the same time. It streams K3's authentic Markdown, tool calls, tasks, and subagents into an MCP App, then hands K3's completed report directly back to Codex for discussion and synthesis.

The plugin is cross-platform and uses only the Node.js standard library. It does not add a forwarding model, a React build, or a status polling loop.

## How it works

1. Codex splits the work and calls `start_k3_collaboration` with K3's independent subtask. The verified K3 session returns immediately.
2. The plugin's MCP server keeps one authenticated loopback WebSocket open for that Kimi session.
3. Codex renders `ui://kimi-k3/live-session-v3.html` as an MCP App component.
4. The component receives raw Kimi frames through the official MCP Apps host bridge and renders Markdown, tools, tasks, subagents, and state changes inside Codex.
5. Codex continues its own different subtask, then calls `await_k3_result`. One event-driven wait returns K3's original Markdown into Codex's model context.
6. The user or Codex can respond to K3 with `send_k3_message`; the next K3 result returns through the same handoff.
7. A plugin-bundled Stop hook prevents Codex from silently ending while a started K3 session still has an undelivered result.

For `execute` mode in a Git project, the bridge creates a per-session temporary branch and worktree. K3 never writes the source checkout. When the turn finishes, the bridge rejects out-of-scope changes, squashes the allowed changes into one local commit, checks for overlapping source changes, removes the temporary worktree, and returns the branch/commit to Codex for review. It never merges or cherry-picks automatically.

The Kimi server remains the source of truth. Session snapshots are stored under `$KIMI_CODE_HOME/codex-jobs` and active isolated checkouts under `$KIMI_CODE_HOME/codex-worktrees` (default root: `~/.kimi-code`).

## What users see

- K3's original messages and Markdown
- Real file, search, tool, task, and subagent activity supported by Kimi Code
- Direct input to the same K3 session
- K3's completed report delivered directly into Codex for reconciliation
- An isolated Git branch/commit handoff for authorized K3 edits
- Full-screen and browser fallbacks

This is an MCP App panel plus a model-visible result handoff, not a native Codex subagent identity. Codex and K3 can own different work while the user sees Kimi's original event stream directly.

## No polling

Normal collaboration has no model-driven status loop or token-consuming retries:

- Starting a session returns immediately.
- Kimi pushes events into one persistent server-side WebSocket.
- The private app-only `receive_k3_events` call waits until an event arrives, then returns a batch through the host bridge. The component renews this long-held receive without a Codex model turn.
- `await_k3_result` performs one bounded, event-driven wait after Codex finishes its own subtask. It does not issue periodic status requests.
- The Stop hook uses the same event wait only as a safety net when Codex tries to finish before collecting K3's report.
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
- Kimi Code 0.26 may still advertise write-capable tools in `analyze` mode. The plugin uses manual permission mode, rejects approval-gated tools, and aborts any observed non-read-only tool call; this is a safety guard, not an operating-system sandbox.
- Git execute mode rejects source changes that already overlap `allowed_paths`, validates K3's final changed paths, and preserves a violating worktree for inspection. The worktree is isolation, not an operating-system sandbox; Codex must still review the returned commit.
- If `cwd` is not in Git, execute mode changes it directly under a persistent single-writer lock. Codex must pause all local writes until K3 completes or is cancelled. The lock prevents a second K3 writer but cannot technically lock Codex itself.

## Requirements

- Node.js 18.18 or newer on Windows, macOS, or Linux
- Kimi Code CLI with local-server and Web UI support (`0.26.0` tested), installed and authenticated
- A Codex or ChatGPT host with personal plugins, MCP, and MCP Apps UI support
- Codex lifecycle-hook support for the automatic stop-time handoff safety net
- Git on `PATH` for isolated parallel `execute` mode; non-Git directories fall back to the single-writer protocol

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

Each Codex task uses one persistent K3 session. Continue its work with `send_k3_message` instead of starting a second K3 session.

```text
send_k3_message {
  session_id: "SESSION",
  prompt: "Codex disagrees with the retry policy. Compare both options."
}
```

In a Git project, `allowed_paths` are translated into K3's isolated worktree. Existing uncommitted source changes may coexist only when they do not overlap those paths. The completion handoff reports one of:

- `ready`: source `HEAD` did not move and no source changes overlap K3's files.
- `review_required`: source `HEAD` moved; inspect the returned commit against the new base.
- `conflict_likely`: source working-tree changes overlap K3's changed files.
- `scope_violation` or `integration_error`: nothing is merged and the isolated worktree is preserved for manual inspection.

Review the returned commit with Git, then cherry-pick it only when appropriate. The plugin intentionally performs no automatic integration. Follow-up K3 turns recreate the same isolated worktree from the handoff branch and produce another scoped commit.

## Receive K3 in Codex

After Codex finishes its own complementary subtask, it waits for K3 once:

```text
await_k3_result {
  session_id: "SESSION",
  wait_seconds: 100
}
```

The tool returns K3's original Markdown directly to Codex. If K3 needs longer and no useful Codex work remains, the trusted Stop hook takes over the longer event wait. Without that hook, Codex may make one later bounded await; if K3 is still running, it should ask whether to keep waiting or cancel. During automatic waiting it must not narrate repeated waiting, run Git/status filler checks, or use status/result tools for polling.

The installed plugin also contributes a Stop hook. Review and trust that hook when Codex prompts you; in the CLI it appears under `/hooks`. Without hook trust, direct `await_k3_result` still works, but the automatic “do not finish before K3 reports” safety net is disabled. The hook can recover the active K3 handoff from the current Codex transcript when a host path skips `PostToolUse`, then wait event-first for up to nine minutes within Codex's documented 600-second hook timeout.

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
