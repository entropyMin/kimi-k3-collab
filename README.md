# Kimi K3 Collab

This personal Codex plugin follows the thin-agent pattern used by OpenAI's `codex-plugin-cc`: one native agent forwards engineering, review, discussion, implementation, or visual-design work to an independent persistent runtime and returns a durable job result.

The Kimi server remains the source of truth for execution. The single native `kimi-k3-collaborator` Codex role uses a low-cost wrapper model only to invoke `scripts/kimi-k3.ps1 -Action delegate`; `-Focus engineering|visual|general` changes its preference without creating separate agents. Every delegated job verifies the server-selected model is `kimi-code/k3`.

Job snapshots are stored under `%USERPROFILE%\.kimi-code\codex-jobs`, so an interrupted wrapper can recover the latest Kimi session.

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\self-test.ps1` to verify script syntax, service health, the advertised K3 model, and any existing durable job record.

## Requirements

- Windows PowerShell 5.1 or newer.
- Kimi Code installed under `%USERPROFILE%\.kimi-code` and authenticated.
- A Codex build with personal plugins and custom agent roles.

## Local installation

Clone the repository into the standard personal-plugin location:

```powershell
git clone https://github.com/entropyMin/kimi-k3-collab "$HOME\plugins\kimi-k3-collab"
```

Register that directory as `kimi-k3-collab` in your personal Codex marketplace, install `kimi-k3-collab@personal`, and point the `kimi-k3-collaborator` agent role at `agents\kimi-k3-collaborator.toml` using its absolute local path. Start a new Codex task after installation so the skill and role are reloaded.
