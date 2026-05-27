# 群分析

先做一件事：把飞书项目群的历史消息按天拉下来，形成后续统计分析的数据底座。

## 当前能力

- 按群或按项目拉取飞书群历史消息。
- 支持按日期全量、按上次同步位置增量。
- 保存原始飞书消息 `raw`，同时抽取：时间、群、项目、发送者、消息类型、文本。
- 保存回复关系：`parentId` / `rootId` / `replyToMessageId` / `threadRootMessageId`。
- 生成每日指标：消息数、发言人数、疑似问题数、回复数、按小时分布、消息类型分布、Top 发送者、谁回复了谁。
- 生成可视化面板数据：全部、近 30 天、近 14 天、近 7 天、近 3 天、今天。
- 维护两类严格分离的面板：
  - 真实面板：只展示飞书原始事实和可验证派生统计，包括多项目总览、完整消息、回复引用链路、人员活跃、消息类型和时间分布。
  - AI 分析面板：展示待 AI/人工判断候选、模型产出的分类分级、有效回复判断、FAQ 沉淀、排班建议。
- 真实面板不会把脚本规则生成的 P0/P1、SLA、解决状态、FAQ 命中率当成事实展示。
- 按“采集数据 -> AI/人工确认专家问题分类分级 -> 计算时间段工作量 -> 换算运营人数 -> 形成排班表”的链路生成运营指标。

飞书接口文档：[获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)

## 目录

```text
群分析/
  src/group-analysis.js
  groups.json
  people.example.json
  project-events.example.json
  .env
  public/index.html
  data/
    messages.jsonl
    daily/YYYY-MM-DD/<chat_id>.jsonl
    state/<chat_id>.json
    reports/YYYY-MM-DD/summary.json
    dashboard/dashboard.json
    dashboard/ai-iteration-input.json
    dashboard/ai-insights.json
```

每条消息里会保留飞书返回的完整 `raw`，不会只存摘要。常用字段会额外摊平出来：

- `createTime`：什么时候发的。
- `sender.id` / `sender.senderType`：谁发的，是用户还是应用。
- `text`：消息文本或富文本抽取结果。
- `mentions`：@ 了谁。
- `messageId`：当前消息 ID。
- `parentId` / `replyToMessageId`：回复的是哪条消息。
- `rootId` / `threadRootMessageId`：属于哪条回复线程。
- `questionCandidate`：疑问词规则召回的待判断候选，不等于专家问题结论。
- `expertQuestionStatus`：候选状态，默认需要 AI 或人工判断。
- `isOperatorReply`：是否为内部运营 / PM / 机器人回复。
- `replyObjectMessageId`：回复对象或引用对象。

报表里的 `replyEdges` 会直接给出：

- 谁回复的：`replier`
- 回复内容：`replyText`
- 回复了哪条消息：`parentMessageId`
- 被回复的人：`parentSender`
- 被回复内容：`parentText`
- 间隔多久回复：`latencySeconds`

## 面板模型

### 1. 真实消息

面板会把每条消息摊平成可筛选字段：

- 项目 ID / 项目名称
- 群 ID / 群名称
- 消息时间
- 发送人 ID / 名称 / 身份
- 消息类型
- 消息内容
- 是否回复
- 回复对象 / 引用关系

完整消息列表在面板的“完整消息”页签里，可以按项目、时间范围、关键词搜索，点项目后也会显示该项目下的完整消息复现。

### 2. 待 AI/人工判断候选

系统会先把疑似问题召回成 `analysisCandidates`，但这些不是专家问题结论，只是给 AI 或人工复核的输入。字段包括：

- `issueId`：问题单元 ID。
- `questionTime`：提问时间。
- `source`：固定为 `rule_candidate`。
- `requiresAiOrHumanReview`：固定为 `true`。
- `candidateReason`：为什么被规则召回。
- `replyConfidence`：是否存在飞书明确回复/引用关系。
- `ruleDraft`：脚本给 AI 的草稿分类、分级、标准耗时，只能作为输入，不能作为运营结论。
- `finalStatus`：固定为 `待AI/人工判断`，不会凭空生成“已解决”。
- `messages`：候选线程，系统消息不会进入候选线程。

