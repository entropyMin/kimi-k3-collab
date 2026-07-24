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
const handoffHook = path.join(scriptsDir, "k3-codex-hook.mjs");
const websocketModule = path.join(scriptsDir, "lib", "local-websocket.mjs");
const policyModule = path.join(scriptsDir, "lib", "k3-policy.mjs");
const selfTest = path.join(scriptsDir, "self-test.mjs");
const realKimiTest = path.join(scriptsDir, "real-kimi-test.mjs");

for (const script of [bridge, mcpServer, handoffHook, websocketModule, policyModule, selfTest, realKimiTest]) {
  const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(checked.stderr || `Syntax check failed for ${script}`);
  }
}

const bridgeUnitHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-bridge-unit-ü;-"));
const originalKimiHome = process.env.KIMI_CODE_HOME;
process.env.KIMI_CODE_HOME = bridgeUnitHome;
const {
  applyK3Event,
  createRenderState,
  eventMatchesCurrentPrompt,
  finalizeExecutionWorkspace,
  kimiServerLaunchSpec,
  pathsOverlap,
  prepareExecutionWorkspace,
  pruneExecutionResources,
  renderK3Event,
  restoreExecutionWorkspace,
  scopeViolations
} = await import(pathToFileURL(bridge));
if (originalKimiHome == null) delete process.env.KIMI_CODE_HOME;
else process.env.KIMI_CODE_HOME = originalKimiHome;
const legacyServerLaunch = kimiServerLaunchSpec("Commands:\n  run [options]   Start the Kimi server");
const currentServerLaunch = kimiServerLaunchSpec("Commands:\n  kill   Stop a legacy Kimi server");
if (
  legacyServerLaunch.detached ||
  legacyServerLaunch.args.join(" ") !== "server run --keep-alive --log-level warn" ||
  !currentServerLaunch.detached ||
  currentServerLaunch.args.join(" ") !== "web --no-open --log-level warn"
) {
  throw new Error("Kimi server startup capability negotiation is invalid.");
}
const {
  browserCommand,
  browserToolDefinition,
  awaitToolDefinition,
  integrationHandoff,
  panelResource,
  parseBridgeFooter,
  receiveToolDefinition,
  startToolDefinition,
  toolDefinitions
} = await import(pathToFileURL(mcpServer));
const { connectLocalWebSocket } = await import(pathToFileURL(websocketModule));
const footer = parseBridgeFooter("---\nKimi K3 session: session_mcp\nMode: analyze\nFocus: engineering\nStatus: completed\nModel: kimi-code/k3 (verified)\n");
if (footer.sessionId !== "session_mcp" || footer.status !== "completed" || footer.model !== "kimi-code/k3" || !footer.verifiedK3) {
  throw new Error("The MCP server did not preserve the K3 verification footer.");
}
if (
  startToolDefinition.name !== "start_k3_collaboration" ||
  startToolDefinition._meta?.ui?.resourceUri !== panelResource.uri ||
  startToolDefinition._meta?.["openai/outputTemplate"] !== panelResource.uri ||
  panelResource.mimeType !== "text/html;profile=mcp-app" ||
  toolDefinitions.map((tool) => tool.name).join(",") !==
    "start_k3_collaboration,open_k3_panel,send_k3_message,await_k3_result,receive_k3_events,open_k3_in_browser,get_k3_status,get_k3_result,cancel_k3_job"
) {
  throw new Error("The direct MCP Apps tool contract is invalid.");
}
if (
  awaitToolDefinition.inputSchema?.properties?.wait_seconds?.default !== 100 ||
  awaitToolDefinition.inputSchema?.properties?.wait_seconds?.maximum !== 100
) {
  throw new Error("The model-visible K3-to-Codex handoff does not use one bounded event wait.");
}
if (
  browserToolDefinition._meta?.ui?.visibility?.join(",") !== "app" ||
  browserToolDefinition._meta?.["openai/visibility"] !== "private" ||
  browserToolDefinition._meta?.["openai/widgetAccessible"] !== true ||
  browserCommand("http://127.0.0.1:1/#token=test", "win32").command !== "rundll32.exe" ||
  browserCommand("http://127.0.0.1:1/#token=test", "darwin").command !== "open" ||
  browserCommand("http://127.0.0.1:1/#token=test", "linux").command !== "xdg-open"
) {
  throw new Error("The private cross-platform Kimi browser launcher contract is invalid.");
}
const sendDefinition = toolDefinitions.find((tool) => tool.name === "send_k3_message");
if (
  sendDefinition?._meta?.ui?.visibility?.join(",") !== "model,app" ||
  sendDefinition?._meta?.["openai/widgetAccessible"] !== true
) {
  throw new Error("The K3 panel cannot send direct app-initiated follow-up messages.");
}
if (
  receiveToolDefinition._meta?.ui?.visibility?.join(",") !== "app" ||
  receiveToolDefinition._meta?.["openai/visibility"] !== "private" ||
  receiveToolDefinition._meta?.["openai/widgetAccessible"] !== true
) {
  throw new Error("The pushed K3 event receiver is not private and app-only.");
}

for (const preservedState of ["scope_violation", "integration_error", "unintegrated_ignored_files"]) {
  const preservedHandoff = integrationHandoff({
    integration: {
      isolation: "git-worktree",
      state: preservedState,
      branch: "k3/fixture",
      worktree_root: "D:/fixture/k3-worktree"
    }
  });
  if (
    preservedHandoff.structured.worktree_root !== "D:/fixture/k3-worktree" ||
    !preservedHandoff.text.includes("Preserved worktree: D:/fixture/k3-worktree") ||
    !preservedHandoff.text.includes("cherry-pick")
  ) {
    throw new Error("The preserved-worktree handoff guidance is missing or incomplete.");
  }
}
const integratedHandoff = integrationHandoff({
  integration: {
    isolation: "git-worktree",
    state: "ready",
    branch: "k3/fixture",
    commit: "abc123",
    worktree_root: "D:/fixture/k3-worktree"
  }
});
if (
  integratedHandoff.structured.worktree_root !== "D:/fixture/k3-worktree" ||
  integratedHandoff.text.includes("Preserved worktree")
) {
  throw new Error("An integrated handoff must expose worktree_root without preserved-worktree guidance.");
}

if (
  !pathsOverlap("src", "src/app.js") ||
  pathsOverlap("src", "scripts/app.js") ||
  scopeViolations(["src/app.js", "README.md"], ["src"]).join(",") !== "README.md"
) {
  throw new Error("The execute-mode path overlap guard is invalid.");
}

function checkedGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function samePath(left, right) {
  const identity = (value) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {}
    if (process.platform === "darwin") resolved = resolved.normalize("NFC");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return identity(left) === identity(right);
}

