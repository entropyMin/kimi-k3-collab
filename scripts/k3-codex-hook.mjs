#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PLUGIN_DATA = path.resolve(
  process.env.PLUGIN_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), ".kimi-code", "codex-plugin-data")
);
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "error", "stopped", "stalled"]);
const HANDOFF_STATUSES = new Set([...TERMINAL_STATUSES, "blocked", "needs_authorization"]);
const TRACKED_TOOLS = new Set([
  "start_k3_collaboration",
  "send_k3_message",
  "await_k3_result",
  "get_k3_result",
  "cancel_k3_job"
]);
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const WAIT_QUESTION_ID = "k3_wait_decision";
const CONTINUE_WAITING = "Continue waiting";
const STOP_WAITING = "Stop waiting";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function statePath(codexSessionId) {
  const key = createHash("sha256").update(codexSessionId).digest("hex");
  return path.join(PLUGIN_DATA, "handoffs", `${key}.json`);
}

function readState(codexSessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(codexSessionId), "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  const file = statePath(state.codexSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function findField(value, names, depth = 0) {
  if (depth > 7 || value == null || typeof value !== "object") return null;
  for (const name of names) {
    if (typeof value[name] === "string" && value[name].trim()) return value[name].trim();
    if (typeof value[name] === "boolean") return value[name];
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findField(child, names, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function containsQuestionId(value, depth = 0) {
  if (depth > 10 || value == null) return false;
  if (typeof value === "string") return value === WAIT_QUESTION_ID;
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key === WAIT_QUESTION_ID ||
    (key === "id" && child === WAIT_QUESTION_ID) ||
    containsQuestionId(child, depth + 1)
  );
}

function isUserTranscriptEntry(value) {
  return findField(value, ["role"]) === "user" ||
    ["user_message", "user_input"].includes(String(value?.payload?.type || value?.type || ""));
}

function fixedDecision(value, depth = 0, found = new Set()) {
  if (depth > 10 || value == null) return found;
  if (typeof value === "string") {
    const answer = value.trim().toLowerCase();
    if (answer === CONTINUE_WAITING.toLowerCase()) found.add(CONTINUE_WAITING);
    if (answer === STOP_WAITING.toLowerCase()) found.add(STOP_WAITING);
    return found;
  }
  if (typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) fixedDecision(child, depth + 1, found);
  }
  return found;
}

function applyDecision(state, decision) {
  if (decision === CONTINUE_WAITING) {
    return {
      ...state,
      running_await_count: 0,
      waiting_decision: false,
      user_stopped_waiting: false
    };
  }
  if (decision === STOP_WAITING) {
    return { ...state, waiting_decision: false, user_stopped_waiting: true };
  }
  return state;
}

function resetHandoff(codexSessionId, k3SessionId, turnId, previous = {}) {
  return {
    ...previous,
    codexSessionId,
    k3SessionId,
    startedTurnId: turnId || null,
    delivered: false,
    running_await_count: 0,
    waiting_decision: false,
    user_stopped_waiting: false
  };
}

function recoverStateFromTranscript(input, codexSessionId) {
  const transcript = String(input.transcript_path || "").trim();
  try {
    const stat = transcript && fs.statSync(transcript, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    const length = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const file = fs.openSync(transcript, "r");
    try {
      fs.readSync(file, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(file);
    }
    const text = buffer.toString("utf8");
    const firstNewline = stat.size > length ? text.indexOf("\n") : -1;
    const completeText = stat.size > length
      ? firstNewline === -1 ? "" : text.slice(firstNewline + 1)
      : text;
    let state = null;
    for (const line of completeText.split(/\r?\n/)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.type === "event_msg" ? entry.payload : null;
      const invocation = payload?.type === "mcp_tool_call_end" ? payload.invocation : null;
      const tool = String(invocation?.tool || "");
      if (invocation?.server === "kimi-k3" && TRACKED_TOOLS.has(tool)) {
        const response = payload.result;
        const k3SessionId = findField(response, ["session_id", "sessionId"])
          || findField(invocation.arguments, ["session_id", "sessionId"]);
        if (!k3SessionId) continue;
        const status = String(findField(response, ["status", "state"]) || "");
        const complete = findField(response, ["complete"]);
        const verifiedK3 = findField(response, ["verified_k3", "verifiedK3"]);
        if (tool === "start_k3_collaboration" || tool === "send_k3_message") {
          state = resetHandoff(codexSessionId, k3SessionId, input.turn_id, { recoveredFrom: "transcript" });
        } else if (tool === "await_k3_result" && status === "running" && verifiedK3 === true) {
          state ||= resetHandoff(codexSessionId, k3SessionId, input.turn_id, { recoveredFrom: "transcript" });
          const count = Math.min(2, Number(state.running_await_count || 0) + 1);
          state = { ...state, k3SessionId, running_await_count: count, waiting_decision: count >= 2 };
        } else if (complete === true || HANDOFF_STATUSES.has(status)) {
          state ||= resetHandoff(codexSessionId, k3SessionId, input.turn_id, { recoveredFrom: "transcript" });
          state = { ...state, delivered: true, deliveredBy: `transcript:${tool}` };
        } else if (tool === "cancel_k3_job" && findField(response, ["aborted"]) === true) {
          state ||= resetHandoff(codexSessionId, k3SessionId, input.turn_id, { recoveredFrom: "transcript" });
          state = { ...state, delivered: true, deliveredBy: `transcript:${tool}` };
        }
      }
      if (state?.waiting_decision && (containsQuestionId(entry) || isUserTranscriptEntry(entry))) {
        const decisions = fixedDecision(entry);
        if (decisions.size === 1) state = applyDecision(state, [...decisions][0]);
      }
    }
    return state;
  } catch {
    return null;
  }
}

function trackToolResult(input) {
  const codexSessionId = String(input.session_id || "").trim();
  const toolName = String(input.tool_name || "");
  if (!codexSessionId || !toolName) return;
  const current = readState(codexSessionId);

  if (/request_user_input$/.test(toolName) && current?.waiting_decision) {
    if (!containsQuestionId(input.tool_input) && !containsQuestionId(input.tool_response)) return;
    const decisions = fixedDecision(input.tool_response);
    if (decisions.size === 1) writeState(applyDecision(current, [...decisions][0]));
    return;
  }

  const response = input.tool_response;
  const k3SessionId = findField(response, ["session_id", "sessionId"]);
  const status = String(findField(response, ["status", "state"]) || "");
  const complete = findField(response, ["complete"]);
  const verifiedK3 = findField(response, ["verified_k3", "verifiedK3"]);

  if (/start_k3_collaboration$/.test(toolName) && k3SessionId) {
    writeState(resetHandoff(codexSessionId, k3SessionId, input.turn_id));
    return;
  }
  if (/send_k3_message$/.test(toolName) && k3SessionId) {
    writeState(resetHandoff(codexSessionId, k3SessionId, input.turn_id, current || {}));
    return;
  }
  if (/await_k3_result$/.test(toolName) && k3SessionId) {
    if (complete === true || HANDOFF_STATUSES.has(status)) {
      writeState({ ...(current || resetHandoff(codexSessionId, k3SessionId, input.turn_id)), delivered: true, deliveredBy: toolName });
    } else if (verifiedK3 === true && status === "running") {
      const state = current || resetHandoff(codexSessionId, k3SessionId, input.turn_id);
      const count = Math.min(2, Number(state.running_await_count || 0) + 1);
      writeState({
        ...state,
        k3SessionId,
        delivered: false,
        running_await_count: count,
        waiting_decision: count >= 2,
        user_stopped_waiting: false
      });
    }
    return;
  }
  if (/get_k3_result$/.test(toolName) && current && (complete === true || HANDOFF_STATUSES.has(status))) {
    writeState({ ...current, delivered: true, deliveredBy: toolName });
    return;
  }
  if (/cancel_k3_job$/.test(toolName) && current && findField(response, ["aborted"]) === true) {
    writeState({ ...current, delivered: true, deliveredBy: toolName });
  }
}

function handleStop(input) {
  const codexSessionId = String(input.session_id || "").trim();
  let state = codexSessionId ? readState(codexSessionId) : null;
  const recovered = codexSessionId ? recoverStateFromTranscript(input, codexSessionId) : null;
  if (!state || (state.waiting_decision && recovered?.k3SessionId === state.k3SessionId)) state = recovered || state;
  if (state?.recoveredFrom === "transcript") writeState(state);
  if (!state || state.delivered || state.user_stopped_waiting) {
    emit({ continue: true });
    return;
  }

  const count = Number(state.running_await_count || 0);
  if (count < 2) {
    emit({
      decision: "block",
      reason: `Kimi K3 is still running. Call await_k3_result once more with a bounded wait of at most 60 seconds (${count + 1} of 2). Do not poll status or run filler work.`
    });
    return;
  }

  emit({
    decision: "block",
    reason: [
      "Kimi K3 is still running after two bounded awaits. Before finishing, call request_user_input with question id k3_wait_decision.",
      "Offer exactly Continue waiting and Stop waiting; leave the host-provided Other/free-text choice available.",
      "Continue waiting resets the count for another two-await group. Stop waiting ends only Codex's wait and must not cancel K3 or mark its result delivered. Other requires an explicit follow-up action."
    ].join("\n")
  });
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}") || {};
} catch {
  emit({});
  process.exit(0);
}
if (input.hook_event_name === "PostToolUse") {
  trackToolResult(input);
  emit({});
} else if (input.hook_event_name === "Stop") {
  handleStop(input);
} else {
  emit({});
}
