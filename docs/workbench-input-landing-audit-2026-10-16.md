# 工作台「输入框 → 落点」审计（2026-10-16 · **只读**）

> 起因：2026-10-16 那个「**到货说明**」的教训 —— 输入框**收了值，但代码里没有任何落点** ✗
> （它一路走到 `purchaseArrivalConversationService` 的草稿，而「验收原话」**那一列 2026-10-09 已被她从真表删掉**
> ⇒ **写进了不存在的东西** ✗），而且**没人发现**，直到她追问 ✓
> ⇒ 本报告把工作台**所有输入**逐条从「界面」追到「表 + 列」✓
>
> 🔴 本任务**只出报告、一个字都没改** ✗（发现真问题 ⇒ 报 Lead + 建任务 ✓）

## 0. 怎么读这张表（证据等级标注，不吹）

| 标记 | 含义 |
|---|---|
| ✅ **已核到列** | 界面 → 提交键 → 路由 → 服务 → **具体表 + 具体列**，四跳都在代码里核过 |
| 🔎 **已核到服务** | 追到写入服务为止（列映射在 `config/v1BitableSchema`，**未逐列核对**）|
| 🔵 **只读筛选** | 它本来就**不该有落点**（查询/筛选/分页参数）⇒ **不是缺陷** ✓ |
| ✗ **无落点 / 落点已失效** | **真问题**（收不到、或写进不存在的东西 ✗）|

## 1. 逐条表

### 1.1 工作台「采购 → 验收」（`features/orders/index.js`）

| 输入（data-field / 标签）| 提交发到哪 | 后端谁读 | 落到哪 | 等级 |
|---|---|---|---|---|
| `arrival-amount`「实际金额」| `api.post(ARRIVAL_FULL_API.accept)` `orders/index.js:1047` → `POST /purchase/arrivals/accept` | `routes/workbench.js` → `workbenchPurchaseArrivalService.confirmArrival` | 金额进**核对链路**（`purchaseArrivalConversationService`）⇒ 与实际数量一起进**库存/批次** | 🔎 已核到服务（金额的**列**落点未逐列核 ⇒ 见 §3 T2）|
| `arrival-actual`「逐码实际到货」| 同上（`[ARRIVAL_FULL_FIELDS.lines]`）| 同上 → `scanArrivalService.addScan` 那条 | **实时库存 + 库存流水**（按实际到货加库存 ✓）| ✅ 已核到列（task-27/37 已实测：`inventory.change.applied` ✓）|
| `custom-item-no` / `custom-item-size` / `custom-item-quantity`「补充其余尺码」| 同上（进 `lines`）| 同上 | 同「逐码实际到货」⇒ **实时库存 + 流水** ✓ | 🔎 已核到服务 |
| ~~`arrival-note`「到货说明」~~ | **2026-10-16 已删** ✓（PR #651）| —— | —— | ✗→**已修**（本节就是起因 ✓）|

### 1.2 工作台「销售 → 订单列表」（`features/orders/index.js`）

| 输入 | 提交发到哪 | 后端谁读 | 落到哪 | 等级 |
|---|---|---|---|---|
| 补收款（金额/方式）| `api.post(ORDERS_API.payments)` `:1094` → `POST /sales/payments` | `followup.addPayment` → `paymentService.record` | **收款明细**：收款金额 / 收款方式 / 收款状态 / **收款日**（唯一代码写的时间列 ✓）| ✅ 已核到列（task-37 实测过同一条链 ✓）|
| `detail-amount` / `diff-amount`（每件实收 / 差价）| `api.post(ORDERS_API.detailAmounts)` `:1121` | `POST /sales/detail-amounts` → 销售明细写入器 | **销售明细 · 实收金额** | 🔎 已核到服务 |
| `sample-fill-size` / `sample-fill-quantity`（样品补货）| `api.post(ORDERS_API.sampleFill)` `:1144` | `POST /sales/sample-fill` → `SampleReplacementService` | 补货记录 + **库存/流水**（样品替换那条链 ✓）| 🔎 已核到服务 |
| `delivery-detail`（勾选要交付的明细）| `api.post(ORDERS_API.deliveries)` `:1159` | `followup.delivery.deliver` → `salesDeliveryService` | **销售明细 · 履约状态 = 已交付** ＋ **实时库存扣减 + 流水** | 🔎 已核到服务 |
| `after-sales-action` / `after-sales-detail`（售后动作/明细）| `api.post(ORDERS_API.afterSales)` → `POST /sales/after-sales` | `WorkbenchOrderActionService.afterSales` → `afterSalesService` | 售后记录 +（退货类）**库存加回** ＋ 收款/退款 | 🔎 已核到服务 |
| 二次交付（方式）| `api.post(ORDERS_API.secondDelivery)` `:1172` | `secondDeliveryService.confirm` | **收款明细**（尾款）＋ **销售明细 · 已交付** ＋ 库存 | 🔎 已核到服务 |
| 重试（异步补写）| `api.post(ORDERS_API.retry)` `:1192` | `saleWriteBackgroundService` 重放 | 与首次同一批写入（幂等 ✓）| 🔎 已核到服务 |

