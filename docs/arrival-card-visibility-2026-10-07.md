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

**残留（如实记）**：
1. 旧卡作废失败（或 `im.v1.message.get` 读不到那条消息 —— 例如线上缺读权限）时，
   话题里可能同时留着两张可点的卡（旧卡数字是旧的）。
   两张卡指向**同一个 `taskId`**，点哪张都按**最新**计划入库（既有用例「追加②」钉住），
   **不会写错账**；作废失败会记 `card_supersede_failed` / 跳过会记 `card_supersede_skipped`，可据此排查。
2. 她连着说 N 句有内容的话 → 会发 N 张卡（前 N-1 张被作废成灰色）。
   **这是"可见性优先"的代价**：卡片一定落在她说话的地方，代价是话题里多几张"已作废"的痕迹。
   （改动前为了省这几张卡，付出的代价是**她可能一张都看不到** —— 真机已经发生过。）
3. 旧卡作废依赖只读接口 `im.v1.message.get`（**读不到就不动手**，不是"猜着 patch"）。
   若线上这个口子没权限，日志里会是 `card_supersede_skipped{reason:'call_error'/'code_230027'}`
   —— 那时"她一定看得见卡片"这条**照样成立**（新卡已经发出去了），只是旧卡不回收。

## 6. 先红后绿

**改动前**（`server/`，只跑新增的 5 条「可见性」用例）：

```
$ node --test --test-concurrency=1 --test-name-pattern="可见性" test/arrivalConversation.test.js
{"event":"purchase.arrival.reconcile.processing","batch_no":"BH-20261006-0001","message_count":2,"parse_complete":true,"parse_same":true,"difference_count":0}
{"event":"purchase.arrival.reconcile.card_updated","task_id":"arrival_reconcile_bd2baaffb460ea7ffeb46be6",
 "batch_no":"BH-20261006-0001","card_message_id":"om_card_1","row_count":2,"difference_count":0,
 "zero_actual_count":0,"adjustment_total":0,"parse_complete":true,"card_action":"updated"}
✖ 可见性①（真机复现）🔴：卡片在**另一个话题**里 —— 她在本话题说「货都到了」也必须拿到一张卡
  AssertionError: 🔴 必须**在她说这句话的那个话题**里发一张新卡（不是去更新别处那张）
  1 !== 2
✖ 可见性②🔴：历史卡片 id 指向的那条消息**不是卡片** → 一个字都不许 patch 它，照样发新卡
✖ 可见性③：读过之后拿不准（读不到 / 已撤回）→ **不 patch**，照样发新卡
✖ 可见性④：`card_sent` 日志能回答"发出去没有 / message_id / 是不是 interactive / 在哪个话题"
✖ 可见性⑤：旧卡作废**先确认是卡片、改完再读一眼校验**，结果进日志
ℹ tests 5   ℹ pass 0   ℹ fail 5
```

⭐ **它复现的就是真机那三条日志的形状**：只有 `card_updated`（`card_message_id: om_card_1`）、
**没有 `card_sent`** —— 卡片被"更新"到了她这次说话的那个话题之外。

**改动后**：

```
$ node --test --test-concurrency=1 --test-name-pattern="可见性" test/arrivalConversation.test.js
{"event":"purchase.arrival.reconcile.card_sent","task_id":"arrival_reconcile_bd2baaffb460ea7ffeb46be6",
 "batch_no":"BH-20261006-0001","card_message_id":"om_card_2","row_count":2,"difference_count":0,
 "zero_actual_count":0,"adjustment_total":0,"parse_complete":true,"card_action":"sent",
 "card_requested_msg_type":"interactive","card_msg_type":"interactive","card_msg_type_source":"message_get",
 "card_msg_type_reason":"","card_deleted":false,"card_thread_id":"","card_thread_match":null,
 "thread_id":"omt_B","superseded_card_message_id":"om_card_1","supersede_attempted":true,"supersede_result":"ok"}
✔ 可见性①（真机复现）🔴 …  ✔ 可见性②🔴 …  ✔ 可见性③ …  ✔ 可见性④ …  ✔ 可见性⑤ …
ℹ tests 5   ℹ pass 5   ℹ fail 0
```

