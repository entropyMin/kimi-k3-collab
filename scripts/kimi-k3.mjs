#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { connectLocalWebSocket } from "./lib/local-websocket.mjs";

const K3_MODEL = "kimi-code/k3";
const KIMI_HOME = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));
const JOB_ROOT = path.join(KIMI_HOME, "codex-jobs");
const LOCK_FILE = path.join(KIMI_HOME, "server", "lock");
const TOKEN_FILE = path.join(KIMI_HOME, "server.token");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const COMPLETE_STATES = new Set(["completed", "cancelled", "failed", "error", "stopped", "end_turn"]);
const FAILURE_STATES = new Set(["cancelled", "failed", "error", "stopped"]);
const READ_ONLY_TOOLS = [
  "Read", "ReadMediaFile", "Glob", "Grep", "WebSearch", "FetchURL", "TodoList",
  "Agent", "Skill", "TaskList", "TaskOutput", "GetGoal"
];
const TERMINAL_EVENTS = new Set(["turn.ended", "prompt.completed", "prompt.aborted"]);
const PROCESS_DEADLINE = Date.now() + 115000;
const STREAM_EXIT_RESERVE_MS = 10000;

function boundedTimeout(requested, reserve = 1000) {
  const remaining = PROCESS_DEADLINE - Date.now() - reserve;
  if (remaining <= 0) {
    throw new Error("Kimi bridge command budget exhausted; the persistent job can be resumed by session id.");
  }
  return Math.max(1, Math.min(requested, remaining));
}

function assertRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 18 || (major === 18 && minor < 18)) {
    throw new Error(`Node.js 18.18 or newer is required; found ${process.versions.node}.`);
  }
}

