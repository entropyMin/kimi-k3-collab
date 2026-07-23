# Security

## Supported security posture

`analyze` mode is defense in depth, not a sandbox. It uses a local-only read-tool allowlist, manual permissions, approval rejection, and live/result-stream checks for disallowed tools. Repository content read by K3 is sent to the configured model; the loopback service coordinates requests but does not imply local inference.

Git `execute` mode protects the source checkout with a temporary worktree and validates the Git-visible handoff. It canonicalizes source paths, rejects symbolic links or junctions in allowed scopes, reports ignored outputs, and preserves worktrees that require review.

## Out of scope

The plugin cannot prevent a process from writing an absolute path, modifying an external file, or creating, using, and deleting a link before final inspection. Use an operating-system sandbox or container when write prevention is required. Non-Git execution uses an advisory single-writer lock and changes the target directory directly.

## Data flow

1. The MCP server reads the authenticated Kimi lock/token from the local Kimi home.
2. REST and WebSocket traffic is restricted to loopback hosts.
3. The MCP App receives event frames through the host bridge and does not receive the bearer token as a connection credential.
4. The completed Markdown is returned to Codex through `await_k3_result`; a structured `result_markdown` copy is included as a host-compatibility fallback.
5. The browser fallback contains the token only in component-private URL metadata.

## Reporting

Please report vulnerabilities privately to the repository owner before opening a public issue. Include the affected commit/version, reproduction steps, platform, and whether an external file or credential was exposed.
