#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
const websocketModule = path.join(scriptsDir, "lib", "local-websocket.mjs");
const selfTest = path.join(scriptsDir, "self-test.mjs");

for (const script of [bridge, websocketModule, selfTest]) {
  const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(checked.stderr || `Syntax check failed for ${script}`);
  }
}

const { applyK3Event, createRenderState, renderK3Event } = await import(pathToFileURL(bridge));
const { connectLocalWebSocket } = await import(pathToFileURL(websocketModule));
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

const publishedText = [
  "README.md",
  path.join("agents", "kimi-k3-collaborator.toml"),
  path.join("skills", "kimi-k3-collab", "SKILL.md")
].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
if (/powershell|\.ps1|%USERPROFILE%|[A-Z]:\\/i.test(publishedText)) {
  throw new Error("A Windows-specific invocation remains in a published contract.");
}

const bridgeText = fs.readFileSync(bridge, "utf8");
if (!bridgeText.includes("const planMode = false") || bridgeText.includes("constraint_drift")) {
  throw new Error("Analysis is still coupled to Kimi plan mode or constraint-drift cancellation.");
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
