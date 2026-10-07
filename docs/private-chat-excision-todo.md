# 🔴 把「私聊」从链路里切出去（业务负责人 2026-10-06 明确）

> 她的原话：「**后续就不走私聊了，所以你私聊的要切除出来，后续要删除！**」
> 还有一条：「**卡片点按钮后那条多余的私聊文字，需要删。**」

## 一、待办（按顺序做）

### ① 🔴 删掉卡片点按钮后那条【多余的私聊文字】
- **位置**：`server/src/routes/larkEvents.js:74` 附近
  （`const message = result?.toast?.content;` → 之后发私聊那条）
- **她的口径**：「**我们的消息卡片会变化啊！**」→ **卡片更新本身就是反馈**，
  不需要再额外弹一句到私聊。
- ⚠️ **注意**：飞书要求"点按钮后必须回一个响应"，而**卡片更新就是响应**；
  去掉的是**那条额外的私聊消息**，不是整个响应。
- ⭐ **做完要有测试**：点按钮 → **卡片被更新** + **没有 `im.message.create` 到私聊**。

### ② ⭐ 把私聊专属的东西【切出来】（为将来删除做准备）
**判断标准**：**「私聊明天被删掉，这段代码还能跑吗？」**

| 类别 | 私聊专属的形态 | 目标形态 |
| --- | --- | --- |
| 发送 | `sendCard(open_id,…)` / `sendText(open_id,…)`（主动私聊） | **渠道感知端口**：任务带 `chat_type/chat_id/thread_id`；群话题走 `reply_in_thread`，无群上下文才回落私聊 |
| 任务字段 | 只有 `sender_open_id` | 加渠道上下文 |
| 准入 | 私聊 = 无条件 | 群：话题免 @、主群按判据；**私聊只是入口之一** |
| 卡片动作响应 | 点按钮 → 私聊发 toast 文字 | **不需要那条文字**（见 ①） |
| 兜底路径 | 出错时 `sendText(sender_open_id, …)` | 出错也走**渠道感知**的出口 |

## 二、✅ 已经切好的（2026-10-06 完成，别重做）
- **销售录入**的回复：群话题 `reply_in_thread`，私聊逐字不变
- **售后（退货/换货）**的回复：按 `task.chat_type === 'group'` 分流回话题
  （`replyCardToTask` / `sendCardToTask` / `sendTextToTask`）
- **二次交付（进展）**的回复：走 `sendTextToTask` → 渠道感知 → **会回到那个话题**
- **采购到货**的回复：`threadId` 当上下文传给发送端口
- **主群准入**：不 @ 也能识别（`config/groupAdmission.js`）

## 三、⚠️ 盘清时要重点查的（还没逐个核）
- 所有 `sendText(...)` / `sendCard(...)` 的**主动私聊**调用点
- 出错/兜底分支里的私聊发送
- 卡片动作的 `updateInteractiveCard` 兜底
- 任务记录里的 `sender_open_id` 用途（哪些只是"发给谁"、哪些是业务主键）

## 四、🎯 最终目标（她定的）
> 「**后续就不用私聊了，后续就是在群聊里面沟通销售、采购的事情。**」

⇒ **私聊应当只是【其中一个入口】——删掉它，其余链路不受影响。**

---

## 五、⭐ 盘清结论（2026-10-06 实盘，把第三节四条逐个查完）

> 判据统一是那一句：**「私聊明天被删掉，这段代码还能跑吗？」**
> 行号是本次核查时（分支 `feat/private-chat-excision-card`）的**当前位置**，会漂。

### 5.1 全仓「主动发私聊」的调用点 —— 逐条

全仓发消息最终只落到 **3 个 `im.message.create`**（`receive_id_type` 决定发给谁）：

