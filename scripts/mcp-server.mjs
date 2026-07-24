#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { connectLocalWebSocket } from "./lib/local-websocket.mjs";
import { isReadOnlyTool } from "./lib/k3-policy.mjs";

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
const DEFAULT_KIMI_ORIGIN = "http://127.0.0.1:58627";
const K3_MODEL = "kimi-code/k3";
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".codex-plugin", "plugin.json"), "utf8")).version;
const PROTOCOL_VERSION = "2025-11-25";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const activeChildren = new Map();
const activeRequests = new Set();
const cancelledRequests = new Set();
const relayReceivers = new Map();
const relays = new Map();
const MAX_RELAY_EVENTS = 2000;
const MAX_EVENT_BATCH = 100;
const MAX_RELAY_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BATCH_BYTES = 512 * 1024;
const MAX_RELAY_FAILURES = 30;
const RELAY_IDLE_MS = 3 * 60 * 1000;
const DEFAULT_RECEIVE_WAIT_MS = 45000;
const DEFAULT_MODEL_WAIT_SECONDS = 100;
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "error", "stopped"]);
let transportClosed = false;

function closeTransport() {
  if (transportClosed) return;
  transportClosed = true;
  for (const requestId of activeRequests) cancelledRequests.add(requestId);
  for (const child of activeChildren.values()) child.kill();
  for (const cancel of relayReceivers.values()) cancel();
  for (const relay of relays.values()) relay.stop();
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

function runBridgeWindow(requestId, args, stdinText = "") {
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

async function runBridgeJson(requestId, args, stdinText = "") {
  const result = await runBridgeWindow(requestId, args, stdinText);
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
      ...(input.mode === "execute" ? ["--allowed-path", input.allowedPaths.join(";")] : [])
    ],
    input.prompt
  );
  if (!job.verified_k3 || job.server_reported_model !== K3_MODEL) {
    throw new Error(`Kimi server did not verify ${K3_MODEL}.`);
  }
  return { ...job, session_id: requireSessionId(job.session_id) };
}

function structuredJob(job) {
  const integration = job.integration || null;
  return {
    session_id: job.session_id,
    status: normalizeStatus(job.state || job.status || "running"),
    mode: job.mode || null,
    focus: job.focus || null,
    kimi_code_version: job.kimi_code_version || null,
    compatibility_status: job.compatibility_status || "untested",
    server_reported_model: job.server_reported_model || job.explicit_model || null,
    verified_k3: Boolean(job.verified_k3),
    isolation: job.workspace?.isolation || integration?.isolation || null,
    integration_state: integration?.state || null,
    branch: integration?.branch || job.workspace?.branch || null,
    commit: integration?.commit || null
  };
}

