export const READ_ONLY_TOOLS = Object.freeze([
  "Read", "ReadMediaFile", "Glob", "Grep", "TodoList",
  "Agent", "Skill", "TaskList", "TaskOutput", "GetGoal"
]);

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.includes(String(name || ""));
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
