# 🔴 私聊链路移除 —— 验收标准与实现记录（2026-10-07）

> 业务负责人口径（逐字）：「**以后私聊这条链路我们就没有了**」。
> **方式是她拍板的 ⓐ**：「**代码里一行私聊都不留，测试全部迁到群聊入口**」
> —— 见 [private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)。
> 承接件：[private-chat-excision-todo.md](private-chat-excision-todo.md)（2026-10-06 的「把私聊专属切出来」）。
>
> ⚠️ **没有开关**：刻意**不引入** `PRIVATE_CHAT_INTAKE_ENABLED` 之类的变量，
> 也**没有**"测试专用 helper"。要恢复私聊是**重新实现那条链路**，不是翻一个开关
> （留开关那个方案 ⓑ 已被否掉）。
>
> ⭐ **2026-10-07 追加：「私聊被挡下时回一句『请到群里说』」那一句 notice 已保留**
>（业务负责人拍板）—— 旋钮只有两个，都在 `config/privateChatNotice.js`：
> `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED`（默认 `true`）、
> `PRIVATE_CHAT_DISABLED_NOTICE_TEXT`（**空串 = 关掉那句话**）。
> 🔴 仍然**没有**恢复私聊入口 / 发送的开关。⇒ 下面 **A2 那一行以本节为准**
>（"一条消息都不回"是 PR #191 当时的状态，PR #193 起改成"只回那一句"）。
> 同一轮收尾（**PR #195**，分支 `chore/private-chat-remaining-default-ports`）还把当时**留待确认的最后
> 5 处「缺省回落发私聊」**清掉了 —— 验收标准与逐条对照见**第五节**。

## 一、⭐ 先写「删完应该是什么样」（验收标准）

> 纪律：**先写预期 → 再跑 → 逐条对照**（`AGENTS.md` 协作纪律第 2 条）。

### A. 私聊（非群聊）入口

| # | 预期 | 判据 |
| --- | --- | --- |
| A1 | 私聊**任何**消息（文字 / 富文本 / 图片 / 空文字）→ **不建任务、不进 AI、不读表、不写表** | `store.create` 0 次、`recognizer.parseSalesText` 0 次、`gateway.create/update` 0 次 |
| A2 | 私聊消息 → **只回那一句固定文案**（可关：`..._ENABLED=false` 或 `..._TEXT=` 空串 → 一个字都不发），另记一条 `lark.private_chat.disabled` | 默认 `im.message.create` 1 次且正文匹配 `config/privateChatNotice` 的文案；`im.message.reply` 0 次 |
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
> ⚠️ 同类但**当时没动**的"回落 open_id"缺省端口还有**5 处**（`afterSalesFlowService` ×2 /
> `saleLookupService` ×2 / `salesThreadProgressService` ×1 里给单测用的缺省值）。它们在**生产路径上
> 都已被 `larkMvpService` 注入真实出口**，只有单测在用。
> 业务负责人 2026-10-07 批准收尾：**已全部清掉**（见第五节）。

## 三、⭐ 测试怎么救的（迁到群入口，**不删覆盖**）

**新增 `server/test/privateChatRemoval.test.js`（13 条）**，钉住上面 A / C / D4 / B：

| 用例 | 钉住什么 |
| --- | --- |
| 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情 / **回一句「请到群里说」**，只记一条日志 | A1 + A2 |
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

---

## 五、2026-10-07 收尾：清掉最后 5 处「缺省回落发私聊」

> 业务负责人 2026-10-07 批准（承接 PR #191 / #193）。
> **PR #195**（分支 `chore/private-chat-remaining-default-ports`）。
> ⚠️ **那句 notice 一个字都没动**（`config/privateChatNotice.js`）——
> 见开头「2026-10-07 追加」。

### 5.1 验收标准（**动手前先写**，`AGENTS.md` 协作纪律第 2 条）