### 1.3 工作台「库存 → 手工调整」（`features/inventory/adjustment.js`）

| 输入 | 提交发到哪 | 后端谁读 | 落到哪 | 等级 |
|---|---|---|---|---|
| `count-keyword` / `count-size` / `count-state`（定位那一格）| `api.post('/api/workbench/inventory/adjustments/count')` `:226` | `routes/workbenchInventoryAdjustment.js` → `inventoryAdjustmentService` | 定位参数（**本身不落表** ⇒ 正常 ✓）| 🔵 |
| `counted-quantity`「盘到的数量」| 同上 | 同上 | **实时库存 · 数量** ＋ **库存流水**（盘点调整 ✓）| 🔎 已核到服务 |
| `season-*`（关键词/类别/尺码/动作/目标状态）| `api.post('/api/workbench/inventory/adjustments/season')` `:377` | 同上 | **实时库存 · 所属状态**（门盒/样品/仓库）＋ **库存流水** | 🔎 已核到服务 |
| `delta-quantity`（换季数量）| 同上 | 同上 | **实时库存 · 数量** ＋ 流水 | 🔎 已核到服务 |

### 1.4 工作台「销售 → 销售查询」/「货品 → 标签打印」（只读筛选）

| 输入 | 用途 | 落点 | 等级 |
|---|---|---|---|
| `keyword` / `category` / `state` / `size` / `sort` / `recent-days`（标签打印筛选）| 查询参数 | **不应落表** ✓（`GET /api/workbench/labels` 只读 ✓）| 🔵 |
| 编号选择器 `keyword` | 查询参数 | **不应落表** ✓（`GET /products/numbers` 只读 ✓）| 🔵 |
| 打印队列 / 扫码打印（`queue.js:156` / `scan-print.js:255`）| `POST /label-print/jobs` | 打印任务（**本地队列 + 回执**，不写业务表 ✓）| 🔎 已核到服务 |

## 2. 结论（两类真问题）

1. ✗ **无落点**：本次逐条核过的输入里 **没有发现**"收了就丢"的新案例 ✓
   （每个 `data-field` 要么进提交体、要么是只读筛选 ✓）
2. ✗ **落点已失效**：**只有 1 例，且今天已修** ——
   「到货说明」→ `acceptanceText` → `purchaseArrivalConversationService` 草稿 → **写「验收原话」**，
   而**那一列 2026-10-09 已从真表删除** ⇒ **写进不存在的东西** ✗（她的原话：「数据表里面已经没有验收原话了」✓）
   ⇒ PR **#651** 已把**整条通路成对删掉** ✓
3. ⚠️ **需要下一刀才能下结论的**：见 §3 —— 它们是"**追到服务为止**"，**没有逐列核对** ⇒ **不作为结论** ✓

## 3. 待核（**下一刀建议**，每项都小、都可真红）

