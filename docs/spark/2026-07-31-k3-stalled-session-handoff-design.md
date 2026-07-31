# K3 stalled session handoff design

Date: 2026-07-31

## Context

A real Kimi Code 0.31.0 review session successfully authenticated, verified
`kimi-code/k3`, made three productive model requests, and then issued ten
requests without usage, assistant output, or tool results. The native Kimi
wire log eventually ended with `turn.cancel`, but the plugin's durable job
remained:

```text
state: idle
complete: false
error: null
last_event_type: event.session.work_changed
```

The plugin currently completes a job only when it observes a known terminal
state, a non-empty `last_turn_reason`, or a terminal WebSocket event such as
`prompt.completed` or `prompt.aborted`. An idle session with none of those
signals therefore remains incomplete forever.

The exact upstream cause is unknown. The available evidence does not
distinguish a rate limit, timeout, connection failure, or provider-side
incident, so the plugin must not label this condition as a provider error.

## Goals

- End an active handoff when Kimi remains idle without a terminal signal for
  10 seconds.
- Return an explicit, durable `stalled` failure instead of waiting forever.
- Preserve partial assistant text as diagnostic data without presenting it as
  a completed K3 report.
- Apply the behavior consistently to analyze, safe execute, and confirmed
  unrestricted sessions.
- Release locks and conservatively preserve incomplete Git changes.
- Show the stalled state and partial output in the MCP App panel.
- Preserve the plugin's event-driven, no-polling contract.
- Recover the grace-period state across MCP process restarts.

## Non-goals

- Automatically retry, continue, cancel, or replace the K3 session.
- Guess the upstream provider failure type.
- Read or depend on Kimi's private `wire.jsonl` format.
- Add a background watchdog or periodic status poll.
- Reclassify Kimi Code 0.31.0 compatibility.
- Add unrelated panel or execution-workspace features.

## Considered approaches

### Persisted anomalous-idle state with one event wait

Persist the first anomalous-idle observation, use the existing event channel
for a single 10-second grace wait, and perform one final synchronization.
This approach survives MCP restarts, keeps all decisions in the existing job
synchronization path, and does not poll. This is the selected approach.

### Immediate failure on idle

Failing on the first idle observation would be smaller, but could misclassify
a brief REST/WebSocket synchronization delay. It does not satisfy the agreed
10-second grace period.

### Background watchdog or native wire inspection

A watchdog could terminalize a job without a later tool call, while native
wire inspection could detect `turn.cancel`. Both add lifecycle complexity or
couple the plugin to undocumented Kimi storage. They are out of scope.

## State model

### Anomalous-idle predicate

A job is an anomalous-idle candidate only when all of the following are true:

- the durable record has an active `prompt_id`;
- the record is not already complete;
- Kimi reports `busy=false`;
- `pending_interaction` is `none`;
- `last_turn_reason` is empty;
- the current status is not a known complete, failed, blocked, cancelled, or
  authorization-required state.

### First observation

On the first anomalous-idle observation, the bridge:

- persists `idle_without_terminal_since` as an ISO timestamp;
- keeps the externally visible job state as `running`;
- preserves any existing assistant text;
- does not report an error.

The timestamp is internal candidate state rather than a new public status.

### Candidate reset

The bridge removes `idle_without_terminal_since` when any of these occurs:

- Kimi becomes busy again;
- a current-prompt event arrives after the candidate began;
- a pending interaction appears;
- a terminal reason, terminal event, or terminal state appears;
- a follow-up prompt is successfully submitted.

Events for an older prompt do not reset the current prompt's candidate.

### Terminal transition

If the anomalous-idle predicate still holds at least 10 seconds after
`idle_without_terminal_since`, the durable record becomes:

```text
state: stalled
complete: true
error_code: session_stalled
error: Kimi became idle without a terminal event.
result: null
partial_result: <latest assistant text or null>
stalled_at: <ISO timestamp>
```

The record retains `idle_without_terminal_since`, `last_event_type`,
`prompt_id`, mode, model verification, and integration metadata for
diagnosis. `stalled` is included in the bridge and MCP server terminal/failure
sets.

## Data flow

The decision belongs in the existing shared job synchronization path so that
WebSocket checkpoints, `await_k3_result`, explicit result/status tools, and
the Stop hook cannot disagree.

When `await_k3_result` first observes anomalous idle, it uses the existing
event wait for the remainder of the 10-second grace period and then performs
one final status synchronization. It does not loop. An incoming event ends
the wait early and follows the normal event path.

Explicit status or result fallback calls remain non-blocking. They persist
the first candidate observation; a later call terminalizes the record when
the persisted grace period has elapsed.

MCP restart recovery reads `idle_without_terminal_since` from the durable job
record. Restarting the MCP process does not restart the 10-second grace
period.

## Result and follow-up behavior

The model-visible report for a stalled job is an explicit failure:

> Kimi K3 stalled after becoming idle without a terminal event. No automatic
> retry or cancellation was performed. Start a new session to retry the task.

