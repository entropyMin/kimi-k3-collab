#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { connectLocalWebSocket } from "./lib/local-websocket.mjs";
import { READ_ONLY_TOOLS, isReadOnlyTool } from "./lib/k3-policy.mjs";

const K3_MODEL = "kimi-code/k3";
const TESTED_KIMI_CODE_VERSIONS = new Set(["0.26.0", "0.29.0"]);
const KIMI_HOME = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));
const JOB_ROOT = path.join(KIMI_HOME, "codex-jobs");
const WORKTREE_ROOT = path.join(KIMI_HOME, "codex-worktrees");
const WRITE_LOCK_ROOT = path.join(JOB_ROOT, "write-locks");
const LOCK_FILE = path.join(KIMI_HOME, "server", "lock");
const INSTANCE_ROOT = path.join(KIMI_HOME, "server", "instances");
const TOKEN_FILE = path.join(KIMI_HOME, "server.token");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const COMPLETE_STATES = new Set(["completed", "cancelled", "failed", "error", "stopped", "end_turn"]);
const FAILURE_STATES = new Set(["cancelled", "failed", "error", "stopped"]);
const PROMPT_TERMINAL_EVENTS = new Set(["prompt.completed", "prompt.aborted"]);
const CHECKPOINT_EVENTS = new Set(["turn.ended", "error", ...PROMPT_TERMINAL_EVENTS]);
const TERMINAL_PROVIDER_ERROR_CODES = new Set(["provider.api_error", "provider.rate_limit"]);
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
    ["--approval-id", "approvalId"],
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

  if (!["ensure", "delegate", "latest", "start", "send", "status", "watch", "result", "cancel", "reject-approval"].includes(options.action)) {
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

function formatIntegration(value) {
  const integration = value.integration || value.record?.integration;
  if (!integration) return "";
  if (integration.isolation === "single-writer") {
    return `\n\n---\nExecution handoff: non-Git single-writer changes were made directly in ${integration.source_cwd}.`;
  }
  return `\n\n${[
    "---",
    "K3 isolated Git handoff",
    `State: ${integration.state}`,
    integration.branch && `Branch: ${integration.branch}`,
    integration.commit && `Commit: ${integration.commit}`,
    integration.changed_paths?.length && `Changed paths: ${integration.changed_paths.join(", ")}`,
    integration.ignored_paths?.length && `Ignored paths requiring review: ${integration.ignored_paths.join(", ")}`,
    integration.symlink_paths?.length && `Symbolic links or junctions: ${integration.symlink_paths.join(", ")}`,
    integration.overlapping_source_paths?.length && `Overlapping source changes: ${integration.overlapping_source_paths.join(", ")}`,
    integration.scope_violations?.length && `Scope violations: ${integration.scope_violations.join(", ")}`
  ].filter(Boolean).join("\n")}`;
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

  if (value.kind === "kimi-k3-message") {
    return `Follow-up sent to Kimi K3.\nSession: ${sessionId}\nStatus: ${state}\nModel: ${model} (${verification})\n`;
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
  return `${report}${formatIntegration(value)}\n\n${formatFooter(value)}`;
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
    cwd: options.cwd,
    input: options.input,
    timeout: boundedTimeout(options.timeout ?? 20000),
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
}

function checkedCommand(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.status}`).trim());
  }
  return result.stdout;
}

function runGit(cwd, args, options = {}) {
  return checkedCommand("git", ["-C", cwd, ...args], options);
}

function gitPath(value) {
  const normalized = String(value || "").split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized || ".";
}

export function pathsOverlap(left, right) {
  const a = gitPath(left);
  const b = gitPath(right);
  return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scopeViolations(changedPaths, allowedPaths) {
  return changedPaths.filter((changed) => !allowedPaths.some((allowed) => {
    const file = gitPath(changed);
    const scope = gitPath(allowed);
    return scope === "." || file === scope || file.startsWith(`${scope}/`);
  }));
}

function nullList(value) {
  return String(value || "").split("\0").filter(Boolean).map(gitPath);
}

function canonicalPath(value) {
  const missing = [];
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Path has no existing ancestor: ${value}`);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

function kimiCompatibility(version) {
  const normalized = String(version || "").match(/\d+\.\d+\.\d+/)?.[0] || null;
  return {
    version: normalized,
    status: normalized && TESTED_KIMI_CODE_VERSIONS.has(normalized) ? "tested" : "untested"
  };
}

function gitDirtyPaths(repo) {
  return [...new Set([
    ...nullList(runGit(repo, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])),
    ...nullList(runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
  ])];
}

function gitChangedPaths(repo, baseCommit) {
  return [...new Set([
    ...nullList(runGit(repo, ["diff", "--name-only", "--no-renames", "-z", baseCommit, "--"])),
    ...nullList(runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
  ])];
}

function gitIgnoredPaths(repo) {
  return [...new Set(nullList(runGit(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])))];
}

function symlinkPathsWithinScopes(root, scopes) {
  const links = new Set();
  const pending = scopes.map((scope) => ({
    absolute: path.join(root, ...gitPath(scope).split("/")),
    relative: gitPath(scope)
  }));
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current.absolute, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      links.add(current.relative);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current.absolute)) {
      pending.push({
        absolute: path.join(current.absolute, entry),
        relative: gitPath(path.posix.join(current.relative, entry))
      });
    }
  }
  return [...links].sort();
}

