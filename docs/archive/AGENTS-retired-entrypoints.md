# AGENTS.md · 已退场入口（历史，不可恢复）

> 本文件于 2026-11-14 从根目录 `AGENTS.md` 拆出（原文过长导致 Agent 上下文被截断）。
> **现行事实以 `AGENTS.md` 顶部「项目概述」与 `README.md` / `docs/README.md` 的「现行事实」为准**；
> 本文件只保留历史沿革（当时的实现细节、行号已失效，不再作为排查依据）。

## 已退场入口（历史，不可恢复）

**⛔ 群聊 / 群话题（2026-10-12 起不再受理；不可恢复、无开关）**：过去机器人接收群聊消息，准入判据有两条，且必须先判 `thread_id`。**现在该分支是「收到即静默拒绝」的守卫**：只记一条 `lark.group.message.disabled`并返回 `reason: 'group_chat_removed'`（不建任务、不进 AI、不读表、不写表、不回话——群里日常聊天绝不刷屏）。以下为历史记录（当时的具体行号已失效，不再引用）：

- **消息在话题里（`thread_id` 有值）→ 一律处理，不要求 @ 机器人**（当时实现；真机实测：她在话题里发「你好 小来财」时 `mentions` 为空，事件照样推给我们——话题本身就是"冲着机器人来的"的判据）。
- **主群消息（`thread_id` 为空）→ 才要求 `message.mentions` 里有机器人自己的 open_id**（`LARK_BOT_OPEN_ID`，当时实现）。没配 `LARK_BOT_OPEN_ID` 时**一条主群消息都不处理**。

⚠️ 顺序不能反：先读 `mentions` 会把话题里没 @ 的消息当成"主群没 @"丢掉——这正是真机测出来的 bug。不处理 → **完全静默、零远端调用**（群里日常聊天绝不能被触发）；处理 → 加 `OneSecond` 表情确认（群里**不回**文字，避免刷屏），再走采购定位链路（`PurchaseBatchLocator.resolve`，当时实现），**按顺序**：

1. **`thread_id`** → `findByThreadId`（当时实现；最稳——她在话题里后续发的消息不一定还引用着机器人那条）
2. **`message.parent_id`**（引用采购单那条消息）→ `findByMessageId` 反查本地映射（当时实现）
3. **正文里的批次号 `BH-YYYYMMDD-NNNN`** → `findByBatchNo`（当时实现；**只有既没话题也没引用时**才走这条）
4. **都没有 → 回一句问清楚**（当时实现），**绝不猜"最近一笔"**

⚠️ 两个"认不出"：话题里但这条话题没记过映射、又没引用 → 直接说认不出，**不拿正文号去猜**（当时实现）；引用到的不是我们发的消息（或映射丢了）→ 同样认不出（当时实现）。采购单与群里那条消息的 `message_id ↔ 批次`（以及 `thread_id`）映射写在本地任务记录 `server/data/purchase_group_messages/`，**不写业务表**。

**🔴 私聊链路已移除（2026-10-07 起）**：业务负责人口径（逐字）「**以后私聊这条链路我们就没有了**」；
她拍板的方式是 **ⓐ：代码里一行私聊都不留，测试全部迁到群聊入口**
（见 `docs/private-chat-removal-decision-2026-10-07.md`）。
入口统一到【群聊 + 话题】—— 私聊（以及一切非群聊）消息**只记一条
`lark.private_chat.disabled` 日志**：不建任务、不进 AI、不读表、不写表。
⭐ **唯一保留的动作是回一句固定文案**（`PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` 默认 `true` /
`PRIVATE_CHAT_DISABLED_NOTICE_TEXT`，见 `config/privateChatNotice.js`）；**空串 = 关掉那句话**；
🔴 **仍然没有**恢复私聊入口 / 发送的开关 —— `PRIVATE_CHAT_INTAKE_ENABLED` 之类的变量**刻意不存在**；
要恢复私聊是**重新实现那条链路**，不是翻一个开关（留开关的方案 ⓑ 已被否掉）。
⚠️ 顺带删掉的私聊专属件：`larkMvpService.sendTodaySales` / `handleBotMenu` / `shanghaiDay`、
路由的 `application.bot.menu_v6` 分支、`utils/larkCards.todaySalesCard`、
`purchaseWebhookService.sendCard`、
`larkMvpService.sendCard`（open_id 口径的卡片发送器，2026-10-07 收尾时成孤儿）、
`SampleReplacementService` 的 `sendCard` / `sendText` 两个 open_id 发送器。
⚠️ **没有群上下文的任务 = 没有去处**：`sendTaskCard` / `sendTaskText` 只记
`lark.private_chat.send_skipped` 并返 `null`。
⭐ 2026-10-07 收尾把剩下 5 处**缺省回落发私聊**也清了
（`saleLookupService` ×2 / `afterSalesFlowService` ×2 / `salesThreadProgressService` ×1）：
现在缺省出口一律"记 skip + 返 `null`"，日志只有一处定义
（`utils/privateChatSend.js` 的 `skipNoGroupContext`）。
⭐ 同日**二次收尾**又补了最后 2 处**同形状**的（都只在非群分支）：
`larkMvpService.replyTaskCard`（不再 `replyCard(task.message_id, …)`）与
`afterSalesFlowService.replyCardToTask` 的缺省（非群 → skip + `null`，**群那一条逐字不变**）。
⭐ 同日**三次收尾**把最后 2 处**主回复路径**也堵了 ——
`larkMvpService` 的销售确认卡片非群分支（不再 `replyCard(task.message_id, …)`）与
`saleLookupService.replyCardByTask` 的主回复（非群在函数入口 skip + 返 `null`）；
两处都**只在非群分支**，**群那一条逐字不变**；没发出去时**也不记**「已发出」日志
（`lark.sales.card.sent` / `sale_lookup.card.sent`）。
⚠️ `replyCard` **不是孤儿**（`LarkMvpService` 里仍有 **3** 个调用方：
`:138` 销售查单群路径 / `:158` 售后接线 / `:442` 采购卡片无话题回落）→ 保留。
⭐ 详见 `docs/archive/private-chat-removal-2026-10-07.md` 第七节（验收标准 + 逐条对照）。
**有意的行为变化**：
`SampleReplacementService.notifySampleReplacements` 在**工作台触发**（
`routes/workbench.js`，没有群上下文）时**不再静默发私聊**；
群销售那条则回到**那条销售话题**（`reply_in_thread`）。
⭐ 验收标准、实现与测试证据见 `docs/archive/private-chat-removal-2026-10-07.md`。

