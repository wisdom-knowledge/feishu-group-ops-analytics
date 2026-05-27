#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { listProjectsRaw as listProjectsRawShared } from "./agent/projects.js";

const API_BASE = "https://open.feishu.cn/open-apis";
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const INTERNAL_ROLES = new Set(["internal", "operator", "reviewer", "pm", "bot"]);

loadEnv();

function loadEnv(filePath = path.resolve(".env")) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  console.log(`用法：
  node src/group-analysis.js sync --date 2026-05-07
  node src/group-analysis.js sync --chat-id oc_xxx --lookback-hours 24
  node src/group-analysis.js backfill --chat-id oc_xxx --days 30
  node src/group-analysis.js groups-discover --write
  node src/group-analysis.js report --date 2026-05-07 --write
  node src/group-analysis.js db-import
  node src/group-analysis.js db-status
  STORAGE_PROVIDER=bytehouse BYTEHOUSE_HOST=xxx BYTEHOUSE_PASSWORD=xxx BYTEHOUSE_DATABASE=xxx node src/group-analysis.js db-import
  node src/group-analysis.js dashboard --write
  node src/group-analysis.js ai-analyze --run --write
  node src/group-analysis.js users-resolve --write
  node src/group-analysis.js people-sync
  node src/group-analysis.js serve --port 4198
  node src/group-analysis.js cron-install
  node src/group-analysis.js cron-run
	`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseJsonValue(value, fallback) {
  try {
    if (value === undefined || value === null || value === "") return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeTextAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tempPath = path.resolve(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function appendJsonl(filePath, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function sqlitePath(dir) {
  return path.resolve(dir, "group-analysis.sqlite");
}

function sqlQuote(value) {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

const sqliteQuote = sqlQuote;

function storageProvider() {
  const configured = (process.env.STORAGE_PROVIDER || process.env.DB_PROVIDER || "").trim().toLowerCase();
  if (configured) return configured;
  if (process.env.BYTEHOUSE_HOST || process.env.BYTEHOUSE_URL) return "bytehouse";
  return "sqlite";
}

function isByteHouseProvider() {
  return storageProvider() === "bytehouse";
}

function requireIdent(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new Error(`非法数据库标识符：${raw || "(empty)"}`);
  return raw;
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
    tables: {
      messages: `${tablePrefix}_messages`,
      syncRuns: `${tablePrefix}_sync_runs`,
      syncChatRuns: `${tablePrefix}_sync_chat_runs`,
      people: `${tablePrefix}_people`
    }
  };
}

function byteHouseUrl(config) {
  const url = new URL(config.url);
  url.searchParams.set("database", config.database);
  if (config.virtualWarehouse) url.searchParams.set("virtual_warehouse", config.virtualWarehouse);
  return url;
}

async function byteHouseExec(sql, { expectJson = false } = {}) {
  const config = byteHouseConfig();
  if (!config.ok) throw new Error(`ByteHouse 未配置完整：缺少 ${config.missing.join(", ")}`);
  const headers = {
    Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
    "Content-Type": "text/plain; charset=utf-8"
  };
  const timeoutMs = Number(process.env.BYTEHOUSE_QUERY_TIMEOUT_MS || 60_000);
  let response;
  try {
    response = await fetch(byteHouseUrl(config), {
      method: "POST",
      headers,
      body: sql,
      signal: timeoutMs > 0 && typeof AbortSignal !== "undefined" ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error(`ByteHouse 查询超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ByteHouse 执行失败：HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  if (!expectJson) return text;
  return text.trim() ? JSON.parse(text) : { data: [] };
}

async function byteHouseQueryRows(sql) {
  const result = await byteHouseExec(`${sql}\nFORMAT JSON`, { expectJson: true });
  return result.data || [];
}

function byteHouseTable(name) {
  const config = byteHouseConfig();
  return `${requireIdent(config.database)}.${requireIdent(name)}`;
}

async function initByteHouse() {
  const config = byteHouseConfig();
  if (!config.ok) throw new Error(`ByteHouse 未配置完整：缺少 ${config.missing.join(", ")}`);
  await byteHouseExec(
    `CREATE TABLE IF NOT EXISTS ${byteHouseTable(config.tables.messages)} (
      message_key String,
      message_id String,
      chat_id String,
      project_id String,
      project_name String,
      group_name String,
      create_time_ms Int64,
      create_time String,
      create_date String,
      sender_id String,
      sender_id_type String DEFAULT '',
      sender_type String,
      sender_tenant_key String DEFAULT '',
      msg_type String,
      is_reply UInt8,
      reply_to_message_id String,
      thread_root_message_id String,
      text String,
      mentions_json String DEFAULT '[]',
      content_json String DEFAULT '{}',
      raw_json String,
      archived_at String,
      ingested_at DateTime DEFAULT now()
    )
    ENGINE = CnchMergeTree()
    ORDER BY (message_key)`
  );
  await byteHouseExec(`ALTER TABLE ${byteHouseTable(config.tables.messages)} ADD COLUMN IF NOT EXISTS sender_id_type String DEFAULT ''`);
  await byteHouseExec(`ALTER TABLE ${byteHouseTable(config.tables.messages)} ADD COLUMN IF NOT EXISTS sender_tenant_key String DEFAULT ''`);
  await byteHouseExec(`ALTER TABLE ${byteHouseTable(config.tables.messages)} ADD COLUMN IF NOT EXISTS mentions_json String DEFAULT '[]'`);
  await byteHouseExec(`ALTER TABLE ${byteHouseTable(config.tables.messages)} ADD COLUMN IF NOT EXISTS content_json String DEFAULT '{}'`);
  await byteHouseExec(
    `CREATE TABLE IF NOT EXISTS ${byteHouseTable(config.tables.syncRuns)} (
      run_id String,
      started_at String,
      finished_at String,
      status String,
      trigger_name String,
      chat_count UInt64,
      scanned_count UInt64,
      new_count UInt64,
      message_count_after UInt64,
      db_path String,
      error String,
      meta_json String,
      updated_at DateTime DEFAULT now()
    )
    ENGINE = CnchMergeTree()
    ORDER BY (run_id)`
  );
  await byteHouseExec(
    `CREATE TABLE IF NOT EXISTS ${byteHouseTable(config.tables.syncChatRuns)} (
      run_id String,
      chat_id String,
      project_id String,
      project_name String,
      window_start_ms Int64,
      window_end_ms Int64,
      scanned_count UInt64,
      new_count UInt64,
      page_count UInt64,
      status String,
      error String,
      updated_at DateTime DEFAULT now()
    )
    ENGINE = CnchMergeTree()
    ORDER BY (run_id, chat_id)`
  );
  await byteHouseExec(
    `CREATE TABLE IF NOT EXISTS ${byteHouseTable(config.tables.people)} (
      person_id String,
      name String,
      team String,
      role String,
      is_internal UInt8,
      open_id String,
      user_id String,
      union_id String,
      email String,
      department_ids_json String DEFAULT '[]',
      department_names_json String DEFAULT '[]',
      name_source String,
      identity_source String,
      department_source String,
      source_json String DEFAULT '{}',
      resolved_at String,
      updated_at String,
      ingested_at DateTime DEFAULT now()
    )
    ENGINE = CnchMergeTree()
    ORDER BY (person_id)`
  );
}

function sqliteExec(dir, sql) {
  ensureDir(dir);
  const result = spawnSync("sqlite3", ["-cmd", ".timeout 10000", sqlitePath(dir)], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`SQLite 执行失败：${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sqliteQueryJson(dir, sql) {
  const output = sqliteExec(dir, `.mode json\n${sql}\n`);
  return output.trim() ? JSON.parse(output) : [];
}

function initDatabase(dir) {
  sqliteExec(
    dir,
    `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS messages (
  message_key TEXT PRIMARY KEY,
  message_id TEXT,
  chat_id TEXT NOT NULL,
  project_id TEXT,
  project_name TEXT,
  group_name TEXT,
  create_time_ms INTEGER,
  create_time TEXT,
  create_date TEXT,
  sender_id TEXT,
  sender_type TEXT,
  msg_type TEXT,
  is_reply INTEGER,
  reply_to_message_id TEXT,
  thread_root_message_id TEXT,
  text TEXT,
  raw_json TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, create_time_ms);
CREATE INDEX IF NOT EXISTS idx_messages_project_time ON messages(project_id, create_time_ms);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, create_time_ms);
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger_name TEXT,
  chat_count INTEGER DEFAULT 0,
  scanned_count INTEGER DEFAULT 0,
  new_count INTEGER DEFAULT 0,
  message_count_after INTEGER DEFAULT 0,
  db_path TEXT,
  error TEXT,
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS sync_chat_runs (
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  project_id TEXT,
  project_name TEXT,
  window_start_ms INTEGER,
  window_end_ms INTEGER,
  scanned_count INTEGER DEFAULT 0,
  new_count INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (run_id, chat_id)
);
`
  );
}

function messageDbKey(row) {
  return row.messageId || `${row.chatId}-${row.createTimeMs}-${row.text || ""}`;
}

function messageRecord(row) {
  return {
    message_key: messageDbKey(row),
    message_id: row.messageId || "",
    chat_id: row.chatId || "",
    project_id: row.projectId || "",
    project_name: row.projectName || "",
    group_name: row.groupName || "",
    create_time_ms: Number(row.createTimeMs || 0),
    create_time: row.createTime || "",
    create_date: row.createDate || "",
    sender_id: row.sender?.id || row.senderId || "",
    sender_id_type: row.sender?.idType || row.senderIdType || "",
    sender_type: row.sender?.senderType || row.senderType || "",
    sender_tenant_key: row.sender?.tenantKey || row.senderTenantKey || "",
    msg_type: row.msgType || "",
    is_reply: row.isReply ? 1 : 0,
    reply_to_message_id: row.replyToMessageId || "",
    thread_root_message_id: row.threadRootMessageId || "",
    text: row.text || "",
    mentions_json: JSON.stringify(row.mentions || []),
    content_json: JSON.stringify(row.content || {}),
    raw_json: JSON.stringify(row),
    archived_at: row.archivedAt || new Date().toISOString()
  };
}

async function upsertMessagesToDb(dir, rows) {
  if (!rows.length) return 0;
  const columns = [
    "message_key",
    "message_id",
    "chat_id",
    "project_id",
    "project_name",
    "group_name",
    "create_time_ms",
    "create_time",
    "create_date",
    "sender_id",
    "sender_id_type",
    "sender_type",
    "sender_tenant_key",
    "msg_type",
    "is_reply",
    "reply_to_message_id",
    "thread_root_message_id",
    "text",
    "mentions_json",
    "content_json",
    "raw_json",
    "archived_at"
  ];
  if (isByteHouseProvider()) {
    await initByteHouse();
    const config = byteHouseConfig();
    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200);
      const values = chunk.map((row) => {
        const record = messageRecord(row);
        return `(${columns.map((column) => sqlQuote(record[column])).join(",")})`;
      });
      await byteHouseExec(`INSERT INTO ${byteHouseTable(config.tables.messages)} (${columns.join(",")}) VALUES ${values.join(",")}`);
    }
    return rows.length;
  }
  initDatabase(dir);
  const chunks = [];
  for (let index = 0; index < rows.length; index += 200) chunks.push(rows.slice(index, index + 200));
  for (const chunk of chunks) {
    const values = chunk.map((row) => {
      const record = messageRecord(row);
      return `(${columns.map((column) => sqliteQuote(record[column])).join(",")})`;
    });
    sqliteExec(
      dir,
      `INSERT INTO messages (${columns.join(",")}) VALUES ${values.join(",")}
ON CONFLICT(message_key) DO UPDATE SET
  project_id=excluded.project_id,
  project_name=excluded.project_name,
  group_name=excluded.group_name,
  sender_id=excluded.sender_id,
  sender_type=excluded.sender_type,
  msg_type=excluded.msg_type,
  is_reply=excluded.is_reply,
  reply_to_message_id=excluded.reply_to_message_id,
  thread_root_message_id=excluded.thread_root_message_id,
  text=excluded.text,
  raw_json=excluded.raw_json,
  archived_at=excluded.archived_at;`
    );
  }
  return rows.length;
}

async function writeSyncRun(dir, row) {
  if (isByteHouseProvider()) {
    await initByteHouse();
    const config = byteHouseConfig();
    const columns = [
      "run_id",
      "started_at",
      "finished_at",
      "status",
      "trigger_name",
      "chat_count",
      "scanned_count",
      "new_count",
      "message_count_after",
      "db_path",
      "error",
      "meta_json"
    ];
    const record = {
      run_id: row.runId,
      started_at: row.startedAt,
      finished_at: row.finishedAt || "",
      status: row.status,
      trigger_name: row.triggerName || "",
      chat_count: Number(row.chatCount || 0),
      scanned_count: Number(row.scannedCount || 0),
      new_count: Number(row.newCount || 0),
      message_count_after: Number(row.messageCountAfter || 0),
      db_path: `bytehouse://${config.database}/${config.tablePrefix}`,
      error: row.error || "",
      meta_json: JSON.stringify(row.meta || {})
    };
    await byteHouseExec(
      `INSERT INTO ${byteHouseTable(config.tables.syncRuns)} (${columns.join(",")}) VALUES (${columns.map((column) => sqlQuote(record[column])).join(",")})`
    );
    return;
  }
  initDatabase(dir);
  sqliteExec(
    dir,
    `INSERT INTO sync_runs (run_id, started_at, finished_at, status, trigger_name, chat_count, scanned_count, new_count, message_count_after, db_path, error, meta_json)
VALUES (${[
      row.runId,
      row.startedAt,
      row.finishedAt || "",
      row.status,
      row.triggerName || "",
      Number(row.chatCount || 0),
      Number(row.scannedCount || 0),
      Number(row.newCount || 0),
      Number(row.messageCountAfter || 0),
      sqlitePath(dir),
      row.error || "",
      JSON.stringify(row.meta || {})
    ]
      .map(sqliteQuote)
      .join(",")})
ON CONFLICT(run_id) DO UPDATE SET
  finished_at=excluded.finished_at,
  status=excluded.status,
  chat_count=excluded.chat_count,
  scanned_count=excluded.scanned_count,
  new_count=excluded.new_count,
  message_count_after=excluded.message_count_after,
  error=excluded.error,
  meta_json=excluded.meta_json;`
  );
}

async function writeSyncChatRun(dir, row) {
  if (isByteHouseProvider()) {
    await initByteHouse();
    const config = byteHouseConfig();
    const columns = [
      "run_id",
      "chat_id",
      "project_id",
      "project_name",
      "window_start_ms",
      "window_end_ms",
      "scanned_count",
      "new_count",
      "page_count",
      "status",
      "error"
    ];
    const record = {
      run_id: row.runId,
      chat_id: row.chatId,
      project_id: row.projectId || "",
      project_name: row.projectName || "",
      window_start_ms: Number(row.windowStartMs || 0),
      window_end_ms: Number(row.windowEndMs || 0),
      scanned_count: Number(row.scannedCount || 0),
      new_count: Number(row.newCount || 0),
      page_count: Number(row.pageCount || 0),
      status: row.status,
      error: row.error || ""
    };
    await byteHouseExec(
      `INSERT INTO ${byteHouseTable(config.tables.syncChatRuns)} (${columns.join(",")}) VALUES (${columns.map((column) => sqlQuote(record[column])).join(",")})`
    );
    return;
  }
  initDatabase(dir);
  sqliteExec(
    dir,
    `INSERT INTO sync_chat_runs (run_id, chat_id, project_id, project_name, window_start_ms, window_end_ms, scanned_count, new_count, page_count, status, error)
VALUES (${[
      row.runId,
      row.chatId,
      row.projectId || "",
      row.projectName || "",
      Number(row.windowStartMs || 0),
      Number(row.windowEndMs || 0),
      Number(row.scannedCount || 0),
      Number(row.newCount || 0),
      Number(row.pageCount || 0),
      row.status,
      row.error || ""
    ]
      .map(sqliteQuote)
      .join(",")})
ON CONFLICT(run_id, chat_id) DO UPDATE SET
  scanned_count=excluded.scanned_count,
  new_count=excluded.new_count,
  page_count=excluded.page_count,
  status=excluded.status,
  error=excluded.error;`
  );
}

async function readStorageStatus(dir) {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (!config.ok) {
      return {
        ok: false,
        type: "bytehouse",
        path: config.url,
        database: config.database || "",
        messageCount: 0,
        missing: config.missing,
        note: `ByteHouse 未配置完整：缺少 ${config.missing.join(", ")}`
      };
    }
    await initByteHouse();
    const [summary = {}] = await byteHouseQueryRows(
      `SELECT
        (SELECT count(DISTINCT message_key) FROM ${byteHouseTable(config.tables.messages)}) AS messageCount,
        (SELECT count(DISTINCT person_id) FROM ${byteHouseTable(config.tables.people)}) AS peopleCount,
        (SELECT count(DISTINCT person_id) FROM ${byteHouseTable(config.tables.people)} WHERE is_internal=1) AS internalPeopleCount,
        (SELECT max(toString(ingested_at)) FROM ${byteHouseTable(config.tables.people)}) AS peopleUpdatedAt,
        (SELECT min(create_time) FROM ${byteHouseTable(config.tables.messages)}) AS firstMessageTime,
        (SELECT max(create_time) FROM ${byteHouseTable(config.tables.messages)}) AS lastMessageTime,
        (SELECT max(finished_at) FROM ${byteHouseTable(config.tables.syncRuns)} WHERE status='success') AS lastSuccessfulSyncAt,
        (SELECT status FROM ${byteHouseTable(config.tables.syncRuns)} ORDER BY started_at DESC, updated_at DESC LIMIT 1) AS lastSyncStatus,
        (SELECT error FROM ${byteHouseTable(config.tables.syncRuns)} ORDER BY started_at DESC, updated_at DESC LIMIT 1) AS lastSyncError`
    );
    return {
      ok: true,
      type: "bytehouse",
      path: config.url,
      database: config.database,
      tablePrefix: config.tablePrefix,
      virtualWarehouse: config.virtualWarehouse,
      messageCount: Number(summary.messageCount || 0),
      peopleCount: Number(summary.peopleCount || 0),
      internalPeopleCount: Number(summary.internalPeopleCount || 0),
      peopleUpdatedAt: summary.peopleUpdatedAt || "",
      firstMessageTime: summary.firstMessageTime || "",
      lastMessageTime: summary.lastMessageTime || "",
      lastSuccessfulSyncAt: summary.lastSuccessfulSyncAt || "",
      lastSyncStatus: summary.lastSyncStatus || "",
      lastSyncError: summary.lastSyncError || ""
    };
  }
  if (!fs.existsSync(sqlitePath(dir))) {
    return { ok: false, type: "sqlite", path: sqlitePath(dir), messageCount: 0, note: "数据库未初始化" };
  }
  initDatabase(dir);
  const [summary = {}] = sqliteQueryJson(
    dir,
    `SELECT
      (SELECT COUNT(*) FROM messages) AS messageCount,
      (SELECT MIN(create_time) FROM messages) AS firstMessageTime,
      (SELECT MAX(create_time) FROM messages) AS lastMessageTime,
      (SELECT MAX(finished_at) FROM sync_runs WHERE status='success') AS lastSuccessfulSyncAt,
      (SELECT status FROM sync_runs ORDER BY started_at DESC LIMIT 1) AS lastSyncStatus,
      (SELECT error FROM sync_runs ORDER BY started_at DESC LIMIT 1) AS lastSyncError;`
  );
  return {
    ok: true,
    type: "sqlite",
    path: sqlitePath(dir),
    messageCount: Number(summary.messageCount || 0),
    firstMessageTime: summary.firstMessageTime || "",
    lastMessageTime: summary.lastMessageTime || "",
    lastSuccessfulSyncAt: summary.lastSuccessfulSyncAt || "",
    lastSyncStatus: summary.lastSyncStatus || "",
    lastSyncError: summary.lastSyncError || ""
  };
}

function questionLikeSql(column = "text") {
  return `positionUTF8(${column}, '?') > 0 OR positionUTF8(${column}, '？') > 0 OR positionUTF8(${column}, '吗') > 0 OR positionUTF8(${column}, '什么') > 0 OR positionUTF8(${column}, '怎么') > 0 OR positionUTF8(${column}, '咋') > 0 OR positionUTF8(${column}, '为什么') > 0 OR positionUTF8(${column}, '有没有') > 0 OR positionUTF8(${column}, '是否') > 0`;
}

async function readProjectStatsFromStorage(dir) {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (!config.ok) return { projects: {}, chats: {} };
    await initByteHouse();
    const table = byteHouseTable(config.tables.messages);
    const projectRows = await byteHouseQueryRows(
      `SELECT
        project_id AS projectId,
        any(project_name) AS projectName,
        count(DISTINCT message_key) AS messageCount,
        uniqExactIf(sender_id, sender_id!='') AS uniqueSenderCount,
        uniqExactIf(message_key, is_reply=1) AS replyCount,
        uniqExactIf(message_key, ${questionLikeSql("text")}) AS questionLikeCount,
        min(create_time) AS firstTime,
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
        uniqExactIf(message_key, ${questionLikeSql("text")}) AS questionLikeCount,
        max(create_time) AS lastTime
      FROM ${table}
      GROUP BY project_id, chat_id`
    );
    const projectDateRows = await byteHouseQueryRows(
      `SELECT
        project_id AS projectId,
        create_date AS date,
        count(DISTINCT message_key) AS count
      FROM ${table}
      GROUP BY project_id, create_date
      ORDER BY create_date ASC`
    );
    const projectDateHourRows = await byteHouseQueryRows(
      `SELECT
        project_id AS projectId,
        create_date AS date,
        substring(create_time, 12, 2) AS slot,
        count(DISTINCT message_key) AS count
      FROM ${table}
      GROUP BY project_id, create_date, slot
      ORDER BY create_date ASC, slot ASC`
    );
    const byDateByProject = {};
    for (const row of projectDateRows) {
      const key = row.projectId || "";
      if (!byDateByProject[key]) byDateByProject[key] = [];
      byDateByProject[key].push({ date: row.date || "", count: Number(row.count || 0) });
    }
    const byDateHourByProject = {};
    for (const row of projectDateHourRows) {
      const projectId = row.projectId || "";
      const date = row.date || "";
      if (!date) continue;
      if (!byDateHourByProject[projectId]) byDateHourByProject[projectId] = {};
      if (!byDateHourByProject[projectId][date]) byDateHourByProject[projectId][date] = [];
      byDateHourByProject[projectId][date].push({ slot: row.slot || "unknown", count: Number(row.count || 0) });
    }
    return {
      projects: Object.fromEntries(
        projectRows.map((row) => [
          row.projectId || "",
          {
            projectName: row.projectName || "",
            messageCount: Number(row.messageCount || 0),
            uniqueSenderCount: Number(row.uniqueSenderCount || 0),
            replyCount: Number(row.replyCount || 0),
            questionLikeCount: Number(row.questionLikeCount || 0),
            firstTime: row.firstTime || "",
            lastTime: row.lastTime || "",
            byDate: byDateByProject[row.projectId || ""] || [],
            byDateHour: byDateHourByProject[row.projectId || ""] || {}
          }
        ])
      ),
      chats: Object.fromEntries(
        chatRows.map((row) => [
          row.chatId || "",
          {
            projectId: row.projectId || "",
            groupName: row.groupName || "",
            messageCount: Number(row.messageCount || 0),
            questionLikeCount: Number(row.questionLikeCount || 0),
            lastTime: row.lastTime || ""
          }
        ])
      )
    };
  }
  if (!fs.existsSync(sqlitePath(dir))) return { projects: {}, chats: {} };
  initDatabase(dir);
  const questionLike = "text LIKE '%?%' OR text LIKE '%？%' OR text LIKE '%吗%' OR text LIKE '%什么%' OR text LIKE '%怎么%' OR text LIKE '%为什么%' OR text LIKE '%有没有%'";
  const projectRows = sqliteQueryJson(
    dir,
    `SELECT project_id AS projectId, project_name AS projectName, COUNT(DISTINCT message_key) AS messageCount,
      COUNT(DISTINCT NULLIF(sender_id, '')) AS uniqueSenderCount,
      SUM(CASE WHEN is_reply=1 THEN 1 ELSE 0 END) AS replyCount,
      SUM(CASE WHEN ${questionLike} THEN 1 ELSE 0 END) AS questionLikeCount, MIN(create_time) AS firstTime, MAX(create_time) AS lastTime
    FROM messages GROUP BY project_id;`
  );
  const chatRows = sqliteQueryJson(
    dir,
    `SELECT project_id AS projectId, chat_id AS chatId, group_name AS groupName, COUNT(DISTINCT message_key) AS messageCount,
      SUM(CASE WHEN ${questionLike} THEN 1 ELSE 0 END) AS questionLikeCount, MAX(create_time) AS lastTime
    FROM messages GROUP BY project_id, chat_id;`
  );
  const projectDateRows = sqliteQueryJson(
    dir,
    `SELECT project_id AS projectId, create_date AS date, COUNT(DISTINCT message_key) AS count
    FROM messages GROUP BY project_id, create_date ORDER BY create_date ASC;`
  );
  const projectDateHourRows = sqliteQueryJson(
    dir,
    `SELECT project_id AS projectId, create_date AS date, substr(create_time, 12, 2) AS slot, COUNT(DISTINCT message_key) AS count
    FROM messages GROUP BY project_id, create_date, slot ORDER BY create_date ASC, slot ASC;`
  );
  const byDateByProject = {};
  for (const row of projectDateRows) {
    const key = row.projectId || "";
    if (!byDateByProject[key]) byDateByProject[key] = [];
    byDateByProject[key].push({ date: row.date || "", count: Number(row.count || 0) });
  }
  const byDateHourByProject = {};
  for (const row of projectDateHourRows) {
    const projectId = row.projectId || "";
    const date = row.date || "";
    if (!date) continue;
    if (!byDateHourByProject[projectId]) byDateHourByProject[projectId] = {};
    if (!byDateHourByProject[projectId][date]) byDateHourByProject[projectId][date] = [];
    byDateHourByProject[projectId][date].push({ slot: row.slot || "unknown", count: Number(row.count || 0) });
  }
  return {
    projects: Object.fromEntries(
      projectRows.map((row) => [
        row.projectId || "",
        {
          projectName: row.projectName || "",
          messageCount: Number(row.messageCount || 0),
          uniqueSenderCount: Number(row.uniqueSenderCount || 0),
          replyCount: Number(row.replyCount || 0),
          questionLikeCount: Number(row.questionLikeCount || 0),
          firstTime: row.firstTime || "",
          lastTime: row.lastTime || "",
          byDate: byDateByProject[row.projectId || ""] || [],
          byDateHour: byDateHourByProject[row.projectId || ""] || {}
        }
      ])
    ),
    chats: Object.fromEntries(
      chatRows.map((row) => [
        row.chatId || "",
        {
          projectId: row.projectId || "",
          groupName: row.groupName || "",
          messageCount: Number(row.messageCount || 0),
          questionLikeCount: Number(row.questionLikeCount || 0),
          lastTime: row.lastTime || ""
        }
      ])
    )
  };
}

async function readOverviewStatsFromStorage(dir) {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (!config.ok) return null;
    await initByteHouse();
    const table = byteHouseTable(config.tables.messages);
    const [summary = {}] = await byteHouseQueryRows(
      `SELECT
        count(DISTINCT message_key) AS messageCount,
        uniqExactIf(sender_id, sender_id!='') AS uniqueSenderCount,
        uniqExactIf(message_key, is_reply=1) AS replyCount,
        uniqExactIf(message_key, ${questionLikeSql("text")}) AS questionLikeCount,
        min(create_time) AS firstTime,
        max(create_time) AS lastTime
      FROM ${table}`
    );
    const [dateRows, hourRows, dateHourRows, typeRows, projectRows, chatRows] = await Promise.all([
      byteHouseQueryRows(`SELECT create_date AS date, count(DISTINCT message_key) AS count FROM ${table} GROUP BY create_date ORDER BY create_date ASC`),
      byteHouseQueryRows(`SELECT substring(create_time, 12, 2) AS slot, count(DISTINCT message_key) AS count FROM ${table} GROUP BY slot ORDER BY slot ASC`),
      byteHouseQueryRows(`SELECT create_date AS date, substring(create_time, 12, 2) AS slot, count(DISTINCT message_key) AS count FROM ${table} GROUP BY create_date, slot ORDER BY create_date ASC, slot ASC`),
      byteHouseQueryRows(`SELECT msg_type AS key, count(DISTINCT message_key) AS count FROM ${table} GROUP BY msg_type ORDER BY count DESC`),
      byteHouseQueryRows(`SELECT any(project_name) AS key, count(DISTINCT message_key) AS count FROM ${table} GROUP BY project_id ORDER BY count DESC`),
      byteHouseQueryRows(`SELECT any(group_name) AS key, count(DISTINCT message_key) AS count FROM ${table} GROUP BY chat_id ORDER BY count DESC`)
    ]);
    const byDateHour = {};
    for (const row of dateHourRows) {
      const date = row.date || "";
      if (!date) continue;
      if (!byDateHour[date]) byDateHour[date] = [];
      byDateHour[date].push({ slot: row.slot || "unknown", count: Number(row.count || 0) });
    }
    return {
      source: "bytehouse",
      messageCount: Number(summary.messageCount || 0),
      uniqueSenderCount: Number(summary.uniqueSenderCount || 0),
      replyCount: Number(summary.replyCount || 0),
      questionLikeCount: Number(summary.questionLikeCount || 0),
      firstTime: summary.firstTime || "",
      lastTime: summary.lastTime || "",
      byDate: dateRows.map((row) => ({ date: row.date || "", count: Number(row.count || 0) })),
      byDateHour,
      byHour: Object.fromEntries(hourRows.map((row) => [row.slot || "unknown", Number(row.count || 0)])),
      hourlyMessageCount: hourRows.map((row) => ({ slot: row.slot || "unknown", count: Number(row.count || 0) })),
      byMsgType: Object.fromEntries(typeRows.map((row) => [row.key || "unknown", Number(row.count || 0)])),
      messageTypeRows: typeRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) })),
      byProject: projectRows.map((row) => ({ key: row.key || "未标注项目", count: Number(row.count || 0) })),
      byChat: chatRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) }))
    };
  }
  if (!fs.existsSync(sqlitePath(dir))) return null;
  initDatabase(dir);
  const questionLike = "text LIKE '%?%' OR text LIKE '%？%' OR text LIKE '%吗%' OR text LIKE '%什么%' OR text LIKE '%怎么%' OR text LIKE '%咋%' OR text LIKE '%为什么%' OR text LIKE '%有没有%' OR text LIKE '%是否%'";
  const [summary = {}] = sqliteQueryJson(
    dir,
    `SELECT COUNT(DISTINCT message_key) AS messageCount,
      COUNT(DISTINCT NULLIF(sender_id, '')) AS uniqueSenderCount,
      SUM(CASE WHEN is_reply=1 THEN 1 ELSE 0 END) AS replyCount,
      SUM(CASE WHEN ${questionLike} THEN 1 ELSE 0 END) AS questionLikeCount,
      MIN(create_time) AS firstTime,
      MAX(create_time) AS lastTime
    FROM messages;`
  );
  const dateRows = sqliteQueryJson(dir, `SELECT create_date AS date, COUNT(DISTINCT message_key) AS count FROM messages GROUP BY create_date ORDER BY create_date ASC;`);
  const hourRows = sqliteQueryJson(dir, `SELECT substr(create_time, 12, 2) AS slot, COUNT(DISTINCT message_key) AS count FROM messages GROUP BY slot ORDER BY slot ASC;`);
  const dateHourRows = sqliteQueryJson(
    dir,
    `SELECT create_date AS date, substr(create_time, 12, 2) AS slot, COUNT(DISTINCT message_key) AS count
    FROM messages GROUP BY create_date, slot ORDER BY create_date ASC, slot ASC;`
  );
  const typeRows = sqliteQueryJson(dir, `SELECT msg_type AS key, COUNT(DISTINCT message_key) AS count FROM messages GROUP BY msg_type ORDER BY count DESC;`);
  const projectRows = sqliteQueryJson(dir, `SELECT project_name AS key, COUNT(DISTINCT message_key) AS count FROM messages GROUP BY project_id ORDER BY count DESC;`);
  const chatRows = sqliteQueryJson(dir, `SELECT group_name AS key, COUNT(DISTINCT message_key) AS count FROM messages GROUP BY chat_id ORDER BY count DESC;`);
  const byDateHour = {};
  for (const row of dateHourRows) {
    const date = row.date || "";
    if (!date) continue;
    if (!byDateHour[date]) byDateHour[date] = [];
    byDateHour[date].push({ slot: row.slot || "unknown", count: Number(row.count || 0) });
  }
  return {
    source: "sqlite",
    messageCount: Number(summary.messageCount || 0),
    uniqueSenderCount: Number(summary.uniqueSenderCount || 0),
    replyCount: Number(summary.replyCount || 0),
    questionLikeCount: Number(summary.questionLikeCount || 0),
    firstTime: summary.firstTime || "",
    lastTime: summary.lastTime || "",
    byDate: dateRows.map((row) => ({ date: row.date || "", count: Number(row.count || 0) })),
    byDateHour,
    byHour: Object.fromEntries(hourRows.map((row) => [row.slot || "unknown", Number(row.count || 0)])),
    hourlyMessageCount: hourRows.map((row) => ({ slot: row.slot || "unknown", count: Number(row.count || 0) })),
    byMsgType: Object.fromEntries(typeRows.map((row) => [row.key || "unknown", Number(row.count || 0)])),
    messageTypeRows: typeRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) })),
    byProject: projectRows.map((row) => ({ key: row.key || "未标注项目", count: Number(row.count || 0) })),
    byChat: chatRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) }))
  };
}