| # | 位置 | 形态 | 谁的链路 | 判断 | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1 | `routes/larkEvents.js` 卡片动作分支 | `sendText(operator_open_id, toast)` —— 点按钮后**额外**一条私聊文字 | 所有卡片动作 | 🔴 **私聊专属且多余**（她要删的那条） | ✅ **本次已删**（①） |
| 2 | `sampleReplacementService.publishCard` 兜底 | `sendCard(task.sender_open_id, card)` | 补样品卡片 | 🔴 硬编码"发给谁" | ✅ **已切成任务感知端口**（②）＋ **生产已接线**（③ 在 `larkMvpService` 注入 `sendCardToTask`） |
| 3 | `sampleReplacementService.handleCardActionUnlocked` (`:170`) | `sendText(operator_open_id, "正在处理…")` | 补样品卡片 | 🔴 同上（鉴权已保证与 `task.sender_open_id` 相同） | ✅ **已切成任务感知端口**（②）＋ **生产已接线**（③ 注入 `sendTextToTask`） |
| 4 | `sampleReplacementService.notifySampleReplacements` (`:110`/`:115`) | `sendCard(operator_open_id, …)` / 失败再 `sendText(operator_open_id, …)` | 补样品**提醒**（触发源：网页工作台 `routes/workbench.js:73`，或销售确认卡片） | ⚠️ **私聊通道能力**：触发方**没有群上下文**，本来就只能回落私聊 | ⏳ 留着；等任务带上渠道上下文再接（**故意不硬改**：这个 `operatorOpenId` 是"本次操作的人"，与 `task.sender_open_id` 在极端情况下可能不是同一个人，改了会变行为） |
| 5 | `purchaseWebhookService.sendReturnNotice`（差额提示） | ~~`sendNoticeText(prepared.operatorOpenId, notice)`~~ → **`sendPurchaseGroupNotice(notice, { replyToMessageId })`** | 采购退货（**群链路**） | 🔴 **真正的耦合**：退货单发群，结果却发私聊 | ✅ **本次已切**：发**采购群**、并**回复退货单图（话题根）** → 落在**同一个话题**；未配群**大声跳过、不回落私聊**。`sendNoticeText`（唯一调用点就是它）已**整体删除** |
| 6 | `saleLookupService.replyCardByTask` 兜底 (`:346`) | 群任务 → **渠道感知出口** `sendCardToTask`（回那个话题）；私聊任务 → 仍是 `sendCard(task.sender_open_id, card)` | 销售查询 / 售后候选卡片 | 🔴 **真正的耦合**：群话题里回复失败会掉进私聊 | ✅ **本次已切**：`chat_type === 'group'` 走渠道出口；出口再失败**只记日志、返回空串**（`sale_lookup.card.topic_fallback_failed`），**绝不回落私聊**。私聊分支**逐字不变** |
| 7 | `afterSalesFlowService` 端口缺省值 (`:113`–`:115`) | `sendCard/sendText(task.sender_open_id, …)` | 售后 | ✅ 生产**已注入**渠道感知端口，缺省值只是给单测的兜底 | 已切 |
| 8 | `salesThreadProgressService` 端口缺省值 (`:65`) | `options.sendText?.(task?.sender_open_id, …)` | 进展同步 | ✅ 同上（生产已注入 `sendTextToTask`） | 已切 |

**私聊【入口】专属（不是耦合，跟私聊一起删就行，别单独改）**：

| 位置 | 是什么 |
| --- | --- |
| `larkMvpService.acceptMessage` 的 `chat_type === 'p2p'` 整段（含 `:689`/`:695` 两条非文字/空文字提示） | 私聊消息入口本身 |
| `larkMvpService.sendTodaySales` (`:362`，`sendCard` 在 `:371`) → `sendCard(openId)` | 机器人菜单「今日销售」，**只有私聊里点得到** |
| `routes/larkEvents.js` 的 `application.bot.menu_v6` 分支（`:89`，含 `:98` 失败兜底 `sendText(openId,…)`） | 机器人菜单事件，**只有私聊里会推过来** |

**已经是群、不是私聊的（别误改）**：

| 位置 | 说明 |
| --- | --- |
| `secondDeliveryService.sendCardToChat` (`:319`) | `receive_id_type: 'chat_id'`，成交提醒发群；**没配群就不发，绝不回落私聊**（这条口径已经对了） |
| `purchaseWebhookService.sendText(chatId, content, 'chat_id')` (`:1372`) | 参数化的收件人类型；采购申请说明/群通知走它 |
| `purchaseWebhookService.sendPurchaseGroupNotice` (`:1234`) | 采购群通知；未配置群 id → **大声跳过、不回落私聊** |

**死代码（无任何调用方，删私聊时可以顺手清）**：

| 位置 | 说明 |
| --- | --- |
| `purchaseWebhookService.sendCard(openId, card)` (`:1156`) | 全仓**没有调用点**（注释里写着"要回滚成确认卡片就换回它"）。采购申请那条路现在走群，不再私聊。 |

### 5.2 出错 / 兜底分支里的私聊发送 —— 结论

- **卡片动作的失败分支**：原先会 `sendText(operator_open_id, "操作失败：…")`。
  ⇒ **本次已删**（与 ① 同一处）：失败只记 `lark.mvp.card.failed` 日志；
  **同步响应照旧**（handler 早就 return 了），所以她点按钮**不会**觉得"点不动"。
- **采购退货差额提示**（5.1 #5）：**是**兜底式的事后通知。⇒ ✅ **本次已切**：
  改走 `sendPurchaseGroupNotice`（发采购群 + 回复退货单图的话题根）；未配群**大声跳过、不回落私聊**。
