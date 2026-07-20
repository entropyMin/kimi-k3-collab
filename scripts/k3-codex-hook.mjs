#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ROOT = path.resolve(process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || SCRIPT_ROOT);
const PLUGIN_DATA = path.resolve(
  process.env.PLUGIN_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), ".kimi-code", "codex-plugin-data")
);
const BRIDGE = path.resolve(process.env.KIMI_K3_HOOK_BRIDGE || path.join(PLUGIN_ROOT, "scripts", "kimi-k3.mjs"));
const K3_MODEL = "kimi-code/k3";
const WINDOW_SECONDS = 105;
const MAX_STOP_WAIT_SECONDS = Math.max(1, Math.min(600, Number(process.env.KIMI_K3_STOP_MAX_WAIT_SECONDS) || 540));
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "error", "stopped"]);
const HANDOFF_STATUSES = new Set([...TERMINAL_STATUSES, "blocked"]);
const TRACKED_TOOLS = new Set([
  "start_k3_collaboration",
  "send_k3_message",
  "await_k3_result",
  "get_k3_result",
  "cancel_k3_job"
]);
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/(--?(?:api[-_]?key|token|password|secret)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD))=\S+/g, "$1=[redacted]")
    .slice(0, 500);
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
    for (const line of completeText.split(/\r?\n/).reverse()) {
      if (!line.includes('"mcp_tool_call_end"') || !line.includes('"kimi-k3"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.type === "event_msg" ? entry.payload : null;
      const invocation = payload?.type === "mcp_tool_call_end" ? payload.invocation : null;
      const tool = String(invocation?.tool || "");
      if (invocation?.server !== "kimi-k3" || !TRACKED_TOOLS.has(tool)) continue;
      const response = payload.result;
      const k3SessionId = findField(response, ["session_id", "sessionId"])
        || findField(invocation.arguments, ["session_id", "sessionId"]);
      if (!k3SessionId) continue;
      const status = String(findField(response, ["status", "state"]) || "");
      const complete = findField(response, ["complete"]);
      const aborted = findField(response, ["aborted"]);
      if (complete === true || HANDOFF_STATUSES.has(status) || (tool === "cancel_k3_job" && aborted === true)) {
        return { codexSessionId, k3SessionId, delivered: true, deliveredBy: `transcript:${tool}` };
      }
      return {
        codexSessionId,
        k3SessionId,
        startedTurnId: input.turn_id || null,
        delivered: false,
        stopContinuationIssued: false,
        recoveredFrom: "transcript"
      };
    }
  } catch {
    return null;
  }
  return null;
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

function runBridge(sessionId, waitSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      BRIDGE,
      "result", "--format", "json", "--session-id", sessionId, "--wait-seconds", String(waitSeconds)
    ], {
      cwd: PLUGIN_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Kimi bridge exited with code ${code ?? "unknown"}.`));
        return;
      }
      try {
        const record = JSON.parse(stdout);
        const model = record.server_reported_model || record.explicit_model || null;
        if (!record.verified_k3 || model !== K3_MODEL) {
          throw new Error(`Kimi handoff did not verify ${K3_MODEL}.`);
        }
        const status = record.complete === true || record.state === "end_turn"
          ? "completed"
          : String(record.state || record.status || "unknown");
        resolve({ status, report: typeof record.result === "string" ? record.result.trim() : "" });
      } catch {
        reject(new Error("Kimi bridge returned invalid JSON to the handoff hook."));
      }
    });
  });
}

async function waitForHandoff(sessionId) {
  const deadline = Date.now() + MAX_STOP_WAIT_SECONDS * 1000;
  let outcome = { report: "", status: "running" };
  while (Date.now() < deadline && !HANDOFF_STATUSES.has(outcome.status)) {
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    outcome = await runBridge(sessionId, Math.min(WINDOW_SECONDS, remaining));
  }
  if (HANDOFF_STATUSES.has(outcome.status)) return runBridge(sessionId, 0);
  return outcome;
}

function trackToolResult(input) {
  const codexSessionId = String(input.session_id || "").trim();
  const toolName = String(input.tool_name || "");
  if (!codexSessionId || !toolName) return;
  const response = input.tool_response;
  const k3SessionId = findField(response, ["session_id", "sessionId"]);
  const status = findField(response, ["status", "state"]);
  const complete = findField(response, ["complete"]);
  const current = readState(codexSessionId);

  if (/start_k3_collaboration$/.test(toolName) && k3SessionId) {
    writeState({
      codexSessionId,
      k3SessionId,
      startedTurnId: input.turn_id || null,
      delivered: false,
      stopContinuationIssued: false
    });
    return;
  }
  if (/send_k3_message$/.test(toolName) && k3SessionId) {
    writeState({
      ...(current || { codexSessionId, k3SessionId }),
      k3SessionId,
      delivered: false,
      stopContinuationIssued: false
    });
    return;
  }
  if (/(await_k3_result|get_k3_result)$/.test(toolName) && current) {
    if (complete === true || HANDOFF_STATUSES.has(String(status || ""))) {
      writeState({ ...current, delivered: true, deliveredBy: toolName });
    }
    return;
  }
  if (/cancel_k3_job$/.test(toolName) && current && findField(response, ["aborted"]) === true) {
    writeState({ ...current, delivered: true, deliveredBy: toolName });
  }
}

async function handleStop(input) {
  const codexSessionId = String(input.session_id || "").trim();
  const state = codexSessionId
    ? readState(codexSessionId) || recoverStateFromTranscript(input, codexSessionId)
    : null;
  if (state?.recoveredFrom === "transcript") writeState(state);
  if (!state || state.delivered) {
    emit({ continue: true });
    return;
  }
  if (state.stopContinuationIssued) {
    emit({
      continue: true,
      systemMessage: `Kimi K3 session ${state.k3SessionId} still has an undelivered result.`
    });
    return;
  }

  try {
    const outcome = await waitForHandoff(state.k3SessionId);
    if (HANDOFF_STATUSES.has(outcome.status)) {
      writeState({ ...state, delivered: true, deliveredBy: "Stop" });
      emit({
        decision: "block",
        reason: [
          "Kimi K3 has reported back. Treat the following as authentic K3-to-Codex collaborator output.",
          "Reconcile it with your own work, respond to it directly, and only then finish the user-facing answer.",
          "",
          outcome.report || `Kimi K3 returned ${outcome.status} without a Markdown report.`
        ].join("\n")
      });
      return;
    }
    writeState({ ...state, stopContinuationIssued: true });
    emit({
      decision: "block",
      reason: `Kimi K3 session ${state.k3SessionId} is still working after the long event wait. Do not narrate repeated waiting or run filler checks. Tell the user once and ask whether to keep waiting or cancel.`
    });
  } catch (error) {
    const failures = Number(state.handoffFailures || 0) + 1;
    if (failures === 1) {
      writeState({ ...state, handoffFailures: failures, stopContinuationIssued: false });
      emit({
        decision: "block",
        reason: `Kimi K3-to-Codex handoff failed once: ${safeError(error)}. Retry the event-driven handoff without polling status or running filler checks.`
      });
    } else {
      writeState({ ...state, handoffFailures: failures, stopContinuationIssued: true });
      emit({
        continue: true,
        systemMessage: `Kimi K3-to-Codex handoff failed repeatedly: ${safeError(error)}.`
      });
    }
  }
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
  await handleStop(input);
} else {
  emit({});
}
