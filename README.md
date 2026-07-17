# Kimi K3 Collab

This cross-platform Codex plugin follows the thin-agent pattern used by OpenAI's `codex-plugin-cc`: one native agent forwards engineering, review, discussion, implementation, or visual-design work to an independent persistent runtime and returns a durable job result.

The Kimi server remains the source of truth for execution. The single native `kimi-k3-collaborator` Codex role uses a low-cost wrapper model to start a persistent job and poll it with short, bounded calls; `--focus engineering|visual|general` changes its preference without creating separate agents. Every delegated job verifies the server-selected model is `kimi-code/k3`.

Job snapshots are stored under `$KIMI_CODE_HOME/codex-jobs` (default: `~/.kimi-code/codex-jobs`), so an interrupted wrapper can recover the latest Kimi session.

The native subagent uses `--format text`: its conversation shows K3's original Markdown report, readable progress, and a small verification footer instead of the bridge's JSON transport envelope. Polls stop on completed, blocked, or failed jobs and after 30 minutes of continuous running; the persistent K3 job itself continues and remains recoverable. JSON remains the default CLI format for scripts and integrations.

Run `node scripts/self-test.mjs` to verify script syntax, service health, the advertised K3 model, and any existing durable job record.

## Requirements

- Node.js 18.18 or newer on Windows, macOS, or Linux.
- Kimi Code CLI with local-server support (`0.26.0` tested), installed and authenticated.
- A Codex build with personal plugins and custom agent roles.

The bridge uses only the Node.js standard library; no npm install is required. It finds Kimi on `PATH` or under `$KIMI_CODE_HOME/bin` (default: `~/.kimi-code/bin`). Set `KIMI_CODE_BIN` only when the executable lives elsewhere.

The standard installation path, `$HOME/plugins/kimi-k3-collab`, is part of this native-agent contract. Analysis jobs verify that Kimi keeps server-side plan mode enabled while running and abort on constraint drift. Execution allowlists are explicit instructions to K3, not an operating-system sandbox; Codex must review the resulting diff before accepting edits.

## Local installation

Clone the repository into the standard personal-plugin location:

```sh
git clone https://github.com/entropyMin/kimi-k3-collab "$HOME/plugins/kimi-k3-collab"
node "$HOME/plugins/kimi-k3-collab/scripts/self-test.mjs"
```

Register that directory as `kimi-k3-collab` in your personal Codex marketplace, install `kimi-k3-collab@personal`, and point the `kimi-k3-collaborator` agent role at `agents/kimi-k3-collaborator.toml` using its absolute local path. Start a new Codex task after installation so the skill and role are reloaded.