- **补样品提醒发送失败**（5.1 #4）：失败再发一条私聊文字，**两层都是私聊**。**仍未切**（触发方没有群上下文）。
- **销售查询卡片回复失败**（5.1 #6）：⇒ ✅ **本次已切**：群任务走渠道出口回话题；
  出口再失败**只记日志、返回空串**，不静默掉进私聊。私聊任务仍走原来的 `sendCard(sender_open_id)`。
- ✅ 已经是对形态的两个范例：`sendPurchaseGroupNotice` / `sendCardToChat` ——
  **未配置群 = 大声跳过，不回落私聊**。本次两条都是照它们抄的。

### 5.3 卡片动作 `updateInteractiveCard` 的兜底 —— 结论

`updateInteractiveCard`（`infrastructure/interactiveCardFeedback.js`）**自己不发消息**：
改不动就 `logWarn` + 返回 `false`。**兜底在调用方**，一共两处，都查了：

| 位置 | 兜底形态 | 处置 |
| --- | --- | --- |
| `larkMvpService.publishSalesResultCard` (`:495`) | `sendTaskCard(task, card)` —— **任务感知**（群→话题、私聊→私聊） | ✅ 已经是目标形态 |
| `sampleReplacementService.publishCard` (`:65`) | `sendCard(task.sender_open_id, card)` —— 硬编码私聊 | ✅ **本次已切成 `sendCardToTask`**（②），默认回落逐字相同 |

### 5.4 任务记录里 `sender_open_id` 的用途 —— 分两类（**这条最容易切错**）

🔴 **它是"业务主键/身份"的地方 —— 删私聊后【必须留下】**
（群里也有 `sender_open_id`，它不是私聊专有概念）：

| 用途 | 位置 |
| --- | --- |
| **卡片动作鉴权**（"只能由本人确认"）—— 少了它任何人点一下就能确认别人的单 | `larkMvpService:1498`、`afterSalesFlowService:422`、`sampleReplacementService:153` |
| **跨消息上下文 key**（"第 2 笔，退货"要按人找回她刚查到的候选） | `afterSalesFlowService:211`（`afterSalesContextId(t.sender_open_id)`）、`larkMvpService:1201`（`rememberCandidates`） |
| **同一人串行队列 key**（同一个人的消息按顺序处理，不并发写账） | `larkMvpService:296` `enqueueForSender(senderOpenId)` |
| **写进业务表的值**（「销售人」） | `larkMvpService:1117` `person(task.sender_open_id)` |
| **任务归属人**（群话题/到货会话记"谁开的这个话题"，供回话与审计） | `salesGroupThreadLocator:67`、`purchaseArrivalConversationService:169`/`176`、`groupPurchaseFlowService:71` |

⚠️ **只作"发给谁"（渠道相关）的地方** —— 这些才是将来要换成"渠道上下文"的：
`larkMvpService.sendText/sendCard` 的 `openId` 参数、`sampleReplacementService` 的发送点、
`saleLookupService` 的兜底、`purchaseWebhookService.sendReturnNotice`（**已切**，见 5.5）。
**两类别混着用同一个字段名，切的时候必须逐个看语义，不能按字段名一刀切。**

### 5.5 切了哪几类 ✗ 还有哪几类没切

**✅ 第 1 批（2026-10-06 上半天，PR #157）**
1. **卡片动作响应类**（`routes/larkEvents.js`）：删掉点按钮后那条多余私聊文字 +
   失败分支的私聊兜底；**卡片更新与同步响应原样保留**。回归证据：
   `test/larkEvents.test.js` 用**真实 `LarkMvpService` ＋ 计数假 client** 断言
   **卡片更新 `im.message.patch` 恰好 1 次、主动发送 `im.message.create` 恰好 0 次**，
   并另有一条"私聊非文字消息仍然回同样那一条文字"的**逐字不变**回归。
2. **发送端口类**（`SampleReplacementService`）：把**硬编码私聊收件人**换成
   **任务感知端口** `sendCardToTask` / `sendTextToTask`（缺省 = 改动前的私聊行为，逐字相同；
   飞书语义仍只留在 `larkMvpService` 适配器里）。证据：`test/sampleReplacementRecovery.test.js`
   两条新用例——注入端口时走端口、不注入时回落 `task.sender_open_id`。

**✅ 第 2 批（2026-10-06 晚，本次：把上面 5.5 遗留的三处做完）**
3. **① 采购退货差额提示改发话题/群**（`purchaseWebhookService`）：
   `sendReturnNotice(prepared, { replyToMessageId })` → `sendPurchaseGroupNotice`；
   `deliverReturnImages` / `deliverSupplierImagesInner` 把 `thread_root_message_id`
   （这一批群里第 1 条图 = 话题根）交回调用方，提示**回复它** → 与退货单同一个话题。
   `sendNoticeText`（唯一调用方就是它）**整体删除**。
   证据：`test/purchaseReturn.test.js` 两条新用例（差额提示是 `reply` 到那张图的根消息、
   全链路无 `receive_id_type: 'open_id'`；未配群时**一条消息都不发** + `purchase.group_notice.skipped`）。