const isolationFixture = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-isolation-"));
try {
  checkedGit(isolationFixture, ["init"]);
  checkedGit(isolationFixture, ["config", "user.name", "Portable Check"]);
  checkedGit(isolationFixture, ["config", "user.email", "portable-check@local"]);
  fs.mkdirSync(path.join(isolationFixture, "src"));
  fs.mkdirSync(path.join(isolationFixture, "docs"));
  fs.writeFileSync(path.join(isolationFixture, "src", "feature.txt"), "base\n");
  fs.writeFileSync(path.join(isolationFixture, "docs", "guide.txt"), "guide\n");
  fs.writeFileSync(path.join(isolationFixture, ".gitignore"), "*.generated\nignored/\n");
  checkedGit(isolationFixture, ["add", "--all"]);
  checkedGit(isolationFixture, ["commit", "-m", "fixture"]);
  fs.writeFileSync(path.join(isolationFixture, "docs", "local.txt"), "unrelated local change\n");

  const linkedFixture = `${isolationFixture}-link`;
  fs.symlinkSync(isolationFixture, linkedFixture, process.platform === "win32" ? "junction" : "dir");
  try {
    const linked = await prepareExecutionWorkspace(linkedFixture, [path.join(linkedFixture, "src")]);
    if (
      linked.workspace.source_cwd !== fs.realpathSync.native(isolationFixture) ||
      linked.workspace.source_subdir !== "."
    ) {
      throw new Error("A symlinked working directory was not canonicalized.");
    }
    const linkedHandoff = finalizeExecutionWorkspace({
      session_id: "session_linked_cwd_fixture",
      prompt_id: "prompt_linked_cwd_fixture",
      mode: "execute",
      workspace: linked.workspace
    });
    if (
      linkedHandoff.state !== "no_changes" ||
      fs.existsSync(linked.workspace.worktree_root) ||
      checkedGit(isolationFixture, ["branch", "--list", linked.workspace.branch])
    ) {
      throw new Error("A canonicalized working directory did not finalize cleanly.");
    }
    const linkedFollowup = {
      session_id: "session_linked_cwd_followup",
      prompt_id: "prompt_linked_cwd_followup",
      mode: "execute",
      workspace: linked.workspace
    };
    await restoreExecutionWorkspace(linkedFollowup);
    if (
      !fs.existsSync(linked.workspace.worktree_root) ||
      checkedGit(linked.workspace.worktree_root, ["rev-parse", "HEAD"]) !== linked.workspace.base_commit
    ) {
      throw new Error("A no-change follow-up did not recreate its worktree from the persisted base commit.");
    }
    linked.workspace.turn_finalized_for = null;
    const linkedFollowupHandoff = finalizeExecutionWorkspace(linkedFollowup);
    if (
      linkedFollowupHandoff.state !== "no_changes" ||
      fs.existsSync(linked.workspace.worktree_root) ||
      checkedGit(isolationFixture, ["branch", "--list", linked.workspace.branch])
    ) {
      throw new Error("A recreated no-change worktree did not clean up its branch.");
    }
  } finally {
    fs.unlinkSync(linkedFixture);
  }

  const prepared = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  if (prepared.workspace.isolation !== "git-worktree" || !fs.existsSync(prepared.workspace.worktree_root)) {
    throw new Error("Git execute mode did not create an isolated worktree.");
  }
  fs.writeFileSync(path.join(prepared.cwd, "src", "feature.txt"), "k3 isolated change\n");
  const record = {
    session_id: "session_isolation_fixture",
    prompt_id: "prompt_isolation_fixture",
    mode: "execute",
    workspace: prepared.workspace
  };
  const handoff = finalizeExecutionWorkspace(record);
  if (
    handoff.state !== "ready" ||
    !handoff.commit ||
    fs.existsSync(prepared.workspace.worktree_root) ||
    fs.readFileSync(path.join(isolationFixture, "src", "feature.txt"), "utf8") !== "base\n" ||
    checkedGit(isolationFixture, ["show", `${handoff.commit}:src/feature.txt`]) !== "k3 isolated change"
  ) {
    throw new Error("The isolated Git handoff changed the source checkout or lost its commit.");
  }

  await restoreExecutionWorkspace(record);
  record.prompt_id = "prompt_isolation_followup";
  record.workspace.base_commit = checkedGit(record.workspace.worktree_root, ["rev-parse", "HEAD"]);
  record.workspace.turn_finalized_for = null;
  fs.writeFileSync(path.join(record.workspace.cwd, "src", "feature.txt"), "k3 follow-up change\n");
  const followupHandoff = finalizeExecutionWorkspace(record);
  if (
    followupHandoff.commits.length !== 2 ||
    fs.existsSync(record.workspace.worktree_root) ||
    checkedGit(isolationFixture, ["show", `${followupHandoff.commit}:src/feature.txt`]) !== "k3 follow-up change"
  ) {
    throw new Error("An execute-mode follow-up did not recreate and finalize the isolated worktree.");
  }

  fs.writeFileSync(path.join(isolationFixture, "src", "feature.txt"), "overlapping local change\n");
  let overlapRejected = false;
  try {
    await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  } catch (error) {
    overlapRejected = String(error).includes("overlapping K3 allowed_paths");
  }
  if (!overlapRejected) throw new Error("Parallel execute mode accepted overlapping source changes.");

  fs.writeFileSync(path.join(isolationFixture, "src", "feature.txt"), "base\n");
  const scoped = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  fs.writeFileSync(path.join(scoped.workspace.worktree_root, "README.md"), "outside scope\n");
  const scopedRecord = {
    session_id: "session_scope_fixture",
    prompt_id: "prompt_scope_fixture",
    mode: "execute",
    workspace: scoped.workspace
  };
  const scopedHandoff = finalizeExecutionWorkspace(scopedRecord);
  if (scopedHandoff.state !== "scope_violation" || !fs.existsSync(scoped.workspace.worktree_root)) {
    throw new Error("A scope violation was not blocked and preserved for review.");
  }
  const pruneJobs = path.join(bridgeUnitHome, "codex-jobs");
  fs.mkdirSync(pruneJobs, { recursive: true });
  fs.writeFileSync(path.join(pruneJobs, `${scopedRecord.session_id}.json`), JSON.stringify({
    ...scopedRecord,
    complete: true,
    integration: scopedHandoff
  }));
  const orphanSessionId = "session_portable_orphan";
  const orphanRoot = path.join(bridgeUnitHome, "codex-worktrees", "portable-orphan");
  const orphanBranch = "codex-k3/portable-orphan";
  checkedGit(isolationFixture, ["worktree", "add", "-b", orphanBranch, orphanRoot, "HEAD"]);
  fs.writeFileSync(path.join(pruneJobs, `${orphanSessionId}.json`), JSON.stringify({
    session_id: orphanSessionId,
    complete: true,
    workspace: {
      isolation: "git-worktree",
      source_repo: isolationFixture,
      worktree_root: orphanRoot,
      branch: orphanBranch
    },
    integration: { state: "ready" }
  }));
  const unknownRoot = path.join(bridgeUnitHome, "codex-worktrees", "portable-unknown");
  const unknownBranch = "codex-k3/portable-unknown";
  checkedGit(isolationFixture, ["worktree", "add", "-b", unknownBranch, unknownRoot, "HEAD"]);
  const emptySessionId = "session_portable_empty_directory";
  const emptyRoot = path.join(bridgeUnitHome, "codex-worktrees", "portable-empty");
  fs.mkdirSync(emptyRoot);
  fs.writeFileSync(path.join(pruneJobs, `${emptySessionId}.json`), JSON.stringify({
    session_id: emptySessionId,
    complete: true,
    workspace: {
      isolation: "git-worktree",
      source_repo: isolationFixture,
      worktree_root: emptyRoot,
      branch: "codex-k3/portable-empty"
    },
    integration: { state: "ready" }
  }));
  const prunePreview = pruneExecutionResources(false);
  let untargetedPruneError = null;
  try {
    pruneExecutionResources(true);
  } catch (error) {
    untargetedPruneError = error;
  }
  if (
    !untargetedPruneError?.message.includes("explicit session id") ||
    !prunePreview.candidates.some((candidate) =>
      candidate.type === "worktree" &&
      samePath(candidate.worktree_root, scoped.workspace.worktree_root) &&
      !candidate.deletable
    ) ||
    !prunePreview.candidates.some((candidate) =>
      candidate.type === "worktree" &&
      samePath(candidate.worktree_root, orphanRoot) &&
      candidate.deletable
    ) ||
    !prunePreview.candidates.some((candidate) =>
      candidate.type === "worktree" &&
      samePath(candidate.worktree_root, unknownRoot) &&
      !candidate.deletable &&
      candidate.reason === "missing-record"
    ) ||
    !prunePreview.candidates.some((candidate) =>
      candidate.type === "unowned_directory" &&
      samePath(candidate.worktree_root, emptyRoot) &&
      candidate.deletable &&
      candidate.reason === "empty-terminal-directory"
    )
  ) {
    throw new Error(`Prune preview did not distinguish preserved, explicit, and unknown worktrees: ${JSON.stringify({
      expected: {
        scoped: scoped.workspace.worktree_root,
        orphan: orphanRoot,
        unknown: unknownRoot,
        empty: emptyRoot
      },
      candidates: prunePreview.candidates.map((candidate) => ({
        type: candidate.type,
        worktree_root: candidate.worktree_root,
        session_id: candidate.session_id,
        deletable: candidate.deletable,
        reason: candidate.reason
      }))
    })}`);
  }
  const prunedResources = pruneExecutionResources(true, orphanSessionId);
  if (
    !fs.existsSync(scoped.workspace.worktree_root) ||
    fs.existsSync(orphanRoot) ||
    !fs.existsSync(unknownRoot) ||
    checkedGit(isolationFixture, ["branch", "--list", orphanBranch]) ||
    !prunedResources.deleted.some((candidate) => samePath(candidate.worktree_root, orphanRoot))
  ) {
    throw new Error("Session-targeted prune did not remove only the selected worktree.");
  }
  const originalRmdirSync = fs.rmdirSync;
  fs.rmdirSync = (target) => {
    if (target === emptyRoot) {
      const error = new Error("fixture directory is busy");
      error.code = "EBUSY";
      throw error;
    }
    return originalRmdirSync(target);
  };
  let busyEmptyDirectory;
  try {
    busyEmptyDirectory = pruneExecutionResources(true, emptySessionId);
  } finally {
    fs.rmdirSync = originalRmdirSync;
  }
  if (
    !fs.existsSync(emptyRoot) ||
    busyEmptyDirectory.deleted.length !== 0 ||
    !busyEmptyDirectory.errors.some((candidate) =>
      samePath(candidate.worktree_root, emptyRoot) &&
      candidate.delete_error.includes("fixture directory is busy")
    )
  ) {
    throw new Error("A locked empty terminal directory was not reported without forced deletion.");
  }
  const prunedEmptyDirectory = pruneExecutionResources(true, emptySessionId);
  if (
    fs.existsSync(emptyRoot) ||
    !prunedEmptyDirectory.deleted.some((candidate) => samePath(candidate.worktree_root, emptyRoot)) ||
    prunedEmptyDirectory.errors.length !== 0
  ) {
    throw new Error("Session-targeted prune did not remove a known empty terminal directory.");
  }
  checkedGit(isolationFixture, ["worktree", "remove", "--force", unknownRoot]);
  checkedGit(isolationFixture, ["branch", "-D", unknownBranch]);
  checkedGit(isolationFixture, ["worktree", "remove", "--force", scoped.workspace.worktree_root]);
  checkedGit(isolationFixture, ["branch", "-D", scoped.workspace.branch]);

  const ignored = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  fs.writeFileSync(path.join(ignored.cwd, "src", "result.generated"), "ignored result\n");
  const ignoredHandoff = finalizeExecutionWorkspace({
    session_id: "session_ignored_fixture",
    prompt_id: "prompt_ignored_fixture",
    mode: "execute",
    workspace: ignored.workspace
  });
  if (
    ignoredHandoff.state !== "unintegrated_ignored_files" ||
    ignoredHandoff.ignored_paths.join(",") !== "src/result.generated" ||
    !fs.existsSync(ignored.workspace.worktree_root)
  ) {
    throw new Error("An ignored result was not reported and preserved for review.");
  }
  checkedGit(isolationFixture, ["worktree", "remove", "--force", ignored.workspace.worktree_root]);
  checkedGit(isolationFixture, ["branch", "-D", ignored.workspace.branch]);

  const ignoredOutsideScope = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  fs.mkdirSync(path.join(ignoredOutsideScope.workspace.worktree_root, "ignored"));
  fs.writeFileSync(path.join(ignoredOutsideScope.workspace.worktree_root, "ignored", "outside.txt"), "outside scope\n");
  const ignoredOutsideHandoff = finalizeExecutionWorkspace({
    session_id: "session_ignored_scope_fixture",
    prompt_id: "prompt_ignored_scope_fixture",
    mode: "execute",
    workspace: ignoredOutsideScope.workspace
  });
  if (
    ignoredOutsideHandoff.state !== "scope_violation" ||
    ignoredOutsideHandoff.ignored_paths.join(",") !== "ignored/outside.txt" ||
    ignoredOutsideHandoff.scope_violations.join(",") !== "ignored/outside.txt" ||
    !fs.existsSync(ignoredOutsideScope.workspace.worktree_root)
  ) {
    throw new Error("An ignored result outside allowed_paths was not blocked.");
  }
  checkedGit(isolationFixture, ["worktree", "remove", "--force", ignoredOutsideScope.workspace.worktree_root]);
  checkedGit(isolationFixture, ["branch", "-D", ignoredOutsideScope.workspace.branch]);

  const externalTarget = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-external-"));
  const symlinkEscape = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  const escapingLink = path.join(symlinkEscape.cwd, "src", "linked");
  try {
    fs.symlinkSync(externalTarget, escapingLink, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(escapingLink, "escaped.txt"), "outside worktree\n");
    const symlinkHandoff = finalizeExecutionWorkspace({
      session_id: "session_symlink_escape_fixture",
      prompt_id: "prompt_symlink_escape_fixture",
      mode: "execute",
      workspace: symlinkEscape.workspace
    });
    if (
      symlinkHandoff.state !== "scope_violation" ||
      symlinkHandoff.symlink_paths.join(",") !== "src/linked" ||
      !fs.existsSync(path.join(externalTarget, "escaped.txt")) ||
      !fs.existsSync(symlinkEscape.workspace.worktree_root)
    ) {
      throw new Error("A symlink escape was not reported and preserved for review.");
    }
  } finally {
    if (fs.lstatSync(escapingLink, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(escapingLink);
    checkedGit(isolationFixture, ["worktree", "remove", "--force", symlinkEscape.workspace.worktree_root]);
    checkedGit(isolationFixture, ["branch", "-D", symlinkEscape.workspace.branch]);
    fs.rmSync(externalTarget, { recursive: true, force: true });
  }

  if (process.platform !== "win32") {
    const committedLink = path.join(isolationFixture, "src", "committed-link");
    fs.symlinkSync("../docs", committedLink, "dir");
    checkedGit(isolationFixture, ["add", "src/committed-link"]);
    checkedGit(isolationFixture, ["commit", "-m", "add committed symlink fixture"]);
    let committedLinkRejected = false;
    try {
      await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
    } catch (error) {
      committedLinkRejected = String(error).includes("contain symbolic links or junctions");
    }
    if (!committedLinkRejected) throw new Error("A committed symlink inside allowed_paths was accepted.");
    fs.unlinkSync(committedLink);
    checkedGit(isolationFixture, ["add", "src/committed-link"]);
    checkedGit(isolationFixture, ["commit", "-m", "remove committed symlink fixture"]);
  }

  const conflicting = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  fs.writeFileSync(path.join(conflicting.cwd, "src", "feature.txt"), "k3 conflict\n");
  fs.writeFileSync(path.join(isolationFixture, "src", "feature.txt"), "codex conflict\n");
  checkedGit(isolationFixture, ["add", "src/feature.txt"]);
  checkedGit(isolationFixture, ["commit", "-m", "concurrent Codex change"]);
  const conflictHandoff = finalizeExecutionWorkspace({
    session_id: "session_conflict_fixture",
    prompt_id: "prompt_conflict_fixture",
    mode: "execute",
    workspace: conflicting.workspace
  });
  if (
    conflictHandoff.state !== "conflict_likely" ||
    conflictHandoff.overlapping_source_paths.join(",") !== "src/feature.txt" ||
    conflictHandoff.source_committed_paths.join(",") !== "src/feature.txt" ||
    fs.readFileSync(path.join(isolationFixture, "src", "feature.txt"), "utf8") !== "codex conflict\n"
  ) {
    throw new Error("The handoff did not flag a source/K3 path conflict without overwriting Codex changes.");
  }

  const providerWorkspace = await prepareExecutionWorkspace(isolationFixture, [path.join(isolationFixture, "src")]);
  const providerRecord = {
    session_id: "session_provider_execute_fixture",
    prompt_id: "prompt_provider_execute_fixture",
    state: "running",
    complete: false,
    mode: "execute",
    workspace: providerWorkspace.workspace
  };
  fs.writeFileSync(path.join(providerWorkspace.cwd, "src", "provider.txt"), "partial provider result\n");
  applyK3Event(providerRecord, {
    type: "error",
    session_id: providerRecord.session_id,
    seq: 1,
    payload: {
      code: "provider.rate_limit",
      message: "429 overloaded",
      fatal: true
    }
  });
  const firstProviderHandoff = finalizeExecutionWorkspace(providerRecord);
  const secondProviderHandoff = finalizeExecutionWorkspace(providerRecord);
  if (
    !providerRecord.complete ||
    providerRecord.state !== "failed" ||
    firstProviderHandoff?.state !== "ready" ||
    !firstProviderHandoff.commit ||
    secondProviderHandoff?.commit !== firstProviderHandoff.commit ||
    providerRecord.workspace.turn_finalized_for !== providerRecord.prompt_id
  ) {
    throw new Error("A Provider failure did not finalize its partial execute handoff exactly once.");
  }

  const submoduleSource = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-submodule-source-"));
  try {
    checkedGit(submoduleSource, ["init"]);
    checkedGit(submoduleSource, ["config", "user.name", "Portable Check"]);
    checkedGit(submoduleSource, ["config", "user.email", "portable-check@local"]);
    fs.writeFileSync(path.join(submoduleSource, "feature.txt"), "submodule base\n");
    checkedGit(submoduleSource, ["add", "--all"]);
    checkedGit(submoduleSource, ["commit", "-m", "submodule fixture"]);
    const submoduleRelative = "module ü; space";
    checkedGit(isolationFixture, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", submoduleSource, submoduleRelative
    ]);
    checkedGit(isolationFixture, ["commit", "-am", "add submodule fixture"]);
    const submoduleRoot = path.join(isolationFixture, submoduleRelative);
    const submoduleSourceText = fs.readFileSync(path.join(submoduleRoot, "feature.txt"), "utf8");
    const submoduleWorkspace = await prepareExecutionWorkspace(
      submoduleRoot,
      [path.join(submoduleRoot, "feature.txt")]
    );
    fs.writeFileSync(path.join(submoduleWorkspace.cwd, "feature.txt"), "submodule K3 change\n");
    const submoduleHandoff = finalizeExecutionWorkspace({
      session_id: "session_submodule_fixture",
      prompt_id: "prompt_submodule_fixture",
      mode: "execute",
      workspace: submoduleWorkspace.workspace
    });
    if (
      submoduleWorkspace.workspace.source_repo !== fs.realpathSync.native(submoduleRoot) ||
      submoduleHandoff.state !== "ready" ||
      submoduleHandoff.changed_paths.join(",") !== "feature.txt" ||
      fs.existsSync(submoduleWorkspace.workspace.worktree_root) ||
      fs.readFileSync(path.join(submoduleRoot, "feature.txt"), "utf8") !== submoduleSourceText
    ) {
      throw new Error("Submodule execute isolation or special-path handoff failed.");
    }
  } finally {
    fs.rmSync(submoduleSource, { recursive: true, force: true });
  }

  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-single-writer-"));
  try {
    const bindFixtureOwner = (prepared, sessionId, {
      complete = false,
      createdAt = new Date().toISOString(),
      persistRecord = true
    } = {}) => {
      fs.writeFileSync(
        path.join(prepared.workspace.lock_path, "owner.json"),
        JSON.stringify({
          token: prepared.workspace.lock_token,
          cwd: prepared.workspace.source_cwd,
          session_id: sessionId,
          created_at: createdAt
        })
      );
      if (!persistRecord) return;
      fs.writeFileSync(
        path.join(bridgeUnitHome, "codex-jobs", `${sessionId}.json`),
        JSON.stringify({
          session_id: sessionId,
          prompt_id: `prompt_${sessionId}`,
          state: "running",
          complete,
          mode: "execute",
          focus: "engineering",
          workspace: prepared.workspace
        })
      );
    };
    const fixtureOwnerStatus = async (sessionId) => {
      if (sessionId === "session_missing_fixture") {
        throw new Error(`Kimi API error 40401: session ${sessionId} does not exist`);
      }
      if (sessionId === "session_uncertain_fixture") throw new Error("HTTP 503: service unavailable");
      const busy = sessionId === "session_live_fixture";
      return {
        state: busy ? "running" : sessionId.includes("idle") ? "idle" : "completed",
        busy,
        pending_interaction: "none"
      };
    };

    const first = await prepareExecutionWorkspace(nonGit, [nonGit]);
    let secondRejected = false;
    try {
      await prepareExecutionWorkspace(nonGit, [nonGit]);
    } catch (error) {
      secondRejected = String(error).includes("already owns the non-Git directory");
    }
    if (!secondRejected || first.workspace.isolation !== "single-writer") {
      throw new Error("The non-Git single-writer lock accepted a concurrent writer.");
    }
    finalizeExecutionWorkspace({
      session_id: "session_single_writer_fixture",
      prompt_id: "prompt_single_writer_fixture",
      mode: "execute",
      workspace: first.workspace
    });
    const reacquired = await prepareExecutionWorkspace(nonGit, [nonGit]);
    finalizeExecutionWorkspace({
      session_id: "session_single_writer_reacquired",
      prompt_id: "prompt_single_writer_reacquired",
      mode: "execute",
      workspace: reacquired.workspace
    });

    const live = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(live, "session_live_fixture", { complete: true });
    let liveRejected = false;
    try {
      await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    } catch (error) {
      liveRejected = String(error).includes("already owns the non-Git directory");
    }
    if (!liveRejected) throw new Error("A live single-writer owner was reclaimed.");
    finalizeExecutionWorkspace({
      session_id: "session_live_fixture",
      prompt_id: "prompt_session_live_fixture",
      mode: "execute",
      workspace: live.workspace
    });

    const youngCompleteTerminal = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(youngCompleteTerminal, "session_terminal_complete_young_fixture", { complete: true });
    let youngCompleteTerminalRejected = false;
    try {
      await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    } catch (error) {
      youngCompleteTerminalRejected = String(error).includes("already owns the non-Git directory");
    }
    if (!youngCompleteTerminalRejected) {
      throw new Error("A young complete terminal single-writer owner was reclaimed.");
    }
    finalizeExecutionWorkspace({
      session_id: "session_terminal_complete_young_fixture",
      prompt_id: "prompt_session_terminal_complete_young_fixture",
      mode: "execute",
      workspace: youngCompleteTerminal.workspace
    });

    const expiredCompleteTerminal = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(expiredCompleteTerminal, "session_terminal_complete_expired_fixture", {
      complete: true,
      createdAt: new Date(Date.now() - 121000).toISOString()
    });
    const recoveredCompleteTerminal = await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    finalizeExecutionWorkspace({
      session_id: "session_terminal_complete_expired_recovered",
      prompt_id: "prompt_session_terminal_complete_expired_recovered",
      mode: "execute",
      workspace: recoveredCompleteTerminal.workspace
    });

    const youngIdle = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(youngIdle, "session_idle_young_fixture", { persistRecord: false });
    let youngIdleRejected = false;
    try {
      await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    } catch (error) {
      youngIdleRejected = String(error).includes("already owns the non-Git directory");
    }
    if (!youngIdleRejected) throw new Error("A young bound owner without a job record was reclaimed.");
    finalizeExecutionWorkspace({
      session_id: "session_idle_young_fixture",
      prompt_id: "prompt_session_idle_young_fixture",
      mode: "execute",
      workspace: youngIdle.workspace
    });

    const expiredIdle = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(expiredIdle, "session_idle_expired_fixture", {
      createdAt: new Date(Date.now() - 121000).toISOString(),
      persistRecord: false
    });
    const recoveredIdle = await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    finalizeExecutionWorkspace({
      session_id: "session_idle_expired_recovered",
      prompt_id: "prompt_session_idle_expired_recovered",
      mode: "execute",
      workspace: recoveredIdle.workspace
    });

    const terminal = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(terminal, "session_terminal_fixture");
    const recoveredTerminal = await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    const terminalRecord = JSON.parse(fs.readFileSync(
      path.join(bridgeUnitHome, "codex-jobs", "session_terminal_fixture.json"),
      "utf8"
    ));
    if (!terminalRecord.complete || terminalRecord.integration?.state !== "direct_changes") {
      throw new Error("A terminal single-writer owner was not finalized before lock recovery.");
    }
    finalizeExecutionWorkspace({
      session_id: "session_terminal_recovered",
      prompt_id: "prompt_session_terminal_recovered",
      mode: "execute",
      workspace: recoveredTerminal.workspace
    });

    const missing = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(missing, "session_missing_fixture");
    const recoveredMissing = await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    const missingRecord = JSON.parse(fs.readFileSync(
      path.join(bridgeUnitHome, "codex-jobs", "session_missing_fixture.json"),
      "utf8"
    ));
    if (!missingRecord.complete || missingRecord.state !== "stopped") {
      throw new Error("A missing single-writer owner was not recovered.");
    }
    finalizeExecutionWorkspace({
      session_id: "session_missing_recovered",
      prompt_id: "prompt_session_missing_recovered",
      mode: "execute",
      workspace: recoveredMissing.workspace
    });

    const uncertain = await prepareExecutionWorkspace(nonGit, [nonGit]);
    bindFixtureOwner(uncertain, "session_uncertain_fixture");
    let uncertainRejected = false;
    try {
      await prepareExecutionWorkspace(nonGit, [nonGit], fixtureOwnerStatus);
    } catch (error) {
      uncertainRejected = String(error).includes("could not be verified");
    }
    if (!uncertainRejected) throw new Error("An unverifiable single-writer owner was reclaimed.");
    finalizeExecutionWorkspace({
      session_id: "session_uncertain_fixture",
      prompt_id: "prompt_session_uncertain_fixture",
      mode: "execute",
      workspace: uncertain.workspace
    });

    const race = await Promise.allSettled([
      prepareExecutionWorkspace(nonGit, [nonGit]),
      prepareExecutionWorkspace(nonGit, [nonGit])
    ]);
    const raceWinner = race.find((result) => result.status === "fulfilled");
    const raceLoser = race.find((result) => result.status === "rejected");
    if (
      !raceWinner ||
      !raceLoser ||
      !String(raceLoser.reason).includes("already owns the non-Git directory") ||
      raceLoser.reason?.code === "EEXIST"
    ) {
      throw new Error("Concurrent single-writer acquisition did not fail with the friendly contention error.");
    }
    finalizeExecutionWorkspace({
      session_id: "session_race_winner",
      prompt_id: "prompt_session_race_winner",
      mode: "execute",
      workspace: raceWinner.value.workspace
    });
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(isolationFixture, { recursive: true, force: true });
  fs.rmSync(bridgeUnitHome, { recursive: true, force: true });
}

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

const mcpFixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-k3-mcp-"));
const stubBridge = path.join(mcpFixtureHome, "stub-bridge.mjs");
const fixtureToken = "fixture-secret-token";
const relayServer = http.createServer();
const relaySockets = new Set();
let relayAuthenticated = false;
let relayConnectionCount = 0;
relayServer.on("upgrade", (request, socket) => {
  relayConnectionCount += 1;
  relayAuthenticated ||= request.headers.authorization === `Bearer ${fixtureToken}`;
  relaySockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => relaySockets.delete(socket));
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
  const sharedToolStart = { type: "tool.call.started", session_id: "session_portable_mcp", seq: 3, payload: { toolCallId: "tool_fixture", name: "Read", args: { path: "README.md" } } };
  const frames = relayConnectionCount === 1
    ? [
        { type: "server_hello", payload: { protocol_version: 1 } },
        { type: "turn.started", session_id: "session_portable_mcp", seq: 1, payload: { turnId: "turn_fixture" } },
        { type: "assistant.delta", session_id: "session_portable_mcp", seq: 2, volatile: true, offset: 0, payload: { turnId: "turn_fixture", delta: "A" } },
        { type: "assistant.delta", session_id: "session_portable_mcp", seq: 2, volatile: true, offset: 1, payload: { turnId: "turn_fixture", delta: "B" } },
        sharedToolStart,
        { type: "event.approval.requested", session_id: "session_portable_mcp", seq: 4, payload: { approval_id: "approval_fixture", tool_call_id: "tool_bash", tool_name: "Bash" } }
      ]
    : [
        { type: "server_hello", payload: { protocol_version: 1 } },
        sharedToolStart,
        { type: "tool.progress", session_id: "session_portable_mcp", seq: 5, volatile: true, payload: { toolCallId: "tool_fixture", update: { message: "x".repeat(300000) } } },
        { type: "tool.progress", session_id: "session_portable_mcp", seq: 5, volatile: true, payload: { toolCallId: "tool_fixture", update: { message: "y".repeat(300000) } } },
        { type: "resync_required", payload: { session_id: "session_portable_mcp", current_seq: 5, epoch: "epoch_portable_resync" } },
        { type: "tool.result", session_id: "session_portable_mcp", seq: 6, payload: { toolCallId: "tool_fixture", output: "ok", isError: false } },
        { type: "error", session_id: "session_portable_mcp", seq: 7, payload: { code: "provider.rate_limit", message: "429 overloaded", fatal: true } },
        { type: "turn.started", session_id: "session_portable_mcp", seq: 8, payload: { turnId: "turn_followup" } },
        { type: "error", session_id: "session_portable_mcp", seq: 9, payload: { code: "provider.rate_limit", message: "429 overloaded again", fatal: true } },
        { type: "tool.call.started", session_id: "session_portable_mcp", seq: 10, payload: { toolCallId: "tool_disallowed", name: "Bash", args: { command: "echo blocked" } } },
        { type: "turn.ended", session_id: "session_portable_mcp", seq: 11, payload: { turnId: "turn_followup", reason: "completed" } }
      ];
  socket.write(Buffer.concat([headers, ...frames.map(websocketFrame)]));
  if (relayConnectionCount === 1) setTimeout(() => socket.destroy(), 20);
});
await new Promise((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
const relayPort = relayServer.address().port;
const instanceRoot = path.join(mcpFixtureHome, "server", "instances");
const instanceFile = path.join(instanceRoot, "current.json");
fs.mkdirSync(instanceRoot, { recursive: true });
fs.writeFileSync(
  instanceFile,
  JSON.stringify({
    host: "127.0.0.1",
    port: relayPort,
    pid: process.pid,
    host_version: "0.29.0",
    heartbeat_at: Date.now()
  }),
  "utf8"
);
fs.writeFileSync(path.join(mcpFixtureHome, "server.token"), fixtureToken, "utf8");
fs.writeFileSync(stubBridge, `
import fs from "node:fs";
if (process.env.KIMI_K3_HOOK_FAIL === "1") process.exit(4);
const [action, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const session = "session_portable_mcp";
const requestedSession = value("--session-id") || session;
const footer = (status) => \`---\\nKimi K3 session: \${session}\\nMode: analyze\\nFocus: engineering\\nStatus: \${status}\\nModel: kimi-code/k3 (verified)\\n\`;
if (action === "start") {
  if (!fs.readFileSync(0, "utf8").trim()) process.exit(2);
  fs.appendFileSync(process.env.KIMI_CODE_HOME + "/start-calls", "1\\n");
  process.stdout.write(JSON.stringify({ session_id: session, state: "running", mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }));
} else if (action === "send") {
  if (!fs.readFileSync(0, "utf8").trim()) process.exit(2);
  process.stdout.write(JSON.stringify({ session_id: session, state: "running", mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }));
} else if (action === "status") {
  process.stdout.write(JSON.stringify({ session_id: requestedSession, state: "completed", busy: false, mode: requestedSession === "session_mode_missing" ? null : "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }));
} else if (action === "result") {
  process.stdout.write(value("--format") === "json"
    ? JSON.stringify(requestedSession === "session_running"
      ? { session_id: requestedSession, state: "running", complete: false, mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }
      : requestedSession === "session_failed"
        ? { session_id: requestedSession, state: "failed", complete: true, error: "[provider.rate_limit] 429 overloaded", error_code: "provider.rate_limit", result: "# Stale report", mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true }
      : requestedSession === "session_scope_violation_fixture"
        ? { session_id: requestedSession, state: "failed", complete: true, error: "K3 wrote outside its allowed paths; the isolated worktree was preserved for review.", error_code: "scope_violation", mode: "execute", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true, integration: { isolation: "git-worktree", state: "scope_violation", branch: "k3/session_scope_violation_fixture", commit: null, worktree_root: "D:/fixture/k3-worktree", changed_paths: ["README.md"], scope_violations: ["README.md"] } }
      : { session_id: requestedSession, state: "max_tokens", complete: true, result: "# Stub K3 report\\n\\nOriginal Markdown.", mode: "analyze", focus: "engineering", server_reported_model: "kimi-code/k3", verified_k3: true })
    : \`# Stub K3 report\\n\\nOriginal Markdown.\\n\\n\${footer("completed")}\`);
} else if (action === "reject-approval") {
  fs.writeFileSync(process.env.KIMI_CODE_HOME + "/approval-rejected", "1");
  process.stdout.write(JSON.stringify({ session_id: session, approval_id: "approval_fixture", decision: "rejected", resolved: true }));
} else if (action === "cancel") {
  process.stdout.write(JSON.stringify({ session_id: session, prompt_id: "prompt_stub", aborted: true }));
} else if (action === "ensure") {
  process.stdout.write(JSON.stringify({ healthy: true, model: "kimi-code/k3" }));
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
    KIMI_K3_BROWSER_TEST: "1"
  }
});
let mcpExited = false;
try {
  const createRequest = (child) => {
    const pending = new Map();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const waitFor = async (predicate, description, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const request = createRequest(mcpChild);

  const initialized = await request(1, "initialize", { protocolVersion: "2025-11-25" });
  const listed = await request(2, "tools/list", {});
  const resources = await request(3, "resources/list", {});
  const panel = await request(4, "resources/read", { uri: panelResource.uri });
  let nextRequestId = 5;
  let relayCursor = 0;
  let relayGeneration = "";
  const relayedFrames = [];
  let maxRelayedBatchBytes = 0;
  for (let attempt = 0; attempt < 10 && !relayedFrames.some((frame) => frame.type === "turn.ended"); attempt += 1) {
    const received = await request(nextRequestId++, "tools/call", {
      name: "receive_k3_events",
      arguments: { session_id: "session_portable_mcp", after_cursor: relayCursor, wait_ms: 1000 }
    });
    const batch = received.result?.structuredContent;
    relayGeneration ||= batch?.relay_generation || "";
    maxRelayedBatchBytes = Math.max(maxRelayedBatchBytes, Buffer.byteLength(JSON.stringify(batch?.events || []), "utf8"));
    relayedFrames.push(...(batch?.events || []));
    relayCursor = batch?.cursor ?? relayCursor;
  }
  const started = await request(nextRequestId++, "tools/call", {
    name: "start_k3_collaboration",
    arguments: { prompt: "Stub review", mode: "analyze", focus: "engineering", cwd: root }
  });
  const opened = await request(nextRequestId++, "tools/call", {
    name: "open_k3_panel",
    arguments: { session_id: "session_portable_mcp" }
  });
  const browserOpened = await request(nextRequestId++, "tools/call", {
    name: "open_k3_in_browser",
    arguments: { session_id: "session_portable_mcp" }
  });
  const awaited = await request(nextRequestId++, "tools/call", {
    name: "await_k3_result",
    arguments: { session_id: "session_portable_mcp", wait_seconds: 1 }
  });
  const runningAwaited = await request(nextRequestId++, "tools/call", {
    name: "await_k3_result",
    arguments: { session_id: "session_running", wait_seconds: 1 }
  });
  const failedAwaited = await request(nextRequestId++, "tools/call", {
    name: "await_k3_result",
    arguments: { session_id: "session_failed", wait_seconds: 1 }
  });
  const scopeHandoff = await request(nextRequestId++, "tools/call", {
    name: "await_k3_result",
    arguments: { session_id: "session_scope_violation_fixture", wait_seconds: 1 }
  });
  const messaged = await request(nextRequestId++, "tools/call", {
    name: "send_k3_message",
    arguments: { session_id: "session_portable_mcp", prompt: "Challenge the retry policy." }
  });
  const status = await request(nextRequestId++, "tools/call", {
    name: "get_k3_status",
    arguments: { session_id: "session_portable_mcp" }
  });
  const result = await request(nextRequestId++, "tools/call", {
    name: "get_k3_result",
    arguments: { session_id: "session_portable_mcp" }
  });
  const cancelled = await request(nextRequestId++, "tools/call", {
    name: "cancel_k3_job",
    arguments: { session_id: "session_portable_mcp" }
  });
  const invalid = await request(nextRequestId++, "tools/call", {
    name: "start_k3_collaboration",
    arguments: { prompt: "Invalid cwd", cwd: "." }
  });
  const missingMode = await request(nextRequestId++, "tools/call", {
    name: "receive_k3_events",
    arguments: { session_id: "session_mode_missing", after_cursor: 0, wait_ms: 0 }
  });
  const startCallsBeforeUnavailable = fs.readFileSync(path.join(mcpFixtureHome, "start-calls"), "utf8");
  fs.unlinkSync(instanceFile);
  const unavailable = await request(nextRequestId++, "tools/call", {
    name: "start_k3_collaboration",
    arguments: { prompt: "No panel service", mode: "analyze", focus: "engineering", cwd: root }
  });
  const startCallsAfterUnavailable = fs.readFileSync(path.join(mcpFixtureHome, "start-calls"), "utf8");

  if (
    initialized.result?.serverInfo?.name !== "Kimi K3 Collab" ||
    listed.result?.tools?.length !== 9 ||
    resources.result?.resources?.[0]?.uri !== panelResource.uri ||
    panel.result?.contents?.[0]?.mimeType !== panelResource.mimeType ||
    !panel.result?.contents?.[0]?.text?.includes("Kimi K3 live session") ||
    !panel.result?.contents?.[0]?.text?.includes("[hidden] { display: none !important; }") ||
    !panel.result?.contents?.[0]?.text?.includes("value?.result?._meta") ||
    panel.result?.contents?.[0]?.text?.includes("new WebSocket") ||
    panel.result?.contents?.[0]?.text?.includes("kimi-code.bearer.") ||
    !panel.result?.contents?.[0]?.text?.includes("receive_k3_events") ||
    !panel.result?.contents?.[0]?.text?.includes("open_k3_in_browser") ||
    !panel.result?.contents?.[0]?.text?.includes("send_k3_message") ||
    !panel.result?.contents?.[0]?.text?.includes("relay.policy") ||
    !panel.result?.contents?.[0]?.text?.includes("resynced") ||
    !panel.result?.contents?.[0]?.text?.includes("stream gap: resumed at source offset") ||
    panel.result?.contents?.[0]?.text?.includes("<iframe") ||
    panel.result?.contents?.[0]?._meta?.ui?.csp?.connectDomains !== undefined ||
    panel.result?.contents?.[0]?._meta?.ui?.csp?.frameDomains !== undefined ||
    panel.result?.contents?.[0]?._meta?.["openai/widgetCSP"]?.connect_domains?.length !== 0 ||
    panel.result?.contents?.[0]?._meta?.["openai/widgetCSP"]?.frame_domains !== undefined ||
    !panel.result?.contents?.[0]?._meta?.["openai/widgetCSP"]?.redirect_domains?.includes("http://127.0.0.1:58627") ||
    !panel.result?.contents?.[0]?._meta?.["openai/widgetCSP"]?.redirect_domains?.includes(`http://127.0.0.1:${relayPort}`)
  ) {
    throw new Error("The MCP server did not advertise the K3 tools and app resource.");
  }

  const panelScript = panel.result?.contents?.[0]?.text?.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!panelScript) throw new Error("The K3 event panel script is missing.");
  Function(panelScript);

  const privatePanelUrl = started.result?._meta?.["kimi-k3/panelUrl"];
  const openedPanelUrl = opened.result?._meta?.["kimi-k3/panelUrl"];
  const privateToken = started.result?._meta?.["kimi-k3/token"];
  const privateOrigin = started.result?._meta?.["kimi-k3/origin"];
  const modelVisible = JSON.stringify({
    content: started.result?.content,
    structuredContent: started.result?.structuredContent
  });
  if (
    started.result?.structuredContent?.status !== "running" ||
    started.result?.structuredContent?.server_reported_model !== "kimi-code/k3" ||
    !started.result?.structuredContent?.verified_k3 ||
    !privatePanelUrl?.endsWith(`#token=${fixtureToken}`) ||
    privateToken !== undefined ||
    privateOrigin !== undefined ||
    openedPanelUrl !== privatePanelUrl ||
    browserOpened.result?.structuredContent?.opened !== true ||
    awaited.result?.structuredContent?.complete !== true ||
    !awaited.result?.structuredContent?.result_markdown?.includes("# Stub K3 report") ||
    !awaited.result?.content?.[0]?.text?.includes("# Stub K3 report") ||
    runningAwaited.result?.structuredContent?.complete !== false ||
    !runningAwaited.result?.content?.[0]?.text?.includes("do not narrate the same waiting state") ||
    !runningAwaited.result?.content?.[0]?.text?.includes("inspect Git/status as filler") ||
    !runningAwaited.result?.content?.[0]?.text?.includes("for polling") ||
    failedAwaited.result?.structuredContent?.status !== "failed" ||
    failedAwaited.result?.structuredContent?.complete !== true ||
    failedAwaited.result?.structuredContent?.error_code !== "provider.rate_limit" ||
    failedAwaited.result?.structuredContent?.result_markdown !== null ||
    !failedAwaited.result?.content?.[0]?.text?.includes("[provider.rate_limit] 429 overloaded") ||
    failedAwaited.result?.content?.[0]?.text?.includes("# Stale report") ||
    JSON.stringify(browserOpened.result?.structuredContent).includes(fixtureToken) ||
    modelVisible.includes(fixtureToken) ||
    JSON.stringify(opened.result?.structuredContent).includes(fixtureToken) ||
    messaged.result?.structuredContent?.status !== "running" ||
    status.result?.structuredContent?.status !== "completed" ||
    !result.result?.structuredContent?.result_markdown?.includes("# Stub K3 report") ||
    !result.result?.content?.[0]?.text?.includes("# Stub K3 report") ||
    !cancelled.result?.structuredContent?.aborted ||
    !relayAuthenticated ||
    !relayGeneration ||
    relayConnectionCount !== 2 ||
    relayedFrames.filter((frame) => frame.type === "assistant.delta" && frame.seq === 2).length !== 2 ||
    relayedFrames.filter((frame) => frame.type === "tool.call.started" && frame.seq === 3).length !== 1 ||
    !relayedFrames.some((frame) => frame.type === "tool.result") ||
    !relayedFrames.some((frame) => frame.type === "relay.policy" && frame.payload?.status === "rejected") ||
    !relayedFrames.some((frame) => frame.type === "relay.policy" && frame.payload?.message?.includes("Stopped disallowed tool")) ||
    relayedFrames.filter((frame) =>
      frame.type === "relay.status" &&
      frame.payload?.status === "failed" &&
      frame.payload?.terminal === true &&
      frame.payload?.turn_terminal === true
    ).length !== 2 ||
    !relayedFrames.some((frame) => frame.type === "relay.status" && frame.payload?.status === "resynced") ||
    relayedFrames.findIndex((frame) => frame.type === "error" && frame.payload?.code === "provider.rate_limit") < 0 ||
    relayedFrames.findIndex((frame) => frame.type === "error" && frame.payload?.code === "provider.rate_limit") >
      relayedFrames.findIndex((frame) => frame.type === "turn.ended") ||
    !fs.existsSync(path.join(mcpFixtureHome, "approval-rejected")) ||
    maxRelayedBatchBytes > 520000 ||
    relayCursor < relayedFrames.length ||
    [started, opened, browserOpened, awaited, runningAwaited, failedAwaited, messaged, status, result, cancelled].some((message) =>
      message.result?.content?.[0]?.text?.trimStart().startsWith("{")
    )
  ) {
    throw new Error("The direct K3 panel, messaging, fallback, or token-isolation contract failed.");
  }
  if (
    scopeHandoff.result?.structuredContent?.integration_state !== "scope_violation" ||
    scopeHandoff.result?.structuredContent?.worktree_root !== "D:/fixture/k3-worktree" ||
    !scopeHandoff.result?.content?.[0]?.text?.includes("Preserved worktree: D:/fixture/k3-worktree") ||
    !scopeHandoff.result?.content?.[0]?.text?.includes("cherry-pick")
  ) {
    throw new Error("The scope-violation handoff did not expose the preserved worktree.");
  }
  if (!invalid.result?.isError || invalid.error) {
    throw new Error("MCP tool execution errors are not returned with the MCP isError result shape.");
  }
  if (
    !missingMode.result?.isError ||
    !unavailable.result?.isError ||
    startCallsAfterUnavailable !== startCallsBeforeUnavailable
  ) {
    throw new Error("The MCP restart policy or preflight orphan guard failed.");
  }

  const hookData = path.join(mcpFixtureHome, "hook-data");
  const hookEnvironment = {
    ...process.env,
    PLUGIN_ROOT: root,
    PLUGIN_DATA: hookData,
    KIMI_K3_HOOK_BRIDGE: stubBridge,
    KIMI_CODE_HOME: mcpFixtureHome,
    KIMI_K3_STOP_MAX_WAIT_SECONDS: "1"
  };
  const runHook = (input, env = {}) => spawnSync(process.execPath, [handoffHook], {
    cwd: root,
    env: { ...hookEnvironment, ...env },
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 5000
  });
  const tracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: "codex_fixture",
    turn_id: "codex_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", status: "running" } }
  });
  const handedOff = runHook({
    hook_event_name: "Stop",
    session_id: "codex_fixture",
    turn_id: "codex_turn",
    stop_hook_active: false
  });
  const released = runHook({
    hook_event_name: "Stop",
    session_id: "codex_fixture",
    turn_id: "codex_turn_2",
    stop_hook_active: true
  });
  const guardSession = "codex_guard_fixture";
  const guardTracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: guardSession,
    turn_id: "codex_guard_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", status: "running" } }
  });
  const guardFile = path.join(hookData, "handoffs", `${createHash("sha256").update(guardSession).digest("hex")}.json`);
  const guardState = JSON.parse(fs.readFileSync(guardFile, "utf8"));
  fs.writeFileSync(guardFile, JSON.stringify({ ...guardState, stopContinuationIssued: true }), "utf8");
  const guarded = runHook({
    hook_event_name: "Stop",
    session_id: guardSession,
    turn_id: "codex_guard_turn_2"
  });
  const cancelSession = "codex_cancel_fixture";
  const cancelTracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: cancelSession,
    turn_id: "codex_cancel_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", status: "running" } }
  });
  const cancelHandled = runHook({
    hook_event_name: "PostToolUse",
    session_id: cancelSession,
    turn_id: "codex_cancel_turn",
    tool_name: "mcp__kimi_k3__cancel_k3_job",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", aborted: true } }
  });
  const cancelStop = runHook({
    hook_event_name: "Stop",
    session_id: cancelSession,
    turn_id: "codex_cancel_turn_2"
  });
  const providerFailureSession = "codex_provider_failure_fixture";
  const providerFailureTracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: providerFailureSession,
    turn_id: "codex_provider_failure_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_failed", status: "running" } }
  });
  const providerFailureHandoff = runHook({
    hook_event_name: "Stop",
    session_id: providerFailureSession,
    turn_id: "codex_provider_failure_turn"
  });
  const transcriptSession = "codex_transcript_fixture";
  const transcript = path.join(mcpFixtureHome, "codex-transcript.jsonl");
  const transcriptEvent = (server, tool, result, args = {}) => JSON.stringify({
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      invocation: { server, tool, arguments: args },
      result
    }
  });
  fs.writeFileSync(transcript, [
    "x".repeat(2 * 1024 * 1024 + 16),
    transcriptEvent("kimi-k3", "await_k3_result", { Ok: { structuredContent: { session_id: "session_old", status: "completed", complete: true } } }),
    transcriptEvent("kimi-k3", "start_k3_collaboration", { Ok: { structuredContent: { session_id: "session_portable_mcp", status: "running" } } }),
    transcriptEvent("other-server", "start_k3_collaboration", { Ok: { structuredContent: { session_id: "session_other", status: "running" } } })
  ].join("\n"), "utf8");
  const transcriptHandoff = runHook({
    hook_event_name: "Stop",
    session_id: transcriptSession,
    turn_id: "codex_transcript_turn",
    transcript_path: transcript
  });
  const transcriptFile = path.join(hookData, "handoffs", `${createHash("sha256").update(transcriptSession).digest("hex")}.json`);
  const transcriptState = JSON.parse(fs.readFileSync(transcriptFile, "utf8"));
  const retrySession = "codex_retry_fixture";
  const retryTracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: retrySession,
    turn_id: "codex_retry_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", status: "running" } }
  });
  const failedOnce = runHook({
    hook_event_name: "Stop",
    session_id: retrySession,
    turn_id: "codex_retry_turn_2"
  }, { KIMI_K3_HOOK_FAIL: "1" });
  const retryFile = path.join(hookData, "handoffs", `${createHash("sha256").update(retrySession).digest("hex")}.json`);
  const retryState = JSON.parse(fs.readFileSync(retryFile, "utf8"));
  const retried = runHook({
    hook_event_name: "Stop",
    session_id: retrySession,
    turn_id: "codex_retry_turn_3"
  });
  const persistentFailureSession = "codex_persistent_failure_fixture";
  const persistentFailureTracked = runHook({
    hook_event_name: "PostToolUse",
    session_id: persistentFailureSession,
    turn_id: "codex_persistent_failure_turn",
    tool_name: "mcp__kimi_k3__start_k3_collaboration",
    tool_response: { structuredContent: { session_id: "session_portable_mcp", status: "running" } }
  });
  const persistentFailureFirst = runHook({
    hook_event_name: "Stop",
    session_id: persistentFailureSession,
    turn_id: "codex_persistent_failure_turn_2"
  }, { KIMI_K3_HOOK_FAIL: "1" });
  const persistentFailureSecond = runHook({
    hook_event_name: "Stop",
    session_id: persistentFailureSession,
    turn_id: "codex_persistent_failure_turn_3"
  }, { KIMI_K3_HOOK_FAIL: "1" });
  const persistentFailureFile = path.join(hookData, "handoffs", `${createHash("sha256").update(persistentFailureSession).digest("hex")}.json`);
  const persistentFailureState = JSON.parse(fs.readFileSync(persistentFailureFile, "utf8"));
  const malformed = spawnSync(process.execPath, [handoffHook], {
    cwd: root,
    env: hookEnvironment,
    input: "not-json",
    encoding: "utf8",
    timeout: 5000
  });
  const nullPayload = spawnSync(process.execPath, [handoffHook], {
    cwd: root,
    env: hookEnvironment,
    input: "null",
    encoding: "utf8",
    timeout: 5000
  });
  if (
    tracked.status !== 0 ||
    handedOff.status !== 0 ||
    released.status !== 0 ||
    guardTracked.status !== 0 ||
    guarded.status !== 0 ||
    cancelTracked.status !== 0 ||
    cancelHandled.status !== 0 ||
    cancelStop.status !== 0 ||
    providerFailureTracked.status !== 0 ||
    providerFailureHandoff.status !== 0 ||
    transcriptHandoff.status !== 0 ||
    retryTracked.status !== 0 ||
    failedOnce.status !== 0 ||
    retried.status !== 0 ||
    persistentFailureTracked.status !== 0 ||
    persistentFailureFirst.status !== 0 ||
    persistentFailureSecond.status !== 0 ||
    malformed.status !== 0 ||
    nullPayload.status !== 0 ||
    JSON.parse(handedOff.stdout).decision !== "block" ||
    !JSON.parse(handedOff.stdout).reason.includes("# Stub K3 report") ||
    JSON.parse(released.stdout).continue !== true ||
    JSON.parse(guarded.stdout).continue !== true ||
    JSON.parse(cancelStop.stdout).continue !== true ||
    JSON.parse(providerFailureHandoff.stdout).decision !== "block" ||
    !JSON.parse(providerFailureHandoff.stdout).reason.includes("[provider.rate_limit] 429 overloaded") ||
    JSON.parse(providerFailureHandoff.stdout).reason.includes("# Stale report") ||
    JSON.parse(transcriptHandoff.stdout).decision !== "block" ||
    !JSON.parse(transcriptHandoff.stdout).reason.includes("# Stub K3 report") ||
    transcriptState.k3SessionId !== "session_portable_mcp" ||
    JSON.parse(failedOnce.stdout).decision !== "block" ||
    retryState.handoffFailures !== 1 ||
    retryState.stopContinuationIssued !== false ||
    JSON.parse(retried.stdout).decision !== "block" ||
    !JSON.parse(retried.stdout).reason.includes("# Stub K3 report") ||
    JSON.parse(persistentFailureFirst.stdout).decision !== "block" ||
    JSON.parse(persistentFailureSecond.stdout).continue !== true ||
    persistentFailureState.handoffFailures !== 2 ||
    persistentFailureState.stopContinuationIssued !== true ||
    Object.keys(JSON.parse(malformed.stdout)).length !== 0 ||
    Object.keys(JSON.parse(nullPayload.stdout)).length !== 0
  ) {
    throw new Error("The Stop hook did not deliver exactly once, break loops, or honor cancellation.");
  }
  const cancelledReceiveId = nextRequestId++;
  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: cancelledReceiveId,
    method: "tools/call",
    params: {
      name: "receive_k3_events",
      arguments: { session_id: "session_portable_mcp", after_cursor: relayCursor, wait_ms: 1000 }
    }
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: cancelledReceiveId, reason: "portable cancellation check" }
  })}\n`);
  const pingAfterCancellation = await request(nextRequestId++, "ping", {});
  if (!pingAfterCancellation.result || pingAfterCancellation.error) {
    throw new Error("Cancelling an app event receive blocked the MCP server.");
  }
  mcpChild.stdin.end();
  const exitCode = await Promise.race([
    new Promise((resolve) => mcpChild.once("exit", (code) => resolve(code))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The MCP server did not exit after stdin closed.")), 2000))
  ]);
  mcpExited = true;
  if (exitCode !== 0) throw new Error(`The MCP server exited with code ${exitCode} after stdin closed.`);

  const idleBaselineConnections = relayConnectionCount;
  fs.writeFileSync(
    instanceFile,
    JSON.stringify({
      host: "127.0.0.1",
      port: relayPort,
      pid: process.pid,
      host_version: "0.29.0",
      heartbeat_at: Date.now()
    }),
    "utf8"
  );
  const idleChild = spawn(process.execPath, [mcpServer], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      KIMI_K3_BRIDGE: stubBridge,
      KIMI_CODE_HOME: mcpFixtureHome,
      KIMI_K3_BROWSER_TEST: "1",
      KIMI_K3_RELAY_IDLE_MS: "1000"
    }
  });
  let idleExited = false;
  try {
    const idleRequest = createRequest(idleChild);
    const firstIdle = await idleRequest(1, "tools/call", {
      name: "receive_k3_events",
      arguments: { session_id: "session_idle_fixture", after_cursor: 0, wait_ms: 0 }
    });
    const firstGeneration = firstIdle.result?.structuredContent?.relay_generation;
    await waitFor(() => relayConnectionCount === idleBaselineConnections + 1, "the idle-fixture relay connection");
    // Polling receive_k3_events would refresh lastReceiveAt, so wait out the 1s idle window instead.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const secondIdle = await idleRequest(2, "tools/call", {
      name: "receive_k3_events",
      arguments: { session_id: "session_idle_fixture", after_cursor: 0, wait_ms: 0 }
    });
    const secondGeneration = secondIdle.result?.structuredContent?.relay_generation;
    await waitFor(() => relayConnectionCount === idleBaselineConnections + 2, "the recreated relay connection");
    if (!firstGeneration || !secondGeneration || firstGeneration === secondGeneration) {
      throw new Error("The idle K3 event relay was not torn down and recreated.");
    }
    idleChild.stdin.end();
    const idleExitCode = await Promise.race([
      new Promise((resolve) => idleChild.once("exit", (code) => resolve(code))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The idle-fixture MCP server did not exit after stdin closed.")), 2000))
    ]);
    idleExited = true;
    if (idleExitCode !== 0) throw new Error(`The idle-fixture MCP server exited with code ${idleExitCode}.`);
  } finally {
    if (!idleExited) idleChild.kill();
  }
} finally {
  if (!mcpExited) mcpChild.kill();
  for (const socket of relaySockets) socket.destroy();
  await new Promise((resolve) => relayServer.close(resolve));
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
if (cursorRecord.cursor?.seq !== 42 || cursorRecord.cursor?.epoch !== "epoch_portable" || cursorRecord.complete) {
  throw new Error("The bridge treated a turn checkpoint as full prompt completion.");
}
applyK3Event(cursorRecord, {
  type: "prompt.completed",
  seq: 43,
  epoch: "epoch_portable",
  payload: { reason: "completed" }
});
if (!cursorRecord.complete || cursorRecord.state !== "completed") {
  throw new Error("The durable prompt terminal state was not advanced.");
}
const providerFailureRecord = { state: "running", complete: false, cursor: null };
applyK3Event(providerFailureRecord, {
  type: "turn.step.retrying",
  seq: 44,
  epoch: "epoch_portable",
  payload: {
    errorName: "APIProviderRateLimitError",
    errorMessage: "429 overloaded",
    statusCode: 429
  }
});
if (providerFailureRecord.complete || providerFailureRecord.error) {
  throw new Error("A transient Kimi Provider retry was treated as terminal.");
}
const transientProviderRecord = { session_id: "session_transient_provider", state: "running", complete: false };
applyK3Event(transientProviderRecord, {
  type: "error",
  session_id: transientProviderRecord.session_id,
  seq: 45,
  epoch: "epoch_portable",
  payload: {
    code: "provider.overloaded",
    message: "temporary overload",
    fatal: false
  }
});
if (transientProviderRecord.complete || transientProviderRecord.error) {
  throw new Error("A non-terminal Kimi Provider error was treated as failed.");
}
applyK3Event(providerFailureRecord, {
  type: "turn.ended",
  seq: 46,
  epoch: "epoch_portable",
  payload: {
    reason: "failed",
    error: {
      code: "provider.rate_limit",
      message: "429 overloaded",
      name: "APIProviderRateLimitError",
      retryable: true
    }
  }
});
if (
  !providerFailureRecord.complete ||
  providerFailureRecord.state !== "failed" ||
  providerFailureRecord.error_code !== "provider.rate_limit" ||
  !providerFailureRecord.error?.includes("429 overloaded")
) {
  throw new Error("A terminal Kimi Provider error was not persisted as a failed handoff.");
}
const standaloneProviderFailure = {
  session_id: "session_standalone_provider_failure",
  state: "running",
  complete: false
};
applyK3Event(standaloneProviderFailure, {
  type: "error",
  session_id: standaloneProviderFailure.session_id,
  seq: 47,
  payload: {
    code: "provider.rate_limit",
    message: "429 overloaded",
    fatal: true
  }
});
if (
  !standaloneProviderFailure.complete ||
  standaloneProviderFailure.state !== "failed" ||
  standaloneProviderFailure.error_code !== "provider.rate_limit"
) {
  throw new Error("A standalone terminal Kimi Provider error was not persisted.");
}
const transportFailureRecord = { session_id: "session_transport_failure", state: "running", complete: false };
applyK3Event(transportFailureRecord, {
  type: "error",
  seq: 48,
  payload: { code: "provider.rate_limit", message: "transport-scoped", fatal: true }
});
if (transportFailureRecord.complete || transportFailureRecord.error) {
  throw new Error("A transport-scoped WebSocket error was misclassified as a job failure.");
}
if (
  eventMatchesCurrentPrompt({ prompt_id: "prompt_new" }, { payload: { promptId: "prompt_old" } }) ||
  !eventMatchesCurrentPrompt({ prompt_id: "prompt_new" }, { payload: { promptId: "prompt_new" } })
) {
  throw new Error("Late terminal events can be attributed to the wrong K3 prompt.");
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
  !skillContract.includes("await_k3_result") ||
  !skillContract.includes("Stop hook") ||
  !skillContract.includes("isolated worktree") ||
  !skillContract.includes("isolation=single-writer")
) {
  throw new Error("The direct MCP skill lacks parallel work or the K3-to-Codex handoff contract.");
}

const hooksManifest = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
const hookText = fs.readFileSync(handoffHook, "utf8");
if (
  hooksManifest.hooks?.Stop?.[0]?.hooks?.[0]?.timeout !== 600 ||
  !hooksManifest.hooks?.PostToolUse?.[0]?.matcher?.includes("await_k3_result") ||
  !hooksManifest.hooks?.PostToolUse?.[0]?.matcher?.includes("cancel_k3_job") ||
  !hooksManifest.hooks?.Stop?.[0]?.hooks?.[0]?.commandWindows ||
  !hookText.includes('decision: "block"') ||
  !hookText.includes("|| 540") ||
  !hookText.includes("authentic K3-to-Codex collaborator output")
) {
  throw new Error("The plugin-bundled K3-to-Codex Stop handoff is invalid.");
}

const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
const mcpManifest = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
const mcpConfig = mcpManifest.mcpServers?.["kimi-k3"];
if (
  pluginManifest.mcpServers !== "./.mcp.json" ||
  mcpConfig?.args?.[0] !== "./scripts/mcp-server.mjs" ||
  !Number.isInteger(mcpConfig.tool_timeout_sec) ||
  mcpConfig.tool_timeout_sec < 1 ||
  mcpConfig.tool_timeout_sec > 120 ||
  mcpConfig.supports_parallel_tool_calls !== true
) {
  throw new Error("The plugin MCP server or bounded tool timeout is not configured.");
}

const bridgeText = fs.readFileSync(bridge, "utf8");
const policyText = fs.readFileSync(policyModule, "utf8");
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
if (!mcpServerText.includes('lines.on("close", () => {') || !mcpServerText.includes('error?.code === "EPIPE"')) {
  throw new Error("The MCP stdio transport does not shut down cleanly after its client disconnects.");
}
if (
  mcpServerText.includes("collaborate_with_k3") ||
  mcpServerText.includes("start_k3_job") ||
  mcpServerText.includes("setInterval(") ||
  !mcpServerText.includes('const PANEL_MIME = "text/html;profile=mcp-app"') ||
  !mcpServerText.includes('"kimi-k3/panelUrl"') ||
  mcpServerText.includes('"kimi-k3/token"') ||
  mcpServerText.includes('"kimi-k3/origin"') ||
  !mcpServerText.includes('name: "receive_k3_events"') ||
  !mcpServerText.includes('name: "await_k3_result"') ||
  !mcpServerText.includes('name: "open_k3_in_browser"') ||
  !mcpServerText.includes("isolated Git commit handoff") ||
  !mcpServerText.includes('frame.type === "event.approval.requested"') ||
  !mcpServerText.includes('"reject-approval"') ||
  !mcpServerText.includes('visibility: ["app"]') ||
  !mcpServerText.includes("MAX_RELAY_BUFFER_BYTES") ||
  !mcpServerText.includes("MAX_EVENT_BATCH_BYTES") ||
  !mcpServerText.includes("relay_generation") ||
  !mcpServerText.includes("isReadOnlyTool") ||
  !mcpServerText.includes("terminalProviderFailure") ||
  !mcpServerText.includes("KIMI_K3_RELAY_IDLE_MS") ||
  !mcpServerText.includes("resynced") ||
  mcpServerText.includes("frameDomains") ||
  mcpServerText.includes("frame_domains")
) {
  throw new Error("The MCP server still contains the old polling/iframe path or lacks the private event panel contract.");
}
if (
  !policyText.includes('"TodoList"') ||
  !policyText.includes("terminalProviderFailure") ||
  policyText.includes('"WebSearch"') ||
  policyText.includes('"FetchURL"') ||
  !bridgeText.includes("Do not call Bash") ||
  !bridgeText.includes('isolation: "git-worktree"') ||
  !bridgeText.includes('isolation: "single-writer"') ||
  !bridgeText.includes('state: "scope_violation"')
) {
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