function mergeProjectStats(projects, stats) {
  const projectStats = stats?.projects || {};
  const chatStats = stats?.chats || {};
  return projects.map((project) => {
    const stat = projectStats[project.projectId] || {};
    return {
      ...project,
      stats: stat,
      projectName: project.projectName || stat.projectName || project.projectId,
      chats: (project.chats || []).map((chat) => ({
        ...chat,
        ...(chatStats[chat.chatId] || {})
      }))
    };
  });
}

async function writeStorageStatus(dir) {
  const status = await readStorageStatus(dir);
  writeJsonAtomic(path.resolve(dir, "dashboard", "storage-status.json"), status);
  return status;
}

function localDate(ms) {
  return new Date(Number(ms) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function localIso(ms) {
  return new Date(Number(ms) + SHANGHAI_OFFSET_MS).toISOString().replace("Z", "+08:00");
}

function dayWindow(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error(`日期格式必须是 YYYY-MM-DD：${dateText}`);
  return {
    startMs: Date.parse(`${dateText}T00:00:00+08:00`),
    endMs: Date.parse(`${dateText}T23:59:59.999+08:00`)
  };
}

function parseTime(value) {
  if (!value) return 0;
  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`非法时间：${value}`);
  return parsed;
}

function datesBetween(startMs, endMs) {
  const dates = [];
  let cursor = Date.parse(`${localDate(startMs)}T00:00:00+08:00`);
  const endDate = localDate(endMs);
  while (localDate(cursor) <= endDate) {
    dates.push(localDate(cursor));
    cursor += 24 * 60 * 60 * 1000;
  }
  return dates;
}

function archiveDir(args) {
  return path.resolve(args["archive-dir"] || process.env.ARCHIVE_DIR || "./data");
}

function readGroups() {
  return readJson(path.resolve(process.env.GROUPS_CONFIG || "./groups.json"), {});
}

function readPeople() {
  return readJson(path.resolve(process.env.PEOPLE_CONFIG || "./people.json"), {});
}

function peopleRecord(id, person = {}) {
  const role = String(person.role || "").trim();
  const isInternal = person.isInternal === true || INTERNAL_ROLES.has(role);
  const departmentIds = Array.isArray(person.departmentIds) ? person.departmentIds.filter(Boolean) : [];
  const departmentNames = Array.isArray(person.departmentNames) ? person.departmentNames.filter(Boolean) : [];
  return {
    person_id: id,
    name: person.name || "",
    team: person.team || "",
    role,
    is_internal: isInternal ? 1 : 0,
    open_id: person.openId || id,
    user_id: person.userId || "",
    union_id: person.unionId || "",
    email: person.email || "",
    department_ids_json: JSON.stringify(departmentIds),
    department_names_json: JSON.stringify(departmentNames),
    name_source: person.nameSource || "",
    identity_source: person.identitySource || "",
    department_source: person.departmentSource || "",
    source_json: JSON.stringify(person || {}),
    resolved_at: person.resolvedAt || "",
    updated_at: person.updatedAt || person.resolvedAt || ""
  };
}

async function syncPeopleToStorage(people, ids = null) {
  const entries = Object.entries(people || {}).filter(([id]) => !ids || ids.has(id));
  if (!entries.length) return { provider: storageProvider(), synced: 0, skipped: true };
  if (!isByteHouseProvider()) return { provider: storageProvider(), synced: 0, skipped: true };
  await initByteHouse();
  const config = byteHouseConfig();
  const columns = [
    "person_id",
    "name",
    "team",
    "role",
    "is_internal",
    "open_id",
    "user_id",
    "union_id",
    "email",
    "department_ids_json",
    "department_names_json",
    "name_source",
    "identity_source",
    "department_source",
    "source_json",
    "resolved_at",
    "updated_at"
  ];
  for (let index = 0; index < entries.length; index += 200) {
    const chunk = entries.slice(index, index + 200);
    const values = chunk.map(([id, person]) => {
      const record = peopleRecord(id, person);
      return `(${columns.map((column) => sqlQuote(record[column])).join(",")})`;
    });
    await byteHouseExec(`INSERT INTO ${byteHouseTable(config.tables.people)} (${columns.join(",")}) VALUES ${values.join(",")}`);
  }
  return { provider: "bytehouse", table: `${config.database}.${config.tables.people}`, synced: entries.length };
}

function normalizePersonName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function senderIdsForQuery(configuredPeople, query) {
  const needle = String(query || "").trim().toLowerCase();
  const normalizedNeedle = normalizePersonName(query);
  if (!needle && !normalizedNeedle) return [];
  return Object.entries(configuredPeople || {})
    .filter(([id, person]) => {
      const fields = [id, person?.name, person?.team, person?.role].filter(Boolean).map((value) => String(value).toLowerCase());
      if (fields.some((value) => value.includes(needle))) return true;
      return normalizePersonName(person?.name).includes(normalizedNeedle);
    })
    .map(([id]) => id);
}

function readProjectEvents() {
  const configured = readJson(path.resolve(process.env.PROJECT_EVENTS_CONFIG || "./project-events.json"), []);
  const rows = Array.isArray(configured) ? configured : configured.events || [];
  return normalizeProjectEvents(rows);
}

function buildPeopleDirectory(rows, configuredPeople = {}) {
  const groups = readGroups();
  const directory = {};
  const configuredByName = new Map();
  for (const [id, person] of Object.entries(configuredPeople || {})) {
    directory[id] = { ...person, nameSource: person.nameSource || "people_config" };
    const normalizedName = normalizePersonName(person.name);
    if (normalizedName && !configuredByName.has(normalizedName)) {
      configuredByName.set(normalizedName, directory[id]);
    }
  }
  for (const row of rows) {
    for (const mention of row.mentions || []) {
      if (mention.id && mention.name && !directory[mention.id]) {
        const matchedConfiguredPerson = configuredByName.get(normalizePersonName(mention.name));
        directory[mention.id] = matchedConfiguredPerson
          ? {
              ...matchedConfiguredPerson,
              name: mention.name,
              nameSource: "message_mention",
              identitySource: "message_mention_name_alias"
            }
          : {
              name: mention.name,
              team: "",
              role: "external",
              isInternal: false,
              nameSource: "message_mention"
            };
      }
    }
    const senderId = row.sender?.id || "";
    if (senderId && row.sender?.senderType === "app" && !directory[senderId]) {
      directory[senderId] = {
        name: "项目机器人",
        team: "系统",
        role: "bot",
        isInternal: true,
        nameSource: "sender_type_app"
      };
    }
    if (senderId && senderId !== "unknown" && !directory[senderId] && groups[row.chatId]?.external === false) {
      directory[senderId] = {
        name: senderId,
        team: "内部群未补姓名",
        role: "internal",
        isInternal: true,
        nameSource: "internal_group_unresolved",
        identitySource: "internal_group_unresolved"
      };
    }
  }
  return directory;
}

function collectTargets(args) {
  const groups = readGroups();
  if (args["chat-id"]) {
    return [{ chatId: args["chat-id"], group: groups[args["chat-id"]] || {} }];
  }
  return Object.entries(groups)
    .filter(([, group]) => group?.enabled !== false)
    .filter(([, group]) => !args["project-id"] || group.projectId === args["project-id"])
    .map(([chatId, group]) => ({ chatId, group }));
}

function resolveWindow(args, state) {
  if (args.date) return dayWindow(args.date);
  const endMs = args.until ? parseTime(args.until) : Date.now();
  let startMs = args.since ? parseTime(args.since) : 0;
  if (!startMs && state.highWatermarkMs) {
    startMs = Number(state.highWatermarkMs) - Number(process.env.OVERLAP_MINUTES || 5) * 60 * 1000;
  }
  if (!startMs) {
    const firstSyncLookbackHours = Number(args["initial-lookback-hours"] || process.env.INITIAL_LOOKBACK_HOURS || 24 * 90);
    const regularLookbackHours = Number(args["lookback-hours"] || process.env.LOOKBACK_HOURS || 24);
    startMs = endMs - (state.highWatermarkMs ? regularLookbackHours : firstSyncLookbackHours) * 60 * 60 * 1000;
  }
  return { startMs, endMs };
}

function resolveBackfillWindow(args) {
  const endMs = args.until ? parseTime(args.until) : Date.now();
  let startMs = args.since ? parseTime(args.since) : 0;
  if (!startMs && args.days) startMs = endMs - Number(args.days) * 24 * 60 * 60 * 1000;
  if (!startMs && args["lookback-hours"]) startMs = endMs - Number(args["lookback-hours"]) * 60 * 60 * 1000;
  if (!startMs) startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  return { startMs, endMs };
}

async function tenantToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  const response = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(`获取 tenant_access_token 失败：${body.msg || JSON.stringify(body)}`);
  return body.tenant_access_token;
}

function apiError(pathname, body) {
  const permissions = body?.error?.permission_violations?.map((item) => item.subject).filter(Boolean).join(", ");
  const logId = body?.error?.log_id || body?.error?.logid || "";
  const outOfChatHint =
    body?.code === 230002
      ? "机器人不在这个群里。请把这个应用对应的机器人添加到目标飞书群后再重试。"
      : "";
  const permissionHint =
    body?.code === 99991672 || permissions
      ? permissions?.includes("contact:")
        ? "请在飞书开放平台开通通讯录读取权限，并发布版本。"
        : "请在飞书开放平台开通所需读取权限，并发布版本。"
      : "";
  return [
    `${pathname} 失败：code=${body?.code}, msg=${body?.msg || JSON.stringify(body)}`,
    permissions ? `缺少权限：${permissions}` : "",
    logId ? `log_id：${logId}` : "",
    outOfChatHint || permissionHint
  ]
    .filter(Boolean)
    .join("\n");
}

async function apiGet(token, pathname, params) {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(apiError(pathname, body));
  return body.data || {};
}

async function listMessages(token, { chatId, startMs, endMs, pageToken, pageSize }) {
  return apiGet(token, "/im/v1/messages", {
    container_id_type: "chat",
    container_id: chatId,
    start_time: Math.floor(startMs / 1000),
    end_time: Math.floor(endMs / 1000),
    sort_type: "ByCreateTimeAsc",
    page_size: pageSize || 50,
    page_token: pageToken || ""
  });
}

async function listChats(token, { pageToken, pageSize }) {
  return apiGet(token, "/im/v1/chats", {
    page_size: pageSize || 50,
    page_token: pageToken || ""
  });
}

async function getUser(token, userId) {
  return apiGet(token, `/contact/v3/users/${encodeURIComponent(userId)}`, {
    user_id_type: "open_id",
    department_id_type: "open_department_id"
  });
}

async function getDepartment(token, departmentId) {
  return apiGet(token, `/contact/v3/departments/${encodeURIComponent(departmentId)}`, {
    department_id_type: "open_department_id",
    user_id_type: "open_id"
  });
}

async function basicBatchUsers(token, userIds = []) {
  const result = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fetchChunk = async (chunk) => {
    const url = new URL(`${API_BASE}/contact/v3/users/basic_batch`);
    url.searchParams.set("user_id_type", "open_id");
    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({ user_ids: chunk }),
          signal: typeof AbortSignal !== "undefined" ? AbortSignal.timeout(45_000) : undefined
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(600 * (attempt + 1));
      }
    }
    if (!response) throw new Error(lastError?.message || "/contact/v3/users/basic_batch 请求失败");
    const body = await response.json();
    if (!response.ok || body.code !== 0) {
      if (body.code === 99992402 && chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        await fetchChunk(chunk.slice(0, middle));
        await fetchChunk(chunk.slice(middle));
        return;
      }
      if (body.code === 99992402 && chunk.length === 1) return;
      throw new Error(apiError("/contact/v3/users/basic_batch", body));
    }
    const data = body.data || {};
    const users = data.user_list || data.users || data.items || [];
    for (const user of users) {
      const openId = user.open_id || user.user_id || user.id;
      if (openId) result.set(openId, user);
    }
  };
  for (let index = 0; index < userIds.length; index += 20) {
    const chunk = userIds.slice(index, index + 20);
    if (!chunk.length) continue;
    await fetchChunk(chunk);
  }
  return result;
}

function departmentDisplayName(department = {}) {
  const i18n = department.i18n_name || {};
  return (
    department.name ||
    i18n.zh_cn ||
    i18n["zh-CN"] ||
    i18n.en_us ||
    i18n["en-US"] ||
    department.open_department_id ||
    department.department_id ||
    ""
  );
}

async function resolveDepartmentNames(token, departmentIds = [], cache = new Map()) {
  const names = [];
  const failed = [];
  for (const id of departmentIds || []) {
    if (!id) continue;
    if (!cache.has(id)) {
      try {
        const data = await getDepartment(token, id);
        const department = data.department || {};
        cache.set(id, { ok: true, name: departmentDisplayName(department) || id, department });
      } catch (error) {
        cache.set(id, { ok: false, name: id, reason: error.message });
      }
    }
    const item = cache.get(id);
    names.push(item.name || id);
    if (!item.ok) failed.push({ id, reason: item.reason || "department_lookup_failed" });
  }
  return { names, failed };
}

async function fetchMessageResource(token, messageId, fileKey, type = "image") {
  const url = new URL(`${API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`);
  url.searchParams.set("type", type);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!response.ok) {
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text().catch(() => "");
    throw new Error(apiError(`/im/v1/messages/${messageId}/resources/${fileKey}`, body));
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}

function postContentBody(content = {}) {
  if (!content || typeof content !== "object") return [];
  const first = content.post ? content.post.zh_cn || content.post.en_us || Object.values(content.post)[0] : content;
  return Array.isArray(first?.content) ? first.content : [];
}

function richBlocksFromContent(content, msgType) {
  if (!content || typeof content !== "object") return [];
  if (msgType === "image" && content.image_key) {
    return [[{ tag: "img", imageKey: content.image_key, width: content.width || null, height: content.height || null }]];
  }
  if (msgType !== "post") return [];
  return postContentBody(content).map((line) =>
    (Array.isArray(line) ? line : []).map((item) => ({
      tag: item.tag || "text",
      text: item.text || item.user_name || item.href || "",
      href: item.href || "",
      userName: item.user_name || "",
      imageKey: item.image_key || "",
      width: item.width || null,
      height: item.height || null,
      emojiType: item.emoji_type || ""
    }))
  );
}

function imageResourcesFromBlocks(blocks = []) {
  return blocks
    .flat()
    .filter((item) => item.tag === "img" && item.imageKey)
    .map((item) => ({
      type: "image",
      fileKey: item.imageKey,
      width: item.width || null,
      height: item.height || null
    }));
}

function parseContent(rawContent, msgType) {
  if (!rawContent) return { content: null, text: "" };
  let content;
  try {
    content = JSON.parse(rawContent);
  } catch {
    return { content: rawContent, text: rawContent };
  }
  if (msgType === "system") return { content, text: formatSystemContent(content) || JSON.stringify(content) };
  if (msgType === "text") return { content, text: content.text || "" };
  if (msgType === "post") {
    const text = postContentBody(content)
      .flat()
      .map((item) => item.text || item.user_name || item.href || `[${item.tag || msgType}]`)
      .join("");
    return { content, text };
  }
  if (content.file_name) return { content, text: `[${msgType}:${content.file_name}]` };
  if (content.image_key) return { content, text: "[图片]" };
  if (content.file_key) return { content, text: `[文件:${content.file_name || content.file_key}]` };
  if (content.audio_key) return { content, text: "[语音]" };
  return { content, text: content.title || JSON.stringify(content) };
}

function formatSystemContent(content = {}) {
  if (!content || typeof content !== "object") return "";
  const from = Array.isArray(content.from_user) ? content.from_user.join("、") : content.from_user || "";
  const to = Array.isArray(content.to_chatters) ? content.to_chatters.join("、") : content.to_chatters || "";
  const template = String(content.template || "");
  if (from && to && /invited|邀请/.test(template)) return `${from} 邀请 ${to} 加入群聊；新成员可查看历史消息`;
  if (from && template) return template.replace("{from_user}", from).replace("{to_chatters}", to);
  return "";
}

function replaceMentionNames(text = "", mentions = []) {
  let output = String(text || "");
  for (const mention of mentions || []) {
    if (mention.key && mention.name) output = output.replaceAll(mention.key, `@${mention.name}`);
  }
  return output;
}

function normalize(message, target) {
  const createTimeMs = Number(message.create_time || 0);
  const parsed = parseContent(message.body?.content || "", message.msg_type || "");
  return {
    archivedAt: new Date().toISOString(),
    projectId: target.group.projectId || "",
    projectName: target.group.projectName || "",
    groupName: target.group.groupName || target.group.chatName || target.group.projectName || "",
    chatId: message.chat_id || target.chatId,
    messageId: message.message_id || "",
    rootId: message.root_id || "",
    parentId: message.parent_id || "",
    isReply: Boolean(message.parent_id || message.root_id),
    replyToMessageId: message.parent_id || "",
    threadRootMessageId: message.root_id || message.parent_id || message.message_id || "",
    msgType: message.msg_type || "",
    createTimeMs,
    createTime: createTimeMs ? localIso(createTimeMs) : "",
    createDate: createTimeMs ? localDate(createTimeMs) : "",
    sender: {
      id: message.sender?.id || "",
      idType: message.sender?.id_type || "",
      senderType: message.sender?.sender_type || "",
      tenantKey: message.sender?.tenant_key || ""
    },
    mentions: message.mentions || [],
    text: parsed.text,
    content: parsed.content,
    raw: message
  };
}

async function existingIds(dir, chatId, startMs, endMs) {
  if (isByteHouseProvider() || fs.existsSync(sqlitePath(dir))) {
    const dbRows = await readMessagesFromDb(dir, { chatId, startMs, endMs });
    return new Set(dbRows.map((row) => row.messageId).filter(Boolean));
  }
  const ids = new Set();
  for (const date of datesBetween(startMs, endMs)) {
    for (const row of readJsonl(path.resolve(dir, "daily", date, `${chatId}.jsonl`))) {
      if (row.messageId) ids.add(row.messageId);
    }
  }
  return ids;
}