4. **② `saleLookupService.replyCardByTask` 兜底按渠道分流**：
   群任务走渠道端口 `sendCardToTask`（回那个话题），出口再失败只记
   `sale_lookup.card.topic_fallback_failed` 并返回空串；私聊分支逐字不变。
   证据：`test/saleLookupService.test.js` 两条新用例 + 原有那条私聊回落用例加强断言。
5. **③ `larkMvpService` 端口接线**：给 `SampleReplacementService` 注入
   `sendCardToTask` / `sendTextToTask`，给 `SaleLookupService` 注入 `sendCardToTask`
   （接法与 `afterSalesFlowService` 完全一致，PR #148）。
   证据：`test/groupThreadReplyRouting.test.js` 两条新用例（端口不是缺省回落；群任务
   `reply_in_thread: true`、私聊仍是 `im.message.create` 给本人）。

**🔴 2026-10-07 收口：私聊【入口】也删了 —— 本节的"还没切"全部落地**
（验收标准、实现与测试证据见 [private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md)）

> 业务负责人口径（逐字）：「**以后私聊这条链路我们就没有了**」。

| 本节原来的"还没切" | 处置 |
| --- | --- |
| `sampleReplacementService.notifySampleReplacements`（5.1 #4，补样品**提醒**，触发方没有群上下文） | ✅ **加了渠道感知入参**：群销售 → 卡片回到**那条销售话题**；没有群上下文（工作台触发）→ **不发任何消息**，改记 `lark.private_chat.removed`（`reason: no_group_context`）。⚠️ **有意的行为变化**：不再静默发私聊 |
| `larkMvpService.sendTodaySales`（菜单「今日销售」） | ✅ **已删**（连 `todaySalesCard` 一起）。要看今日销售去工作台「销售查询」 |
| `acceptMessage` 的 `p2p` 分支两条非文字/空文字提示 | ✅ **随私聊入口一起删**：私聊消息统一回**一句**固定文案（`PRIVATE_CHAT_DISABLED_NOTICE_TEXT`），两条旧提示不会再出现 |
| `routes/larkEvents.js` 的 `application.bot.menu_v6` 分支 | ✅ **已删**（含失败兜底的 `sendText(openId, …)`） |
| **死代码**：`purchaseWebhookService.sendCard(openId, card)`（全仓无调用点） | ✅ **已删**（`PurchaseWebhookService.prototype.sendCard === undefined`） |

**私聊入口现在的形态（⭐ 2026-10-07 二次收口 = ⓐ 彻底版）**：
`config/privateChat.js` **只剩"那一句话"的两个旋钮**（`PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` / `..._TEXT`），
取值规则复用 `config/envValue`（**空串 = 关掉、认不出的值抛错**），且是**每次调用时读 env**。
🔴 `PRIVATE_CHAT_INTAKE_ENABLED` / `PRIVATE_CHAT_SEND_ENABLED` 与测试 helper
`server/test/helpers/enablePrivateChatForTests.js` **已整体删除** ——
**代码里再也没有"打开私聊"的口子**；历史用例（拿私聊当入口测下游的那一批）已
**迁到群聊真入口**（主群 @ 机器人 / 话题），断言改成"回复回到那条话题"。
验收标准、逐条对照与测试证据见 [private-chat-removal-hard-2026-10-07.md](private-chat-removal-hard-2026-10-07.md)；
上一版（ⓑ，留开关）的实现记录保留在 [private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md)（**已被取代**）。


⇒ **开工记录（本次）**：`git worktree list` 显示这 3 个文件仍被 7 条**未合并分支**碰过
（`feat/after-sales-thread`、`feat/arrival-conversation-flow`、`feat/sales-status-dimensions-write`、
`feat/sales-status-write-backfill`、`refactor/decouple-creation-and-stock`、
`feat/return-batch-window-and-topic`、`fix/purchase-schema-after-table-change`），
但它们**全部已停**（worktree working tree 干净、**没有任何 open PR**、最后提交 1.5–7.5 小时前）
⇒ 按 todo 原文的判据（"确认那些 worktree 是不是还在跑"）**判定为非活跃**，
单写入者顺序做，不会覆盖任何人的未提交改动。⚠️ 这 7 条分支日后合并时**会与本次撞车**，
需"要么弃掉、要么重放"。

**第 1 批的遗留说明已被本次取代**：`SampleReplacementService` 的新端口当时**没有生产注入方**
（行为零变化），本次 ③ 已把它接上 —— 缺省仍是改动前逐字相同的私聊回落。
