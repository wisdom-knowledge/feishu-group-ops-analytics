// 聊天前端：会话列表 + 流式消息 + 项目过滤 + 高级工具确认
(function () {
  const $ = (id) => document.getElementById(id);
  let inited = false;
  const state = {
    sessions: [],
    activeSessionId: null,
    projects: [],
    selectedProjectId: "",
    allowDestructive: false,
    sending: false,
    drafts: new Map(),
    streams: new Map(),
    viewToken: 0,
    loadToken: 0,
    chatStatus: null
  };
  const NEW_SESSION_DRAFT_KEY = "__new_session__";

  // ============ DOM 渲染 ============

  let pendingScroll = false;

  function scheduleScrollToBottom() {
    if (pendingScroll) return;
    pendingScroll = true;
    requestAnimationFrame(() => {
      pendingScroll = false;
      scrollToBottom();
    });
  }

  function renderSessions() {
    const list = $("chatSessionList");
    list.innerHTML = "";
    if (state.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color: var(--text-3); font-size: 12px; padding: 8px;";
      empty.textContent = "还没有会话";
      list.appendChild(empty);
      return;
    }
    for (const s of state.sessions) {
      const item = document.createElement("div");
      item.className = "chat-session-item" + (s.sessionId === state.activeSessionId ? " active" : "");
      item.dataset.id = s.sessionId;

      const title = document.createElement("div");
      title.className = "chat-session-title";
      title.textContent = s.summary || s.firstPrompt || s.title || "新会话";
      const ts = s.lastModified ? new Date(s.lastModified).toLocaleString() : "";
      title.title = `${s.sessionId}\n${ts}`;
      item.appendChild(title);

      const del = document.createElement("button");
      del.className = "chat-session-del";
      del.textContent = "删除";
      del.title = "删除会话";
      del.setAttribute("aria-label", "删除会话");
      del.onclick = (e) => {
        e.stopPropagation();
        if (!confirm("删除这个会话？")) return;
        deleteSession(s.sessionId);
      };
      item.appendChild(del);

      item.onclick = () => loadSession(s.sessionId);
      list.appendChild(item);
    }
  }

  function renderMessages(messages) {
    const box = $("chatMessages");
    box.innerHTML = "";
    if (!messages || messages.length === 0) {
      renderEmpty("直接问数据就行。", "例如：今天哪个群最忙？超能群最近在问什么？谁回复最慢？");
      return;
    }
    for (const m of messages) appendMessageDom(m);
    scrollToBottom();
  }

  function renderEmpty(title, detail = "") {
    const box = $("chatMessages");
    box.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    const detailHtml = detail ? `<br>${escapeHtml(detail)}` : "";
    empty.innerHTML = `${escapeHtml(title)}${detailHtml}<br><br><kbd>Enter</kbd> 发送，<kbd>Shift + Enter</kbd> 换行`;
    box.appendChild(empty);
  }

  function renderLoading(text) {
    const box = $("chatMessages");
    box.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = text;
    box.appendChild(empty);
  }

  function appendMessageDom(m) {
    const box = $("chatMessages");
    // 第一条时清空 empty 提示
    const empty = box.querySelector(".chat-empty");
    if (empty) empty.remove();

    const wrap = document.createElement("div");
    wrap.className = "chat-msg " + (m.cssRole || m.role);
    if (m.id) wrap.dataset.id = m.id;

    const role = document.createElement("div");
    role.className = "chat-msg-role";
    role.textContent = m.label || m.role;
    wrap.appendChild(role);

    const content = document.createElement("div");
    content.className = "chat-msg-content";
    if ((m.cssRole || m.role) === "assistant") {
      content.innerHTML = renderMarkdown(m.text || "");
    } else {
      content.textContent = m.text || "";
    }
    wrap.appendChild(content);

    box.appendChild(wrap);
    return content;
  }

  function startTypewriter(ctx) {
    if (ctx.typeTimer) return;
    const step = () => {
      if (!ctx.pendingText) {
        ctx.typeTimer = null;
        finalizeStreamIfReady(ctx);
        return;
      }
      if (!isStreamCurrent(ctx)) {
        ctx.typeTimer = null;
        return;
      }
      const chunkSize = ctx.pendingText.length > 1000 ? 9 : ctx.pendingText.length > 320 ? 6 : 3;
      const chunk = ctx.pendingText.slice(0, chunkSize);
      ctx.pendingText = ctx.pendingText.slice(chunk.length);
      ctx.displayText += chunk;
      ctx.content.textContent = ctx.displayText;
      scheduleScrollToBottom();
      ctx.typeTimer = requestAnimationFrame(step);
    };
    ctx.typeTimer = requestAnimationFrame(step);
  }

  function finalizeStreamIfReady(ctx) {
    if (!ctx?.donePayload || ctx.finalized || ctx.pendingText || ctx.typeTimer || !isStreamCurrent(ctx)) return;
    const payload = ctx.donePayload;
    ctx.finalized = true;
    ctx.wrap.classList.remove("is-streaming");
    if (ctx.rawText.trim()) ctx.content.innerHTML = renderMarkdown(ctx.rawText);
    // 没有任何文本时显示个占位
    if (!ctx.content.textContent.trim() || ctx.content.classList.contains("is-thinking")) {
      ctx.content.classList.remove("is-thinking");
      ctx.content.textContent = payload.ok === false ? "这次没有拿到有效结果。" : "处理完成。";
      ctx.content.style.color = "var(--muted)";
    }
    if (payload.usage || payload.cost != null) {
      const meta = document.createElement("div");
      meta.className = "chat-msg-meta";
      const inT = payload.usage?.input_tokens || 0;
      const outT = payload.usage?.output_tokens || 0;
      meta.textContent = `用量 in=${inT} out=${outT}，费用 $${(payload.cost || 0).toFixed(4)}`;
      ctx.wrap.appendChild(meta);
    }
    if (!payload.ok && payload.error && !ctx.errorShown) {
      ctx.errorShown = true;
      appendMessageDom({ role: "error", cssRole: "error", label: "ERROR", text: payload.error });
    }
    scheduleScrollToBottom();
  }

  function scrollToBottom() {
    const box = $("chatMessages");
    box.scrollTop = box.scrollHeight;
  }

  // ============ API ============

  async function fetchProjects() {
    const res = await fetch("/api/projects");
    const json = await res.json();
    if (json.ok) {
      state.projects = json.projects || [];
      const sel = $("chatProjectSelect");
      sel.innerHTML = `<option value="">（全部项目）</option>`;
      for (const p of state.projects) {
        const opt = document.createElement("option");
        opt.value = p.projectId;
        opt.textContent = p.projectName;
        sel.appendChild(opt);
      }
    }
  }

  async function fetchChatStatus() {
    try {
      const res = await fetch("/api/chat/status", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) return;
      state.chatStatus = json;
      const label = [json.model, json.provider].filter(Boolean).join(" · ");
      const el = $("chatModelStatus");
      if (el) el.textContent = label ? `问数模型：${label}` : "问数模型：未配置";
    } catch {
      const el = $("chatModelStatus");
      if (el) el.textContent = "问数模型：读取失败";
    }
  }

  async function fetchSessions(options = {}) {
    const autoLoad = options.autoLoad !== false;
    try {
      const res = await fetch("/api/chat/sessions");
      const json = await res.json();
      if (json.ok) {
        state.sessions = (json.sessions || []).sort((a, b) => {
          return (b.lastModified || 0) - (a.lastModified || 0);
        });
        if (autoLoad && !state.activeSessionId && state.sessions.length) {
          await loadSession(state.sessions[0].sessionId);
          return;
        }
        renderSessions();
      }
    } catch (e) {
      console.error("fetchSessions failed", e);
    }
  }

  async function loadSession(sessionId) {
    saveCurrentDraft();
    const stream = state.streams.get(sessionKey(sessionId));
    if (state.activeSessionId === sessionId && stream && !stream.finalized) {
      attachStream(stream);
      renderSessions();
      return;
    }
    const token = ++state.loadToken;
    state.viewToken += 1;
    state.activeSessionId = sessionId;
    restoreDraft(sessionId);
    renderSessions();
    if (stream) {
      attachStream(stream);
      return;
    }
    renderLoading("正在读取这个会话…");
    try {
      const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "加载失败");
      if (token !== state.loadToken || state.activeSessionId !== sessionId) return;
      const display = (json.messages || [])
        .map(sdkMessageToDisplay)
        .filter(Boolean);
      if (display.length) renderMessages(display);
      else renderEmpty("这个会话暂无可展示消息。", "工具调用细节已收起，等有用户问题或助手文本后会显示在这里。");
    } catch (e) {
      if (token !== state.loadToken || state.activeSessionId !== sessionId) return;
      renderMessages([{ role: "error", cssRole: "error", label: "ERROR", text: e.message }]);
    }
  }

  // 把 SDK 历史消息转成展示格式
  // 历史会话回放：只渲染纯文本，跳过 tool_use 和 tool_result（避免技术细节糊脸）
  function textFromSdkContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block?.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n\n");
  }

  function sdkMessageToDisplay(msg) {
    if (msg.type === "user") {
      const content = msg.message?.content;
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return null;
      const text = textFromSdkContent(content);
      return text ? { role: "user", label: "你", text } : null;
    }
    if (msg.type === "assistant") {
      const content = msg.message?.content || [];
      // 只取文本 block，跳过 tool_use
      const text = textFromSdkContent(content);
      return text ? { role: "assistant", label: "助手", text } : null;
    }
    return null;
  }

  async function deleteSession(sessionId) {
    try {
      await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      state.drafts.delete(sessionId);
      state.streams.delete(sessionKey(sessionId));
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = null;
        state.viewToken += 1;
        state.loadToken += 1;
        restoreDraft(null);
        renderMessages([]);
      }
      await fetchSessions();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  }

  function newSession() {
    saveCurrentDraft();
    state.activeSessionId = null;
    state.viewToken += 1;
    state.loadToken += 1;
    state.drafts.set(NEW_SESSION_DRAFT_KEY, "");
    restoreDraft(null);
    renderSessions();
    const stream = state.streams.get(NEW_SESSION_DRAFT_KEY);
    if (stream && !stream.finalized) attachStream(stream);
    else renderMessages([]);
    $("chatInput").focus();
  }

  function sessionKey(sessionId = state.activeSessionId) {
    return sessionId || NEW_SESSION_DRAFT_KEY;
  }

  function draftKey(sessionId = state.activeSessionId) {
    return sessionKey(sessionId);
  }

  function saveCurrentDraft() {
    const input = $("chatInput");
    if (!input) return;
    state.drafts.set(draftKey(), input.value);
  }

  function restoreDraft(sessionId = state.activeSessionId) {
    const input = $("chatInput");
    if (!input) return;
    input.value = state.drafts.get(draftKey(sessionId)) || "";
  }

  function attachStream(ctx) {
    const box = $("chatMessages");
    box.innerHTML = "";
    if (ctx.userMessage) appendMessageDom(ctx.userMessage);
    box.appendChild(ctx.wrap);
    if (ctx.pendingText && !ctx.typeTimer) {
      if (ctx.content.classList.contains("is-thinking")) {
        ctx.content.classList.remove("is-thinking");
        ctx.content.textContent = ctx.displayText || "";
      }
      startTypewriter(ctx);
    }
    finalizeStreamIfReady(ctx);
    scrollToBottom();
  }

  // ============ SSE 流式收消息 ============

  async function sendMessage() {
    if (state.sending) return;
    const input = $("chatInput");
    const prompt = input.value.trim();
    if (!prompt) return;
    const requestSessionId = state.activeSessionId;
    const requestKey = sessionKey(requestSessionId);
    const requestViewToken = state.viewToken;

    state.sending = true;
    $("chatSend").disabled = true;
    $("chatSend").textContent = "发送中";

    // 显示用户消息
    const userMessage = { role: "user", cssRole: "user", label: "你", text: prompt };
    appendMessageDom(userMessage);
    input.value = "";
    state.drafts.set(draftKey(requestSessionId), "");
    scrollToBottom();

    // AI 气泡（含 tool chips 区 + 文本区），用 ref 让 SSE handler 能切换 bubble
    const ctx = createAssistantBubble();
    ctx.requestSessionId = requestSessionId;
    ctx.sessionKey = requestKey;
    ctx.userMessage = userMessage;
    ctx.viewToken = requestViewToken;
    ctx.resolvedSessionId = requestSessionId;
    state.streams.set(requestKey, ctx);
    scheduleScrollToBottom();

    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          sessionId: requestSessionId,
          projectId: state.selectedProjectId || undefined,
          allowDestructive: state.allowDestructive
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // 解析 SSE
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 切割事件
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseEvent(block, ctx);
        }
      }
    } catch (e) {
      if (isStreamCurrent(ctx)) appendMessageDom({ role: "error", cssRole: "error", label: "ERROR", text: e.message });
    } finally {
      state.sending = false;
      $("chatSend").disabled = false;
      $("chatSend").textContent = "发送";
      // 刷新会话列表（可能创建了新会话）
      await fetchSessions({ autoLoad: false });
      if (isStreamCurrent(ctx)) scrollToBottom();
    }
  }

  // 建一条 AI 气泡，结构：
  //   .chat-msg.assistant
  //     .chat-msg-role "AI"
  //     .chat-msg-body
  //       .tool-chips   ← 工具调用 chip 列表
  //       .chat-msg-content  ← 文本
  // chipById：按 tool_use_id 索引 chip，支持并行工具调用回填
  function createAssistantBubble() {
    const box = $("chatMessages");
    const empty = box.querySelector(".chat-empty");
    if (empty) empty.remove();
    const wrap = document.createElement("div");
    wrap.className = "chat-msg assistant is-streaming";
    const role = document.createElement("div");
    role.className = "chat-msg-role";
    role.textContent = "助手";
    wrap.appendChild(role);
    const body = document.createElement("div");
    body.className = "chat-msg-body";
    const chips = document.createElement("div");
    chips.className = "tool-chips";
    const content = document.createElement("div");
    content.className = "chat-msg-content";
    content.classList.add("is-thinking");
    content.textContent = "正在整理数据…";
    body.appendChild(chips);
    body.appendChild(content);
    wrap.appendChild(body);
    box.appendChild(wrap);
    return {
      wrap,
      chips,
      content,
      rawText: "",
      displayText: "",
      pendingText: "",
      typeTimer: null,
      donePayload: null,
      finalized: false,
      errorShown: false,
      chipById: new Map()
    };
  }

  function isStreamCurrent(ctx) {
    return ctx && ctx.sessionKey === sessionKey(state.activeSessionId);
  }

  function moveStreamContext(ctx, nextSessionId) {
    if (!ctx || !nextSessionId) return;
    const oldKey = ctx.sessionKey || sessionKey(ctx.requestSessionId);
    const nextKey = sessionKey(nextSessionId);
    if (oldKey !== nextKey) state.streams.delete(oldKey);
    ctx.sessionKey = nextKey;
    state.streams.set(nextKey, ctx);
  }

  function toolDisplayName(name) {
    return (
      {
        list_projects: "读取项目",
        read_messages: "读取消息",
        search_messages: "搜索消息",
        read_message_context: "读取上下文",
        get_dashboard: "读取看板",
        get_ai_insights: "读取复核",
        sync_messages: "同步消息",
        rebuild_dashboard: "重建看板",
        run_ai_analyze: "批量复核"
      }[String(name || "").replace(/^mcp__feishu-group-analysis__/, "")] || "处理数据"
    );
  }

  function summarizeToolResult(text) {
    const value = String(text || "").trim();
    if (!value) return "已完成";
    try {
      const parsed = JSON.parse(value);
      if (parsed?.error) return `失败：${parsed.error}`;
      if (parsed?.project?.projectName) return `${parsed.project.projectName}，${parsed.count ?? 0} 条`;
      if (parsed?.source && parsed?.count != null) return `${parsed.source === "bytehouse" ? "ByteHouse" : "本地"}，${parsed.count} 条`;
      if (Array.isArray(parsed?.projects)) return `${parsed.projects.length} 个项目`;
      if (parsed?.metrics?.messageCount != null) return `${parsed.metrics.messageCount} 条消息`;
      if (parsed?.ok === false) return "执行失败";
    } catch {
      // 文本结果按普通摘要处理
    }
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }

  // 工具调用只显示一句人能理解的状态，不把 raw JSON 糊到界面上
  function appendToolChip(ctx, payload) {
    const chip = document.createElement("div");
    chip.className = "tool-chip";
    const head = document.createElement("div");
    head.className = "tool-chip-head";
    head.innerHTML = `<span class="tool-chip-dot"></span><span class="tool-chip-name">${escapeHtml(toolDisplayName(payload.name))}</span><span class="tool-chip-status">进行中</span>`;
    chip.appendChild(head);
    ctx.chips.appendChild(chip);
    return chip;
  }

  function fillToolChipResult(chip, text) {
    if (!chip) return;
    const status = chip.querySelector(".tool-chip-status");
    if (status) status.textContent = summarizeToolResult(text);
    chip.classList.add("done");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderInlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function splitMarkdownTableRow(line) {
    const trimmed = String(line || "").trim();
    const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
    return body.split("|").map((cell) => cell.trim());
  }

  function isMarkdownTableDivider(line) {
    const cells = splitMarkdownTableRow(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isMarkdownTableStart(lines, index) {
    const current = lines[index] || "";
    const next = lines[index + 1] || "";
    return current.includes("|") && next.includes("|") && isMarkdownTableDivider(next);
  }

  function renderMarkdownTable(lines, startIndex) {
    const header = splitMarkdownTableRow(lines[startIndex]);
    const rows = [];
    let index = startIndex + 2;
    while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
      const cells = splitMarkdownTableRow(lines[index]);
      rows.push(cells);
      index += 1;
    }
    const colCount = Math.max(header.length, ...rows.map((row) => row.length), 0);
    const normalizedHeader = Array.from({ length: colCount }, (_, i) => header[i] || "");
    const normalizedRows = rows.map((row) => Array.from({ length: colCount }, (_, i) => row[i] || ""));
    const html = `<div class="chat-table-wrap"><table class="chat-md-table"><thead><tr>${normalizedHeader
      .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
      .join("")}</tr></thead><tbody>${normalizedRows
      .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
    return { html, nextIndex: index };
  }

  function renderMarkdown(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let listType = "";
    const closeList = () => {
      if (!listType) return;
      html.push(`</${listType}>`);
      listType = "";
    };
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        closeList();
        continue;
      }
      if (isMarkdownTableStart(lines, index)) {
        closeList();
        const table = renderMarkdownTable(lines, index);
        html.push(table.html);
        index = table.nextIndex - 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        if (listType !== "ul") {
          closeList();
          html.push("<ul>");
          listType = "ul";
        }
        html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        if (listType !== "ol") {
          closeList();
          html.push("<ol>");
          listType = "ol";
        }
        html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
        continue;
      }
      const quote = line.match(/^>\s+(.+)$/);
      if (quote) {
        closeList();
        html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }
      closeList();
      html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }
    closeList();
    return html.join("");
  }

  function handleSseEvent(block, ctx) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    if (event === "session" && payload.sessionId) {
      ctx.resolvedSessionId = payload.sessionId;
      const wasCurrent = isStreamCurrent(ctx);
      moveStreamContext(ctx, payload.sessionId);
      if (wasCurrent) state.activeSessionId = payload.sessionId;
      if (isStreamCurrent(ctx)) {
        if (ctx.requestSessionId !== payload.sessionId) {
          const oldKey = draftKey(ctx.requestSessionId);
          const nextKey = draftKey(payload.sessionId);
          state.drafts.set(nextKey, state.drafts.get(oldKey) || "");
          if (oldKey === NEW_SESSION_DRAFT_KEY) state.drafts.set(NEW_SESSION_DRAFT_KEY, "");
        }
        renderSessions();
      }
    } else if (event === "text") {
      ctx.rawText += payload.delta || "";
      ctx.pendingText += payload.delta || "";
      if (!isStreamCurrent(ctx)) return;
      if (ctx.content.classList.contains("is-thinking")) {
        ctx.content.classList.remove("is-thinking");
        ctx.content.textContent = "";
      }
      startTypewriter(ctx);
    } else if (event === "start") {
      if (!isStreamCurrent(ctx)) return;
      ctx.content.textContent = "正在整理数据…";
    } else if (event === "tool_use") {
      if (!isStreamCurrent(ctx)) return;
      const chip = appendToolChip(ctx, payload);
      if (payload.id) ctx.chipById.set(payload.id, chip);
      scheduleScrollToBottom();
    } else if (event === "tool_result") {
      if (!isStreamCurrent(ctx)) return;
      const chip = ctx.chipById.get(payload.tool_use_id);
      fillToolChipResult(chip, payload.text || "");
      if (chip) ctx.chipById.delete(payload.tool_use_id);
      scheduleScrollToBottom();
    } else if (event === "done") {
      if (payload.sessionId) {
        ctx.resolvedSessionId = payload.sessionId;
        const wasCurrent = isStreamCurrent(ctx);
        moveStreamContext(ctx, payload.sessionId);
        if (wasCurrent) state.activeSessionId = payload.sessionId;
      }
      ctx.donePayload = payload;
      if (!isStreamCurrent(ctx)) return;
      if (ctx.pendingText && !ctx.typeTimer) startTypewriter(ctx);
      finalizeStreamIfReady(ctx);
    } else if (event === "error") {
      ctx.donePayload = { ok: false, error: payload.message };
      if (!isStreamCurrent(ctx)) return;
      ctx.errorShown = true;
      appendMessageDom({ role: "error", cssRole: "error", label: "ERROR", text: payload.message });
    }
  }

  // ============ 初始化（lazy：第一次切到 chat tab 才初始化） ============

  function initIfNeeded() {
    if (inited) return;
    inited = true;

    fetchProjects();
    fetchChatStatus();
    renderMessages([]);
    fetchSessions();

    $("chatNewBtn").onclick = newSession;
    $("chatSend").onclick = sendMessage;
    $("chatInput").addEventListener("input", saveCurrentDraft);
    $("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    $("chatProjectSelect").addEventListener("change", (e) => {
      state.selectedProjectId = e.target.value;
    });
    $("chatAllowDestructive").addEventListener("change", (e) => {
      state.allowDestructive = e.target.checked;
    });
  }

  // 监听 tab 切换：切到 chat 时初始化
  document.addEventListener("DOMContentLoaded", () => {
    const chatTab = document.querySelector('.tab[data-tab="chat"]');
    if (chatTab) {
      chatTab.addEventListener("click", () => initIfNeeded());
      // 如果默认就是 chat tab（一般不会，但兼容下）
      if (chatTab.classList.contains("active")) initIfNeeded();
    }
  });
})();
