#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { connectLocalWebSocket } from "./lib/local-websocket.mjs";
import {
  appendSecurityAudit,
  inspectToolSecurity,
  isReadOnlyTool,
  terminalProviderFailure
} from "./lib/k3-policy.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(THIS_FILE));
const BRIDGE = path.resolve(process.env.KIMI_K3_BRIDGE || path.join(ROOT, "scripts", "kimi-k3.mjs"));
const KIMI_HOME = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));
const JOB_ROOT = path.join(KIMI_HOME, "codex-jobs");
const LOCK_FILE = path.join(KIMI_HOME, "server", "lock");
const INSTANCE_ROOT = path.join(KIMI_HOME, "server", "instances");
const TOKEN_FILE = path.join(KIMI_HOME, "server.token");
const PANEL_FILE = path.join(ROOT, "assets", "k3-panel.html");
const PANEL_URI = "ui://kimi-k3/live-session-v3.html";
const PANEL_MIME = "text/html;profile=mcp-app";
const K3_MODEL = "kimi-code/k3";
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".codex-plugin", "plugin.json"), "utf8")).version;
const PROTOCOL_VERSION = "2025-11-25";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const activeChildren = new Map();
const activeRequests = new Set();
const cancelledRequests = new Set();
const relayReceivers = new Map();
const relays = new Map();
const unrestrictedRequests = new Map();
let browserGateway = null;
const MAX_RELAY_EVENTS = 2000;
const MAX_EVENT_BATCH = 100;
const MAX_RELAY_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BATCH_BYTES = 512 * 1024;
const MAX_PANEL_PARTIAL_RESULT_CHARS = 60000;
const MAX_RELAY_FAILURES = 30;
const MAX_DENIED_TOOL_CALL_IDS = 1024;
const DEFAULT_RELAY_IDLE_MS = 3 * 60 * 1000;
const MIN_RELAY_IDLE_MS = 1000;
const RELAY_IDLE_MS = Math.max(Number(process.env.KIMI_K3_RELAY_IDLE_MS) || DEFAULT_RELAY_IDLE_MS, MIN_RELAY_IDLE_MS);
const DEFAULT_RECEIVE_WAIT_MS = 45000;
const DEFAULT_MODEL_WAIT_SECONDS = 60;
const BROWSER_TICKET_TTL_MS = 2 * 60 * 1000;
const UNRESTRICTED_REQUEST_TTL_MS = 5 * 60 * 1000;
const UNRESTRICTED_CONFIRMATION = "ENABLE UNRESTRICTED";
const { privateKey: unrestrictedSigningKey, publicKey: unrestrictedVerificationKey } =
  generateKeyPairSync("ed25519");
const unrestrictedPublicKey = unrestrictedVerificationKey
  .export({ type: "spki", format: "der" })
  .toString("base64url");
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "error", "stopped", "stalled"]);
const PRESERVED_WORKTREE_STATES = new Set(["scope_violation", "integration_error", "unintegrated_ignored_files", "stalled"]);
const BRIDGE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "KIMI_CODE_BIN",
  "KIMI_CODE_HOME",
  "KIMI_K3_SERVER_WRAPPER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR"
]);
let transportClosed = false;

function closeTransport() {
  if (transportClosed) return;
  transportClosed = true;
  for (const requestId of activeRequests) cancelledRequests.add(requestId);
  for (const child of activeChildren.values()) child.kill();
  for (const cancel of relayReceivers.values()) cancel();
  for (const relay of relays.values()) relay.stop();
  for (const request of unrestrictedRequests.values()) {
    for (const finish of request.waiters) finish();
  }
  unrestrictedRequests.clear();
  browserGateway?.close();
  browserGateway = null;
}

function send(message) {
  if (!transportClosed) process.stdout.write(`${JSON.stringify(message)}\n`);
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

function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireSessionId(value) {
  const sessionId = requireString(value, "session_id");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error("session_id contains unsupported characters.");
  return sessionId;
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function parseJobArguments(value) {
  const input = requireObject(value);
  const mode = input.mode ?? "analyze";
  const focus = input.focus ?? "general";
  if (!new Set(["analyze", "execute"]).has(mode)) throw new Error("mode must be analyze or execute.");
  if (!new Set(["engineering", "visual", "general"]).has(focus)) {
    throw new Error("focus must be engineering, visual, or general.");
  }
  const requestedAllowedPaths = Array.isArray(input.allowed_paths)
    ? input.allowed_paths.map((item) => requireString(item, "allowed_paths[]"))
    : [];
  if (mode === "execute" && requestedAllowedPaths.length === 0) {
    throw new Error("execute mode requires at least one allowed_paths entry.");
  }
  const cwd = requireString(input.cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path.");
  const resolvedCwd = path.resolve(cwd);
  const allowedPaths = requestedAllowedPaths.map((item) => {
    if (!isWithinPath(resolvedCwd, path.resolve(resolvedCwd, item))) {
      throw new Error(`allowed_paths entry is outside cwd: ${item}`);
    }
    return item;
  });
  if (input.allow_non_git_execute != null && typeof input.allow_non_git_execute !== "boolean") {
    throw new Error("allow_non_git_execute must be a boolean.");
  }
  if (input.sensitive_paths_ack != null && typeof input.sensitive_paths_ack !== "boolean") {
    throw new Error("sensitive_paths_ack must be a boolean.");
  }
  return {
    mode,
    focus,
    cwd: resolvedCwd,
    prompt: requireString(input.prompt, "prompt"),
    allowedPaths,
    allowNonGitExecute: input.allow_non_git_execute === true,
    sensitivePathsAcknowledged: input.sensitive_paths_ack === true
  };
}

function parseSessionArguments(value) {
  return { sessionId: requireSessionId(requireObject(value).session_id) };
}

function parseUnrestrictedArguments(value) {
  const input = requireObject(value);
  const focus = input.focus ?? "general";
  if (!new Set(["engineering", "visual", "general"]).has(focus)) {
    throw new Error("focus must be engineering, visual, or general.");
  }
  const cwd = requireString(input.cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path.");
  return {
    focus,
    cwd: path.resolve(cwd),
    prompt: requireString(input.prompt, "prompt")
  };
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

export function bridgeEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, value]) => value != null && BRIDGE_ENVIRONMENT_KEYS.has(key.toUpperCase()))
      .map(([key, value]) => [key, String(value)])
  );
}

