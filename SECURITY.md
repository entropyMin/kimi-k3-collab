# Security

## Supported security posture

`analyze` mode is defense in depth, not a sandbox. It uses a local-only read-tool allowlist, manual permissions, approval rejection, live/result-stream checks for disallowed tools, and a default-sensitive path policy. Repository content read by K3 is sent to the configured model; the loopback service coordinates requests but does not imply local inference.

Git `execute` mode protects the source checkout with a temporary worktree and validates the Git-visible handoff. It canonicalizes source paths, rejects symbolic links or junctions in allowed scopes, checks structured write targets, reports ignored outputs, and preserves worktrees that require review. Non-Git execution is disabled unless the user explicitly authorizes `allow_non_git_execute`.

The bridge preflights the effective workspace and refuses sessions that expose default-sensitive paths unless `sensitive_paths_ack` is explicitly confirmed; runtime tool paths are checked again. Confirmation and policy events are stored as metadata-only JSONL under `$KIMI_CODE_HOME/codex-jobs/audit`; file contents and bearer tokens are never written to this audit.

## Out of scope

The plugin cannot reliably parse or confine arbitrary shell commands. It may also lose a race against a process that creates, uses, and deletes a link before inspection. Use an operating-system sandbox or container when prevention is required. Configure `KIMI_K3_SERVER_WRAPPER` with a dedicated `KIMI_CODE_HOME` before Kimi starts; the executable receives the resolved Kimi command and its server arguments. The bridge refuses to reuse an active service that was not marked as launched by the configured wrapper.

## Operational recommendations

Run `execute` sessions in a dedicated development environment with no production access — a separate OS account, VM, or container. The bridge forwards only an explicit runtime environment allowlist to Kimi, but the wrapper and mounted workspace can still expose credentials or files. Keep production environment variables, cloud credentials, and unrelated file mounts out of that environment; plugin path checks and worktree isolation do not hide resources the environment already exposes.

Install the plugin pinned to a Git tag or commit instead of tracking a moving branch. Validate each upgrade in a test repository first — `npm run check`, `npm test`, and `npm run test:real-kimi` when the change touches live Kimi interaction — then update the pinned ref in the production development environment only after those checks pass.

## Data flow

1. The MCP server reads the authenticated Kimi lock/token from the local Kimi home.
2. REST and WebSocket traffic is restricted to loopback hosts.
3. The MCP App receives event frames through the host bridge and does not receive the bearer token or browser URL.
4. The completed Markdown is returned to Codex through `await_k3_result`; a structured `result_markdown` copy is included as a host-compatibility fallback.
5. Browser fallback exchanges a 60-second single-use loopback ticket for a 10-minute HttpOnly gateway session. Only the gateway's upstream loopback request carries the persistent Kimi bearer token.

## Reporting

Please report vulnerabilities privately to the repository owner before opening a public issue. Include the affected commit/version, reproduction steps, platform, and whether an external file or credential was exposed.
