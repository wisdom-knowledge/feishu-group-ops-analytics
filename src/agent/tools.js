// Agent 工具集：用 createSdkMcpServer + tool 暴露给 Claude Agent SDK
// 所有工具走 in-process MCP，不需要外部进程
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { listProjectsRaw, findProject } from "./projects.js";
// 同名重导出，让其他模块能从 tools.js 拿到（保持原 API 入口）
export { listProjectsRaw, findProject };

// ==================== 数据访问层（薄抽象，未来 FaaS 时只换这层） ====================

const ROOT = process.cwd();
const DATA_DIR = path.resolve(ROOT, process.env.ARCHIVE_DIR || "./data");

function loadEnv(filePath = path.resolve(ROOT, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv();

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonlSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

function readAllMessages() {
  return readJsonlSafe(path.resolve(DATA_DIR, "messages.jsonl"));
}

function sqlQuote(value) {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requireIdent(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new Error(`非法数据库标识符：${raw || "(empty)"}`);
  return raw;
}

function isByteHouseProvider() {
  const provider = (process.env.STORAGE_PROVIDER || process.env.DB_PROVIDER || "").trim().toLowerCase();
  return provider === "bytehouse" || (!provider && Boolean(process.env.BYTEHOUSE_HOST || process.env.BYTEHOUSE_URL));
}

function byteHouseConfig() {
  const url = (process.env.BYTEHOUSE_URL || "").replace(/\/+$/, "");
  const host = (process.env.BYTEHOUSE_HOST || "").trim();
  const protocol = process.env.BYTEHOUSE_PROTOCOL || "https";
  const port = process.env.BYTEHOUSE_PORT || "8123";
  const user = process.env.BYTEHOUSE_USER || "bytehouse";
  const password = process.env.BYTEHOUSE_PASSWORD || process.env.BYTEHOUSE_API_KEY || "";
  const database = process.env.BYTEHOUSE_DATABASE || "";
  const virtualWarehouse = process.env.BYTEHOUSE_VIRTUAL_WAREHOUSE || process.env.BYTEHOUSE_VW || "";
  const tablePrefix = requireIdent(process.env.BYTEHOUSE_TABLE_PREFIX, "feishu_group_analysis");
  const missing = [];
  if (!url && !host) missing.push("BYTEHOUSE_HOST 或 BYTEHOUSE_URL");
  if (!password) missing.push("BYTEHOUSE_PASSWORD 或 BYTEHOUSE_API_KEY");
  if (!database) missing.push("BYTEHOUSE_DATABASE");
  return {
    ok: missing.length === 0,
    missing,
    url: url || `${protocol}://${host}:${port}`,
    user,
    password,
    database,
    virtualWarehouse,
    tablePrefix,
    tables: { messages: `${tablePrefix}_messages` }
  };
}

function byteHouseUrl(config) {
  const url = new URL(config.url);
  url.searchParams.set("database", config.database);
  if (config.virtualWarehouse) url.searchParams.set("virtual_warehouse", config.virtualWarehouse);
  return url;
}

function byteHouseTable(name) {
  const config = byteHouseConfig();
  return `${requireIdent(config.database)}.${requireIdent(name)}`;
}

async function byteHouseQueryRows(sql) {
  const config = byteHouseConfig();
  if (!config.ok) throw new Error(`ByteHouse 未配置完整：缺少 ${config.missing.join(", ")}`);
  const response = await fetch(byteHouseUrl(config), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
      "Content-Type": "text/plain; charset=utf-8"
    },
    body: `${sql}\nFORMAT JSON`
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ByteHouse 查询失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text).data || [] : [];
}

function compactMessageForAgent(message) {
  return {
    messageId: message.messageId || message.message_id || "",
    time: message.createTime || "",
    projectName: message.projectName || "",
    groupName: message.groupName || "",
    chatId: message.chatId || message.chat_id || "",
    senderId: message.sender?.id || message.senderId || "",
    senderName: message.senderName || message.sender?.name || "",
    type: message.msgType || "",
    isReply: Boolean(message.parentId || message.rootId || message.replyToMessageId),
    text: String(message.text || message.content?.text || "").slice(0, 900)
  };
}

function compactDbMessage(row, names = new Map()) {
  return compactMessageForAgent({
    messageId: row.message_id || "",
    createTime: row.create_time || "",
    projectName: row.project_name || "",
    groupName: row.group_name || "",
    chatId: row.chat_id || "",
    senderId: row.sender_id || "",
    senderName: row.sender_name || names.get(row.sender_id) || "",
    msgType: row.msg_type || "",
    parentId: row.reply_to_message_id || row.thread_root_message_id || "",
    text: row.text || ""
  });
}

function timeFilterMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function queryMessagesFromByteHouse({ projectId, chatId, senderId, messageId, since, until, keyword, limit = 100 } = {}) {
  if (!isByteHouseProvider()) return null;
  const config = byteHouseConfig();
  if (!config.ok) return null;
  const where = [];
  if (projectId) where.push(`project_id=${sqlQuote(projectId)}`);
  if (chatId) where.push(`chat_id=${sqlQuote(chatId)}`);
  if (senderId) where.push(`sender_id=${sqlQuote(senderId)}`);
  if (messageId) where.push(`message_id=${sqlQuote(messageId)}`);
  const sinceMs = timeFilterMs(since);
  const untilMs = timeFilterMs(until);
  if (sinceMs) where.push(`create_time_ms>=${sinceMs}`);
  if (untilMs) where.push(`create_time_ms<=${untilMs}`);
  if (keyword) where.push(`positionCaseInsensitive(text, ${sqlQuote(keyword)}) > 0`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await byteHouseQueryRows(
    `SELECT
      message_id,
      chat_id,
      project_id,
      project_name,
      group_name,
      create_time,
      create_time_ms,
      sender_id,
      msg_type,
      reply_to_message_id,
      thread_root_message_id,
      text
    FROM ${byteHouseTable(config.tables.messages)}
    ${whereSql}
    ORDER BY create_time_ms DESC, message_id DESC
    LIMIT ${Math.max(1, Math.min(500, Number(limit || 100)))}`
  );
  const names = peopleNameById();
  return rows.map((row) => compactDbMessage(row, names));
}

function filterMessagesFromFiles({ projectId, chatId, senderId, messageId, since, until, keyword, limit = 100 } = {}) {
  const all = readAllMessages();
  const sinceMs = timeFilterMs(since);
  const untilMs = timeFilterMs(until);
  const kw = keyword ? String(keyword).toLowerCase() : "";
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = all[i];
    if (projectId && message.projectId !== projectId) continue;
    if (chatId && message.chatId !== chatId) continue;
    if (senderId && message.sender?.id !== senderId && message.senderId !== senderId) continue;
    if (messageId && message.messageId !== messageId) continue;
    const ts = Number(message.createTimeMs || Date.parse(message.createTime || ""));
    if ((sinceMs || untilMs) && !Number.isFinite(ts)) continue;
    if (sinceMs && ts < sinceMs) continue;
    if (untilMs && ts > untilMs) continue;
    if (kw && !String(message.text || message.content?.text || "").toLowerCase().includes(kw)) continue;
    out.push(compactMessageForAgent(message));
  }
  return out;
}

async function readCurrentProjectStats() {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (config.ok) {
      const table = byteHouseTable(config.tables.messages);
      const projectRows = await byteHouseQueryRows(
        `SELECT
          project_id AS projectId,
          any(project_name) AS projectName,
          count(DISTINCT message_key) AS messageCount,
          max(create_time) AS lastTime
        FROM ${table}
        GROUP BY project_id`
      );
      const chatRows = await byteHouseQueryRows(
        `SELECT
          project_id AS projectId,
          chat_id AS chatId,
          any(group_name) AS groupName,
          count(DISTINCT message_key) AS messageCount,
          max(create_time) AS lastTime
        FROM ${table}
        GROUP BY project_id, chat_id`
      );
      return {
        source: "bytehouse",
        projects: Object.fromEntries(projectRows.map((row) => [row.projectId || "", row])),
        chats: Object.fromEntries(chatRows.map((row) => [row.chatId || "", row]))
      };
    }
  }
  const projectStats = {};
  const chatStats = {};
  for (const message of readAllMessages()) {
    const projectId = message.projectId || "";
    const chatId = message.chatId || "";
    const project = projectStats[projectId] || { projectId, projectName: message.projectName || projectId, messageCount: 0, lastTime: "" };
    project.messageCount += 1;
    if (!project.lastTime || message.createTime > project.lastTime) project.lastTime = message.createTime || "";
    projectStats[projectId] = project;
    const chat = chatStats[chatId] || { projectId, chatId, groupName: message.groupName || chatId, messageCount: 0, lastTime: "" };
    chat.messageCount += 1;
    if (!chat.lastTime || message.createTime > chat.lastTime) chat.lastTime = message.createTime || "";
    chatStats[chatId] = chat;
  }
  return { source: "file", projects: projectStats, chats: chatStats };
}

function mergeCurrentProjectStats(projects, stats = {}) {
  return (projects || []).map((project) => {
    const projectStat = stats.projects?.[project.projectId] || {};
    return {
      ...project,
      projectName: project.projectName || projectStat.projectName || project.projectId,
      messageCount: Number(projectStat.messageCount || 0),
      lastTime: projectStat.lastTime || "",
      chats: (project.chats || []).map((chat) => {
        const chatStat = stats.chats?.[chat.chatId] || {};
        return {
          ...chat,
          groupName: chat.chatName || chat.groupName || chatStat.groupName || "",
          messageCount: Number(chatStat.messageCount || 0),
          lastTime: chatStat.lastTime || ""
        };
      })
    };
  });
}

export async function searchMessagesForAgent(filters = {}) {
  try {
    const rows = await queryMessagesFromByteHouse(filters);
    if (rows) return { source: "bytehouse", count: rows.length, messages: rows };
  } catch (error) {
    const rows = filterMessagesFromFiles(filters);
    return { source: "file", warning: `ByteHouse 查询失败，已回退本地文件：${error.message}`, count: rows.length, messages: rows };
  }
  const rows = filterMessagesFromFiles(filters);
  return { source: "file", count: rows.length, messages: rows };
}

export async function readMessageContextForAgent({ messageId, before = 20, after = 20 } = {}) {
  if (!messageId) return { error: "缺少 messageId" };
  const targetResult = await searchMessagesForAgent({ messageId, limit: 1 });
  const target = targetResult.messages?.[0];
  if (!target) return { source: targetResult.source, error: "没有找到这条消息" };
  const targetMs = Date.parse(target.time || "");
  const since = Number.isFinite(targetMs) ? new Date(targetMs - 24 * 60 * 60 * 1000).toISOString() : undefined;
  const until = Number.isFinite(targetMs) ? new Date(targetMs + 24 * 60 * 60 * 1000).toISOString() : undefined;
  const contextResult = await searchMessagesForAgent({ chatId: target.chatId, since, until, limit: Math.max(80, before + after + 1) });
  const asc = [...(contextResult.messages || [])].sort((a, b) => Date.parse(a.time || "") - Date.parse(b.time || ""));
  const index = asc.findIndex((message) => message.messageId === messageId);
  const messages = index >= 0 ? asc.slice(Math.max(0, index - before), Math.min(asc.length, index + after + 1)) : asc;
  return { source: contextResult.source, target, count: messages.length, messages };
}

// 用 chatId 集合过滤消息
export async function readProjectMessages(projectId, { since, until, limit = 100, keyword } = {}) {
  const project = findProject(projectId);
  if (!project) return { error: `项目 ${projectId} 不存在` };
  const result = await searchMessagesForAgent({ projectId, since, until, keyword, limit });
  return { project: { projectId: project.projectId, projectName: project.projectName }, ...result };
}

function readDashboard() {
  return readJsonSafe(path.resolve(DATA_DIR, "dashboard", "dashboard.json"), null);
}

function readAiInsights() {
  return readJsonSafe(path.resolve(DATA_DIR, "dashboard", "ai-insights.json"), null);
}

function peopleNameById() {
  const dash = readDashboard();
  const rows = dash?.periods?.all?.metrics?.staff || [];
  return new Map(rows.map((row) => [row.id, row.name]).filter(([id, name]) => id && name));
}

function compactMetricsForAgent(metrics = {}) {
  return {
    messageCount: metrics.messageCount,
    firstTime: metrics.firstTime,
    lastTime: metrics.lastTime,
    activeDayCount: metrics.activeDayCount,
    uniqueSenderCount: metrics.uniqueSenderCount,
    internalSenderCount: metrics.internalSenderCount,
    questionCandidateCount: metrics.questionCandidateCount,
    replyCount: metrics.replyCount,
    avgReplySeconds: metrics.avgReplySeconds,
    p90ReplySeconds: metrics.p90ReplySeconds,
    byDate: (metrics.byDate || []).slice(-14),
    byHour: metrics.byHour || {},
    byProject: metrics.byProject || [],
    byChat: metrics.byChat || [],
    messageTypeRows: metrics.messageTypeRows || [],
    topTerms: (metrics.topTerms || []).slice(0, 20),
    staff: (metrics.staff || []).slice(0, 20).map((row) => ({
      name: row.name,
      role: row.role,
      isInternal: row.isInternal,
      messageCount: row.messageCount,
      replyCount: row.replyCount,
      activeDays: row.activeDays
    })),
    candidates: (metrics.analysisCandidates || []).slice(-30).map((item) => ({
      issueId: item.issueId,
      time: item.questionTime,
      projectName: item.projectName,
      groupName: item.groupName,
      askerName: item.askerName,
      text: item.text,
      replyConfidence: item.replyConfidence,
      firstReplyTime: item.firstReplyTime,
      ruleDraft: item.ruleDraft
        ? {
            categoryName: item.ruleDraft.categoryName,
            priority: item.ruleDraft.priority
          }
        : null
    }))
  };
}

function compactDashboardForAgent(dash, projectId = "", currentStats = null) {
  if (!dash) return null;
  const project = projectId ? (dash.projects || []).find((p) => p.projectId === projectId) : null;
  const currentProjects = currentStats ? mergeCurrentProjectStats(dash.projects || [], currentStats) : null;
  const currentProject = projectId && currentProjects ? currentProjects.find((p) => p.projectId === projectId) : null;
  return {
    generatedAt: dash.generatedAt,
    storage: dash.storageStatus
      ? {
          ok: dash.storageStatus.ok,
          provider: dash.storageStatus.provider,
          messageCount: dash.storageStatus.messageCount,
          firstMessageTime: dash.storageStatus.firstMessageTime,
          lastMessageTime: dash.storageStatus.lastMessageTime
        }
      : null,
    projectStatsSource: currentStats?.source || "dashboard_snapshot",
    projects: (currentProjects || dash.projects || []).map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      messageCount: p.messageCount ?? p.periods?.all?.metrics?.messageCount ?? p.metrics?.messageCount ?? 0,
      candidateCount: p.periods?.all?.metrics?.questionCandidateCount || p.metrics?.questionCandidateCount || 0
    })),
    metrics: compactMetricsForAgent(project ? project.periods?.all?.metrics || project.metrics : dash.periods?.all?.metrics),
    selectedProject: project
      ? {
          projectId: project.projectId,
          projectName: project.projectName,
          chats: currentProject?.chats || project.chats
        }
      : null
  };
}

