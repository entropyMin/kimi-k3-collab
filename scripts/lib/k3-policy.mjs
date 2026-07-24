import fs from "node:fs";
import path from "node:path";

export const READ_ONLY_TOOLS = Object.freeze([
  "Read", "ReadMediaFile", "Glob", "Grep", "TodoList",
  "Agent", "Skill", "TaskList", "TaskOutput", "GetGoal"
]);

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Delete", "Move", "Rename"]);
const SHELL_TOOLS = new Set(["Bash", "Shell", "Terminal", "Command"]);
const SENSITIVE_PATHS = [
  /(^|\/)\.env(?:$|\.)/i,
  /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/i,
  /(^|\/)(?:credentials|service[-_.]?account)(?:\.[^/]+)?\.json$/i,
  /(^|\/)(?:\.npmrc|\.pypirc|\.netrc)$/i,
  /(^|\/)\.git\/(?:config|credentials)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.config\/gcloud\/application_default_credentials\.json$/i,
  /\.(?:pem|p12|pfx|key)$/i
];

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.includes(String(name || ""));
}

export function isSensitivePath(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.replace(/:.*$/, "").replace(/[ .]+$/, ""))
    .join("/");
  if (/(^|\/)\.env\.(?:example|sample|template)$/i.test(normalized)) return false;
  return SENSITIVE_PATHS.some((pattern) => pattern.test(normalized));
}

export function findSensitivePaths(root, maximum = 20) {
  const found = [];
  const pending = [path.resolve(root)];
  const skippedDirectories = new Set([".git", ".cache", ".next", ".venv", "build", "dist", "node_modules", "vendor"]);
  while (pending.length > 0 && found.length < maximum) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) pending.push(absolute);
      let flagged = (entry.isFile() || entry.isSymbolicLink()) && isSensitivePath(relative);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync.native(absolute);
        const targetRelative = path.relative(root, target);
        if (
          targetRelative.startsWith("..") ||
          path.isAbsolute(targetRelative) ||
          isSensitivePath(target)
        ) {
          flagged = true;
        }
      }
      if (flagged) found.push(relative);
      if (found.length >= maximum) break;
    }
  }
  return found;
}

function toolPaths(payload = {}) {
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const display = payload.display && typeof payload.display === "object" ? payload.display : {};
  return [...new Set([
    display.path,
    args.path,
    args.file_path,
    args.filePath,
    args.target,
    args.destination,
    args.output_path,
    args.outputPath
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function canonicalCandidate(root, candidate) {
  const missing = [];
  let current = path.resolve(root, candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(root, candidate);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

function withinAny(root, candidate, allowedPaths) {
  const resolved = canonicalCandidate(root, candidate);
  return allowedPaths.some((allowed) => {
    const relative = path.relative(canonicalCandidate(root, allowed), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

export function inspectToolSecurity(payload, {
  mode,
  cwd,
  allowedPaths = [],
  sensitivePathsAcknowledged = false,
  sandboxed = false
} = {}) {
  const name = String(payload?.name || "");
  const paths = toolPaths(payload);
  const root = cwd || process.cwd();
  if (!sensitivePathsAcknowledged) {
    const sensitive = paths.find((candidate) =>
      isSensitivePath(candidate) || isSensitivePath(canonicalCandidate(root, candidate))
    );
    if (sensitive) {
      return {
        action: "block",
        event: "sensitive_path_blocked",
        path: sensitive,
        message: `Blocked access to sensitive path without explicit user confirmation: ${sensitive}`
      };
    }
  }
  if (mode !== "execute") return null;
  const operation = String(payload?.display?.operation || "").toLowerCase();
  const structuredWrite = WRITE_TOOLS.has(name) || /write|edit|create|delete|move|rename/.test(operation);
  if (structuredWrite) {
    const outside = paths.find((candidate) => !withinAny(root, candidate, allowedPaths));
    if (outside) {
      return {
        action: "block",
        event: "external_write_blocked",
        path: outside,
        message: `Blocked a structured write outside allowed_paths: ${outside}`
      };
    }
  }
  if (SHELL_TOOLS.has(name) && !sandboxed) {
    return {
      action: "warn",
      event: "unsandboxed_shell_warning",
      path: null,
      message: "Shell execution cannot be path-confined by the plugin; use KIMI_K3_SERVER_WRAPPER for OS-level containment."
    };
  }
  return null;
}

export function appendSecurityAudit(jobRoot, sessionId, event) {
  const auditRoot = path.join(jobRoot, "audit");
  fs.mkdirSync(auditRoot, { recursive: true, mode: 0o700 });
  const file = path.join(auditRoot, `${sessionId}.jsonl`);
  if (event.event_id && fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (existing.includes(`"event_id":"${String(event.event_id).replaceAll('"', '\\"')}"`)) return file;
  }
  fs.appendFileSync(file, `${JSON.stringify({
    at: new Date().toISOString(),
    session_id: sessionId,
    ...event
  })}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}

// Shared by the bridge (kimi-k3.mjs) and the MCP relay (mcp-server.mjs): only a
// session-scoped provider.* error with fatal:true or a known terminal code ends a session.
const TERMINAL_PROVIDER_ERROR_CODES = Object.freeze(["provider.api_error", "provider.rate_limit"]);

export function terminalProviderFailure(event) {
  if (event?.type !== "error" || !event.session_id) return null;
  const payload = event.payload || {};
  const code = String(payload.code || payload.type || "").trim();
  if (!code.startsWith("provider.")) return null;
  return payload.fatal === true || TERMINAL_PROVIDER_ERROR_CODES.includes(code) ? payload : null;
}