## 7. 验收标准逐条对照

| # | 验收标准 | 结果 | 判据（用例 / 日志） |
|---|---|---|---|
| AC-1 | 她说「货都到了」→ **她说话的那个话题里出现带「是」的核对卡片** | ✅ | 用例「可见性①」：`cards.length 1 → 2`、`cards[1].messageId = 她刚说的那条`、`options.threadId = 她这次的话题`、按钮 `[confirm_arrival_reconcile, reject_arrival_reconcile]` 齐全；`card_sent` 日志 |
| AC-2 | 点「是」→ 入库 + 到货状态【已到货】 | ✅（未改动） | `arrivalConversation.test.js` 59/59、`arrivalLandingOnBatch.test.js` 全绿（入库 / 库存 / 「报货批次」到货状态那几条原样） |
| AC-3 | 重复说一次 → 不重复写库；卡片**看得见**（策略：**旧卡作废 + 在当前话题重发新卡**） | ✅ | 用例「追加①/④」「可见性①」：第二次 `cards.length 2`（新卡在当前话题）、旧卡被 patch 成灰色"已作废"（按钮收掉）、`gateway.writes = 0` |
| AC-4 | 目标消息**不是卡片** → 自动回落"发新卡"，不许静默 | ✅ | 用例「可见性②」：`msg_type: 'text'` → `updated.length 0`（一个字都没 patch 它）+ 新卡照发 + `card_supersede_skipped {reason:'target_not_interactive', target_msg_type:'text'}` |
| AC-5 | 「解析不了就不发卡」不许回退 | ✅（未改动） | 用例「直接处理③」仍然绿：`no_arrival_content` → 零卡片、零写入、`status: collecting` |
| AC-6 | 日志能回答"发出去了没有 / message_id / 是不是 interactive" | ✅ | 用例「可见性④」逐字段断言：`card_message_id` · `thread_id` · `card_msg_type:'interactive'` · `card_msg_type_source:'message_get'` · `card_thread_match:true` · `card_action:'sent'`；旧 `card_updated` 事件 0 条 |
| AC-7 | 更新已存在的卡片前**先确认它是卡片**、改完**再校验结果** | ✅ | 用例「可见性③/⑤」：读不到 / 已撤回 → **不 patch**；是卡片 → patch → 再读一眼 `updated` → `card_superseded.update_verified:true` |
| AC-8 | 更新成功 / 跳过 / 失败都有明确日志，且**新卡已发出**（可见性不依赖 patch） | ✅ | 用例「可见性②/③/⑤」「追加③」分别断言 `card_supersede_skipped` / `card_superseded` / `card_supersede_failed` + `card_update_failed`，且三种情况下 `cards.length` 都 +1 |
| AC-9 | 先红后绿 | ✅ | 第 6 节（改动前 5 fail → 改动后 5 pass） |
| AC-10 | 不写任何业务表、不部署 | ✅ | 全部用例 `gateway.writes = 0`；没碰线上 `.env`、没跑任何部署脚本（只 `git push` + 开 PR） |
| AC-11 | 全量 `node --test --test-concurrency=1` 连跑 2 次 fail=0 | ✅ | 第 8 节（1299 / 1299 ×2） |

## 8. CI 三项 + 全量 2 次

### 全量 2 次（在**独立 worktree** 里跑，不在主工作区）

```
$ node --test --test-concurrency=1     # 第 1 次
ℹ tests 1299   ℹ pass 1299   ℹ fail 0   ℹ duration_ms 34830   （exit 0）
$ node --test --test-concurrency=1     # 第 2 次
ℹ tests 1299   ℹ pass 1299   ℹ fail 0   ℹ duration_ms 33890   （exit 0）
```

（改动前 `arrivalConversation.test.js` 54 条 + `cardUpdateMulti.test.js` 8 条；
改动后 59 + 11 —— **只增不删**。）

### CI 三项（`gh pr checks`，**不用 `--admin`**）

（PR 开出来后填写。）

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
