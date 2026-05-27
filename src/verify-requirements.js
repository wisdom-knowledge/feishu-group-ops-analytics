#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dashboardPath = path.resolve(root, "data/dashboard/dashboard.json");
const aiInputPath = path.resolve(root, "data/dashboard/ai-iteration-input.json");
const aiInsightsPath = path.resolve(root, "data/dashboard/ai-insights.json");
const htmlPath = path.resolve(root, "public/index.html");
const sourcePath = path.resolve(root, "src/group-analysis.js");
const packagePath = path.resolve(root, "package.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function get(obj, pathText) {
  return pathText.split(".").reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

function hasFields(obj, fields) {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(obj || {}, field));
}

const failures = [];
const passes = [];

function check(condition, label, detail = "") {
  if (condition) passes.push({ label, detail });
  else failures.push({ label, detail });
}

check(fs.existsSync(dashboardPath), "dashboard.json 已生成");
check(fs.existsSync(aiInputPath), "ai-iteration-input.json 已生成");
check(fs.existsSync(aiInsightsPath), "ai-insights.json 已生成");
check(fs.existsSync(htmlPath), "public/index.html 存在");

const dashboard = fs.existsSync(dashboardPath) ? readJson(dashboardPath) : {};
const aiInput = fs.existsSync(aiInputPath) ? readJson(aiInputPath) : {};
const aiInsights = fs.existsSync(aiInsightsPath) ? readJson(aiInsightsPath) : {};
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
const pkg = fs.existsSync(packagePath) ? readJson(packagePath) : {};
const metrics = get(dashboard, "periods.all.metrics") || {};
const firstMessage = metrics.messages?.[0] || {};
const firstCandidate = metrics.analysisCandidates?.[0] || {};
const candidateMessages = (metrics.analysisCandidates || []).flatMap((item) => item.messages || []);

check(
  Boolean(dashboard.periods?.all) && html.includes("calendarCells") && html.includes("date:"),
  "真实面板时间区间完整",
  `dashboard 预聚合 ${Object.keys(dashboard.periods || {}).join(",") || "无"}；日历按日过滤在前端执行`
);
check(Array.isArray(dashboard.projects) && dashboard.projects.every((project) => project.periods?.all && Array.isArray(project.chats)), "多项目 / 多群容器完整");
check(Array.isArray(metrics.messages) && metrics.messages.length > 0, "完整消息列表可复现");
check(
  hasFields(firstMessage, [
    "projectId",
    "projectName",
    "chatId",
    "groupName",
    "createTime",
    "senderName",
    "senderNameSource",
    "senderRoleLabel",
    "text",
    "questionCandidate",
    "expertQuestionStatus",
    "isOperatorReply",
    "replyObjectMessageId"
  ]),
  "群消息基础字段完整"
);

check(metrics.messageCount >= 1000, "历史消息已回补到千级以上", `当前 ${metrics.messageCount || 0}`);
check(metrics.expertQuestionCount === 0 && metrics.questionCount === 0, "真实看板不直接确认专家问题");
check(Array.isArray(metrics.priorityCounts) && metrics.priorityCounts.length === 0, "真实看板不展示脚本 P0/P1/P2/P3");
check(Array.isArray(metrics.hourlyStaffing) && metrics.hourlyStaffing.length === 0 && metrics.totalWorkloadMinutes === null, "真实看板不展示脚本排班工作量");
check(metrics.slaHitRate === null && metrics.faqHitRate === null && metrics.duplicateRate === null, "真实看板不展示未确认 SLA/FAQ/重复率");

check(Array.isArray(metrics.analysisCandidates) && metrics.analysisCandidates.length > 0, "待 AI/人工判断候选已生成");
check(
  hasFields(firstCandidate, [
    "issueId",
    "questionMessageIds",
    "questionTime",
    "source",
    "requiresAiOrHumanReview",
    "judgementStatus",
    "candidateReason",
    "ruleDraft",
    "messages"
  ]),
  "候选字段有来源和待判断状态"
);
check(firstCandidate.finalStatus === "待AI/人工判断" && firstCandidate.statusSource === "not_inferred", "候选不凭空生成解决状态");
check(candidateMessages.every((message) => message.msgType !== "system"), "系统消息不会进入候选对话线程");

check(metrics.coreMetricSummary?.hourlyMessageCount && metrics.coreMetricSummary?.messageTypeDistribution, "真实统计图表字段完整");
check(Array.isArray(metrics.replyEdges), "真实回复引用链路完整");
check(metrics.dataAuthenticity?.separationRule && metrics.dataAuthenticity?.aiFields, "数据真实性边界完整");

check(aiInput.sourceBoundary?.realDashboard && aiInput.aiMustJudgeFields?.includes("finalStatus"), "AI 输入明确真实/规则/AI 边界");
check(aiInput.ruleDraftForReview?.source === "local_rule_draft_for_ai_input_only", "规则草稿只作为 AI 输入");
check(aiInput.expectedOutputSchema?.issueUpdates && aiInput.expectedOutputSchema?.staffingPlan, "AI 输出 schema 覆盖问题判定和排班");
check(["not_run", "model"].includes(aiInsights.source), "AI 结果来源明确");
if (aiInsights.source !== "model") {
  check((aiInsights.commonQuestions || []).length === 0 && (aiInsights.staffingPlan || []).length === 0, "未运行 AI 时不生成伪分析结果");
}

check(
  ["真实总览", "消息流", "人员活跃", "复核分析", "问数助手"].every((label) => html.includes(label)),
  "UI 信息架构按真实、消息、人员、复核、问数分区"
);
const overviewHtml = html.includes('<section id="overview"')
  ? html.slice(html.indexOf('<section id="overview"'), html.indexOf('<section id="messages"'))
  : "";
check(overviewHtml.includes("消息类型") && overviewHtml.includes("回复引用") && html.includes("hourChart") && html.includes("rolePanel"), "UI 真实统计图表入口完整");
check(!html.includes("priorityDonut") && !html.includes("data-priority"), "UI 真实区移除优先级过滤和优先级图");
check(
  !/(候选优先级|时段负载|巡检项|规则召回|待校准)/.test(overviewHtml),
  "真实总览不展示规则候选、排班估算或巡检推断"
);
check(
  source.includes("includeContent") &&
    source.includes("content_json") &&
    source.includes("message-resource") &&
    html.includes("renderImageResource"),
  "图片消息资源链路完整"
);
check(html.includes("backdrop-filter") && html.includes("focus-visible") && html.includes("prefers-reduced-motion"), "UI 设计与可访问性基础通过");
check(pkg.scripts?.["ai:analyze"] && source.includes("async function aiAnalyze"), "AI 分析命令已接入");
check(source.includes("run ai:analyze"), "每天 08:00 定时任务包含 AI 分析步骤");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
try {
  for (const script of scripts) {
    new Function(script);
  }
  check(scripts.length > 0, "HTML 内嵌 JS 可解析");
} catch (error) {
  check(false, "HTML 内嵌 JS 可解析", error.message);
}

for (const item of passes) {
  console.log(`PASS ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
}
for (const item of failures) {
  console.error(`FAIL ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
}

if (failures.length) {
  console.error(`\n${failures.length} 个验收项失败`);
  process.exit(1);
}

console.log(`\n全部 ${passes.length} 个验收项通过`);