| # | 预期 |
| --- | --- |
| F1 | `saleLookupService.sendCardToTask` 缺省：没有群上下文 → 记 `lark.private_chat.send_skipped`、返 `null` |
| F2 | `saleLookupService.replyCardByTask` 的非群分支：同上；**全类再无 `this.sendCard`** |
| F3 / F4 | `afterSalesFlowService.sendCardToTask` / `sendTextToTask` 缺省：同上；**全类再无 `this.sendCard` / `this.sendText`** |
| F5 | `salesThreadProgressService.sendTextToTask` 缺省：同上；**不再读 `options.sendText`**（旧 open_id 口径） |
| F6 | skip 日志**只有一处定义**：`utils/privateChatSend.js` 的 `skipNoGroupContext`（5 处缺省出口都调它） |
| G1 | `LarkMvpService.sendCard(openId, card)` 因此成孤儿 → **删除** |
| G2 | `LarkMvpService.sendText` **保留**（notice 那一句要用，不许删） |
| H1 | 群任务那条路（回到话题、`reply_in_thread`）**逐字不变** |
| I1 | 依赖缺省端口的测试断言改成**显式注入**；**不许为了绿而删覆盖** |
| I2 | 新增用例钉住：非群任务 → 不发 + 记 `send_skipped` + 返 `null` |
| J1 | `AGENTS.md` 与本文档同步（那两个 env 名可见、"纯静默"表述修正） |

### 5.2 逐条对照

| # | 结果 | 证据 |
| --- | --- | --- |
| F1 | ✅ | `saleLookupService.js` 构造里缺省 = `skipNoGroupContext('card', task)` |
| F2 | ✅ | `replyCardByTask` 的非群分支 = `return skipNoGroupContext('card', task)`；用例断言 `service.sendCard === undefined` |
| F3 / F4 | ✅ | `afterSalesFlowService.js` 两个缺省出口；类里 `sendCard` / `sendText` 已删 |
| F5 | ✅ | `salesThreadProgressService.js` 缺省 = `skipNoGroupContext('text', task)`；用例把旧的 `options.sendText` 传进来记账，断言**一次都没被调** |
| F6 | ✅ | 全仓只有 `utils/privateChatSend.js` 打这条日志；`privateChatRemoval.test.js` 有源码级哨兵（剥掉注释后 grep 不到"发到 `sender_open_id`"的代码） |
| G1 | ✅ | `privateChatRemoval.test.js`：`LarkMvpService.prototype.sendCard === undefined` |
| G2 | ✅ | 同一条用例断言 `typeof prototype.sendText === 'function'`；notice 那条路仍走它 |
| H1 | ✅ | 群任务用例全绿：`privateChatRemoval.test.js` ⑤、`groupThreadReplyRouting.test.js` ③、`saleLookupService.test.js` ②、`afterSalesGroupThread.test.js`、`salesThreadProgress.test.js` |
| I1 | ✅ | `afterSalesFlow.test.js` 的 `build()` 改成显式注入 `sendCardToTask` / `sendTextToTask`；`saleLookupService.test.js` 的 `sendCard` 打桩删除；`messageGate.test.js` / `saleQueryFlow.test.js` 里给已删方法打的桩删除 |
| I2 | ✅ | 新增 9 条：`saleLookupService.test.js` ×3、`afterSalesFlow.test.js` ×3、`salesThreadProgress.test.js` ×1、`privateChatRemoval.test.js` ×2（源码哨兵 + 孤儿） |
| J1 | ✅ | `AGENTS.md` 两处；本文档开头 + 本节 |

### 5.3 ⚠️ 与本节的"有意行为变化"

非群任务（私聊 / 工作台触发）**再也发不出任何消息**：以前"悄悄发私聊"，
现在只记一条 `lark.private_chat.send_skipped` 并返 `null`。
调用方据此**不许记"已发送"**（例：`SampleReplacementService` 不写 `notice_sent`）。

---

## 六、2026-10-07 二次收尾：最后 2 处「非群 → 仍会回一条消息」+ 一条 CI 偶发

