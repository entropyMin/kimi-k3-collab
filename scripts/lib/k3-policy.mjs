export const READ_ONLY_TOOLS = Object.freeze([
  "Read", "ReadMediaFile", "Glob", "Grep", "TodoList",
  "Agent", "Skill", "TaskList", "TaskOutput", "GetGoal"
]);

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.includes(String(name || ""));
}