// 跑 npm 脚本（一次性任务），返回 stdout/stderr/exitCode
// 注意：extraArgs 必须是常量，不要拼接用户输入（防注入）
const SCRIPT_TIMEOUT_MS = Number(process.env.AGENT_SCRIPT_TIMEOUT_MS) || 5 * 60 * 1000;
function runScript(script, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script, "--silent", "--", ...extraArgs], {
      cwd: ROOT,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // 5 秒后还没退就 SIGKILL 兜底
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, SCRIPT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.slice(-4000), // 只截后 4KB，避免上下文爆炸
        stderr: timedOut
          ? `[超时 ${SCRIPT_TIMEOUT_MS}ms 被强杀] ${stderr.slice(-2000)}`
          : stderr.slice(-2000),
        ok: code === 0 && !timedOut
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message, ok: false });
    });
  });
}

// 把任意结果包成 MCP tool 的 content 格式
function asResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
  };
}

// 把"调 npm 脚本 → 包装结果"的样板抽出来
function makeScriptTool(name, description, script, extraArgs = []) {
  return tool(name, description, {}, async () => {
    const r = await runScript(script, extraArgs);
    return asResult({
      ok: r.ok,
      exitCode: r.exitCode,
      tail: r.stdout,
      error: r.ok ? undefined : r.stderr
    });
  });
}

