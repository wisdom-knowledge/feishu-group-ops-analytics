#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.VERIFY_BASE_URL || "http://127.0.0.1:4198";
const root = process.cwd();
const dashboardPath = path.resolve(root, "data/dashboard/dashboard.json");
const peoplePath = path.resolve(root, "people.json");
const htmlPath = path.resolve(root, "public/index.html");

const failures = [];
const passes = [];

function check(condition, label, detail = "") {
  if (condition) passes.push({ label, detail });
  else failures.push({ label, detail });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { cache: "no-store" });
  const text = await response.text();
  let payload = {};
  try {
    payload = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${pathname} 返回非 JSON：${text.slice(0, 200)}`);
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(`${pathname} 失败：HTTP ${response.status} ${payload.error || text.slice(0, 200)}`);
  }
  return payload;
}

function dayRange(date) {
  const startMs = Date.parse(`${date}T00:00:00+08:00`);
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 - 1 };
}

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

function pickDates(byDate) {
  const rows = (byDate || []).filter((row) => Number(row.count || 0) > 0);
  if (!rows.length) return [];
  const indexes = [0, Math.floor(rows.length / 2), rows.length - 1];
  return [...new Set(indexes.map((index) => rows[index]?.date).filter(Boolean))];
}

const dashboard = readJson(dashboardPath, {});
const people = readJson(peoplePath, {});
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
const overviewHtml = html.includes('<section id="overview"')
  ? html.slice(html.indexOf('<section id="overview"'), html.indexOf('<section id="messages"'))
  : "";

const storagePayload = await getJson("/api/storage/status");
const overviewPayload = await getJson("/api/overview/stats");
const projectsPayload = await getJson("/api/projects");

const storage = storagePayload.storage || {};
const overview = overviewPayload.stats || {};
const dashboardMetrics = dashboard.periods?.all?.metrics || {};
const peopleCount = Object.keys(people || {}).length;

check(storage.ok === true && storage.type === "bytehouse", "存储连接使用 ByteHouse", storage.type || "unknown");
check(
  Number(storage.messageCount || 0) === Number(overview.messageCount || 0),
  "ByteHouse 总消息数与 overview 动态统计一致",
  `${storage.messageCount} vs ${overview.messageCount}`
);
check(
  Number(storage.messageCount || 0) === Number(dashboardMetrics.messageCount || 0),
  "dashboard 快照总消息数与 ByteHouse 一致",
  `${storage.messageCount} vs ${dashboardMetrics.messageCount}`
);
check(
  Number(overview.uniqueSenderCount || 0) > 0,
  "overview 动态统计返回真实发言人数",
  `uniqueSenderCount=${overview.uniqueSenderCount}`
);
check(
  Number(overview.replyCount || 0) >= 0 && overview.replyCount !== undefined,
  "overview 动态统计返回真实回复引用数",
  `replyCount=${overview.replyCount}`
);
check(
  Number(storage.peopleCount || 0) === peopleCount,
  "ByteHouse 人员表数量与 people.json 一致",
  `${storage.peopleCount} vs ${peopleCount}`
);
check(!html.includes("今日负载"), "总览负载标题没有硬编码今日负载");
check(html.includes("/api/metrics?"), "前端日期/项目指标使用动态 metrics 接口");
check(overviewHtml.includes("消息类型") && overviewHtml.includes("回复引用"), "真实总览只保留原始消息事实面板");
check(
  !/(候选优先级|时段负载|巡检项|规则召回|待校准)/.test(overviewHtml),
  "真实总览不展示规则候选、排班估算或巡检推断"
);
check(
  html.includes("function calendarMetrics") && html.includes("calendarMetrics().byDate"),
  "左侧日历按当前项目读取 byDate"
);
check(
  html.includes("function messageIdentityBadges") && html.includes("messageIdentityBadges(message)"),
  "消息流优先展示飞书部门身份而不是粗角色标签"
);

const byDate = overview.byDate || [];
const dateCounts = new Map(byDate.map((row) => [row.date, Number(row.count || 0)]));
for (const date of pickDates(byDate)) {
  const { startMs, endMs } = dayRange(date);
  const expected = dateCounts.get(date) || 0;
  const metricsPayload = await getJson(`/api/metrics?${qs({ startMs, endMs, limit: 50000 })}`);
  const messagesPayload = await getJson(`/api/messages?${qs({ startMs, endMs, limit: 1 })}`);
  const metrics = metricsPayload.metrics || {};
  check(Number(metricsPayload.total || 0) === expected, `${date} metrics 总量等于日历计数`, `${metricsPayload.total} vs ${expected}`);
  check(Number(messagesPayload.total || 0) === expected, `${date} 消息流总量等于日历计数`, `${messagesPayload.total} vs ${expected}`);
  check(Number(metrics.messageCount || 0) === expected, `${date} 指标卡消息数等于日历计数`, `${metrics.messageCount} vs ${expected}`);
  check((metrics.staff || []).length > 0, `${date} 人员分布不是空数据`, `staff=${(metrics.staff || []).length}`);
  check((metrics.coreMetricSummary?.hourlyMessageCount || []).length > 0, `${date} 消息时段不是空数据`);
}

const projects = projectsPayload.projects || [];
const projectSamples = projects
  .filter((project) => project.projectId && Number(project.stats?.messageCount || 0) > 0)
  .sort((a, b) => Number(b.stats?.messageCount || 0) - Number(a.stats?.messageCount || 0))
  .slice(0, 3);
for (const project of projectSamples) {
  const expected = Number(project.stats?.messageCount || 0);
  const metricsPayload = await getJson(`/api/metrics?${qs({ projectId: project.projectId, limit: 50000 })}`);
  check(
    Number(metricsPayload.total || 0) === expected,
    `项目 ${project.projectName || project.projectId} 动态总量等于项目列表`,
    `${metricsPayload.total} vs ${expected}`
  );
  const sampleDate = (project.stats?.byDate || []).filter((row) => Number(row.count || 0) > 0).at(-1);
  if (sampleDate?.date) {
    const { startMs, endMs } = dayRange(sampleDate.date);
    const scopedPayload = await getJson(`/api/metrics?${qs({ projectId: project.projectId, startMs, endMs, limit: 50000 })}`);
    check(
      Number(scopedPayload.total || 0) === Number(sampleDate.count || 0),
      `项目 ${project.projectName || project.projectId} 的 ${sampleDate.date} 动态总量等于项目日历计数`,
      `${scopedPayload.total} vs ${sampleDate.count}`
    );
  }
}

let identitySampleChecked = false;
for (const [personId, person] of Object.entries(people || {}).filter(([, item]) => item?.team && item?.nameSource === "feishu_contact_api").slice(0, 30)) {
  const payload = await getJson(`/api/messages?${qs({ senderId: personId, limit: 1 })}`);
  const message = payload.messages?.[0];
  if (!message) continue;
  identitySampleChecked = true;
  check(
    message.senderTeam === person.team,
    `消息流身份与人员表一致：${person.name || personId}`,
    `${message.senderTeam || "-"} vs ${person.team || "-"}`
  );
  check(
    message.senderNameSource === person.nameSource,
    `消息流姓名来源与人员表一致：${person.name || personId}`,
    `${message.senderNameSource || "-"} vs ${person.nameSource || "-"}`
  );
  break;
}
check(identitySampleChecked, "至少抽到一条可验证的通讯录人员消息");

for (const item of passes) console.log(`PASS ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
for (const item of failures) console.error(`FAIL ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);

if (failures.length) {
  console.error(`\n${failures.length} 个数据一致性验收失败`);
  process.exit(1);
}

console.log(`\n全部 ${passes.length} 个数据一致性验收通过`);