注意：真实面板只展示飞书明确回复/引用关系，不判断这是不是“有效回复”。有效回复、解决状态、FAQ、优先级必须由 AI 或人工判断。

### 3. 分类与分级

当前内置一级分类：

- 入项 / 报名
- 权限 / 账号
- 任务领取
- 操作使用
- 规则理解
- 审核进度
- 驳回 / 质检
- 结算 / 费用
- 公告 / 信息确认
- 情绪 / 投诉 / 风险
- 其他 / 待判断

优先级规则：

这些规则只进入 `ruleDraft`，用于给 AI 或人工审核提供参考，不会出现在真实看板的运营结论里。

- `P0`：紧急风险，SLA 10 分钟，按 15 分钟工作量估算。
- `P1`：作业阻塞，SLA 20 分钟，按 6 分钟工作量估算。
- `P2`：常规推进，SLA 60 分钟，按 3 分钟工作量估算。
- `P3`：重复 FAQ，SLA 60 分钟，按 1 分钟工作量估算。

### 4. 项目节奏数据

项目动作会作为预测问题高峰的外部信号一起进入 dashboard 和 AI 输入。复制示例：

```bash
cp project-events.example.json project-events.json
```

支持的标准动作：

- 招募开始：入项、报名、测试问题增加。
- 培训 / 考试：规则理解问题增加。
- 任务放量：操作、任务入口、作业问题增加。
- 审核结果释放：审核进度、驳回、申诉问题增加。
- 规则变更：规则争议、重复确认问题增加。
- 结算节点：费用、到账、金额问题增加。

每条项目动作字段：

- `eventId`
- `projectId` / `projectName`
- `eventType` / `eventName`
- `eventTime`
- `impactWindowHours`
- `impact` / `expectedImpact`
- `relatedCategoryIds`
- `owner`
- `note`

AI 分析可以结合项目动作窗口判断问题高峰。未运行 AI 前，真实面板只展示项目动作本身，不展示动作导致的问题量或高优问题结论。

### 5. 工作量与排班

排班只在 AI/人工确认分类分级之后计算。未运行 AI 前，真实看板不会展示工作量和建议人数，避免脚本分级误导运营。

AI 分析确认后按 1 小时颗粒度统计：

```text
总工作量 =
P0问题数 × 15
+ P1问题数 × 6
+ P2问题数 × 3
+ P3问题数 × 1
```

换算人数：

```text
建议人数 = 总工作量分钟 ÷ 45 ÷ 0.8
```

AI 分析确认后可以同时给角色分配建议：

- 高优答疑：处理 P0/P1。
- 标准回复：处理 P2/P3、FAQ、重复问题。
- 复杂问题：处理规则争议、驳回、申诉。
- 升级接口：对接审核、技术、结算、权限接口。
- 巡群统筹：检查漏回、情绪升级、是否需要发公告。

### 6. 核心指标与耗时表校准

当前无法精确知道运营在每个问题上实际投入了多少有效分钟，因此先使用标准平均运营耗时表：

| 优先级 | 标准平均运营耗时 |
| --- | ---: |
| P0 | 15 分钟 |
| P1 | 6 分钟 |
| P2 | 3 分钟 |
| P3 | 1 分钟 |

后续用 AI/人工确认后的服务指标反向校准标准耗时表：

- 每单位小时专家问题量。
- P0/P1/P2/P3 问题量和占比。
- 各问题类型占比。
- 各类型 / 优先级平均处理耗时。
- 首响 SLA 达成率。
- 未回复 / 超时问题数。
- FAQ 命中率和重复提问率。
- 专家追问次数和一次解决率。

## 内部人员标注

如果要区分“内部人员回复”和“外部用户提问”，复制一份人员配置：

```bash
cp people.example.json people.json
```

然后把飞书 sender id 填进去：

