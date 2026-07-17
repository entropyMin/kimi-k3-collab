---
name: kimi-k3-collab
description: Proactively collaborate directly with persistent Kimi K3 for material engineering design, architecture discussion, code or design review, technical tradeoffs, implementation planning, reliability, security, maintainability, testing strategy, frontend visual design, UI/UX aesthetics, typography, color, layout, motion, image aesthetics, screenshot comparison, and visual QA. Use when an independent K3 perspective can materially improve a decision or implementation. Do not use for trivial edits, routine commands, straightforward build failures, or questions that need no independent review.
---

# Kimi K3 Collaboration

Call the plugin MCP tools directly from the main Codex task. Do not spawn a Codex subagent as a K3 wrapper.

Select one focus:

- `engineering`: architecture, correctness, APIs, data, reliability, security, performance, maintainability, tests, migrations, and operations.
- `visual`: hierarchy, layout, typography, color, interaction, responsive behavior, imagery, accessibility, and visual QA.
- `general`: mixed product, engineering, and design work.

## Workflow

1. Tell the user Kimi K3 is being called explicitly and state the mode and focus.
2. Use `collaborate_with_k3` once for normal foreground work. It waits on pushed events internally and returns genuine K3 actions plus the durable original Markdown report.
3. Use `start_k3_job` once when the user requests background execution or the task is likely to be long-running. Return its session ID and continue without polling.
4. Call `get_k3_status`, `get_k3_result`, or `cancel_k3_job` only when the user explicitly asks about that background job. Never create an automatic status loop or spend model turns polling.
5. Use `mode=analyze` for review, architecture, planning, and critique. Use `mode=execute` only after the user authorizes edits, and pass explicit `allowed_paths` under the absolute `cwd`.
6. Keep K3's action trace and original Markdown visible. Then independently discuss agreements, disagreements, and resulting decisions. Report `session_id`, `focus`, `server_reported_model`, and `verified_k3` in readable text. Do not expose bridge JSON or hidden reasoning.
7. After execute mode, compare the working-tree diff with `allowed_paths`; the allowlist is a K3 instruction, not an operating-system sandbox.

If a foreground call is interrupted, resume it once with `collaborate_with_k3 { session_id }`. Never claim K3 was used unless the result reports the exact model `kimi-code/k3` as verified.