| # | 待核什么 | 怎么做 | 为什么值得 |
|---|---|---|---|
| **T1** | `v1BitableSchema` 里**所有被写入的语义键**是否都还在真表（**列级**对照）| 用**项目代码**只读跑一遍 `pnpm run v1:schema-check:all`（对着生产）+ 把本次每个 🔎 的行逐列核 | 「到货说明」那种"写进已删列"**正是闸门能提前拦的**（`AGENTS.md` 已写：部署前必须跑闸门 ✓）|
| **T2** | `arrival-amount`（实际金额）到底进哪一列 | 读 `purchaseArrivalConversationService` 的确认写入 + 只读核真表 | 它是**唯一带金额的验收输入**，落点必须明确 ✓ |
| **T3** | `after-sales-*` / `sample-fill-*` 的列级落点 | 同上（读写入器 + 真表只读核）| 售后是最复杂的一条链（钱+货+库存）✓ |
| **T4** | 前端**只读筛选**是否被误存进表 | 只读 grep 确认这些字段**不进任何 `POST` 体** | 本次已核 1.4 ✓（可加**源码哨兵**防回归 ✓）|

## 4. 建议（给 Lead 排活用）

1. **建一条"落点哨兵"用例**：给每个**有落点**的 `data-field` 钉一条"提交键 → 路由 → 服务"的**静态链**，
   任一环断了就红 ✓（本次的「到货说明」如果早有这条哨兵，**当场就会红** ✗）
2. **部署闸门照旧**：`pnpm run v1:schema-check:all`（对着生产）+ 每次她删列后立刻只读核真表 ✓
3. **新增输入时的一条纪律**（建议写进总账）：**"这个框的值最终落哪张表哪一列"必须能在 PR 里写出来** ✗
   —— 写不出来就别加这个框 ✓（「到货说明」就是反例 ✓）

## 附：本次覆盖范围与限制（如实）

- 覆盖：`public/workbench/**` 里全部 `data-field`（含 `input` / `select` / `textarea`）✓ + 它们的提交端点 ✓
- **限制 1**：§1 里标 🔎 的那些**只追到写入服务**，**没有逐列核对**（⇒ 不写进"结论" ✓ 见 §3）
- **限制 2**：`routes/scanPage.js` / `views/**` / 扫码页那条线**不在本次范围**（热点文件，Lead 明令别碰 ✗）
- 🔴 本报告**不改一行代码** ✓ · 未部署 ✓ · 生产 Base 只读 ✓

---

## 5. 补核（2026-10-16 · task「落点哨兵」这一步的只读核对）

### 5.1 ✅ T2：`arrival-amount`（实际金额）的列级落点 —— **已核到列**

`features/orders/index.js`（`arrival-amount`）→ `api.post(ARRIVAL_FULL_API.accept)` →
`src/routes/workbench.js:252` `router.post(arrivalTab.api.accept, …)`（**变量路径**，常量在 `config/workbenchArrival.js`：
`accept: '/purchase/arrivals/accept'` ✓）→ `workbenchPurchaseArrivalService.confirmArrival({ batchNo, actualAmount })` →
`purchaseArrivalConversationService`（`:735` / `:871` / `:880` 的 `actual_amount`）⇒
**落 `采购主表`（报货批次）·「实际金额」**（`v1BitableSchema.tables.purchaseOrderBatch.fields.actualAmount = '实际金额'` ✓；
schema 注释 `:477` 逐字写着**保留**「到货状态 ＋ 实际数量 ＋ **实际金额**」✓）⇒ **不是"写进已删列"** ✓

### 5.2 🔎 T3：售后那条链的列级落点 —— **已核到写入调用（未逐列命名）**

`afterSalesService` 的写入点（只读核过）：`gateway.create('salesEntry'`（`:573`）· `create('salesDetail'`（`:777`）·
`update('salesDetail'`（`:838`）· `create('paymentRecord'`（`:934`）· `update('paymentRecord'`（`:1068`）·
`update('salesEntry', { afterSalesCount })`（`:1205`）⇒ 落点 = **销售主表·售后次数 / 销售明细 / 收款明细** ✓
⚠️ **未逐列命名**（每个 create/update 的具体列没一列列核）⇒ 仍标 🔎 ✓

### 5.3 ✗ 未核：**样品补货**那条链的列级落点

本刀没核（`sample-fill-*` → `POST /sales/sample-fill` → `SampleReplacementService`）⇒ **如实标 ✗ 待核** ✓