function findGitRepo(cwd) {
  const result = runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.error || result.status !== 0) return null;
  return canonicalPath(result.stdout.trim());
}

function removeGitWorktree(workspace, deleteBranch = false) {
  if (!workspace?.source_repo || !workspace?.worktree_root) return;
  const expectedRoot = path.resolve(WORKTREE_ROOT);
  const target = path.resolve(workspace.worktree_root);
  const relative = path.relative(expectedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove unexpected K3 worktree path: ${target}`);
  }
  if (fs.existsSync(target)) {
    runGit(workspace.source_repo, ["worktree", "remove", "--force", target]);
  }
  runCommand("git", ["-C", workspace.source_repo, "worktree", "prune"]);
  if (deleteBranch && workspace.branch) {
    runGit(workspace.source_repo, ["branch", "-D", workspace.branch]);
  }
  workspace.worktree_active = false;
}

function readSingleWriterOwner(lockPath) {
  const ownerFile = path.join(lockPath, "owner.json");
  try {
    return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  } catch {
    return null;
  }
}

function removeSingleWriterLock(lockPath, expectedToken = null) {
  if (!fs.existsSync(lockPath)) return true;
  const owner = readSingleWriterOwner(lockPath);
  if (expectedToken ? owner?.token !== expectedToken : owner?.token || owner?.session_id) return false;
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function releaseSingleWriter(workspace) {
  if (!workspace?.lock_path || !removeSingleWriterLock(workspace.lock_path, workspace.lock_token)) return;
  workspace.lock_active = false;
}

function singleWriterContention(canonicalCwd, detail = "") {
  const suffix = detail ? ` ${detail}` : "";
  return new Error(`A K3 execute session already owns the non-Git directory: ${canonicalCwd}.${suffix}`);
}

function missingKimiSession(error) {
  return /\bsession\b[^\r\n]{0,240}\b(?:does not exist|not found)\b/i.test(String(error?.message || error));
}

async function reclaimSingleWriter(lockPath, canonicalCwd, getOwnerStatus) {
  const owner = readSingleWriterOwner(lockPath);
  const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
  if (!stat) return true;
  const createdAt = Date.parse(owner?.created_at || "");
  const age = Date.now() - (Number.isFinite(createdAt) ? createdAt : stat.mtimeMs);
  if (!owner?.session_id) {
    if (age <= 120000) return false;
    return removeSingleWriterLock(lockPath, owner?.token || null);
  }

  const record = readJobRecord(owner.session_id);
  let status = null;
  try {
    status = await getOwnerStatus(owner.session_id);
  } catch (error) {
    if (!missingKimiSession(error)) {
      throw singleWriterContention(
        canonicalCwd,
        `The previous owner could not be verified, so the lock was kept: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (status?.busy || (status?.pending_interaction && status.pending_interaction !== "none")) return false;
  const terminal = !status || COMPLETE_STATES.has(status.state);
  const expiredIdle = status?.state === "idle" && age > 120000;
  if (!terminal && !expiredIdle) return false;

  if (record) {
    if (
      record.workspace?.isolation !== "single-writer" ||
      record.workspace.lock_token !== owner.token ||
      path.resolve(record.workspace.lock_path || "") !== lockPath
    ) {
      throw singleWriterContention(canonicalCwd, "The previous owner record does not match the lock.");
    }
    if (record.complete) {
      if (status && age <= 120000) return false;
      return removeSingleWriterLock(lockPath, owner.token);
    }
    Object.assign(record, {
      state: status?.state || "stopped",
      complete: true,
      updated_at: new Date().toISOString()
    });
    finalizeExecutionSafely(record);
    writeJobRecord(record);
  } else {
    return removeSingleWriterLock(lockPath, owner.token);
  }
  return !fs.existsSync(lockPath);
}

async function acquireSingleWriter(cwd, getOwnerStatus) {
  const canonicalCwd = canonicalPath(cwd);
  fs.mkdirSync(WRITE_LOCK_ROOT, { recursive: true, mode: 0o700 });
  const lockPath = path.join(WRITE_LOCK_ROOT, createHash("sha256").update(canonicalCwd).digest("hex"));
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!await reclaimSingleWriter(lockPath, canonicalCwd, getOwnerStatus)) {
        throw singleWriterContention(canonicalCwd);
      }
    }
  }
  const token = randomUUID();
  writeJsonFile(path.join(lockPath, "owner.json"), {
    token,
    cwd: canonicalCwd,
    session_id: null,
    created_at: new Date().toISOString()
  });
  return { lock_path: lockPath, lock_token: token, lock_active: true };
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

