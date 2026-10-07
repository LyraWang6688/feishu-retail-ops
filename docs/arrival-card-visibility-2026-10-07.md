# 到货核对：日志说「卡片已更新」，她那边**一张卡都没有** —— 2026-10-07 23:37 真机

> 状态：**实现中**（本文第 3 节的验收标准**先写**，代码后写；逐条对照见第 7 节）
> 分支：`fix/arrival-card-visible`（独立 worktree `.local/worktrees/arrival-card-visible`）
> 范围：**只改"核对卡片怎么送到她眼前"这一件事**。解析判据（`hasArrivalContent`）、
> 入库能力（`confirmArrival`）、「报货批次」落点、`pendingDealPush*`、销售侧、`app.js` **一个字不动**。

## 1. 真机现象（业务负责人 2026-10-07 23:37，生产）

```
她（话题里）：「货都到了」
服务端日志（逐字，只有这三条，之后没有任何失败）：
  23:37:38.577  purchase.arrival.reconcile.parsed      { task_id: arrival_reconcile_53ce…, complete:true, same:true, difference_count:0, request_row_count:5, bare_all_arrived:false }
  23:37:38.579  purchase.arrival.reconcile.processing  { batch_no:"202610071", message_count:6, parse_complete:true }
  23:37:38.914  purchase.arrival.reconcile.card_updated { batch_no:"202610071", card_message_id:"om_x100b636b253ca430c453e956f10f224", row_count:5, difference_count:0 }
然后机器人回她一句：「我按你刚说的重算了一遍，上面那张卡片已经更新 —— 你看一眼，点「是」我就按新的数量入库。」
她（截图确认）：**话题里根本没有卡片**，只有 20:05 那条「采购单图 + 文字」和这条文字回复。
```

⇒ 交付物应该是「带「是」按钮的核对卡片」，她只拿到一句话 ⇒ **功能不可用**。

## 2. 两种出口的判据（改前，`purchaseArrivalConversationService.handleTopicMessageLocked`）

| 出口 | 代码位置（改前） | 触发条件 | 成功判据 |
|---|---|---|---|
| `card_updated` | 第 354–357 行 | 任务上 `card_message_id` **非空**（= 这批以前发过一张卡） | `updateCard` **没抛错且返回真值**；`patchCardMessage` 只校验 `response.code === 0` |
| `card_sent` | 第 358–376 行 | 没有历史卡片 **或** 更新失败 | `replyCard` 没抛错（返回的 message_id **不校验**） |

⇒ 她这次走的是 `card_updated`：任务上记着一条历史 `card_message_id`，代码**无条件相信它**
（既不确认那条消息还在、也不确认它是不是卡片、更不确认它落在哪个话题）就去 patch，
`code === 0` 即判成功，于是「日志说已更新、她那边什么都没有」。

## 3. ⭐ 验收标准（**先写，再动手**；第 7 节逐条对照）