function runBridgeWindow(requestId, args, stdinText = "", extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      cwd: ROOT,
      env: { ...bridgeEnvironment(), ...extraEnvironment },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    activeChildren.set(requestId, child);
    child.stdin.end(stdinText);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      activeChildren.delete(requestId);
      if (cancelledRequests.has(requestId)) {
        reject(new Error("MCP call cancelled; the persistent K3 session continues."));
      } else if (code !== 0) {
        reject(new Error(stderr.trim() || `Kimi bridge exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function runBridgeJson(requestId, args, stdinText = "", extraEnvironment = {}) {
  const result = await runBridgeWindow(requestId, args, stdinText, extraEnvironment);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Kimi bridge returned invalid JSON.");
  }
}

async function startJob(requestId, input) {
  const job = await runBridgeJson(
    requestId,
    [
      "start", "--format", "json", "--mode", input.mode, "--focus", input.focus, "--cwd", input.cwd,
      ...(input.allowNonGitExecute ? ["--allow-non-git-execute"] : []),
      ...(input.sensitivePathsAcknowledged ? ["--ack-sensitive-paths"] : []),
      ...(input.mode === "execute" ? input.allowedPaths.flatMap((item) => ["--allowed-path", item]) : [])
    ],
    input.prompt
  );
  if (!job.verified_k3 || job.server_reported_model !== K3_MODEL) {
    throw new Error(`Kimi server did not verify ${K3_MODEL}.`);
  }
  return { ...job, session_id: requireSessionId(job.session_id) };
}

function notifyUnrestrictedRequest(request) {
  for (const finish of [...request.waiters]) finish();
}

async function startUnrestrictedJob(requestId, request) {
  const grantPayload = Buffer.from(JSON.stringify({
    v: 1,
    request_id: request.id,
    cwd: request.cwd,
    prompt_sha256: request.promptSha256,
    expires_at: Date.now() + 30_000,
    nonce: randomBytes(16).toString("base64url")
  }), "utf8");
  const grant = `${grantPayload.toString("base64url")}.${
    sign(null, grantPayload, unrestrictedSigningKey).toString("base64url")
  }`;
  const job = await runBridgeJson(
    requestId,
    [
      "start", "--format", "json", "--mode", "execute", "--focus", request.focus,
      "--cwd", request.cwd, "--unrestricted"
    ],
    request.prompt,
    {
      KIMI_K3_UNRESTRICTED_GRANT: grant,
      KIMI_K3_UNRESTRICTED_PUBLIC_KEY: unrestrictedPublicKey
    }
  );
  if (!job.verified_k3 || job.server_reported_model !== K3_MODEL || !job.unrestricted) {
    throw new Error(`Kimi server did not verify the unrestricted ${K3_MODEL} session.`);
  }
  return { ...job, session_id: requireSessionId(job.session_id) };
}

async function requestUnrestrictedCollaboration(requestId, rawArguments) {
  if (process.env.KIMI_K3_ENABLE_UNRESTRICTED !== "1") {
    throw new Error(
      "Unrestricted K3 access is disabled. Set KIMI_K3_ENABLE_UNRESTRICTED=1 before starting Codex, " +
      "then request it again and confirm the warning in the private panel."
    );
  }
  const input = parseUnrestrictedArguments(rawArguments);
  if (!fs.statSync(input.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${input.cwd}`);
  }
  await ensurePanelService(requestId);
  for (const [id, request] of unrestrictedRequests) {
    if (request.expiresAt <= Date.now() && request.state === "awaiting_user_confirmation") {
      request.state = "expired";
      request.confirmationToken = null;
      notifyUnrestrictedRequest(request);
    }
  }
  const id = `unrestricted_${randomUUID()}`;
  const confirmationToken = randomBytes(32).toString("base64url");
  const request = {
    id,
    ...input,
    promptSha256: sha256(input.prompt),
    confirmationToken,
    state: "awaiting_user_confirmation",
    createdAt: Date.now(),
    expiresAt: Date.now() + UNRESTRICTED_REQUEST_TTL_MS,
    sandboxed: Boolean(String(process.env.KIMI_K3_SERVER_WRAPPER || "").trim()),
    dedicatedHome: Boolean(
      process.env.KIMI_CODE_HOME &&
      path.resolve(process.env.KIMI_CODE_HOME) !== path.join(os.homedir(), ".kimi-code")
    ),
    waiters: new Set(),
    sessionId: null,
    error: null
  };
  unrestrictedRequests.set(id, request);
  appendSecurityAudit(JOB_ROOT, id, {
    event: "unrestricted_access_requested",
    decision: "pending_user_confirmation",
    cwd: request.cwd,
    prompt_sha256: request.promptSha256,
    sandboxed: request.sandboxed,
    dedicated_kimi_home: request.dedicatedHome
  });
  return {
    content: [{
      type: "text",
      text:
        "Unrestricted K3 access is awaiting explicit user confirmation in the private panel. " +
        "It has not started and cannot be enabled by model text."
    }],
    structuredContent: {
      session_id: id,
      status: request.state,
      mode: "unrestricted",
      access_mode: "unrestricted",
      complete: false,
      handoff_ready: false,
      view: "unrestricted-confirmation"
    },
    _meta: {
      "kimi-k3/unrestrictedRequestId": id,
      "kimi-k3/unrestrictedConfirmationToken": confirmationToken,
      "kimi-k3/unrestrictedCwd": request.cwd,
      "kimi-k3/unrestrictedPrompt": request.prompt,
      "kimi-k3/unrestrictedSandboxed": request.sandboxed,
      "kimi-k3/unrestrictedDedicatedHome": request.dedicatedHome,
      "kimi-k3/unrestrictedExpiresAt": request.expiresAt
    }
  };
}

async function confirmUnrestrictedCollaboration(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const id = requireString(input.request_id, "request_id");
  const request = unrestrictedRequests.get(id);
  if (!request) throw new Error("The unrestricted access request is missing, expired, or belongs to another host process.");
  if (request.expiresAt <= Date.now()) {
    request.state = "expired";
    request.confirmationToken = null;
    notifyUnrestrictedRequest(request);
    throw new Error("The unrestricted access request expired; create a new request.");
  }
  if (request.state !== "awaiting_user_confirmation") {
    throw new Error(`The unrestricted access request is already ${request.state}.`);
  }
  if (
    input.confirmation !== UNRESTRICTED_CONFIRMATION ||
    !safeTokenEqual(input.confirmation_token, request.confirmationToken)
  ) {
    throw new Error("The private unrestricted confirmation is invalid.");
  }
  request.state = "starting";
  appendSecurityAudit(JOB_ROOT, id, {
    event: "unrestricted_access_confirmed",
    decision: "allow_once",
    cwd: request.cwd,
    prompt_sha256: request.promptSha256,
    sandboxed: request.sandboxed,
    dedicated_kimi_home: request.dedicatedHome
  });
  try {
    const job = await startUnrestrictedJob(requestId, request);
    request.state = "running";
    request.sessionId = job.session_id;
    request.confirmationToken = null;
    relayFor(job.session_id, job.mode);
    notifyUnrestrictedRequest(request);
    return await panelToolResult(
      job.session_id,
      structuredJob(job),
      "User-confirmed unrestricted Kimi K3 collaboration started.",
      { "kimi-k3/unrestricted": true }
    );
  } catch (error) {
    request.state = "failed";
    request.error = error instanceof Error ? error.message : String(error);
    notifyUnrestrictedRequest(request);
    appendSecurityAudit(JOB_ROOT, id, {
      event: "unrestricted_access_start_failed",
      decision: "failed",
      message: request.error
    });
    throw error;
  }
}

function waitForUnrestrictedRequest(request, milliseconds) {
  if (!["awaiting_user_confirmation", "starting"].includes(request.state)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      request.waiters.delete(finish);
      resolve();
    };
    request.waiters.add(finish);
    timer = setTimeout(finish, milliseconds);
  });
}

function structuredJob(job) {
  const integration = job.integration || null;
  return {
    session_id: job.session_id,
    prompt_id: job.prompt_id || null,
    status: normalizeStatus(job.state || job.status || "running"),
    mode: job.mode || null,
    access_mode: job.unrestricted ? "unrestricted" : (job.mode || null),
    unrestricted: Boolean(job.unrestricted),
    authorization_request: job.authorization_request || null,
    focus: job.focus || null,
    kimi_code_version: job.kimi_code_version || null,
    compatibility_status: job.compatibility_status || "untested",
    server_reported_model: job.server_reported_model || job.explicit_model || null,
    verified_k3: Boolean(job.verified_k3),
    complete: Boolean(job.complete),
    error: job.error || null,
    error_code: job.error_code || null,
    idle_without_terminal_since: job.idle_without_terminal_since || null,
    stalled_at: job.stalled_at || null,
    last_event_type: job.last_event_type || null,
    partial_result: job.partial_result || null,
    sandboxed: Boolean(job.sandboxed),
    isolation: job.workspace?.isolation || integration?.isolation || null,
    integration_state: integration?.state || null,
    branch: integration?.branch || job.workspace?.branch || null,
    commit: integration?.commit || null
  };
}