function serviceDescriptors() {
  const descriptors = [];
  const readDescriptor = (filename) => {
    try {
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      descriptors.push({
        ...value,
        version: value.version ?? value.host_version ?? "",
        freshness: Number(value.heartbeat_at ?? value.started_at ?? 0)
      });
    } catch {
      // Ignore incomplete or stale discovery files and try the remaining candidates.
    }
  };

  if (fs.existsSync(LOCK_FILE)) readDescriptor(LOCK_FILE);
  if (fs.existsSync(INSTANCE_ROOT)) {
    for (const entry of fs.readdirSync(INSTANCE_ROOT, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        readDescriptor(path.join(INSTANCE_ROOT, entry.name));
      }
    }
  }
  return descriptors.sort((left, right) => right.freshness - left.freshness);
}

async function readService() {
  const descriptors = serviceDescriptors();
  if (!descriptors.length || !fs.existsSync(TOKEN_FILE)) {
    return null;
  }

  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) return null;
  let refusedHost = null;
  for (const descriptor of descriptors) {
    const host = String(descriptor.host ?? "");
    if (!LOOPBACK_HOSTS.has(host)) {
      refusedHost ||= host;
      continue;
    }
    const port = Number(descriptor.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    try {
      const urlHost = host === "::1" ? "[::1]" : host;
      const baseUrl = `http://${urlHost}:${port}`;
      const headers = { Authorization: `Bearer ${token}` };
      const health = await fetchJson(`${baseUrl}/api/v1/healthz`, { headers }, 3000);
      if (health?.code !== 0) continue;
      let meta = null;
      try {
        const response = await fetchJson(`${baseUrl}/api/v1/meta`, { headers }, 3000);
        if (response?.code === 0) meta = response.data;
      } catch {
        // Kimi Code 0.26 does not require the optional metadata endpoint.
      }
      return {
        baseUrl,
        headers,
        host,
        port,
        pid: Number(descriptor.pid) || null,
        version: String(descriptor.version || meta?.server_version || ""),
        capabilities: meta?.capabilities || null,
        backend: meta?.backend || null
      };
    } catch {
      // A stale instance file must not hide another live loopback instance.
    }
  }
  if (refusedHost) throw new Error(`Refusing non-loopback Kimi server host: ${refusedHost}`);
  return null;
}

