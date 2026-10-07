# 「某尺码实际到 0 双」放行：验收标准 + 实现对照（2026-10-07）

> **口径来源（业务负责人 2026-10-07 当面拍板，逐字）**：
> 「**这个情况是正常的！对啊，所以这就是为什么要到货核实啊，如果我们报的货都到了，
>  还用校准这个差异吗？如果这个尺码算下来为 0，那么就不用入库啊！**」
> 口径已单独落档：`docs/arrival-zero-arrived-rule-2026-10-07.md`（PR #206，文档先行）。
> 本文件是**它的实现与验收证据**。
>
> ⚠️ 本文的验收标准是**动手前先写的**（业务负责人定的测试流程：先写按链路应该实现的效果 → 再跑 → 逐条对照）。

## 0. 起因（真机事故，2026-10-07 15:00:03）

```
她：8230黑色少一双38码 / 93827黑色少39 40码各一双
而这三行在「单据信息」（purchaseRequest）里申请数量都是 1 双 ⇒ 实际 = 0 双
→ purchase.arrival.reconcile.plan_unmatched reason:"actual_not_positive"
→ 机器人回「我没把你说的话对上这批采购申请的明细，先不入库」 ← 对她来说是**误报**，且整单被拒
```

根因：代码沿用旧口径「实际到货不会为 0」，把**算出来的 `实际 = 0`** 与
**"对不上明细"**混成一个错误分支（`purchaseArrivalConversationService#buildPlan`）。

---

## 1. 验收标准（动手前写的，逐条对照见第 3 节）

### A. 计划阶段（她说完「完毕」→ 发卡片之前）

- [ ] **A1** 一批 12 行里有 3 行算出来 `实际 = 0` → **不发任何「对不上明细」的话**，
  正常发**核对卡片**；卡片上这 3 行如实写「申请 N 双 → 实际 0 双（这双没到）」
- [ ] **A2** `实际 > 0` 的「少」照旧（例：申请 2 − 她说少 1 = 实际 1 → 入库 1）
- [ ] **A3** 真「对不上明细」（她说的尺码/货号在单据里找不到、命中不唯一）→ 仍走原路径：
  `plan_unmatched` + 「我没把你说的话对上这批采购申请的明细，先不入库…」，
  **不发卡片、一个字都不写**（与 0 双**不许混为一谈**）
- [ ] **A4** `实际 < 0`（她说少的双数比申请数还多）→ **不放行、也不静默当 0**：
  不入库、不发卡片，回一句**明确说"算出来是负数"**的话让她重说
  （reason 维持 `actual_not_positive`，既有断言不动）
- [ ] **A5** 差异仍只有三类（一样 / 多 / 少）、`complete` 只认模型明说「说完了」——一个字不改

### B. 卡片（她点「是」之前核对用）

- [ ] **B1** 每行都给出 **申请数量 → 实际数量**（含 0）
- [ ] **B2** `实际 = 0` 的行在卡片上看得出来是「这双没到」（配置文案 `card.zeroActualNote`）
- [ ] **B3** 有 0 行时卡片多一句说明（`card.zeroRowsNote`）：这些行不入库、也不写库存流水
- [ ] **B4** 以上文案全部来自 `config/arrivalConversation.js`（配置先行；改文案不碰逻辑）

### C. 点「是」→ 这才是入库点

- [ ] **C1** `实际 = 0` 的行：**不写「采购入库」、不调 `inventory.applyPurchase`**
  （这 3 行 0 条流水、0 次加库存）
- [ ] **C2** `实际 > 0` 的行：照常写「采购入库」+「库存流水」/「实时库存」；
  **入库数量 = 实际数量**（不是差异数、不是申请数）
- [ ] **C3** 「采购到货」仍只有**一行**（批次级）；🔴「单据信息」(`purchaseRequest`) **零写入**
- [ ] **C4** 流程**不卡**：点「是」后正常收尾（群里回一句结果 + 卡片改终态 + `status = posted`）
- [ ] **C5** 全 0（这一批一件都没到）：不写任何入库 / 库存流水，但流程照走，
  回话**明说"一件都没到、没有入库"**（不能报成"已入库 0 条"含糊过去）
