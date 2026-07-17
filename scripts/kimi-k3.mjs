#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const K3_MODEL = "kimi-code/k3";
const KIMI_HOME = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));
const JOB_ROOT = path.join(KIMI_HOME, "codex-jobs");
const LOCK_FILE = path.join(KIMI_HOME, "server", "lock");
const TOKEN_FILE = path.join(KIMI_HOME, "server.token");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const COMPLETE_STATES = new Set(["completed", "cancelled", "failed", "error", "stopped", "end_turn"]);

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
    waitSeconds: 0,
    maxWaitSeconds: 1800,
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

  if (!["ensure", "delegate", "latest", "start", "status", "result", "cancel"].includes(options.action)) {
    throw new Error(`Unknown action: ${options.action}`);
  }
  if (!["analyze", "execute"].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (!["general", "engineering", "visual"].includes(options.focus)) {
    throw new Error(`Unsupported focus: ${options.focus}`);
  }
  if (!Number.isInteger(options.waitSeconds) || options.waitSeconds < 0 || options.waitSeconds > 55) {
    throw new Error("--wait-seconds must be an integer from 0 to 55.");
  }
  if (!Number.isInteger(options.maxWaitSeconds) || options.maxWaitSeconds < 1 || options.maxWaitSeconds > 3600) {
    throw new Error("--max-wait-seconds must be an integer from 1 to 3600.");
  }
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && command === "kimi",
    timeout: options.timeout ?? 20000,
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

  const deadline = Date.now() + 15000;
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

function writeJobRecord(record) {
  writeJsonFile(path.join(JOB_ROOT, `${record.session_id}.json`), record);
  writeJsonFile(path.join(JOB_ROOT, "latest.json"), record);
}

function requireSessionId(options) {
  if (!options.sessionId?.trim()) {
    throw new Error("--session-id is required.");
  }
  return options.sessionId.trim();
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
  const state = session.pending_interaction && session.pending_interaction !== "none"
    ? "blocked"
    : runtime.busy
      ? "running"
      : session.last_turn_reason || "idle";
  const expectedPlanMode = session.metadata?.mode === "analyze"
    ? true
    : session.metadata?.mode === "execute"
      ? false
      : null;
  const planMode = Boolean(runtime.plan_mode);
  const constraintDrift = Boolean(runtime.busy) && expectedPlanMode != null && planMode !== expectedPlanMode;

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
    expected_plan_mode: expectedPlanMode,
    constraint_drift: constraintDrift,
    permission_mode: String(runtime.permission || ""),
    verified_k3: String(runtime.model || "") === K3_MODEL,
    message_count: Number(session.message_count || 0)
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
  const planMode = options.mode === "analyze";
  let scopeText = "";
  if (!planMode) {
    const items = options.allowedPaths.flatMap((value) => value.split(";")).map((value) => value.trim()).filter(Boolean);
    if (items.length === 0) {
      throw new Error("Execution mode requires at least one --allowed-path.");
    }
    const allowed = items.map((item) => verifyWithinRoot(root, item));
    scopeText = `\nYou may edit only these paths:\n- ${allowed.join("\n- ")}`;
  }

  const systemPrompt = planMode
    ? `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nANALYSIS ONLY: do not create, edit, delete, move, or rename files. Inspect relevant project files and assets as needed.\nReview the proposal or implementation, challenge assumptions, compare material tradeoffs, and identify concrete risks or defects. Return a concise verdict, ranked findings backed by evidence, recommended changes, and acceptance checks. Distinguish observed facts from inference.`
    : `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nThe user has authorized the scoped implementation described in the task. Inspect before editing, preserve unrelated user changes, and do not touch files outside the allowed paths.${scopeText}\nImplement the requested work, verify it with appropriate tests, static checks, or rendered evidence, and return the files changed, decisions made, and verification results.`;

  const session = await callApi("POST", "/api/v1/sessions", {
    title: `Codex K3 collaboration (${options.focus}, ${options.mode})`,
    metadata: { cwd: root, focus: options.focus, mode: options.mode }
  });
  const escaped = encodeURIComponent(String(session.id));
  const profile = {
    agent_config: {
      model: K3_MODEL,
      system_prompt: systemPrompt.trim(),
      thinking: "max",
      permission_mode: "auto",
      plan_mode: planMode,
      swarm_mode: false
    }
  };
  await callApi("POST", `/api/v1/sessions/${escaped}/profile`, profile);
  const configured = await callApi("GET", `/api/v1/sessions/${escaped}/status`);
  if (configured.model !== K3_MODEL || configured.thinking_level !== "max" || Boolean(configured.plan_mode) !== planMode) {
    throw new Error(`Kimi session configuration verification failed for ${session.id}.`);
  }

  const submitted = await callApi("POST", `/api/v1/sessions/${escaped}/prompts`, {
    content: [{ type: "text", text: prompt }],
    metadata: { delegated_by: "codex", collaboration: options.focus },
    model: K3_MODEL,
    thinking: "max",
    permission_mode: "auto",
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
    verified_k3: configured.model === K3_MODEL,
    persistent_server: true
  };
}

async function getResult(sessionId, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let status;
  do {
    status = await getJobStatus(sessionId);
    if (!status.busy || status.constraint_drift || Date.now() >= deadline) {
      break;
    }
    await sleep(1000);
  } while (true);

  const escaped = encodeURIComponent(sessionId);
  const messages = await callApi("GET", `/api/v1/sessions/${escaped}/messages?page_size=100&role=assistant`);
  const latest = messages.items?.find((message) =>
    message.content?.some((item) => item.type === "text" && String(item.text || "").trim())
  );
  const text = latest?.content
    ?.filter((item) => item.type === "text" && String(item.text || "").trim())
    .map((item) => String(item.text))
    .join("\n\n") || null;

  return {
    kind: "kimi-k3-job-result",
    session_id: sessionId,
    status,
    complete: !status.busy && status.pending_interaction === "none" && (COMPLETE_STATES.has(status.state) || Boolean(status.last_turn_reason)),
    result: text
  };
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

async function delegate(options) {
  const job = await startJob(options);
  const record = {
    kind: "kimi-k3-native-delegation",
    session_id: job.session_id,
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
    result: null
  };
  writeJobRecord(record);

  const deadline = Date.now() + options.maxWaitSeconds * 1000;
  do {
    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const result = await getResult(job.session_id, Math.min(30, remainingSeconds));
    if (result.status.constraint_drift) {
      const cancellation = await abortActivePrompt(job.session_id);
      Object.assign(record, {
        state: "constraint-drift",
        complete: true,
        verified_k3: result.status.verified_k3,
        updated_at: new Date().toISOString(),
        result: result.result,
        error: "Kimi changed the active session plan-mode constraint; the prompt was aborted. Inspect the working tree before accepting any result.",
        cancellation
      });
      writeJobRecord(record);
      return record;
    }
    Object.assign(record, {
      state: result.status.state,
      complete: result.complete,
      server_reported_model: result.status.server_reported_model,
      verified_k3: result.status.verified_k3,
      updated_at: new Date().toISOString(),
      result: result.result
    });
    writeJobRecord(record);
    if (record.complete || Date.now() >= deadline) {
      return record;
    }
  } while (true);
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
    printJson({
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
    });
    return;
  }

  if (options.action === "latest") {
    const latest = path.join(JOB_ROOT, "latest.json");
    if (!fs.existsSync(latest)) {
      throw new Error("No persisted Kimi K3 delegation record was found.");
    }
    process.stdout.write(fs.readFileSync(latest, "utf8"));
    return;
  }

  if (options.action === "start") {
    printJson(await startJob(options));
    return;
  }

  if (options.action === "status") {
    printJson(await getJobStatus(requireSessionId(options)));
    return;
  }

  if (options.action === "result") {
    printJson(await getResult(requireSessionId(options), options.waitSeconds));
    return;
  }

  if (options.action === "cancel") {
    const sessionId = requireSessionId(options);
    printJson({ kind: "kimi-k3-job-cancel", session_id: sessionId, ...await abortActivePrompt(sessionId) });
    return;
  }

  printJson(await delegate(options));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
