# 触发入口只留卡片按钮：说话不再触发（2026-10-08）

> 业务负责人的口径（逐字，见 `docs/todo-trigger-only-by-card-button.md`）：
> 「二选一时她选：**「乙 只留按钮：说话不再触发了」**」
> 「针对我们有**二次的**（比方说**现货待收**的，还有我们**预付**的），**都需要切换到消息卡片里面**。
>  在消息卡片里面**一点击，货和钱都按照这个逻辑处理**。」

## 0. 一句话

**"在话题里说话"这条入口关掉**（命中进展词 → **零写库**、只回一句提示）；
**卡片按钮那条入口一个字不动**（点【确认成交】照常走完整链路）。
两条路本来就是同一条内部链路（`SalesThreadProgressService.applyComplete` →
`SecondDeliveryService.confirm`），这次只关"说话"那个**触发点**。

## 1. 改动前是什么样（先红的那一半）

| 她在话题里说 | 改动前（实际代码） |
| --- | --- |
| 「那双拿走了」/「交付」 | `applyDelivery` → `SalesDeliveryService.deliver`：写「已交付」+ 扣库存流水 + 扣实时库存 |
| 「收到微信 500」 | `applyPayment` → `PaymentService`：翻/记「收款明细」+ 写收款时间 + 走进度 |
| 「成交 / 已完毕」 | `applyComplete` → `SecondDeliveryService.confirm`：补收款 + 交付（钱货一起） |
| 「收到微信 500，再记一双 66356」 | `ambiguous` → 只回一句「这是在说这笔的收款进展吗…」 |
| 「收到微信」（没说多少钱） | `ambiguous` → 同上 |

判据在 `config/salesProgressIntake.js`（`progressCues.payment / delivery / complete`），
入口是 `services/salesThreadProgressService.js` 的 `handle()`。

## 2. 验收标准（改完之后应该是什么样 —— 逐条对照用）

- **AC-1 说话零写库**：话题里（已定位到某笔销售）说命中 `payment` / `delivery` / `complete`
  词的话 → **不交付、不扣库存、不记收款、不改状态**；
  业务表（销售主表 / 销售明细 / 收款明细 / 实时库存 / 库存流水）**一个字节都不写**。
- **AC-2 改成回一句提示**（不静默）：同一句话回**配置里那句提示**（逐字）；
  回话仍回到**那条销售话题**（`reply_in_thread: true`）。
- **AC-3 不刷屏（幂等友好）**：同一话题在**短时间窗口内**说多次 → 提示**只回一次**；
  第二次起**不再发**，但要留一条可排查日志（`notice_suppressed`）。
- **AC-4 开关是显式布尔、词表与判据代码保留**：
  新开关 `SALES_PROGRESS_TEXT_TRIGGER_ENABLED`（默认 `false` = 说话不再触发）；
  `=true` 时**旧行为逐字恢复**（说话照样写库）。解析走显式布尔（空串 = 没配 = 用默认），
  **不用 `|| fallback`**。
- **AC-5 `ambiguous` / 认不出的既有回话不变**：判不清时仍只回既有那句问话
  （`replies.ambiguous`），**不**换成提示、**仍然零写库**；
  认不出（`NONE`）仍然不归本链路（照旧走销售原话解析）。
- **AC-6 卡片按钮不许回退**：默认（开关关）下，点【确认成交】
  （`handleConfirmDealAction` → `completeDealFromCard`）**照常**走完整链路
  （补收款 + 交付 + 卡面变灰），一个字不变。
- **AC-7 配置先行**：文案 / 窗口 / 开关都在 `config/`，`.env.example` 与默认值一致。
- **AC-8 状态如实**：只回一句提示（业务表一个字没写）的任务状态**不是** `progress_applied`。

