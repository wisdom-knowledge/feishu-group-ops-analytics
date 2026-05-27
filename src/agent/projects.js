// 共享：把 groups.json 按 projectId 聚合
// 主进程 serve() 与 agent/tools.js 都从这里 import，避免重复实现
// 单独成文件是为了让主进程 import 时不触发 @anthropic-ai/claude-agent-sdk 初始化（在 tools.js 里）
import fs from "node:fs";
import path from "node:path";

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadGroupsConfig() {
  return readJsonSafe(path.resolve(process.cwd(), process.env.GROUPS_CONFIG || "./groups.json"), {});
}

export function listProjectsRaw() {
  const groups = loadGroupsConfig();
  const byProject = new Map();
  for (const [chatId, group] of Object.entries(groups)) {
    if (group?.enabled === false) continue;
    const projectId = group.projectId || chatId;
    if (!byProject.has(projectId)) {
      byProject.set(projectId, {
        projectId,
        projectName: group.projectName || projectId,
        chats: []
      });
    }
    byProject.get(projectId).chats.push({
      chatId,
      chatName: group.chatName || group.groupName || "",
      enabled: group.enabled !== false,
      external: !!group.external
    });
  }
  return [...byProject.values()];
}

export function findProject(projectId) {
  return listProjectsRaw().find((p) => p.projectId === projectId);
}