| # | 验收标准 | 判据（怎么算达标） |
|---|---|---|
| AC-1 | 她在话题里说「货都到了」→ **她说话的那个话题里出现一张带「是」的核对卡片** | 用例：卡片回复的是**她刚说的那条消息**、`options.threadId` = 她这次说话的话题；行数/数量 = 全部到齐 |
| AC-2 | 点「是」→ 入库 + 「报货批次」的到货状态变【已到货】 | 既有用例（`arrivalConversation.test.js` / `arrivalLandingOnBatch.test.js`）保持绿 |
| AC-3 | 重复说一次 → **不重复写库**；卡片**看得见**（策略：**旧卡作废 + 在当前话题重发一张新卡**） | 用例：第二次也只发卡不写表；新卡在当前话题；旧卡被 patch 成"已作废"终态（按钮收掉）；零业务表写入 |
| AC-4 | 目标消息**不是卡片** → **自动回落成"发新卡"**，不许静默什么都不做 | 用例：读回 `msg_type != interactive` → **一个字都不 patch 它**、照样发新卡、日志 `card_supersede_skipped` 带 `target_msg_type` |
| AC-5 | 既有的「解析不了就不发卡」行为**不许回退** | 用例「直接处理③」保持绿（`no_arrival_content` → 零卡片、零写入） |
| AC-6 | **可验证**：日志能回答"卡片到底发出去没有 / message_id 是什么 / 是不是 interactive" | `purchase.arrival.reconcile.card_sent` 带 `card_message_id` · `thread_id` · `card_msg_type`(读回) · `card_msg_type_source` · `card_deleted` · `card_thread_match` |
| AC-7 | 真正去"更新一张已存在的卡片"前，**必须先确认它确实是卡片**；改完**再校验一次结果** | 只有读回 `msg_type === 'interactive'` 且未被撤回才 patch；patch 后再读一次，把 `updated` 写进日志（`card_superseded.update_verified`） |
| AC-8 | 更新成功/跳过/失败都有**明确日志**，且**新卡已经发出**（可见性不依赖 patch） | `card_superseded` / `card_supersede_skipped` / `card_supersede_failed` / `card_update_failed` 四条各有断言 |
| AC-9 | **先红后绿**：用例先复现"解析成功但她在本话题拿不到卡片" | 第 6 节贴改动前的失败输出 |
| AC-10 | 不写任何业务表、不部署、不碰生产 | 所有用例 `gateway.writes = 0`；没碰线上 `.env`、没跑部署脚本 |
| AC-11 | **全量回归**：`node --test --test-concurrency=1` **连跑 2 次 fail=0** | 第 8 节贴原始输出 |

## 4. 根因

**改前的"更新已有卡片"这条路，判据全是"我方动作"，没有一条是"她能不能看见"。**

1. **`card_message_id` 是批次级的，可见性是话题级的。**
   会话任务 id 只由 `batch_no` 决定（`taskIdForBatch`，同一批**含她后来另开一个话题**永远是同一条记录，
   见该函数注释）。而 `existingCardMessageId` 取的就是这条任务上的 `card_message_id` ——
   **它可能是另一个话题里那张卡**。于是"更新成功"发生在 A 话题，她在 B 话题里什么都看不到。
2. **`patch` 的成功判据只有 `code === 0`。**
   飞书官方文档 `im-v1/message/patch`：路径参数 `message_id` 明确写着「**仅支持更新卡片
   （消息类型为 `interactive`）**」，但**错误码表里没有"目标不是卡片"这一条**
   （只有 230001 参数错 / 230011 已撤回 / 230031 超 14 天 / 230110 已删除 / 230027 无权限…）。
   ⇒ 对一条文字或图片消息 patch，**完全可能回 `code 0` 而什么都没改**，代码却记成 `card_updated`。
3. **`replyCard` 的返回值不校验。** `card_updated` 那条路连"message_id 有没有回带"都不看。

⇒ 改前的出口设计，**没有任何一处能排除**"她看不到卡片"这件事；真机那次就是它的必然结果之一。

### 4.1 那个 message_id 是什么（**待服务器只读核一次**，见第 9 节）

`om_x100b636b253ca430c453e956f10f224` 只存在于**生产**的本地任务记录里（`server/data/lark_mvp_tasks/`
下的到货会话任务，`batch_no = 202610071`），本机`server/data/` 里只有测试夹具，**够不着生产**
（按第 8 条纪律：本机不配生产凭证）。本机 grep 全仓：**零命中**。
⇒ 只能交给服务器只读核一次（清单见第 9 节）：它到底是**卡片**（`interactive`）、
还是**我们发的那条图片/文字**、还是**她自己的消息**，以及它落在**哪个话题**。
⚠️ 无论答案是哪一种，本次改法（AC-1/AC-4/AC-7）都已经把它挡住：
不是卡片 → 不 patch 它（AC-4）；是卡片但在别的话题 → 她这次的话题里一定会有新卡（AC-1）。

## 5. 改法（+ 回落策略）