export function integrationHandoff(record) {
  const integration = record?.integration;
  if (!integration) return { text: "", structured: {} };
  if (integration.isolation === "single-writer") {
    const changesVerified = integration.changes_verified === true;
    return {
      text: changesVerified
        ? `\n\n---\nExecution handoff: verified changes were made directly in ${integration.source_cwd} under the single-writer protocol.`
        : `\n\n---\nExecution handoff: direct-write access was available for ${integration.source_cwd} under the single-writer protocol; whether changes occurred is unverified.`,
      structured: {
        isolation: "single-writer",
        integration_state: integration.state,
        source_cwd: integration.source_cwd,
        changes_verified: changesVerified
      }
    };
  }
  const lines = [
    "",
    "---",
    "K3 isolated Git handoff",
    `State: ${integration.state}`,
    integration.branch && `Branch: ${integration.branch}`,
    integration.commit && `Commit: ${integration.commit}`,
    integration.changed_paths?.length && `Changed paths: ${integration.changed_paths.join(", ")}`,
    integration.ignored_paths?.length && `Ignored paths requiring review: ${integration.ignored_paths.join(", ")}`,
    integration.sensitive_paths?.length && `Sensitive paths blocked: ${integration.sensitive_paths.join(", ")}`,
    integration.symlink_paths?.length && `Symbolic links or junctions: ${integration.symlink_paths.join(", ")}`,
    integration.overlapping_source_paths?.length && `Overlapping source changes: ${integration.overlapping_source_paths.join(", ")}`,
    integration.scope_violations?.length && `Scope violations: ${integration.scope_violations.join(", ")}`,
    PRESERVED_WORKTREE_STATES.has(integration.state) && integration.worktree_root &&
      `Preserved worktree: ${integration.worktree_root} (K3 changes were not integrated; review or cherry-pick them there, then remove the worktree).`,
    integration.commit && "Review the commit before cherry-picking it; the plugin never merges automatically."
  ].filter(Boolean);
  return {
    text: `\n${lines.join("\n")}`,
    structured: {
      isolation: integration.isolation,
      integration_state: integration.state,
      source_repo: integration.source_repo || null,
      branch: integration.branch || null,
      commit: integration.commit || null,
      worktree_root: integration.worktree_root || null,
      commits: integration.commits || [],
      changed_paths: integration.changed_paths || [],
      ignored_paths: integration.ignored_paths || [],
      sensitive_paths: integration.sensitive_paths || [],
      symlink_paths: integration.symlink_paths || [],
      overlapping_source_paths: integration.overlapping_source_paths || [],
      scope_violations: integration.scope_violations || []
    }
  };
}

function latestSessionId() {
  const file = path.join(JOB_ROOT, "latest.json");
  if (!fs.existsSync(file)) return null;
  try {
    return requireSessionId(JSON.parse(fs.readFileSync(file, "utf8")).session_id);
  } catch {
    return null;
  }
}

export function readSessionPolicy(sessionId, jobRoot = JOB_ROOT) {
  try {
    const requiredSessionId = requireSessionId(sessionId);
    const record = JSON.parse(fs.readFileSync(path.join(jobRoot, `${requiredSessionId}.json`), "utf8"));
    const mode = new Set(["analyze", "execute"]).has(record.mode) ? record.mode : null;
    const recordedCwd = record.cwd || record.source_cwd;
    const cwd = typeof recordedCwd === "string" && path.isAbsolute(recordedCwd)
      ? path.resolve(recordedCwd)
      : null;
    const allowedPaths = Array.isArray(record.allowed_paths)
      && record.allowed_paths.every((item) => typeof item === "string" && path.isAbsolute(item))
      ? record.allowed_paths.map((item) => path.resolve(item))
      : null;
    if (record.unrestricted === true) {
      const sourceCwd = typeof record.source_cwd === "string" && path.isAbsolute(record.source_cwd)
        ? path.resolve(record.source_cwd)
        : null;
      const workspace = record.workspace;
      const workspaceCwd = typeof workspace?.cwd === "string" && path.isAbsolute(workspace.cwd)
        ? path.resolve(workspace.cwd)
        : null;
      const workspaceSourceCwd = typeof workspace?.source_cwd === "string" && path.isAbsolute(workspace.source_cwd)
        ? path.resolve(workspace.source_cwd)
        : null;
      if (
        record.kind !== "kimi-k3-native-delegation" ||
        record.session_id !== requiredSessionId ||
        mode !== "execute" ||
        !/^unrestricted_[A-Za-z0-9_-]+$/.test(String(record.unrestricted_request_id || "")) ||
        !cwd ||
        !sourceCwd ||
        path.relative(cwd, sourceCwd) !== "" ||
        workspace?.isolation !== "single-writer" ||
        !workspaceCwd ||
        !workspaceSourceCwd ||
        path.relative(cwd, workspaceCwd) !== "" ||
        path.relative(cwd, workspaceSourceCwd) !== ""
      ) {
        throw new Error("Confirmed unrestricted session policy is incomplete.");
      }
      return {
        valid: true,
        mode,
        cwd,
        allowedPaths: [],
        sensitivePathsAcknowledged: true,
        sandboxed: Boolean(record.sandboxed),
        unrestricted: true
      };
    }
    if (
      !mode ||
      !cwd ||
      !allowedPaths ||
      (mode === "execute" && (
        allowedPaths.length === 0 ||
        allowedPaths.some((item) => !isWithinPath(cwd, item))
      ))
    ) {
      throw new Error("Session security policy is incomplete.");
    }
    return {
      valid: true,
      mode,
      cwd,
      allowedPaths,
      sensitivePathsAcknowledged: Boolean(record.sensitive_paths_acknowledged),
      sandboxed: Boolean(record.sandboxed),
      unrestricted: false
    };
  } catch {
    return { valid: false };
  }
}

export function inspectSessionToolSecurity(sessionId, payload, relayMode, jobRoot = JOB_ROOT) {
  const policy = readSessionPolicy(sessionId, jobRoot);
  if (!policy.valid || (relayMode && relayMode !== policy.mode)) {
    return {
      action: "block",
      event: "session_policy_unavailable",
      path: null,
      message: "Blocked K3 tool execution because the persisted session security policy is missing, invalid, or inconsistent."
    };
  }
  return inspectToolSecurity(payload, { ...policy, mode: relayMode || policy.mode });
}

