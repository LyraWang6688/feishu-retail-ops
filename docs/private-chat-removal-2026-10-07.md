# 🔴 私聊链路移除 —— 验收标准与实现记录（2026-10-07）

> 业务负责人口径（逐字）：「**以后私聊这条链路我们就没有了**」。
> **方式是她拍板的 ⓐ**：「**代码里一行私聊都不留，测试全部迁到群聊入口**」
> —— 见 [private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)。
> 承接件：[private-chat-excision-todo.md](private-chat-excision-todo.md)（2026-10-06 的「把私聊专属切出来」）。
>
> ⚠️ **没有开关**：刻意**不引入** `PRIVATE_CHAT_INTAKE_ENABLED` 之类的变量，
> 也**没有**"测试专用 helper"。要恢复私聊是**重新实现那条链路**，不是翻一个开关
> （留开关那个方案 ⓑ 已被否掉）。

## 一、⭐ 先写「删完应该是什么样」（验收标准）

> 纪律：**先写预期 → 再跑 → 逐条对照**（`AGENTS.md` 协作纪律第 2 条）。

### A. 私聊（非群聊）入口

| # | 预期 | 判据 |
| --- | --- | --- |
| A1 | 私聊**任何**消息（文字 / 富文本 / 图片 / 空文字）→ **不建任务、不进 AI、不读表、不写表** | `store.create` 0 次、`recognizer.parseSalesText` 0 次、`gateway.create/update` 0 次 |
| A2 | 私聊消息 → **一条消息都不回**（不主动发、也不回复），只记一条 `lark.private_chat.disabled` | `im.message.create` 0 次、`im.message.reply` 0 次 |
| A3 | 私聊专属的两条提示（「机器人当前只接收销售文字…」/「没有读到销售文字…」）**从代码里消失** | 全仓 grep 不到那两句文案 |
| A4 | 改动前的 `not_p2p` 拒绝分支也一并消失 | 非群聊统一走 A1/A2 那条路 |

### B. 群聊（回归 —— **逐字不变**）

| # | 预期 |
| --- | --- |
| B1 | 话题里（`thread_id` 有值）→ 一律处理、**不要求 @**；主群（`thread_id` 为空）→ 按 `resolveMainChatAdmission` 三条判据 |
| B2 | 主群不 @ + 正文像销售 → 新开一笔 + **卡片回复进那条话题**（`reply_in_thread: true`） |
| B3 | 群聊「已收到」仍然只有表情、**不回文字** |
| B4 | 群采购链路（采购申请 / 采购退货 / 到货核对）**一个字都不动** |

### C. 发送出口（没有群上下文时不许静默发私聊）

| # | 预期 |
| --- | --- |
| C1 | 任务**没有群上下文** → `sendTaskCard` / `sendTaskText` **不发消息**、记 `lark.private_chat.send_skipped`（`reason: no_group_context`）、返 `null` |
| C2 | `SampleReplacementService` 里**一行主动私聊都没有**：`sendCard` / `sendText` 两个 open_id 发送器**整体删除** |
| C3 | 群销售 → 补样品提醒回到**那条销售话题**；工作台触发（没有群上下文）→ **不发**（⚠️ 这是**有意的行为变化**，旧行为是静默发私聊） |
| C4 | `PurchaseWebhookService.sendCard`（全仓无调用方）删除 |

### D. 历史用例（**迁到群入口**，不是删掉）

| # | 预期 |
| --- | --- |
| D1 | 原来「拿私聊当入口 / 出口」的 ~26 条用例，输入改成**群消息 + 话题**、走 `salesGroupFlowService` 那条真入口 |
| D2 | 断言改成**群入口的形态**：`reply_in_thread: true`、任务带 `chat_type/chat_id/group_thread_id`、群聊只表情不回文字 |
| D3 | 只有**确实测管线**（不是测入口）的个别用例才直接造任务，且测试里写明原因 |
| D4 | 私聊专属的测试 helper（`test/helpers/enablePrivateChatForTests.js`）**删除** |

