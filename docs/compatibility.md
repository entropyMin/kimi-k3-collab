# Kimi Code compatibility

The plugin validates required runtime capabilities instead of accepting a version number alone:

- loopback health endpoint
- `kimi-code/k3` model advertisement
- session creation and profile configuration
- prompt submission and status reads
- assistant messages, approvals, and WebSocket events used by the collaboration bridge

| Kimi Code version | Status | Coverage |
| --- | --- | --- |
| 0.29.0 | Tested (preferred) | Real Windows session/prompt/WebSocket/result handoff plus fake protocol regression fixtures |
| 0.26.0 | Tested (legacy baseline) | Real Windows session/prompt/WebSocket/result handoff plus fake protocol regression fixtures |
| Other versions | Untested | Runtime capability failures are reported; no compatibility guarantee yet |

The project prioritizes the latest official stable Kimi Code release and retains 0.26.0 as a regression baseline. As of 2026-07-24, the preferred version is 0.29.0. Compatibility is not inferred from the version alone: 0.26 uses the legacy background-server lock, while 0.29 uses foreground `kimi web` processes and per-instance discovery records. The bridge detects the available server-launch command and verifies the loopback health, advertised K3 model, and required REST/WebSocket behavior.

The fake server used by `npm test` verifies this repository's expected REST/WebSocket contract through the real MCP server and bridge, including analyze and isolated execute handoffs, on all CI platforms and supported Node.js runtimes. It is not a substitute for running the real Kimi release. `npm run test:real-kimi` creates a real session, submits a no-tool prompt, consumes WebSocket events, verifies the result handoff, and checks the durable record. It requires an installed and authenticated Kimi Code and consumes one model request.

When the local lock or instance record contains a parseable version, tool results expose `kimi_code_version` and `compatibility_status`. An untested version is not blocked when the required capabilities still work.
