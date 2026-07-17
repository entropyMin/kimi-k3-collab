#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(THIS_FILE));
const BRIDGE = path.resolve(process.env.KIMI_K3_BRIDGE || path.join(ROOT, "scripts", "kimi-k3.mjs"));
const JOB_ROOT = path.join(path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code")), "codex-jobs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".codex-plugin", "plugin.json"), "utf8")).version;
const PROTOCOL_VERSION = "2025-11-25";
const FOREGROUND_TOOL = "collaborate_with_k3";
const START_TOOL = "start_k3_job";
const STATUS_TOOL = "get_k3_status";
const RESULT_TOOL = "get_k3_result";
const CANCEL_TOOL = "cancel_k3_job";
const WINDOW_SECONDS = 105;
const DEFAULT_MAX_WAIT_SECONDS = 3600;
const TERMINAL_STATES = new Set(["completed", "blocked", "failed", "cancelled", "stopped", "error"]);
const activeChildren = new Map();
const activeRequests = new Set();
const cancelledRequests = new Set();
let transportClosed = false;

function closeTransport() {
  if (transportClosed) return;
  transportClosed = true;
  for (const requestId of activeRequests) cancelledRequests.add(requestId);
  for (const child of activeChildren.values()) child.kill();
}

function send(message) {
  if (transportClosed) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdout.on("error", (error) => {
  closeTransport();
  process.exit(error?.code === "EPIPE" ? 0 : 1);
});

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function requireObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireSessionId(value) {
  const sessionId = requireString(value, "session_id");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error("session_id contains unsupported characters.");
  return sessionId;
}

function parseJobArguments(value) {
  const input = requireObject(value);
  const mode = input.mode ?? "analyze";
  const focus = input.focus ?? "general";
  if (!new Set(["analyze", "execute"]).has(mode)) throw new Error("mode must be analyze or execute.");
  if (!new Set(["engineering", "visual", "general"]).has(focus)) {
    throw new Error("focus must be engineering, visual, or general.");
  }
  const allowedPaths = Array.isArray(input.allowed_paths)
    ? input.allowed_paths.map((item) => requireString(item, "allowed_paths[]"))
    : [];
  if (mode === "execute" && allowedPaths.length === 0) {
    throw new Error("execute mode requires at least one allowed_paths entry.");
  }
  const cwd = requireString(input.cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path.");
  return {
    mode,
    focus,
    cwd: path.resolve(cwd),
    prompt: requireString(input.prompt, "prompt"),
    allowedPaths
  };
}

function parseForegroundArguments(value) {
  const input = requireObject(value);
  const maxWaitSeconds = input.max_wait_seconds === undefined ? DEFAULT_MAX_WAIT_SECONDS : Number(input.max_wait_seconds);
  if (!Number.isInteger(maxWaitSeconds) || maxWaitSeconds < 1 || maxWaitSeconds > DEFAULT_MAX_WAIT_SECONDS) {
    throw new Error(`max_wait_seconds must be an integer from 1 to ${DEFAULT_MAX_WAIT_SECONDS}.`);
  }
  if (typeof input.session_id === "string" && input.session_id.trim()) {
    return { sessionId: requireSessionId(input.session_id), maxWaitSeconds };
  }
  return { sessionId: null, maxWaitSeconds, ...parseJobArguments(input) };
}

function parseSessionArguments(value) {
  return { sessionId: requireSessionId(requireObject(value).session_id) };
}

function lastMatch(text, pattern) {
  let result = null;
  for (const match of text.matchAll(pattern)) result = match[1].trim();
  return result;
}

export function parseBridgeFooter(text) {
  const modelLine = lastMatch(text, /^Model:\s*(.+)$/gm);
  return {
    sessionId: lastMatch(text, /^Kimi K3 session:\s*(.+)$/gm),
    status: normalizeStatus(lastMatch(text, /^Status:\s*(.+)$/gm)),
    mode: lastMatch(text, /^Mode:\s*(.+)$/gm),
    focus: lastMatch(text, /^Focus:\s*(.+)$/gm),
    model: modelLine?.replace(/\s+\((?:verified|NOT VERIFIED)\)$/, "") ?? null,
    verifiedK3: modelLine?.endsWith("(verified)") ?? false
  };
}

function normalizeStatus(value) {
  return value === "end_turn" ? "completed" : value;
}

function isActionLine(line) {
  return line.startsWith("K3 · ") && !line.includes("Stream checkpoint saved");
}

function actionTracePath(sessionId) {
  return path.join(JOB_ROOT, `${requireSessionId(sessionId)}.actions.log`);
}

function readActionTrace(sessionId) {
  const file = actionTracePath(sessionId);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

function appendAction(sessionId, line) {
  fs.mkdirSync(JOB_ROOT, { recursive: true });
  fs.appendFileSync(actionTracePath(sessionId), `${line}\n`, "utf8");
}

function runBridgeWindow(requestId, args, onLine = () => {}, stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    activeChildren.set(requestId, child);
    child.stdin.end(stdinText);
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf("\n");
      while (newline !== -1) {
        onLine(lineBuffer.slice(0, newline).replace(/\r$/, ""));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      activeChildren.delete(requestId);
      if (lineBuffer) onLine(lineBuffer);
      if (cancelledRequests.has(requestId)) {
        reject(new Error("MCP call cancelled; the persistent K3 session can be resumed by session_id."));
      } else if (code !== 0) {
        reject(new Error(stderr.trim() || `Kimi bridge exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function runBridgeJson(requestId, args, stdinText = "") {
  const result = await runBridgeWindow(requestId, args, () => {}, stdinText);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Kimi bridge returned invalid JSON.");
  }
}

function sendProgress(progressToken, progress, message) {
  if (progressToken === undefined || progressToken === null) return;
  send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, message }
  });
}

async function startJob(requestId, input) {
  const job = await runBridgeJson(
    requestId,
    [
      "start", "--format", "json", "--mode", input.mode, "--focus", input.focus, "--cwd", input.cwd,
      ...(input.mode === "execute" ? ["--allowed-path", input.allowedPaths.join(";")] : [])
    ],
    input.prompt
  );
  return { ...job, session_id: requireSessionId(job.session_id) };
}

function structuredJob(job, actionCount = 0) {
  return {
    session_id: job.session_id,
    status: normalizeStatus(job.state || job.status || "running"),
    mode: job.mode || null,
    focus: job.focus || null,
    server_reported_model: job.server_reported_model || job.explicit_model || null,
    verified_k3: Boolean(job.verified_k3),
    action_count: actionCount
  };
}

function actionTraceText(actions) {
  return actions.length ? `## K3 actions\n\n${actions.join("\n")}\n\n` : "";
}

async function collaborate(requestId, rawArguments, progressToken) {
  const input = parseForegroundArguments(rawArguments);
  const deadline = Date.now() + input.maxWaitSeconds * 1000;
  let actions = input.sessionId ? readActionTrace(input.sessionId) : [];
  let progress = 0;
  let sessionId = input.sessionId;
  let footer = { sessionId, status: "running", mode: input.mode ?? null, focus: input.focus ?? null };

  if (!sessionId) {
    const job = await startJob(requestId, input);
    sessionId = job.session_id;
    footer = {
      sessionId,
      status: normalizeStatus(job.state || "running"),
      mode: job.mode || input.mode,
      focus: job.focus || input.focus,
      model: job.server_reported_model || job.explicit_model || null,
      verifiedK3: Boolean(job.verified_k3)
    };
    actions = readActionTrace(sessionId);
    sendProgress(progressToken, ++progress, `K3 session started: ${sessionId}`);
  }

  const onLine = (line) => {
    if (!isActionLine(line)) return;
    actions.push(line);
    appendAction(sessionId, line);
    sendProgress(progressToken, ++progress, line);
  };

  while (Date.now() < deadline && !TERMINAL_STATES.has(footer.status)) {
    if (cancelledRequests.has(requestId)) throw new Error("MCP call cancelled; the persistent K3 session continues.");
    const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const waitSeconds = Math.min(WINDOW_SECONDS, remainingSeconds);
    const window = await runBridgeWindow(
      requestId,
      ["watch", "--format", "text", "--session-id", sessionId, "--wait-seconds", String(waitSeconds)],
      onLine
    );
    footer = { ...footer, ...parseBridgeFooter(window.stdout) };
    sessionId = requireSessionId(footer.sessionId ?? sessionId);
  }

  const durable = await runBridgeWindow(
    requestId,
    ["watch", "--format", "text", "--session-id", sessionId, "--wait-seconds", "0"],
    onLine
  );
  footer = { ...footer, ...parseBridgeFooter(durable.stdout) };
  return {
    content: [{ type: "text", text: `${actionTraceText(actions)}${durable.stdout.trimStart()}` }],
    structuredContent: {
      session_id: sessionId,
      status: footer.status,
      mode: footer.mode,
      focus: footer.focus,
      server_reported_model: footer.model,
      verified_k3: footer.verifiedK3,
      action_count: actions.length
    }
  };
}

function spawnBackgroundFollower(sessionId) {
  if (process.env.KIMI_K3_DISABLE_BACKGROUND_WORKER === "1") return false;
  const child = spawn(process.execPath, [THIS_FILE, "--follow-session", requireSessionId(sessionId)], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return true;
}

async function startBackgroundJob(requestId, rawArguments) {
  const input = parseJobArguments(rawArguments);
  const job = await startJob(requestId, input);
  const followerStarted = spawnBackgroundFollower(job.session_id);
  const status = normalizeStatus(job.state || "running");
  const text = [
    "# Kimi K3 job started",
    "",
    `Session: ${job.session_id}`,
    `Mode: ${job.mode || input.mode}`,
    `Focus: ${job.focus || input.focus}`,
    `Status: ${status}`,
    `Model: ${job.server_reported_model || job.explicit_model || "unknown"} (${job.verified_k3 ? "verified" : "NOT VERIFIED"})`,
    "",
    "The job is running independently. Do not poll automatically; use get_k3_status or get_k3_result only when the user asks."
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...structuredJob(job), background_worker_started: followerStarted }
  };
}

async function getJobStatus(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const status = await runBridgeJson(requestId, ["status", "--format", "json", "--session-id", sessionId]);
  const actions = readActionTrace(sessionId);
  const state = normalizeStatus(status.state || "unknown");
  const lines = [
    "# Kimi K3 status",
    "",
    `Session: ${sessionId}`,
    `Status: ${state}`,
    `Activity: ${status.busy ? "working" : "idle"}`,
    `Mode: ${status.mode || "unknown"}`,
    `Focus: ${status.focus || "unknown"}`,
    `Model: ${status.server_reported_model || status.explicit_model || "unknown"} (${status.verified_k3 ? "verified" : "NOT VERIFIED"})`,
    `Captured actions: ${actions.length}`
  ];
  if (actions.length) lines.push("", "Latest actions:", ...actions.slice(-5).map((line) => `- ${line}`));
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      session_id: sessionId,
      status: state,
      busy: Boolean(status.busy),
      mode: status.mode || null,
      focus: status.focus || null,
      server_reported_model: status.server_reported_model || status.explicit_model || null,
      verified_k3: Boolean(status.verified_k3),
      action_count: actions.length
    }
  };
}

async function getJobResult(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const durable = await runBridgeWindow(
    requestId,
    ["watch", "--format", "text", "--session-id", sessionId, "--wait-seconds", "0"]
  );
  const footer = parseBridgeFooter(durable.stdout);
  const actions = readActionTrace(sessionId);
  return {
    content: [{ type: "text", text: `${actionTraceText(actions)}${durable.stdout.trimStart()}` }],
    structuredContent: {
      session_id: sessionId,
      status: footer.status,
      mode: footer.mode,
      focus: footer.focus,
      server_reported_model: footer.model,
      verified_k3: footer.verifiedK3,
      action_count: actions.length
    }
  };
}

async function cancelJob(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const result = await runBridgeJson(requestId, ["cancel", "--format", "json", "--session-id", sessionId]);
  return {
    content: [{
      type: "text",
      text: result.aborted
        ? `Kimi K3 cancellation requested.\nSession: ${sessionId}`
        : `Kimi K3 had no active prompt to cancel.\nSession: ${sessionId}`
    }],
    structuredContent: {
      session_id: sessionId,
      aborted: Boolean(result.aborted),
      prompt_id: result.prompt_id || null,
      reason: result.reason || null
    }
  };
}

const jobInputProperties = {
  prompt: { type: "string", minLength: 1, description: "Complete task for a new K3 session." },
  mode: { type: "string", enum: ["analyze", "execute"], default: "analyze" },
  focus: { type: "string", enum: ["engineering", "visual", "general"], default: "general" },
  cwd: { type: "string", minLength: 1, description: "Absolute project working directory." },
  allowed_paths: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "Execute-mode paths allowed under cwd."
  }
};

export const toolDefinition = {
  name: FOREGROUND_TOOL,
  title: "Collaborate with Kimi K3",
  description:
    "Run one foreground Kimi K3 engineering/design collaboration. Waits on pushed events without model polling and returns genuine K3 actions plus the durable original Markdown report.",
  inputSchema: {
    type: "object",
    properties: {
      ...jobInputProperties,
      session_id: { type: "string", minLength: 1, description: "Existing K3 session to resume after interruption." },
      max_wait_seconds: {
        type: "integer",
        minimum: 1,
        maximum: DEFAULT_MAX_WAIT_SECONDS,
        default: DEFAULT_MAX_WAIT_SECONDS
      }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};

const startToolDefinition = {
  name: START_TOOL,
  title: "Start Kimi K3 Job",
  description:
    "Start a persistent Kimi K3 job and return immediately. A detached event follower records genuine actions; do not automatically poll status or result.",
  inputSchema: { type: "object", properties: jobInputProperties, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};

function sessionToolDefinition(name, title, description, annotations) {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", minLength: 1 } },
      required: ["session_id"],
      additionalProperties: false
    },
    annotations
  };
}

export const toolDefinitions = [
  toolDefinition,
  startToolDefinition,
  sessionToolDefinition(
    STATUS_TOOL,
    "Get Kimi K3 Status",
    "Read one K3 job status and its latest captured actions. Call only on explicit user request; never poll automatically.",
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  ),
  sessionToolDefinition(
    RESULT_TOOL,
    "Get Kimi K3 Result",
    "Read captured K3 actions and the durable original Markdown result for one session. Call only on explicit user request.",
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  ),
  sessionToolDefinition(
    CANCEL_TOOL,
    "Cancel Kimi K3 Job",
    "Cancel the active prompt for one persistent K3 session.",
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  )
];

const toolHandlers = new Map([
  [FOREGROUND_TOOL, collaborate],
  [START_TOOL, startBackgroundJob],
  [STATUS_TOOL, getJobStatus],
  [RESULT_TOOL, getJobResult],
  [CANCEL_TOOL, cancelJob]
]);

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "Kimi K3 Collab", version: VERSION },
      instructions:
        "Use collaborate_with_k3 for one foreground event-driven call. Use start_k3_job for background work, then get_k3_status/get_k3_result only when the user explicitly asks. Never create a model-driven polling loop."
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions });
    return;
  }
  if (method === "tools/call") {
    const handler = toolHandlers.get(params?.name);
    if (!handler) {
      sendError(id, -32602, `Unknown tool: ${params?.name ?? ""}`);
      return;
    }
    activeRequests.add(id);
    try {
      const result = await handler(id, params.arguments, params?._meta?.progressToken);
      if (!cancelledRequests.has(id)) sendResult(id, result);
    } catch (error) {
      if (!cancelledRequests.has(id)) {
        sendResult(id, {
          content: [{ type: "text", text: `Kimi K3 ${params.name} failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        });
      }
    } finally {
      activeRequests.delete(id);
      cancelledRequests.delete(id);
    }
    return;
  }
  if (method === "notifications/cancelled" || method === "$/cancelRequest") {
    const requestId = params?.requestId;
    if (activeRequests.has(requestId)) {
      cancelledRequests.add(requestId);
      activeChildren.get(requestId)?.kill();
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

async function main() {
  if (process.argv[2] === "--follow-session") {
    const sessionId = requireSessionId(process.argv[3]);
    await collaborate(`background:${sessionId}`, { session_id: sessionId, max_wait_seconds: DEFAULT_MAX_WAIT_SECONDS });
    return;
  }

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("close", closeTransport);
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      void handleMessage(JSON.parse(line));
    } catch {
      // Ignore malformed transport lines; valid requests receive JSON-RPC errors above.
    }
  });
}

if (path.resolve(process.argv[1] || "") === THIS_FILE) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
