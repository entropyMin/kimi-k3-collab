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
3. Use `analyze` for review, discussion, architecture, planning, and critique. Use `execute` only when the user already authorized edits, and pass explicit allowed paths under the working directory.
4. Continue independent Codex work while K3 runs when safe. Do not edit the same files concurrently with an execution delegation.
5. Retrieve K3's final JSON, independently evaluate its claims and edits, and report `session_id`, `focus`, `server_reported_model`, and `verified_k3`.

## Thin-wrapper contract

Make exactly one shell call and return stdout verbatim:

```powershell
$task = @'
Review the proposed caching architecture and challenge its failure modes.
'@
$bridge = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'plugins\kimi-k3-collab\scripts\kimi-k3.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $bridge -Action delegate -Mode analyze -Focus engineering -Cwd "C:\path\to\project" -Prompt $task
```

For implementation, add `-Mode execute -AllowedPath "src;tests"`. If the native wrapper is interrupted, recover with `-Action latest`, then use `-Action result -SessionId ID -WaitSeconds 30`. Never claim K3 was used unless the JSON reports `verified_k3: true`.
