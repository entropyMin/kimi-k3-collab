#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

process.stdout.write(`Portable checks passed on ${process.platform}.\n`);
