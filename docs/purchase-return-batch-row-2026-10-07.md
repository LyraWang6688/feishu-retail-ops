# 退货批次也落「报货批次」一行（到货状态留空）· 退货单 PNG 有落点 · 9 点推送不受影响

> **业务负责人口径（逐字，2026-10-07 晚）**
>
> 「**为什么退货批次不可以像申请一样，也自动生成呢？并且也落到报货批次表里呢？
>  然后如果退货申请也要落到报货批次的话，那么到货状态，就需要你在报货的时候，写入未到货，
>  然后退货，不用写**，你再来理解一下～」
>
> ⇒ 三条：
> 1. **退货批次也自动生成批次号**（与报货同一套生成器/格式 `CGD-YYYYMMDD-NNNN`、同一套幂等）；
> 2. **退货也往「报货批次」写一行**（这样**退货单那张 PNG 才有落点**：写该行的「单据」附件）；
> 3. **报货**建那行时写 **到货状态 = 未到货**；**退货**建那行时 **到货状态留空**（不写）
>    —— 留空的目的：**退货批次不会混进每天 9 点的「未到货」推送**（推送只认字面量「未到货」）。

> ⚠️ 本文件**先写"改完之后应该是什么样"（第 4 节验收标准），再动手**；第 5 节是逐条对照与证据，
> 第 6 节是改过的既有断言逐条说明，第 7 节先红后绿，第 8 节 CI，第 9 节不确定处。

---

## 1. 改动前的现状（核过的代码位置）

| # | 现状 | 位置 |
|---|---|---|
| 1 | **报货**：`confirmPurchaseRequest` 用 `createOnceByKey('purchaseOrderBatch', …)` 建一行，幂等键 = 已落盘计划里的 `purchase_batch:<批次 task_id>`，并写「到货状态 = 未到货」（取值来自配置） | `services/purchaseWebhookService.js` `confirmPurchaseRequest` |
| 2 | **退货**：走 `handleReturnBatch` → `runReturnBatch`（整批）或 `processSupplierReturn`（单条），**一条「报货批次」行都不建** | 同上 `runReturnBatch` / `processSupplierReturn` |
| 3 | 于是 `writeSupplierImageAttachment` 找不到落点：`findDocument` → `!found` → 记一条 `purchase.batch.document.no_record` 的 warn，**连素材都不上传** | `writeSupplierImageAttachment` / `PurchaseOrderBatchService.writeDocument` |
| 4 | 批次号在**入口**（`accept` → `ensureIntakeBatchNo` → `ensureReportBatchNo`）按包生成并写回「信息填写」；**退货记录走的是同一条入口**（`kind` 也是 `supplier-report`）⇒ 退货**已经**消耗号（生成器计数 = 「信息填写」∪「报货批次」并集） | `ensureReportBatchNo` / `services/purchaseBatchNoGenerator.js` 文件头 ② |
| 5 | 两条「退货不建报货批次」的既有断言钉着旧行为 | `test/purchaseReturn.test.js`、`test/purchaseReturnBatch.test.js`、`test/purchaseWebhookService.test.js` |

## 2. 决策与依据

| # | 决策 | 依据 |
|---|---|---|
| D1 | 退货批次的号**不重新生成**：入口已经按包生成并写回「信息填写」（`readReportBatchNo` 读到的就是它）⇒ 退货建行时**复用同一个号** | 她的口径是"退货批次也自动生成"，而**号在入口就已经生成了**（第 1 节 #4）；在退货那一侧再生成一次会得到**第二个号**，正是要避免的 |
| D2 | 建行落在 **`PurchaseOrderBatchService`**（新增 `createForReturnBatch`），由 `PurchaseWebhookService` 在**出图之前**调 | 「报货批次」那一行的读写本来就归这个 service（模块化）；出图之前建行，PNG 才有落点 |
| D3 | 建行用 `createOnceByKey`，**幂等键与报货同族**（前缀 `purchase_batch:`），但身份取**批次号**：`purchase_batch:<批次号>` | 报货那条的键是 `purchase_batch:<批次 task_id>`。退货这边**不能用 task_id**：一个退货批次重试时"领头的那条记录"可能换人（先投 A 还是 B 不定），换人就会算出**另一个键**、多建一行；**批次号才是这一包的稳定身份**（归批键就是它） |
| D4 | 退货建行**只写 批次号 + 幂等键**，**不写「到货状态」**（连 `arrivalStatus` 这个键都不进 `values`） | 她逐字：「**退货，不用写**」。留空 ⇒ 9 点推送（只认字面量「未到货」）**看不见它** |
| D5 | 建行只发生在**这一批真的有内容要出图**时（`runReturnBatch`：`preparedList.length > 0`；`processSupplierReturn`：`docIds.length > 0`） | 这一行的**唯一用途**是"退货单 PNG 的落点"（她的口径）。一双都没退掉（`taken = 0`）时既没有图、也没有事实要挂 ⇒ 不建空行 |
| D6 | 建行失败**不阻塞**出图/发群/流水（catch → warn） | 与既有「附件写失败不阻塞主流程」同一条纪律；库存与单据那时已经落地 |
| D7 | 退货行**不走**「改到货状态」那条路（到货核对本来就对退货话题直接退场） | 既有边界：`ARRIVAL_BATCH_KINDS.PURCHASE_RETURN` 已在到货核对入口被挡掉 |
| D8 | 用户可见文案里的旧表名「采购到货」→ **「到货验收」**（只改她点到的两处 ＋ 那句 toast＋两处会出现在她眼前的报错原文） | 她 2026-10-07 已把「采购到货」改名「到货验收」；AGENTS.md：生产表改名要同步用户可见文案 |
| D9 | `utils/larkCards.js` 那处默认标题 **本次不动**（另一个在跑的任务正在改这个文件） | task brief 明确：只改 `larkCards.js` 以外的，那处跳过并在汇报里写清 |