### E. 全局门禁

| # | 预期 |
| --- | --- |
| E1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |
| E2 | **真启动一次** `GET /health` → 200（`app.js` 顶部 require 顺序那个坑只有真启动看得见） |
| E3 | CI `server tests`（job `test`）**CLEAN** ＋ CodeQL 通过 |

## 二、实现（逐条对照）

| # | 修法 |
| --- | --- |
| A1/A2/A4 | `larkMvpService.acceptMessage`：群分支之后**只剩一条日志 + 返回** —— `logInfo('lark.private_chat.disabled', { message_id, chat_type, message_type })` → `{ accepted: false, reason: 'private_chat_removed' }`。**没有开关、没有回执**。 |
| A3 | 两条提示所在的**整段 p2p 代码**（含非文字/空文字判断、`extractSalesMessageText` 那一段）已删；两句文案全仓 grep 不到。 |
| C1 | `sendTaskCard` / `sendTaskText`：`chat_type !== 'group'` → `logWarn('lark.private_chat.send_skipped', { kind, task_id, reason: 'no_group_context' })` + `return null`（**刻意留这条防御分支**：删到会崩不算"干净"）。 |
| C2 | `SampleReplacementService`：构造函数里的 `sendCard` / `sendText`（两个 `im.message.create({ receive_id_type: 'open_id' })`）与其选项**整体删除**；两个缺省出口改为"记 skip + 返 null"。`publishCard` 拿不到 message_id 时**不再谎报** `fallback.sent`，改记 `lark.sales.sample_card.fallback.skipped` 并返 `false`。 |
| C3 | `notifySampleReplacements(deliveryResult, operatorOpenId, { handledDetailIds, channelTask })`：`channelTask` = **触发这次交付的那条销售任务**，发送走 `sendCardToTask` / `sendTextToTask`。 |
| C4 | `PurchaseWebhookService.sendCard` 整段删除（原处留注释说明"为什么删 / 要用回来怎么办"）。 |
| D1–D3 | 见第三节。 |
| D4 | `server/test/helpers/` 已删。 |

### ⚠️ C3 实现时踩到的坑（**为什么把「那条**销售**任务」交给出口**）

出口（`LarkMvpService.sendTaskCard`）会顺手记「**话题 ↔ 销售**」的本地路由映射：
映射的 key 是**她那句话的 `message_id`**，值里带**那笔销售的 `record_id`**。
如果拿**补样品任务**去记（它没有 `sales_entry_record_id`），会把那条映射**冲成空** ——
之后那个话题里的消息就再也定位不回那笔销售了。
⇒ 群那条必须把**销售任务**交出去；同理**不复制** channel 字段到补样品任务上。

### ⚠️ 顺带清掉的孤儿

| 位置 | 是什么 | 处置 |
| --- | --- | --- |
| `larkMvpService.sendTodaySales` / `handleBotMenu` | 机器人菜单「今日销售」（只有私聊点得到） | 删 |
| `routes/larkEvents.js` 的 `application.bot.menu_v6` 分支 | 菜单事件（只有私聊会推过来） | 删 |
| `larkMvpService.shanghaiDay` | 只有 `sendTodaySales` 用 | 删 |
| `larkMvpService` 的 `createWorkbenchService` / `todaySalesCard` require | 同上 | 删 |
| `utils/larkCards.todaySalesCard` | 「今日销售」卡片 | 删（定义 + 导出） |

> ⚠️ 顺带发现但**没动**：`purchaseWebhookService.js` 的 `person` 解构导入在 `main` 上就已经没有调用方
> —— 既有问题，不属于本次改动面，留给单独一次清理。
>
> ⚠️ 同类但**本次没动**的"回落 open_id"缺省端口还有三处（`afterSalesFlowService` /
> `saleLookupService` / `salesThreadProgressService` 里给单测用的缺省值）。它们在**生产路径上都已被
> `larkMvpService` 注入真实出口**，只有单测在用。要不要一并清掉 → **待业务负责人/父代理确认**。

