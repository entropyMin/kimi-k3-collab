# Changelog

## Unreleased

## 0.5.1 - 2026-07-24

- Disable non-Git execute by default and require explicit confirmation for direct writes.
- Replace browser bearer URLs with short-lived one-time tickets and a loopback authenticated gateway.
- Add default-sensitive path checks, structured external-write blocking, unsandboxed shell warnings, and metadata-only security audit records.
- Add the `KIMI_K3_SERVER_WRAPPER` contract for OS sandbox/container launchers.

## 0.5.0 - 2026-07-24

### Security

- Canonicalize Git/source paths and single-writer lock identities.
- Reject symbolic links and junctions inside execute-mode allowed scopes.
- Preserve scope-violating and ignored-output worktrees for review.
- Remove network tools from the default analysis allowlist and enforce the same tool policy in the relay and result stream.

### Fixed

- Handle macOS `/var` and `/private/var` path aliases.
- Report ignored generated files instead of returning `no_changes` and deleting them.
- Include K3 Markdown in structured tool results when a host drops text content.
- Recover stale non-Git writer locks only after the previous Kimi session is confirmed inactive or missing.
- Persist terminal Provider errors and return them immediately through await and Stop handoffs.
- Discover Kimi Code 0.29 foreground Web instances, read `host_version`, and launch the supported `kimi web --no-open` server when the legacy `server run` command is absent.
- Discover Kimi Code 0.29 instances in the MCP panel path and preflight the panel service before creating a K3 job.
- Restore the persisted session mode before recreating an event relay after an MCP restart, and fail closed when the mode is unavailable.
- Reuse durable Provider terminal-error classification in the live relay without reconnect churn.
- Close idle relays while their WebSocket remains healthy.
- Remove no-change worktree branches and recreate follow-up worktrees from the persisted base commit.
- Finalize an unread execute handoff before follow-up and restore the prior handoff when prompt submission fails.
- Return preserved worktree paths with manual review guidance.
- Add conservative orphan inspection and session-targeted worktree or branch cleanup.
- Remove known terminal worktree directories only when they are already empty.

### Testing

- Run all CI matrix jobs with fail-fast disabled.
- Test the minimum Node.js runtime and supported Node.js LTS releases on every CI operating system.
- Add fake Kimi REST/WebSocket integration coverage that requires no Kimi login.
- Exercise the real MCP server and bridge through fake-Kimi analyze and isolated execute handoffs.
- Cover submodule execute isolation and paths containing spaces, Unicode, and semicolons.
- Test Kimi Code 0.26.0 as the legacy baseline and prioritize the latest stable 0.29.0.
- Make `npm run test:real-kimi` verify a real session, prompt, WebSocket stream, result handoff, and durable record.