```json
{
  "ou_xxx": {
    "name": "运营A",
    "team": "运营",
    "role": "internal",
    "isInternal": true
  },
  "cli_xxx": {
    "name": "项目AI机器人",
    "team": "AI",
    "role": "bot",
    "isInternal": true
  }
}
```

没有标注的人会显示为未标注发送者；`sender.senderType=app` 会先按机器人处理。

也可以用飞书通讯录接口按 `open_id` 补全身份：

```bash
npm run users:resolve
```

这个命令会读取历史消息里的 sender / mention open_id，调用飞书 `/contact/v3/users/{user_id}` 获取用户信息，并写入 `people.json`。接口能查到的 open_id 会按明确通讯录身份写回内部人员；如果飞书返回 `no user authority error`，说明应用没有该用户的通讯录读取权限或该用户不在可见通讯录中，面板不会做行为推断。没有接口结果时，可以在“人员活跃”页用“添加内部”或输入 open_id + 姓名显式添加。

## 配置

复制 `.env.example` 为 `.env`，填入飞书应用：

```bash
cp .env.example .env
```

飞书开放平台需要给应用开通并发布版本：

- 机器人能力
- `im:message.history:readonly` 或 `im:message:readonly`
- 读取群历史消息对应权限，比如“获取群组中所有消息”

## 同步

如果刚把机器人加入了新群，先发现机器人所在群并写入 `groups.json`：

```bash
npm run groups:discover -- --write
```

这个命令使用飞书“获取用户或机器人所在的群列表”接口，需要 `im:chat:readonly` 或 `im:chat.group_info:readonly` 这类群信息读取权限。没有这个权限时，只能手动把群 `chat_id` 写入 `groups.json`。

测试拉某个群最近 24 小时，不写入：

```bash
npm run sync -- --chat-id oc_db8c33cfee97a20bf79c6cd3a4abc3d3 --lookback-hours 24 --max-pages 1 --dry-run
```

正式拉某一天：

```bash
npm run sync -- --date 2026-05-07 --write-report
```

首次接入新群时，默认增量只拉最近 24 小时。要回补历史消息，用：

```bash
npm run backfill -- --chat-id oc_xxx --days 30 --write-report
```

也可以指定时间：

```bash
npm run backfill -- --chat-id oc_xxx --since "2026-04-01 00:00" --until "2026-05-07 23:59" --write-report
```

没有 `npm` 时直接跑：

```bash
node src/group-analysis.js sync --date 2026-05-07 --write-report
```

## 报表

```bash
npm run report -- --date 2026-05-07 --write
```

## 面板

生成面板数据：

```bash
npm run dashboard
```

启动本地面板：

```bash
npm run serve
```

默认地址：

```text
http://127.0.0.1:4198
```

真实面板读：

- `data/dashboard/dashboard.json`

AI 分析面板读：

- `data/dashboard/ai-iteration-input.json`：给 AI 的结构化输入。
- `data/dashboard/ai-insights.json`：AI 模型输出。未运行模型时保持空结果，不用规则草稿冒充 AI 分析。

## 验收

一键重新生成面板并检查需求字段：

```bash
npm run verify
```

这个检查会覆盖：

- 群消息底层字段。
- 真实看板不直接确认专家问题。
- 真实看板不展示脚本 P0/P1/P2/P3、SLA、FAQ、解决状态和排班工作量。
- 待 AI/人工判断候选字段。
- 系统消息不会进入候选对话线程。
- 项目节奏字段。
- AI 输入和模型结果边界。
- 页面入口和内嵌 JS 可解析性。

## 定时

每天早上 8 点增量同步，并重新生成面板数据：

```bash
npm run cron:install
```

移除定时任务：

```bash
npm run cron:remove
```

定时任务实际执行的是：

```bash
npm run sync -- --write-report
npm run dashboard -- --write
npm run ai:analyze
```

`ai:analyze` 默认不会把群消息发给模型。只有配置 `AI_ENABLED=1` 和 `AI_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` 后才会真实调用模型。
