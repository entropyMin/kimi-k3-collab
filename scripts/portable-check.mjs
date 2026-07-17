#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDir);
const bridge = path.join(scriptsDir, "kimi-k3.mjs");
const mcpServer = path.join(scriptsDir, "mcp-server.mjs");
const websocketModule = path.join(scriptsDir, "lib", "local-websocket.mjs");
const selfTest = path.join(scriptsDir, "self-test.mjs");

for (const script of [bridge, mcpServer, websocketModule, selfTest]) {
  const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(checked.stderr || `Syntax check failed for ${script}`);
  }
}

const { applyK3Event, createRenderState, renderK3Event } = await import(pathToFileURL(bridge));
const { parseBridgeFooter, toolDefinition, toolDefinitions } = await import(pathToFileURL(mcpServer));
const { connectLocalWebSocket } = await import(pathToFileURL(websocketModule));
const footer = parseBridgeFooter("---\nKimi K3 session: session_mcp\nMode: analyze\nFocus: engineering\nStatus: completed\nModel: kimi-code/k3 (verified)\n");
if (footer.sessionId !== "session_mcp" || footer.status !== "completed" || footer.model !== "kimi-code/k3" || !footer.verifiedK3) {
  throw new Error("The MCP server did not preserve the K3 verification footer.");
}
if (
  toolDefinition.name !== "collaborate_with_k3" ||
  toolDefinition.inputSchema.properties.max_wait_seconds.maximum !== 3600 ||
  toolDefinitions.map((tool) => tool.name).join(",") !==
    "collaborate_with_k3,start_k3_job,get_k3_status,get_k3_result,cancel_k3_job"
) {
  throw new Error("The foreground/background MCP tool contract is invalid.");
}

const mcpFixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-mcp-"));
const stubBridge = path.join(mcpFixtureHome, "stub-bridge.mjs");
fs.writeFileSync(stubBridge, `
import fs from "node:fs";
import path from "node:path";
const [action, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const session = "session_portable_mcp";
const stateFile = path.join(process.env.KIMI_CODE_HOME, "stub-count");
const footer = (status) => \`---\\nKimi K3 session: \${session}\\nMode: analyze\\nFocus: engineering\\nStatus: \${status}\\nModel: kimi-code/k3 (verified)\\n\`;
if (action === "start") {
  if (!fs.readFileSync(0, "utf8").trim()) process.exit(2);
  process.stdout.write(JSON.stringify({ session_id: session, state: "running", mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }));
} else if (action === "status") {
  process.stdout.write(JSON.stringify({ session_id: session, state: "completed", busy: false, mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }));
} else if (action === "cancel") {
  process.stdout.write(JSON.stringify({ session_id: session, prompt_id: "prompt_stub", aborted: true }));
} else if (action === "watch" && process.env.KIMI_K3_STUB_HANG === "1") {
  fs.writeFileSync(path.join(process.env.KIMI_CODE_HOME, "stub-watch-started"), "1");
  setTimeout(() => {}, 10000);
} else if (action === "watch" && value("--wait-seconds") === "0") {
  process.stdout.write(\`# Stub K3 report\\n\\nOriginal Markdown.\\n\\n\${footer("completed")}\`);
} else if (action === "watch") {
  const count = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, "utf8")) + 1 : 1;
  fs.writeFileSync(stateFile, String(count));
  process.stdout.write(count === 1 ? \`K3 · Turn started\\n\${footer("running")}\` : \`K3 · Read completed\\n\${footer("completed")}\`);
} else {
  process.exit(3);
}
`, "utf8");
const mcpChild = spawn(process.execPath, [mcpServer], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    KIMI_K3_BRIDGE: stubBridge,
    KIMI_CODE_HOME: mcpFixtureHome,
    KIMI_K3_DISABLE_BACKGROUND_WORKER: "1"
  }
});
let mcpExited = false;
try {
  const request = (() => {
    const pending = new Map();
    let buffer = "";
    mcpChild.stdout.setEncoding("utf8");
    mcpChild.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    return (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The MCP request ${id} timed out.`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  })();

  const initialized = await request(1, "initialize", { protocolVersion: "2025-11-25" });
  const listed = await request(2, "tools/list", {});
  const foreground = await request(3, "tools/call", {
    name: "collaborate_with_k3",
    arguments: { prompt: "Stub review", mode: "analyze", focus: "engineering", cwd: root, max_wait_seconds: 5 }
  });
  const started = await request(4, "tools/call", {
    name: "start_k3_job",
    arguments: { prompt: "Background stub review", mode: "analyze", focus: "engineering", cwd: root }
  });
  const status = await request(5, "tools/call", {
    name: "get_k3_status",
    arguments: { session_id: "session_portable_mcp" }
  });
  const result = await request(6, "tools/call", {
    name: "get_k3_result",
    arguments: { session_id: "session_portable_mcp" }
  });
  const cancelled = await request(7, "tools/call", {
    name: "cancel_k3_job",
    arguments: { session_id: "session_portable_mcp" }
  });
  const invalid = await request(8, "tools/call", {
    name: "collaborate_with_k3",
    arguments: { prompt: "Invalid cwd", cwd: "." }
  });

  if (initialized.result?.serverInfo?.name !== "Kimi K3 Collab" || listed.result?.tools?.length !== 5) {
    throw new Error("The MCP stdio server did not advertise the K3 collaboration tool.");
  }
  const toolResult = foreground.result;
  const resultText = toolResult?.content?.[0]?.text || "";
  if (
    toolResult?.structuredContent?.status !== "completed" ||
    toolResult.structuredContent.action_count !== 2 ||
    !resultText.includes("K3 · Turn started") ||
    !resultText.includes("K3 · Read completed") ||
    !resultText.includes("# Stub K3 report")
  ) {
    throw new Error("The MCP delegate/watch flow lost K3 actions or the original Markdown report.");
  }
  if (
    started.result?.structuredContent?.status !== "running" ||
    started.result.structuredContent.background_worker_started !== false ||
    status.result?.structuredContent?.status !== "completed" ||
    !result.result?.content?.[0]?.text?.includes("# Stub K3 report") ||
    !cancelled.result?.structuredContent?.aborted ||
    [started, status, result, cancelled].some((message) => message.result?.content?.[0]?.text?.trimStart().startsWith("{"))
  ) {
    throw new Error("The background MCP job flow lost readable status, result, or cancellation output.");
  }
  if (!invalid.result?.isError || invalid.error) {
    throw new Error("MCP tool execution errors are not returned with the MCP isError result shape.");
  }
  mcpChild.stdin.end();
  const exitCode = await Promise.race([
    new Promise((resolve) => mcpChild.once("exit", (code) => resolve(code))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The MCP server did not exit after stdin closed.")), 2000))
  ]);
  mcpExited = true;
  if (exitCode !== 0) throw new Error(`The MCP server exited with code ${exitCode} after stdin closed.`);

  const lifecycleChild = spawn(process.execPath, [mcpServer], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      KIMI_K3_BRIDGE: stubBridge,
      KIMI_CODE_HOME: mcpFixtureHome,
      KIMI_K3_DISABLE_BACKGROUND_WORKER: "1",
      KIMI_K3_STUB_HANG: "1"
    }
  });
  let lifecycleExited = false;
  try {
    lifecycleChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 20, method: "initialize", params: {} })}\n`);
    lifecycleChild.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "collaborate_with_k3",
        arguments: { prompt: "Keep running", mode: "analyze", focus: "engineering", cwd: root }
      }
    })}\n`);
    const watchStarted = path.join(mcpFixtureHome, "stub-watch-started");
    for (let attempt = 0; !fs.existsSync(watchStarted) && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!fs.existsSync(watchStarted)) throw new Error("The active MCP bridge fixture did not start.");
    lifecycleChild.stdin.end();
    const lifecycleExitCode = await Promise.race([
      new Promise((resolve) => lifecycleChild.once("exit", (code) => resolve(code))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The MCP server left an active bridge child after stdin closed.")), 2000))
    ]);
    lifecycleExited = true;
    if (lifecycleExitCode !== 0) throw new Error(`The active MCP server exited with code ${lifecycleExitCode}.`);
  } finally {
    if (!lifecycleExited) lifecycleChild.kill();
  }
} finally {
  if (!mcpExited) mcpChild.kill();
  fs.rmSync(mcpFixtureHome, { recursive: true, force: true });
}
const renderState = createRenderState();
const toolLine = renderK3Event({
  type: "tool.call.started",
  payload: {
    toolCallId: "tool_portable",
    name: "Read",
    display: { kind: "file_io", operation: "read", path: "/project/README.md" }
  }
}, renderState);
const hiddenThinking = renderK3Event({ type: "thinking.delta", payload: { delta: "private reasoning" } }, renderState);
const assistantText = renderK3Event({ type: "assistant.delta", payload: { delta: "# Original report" } }, renderState);
if (!toolLine.includes("K3 · read /project/README.md") || hiddenThinking !== "" || !assistantText.endsWith("# Original report")) {
  throw new Error("The event renderer did not preserve readable K3 actions and report text.");
}
if (toolLine.trimStart().startsWith("{") || assistantText.includes("private reasoning")) {
  throw new Error("The event renderer exposed transport JSON or hidden thinking.");
}
const cursorRecord = { state: "running", complete: false, cursor: null };
applyK3Event(cursorRecord, {
  type: "turn.ended",
  seq: 42,
  epoch: "epoch_portable",
  payload: { reason: "completed" }
});
if (cursorRecord.cursor?.seq !== 42 || cursorRecord.cursor?.epoch !== "epoch_portable" || !cursorRecord.complete) {
  throw new Error("The durable event cursor or terminal state was not advanced.");
}

const websocketServer = http.createServer();
let upgradedSocket;
websocketServer.on("upgrade", (request, socket) => {
  upgradedSocket = socket;
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const headers = Buffer.from([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  const payload = Buffer.from(JSON.stringify({ type: "server_hello", payload: { protocol_version: 1 } }));
  socket.write(Buffer.concat([headers, Buffer.from([0x81, payload.length]), payload]));
});
await new Promise((resolve) => websocketServer.listen(0, "127.0.0.1", resolve));
try {
  const address = websocketServer.address();
  const websocket = await connectLocalWebSocket({ host: "127.0.0.1", port: address.port });
  const message = JSON.parse(await websocket.nextMessage(1000));
  websocket.close();
  if (message.type !== "server_hello") {
    throw new Error("The standard-library WebSocket client lost a server frame.");
  }
} finally {
  upgradedSocket?.destroy();
  await new Promise((resolve) => websocketServer.close(resolve));
}

const escaped = spawnSync(process.execPath, [
  bridge,
  "start",
  "--mode", "execute",
  "--cwd", root,
  "--allowed-path", "..",
  "--prompt", "This must fail before contacting Kimi."
], { encoding: "utf8" });
if (escaped.status === 0 || !escaped.stderr.includes("outside the working directory")) {
  throw new Error("The allowed-path escape guard did not reject a parent directory.");
}
const escapedSession = spawnSync(process.execPath, [bridge, "watch", "--session-id", "../escape", "--wait-seconds", "0"], { encoding: "utf8" });
if (escapedSession.status === 0 || !escapedSession.stderr.includes("unsupported characters")) {
  throw new Error("The session-id path escape guard did not reject traversal characters.");
}

const publishedText = [
  "README.md",
  path.join("skills", "kimi-k3-collab", "SKILL.md")
].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
if (/powershell|\.ps1|%USERPROFILE%|[A-Z]:\\/i.test(publishedText)) {
  throw new Error("A Windows-specific invocation remains in a published contract.");
}
const skillContract = fs.readFileSync(path.join(root, "skills", "kimi-k3-collab", "SKILL.md"), "utf8");
if (
  /kimi-k3\.mjs|--wait-seconds|17 event-stream windows/i.test(skillContract) ||
  !skillContract.includes("Do not spawn a Codex subagent") ||
  !skillContract.includes("Never create an automatic status loop")
) {
  throw new Error("The direct MCP skill still depends on a subagent or model-driven polling.");
}

const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
const mcpManifest = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
const mcpConfig = mcpManifest.mcpServers?.["kimi-k3"];
if (pluginManifest.mcpServers !== "./.mcp.json" || mcpConfig?.args?.[0] !== "./scripts/mcp-server.mjs" || mcpConfig.tool_timeout_sec < 3660) {
  throw new Error("The plugin MCP server or long-running tool timeout is not configured.");
}

const bridgeText = fs.readFileSync(bridge, "utf8");
if (
  !bridgeText.includes("const planMode = false") ||
  !bridgeText.includes('const permissionMode = readOnly ? "manual" : "auto"') ||
  !bridgeText.includes('frame.type === "event.approval.requested"') ||
  !bridgeText.includes('decision: "rejected"') ||
  bridgeText.includes("constraint_drift")
) {
  throw new Error("Analysis is still coupled to Kimi plan mode or constraint-drift cancellation.");
}
const mcpServerText = fs.readFileSync(mcpServer, "utf8");
if (!mcpServerText.includes('lines.on("close", closeTransport)') || !mcpServerText.includes('error?.code === "EPIPE"')) {
  throw new Error("The MCP stdio transport does not shut down cleanly after its client disconnects.");
}
if (!bridgeText.includes('"TodoList"') || !bridgeText.includes("Do not call Bash")) {
  throw new Error("Analysis mode does not allow safe planning while forbidding shell execution.");
}
if (!bridgeText.includes("PROCESS_DEADLINE = Date.now() + 115000") || !bridgeText.includes("cursor: { seq: 0 }")) {
  throw new Error("The command budget or replay-from-zero cursor guard is missing.");
}

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-collab-"));
try {
  const jobs = path.join(temporaryHome, "codex-jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const renderLatest = (record) => {
    fs.writeFileSync(path.join(jobs, "latest.json"), JSON.stringify(record));
    return spawnSync(process.execPath, [bridge, "latest", "--format", "text"], {
      encoding: "utf8",
      env: { ...process.env, KIMI_CODE_HOME: temporaryHome }
    });
  };
  const baseRecord = {
    kind: "kimi-k3-native-delegation",
    session_id: "session_portable_check",
    server_reported_model: "kimi-code/k3",
    verified_k3: true
  };
  const textResult = renderLatest({
    ...baseRecord,
    state: "completed",
    complete: true,
    result: "# Original K3 report\n\nHuman-readable output."
  });
  if (textResult.status !== 0 || !textResult.stdout.includes("# Original K3 report") || textResult.stdout.trimStart().startsWith("{")) {
    throw new Error(textResult.stderr || "The text output contract exposed JSON or lost the K3 report.");
  }
  const blockedResult = renderLatest({ ...baseRecord, state: "blocked", complete: false, result: null });
  if (!blockedResult.stdout.includes("blocked waiting for interaction") || !blockedResult.stdout.includes("Status: blocked")) {
    throw new Error(blockedResult.stderr || "The text output contract did not surface a blocked job.");
  }
  const failedResult = renderLatest({ ...baseRecord, state: "failed", complete: true, result: null });
  if (!failedResult.stdout.includes("stopped with status: failed") || !failedResult.stdout.includes("Status: failed")) {
    throw new Error(failedResult.stderr || "The text output contract did not surface a failed job.");
  }
} finally {
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}

process.stdout.write(`Portable checks passed on ${process.platform}.\n`);