async function sync(args) {
  const dir = archiveDir(args);
  const targets = collectTargets(args);
  if (!targets.length) throw new Error("没有可同步的群，请检查 groups.json 或传 --chat-id");
  const runId = `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  if (!args["dry-run"]) {
    await writeSyncRun(dir, {
      runId,
      startedAt,
      status: "running",
      triggerName: args.trigger || "manual",
      chatCount: targets.length,
      meta: { args }
    });
  }
  let token;
  let totalScanned = 0;
  let totalNew = 0;
  const touchedDates = new Set();

  try {
  token = await tenantToken();

  for (const target of targets) {
    const statePath = path.resolve(dir, "state", `${target.chatId}.json`);
    const state = readJson(statePath, {});
    const window = resolveWindow(args, state);
    const seen = await existingIds(dir, target.chatId, window.startMs, window.endMs);
    const allNew = [];
    let pageToken = "";
    let page = 0;
    let chatScanned = 0;
    let chatNew = 0;

    console.log(`[sync] ${target.chatId} ${localIso(window.startMs)} ~ ${localIso(window.endMs)}`);
    do {
      page += 1;
      const data = await listMessages(token, {
        chatId: target.chatId,
        startMs: window.startMs,
        endMs: window.endMs,
        pageToken,
        pageSize: Number(args["page-size"] || 50)
      });
      const items = data.items || [];
      totalScanned += items.length;
      chatScanned += items.length;
      const rows = items.filter((item) => item.message_id && !seen.has(item.message_id)).map((item) => {
        seen.add(item.message_id);
        return normalize(item, target);
      });
      allNew.push(...rows);
      totalNew += rows.length;
      chatNew += rows.length;
      for (const row of rows) {
        if (row.createDate) touchedDates.add(row.createDate);
      }

      if (!args["dry-run"]) {
        const byDate = new Map();
        for (const row of rows) {
          const date = row.createDate || localDate(Date.now());
          const dateRows = byDate.get(date) || [];
          dateRows.push(row);
          byDate.set(date, dateRows);
        }
        for (const [date, dateRows] of byDate.entries()) {
          appendJsonl(path.resolve(dir, "daily", date, `${target.chatId}.jsonl`), dateRows);
        }
        appendJsonl(path.resolve(dir, "messages.jsonl"), rows);
        await upsertMessagesToDb(dir, rows);
      }
      console.log(`[sync] page=${page} scanned=${items.length} new=${rows.length}`);
      pageToken = data.has_more ? data.page_token : "";
      if (args["max-pages"] && page >= Number(args["max-pages"])) break;
    } while (pageToken);

    if (!args["dry-run"]) {
      const lastMessageTimeMs = allNew.reduce((max, row) => Math.max(max, row.createTimeMs || 0), 0);
      writeJsonAtomic(statePath, {
        chatId: target.chatId,
        projectId: target.group.projectId || "",
        highWatermarkMs: Math.max(lastMessageTimeMs, window.endMs),
        lastMessageTimeMs,
        lastSyncedAt: new Date().toISOString(),
        lastWindow: { startMs: window.startMs, endMs: window.endMs, start: localIso(window.startMs), end: localIso(window.endMs) }
      });
      await writeSyncChatRun(dir, {
        runId,
        chatId: target.chatId,
        projectId: target.group.projectId || "",
        projectName: target.group.projectName || target.group.groupName || "",
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        scannedCount: chatScanned,
        newCount: chatNew,
        pageCount: page,
        status: "success"
      });
    }
  }

  console.log(`[done] chats=${targets.length} scanned=${totalScanned} new=${totalNew} dir=${dir}`);
  if (args["write-report"] && !args["dry-run"]) {
    const dates = touchedDates.size ? [...touchedDates].sort() : [args.date || localDate(Date.now())];
    for (const date of dates) {
      await report({ ...args, date, write: true, silent: true });
    }
  }
  if (!args["dry-run"]) {
    const storageStatus = await writeStorageStatus(dir);
    await writeSyncRun(dir, {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "success",
      triggerName: args.trigger || "manual",
      chatCount: targets.length,
      scannedCount: totalScanned,
      newCount: totalNew,
      messageCountAfter: storageStatus.messageCount,
      meta: { chats: targets.length, scanned: totalScanned, newMessages: totalNew, dir }
    });
  }
  return { chats: targets.length, scanned: totalScanned, newMessages: totalNew, dir };
  } catch (error) {
    if (!args["dry-run"]) {
      const storageStatus = await readStorageStatus(dir);
      await writeSyncRun(dir, {
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        triggerName: args.trigger || "manual",
        chatCount: targets.length,
        scannedCount: totalScanned,
        newCount: totalNew,
        messageCountAfter: storageStatus.messageCount,
        error: error.message,
        meta: { args }
      });
    }
    throw error;
  }
}

async function backfill(args) {
  const dir = archiveDir(args);
  const targets = collectTargets(args);
  if (!targets.length) throw new Error("没有可回补的群，请检查 groups.json 或传 --chat-id");
  const token = await tenantToken();
  const window = resolveBackfillWindow(args);
  const chunkHours = Number(args["chunk-hours"] || 24);
  const chunkMs = chunkHours * 60 * 60 * 1000;
  let totalScanned = 0;
  let totalNew = 0;
  const touchedDates = new Set();

  for (const target of targets) {
    let cursor = window.startMs;
    while (cursor < window.endMs) {
      const endMs = Math.min(cursor + chunkMs - 1, window.endMs);
      const seen = await existingIds(dir, target.chatId, cursor, endMs);
      let pageToken = "";
      let page = 0;
      let chunkScanned = 0;
      let chunkNew = 0;
      console.log(`[backfill] ${target.chatId} ${localIso(cursor)} ~ ${localIso(endMs)}`);
      do {
        page += 1;
        const data = await listMessages(token, {
          chatId: target.chatId,
          startMs: cursor,
          endMs,
          pageToken,
          pageSize: Number(args["page-size"] || 50)
        });
        const items = data.items || [];
        totalScanned += items.length;
        chunkScanned += items.length;
        const rows = items
          .filter((item) => item.message_id && !seen.has(item.message_id))
          .map((item) => {
            seen.add(item.message_id);
            return normalize(item, target);
          });
        totalNew += rows.length;
        chunkNew += rows.length;
        for (const row of rows) {
          if (row.createDate) touchedDates.add(row.createDate);
        }
        if (!args["dry-run"]) {
          const byDate = new Map();
          for (const row of rows) {
            const date = row.createDate || localDate(Date.now());
            const dateRows = byDate.get(date) || [];
            dateRows.push(row);
            byDate.set(date, dateRows);
          }
          for (const [date, dateRows] of byDate.entries()) {
            appendJsonl(path.resolve(dir, "daily", date, `${target.chatId}.jsonl`), dateRows);
          }
          appendJsonl(path.resolve(dir, "messages.jsonl"), rows);
          await upsertMessagesToDb(dir, rows);
        }
        console.log(`[backfill] page=${page} scanned=${items.length} new=${rows.length}`);
        pageToken = data.has_more ? data.page_token : "";
        if (args["max-pages"] && page >= Number(args["max-pages"])) break;
      } while (pageToken);
      console.log(`[backfill] chunk scanned=${chunkScanned} new=${chunkNew}`);
      cursor = endMs + 1;
    }
  }

  console.log(`[done] backfill chats=${targets.length} scanned=${totalScanned} new=${totalNew} dir=${dir}`);
  if (args["write-report"] && !args["dry-run"]) {
    const dates = touchedDates.size ? [...touchedDates].sort() : datesBetween(window.startMs, window.endMs);
    for (const date of dates) {
      await report({ ...args, date, write: true, silent: true });
    }
  }
  if (!args["dry-run"]) await writeStorageStatus(dir);
}

function defaultProjectIdForChat(chat) {
  return `chat-${String(chat.chat_id || "").replace(/^oc_/, "").slice(0, 10) || "unknown"}`;
}

async function discoverGroups(args) {
  const token = await tenantToken();
  const groupsPath = path.resolve(process.env.GROUPS_CONFIG || "./groups.json");
  const groups = readGroups();
  const discovered = [];
  let pageToken = "";
  let page = 0;
  try {
    do {
      page += 1;
      const data = await listChats(token, { pageToken, pageSize: Number(args["page-size"] || 50) });
      const items = data.items || [];
      discovered.push(...items);
      pageToken = data.has_more ? data.page_token : "";
      if (args["max-pages"] && page >= Number(args["max-pages"])) break;
    } while (pageToken);
  } catch (error) {
    if (args.soft) {
      const summary = {
        ok: false,
        soft: true,
        error: error.message,
        hint: "需要开通 im:chat:readonly 或 im:chat.group_info:readonly 后，才能自动发现 qz 已加入的群。"
      };
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    throw error;
  }

  const added = [];
  const updated = [];
  for (const chat of discovered) {
    if (!chat.chat_id) continue;
    const existing = groups[chat.chat_id];
    if (existing) {
      const next = {
        ...existing,
        groupName: existing.groupName || chat.name || existing.projectName || "",
        chatName: existing.chatName || chat.name || "",
        external: chat.external === undefined ? existing.external : chat.external
      };
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        groups[chat.chat_id] = next;
        updated.push({ chatId: chat.chat_id, name: chat.name || next.groupName });
      }
      continue;
    }
    const projectName = args["project-name"] || chat.name || "未命名飞书群";
    const projectId = args["project-id"] || defaultProjectIdForChat(chat);
    groups[chat.chat_id] = {
      projectId,
      projectName,
      groupName: chat.name || projectName,
      chatName: chat.name || projectName,
      enabled: true,
      external: chat.external === true,
      discoveredAt: new Date().toISOString()
    };
    added.push({ chatId: chat.chat_id, name: chat.name || projectName, projectId, projectName });
  }

  if (args.write) {
    writeJsonAtomic(groupsPath, groups);
  }
  const summary = {
    ok: true,
    discovered: discovered.length,
    added: added.length,
    updated: updated.length,
    wrote: Boolean(args.write),
    groupsPath,
    added,
    updated
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function resolveUsers(args) {
  const dir = archiveDir(args);
  const rows = await readAllMessages(dir);
  const peoplePath = path.resolve(process.env.PEOPLE_CONFIG || "./people.json");
  const people = readPeople();
  const ids = new Set();
  for (const row of rows) {
    if (row.sender?.idType === "open_id" && row.sender?.id) ids.add(row.sender.id);
    for (const mention of row.mentions || []) {
      if (mention.id_type === "open_id" && mention.id) ids.add(mention.id);
    }
  }
  const pending = [...ids].filter((id) => args.force || !people[id]?.name || people[id]?.nameSource !== "feishu_contact_api");
  if (!pending.length) {
    const storageSync = args.write === false ? null : await syncPeopleToStorage(people);
    const summary = { scannedOpenIds: ids.size, requested: 0, resolved: 0, failed: [], outputPath: peoplePath, storageSync };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  const token = await tenantToken();
  let basicProfiles = new Map();
  const resolved = {};
  const failed = [];
  const departmentFailed = [];
  const departmentCache = new Map();
  let permissionError = "";
  let basicProfileError = "";
  const basicDisplayName = (id) => {
    const user = basicProfiles.get(id) || {};
    const i18n = user.i18n_name || {};
    return user.name || user.nickname || user.en_name || i18n.zh_cn || i18n.en_us || i18n.ja_jp || "";
  };
  const writeResolvedUser = async (id, detailUser = {}, source = "feishu_contact_api") => {
    const existing = people[id] || {};
    const departmentIds = Array.isArray(detailUser.department_ids) ? detailUser.department_ids.filter(Boolean) : [];
    const departments = await resolveDepartmentNames(token, departmentIds, departmentCache);
    departmentFailed.push(...departments.failed.map((item) => ({ userId: id, ...item })));
    const team = departments.names.length ? departments.names.join(" / ") : departmentIds.join(",") || existing.team || "";
    const displayName =
      detailUser.name ||
      detailUser.nickname ||
      detailUser.en_name ||
      basicDisplayName(id);
    if (!displayName) return false;
    resolved[id] = {
      ...existing,
      name: displayName,
      team,
      openId: detailUser.open_id || id,
      userId: detailUser.user_id || existing.userId || "",
      unionId: detailUser.union_id || existing.unionId || "",
      email: detailUser.email || existing.email || "",
      departmentIds,
      departmentNames: departments.names,
      role: existing.role && !["external", "expert", "unmarked"].includes(existing.role) ? existing.role : "internal",
      isInternal: true,
      nameSource: source,
      identitySource: source,
      departmentSource: departments.names.length ? "feishu_contact_api" : existing.departmentSource || "",
      resolvedAt: new Date().toISOString()
    };
    return true;
  };
  try {
    basicProfiles = await basicBatchUsers(token, pending);
  } catch (error) {
    basicProfileError = error.message;
    if (basicProfileError.includes("code=99991672")) permissionError = basicProfileError;
  }
  for (const id of pending) {
    try {
      const data = await getUser(token, id);
      const user = data.user || {};
      const ok = await writeResolvedUser(id, user, "feishu_contact_api");
      if (!ok) {
        failed.push({ id, reason: basicProfileError || "empty_user_name" });
      }
    } catch (error) {
      const reason = error.message;
      if (basicDisplayName(id)) {
        const ok = await writeResolvedUser(id, { open_id: id }, "feishu_basic_profile_api");
        if (ok) continue;
      }
      failed.push({ id, reason });
      if (reason.includes("code=99991672")) {
        permissionError = reason;
        break;
      }
    }
  }
  const next = { ...people, ...resolved };
  const outputPath = path.resolve(args.output || peoplePath);
  if (args.write !== false) {
    ensureDir(path.dirname(outputPath));
    writeJsonAtomic(outputPath, next);
  }
  const storageSync =
    args.write === false ? null : await syncPeopleToStorage(next, new Set(Object.keys(resolved)));
  const summary = {
    scannedOpenIds: ids.size,
    requested: pending.length,
    resolved: Object.keys(resolved).length,
    failed,
    departmentFailed,
    departmentResolved: [...departmentCache.values()].filter((item) => item.ok).length,
    basicProfileResolved: basicProfiles.size,
    basicProfileError,
    permissionError,
    outputPath,
    storageSync,
    note: "用户身份来自飞书通讯录接口；优先使用用户详情接口拿部门，同时用 basic_batch 补姓名。接口能查到的 open_id 会直接写回为内部身份，并把 department_ids 翻译成部门名称写入 team/departmentNames。失败通常是应用缺少通讯录读取权限、缺少 contact:user.basic_profile:readonly，或该用户不在可见通讯录中。"
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function upsertInternalPerson(payload = {}) {
  const id = String(payload.id || payload.openId || "").trim();
  if (!id || id === "unknown") throw new Error("请提供有效的 open_id/user_id");
  const peoplePath = path.resolve(process.env.PEOPLE_CONFIG || "./people.json");
  const people = readPeople();
  const existing = people[id] || {};
  const name = String(payload.name || existing.name || "").trim();
  if (!name) throw new Error("请提供姓名");
  const allowedRoles = new Set(["expert", "internal", "operator", "reviewer", "pm", "bot"]);
  const role = allowedRoles.has(payload.role) ? payload.role : "internal";
  const isInternal = INTERNAL_ROLES.has(role);
  const next = {
    ...people,
    [id]: {
      ...existing,
      name,
      team: String(payload.team || existing.team || "").trim(),
      role,
      isInternal,
      nameSource: existing.nameSource === "feishu_contact_api" ? existing.nameSource : "manual_input",
      identitySource: "manual_input",
      updatedAt: new Date().toISOString()
    }
  };
  writeJsonAtomic(peoplePath, next);
  const storageSync = await syncPeopleToStorage(next, new Set([id]));
  return { id, person: next[id], outputPath: peoplePath, storageSync };
}

async function removeInternalPerson(payload = {}) {
  const id = String(payload.id || payload.openId || "").trim();
  if (!id || id === "unknown") throw new Error("请提供有效的 open_id/user_id");
  const peoplePath = path.resolve(process.env.PEOPLE_CONFIG || "./people.json");
  const people = readPeople();
  const existing = people[id] || {};
  if (!existing.name) throw new Error("people.json 中没有这个人的身份记录");
  const next = {
    ...people,
    [id]: {
      ...existing,
      role: "expert",
      isInternal: false,
      identitySource: "manual_input",
      updatedAt: new Date().toISOString()
    }
  };
  writeJsonAtomic(peoplePath, next);
  const storageSync = await syncPeopleToStorage(next, new Set([id]));
  return { id, person: next[id], outputPath: peoplePath, storageSync };
}

function summarize(rows, extra = {}) {
  const byHour = {};
  const byMsgType = {};
  const bySender = {};
  const messageById = extra.messageById || new Map(rows.map((row) => [row.messageId, row]));
  const replyEdges = [];
  let questionCount = 0;
  let unresolvedReplyCount = 0;
  for (const row of rows) {
    const hour = row.createTime ? row.createTime.slice(11, 13) : "unknown";
    byHour[hour] = (byHour[hour] || 0) + 1;
    byMsgType[row.msgType || "unknown"] = (byMsgType[row.msgType || "unknown"] || 0) + 1;
    const sender = row.sender?.id || "unknown";
    bySender[sender] = (bySender[sender] || 0) + 1;
    if (/[?？]|(吗|么|啥|什么|怎么|为什么|是否|有没有|谁|何时|什么时候|多少|哪里|哪儿)/.test(row.text || "")) questionCount += 1;
    const parentId = row.replyToMessageId || row.parentId || "";
    if (parentId) {
      const parent = messageById.get(parentId);
      if (!parent) unresolvedReplyCount += 1;
      replyEdges.push({
        replyMessageId: row.messageId,
        replyTime: row.createTime,
        replier: row.sender?.id || "unknown",
        replierType: row.sender?.senderType || "",
        replyText: row.text || "",
        parentMessageId: parentId,
        parentTime: parent?.createTime || "",
        parentSender: parent?.sender?.id || "",
        parentSenderType: parent?.sender?.senderType || "",
        parentText: parent?.text || "",
        latencySeconds:
          parent?.createTimeMs && row.createTimeMs ? Math.max(0, Math.round((row.createTimeMs - parent.createTimeMs) / 1000)) : null
      });
    }
  }
  const { messageById: _messageById, ...cleanExtra } = extra;
  return {
    ...cleanExtra,
    messageCount: rows.length,
    uniqueSenderCount: Object.keys(bySender).length,
    questionCount,
    replyCount: replyEdges.length,
    unresolvedReplyCount,
    byHour,
    byMsgType,
    replyEdges,
    topSenders: Object.entries(bySender)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([sender, count]) => ({ sender, count }))
  };
}

async function loadMessageIndex(dir) {
  const messageById = new Map();
  for (const row of await readAllMessages(dir)) {
    if (row.messageId) messageById.set(row.messageId, row);
  }
  return messageById;
}

function scanDailyMessages(dir) {
  const dailyRoot = path.resolve(dir, "daily");
  if (!fs.existsSync(dailyRoot)) return [];
  const rows = [];
  for (const date of fs.readdirSync(dailyRoot).sort()) {
    const dateDir = path.resolve(dailyRoot, date);
    if (!fs.statSync(dateDir).isDirectory()) continue;
    for (const file of fs.readdirSync(dateDir).filter((name) => name.endsWith(".jsonl")).sort()) {
      rows.push(...readJsonl(path.resolve(dateDir, file)));
    }
  }
  return rows;
}

function readMessagesFromFiles(dir) {
  const primary = readJsonl(path.resolve(dir, "messages.jsonl"));
  const rows = primary.length ? primary : scanDailyMessages(dir);
  const byId = new Map();
  for (const row of rows) {
    const key = row.messageId || `${row.chatId}-${row.createTimeMs}-${row.text}`;
    if (!byId.has(key)) byId.set(key, row);
  }
  return [...byId.values()].sort((a, b) => Number(a.createTimeMs || 0) - Number(b.createTimeMs || 0));
}

async function readMessagesFromDb(dir, filters = {}) {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (!config.ok) return [];
    await initByteHouse();
    const where = [];
    if (filters.chatId) where.push(`chat_id=${sqlQuote(filters.chatId)}`);
    if (filters.projectId) where.push(`project_id=${sqlQuote(filters.projectId)}`);
    if (filters.messageId) where.push(`message_id=${sqlQuote(filters.messageId)}`);
    if (filters.senderId) where.push(`sender_id=${sqlQuote(filters.senderId)}`);
    if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
      where.push(`sender_id IN (${filters.senderIds.map(sqlQuote).join(",")})`);
    }
    if (filters.date) where.push(`create_date=${sqlQuote(filters.date)}`);
    if (filters.startMs) where.push(`create_time_ms>=${Number(filters.startMs)}`);
    if (filters.endMs) where.push(`create_time_ms<=${Number(filters.endMs)}`);
    if (filters.q) where.push(`positionCaseInsensitive(text, ${sqlQuote(filters.q)}) > 0`);
    if (filters.senderQ) {
      const senderClauses = [`positionCaseInsensitive(sender_id, ${sqlQuote(filters.senderQ)}) > 0`];
      if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
        senderClauses.push(`sender_id IN (${filters.senderIds.map(sqlQuote).join(",")})`);
      }
      where.push(`(${senderClauses.join(" OR ")})`);
    }
    if (filters.metaQ) {
      const meta = sqlQuote(filters.metaQ);
      where.push(
        `(positionCaseInsensitive(group_name, ${meta}) > 0 OR positionCaseInsensitive(project_name, ${meta}) > 0 OR positionCaseInsensitive(message_id, ${meta}) > 0 OR positionCaseInsensitive(msg_type, ${meta}) > 0 OR positionCaseInsensitive(chat_id, ${meta}) > 0)`
      );
    }
    const pageSize = Math.max(100, Math.min(20_000, Number(process.env.BYTEHOUSE_READ_PAGE_SIZE || 5000)));
    const requestedLimit = Math.max(0, Math.min(20_000, Number(filters.limit || 0)));
    const requestedOffset = Math.max(0, Number(filters.offset || 0));
    const queryLimit = requestedLimit ? requestedLimit + requestedOffset : pageSize;
    const orderDir = filters.orderDesc ? "DESC" : "ASC";
    const table = byteHouseTable(config.tables.messages);
    const byKey = new Map();
    let cursorMs = -1;
    let cursorKey = "";
    const narrowRead = Boolean(
      filters.chatId || filters.projectId || filters.messageId || filters.senderId || filters.date || filters.startMs || filters.endMs
    );
    const includeContent = filters.includeContent === false ? false : narrowRead || filters.q || filters.limit || filters.includeContent;
    const contentSelect = includeContent ? "content_json" : "'{}' AS content_json";
    for (;;) {
      const pageWhere = [...where];
      if (cursorMs >= 0) {
        pageWhere.push(`(create_time_ms>${cursorMs} OR (create_time_ms=${cursorMs} AND message_key>${sqlQuote(cursorKey)}))`);
      }
      const whereSql = pageWhere.length ? ` WHERE ${pageWhere.join(" AND ")}` : "";
      const rows = await byteHouseQueryRows(
        `SELECT
          message_key,
          message_id,
          chat_id,
          project_id,
          project_name,
          group_name,
          create_time_ms,
          create_time,
          create_date,
          sender_id,
          sender_id_type,
          sender_type,
          sender_tenant_key,
          msg_type,
          is_reply,
          reply_to_message_id,
          thread_root_message_id,
          text,
          mentions_json,
          ${contentSelect}
        FROM ${table}${whereSql}
        ORDER BY create_time_ms ${orderDir}, message_key ${orderDir}
        LIMIT ${queryLimit}`
      );
      if (!rows.length) break;
      for (const row of rows) {
        byKey.set(row.message_key, {
          messageId: row.message_id || "",
          projectId: row.project_id || "",
          projectName: row.project_name || "",
          groupName: row.group_name || "",
          chatId: row.chat_id || "",
          msgType: row.msg_type || "",
          isReply: Boolean(Number(row.is_reply || 0)),
          replyToMessageId: row.reply_to_message_id || "",
          threadRootMessageId: row.thread_root_message_id || "",
          createTimeMs: Number(row.create_time_ms || 0),
          createTime: row.create_time || "",
          createDate: row.create_date || "",
          sender: {
            id: row.sender_id || "",
            idType: row.sender_id_type || "",
            senderType: row.sender_type || "",
            tenantKey: row.sender_tenant_key || ""
          },
          mentions: parseJsonValue(row.mentions_json, []),
          text: row.text || "",
          content: parseJsonValue(row.content_json, {})
        });
      }
      const last = rows[rows.length - 1];
      cursorMs = Number(last.create_time_ms || 0);
      cursorKey = String(last.message_key || "");
      if (requestedLimit) break;
      if (rows.length < pageSize) break;
    }
    const values = [...byKey.values()];
    return requestedLimit ? values.slice(requestedOffset, requestedOffset + requestedLimit) : values;
  }
  if (!fs.existsSync(sqlitePath(dir))) return [];
  initDatabase(dir);
  const where = [];
  if (filters.chatId) where.push(`chat_id=${sqliteQuote(filters.chatId)}`);
  if (filters.projectId) where.push(`project_id=${sqliteQuote(filters.projectId)}`);
  if (filters.messageId) where.push(`message_id=${sqliteQuote(filters.messageId)}`);
  if (filters.senderId) where.push(`sender_id=${sqliteQuote(filters.senderId)}`);
  if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
    where.push(`sender_id IN (${filters.senderIds.map(sqliteQuote).join(",")})`);
  }
  if (filters.date) where.push(`create_date=${sqliteQuote(filters.date)}`);
  if (filters.startMs) where.push(`create_time_ms>=${Number(filters.startMs)}`);
  if (filters.endMs) where.push(`create_time_ms<=${Number(filters.endMs)}`);
  if (filters.q) where.push(`raw_json LIKE ${sqliteQuote(`%${filters.q}%`)}`);
  if (filters.senderQ) {
    const senderClauses = [`sender_id LIKE ${sqliteQuote(`%${filters.senderQ}%`)}`];
    if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
      senderClauses.push(`sender_id IN (${filters.senderIds.map(sqliteQuote).join(",")})`);
    }
    where.push(`(${senderClauses.join(" OR ")})`);
  }
  if (filters.metaQ) where.push(`raw_json LIKE ${sqliteQuote(`%${filters.metaQ}%`)}`);
  const requestedLimit = Math.max(0, Math.min(20_000, Number(filters.limit || 0)));
  const requestedOffset = Math.max(0, Number(filters.offset || 0));
  const orderDir = filters.orderDesc ? "DESC" : "ASC";
  const limitSql = requestedLimit ? ` LIMIT ${requestedLimit} OFFSET ${requestedOffset}` : "";
  const rows = sqliteQueryJson(
    dir,
    `SELECT raw_json FROM messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY create_time_ms ${orderDir}, message_id ${orderDir}${limitSql};`
  );
  return rows
    .map((row) => {
      try {
        return JSON.parse(row.raw_json);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function countMessagesFromDb(dir, filters = {}) {
  if (isByteHouseProvider()) {
    const config = byteHouseConfig();
    if (!config.ok) return null;
    await initByteHouse();
    const where = [];
    if (filters.chatId) where.push(`chat_id=${sqlQuote(filters.chatId)}`);
    if (filters.projectId) where.push(`project_id=${sqlQuote(filters.projectId)}`);
    if (filters.senderId) where.push(`sender_id=${sqlQuote(filters.senderId)}`);
    if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
      where.push(`sender_id IN (${filters.senderIds.map(sqlQuote).join(",")})`);
    }
    if (filters.date) where.push(`create_date=${sqlQuote(filters.date)}`);
    if (filters.startMs) where.push(`create_time_ms>=${Number(filters.startMs)}`);
    if (filters.endMs) where.push(`create_time_ms<=${Number(filters.endMs)}`);
    if (filters.q) where.push(`positionCaseInsensitive(text, ${sqlQuote(filters.q)}) > 0`);
    if (filters.senderQ) {
      const senderClauses = [`positionCaseInsensitive(sender_id, ${sqlQuote(filters.senderQ)}) > 0`];
      if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
        senderClauses.push(`sender_id IN (${filters.senderIds.map(sqlQuote).join(",")})`);
      }
      where.push(`(${senderClauses.join(" OR ")})`);
    }
    if (filters.metaQ) {
      const meta = sqlQuote(filters.metaQ);
      where.push(
        `(positionCaseInsensitive(group_name, ${meta}) > 0 OR positionCaseInsensitive(project_name, ${meta}) > 0 OR positionCaseInsensitive(message_id, ${meta}) > 0 OR positionCaseInsensitive(msg_type, ${meta}) > 0 OR positionCaseInsensitive(chat_id, ${meta}) > 0)`
      );
    }
    const rows = await byteHouseQueryRows(
      `SELECT count(DISTINCT message_key) AS count
       FROM ${byteHouseTable(config.tables.messages)}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`
    );
    return Number(rows?.[0]?.count || 0);
  }
  if (!fs.existsSync(sqlitePath(dir))) return null;
  initDatabase(dir);
  const where = [];
  if (filters.chatId) where.push(`chat_id=${sqliteQuote(filters.chatId)}`);
  if (filters.projectId) where.push(`project_id=${sqliteQuote(filters.projectId)}`);
  if (filters.senderId) where.push(`sender_id=${sqliteQuote(filters.senderId)}`);
  if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
    where.push(`sender_id IN (${filters.senderIds.map(sqliteQuote).join(",")})`);
  }
  if (filters.date) where.push(`create_date=${sqliteQuote(filters.date)}`);
  if (filters.startMs) where.push(`create_time_ms>=${Number(filters.startMs)}`);
  if (filters.endMs) where.push(`create_time_ms<=${Number(filters.endMs)}`);
  if (filters.q) where.push(`raw_json LIKE ${sqliteQuote(`%${filters.q}%`)}`);
  if (filters.senderQ) {
    const senderClauses = [`sender_id LIKE ${sqliteQuote(`%${filters.senderQ}%`)}`];
    if (Array.isArray(filters.senderIds) && filters.senderIds.length) {
      senderClauses.push(`sender_id IN (${filters.senderIds.map(sqliteQuote).join(",")})`);
    }
    where.push(`(${senderClauses.join(" OR ")})`);
  }
  if (filters.metaQ) where.push(`raw_json LIKE ${sqliteQuote(`%${filters.metaQ}%`)}`);
  const rows = sqliteQueryJson(dir, `SELECT count(*) AS count FROM messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""};`);
  return Number(rows?.[0]?.count || 0);
}

async function readAggregateMetricsFromDb(dir, filters = {}) {
  if (!isByteHouseProvider()) return null;
  const config = byteHouseConfig();
  if (!config.ok) return null;
  await initByteHouse();
  const table = byteHouseTable(config.tables.messages);
  const where = [];
  if (filters.chatId) where.push(`chat_id=${sqlQuote(filters.chatId)}`);
  if (filters.projectId) where.push(`project_id=${sqlQuote(filters.projectId)}`);
  if (filters.senderId) where.push(`sender_id=${sqlQuote(filters.senderId)}`);
  if (Array.isArray(filters.senderIds) && filters.senderIds.length) where.push(`sender_id IN (${filters.senderIds.map(sqlQuote).join(",")})`);
  if (filters.date) where.push(`create_date=${sqlQuote(filters.date)}`);
  if (filters.startMs) where.push(`create_time_ms>=${Number(filters.startMs)}`);
  if (filters.endMs) where.push(`create_time_ms<=${Number(filters.endMs)}`);
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const [summaryRows, dateRows, hourRows, dateHourRows, typeRows, senderRows, projectRows, chatRows] = await Promise.all([
    byteHouseQueryRows(
      `SELECT
        count(DISTINCT message_key) AS messageCount,
        uniqExactIf(sender_id, sender_id!='') AS uniqueSenderCount,
        uniqExactIf(message_key, is_reply=1) AS replyCount,
        count(DISTINCT create_date) AS activeDayCount,
        min(create_time) AS firstTime,
        max(create_time) AS lastTime
      FROM ${table}${whereSql}`
    ),
    byteHouseQueryRows(`SELECT create_date AS date, count(DISTINCT message_key) AS count FROM ${table}${whereSql} GROUP BY create_date ORDER BY create_date ASC`),
    byteHouseQueryRows(`SELECT substring(create_time, 12, 2) AS slot, count(DISTINCT message_key) AS count FROM ${table}${whereSql} GROUP BY slot ORDER BY slot ASC`),
    byteHouseQueryRows(
      `SELECT create_date AS date, substring(create_time, 12, 2) AS slot, count(DISTINCT message_key) AS count
      FROM ${table}${whereSql} GROUP BY create_date, slot ORDER BY create_date ASC, slot ASC`
    ),
    byteHouseQueryRows(`SELECT msg_type AS key, count(DISTINCT message_key) AS count FROM ${table}${whereSql} GROUP BY msg_type ORDER BY count DESC`),
    byteHouseQueryRows(
      `SELECT
        sender_id AS senderId,
        any(sender_type) AS senderType,
        count(DISTINCT message_key) AS messageCount,
        uniqExactIf(message_key, is_reply=1) AS replyCount,
        uniqExactIf(message_key, ${questionLikeSql("text")}) AS questionCount,
        count(DISTINCT create_date) AS activeDays,
        min(create_time) AS firstTime,
        max(create_time) AS lastTime
      FROM ${table}${whereSql}
      GROUP BY sender_id
      ORDER BY messageCount DESC
      LIMIT 500`
    ),
    byteHouseQueryRows(`SELECT any(project_name) AS key, count(DISTINCT message_key) AS count FROM ${table}${whereSql} GROUP BY project_id ORDER BY count DESC`),
    byteHouseQueryRows(`SELECT any(group_name) AS key, count(DISTINCT message_key) AS count FROM ${table}${whereSql} GROUP BY chat_id ORDER BY count DESC`)
  ]);
  const summary = summaryRows[0] || {};
  const people = readPeople();
  const staff = senderRows.map((row) => {
    const info = personInfo({ id: row.senderId || "", senderType: row.senderType || "" }, people);
    return {
      ...info,
      messageCount: Number(row.messageCount || 0),
      replyCount: Number(row.replyCount || 0),
      handledQuestionCount: 0,
      questionCount: Number(row.questionCount || 0),
      activeDays: Number(row.activeDays || 0),
      firstTime: row.firstTime || "",
      lastTime: row.lastTime || "",
      avgLatencySeconds: null,
      replyRatio: row.messageCount ? Math.round((Number(row.replyCount || 0) / Number(row.messageCount || 1)) * 100) : 0,
      groupBreakdown: [],
      messageTypeRows: [],
      recentMessages: []
    };
  });
  const byDateHour = {};
  for (const row of dateHourRows) {
    const date = row.date || "";
    if (!date) continue;
    if (!byDateHour[date]) byDateHour[date] = [];
    byDateHour[date].push({ slot: row.slot || "unknown", count: Number(row.count || 0) });
  }
  const hourlyMessageCount = hourRows.map((row) => ({ slot: row.slot || "unknown", count: Number(row.count || 0) }));
  const messageTypeRows = typeRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) }));
  const internalStaff = staff.filter((row) => row.isInternal);
  return {
    messageCount: Number(summary.messageCount || 0),
    firstTime: summary.firstTime || "",
    lastTime: summary.lastTime || "",
    activeDayCount: Number(summary.activeDayCount || 0),
    uniqueSenderCount: Number(summary.uniqueSenderCount || staff.length || 0),
    internalSenderCount: internalStaff.length,
    expertQuestionCount: 0,
    questionCount: 0,
    questionCandidateCount: 0,
    analysisCandidateCount: 0,
    replyCount: Number(summary.replyCount || 0),
    unresolvedIssueCount: 0,
    unansweredQuestionCount: 0,
    avgFirstResponseSeconds: null,
    avgResolutionSeconds: null,
    avgReplySeconds: null,
    p90FirstResponseSeconds: null,
    p90ResolutionSeconds: null,
    p90ReplySeconds: null,
    slaHitRate: null,
    overSlaCount: null,
    faqHitRate: null,
    duplicateRate: null,
    oneShotResolveRate: null,
    totalWorkloadMinutes: null,
    dataAuthenticity: {
      rawMessageCount: Number(summary.messageCount || 0),
      deterministicFields: ["消息量", "消息类型分布", "发送人活跃", "回复字段", "真实时间分布"],
      separationRule: "动态指标接口只展示飞书原始事实和可验证聚合，不生成规则候选、优先级或排班估算。"
    },
    identitySourceCounts: objectCountsToRows(
      staff.reduce((acc, row) => {
        acc[row.nameSource || "unknown"] = (acc[row.nameSource || "unknown"] || 0) + 1;
        return acc;
      }, {})
    ),
    priorityCounts: [],
    categoryCounts: [],
    finalStatusCounts: [],
    hourlyStaffing: [],
    calibrationMetrics: { method: "未运行 AI/人工判定前，不计算标准耗时校准。", byPriority: [], byCategory: [] },
    projectEvents: [],
    projectEventImpacts: [],
    ruleDraft: {
      source: "disabled_for_real_metrics_endpoint",
      warning: "动态指标接口只返回入库事实聚合，不生成规则候选、优先级、SLA 或排班估算。",
      questionCandidates: [],
      candidateCount: 0,
      explicitReplyCandidateCount: 0,
      avgExplicitReplyCandidateSeconds: null,
      priorityCounts: [],
      categoryCounts: [],
      hourlyStaffing: [],
      calibrationMetrics: { method: "未运行 AI/人工判定前，不计算标准耗时校准。", byPriority: [], byCategory: [] },
      projectEventImpacts: [],
      totalWorkloadMinutes: null
    },
    coreMetricSummary: {
      hourlyMessageCount,
      hourlyQuestionCandidateCount: [],
      messageTypeDistribution: messageTypeRows,
      identitySourceDistribution: [],
      replyEdgeCount: Number(summary.replyCount || 0),
      avgExplicitReplySeconds: null,
      p90ExplicitReplySeconds: null,
      ruleCandidateCount: 0
    },
    issues: [],
    analysisCandidates: [],
    questionCandidates: [],
    unresolvedIssues: [],
    byDate: dateRows.map((row) => ({ date: row.date || "", count: Number(row.count || 0) })),
    byDateHour,
    byHour: Object.fromEntries(hourRows.map((row) => [row.slot || "unknown", Number(row.count || 0)])),
    byMsgType: Object.fromEntries(typeRows.map((row) => [row.key || "unknown", Number(row.count || 0)])),
    messageTypeRows,
    byProject: projectRows.map((row) => ({ key: row.key || "未标注项目", count: Number(row.count || 0) })),
    byChat: chatRows.map((row) => ({ key: row.key || "unknown", count: Number(row.count || 0) })),
    projectBreakdown: projectRows.map((row) => ({ key: row.key || "未标注项目", count: Number(row.count || 0) })),
    topTerms: [],
    staff,
    internalStaff,
    replyEdges: [],
    messages: []
  };
}

async function readAllMessages(dir) {
  const dbRows = await readMessagesFromDb(dir);
  return dbRows.length ? dbRows : readMessagesFromFiles(dir);
}

async function importDatabase(args) {
  const dir = archiveDir(args);
  const rows = readMessagesFromFiles(dir);
  const imported = await upsertMessagesToDb(dir, rows);
  const status = await writeStorageStatus(dir);
  console.log(
    JSON.stringify(
      {
        imported,
        dbPath: status.path,
        messageCount: status.messageCount,
        firstMessageTime: status.firstMessageTime,
        lastMessageTime: status.lastMessageTime
      },
      null,
      2
    )
  );
  return status;
}

async function printDatabaseStatus(args) {
  const status = await readStorageStatus(archiveDir(args));
  console.log(JSON.stringify(status, null, 2));
  return status;
}

async function syncPeopleCommand() {
  const people = readPeople();
  const storageSync = await syncPeopleToStorage(people);
  const status = await readStorageStatus(archiveDir({}));
  const summary = {
    ok: true,
    peopleConfigCount: Object.keys(people || {}).length,
    storageSync,
    storage: {
      type: status.type,
      database: status.database,
      tablePrefix: status.tablePrefix,
      peopleCount: status.peopleCount || 0,
      internalPeopleCount: status.internalPeopleCount || 0,
      peopleUpdatedAt: status.peopleUpdatedAt || ""
    }
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function isQuestionText(text) {
  return /[?？]|(吗|么|啥|什么|怎么|为什么|是否|有没有|谁|何时|什么时候|多少|哪里|哪儿|干嘛|咋)/.test(text || "");
}

function personInfo(sender = {}, people = {}) {
  const id = sender.id || "unknown";
  const configured = people[id] || {};
  const senderType = sender.senderType || "";
  const role = configured.role || (senderType === "app" ? "bot" : configured.isInternal ? "internal" : "expert");
  const isInternal = configured.isInternal === true || INTERNAL_ROLES.has(role);
  return {
    id,
    name: configured.name || (id === "unknown" ? "未知发送者" : id),
    nameSource: configured.name ? configured.nameSource || "people_config" : id === "unknown" ? "empty_sender" : "raw_open_id",
    team: configured.team || "",
    role,
    isInternal,
    senderType
  };
}

function senderRoleLabel(role) {
  return (
    {
      expert: "专家",
      external: "专家",
      internal: "运营",
      operator: "运营",
      reviewer: "审核",
      pm: "PM",
      bot: "系统",
      system: "系统",
      unmarked: "专家"
    }[role] || role || "专家"
  );
}

function rangePresetRows(rows, nowMs) {
  const endMs = nowMs || Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const presets = [
    { key: "all", label: "全部", startMs: 0 },
    { key: "30d", label: "近30天", startMs: endMs - 30 * dayMs },
    { key: "14d", label: "近14天", startMs: endMs - 14 * dayMs },
    { key: "7d", label: "近7天", startMs: endMs - 7 * dayMs },
    { key: "3d", label: "近3天", startMs: endMs - 3 * dayMs },
    { key: "today", label: "今天", startMs: Date.parse(`${localDate(endMs)}T00:00:00+08:00`) }
  ];
  const presetRows = presets.map(({ key, label, startMs }) => {
    const filtered = startMs ? rows.filter((row) => Number(row.createTimeMs || 0) >= startMs) : rows;
    return { key, label, startMs: startMs || null, endMs, rows: filtered };
  });
  return presetRows;
}

function dashboardPresetRows(rows, nowMs) {
  const presets = rangePresetRows(rows, nowMs);
  if (process.env.DASHBOARD_BUILD_ALL_PERIODS === "1") return presets;
  return presets.filter((preset) => preset.key === "all");
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function topEntries(map, limit = 20) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

const ISSUE_CATEGORIES = [
  { id: "entry", name: "入项 / 报名", keywords: ["报名", "入项", "进项目", "测试", "入口", "加入", "申请"] },
  { id: "account", name: "权限 / 账号", keywords: ["登录", "账号", "权限", "打不开", "页面打不开", "异常", "无权限", "访问", "开通"] },
  { id: "task", name: "任务领取", keywords: ["任务", "放量", "领取", "没任务", "什么时候放", "今天有没有", "还有任务", "排期"] },
  {
    id: "operation",
    name: "操作使用",
    keywords: ["怎么用", "怎么弄", "咋弄", "咋样", "提交", "修改", "提交失败", "工具", "入口", "上传", "保存", "触发", "按钮", "页面"]
  },
  {
    id: "data_quality",
    name: "数据 / 附件 / Metadata",
    keywords: ["metadata", "meta", "附件", "清洗", "query", "badcase", "脏数据", "上游", "字段", "缺失", "重复", "哈希", "原图"]
  },
  {
    id: "model_tooling",
    name: "工具 / 模型生产",
    keywords: ["模型", "生产", "failed", "失败", "报错", "openrouter", "额度", "接口", "生成", "工具表", "重试", "超时"]
  },
  { id: "rule", name: "规则理解", keywords: ["规则", "标准", "怎么判", "case", "边界", "看不懂", "是否按", "区别", "为什么"] },
  { id: "review", name: "审核进度", keywords: ["审核", "多久", "进度", "什么时候出", "还没审核", "结果"] },
  { id: "rejection", name: "驳回 / 质检", keywords: ["驳回", "质检", "修改", "申诉", "为什么被", "不通过"] },
  { id: "settlement", name: "结算 / 费用", keywords: ["结算", "费用", "单价", "金额", "到账", "工资", "付款"] },
  { id: "announcement", name: "公告 / 信息确认", keywords: ["公告", "文档", "在哪", "新规则", "确认", "流程"] },
  { id: "risk", name: "情绪 / 投诉 / 风险", keywords: ["投诉", "不满", "催", "为什么没人", "垃圾", "离谱", "升级", "公开质疑"] }
];

const PRIORITIES = {
  P0: {
    label: "P0 紧急风险",
    definition: "影响大量专家或存在明显升级风险。",
    examples: ["系统故障", "大面积无法提交", "结算异常", "群内投诉发酵"],
    slaMinutes: 10,
    slaRange: "5-10 分钟",
    workMinutes: 15,
    responseMode: "必须人工看懂后优先回复，并同步升级接口。"
  },
  P1: {
    label: "P1 作业阻塞",
    definition: "影响专家继续完成任务。",
    examples: ["看不到任务", "无法提交", "规则不清导致不能做", "审核驳回不知道怎么改"],
    slaMinutes: 20,
    slaRange: "10-20 分钟",
    workMinutes: 6,
    responseMode: "必须人工确认，必要时拉复杂问题或升级接口处理。"
  },
  P2: {
    label: "P2 常规推进",
    definition: "不立即阻塞，但专家需要确认。",
    examples: ["审核多久", "什么时候放量", "是否入项成功", "任务还有没有"],
    slaMinutes: 60,
    slaRange: "30-60 分钟",
    workMinutes: 3,
    responseMode: "标准话术先答，人工抽检确认。"
  },
  P3: {
    label: "P3 重复 FAQ",
    definition: "FAQ/文档已覆盖，但专家仍然提问。",
    examples: ["入口在哪", "文档在哪", "单价多少", "流程怎么走"],
    slaMinutes: 60,
    slaRange: "60 分钟内或批量回复",
    workMinutes: 1,
    responseMode: "机器人命中 FAQ 或运营一键快捷回复。"
  }
};

const STAFFING_MODEL = {
  granularityMinutes: 60,
  effectiveWorkMinutesPerPerson: 45,
  targetUtilization: 0.8,
  formula: "所需人数 = 总工作量 ÷ 单人该时段有效工作分钟 ÷ 目标利用率"
};

const PROJECT_EVENT_TYPES = [
  {
    id: "recruiting_start",
    name: "招募开始",
    impact: "入项、报名、测试问题增加",
    categoryIds: ["entry", "announcement", "account"]
  },
  {
    id: "training_exam",
    name: "培训 / 考试",
    impact: "规则理解问题增加",
    categoryIds: ["rule", "operation", "announcement"]
  },
  {
    id: "task_release",
    name: "任务放量",
    impact: "操作、任务入口、作业问题增加",
    categoryIds: ["task", "operation", "rule"]
  },
  {
    id: "review_result_release",
    name: "审核结果释放",
    impact: "审核进度、驳回、申诉问题增加",
    categoryIds: ["review", "rejection", "risk"]
  },
  {
    id: "rule_change",
    name: "规则变更",
    impact: "规则争议、重复确认问题增加",
    categoryIds: ["rule", "announcement", "risk"]
  },
  {
    id: "settlement",
    name: "结算节点",
    impact: "费用、到账、金额问题增加",
    categoryIds: ["settlement", "risk"]
  }
];

function includesAny(text, words) {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function standardWorkMinuteRows() {
  return Object.entries(PRIORITIES).map(([priority, rule]) => ({
    priority,
    label: rule.label,
    definition: rule.definition,
    examples: rule.examples,
    slaMinutes: rule.slaMinutes,
    slaRange: rule.slaRange,
    standardWorkMinutes: rule.workMinutes,
    responseMode: rule.responseMode
  }));
}

function projectEventTypeMeta(value) {
  const text = String(value || "").trim().toLowerCase();
  return (
    PROJECT_EVENT_TYPES.find((item) => item.id.toLowerCase() === text || item.name.toLowerCase() === text) || {
      id: text || "custom",
      name: value || "自定义项目动作",
      impact: "需要人工填写影响",
      categoryIds: []
    }
  );
}

function parseLocalEventTime(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00+08:00`);
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return Date.parse(`${text.replace(/\s+/, "T")}${text.split(":").length === 2 ? ":00" : ""}+08:00`);
  }
  return parseTime(text);
}