> **采购链路的历史**：曾存在一条"机器人收采购图片 → 写「采购批次」表 → `PurchasePostingService`"
> 的旧链路（`acceptPurchaseImage` / `finishPurchaseImages` / `processPurchaseTask` /
> `purchaseDraftBuilder` / `purchasePostingService` / schema 里的 `purchaseBatch`）。
> 它在 2026-10-04 已**整体删除**——这些方法此前已无任何调用方。
>
> 2026-10-05 又退场了一条：**「采购到货 → 拍照识别 → 确认入库」**（`processArrival` /
> `resolveArrivalProduct` / 到货等待与超时策略 `arrivalWaitPolicy` / 到货详情卡片
> `purchaseArrivalDetailCard` / 卡片动作 `confirm_purchase_arrival` / 视觉模型配置
> `VISION_LLM_*` / 鞋盒与到货单两个识别方法）。理由：她删掉了那张表上的三个识别字段，
> 并明确「不再用拍照识别，改成纯对话驱动」。
> ⚠️ **保留**的是**加库存与建档**这两项能力（到货链路里 `confirmArrival` 逐条调
> `inventory.applyPurchase`；`ensureArrivalProducts` 建档 + 成本）——**2026-10-06 起有调用方了**
> （群话题对话式核对，她点「是」之后进来）。
> ⚠️⚠️ **2026-10-07 深夜更新**：「**采购入库**」表（`tblK3Uzd0nN1GJrr`）已被业务负责人
> **整表删除**，她的口径（逐字）：「甲 **不再写任何入库明细**：只更新「报货批次」
> （到货状态=已到货 + 验收原话 + 确认状态）+ **加库存**（库存流水 / 实时库存照写）
> —— 也就是"**入库明细表整个不要了**"」。
> ⇒ 到货链路**不再写任何入库明细行**：`config/purchaseBehaviors.js`（采购环节 `PURCHASE_IN`）
> 随它的唯一消费者一起退场；`v1BitableSchema` 的 `purchaseInbound` 整段、
> `inventoryLedger.purchaseInbound`（「关联采购」，随对端表一起被飞书删掉）、
> `v1SchemaScopes` 里的两处引用全部删除；幂等来源从"入库行 id"换成**真实三元组**
> （批次记录 id ｜ 货品 ｜ 尺码，只进本地）⇒ 加库存的流水**不带来源关联**（与采购退货同一通路）。
> ⭐ 验收标准 + 逐条对照 + 证据见 `docs/purchase-inbound-table-removal-2026-10-07.md`。
> ⭐ **「把建档剥成 `services/productCreationService.js`」这件事
> 还没进 main**——原分支 `refactor/decouple-creation-and-stock`（PR #80 CLOSED）已于 2026-10-06
> 清理时删除，但**剥出来的 service 原文与全量 patch 已留档在**
> `docs/branch-salvage-2026-10-06/`（索引见 `docs/branch-salvage-2026-10-06.md` 第 4 节）。
> 真要做这件事时以那份留档为起点，别重新发明。

