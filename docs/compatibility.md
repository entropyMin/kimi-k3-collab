# Kimi Code compatibility

The plugin validates required runtime capabilities instead of accepting a version number alone:

- loopback health endpoint
- `kimi-code/k3` model advertisement
- session creation and profile configuration
- prompt submission and status reads
- assistant messages, approvals, and WebSocket events used by the collaboration bridge

| Kimi Code version | Status | Coverage |
| --- | --- | --- |
| 0.26.0 | Tested | Real local use plus fake protocol regression fixtures |
| Other versions | Untested | Runtime capability failures are reported; no compatibility guarantee yet |

The fake server used by `npm test` verifies this repository's expected REST/WebSocket contract but is not a substitute for running the real Kimi release. Use `npm run test:real-kimi` against an installed and authenticated version before adding it to the tested table.

When the local lock file contains a parseable version, tool results expose `kimi_code_version` and `compatibility_status`. An untested version is not blocked when the required capabilities still work.