function normalizeProjectEvents(rows) {
  return rows
    .map((event, index) => {
      const meta = projectEventTypeMeta(event.eventType || event.type || event.action || event.name);
      const eventTimeRaw = event.eventTime || event.time || event.startTime || event.date || "";
      const eventTimeMs = parseLocalEventTime(eventTimeRaw);
      const impactWindowHours = Number(event.impactWindowHours || event.windowHours || 48);
      return {
        eventId: event.eventId || event.id || `EV-${String(index + 1).padStart(4, "0")}`,
        projectId: event.projectId || "",
        projectName: event.projectName || "",
        chatId: event.chatId || "",
        groupName: event.groupName || "",
        eventType: meta.id,
        eventName: event.eventName || event.name || meta.name,
        eventTime: eventTimeMs ? localIso(eventTimeMs) : "",
        eventTimeMs,
        impact: event.impact || meta.impact,
        expectedImpact: event.expectedImpact || event.impact || meta.impact,
        relatedCategoryIds: event.relatedCategoryIds || event.categoryIds || meta.categoryIds,
        impactWindowHours,
        owner: event.owner || "",
        note: event.note || ""
      };
    })
    .sort((a, b) => Number(a.eventTimeMs || 0) - Number(b.eventTimeMs || 0));
}

function eventInRange(event, startMs, endMs) {
  if (!event.eventTimeMs) return true;
  return (!startMs || event.eventTimeMs >= startMs) && (!endMs || event.eventTimeMs <= endMs);
}

function eventMatchesProject(event, projectId) {
  if (!projectId || projectId === "all") return true;
  return !event.projectId || event.projectId === projectId;
}

function classifyIssue(text) {
  const lower = String(text || "").toLowerCase();
  const scored = ISSUE_CATEGORIES.map((category) => ({
    category,
    score: category.keywords.reduce((sum, word) => sum + (lower.includes(word.toLowerCase()) ? 1 : 0), 0)
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || ISSUE_CATEGORIES.indexOf(a.category) - ISSUE_CATEGORIES.indexOf(b.category));
  if (scored[0]) return scored[0].category;
  if (includesAny(lower, ["怎么", "咋", "如何", "哪里", "哪儿", "入口"])) return ISSUE_CATEGORIES.find((category) => category.id === "operation");
  if (includesAny(lower, ["为什么", "是否", "能不能", "是不是", "区别"])) return ISSUE_CATEGORIES.find((category) => category.id === "rule");
  return { id: "needs_review", name: "待细分", keywords: [] };
}

function issueSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/@_user_\d+/g, "")
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
    .slice(0, 80);
}

function isFaqCovered(text) {
  return includesAny(String(text || "").toLowerCase(), ["文档", "公告", "入口", "在哪", "单价", "流程", "报名", "入项", "链接"]);
}

function hasEmotionRisk(text) {
  return includesAny(String(text || "").toLowerCase(), ["投诉", "不满", "催", "没人", "离谱", "垃圾", "生气", "退群", "升级"]);
}

function isBlocking(text) {
  return includesAny(String(text || "").toLowerCase(), ["无法", "不能", "看不到", "提交失败", "登录失败", "无权限", "打不开", "卡住", "做不了"]);
}

function needsCrossTeam(text) {
  return includesAny(String(text || "").toLowerCase(), ["技术", "审核", "质检", "结算", "系统", "bug", "权限", "账号", "费用"]);
}

function priorityForIssue(text, category, duplicateCount) {
  const lower = String(text || "").toLowerCase();
  if (hasEmotionRisk(lower) || includesAny(lower, ["大面积", "系统故障", "结算异常"])) return "P0";
  if (isBlocking(lower) || ["account", "operation", "rule", "rejection"].includes(category.id)) return "P1";
  if (duplicateCount > 1 || isFaqCovered(lower)) return "P3";
  return "P2";
}