## 3. 不做什么（边界）

- 🔴 不碰销售侧任何文件、`utils/larkCards.js`、`pendingDealPush*`、`app.js`；
- 🔴 **不改「报货」那条链的既有行为**（只确认它仍然写「未到货」）；
- 🔴 `doubaoService` 的提示词/助手名不动（改它等于改解析行为）；
- 🔴 「报货批次」的「采购行为」列不读、不写、不映射（Lookup/公式，她的）；
- 🔴 不写任何生产表（只读核都没有做写操作）· 不部署。

## 4. 验收标准（**先写，后对照**）

| # | 验收标准 |
|---|---|
| A1 | 退货包（入口 `accept`）建「报货批次」**1 行**；该行的「报货批次号」＝「信息填写」那一列上的号（同一个 `CGD-YYYYMMDD-NNNN`） |
| A2 | 退货行的**「到货状态」是空的**：`values` 里**连这个键都没有**（不是"写了空串"） |
| A3 | 退货行的「幂等键」非空，且**与报货同族**（`purchase_batch:` 前缀） |
| A4 | **报货**包建的那一行仍然写「到货状态 = 未到货」（口径差异对钉） |
| B1 | **退货单 PNG 写到那一行的「单据」**：上传 1 次、`单据` 里 1 个 file_token、文件名以 `-退货单.png` 结尾 |
| B2 | 既有附件语义不变：**同名图 → 连上传都不做**（跳过）；**多供应商 → 已有附件带上再追加**（两张图都在同一行的「单据」里） |
| B3 | 没有落点时（真的没有号 / 建行失败）行为不变：**只 warn、不上传**，图照常发到群里 |
| C1 | 退货行（「到货状态」空）**不进** 9 点推送的候选；候选里只有字面量「未到货」的那些批次 |
| D1 | **重投**（同一条记录再收一次 webhook）不生成第二个号、不建第二行、不重复上传 |
| D2 | **重试/重跑**（把处理状态与任务状态手动改回未处理再跑一遍）同样只有 1 行、1 份附件 |
| E1 | **退货与报货不会拿到同一个号**：先跑一个退货包、再跑一个报货包，两行批次号不同（并集计数） |
| F1 | 「退货单」这条链路的**其余行为逐字不变**：扣库存、写「具体信息」、出图标题、发群（图 + 一句话）都不动 |
| G1 | 用户可见文案里的旧表名同步成「到货验收」：`config/arrivalConversation.js` 的卡片失败标题与 `replies.arrivalCreateFailed`、`purchaseWebhookService` 那句 toast |
| G2 | `utils/larkCards.js` **不改**（另一个任务在改它）· `doubaoService` 提示词不改 · 「报货批次.采购行为」不读不写 |
| H1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（在独立 worktree 里跑） |
| H2 | `gh pr checks` 见 **CLEAN**（`test` / `Analyze (javascript-typescript)` / `CodeQL`）；**不用 `--admin`**；**不开合并**（合并由业务负责人来做） |
| H3 | 既有断言**不放宽**；因**口径变更**必须改的逐条说明"为什么不是放宽"（第 6 节） |
| H4 | 🔴 不部署（等她当次命令）· 不写生产表 · 不改线上 `.env` |

## 5. 逐条对照（实现与证据）

（实现后回填）

## 6. 改动的既有断言（逐条说明：口径变更 vs 放宽）

（实现后回填）

## 7. 先红后绿（证据）

（实现后回填）

## 8. CI 三项实际输出

（实现后回填）

## 9. 不确定 / 没做到的地方

（实现后回填）