function parseArgs(argv) {
  const [action = "ensure", ...tokens] = argv;
  const options = {
    action,
    mode: "analyze",
    focus: "general",
    cwd: process.cwd(),
    outputFormat: "json",
    waitSeconds: 0,
    maxWaitSeconds: 105,
    allowedPaths: []
  };
  const names = new Map([
    ["--mode", "mode"],
    ["--focus", "focus"],
    ["--cwd", "cwd"],
    ["--prompt", "prompt"],
    ["--prompt-file", "promptFile"],
    ["--allowed-path", "allowedPaths"],
    ["--session-id", "sessionId"],
    ["--format", "outputFormat"],
    ["--wait-seconds", "waitSeconds"],
    ["--max-wait-seconds", "maxWaitSeconds"]
  ]);

  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const key = names.get(flag);
    const value = tokens[index + 1];
    if (!key || value == null) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    if (key === "allowedPaths") {
      options.allowedPaths.push(value);
    } else if (key === "waitSeconds" || key === "maxWaitSeconds") {
      options[key] = Number(value);
    } else {
      options[key] = value;
    }
  }

  if (!["ensure", "delegate", "latest", "start", "status", "watch", "result", "cancel"].includes(options.action)) {
    throw new Error(`Unknown action: ${options.action}`);
  }
  if (!["analyze", "execute"].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (!["general", "engineering", "visual"].includes(options.focus)) {
    throw new Error(`Unsupported focus: ${options.focus}`);
  }
  if (!["json", "text"].includes(options.outputFormat)) {
    throw new Error(`Unsupported output format: ${options.outputFormat}`);
  }
  if (!Number.isInteger(options.waitSeconds) || options.waitSeconds < 0 || options.waitSeconds > 110) {
    throw new Error("--wait-seconds must be an integer from 0 to 110.");
  }
  if (!Number.isInteger(options.maxWaitSeconds) || options.maxWaitSeconds < 1 || options.maxWaitSeconds > 3600) {
    throw new Error("--max-wait-seconds must be an integer from 1 to 3600.");
  }
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatFooter(value) {
  const status = value.status || value;
  const sessionId = value.session_id || status.session_id || "unknown";
  const rawState = String(value.state || status.state || (value.complete ? "completed" : "running"));
  const state = rawState === "end_turn" ? "completed" : rawState;
  const model = value.server_reported_model || status.server_reported_model || value.explicit_model || K3_MODEL;
  const verified = value.verified_k3 ?? status.verified_k3;
  const verification = verified ? "verified" : "NOT VERIFIED";
  const context = [value.mode && `Mode: ${value.mode}`, value.focus && `Focus: ${value.focus}`].filter(Boolean).join("\n");
  const contextBlock = context ? `${context}\n` : "";
  return `---\nKimi K3 session: ${sessionId}\n${contextBlock}Status: ${state}\nModel: ${model} (${verification})\n`;
}

function formatText(value) {
  if (value.kind === "kimi-k3-service") {
    return `Kimi K3 service is healthy.\nModel: ${value.model} (verified)\nServer: ${value.host}:${value.port}\n`;
  }

  if (value.kind === "kimi-k3-job-cancel") {
    return `Kimi K3 prompt ${value.aborted ? "cancelled" : "was not active"}.\nSession: ${value.session_id}\n`;
  }

  const status = value.status || value;
  const sessionId = value.session_id || status.session_id || "unknown";
  const rawState = String(value.state || status.state || (value.complete ? "completed" : "running"));
  const state = rawState === "end_turn" ? "completed" : rawState;
  const model = value.server_reported_model || status.server_reported_model || value.explicit_model || K3_MODEL;
  const verified = value.verified_k3 ?? status.verified_k3;
  const verification = verified ? "verified" : "NOT VERIFIED";
  const context = [value.mode && `Mode: ${value.mode}`, value.focus && `Focus: ${value.focus}`].filter(Boolean).join("\n");
  const contextBlock = context ? `${context}\n` : "";

  if (value.kind === "kimi-k3-job") {
    return `Kimi K3 started.\nSession: ${sessionId}\n${contextBlock}Status: ${state}\nModel: ${model} (${verification})\n`;
  }

  if (value.kind === "kimi-k3-job-status") {
    return `Kimi K3 is ${value.busy ? "working" : "idle"}.\nSession: ${sessionId}\n${contextBlock}Status: ${state}\nModel: ${model} (${verification})\n`;
  }

  let report = "Kimi K3 is still working.";
  if (value.error) {
    report = `Kimi K3 collaboration stopped: ${value.error}`;
  } else if (typeof value.result === "string" && value.result.trim()) {
    report = value.result.trimEnd();
  } else if (state === "blocked") {
    report = "Kimi K3 is blocked waiting for interaction.";
  } else if (FAILURE_STATES.has(state)) {
    report = `Kimi K3 stopped with status: ${state}.`;
  } else if (value.complete) {
    report = "Kimi K3 completed without a text report.";
  }
  return `${report}\n\n${formatFooter(value)}`;
}

function printOutput(value, outputFormat) {
  if (outputFormat === "text") {
    process.stdout.write(formatText(value));
    return;
  }
  printJson(value);
}

function printStreamConclusion(outcome) {
  if (!outcome.assistantStreamed) {
    process.stdout.write(formatText(outcome.record));
    return;
  }
  if (!outcome.record.complete) {
    process.stdout.write("\n\nK3 · Stream checkpoint saved; K3 is still working.\n\n");
  } else {
    process.stdout.write("\n\n");
  }
  process.stdout.write(formatFooter(outcome.record));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && command === "kimi",
    timeout: boundedTimeout(options.timeout ?? 20000),
    maxBuffer: 4 * 1024 * 1024
  });
}

function resolveKimiCommand() {
  const bundledName = process.platform === "win32" ? "kimi.exe" : "kimi";
  const candidates = [
    process.env.KIMI_CODE_BIN,
    path.join(KIMI_HOME, "bin", bundledName),
    "kimi"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = runCommand(candidate, ["--version"]);
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error("Kimi Code CLI was not found. Install `kimi` or set KIMI_CODE_BIN to its executable path.");
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function readService() {
  if (!fs.existsSync(LOCK_FILE) || !fs.existsSync(TOKEN_FILE)) {
    return null;
  }

  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    const host = String(lock.host ?? "");
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`Refusing non-loopback Kimi server host: ${host}`);
    }
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (!token) {
      return null;
    }
    const urlHost = host === "::1" ? "[::1]" : host;
    const baseUrl = `http://${urlHost}:${Number(lock.port)}`;
    const headers = { Authorization: `Bearer ${token}` };
    const health = await fetchJson(`${baseUrl}/api/v1/healthz`, { headers }, 3000);
    if (health?.code !== 0) {
      return null;
    }
    return {
      baseUrl,
      headers,
      host,
      port: Number(lock.port),
      pid: Number(lock.pid),
      version: String(lock.version ?? "")
    };
  } catch (error) {
    if (String(error?.message).startsWith("Refusing non-loopback")) {
      throw error;
    }
    return null;
  }
}