function rowProject(row) {
  return {
    projectId: row.projectId || "unassigned",
    projectName: row.projectName || row.projectId || "未标注项目",
    chatId: row.chatId || "unknown",
    groupName: row.groupName || row.projectName || row.chatId || "未命名群"
  };
}

function enrichMessage(row, people = {}) {
  let info = personInfo(row.sender, people);
  const systemActor = row.msgType === "system" ? row.content?.from_user?.join?.("、") || row.content?.from_user || "" : "";
  if (systemActor && info.id === "unknown") {
    info = {
      ...info,
      id: "system",
      name: systemActor,
      nameSource: "system_message_content",
      role: "system",
      isInternal: true,
      senderType: "system"
    };
  }
  const project = rowProject(row);
  const replyObjectMessageId = row.replyToMessageId || row.parentId || "";
  const isInternal = info.isInternal;
  const displayText = replaceMentionNames(row.msgType === "system" ? formatSystemContent(row.content) || row.text || "" : row.text || "", row.mentions);
  const richBlocks = richBlocksFromContent(row.content, row.msgType);
  const resources = imageResourcesFromBlocks(richBlocks);
  const questionCandidate =
    !isInternal && info.role !== "bot" && row.msgType !== "system" && ["text", "post"].includes(row.msgType || "") && isQuestionText(displayText);
  return {
    messageId: row.messageId,
    createTimeMs: row.createTimeMs || 0,
    createTime: row.createTime || "",
    createDate: row.createDate || "",
    projectId: project.projectId,
    projectName: project.projectName,
    chatId: project.chatId,
    groupName: project.groupName,
    senderId: info.id,
    senderName: info.name,
    senderNameSource: info.nameSource,
    senderRole: info.role,
    senderRoleLabel: senderRoleLabel(info.role),
    senderTeam: info.team,
    senderType: info.senderType,
    isInternal,
    msgType: row.msgType || "",
    text: displayText,
    rawText: row.text || "",
    richBlocks,
    resources,
    isExpertQuestion: false,
    questionCandidate,
    questionCandidateSource: questionCandidate ? "rule_candidate_question_words" : "",
    expertQuestionStatus: questionCandidate ? "candidate_needs_ai_or_human" : "not_marked",
    isOperatorReply: isInternal && Boolean(row.text || replyObjectMessageId),
    isReply: Boolean(row.isReply),
    replyObjectMessageId,
    replyToMessageId: replyObjectMessageId,
    threadRootMessageId: row.threadRootMessageId || row.rootId || row.parentId || row.messageId || "",
    mentions: row.mentions || []
  };
}

function buildIssueUnits(rows, people = {}, messageById = new Map()) {
  const enriched = rows.map((row) => enrichMessage(row, people));
  const byMessageId = new Map(enriched.map((row) => [row.messageId, row]));
  const byChat = new Map();
  for (const message of enriched) {
    const list = byChat.get(message.chatId) || [];
    list.push(message);
    byChat.set(message.chatId, list);
  }
  for (const list of byChat.values()) list.sort((a, b) => a.createTimeMs - b.createTimeMs);

  const candidates = enriched.filter((message) => message.questionCandidate);
  const candidateGroups = [];
  for (const chatMessages of byChat.values()) {
    const chatCandidates = chatMessages.filter((message) => message.questionCandidate);
    let group = null;
    for (const question of chatCandidates) {
      const previous = group?.questions.at(-1);
      const gapMs = previous ? question.createTimeMs - previous.createTimeMs : Infinity;
      const hasInternalBetween =
        previous &&
        chatMessages.some(
          (message) => message.isInternal && message.createTimeMs > previous.createTimeMs && message.createTimeMs < question.createTimeMs
        );
      const sameAsker = previous && previous.senderId === question.senderId;
      const sameThread =
        previous &&
        ((question.replyToMessageId && question.replyToMessageId === previous.messageId) ||
          (question.threadRootMessageId &&
            previous.threadRootMessageId &&
            question.threadRootMessageId === previous.threadRootMessageId));
      const sameCategory = previous && classifyIssue(previous.text).id === classifyIssue(question.text).id;
      const shouldMerge = group && sameAsker && gapMs <= 5 * 60 * 1000 && !hasInternalBetween && (sameThread || sameCategory || gapMs <= 2 * 60 * 1000);
      if (shouldMerge) {
        group.questions.push(question);
      } else {
        group = { questions: [question], chatId: question.chatId };
        candidateGroups.push(group);
      }
    }
  }
  const signatureCounts = {};
  for (const group of candidateGroups) {
    const signature = issueSignature(group.questions.map((message) => message.text).join("\n"));
    if (signature) signatureCounts[signature] = (signatureCounts[signature] || 0) + 1;
  }

  return candidateGroups.map((group, index) => {
    const question = group.questions[0];
    const questionIds = new Set(group.questions.map((message) => message.messageId));
    const combinedText = group.questions.map((message) => message.text).filter(Boolean).join("\n");
    const chatMessages = byChat.get(question.chatId) || [];
    const related = chatMessages.filter((message) => {
      if (message.msgType === "system") return false;
      if (questionIds.has(message.messageId)) return true;
      if (questionIds.has(message.replyToMessageId)) return true;
      if (message.threadRootMessageId && questionIds.has(message.threadRootMessageId)) return true;
      const sameParent = group.questions.some((item) => item.replyToMessageId && message.replyToMessageId === item.replyToMessageId);
      const sameThread = group.questions.some(
        (item) => item.threadRootMessageId && item.threadRootMessageId !== item.messageId && message.threadRootMessageId === item.threadRootMessageId
      );
      return sameParent || sameThread;
    });
    const lastQuestionTimeMs = group.questions.at(-1)?.createTimeMs || question.createTimeMs;
    const explicitReplies = related.filter(
      (message) =>
        message.isInternal &&
        message.senderRole !== "system" &&
        message.createTimeMs >= question.createTimeMs &&
        (questionIds.has(message.replyToMessageId) || questionIds.has(message.threadRootMessageId))
    );
    const firstReply = explicitReplies[0] || null;
    const replyConfidence = explicitReplies[0] ? "explicit_feishu_reply" : "none";
    const category = classifyIssue(combinedText);
    const signature = issueSignature(combinedText);
    const duplicateCount = signature ? signatureCounts[signature] || 1 : 1;
    const priority = priorityForIssue(combinedText, category, duplicateCount);
    const latencySeconds = firstReply ? Math.max(0, Math.round((firstReply.createTimeMs - question.createTimeMs) / 1000)) : null;
    const slaMinutes = PRIORITIES[priority].slaMinutes;
    const isOverSla = latencySeconds === null ? true : latencySeconds > slaMinutes * 60;
    const issueMessages = [...new Map([...group.questions, ...related, firstReply].filter(Boolean).map((message) => [message.messageId, message])).values()].sort(
      (a, b) => a.createTimeMs - b.createTimeMs
    );
    const expertFollowups = issueMessages.filter((message) => !message.isInternal && !questionIds.has(message.messageId)).length;
    const operatorReplies = issueMessages.filter((message) => message.isInternal).length;
    const internalMessages = issueMessages.filter((message) => message.isInternal);
    const lastInternal = internalMessages.at(-1) || null;
    const lastMessage = issueMessages.at(-1) || null;
    const escalationSignals = includesAny(String(lastInternal?.text || firstReply?.text || "").toLowerCase(), [
      "升级",
      "反馈",
      "同步",
      "转交",
      "对接",
      "技术",
      "审核",
      "结算"
    ]);
    const finalStatus = "待AI/人工判断";
    const resolvedAt = "";
    const resolutionSeconds =
      resolvedAt && (lastInternal?.createTimeMs || firstReply?.createTimeMs)
        ? Math.max(0, Math.round(((lastInternal?.createTimeMs || firstReply.createTimeMs) - question.createTimeMs) / 1000))
        : null;
    const responseStatus = firstReply ? "有明确引用回复_待判断是否有效" : "无明确引用回复";
    const standardWorkMinutes = PRIORITIES[priority].workMinutes;

    return {
      issueId: `Q-${String(index + 1).padStart(5, "0")}`,
      projectId: question.projectId,
      projectName: question.projectName,
      chatId: question.chatId,
      groupName: question.groupName,
      questionMessageId: question.messageId,
      questionMessageIds: [...questionIds],
      questionTime: question.createTime,
      questionTimeMs: question.createTimeMs,
      askerId: question.senderId,
      askerName: question.senderName,
      askerRole: question.senderRole,
      askerRoleLabel: question.senderRoleLabel,
      text: combinedText || question.text,
      isExpertQuestion: false,
      questionCandidate: true,
      source: "rule_candidate",
      requiresAiOrHumanReview: true,
      judgementStatus: "pending_ai_or_human",
      candidateReason: "包含问号或疑问词，仅说明这条消息像问题，不代表它一定是专家问题。",
      classificationSource: "rule_draft_for_ai_input_only",
      categoryId: category.id,
      categoryName: category.name,
      priority,
      priorityLabel: PRIORITIES[priority].label,
      slaMinutes,
      slaRange: PRIORITIES[priority].slaRange,
      isFaqCovered: isFaqCovered(combinedText),
      duplicateCount,
      isDuplicate: duplicateCount > 1,
      isBlocking: isBlocking(combinedText),
      hasEmotionRisk: hasEmotionRisk(combinedText),
      needsCrossTeam: needsCrossTeam(combinedText),
      status: finalStatus,
      finalStatus,
      statusSource: "not_inferred",
      responseStatus,
      firstReplyTime: firstReply?.createTime || "",
      effectiveReplyMessageId: firstReply?.messageId || "",
      firstReplierId: firstReply?.senderId || "",
      firstReplierName: firstReply?.senderName || "",
      firstReplyText: firstReply?.text || "",
      replyConfidence,
      explicitReplyCandidateMessageId: firstReply?.messageId || "",
      explicitReplyCandidateText: firstReply?.text || "",
      effectiveReplyJudgement: "pending_ai_or_human",
      firstResponseSeconds: latencySeconds,
      resolvedAt,
      resolutionSeconds,
      resolutionConfidence: "requires_ai_or_human",
      isOverSla,
      operatorReplyCount: operatorReplies,
      expertFollowupCount: expertFollowups,
      isOneShotResolved: Boolean(firstReply) && expertFollowups === 0,
      standardWorkMinutes,
      actualWorkMinutes: null,
      workMinutesSource: "standard_priority_table",
      estimatedWorkMinutes: standardWorkMinutes,
      ruleDraft: {
        categoryId: category.id,
        categoryName: category.name,
        priority,
        priorityLabel: PRIORITIES[priority].label,
        isFaqCovered: isFaqCovered(combinedText),
        isDuplicate: duplicateCount > 1,
        isBlocking: isBlocking(combinedText),
        hasEmotionRisk: hasEmotionRisk(combinedText),
        needsCrossTeam: needsCrossTeam(combinedText),
        standardWorkMinutes,
        note: "脚本草稿，只能给 AI/人工审核做输入，不属于真实结论。"
      },
      messages: issueMessages
    };
  });
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function objectCountsToRows(object, labelMap = {}) {
  return Object.entries(object)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: labelMap[key] || key, count }));
}

function truncateText(value, max = 1200) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compactMessageForOutput(message, maxText = 1000) {
  return {
    messageId: message.messageId,
    createTimeMs: message.createTimeMs,
    createTime: message.createTime,
    createDate: message.createDate,
    projectId: message.projectId,
    projectName: message.projectName,
    chatId: message.chatId,
    groupName: message.groupName,
    senderId: message.senderId,
    senderName: message.senderName,
    senderNameSource: message.senderNameSource,
    senderRole: message.senderRole,
    senderRoleLabel: message.senderRoleLabel,
    senderTeam: message.senderTeam,
    senderType: message.senderType,
    isInternal: message.isInternal,
    msgType: message.msgType,
    text: truncateText(message.text, maxText),
    richBlocks: message.richBlocks || [],
    resources: message.resources || [],
    questionCandidate: message.questionCandidate,
    questionCandidateSource: message.questionCandidateSource,
    expertQuestionStatus: message.expertQuestionStatus,
    isOperatorReply: message.isOperatorReply,
    isReply: message.isReply,
    replyObjectMessageId: message.replyObjectMessageId,
    replyToMessageId: message.replyToMessageId,
    threadRootMessageId: message.threadRootMessageId
  };
}

function compactCandidateForOutput(issue) {
  return {
    issueId: issue.issueId,
    projectId: issue.projectId,
    projectName: issue.projectName,
    chatId: issue.chatId,
    groupName: issue.groupName,
    questionMessageId: issue.questionMessageId,
    questionMessageIds: issue.questionMessageIds,
    questionTime: issue.questionTime,
    questionTimeMs: issue.questionTimeMs,
    askerId: issue.askerId,
    askerName: issue.askerName,
    askerRole: issue.askerRole,
    askerRoleLabel: issue.askerRoleLabel,
    text: truncateText(issue.text, 2000),
    isExpertQuestion: issue.isExpertQuestion,
    questionCandidate: issue.questionCandidate,
    source: issue.source,
    requiresAiOrHumanReview: issue.requiresAiOrHumanReview,
    judgementStatus: issue.judgementStatus,
    candidateReason: issue.candidateReason,
    classificationSource: issue.classificationSource,
    status: issue.status,
    finalStatus: issue.finalStatus,
    statusSource: issue.statusSource,
    responseStatus: issue.responseStatus,
    firstReplyTime: issue.firstReplyTime,
    effectiveReplyMessageId: issue.effectiveReplyMessageId,
    firstReplierId: issue.firstReplierId,
    firstReplierName: issue.firstReplierName,
    firstReplyText: truncateText(issue.firstReplyText, 1000),
    replyConfidence: issue.replyConfidence,
    explicitReplyCandidateMessageId: issue.explicitReplyCandidateMessageId,
    explicitReplyCandidateText: truncateText(issue.explicitReplyCandidateText, 1000),
    firstResponseSeconds: issue.firstResponseSeconds,
    ruleDraft: issue.ruleDraft
      ? {
          categoryId: issue.ruleDraft.categoryId,
          categoryName: issue.ruleDraft.categoryName,
          priority: issue.ruleDraft.priority,
          priorityLabel: issue.ruleDraft.priorityLabel,
          isFaqCovered: issue.ruleDraft.isFaqCovered,
          isDuplicate: issue.ruleDraft.isDuplicate,
          isBlocking: issue.ruleDraft.isBlocking,
          hasEmotionRisk: issue.ruleDraft.hasEmotionRisk,
          needsCrossTeam: issue.ruleDraft.needsCrossTeam,
          standardWorkMinutes: issue.ruleDraft.standardWorkMinutes,
          note: issue.ruleDraft.note
        }
      : null,
    messages: (issue.messages || []).map((message) => compactMessageForOutput(message, 900))
  };
}

function compactMessageForBrowser(message, maxText = 420) {
  const out = compactMessageForOutput(message, maxText);
  out.richBlocks = [];
  out.resources = (out.resources || []).slice(0, 3).map((item) => ({
    type: item.type,
    fileKey: item.fileKey || item.imageKey || "",
    imageKey: item.imageKey || item.fileKey || "",
    width: item.width || null,
    height: item.height || null
  }));
  return out;
}

function compactCandidateForBrowser(issue) {
  const out = compactCandidateForOutput(issue);
  out.messages = (issue.messages || []).slice(0, 3).map((message) => compactMessageForBrowser(message, 360));
  return out;
}

function compactStaffForBrowser(row) {
  return {
    id: row.id,
    name: row.name,
    nameSource: row.nameSource,
    team: row.team,
    role: row.role,
    senderType: row.senderType,
    isInternal: row.isInternal,
    internalSource: row.internalSource,
    messageCount: row.messageCount,
    replyCount: row.replyCount,
    handledQuestionCount: row.handledQuestionCount,
    questionCount: row.questionCount,
    activeDays: row.activeDays,
    firstTime: row.firstTime,
    lastTime: row.lastTime,
    avgLatencySeconds: row.avgLatencySeconds,
    replyRatio: row.replyRatio,
    groupBreakdown: (row.groupBreakdown || []).slice(0, 12),
    messageTypeRows: (row.messageTypeRows || []).slice(0, 8),
    recentMessages: (row.recentMessages || []).slice(0, 8)
  };
}

function compactRuleDraftForBrowser(ruleDraft = {}) {
  return {
    source: ruleDraft.source,
    warning: ruleDraft.warning,
    candidateCount: ruleDraft.candidateCount,
    explicitReplyCandidateCount: ruleDraft.explicitReplyCandidateCount,
    avgExplicitReplyCandidateSeconds: ruleDraft.avgExplicitReplyCandidateSeconds,
    priorityCounts: ruleDraft.priorityCounts || [],
    categoryCounts: ruleDraft.categoryCounts || [],
    hourlyStaffing: (ruleDraft.hourlyStaffing || []).slice(-72),
    calibrationMetrics: ruleDraft.calibrationMetrics || null,
    projectEventImpacts: (ruleDraft.projectEventImpacts || []).slice(-30),
    totalWorkloadMinutes: ruleDraft.totalWorkloadMinutes
  };
}

function compactMetricsForBrowser(metrics, options = {}) {
  if (!metrics) return {};
  const keepMessages = Boolean(options.keepMessages);
  const messageLimit = Number(options.messageLimit || 300);
  const candidateLimit = Number(options.candidateLimit || 80);
  const staffLimit = Number(options.staffLimit || 160);
  const messages = keepMessages ? (metrics.messages || []).slice(-messageLimit).map((message) => compactMessageForBrowser(message)) : [];
  const analysisCandidates = (metrics.analysisCandidates || []).slice(-candidateLimit).map(compactCandidateForBrowser);
  const replyEdges = (metrics.replyEdges || []).slice(-500).map(compactReplyEdgeForOutput);
  return {
    messageCount: metrics.messageCount,
    firstTime: metrics.firstTime,
    lastTime: metrics.lastTime,
    activeDayCount: metrics.activeDayCount,
    uniqueSenderCount: metrics.uniqueSenderCount,
    internalSenderCount: metrics.internalSenderCount,
    expertQuestionCount: metrics.expertQuestionCount,
    questionCount: metrics.questionCount,
    questionCandidateCount: metrics.questionCandidateCount,
    analysisCandidateCount: metrics.analysisCandidateCount,
    replyCount: metrics.replyCount,
    unresolvedIssueCount: metrics.unresolvedIssueCount,
    unansweredQuestionCount: metrics.unansweredQuestionCount,
    avgFirstResponseSeconds: metrics.avgFirstResponseSeconds,
    avgResolutionSeconds: metrics.avgResolutionSeconds,
    avgReplySeconds: metrics.avgReplySeconds,
    p90FirstResponseSeconds: metrics.p90FirstResponseSeconds,
    p90ResolutionSeconds: metrics.p90ResolutionSeconds,
    p90ReplySeconds: metrics.p90ReplySeconds,
    slaHitRate: metrics.slaHitRate,
    overSlaCount: metrics.overSlaCount,
    faqHitRate: metrics.faqHitRate,
    duplicateRate: metrics.duplicateRate,
    oneShotResolveRate: metrics.oneShotResolveRate,
    totalWorkloadMinutes: metrics.totalWorkloadMinutes,
    staffingModel: metrics.staffingModel,
    standardWorkMinuteTable: metrics.standardWorkMinuteTable,
    workloadMethod: metrics.workloadMethod,
    dataAuthenticity: metrics.dataAuthenticity,
    identitySourceCounts: metrics.identitySourceCounts || [],
    priorityCounts: metrics.priorityCounts || [],
    categoryCounts: metrics.categoryCounts || [],
    finalStatusCounts: metrics.finalStatusCounts || [],
    hourlyStaffing: (metrics.hourlyStaffing || []).slice(-72),
    calibrationMetrics: metrics.calibrationMetrics,
    projectEvents: (metrics.projectEvents || []).slice(-30),
    projectEventImpacts: (metrics.projectEventImpacts || []).slice(-30),
    ruleDraft: compactRuleDraftForBrowser(metrics.ruleDraft),
    coreMetricSummary: metrics.coreMetricSummary
      ? {
          ...metrics.coreMetricSummary,
          hourlyMessageCount: metrics.coreMetricSummary.hourlyMessageCount || [],
          hourlyQuestionCandidateCount: metrics.coreMetricSummary.hourlyQuestionCandidateCount || [],
          messageTypeDistribution: metrics.coreMetricSummary.messageTypeDistribution || [],
          identitySourceDistribution: metrics.coreMetricSummary.identitySourceDistribution || []
        }
      : {},
    issues: [],
    analysisCandidates,
    questionCandidates: [],
    unresolvedIssues: [],
    byDate: metrics.byDate || [],
    byHour: metrics.byHour || {},
    byMsgType: metrics.byMsgType || {},
    messageTypeRows: metrics.messageTypeRows || [],
    byProject: metrics.byProject || [],
    byChat: metrics.byChat || [],
    projectBreakdown: metrics.projectBreakdown || [],
    topTerms: metrics.topTerms || [],
    staff: (metrics.staff || []).slice(0, staffLimit).map(compactStaffForBrowser),
    internalStaff: (metrics.internalStaff || []).slice(0, 80).map(compactStaffForBrowser),
    questionRows: [],
    unansweredQuestions: [],
    answerPairs: [],
    replyEdges,
    messages,
    messagesPreloaded: messages.length,
    messagesTruncated: keepMessages && Number(metrics.messageCount || 0) > messages.length
  };
}

function compactDashboardForBrowser(dashboard) {
  const compactPeriods = {};
  for (const [key, value] of Object.entries(dashboard.periods || {})) {
    if (key !== "all") continue;
    compactPeriods[key] = {
      ...value,
      metrics: compactMetricsForBrowser(value.metrics, {
        keepMessages: key === "all",
        messageLimit: key === "all" ? 300 : 0,
        candidateLimit: 80
      })
    };
  }
  return {
    generatedAt: dashboard.generatedAt,
    archiveDir: dashboard.archiveDir,
    storageStatus: dashboard.storageStatus,
    aiConnection: dashboard.aiConnection,
    peopleConfigured: dashboard.peopleConfigured,
    peopleDirectoryCount: dashboard.peopleDirectoryCount,
    groups: dashboard.groups,
    staffingModel: dashboard.staffingModel,
    standardWorkMinuteTable: dashboard.standardWorkMinuteTable,
    projectEventTypes: dashboard.projectEventTypes,
    projectEvents: dashboard.projectEvents,
    projects: (dashboard.projects || []).map((project) => {
      const periods = {};
      for (const [key, value] of Object.entries(project.periods || {})) {
        if (key !== "all") continue;
        periods[key] = {
          ...value,
          metrics: compactMetricsForBrowser(value.metrics, {
            keepMessages: key === "all",
            messageLimit: key === "all" ? 300 : 0,
            candidateLimit: 80,
            staffLimit: 120
          })
        };
      }
      return {
        projectId: project.projectId,
        projectName: project.projectName,
        chats: project.chats,
        events: project.events,
        periods,
        metrics: null
      };
    }),
    periods: compactPeriods,
    payloadMode: "browser_compact"
  };
}

function compactMessageForAi(message, maxText = 500) {
  return {
    messageId: message.messageId,
    createTime: message.createTime,
    senderId: message.senderId,
    senderName: message.senderName,
    senderRoleLabel: message.senderRoleLabel,
    msgType: message.msgType,
    text: truncateText(message.text, maxText),
    isReply: message.isReply,
    replyToMessageId: message.replyToMessageId || message.replyObjectMessageId || ""
  };
}

function compactCandidateForAi(issue) {
  return {
    issueId: issue.issueId,
    projectId: issue.projectId,
    projectName: issue.projectName,
    chatId: issue.chatId,
    groupName: issue.groupName,
    questionMessageIds: issue.questionMessageIds,
    questionTime: issue.questionTime,
    askerName: issue.askerName,
    askerRoleLabel: issue.askerRoleLabel,
    text: truncateText(issue.text, 700),
    candidateReason: issue.candidateReason,
    explicitReplyCandidateMessageId: issue.explicitReplyCandidateMessageId,
    firstReplyTime: issue.firstReplyTime,
    firstReplierName: issue.firstReplierName,
    firstReplyText: truncateText(issue.firstReplyText, 700),
    replyConfidence: issue.replyConfidence,
    ruleDraft: issue.ruleDraft
      ? {
          categoryName: issue.ruleDraft.categoryName,
          priority: issue.ruleDraft.priority,
          isFaqCovered: issue.ruleDraft.isFaqCovered,
          isDuplicate: issue.ruleDraft.isDuplicate,
          isBlocking: issue.ruleDraft.isBlocking,
          hasEmotionRisk: issue.ruleDraft.hasEmotionRisk,
          needsCrossTeam: issue.ruleDraft.needsCrossTeam,
          standardWorkMinutes: issue.ruleDraft.standardWorkMinutes,
          note: issue.ruleDraft.note
        }
      : null,
    messages: (issue.messages || []).slice(0, 8).map((message) => compactMessageForAi(message, 500))
  };
}

function compactReplyEdgeForOutput(edge) {
  return {
    ...edge,
    parentText: truncateText(edge.parentText, 800),
    replyText: truncateText(edge.replyText, 800)
  };
}

function metricsSummaryForAi(metrics, maxCandidates = 120, includeCandidates = true) {
  if (!metrics) return {};
  const candidates = includeCandidates
    ? (metrics.analysisCandidates || metrics.ruleDraft?.questionCandidates || [])
        .slice(0, maxCandidates)
        .map(compactCandidateForAi)
    : [];
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
    byDate: (metrics.byDate || []).slice(-30),
    byHour: metrics.byHour || {},
    messageTypeRows: metrics.messageTypeRows || [],
    byProject: metrics.byProject || [],
    byChat: metrics.byChat || [],
    projectBreakdown: metrics.projectBreakdown || [],
    identitySourceCounts: metrics.identitySourceCounts || [],
    dataAuthenticity: metrics.dataAuthenticity,
    internalStaff: (metrics.internalStaff || []).slice(0, 30),
    staff: (metrics.staff || []).slice(0, 30).map((item) => ({
      id: item.id,
      name: item.name,
      nameSource: item.nameSource,
      team: item.team,
      role: item.role,
      senderType: item.senderType,
      isInternal: item.isInternal,
      messageCount: item.messageCount,
      replyCount: item.replyCount,
      handledQuestionCount: item.handledQuestionCount,
      activeDays: item.activeDays,
      avgLatencySeconds: item.avgLatencySeconds
    })),
    replyEdges: (metrics.replyEdges || []).slice(0, 30).map(compactReplyEdgeForOutput),
    analysisCandidates: candidates
  };
}