| 层 | 文件 | 改动 |
|---|---|---|
| 出口 | `services/purchaseArrivalConversationService.js` | 「有核对内容」的出口**一律 `card_sent`**：把卡回到**她这次说话的那条消息**（`{ threadId }`）下面，成功判据 = 飞书**回了 message_id**（回空 = 判失败，记 `card_send_failed`，下一句重发） |
| 旧卡 | 同上 `retirePreviousCard()` | 历史卡片**尽力作废**（改成"已作废、请用最新那张"的终态，按钮收掉）：**先读一眼确认 `msg_type === 'interactive'` 且未撤回**才 patch；patch 后再读一次校验 `updated`，结果写日志。**跳过/失败都不影响新卡**（回落策略 = 新卡已经发出去了） |
| 证据 | 同上 `cardEvidence()` | 发卡后读一次刚发的那条：`msg_type` / `deleted` / `thread_id` / `thread_match`，进 `card_sent` 日志 |
| 端口 | `services/larkMvpService.js` | 新增 `getMessageMeta(messageId)`（`im.v1.message.get`，只读）；`updateCard` 端口不变 |
| 文案 | `config/arrivalConversation.js` | `replies.updatedCard` → **`replies.recalculatedCard`**（"更新了上面那张"在**新出口下是假话**，必须改；真机上那句回话正是误导来源）；新增 `card.supersededTitle` / `card.supersededMessage` |

**为什么不是"只把更新判据修严"就够**：那仍然把"她能不能看见"押在"猜对是哪张卡"上。
发新卡是**唯一不依赖猜测**的做法 —— 卡片长在她刚说话的地方，这在结构上就保证了可见性。

**残留（如实记）**：旧卡作废失败时，话题里可能同时留着两张可点的卡（旧卡数字是旧的）。
两张卡指向**同一个 `taskId`**，点哪张都按**最新**计划入库（既有用例「追加②」钉住），
**不会写错账**；作废失败会记 `card_supersede_failed`，可据此排查。

## 6. 先红后绿

（改动前的失败输出贴在第 9 节下方「先红」处。）

## 7. 验收标准逐条对照

（实现后填写。）

## 8. CI 三项 + 全量 2 次

（实现后填写。）

## 9. 需要在服务器上【只读】核的清单（不连生产、不在本机做）

1. `cat server/data/lark_mvp_tasks/*.json | grep -l 'arrival_reconcile_53ce68877412d0580e83226d'`
   → 找出这一批的会话任务文件，看 `card_message_id` / `card_thread_id` / `thread_id` / `transcript` 全貌。
2. **那三条 message_id 的 `msg_type`**（只读 `im.v1.message.get`，用项目代码/官方 SDK，**不用飞书 CLI**）：
   · `om_x100b636b253ca430c453e956f10f224`（日志说被"更新"的那条）
   · 该批 `server/data/purchase_group_messages/` 里 `batch_no=202610071` 记的 `message_id`（20:05 那条采购单）
   · `card_thread_id` 与实际 `thread_id` 是否一致
   → 回答"它到底是不是卡片、在不在她看的那个话题里"。
3. 该批**有没有更早的 `purchase.arrival.reconcile.card_sent`**（grep `202610071`）：
   核对 `card_message_id` 就是 `om_x100b…` 的那一次，当时 `thread_id` 是哪个话题。
4. `PURCHASE_ARRIVAL_CONVERSATION_ENABLED` 的**线上取值**（确认这条链路是开着的）。
5. 顺便核一下**上一个 14 天 / 撤回**两个边界：那条消息在 `im.v1.message.get` 里
   `deleted` / `updated` / `create_time` 各是什么。

## 10. 不确定处（如实记）

1. `om_x100b…` 的**真实类型**没核过（够不着生产）—— 见第 9 节第 2 条。改法对它两种可能都成立。
2. `patch` 对**非卡片消息**到底回什么码，文档里没有这一条 —— **待真机只读核一次**
   （第 9 节第 2 条顺带能看出来：如果那条 `card_message_id` 的 `msg_type` 不是 `interactive`，
   而当时 `patch` 回了 `code 0`，就证明了"200 但什么都没做"）。
3. `im.v1.message.get` 的 `updated` 字段**是否即时反映**（刚 patch 完就读）没在真机验过；
   所以它**只作证据**，不作业务判据（改不动时不影响任何业务事实）。
