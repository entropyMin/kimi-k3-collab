#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDir);
const bridge = path.join(scriptsDir, "kimi-k3.mjs");
const kimiHome = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));
const expected = "KIMI_K3_REAL_E2E_OK";

function runBridge(args) {
  return JSON.parse(execFileSync(process.execPath, [bridge, ...args], {
    encoding: "utf8",
    timeout: 120000
  }));
}

const service = runBridge(["ensure"]);
if (!service.healthy || service.model !== "kimi-code/k3") {
  throw new Error("Kimi service health or model verification failed.");
}

const started = runBridge([
  "start",
  "--mode", "analyze",
  "--focus", "engineering",
  "--cwd", root,
  "--prompt", `Compatibility test: inspect no files, call no tools, and reply with exactly ${expected}.`
]);
if (
  !started.session_id ||
  !started.prompt_id ||
  !started.verified_k3 ||
  started.server_reported_model !== "kimi-code/k3" ||
  started.kimi_code_version !== service.kimi_code_version
) {
  throw new Error("The real Kimi session did not start with the verified K3 compatibility contract.");
}

const result = runBridge([
  "result",
  "--session-id", started.session_id,
  "--wait-seconds", "90"
]);
if (
  !result.complete ||
  result.state !== "completed" ||
  !result.verified_k3 ||
  !String(result.result || "").includes(expected) ||
  !Number.isInteger(result.cursor?.seq) ||
  result.cursor.seq < 1
) {
  throw new Error(`The real Kimi prompt/WebSocket/result handoff failed: ${JSON.stringify({
    state: result.state,
    complete: result.complete,
    error: result.error,
    cursor: result.cursor
  })}`);
}

const latest = path.join(kimiHome, "codex-jobs", "latest.json");
const record = JSON.parse(fs.readFileSync(latest, "utf8"));
if (record.session_id !== started.session_id || record.state !== "completed") {
  throw new Error("The durable latest-job record does not match the completed real Kimi session.");
}

process.stdout.write(
  `Real Kimi K3 session/prompt/WebSocket/result test passed on ${process.platform} with Kimi Code ${service.kimi_code_version || service.version || "unknown"}.\n`
);
