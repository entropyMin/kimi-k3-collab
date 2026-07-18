---
name: kimi-k3-collab
description: Proactively collaborate directly with persistent Kimi K3 for material engineering design, architecture discussion, code or design review, technical tradeoffs, implementation planning, reliability, security, maintainability, testing strategy, frontend visual design, UI/UX aesthetics, typography, color, layout, motion, image aesthetics, screenshot comparison, and visual QA. Use when an independent K3 perspective can materially improve a decision or implementation. Do not use for trivial edits, routine commands, straightforward build failures, or questions that need no independent review.
---

# Kimi K3 Collaboration

Call the plugin MCP tools directly from the main Codex task. Do not spawn a Codex subagent as a K3 wrapper. K3 speaks and acts in the direct pushed-event panel; do not imitate K3 in Codex commentary.

Select one focus:

- `engineering`: architecture, correctness, APIs, data, reliability, security, performance, maintainability, tests, migrations, and operations.
- `visual`: hierarchy, layout, typography, color, interaction, responsive behavior, imagery, accessibility, and visual QA.
- `general`: mixed product, engineering, and design work.

## Workflow

1. Tell the user Kimi K3 is being called explicitly and state the mode and focus.
2. Call `start_k3_collaboration` once. It creates a persistent K3 session, returns immediately, and renders Kimi's pushed Markdown and action events through MCP Apps.
3. Let the user inspect K3 output, tools, subagents, and original Markdown in that panel. Do not narrate a fake K3 action stream in the Codex transcript.
4. Use `send_k3_message` when Codex has a deliberate follow-up, challenge, or response for the same session. Do not send while K3 is already working.
5. Use `open_k3_panel` to reopen an existing or latest session. Call `get_k3_status`, `get_k3_result`, or `cancel_k3_job` only when the user explicitly asks Codex to inspect, discuss, or stop the session. Never create an automatic status loop.
6. Use `mode=analyze` for review, architecture, planning, and critique. Use `mode=execute` only after the user authorizes edits, and pass explicit `allowed_paths` under the absolute `cwd`.
7. Report `session_id`, `focus`, `server_reported_model`, and `verified_k3` from the start result. Never claim K3 was used unless the server reports the exact model `kimi-code/k3` as verified.
8. After execute mode, compare the working-tree diff with `allowed_paths`; the allowlist is a K3 instruction, not an operating-system sandbox.

The MCP server owns Kimi's authenticated loopback-only WebSocket. The panel receives raw frames through a private app-only long-held host-bridge call, so it neither receives the bearer token nor needs loopback network access. This transport uses no model turns or status polling. If the host cannot render MCP Apps or make app-initiated tool calls, use the panel's Kimi Code browser fallback.
