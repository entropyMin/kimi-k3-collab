#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(scriptsDir, "kimi-k3.mjs");
const kimiHome = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"));

const service = JSON.parse(execFileSync(process.execPath, [bridge, "ensure"], { encoding: "utf8" }));
if (!service.healthy || service.model !== "kimi-code/k3") {
  throw new Error("Kimi service health or model verification failed.");
}

const latest = path.join(kimiHome, "codex-jobs", "latest.json");
if (fs.existsSync(latest)) {
  const record = JSON.parse(fs.readFileSync(latest, "utf8"));
  if (!String(record.session_id || "").trim()) {
    throw new Error("The durable latest-job record has no session_id.");
  }
}

process.stdout.write(`Real Kimi K3 bridge test passed on ${process.platform}.\n`);
