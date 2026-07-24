#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(scriptsDir, "kimi-k3.mjs");
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-e2e-"));
const fixtureCwd = path.join(temporaryHome, "project");
const token = "fake-kimi-token";
const sessionId = "session_fake_e2e";
const successPromptId = "prompt_fake_e2e";
const failurePromptId = "prompt_fake_provider_failure";
const recoveredPromptId = "prompt_fake_provider_recovered";
let complete = false;
let scenario = "success";
let promptCount = 0;
let activePromptId = successPromptId;
let approvalRejected = false;
let authenticated = true;
let profile = null;
const upgradedSockets = new Set();

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function reply(response, data) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 0, data }));
}

const server = http.createServer(async (request, response) => {
  authenticated &&= request.headers.authorization === `Bearer ${token}`;
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = url.pathname;
  if (pathname === "/api/v1/healthz") return reply(response, { healthy: true });
  if (pathname === "/api/v1/models") {
    return reply(response, {
      items: [{ model: "kimi-code/k3", display_name: "Kimi K3", max_context_size: 262144 }]
    });
  }
  if (pathname === "/api/v1/sessions" && request.method === "POST") {
    await readBody(request);
    return reply(response, { id: sessionId });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/profile` && request.method === "POST") {
    profile = await readBody(request);
    return reply(response, {});
  }
  if (pathname === `/api/v1/sessions/${sessionId}`) {
    return reply(response, {
      metadata: { mode: "analyze", focus: "engineering" },
      pending_interaction: "none",
      last_turn_reason: complete && scenario !== "failure" ? "completed" : "",
      agent_config: { model: "kimi-code/k3" },
      message_count: complete ? 1 : 0
    });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/status`) {
    return reply(response, {
      model: "kimi-code/k3",
      thinking_level: "max",
      permission: "manual",
      plan_mode: false,
      busy: !complete
    });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/prompts` && request.method === "POST") {
    await readBody(request);
    promptCount += 1;
    scenario = promptCount === 1 ? "success" : promptCount === 2 ? "failure" : "recovered";
    complete = false;
    activePromptId = scenario === "success"
      ? successPromptId
      : scenario === "failure"
        ? failurePromptId
        : recoveredPromptId;
    return reply(response, { prompt_id: activePromptId, status: "running" });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/prompts`) {
    return reply(response, { active: complete ? null : { prompt_id: activePromptId } });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/approvals/approval_fake` && request.method === "POST") {
    const body = await readBody(request);
    approvalRejected = body?.decision === "rejected";
    return reply(response, { resolved: true });
  }
  if (pathname === `/api/v1/sessions/${sessionId}/messages`) {
    return reply(response, {
      items: complete
        ? [{
            created_at: new Date().toISOString(),
            content: [{
              type: "text",
              text: scenario === "recovered"
                ? "# Recovered K3 report\n\nTransient Provider overload recovered."
                : "# Fake K3 report\n\nProtocol handoff completed."
            }]
          }]
        : []
    });
  }
  response.writeHead(404);
  response.end();
});

server.on("upgrade", (request, socket) => {
  const websocketScenario = scenario;
  const websocketPromptId = activePromptId;
  upgradedSockets.add(socket);
  socket.once("close", () => upgradedSockets.delete(socket));
  authenticated &&= request.headers.authorization === `Bearer ${token}`;
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  setTimeout(() => {
    complete = true;
    const frames = websocketScenario === "failure"
      ? [
          { type: "server_hello", payload: { protocol_version: 1 } },
          {
            type: "turn.started",
            session_id: sessionId,
            seq: 6,
            payload: { turnId: 1 }
          },
          {
            type: "turn.step.retrying",
            session_id: sessionId,
            seq: 7,
            payload: {
              errorName: "APIProviderRateLimitError",
              errorMessage: "429 The engine is overloaded",
              statusCode: 429
            }
          },
          {
            type: "error",
            session_id: sessionId,
            seq: 8,
            payload: {
              code: "provider.rate_limit",
              message: "429 The engine is overloaded",
              name: "APIProviderRateLimitError",
              retryable: true,
              fatal: true
            }
          }
        ]
      : websocketScenario === "recovered"
        ? [
            { type: "server_hello", payload: { protocol_version: 1 } },
            {
              type: "turn.started",
              session_id: sessionId,
              seq: 9,
              payload: { turnId: 2 }
            },
            {
              type: "error",
              session_id: sessionId,
              seq: 10,
              payload: {
                code: "provider.overloaded",
                message: "Temporary Provider overload",
                fatal: false
              }
            },
            {
              type: "assistant.delta",
              session_id: sessionId,
              seq: 11,
              payload: { delta: "# Recovered K3 report\n\nTransient Provider overload recovered." }
            },
            {
              type: "prompt.completed",
              session_id: sessionId,
              seq: 12,
              payload: { promptId: websocketPromptId, reason: "completed" }
            }
          ]
        : [
          { type: "server_hello", payload: { protocol_version: 1 } },
          {
            type: "event.approval.requested",
            session_id: sessionId,
            seq: 1,
            payload: { approval_id: "approval_fake", tool_call_id: "tool_bash", tool_name: "Bash" }
          },
          {
            type: "tool.call.started",
            session_id: sessionId,
            seq: 2,
            payload: { toolCallId: "tool_bash", name: "Bash", args: { command: "echo denied" } }
          },
          {
            type: "tool.result",
            session_id: sessionId,
            seq: 3,
            payload: { toolCallId: "tool_bash", output: "denied", isError: true }
          },
          {
            type: "assistant.delta",
            session_id: sessionId,
            seq: 4,
            payload: { delta: "# Fake K3 report\n\nProtocol handoff completed." }
          },
          {
            type: "prompt.completed",
            session_id: sessionId,
            seq: 5,
            payload: { promptId: websocketPromptId, reason: "completed" }
          }
        ];
    socket.write(Buffer.concat(frames.map(websocketFrame)));
    setTimeout(() => socket.destroy(), 500);
  }, 25);
});

function runBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, ...args], {
      windowsHide: true,
      env: { ...process.env, KIMI_CODE_HOME: temporaryHome }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `Bridge exited with ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

try {
  fs.mkdirSync(path.join(temporaryHome, "server"), { recursive: true });
  fs.mkdirSync(fixtureCwd);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(
    path.join(temporaryHome, "server", "lock"),
    JSON.stringify({ host: "127.0.0.1", port, pid: process.pid, host_version: "0.26.0" })
  );
  fs.writeFileSync(path.join(temporaryHome, "server.token"), token);

  const service = await runBridge(["ensure"]);
  if (
    !service.healthy ||
    service.model !== "kimi-code/k3" ||
    service.compatibility_status !== "tested"
  ) {
    throw new Error("The fake Kimi service did not pass model verification.");
  }
  fs.rmSync(path.join(temporaryHome, "server", "lock"));
  fs.mkdirSync(path.join(temporaryHome, "server", "instances"));
  fs.writeFileSync(
    path.join(temporaryHome, "server", "instances", "fake-instance.json"),
    JSON.stringify({
      server_id: "fake-server",
      host: "127.0.0.1",
      port,
      pid: process.pid,
      heartbeat_at: Date.now(),
      host_version: "0.29.0"
    })
  );
  const currentService = await runBridge(["ensure"]);
  if (
    currentService.kimi_code_version !== "0.29.0" ||
    currentService.compatibility_status !== "tested"
  ) {
    throw new Error("The current Kimi instance discovery/version contract failed.");
  }
  const started = await runBridge([
    "start",
    "--mode", "analyze",
    "--focus", "engineering",
    "--cwd", fixtureCwd,
    "--prompt", "Review the fake protocol."
  ]);
  if (started.session_id !== sessionId || started.server_reported_model !== "kimi-code/k3") {
    throw new Error("The fake Kimi session did not start with the verified model.");
  }
  const result = await runBridge([
    "result",
    "--session-id", sessionId,
    "--wait-seconds", "5"
  ]);
  if (
    !result.complete ||
    !result.verified_k3 ||
    !result.result?.includes("# Fake K3 report") ||
    !approvalRejected ||
    !authenticated ||
    profile?.agent_config?.tools?.includes("WebSearch") ||
    profile?.agent_config?.tools?.includes("FetchURL")
  ) {
    throw new Error("The fake Kimi REST/WebSocket handoff contract failed.");
  }
  const sent = await runBridge([
    "send",
    "--session-id", sessionId,
    "--prompt", "Trigger the fake Provider failure."
  ]);
  if (sent.state !== "running" || sent.prompt_id !== failurePromptId) {
    throw new Error("The fake Kimi follow-up did not start.");
  }
  const failedResult = await runBridge([
    "result",
    "--session-id", sessionId,
    "--wait-seconds", "5"
  ]);
  if (
    !failedResult.complete ||
    failedResult.state !== "failed" ||
    failedResult.error_code !== "provider.rate_limit" ||
    !failedResult.error?.includes("429 The engine is overloaded") ||
    failedResult.result
  ) {
    throw new Error("A terminal Kimi Provider error did not become an immediate failed handoff.");
  }
  const rereadFailedResult = await runBridge([
    "result",
    "--session-id", sessionId,
    "--wait-seconds", "0"
  ]);
  if (
    !rereadFailedResult.complete ||
    rereadFailedResult.state !== "failed" ||
    rereadFailedResult.error_code !== "provider.rate_limit"
  ) {
    throw new Error("A durable Kimi Provider failure was resurrected by a non-settle REST read.");
  }
  const recovered = await runBridge([
    "send",
    "--session-id", sessionId,
    "--prompt", "Recover from a transient fake Provider overload."
  ]);
  if (recovered.state !== "running" || recovered.prompt_id !== recoveredPromptId) {
    throw new Error("The transient Provider recovery follow-up did not start.");
  }
  const recoveredResult = await runBridge([
    "result",
    "--session-id", sessionId,
    "--wait-seconds", "5"
  ]);
  if (
    !recoveredResult.complete ||
    recoveredResult.state !== "completed" ||
    recoveredResult.error ||
    !recoveredResult.result?.includes("# Recovered K3 report")
  ) {
    throw new Error("A transient Kimi Provider error was treated as terminal.");
  }
  process.stdout.write(`Fake Kimi REST/WebSocket test passed on ${process.platform}.\n`);
} finally {
  for (const socket of upgradedSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