## 3. 开关与文案（新增，逐字）

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SALES_PROGRESS_TEXT_TRIGGER_ENABLED` | `false` | 显式布尔。`false`/`0`/`no`/`off` = 说话不再触发（只回提示）；`true`/`1`/`yes`/`on` = 旧行为逐字恢复。空串 = 没配 = 用默认（`false`）。 |
| `SALES_PROGRESS_TEXT_NOTICE` | `这单请在卡片上的【确认成交】点一下～` | 命中进展词时回的那一句话（改文案不碰逻辑）。 |
| `SALES_PROGRESS_TEXT_NOTICE_WINDOW_MS` | `300000`（5 分钟） | 同一话题的提示去重窗口：窗口内已提示过就不再提示。 |

⚠️ 与既有 `SALES_PROGRESS_INTAKE_ENABLED` 的分工（**两个开关管两件事，别混**）：
- `SALES_PROGRESS_INTAKE_ENABLED`（既有，默认 `true`）：**整条二次处理识别**的开关。
  关掉 → 这句话**不归二次处理**（`classify` 直接 `NONE`）→ 会被当成**新销售原话**送进 AI。
- `SALES_PROGRESS_TEXT_TRIGGER_ENABLED`（本次新增，默认 `false`）：**只关"说话触发写库"**。
  关掉后这句话**仍然归二次处理**（照样判得出是钱 / 货 / 成交，照样回话），
  只是**不写库**、改回一句提示 —— 这才是她要的"只留按钮"。

## 4. 不刷屏怎么做（策略写清）

- 去重键 = **话题**（`task.group_thread_id`，缺省退回 `sales_entry_record_id`）——
  与她的口径"**同一话题**短时间内只说一次"逐字对应。
- 状态落在**本地**一个小存储（`server/data/sales_progress_notices/`，
  `JsonTaskStore`，一条话题/一笔单一个文件，键是哈希后的去重键）——
  **不写任何业务表**；记录里存 `notice_at` / `notice_text` / `last_task_id` 便于排查。
  这是"机器人的路由/节流信息"，与 `data/sales_group_threads` 同一个模式。
- 判定：`now - notice_at < 窗口` → **不再发**，只记 `sales.thread_progress.notice_suppressed`。
- 存储读/写失败时**照常提示**（fail-open）：宁可多说一次，也不能让"该点按钮"这句话消失。
- 本类只写**本地任务记录**（状态如实，见 AC-8）与这个节流记录；
  业务表的写入点仍然只有 `PaymentService` / `SalesDeliveryService`（本次一个都不碰）。

## 5. 实现位置

| 文件 | 改什么 |
| --- | --- |
| `server/src/config/salesProgressIntake.js` | 新增 `textTrigger` / `replies.textNotice` / `noticeWindowMs`；新增任务状态 `progress_notice` |
| `server/src/services/salesThreadProgressService.js` | `handle()` 在 `ambiguous` 之后、写库之前插入"说话入口关闭"分支；新增 `noticeOnce()` |
| `.env.example` | 同步三个新键与默认值 |
| `server/test/salesTextTriggerOff.test.js` | 本次验收测试（AC-1…AC-8） |
| `server/test/salesThreadProgress.test.js` | 该文件钉的是**开关打开时的旧行为** → 进程内显式打开开关（一行） |

## 6. 先红后绿（改动前的红）

测试文件 `server/test/salesTextTriggerOff.test.js`（本次新增，13 条）在**实现之前**先跑：

```
$ node --test --test-concurrency=1 test/salesTextTriggerOff.test.js    # 改动前
ℹ tests 13   ℹ pass 5   ℹ fail 8
✖ AC-1/AC-2/AC-8：说「那双拿走了」→ 不交付、不扣库存、只回提示，状态是 progress_notice
✖ AC-1/AC-2：说「收到微信 500」→ 不记收款（连那条「未收款」都不动），只回提示
✖ AC-1/AC-2：说「成交」/「已完毕」→ 不交付、不收款、不扣库存，只回提示
✖ AC-3：同一话题里重复说（语音输入重发）→ 提示只回一次，第二次只留抑制日志
✖ AC-4：开关解析是显式布尔（空串 = 没配 = 默认 false；非法值当场抛）
✖ AC-7：词表与判据代码保留 —— 开关关着也照样判得出钱 / 货 / 成交
✖ AC-7：`.env.example` 里那三个键与配置默认值逐字一致
（红的原因就是"改动前它会写库"：`gateway.created/updated` 非空、`notice` 未定义）
```

**AC-6 那一条在改动前就是绿的**（说明卡片那条路本来就通、这次不该动它 —— 它是回归钉，
不是新功能）：

```
$ node --test --test-concurrency=1 --test-name-pattern="AC-6" test/salesTextTriggerOff.test.js
✔ AC-6：点【确认成交】（默认开关关）→ 照常 待收→已收 + 未交付→已交付 + 扣库存
ℹ tests 1   ℹ pass 1   ℹ fail 0
```

实现之后（同一文件）：

```
ℹ tests 13   ℹ pass 13   ℹ fail 0
```

## 7. 逐条对照（AC → 证据）

| AC | 结论 | 证据（测试 / 代码） |
| --- | --- | --- |
| AC-1 说话零写库 | ✅ | `salesTextTriggerOff.test.js`：`zeroBusinessWrites(gateway)`（`created`/`updated` 都必须为空）覆盖 delivery / payment / complete 三类；delivery 用例里 `service.delivery.deliver` 被换成**抛错**的桩（真去扣库存就会红）；complete 用例断言 `SecondDeliveryService.confirm` **一次都没被调** |
| AC-2 回配置里那句提示 | ✅ | 三个用例逐字断言 `'这单请在卡片上的【确认成交】点一下～'`，并断言 `reply_in_thread === true`（回到那条销售话题） |
| AC-3 不刷屏 | ✅ | 同一话题连发两条 → `textReplies.length === 1`，并抓到 1 条 `sales.thread_progress.notice_suppressed`（带 `sales_entry_record_id` / `progress_kind`）；窗口用例：`textNoticeWindowMs=60000`，拨快 61s 后**再提示一次** |
| AC-4 显式开关 | ✅ | 解析用例：默认 `false`、空串 `false`、`'true'`→`true`、`'off'`→`false`、`'maybe'`→**抛**；打开用例：`textTrigger: true` 时「收到微信 500」把「未收款」翻成「已收款」+ 写收款时间、任务状态 `progress_applied`，且**不再回提示**；「成交」照旧交给 `SecondDeliveryService` |
| AC-5 ambiguous / 认不出不变 | ✅ | 判不清（`收到微信 500，再记一双 66356 黑 42`）与没说金额（`收到微信`）→ 回的仍是 `DEFAULTS.replies.ambiguous` 逐字、**不是**提示、零写库、`progress_kind=ambiguous`、状态 `ignored`；认不出（`NONE`）仍 `handled:false`（走新原话解析，`salesGroupThread.test.js` 里那条主群用例照旧绿） |
| AC-6 卡片按钮不回退 | ✅ | 本文件 AC-6 用例走完整 `service.handleCardAction(...)`：待收→已收 + 收款时间 + 未交付→已交付 + `inventory.applySale` 一次 + toast success；⚠️ **那一条在改动前就是绿的**，改完仍绿；既有 `terminalCardConfirmDeal.test.js`（30 条）**一行未改**、全绿 |
| AC-7 配置先行 | ✅ | 词表/判据代码一行未删（`classify` 用例照旧判得出钱/货/成交）；三个新键在 `config/salesProgressIntake.js`；`.env.example` 同步由测试逐字钉住 |
| AC-8 状态如实 | ✅ | 只回提示的三条用例都断言 `task.status === 'progress_notice'`（**不是** `progress_applied`），并断言 `progress_kind` 如实为 payment / delivery / complete |

## 8. 全量测试 / CI

**⚠️ 全量只在独立 worktree 跑**（`.local/wt-card-only-trigger`，HEAD `feat/card-only-trigger`），
不在主工作区跑。

```
$ node --test --test-concurrency=1        # 第 1 次
ℹ tests 1317   ℹ pass 1315   ℹ fail 2
$ node --test --test-concurrency=1        # 第 2 次
ℹ tests 1317   ℹ pass 1315   ℹ fail 2
```

那 2 条失败**与本改动无关，是既存的"日期硬编码"时间炸弹**（今天上海时间 2026-10-08，
而用例里写死 `CGD-20261007-0001/0002`）：

- `purchaseBatchNoGeneration.test.js` →「② 同天第 2 包 → 0002」「⑥ 并发不重号」
- **在【未做任何改动的 `origin/main`（b75139a）主工作区】上逐条复现**：

```
$ cd <主工作区> && node --test --test-concurrency=1 test/purchaseBatchNoGeneration.test.js
✖ ② 同天第 2 包 → 0002（计数取 max+1，不是条数+1）
✖ ⑥ 并发不重号：两包几乎同时进来，各拿各的号（串行队列）
ℹ tests 16   ℹ pass 14   ℹ fail 2
```

⇒ 🔴 **采购侧文件本次一个字都不碰**（另一个代理正在改），所以不修它；为了给出"除这两条外
全绿"的证据，另跑两次把这两条按名字跳过：

```
$ node --test --test-concurrency=1 --test-skip-pattern="同天第 2 包|并发不重号"
ℹ tests 1315   ℹ pass 1315   ℹ fail 0      # 第 1 次
ℹ tests 1315   ℹ pass 1315   ℹ fail 0      # 第 2 次
```

## 9. CI 证据（PR #255，head `2615a1d`）

```
$ gh pr checks 255
test                       fail    1m2s    https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37650633391/job/112892724851
Analyze (javascript-typescript)  pass  1m6s  .../runs/37650630320/job/112892722307
CodeQL                     pass    2s      https://github.com/LyraWang6688/feishu-retail-ops/runs/112893162899
```

🔴 **`test` 是红的，但根因不在本 PR** —— 它红的**就是本文件第 8 节那 2 条日期硬编码用例**，
且**计数与本地逐字一致**（1317 条里的其余 1315 条全部通过，含本次新增的 13 条）：

```
# CI 日志（gh run view 37650633391 --log-failed）
not ok 675 - ② 同天第 2 包 → 0002（计数取 max+1，不是条数+1）
not ok 683 - ⑥ 并发不重号：两包几乎同时进来，各拿各的号（串行队列）
# tests 1317
# pass 1315
# fail 2
```

**为什么是"时间炸弹"而不是谁的改动**：

| 事实 | 时间（上海） | 结果 |
| --- | --- | --- |
| `main` 最后一次 CI（commit `b75139a`，= 本 PR 的 base） | 2026-10-07 **23:52** | ✅ success |
| 本 PR CI（同一份采购代码，晚 24 分钟） | 2026-10-08 **00:16** | ❌ 那 2 条 |
| 本机在**未改动的 `origin/main` 主工作区**跑那个文件 | 2026-10-08 00:0x | ❌ 同样 2 条 |

⇒ 那条用例里写死了上海日期 `CGD-20261007-0001/0002`，**跨过上海零点就必红**，
与本次改动（销售话题触发入口）**没有任何关系**。
🔴 采购侧文件本次**一个字都不能碰**（另一个代理正在改 `refactor/drop-purchase-inbound-table`）
⇒ **本 PR 不做 `--admin`、不绕过 CI**；这 2 条要么由采购那个任务顺带修，
要么另开一个"只改日期硬编码"的小 PR（**需要 Lead 决定**）。

## 10. 不确定处 / 需要她知道的两件事

1. **提示的去重是"整条话题一份"**，不分钱 / 货 / 成交：她先说「收到微信 500」（回提示），
   一分钟内又说「那双拿走了」→ **第二条不再回**（窗口内同一话题只说一次）。
   判断：两种话现在都只能靠点卡片，卡片没点之前重复提示没有新信息；若她希望"换一种说法再提示一次"，
   把去重键加 `progress_kind` 即可（一行）。
2. **去重窗口只有"5 分钟"这一档**（`SALES_PROGRESS_TEXT_NOTICE_WINDOW_MS`，可配）。
   窗口内**关掉重开会话**也不会重复提示（记录落本地文件）；但若她隔了很久又来重复说，
   会再提示一次 —— 这是有意的（避免她以为机器人死了）。