function readPanelService() {
  const descriptors = [];
  const readDescriptor = (filename) => {
    try {
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      descriptors.push({
        ...value,
        freshness: Number(value.heartbeat_at ?? value.started_at ?? 0)
      });
    } catch {
      // Ignore incomplete discovery files and try the remaining candidates.
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
  descriptors.sort((left, right) => right.freshness - left.freshness);
  if (!descriptors.length) throw new Error("Kimi server discovery record is missing.");

  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error("Kimi server token is empty.");
  let refusedHost = null;
  for (const descriptor of descriptors) {
    const host = String(descriptor.host ?? "");
    if (!LOOPBACK_HOSTS.has(host)) {
      refusedHost ||= host;
      continue;
    }
    const port = Number(descriptor.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const urlHost = host === "::1" ? "[::1]" : host;
    return {
      origin: `http://${urlHost}:${port}`,
      token,
      host,
      port,
      headers: { Authorization: `Bearer ${token}` }
    };
  }
  if (refusedHost) throw new Error(`Refusing non-loopback Kimi server host: ${refusedHost}`);
  throw new Error("Kimi server discovery has no valid loopback instance.");
}

async function ensurePanelService(requestId) {
  try {
    return readPanelService();
  } catch {
    await runBridgeJson(requestId, ["ensure", "--format", "json"]);
    return readPanelService();
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeRelayError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .slice(0, 500);
}

class SessionRelay {
  constructor(sessionId, mode = null) {
    this.sessionId = sessionId;
    this.mode = mode;
    this.generation = randomUUID();
    this.buffer = [];
    this.bufferBytes = 0;
    this.localCursor = 0;
    this.serverCursor = { seq: 0 };
    this.durableKeys = new Set();
    this.waiters = new Map();
    this.websocket = null;
    this.loop = null;
    this.stopped = false;
    this.outage = false;
    this.providerFailureNotified = false;
    this.deniedToolCallIds = new Set();
    this.stalledNoticeKey = "";
    this.lastReceiveAt = Date.now();
  }

  start() {
    if (this.loop || this.stopped || transportClosed) return;
    this.loop = this.run().finally(() => { this.loop = null; });
  }

  stop() {
    this.stopped = true;
    this.websocket?.close();
    this.websocket = null;
    for (const finish of [...this.waiters.values()]) finish();
    if (relays.get(this.sessionId) === this) relays.delete(this.sessionId);
  }

  enqueue(frame) {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    this.localCursor += 1;
    this.buffer.push({ cursor: this.localCursor, frame, bytes });
    this.bufferBytes += bytes;
    while (
      this.buffer.length > 1 &&
      (this.buffer.length > MAX_RELAY_EVENTS || this.bufferBytes > MAX_RELAY_BUFFER_BYTES)
    ) {
      this.bufferBytes -= this.buffer.shift().bytes;
    }
    for (const finish of [...this.waiters.values()]) finish();
  }

  batch(afterCursor) {
    const firstCursor = this.buffer[0]?.cursor ?? this.localCursor + 1;
    const entries = [];
    let batchBytes = 0;
    for (const entry of this.buffer) {
      if (entry.cursor <= afterCursor) continue;
      if (entries.length >= MAX_EVENT_BATCH) break;
      if (entries.length > 0 && batchBytes + entry.bytes > MAX_EVENT_BATCH_BYTES) break;
      entries.push(entry);
      batchBytes += entry.bytes;
    }
    return {
      session_id: this.sessionId,
      relay_generation: this.generation,
      cursor: entries.at(-1)?.cursor ?? Math.max(afterCursor, this.localCursor),
      events: entries.map((entry) => entry.frame),
      dropped_before_cursor: afterCursor < firstCursor - 1 ? firstCursor : null
    };
  }

  receive(requestId, afterCursor, waitMs) {
    this.lastReceiveAt = Date.now();
    const immediate = this.batch(afterCursor);
    if (immediate.events.length > 0 || immediate.dropped_before_cursor != null || waitMs === 0) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(requestId);
        relayReceivers.delete(requestId);
        resolve(this.batch(afterCursor));
      };
      const timer = setTimeout(finish, waitMs);
      this.waiters.set(requestId, finish);
      relayReceivers.set(requestId, finish);
    });
  }

  updateServerCursor(frame) {
    if (!Number.isInteger(frame?.seq) || frame.volatile === true) return;
    if (frame.epoch && frame.epoch !== this.serverCursor.epoch) {
      this.serverCursor = { seq: frame.seq, epoch: frame.epoch };
      return;
    }
    this.serverCursor = {
      seq: Math.max(this.serverCursor.seq || 0, frame.seq),
      ...(frame.epoch || this.serverCursor.epoch ? { epoch: frame.epoch || this.serverCursor.epoch } : {})
    };
  }

  noteResynced() {
    this.enqueue({
      type: "relay.status",
      session_id: this.sessionId,
      volatile: true,
      payload: { status: "resynced", message: "K3 event relay resynchronized its event cursor; live events continue." }
    });
  }

  noteStalled(record) {
    if (record?.state !== "stalled" || !record.stalled_at) return;
    const key = `${record.prompt_id || ""}:${record.stalled_at}`;
    if (key === this.stalledNoticeKey) return;
    this.stalledNoticeKey = key;
    const full = typeof record.partial_result === "string" ? record.partial_result : "";
    const truncated = full.length > MAX_PANEL_PARTIAL_RESULT_CHARS;
    this.enqueue({
      type: "relay.stalled",
      session_id: this.sessionId,
      volatile: true,
      payload: {
        prompt_id: record.prompt_id || null,
        stalled_at: record.stalled_at,
        partial_result: truncated ? full.slice(0, MAX_PANEL_PARTIAL_RESULT_CHARS) : full || null,
        partial_result_truncated: truncated
      }
    });
  }

  isDuplicateDurable(frame) {
    if (!Number.isInteger(frame?.seq) || frame.volatile === true) return false;
    const key = `${frame.epoch || this.serverCursor.epoch || ""}:${frame.seq}:${frame.type || ""}`;
    if (this.durableKeys.has(key)) return true;
    this.durableKeys.add(key);
    if (this.durableKeys.size > MAX_RELAY_EVENTS) this.durableKeys.delete(this.durableKeys.values().next().value);
    return false;
  }

  async run() {
    let reconnectDelay = 250;
    let consecutiveFailures = 0;
    while (!this.stopped && !transportClosed) {
      if (Date.now() - this.lastReceiveAt >= RELAY_IDLE_MS) {
        this.stop();
        break;
      }
      let websocket;
      try {
        const service = await ensurePanelService(`relay:${this.sessionId}`);
        const clientId = `codex-k3-relay-${process.pid}-${randomUUID()}`;
        websocket = await connectLocalWebSocket({
          host: service.host,
          port: service.port,
          headers: service.headers,
          pathname: `/api/v1/ws?client_id=${encodeURIComponent(clientId)}`
        });
        this.websocket = websocket;
        const helloId = randomUUID();
        websocket.sendJson({
          type: "client_hello",
          id: helloId,
          payload: {
            client_id: clientId,
            subscriptions: [this.sessionId],
            cursors: { [this.sessionId]: this.serverCursor }
          }
        });
        while (!this.stopped && !transportClosed) {
          const message = await websocket.nextMessage(Math.min(30000, RELAY_IDLE_MS));
          if (message == null) {
            if (Date.now() - this.lastReceiveAt >= RELAY_IDLE_MS) {
              this.stop();
              break;
            }
            continue;
          }
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
          const recovered = frame.session_id === this.sessionId || (
            frame.type === "ack" && frame.id === helloId && Number(frame.code) === 0
          );
          if (recovered) {
            if (this.outage) {
              this.outage = false;
              this.enqueue({
                type: "relay.status",
                session_id: this.sessionId,
                volatile: true,
                payload: { status: "connected", message: "K3 event relay reconnected." }
              });
            }
            consecutiveFailures = 0;
            reconnectDelay = 250;
          }
          if (frame.type === "ack" && frame.id === helloId) {
            if (Number(frame.code) !== 0) {
              const error = new Error(`Kimi WebSocket subscription failed: ${frame.msg || frame.code}`);
              error.terminal = true;
              throw error;
            }
            if (frame.payload?.resync_required?.includes(this.sessionId)) {
              const cursor = frame.payload?.cursors?.[this.sessionId];
              if (Number.isInteger(cursor?.seq)) this.serverCursor = cursor;
              this.noteResynced();
            }
          }
          if (frame.type === "resync_required" && frame.payload?.session_id === this.sessionId) {
            this.serverCursor = {
              seq: Number(frame.payload.current_seq || 0),
              ...(frame.payload.epoch ? { epoch: frame.payload.epoch } : {})
            };
            this.noteResynced();
          }
          if (frame.session_id && frame.session_id !== this.sessionId) continue;
          if (this.isDuplicateDurable(frame)) continue;
          this.updateServerCursor(frame);
          this.enqueue(frame);
          if (frame.type === "turn.started") this.providerFailureNotified = false;
          const frameToolCallId = String(frame.payload?.toolCallId || "");
          const deniedToolCall = this.deniedToolCallIds.has(frameToolCallId);
          if (frame.type === "tool.call.started" && !deniedToolCall) {
            const finding = inspectSessionToolSecurity(
              this.sessionId,
              frame.payload,
              this.mode
            );
            if (finding) {
              const eventId = `${frame.epoch || ""}:${frame.seq || ""}:${frame.payload?.toolCallId || ""}:${finding.event}`;
              appendSecurityAudit(JOB_ROOT, this.sessionId, {
                event_id: eventId,
                event: finding.event,
                decision: finding.action,
                tool: String(frame.payload?.name || ""),
                path: finding.path,
                message: finding.message
              });
              if (finding.action === "block") {
                try {
                  await runBridgeJson(
                    `relay-security:${this.sessionId}:${frame.payload?.toolCallId || randomUUID()}`,
                    ["cancel", "--format", "json", "--session-id", this.sessionId]
                  );
                } catch {}
              }
              if (finding.action !== "allow") {
                this.enqueue({
                  type: "relay.policy",
                  session_id: this.sessionId,
                  volatile: true,
                  payload: {
                    status: finding.action === "block" ? "failed" : "warning",
                    message: finding.message,
                    security_event: finding.event
                  }
                });
              }
            }
          }
          if (this.mode === "analyze" && frame.type === "event.approval.requested") {
            const approvalId = String(frame.payload?.approval_id || "").trim();
            const toolCallId = String(frame.payload?.tool_call_id || "").trim();
            if (!approvalId) {
              this.enqueue({
                type: "relay.policy",
                session_id: this.sessionId,
                volatile: true,
                payload: { status: "failed", message: "K3 approval request omitted approval_id." }
              });
            } else {
              try {
                await runBridgeJson(
                  `relay-approval:${this.sessionId}:${approvalId}`,
                  ["reject-approval", "--format", "json", "--session-id", this.sessionId, "--approval-id", approvalId]
                );
                if (toolCallId) {
                  this.deniedToolCallIds.add(toolCallId);
                  while (this.deniedToolCallIds.size > MAX_DENIED_TOOL_CALL_IDS) {
                    this.deniedToolCallIds.delete(this.deniedToolCallIds.values().next().value);
                  }
                }
                this.enqueue({
                  type: "relay.policy",
                  session_id: this.sessionId,
                  volatile: true,
                  payload: { status: "rejected", message: "Denied an approval-gated tool in read-only analysis." }
                });
              } catch (error) {
                this.enqueue({
                  type: "relay.policy",
                  session_id: this.sessionId,
                  volatile: true,
                  payload: { status: "failed", message: safeRelayError(error) }
                });
              }
            }
          }
          if (
            this.mode === "analyze" &&
            frame.type === "tool.call.started" &&
            !this.deniedToolCallIds.has(String(frame.payload?.toolCallId || "")) &&
            !isReadOnlyTool(frame.payload?.name)
          ) {
            try {
              await runBridgeJson(
                `relay-cancel:${this.sessionId}:${frame.payload?.toolCallId || randomUUID()}`,
                ["cancel", "--format", "json", "--session-id", this.sessionId]
              );
              this.enqueue({
                type: "relay.policy",
                session_id: this.sessionId,
                volatile: true,
                payload: {
                  status: "failed",
                  message: `Stopped disallowed tool in read-only analysis: ${frame.payload?.name || "unknown"}.`
                }
              });
            } catch (error) {
              this.enqueue({
                type: "relay.policy",
                session_id: this.sessionId,
                volatile: true,
                payload: { status: "failed", message: safeRelayError(error) }
              });
            }
          }
          if (frame.type === "tool.result" && deniedToolCall) {
            if (frame.payload?.isError !== true) {
              const eventId = `${frame.epoch || ""}:${frame.seq || ""}:${frameToolCallId}:denied_tool_returned_success`;
              const message = "A tool rejected in read-only analysis returned a successful result; stopped the turn.";
              appendSecurityAudit(JOB_ROOT, this.sessionId, {
                event_id: eventId,
                event: "denied_tool_returned_success",
                decision: "block",
                tool: String(frame.payload?.name || ""),
                path: null,
                message
              });
              try {
                await runBridgeJson(
                  `relay-integrity:${this.sessionId}:${frameToolCallId || randomUUID()}`,
                  ["cancel", "--format", "json", "--session-id", this.sessionId]
                );
              } catch {}
              this.enqueue({
                type: "relay.policy",
                session_id: this.sessionId,
                volatile: true,
                payload: {
                  status: "failed",
                  message,
                  security_event: "denied_tool_returned_success"
                }
              });
            }
            this.deniedToolCallIds.delete(frameToolCallId);
          }
          if (frame.type === "prompt.completed" || frame.type === "prompt.aborted") {
            this.deniedToolCallIds.clear();
          }
          const sessionProviderFailure = frame.session_id === this.sessionId && terminalProviderFailure(frame);
          if (sessionProviderFailure && !this.providerFailureNotified) {
            this.providerFailureNotified = true;
            const code = String(frame.payload?.code || frame.payload?.type || "").trim();
            const detail = String(frame.payload?.message || frame.payload?.msg || "").trim() || "Kimi provider failure.";
            this.enqueue({
              type: "relay.status",
              session_id: this.sessionId,
              volatile: true,
              payload: {
                status: "failed",
                message: [code && `[${code}]`, detail].filter(Boolean).join(" "),
                terminal: true,
                turn_terminal: true
              }
            });
          }
          if (frame.type === "error" && frame.payload?.fatal && !sessionProviderFailure) {
            throw new Error(`Kimi WebSocket error: ${frame.payload.msg || frame.payload.code}`);
          }
        }
      } catch (error) {
        if (this.stopped || transportClosed) break;
        consecutiveFailures += 1;
        const terminal = error?.terminal === true || consecutiveFailures >= MAX_RELAY_FAILURES;
        if (!this.outage || terminal) {
          this.enqueue({
            type: "relay.status",
            session_id: this.sessionId,
            volatile: true,
            payload: {
              status: terminal ? "failed" : "reconnecting",
              message: safeRelayError(error),
              terminal
            }
          });
        }
        this.outage = true;
        if (terminal) {
          this.stop();
          break;
        }
        try {
          await runBridgeJson(`relay-ensure:${this.sessionId}`, ["ensure", "--format", "json"]);
        } catch {
          // The next reconnect attempt will retry service discovery.
        }
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 4000);
      } finally {
        if (this.websocket === websocket) this.websocket = null;
        websocket?.close();
      }
    }
  }
}