- [ ] **C6** 幂等：重复点「是」不重复入库（含带 0 行的场景）

### D. 日志（排查路径）

- [ ] **D1** 计划阶段：`purchase.arrival.reconcile.plan_zero_actual`（info，列出 0 行的货号/颜色/尺码/申请数）
- [ ] **D2** 真 unmatched：仍是 `purchase.arrival.reconcile.plan_unmatched`（warn）
- [ ] **D3** 负数：`purchase.arrival.reconcile.plan_negative`（warn）——与真 unmatched **分开**
- [ ] **D4** 入库时：`purchase.arrival.reconcile.zero_actual_skipped`（info，明写 `inbound_rows_written: 0`）；
  `posted` 带 `posted_row_count` / `skipped_zero_count`
- [ ] **D5** 发卡片时：`card_sent` 带 `zero_actual_count`

### E. 不许动的东西（回归红线）

- [ ] **E1** `purchaseRequest`（「单据信息」）零写入 —— 既有断言继续钉住
- [ ] **E2** 差异三类（一样/多/少）与 `complete` 判据不变
- [ ] **E3** 入库数量 = 实际数量
- [ ] **E4** 既有断言**一条都不放宽**（只新增）

---

## 2. 我的两个判断（任务书要我说明理由）

### 2.1 `实际 < 0` 怎么处理

**选择：不放行、不静默当 0 —— 与「真对不上明细」分开，回一句"算出来是负数，你说一下这个尺码实际到了几双"。**

理由：

1. **负数不是事实**：`实际 = 申请数 − 她说少的双数 < 0` 只可能是"她说的数字与这行申请数对不上"
   （口误 / 模型听错），不是"这双到了负几双"。**静默夹成 0 等于替她编了一行"没到"**，
   那一行会变成库存流水里不存在的扣减依据 —— 比拒绝更危险。
2. **不能混进 0 双**：0 双已明确是正常结果、要放行；负数要是也放行，
   就等于"任何算得出来的数都入库"，把 `buildPlan` 的唯一算术闸门拆掉了。
3. **也不该说成"对不上明细"**：货号/尺码其实对上了，是**数字**对不上。
   用原来那句「我没把你说的话对上这批采购申请的明细」会让她去改货号/尺码，
   所以另给一句文案（`replies.negative`），并把日志事件分成 `plan_negative`。
4. **reason 维持 `actual_not_positive`**：既有用例（「三类差异⑤」）断言的就是这个取值，
   按纪律**不放宽、不改动既有断言**；语义上"负数确实不是正数"，名字仍然成立。

### 2.2 全 0（这一批一件都没到）怎么处理

**选择：照常走完（建批次级「采购到货」一行 + 卡片终态 + `posted`），但一条入库/库存流水都不写，
回话明说"一件都没到"。**

理由：规则 A1/C1 是**按行**生效的（0 的行不入库）；全 0 只是它的边界，
没有任何一行需要入库 —— 不写入库恰恰是正确结果，不构成"卡单"。
但**不能**用"已按实际到货入库：0 条明细 / 共 0 双"这种话含糊过去（读起来像 bug），
所以单给一句文案 `replies.postedNothingArrived`。
⚠️ 这是我在她没明说的边界上做的判断，已在汇报里标为"不确定处"，等她一句话就能改。

---

## 3. 实现落点