> 承接 PR #195；口径不变（业务负责人拍板的 ⓐ「代码里一行私聊都不留」）。
> ⚠️ **那句 notice 仍然一个字都没动**（`config/privateChatNotice.js`）。
> 分支 `fix/private-chat-tail-defaults-and-flake`。
>
> ⚠️ 与 `server/scripts/e2e-*.mjs` / `docs/e2e-group-thread-*.md` /
> `server/test/e2e-group-thread.test.js` **零交集**（那三个由另一个 agent 在写）。

### 6.1 验收标准（**动手前先写**，`AGENTS.md` 协作纪律第 2 条）

| # | 预期 |
| --- | --- |
| K1 | `LarkMvpService.replyTaskCard` 的**非群分支**：不再 `replyCard(task.message_id, card)`，改成记 `skipNoGroupContext('card', task)` + 返 `null`；**零远端调用** |
| K2 | `AfterSalesFlowService.replyCardToTask` 的**缺省**：非群 → 记 `skipNoGroupContext('card', task)` + 返 `null`；**群那一条（`this.replyCard(task.message_id, card)`）逐字不变** |
| K3 | 两处都**复用** `utils/privateChatSend.js`（全仓 skip 日志仍**只有一处定义**） |
| K4 | `replyCard` 孤儿核查：`LarkMvpService.prototype.replyCard` 若还有调用方 → **保留**；若成孤儿 → 删掉 + 注释 |
| K5 | 群路径**逐字不变**：`replyTaskCard` 群分支（`replyCardInThread` + `bindGroupSaleThread`）、`sendTaskCard` / `sendTaskText`、`reply_in_thread` |
| K6 | 全仓仍只有 **1 处** `receive_id_type: 'open_id'`（notice 的 `sendText`）；notice 一行不动 |
| K7 | CI 偶发用例（`purchaseWebhookService.test.js`「A：未配置 PURCHASE_CHAT_ID」）：断言改成**等到 `purchase.request.image.skipped` 出现或超时**，**再**断言恰好 1 条；**不许**放宽成"0 或 1 都行"；守卫语义不变（必须记 skipped ＋ 一条 IM 都不发） |
| K8 | 偶发用例**故意多跑**（不是"跑一次绿了就算"）；全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |
| K9 | 依赖缺省端口的测试断言改成**显式注入**出口；**不许为了绿而删覆盖** |

### 6.2 逐条对照（跑完填）