function metricsTinySummaryForAi(metrics) {
  if (!metrics) return {};
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
    byHour: metrics.byHour || {},
    messageTypeRows: metrics.messageTypeRows || [],
    byChat: metrics.byChat || [],
    byProject: metrics.byProject || []
  };
}

function compactRuleDraftForAi(ruleDraft, questionCandidates) {
  return {
    source: ruleDraft?.source || "local_rule_draft_for_ai_input_only",
    warning: ruleDraft?.warning || "规则草稿只用于召回候选，不是运营结论。",
    candidateCount: ruleDraft?.candidateCount || 0,
    explicitReplyCandidateCount: ruleDraft?.explicitReplyCandidateCount || 0,
    avgExplicitReplyCandidateSeconds: ruleDraft?.avgExplicitReplyCandidateSeconds ?? null,
    priorityCounts: ruleDraft?.priorityCounts || [],
    categoryCounts: ruleDraft?.categoryCounts || [],
    totalWorkloadMinutes: ruleDraft?.totalWorkloadMinutes ?? null,
    questionCandidates
  };
}

function buildHourlyStaffing(issues) {
  const byHour = {};
  for (const issue of issues) {
    const date = issue.questionTime.slice(0, 10);
    const hour = issue.questionTime.slice(11, 13) || "unknown";
    const key = `${date} ${hour}:00`;
    const bucket = byHour[key] || {
      slot: key,
      issueCount: 0,
      priorities: { P0: 0, P1: 0, P2: 0, P3: 0 },
      categoryCounts: {},
      priorityWorkloadMinutes: { P0: 0, P1: 0, P2: 0, P3: 0 },
      workloadMinutes: 0,
      highPriorityCount: 0,
      highPriorityRatio: 0,
      suggestedHeadcountRaw: 0,
      suggestedHeadcount: 0,
      staffingModel: STAFFING_MODEL,
      roles: []
    };
    bucket.issueCount += 1;
    bucket.priorities[issue.priority] += 1;
    bucket.categoryCounts[issue.categoryName] = (bucket.categoryCounts[issue.categoryName] || 0) + 1;
    const workMinutes = issue.standardWorkMinutes || issue.estimatedWorkMinutes || PRIORITIES[issue.priority].workMinutes;
    bucket.priorityWorkloadMinutes[issue.priority] += workMinutes;
    bucket.workloadMinutes += workMinutes;
    if (issue.priority === "P0" || issue.priority === "P1") bucket.highPriorityCount += 1;
    byHour[key] = bucket;
  }
  return Object.values(byHour)
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map((bucket) => {
      bucket.highPriorityRatio = bucket.issueCount ? Math.round((bucket.highPriorityCount / bucket.issueCount) * 100) : 0;
      bucket.suggestedHeadcountRaw =
        bucket.workloadMinutes / STAFFING_MODEL.effectiveWorkMinutesPerPerson / STAFFING_MODEL.targetUtilization;
      bucket.suggestedHeadcount = Math.max(1, Math.ceil(bucket.suggestedHeadcountRaw));
      bucket.workloadFormula = Object.entries(bucket.priorities)
        .map(([priority, count]) => `${priority} ${count} × ${PRIORITIES[priority].workMinutes}`)
        .join(" + ");
      bucket.roles = allocateRoles(bucket);
      return bucket;
    });
}

function allocateRoles(bucket) {
  const roles = [];
  const high = bucket.priorities.P0 + bucket.priorities.P1;
  const standard = bucket.priorities.P2 + bucket.priorities.P3;
  const people = Math.max(1, bucket.suggestedHeadcount);
  const highPeople = Math.min(people, Math.max(high ? 1 : 0, Math.ceil(high / 12)));
  const standardPeople = Math.max(0, Math.min(people - highPeople, Math.ceil(standard / 35)));
  const complexPeople = bucket.categoryCounts["规则理解"] || bucket.categoryCounts["驳回 / 质检"] ? Math.min(2, Math.max(0, people - highPeople - standardPeople)) : 0;
  const upgradeDemand =
    bucket.priorities.P0 +
    (bucket.categoryCounts["权限 / 账号"] || 0) +
    (bucket.categoryCounts["结算 / 费用"] || 0) +
    (bucket.categoryCounts["情绪 / 投诉 / 风险"] || 0);
  const upgradePeople = upgradeDemand && people - highPeople - standardPeople - complexPeople > 0 ? 1 : 0;
  const used = highPeople + standardPeople + complexPeople + upgradePeople;
  const coordinatorPeople = Math.max(0, people - used);
  if (highPeople) roles.push({ role: "高优答疑", count: highPeople, focus: "P0/P1 作业阻塞和升级风险" });
  if (standardPeople) roles.push({ role: "标准回复", count: standardPeople, focus: "P2/P3、FAQ、重复问题" });
  if (complexPeople) roles.push({ role: "复杂问题", count: complexPeople, focus: "规则争议、驳回、申诉" });
  if (upgradePeople) roles.push({ role: "升级接口", count: upgradePeople, focus: "对接审核、技术、结算、权限接口" });
  if (coordinatorPeople) roles.push({ role: "巡群统筹", count: coordinatorPeople, focus: "漏回检查、情绪升级、公告触发" });
  return roles;
}

function average(values) {
  const clean = values.filter((value) => value !== null && value !== undefined && !Number.isNaN(Number(value))).map(Number);
  return clean.length ? Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null;
}

function rate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}

function calibrationRows(issues, keyFn, labelFn = (key) => key) {
  const byKey = new Map();
  for (const issue of issues) {
    const key = keyFn(issue) || "unknown";
    const list = byKey.get(key) || [];
    list.push(issue);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .map(([key, list]) => {
      const avgFirstResponseSeconds = average(list.map((issue) => issue.firstResponseSeconds));
      const avgResolutionSeconds = average(list.map((issue) => issue.resolutionSeconds));
      const avgOperatorReplyCount = average(list.map((issue) => issue.operatorReplyCount));
      const avgExpertFollowupCount = average(list.map((issue) => issue.expertFollowupCount));
      const oneShotRate = rate(list.filter((issue) => issue.isOneShotResolved).length, list.length);
      const slaHitRate = rate(list.filter((issue) => !issue.isOverSla).length, list.length);
      const avgStandardWorkMinutes = average(list.map((issue) => issue.standardWorkMinutes || issue.estimatedWorkMinutes));
      const calibrationSignal =
        slaHitRate < 80 || avgExpertFollowupCount > 1
          ? "建议上调标准耗时或增加该类人力"
          : oneShotRate >= 80 && slaHitRate >= 90
            ? "标准耗时可保持，后续观察是否可自动化"
            : "继续观察";
      return {
        key,
        label: labelFn(key),
        issueCount: list.length,
        avgFirstResponseSeconds,
        avgResolutionSeconds,
        avgOperatorReplyCount,
        avgExpertFollowupCount,
        oneShotRate,
        slaHitRate,
        overSlaCount: list.filter((issue) => issue.isOverSla).length,
        avgStandardWorkMinutes,
        calibrationSignal
      };
    })
    .sort((a, b) => b.issueCount - a.issueCount);
}

function buildCalibrationMetrics(issues) {
  const priorityLabels = Object.fromEntries(Object.entries(PRIORITIES).map(([key, value]) => [key, value.label]));
  return {
    method: "当前无法精确采集每条问题的实际有效工作分钟，因此使用标准平均运营耗时表估算人力成本；后续用 SLA、追问、一次解决率、未回复率反向校准。",
    staffingModel: STAFFING_MODEL,
    standardWorkMinuteTable: standardWorkMinuteRows(),
    byPriority: calibrationRows(issues, (issue) => issue.priority, (key) => priorityLabels[key] || key),
    byCategory: calibrationRows(issues, (issue) => issue.categoryName)
  };
}

function buildProjectEventImpacts(events, issues) {
  return events.map((event) => {
    const windowStartMs = event.eventTimeMs || 0;
    const windowEndMs = windowStartMs ? windowStartMs + event.impactWindowHours * 60 * 60 * 1000 : 0;
    const relatedIssues = issues.filter((issue) => {
      if (event.projectId && issue.projectId !== event.projectId) return false;
      if (!windowStartMs) return event.relatedCategoryIds.includes(issue.categoryId);
      const inWindow = issue.questionTimeMs >= windowStartMs && issue.questionTimeMs <= windowEndMs;
      const relatedCategory = !event.relatedCategoryIds.length || event.relatedCategoryIds.includes(issue.categoryId);
      return inWindow && relatedCategory;
    });
    return {
      ...event,
      windowStart: windowStartMs ? localIso(windowStartMs) : "",
      windowEnd: windowEndMs ? localIso(windowEndMs) : "",
      observedIssueCount: relatedIssues.length,
      observedHighPriorityCount: relatedIssues.filter((issue) => issue.priority === "P0" || issue.priority === "P1").length,
      observedCategories: objectCountsToRows(countBy(relatedIssues, (issue) => issue.categoryName)),
      observedPriorities: objectCountsToRows(
        countBy(relatedIssues, (issue) => issue.priority),
        Object.fromEntries(Object.entries(PRIORITIES).map(([key, value]) => [key, value.label]))
      ),
      evidenceIssueIds: relatedIssues.slice(0, 20).map((issue) => issue.issueId)
    };
  });
}

function groupMetrics(rows, people = {}, messageById = new Map(), options = {}) {
  const includeAnalysis = options.includeAnalysis !== false;
  const byDate = {};
  const byHour = {};
  const byMsgType = {};
  const byProject = {};
  const byChat = {};
  const bySender = {};
  const byTerm = {};
  const replyEdges = [];
  const replyLatencies = [];
  const messages = rows.map((row) => enrichMessage(row, people));

  for (const row of rows) {
    const info = personInfo(row.sender, people);
    const date = row.createDate || localDate(row.createTimeMs || Date.now());
    const hour = row.createTime ? row.createTime.slice(11, 13) : "unknown";
    const projectKey = row.projectName || row.projectId || "未标注项目";
    const chatKey = row.groupName || row.chatId || "unknown";
    const typeKey = row.msgType || "unknown";

    byDate[date] = (byDate[date] || 0) + 1;
    byHour[hour] = (byHour[hour] || 0) + 1;
    byMsgType[typeKey] = (byMsgType[typeKey] || 0) + 1;
    byProject[projectKey] = (byProject[projectKey] || 0) + 1;
    byChat[chatKey] = (byChat[chatKey] || 0) + 1;

    const senderStats = bySender[info.id] || {
      id: info.id,
      name: info.name,
      nameSource: info.nameSource,
      team: info.team,
      role: info.role,
      senderType: info.senderType,
      isInternal: info.isInternal,
      messageCount: 0,
      replyCount: 0,
      handledQuestionCount: 0,
      questionCount: 0,
      activeDays: new Set(),
      firstTime: "",
      lastTime: "",
      latencySeconds: [],
      groups: {},
      messageTypes: {},
      recentMessages: []
    };
    senderStats.messageCount += 1;
    senderStats.questionCount += isQuestionText(row.text || "") ? 1 : 0;
    senderStats.activeDays.add(date);
    if (!senderStats.firstTime || row.createTime < senderStats.firstTime) senderStats.firstTime = row.createTime || "";
    if (!senderStats.lastTime || row.createTime > senderStats.lastTime) senderStats.lastTime = row.createTime || "";
    senderStats.messageTypes[typeKey] = (senderStats.messageTypes[typeKey] || 0) + 1;
    const senderGroup = senderStats.groups[row.chatId || chatKey] || {
      chatId: row.chatId || "",
      groupName: chatKey,
      projectName: row.projectName || "",
      messageCount: 0,
      replyCount: 0,
      questionCount: 0,
      firstTime: "",
      lastTime: ""
    };
    senderGroup.messageCount += 1;
    senderGroup.questionCount += isQuestionText(row.text || "") ? 1 : 0;
    if (!senderGroup.firstTime || row.createTime < senderGroup.firstTime) senderGroup.firstTime = row.createTime || "";
    if (!senderGroup.lastTime || row.createTime > senderGroup.lastTime) senderGroup.lastTime = row.createTime || "";
    senderStats.groups[row.chatId || chatKey] = senderGroup;
    senderStats.recentMessages.push({
      messageId: row.messageId,
      createTime: row.createTime || "",
      groupName: chatKey,
      msgType: row.msgType || "",
      isReply: Boolean(row.replyToMessageId || row.parentId),
      text: truncateText(row.text || "", 180)
    });
    bySender[info.id] = senderStats;

    const parentId = row.replyToMessageId || row.parentId || "";
    if (parentId) {
      const parent = messageById.get(parentId);
      const parentRichBlocks = parent ? richBlocksFromContent(parent.content, parent.msgType) : [];
      const replyRichBlocks = richBlocksFromContent(row.content, row.msgType);
      const latencySeconds =
        parent?.createTimeMs && row.createTimeMs ? Math.max(0, Math.round((row.createTimeMs - parent.createTimeMs) / 1000)) : null;
      if (latencySeconds !== null) {
        replyLatencies.push(latencySeconds);
        senderStats.latencySeconds.push(latencySeconds);
      }
      if (parent && isQuestionText(parent.text)) senderStats.handledQuestionCount += 1;
      senderStats.replyCount += 1;
      senderGroup.replyCount += 1;
      replyEdges.push({
        replyMessageId: row.messageId,
        replyTime: row.createTime,
        replyTimeMs: row.createTimeMs || 0,
        replier: info.name,
        replierId: info.id,
        replierRole: info.role,
        replierTeam: info.team,
        replierNameSource: info.nameSource,
        parentMessageId: parentId,
        parentTime: parent?.createTime || "",
        parentTimeMs: parent?.createTimeMs || 0,
        parentSender: parent ? personInfo(parent.sender, people).name : "",
        parentSenderId: parent?.sender?.id || "",
        parentSenderTeam: parent ? personInfo(parent.sender, people).team : "",
        parentSenderNameSource: parent ? personInfo(parent.sender, people).nameSource : "",
        parentText: parent?.text || "",
        parentMsgType: parent?.msgType || "",
        parentRichBlocks,
        parentResources: imageResourcesFromBlocks(parentRichBlocks),
        projectName: row.projectName || parent?.projectName || "",
        groupName: row.groupName || parent?.groupName || "",
        replyText: row.text || "",
        replyMsgType: row.msgType || "",
        replyRichBlocks,
        replyResources: imageResourcesFromBlocks(replyRichBlocks),
        latencySeconds
      });
    }

    for (const term of String(row.text || "")
      .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 2 && term.length <= 16)) {
      byTerm[term] = (byTerm[term] || 0) + 1;
    }
  }

  const staff = Object.values(bySender).map((item) => {
    const avgLatencySeconds = item.latencySeconds.length
      ? Math.round(item.latencySeconds.reduce((sum, value) => sum + value, 0) / item.latencySeconds.length)
      : null;
    const replyRatio = item.messageCount ? item.replyCount / item.messageCount : 0;
    return {
      ...item,
      internalSource: item.isInternal ? item.nameSource : "",
      activeDays: item.activeDays.size,
      avgLatencySeconds,
      replyRatio: Math.round(replyRatio * 100),
      groupBreakdown: Object.values(item.groups || {}).sort((a, b) => b.messageCount - a.messageCount),
      messageTypeRows: objectCountsToRows(item.messageTypes || {}),
      recentMessages: (item.recentMessages || []).slice(-12).reverse(),
      latencySeconds: undefined,
      groups: undefined,
      messageTypes: undefined
    };
  });
  const internalStaff = staff.filter((item) => item.isInternal);
  const firstTime = rows[0]?.createTime || "";
  const lastTime = rows.at(-1)?.createTime || "";
  const questionCandidates = includeAnalysis ? buildIssueUnits(rows, people, messageById) : [];
  const candidateReplySeconds = questionCandidates.map((issue) => issue.firstResponseSeconds).filter((value) => value !== null);
  const categoryCounts = countBy(questionCandidates, (issue) => issue.categoryName);
  const priorityCounts = countBy(questionCandidates, (issue) => issue.priority);
  const hourlyStaffingDraft = buildHourlyStaffing(questionCandidates);
  const calibrationMetricsDraft = buildCalibrationMetrics(questionCandidates);
  const projectBreakdown = objectCountsToRows(countBy(rows, (row) => row.projectName || row.projectId || "未标注项目"));
  const issueCategoryLabelMap = Object.fromEntries(ISSUE_CATEGORIES.map((item) => [item.id, item.name]));
  const projectEvents = options.projectEvents || [];
  const projectEventImpactsDraft = buildProjectEventImpacts(projectEvents, questionCandidates);
  const totalWorkloadMinutesDraft = hourlyStaffingDraft.reduce((sum, bucket) => sum + bucket.workloadMinutes, 0);
  const identitySourceCounts = objectCountsToRows(countBy(messages, (message) => message.senderNameSource));
  const unresolvedIdentityCount = messages.filter((message) => message.senderNameSource === "raw_open_id" || message.senderNameSource === "empty_sender").length;
  const hourlyMessageCount = Object.entries(byHour)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slot, count]) => ({ slot, count }));
  const hourlyQuestionCandidateCount = Object.entries(
    countBy(questionCandidates, (issue) => (issue.questionTime ? issue.questionTime.slice(11, 13) : "unknown"))
  )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slot, count]) => ({ slot, count }));
  const dataAuthenticity = {
    rawMessageCount: rows.length,
    realFields: ["消息时间", "项目/群", "sender open_id/app_id", "消息内容", "回复对象/引用关系", "mentions"],
    deterministicFields: ["消息量", "消息类型分布", "发送人活跃", "明确回复/引用边", "真实时间分布"],
    ruleCandidateFields: ["疑问词候选消息", "候选线程", "规则草稿分类/分级"],
    aiFields: ["是否专家问题", "有效回复判定", "问题分类", "优先级", "FAQ命中", "解决状态", "标准耗时校准", "排班建议"],
    configuredIdentityCount: Object.keys(people || {}).filter((id) => people[id]?.nameSource === "people_config").length,
    resolvedIdentityCount: Object.keys(people || {}).filter((id) => people[id]?.nameSource === "feishu_contact_api").length,
    derivedNameCount: Object.keys(people || {}).filter((id) => ["message_mention", "sender_type_app"].includes(people[id]?.nameSource)).length,
    unresolvedIdentityCount,
    ruleCandidateCount: questionCandidates.length,
    aiGeneratedCount: 0,
    identitySourceCounts,
    separationRule: "真实看板只展示飞书原始事实和可验证派生统计；规则候选仅作为 AI/人工输入，不当作专家问题、优先级或解决状态。",
    warning:
      unresolvedIdentityCount > 0
        ? "部分飞书历史消息只返回 open_id，未拿到真实姓名；请维护 people.json 或运行 users:resolve 补全。"
        : "当前消息发送人均已通过配置、通讯录或消息上下文补齐名称。"
  };
  const outputCandidates = questionCandidates.slice(-500).map(compactCandidateForOutput);
  const outputQuestionRows = outputCandidates.slice(0, 200);
  const outputRuleCandidates = outputCandidates.slice(0, 80);
  const outputAnswerPairs = questionCandidates
    .filter((issue) => issue.firstReplyText)
    .slice(-200)
    .map(compactCandidateForOutput);
  const outputReplyEdges = replyEdges.slice(-500).map(compactReplyEdgeForOutput);
  const outputMessages = messages.map((message) => compactMessageForOutput(message, 1400));
  const ruleDraft = includeAnalysis
    ? {
        source: "local_rule_draft_for_ai_input_only",
        warning: "以下分类、优先级、SLA、排班均为脚本草稿，不是真实结论；必须由 AI 或人工审核后才能用于运营决策。",
        questionCandidates: outputRuleCandidates,
        candidateCount: questionCandidates.length,
        explicitReplyCandidateCount: questionCandidates.filter((issue) => issue.firstReplyTime).length,
        avgExplicitReplyCandidateSeconds: candidateReplySeconds.length
          ? Math.round(candidateReplySeconds.reduce((sum, value) => sum + value, 0) / candidateReplySeconds.length)
          : null,
        priorityCounts: objectCountsToRows(priorityCounts, Object.fromEntries(Object.entries(PRIORITIES).map(([key, value]) => [key, value.label]))),
        categoryCounts: objectCountsToRows(categoryCounts, issueCategoryLabelMap),
        hourlyStaffing: hourlyStaffingDraft,
        calibrationMetrics: calibrationMetricsDraft,
        projectEventImpacts: projectEventImpactsDraft,
        totalWorkloadMinutes: totalWorkloadMinutesDraft
      }
    : {
        source: "disabled_for_real_metrics_endpoint",
        warning: "动态指标接口只返回入库事实聚合，不生成规则候选、优先级、SLA 或排班估算。",
        questionCandidates: [],
        candidateCount: 0,
        explicitReplyCandidateCount: 0,
        avgExplicitReplyCandidateSeconds: null,
        priorityCounts: [],
        categoryCounts: [],
        hourlyStaffing: [],
        calibrationMetrics: { method: "未运行 AI/人工判定前，不计算标准耗时校准。", byPriority: [], byCategory: [] },
        projectEventImpacts: [],
        totalWorkloadMinutes: null
      };

  return {
    messageCount: rows.length,
    firstTime,
    lastTime,
    activeDayCount: Object.keys(byDate).length,
    uniqueSenderCount: staff.length,
    internalSenderCount: internalStaff.length,
    expertQuestionCount: 0,
    questionCount: 0,
    questionCandidateCount: questionCandidates.length,
    analysisCandidateCount: questionCandidates.length,
    replyCount: replyEdges.length,
    unresolvedIssueCount: 0,
    unansweredQuestionCount: 0,
    avgFirstResponseSeconds: null,
    avgResolutionSeconds: null,
    avgReplySeconds: replyLatencies.length ? Math.round(replyLatencies.reduce((sum, value) => sum + value, 0) / replyLatencies.length) : null,
    p90FirstResponseSeconds: null,
    p90ResolutionSeconds: null,
    p90ReplySeconds: percentile(replyLatencies, 0.9),
    slaHitRate: null,
    overSlaCount: null,
    faqHitRate: null,
    duplicateRate: null,
    oneShotResolveRate: null,
    totalWorkloadMinutes: null,
    staffingModel: STAFFING_MODEL,
    standardWorkMinuteTable: standardWorkMinuteRows(),
    workloadMethod: "真实数据不直接计算排班；排班必须基于 AI/人工确认后的问题分类、优先级和有效回复判定。",
    dataAuthenticity,
    identitySourceCounts,
    priorityCounts: [],
    categoryCounts: [],
    finalStatusCounts: [],
    hourlyStaffing: [],
    calibrationMetrics: {
      method: "未运行 AI/人工判定前，不计算标准耗时校准。",
      byPriority: [],
      byCategory: []
    },
    projectEvents,
    projectEventImpacts: [],
    ruleDraft,
    coreMetricSummary: {
      hourlyMessageCount,
      hourlyQuestionCandidateCount,
      messageTypeDistribution: objectCountsToRows(byMsgType),
      identitySourceDistribution: identitySourceCounts,
      replyEdgeCount: replyEdges.length,
      avgExplicitReplySeconds: replyLatencies.length ? Math.round(replyLatencies.reduce((sum, value) => sum + value, 0) / replyLatencies.length) : null,
      p90ExplicitReplySeconds: percentile(replyLatencies, 0.9),
      ruleCandidateCount: questionCandidates.length
    },
    issues: [],
    analysisCandidates: outputCandidates,
    questionCandidates: [],
    unresolvedIssues: [],
    byDate: Object.entries(byDate).sort().map(([date, count]) => ({ date, count })),
    byHour,
    byMsgType,
    messageTypeRows: objectCountsToRows(byMsgType),
    byProject: topEntries(byProject),
    byChat: topEntries(byChat),
    projectBreakdown,
    topTerms: topEntries(byTerm, 30),
    staff: staff.sort((a, b) => b.messageCount - a.messageCount),
    internalStaff: internalStaff.sort((a, b) => b.replyCount - a.replyCount),
    questionRows: outputQuestionRows,
    unansweredQuestions: [],
    answerPairs: outputAnswerPairs,
    replyEdges: outputReplyEdges,
    messages: outputMessages
  };
}