async function ensureService() {
  let service = await readService();
  if (service) {
    return service;
  }

  const command = resolveKimiCommand();
  const started = runCommand(command, ["server", "run", "--keep-alive", "--log-level", "warn"], { timeout: 60000 });
  if (started.error) {
    throw started.error;
  }
  if (started.status !== 0) {
    throw new Error((started.stderr || started.stdout || `Kimi server exited with ${started.status}`).trim());
  }

  const deadline = Math.min(Date.now() + 15000, PROCESS_DEADLINE - 1000);
  while (Date.now() < deadline) {
    await sleep(250);
    service = await readService();
    if (service) {
      return service;
    }
  }
  throw new Error("Kimi local server did not become healthy within 15 seconds.");
}

async function callApi(method, endpoint, body) {
  const service = await ensureService();
  const options = { method, headers: { ...service.headers } };
  if (body != null) {
    options.headers["Content-Type"] = "application/json; charset=utf-8";
    options.body = JSON.stringify(body);
  }
  const response = await fetchJson(`${service.baseUrl}${endpoint}`, options);
  if (response?.code !== 0) {
    throw new Error(`Kimi API error ${response?.code}: ${response?.msg ?? "unknown error"}`);
  }
  return response.data;
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (process.platform !== "win32" || !fs.existsSync(file) || !["EEXIST", "EPERM"].includes(error?.code)) {
      throw error;
    }
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  }
}

function validateSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
    throw new Error("Kimi session id contains unsupported characters.");
  }
  return sessionId;
}

function writeJobRecord(record) {
  const sessionId = validateSessionId(record.session_id);
  writeJsonFile(path.join(JOB_ROOT, `${sessionId}.json`), record);
  writeJsonFile(path.join(JOB_ROOT, "latest.json"), record);
}

function createJobRecord(job, options) {
  return {
    kind: "kimi-k3-native-delegation",
    session_id: job.session_id,
    prompt_id: job.prompt_id,
    state: job.state,
    complete: false,
    mode: options.mode,
    focus: options.focus,
    cwd: path.resolve(options.cwd),
    explicit_model: job.explicit_model,
    server_reported_model: job.server_reported_model,
    verified_k3: job.verified_k3,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: null,
    cursor: { seq: 0 }
  };
}

function readJobRecord(sessionId) {
  const file = path.join(JOB_ROOT, `${validateSessionId(sessionId)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function requireSessionId(options) {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw new Error("--session-id is required.");
  }
  return validateSessionId(sessionId);
}

function verifyWithinRoot(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Allowed path is outside the working directory: ${candidate}`);
}

async function getJobStatus(sessionId) {
  const escaped = encodeURIComponent(sessionId);
  const [session, runtime] = await Promise.all([
    callApi("GET", `/api/v1/sessions/${escaped}`),
    callApi("GET", `/api/v1/sessions/${escaped}/status`)
  ]);
  const record = readJobRecord(sessionId);
  const mode = session.metadata?.mode || record?.mode;
  const state = session.pending_interaction && session.pending_interaction !== "none"
    ? "blocked"
    : runtime.busy
      ? "running"
      : session.last_turn_reason || "idle";
  const planMode = Boolean(runtime.plan_mode);

  return {
    kind: "kimi-k3-job-status",
    session_id: sessionId,
    state: String(state),
    busy: Boolean(runtime.busy),
    pending_interaction: String(session.pending_interaction || "none"),
    last_turn_reason: String(session.last_turn_reason || ""),
    explicit_model: K3_MODEL,
    session_model: String(session.agent_config?.model || ""),
    server_reported_model: String(runtime.model || ""),
    thinking: String(runtime.thinking_level || ""),
    plan_mode: planMode,
    permission_mode: String(runtime.permission || ""),
    verified_k3: String(runtime.model || "") === K3_MODEL,
    message_count: Number(session.message_count || 0),
    mode: mode || "",
    focus: String(record?.focus || session.metadata?.focus || "")
  };
}

function focusPrompt(focus) {
  if (focus === "visual") {
    return "Prefer visual hierarchy, composition, spacing, typography, color, responsive behavior, interaction polish, image quality, accessibility, and consistency with the product context.";
  }
  if (focus === "engineering") {
    return "Prefer architecture, API and data design, correctness, failure modes, security, reliability, performance, maintainability, testability, migration and rollback strategy, and operational simplicity.";
  }
  return "Select the most relevant engineering, product, and visual criteria for the task. Treat the focus as a preference rather than a boundary.";
}