The MCP structured result exposes:

```text
status: stalled
complete: true
handoff_ready: true
error_code: session_stalled
idle_without_terminal_since
stalled_at
last_event_type
partial_result
```

`partial_result` is never copied into `result` or appended to the main report.
The Stop hook treats the failure as delivered and stops blocking Codex.
`send_k3_message` rejects a stalled session and directs the caller to start a
new session.

## Execution cleanup

### Analyze

No workspace cleanup is required. The terminal stalled result is returned
directly.

### Git execute

The bridge inspects the isolated worktree using the existing path, sensitive
file, ignored file, and symbolic-link checks.

- With no changes, it removes the temporary worktree and branch.
- With changes, it does not create the normal squashed handoff commit because
  the edits may be incomplete. It records `integration.state: stalled`,
  lists changed paths, and preserves the worktree and branch for manual
  review.
- Existing scope or security violations retain their stricter failure state
  and preservation behavior.

### Single-writer and unrestricted

The bridge releases the advisory single-writer lock through the existing
finalizer. The handoff states only that direct-write access was available and
that whether changes occurred is unverified. It must not claim that changes
were completed.

## Panel behavior

The MCP server publishes one plugin-generated terminal notification when a
job becomes stalled. It is visually and structurally distinct from raw Kimi
events and does not enter Kimi's native history.

The panel displays:

```text
K3 session stalled
Kimi became idle without a terminal event.
No automatic retry or cancellation was performed.

Partial K3 output — incomplete, do not treat as final
<partial_result Markdown>
```

Requirements:

- reuse the existing Markdown renderer and panel components;
- collapse the partial-output section by default;
- omit the section when `partial_result` is empty;
- deduplicate by `prompt_id` and `stalled_at`;
- recover the same notification from the durable job when the panel reopens;
- apply the existing bounded-text payload limit and show an explicit
  truncation notice when needed;
- direct users to Open Kimi Code for the full native history;
- never trigger a retry, cancellation, or follow-up from the notification.

An already-open panel receives the synthetic notification from the MCP
server after a bridge operation returns the stalled record. A reopened panel
receives the stalled fields in its initial durable session data. No panel
polling is added.

## Error precedence

A concrete terminal error, prompt completion/abort, authorization request,
scope violation, or security failure always takes precedence over
`session_stalled`. The bridge clears a pending anomalous-idle candidate before
applying the more specific terminal outcome.

If workspace finalization itself fails after the session stalls, the existing
integration error becomes the primary execution-handoff error while the
record retains the session stalled metadata for diagnosis.

## Tests

Tests use the existing fake Kimi REST/WebSocket server and bridge. No new test
framework or real 10-second sleep is introduced.

### State transition tests

- First anomalous idle persists `idle_without_terminal_since`, remains
  incomplete, and preserves current text.
- A candidate timestamp more than 10 seconds old produces `stalled`,
  `complete=true`, and `session_stalled`.
- `result` is null and prior text appears only in `partial_result`.
- Busy recovery, a new current-prompt event, a pending interaction, and a
  normal terminal event each clear the candidate without a false positive.
- Old-prompt events do not reset a current candidate.
- A persisted candidate terminalizes correctly after an MCP restart.
- A successfully submitted follow-up clears stale candidate metadata.

Tests pre-populate an expired timestamp instead of waiting 10 real seconds.

### Mode cleanup tests

- Analyze returns a terminal stalled handoff.
- Git execute with no changes removes its temporary resources.
- Git execute with changes preserves the worktree, reports changed paths, and
  creates no normal handoff commit.
- Single-writer and unrestricted sessions release their lock and use
  unverified direct-write wording.
- Existing scope and sensitive-path failures continue to take precedence.

### MCP App and lifecycle tests

- The panel shows one stalled notice and a collapsed, clearly incomplete
  partial result.
- Empty partial output creates no empty panel section.
- Reopening the panel restores the stalled notice.
- Duplicate bridge results do not duplicate the notice.
- The Stop hook treats stalled as a delivered terminal failure.
- Follow-up messaging rejects the stalled session.
- Structured fields and tool schemas remain backward compatible.

### Validation

The implementation is accepted when all of the following pass:

```text
npm.cmd run check
npm.cmd test
npm.cmd run test:real-kimi
plugin-creator validate_plugin.py
git diff --check
```

The real Kimi test verifies that a normal analyze
session/prompt/WebSocket/result handoff completes without a false stalled
classification. It does not attempt nondeterministic upstream fault
injection.

## Success criteria

- The reproduced `idle + complete=false + no terminal reason` condition
  becomes a durable stalled failure after 10 seconds.
- Codex, the Stop hook, fallback result tools, and the panel agree on the
  terminal state.
- Partial output remains available but cannot be mistaken for a final K3
  report.
- No automatic provider action, model request, cancellation, polling loop, or
  dependency is added.
- Normal K3 sessions and existing security/integration failures retain their
  current behavior.