export function kimiServerLaunchSpec(serverHelp) {
  if (/^\s*run(?:\s|\[)/m.test(String(serverHelp || ""))) {
    return {
      args: ["server", "run", "--keep-alive", "--log-level", "warn"],
      detached: false
    };
  }
  return {
    args: ["web", "--no-open", "--log-level", "warn"],
    detached: true
  };
}

async function launchKimiService(command) {
  const help = runCommand(command, ["server", "--help"], { timeout: 10000 });
  const launch = kimiServerLaunchSpec(`${help.stdout || ""}\n${help.stderr || ""}`);
  if (!launch.detached) {
    const started = runCommand(command, launch.args, { timeout: 60000 });
    if (started.error) throw started.error;
    if (started.status !== 0) {
      throw new Error((started.stderr || started.stdout || `Kimi server exited with ${started.status}`).trim());
    }
    return;
  }

  const child = spawn(command, launch.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32" && command === "kimi"
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function ensureService() {
  let service = await readService();
  if (service) {
    return service;
  }

  const command = resolveKimiCommand();
  await launchKimiService(command);

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
    cwd: job.workspace?.cwd || path.resolve(options.cwd),
    source_cwd: path.resolve(options.cwd),
    allowed_paths: job.workspace?.allowed_paths || [],
    workspace: job.workspace || null,
    explicit_model: job.explicit_model,
    server_reported_model: job.server_reported_model,
    kimi_code_version: job.kimi_code_version || null,
    compatibility_status: job.compatibility_status || "untested",
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
  const canonicalRoot = canonicalPath(root);
  const resolved = canonicalPath(path.resolve(canonicalRoot, candidate));
  const relative = path.relative(canonicalRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Allowed path is outside the working directory: ${candidate}`);
}

export async function prepareExecutionWorkspace(sourceCwd, allowedAbsolutePaths, getOwnerStatus = getJobStatus) {
  const sourceRoot = canonicalPath(sourceCwd);
  const allowedSourcePaths = allowedAbsolutePaths.map((item) => verifyWithinRoot(sourceRoot, item));
  const repo = findGitRepo(sourceRoot);
  if (!repo) {
    const lock = await acquireSingleWriter(sourceRoot, getOwnerStatus);
    return {
      cwd: sourceRoot,
      allowed: allowedSourcePaths,
      workspace: {
        isolation: "single-writer",
        source_cwd: sourceRoot,
        cwd: sourceRoot,
        allowed_paths: allowedSourcePaths,
        ...lock
      }
    };
  }

  const sourceSubdir = path.relative(repo, sourceRoot);
  if (sourceSubdir.startsWith("..") || path.isAbsolute(sourceSubdir)) {
    throw new Error(`Working directory is outside its reported Git root: ${sourceRoot}`);
  }
  const allowedRepoPaths = allowedSourcePaths.map((item) => gitPath(path.relative(repo, item)));
  const dirtyPaths = gitDirtyPaths(repo);
  const overlaps = dirtyPaths.filter((dirty) => allowedRepoPaths.some((allowed) => pathsOverlap(dirty, allowed)));
  if (overlaps.length > 0) {
    throw new Error(
      `Source checkout has uncommitted changes overlapping K3 allowed_paths: ${overlaps.join(", ")}. ` +
      "Commit, stash, or choose non-overlapping paths before parallel execute mode."
    );
  }

  const baseCommit = runGit(repo, ["rev-parse", "HEAD"]).trim();
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const branch = `codex-k3/${id}`;
  const worktreeRoot = path.join(WORKTREE_ROOT, id);
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true, mode: 0o700 });
  const workspace = {
    isolation: "git-worktree",
    source_cwd: sourceRoot,
    source_repo: repo,
    source_subdir: gitPath(sourceSubdir),
    source_head_at_start: baseCommit,
    source_dirty_paths_at_start: dirtyPaths,
    cwd: path.join(worktreeRoot, sourceSubdir),
    worktree_root: worktreeRoot,
    worktree_active: false,
    branch,
    base_commit: baseCommit,
    allowed_repo_paths: allowedRepoPaths,
    commits: []
  };
  try {
    runGit(repo, ["worktree", "add", "-b", branch, worktreeRoot, baseCommit], { timeout: 60000 });
    workspace.worktree_active = true;
    if (!fs.statSync(workspace.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`The working directory is not present in the committed Git snapshot: ${sourceRoot}`);
    }
    const symlinkPaths = symlinkPathsWithinScopes(worktreeRoot, allowedRepoPaths);
    if (symlinkPaths.length > 0) {
      throw new Error(`K3 allowed_paths contain symbolic links or junctions: ${symlinkPaths.join(", ")}`);
    }
    const allowed = allowedSourcePaths.map((item) => path.join(worktreeRoot, path.relative(repo, item)));
    workspace.allowed_paths = allowed;
    return { cwd: workspace.cwd, allowed, workspace };
  } catch (error) {
    try {
      removeGitWorktree(workspace, true);
    } catch {}
    throw error;
  }
}

function bindSingleWriter(workspace, sessionId) {
  if (workspace?.isolation !== "single-writer" || !workspace.lock_active) return;
  writeJsonFile(path.join(workspace.lock_path, "owner.json"), {
    token: workspace.lock_token,
    cwd: workspace.source_cwd,
    session_id: sessionId,
    created_at: new Date().toISOString()
  });
}

export async function restoreExecutionWorkspace(record, getOwnerStatus = getJobStatus) {
  const workspace = record?.workspace;
  if (workspace?.isolation === "single-writer") {
    const lock = await acquireSingleWriter(workspace.source_cwd, getOwnerStatus);
    Object.assign(workspace, lock);
    return;
  }
  if (workspace?.isolation !== "git-worktree") return;
  if (workspace.worktree_active && fs.existsSync(workspace.worktree_root)) return;
  workspace.worktree_active = false;
  runGit(workspace.source_repo, ["worktree", "add", workspace.worktree_root, workspace.branch], { timeout: 60000 });
  workspace.worktree_active = true;
  workspace.cwd = path.join(
    workspace.worktree_root,
    workspace.source_subdir === "." ? "" : workspace.source_subdir.split("/").join(path.sep)
  );
  workspace.allowed_paths = workspace.allowed_repo_paths.map((item) =>
    path.join(workspace.worktree_root, item === "." ? "" : item.split("/").join(path.sep))
  );
}

export function finalizeExecutionWorkspace(record) {
  const workspace = record?.workspace;
  if (record?.mode !== "execute" || !workspace || workspace.turn_finalized_for === record.prompt_id) {
    return record?.integration || null;
  }

  if (workspace.isolation === "single-writer") {
    releaseSingleWriter(workspace);
    workspace.turn_finalized_for = record.prompt_id;
    record.integration = {
      isolation: "single-writer",
      state: "direct_changes",
      source_cwd: workspace.source_cwd,
      note: "Non-Git execution changed the source directory directly while holding the advisory single-writer lock."
    };
    return record.integration;
  }

  if (workspace.isolation !== "git-worktree") return null;
  const baseCommit = workspace.base_commit;
  const symlinkPaths = symlinkPathsWithinScopes(workspace.worktree_root, workspace.allowed_repo_paths);
  if (symlinkPaths.length > 0) {
    workspace.turn_finalized_for = record.prompt_id;
    record.integration = {
      isolation: "git-worktree",
      state: "scope_violation",
      branch: workspace.branch,
      base_commit: baseCommit,
      worktree_root: workspace.worktree_root,
      changed_paths: symlinkPaths,
      symlink_paths: symlinkPaths,
      scope_violations: symlinkPaths
    };
    record.state = "error";
    record.complete = true;
    record.error = `K3 allowed_paths contain symbolic links or junctions: ${symlinkPaths.join(", ")}. The isolated worktree was preserved for review.`;
    return record.integration;
  }
  const changedPaths = gitChangedPaths(workspace.worktree_root, baseCommit);
  const ignoredPaths = gitIgnoredPaths(workspace.worktree_root);
  const observedPaths = [...new Set([...changedPaths, ...ignoredPaths])];
  const violations = scopeViolations(observedPaths, workspace.allowed_repo_paths);
  if (violations.length > 0) {
    workspace.turn_finalized_for = record.prompt_id;
    record.integration = {
      isolation: "git-worktree",
      state: "scope_violation",
      branch: workspace.branch,
      base_commit: baseCommit,
      worktree_root: workspace.worktree_root,
      changed_paths: observedPaths,
      ignored_paths: ignoredPaths,
      scope_violations: violations
    };
    record.state = "error";
    record.complete = true;
    record.error = `K3 changed files outside allowed_paths: ${violations.join(", ")}. The isolated worktree was preserved for review.`;
    return record.integration;
  }

  if (ignoredPaths.length > 0) {
    workspace.turn_finalized_for = record.prompt_id;
    record.integration = {
      isolation: "git-worktree",
      state: "unintegrated_ignored_files",
      branch: workspace.branch,
      base_commit: baseCommit,
      worktree_root: workspace.worktree_root,
      changed_paths: observedPaths,
      ignored_paths: ignoredPaths
    };
    return record.integration;
  }

  if (changedPaths.length === 0) {
    workspace.turn_finalized_for = record.prompt_id;
    record.integration = {
      isolation: "git-worktree",
      state: "no_changes",
      branch: workspace.branch,
      base_commit: baseCommit,
      changed_paths: []
    };
    try {
      removeGitWorktree(workspace);
    } catch (error) {
      record.integration.cleanup_error = error instanceof Error ? error.message : String(error);
    }
    return record.integration;
  }

  const currentHead = runGit(workspace.worktree_root, ["rev-parse", "HEAD"]).trim();
  if (currentHead !== baseCommit) {
    runGit(workspace.worktree_root, ["reset", "--soft", baseCommit]);
  }
  runGit(workspace.worktree_root, ["add", "--all"]);
  runGit(workspace.worktree_root, [
    "-c", "user.name=Kimi K3",
    "-c", "user.email=kimi-k3-collab@local",
    "commit", "--no-verify", "-m", `K3 isolated changes (${record.session_id})`
  ], { timeout: 60000 });
  const commit = runGit(workspace.worktree_root, ["rev-parse", "HEAD"]).trim();
  workspace.commits = [...new Set([...(workspace.commits || []), commit])];
  workspace.base_commit = commit;
  workspace.turn_finalized_for = record.prompt_id;

  const sourceHead = runGit(workspace.source_repo, ["rev-parse", "HEAD"]).trim();
  const sourceDirty = gitDirtyPaths(workspace.source_repo);
  const sourceCommitted = sourceHead === workspace.source_head_at_start
    ? []
    : nullList(runGit(workspace.source_repo, [
        "diff", "--name-only", "--no-renames", "-z", workspace.source_head_at_start, sourceHead, "--"
      ]));
  const overlappingSourcePaths = [...new Set([...sourceDirty, ...sourceCommitted])]
    .filter((sourcePath) => changedPaths.some((changed) => pathsOverlap(sourcePath, changed)));
  const state = overlappingSourcePaths.length > 0
    ? "conflict_likely"
    : sourceHead === workspace.source_head_at_start
      ? "ready"
      : "review_required";
  record.integration = {
    isolation: "git-worktree",
    state,
    source_repo: workspace.source_repo,
    branch: workspace.branch,
    base_commit: baseCommit,
    commit,
    commits: workspace.commits,
    changed_paths: changedPaths,
    source_head: sourceHead,
    source_head_changed: sourceHead !== workspace.source_head_at_start,
    source_committed_paths: sourceCommitted,
    overlapping_source_paths: overlappingSourcePaths,
    worktree_root: workspace.worktree_root
  };
  try {
    removeGitWorktree(workspace);
  } catch (error) {
    record.integration.cleanup_error = error instanceof Error ? error.message : String(error);
  }
  return record.integration;
}

function finalizeExecutionSafely(record) {
  try {
    return finalizeExecutionWorkspace(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.state = "error";
    record.complete = true;
    record.error = `K3 execution handoff failed: ${message}`;
    record.integration = {
      ...(record.integration || {}),
      isolation: record.workspace?.isolation || null,
      state: "integration_error",
      branch: record.workspace?.branch || null,
      worktree_root: record.workspace?.worktree_root || null,
      error: message
    };
    return record.integration;
  }
}

function cleanupPreparedWorkspace(workspace) {
  if (workspace?.isolation === "git-worktree") removeGitWorktree(workspace, true);
  if (workspace?.isolation === "single-writer") releaseSingleWriter(workspace);
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
    kimi_code_version: record?.kimi_code_version || null,
    compatibility_status: record?.compatibility_status || "untested",
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

function readPromptInput(options) {
  if (options.prompt && options.promptFile) {
    throw new Error("Use either --prompt or --prompt-file, not both.");
  }
  const prompt = options.promptFile
    ? fs.readFileSync(path.resolve(options.promptFile), "utf8")
    : options.prompt ?? (!process.stdin.isTTY ? fs.readFileSync(0, "utf8") : undefined);
  if (!prompt?.trim()) {
    throw new Error("A non-empty --prompt or --prompt-file is required.");
  }
  return prompt.trim();
}

async function startJob(options) {
  const prompt = readPromptInput(options);

  const sourceRoot = path.resolve(options.cwd);
  if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${sourceRoot}`);
  }
  const readOnly = options.mode === "analyze";
  let allowedOriginal = null;
  if (!readOnly) {
    const items = options.allowedPaths.flatMap((value) => value.split(";")).map((value) => value.trim()).filter(Boolean);
    if (items.length === 0) {
      throw new Error("Execution mode requires at least one --allowed-path.");
    }
    allowedOriginal = items.map((item) => verifyWithinRoot(sourceRoot, item));
  }
  const service = await ensureService();
  const compatibility = kimiCompatibility(service.version);
  const models = await callApi("GET", "/api/v1/models");
  if (!models.items?.some((item) => item.model === K3_MODEL)) {
    throw new Error(`The local Kimi service does not advertise required capability ${K3_MODEL}.`);
  }
  const planMode = false;
  const permissionMode = readOnly ? "manual" : "auto";
  let root = sourceRoot;
  let workspace = null;
  let scopeText = "";
  if (!readOnly) {
    const prepared = await prepareExecutionWorkspace(sourceRoot, allowedOriginal);
    root = prepared.cwd;
    workspace = prepared.workspace;
    const allowed = prepared.allowed;
    scopeText = `\nYou may edit only these paths:\n- ${allowed.join("\n- ")}`;
  }

  const systemPrompt = readOnly
    ? `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nANALYSIS ONLY: do not create, edit, delete, move, or rename files. Do not call Bash, Shell, another command-execution tool, WebSearch, or FetchURL; use the configured local read-only inspection tools instead. You may use TodoList to organize the review. Inspect relevant project files and assets as needed.\nReview the proposal or implementation, challenge assumptions, compare material tradeoffs, and identify concrete risks or defects. Return a concise verdict, ranked findings backed by evidence, recommended changes, and acceptance checks. Distinguish observed facts from inference.`
    : `You are Kimi K3, collaborating with Codex as an independent engineering and design partner.\nPrimary preference for this task: ${focusPrompt(options.focus)}\nThe user has authorized the scoped implementation described in the task. Inspect before editing, preserve unrelated user changes, and do not touch files outside the allowed paths.${scopeText}\n${workspace?.isolation === "git-worktree" ? `You are inside an isolated Git worktree on branch ${workspace.branch}. Do not create commits, branches, merges, or additional worktrees; the collaboration bridge owns integration.` : "This is a non-Git single-writer session. Codex must pause local writes until your turn completes."}\nImplement the requested work, verify it with appropriate tests, static checks, or rendered evidence, and return the files changed, decisions made, and verification results.`;

  try {
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

    bindSingleWriter(workspace, String(session.id));
    const submitted = await callApi("POST", `/api/v1/sessions/${escaped}/prompts`, {
    // Kimi Code 0.26 accepts profile system_prompt/tools fields but does not
    // apply them on its legacy REST route. Keep the profile fields for newer
    // servers and repeat the collaboration contract in the task for 0.26.
    content: [{ type: "text", text: `${systemPrompt.trim()}\n\nTask from Codex:\n${prompt}` }],
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
      kimi_code_version: compatibility.version,
      compatibility_status: compatibility.status,
      verified_k3: configured.model === K3_MODEL,
      persistent_server: true,
      workspace
    };
  } catch (error) {
    if (workspace) {
      try {
        cleanupPreparedWorkspace(workspace);
      } catch {}
    }
    throw error;
  }
}

async function sendMessage(options) {
  const sessionId = requireSessionId(options);
  const prompt = readPromptInput(options);
  const record = readJobRecord(sessionId);
  if (!record) {
    throw new Error(`No persisted Kimi K3 job was found for ${sessionId}.`);
  }
  const status = await getJobStatus(sessionId);
  if (!status.verified_k3 || status.server_reported_model !== K3_MODEL) {
    throw new Error(`Refusing to continue ${sessionId}: the server did not verify ${K3_MODEL}.`);
  }
  if (status.busy) {
    throw new Error(`Kimi K3 session ${sessionId} is already working. Wait for the current turn or cancel it first.`);
  }

  const readOnly = record.mode !== "execute";
  let previousIntegration = null;
  let preserveWorktreeOnSendFailure = false;
  if (!readOnly) {
    if (["scope_violation", "integration_error"].includes(record.integration?.state)) {
      throw new Error(`K3 execute workspace requires manual review after ${record.integration.state}; refusing a follow-up turn.`);
    }
    if (record.integration) {
      previousIntegration = record.integration;
      preserveWorktreeOnSendFailure = record.integration.state === "unintegrated_ignored_files";
      record.integration_history = [...(record.integration_history || []), record.integration];
      record.integration = null;
    }
    await restoreExecutionWorkspace(record);
    if (record.workspace?.isolation === "git-worktree") {
      record.workspace.base_commit = runGit(record.workspace.worktree_root, ["rev-parse", "HEAD"]).trim();
    }
    record.workspace.turn_finalized_for = null;
    bindSingleWriter(record.workspace, sessionId);
    writeJobRecord(record);
  }
  const reminder = readOnly
    ? "Continue in analysis-only mode. Do not modify files or run shell commands."
    : "Continue within the previously authorized file scope and verify any changes.";
  let submitted;
  try {
    submitted = await callApi("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      content: [{ type: "text", text: `${reminder}\n\nFollow-up from Codex:\n${prompt}` }],
      metadata: { delegated_by: "codex", collaboration: record.focus || "general" },
      model: K3_MODEL,
      thinking: "max",
      permission_mode: readOnly ? "manual" : "auto",
      plan_mode: false,
      swarm_mode: false
    });
  } catch (error) {
    if (!readOnly) {
      if (previousIntegration) {
        record.integration = previousIntegration;
        record.integration_history = (record.integration_history || []).slice(0, -1);
      }
      if (record.workspace?.isolation === "single-writer") releaseSingleWriter(record.workspace);
      if (record.workspace?.isolation === "git-worktree" && !preserveWorktreeOnSendFailure) {
        try {
          removeGitWorktree(record.workspace);
        } catch {}
      }
      writeJobRecord(record);
    }
    throw error;
  }

  Object.assign(record, {
    prompt_id: String(submitted.prompt_id),
    state: String(submitted.status),
    complete: false,
    result: null,
    error: null,
    error_code: null,
    updated_at: new Date().toISOString()
  });
  writeJobRecord(record);
  return {
    kind: "kimi-k3-message",
    session_id: sessionId,
    prompt_id: String(submitted.prompt_id),
    state: String(submitted.status),
    mode: record.mode,
    focus: record.focus,
    server_reported_model: status.server_reported_model,
    verified_k3: true
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
        feedback: "Codex requested read-only analysis. Use Read, Grep, Glob, or ReadMediaFile instead."
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
  const preserveObserved = observedTerminal && (Boolean(next.error) || (settle && !complete));
  Object.assign(next, {
    state: preserveObserved ? observedState : status.state,
    complete: preserveObserved ? Boolean(next.complete) : complete,
    server_reported_model: status.server_reported_model,
    verified_k3: status.verified_k3,
    updated_at: new Date().toISOString(),
    result: next.error ? next.result ?? null : text ?? next.result ?? null,
    mode: next.mode || status.mode,
    focus: next.focus || status.focus
  });
  if (next.complete) finalizeExecutionSafely(next);
  writeJobRecord(next);
  return {
    kind: "kimi-k3-job-result",
    session_id: sessionId,
    status,
    complete: Boolean(next.complete),
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

export function eventMatchesCurrentPrompt(record, event) {
  const eventPromptId = String(event?.payload?.promptId || event?.payload?.prompt_id || "").trim();
  const recordPromptId = String(record?.prompt_id || "").trim();
  return !eventPromptId || !recordPromptId || eventPromptId === recordPromptId;
}

function terminalProviderFailure(event) {
  if (event?.type !== "error" || !event.session_id) return null;
  const payload = event.payload || {};
  const code = String(payload.code || payload.type || "").trim();
  if (!code.startsWith("provider.")) return null;
  return payload.fatal === true || TERMINAL_PROVIDER_ERROR_CODES.has(code) ? payload : null;
}

export function applyK3Event(record, event) {
  if (Number.isInteger(event?.seq)) {
    record.cursor = { seq: event.seq, ...(event.epoch ? { epoch: event.epoch } : {}) };
  }
  record.last_event_type = String(event?.type || "");
  record.updated_at = new Date().toISOString();
  const payload = event?.payload || {};
  const failure = terminalProviderFailure(event)
    || (event?.type === "turn.ended" && payload.reason === "failed"
      ? payload.error || payload
      : event?.type === "prompt.completed" && payload.reason === "failed"
        ? payload.error || payload
        : null);
  if (failure) {
    const code = compact(failure.code || failure.name || "");
    const message = compact(failure.message || payload.message || "");
    record.state = "failed";
    record.complete = true;
    record.error_code = code || null;
    record.error = [code && `[${code}]`, message || "Kimi turn failed."].filter(Boolean).join(" ");
  } else if (event?.type === "turn.started") {
    record.state = "running";
    record.complete = false;
    record.error = null;
    record.error_code = null;
  } else if (event?.type === "turn.ended") {
    record.state = payload.reason === "blocked" ? "blocked" : "running";
    record.complete = false;
  } else if (event?.type === "prompt.completed") {
    if (record.complete && record.error) return record;
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
    record = synced.record;
    if (record.complete) return { record, assistantStreamed: false };
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
        const sessionProviderFailure = frame.session_id === sessionId && terminalProviderFailure(frame);
        if (frame.type === "error" && frame.payload?.fatal && !sessionProviderFailure) {
          throw new Error(`Kimi WebSocket error: ${frame.payload.msg || frame.payload.code}`);
        }
        if (frame.session_id && frame.session_id !== sessionId) continue;
        if (!Number.isInteger(frame.seq) || !frame.payload || !isNewEvent(record || {}, frame)) continue;
        if (!record) {
          const synced = await syncJobRecord(sessionId, null);
          record = synced.record;
        }
        if (PROMPT_TERMINAL_EVENTS.has(frame.type) && !eventMatchesCurrentPrompt(record, frame)) {
          record.cursor = { seq: frame.seq, ...(frame.epoch ? { epoch: frame.epoch } : {}) };
          record.updated_at = new Date().toISOString();
          writeJobRecord(record);
          continue;
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
        if (record.mode === "analyze" && frame.type === "tool.call.started" && !isReadOnlyTool(frame.payload.name)) {
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
        const checkpoint = CHECKPOINT_EVENTS.has(frame.type)
          && (frame.type !== "error" || Boolean(sessionProviderFailure));
        if (!frame.volatile || Date.now() - lastWrite >= 500 || checkpoint) {
          writeJobRecord(record);
          lastWrite = Date.now();
        }
        if (checkpoint) {
          const synced = await syncJobRecord(sessionId, record, true);
          record = synced.record;
          if (PROMPT_TERMINAL_EVENTS.has(frame.type) || record.complete || record.state === "blocked" || FAILURE_STATES.has(record.state)) {
            websocket.close();
            return { record, assistantStreamed: renderState.assistantStreamed };
          }
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
    const compatibility = kimiCompatibility(service.version);
    printOutput({
      kind: "kimi-k3-service",
      healthy: true,
      persistent: true,
      host: service.host,
      port: service.port,
      pid: service.pid,
      version: service.version,
      kimi_code_version: compatibility.version,
      compatibility_status: compatibility.status,
      server_backend: service.backend,
      server_capabilities: service.capabilities,
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

  if (options.action === "send") {
    printOutput(await sendMessage(options), options.outputFormat);
    return;
  }

  if (options.action === "status") {
    printOutput(await getJobStatus(requireSessionId(options)), options.outputFormat);
    return;
  }

  if (options.action === "reject-approval") {
    const sessionId = requireSessionId(options);
    const approvalId = String(options.approvalId || "").trim();
    if (!approvalId) throw new Error("--approval-id is required.");
    printOutput({
      kind: "kimi-k3-approval",
      session_id: sessionId,
      approval_id: approvalId,
      decision: "rejected",
      ...await rejectAnalysisApproval(sessionId, { approval_id: approvalId })
    }, options.outputFormat);
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
    const cancellation = await abortActivePrompt(sessionId);
    const record = readJobRecord(sessionId);
    if (record?.mode === "execute") {
      Object.assign(record, {
        state: "cancelled",
        complete: true,
        updated_at: new Date().toISOString()
      });
      finalizeExecutionSafely(record);
      writeJobRecord(record);
    }
    printOutput({
      kind: "kimi-k3-job-cancel",
      session_id: sessionId,
      ...cancellation,
      integration: record?.integration || null
    }, options.outputFormat);
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