async function startJob(options) {
  if (options.prompt && options.promptFile) {
    throw new Error("Use either --prompt or --prompt-file, not both.");
  }
  const prompt = options.promptFile
    ? fs.readFileSync(path.resolve(options.promptFile), "utf8")
    : options.prompt ?? (!process.stdin.isTTY ? fs.readFileSync(0, "utf8") : undefined);
  if (!prompt?.trim()) {
    throw new Error("A non-empty --prompt or --prompt-file is required.");
  }

  const root = path.resolve(options.cwd);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${root}`);
  }
  const readOnly = options.mode === "analyze";
  const planMode = false;
  const permissionMode = readOnly ? "manual" : "auto";
  let scopeText = "";
  if (!readOnly) {
    const items = options.allowedPaths.flatMap((value) => value.split(";")).map((value) => value.trim()).filter(Boolean);
    if (items.length === 0) {
      throw new Error("Execution mode requires at least one --allowed-path.");
    }
    const allowed = items.map((item) => verifyWithinRoot(root, item));
    scopeText = `\nYou may edit only these paths:\n- ${allowed.join("\n- ")}`;
  }

  const systemPrompt = readOnly
    ? `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nANALYSIS ONLY: do not create, edit, delete, move, or rename files. Do not call Bash, Shell, or another command-execution tool; use the configured read-only inspection tools instead. You may use TodoList to organize the review. Inspect relevant project files and assets as needed.\nReview the proposal or implementation, challenge assumptions, compare material tradeoffs, and identify concrete risks or defects. Return a concise verdict, ranked findings backed by evidence, recommended changes, and acceptance checks. Distinguish observed facts from inference.`
    : `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nThe user has authorized the scoped implementation described in the task. Inspect before editing, preserve unrelated user changes, and do not touch files outside the allowed paths.${scopeText}\nImplement the requested work, verify it with appropriate tests, static checks, or rendered evidence, and return the files changed, decisions made, and verification results.`;

  const session = await callApi("POST", "/api/v1/sessions", {
    title: `Codex K3 collaboration (${options.focus}, ${options.mode})`,
    metadata: { cwd: root, focus: options.focus, mode: options.mode },
    agent_config: {
      model: K3_MODEL,
      system_prompt: systemPrompt.trim(),
      tools: readOnly ? READ_ONLY_TOOLS : undefined,
      thinking: "max",
      permission_mode: permissionMode,
      plan_mode: planMode,
      swarm_mode: false
    }
  });
  const escaped = encodeURIComponent(String(session.id));
  const profile = {
    agent_config: {
      model: K3_MODEL,
      system_prompt: systemPrompt.trim(),
      thinking: "max",
      permission_mode: permissionMode,
      plan_mode: planMode,
      swarm_mode: false,
      ...(readOnly ? { tools: READ_ONLY_TOOLS } : {})
    }
  };
  await callApi("POST", `/api/v1/sessions/${escaped}/profile`, profile);
  const configured = await callApi("GET", `/api/v1/sessions/${escaped}/status`);
  if (
    configured.model !== K3_MODEL ||
    configured.thinking_level !== "max" ||
    configured.permission !== permissionMode ||
    Boolean(configured.plan_mode)
  ) {
    throw new Error(`Kimi session configuration verification failed for ${session.id}.`);
  }

  const submitted = await callApi("POST", `/api/v1/sessions/${escaped}/prompts`, {
    // Kimi Code 0.26 accepts profile system_prompt/tools fields but does not
    // apply them on its legacy REST route. Keep the profile fields for newer
    // servers and repeat the collaboration contract in the task for 0.26.
    content: [{ type: "text", text: `${systemPrompt.trim()}\n\nTask from Codex:\n${prompt.trim()}` }],
    metadata: { delegated_by: "codex", collaboration: options.focus },
    model: K3_MODEL,
    thinking: "max",
    permission_mode: permissionMode,
    plan_mode: planMode,
    swarm_mode: false
  });

  return {
    kind: "kimi-k3-job",
    session_id: String(session.id),
    prompt_id: String(submitted.prompt_id),
    state: String(submitted.status),
    mode: options.mode,
    focus: options.focus,
    explicit_model: K3_MODEL,
    server_reported_model: String(configured.model),
    thinking: String(configured.thinking_level),
    plan_mode: Boolean(configured.plan_mode),
    read_only_tools: readOnly ? READ_ONLY_TOOLS : null,
    verified_k3: configured.model === K3_MODEL,
    persistent_server: true
  };
}

async function rejectAnalysisApproval(sessionId, approval) {
  const approvalId = String(approval.approval_id || "").trim();
  if (!approvalId) throw new Error("Kimi approval event did not include an approval id.");
  try {
    return await callApi(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        decision: "rejected",
        feedback: "Codex requested read-only analysis. Use Read, Grep, Glob, ReadMediaFile, WebSearch, or FetchURL instead."
      }
    );
  } catch (error) {
    if (String(error).includes("40902")) return { resolved: false };
    throw error;
  }
}

async function getLatestAssistantText(sessionId) {
  const escaped = encodeURIComponent(sessionId);
  const messages = await callApi("GET", `/api/v1/sessions/${escaped}/messages?page_size=100&role=assistant`);
  const candidates = (messages.items || []).filter((message) =>
    message.content?.some((item) => item.type === "text" && String(item.text || "").trim())
  );
  const latest = candidates.reduce((newest, message) => {
    if (!newest) return message;
    const candidateTime = Date.parse(message.created_at || "");
    const newestTime = Date.parse(newest.created_at || "");
    return Number.isFinite(candidateTime) && (!Number.isFinite(newestTime) || candidateTime > newestTime) ? message : newest;
  }, null);
  const text = latest?.content
    ?.filter((item) => item.type === "text" && String(item.text || "").trim())
    .map((item) => String(item.text))
    .join("\n\n") || null;
  return text;
}

async function syncJobRecord(sessionId, record = readJobRecord(sessionId), settle = false) {
  let status = await getJobStatus(sessionId);
  if (settle) {
    for (let attempt = 0; status.busy && attempt < 5; attempt += 1) {
      await sleep(100);
      status = await getJobStatus(sessionId);
    }
  }
  const text = await getLatestAssistantText(sessionId);
  const complete = !status.busy
    && status.pending_interaction === "none"
    && (COMPLETE_STATES.has(status.state) || Boolean(status.last_turn_reason));
  const next = record || {
    kind: "kimi-k3-native-delegation",
    session_id: sessionId,
    explicit_model: K3_MODEL,
    started_at: new Date().toISOString(),
    cursor: { seq: 0 }
  };
  const observedState = String(next.state || "");
  const observedTerminal = Boolean(next.complete) || observedState === "blocked" || FAILURE_STATES.has(observedState);
  const preserveObserved = settle && observedTerminal && !complete;
  Object.assign(next, {
    state: preserveObserved ? observedState : status.state,
    complete: preserveObserved ? Boolean(next.complete) : complete,
    server_reported_model: status.server_reported_model,
    verified_k3: status.verified_k3,
    updated_at: new Date().toISOString(),
    result: text ?? next.result ?? null,
    mode: next.mode || status.mode,
    focus: next.focus || status.focus
  });
  writeJobRecord(next);
  return {
    kind: "kimi-k3-job-result",
    session_id: sessionId,
    status,
    complete,
    result: text,
    record: next
  };
}

function compact(value, maximum = 260) {
  const text = String(value ?? "")
    .replace(/(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/(--?(?:api[-_]?key|token|password|secret)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD))=\S+/g, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function actionLine(state, text) {
  const prefix = state.assistantActive ? "\n\n" : "";
  state.assistantActive = false;
  return `${prefix}K3 · ${compact(text)}\n`;
}

function describeTool(payload) {
  const display = payload.display || {};
  if (display.kind === "command") return `Running command: ${display.command}`;
  if (display.kind === "file_io") return `${display.operation || "accessing"} ${display.path}`;
  if (display.kind === "diff") return `Reviewing diff: ${display.path}`;
  if (display.kind === "search") return `Searching for “${display.query}”${display.scope ? ` in ${display.scope}` : ""}`;
  if (display.kind === "url_fetch") return `Fetching ${display.url}`;
  if (display.kind === "agent_call") return `Calling ${display.agent_name} subagent`;
  if (display.kind === "skill_call") return `Using ${display.skill_name} skill`;
  if (display.kind === "task") return `${display.status || "Working on"} task: ${display.description}`;
  if (display.kind === "task_stop") return `Stopping task: ${display.task_description}`;
  if (display.kind === "goal_start") return `Starting goal: ${display.objective}`;
  if (display.kind === "generic") return display.summary;
  return payload.description || `Using ${payload.name || "tool"}`;
}

export function createRenderState() {
  return {
    assistantActive: false,
    assistantStreamed: false,
    tools: new Map(),
    subagents: new Map(),
    lastProgress: "",
    lastProgressAt: 0
  };
}

export function renderK3Event(event, state = createRenderState()) {
  const payload = event?.payload || {};
  if (event?.type === "assistant.delta") {
    const delta = String(payload.delta || "");
    if (!delta) return "";
    const prefix = state.assistantActive || state.assistantStreamed ? "" : "\n";
    state.assistantActive = true;
    state.assistantStreamed = true;
    return `${prefix}${delta}`;
  }
  if (event?.type === "thinking.delta" || event?.type === "turn.step.started" || event?.type === "turn.step.completed") {
    return "";
  }
  if (event?.type === "turn.started") return actionLine(state, "Turn started");
  if (event?.type === "tool.call.started") {
    state.tools.set(payload.toolCallId, payload.name || "Tool");
    return actionLine(state, describeTool(payload));
  }
  if (event?.type === "tool.progress") {
    const progress = compact(payload.update?.message || payload.update?.description || payload.update?.status || "");
    if (!progress || progress === state.lastProgress || Date.now() - state.lastProgressAt < 2000) return "";
    state.lastProgress = progress;
    state.lastProgressAt = Date.now();
    return actionLine(state, progress);
  }
  if (event?.type === "tool.result") {
    const name = state.tools.get(payload.toolCallId) || "Tool";
    return actionLine(state, `${name} ${payload.isError ? "failed" : "completed"}`);
  }
  if (event?.type === "subagent.spawned") {
    const name = payload.subagentName || "subagent";
    state.subagents.set(payload.subagentId, name);
    return actionLine(state, `Spawned ${name}${payload.description ? `: ${payload.description}` : ""}`);
  }
  if (event?.type === "subagent.started") {
    return actionLine(state, `${state.subagents.get(payload.subagentId) || "Subagent"} started`);
  }
  if (event?.type === "subagent.completed") {
    return actionLine(state, `${state.subagents.get(payload.subagentId) || "Subagent"} completed`);
  }
  if (event?.type === "warning") return actionLine(state, `Warning: ${payload.message || "unknown warning"}`);
  if (event?.type === "error") return actionLine(state, `Error: ${payload.message || payload.code || "unknown error"}`);
  if (event?.type === "turn.ended" && payload.reason && payload.reason !== "completed") {
    return actionLine(state, `Turn ended: ${payload.reason}`);
  }
  return "";
}

function isNewEvent(record, event) {
  if (!Number.isInteger(event?.seq)) return true;
  if (!record.cursor || record.cursor.epoch !== event.epoch) return true;
  return event.seq > record.cursor.seq;
}

export function applyK3Event(record, event) {
  if (Number.isInteger(event?.seq)) {
    record.cursor = { seq: event.seq, ...(event.epoch ? { epoch: event.epoch } : {}) };
  }
  record.last_event_type = String(event?.type || "");
  record.updated_at = new Date().toISOString();
  const payload = event?.payload || {};
  if (event?.type === "turn.started") {
    record.state = "running";
    record.complete = false;
  } else if (event?.type === "turn.ended") {
    record.state = String(payload.reason || "completed");
    record.complete = payload.reason !== "blocked";
  } else if (event?.type === "prompt.completed") {
    record.state = String(payload.reason || "completed");
    record.complete = true;
  } else if (event?.type === "prompt.aborted") {
    record.state = "cancelled";
    record.complete = true;
  }
  return record;
}

function cursorPayload(sessionId, record) {
  const cursor = record?.cursor && Number.isInteger(record.cursor.seq) ? record.cursor : { seq: 0 };
  return { [sessionId]: cursor };
}

async function streamJob(sessionId, waitSeconds, onText = () => {}) {
  let record = readJobRecord(sessionId);
  if (record?.complete) {
    const synced = await syncJobRecord(sessionId, record);
    return { record: synced.record, assistantStreamed: false };
  }
  if (waitSeconds === 0) {
    const synced = await syncJobRecord(sessionId, record);
    return { record: synced.record, assistantStreamed: false };
  }

  const service = await ensureService();
  const deadline = Math.min(Date.now() + waitSeconds * 1000, PROCESS_DEADLINE - STREAM_EXIT_RESERVE_MS);
  const renderState = createRenderState();
  let lastWrite = 0;
  let reconnectDelay = 250;
  while (Date.now() < deadline && !record?.complete) {
    let websocket;
    try {
      websocket = await connectLocalWebSocket({
        host: service.host,
        port: service.port,
        headers: service.headers
      });
      const helloId = randomUUID();
      websocket.sendJson({
        type: "client_hello",
        id: helloId,
        payload: {
          client_id: `codex-k3-bridge-${process.pid}`,
          subscriptions: [sessionId],
          cursors: cursorPayload(sessionId, record)
        }
      });
      reconnectDelay = 250;
      while (Date.now() < deadline) {
        const message = await websocket.nextMessage(Math.min(30000, deadline - Date.now()));
        if (message == null) continue;
        let frame;
        try {
          frame = JSON.parse(message);
        } catch {
          continue;
        }
        if (frame.type === "ping") {
          websocket.sendJson({ type: "pong", payload: { nonce: String(frame.payload?.nonce || "") } });
          continue;
        }
        if (frame.type === "ack" && frame.id === helloId) {
          if (Number(frame.code) !== 0) throw new Error(`Kimi WebSocket subscription failed: ${frame.msg || frame.code}`);
          if (frame.payload?.resync_required?.includes(sessionId)) {
            const synced = await syncJobRecord(sessionId, record);
            record = synced.record;
            const cursor = frame.payload?.cursors?.[sessionId];
            if (cursor) record.cursor = cursor;
            writeJobRecord(record);
          }
          continue;
        }
        if (frame.type === "resync_required" && frame.payload?.session_id === sessionId) {
          const synced = await syncJobRecord(sessionId, record);
          record = synced.record;
          record.cursor = {
            seq: Number(frame.payload.current_seq || 0),
            ...(frame.payload.epoch ? { epoch: frame.payload.epoch } : {})
          };
          writeJobRecord(record);
          onText(actionLine(renderState, "Event history resynced from the durable session"));
          continue;
        }
        if (frame.type === "error" && frame.payload?.fatal) {
          throw new Error(`Kimi WebSocket error: ${frame.payload.msg || frame.payload.code}`);
        }
        if (frame.session_id && frame.session_id !== sessionId) continue;
        if (!Number.isInteger(frame.seq) || !frame.payload || !isNewEvent(record || {}, frame)) continue;
        if (!record) {
          const synced = await syncJobRecord(sessionId, null);
          record = synced.record;
        }
        if (record.mode === "analyze" && frame.type === "event.approval.requested") {
          await rejectAnalysisApproval(sessionId, frame.payload);
          const toolCallId = String(frame.payload.tool_call_id || "");
          if (!toolCallId) throw new Error("Kimi approval event did not include a tool call id.");
          record.denied_tool_call_ids = [...new Set([...(record.denied_tool_call_ids || []), toolCallId])];
          applyK3Event(record, frame);
          writeJobRecord(record);
          onText(actionLine(renderState, `Denied ${frame.payload.tool_name || "approval-gated tool"} in read-only analysis`));
          continue;
        }
        if (
          record.mode === "analyze" &&
          (frame.type === "tool.call.started" || frame.type === "tool.result") &&
          record.denied_tool_call_ids?.includes(frame.payload.toolCallId)
        ) {
          applyK3Event(record, frame);
          if (frame.type === "tool.result") {
            record.denied_tool_call_ids = record.denied_tool_call_ids.filter((id) => id !== frame.payload.toolCallId);
          }
          writeJobRecord(record);
          continue;
        }
        if (record.mode === "analyze" && frame.type === "tool.call.started" && !READ_ONLY_TOOLS.includes(frame.payload.name)) {
          applyK3Event(record, frame);
          const cancellation = await abortActivePrompt(sessionId);
          Object.assign(record, {
            state: "error",
            complete: true,
            error: `Read-only analysis attempted disallowed tool: ${frame.payload.name || "unknown"}.`,
            cancellation
          });
          writeJobRecord(record);
          onText(actionLine(renderState, record.error));
          websocket.close();
          return { record, assistantStreamed: renderState.assistantStreamed };
        }
        applyK3Event(record, frame);
        const rendered = renderK3Event(frame, renderState);
        if (rendered) onText(rendered);
        if (!frame.volatile || Date.now() - lastWrite >= 500 || TERMINAL_EVENTS.has(frame.type)) {
          writeJobRecord(record);
          lastWrite = Date.now();
        }
        if (TERMINAL_EVENTS.has(frame.type)) {
          const synced = await syncJobRecord(sessionId, record, true);
          websocket.close();
          return { record: synced.record, assistantStreamed: renderState.assistantStreamed };
        }
      }
    } catch (error) {
      if (record?.complete || record?.state === "blocked" || FAILURE_STATES.has(record?.state)) {
        return { record, assistantStreamed: renderState.assistantStreamed };
      }
      if (Date.now() >= deadline) break;
      onText(actionLine(renderState, `Event stream reconnecting: ${error instanceof Error ? error.message : String(error)}`));
      await sleep(Math.min(reconnectDelay, Math.max(0, deadline - Date.now())));
      reconnectDelay = Math.min(reconnectDelay * 2, 4000);
    } finally {
      websocket?.close();
      if (record) writeJobRecord(record);
    }
  }
  const synced = await syncJobRecord(sessionId, record);
  return { record: synced.record, assistantStreamed: renderState.assistantStreamed };
}

async function abortActivePrompt(sessionId) {
  const escaped = encodeURIComponent(sessionId);
  const prompts = await callApi("GET", `/api/v1/sessions/${escaped}/prompts`);
  if (!prompts.active) {
    return { prompt_id: null, aborted: false, reason: "no-active-prompt" };
  }
  const promptId = String(prompts.active.prompt_id);
  const response = await callApi("POST", `/api/v1/sessions/${escaped}/prompts/${encodeURIComponent(promptId)}:abort`, {});
  return { prompt_id: promptId, aborted: Boolean(response.aborted) };
}

async function delegate(options, onText = () => {}) {
  const job = await startJob(options);
  const record = createJobRecord(job, options);
  writeJobRecord(record);
  return streamJob(job.session_id, options.maxWaitSeconds, onText);
}

async function main() {
  assertRuntime();
  const options = parseArgs(process.argv.slice(2));

  if (options.action === "ensure") {
    const service = await ensureService();
    const models = await callApi("GET", "/api/v1/models");
    const model = models.items?.find((item) => item.model === K3_MODEL);
    if (!model) {
      throw new Error(`The local Kimi service does not advertise ${K3_MODEL}.`);
    }
    printOutput({
      kind: "kimi-k3-service",
      healthy: true,
      persistent: true,
      host: service.host,
      port: service.port,
      pid: service.pid,
      version: service.version,
      model: model.model,
      display_name: model.display_name,
      max_context_size: model.max_context_size
    }, options.outputFormat);
    return;
  }

  if (options.action === "latest") {
    const latest = path.join(JOB_ROOT, "latest.json");
    if (!fs.existsSync(latest)) {
      throw new Error("No persisted Kimi K3 delegation record was found.");
    }
    const record = JSON.parse(fs.readFileSync(latest, "utf8"));
    printOutput(record, options.outputFormat);
    return;
  }

  if (options.action === "start") {
    const job = await startJob(options);
    writeJobRecord(createJobRecord(job, options));
    printOutput(job, options.outputFormat);
    return;
  }

  if (options.action === "status") {
    printOutput(await getJobStatus(requireSessionId(options)), options.outputFormat);
    return;
  }

  if (options.action === "watch" || options.action === "result") {
    const outcome = await streamJob(
      requireSessionId(options),
      options.waitSeconds,
      options.outputFormat === "text" ? (value) => process.stdout.write(value) : undefined
    );
    if (options.outputFormat === "text") {
      printStreamConclusion(outcome);
    } else {
      printJson(outcome.record);
    }
    return;
  }

  if (options.action === "cancel") {
    const sessionId = requireSessionId(options);
    printOutput({ kind: "kimi-k3-job-cancel", session_id: sessionId, ...await abortActivePrompt(sessionId) }, options.outputFormat);
    return;
  }

  const outcome = await delegate(
    options,
    options.outputFormat === "text" ? (value) => process.stdout.write(value) : undefined
  );
  if (options.outputFormat === "text") {
    printStreamConclusion(outcome);
  } else {
    printJson(outcome.record);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