// ==================== 工具定义 ====================

export const MCP_SERVER_NAME = "feishu-group-analysis";

export function createAgentMcpServer() {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "list_projects",
        "列出所有飞书群项目（projectId, projectName, 包含的群列表）。先调这个了解可用项目。",
        {},
        async () => asResult(mergeCurrentProjectStats(listProjectsRaw(), await readCurrentProjectStats()))
      ),

      tool(
        "read_messages",
        "从 ByteHouse 读取某项目最近的原始群消息。支持时间过滤、关键词过滤、条数限制。用户问某项目消息、最近问题、今日问题时优先用它拉真实消息，而不是只看 dashboard 摘要。limit 默认 100，最大 500。",
        {
          projectId: z.string().describe("项目 ID（来自 list_projects）"),
          limit: z.number().int().min(1).max(500).optional().describe("返回的消息条数，默认 100"),
          since: z.string().optional().describe("起始时间，ISO 8601 字符串，如 2026-05-11T00:00:00+08:00"),
          until: z.string().optional().describe("结束时间，ISO 8601 字符串"),
          keyword: z.string().optional().describe("按关键词过滤消息文本（不区分大小写）")
        },
        async (args) => {
          const result = await readProjectMessages(args.projectId, {
            limit: args.limit,
            since: args.since,
            until: args.until,
            keyword: args.keyword
          });
          return asResult(result);
        }
      ),

      tool(
        "search_messages",
        "从 ByteHouse 全局搜索原始消息，可按项目、群、发送人、关键词、时间窗口过滤。适合回答：某个人最近说了什么、某关键词在哪里出现、今天有哪些重要问题、哪个群在讨论某事。",
        {
          projectId: z.string().optional().describe("可选项目 ID；不传则全项目搜索"),
          chatId: z.string().optional().describe("可选群 chat_id"),
          senderId: z.string().optional().describe("可选发送人 open_id/user_id"),
          keyword: z.string().optional().describe("关键词，按消息正文不区分大小写搜索"),
          since: z.string().optional().describe("起始时间，ISO 8601 字符串"),
          until: z.string().optional().describe("结束时间，ISO 8601 字符串"),
          limit: z.number().int().min(1).max(500).optional().describe("返回条数，默认 100，最大 500")
        },
        async (args) => asResult(await searchMessagesForAgent(args))
      ),

      tool(
        "read_message_context",
        "读取某条消息在原群里的前后文。适合用户要求溯源、看上下文、解释某条消息为什么被判为问题。",
        {
          messageId: z.string().describe("消息 ID"),
          before: z.number().int().min(1).max(80).optional().describe("前文条数，默认 20"),
          after: z.number().int().min(1).max(80).optional().describe("后文条数，默认 20")
        },
        async (args) => asResult(await readMessageContextForAgent(args))
      ),

      tool(
        "get_dashboard",
        "读取 dashboard.json：覆盖整个数据集的统计指标（消息数、活跃用户、热门话题、按项目细分等）。",
        {
          projectId: z.string().optional().describe("可选：只返回该项目相关的部分；不传返回全部")
        },
        async (args) => {
          const dash = readDashboard();
          if (!dash) return asResult({ error: "dashboard 不存在，可能需要先调 rebuild_dashboard" });
          let currentStats = null;
          try {
            currentStats = await readCurrentProjectStats();
          } catch {
            currentStats = null;
          }
          return asResult(compactDashboardForAgent(dash, args.projectId, currentStats));
        }
      ),

      tool(
        "get_ai_insights",
        "读取上一次批量 AI 分析的结果（commonQuestions, staffingPlan, projectRhythmImpacts, risks, nextActions 等）。",
        {},
        async () => {
          const ins = readAiInsights();
          if (!ins) return asResult({ error: "ai-insights.json 不存在，需要先调 run_ai_analyze" });
          return asResult(ins);
        }
      ),

      makeScriptTool(
        "sync_messages",
        "调用飞书 API 增量同步最新群消息（约几十秒，会消耗飞书 API 配额）。仅在用户明确要求刷新/同步/拉最新时使用；完成后建议再调 rebuild_dashboard 更新统计。",
        "sync"
      ),

      makeScriptTool(
        "rebuild_dashboard",
        "重建 dashboard 统计（基于当前已归档的消息，不拉取新消息）。",
        "dashboard"
      ),

      makeScriptTool(
        "run_ai_analyze",
        "运行批量 AI 分析（生成 ai-insights.json）。【会消耗 token、有费用】调用前应该让用户确认。",
        "ai:analyze",
        ["--run"]
      )
    ]
  });
}

// 工具名集合（外部用来构造 allowedTools）
export const AGENT_TOOL_NAMES = [
  "mcp__feishu-group-analysis__list_projects",
  "mcp__feishu-group-analysis__read_messages",
  "mcp__feishu-group-analysis__search_messages",
  "mcp__feishu-group-analysis__read_message_context",
  "mcp__feishu-group-analysis__get_dashboard",
  "mcp__feishu-group-analysis__get_ai_insights",
  "mcp__feishu-group-analysis__sync_messages",
  "mcp__feishu-group-analysis__rebuild_dashboard",
  "mcp__feishu-group-analysis__run_ai_analyze"
];

// 高成本/会重算的工具：需要二次确认
export const DESTRUCTIVE_TOOL_NAMES = new Set([
  "mcp__feishu-group-analysis__run_ai_analyze",
  "mcp__feishu-group-analysis__rebuild_dashboard"
]);