function integrationHandoff(record) {
  const integration = record?.integration;
  if (!integration) return { text: "", structured: {} };
  if (integration.isolation === "single-writer") {
    return {
      text: `\n\n---\nExecution handoff: non-Git changes were made directly in ${integration.source_cwd} under the single-writer protocol.`,
      structured: {
        isolation: "single-writer",
        integration_state: integration.state,
        source_cwd: integration.source_cwd
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
    integration.symlink_paths?.length && `Symbolic links or junctions: ${integration.symlink_paths.join(", ")}`,
    integration.overlapping_source_paths?.length && `Overlapping source changes: ${integration.overlapping_source_paths.join(", ")}`,
    integration.scope_violations?.length && `Scope violations: ${integration.scope_violations.join(", ")}`,
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
      commits: integration.commits || [],
      changed_paths: integration.changed_paths || [],
      ignored_paths: integration.ignored_paths || [],
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
          const message = await websocket.nextMessage(30000);
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
            }
          }
          if (frame.type === "resync_required" && frame.payload?.session_id === this.sessionId) {
            this.serverCursor = {
              seq: Number(frame.payload.current_seq || 0),
              ...(frame.payload.epoch ? { epoch: frame.payload.epoch } : {})
            };
          }
          if (frame.session_id && frame.session_id !== this.sessionId) continue;
          if (this.isDuplicateDurable(frame)) continue;
          this.updateServerCursor(frame);
          this.enqueue(frame);
          if (this.mode === "analyze" && frame.type === "event.approval.requested") {
            const approvalId = String(frame.payload?.approval_id || "").trim();
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
          if (frame.type === "error" && frame.payload?.fatal) {
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

function panelUrl(service, sessionId) {
  const route = sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : "/";
  return `${service.origin}${route}#token=${encodeURIComponent(service.token)}`;
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

function panelOrigins() {
  const origins = new Set([DEFAULT_KIMI_ORIGIN, "http://localhost:58627"]);
  try {
    origins.add(readPanelService().origin);
  } catch {
    // The render tool starts Kimi before the panel is mounted.
  }
  return [...origins];
}

function panelToolResult(sessionId, service, details, text) {
  const url = panelUrl(service, sessionId);
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...details, session_id: sessionId, view: "kimi-event-stream" },
    _meta: {
      "kimi-k3/panelUrl": url,
      "kimi-k3/sessionId": sessionId
    }
  };
}

async function startCollaboration(requestId, rawArguments) {
  const input = parseJobArguments(rawArguments);
  const service = await ensurePanelService(requestId);
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
  return panelToolResult(job.session_id, service, details, text);
}

async function openPanel(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = input.session_id ? requireSessionId(input.session_id) : latestSessionId();
  const service = await ensurePanelService(requestId);
  const details = sessionId
    ? await runBridgeJson(requestId, ["status", "--format", "json", "--session-id", sessionId])
    : { status: "idle", mode: null, focus: null, server_reported_model: null, verified_k3: false };
  const text = sessionId
    ? `Opened the direct Kimi K3 event stream.\nSession: ${sessionId}`
    : "Opened Kimi K3. Start or select a session in the live panel.";
  if (sessionId) relayFor(sessionId, details.mode);
  return panelToolResult(sessionId, service, structuredJob({ ...details, session_id: sessionId }), text);
}

async function openK3InBrowser(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const service = await ensurePanelService(requestId);
  await launchBrowser(panelUrl(service, sessionId));
  return {
    content: [{ type: "text", text: `Opened Kimi Code in the default browser.\nSession: ${sessionId}` }],
    structuredContent: { session_id: sessionId, opened: true }
  };
}

async function sendMessageToK3(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = requireSessionId(input.session_id);
  const prompt = requireString(input.prompt, "prompt");
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
  return {
    content: [],
    structuredContent: await relay.receive(requestId, afterCursor, waitMs)
  };
}

async function getJobStatus(requestId, rawArguments) {
  const { sessionId } = parseSessionArguments(rawArguments);
  const status = await runBridgeJson(requestId, ["status", "--format", "json", "--session-id", sessionId]);
  const state = normalizeStatus(status.state || "unknown");
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
  const report = record.error
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
      focus: record.focus || null,
      server_reported_model: model,
      verified_k3: true,
      error: record.error || null,
      error_code: record.error_code || null,
      result_markdown: !record.error && typeof record.result === "string" && record.result.trim() ? record.result.trim() : null,
      ...handoff.structured
    }
  };
}

async function awaitK3Result(requestId, rawArguments) {
  const input = requireObject(rawArguments);
  const sessionId = requireSessionId(input.session_id);
  const waitSeconds = input.wait_seconds ?? DEFAULT_MODEL_WAIT_SECONDS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 100) {
    throw new Error("wait_seconds must be an integer from 1 through 100.");
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
  const report = handoffReady && record.error
    ? `Kimi K3 collaboration failed: ${record.error}`
    : handoffReady && typeof record.result === "string" && record.result.trim()
      ? record.result.trim()
    : handoffReady
      ? `Kimi K3 returned ${status} without a Markdown report.`
      : "Kimi K3 is still working. If useful independent Codex work remains, do only that. Otherwise let the trusted Stop hook perform the longer event wait. If the hook is unavailable, make one later await without filler work; if K3 is still running, tell the user once and ask whether to keep waiting or cancel. During automatic waiting, do not narrate the same waiting state, inspect Git/status as filler, or use get_k3_status/get_k3_result for polling.";
  const handoff = handoffReady ? integrationHandoff(record) : { text: "", structured: {} };
  return {
    content: [{ type: "text", text: `${report}${handoff.text}` }],
    structuredContent: {
      session_id: sessionId,
      status,
      complete,
      handoff_ready: handoffReady,
      mode: record.mode || null,
      focus: record.focus || null,
      server_reported_model: model,
      verified_k3: true,
      error: record.error || null,
      error_code: record.error_code || null,
      result_markdown: handoffReady && !record.error && typeof record.result === "string" && record.result.trim()
        ? record.result.trim()
        : null,
      ...handoff.structured
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
    description: "Execute-mode paths allowed under cwd. Git projects use an isolated worktree; non-Git projects use a single-writer lock."
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
  description: "Start one persistent K3 session and render the direct Kimi Code interface. Execute mode isolates Git writes in a temporary branch/worktree; non-Git execution is single-writer. Returns immediately without status polling.",
  inputSchema: {
    type: "object",
    properties: jobInputProperties,
    required: ["prompt", "cwd"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
  description: "Wait event-first for K3 to finish, then return K3's original Markdown and any isolated Git commit handoff directly to Codex. Use after Codex completes its separate subtask and before the final response; this is not status polling.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", minLength: 1 },
      wait_seconds: { type: "integer", minimum: 1, maximum: 100, default: DEFAULT_MODEL_WAIT_SECONDS }
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
  openPanelToolDefinition,
  sendToolDefinition,
  awaitToolDefinition,
  receiveToolDefinition,
  browserToolDefinition,
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
  ["open_k3_panel", openPanel],
  ["send_k3_message", sendMessageToK3],
  ["await_k3_result", awaitK3Result],
  ["receive_k3_events", receiveK3Events],
  ["open_k3_in_browser", openK3InBrowser],
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
  const origins = panelOrigins();
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
          resource_domains: [],
          redirect_domains: origins
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
        "Use start_k3_collaboration once to give K3 a separate subtask, continue Codex's own work, then call await_k3_result before the final response so K3 reports directly back to Codex. If it is still running and no useful Codex work remains, let the trusted Stop hook perform the longer event wait. If that hook is unavailable, make only one later await before asking the user whether to keep waiting or cancel. Never narrate repeated waiting, run filler checks, or poll status/result during automatic waiting."
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
    sendResult(id, readPanelResource());
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