| # | 结果 | 证据 |
| --- | --- | --- |
| K1 | ✅ | `larkMvpService.js:570` → `if (task?.chat_type !== 'group') return skipNoGroupContext('card', task);`。新用例：`privateChatRemoval.test.js` ② 「`replyTaskCard` 非群 → 不发 / 返 null / 记 skip」（断言 `replies`、`sent` 全空，`kind:card` + `reason:no_group_context` + `task_id` 都落日志） |
| K2 | ✅ | `afterSalesFlowService.js` 缺省：非群 → `skipNoGroupContext('card', task)`，群 → `this.replyCard(task.message_id, card)`（**那一行逐字未动**）。新用例：`afterSalesFlow.test.js` 「缺省出口①」（三条出口全 skip、返 null、`replyCalls` 为空）+「缺省出口①b」（**群任务**仍回 `om_her_message`、零 skip） |
| K3 | ✅ | 两处都调 `skipNoGroupContext`；`SEND_SKIPPED_EVENT` 仍只在 `utils/privateChatSend.js:20` 定义（其余命中都是注释） |
| K4 | ✅ **不是孤儿 → 保留** | `LarkMvpService.prototype.replyCard` 仍有 **4** 个调用方（`:138` SaleLookup 接线 / `:158` AfterSalesFlow 接线 / `:442` `replyPurchaseCard` 的无话题回落 / `:1443` 销售确认卡片的非群分支）；`AfterSalesFlowService.this.replyCard` 仍有 **1** 个读取点（缺省出口的**群分支**）。故两处都按"不是孤儿就保留"处理，**没有删任何东西** |
| K5 | ✅ | `git diff` 里 `replyCardInThread` / `bindGroupSaleThread` / `sendTaskCard` / `sendTaskText` / `reply_in_thread` 一行未动（`larkMvpService.js` 本次只动 1 行代码 + 注释）；群用例：`privateChatRemoval.test.js` ②/⑤、`afterSalesFlow.test.js` ①b |
| K6 | ✅ | `grep -rn "receive_id_type: 'open_id'" server/src` → 只有 `larkMvpService.js:339`（notice 的 `sendText`）；`git diff --stat` 里没有 `config/privateChatNotice.js` |
| K7 | ✅ | 改成 `await waitFor('未配置采购群的跳过日志落盘', () => logs.events('purchase.request.image.skipped').length >= 1)` 之后**再**断言 `=== 1`；"一条 IM 都不发"也移到等待之后断言。**没有**放宽成"0 或 1 都行" |
| K8 | ✅ | 该用例单跑过滤 **25 次全绿**；全量 `node --test --test-concurrency=1` **连跑 2 次：901 tests / 901 pass / 0 fail**（`duration_ms` 23126 / 23190）。根因另有**故意注入 250 ms 延迟**的对照实验：改动前的断言复现 CI 症状（`actual: 0, expected: 1`），改动后的断言同条件通过（286 ms） |
| K9 | ✅ | `afterSalesFlow.test.js` 的 `build()` 把 `replyCard` 打桩换成**显式注入** `replyCardToTask`；`saleQueryFlow.test.js` 的 `makeService` 显式把售后编排的回复出口接到记账打桩上。**没有为绿删覆盖**：本次新增 3 条用例（`privateChatRemoval` ×2、`afterSalesFlow` ×1） |

### 6.3 ⚠️ 不确定处 / 留给下一次的

1. ⚠️ **同样形状、但不在本次范围的两条路径还在**（它们不是"缺省出口"，而是**主回复路径**）：
   - `larkMvpService.js:1443`：销售确认卡片 `task.chat_type === 'group' ? sendTaskCard(...) : replyCard(task.message_id, ...)`
     —— 非群任务仍会回一条私聊；
   - `saleLookupService.js:369`：`replyCardByTask` 的**主**回复（任何 `chat_type` 都先走它）。
   - **为什么没顺手改**：本次 brief 划定的是"最后 2 处缺省出口"，且改它们会牵动
     `larkMvpService.test.js`（16 处 `service.replyCard` 打桩）、`saleQueryFlow.test.js`、
     `salesOrderNoIntake.test.js`、`messageGate.test.js` 这批**历史"没有渠道上下文"的用例**，
     属于"把用例迁到群入口"的独立工作量。**建议单开一条任务**，口径与本次相同
     （非群 → 记 skip + 返 null）。
   - ⚠️ 生产上的触达条件：`acceptMessage` 已不再为非群消息建任务，所以这两条只在
     **磁盘上遗留的旧任务 JSON**（`chat_type` 缺失）被重放时才会走到 —— 概率低但不是零。
2. ⚠️ **K2 的取舍**：`replyCardToTask` 的缺省保留了"**群任务才回她那条消息**"，而不是
   整个缺省都 skip。理由：brief 要求"群分支逐字不变"；且这样 `this.replyCard` 不会成孤儿
   （否则要连带删 `options.replyCard` + `larkMvpService.js:158` 的接线 + JSDoc + 测试）。
   若希望缺省**一律** skip（与 `sendCardToTask` / `sendTextToTask` 完全对称），
   说一声即可改，代价是上面那串连带删除。
3. ⚠️ `AfterSalesFlowService` 现在会读 `task.chat_type`（原注释写着"本类不认识 chat_type"）——
   已把注释改成"只用它判**有没有去处**；飞书语义（`reply_in_thread`）仍只留在注入方"。
