# Kimi K3 Collab

This cross-platform Codex plugin follows the thin-agent pattern used by OpenAI's `codex-plugin-cc`: one native agent forwards engineering, review, discussion, implementation, or visual-design work to an independent persistent runtime and returns a durable job result.

The Kimi server remains the source of truth for execution. The single native `kimi-k3-collaborator` Codex role uses a low-cost wrapper model to start a persistent job and subscribe to its WebSocket events; `--focus engineering|visual|general` changes its preference without creating separate agents. Every delegated job verifies the server-selected model is `kimi-code/k3`.

Job snapshots are stored under `$KIMI_CODE_HOME/codex-jobs` (default: `~/.kimi-code/codex-jobs`), so an interrupted wrapper can recover the latest Kimi session.

The native subagent uses `--format text`: its conversation shows K3's real tool and subagent actions, original Markdown report, and a small verification footer instead of the bridge's JSON transport envelope or hidden thinking. The bridge persists Kimi's `seq`/`epoch` cursor and resumes after disconnects. Each command also has a 115-second end-to-end budget covering service startup, REST calls, WebSocket streaming, and final synchronization, so cold starts cannot run into Codex's roughly 124-second command boundary. Reopening the stream continues from the cursor without REST polling. JSON remains the default CLI format for scripts and integrations.

Event delivery is at-least-once: if the wrapper process is forcibly killed between cursor checkpoints, a few readable progress lines can repeat after recovery. The final report is reloaded from the durable Kimi session and is not reconstructed from those progress lines.

Run `node scripts/self-test.mjs` to verify script syntax, service health, the advertised K3 model, and any existing durable job record.

## Requirements

- Node.js 18.18 or newer on Windows, macOS, or Linux.
- Kimi Code CLI with local-server support (`0.26.0` tested), installed and authenticated.
- A Codex build with personal plugins and custom agent roles.

The bridge uses only the Node.js standard library; no npm install is required. It finds Kimi on `PATH` or under `$KIMI_CODE_HOME/bin` (default: `~/.kimi-code/bin`). Set `KIMI_CODE_BIN` only when the executable lives elsewhere.

The standard installation path, `$HOME/plugins/kimi-k3-collab`, is part of this native-agent contract. Analysis jobs keep Kimi plan mode disabled and configure only `Read`, `ReadMediaFile`, `Glob`, `Grep`, `WebSearch`, and `FetchURL`; plan mode is a planning workflow, not a read-only sandbox. Execution allowlists are explicit instructions to K3, not an operating-system sandbox, so Codex must review the resulting diff before accepting edits.

## CLI flow

Start a job and follow its event stream in one bounded call:

```sh
node scripts/kimi-k3.mjs delegate --format text --max-wait-seconds 105 --mode analyze --focus engineering --cwd "/path/to/project" --prompt "Review this design."
```

If the footer still says running, continue from the durable cursor:

```sh
node scripts/kimi-k3.mjs watch --format text --session-id SESSION --wait-seconds 105
```

## Local installation

Clone the repository into the standard personal-plugin location:

```sh
git clone https://github.com/entropyMin/kimi-k3-collab "$HOME/plugins/kimi-k3-collab"
node "$HOME/plugins/kimi-k3-collab/scripts/self-test.mjs"
```

Register that directory as `kimi-k3-collab` in your personal Codex marketplace, install `kimi-k3-collab@personal`, and point the `kimi-k3-collaborator` agent role at `agents/kimi-k3-collaborator.toml` using its absolute local path. Start a new Codex task after installation so the skill and role are reloaded.
