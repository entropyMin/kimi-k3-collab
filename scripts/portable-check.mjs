#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDir);
const bridge = path.join(scriptsDir, "kimi-k3.mjs");
const selfTest = path.join(scriptsDir, "self-test.mjs");

for (const script of [bridge, selfTest]) {
  const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(checked.stderr || `Syntax check failed for ${script}`);
  }
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
