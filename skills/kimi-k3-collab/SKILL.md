---
name: kimi-k3-collab
description: Proactively delegate material engineering design, architecture discussion, code or design review, technical tradeoff analysis, implementation planning, reliability, security, maintainability, testing strategy, frontend visual design, UI/UX aesthetics, typography, color, layout, motion, image aesthetics, screenshot comparison, and visual QA to persistent Kimi K3 through one native Codex subagent. Use when an independent K3 perspective can materially improve a decision or implementation. Do not use for trivial edits, routine commands, straightforward build failures, or questions that need no independent review.
---

# Kimi K3 Collaboration

Use the single `kimi-k3-collaborator` native Codex role as a thin forwarding wrapper. Select a preference, not a different agent:

- `engineering`: architecture, correctness, tradeoffs, APIs, data, reliability, security, performance, maintainability, tests, migrations, and operations.
- `visual`: hierarchy, layout, typography, color, interaction, responsive behavior, imagery, accessibility, and visual QA.
- `general`: mixed product/engineering/design work or no dominant preference.

## Workflow

1. Tell the user Kimi K3 is being called explicitly and state the mode and focus.
2. Spawn a native Codex subagent using `kimi-k3-collaborator` when role selection is exposed. Otherwise spawn one normal native subagent named `kimi_k3_collaborator` and give it the thin-wrapper contract below.
3. Use `analyze` for review, discussion, architecture, planning, and critique. Analyze sessions keep Kimi plan mode off and expose only read-only inspection tools. Use `execute` only when the user already authorized edits, and pass explicit allowed paths under the working directory.
4. Continue independent Codex work while K3 runs when safe. Do not edit the same files concurrently with an execution delegation.
5. Keep K3's original Markdown report visible, then independently discuss its claims, agreements, disagreements, and resulting decisions. Report `session_id`, `focus`, `server_reported_model`, and `verified_k3` in human-readable text. Do not expose the bridge JSON in the subagent conversation. After execution, compare the working-tree diff with the allowed paths; the allowlist is a K3 instruction, not an OS sandbox.

## Transparent-wrapper contract

Use a bounded event-stream call. It starts the persistent job, prints real K3 actions and report deltas, persists the WebSocket cursor, and ends with the `Session` footer:

```text
node "$HOME/plugins/kimi-k3-collab/scripts/kimi-k3.mjs" delegate --format text --max-wait-seconds 105 --mode analyze --focus engineering --cwd "/path/to/project" --prompt "Review the proposed caching architecture and challenge its failure modes."
```

If the footer still says running, reopen the same WebSocket stream from its persisted cursor:

```text
node "$HOME/plugins/kimi-k3-collab/scripts/kimi-k3.mjs" watch --format text --session-id SESSION --wait-seconds 105
```

Prefer `--prompt-file "/path/to/utf8-task.txt"` for multiline or shell-sensitive task text; standard input is also accepted when neither prompt option is supplied. Use `--prompt` only with the current shell's correct literal quoting. For implementation, use `--mode execute --allowed-path "src;tests"`. Reopening a 105-second stream window is only a command-duration workaround, not REST polling; stop after 17 running windows. If the native wrapper is interrupted, recover the session id with `latest --format text`, then continue with `watch`. Return K3's Markdown report and plain-text verification footer, not JSON, hidden thinking, or a wrapper summary. Never claim K3 was used unless the footer reports the exact model `kimi-code/k3` as verified.
