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

### Testing

- Run all CI matrix jobs with fail-fast disabled.
- Add fake Kimi REST/WebSocket integration coverage that requires no Kimi login.
- Keep real installed-Kimi verification as `npm run test:real-kimi`.