## 三、⭐ 测试怎么救的（迁到群入口，**不删覆盖**）

**新增 `server/test/privateChatRemoval.test.js`（13 条）**，钉住上面 A / C / D4 / B：

| 用例 | 钉住什么 |
| --- | --- |
| 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情 / **也不回消息**，只记一条日志 | A1 + A2 |
| 私聊的非文字 / 空文字 → 与文字**同一档**（旧的两条提示已删） | A1 + A3 |
| 没有群上下文的任务 → `sendTaskCard` / `sendTaskText` 不发 + 记 skip + 返 null | C1 |
| 私聊触发的补样品提醒 → 不发 + skip；**不记 `notice_sent`** | C2 + C3 |
| ⭐ 工作台那条路（`routes/workbench.js` 自己 new 的 service）→ 不发 + `reason: no_group_context` | C2 |
| 群销售的补样品提醒 → `reply_in_thread` 进**那条销售话题**，零主动私聊 | C3 |
| `PurchaseWebhookService.prototype.sendCard === undefined` | C4 |
| `sendTodaySales` / `handleBotMenu` / `todaySalesCard` 都不在了 | A3 |
| 路由不再注册 `application.bot.menu_v6`，但消息入口还在 | A3 |
| `SampleReplacementService` 里没有 `sendCard` / `sendText` | C2 |
| 话题里不 @ 也处理；任务带群上下文；采购那条路没被碰 | B1 |
| 群任务的两条出口 payload 不变（都回那条消息的话题） | B2 |
| 主群准入三条判据不受影响 | B1 |

**历史用例（~26 条）逐条迁移**（输入 → 群消息；断言 → 群入口形态）：

| 文件 | 迁移 |
| --- | --- |
| `messageGate.test.js`（5 条） | 入口换成「**主群 + 不 @**」（群里唯一还用这把尺子的那条路）；断言 `group_not_sales_text` / `mode: 'new'` / 引导语走 `reply_in_thread` |
| `larkMvpService.test.js`（11 条） | 入口换成「主群 @ 机器人」；`result.taskId` → `result.sales.taskId`；表情用例只留群那一半。**测管线而非入口**的 4 条直接造任务，测试里已写明原因 |
| `salesGroupThread.test.js`（3 条） | 换成群入口；断言 `reply_in_thread: true` |
| `groupSalesAutodetect.test.js`（2 条） | 换成「话题里不 @ + 录单」与「strict 开关只管主群」 |
| `afterSalesGroupThread.test.js`（2 条） | 换成群入口；售后文字问句断言 `reply_in_thread: true` |
| `salesThreadProgress.test.js`（1 条） | 换成「主群、没有话题上下文」→ 不走二次处理 |
| `salesMessageLink.test.js`（1 条） | 「**没有群上下文的任务**：不发、不写映射、不写表」 |
| `groupThreadReplyRouting.test.js`（1 条） | 群那半保留；私聊那半改成"没有群上下文 → 不发 + 返 null" |
| `sampleReplacementRecovery.test.js`（2 条） | 注入 `sendCardToTask` + `channelTask`；缺省出口改成"不发 + 返 false 不谎报" |
| `larkEvents.test.js`（1 条） | 「私聊链路已移除：一条消息都不发」 |
| 只删 1 条 | `larkMvpService.test.js` 的「today sales menu …」—— `sendTodaySales` 已不存在，留着只能靠"删掉入口再断言旧行为"维持 |

**⚠️ 迁移中一并删掉的测试脚手架**：`privateEvent(...)` 助手（4 个文件里已无人用）、
`test/helpers/enablePrivateChatForTests.js`。

## 四、怎么恢复私聊？

**没有开关可以翻。** 按 ⓐ 的口径：**重新实现那条链路**（入口 + 提示 + 发送端口），
并且要重新想清楚"它是入口之一、还是唯一入口"。
参考实现见 `git log -S 'private_chat_removed'`（本次改动之前的历史）。