| 能力 | 位置（改动后行号） |
|---|---|
| **放行 `实际 = 0`**：唯一的算术闸门从"必须 ≥ 1"改成"只拦**负数** / 非整数" | `server/src/services/purchaseArrivalConversationService.js:600`（`buildPlan`，`:577` 起） |
| **0 行不入库**：点「是」建草稿时把 `实际 = 0` 的行摘掉（不进 `draft.actual`） | 同上 `:407`–`:415`（`confirmLocked`） |
| **负数单独处理**：`plan_negative` 事件 + `replies.negative` 回话（与真 unmatched 分开） | 同上 `:244`–`:256` |
| 计划阶段日志 `plan_zero_actual`（列出 0 行的货号/颜色/尺码/申请数） | 同上 `:258`–`:269` |
| 收尾回话模板（无 0 / 有 0 / 全 0 三种） | 同上 `:436`–`:447` |
| 入库时正向证据 `zero_actual_skipped` + `posted` 带 `posted_row_count` / `skipped_zero_count` | 同上 `:455`–`:480` |
| 卡片：0 行写「实际 0 双（这双没到，不入库）」+ 有 0 行时补一句说明 | `server/src/utils/larkCards.js:544`（`arrivalReconcileLines`）· `:571`–`:582`（卡片） |
| 文案 / 模板（配置先行） | `server/src/config/arrivalConversation.js:62`–`:96`（`card.*` / `summary.*` / `replies.negative`） |
| 测试 | `server/test/arrivalConversation.test.js`（新增「0 双①②③」，并在「三类差异⑤」上补断言） |

### 为什么在**建草稿**这一步摘 0 行，而不是让 `confirmArrival` 自己跳过

1. `PurchaseWebhookService.aggregateArrivalItems` 对 `quantity <= 0` **当场抛错**
   （那道闸门是给"数量无效"兜底的，**不能放宽** —— 它同时拦着负数）；
2. 在源头摘掉之后，"没到"这个事实只存在于**核对卡片 + 日志**里，
   下游入库能力**不必认识"0 双"这个新概念**（解耦：将来换入库实现不受影响）。

---

## 4. 逐条对照（验收标准 → 证据）

> 证据 = `server/test/arrivalConversation.test.js` 的用例名 + 断言；代码行号按改动后。

### A. 计划阶段

| # | 结论 | 证据 |
|---|---|---|
| A1 | ✅ 12 行里 3 行 0 双 → 正常发卡、**不发任何文字**（更不是"对不上"那句） | 用例「0 双①」：`result.card === true`、`harness.replied` 为空、`cardJson` 不含 `对不上`、`实际 0 双` 正好出现 3 次 |
| A2 | ✅ `实际 > 0` 的「少」照旧 | 既有用例「三类差异③」（2−1=1）与「点「是」②」（38 码入库 1）；本条**未改一行** |
| A3 | ✅ 真 unmatched 仍走原路径 | 既有用例「三类差异④」（41 码不在单据里 → `plan_unmatched`、不发卡、零写入、回话含「先不入库」）**原样保留** |
| A4 | ✅ `实际 < 0` → 不放行、也不当 0 | 用例「三类差异⑤」：`reason === 'actual_not_positive'`、零写入、无卡片、回话含「负数」且**不含**「对不上这批采购申请的明细」、日志 `plan_negative` 1 条 / `plan_unmatched` 0 条 |
| A5 | ✅ 差异三类 / `complete` 判据未动 | `git diff` 只改了 `buildPlan` 的**下界**（`< 1` → `< 0`）；`same` 分支与 `complete` 早退分支逐字未动 |

### B. 卡片

| # | 结论 | 证据 |
|---|---|---|
| B1 | ✅ 每行给出 申请 → 实际（含 0） | 用例「0 双①」断言卡片里有 3 处 `申请 1 双 → 实际 0 双`；既有用例断言 `实际 1 双` |
| B2 | ✅ 0 的行看得出来是"这双没到" | 用例「0 双①」断言卡片含 `这双没到` |
| B3 | ✅ 有 0 行时补一句说明（不入库、不写库存流水） | 用例「0 双①」断言卡片含 `不入库`；`larkCards.js:579` 只在真有 0 行时加这个 note（没有 0 行的卡片与改动前逐字一致） |
| B4 | ✅ 文案来自配置 | 用例「0 双③」：注入自定义 `zeroActualNote` / `zeroRowsNote` / `summary.postedWithZero`，卡片与回话都按自定义文案出 |

### C. 点「是」→ 入库

