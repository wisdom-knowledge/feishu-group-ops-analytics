// 聊天后端：处理 /api/chat/* 路由，把请求转给 Claude Agent SDK
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  query,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAgentMcpServer,
  AGENT_TOOL_NAMES,
  DESTRUCTIVE_TOOL_NAMES,
  MCP_SERVER_NAME,
  searchMessagesForAgent,
  readProjectMessages
} from "./tools.js";

// MCP server 模块级单例：tool 都是无状态的，没必要每条消息重建
const mcpServer = createAgentMcpServer();

// SDK 把会话写到 CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/，我们设了 ./data/chats
function getModel() {
  return process.env.AGENT_MODEL || "anthropic/claude-sonnet-4.6";
}

function directChatPath() {
  return path.resolve(process.cwd(), process.env.ARCHIVE_DIR || "./data", "chats", "direct-sessions.json");
}

function readDirectStore() {
  try {
    return JSON.parse(fs.readFileSync(directChatPath(), "utf8")) || { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

function writeDirectStore(store) {
  fs.mkdirSync(path.dirname(directChatPath()), { recursive: true });
  fs.writeFileSync(directChatPath(), JSON.stringify(store, null, 2));
}

function sdkTextMessage(role, text) {
  return {
    type: role,
    message: { role, content: [{ type: "text", text: String(text || "") }] },
    parent_tool_use_id: null,
    createdAt: new Date().toISOString()
  };
}

function sessionSummary(prompt) {
  return String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 32) || "新会话";
}

function directSessionsList() {
  return (readDirectStore().sessions || []).map(({ messages, ...session }) => session);
}

function directMessages(sessionId) {
  const session = (readDirectStore().sessions || []).find((item) => item.sessionId === sessionId);
  return session?.messages || [];
}

function hasDirectSession(sessionId) {
  return (readDirectStore().sessions || []).some((item) => item.sessionId === sessionId);
}

function deleteDirectSession(sessionId) {
  const store = readDirectStore();
  store.sessions = (store.sessions || []).filter((item) => item.sessionId !== sessionId);
  writeDirectStore(store);
}

function renameDirectSession(sessionId, title) {
  const store = readDirectStore();
  const session = (store.sessions || []).find((item) => item.sessionId === sessionId);
  if (session) {
    session.summary = String(title || session.summary || "").trim() || session.summary;
    session.lastModified = Date.now();
    writeDirectStore(store);
  }
}

function upsertDirectSession({ sessionId, prompt, answer }) {
  const store = readDirectStore();
  const now = Date.now();
  let session = (store.sessions || []).find((item) => item.sessionId === sessionId);
  if (!session) {
    session = {
      sessionId,
      summary: sessionSummary(prompt),
      firstPrompt: prompt,
      createdAt: now,
      lastModified: now,
      messages: []
    };
    store.sessions = [session, ...(store.sessions || [])];
  }
  session.messages.push(sdkTextMessage("user", prompt));
  session.messages.push(sdkTextMessage("assistant", answer));
  session.lastModified = now;
  session.summary = session.summary || sessionSummary(prompt);
  writeDirectStore(store);
  return session;
}

function openRouterApiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
}

function messagesUrl() {
  const base = (process.env.ANTHROPIC_BASE_URL || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api").replace(/\/+$/, "");
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function chatProviderLabel() {
  const url = messagesUrl();
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function promptKeywords(prompt) {
  const stop = new Set(["当前项目", "项目名称", "这个", "那个", "今天", "本周", "最近", "情况", "怎么样", "有什么", "为什么", "哪些", "一下"]);
  return [...String(prompt || "").matchAll(/[\p{Script=Han}A-Za-z0-9._-]{2,}/gu)]
    .map((match) => match[0])
    .filter((word) => !stop.has(word))
    .slice(0, 5);
}

function isNoContextPrompt(prompt) {
  return /^(不要调用工具，只回复|只回复|ping|测试连接|smoke)/i.test(String(prompt || "").trim());
}

function isProjectCatalogPrompt(prompt) {
  const text = String(prompt || "");
  return (
    /项目/.test(text) &&
    /(列出|有哪些|当前|所有|名称)/.test(text) &&
    !/(消息|问题|风险|活跃|人员|发送人|复核|失败|原因|今天|本周|最近)/.test(text)
  );
}

function isHistoryOnlyPrompt(prompt) {
  const text = String(prompt || "");
  return /(上面|刚才|上一轮|前面)/.test(text) && !/(重新查|最新|消息|今天|本周|最近|数据库|刷新|同步)/.test(text);
}

function compactContextMessage(message) {
  return {
    time: message.time || "",
    projectName: message.projectName || "",
    groupName: message.groupName || "",
    senderName: message.senderName || "",
    senderId: message.senderId || "",
    type: message.type || "",
    isReply: Boolean(message.isReply),
    text: String(message.text || "").slice(0, 360)
  };
}

async function contextForPrompt(prompt, projectId, projectsSnapshot) {
  const scopedProjects = projectId ? projectsSnapshot.filter((p) => p.projectId === projectId) : projectsSnapshot;
  if (isNoContextPrompt(prompt) || isProjectCatalogPrompt(prompt) || isHistoryOnlyPrompt(prompt)) {
    return {
      projects: scopedProjects.map((project) => ({
        projectId: project.projectId,
        projectName: project.projectName,
        chats: (project.chats || []).map((chat) => ({
          chatName: chat.chatName || chat.groupName || "",
          external: Boolean(chat.external)
        }))
      })),
      messages: []
    };
  }
  const keywordRows = [];
  for (const keyword of promptKeywords(prompt)) {
    const result = await searchMessagesForAgent({ projectId: projectId || undefined, keyword, limit: 30 });
    keywordRows.push(...(result.messages || []));
  }
  const recent = projectId
    ? await readProjectMessages(projectId, { limit: 80 })
    : await searchMessagesForAgent({ limit: 80 });
  const byId = new Map();
  for (const row of [...keywordRows, ...(recent.messages || [])]) {
    if (row.messageId && !byId.has(row.messageId)) byId.set(row.messageId, row);
  }
  const messages = [...byId.values()]
    .sort((a, b) => Date.parse(b.time || "") - Date.parse(a.time || ""))
    .slice(0, 120)
    .map(compactContextMessage);
  return {
    projects: scopedProjects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      chats: (project.chats || []).map((chat) => ({
        chatId: chat.chatId,
        chatName: chat.chatName || chat.groupName || "",
        external: Boolean(chat.external)
      }))
    })),
    messages
  };
}

async function callDirectModel({ prompt, sessionId, projectId, projectsSnapshot, send }) {
  const key = openRouterApiKey();
  if (!key) throw new Error("缺少 OPENROUTER_API_KEY / ANTHROPIC_AUTH_TOKEN");
  const resolvedSessionId = sessionId || randomUUID();
  send("session", { sessionId: resolvedSessionId });
  const store = readDirectStore();
  const previous = (store.sessions || []).find((item) => item.sessionId === resolvedSessionId)?.messages || [];
  const context = await contextForPrompt(prompt, projectId, projectsSnapshot);
  const historyText = previous
    .slice(-8)
    .map((message) => `${message.type === "user" ? "用户" : "助手"}：${message.message?.content?.[0]?.text || ""}`)
    .join("\n");
  const system = [
    "你是飞书群运营分析助手。只基于给定项目、消息上下文和历史会话回答。",
    "必须区分事实、推断和证据不足。人员分析时，被 @ 不等于他出错；要区分直接责任、负责模块待确认、协助清洗或善后、上游数据问题、证据不足。",
    "回答要直接、干净，引用证据时写时间、群名、发送者和原文要点。不要输出 raw JSON、messageId、chatId。",
    "如果上下文不足，明确说还需要更窄的项目、人员或时间范围。"
  ].join("\n");
  const userContent = [
    historyText ? `【最近会话】\n${historyText}` : "",
    `【项目】\n${JSON.stringify(context.projects, null, 2)}`,
    `【可用消息样本，最多 120 条】\n${JSON.stringify(context.messages, null, 2)}`,
    `【用户问题】\n${prompt}`
  ]
    .filter(Boolean)
    .join("\n\n");
  const started = Date.now();
  const response = await fetch(messagesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "HTTP-Referer": "http://127.0.0.1:4198",
      "X-Title": "Feishu Group Analysis"
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: Number(process.env.AGENT_MAX_TOKENS || 2200),
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: userContent }]
    })
  });
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `模型请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const answer = (body.content || []).map((block) => block.text || "").join("").trim();
  if (!answer) throw new Error("模型没有返回文本");
  for (let i = 0; i < answer.length; i += 24) {
    send("text", { delta: answer.slice(i, i + 24) });
  }
  upsertDirectSession({ sessionId: resolvedSessionId, prompt, answer });
  send("done", {
    ok: true,
    sessionId: resolvedSessionId,
    usage: {
      input_tokens: body.usage?.input_tokens || 0,
      output_tokens: body.usage?.output_tokens || 0
    },
    cost: body.usage?.cost || body.usage?.cost_usd || 0,
    latencyMs: Date.now() - started
  });
}

function buildSystemPrompt(projectsSnapshot) {
  return [
    "你是一个飞书群分析助手。用户通过你查询、分析他们归档的飞书群消息数据。",
    "",
    "**核心原则：直接回答，不要解说过程。**",
    "",
    "✅ 应该这样：",
    "  用户：列出所有项目",
    "  你：当前共有 4 个项目：1) ai机器人测试 2) agent 研判救火审核群 3) Agent 研判正式群 4) Hippo3.0专家群",
    "",
    "❌ 不要这样：",
    "  用户：列出所有项目",
    "  你：好的，我来调用 list_projects 工具查一下…[贴一大段 raw JSON]…根据查询结果，共有 4 个项目…",
    "",
    "工作原则：",
    "1. 工具是你私有的获取数据手段。**绝对不要**把工具返回的 raw JSON、字段名、技术细节复述给用户。",
    "2. 不要在回答里说\"我调用了 xxx 工具\"\"根据查询结果\"\"让我查一下\"这类废话。直接给答案。",
    "3. 用户没指定项目时，看上下文：能根据上一轮推断就推断，否则一句话简短问\"是 X 还是 Y？\"——不要列 raw 数据让用户选。",
    "4. 优先读取已入库数据：先用 get_dashboard / list_projects / read_messages / search_messages / read_message_context 自己查。用户问\"今天重要问题\"、\"最近谁最活跃\"、\"某群有哪些风险\"时，不要要求用户手动同步。",
    "5. 只有用户明确说\"刷新\"、\"同步\"、\"拉最新\"、\"重新入库\"时，才调用 sync_messages；同步完成后再 rebuild_dashboard。",
    "6. 用户问项目消息/问题时，先 list_projects 定位项目，再 read_messages 拉 100-300 条真实消息；用户问全局或某个人/关键词时，用 search_messages。",
    "7. 用户问某条消息为什么、上下文、能否溯源时，用 read_message_context。",
    "8. 做人员分析时必须区分：本人发出的进展、别人 @ 他提问、别人催他、他被要求协助处理、他负责的模块问题、上游/脏数据导致的善后。被 @ 不等于他出错；被催不等于他是根因。",
    "9. 任何负面判断都必须写清归因等级：直接责任 / 负责模块待确认 / 协助清洗或善后 / 上游数据问题 / 证据不足。没有明确证据时不能说“他的问题”“他出错”“未解决”。",
    "10. 如果证据显示“源头是脏数据”“上游数据有问题”“清洗结果依赖工具表”等，要写成他在处理上游问题或被拉来善后，不要把努力处理问题的人写成责任人。",
    "11. 回答业务问题要给：一句结论、关键证据、归因判断、建议动作。不要只给 TopN 数字；不要堆一屏项目符号。",
    "12. 人员周报推荐格式：总体判断 / 本人产出 / 被 @ 与协作请求 / 风险与归因 / 建议跟进。每条证据都带时间、群、发送者。",
    "13. run_ai_analyze 会消耗 token，调用前先在回复里告知费用并等用户确认。",
    "14. 引用具体消息时给出消息时间、发送者和群名，必要时简述原文；不要列 messageId/chatId 这种技术字段。",
    "15. 如果用户问你底层是什么，如实说：问数助手由本服务接 Claude Agent SDK，模型来自 AGENT_MODEL 配置；不是 Codex 本体在页面里聊天。",
    "16. 不确定就说不确定，别编。中文回复，简洁明了。",
    "",
    "当前可用项目快照（你内部参考，不要复述给用户）：",
    JSON.stringify(projectsSnapshot, null, 2)
  ].join("\n");
}

// 把"调 SDK + 写 JSON"的八股抽出来
async function jsonHandler(res, build) {
  try {
    const body = await build();
    writeJson(res, 200, { ok: true, ...body });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error.message });
  }
}

const sessionDirOpts = () => ({ dir: process.cwd() });

export const handleListSessions = (req, res) =>
  jsonHandler(res, async () => {
    const direct = directSessionsList();
    let sdk = [];
    try {
      const raw = await listSessions(sessionDirOpts());
      sdk = Array.isArray(raw) ? raw : raw?.sessions || [];
    } catch {
      sdk = [];
    }
    const seen = new Set(direct.map((session) => session.sessionId));
    return { sessions: [...direct, ...sdk.filter((session) => !seen.has(session.sessionId))] };
  });

export const handleGetSessionMessages = (req, res, sessionId) =>
  jsonHandler(res, async () => {
    if (hasDirectSession(sessionId)) {
      return { sessionId, messages: directMessages(sessionId) };
    }
    return { sessionId, messages: await getSessionMessages(sessionId, sessionDirOpts()) };
  });

export const handleDeleteSession = (req, res, sessionId) =>
  jsonHandler(res, async () => {
    if (hasDirectSession(sessionId)) {
      deleteDirectSession(sessionId);
    } else {
      await deleteSession(sessionId, sessionDirOpts());
    }
    return {};
  });

export const handleRenameSession = (req, res, sessionId) =>
  jsonHandler(res, async () => {
    const payload = await readJsonBody(req);
    if (hasDirectSession(sessionId)) {
      renameDirectSession(sessionId, payload.title);
    } else {
      await renameSession(sessionId, payload.title, sessionDirOpts());
    }
    return {};
  });

export const handleChatStatus = (req, res) =>
  jsonHandler(res, async () => ({
    model: getModel(),
    provider: chatProviderLabel()
  }));

// 发送消息：SSE 流式返回
// payload: { prompt, sessionId?, projectId?, allowDestructive? }
export async function handleSendMessage(req, res, projectsSnapshot) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const { prompt, sessionId, projectId, allowDestructive } = payload || {};
  if (!prompt || typeof prompt !== "string") {
    writeJson(res, 400, { ok: false, error: "缺少 prompt 字段" });
    return;
  }

  // SSE 头
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 让用户在前端看到“正在思考……”后即刻开始
  send("start", { sessionId: sessionId || null, model: getModel() });

  // 项目过滤的 system 增强
  let scopedSnapshot = projectsSnapshot;
  if (projectId) {
    const matched = projectsSnapshot.find((p) => p.projectId === projectId);
    if (matched) scopedSnapshot = [matched];
  }

  // 直连 OpenRouter Messages API：避免 Claude Agent SDK 在当前环境只返回 session、不吐正文。
  // 不绑定 req close abort，用户切换会话时后端仍会完成并持久化结果。
  try {
    await callDirectModel({ prompt, sessionId, projectId, projectsSnapshot: scopedSnapshot, send });
  } catch (error) {
    send("error", { message: error.message });
    send("done", { ok: false, sessionId: sessionId || null, error: error.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
  return;

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  let sentResult = false;

  try {
    // 读库/同步默认放行；重建和批量 AI 复核仍需用户显式确认。
    const safeTools = AGENT_TOOL_NAMES.filter((n) => !DESTRUCTIVE_TOOL_NAMES.has(n));
    const allowed = allowDestructive ? AGENT_TOOL_NAMES : safeTools;

    const q = query({
      prompt,
      options: {
        model: getModel(),
        systemPrompt: buildSystemPrompt(scopedSnapshot),
        // tools 字段是给内置工具用的（Bash/Read 等），MCP 工具靠 mcpServers + allowedTools 暴露
        allowedTools: allowed,
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        resume: sessionId || undefined,
        abortController,
        includePartialMessages: true,
        // 兜底：未在 allowedTools 中的工具调用走这里
        canUseTool: async (toolName /*, input, opts */) => {
          if (!DESTRUCTIVE_TOOL_NAMES.has(toolName) || allowDestructive) {
            return { behavior: "allow", updatedInput: undefined };
          }
          return {
            behavior: "deny",
            message: `工具 ${toolName} 是耗资源操作（重建统计/批量 AI 分析），需要用户确认。请在前端勾选"允许高级工具"后重发同一条消息。`
          };
        }
      }
    });

    let resolvedSessionId = sessionId || null;
    const streamedTextMessageIds = new Set();
    let streamedTextSinceAssistant = false;

    for await (const msg of q) {
      if (abortController.signal.aborted) break;

      if (msg.type === "system" && msg.subtype === "init") {
        resolvedSessionId = msg.session_id || resolvedSessionId;
        send("session", { sessionId: resolvedSessionId });
      } else if (msg.type === "stream_event") {
        const event = msg.event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          if (msg.uuid) streamedTextMessageIds.add(msg.uuid);
          streamedTextSinceAssistant = true;
          send("text", { delta: event.delta.text });
        } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
          send("thinking", {});
        }
      } else if (msg.type === "assistant" && msg.message?.content) {
        const alreadyStreamedText = msg.uuid ? streamedTextMessageIds.has(msg.uuid) : false;
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text && !alreadyStreamedText && !streamedTextSinceAssistant) {
            send("text", { delta: block.text });
          } else if (block.type === "tool_use") {
            send("tool_use", {
              id: block.id,
              name: block.name,
              input: block.input
            });
          } else if (block.type === "thinking") {
            // 思考片段不必展示完整内容，告知前端在思考即可
            send("thinking", {});
          }
        }
        streamedTextSinceAssistant = false;
      } else if (msg.type === "user" && msg.message?.content) {
        // 工具结果 (来自 SDK 内部回填的 user 消息)
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c) => c.text || "").join("")
              : String(block.content || "");
            send("tool_result", {
              tool_use_id: block.tool_use_id,
              text: text.slice(0, 2000) // 截断展示
            });
          }
        }
      } else if (msg.type === "result") {
        sentResult = true;
        send("done", {
          ok: !msg.is_error,
          sessionId: resolvedSessionId,
          error: msg.is_error ? msg.result || "Unknown error" : undefined,
          usage: msg.usage,
          cost: msg.total_cost_usd
        });
      }
    }
  } catch (error) {
    if (!sentResult) send("error", { message: error.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ==================== 工具函数 ====================

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// 主入口：判断 url 路由后调对应处理函数。projectsSnapshot 由调用方传入（避免重复读 groups.json）
export async function routeChatRequest(req, res, url, projectsSnapshot) {
  // POST /api/chat/messages  发消息（SSE）
  if (req.method === "POST" && url.pathname === "/api/chat/messages") {
    await handleSendMessage(req, res, projectsSnapshot);
    return true;
  }
  // GET /api/chat/sessions   列出会话
  if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
    await handleListSessions(req, res);
    return true;
  }
  // GET /api/chat/status   问数助手模型状态
  if (req.method === "GET" && url.pathname === "/api/chat/status") {
    await handleChatStatus(req, res);
    return true;
  }
  // GET /api/chat/sessions/:id   读会话消息
  const getMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    await handleGetSessionMessages(req, res, getMatch[1]);
    return true;
  }
  // DELETE /api/chat/sessions/:id   删会话
  if (req.method === "DELETE" && getMatch) {
    await handleDeleteSession(req, res, getMatch[1]);
    return true;
  }
  // POST /api/chat/sessions/:id/rename
  const renameMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/rename$/);
  if (req.method === "POST" && renameMatch) {
    await handleRenameSession(req, res, renameMatch[1]);
    return true;
  }
  return false;
}