async function buildDashboard(args) {
  const dir = archiveDir(args);
  const configuredPeople = readPeople();
  const groups = readGroups();
  const buildStartedAt = Date.now();
  const logStep = (step) => console.log(`[dashboard] ${step} +${Date.now() - buildStartedAt}ms`);
  const projectNameById = Object.values(groups).reduce((acc, group) => {
    if (group.projectId && group.projectName && !acc[group.projectId]) acc[group.projectId] = group.projectName;
    return acc;
  }, {});
  const projectEvents = readProjectEvents().map((event) => ({
    ...event,
    projectName: event.projectName || projectNameById[event.projectId] || event.projectId || "全部项目"
  }));
  logStep("读取消息明细");
  const rows = await readAllMessages(dir);
  logStep(`消息明细 ${rows.length} 条`);
  const people = buildPeopleDirectory(rows, configuredPeople);
  const messageById = new Map(rows.map((row) => [row.messageId, row]));
  const nowMs = Date.now();
  const periods = {};
  logStep("计算总览指标");
  for (const preset of dashboardPresetRows(rows, nowMs)) {
    const periodEvents = projectEvents.filter((event) => eventInRange(event, preset.startMs, preset.endMs));
    periods[preset.key] = {
      label: preset.label,
      startMs: preset.startMs,
      endMs: preset.endMs,
      metrics: groupMetrics(preset.rows, people, messageById, { projectEvents: periodEvents })
    };
  }
  const projectMap = Object.entries(groups || {})
    .filter(([, group]) => group?.enabled !== false)
    .reduce((acc, [chatId, group]) => {
      const projectId = group.projectId || defaultProjectIdForChat({ chat_id: chatId });
      const projectName = group.projectName || group.groupName || group.chatName || projectId;
      const item = acc[projectId] || {
        projectId,
        projectName,
        chats: {},
        rows: []
      };
      item.chats[chatId] = {
        chatId,
        groupName: group.groupName || group.chatName || projectName,
        external: group.external === true,
        messageCount: 0
      };
      acc[projectId] = item;
      return acc;
    }, {});
  for (const row of rows) {
      const project = rowProject(row);
      const key = project.projectId;
      const item = projectMap[key] || {
        projectId: project.projectId,
        projectName: project.projectName,
        chats: {},
        rows: []
      };
      item.rows.push(row);
      item.chats[project.chatId] = {
        chatId: project.chatId,
        groupName: project.groupName,
        external: groups[project.chatId]?.external === true,
        messageCount: (item.chats[project.chatId]?.messageCount || 0) + 1
      };
      projectMap[key] = item;
  }
  logStep("计算项目指标");
  const projects = Object.values(projectMap).map((project) => {
    const projectPeriods = {};
    for (const preset of dashboardPresetRows(project.rows, nowMs)) {
      const periodEvents = projectEvents.filter(
        (event) => eventInRange(event, preset.startMs, preset.endMs) && eventMatchesProject(event, project.projectId)
      );
      projectPeriods[preset.key] = {
        label: preset.label,
        startMs: preset.startMs,
        endMs: preset.endMs,
        metrics: groupMetrics(preset.rows, people, messageById, { projectEvents: periodEvents })
      };
    }
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      chats: Object.values(project.chats),
      events: projectEvents.filter((event) => eventMatchesProject(event, project.projectId)),
      periods: projectPeriods,
      metrics: projectPeriods.all.metrics
    };
  });
  logStep(`项目指标 ${projects.length} 个`);
  const runtimeAiConfig = aiConfig();
  const aiApiKeyConfigured = Boolean(runtimeAiConfig.apiKey);
  const aiConnection = {
    enabled: aiApiKeyConfigured,
    autoRunEnabled: process.env.AI_ENABLED === "1",
    configured: aiApiKeyConfigured,
    provider: runtimeAiConfig.baseUrl,
    model: runtimeAiConfig.model,
    status:
      aiApiKeyConfigured
        ? "ready"
        : "missing_api_key"
  };
  const aiMaxCandidates = Number(args["max-candidates"] || process.env.AI_MAX_CANDIDATES || 10);
  const realMetricsForAi = metricsSummaryForAi(periods.all.metrics, 0, false);
  // Phase 4: 把 AI 的分析窗口固定到近 7 天 —— 摘要、候选都用 7d，避免 30d 数据稀释最近的运营状况
  const recentMetrics7d = periods["7d"]?.metrics || periods.all.metrics;
  const recentRealMetricsForAi = metricsTinySummaryForAi(recentMetrics7d);
  const ruleDraftForReview = compactRuleDraftForAi(
    periods.all.metrics.ruleDraft,
    (recentMetrics7d.analysisCandidates || []).slice(0, aiMaxCandidates).map(compactCandidateForAi)
  );
  const aiInput = {
    generatedAt: new Date().toISOString(),
    purpose: "给 AI 做群运营迭代分析：基于真实消息事实判断哪些是专家问题、有效回复、分类分级、FAQ沉淀、SLA诊断、工作量估算和排班建议。",
    analysisWindow: {
      key: "7d",
      label: "近 7 天",
      startTime: periods["7d"]?.startMs ? new Date(periods["7d"].startMs).toISOString() : null,
      endTime: periods["7d"]?.endMs ? new Date(periods["7d"].endMs).toISOString() : null,
      note: "本次分析仅覆盖最近 7 天的真实数据，所有结论必须基于该窗口内的证据。"
    },
    analysisWorkflow: ["采集数据", "给专家问题分类分级", "计算每个时间段工作量", "换算运营人数", "形成排班表"],
    sourceBoundary: {
      realDashboard: "只包含飞书原始消息与可验证派生统计。",
      ruleDraft: "只用于召回候选消息，不能作为运营结论。",
      aiDashboard: "只有模型或人工确认后的分类、优先级、解决状态、FAQ、排班建议才展示在 AI 分析页。"
    },
    dataCollectionFields: [
      "projectId",
      "projectName",
      "chatId",
      "groupName",
      "createTime",
      "senderRoleLabel",
      "text",
      "questionCandidate",
      "expertQuestionStatus",
      "isOperatorReply",
      "replyObjectMessageId"
    ],
    candidateFieldsForAiJudgement: [
      "issueId",
      "questionTime",
      "candidateReason",
      "messages",
      "explicitReplyCandidateMessageId",
      "replyConfidence",
      "ruleDraft"
    ],
    aiMustJudgeFields: [
      "isExpertQuestion",
      "categoryName",
      "priority",
      "isFaqCovered",
      "isDuplicate",
      "isBlocking",
      "hasEmotionRisk",
      "needsCrossTeam",
      "effectiveReplyMessageId",
      "finalStatus"
    ],
    realResponseFields: [
      "replyObjectMessageId",
      "replyEdges",
      "avgReplySeconds"
    ],
    aiResponseFields: [
      "firstResponseSeconds",
      "resolutionSeconds",
      "operatorReplyCount",
      "expertFollowupCount",
      "isOneShotResolved",
      "isOverSla",
      "standardWorkMinutes",
      "actualWorkMinutes"
    ],
    projectRhythmFields: ["eventId", "eventName", "eventTime", "eventType", "impact", "relatedCategoryIds", "impactWindowHours"],
    priorityRules: PRIORITIES,
    staffingModel: STAFFING_MODEL,
    standardWorkMinuteTable: standardWorkMinuteRows(),
    categories: ISSUE_CATEGORIES.map(({ id, name, keywords }) => ({ id, name, keywords })),
    projectEventTypes: PROJECT_EVENT_TYPES,
    expectedOutputSchema: {
      issueUpdates: [
        {
          issueId: "string",
          sourceMessageIds: ["string"],
          correctedCategory: "string（必须是 categories[].name 之一）",
          correctedPriority: "P0|P1|P2|P3",
          isExpertQuestion: "boolean",
          isFaqCovered: "boolean（FAQ/文档是否已覆盖该问题）",
          isDuplicate: "boolean（是否与其他 issue 重复）",
          isBlocking: "boolean（是否阻塞专家继续作业）",
          hasEmotionRisk: "boolean（是否带情绪/投诉风险）",
          needsCrossTeam: "boolean（是否需要跨团队协作）",
          effectiveReplyMessageId: "string",
          finalStatus: "已回复|已解决|未解决|已升级",
          standardWorkMinutesAdjustment: "number|null",
          reason: "string"
        }
      ],
      commonQuestions: [{ question: "string", frequency: "number", suggestedAnswer: "string", evidenceIssueIds: ["string"] }],
      answerPlaybook: [{ scenario: "string", recommendedReply: "string", ownerTeam: "string", sourceIssueIds: ["string"] }],
      staffingPlan: [{ slot: "YYYY-MM-DD HH:00", suggestedHeadcount: "number", roles: [{ role: "string", count: "number" }] }],
      projectEventUpdates: [{ eventId: "string", observedImpact: "string", predictedNextPeak: "string", evidenceIssueIds: ["string"] }],
      standardWorkMinuteCalibration: [
        { priority: "P0|P1|P2|P3", currentMinutes: "number", suggestedMinutes: "number", reason: "string" }
      ],
      risks: [{ risk: "string", evidence: "string", severity: "low|medium|high" }],
      nextActions: ["string"]
    },
    realMetrics: realMetricsForAi,
    recentRealMetrics: recentRealMetricsForAi,
    ruleDraftForReview,
    projects: projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      chats: project.chats,
      events: project.events,
      metrics: metricsTinySummaryForAi(project.metrics)
    }))
  };
  const existingAiInsights = readJson(path.resolve(dir, "dashboard", "ai-insights.json"), null);
  const aiInsights =
    existingAiInsights?.source === "model" && !args["reset-ai"]
      ? {
          ...existingAiInsights,
          staleWarning: "已有模型分析结果被保留；如果重新同步了大量历史消息，请运行 npm run ai:analyze -- --run --write 重新生成。"
        }
      : {
    generatedAt: new Date().toISOString(),
    source: "not_run",
    status: aiConnection.status,
    model: aiConnection.model || "",
    note: "当前没有模型产出的 AI 分析。真实看板不会使用规则草稿冒充 AI 结论；配置 AI_ENABLED=1、AI_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY、AI_MODEL 后运行 npm run ai:analyze -- --run --write。",
    commonQuestions: [],
    answerPlaybook: [],
    staffingPlan: [],
    standardWorkMinuteCalibration: [],
    projectRhythmImpacts: [],
    coreMetrics: {},
    staffingFindings: [],
    unresolvedQuestions: [],
    risks: [],
    nextActions: []
  };
  const dashboard = {
    generatedAt: new Date().toISOString(),
    archiveDir: dir,
    storageStatus: await readStorageStatus(dir),
    aiConnection,
    peopleConfigured: Object.keys(configuredPeople).length,
    peopleDirectoryCount: Object.keys(people).length,
    groups,
    staffingModel: STAFFING_MODEL,
    standardWorkMinuteTable: standardWorkMinuteRows(),
    projectEventTypes: PROJECT_EVENT_TYPES,
    projectEvents,
    projects,
    periods
  };
  if (args.write) {
    const outputDir = path.resolve(dir, "dashboard");
    ensureDir(outputDir);
    const browserDashboard = compactDashboardForBrowser(dashboard);
    writeJsonAtomic(path.resolve(outputDir, "dashboard.json"), browserDashboard);
    if (process.env.WRITE_FULL_DASHBOARD === "1") {
      writeJsonAtomic(path.resolve(outputDir, "dashboard-full.json"), dashboard);
    }
    writeJsonAtomic(path.resolve(outputDir, "ai-iteration-input.json"), aiInput);
    writeJsonAtomic(path.resolve(outputDir, "ai-insights.json"), aiInsights);
    writeJsonAtomic(path.resolve(outputDir, "storage-status.json"), dashboard.storageStatus);
    console.log(`[dashboard] ${path.resolve(outputDir, "dashboard.json")}`);
    if (process.env.WRITE_FULL_DASHBOARD === "1") console.log(`[dashboard] ${path.resolve(outputDir, "dashboard-full.json")}`);
    console.log(`[dashboard] ${path.resolve(outputDir, "ai-iteration-input.json")}`);
    console.log(`[dashboard] ${path.resolve(outputDir, "ai-insights.json")}`);
  }
  console.log(JSON.stringify({ generatedAt: dashboard.generatedAt, totalMessages: periods.all.metrics.messageCount, archiveDir: dir }, null, 2));
  return dashboard;
}

function aiConfig() {
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "";
  const baseUrl =
    process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  const isOpenRouter = Boolean(process.env.OPENROUTER_API_KEY) || baseUrl.includes("openrouter.ai");
  const model = process.env.AI_MODEL || process.env.OPENAI_MODEL || (isOpenRouter ? "qwen/qwen-2.5-72b-instruct" : "gpt-4.1-mini");
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model, isOpenRouter };
}

// 先用 fetch；如果遇到 5xx 或返回不是 JSON（比如 Cloudflare 直接吐 "Internal Server Error" 文本），
// 回退到 spawn curl。常见于 Node undici 的 TLS/HTTP 行为被中间层认成 bot 的环境。
async function chatCompletionsRequest(url, headers, body) {
  const tryParseJson = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };
  let fetchStatus = null;
  let fetchText = "";
  try {
    const r = await fetch(url, { method: "POST", headers, body });
    fetchStatus = r.status;
    fetchText = await r.text();
    if (r.ok) {
      const json = tryParseJson(fetchText);
      if (json) return json;
    }
  } catch (e) {
    fetchText = `fetch threw: ${e.message}`;
  }
  // 失败：要么 5xx，要么响应不是 JSON。回退 curl。
  const shouldFallback = fetchStatus === null || fetchStatus >= 500 || !tryParseJson(fetchText);
  if (!shouldFallback) {
    // 4xx 且是合法 JSON：原样返回错误对象给上层处理
    return tryParseJson(fetchText) || { __error: `HTTP ${fetchStatus}: ${fetchText.slice(0, 300)}` };
  }
  console.error(`[ai] fetch 失败（status=${fetchStatus}），回退 curl 重试`);
  const curlArgs = ["-sS", "--fail-with-body", "-X", "POST", url, "--data-binary", "@-"];
  for (const [k, v] of Object.entries(headers)) curlArgs.push("-H", `${k}: ${v}`);
  try {
    const stdout = execFileSync("curl", curlArgs, { input: body, maxBuffer: 50 * 1024 * 1024, encoding: "utf8" });
    const json = tryParseJson(stdout);
    if (json) return json;
    return { __error: `curl 返回非 JSON：${stdout.slice(0, 300)}` };
  } catch (e) {
    const stderr = e.stderr?.toString?.() || e.message;
    const stdoutErr = e.stdout?.toString?.() || "";
    const json = tryParseJson(stdoutErr);
    if (json) return json;
    return { __error: `curl 失败：${stderr.slice(0, 300)} ${stdoutErr.slice(0, 200)}` };
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI 返回为空");
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("AI 返回不是 JSON");
  }
}

function compactAiInput(aiInput, limit) {
  const maxCandidates = Number(limit || process.env.AI_MAX_CANDIDATES || 10);
  const realMetrics = metricsSummaryForAi(aiInput.realMetrics, 0, false);
  const recentRealMetrics = metricsTinySummaryForAi(aiInput.recentRealMetrics);
  const ruleCandidates = (
    aiInput.ruleDraftForReview?.questionCandidates ||
    realMetrics.analysisCandidates ||
    []
  )
    .slice(0, maxCandidates)
    .map(compactCandidateForAi);
  return {
    generatedAt: aiInput.generatedAt,
    purpose: aiInput.purpose,
    analysisWindow: aiInput.analysisWindow,
    analysisWorkflow: aiInput.analysisWorkflow,
    sourceBoundary: aiInput.sourceBoundary,
    dataCollectionFields: aiInput.dataCollectionFields,
    candidateFieldsForAiJudgement: aiInput.candidateFieldsForAiJudgement,
    aiMustJudgeFields: aiInput.aiMustJudgeFields,
    realResponseFields: aiInput.realResponseFields,
    aiResponseFields: aiInput.aiResponseFields,
    projectRhythmFields: aiInput.projectRhythmFields,
    priorityRules: aiInput.priorityRules,
    staffingModel: aiInput.staffingModel,
    standardWorkMinuteTable: aiInput.standardWorkMinuteTable,
    categories: aiInput.categories,
    projectEventTypes: aiInput.projectEventTypes,
    expectedOutputSchema: aiInput.expectedOutputSchema,
    realMetrics,
    recentRealMetrics,
    ruleDraftForReview: compactRuleDraftForAi(aiInput.ruleDraftForReview, ruleCandidates),
    projects: (aiInput.projects || []).map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      chats: project.chats,
      events: project.events,
      metrics: metricsTinySummaryForAi(project.metrics)
    }))
  };
}

async function aiAnalyze(args) {
  const dir = archiveDir(args);
  const outputDir = path.resolve(dir, "dashboard");
  const inputPath = path.resolve(outputDir, "ai-iteration-input.json");
  const outputPath = path.resolve(outputDir, "ai-insights.json");
  await buildDashboard({ ...args, write: true });
  const enabled = args.run || process.env.AI_ENABLED === "1";
  const { apiKey, baseUrl, model, isOpenRouter } = aiConfig();
  if (!enabled || !apiKey) {
    const disabled = {
      generatedAt: new Date().toISOString(),
      source: "not_run",
      status: !enabled ? "disabled" : "missing_api_key",
      model: enabled ? model : "",
      note:
        "AI 分析没有运行。为避免把群消息发给外部模型并产生费用，需要显式设置 AI_ENABLED=1 或使用 --run，并配置 AI_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY。",
      commonQuestions: [],
      answerPlaybook: [],
      staffingPlan: [],
      standardWorkMinuteCalibration: [],
      projectRhythmImpacts: [],
      risks: [],
      nextActions: []
    };
    if (args.write) {
      ensureDir(outputDir);
      writeJsonAtomic(outputPath, disabled);
    }
    console.log(JSON.stringify({ skipped: true, status: disabled.status, outputPath }, null, 2));
    return disabled;
  }

  const aiInput = compactAiInput(readJson(inputPath, {}), args["max-candidates"]);
  const allowedCategories = (aiInput.categories || []).map((c) => c.name);
  const prompt = [
    "你是飞书群运营分析专家。本次分析窗口固定为近 7 天（见输入 analysisWindow），不要引用更早或更新的数据。",
    "只基于输入中的真实消息和规则候选做分析；严格区分真实事实、规则候选、AI 判断，不要把没有证据的内容当事实。",
    "",
    "【硬性输出要求】",
    "1) issueUpdates 数组：对输入 ruleDraftForReview.questionCandidates 中的每个 issueId 都要输出一条记录。",
    `   - correctedCategory 必须严格等于以下 ${allowedCategories.length} 个值之一（不允许新增、不允许英文、不允许留空、不允许 \"其他\" / \"待判断\" / \"未分类\"）：${allowedCategories.map((n) => `\"${n}\"`).join(" / ")}。如果实在判断不出来就选最接近的那一类。`,
    "   - correctedPriority 必须是 P0/P1/P2/P3 之一（参考 priorityRules 的定义和示例）。",
    "   - 必须填写 6 个布尔判断：isExpertQuestion, isFaqCovered, isDuplicate, isBlocking, hasEmotionRisk, needsCrossTeam（每个都必须是 true/false，不允许 null）。",
    "   - 还要给 effectiveReplyMessageId（找不到就 \"\"）、finalStatus（已回复/已解决/未解决/已升级 之一）、reason（一句话说明判断依据）。",
    "2) commonQuestions/answerPlaybook/staffingPlan/projectEventUpdates/standardWorkMinuteCalibration/risks/nextActions 字段都要返回，证据不足时返回空数组而不是省略。",
    "3) commonQuestions 至少要给 3 条（基于近 7 天最高频的几类问题），每条必须有 evidenceIssueIds（对应 issueUpdates 里的 issueId）。answerPlaybook 给 sourceIssueIds，projectEventUpdates 给 evidenceIssueIds。",
    "4) staffingPlan 至少给 3 个 slot（覆盖一天中流量较高的时段），slot 必须是 \"YYYY-MM-DD HH:00\" 格式，且时段落在近 7 天窗口内。",
    "5) risks 至少 1 条，nextActions 至少 3 条。",
    "",
    "【输出格式】只返回一个 JSON 对象，不要 Markdown、不要解释、不要 ```。",
    "顶层字段：commonQuestions, answerPlaybook, staffingPlan, standardWorkMinuteCalibration, projectEventUpdates, risks, nextActions, issueUpdates。",
    "证据严重不足时把对应数组留空，并把 status 字段写成 \"pending_human_review\"。"
  ].join("\n");
  const requestHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(isOpenRouter ? { "HTTP-Referer": "http://127.0.0.1:4198", "X-Title": "Feishu Group Analysis" } : {})
  };
  const requestBody = JSON.stringify({
    model,
    temperature: 0.2,
    max_tokens: Number(args["max-output-tokens"] || process.env.AI_MAX_OUTPUT_TOKENS || 6000),
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(aiInput) }
    ]
  });
  const body = await chatCompletionsRequest(`${baseUrl}/chat/completions`, requestHeaders, requestBody);
  if (body.__error) throw new Error(`AI 分析失败：${body.__error}`);
  if (body.error) throw new Error(`AI 分析失败：${body.error.message || JSON.stringify(body.error)}`);
  const content = body.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error(`AI 返回为空：${body.choices?.[0]?.finish_reason || "unknown_finish_reason"}`);
  }
  const parsed = extractJsonObject(content);
  // 模型有时会乱写 \"其他 / 待判断\" 等不在白名单里的分类。统一兜底：
  // 如果不合法，找回该 issueId 在 candidates 里的 ruleDraft.categoryName 顶上；再不行就用 \"操作使用\"。
  const allowedCategorySet = new Set((aiInput.categories || []).map((c) => c.name));
  const fallbackByIssueId = new Map();
  for (const c of aiInput.ruleDraftForReview?.questionCandidates || []) {
    if (c?.issueId) fallbackByIssueId.set(c.issueId, c.ruleDraft?.categoryName || "操作使用");
  }
  const sanitizedIssueUpdates = (parsed.issueUpdates || []).map((u) => {
    if (!u || !u.issueId) return u;
    if (allowedCategorySet.has(u.correctedCategory)) return u;
    return { ...u, correctedCategory: fallbackByIssueId.get(u.issueId) || "操作使用", correctedCategoryFallback: true };
  });
  const output = {
    ...parsed,
    generatedAt: new Date().toISOString(),
    source: "model",
    status: parsed.status || "ok",
    model,
    analysisWindow: aiInput.analysisWindow || null,
    inputGeneratedAt: aiInput.generatedAt,
    issueUpdates: sanitizedIssueUpdates,
    commonQuestions: parsed.commonQuestions || [],
    answerPlaybook: parsed.answerPlaybook || [],
    staffingPlan: parsed.staffingPlan || [],
    standardWorkMinuteCalibration: parsed.standardWorkMinuteCalibration || [],
    projectEventUpdates: parsed.projectEventUpdates || [],
    projectRhythmImpacts: parsed.projectRhythmImpacts || parsed.projectEventUpdates || [],
    risks: parsed.risks || [],
    nextActions: parsed.nextActions || []
  };
  if (args.write) {
    ensureDir(outputDir);
    writeJsonAtomic(outputPath, output);
  }
  console.log(JSON.stringify({ source: output.source, status: output.status, model, outputPath }, null, 2));
  return output;
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "application/octet-stream";
}

function safeCacheName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

function extensionForContentType(contentType = "") {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  return ".bin";
}

function cachedResourcePaths(dir, messageId, fileKey, type) {
  const cacheDir = path.resolve(dir, "resources", safeCacheName(type), safeCacheName(messageId));
  const baseName = safeCacheName(fileKey);
  return {
    cacheDir,
    bodyPath: path.resolve(cacheDir, `${baseName}.bin`),
    metaPath: path.resolve(cacheDir, `${baseName}.json`)
  };
}

async function serveMessageResource(args, response, dir, messageId, fileKey, type = "image") {
  if (!messageId || !fileKey) {
    writeJsonResponse(response, 400, { ok: false, error: "缺少 message_id 或 file_key" });
    return;
  }
  const { cacheDir, bodyPath, metaPath } = cachedResourcePaths(dir, messageId, fileKey, type);
  let meta = readJson(metaPath, null);
  if (!fs.existsSync(bodyPath) || !meta?.contentType) {
    const token = await tenantToken();
    const resource = await fetchMessageResource(token, messageId, fileKey, type);
    ensureDir(cacheDir);
    fs.writeFileSync(bodyPath, resource.bytes);
    meta = {
      messageId,
      fileKey,
      type,
      contentType: resource.contentType,
      extension: extensionForContentType(resource.contentType),
      cachedAt: new Date().toISOString()
    };
    writeJsonAtomic(metaPath, meta);
  }
  response.writeHead(200, {
    "Content-Type": meta.contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=86400"
  });
  fs.createReadStream(bodyPath).pipe(response);
}

