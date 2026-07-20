---
name: kimi-k3-collab
description: Proactively collaborate directly with persistent Kimi K3 for material engineering design, architecture discussion, code or design review, technical tradeoffs, implementation planning, reliability, security, maintainability, testing strategy, frontend visual design, UI/UX aesthetics, typography, color, layout, motion, image aesthetics, screenshot comparison, and visual QA. Use when an independent K3 perspective can materially improve a decision or implementation. Do not use for trivial edits, routine commands, straightforward build failures, or questions that need no independent review.
---

# Kimi K3 Collaboration

Call the plugin MCP tools directly from the main Codex task. Do not spawn a Codex subagent as a K3 wrapper. K3 speaks and acts in the direct pushed-event panel, and its completed report returns directly through `await_k3_result`; do not imitate K3 in Codex commentary.

Select one focus:

- `engineering`: architecture, correctness, APIs, data, reliability, security, performance, maintainability, tests, migrations, and operations.
- `visual`: hierarchy, layout, typography, color, interaction, responsive behavior, imagery, accessibility, and visual QA.
- `general`: mixed product, engineering, and design work.

## Workflow

1. Tell the user Kimi K3 is being called explicitly and state the mode and focus.
2. Split the work before calling K3. Give the one K3 session a bounded, independent subtask with a clear deliverable; keep a different complementary subtask for Codex. Do not ask both agents to duplicate the whole task unless an independent comparison is the point.
3. Call `start_k3_collaboration` once. It creates a persistent K3 session, returns immediately, and renders Kimi's pushed Markdown and action events through MCP Apps.
4. Continue Codex's own subtask while K3 works. Let the user inspect K3 output, tools, subagents, and original Markdown in the panel; do not narrate a fake K3 action stream in the Codex transcript.
5. After Codex's subtask is ready, call `await_k3_result` with the session id before the final response. It uses one event-driven wait rather than status polling and returns K3's original Markdown directly into Codex's context. If it reports `blocked`, address the requested interaction. If it reports `running`, do only genuinely useful remaining Codex work. When none remains, let the trusted Stop hook perform the longer event wait. If that hook is unavailable, make one later await without filler work; if K3 is still running, tell the user once and ask whether to keep waiting or cancel. During automatic waiting, do not repeatedly narrate the same waiting state, inspect Git/status as filler, or use `get_k3_status`/`get_k3_result` for polling. The user can keep observing K3 in the panel meanwhile.
6. Read and reconcile K3's report explicitly. Use `send_k3_message` for a deliberate response, challenge, or next subtask, then call `await_k3_result` again for that turn. Do not send while K3 is already working.
7. Use `open_k3_panel` to reopen an existing or latest session. `get_k3_status` and `get_k3_result` are diagnostic fallbacks; `cancel_k3_job` stops the current K3 prompt. The plugin's Stop hook is a safety net that keeps Codex from silently finishing with an undelivered K3 result.
8. Use `mode=analyze` for review, architecture, planning, and critique. Use `mode=execute` only after the user authorizes edits, and pass explicit `allowed_paths` under the absolute `cwd`. Keep Codex's concurrent writes outside those paths.
9. Verify internally that `server_reported_model` is exactly `kimi-code/k3` and `verified_k3` is true before treating the collaborator as K3. Do not expose session ids, focus, model slugs, verification fields, or collaboration boilerplate in commentary or the final answer unless the user asks or the metadata is needed to diagnose a problem. Never append a collaboration-metadata sentence to the final answer.
10. Inspect the execute handoff before integrating it. In Git projects, the plugin runs K3 in an isolated worktree, rejects existing source changes that overlap `allowed_paths`, validates the completed path set, and returns a local branch/commit without merging. Review `changed_paths` and `integration_state`; cherry-pick only when `ready`, or after resolving `review_required`/`conflict_likely`. Treat `scope_violation` and `integration_error` as blocked manual-review states; the worktree is preserved.
11. When the start result reports `isolation=single-writer`, the directory is not in Git. Stop all Codex writes in that directory until `await_k3_result` or `cancel_k3_job` releases the advisory lock. Do not describe non-Git execute as parallel-safe.

The MCP server owns Kimi's authenticated loopback-only WebSocket. The panel receives raw frames through a private app-only long-held host-bridge call, so it neither receives the bearer token nor needs loopback network access. `await_k3_result` is the separate model-visible K3-to-Codex handoff. Neither path uses periodic status polling. If the host cannot render MCP Apps or make app-initiated tool calls, use the panel's Kimi Code browser fallback.