### 5.4 ⭐ 顺带核到的一件事（**值得记**）：端点可能是**变量路径**

`POST /purchase/arrivals/accept` 在 `routes/workbench.js` 里**不是字面量**，
而是 `router.post(arrivalTab.api.accept, …)`（`:252`，常量在 `config/workbenchArrival.js`）✗
⇒ 我一开始按"字面量"grep **找不到**，差点误判成"端点不存在 / 走 catch-all" ✗
⇒ **教训（写进哨兵）**：查"某个前端 POST 由谁收"时，**必须同时查【字面量】和【变量路径】** ✓
（现已在 `test/workbenchInputLanding.test.js` 的 `ARRIVAL_FULL_API.accept` 那一链里**钉住这个形状** ✓）

## 6. 落点哨兵（本刀新增用例 · `server/test/workbenchInputLanding.test.js`）

| AC | 钉什么 |
|---|---|
| **AC-LANDING-1** | 从源码抽出**所有** `api.post(…)`；凡不在 `CHAINS`（已核链）/ `PENDING_LANDING`（已登记待核）里 ⇒ **红** ⇒ **新增输入必须写清"落到哪张表哪一列"** ✓ |
| **AC-LANDING-2** | 6 条已核链的**四跳**：① 前端真的发 ② 路由真的读到（**含变量路径那种形状** ✓） ③ 服务真的消费 ④ **落点列在 schema 里真的存在** ⇒ 任一环断就红 ✓ |
| **AC-LANDING-3** | ⭐ **范例**：`purchaseOrderBatch` 里**没有** `acceptanceText` ⇒ **「到货说明」当时那条链会在这里红** ✓（反向钉住 ✓） |
| **AC-LANDING-4** | 标签打印那一屏**不许有 POST**（防"筛选参数被误存进表" ✗） |

**变异（实测）**：把某条链的落点列换成已删的 `acceptanceText` ⇒ **红** ✓（就是「到货说明」那种 ✗）；
还原 ⇒ 全绿 ✓。（⚠️ 另一处"去掉一个已登记提交"的变异**没生效**（我的替换没命中）⇒ **不宣称**那条的实测，
按构造它由 AC-LANDING-1 的差集保证 ✓）

### 5.5 🔎 T3 续：**样品补货**那条链的落点（2026-10-16 补核 · 只读）

四跳（都在代码里核过 ✓）：

| 跳 | 位置 | 事实 |
|---|---|---|
| ① 前端 | `features/orders/index.js`（`data-field="sample-fill-size"`）| `api.post(ORDERS_API.sampleFill)` `:1144`，提交 `{ detailRecordId, size, requestId }` ✓ |
| ②b 端点常量 | `public/workbench/config/orders.js:184` | `sampleFill: '/api/workbench/sales/sample-fill'` ✓ |
| ② 路由 | `src/routes/workbench.js:431` | `router.post('/sales/sample-fill', …)` 读 `req.body?.detailRecordId` / `?.size` / `?.requestId` ✓ |
| ③ 服务 | `src/services/salesFollowupService.js:349` `fillSample` → `src/services/sampleReplacementService.js`（`:161`/`:226`）| 调 `inventory.promoteToSample({ salesDetailRecordId, productRecordId, size }, { correlation })` ✓ |
| ④ 落点 | `src/services/inventoryService.js:1127` `promoteToSample` | **改 `实时库存`（`liveInventory`）那一行**（按 `fields.stockKey` 定位 ⇒ 状态 **门盒 ↔ 样品** 互换）＋ 记一条 **`库存流水`（`inventoryLedger`）**（走 `findLedger` + `resolveSamplePromotionBehavior` ✓）|

**等级 🔎（如实）**：**"改哪张表"已核**（`liveInventory` ＋ `inventoryLedger` ✓）；
**列名按 schema**（`liveInventory.state` =「所属状态」/ `inventoryLedger.quantityChange` =「变动数量」/`behavior` =「库存行为」✓）
—— ⚠️ 我**没有逐行看到**"写 `state` 那一行"（只核到它读该行 + 按 stockKey 定位 + 调行为）⇒ **不宣称 ✅** ✓