function relayFor(sessionId, mode = null) {
  let relay = relays.get(sessionId);
  if (!relay) {
    if (!["analyze", "execute"].includes(mode)) {
      throw new Error(`Cannot start the K3 event relay without a persisted session mode.`);
    }
    relay = new SessionRelay(sessionId, mode);
    relays.set(sessionId, relay);
  }
  if (mode) {
    if (!["analyze", "execute"].includes(mode)) throw new Error(`Invalid K3 relay mode: ${mode}.`);
    relay.mode = mode;
  }
  relay.start();
  return relay;
}

export function browserCommand(url, platform = process.platform) {
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  throw new Error(`Opening a browser is unsupported on ${platform}.`);
}

function launchBrowser(url) {
  if (process.env.KIMI_K3_BROWSER_TEST === "1") return Promise.resolve();
  const { command, args } = browserCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function cookieValue(request, name) {
  for (const item of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function createBrowserGateway(
  serviceProvider = readPanelService,
  { ticketTtlMs = BROWSER_TICKET_TTL_MS, sessionTtlMs = 10 * 60 * 1000 } = {}
) {
  const tickets = new Map();
  const sessions = new Map();
  const sockets = new Set();
  let origin = null;

  function cleanup() {
    const now = Date.now();
    for (const [key, value] of tickets) if (value.expires_at <= now) tickets.delete(key);
    for (const [key, value] of sessions) if (value.expires_at <= now) sessions.delete(key);
  }

  function authenticate(request) {
    cleanup();
    const token = cookieValue(request, "kimi_k3_browser");
    const session = token && sessions.get(token);
    return session?.expires_at > Date.now() ? session : null;
  }

  function upstreamHeaders(request, service) {
    const headers = { ...request.headers, host: `${service.host}:${service.port}`, authorization: `Bearer ${service.token}` };
    delete headers.cookie;
    delete headers["proxy-connection"];
    if (headers.origin) headers.origin = service.origin;
    if (headers.referer) headers.referer = `${service.origin}/`;
    return headers;
  }

  function proxyHttp(request, response) {
    const session = authenticate(request);
    if (!session) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Browser fallback session expired. Reopen it from the Kimi K3 panel.");
      return;
    }
    let service;
    try {
      service = serviceProvider();
    } catch (error) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
      return;
    }
    const upstream = http.request({
      host: service.host,
      port: service.port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request, service)
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers["set-cookie"];
      if (headers.location?.startsWith(service.origin)) {
        headers.location = `${origin}${headers.location.slice(service.origin.length)}`;
      }
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
    request.pipe(upstream);
  }

  const server = http.createServer((request, response) => {
    const ticketPrefix = "/__kimi_k3_ticket/";
    if (request.method === "GET" && request.url?.startsWith(ticketPrefix)) {
      cleanup();
      const ticket = request.url.slice(ticketPrefix.length).split(/[?#]/, 1)[0];
      const pending = tickets.get(ticket);
      tickets.delete(ticket);
      if (!pending || pending.expires_at <= Date.now()) {
        response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Browser fallback ticket expired or was already used.");
        return;
      }
      sessions.set(pending.session_token, {
        session_id: pending.session_id,
        expires_at: Date.now() + sessionTtlMs
      });
      response.writeHead(302, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": `kimi_k3_browser=${pending.session_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`,
        Location: `/sessions/${encodeURIComponent(pending.session_id)}#token=${encodeURIComponent(pending.session_token)}`
      });
      response.end();
      return;
    }
    proxyHttp(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket) => {
    if (!authenticate(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    let service;
    try {
      service = serviceProvider();
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(service.port, service.host);
    upstream.once("connect", () => {
      const headers = upstreamHeaders(request, service);
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else if (value != null) {
          lines.push(`${name}: ${value}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  async function start() {
    if (origin) return origin;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    origin = `http://127.0.0.1:${server.address().port}`;
    return origin;
  }

  async function issueDetails(sessionId) {
    const gatewayOrigin = await start();
    cleanup();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ticketTtlMs;
    tickets.set(ticket, {
      session_id: requireSessionId(sessionId),
      session_token: randomBytes(32).toString("base64url"),
      expires_at: expiresAt
    });
    return {
      url: `${gatewayOrigin}/__kimi_k3_ticket/${ticket}`,
      expires_at: expiresAt
    };
  }

  return {
    origin: start,
    async issue(sessionId) {
      return (await issueDetails(sessionId)).url;
    },
    issueDetails,
    close() {
      tickets.clear();
      sessions.clear();
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

function panelToolResult(sessionId, details, text, extraMeta = {}) {
  const fullPartial = typeof details?.partial_result === "string" ? details.partial_result : "";
  const truncated = fullPartial.length > MAX_PANEL_PARTIAL_RESULT_CHARS;
  const stalledMeta = details?.status === "stalled" ? {
    "kimi-k3/stalledAt": details.stalled_at,
    "kimi-k3/stalledPromptId": details.prompt_id || null,
    "kimi-k3/partialResult": truncated ? fullPartial.slice(0, MAX_PANEL_PARTIAL_RESULT_CHARS) : fullPartial || null,
    "kimi-k3/partialResultTruncated": truncated
  } : {};
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...details, session_id: sessionId, view: "kimi-event-stream" },
    _meta: {
      "kimi-k3/sessionId": sessionId,
      ...(details?.unrestricted ? { "kimi-k3/unrestricted": true } : {}),
      ...stalledMeta,
      ...extraMeta
    }
  };
}

async function startCollaboration(requestId, rawArguments) {
  const input = parseJobArguments(rawArguments);
  await ensurePanelService(requestId);
  const job = await startJob(requestId, input);
  relayFor(job.session_id, job.mode);
  const details = structuredJob(job);
  const text = [
    "Kimi K3 collaboration started.",
    `Session: ${job.session_id}`,
    `Mode: ${details.mode}`,
    `Focus: ${details.focus}`,
    `Model: ${details.server_reported_model} (${details.verified_k3 ? "verified" : "NOT VERIFIED"})`,
    "The live panel renders Kimi's raw pushed frames through the server relay."
  ].join("\n");
  return await panelToolResult(job.session_id, details, text);
}

async function openPanel(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = input.session_id ? requireSessionId(input.session_id) : latestSessionId();
  await ensurePanelService(requestId);
  const details = sessionId
    ? await runBridgeJson(requestId, ["status", "--format", "json", "--session-id", sessionId])
    : { status: "idle", mode: null, focus: null, server_reported_model: null, verified_k3: false };
  const text = sessionId
    ? `Opened the direct Kimi K3 event stream.\nSession: ${sessionId}`
    : "Opened Kimi K3. Start or select a session in the live panel.";
  if (sessionId) relayFor(sessionId, details.mode);
  return await panelToolResult(sessionId, structuredJob({ ...details, session_id: sessionId }), text);
}

async function openK3InBrowser(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  await ensurePanelService(requestId);
  browserGateway ||= createBrowserGateway();
  const ticketUrl = await browserGateway.issue(sessionId);
  await launchBrowser(ticketUrl);
  return {
    content: [{ type: "text", text: `Opened Kimi Code in the default browser.\nSession: ${sessionId}` }],
    structuredContent: { session_id: sessionId, opened: true }
  };
}

async function sendMessageToK3(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = requireSessionId(input.session_id);
  const prompt = requireString(input.prompt, "prompt");
  const policy = readSessionPolicy(sessionId);
  if (policy.valid && policy.unrestricted) {
    throw new Error("Unrestricted K3 sessions are single-turn; request and confirm a new session for another task.");
  }
  const result = await runBridgeJson(
    requestId,
    ["send", "--format", "json", "--session-id", sessionId],
    prompt
  );
  return {
    content: [{ type: "text", text: `Follow-up sent directly to Kimi K3.\nSession: ${sessionId}` }],
    structuredContent: structuredJob({ ...result, session_id: sessionId })
  };
}

async function receiveK3Events(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = requireSessionId(input.session_id);
  const afterCursor = input.after_cursor ?? 0;
  const waitMs = input.wait_ms ?? DEFAULT_RECEIVE_WAIT_MS;
  if (!Number.isInteger(afterCursor) || afterCursor < 0) {
    throw new Error("after_cursor must be a non-negative integer.");
  }
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 55000) {
    throw new Error("wait_ms must be an integer from 0 through 55000.");
  }
  let relay = relays.get(sessionId);
  if (!relay) {
    const status = await runBridgeJson(
      requestId,
      ["status", "--format", "json", "--session-id", sessionId]
    );
    relay = relayFor(sessionId, status.mode);
  }
  const structuredContent = await relay.receive(requestId, afterCursor, waitMs);
  return {
    content: [],
    structuredContent,
    _meta: {
      "kimi-k3/sessionId": sessionId
    }
  };
}

async function getJobStatus(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const status = await runBridgeJson(requestId, ["status", "--format", "json", "--session-id", sessionId]);
  const state = normalizeStatus(status.state || "unknown");
  if (state === "stalled") relays.get(sessionId)?.noteStalled(status);
  return {
    content: [{
      type: "text",
      text: [
        "# Kimi K3 status",
        "",
        `Session: ${sessionId}`,
        `Status: ${state}`,
        `Activity: ${status.busy ? "working" : "idle"}`,
        `Mode: ${status.mode || "unknown"}`,
        `Focus: ${status.focus || "unknown"}`,
        `Model: ${status.server_reported_model || status.explicit_model || "unknown"} (${status.verified_k3 ? "verified" : "NOT VERIFIED"})`
      ].join("\n")
    }],
    structuredContent: { ...structuredJob({ ...status, session_id: sessionId }), busy: Boolean(status.busy) }
  };
}

async function getJobResult(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const record = await runBridgeJson(
    requestId,
    ["result", "--format", "json", "--session-id", sessionId, "--wait-seconds", "0"]
  );
  const model = record.server_reported_model || record.explicit_model || null;
  if (!record.verified_k3 || model !== K3_MODEL) {
    throw new Error(`Kimi result did not verify ${K3_MODEL}.`);
  }
  const status = normalizeStatus(record.state || record.status || "running");
  const complete = Boolean(record.complete) || TERMINAL_STATUSES.has(status);
  if (status === "stalled") relays.get(sessionId)?.noteStalled(record);
  const report = status === "stalled"
    ? "Kimi K3 stalled after becoming idle without a terminal event. No automatic retry or cancellation was performed. Start a new session to retry the task."
    : record.error
    ? `Kimi K3 collaboration failed: ${record.error}`
    : typeof record.result === "string" && record.result.trim()
      ? record.result.trim()
    : complete
      ? `Kimi K3 returned ${status} without a Markdown report.`
      : "Kimi K3 is still working.";
  const handoff = complete ? integrationHandoff(record) : { text: "", structured: {} };
  return {
    content: [{ type: "text", text: `${report}${handoff.text}` }],
    structuredContent: {
      session_id: sessionId,
      status,
      complete,
      handoff_ready: complete,
      mode: record.mode || null,
      access_mode: record.unrestricted ? "unrestricted" : (record.mode || null),
      unrestricted: Boolean(record.unrestricted),
      authorization_request: record.authorization_request || null,
      focus: record.focus || null,
      server_reported_model: model,
      verified_k3: true,
      error: record.error || null,
      error_code: record.error_code || null,
      idle_without_terminal_since: record.idle_without_terminal_since || null,
      stalled_at: record.stalled_at || null,
      last_event_type: record.last_event_type || null,
      partial_result: record.partial_result || null,
      result_markdown: !record.error && typeof record.result === "string" && record.result.trim() ? record.result.trim() : null,
      ...handoff.structured
    }
  };
}

async function awaitK3Result(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  let sessionId = requireSessionId(input.session_id);
  const waitSeconds = input.wait_seconds ?? DEFAULT_MODEL_WAIT_SECONDS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 60) {
    throw new Error("wait_seconds must be an integer from 1 through 60.");
  }
  const unrestrictedRequest = unrestrictedRequests.get(sessionId);
  if (unrestrictedRequest) {
    if (
      unrestrictedRequest.state === "awaiting_user_confirmation" &&
      unrestrictedRequest.expiresAt <= Date.now()
    ) {
      unrestrictedRequest.state = "expired";
    }
    await waitForUnrestrictedRequest(unrestrictedRequest, waitSeconds * 1000);
    if (
      unrestrictedRequest.state === "awaiting_user_confirmation" &&
      unrestrictedRequest.expiresAt <= Date.now()
    ) {
      unrestrictedRequest.state = "expired";
      unrestrictedRequest.confirmationToken = null;
    }
    if (!unrestrictedRequest.sessionId) {
      const terminal = ["cancelled", "expired", "failed"].includes(unrestrictedRequest.state);
      const message = unrestrictedRequest.state === "awaiting_user_confirmation"
        ? "Unrestricted K3 access is awaiting the user's private panel confirmation."
        : unrestrictedRequest.state === "starting"
          ? "The user confirmed unrestricted K3 access and the session is starting."
          : `Unrestricted K3 access ${unrestrictedRequest.state}: ${unrestrictedRequest.error || "create a new request."}`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          session_id: unrestrictedRequest.id,
          status: unrestrictedRequest.state,
          complete: terminal,
          handoff_ready: terminal,
          mode: "unrestricted",
          access_mode: "unrestricted",
          server_reported_model: null,
          verified_k3: false,
          error: unrestrictedRequest.error,
          error_code: terminal ? `unrestricted_${unrestrictedRequest.state}` : null,
          result_markdown: null
        }
      };
    }
    sessionId = unrestrictedRequest.sessionId;
  }
  const record = await runBridgeJson(
    requestId,
    ["result", "--format", "json", "--session-id", sessionId, "--wait-seconds", String(waitSeconds)]
  );
  const model = record.server_reported_model || record.explicit_model || null;
  if (!record.verified_k3 || model !== K3_MODEL) {
    throw new Error(`Kimi result did not verify ${K3_MODEL}.`);
  }
  const status = normalizeStatus(record.state || record.status || "running");
  const complete = Boolean(record.complete) || TERMINAL_STATUSES.has(status);
  const handoffReady = complete || status === "blocked";
  if (status === "stalled") relays.get(sessionId)?.noteStalled(record);
  const report = status === "stalled"
    ? "Kimi K3 stalled after becoming idle without a terminal event. No automatic retry or cancellation was performed. Start a new session to retry the task."
    : handoffReady && record.error
    ? `Kimi K3 collaboration failed: ${record.error}`
    : handoffReady && typeof record.result === "string" && record.result.trim()
      ? record.result.trim()
    : handoffReady
      ? `Kimi K3 returned ${status} without a Markdown report.`
      : "Kimi K3 is still working. Finish useful independent Codex work, then make at most one more bounded await. After two verified running awaits, ask the user whether to continue waiting or stop waiting; do not cancel K3. Do not narrate repeated waiting, inspect Git/status as filler, or use get_k3_status/get_k3_result for polling.";
  const handoff = handoffReady ? integrationHandoff(record) : { text: "", structured: {} };
  return {
    content: [{ type: "text", text: `${report}${handoff.text}` }],
    structuredContent: {
      session_id: sessionId,
      status,
      complete,
      handoff_ready: handoffReady,
      mode: record.mode || null,
      access_mode: record.unrestricted ? "unrestricted" : (record.mode || null),
      unrestricted: Boolean(record.unrestricted),
      authorization_request: record.authorization_request || null,
      focus: record.focus || null,
      server_reported_model: model,
      verified_k3: true,
      error: record.error || null,
      error_code: record.error_code || null,
      idle_without_terminal_since: record.idle_without_terminal_since || null,
      stalled_at: record.stalled_at || null,
      last_event_type: record.last_event_type || null,
      partial_result: record.partial_result || null,
      result_markdown: handoffReady && !record.error && typeof record.result === "string" && record.result.trim()
        ? record.result.trim()
        : null,
      ...handoff.structured
    }
  };
}

async function cancelJob(requestId, rawArguments) {
  let { sessionId } = parseSessionArguments(rawArguments);
  const unrestrictedRequest = unrestrictedRequests.get(sessionId);
  if (unrestrictedRequest && !unrestrictedRequest.sessionId) {
    unrestrictedRequest.state = "cancelled";
    unrestrictedRequest.error = "Cancelled before unrestricted access started.";
    unrestrictedRequest.confirmationToken = null;
    notifyUnrestrictedRequest(unrestrictedRequest);
    appendSecurityAudit(JOB_ROOT, unrestrictedRequest.id, {
      event: "unrestricted_access_cancelled",
      decision: "cancelled"
    });
    return {
      content: [{ type: "text", text: "The pending unrestricted K3 request was cancelled before it started." }],
      structuredContent: {
        session_id: unrestrictedRequest.id,
        aborted: true,
        prompt_id: null,
        reason: "unrestricted_request_cancelled"
      }
    };
  }
  if (unrestrictedRequest?.sessionId) sessionId = unrestrictedRequest.sessionId;
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
      reason: result.reason || null,
      ...integrationHandoff(result).structured
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
    description: "Execute-mode paths allowed under cwd. Git projects use an isolated worktree."
  },
  allow_non_git_execute: {
    type: "boolean",
    default: false,
    description: "Permit direct non-Git writes only after explicit user confirmation. Disabled by default."
  },
  sensitive_paths_ack: {
    type: "boolean",
    default: false,
    description: "Permit access to default-sensitive paths only after explicit user confirmation. The decision is audited."
  }
};

const panelMeta = {
  ui: { resourceUri: PANEL_URI },
  "openai/outputTemplate": PANEL_URI,
  "openai/toolInvocation/invoking": "Opening Kimi K3",
  "openai/toolInvocation/invoked": "Kimi K3 is ready"
};

export const startToolDefinition = {
  name: "start_k3_collaboration",
  title: "Start Kimi K3 Collaboration",
  description: "Start one persistent K3 session and render the direct Kimi Code interface. Execute mode isolates Git writes in a temporary branch/worktree; non-Git execution is disabled unless explicitly confirmed. Returns immediately without status polling.",
  inputSchema: {
    type: "object",
    properties: jobInputProperties,
    required: ["prompt", "cwd"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: panelMeta
};

export const requestUnrestrictedToolDefinition = {
  name: "request_unrestricted_k3",
  title: "Request Unrestricted Kimi K3",
  description:
    "Request a dangerous unrestricted K3 session. This never starts K3 directly: the user must confirm " +
    "the exact risk in the private panel, and the feature must be enabled by the host operator.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
      focus: { type: "string", enum: ["engineering", "visual", "general"], default: "general" },
      cwd: { type: "string", minLength: 1 }
    },
    required: ["prompt", "cwd"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: panelMeta
};

const openPanelToolDefinition = {
  name: "open_k3_panel",
  title: "Open Kimi K3 Panel",
  description: "Open the direct Kimi Code interface for a session, or the latest session when session_id is omitted.",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", minLength: 1 } },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: panelMeta
};

const sendToolDefinition = {
  name: "send_k3_message",
  title: "Send Message to Kimi K3",
  description: "Send a Codex follow-up directly to an idle persistent K3 session. The reply appears in the Kimi Code panel.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 }
    },
    required: ["session_id", "prompt"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: {
    ui: { visibility: ["model", "app"] },
    "openai/widgetAccessible": true
  }
};

export const awaitToolDefinition = {
  name: "await_k3_result",
  title: "Await Kimi K3 Result",
  description: "Wait event-first for K3 to finish, then return K3's original Markdown and any isolated Git commit handoff directly to Codex. Use at most two bounded 60-second waits before asking the user whether to continue or stop waiting; this is not status polling.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", minLength: 1 },
      wait_seconds: { type: "integer", minimum: 1, maximum: 60, default: DEFAULT_MODEL_WAIT_SECONDS }
    },
    required: ["session_id"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

export const receiveToolDefinition = {
  name: "receive_k3_events",
  title: "Receive Kimi K3 Events",
  description: "App-only long-held receive for Kimi's pushed session events. Not available to the model.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", minLength: 1 },
      after_cursor: { type: "integer", minimum: 0, default: 0 },
      wait_ms: { type: "integer", minimum: 0, maximum: 55000, default: DEFAULT_RECEIVE_WAIT_MS }
    },
    required: ["session_id", "after_cursor"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true
  }
};

export const browserToolDefinition = {
  name: "open_k3_in_browser",
  title: "Open Kimi K3 in Browser",
  description: "App-only launcher for the authenticated Kimi Code session in the system browser.",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", minLength: 1 } },
    required: ["session_id"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true
  }
};

export const confirmUnrestrictedToolDefinition = {
  name: "confirm_unrestricted_k3",
  title: "Confirm Unrestricted Kimi K3",
  description: "App-only one-time confirmation for a pending unrestricted K3 request.",
  inputSchema: {
    type: "object",
    properties: {
      request_id: { type: "string", minLength: 1 },
      confirmation: { type: "string", const: UNRESTRICTED_CONFIRMATION },
      confirmation_token: { type: "string", minLength: 32 }
    },
    required: ["request_id", "confirmation", "confirmation_token"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true
  }
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
  startToolDefinition,
  requestUnrestrictedToolDefinition,
  openPanelToolDefinition,
  sendToolDefinition,
  awaitToolDefinition,
  receiveToolDefinition,
  browserToolDefinition,
  confirmUnrestrictedToolDefinition,
  sessionToolDefinition(
    "get_k3_status",
    "Get Kimi K3 Status",
    "Read one K3 status snapshot only when the user explicitly asks. Never poll automatically.",
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  ),
  sessionToolDefinition(
    "get_k3_result",
    "Get Kimi K3 Result",
    "Read the durable original Markdown result only when the user explicitly asks Codex to discuss it.",
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  ),
  sessionToolDefinition(
    "cancel_k3_job",
    "Cancel Kimi K3 Job",
    "Cancel the active prompt for one persistent K3 session.",
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  )
];

const toolHandlers = new Map([
  ["start_k3_collaboration", startCollaboration],
  ["request_unrestricted_k3", requestUnrestrictedCollaboration],
  ["open_k3_panel", openPanel],
  ["send_k3_message", sendMessageToK3],
  ["await_k3_result", awaitK3Result],
  ["receive_k3_events", receiveK3Events],
  ["open_k3_in_browser", openK3InBrowser],
  ["confirm_unrestricted_k3", confirmUnrestrictedCollaboration],
  ["get_k3_status", getJobStatus],
  ["get_k3_result", getJobResult],
  ["cancel_k3_job", cancelJob]
]);

export const panelResource = {
  uri: PANEL_URI,
  name: "kimi-k3-live-session",
  title: "Kimi K3 Live Session",
  description: "Direct pushed Kimi K3 events with authentic Markdown, tools, tasks, and subagent activity.",
  mimeType: PANEL_MIME
};

function readPanelResource() {
  return {
    contents: [{
      uri: PANEL_URI,
      mimeType: PANEL_MIME,
      text: fs.readFileSync(PANEL_FILE, "utf8"),
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {}
        },
        "openai/widgetPrefersBorder": false,
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: []
        }
      }
    }]
  };
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "Kimi K3 Collab", version: VERSION },
      instructions:
        "Use start_k3_collaboration once for a separate K3 subtask, then call await_k3_result before the final response. If two verified bounded waits still return running, call request_user_input with id k3_wait_decision and choices Continue waiting and Stop waiting; Other requires an explicit action. Stop waiting never cancels K3. Only use request_unrestricted_k3 after explicit user authorization. Never poll status/result or run filler checks while waiting."
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
  if (method === "resources/list") {
    sendResult(id, { resources: [panelResource] });
    return;
  }
  if (method === "resources/templates/list") {
    sendResult(id, { resourceTemplates: [] });
    return;
  }
  if (method === "resources/read") {
    if (params?.uri !== PANEL_URI) {
      sendError(id, -32602, `Unknown resource: ${params?.uri ?? ""}`);
      return;
    }
    sendResult(id, await readPanelResource());
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
      const result = await handler(id, params.arguments);
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
      relayReceivers.get(requestId)?.();
      activeChildren.get(requestId)?.kill();
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

async function main() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("close", () => {
    closeTransport();
    setImmediate(() => process.exit(0));
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      void handleMessage(JSON.parse(line));
    } catch {
      // Ignore malformed transport lines. Valid requests receive JSON-RPC errors above.
    }
  });
}

if (path.resolve(process.argv[1] || "") === THIS_FILE) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