function safeJoin(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(root, decoded.replace(/^\/+/, ""));
  if (!resolved.startsWith(path.resolve(root))) return null;
  return resolved;
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("请求体过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function writeJsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function messagesSourcePayload(dir, params = {}) {
  const messageId = String(params.messageId || "").trim();
  const senderId = String(params.senderId || "").trim();
  const chatId = String(params.chatId || "").trim();
  const projectId = String(params.projectId || "").trim();
  const q = String(params.q || "").trim().toLowerCase();
  const senderQ = String(params.senderQ || "").trim().toLowerCase();
  const metaQ = String(params.metaQ || "").trim().toLowerCase();
  const startMs = params.startMs ? Number(params.startMs) : null;
  const endMs = params.endMs ? Number(params.endMs) : null;
  const limit = Math.max(1, Math.min(500, Number(params.limit || 200)));
  const offset = Math.max(0, Number(params.offset || 0));
  const configuredPeople = readPeople();
  const senderIds = senderQ ? senderIdsForQuery(configuredPeople, senderQ) : [];
  let rows = [];
  let source = "file";
  let totalOverride = null;
  if (isByteHouseProvider()) {
    try {
      if (messageId) {
        const targetRows = await readMessagesFromDb(dir, { messageId });
        const target = targetRows[0];
        if (target?.chatId) {
          const targetMs = Number(target.createTimeMs || 0);
          rows = await readMessagesFromDb(dir, {
            chatId: target.chatId,
          projectId: target.projectId || projectId,
          startMs: targetMs ? targetMs - 24 * 60 * 60 * 1000 : null,
          endMs: targetMs ? targetMs + 24 * 60 * 60 * 1000 : null
          });
          if (!rows.some((row) => row.messageId === messageId)) rows.push(target);
        } else {
          rows = targetRows;
        }
      } else {
        rows = await readMessagesFromDb(dir, {
          chatId,
          projectId,
          senderId,
          senderIds,
          senderQ,
          metaQ,
          startMs,
          endMs,
          q,
          limit: limit + offset,
          orderDesc: true
        });
        totalOverride = await countMessagesFromDb(dir, { chatId, projectId, senderId, senderIds, senderQ, metaQ, startMs, endMs, q });
      }
      if (rows.length) source = "bytehouse";
    } catch {
      rows = [];
      totalOverride = null;
    }
  }
  if (!rows.length) rows = readMessagesFromFiles(dir);
  const people = buildPeopleDirectory(rows, configuredPeople);
  const messages = rows.map((row) => enrichMessage(row, people));
  const byId = new Map(messages.map((message) => [message.messageId, message]));

  let filtered = messages.filter((message) => {
    if (senderId && message.senderId !== senderId) return false;
    if (chatId && message.chatId !== chatId) return false;
    if (projectId && message.projectId !== projectId) return false;
    if (messageId && message.messageId !== messageId) return false;
    if (startMs && Number(message.createTimeMs || 0) < startMs) return false;
    if (endMs && Number(message.createTimeMs || 0) > endMs) return false;
    if (
      senderQ &&
      ![message.senderName, message.senderId].filter(Boolean).some((value) => String(value).toLowerCase().includes(senderQ))
    ) {
      return false;
    }
    if (
      metaQ &&
      ![message.groupName, message.projectName, message.messageId, message.msgType, message.chatId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(metaQ))
    ) {
      return false;
    }
    if (q) {
      const haystack = [
        message.text,
        message.senderName,
        message.senderId,
        message.groupName,
        message.projectName,
        message.messageId,
        message.msgType
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (messageId && filtered.length) {
    const target = filtered[0];
    const sameChat = messages
      .filter((message) => message.chatId === target.chatId)
      .sort((a, b) => Number(a.createTimeMs || 0) - Number(b.createTimeMs || 0));
    const idx = sameChat.findIndex((message) => message.messageId === target.messageId);
    filtered = sameChat.slice(Math.max(0, idx - 20), Math.min(sameChat.length, idx + 21));
  }

  filtered.sort((a, b) => Number(b.createTimeMs || 0) - Number(a.createTimeMs || 0));
  const total = totalOverride ?? filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const replyEdges = page
    .map((message) => {
      const parentId = message.replyToMessageId || message.replyObjectMessageId || "";
      const parent = parentId ? byId.get(parentId) : null;
      if (!parent) return null;
      return {
        replyMessageId: message.messageId,
        replyTime: message.createTime,
        replyTimeMs: message.createTimeMs,
        replier: message.senderName,
        replierId: message.senderId,
        replierRole: message.senderRole,
        replierTeam: message.senderTeam,
        replierNameSource: message.senderNameSource,
        parentMessageId: parent.messageId,
        parentTime: parent.createTime,
        parentTimeMs: parent.createTimeMs,
        parentSender: parent.senderName,
        parentSenderId: parent.senderId,
        parentSenderTeam: parent.senderTeam,
        parentSenderNameSource: parent.senderNameSource,
        parentText: parent.text || "",
        parentMsgType: parent.msgType || "",
        parentRichBlocks: parent.richBlocks || [],
        parentResources: parent.resources || [],
        projectName: message.projectName || parent.projectName || "",
        groupName: message.groupName || parent.groupName || "",
        replyText: message.text || "",
        replyMsgType: message.msgType || "",
        replyRichBlocks: message.richBlocks || [],
        replyResources: message.resources || [],
        latencySeconds:
          parent.createTimeMs && message.createTimeMs ? Math.max(0, Math.round((message.createTimeMs - parent.createTimeMs) / 1000)) : null
      };
    })
    .filter(Boolean)
    .map(compactReplyEdgeForOutput);

  return {
    total,
    offset,
    limit,
    source,
    messages: page.map((message) => compactMessageForBrowser(message, 900)),
    replyEdges,
    filters: { senderId, chatId, projectId, q, messageId, startMs, endMs }
  };
}

async function metricsPayload(dir, params = {}) {
  const chatId = String(params.chatId || "").trim();
  const projectId = String(params.projectId || "").trim();
  const startMs = params.startMs ? Number(params.startMs) : null;
  const endMs = params.endMs ? Number(params.endMs) : null;
  const limit = Math.max(100, Math.min(50_000, Number(params.limit || 50_000)));
  const filters = { chatId, projectId, startMs, endMs };
  let rows = [];
  let total = 0;
  let source = "file";
  if (isByteHouseProvider()) {
    const metrics = await readAggregateMetricsFromDb(dir, filters);
    total = Number(metrics?.messageCount || 0);
    return {
      source: "bytehouse",
      total,
      returned: total,
      truncated: false,
      filters,
      metrics: compactMetricsForBrowser(metrics, {
        keepMessages: false,
        candidateLimit: 0,
        staffLimit: 500
      })
    };
  } else {
    rows = readMessagesFromFiles(dir).filter((row) => {
      if (chatId && row.chatId !== chatId) return false;
      if (projectId && row.projectId !== projectId) return false;
      if (startMs && Number(row.createTimeMs || 0) < startMs) return false;
      if (endMs && Number(row.createTimeMs || 0) > endMs) return false;
      return true;
    });
    total = rows.length;
    rows = rows.slice(0, limit);
  }
  const configuredPeople = readPeople();
  const people = buildPeopleDirectory(rows, configuredPeople);
  const messageById = new Map(rows.map((row) => [row.messageId, row]));
  const projectNameById = Object.values(readGroups()).reduce((acc, group) => {
    if (group.projectId && group.projectName && !acc[group.projectId]) acc[group.projectId] = group.projectName;
    return acc;
  }, {});
  const projectEvents = readProjectEvents()
    .map((event) => ({
      ...event,
      projectName: event.projectName || projectNameById[event.projectId] || event.projectId || "全部项目"
    }))
    .filter((event) => {
      if (projectId && event.projectId && event.projectId !== projectId) return false;
      return eventInRange(event, startMs, endMs);
    });
  const metrics = groupMetrics(rows, people, messageById, { projectEvents, includeAnalysis: false });
  return {
    source,
    total,
    returned: rows.length,
    truncated: rows.length < total,
    filters,
    metrics: compactMetricsForBrowser(metrics, {
      keepMessages: true,
      messageLimit: Math.min(limit, 5_000),
      candidateLimit: 500,
      staffLimit: 500
    })
  };
}

async function serve(args) {
  const port = Number(args.port || process.env.PORT || 4198);
  const publicRoot = path.resolve("public");
  const dir = archiveDir(args);
  const dashboardPath = path.join(dir, "dashboard", "dashboard.json");
  if (!fs.existsSync(dashboardPath)) {
    await buildDashboard({ ...args, write: true });
  } else {
    console.log(`[serve] using existing dashboard ${dashboardPath}`);
  }
  const refreshState = {
    running: false,
    stage: "idle",
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    error: "",
    result: null
  };
  const refreshSnapshot = () => ({
    ...refreshState,
    elapsedMs: refreshState.running && refreshState.startedAt ? Date.now() - Date.parse(refreshState.startedAt) : refreshState.durationMs || 0
  });
  const refreshStageTimeoutMs = Number(process.env.REFRESH_STAGE_TIMEOUT_MS || 180_000);
  const withRefreshStageTimeout = (label, promise) => {
    if (!refreshStageTimeoutMs || refreshStageTimeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} 超时（${Math.round(refreshStageTimeoutMs / 1000)} 秒），已释放刷新状态`)),
        refreshStageTimeoutMs
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  const runRefreshJob = async () => {
    if (refreshState.running) return;
    const startedMs = Date.now();
    refreshState.running = true;
    refreshState.startedAt = new Date(startedMs).toISOString();
    refreshState.finishedAt = "";
    refreshState.durationMs = 0;
    refreshState.error = "";
    refreshState.result = null;
    try {
      refreshState.stage = "发现新群";
      const discovery = await withRefreshStageTimeout("发现新群", discoverGroups({ ...args, write: true, soft: true }));
      refreshState.stage = "同步消息";
      const syncStats = await withRefreshStageTimeout("同步消息", sync({ ...args, "write-report": true }));
      const shouldRebuildDashboard = process.env.REFRESH_REBUILD_DASHBOARD === "1";
      let dashboardSummary = null;
      if (shouldRebuildDashboard) {
        refreshState.stage = "重建看板";
        const dashboard = await withRefreshStageTimeout("重建看板", buildDashboard({ ...args, write: true }));
        dashboardSummary = { generatedAt: dashboard.generatedAt, totalMessages: dashboard.periods?.all?.metrics?.messageCount || 0 };
      } else {
        refreshState.stage = "刷新统计";
        const storage = await withRefreshStageTimeout("刷新统计", writeStorageStatus(dir));
        dashboardSummary = {
          generatedAt: new Date().toISOString(),
          totalMessages: storage.messageCount || 0,
          skippedRebuild: true
        };
      }
      refreshState.result = {
        refreshedAt: new Date().toISOString(),
        discovery,
        syncStats,
        dashboard: dashboardSummary
      };
      refreshState.stage = "完成";
    } catch (error) {
      refreshState.error = error.message;
      refreshState.stage = "失败";
    } finally {
      refreshState.running = false;
      refreshState.finishedAt = new Date().toISOString();
      refreshState.durationMs = Date.now() - startedMs;
    }
  };
  // AI 分析锁 + 上次运行元数据
  let aiRunning = false;
  let aiLastStartedAt = null;
  let aiLastFinishedAt = null;
  let aiLastDurationMs = null;
  let aiLastError = null;
  const manualOpsPath = path.join(dir, "dashboard", "manual-ops.json");
  const readManualOps = () => {
    try {
      if (!fs.existsSync(manualOpsPath)) return {};
      return JSON.parse(fs.readFileSync(manualOpsPath, "utf8")) || {};
    } catch {
      return {};
    }
  };
  const writeManualOps = (data) => {
    fs.mkdirSync(path.dirname(manualOpsPath), { recursive: true });
    writeJsonAtomic(manualOpsPath, data);
  };
  // 懒加载 chat router（只有在 /api/chat/* 命中时才动态 import，避免影响 serve 启动速度）
  let chatRouter = null;
  const loadChatRouter = async () => {
    if (chatRouter) return chatRouter;
    chatRouter = (await import("./agent/chat-handler.js")).routeChatRequest;
    return chatRouter;
  };
  // 复用 agent/projects.js 的实现，保持单一来源
  const projectsSnapshot = listProjectsRawShared;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/chat/")) {
      try {
        const route = await loadChatRouter();
        const handled = await route(request, response, url, projectsSnapshot());
        if (handled) return;
        // 未匹配子路由：直接 404，不要落到下面的静态资源逻辑
        writeJsonResponse(response, 404, { ok: false, error: `未知 chat 路由：${url.pathname}` });
        return;
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      try {
        const stats = await readProjectStatsFromStorage(dir);
        writeJsonResponse(response, 200, { ok: true, source: storageProvider(), projects: mergeProjectStats(projectsSnapshot(), stats) });
      } catch (error) {
        writeJsonResponse(response, 200, { ok: true, source: "groups", warning: error.message, projects: projectsSnapshot() });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/storage/status") {
      writeJsonResponse(response, 200, { ok: true, storage: await readStorageStatus(dir) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/overview/stats") {
      try {
        writeJsonResponse(response, 200, { ok: true, stats: await readOverviewStatsFromStorage(dir) });
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/metrics") {
      try {
        writeJsonResponse(response, 200, {
          ok: true,
          ...(await metricsPayload(dir, {
            chatId: url.searchParams.get("chatId"),
            projectId: url.searchParams.get("projectId"),
            startMs: url.searchParams.get("startMs"),
            endMs: url.searchParams.get("endMs"),
            limit: url.searchParams.get("limit")
          }))
        });
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/messages") {
      try {
        const payload = await messagesSourcePayload(dir, {
          senderId: url.searchParams.get("senderId"),
          chatId: url.searchParams.get("chatId"),
          projectId: url.searchParams.get("projectId"),
          q: url.searchParams.get("q"),
          senderQ: url.searchParams.get("senderQ"),
          metaQ: url.searchParams.get("metaQ"),
          messageId: url.searchParams.get("messageId"),
          startMs: url.searchParams.get("startMs"),
          endMs: url.searchParams.get("endMs"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset")
        });
        writeJsonResponse(response, 200, { ok: true, ...payload });
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/refresh/status") {
      writeJsonResponse(response, 200, { ok: true, refresh: refreshSnapshot() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      if (!refreshState.running) {
        runRefreshJob().catch((error) => {
          refreshState.running = false;
          refreshState.stage = "失败";
          refreshState.error = error.message;
          refreshState.finishedAt = new Date().toISOString();
        });
      }
      writeJsonResponse(response, 200, { ok: true, refresh: refreshSnapshot() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/ai/status") {
      writeJsonResponse(response, 200, {
        ok: true,
        running: aiRunning,
        lastStartedAt: aiLastStartedAt,
        lastFinishedAt: aiLastFinishedAt,
        lastDurationMs: aiLastDurationMs,
        lastError: aiLastError
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ai/analyze") {
      if (aiRunning) {
        writeJsonResponse(response, 409, { ok: false, error: "AI 分析正在运行中，请等待完成" });
        return;
      }
      aiRunning = true;
      aiLastStartedAt = new Date().toISOString();
      aiLastError = null;
      const startMs = Date.now();
      try {
        const payload = await readRequestJson(request);
        const output = await aiAnalyze({
          ...args,
          run: true,
          write: true,
          "max-candidates": payload.maxCandidates || args["max-candidates"] || 10
        });
        await buildDashboard({ ...args, write: true });
        aiLastFinishedAt = new Date().toISOString();
        aiLastDurationMs = Date.now() - startMs;
        writeJsonResponse(response, 200, {
          ok: true,
          output,
          durationMs: aiLastDurationMs,
          finishedAt: aiLastFinishedAt
        });
      } catch (error) {
        aiLastError = error.message;
        aiLastFinishedAt = new Date().toISOString();
        aiLastDurationMs = Date.now() - startMs;
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      } finally {
        aiRunning = false;
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/manual-ops") {
      writeJsonResponse(response, 200, { ok: true, ops: readManualOps() });
      return;
    }
    if (url.pathname === "/api/project-events") {
      try {
        if (request.method === "GET") {
          writeJsonResponse(response, 200, {
            ok: true,
            events: readProjectEvents(),
            eventTypes: PROJECT_EVENT_TYPES
          });
          return;
        }
        if (request.method === "POST" || request.method === "DELETE") {
          const payload = await readRequestJson(request);
          const eventsPath = path.resolve(process.env.PROJECT_EVENTS_CONFIG || "./project-events.json");
          const raw = readJson(eventsPath, []);
          const list = Array.isArray(raw) ? raw : raw.events || [];
          if (request.method === "DELETE") {
            const eventId = String(payload.eventId || "").trim();
            if (!eventId) {
              writeJsonResponse(response, 400, { ok: false, error: "缺少 eventId" });
              return;
            }
            const next = list.filter((e) => (e.eventId || e.id) !== eventId);
            if (next.length === list.length) {
              writeJsonResponse(response, 404, { ok: false, error: `事件 ${eventId} 不存在` });
              return;
            }
            writeJsonAtomic(eventsPath, next);
          } else {
            // POST：创建或更新
            const projectId = String(payload.projectId || "").trim();
            const eventType = String(payload.eventType || "").trim();
            const eventTime = String(payload.eventTime || "").trim();
            if (!projectId || !eventType || !eventTime) {
              writeJsonResponse(response, 400, { ok: false, error: "缺少 projectId / eventType / eventTime" });
              return;
            }
            const existingId = String(payload.eventId || "").trim();
            const newRecord = {
              eventId: existingId || `EV-${Date.now().toString(36).toUpperCase()}`,
              projectId,
              projectName: String(payload.projectName || "").trim(),
              chatId: String(payload.chatId || "").trim(),
              groupName: String(payload.groupName || "").trim(),
              eventType,
              eventName: String(payload.eventName || "").trim(),
              eventTime,
              impactWindowHours: Number(payload.impactWindowHours) || 48,
              owner: String(payload.owner || "").trim(),
              note: String(payload.note || "").trim(),
              expectedImpact: String(payload.expectedImpact || "").trim()
            };
            const idx = existingId ? list.findIndex((e) => (e.eventId || e.id) === existingId) : -1;
            const next = [...list];
            if (idx >= 0) next[idx] = { ...list[idx], ...newRecord };
            else next.push(newRecord);
            writeJsonAtomic(eventsPath, next);
          }
          // 重建 dashboard 让 projectEventImpacts 立即反映
          const dashboard = await buildDashboard({ ...args, write: true });
          writeJsonResponse(response, 200, {
            ok: true,
            events: readProjectEvents(),
            eventTypes: PROJECT_EVENT_TYPES,
            dashboard: { generatedAt: dashboard.generatedAt }
          });
          return;
        }
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/manual-ops") {
      try {
        const payload = await readRequestJson(request);
        const id = String(payload.id || "").trim();
        if (!id) {
          writeJsonResponse(response, 400, { ok: false, error: "缺少 id" });
          return;
        }
        const ops = readManualOps();
        const cur = ops[id] || {};
        const next = { ...cur };
        if (payload.status) next.status = payload.status; // resolved | reopened
        if (payload.assignedTo !== undefined) next.assignedTo = payload.assignedTo || null;
        if (payload.note !== undefined) next.note = payload.note || "";
        if (payload.clear) {
          delete ops[id];
        } else {
          next.updatedAt = new Date().toISOString();
          ops[id] = next;
        }
        writeManualOps(ops);
        writeJsonResponse(response, 200, { ok: true, ops });
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/people/resolve") {
      try {
        const payload = await readRequestJson(request);
        const summary = await resolveUsers({ ...args, write: true, force: payload.force !== false });
        const dashboard = await buildDashboard({ ...args, write: true });
        writeJsonResponse(response, 200, {
          ok: true,
          summary,
          dashboard: { generatedAt: dashboard.generatedAt, totalMessages: dashboard.periods?.all?.metrics?.messageCount || 0 }
        });
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/people/internal") {
      try {
        const payload = await readRequestJson(request);
        const person = await upsertInternalPerson(payload);
        const dashboard = await buildDashboard({ ...args, write: true });
        writeJsonResponse(response, 200, {
          ok: true,
          person,
          dashboard: { generatedAt: dashboard.generatedAt, totalMessages: dashboard.periods?.all?.metrics?.messageCount || 0 }
        });
      } catch (error) {
        writeJsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/people/internal/remove") {
      try {
        const payload = await readRequestJson(request);
        const person = await removeInternalPerson(payload);
        const dashboard = await buildDashboard({ ...args, write: true });
        writeJsonResponse(response, 200, {
          ok: true,
          person,
          dashboard: { generatedAt: dashboard.generatedAt, totalMessages: dashboard.periods?.all?.metrics?.messageCount || 0 }
        });
      } catch (error) {
        writeJsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    const resourceMatch = url.pathname.match(/^\/api\/message-resource\/([^/]+)\/([^/]+)$/);
    if (request.method === "GET" && resourceMatch) {
      try {
        await serveMessageResource(
          args,
          response,
          dir,
          decodeURIComponent(resourceMatch[1]),
          decodeURIComponent(resourceMatch[2]),
          url.searchParams.get("type") || "image"
        );
      } catch (error) {
        writeJsonResponse(response, 500, { ok: false, error: error.message });
      }
      return;
    }
    let filePath;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      filePath = path.resolve(publicRoot, "index.html");
    } else if (url.pathname.startsWith("/data/")) {
      filePath = safeJoin(path.resolve(dir), url.pathname.replace(/^\/data\//, ""));
    } else {
      filePath = safeJoin(publicRoot, url.pathname);
    }
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(response);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[serve] http://127.0.0.1:${port}`);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function npmPath() {
  try {
    return execFileSync("/bin/zsh", ["-lc", "command -v npm"], { encoding: "utf8" }).trim() || "npm";
  } catch {
    return "npm";
  }
}

function cronBlock(args) {
  const cwd = process.cwd();
  const nodeBin = process.env.NODE_BIN || process.execPath || "node";
  const scriptPath = path.resolve(cwd, "src/group-analysis.js");
  const logPath = path.resolve(archiveDir(args), "cron.log");
  return [
    "# feishu-group-analysis half-hour sync start",
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    `*/30 * * * * cd ${shellQuote(cwd)} && ${shellQuote(nodeBin)} ${shellQuote(scriptPath)} cron-run --trigger cron-30min >> ${shellQuote(logPath)} 2>&1`,
    "# feishu-group-analysis half-hour sync end"
  ].join("\n");
}

function acquireCronLock(args) {
  const dir = archiveDir(args);
  ensureDir(dir);
  const lockPath = path.resolve(dir, "cron.lock");
  const staleMs = Number(process.env.CRON_LOCK_STALE_MINUTES || 90) * 60 * 1000;
  const create = () => {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.resolve(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return () => {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best effort cleanup only
      }
    };
  };
  try {
    return create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > staleMs) {
      console.log(`[cron] 清理超过 ${Math.round(staleMs / 60000)} 分钟的旧锁：${lockPath}`);
      fs.rmSync(lockPath, { recursive: true, force: true });
      return create();
    }
    console.log(`[cron] 上一次同步仍在运行，跳过本轮：${lockPath}`);
    return null;
  }
}

async function cronRun(args) {
  const release = acquireCronLock(args);
  if (!release) return { skipped: true };
  const startedAt = new Date().toISOString();
  try {
    console.log(`[cron] 开始半小时增量同步 ${startedAt}`);
    const discovery = await discoverGroups({ ...args, write: true, soft: true });
    const syncStats = await sync({ ...args, "write-report": true, trigger: args.trigger || "cron-30min" });
    const people = await resolveUsers({ ...args, write: true });
    const dashboard = await buildDashboard({ ...args, write: true });
    const storage = await writeStorageStatus(archiveDir(args));
    const result = {
      startedAt,
      finishedAt: new Date().toISOString(),
      discovery,
      sync: syncStats,
      people: { resolved: people?.resolved || 0, unresolved: people?.unresolved || 0 },
      dashboard: { generatedAt: dashboard.generatedAt, totalMessages: dashboard.periods?.all?.metrics?.messageCount || 0 },
      storage: { messageCount: storage.messageCount || 0, peopleCount: storage.peopleCount || 0 }
    };
    console.log(`[cron] 完成半小时增量同步 ${JSON.stringify(result)}`);
    return result;
  } finally {
    release();
  }
}

function readCrontab() {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function writeCrontab(text) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-group-analysis-cron-"));
  const tmpPath = path.join(tmpDir, "crontab");
  try {
    fs.writeFileSync(tmpPath, `${text.trim()}\n`);
    const result = spawnSync("crontab", [tmpPath], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`写入 crontab 失败：${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function removeCronBlock(current) {
  return current
    .split("\n")
    .reduce(
      (acc, line) => {
        if (/^# feishu-group-analysis (daily|hourly|half-hour) sync start$/.test(line.trim())) {
          acc.skipping = true;
          return acc;
        }
        if (/^# feishu-group-analysis (daily|hourly|half-hour) sync end$/.test(line.trim())) {
          acc.skipping = false;
          return acc;
        }
        if (!acc.skipping) acc.lines.push(line);
        return acc;
      },
      { lines: [], skipping: false }
    )
    .lines.join("\n")
    .trim();
}

function installCron(args) {
  ensureDir(archiveDir(args));
  const current = readCrontab();
  const cleaned = removeCronBlock(current);
  const next = [cleaned, cronBlock(args)].filter(Boolean).join("\n");
  writeCrontab(next);
  console.log("[cron] 已安装每 30 分钟增量同步 + 人员身份回写 + 生成面板数据（AI 分析不自动跑，避免费用与不可信覆盖）");
  console.log(cronBlock(args));
}

function removeCron(args) {
  const current = readCrontab();
  const cleaned = removeCronBlock(current);
  writeCrontab(cleaned || "");
  console.log("[cron] 已移除 feishu-group-analysis 定时任务");
}

async function report(args) {
  const dir = archiveDir(args);
  const date = args.date || localDate(Date.now());
  let rows = await readMessagesFromDb(dir, { date, chatId: args["chat-id"], projectId: args["project-id"] });
  if (!rows.length) {
    const dailyDir = path.resolve(dir, "daily", date);
    let files = fs.existsSync(dailyDir)
      ? fs.readdirSync(dailyDir).filter((name) => name.endsWith(".jsonl")).map((name) => path.resolve(dailyDir, name))
      : [];
    if (args["chat-id"]) files = files.filter((file) => path.basename(file) === `${args["chat-id"]}.jsonl`);
    rows = files.flatMap((file) => readJsonl(file));
    if (args["project-id"]) rows = rows.filter((row) => row.projectId === args["project-id"]);
  }
  const messageById = isByteHouseProvider()
    ? new Map(rows.filter((row) => row.messageId).map((row) => [row.messageId, row]))
    : await loadMessageIndex(dir);
  for (const row of rows) {
    if (row.messageId && !messageById.has(row.messageId)) messageById.set(row.messageId, row);
  }
  const output = summarize(rows, {
    date,
    chatId: args["chat-id"] || rows[0]?.chatId || "",
    projectId: args["project-id"] || rows[0]?.projectId || "",
    projectName: rows[0]?.projectName || "",
    messageById
  });
  if (args.write) {
    const outputPath = path.resolve(dir, "reports", date, "summary.json");
    ensureDir(path.dirname(outputPath));
    writeJsonAtomic(outputPath, output);
    console.log(`[report] ${outputPath}`);
  }
  if (!args.silent) console.log(JSON.stringify(output, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || args.help) {
  usage();
  process.exit(command ? 0 : 1);
}

try {
  if (command === "sync") await sync(args);
  else if (command === "backfill") await backfill(args);
  else if (command === "groups-discover") await discoverGroups(args);
  else if (command === "users-resolve") await resolveUsers(args);
  else if (command === "people-sync") await syncPeopleCommand(args);
  else if (command === "report") await report(args);
  else if (command === "db-import") await importDatabase(args);
  else if (command === "db-status") await printDatabaseStatus(args);
  else if (command === "dashboard") await buildDashboard({ ...args, write: args.write !== false });
  else if (command === "ai-analyze") await aiAnalyze(args);
  else if (command === "serve") await serve(args);
  else if (command === "cron-run") await cronRun(args);
  else if (command === "cron-install") installCron(args);
  else if (command === "cron-remove") removeCron(args);
  else throw new Error(`未知命令：${command}`);
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exit(1);
}