| # | 结论 | 证据 |
|---|---|---|
| C1 | ✅ 0 的行：0 条「采购入库」、0 次库存 | 用例「0 双①」：`purchaseInbound` create = **9**（12−3）、`inventory.calls` = 9 且键集合恰为"非 0 的 9 个（货品,尺码）" |
| C2 | ✅ 其它行照常、入库数量 = 实际数量 | 同上：每条入库行 `数量 === 1`（实际数；这里申请也是 1，差异在别的用例里钉住）；既有用例「点「是」②」 |
| C3 | ✅ 「采购到货」一行 + `purchaseRequest` 零写入 | 用例「0 双①」：`purchaseArrival` create = 1、`writesTo(purchaseRequest)` 为空、`posted` 日志 `purchase_request_writes: 0` |
| C4 | ✅ 不卡单：正常收尾 | 用例「0 双①」：`status === 'posted'`、群里回一句、toast 为 success；`posted` 日志 `posted_row_count: 9` |
| C5 | ✅ 全 0：一条都不写，回话明说 | 用例「0 双②」：`purchaseInbound` 0 条、`inventory.calls` 0、`purchaseArrival` 1 行、`status === 'posted'`、回话含「一件都没到」且**不含**「已按实际到货入库」 |
| C6 | ✅ 幂等 | 既有用例「点「是」⑥」（重复点不重复写）**原样保留**；0 行不改变幂等路径（`status === 'posted'` 早退在任何写入之前） |

### D. 日志

| # | 结论 | 证据 |
|---|---|---|
| D1 | ✅ `plan_zero_actual` | 用例「0 双①」断言 1 条、`"zero_actual_count":3` |
| D2 | ✅ 真 unmatched 仍 `plan_unmatched` | 用例「三类差异④」走的就是这个分支（既有行为） |
| D3 | ✅ 负数 `plan_negative`（与 unmatched 分开） | 用例「三类差异⑤」：`plan_negative` 1 条、`plan_unmatched` 0 条 |
| D4 | ✅ `zero_actual_skipped` + `posted` 计数 | 用例「0 双①」：`"inbound_rows_written":0`、`"inventory_apply_calls":0`、`"posted_row_count":9`、`"skipped_zero_count":3` |
| D5 | ✅ `card_sent` 带 `zero_actual_count` | 用例「0 双①」 |

### E. 不许动的东西

| # | 结论 | 证据 |
|---|---|---|
| E1 | ✅ `purchaseRequest` 零写入 | 用例「点「是」④」「④-补」（行为断言 + 源码级断言）原样保留；「0 双①」再断言一次 |
| E2 | ✅ 差异三类 / `complete` 判据不变 | 见 A5；`doubaoService.parseArrivalReconciliation` 一个字未动（`test/doubaoArrivalReconcileParse.test.js` 全绿） |
| E3 | ✅ 入库数量 = 实际数量 | 见 C2 |
| E4 | ✅ 既有断言一条未放宽 | 本 PR 对测试文件只有**新增**；唯一被改的既有用例是「三类差异⑤」，改动是**补充断言**（负数回话、日志），原有 5 条断言逐字保留 |

---

## 5. 跑过的验证

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 定向用例 | 自己的 worktree `.local/arrival-zero-actual`：`node --test --test-concurrency=1 test/arrivalConversation.test.js` | 35 pass / 0 fail |
| 全量（第 1 次） | （同上 worktree）`node --test --test-concurrency=1` | **931 pass / 0 fail**（exit 0，25.0s） |
| 全量（第 2 次） | 同上 | **931 pass / 0 fail**（exit 0，26.7s） |
| 跑测试前的版本自检 | `git rev-parse --short HEAD` = `03cf4bc`；`HEAD..origin/main` = 0 | ✅ |

⚠️ 本地跑出来的是"CI 之前的证据"；**CI 结论以 `gh pr checks` 为准**（见 PR）。
🔴 本次**没有部署**（业务负责人 2026-10-07：改完禁止部署，她自己做采购测试）。
