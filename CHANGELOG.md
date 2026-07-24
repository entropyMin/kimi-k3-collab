# Changelog

## Unreleased

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

### Testing

- Run all CI matrix jobs with fail-fast disabled.
- Add fake Kimi REST/WebSocket integration coverage that requires no Kimi login.
- Test Kimi Code 0.26.0 as the legacy baseline and prioritize the latest stable 0.29.0.
- Make `npm run test:real-kimi` verify a real session, prompt, WebSocket stream, result handoff, and durable record.
