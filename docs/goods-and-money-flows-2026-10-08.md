# 货流与资金流对照（2026-10-08）

> **本件只写这一份文档**：不改代码、不改其它 docs、不提交 git、不部署、不用飞书 CLI。
>
> **审计方法**：① 只读仓库源码（`server/src/**`、`server/test/**`、`server/src/config/**`）；
> ② 线上**只读**日志 `ssh … 'grep/cat'`（日志文件 `~/.pm2/logs/box2bitable-server-out.log`，
> 覆盖 **2026-05-31T15:50:17Z → 2026-10-08T09:55:29Z**；当前 PM2 日志文件全量 **39616** 行，
> 本件的所有计数都是对这个**全量文件** grep 出来的）。
>
> ⚠️ **证据边界（先说清，免得当成结论）**：
> - 本件里「**没写 / 没扣 / 线上没跑过**」这类结论，凡是我**只用日志**得到的，都**明确标注为
>   「线上日志 0 次 / 未出现」**——我**没有**被授权远程读飞书事实表，所以
>   **没有**核过「库存流水 / 实时库存 / 收款明细」的真表内容。
>   按项目纪律（`AGENTS.md` 第 17 条），这类只能算「**我还没查到这一步**」，
>   要定性必须再去事实表核一遍。
> - 本件里「**代码没有**」这类结论，证据是**源码里的调用方检索结果**（我实际 grep 过），
>   不是日志推断。
> - 线上日志里出现的 record_id / open_id 按原样保留（业务键，不是隐私字段）。

---

## §1 口径（业务负责人 2026-10-08 逐字，一字不改）

> **前提**：「库里的数据和实物数据**必须是一致且准确的**。」
> 「整体其实就是**两条线：货怎么转，资金怎么转**。」
>
> **一、售前与销售链路**
> 1. 货的判断逻辑：(a) **库存里有，就是现货（会影响库存）**；(b) **库存里没有，就是预定**（在二次结清时，会将**履约状态改为已交付**）
> 2. 资金维度（比较灵活，交易方式多，可按用户输入分批次）：
>     (a) **抖音团购券**：比较特殊，一般 **5 天后自然到账**；(b) **一次结清**：只在那一次影响收款；
>     (c) **分两批结清**：第二批需要**再次确认收款方式**，在**二次结清时会影响收款明细**
>
> **二、售后链路（退货、换货、赔付）**
> 1. **退货**：(a) 货流：实物肯定要退回，**库存相应增加**；(b) 资金流：**直接退给用户**，或者**留在平台账户存着**
> 2. **换货**：(a) 货流：可能换**同货号不同尺码**，也可能直接**换不同型号**；(b) 资金流：**若无差价则金额不变；有差价则补差价或退还多余金额**

---

## §2 货流矩阵

**表键 → 生产表名**（全部取自 `server/src/config/v1BitableSchema.js`）：
`salesEntry`=销售主表 · `salesDetail`=销售明细 · `inventoryLedger`=库存流水 ·
`liveInventory`=实时库存 · `paymentRecord`=收款明细 · `behavior`=行为管理 ·
`purchaseReport`=信息填写 · `purchaseRequest`=报货信息 · `purchaseOrderBatch`=报货批次。

**库存方向的唯一注册表** = `server/src/services/inventoryService.js:128` 的 `STOCK_MOVEMENTS`
（本件所有「增加 / 减少」都从那里取，不在调用点判断）。

| # | 场景 | 库存怎么变 | 履约状态怎么变 | 写哪些表 / 字段（语义键，非物理列名） |
| --- | --- | --- | --- | --- |
| 1 | **现货销售**（库存里有） | 录单确认那一刻**当场扣**：行为 `STOCK_SALE_DECREASE`（方向=减少，`consumes:['门盒','样品']`）<br>`inventoryService.js:129-137` | 明细行**建行时就是「已交付」**：`salesMovements.js:35`（`SALE_CASH.delivery='已交付'`）+ `salesDeliveryService.js:93` 再把 `fulfillmentStatus` 写成「已交付」 | `salesEntry`（`tradeType`+四个状态维度）· `salesDetail`（`fulfillmentStatus`=已交付、`actualAmount`、`tradeType` 单选）· `inventoryLedger`（`salesDetail` 关联、变动数量）· `liveInventory`（消耗门盒/样品各一行）· `paymentRecord`<br>调用点：`larkMvpService.js:2476`（`shouldDeliverFor`）→ `:2555-2562`（`delivery.deliver`）→ `salesDeliveryService.js:89-93` |
| 2 | **预定**（库存里没有） | **不动库存**（一行流水都不写）：`salesMovements.js:36`（`SALE_PREPAID.delivery='未交付'`）⇒ `deliversForTradeType` 返回 false，该行不进交付清单（`larkMvpService.js:2481`） | 明细行**建行即「未交付」**：`salesOrderService.js:132`（`kind.requiresFulfillment ? '未交付' : '已交付'`） | 只有 `salesEntry` + `salesDetail`（履约状态=未交付）；**没有**库存三张表的写入 |
| 3 | **二次结清（交付）** | 此时**才扣**：只把**未交付**的明细交给交付服务 → `STOCK_SALE_DECREASE` 减少（门盒优先、不够吃样品）<br>`secondDeliveryService.js:132-134` → `:167-170`（`delivery.deliver`）→ `salesDeliveryService.js:89-92` | 明细行 `未交付` → **`已交付`**：`salesDeliveryService.js:93`（`update('salesDetail', …, { fulfillmentStatus: '已交付' })`） | `salesDetail.fulfillmentStatus` · `inventoryLedger` · `liveInventory` · `salesEntry.stock`（库存状态：已扣减/部分扣减/扣减失败，`salesDeliveryService.js:108-118`）· `paymentRecord`（若同时补收款） |
| 4 | **销售退货** | **增加**：行为 `SALE_RETURN`（方向=增加，`consumes:null` ⇒ **只新增**「实时库存」一行，不消耗既有行）<br>`config/afterSales.js:105-112`（movements: `state:'restockState'`）· `inventoryService.js:183-188` | **原**明细行 → **`已退货`**：`config/afterSales.js:106`（`originalFulfillmentStatus`）+ `afterSalesService.js:645-657`（`markOriginalDetails`）<br>**新建的复制明细行**：履约状态**刻意不写**（`afterSalesService.js:600-601`，只有换货声明了 `newLineFulfillmentStatus`） | `salesEntry`（**新建**一条售后主表，`tradeType`=销售退货、沿用原单号、原主表**一字不动**）· `salesDetail`（新建复制行：`salesEntry`=**原主表**、`actualAmount`=原值正数、`tradeType`=销售退货）· **原** `salesDetail.fulfillmentStatus`=已退货 · `inventoryLedger` + `liveInventory`（回 `门盒` 或 `样品`，取值 `config/afterSales.js:232`） |
| 5 | **换货（同货号不同尺码）** | **两条方向相反的流水**：旧鞋 `SALE_RETURN` **+1**（回 `restockState`）＋ 新鞋 `SALE_CASH` **−1**（从 `门盒`）<br>`config/afterSales.js:113-128`（movements 两条）· `afterSalesService.js:771-807`（逐条 `applyChange`） | **原**那双 → **`已换货`**（`config/afterSales.js:116`）；**新明细行 → `已交付`**（2026-10-08 新增，`config/afterSales.js:118-121` + `afterSalesService.js:539-542`、`:592-602`） | 售后 `salesEntry`（`tradeType`=换货）· 新建 `salesDetail`（新货品/新尺码、`fulfillmentStatus`=已交付）· 原 `salesDetail.fulfillmentStatus`=已换货 · `inventoryLedger` 两行 · `liveInventory` +1 / −1 |
| 6 | **换货（不同型号）** | 与 #5 **同一段库存代码**：差别只在「新的一双」的 `productId` 来自 `new_item_no` 解析结果<br>`afterSalesFlowService.js:426-498`（`resolveOutgoing`） | 同 #5 | 同 #5；`newLines[].productId` = 新货号的货品记录 id、`sizeId` = 新尺码记录 id<br>⚠️ **新货号必须已在「货品信息」里存在**，否则 `afterSalesFlowService.js:456-461` 回问一句、**不写任何表**（不自动建档） |
| 7 | **赔付** | **只出货、坏鞋不回库**：行为 `SALE_COMPENSATION`（方向=减少，`consumes:['门盒']`）<br>`config/afterSales.js:129-142` · `inventoryService.js:192-197` | **原**那双 → **`已赔货`**；出货那一行**不写**履约状态（哨兵：`test/afterSalesService.test.js:713-731`） | 售后 `salesEntry`（`tradeType`=赔货）· 新建 `salesDetail`（出货商品、不写履约状态）· 原 `salesDetail.fulfillmentStatus`=已赔货 · `inventoryLedger` 一行 · `liveInventory` −1（门盒） |
| 8 | **采购到货入库** | **增加**：行为 `STOCK_PURCHASE_INCREASE`（方向=增加）<br>`inventoryService.js:138-161` · `purchaseWebhookService.js:3636-3647`（逐条 `inventory.applyPurchase`） | 不涉及销售明细履约状态 | `inventoryLedger`（`ledgerLink`=**报货批次**那一行，`inventoryService.js:154-158`）· `liveInventory`（入库状态：无样品→样品，有样品→门盒，`purchaseWebhookService.js:3625`）· `purchaseOrderBatch`（`arrivalStatus`=已到货、`acceptanceText`=验收原话、`confirmStatus`=已确认，`purchaseWebhookService.js:3714-3735`）<br>⚠️ **不写任何入库明细行**（「采购入库」表已整表删除）；`purchaseReport`/`purchaseRequest` 的到货列**不动** |
| 9 | **采购退货** | **减少**：行为 `STOCK_PURCHASE_DECREASE`（方向=减少，**状态无关**：`consumes:['门盒','样品','仓库']`）<br>`inventoryService.js:175-180` · `purchaseWebhookService.js:2660-2672` | 不涉及销售明细 | `purchaseRequest`（每个尺码一行退货单：`behavior`/`product`/`size`/`quantity`/`idempotencyKey`，`purchaseWebhookService.js:2638-2653`）· `inventoryLedger` + `liveInventory`（逐尺码 −N）· `purchaseReport.status`=已生成申请 + `request`=退货单（`purchaseWebhookService.js:2684-2689`）· `purchaseOrderBatch`（只写批次号 + 幂等键，`ensureReturnBatchRecord` `:2719`） |

---

## §3 资金流矩阵

**钱的唯一写入口** = `server/src/services/paymentService.js`（销售 / 售后）＋
`server/src/services/afterSalesService.js:687-732`（售后，写的是**同一张** `收款明细`）。
**状态取值**（`paymentService.js:42`）：`已收款` / `未收款` / `待平台结算`；
**「交易方向」**（`paymentService.js:20`）：`收入` / `退回`，**只在真到账那一刻写**
（`paymentService.js:18-19`、`:54-55`）。

| # | 场景 | 收款明细怎么写 | 状态怎么变 | 金额口径 |
| --- | --- | --- | --- | --- |
| 1 | **一次结清** | **新建一条**：`salesEntry`=本单 · `method`=她说的方式 · `amount`=本次收款 · `receivedAt`=服务端当前时间 · `tradeDirection`=**收入**<br>`paymentService.record` `paymentService.js:37-57` | `status` = **`已收款`**（`paymentService.js:39` 默认） | 金额**只认她说的那个数**（`paymentService.js:6-12`：必须 > 0、最多两位小数）；`paidCents > totalCents` 当场拦（`salesOrderService.js:155`）。**不拿「成交 − 已收」倒推**一笔收款 |
| 2 | **分两批（首付）** | 首付按她说的方式各写一条 `已收款`（可多笔、可不同方式：`salesOrderService.js:147-149`、`:239-243`） | 首付那些行：`已收款` + 方向=收入 | 首付=她说的数；**只有她明说欠多少**，后端才补一条**「未收款」占位**：`salesOrderService.js:226-238`（`owedCents > 0` 才建，且必须与「成交−已收」对得上，否则抛错 `:233-236`） |
| 3 | **分两批（尾款 / 二次结清）** | **更新那条已有的「未收款」行**（不是新建）：`status` `未收款`→`已收款` · 补 `method`=**她这次说的方式** · 补 `receivedAt`=点击那一刻 · 补 `tradeDirection`=收入<br>`paymentService.collectPendingReceipt` `paymentService.js:59-80` | `未收款` → **`已收款`**；方向**到账这一刻才补**（`paymentService.js:77-78`） | `amount` **必须等于那条占位记录的金额**（`paymentService.js:67-69`，不等就抛）；占位金额 = 建单时的 `outstandingCents = 成交 − 已收`（`salesOrderService.js:226`、`:237-238`） |
| 4 | **抖音团购券** | 券的部分**单独一条**：`method`=**抖音团购券** · `amount`=**平台结算款**（不是售价、不是面值）· `status`=**`待平台结算`**<br>`groupBuyVoucherPolicy.js:93-100` · 券的三个数（售价/面值/平台结算款）读「团购券管理」表：`config/groupBuyVouchers.js:1-20` | 落库时 = **`待平台结算`**；**`receivedAt` 留空、`tradeDirection` 留空**（`paymentService.js:18-19`、`:43`、`:53-55`）——「钱还没到，方向还没发生」 | 该券**应结**的金额 = `voucher.settlementAmount`（表里维护）；她另外补的现金按 #1 各写一条。校验：现金 + 平台结算款 = 成交额，或 现金 + 面值 = 成交额（`groupBuyVoucherPolicy.js:81-91`） |
| 5 | **抖音团购券（5 天后到账 / 结清）** | 代码里有一个**专用结清方法**：`paymentService.settlePlatformReceipt`（`paymentService.js:82-96`）→ `status` 改 `已收款` + 补 `receivedAt` + 补方向=收入 | `待平台结算` → `已收款` | 金额不变（沿用那条记录上的 `amount`）。⚠️ **没有 5 天的口径实现**、**没有定时任务**、**没有生产调用方**——详见 §4-C |
| 6 | **退款（退现金 / 退微信 / 退支付宝）** | **新建一条**：`salesEntry`=**售后那张新主表**（不是原单）· `method`=**她实际说的方式**（她没说才沿用原单，`afterSalesService.js:693-699`）· `amount`=**正数** · `tradeDirection`=**退回**<br>`afterSalesService.settleCash` `afterSalesService.js:687-732` | `status` = `已收款`（`config/afterSales.js:234`，退款在业务上也用「已结清」同一口径） | `amount = Math.abs(差价)`（`afterSalesService.js:689`）；**退货**的差价默认 = `−原明细成交金额`（`afterSalesFlowService.js:335-336`）⇒ 退原价；原明细没有成交金额且她没说退多少 → 回问、**不猜**（`:340-344`） |
| 7 | **退款（留在平台账户「已留存」/ 预存）** | ⛔ **没有落点**：唯一的落点「客户往来货款」表已被整表删除 ⇒ `afterSalesService.js:765-767` 在**任何写入之前**大声失败（`PREPAID_UNAVAILABLE` `:78-81`） | 不写任何记录 | 不适用（**刻意不静默改写成「收款明细」**——那等于把「钱留在这里」记成「退给客户」，是记错账，`afterSalesService.js:751-754`） |
| 8 | **换货补差价** | 与 #6 同一条腿，只是方向反了：`tradeDirection`=**收入**（`afterSalesService.js:690-692`） | `已收款` | 差价 = **新鞋成交金额 − 原明细成交金额**（`afterSalesFlowService.js:338`）；她明说就按她说的（`parsed.diff_amount`，`:331`） |
| 9 | **换货退还多余** | 与 #6 完全相同：`tradeDirection`=**退回** | `已收款` | 差价 = 新 − 原 为**负数** ⇒ 退 `Math.abs(差价)` |
| 10 | **换货无差价** | **一笔都不写**（`movesMoney=false`：`afterSalesService.js:222`、`afterSalesFlowService.js:352-353`） | 不变 | 差价 = 0 ⇒ 金额不变、不动钱；测试钉住：`test/afterSalesService.test.js:788` |
| 11 | **赔付** | 只在**差价 ≠ 0 且她说了钱怎么走**时才写（走 #6 那条腿） | 有差价 → `已收款`（收入/退回） | 执行器口径是「**赔货不动钱**」（`test/afterSalesService.test.js:640`：`diffAmount:null` 时 `paymentRecord` 0 条）；⚠️ 但**流程层**会把差价算成「新鞋价 − 原价」并在她没说钱怎么走时拦住这一笔——见 §4-E6 |

**资金维度与货维度的解耦**（写进代码的口径）：交易类型（现货/预定）**只**决定交付，
支付方式（现金/微信/支付宝/工商银行/抖音团购券）**只**决定到账；
所以**团购券不是一种交易类型**（`config/salesMovements.js:19-27`）。

---

## §4 ⭐ 对照现有代码（三态 + `文件:行` 证据）

**三态定义**：**已实现** = 有 service 函数实现 + 有测试断言；
**部分实现（缺什么）** = 主链路在，但有明确的缺口；
**未实现** = 在 `server/src` 里找不到实现（写「未找到」= 我按关键字 / 调用方检索过，0 命中）。

### A. 换货（业务负责人重点怀疑 #1）

| 条目 | 三态 | 证据 |
| --- | --- | --- |
| **A1 同货号不同尺码**：旧鞋回库（+1）＋ 新鞋出门盒（−1） | **已实现** | 配置：`server/src/config/afterSales.js:113-128`（`EXCHANGE.movements` 两条：`SALE_RETURN`/`SALE_CASH`）<br>service：`server/src/services/afterSalesService.js:771-807`（`applyStock` 逐条 `inventory.applyChange`）、`:503-548`（`buildPlan`）<br>引擎：`server/src/services/inventoryService.js:183-188`（增加）、`:199-206`（减少）<br>测试：`server/test/afterSalesService.test.js:590`（「换货：旧鞋回库 + 新鞋出门盒，两条流水方向相反」）、`:248`（真实 InventoryService 接线）<br>线上：`after_sales.executed` 1 条（`2026-10-07T16:03:38Z`，`action:"exchange"`，`stock_rows:["SALE_RETURN:门盒:1","SALE_CASH:门盒:1"]`） |
| **A2 换不同型号** | **部分实现（缺：新货号不存在时不会自动建档）** | service：`server/src/services/afterSalesFlowService.js:426-498`（`resolveOutgoing`：`new_item_no` / `new_color` / `new_size` / `new_amount`）<br>缺口：`afterSalesFlowService.js:456-461`——`resolveProduct` 找不到就回一句「找不到这个货品」并 `return {ok:false}`，**不建新品、不写任何表**<br>测试：`server/test/afterSalesFlow.test.js:1252`（换另一双）、`:1201`（同款换码）、`:947`（缺信息就追问） |
| **A3 差价：补差价 / 退还多余** | **已实现** | 差价算法：`afterSalesFlowService.js:331-339`（`新 − 原`，她明说就用她说的）<br>资金腿：`afterSalesService.js:687-732`（`settleCash`：`direction = diffAmount > 0 ? '收入' : '退回'`）、`:689`（`amount = Math.abs(diffAmount)`）<br>方向配置：`config/afterSales.js:79-82`（`AFTER_SALES_MONEY_DIRECTIONS`）<br>测试：`server/test/afterSalesService.test.js:449`（说了现金就写现金）、`server/test/afterSalesFlow.test.js:736`（差价 70 → 卡片写「收现金」） |
| **A4 无差价 → 金额不变** | **已实现** | `afterSalesService.js:222`（`movesMoney`）、`afterSalesFlowService.js:352-353`；测试 `server/test/afterSalesService.test.js:788`、`server/test/afterSalesFlow.test.js:686`（卡片写「不动钱」） |
| **A5 新换出去那行的履约状态 = 已交付** | **已实现**（2026-10-08 补上） | 配置：`config/afterSales.js:118-121`（`newLineFulfillmentStatus`）<br>service：`afterSalesService.js:539-542`、`:592-602`<br>测试：`server/test/afterSalesService.test.js:694`、`:713`（哨兵：退货/赔货仍不写）、`:733`（配置先行）<br>归档：`docs/after-sales-exchange-new-line-fulfillment-2026-10-08.md` |

### B. 退货（销售 + 采购；业务负责人重点怀疑 #2）

| 条目 | 三态 | 证据 |
| --- | --- | --- |
| **B1 销售退货 货流：库存增加** | **已实现**（⚠️ 但线上日志（2026-05-31 起全量）里**从未跑过**，见本行 ⚠️） | 配置：`config/afterSales.js:105-112`（`RETURN.movements`：`state:'restockState'`）<br>引擎：`inventoryService.js:183-188`（`SALE_RETURN`：`direction:'增加'`、`consumes:null` ⇒ 只新增一行）<br>service：`afterSalesService.js:771-807`；回哪去只能 `门盒`/`样品`（`config/afterSales.js:232`），她没说默认门盒（`afterSalesFlowService.js:314-317`）<br>测试：`server/test/afterSalesService.test.js:274`、`:830`（两种状态都按她说的落库）<br>⚠️ **线上日志（2026-05-31 起全量）：`after_sales.executed` 只有 1 条，且 `action` 是 `exchange` ⇒ 销售退货在生产上 0 次**（我只核了日志，**没核事实表**） |
| **B2 销售退货 资金：直接退给用户** | **已实现** | `afterSalesFlowService.js:335-336`（退货差价默认 = `−原成交金额`）、`:340-344`（没有成交金额且她没说 → 回问）<br>`afterSalesService.js:687-732`（新建 `收款明细`，`tradeDirection='退回'`）<br>`afterSalesService.js:693-699`（交易方式=**她说的那个**；她没说才沿用原单）<br>测试：`server/test/afterSalesService.test.js:274`（六处写入各一次）、`:449`、`:462` |
| **B3 退货 资金：留在平台账户存着（「已留存」）** | **未实现**（落点表被整表删除后下线） | `afterSalesService.js:765-767`（`assertPrepaidAvailable` 当场抛）、`:78-81`（`PREPAID_UNAVAILABLE` 文案）、`:327`（在 `run()` 校验阶段调用 ⇒ **任何写入之前**就停）<br>契约：`server/src/config/v1BitableSchema.js:232-249`（「客户往来货款」整段删除，表 id `tblm86T60yAHD6pR` 不存在）<br>测试：`server/test/afterSalesService.test.js:572`、`:800` |
| **B4 采购退货 货流：库存减少** | **已实现** | 引擎：`inventoryService.js:175-180`（`STOCK_PURCHASE_DECREASE`：减少，`consumes:['门盒','样品','仓库']`，状态无关）<br>service：`server/src/services/purchaseWebhookService.js:2660-2672`（逐尺码 `applyChange`）、`:2530-2608`（`prepareSupplierReturn`）、`:2621-2705`（`applySupplierReturn`）<br>测试：`server/test/purchaseReturn.test.js`、`server/test/purchaseReturnBatch.test.js`、`server/test/purchaseReturnUnifiedParsing.test.js`、`server/test/purchaseReturnBatchRow.test.js`<br>线上：`purchase.return.posted` **6** 条、`purchase.return.stock_applied` **36** 条 ⇒ 这条链路**真跑过** |
| **B5 采购退货 资金** | **未实现（未找到）** | 检索：`grep -n "paymentRecord\|customerCredit\|往来" server/src/services/purchaseWebhookService.js` ⇒ **0 命中**；`applySupplierReturn`（`:2621-2705`）只写 `purchaseRequest` + 库存 + `purchaseReport.status`，**没有任何资金侧写入**；`server/test/purchaseReturn*.test.js` 里也没有资金断言<br>⚠️ 业务口径（§1）只说了销售侧退货的资金，**没规定采购退货的钱怎么记** ⇒ 这条更像「口径未定义」而不是「漏写」，但事实是**代码里没有** |

### C. 抖音团购券 / 待平台结算（业务负责人重点怀疑 #3）

| 条目 | 三态 | 证据 |
| --- | --- | --- |
| **C1 券落成「待平台结算」+ 金额=平台结算款** | **已实现** | 策略：`server/src/services/groupBuyVoucherPolicy.js:93-100`（`payments: […, { method:'抖音团购券', amount: voucher.settlementAmount, status:'待平台结算' }]`）<br>券目录（售价/面值/平台结算款）读表：`server/src/config/groupBuyVouchers.js:1-20`；状态常量：`server/src/config/salesCardFacts.js:35`（`PENDING_SETTLEMENT_STATUS = '待平台结算'`）<br>写库：`paymentService.js:42`（值域）、`:43`（待平台结算不能写收款时间）、`:53-55`（**不写方向**）<br>测试：`server/test/doubaoSalesParser.test.js:242`、`:262`、`:431`；`server/test/salesMvp.test.js:223-226`（`收款状态` 落表 = `待平台结算`） |
| **C2 「一般 5 天后自然到账」** | **未实现（未找到）** | 检索：`grep -rn "5\s*天\|五天后\|结算日\|settleAfterDays\|天到账" server/src` ⇒ 唯一相关的「5 天」是**查单窗口**（`server/src/config/saleLookup.js:4`、`server/src/services/saleLookupService.js:50`），**与团购券无关**；券的配置只有 `groupBuyVouchers.js` 三个数（售价/面值/平台结算款），**没有账期/天数**<br>没有任何定时任务：`server/src/app.js:133-138` 只启动了**一个** scheduler（`pendingDealPush`）；全仓没有任何「到期把待平台结算改已收款」的 job<br>测试：`server/test/groupBuyVouchers.test.js` 全文只测**券目录匹配**（3 条），**没有**任何到账/结清断言 |
| **C3 「待平台结算 → 已收款」的结清入口** | **部分实现（缺：生产入口）** | 实现**在**：`paymentService.js:82-96`（`settlePlatformReceipt`：`status`→`已收款`、补 `receivedAt`、补方向=收入）<br>缺口：调用方**只有测试**——`grep -rn "settlePlatformReceipt" server/src server/test server/scripts` 只有 3 处：定义 `paymentService.js:82` + 测试 `server/test/secondDeliveryService.test.js:279`、`server/test/salesMvp.test.js:228`；**没有**任何 route / 工作台接口 / 卡片动作调用它（`server/src/routes/workbench.js:81-112` 只有 `addPayment` 与 `deliveries`）<br>⇒ 一条券单落成 `待平台结算` 之后，**代码里没有任何入口能让它变成「已收款」**<br>线上日志：`待平台结算` 与 `抖音团购券` 各只出现 **1** 次（同一条 `2026-09-27T08:18:15Z` 的 `sales.ai.normalized`），**没有任何一条结清/到账事件**（该方法本身也不打日志 ⇒ 连"调用过没成功"都看不出来） |

### D. 二次交付（二次结清）（业务负责人重点怀疑 #4）

| 条目 | 三态 | 证据 |
| --- | --- | --- |
| **D1 预定 → 二次结清时「未交付 → 已交付」+ 扣库存** | **已实现** | service：`server/src/services/secondDeliveryService.js:132-134`（只挑未交付明细）、`:167-170`（`delivery.deliver`）<br>交付与扣库存：`server/src/services/salesDeliveryService.js:89-93`（`inventory.applySale` + `fulfillmentStatus='已交付'`）<br>测试：`server/test/secondDeliveryService.test.js:155`（预定单点「成交」：补收款 + 未交付转已交付 + 扣库存）、`:101`（现货待收：只补收款、库存一个字不动）<br>线上：`sales.second_delivery.completed` **4** 条 |
| **D2 第二批要「再次确认收款方式」** | **已实现** | 卡片：`server/src/utils/larkCards.js:1128-1140`（**每个收款方式一个按钮**：`methods.length===1 ? '成交' : \`成交·${method}\``，方式写进 `button.value.method`）<br>接线：`server/src/services/larkMvpService.js:2061-2073`（`method: value?.method`）→ `secondDeliveryService.js:149-161`（`method` 缺了**当场报错**，不替她猜）<br>文字那条路（她说「已完毕」）：`server/src/services/salesThreadProgressService.js:600-632`（没说方式 → **先把货那一半做掉**、再回问一句，任务状态记 `asking` 而不是 `applied`，`:246-251`）<br>测试：`server/test/secondDeliveryService.test.js:463`（只配一种方式时按钮就叫「成交」）、`:505`（没配方式就不推、也不猜一个方式写账）、`:847`（卡片动作带 `method`） |
| **D3 二次结清「影响收款明细」** | **部分实现（缺：没有「未收款」占位时，只交货不记账）** | 现有实现：`secondDeliveryService.js:128-129`（**只找 `未收款`**）→ `:152-161`（逐条 `collectPendingReceipt`：`未收款`→`已收款` + 补方式/时间/方向）<br>**占位只在她说欠款时才建**：`server/src/services/salesOrderService.js:226-238`（`owedCents > 0` 才补 `{amount: outstandingCents/100, status:'未收款'}`）<br>⇒ 缺口：**预定 + 首付 且她没说欠多少** ⇒ 首录不产生「未收款」⇒ `pending.length === 0` 而 `undeliveredIds.length > 0` ⇒ `secondDeliveryService.js:137` 的判断不成立、`:167-170` 照常**交付**，`collectedAmount = 0`，**一分钱都不记**<br>⇒ 且这一单**永远到不了「已完成」**：`server/src/services/salesProgressService.js:55`（`orderStatus` 要求 `paidCents === amountCents`）⇒ 它会**长期挂在待处理清单里**（`secondDeliveryService.js:378`）<br>测试缺口：`server/test/secondDeliveryService.test.js` 里所有预定用例都**带**「未收款」记录（`:155-211`），**没有**「无占位 + 有未交付」的用例<br>线上形状：4 条 `sales.second_delivery.completed` 里 **3 条** `method:""`、`collected_payment_ids:[]`、`collected_amount:0`，而 `delivered_detail_ids` **有值**、`fulfillment_status:"已交付"`（`2026-10-07T16:43:52Z`、`2026-10-07T17:22:03Z`、`2026-10-08T06:31:28Z`）<br>⚠️ **不能据此下结论**：这 3 条也完全可能是「首录已全款」（那就**完全正确**）。要区分必须核那 3 张单的**收款明细事实**——我**没有被授权远程读表**，只核了日志 ⇒ 按纪律这里只能说「**我还没查到这一步**」 |

### E. 其余条目（同一套三态口径）

| 条目 | 三态 | 证据 |
| --- | --- | --- |
| **E1 现货/预定的判据 = 实时库存里有没有这一双** | **已实现** | 唯一判据：`server/src/config/salesTradeTypePolicy.js:16`、`:47`、`:60-61`（`salesTradeTypeForStock({ inStock })`）<br>类型→交付：`config/salesMovements.js:34-36`、`:73`（`deliversForTradeType`）<br>测试：`server/test/salesTypeByStockGuard.test.js`、`server/test/salesTradeTypePolicy.test.js`、`server/test/salesStatusDimensions.test.js` |
| **E2 现货：录单即交付 + 扣库存** | **已实现** | `larkMvpService.js:2476`（`shouldDeliverFor`）、`:2481`（`deliverableItemIndexesOfDraft`）、`:2555-2562`（`deliver`）<br>扣库存：`salesDeliveryService.js:89-92` → `inventoryService.js:129-137`（减少，门盒→样品）<br>测试：`server/test/salesMvp.test.js`、`server/test/secondDeliveryService.test.js:101` |
| **E3 预定：录单不扣库存** | **已实现** | `salesOrderService.js:132`（建行即「未交付」）；`salesMovements.js:73` 让预定行不进交付清单<br>测试：`server/test/salesMultiLineTradeType.test.js`、`server/test/salesFundTypeDecoupling.test.js` |
| **E4 一次结清** | **已实现** | `paymentService.js:37-57`；测试 `server/test/secondDeliveryService.test.js:247-270`（`未收款` 不写方向；变 `已收款` 那一刻才写「收入」） |
| **E5 售后不写原主表 / 只改原明细履约状态** | **已实现** | `afterSalesService.js:349-352`（显式注释）、`:645-661`（只改 `fulfillmentStatus`）、`:454-473`（新建售后主表）<br>测试：`server/test/afterSalesService.test.js:274`、`:377`、`:395`（逐字段比对原主表未变） |
| **E6 赔付的资金口径** | **部分实现（缺：流程层与「不动钱」口径不一致）** | 执行器 / 配置口径 = **不动钱**：`server/test/afterSalesService.test.js:640`（`diffAmount:null` ⇒ `paymentRecord` 0 条）；`config/afterSalesFlow.js:52-53`（注释：「赔货不回库、**不动钱**」）<br>缺口：**流程层**对她没明说差价时**一律**按「新鞋价 − 原价」算（`afterSalesFlowService.js:331-339`，注释自己写着「退货 = 原价退回（负）；换货/**赔货** = 新鞋价 - 原价」），差价 ≠ 0 而又没说钱怎么走 ⇒ 直接抛错拦住：`afterSalesFlowService.js:589-595`、测试 `server/test/afterSalesFlow.test.js:714-734`（`t_comp_unparsed` 赔货那条被拦）<br>⇒ 现象：**赔货只要新鞋价 ≠ 原价、她没提钱，这一笔就执行不了**（业务表零写入、不出卡片——不产生错账，但业务上「赔货不该需要她说钱怎么走」） |
| **E7 采购到货入库（加库存 + 落点搬到报货批次）** | **已实现** | `purchaseWebhookService.js:3636-3647`（逐条 `applyPurchase`）、`:3714-3735`（`writeArrivalAcceptance`：`acceptanceText` / `confirmStatus` / `actualQuantity` / `actualAmount`）<br>引擎：`inventoryService.js:138-161`（增加）<br>契约：`v1BitableSchema.js:346-400`（`purchaseOrderBatch`）+ `server/src/config/purchaseAcceptance.js:21-42`（`已确认`）<br>测试：`server/test/arrivalConversation.test.js`、`server/test/arrivalLandingOnBatch.test.js`、`server/test/purchaseLedgerBatchLink.test.js` |
| **E8 「退过/换过/赔过」的单不进待处理清单** | **已实现** | 判据唯一来源：`server/src/config/afterSales.js:68-76`（`AFTER_SALES_FULFILLMENT_EXCLUDED` + `isAfterSalesFulfillment`）<br>唯一判定点：`secondDeliveryService.js:358-370`<br>测试：`server/test/pendingDealPushExclusion.test.js`、`server/test/pendingPushCandidateCaliber.test.js` |
| **E9 售后的远端幂等键（`业务事件ID`）** | **未实现**（随「客户往来货款」表一起下线） | `server/src/config/afterSales.js:183-186`（注释里那个常量 `AFTER_SALES_CREDIT_KEY_FIELD` 已删）<br>`v1SchemaScopes.js:52`（幂等键清单里不再有这张表）<br>现状：只剩本地闸门 `afterSalesService.js:266-313`（`runWithGate`）——**已知窗口**：飞书 create 成功但本地落盘失败时会重复写（`afterSalesService.js:45-47` 自述） |
| **E10 售后的收款明细状态口径** | **已实现** | `config/afterSales.js:234`（`cashPaymentStatus: '已收款'`）；`afterSalesService.js:710-719` |

---

## §5 缺口清单 + 建议优先级

**排序依据**：按业务负责人的**前提**——「库里的数据和实物数据**必须是一致且准确的**」。
⇒ **第一档：会让库存或账不一致**（最危险，因为它**不报错**，人要过很久才发现）；
**第二档：不会写错账，但业务走不通 / 要人工绕**；
**第三档：体验与可排查性**。

### 🔴 第一档：会让库存 / 账不一致（最高优先）

| # | 缺口 | 为什么会不一致 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **G1** | **二次结清（预定）在「没有未收款占位」时，会交货但一分钱不记账** | 「能不能交付」**只**看货那一维（`undeliveredIds`），**没有**「钱结清了没有」这道闸门；而「未收款」占位**只有她明说欠多少**才建 ⇒ 预定 + 首付 + 她没说欠款 = **货出去了、钱没落表**，且这一单永远到不了「已完成」、长期挂在待处理清单里 | 代码：`secondDeliveryService.js:128-138`（只按 `未收款` 判）、`:167-170`（照常交付）；占位条件 `salesOrderService.js:226-238`；`pendingAmount` **算了但不校验**（`secondDeliveryService.js:400` 只用于显示）；`salesProgressService.js:55`（`已完成` 要求 `paidCents===amountCents`）<br>测试缺口：`test/secondDeliveryService.test.js` 无此用例<br>线上形状：4 条 `sales.second_delivery.completed` 中 3 条 `collected_amount:0` + `delivered_detail_ids` 有值（**待核事实表才能定性**） | ① 在 `_confirm` 里加**交付前置判据**：`progress.pendingAmount > 0` 且没有 `未收款` 占位 ⇒ **不交付**，回一句「这一单还欠 X，先说收款方式」（与 `completeDealFromCard` `salesThreadProgressService.js:539-557` 的"先做货"闸门**方向相反**，要显式区分两种场景）；② 录单时若「成交 − 已收 > 0」就**总是**落一条「未收款」占位（现在只在她说欠款时落）——②更根治，但要她确认「她没说欠=不欠」这条既有口径是否还要保留 |
| **G2** | **抖音团购券的「待平台结算」没有任何生产入口能结清** | 券单落成 `待平台结算` 后，钱在账上**永远停在"没到账"**；「已收多少」永远差这一笔 ⇒ `收款明细` 与真实到账不一致、券单永远不算「已完成」 | `paymentService.js:82-96`（实现只在测试里被调：`test/secondDeliveryService.test.js:279`、`test/salesMvp.test.js:228`；`src/routes/**`、卡片动作、scheduler 全无调用）；线上日志 `待平台结算` 仅 1 次且无结清事件 | 加**一个入口**（工作台一个「券已到账」按钮，或让卡片动作接收）——**不需要** 5 天自动逻辑就能先止血；方法本身已经写好且幂等（`:90` 已是 `已收款` 就直接返回） |
| **G3** | **「5 天后自然到账」完全没实现** | 即便有了入口，没人会在第 5 天去点它 ⇒ 上面 G2 会**长期**存在；而且「5 天」这个口径**不在配置里**，谁都改不了 | `config/groupBuyVouchers.js` 只有三个金额，**没有账期**；`app.js:133-138` 只有 `pendingDealPush` 一个 scheduler；全仓无「到账/结算日」实现（`grep` 命中的「5 天」是查单窗口） | 把「5 天」做成配置（`GROUP_BUY_VOUCHER_SETTLE_DAYS`，默认 5），加一个**按天**的 job：到期的 `待平台结算` → 调现成的 `settlePlatformReceipt`；⚠️ 天数的起算点（下单日？券核销日？）**必须请她先定**，别自己猜 |
| **G4** | **采购退货没有任何资金侧记录** | 货退给供应商了（库存 −N，线上跑过 6 批），但**"供应商该退我们多少钱"一个字都没有** ⇒ 采购账与实物脱节 | `purchaseWebhookService.js:2621-2705`（只写 `purchaseRequest` + 库存 + `purchaseReport.status`）；`grep "paymentRecord\|customerCredit\|往来" src/services/purchaseWebhookService.js` ⇒ 0 命中；`test/purchaseReturn*.test.js` 无资金断言 | **先请她定口径**（采购退货的钱记哪张表、记什么）——业务口径（§1）只规定了销售侧退货的资金，这块属**口径空白**，不是单纯漏写 |

### 🟡 第二档：不会写错账，但业务走不通 / 要人工绕

| # | 缺口 | 表现 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **G5** | **退货「留在平台账户存着 / 已留存」没有落点** | 她说「钱先存着」→ 这一笔**在任何写入之前大声失败**（不写一半、不出错账），但业务做不下去 | `afterSalesService.js:765-767`、`:78-81`、`:327`；`v1BitableSchema.js:232-249`（表已整表删除） | 等她把「已留存」的新落点定下来（哪张表 / 哪些列），按 `v1BitableSchema.js:242-245` 那三步接回（本地也留了实现清单 `afterSalesService.js:758-763`） |
| **G6** | **赔货会被「要补差价」拦住** | 赔一双不同价的新鞋、她没提钱 ⇒ 抛「没解析出这次的钱怎么走」，业务表零写入、不出卡片（**不产生错账**，但要重说一遍） | `afterSalesFlowService.js:331-339`（赔货也按「新 − 原」算差价）、`:589-595`（拦住）；测试 `test/afterSalesFlow.test.js:714-734`（赔货分支）；口径冲突：`config/afterSalesFlow.js:52-53`「赔货不动钱」 | 赔货**强制差价 = 0**（或强制 `settlement` 不受差价影响），与执行器口径对齐；改一处 config 即可，`afterSalesService.js:222` 已支持「不动钱」 |
| **G7** | **换不同型号时新货号不存在 ⇒ 换不了** | 只能回一句「找不到这个货品」，不会建档；她得先去建品再重说一次 | `afterSalesFlowService.js:456-461` | 复用采购到货的建档能力（`purchaseWebhookService.ensureArrivalProduct` `:2963`）——但要她确认「换货时自动建档」是否符合口径（**别自己决定**） |
| **G8** | **售后的远端幂等键没了** | 只剩本地闸门；「飞书写成功、本地落盘失败」这个窗口会重复写（**库存那一侧不受影响**，`InventoryService` 自己有远端兜底） | `config/afterSales.js:183-186`、`v1SchemaScopes.js:52`、`afterSalesService.js:45-47` | 等「已留存」的新表定下来时，把 `业务事件ID` 一起接回（键的算法还在：`config/afterSales.js:190-206`（`afterSalesBatchHash` / `afterSalesEventId`）） |
| **G9** | **退货必须她说出「钱怎么走」，否则这一笔做不了** | 只说「退货」不说钱 ⇒ 抛错拦住（**不瞎默认现金**，这是有意的红线），但要重说一遍 | `afterSalesFlowService.js:346-350`、`:589-595`；测试 `test/afterSalesFlow.test.js:649`、`:672` | 保留（这是她定过的红线）；可考虑把「请把'钱怎么走'一起说一遍」的提示做得更可操作 |

### 🟢 第三档：体验 / 可排查性

| # | 缺口 | 表现 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **G10** | **`settlePlatformReceipt` 一条日志都不打** | 券结清是「静默」的——线上无法判断它到底**没被调用**还是**调用失败了** | `paymentService.js:82-96`（无 `logInfo`）；对比同类写入都有日志（`after_sales.executed` `afterSalesService.js:370`） | 加一条 `payment.platform_settled`（带 `payment_record_id` / `correlation`） |
| **G11** | **销售退货在生产上 0 次执行** | 代码与测试都齐（见 B1/B2），但线上日志里 `after_sales.executed` 只有 1 条换货 ⇒ **这条链路从未在真实业务里被验证过** | 线上日志：`after_sales.executed` 1 条（`action:exchange`）；`after_sales.confirmed` 1 条 | 建议**请她用一笔真实的退货走一遍**（这是"测试 Base 之外的验收"，只有她能做）；我不擅自造数据（`AGENTS.md` 第 10 条） |
| **G12** | **`secondDeliveryService` 的日志缺「钱那一维有没有落点」的判据** | `sales.second_delivery.completed` 里 `collected_amount:0` 既可能是「已全款」也可能是「没记账」（正是 D3 的盲区） | `secondDeliveryService.js:190-201`（日志字段里没有 `pending_amount` / `payment_record_count`） | 日志里补 `pending_amount`（`progress.pendingAmount` 已经算好了，`:400`）与 `payment_count`——**不用改任何业务逻辑**就能让 D3 这类问题一眼可查 |

### 一句话总结（给业务负责人看的三个最严重不一致）

1. **预定单二次交付时，"货给出去"和"钱记下来"是两件互不校验的事**——只要录单时没留下「未收款」占位（她没说欠多少就不会留），二次交付就会**交货但不记账**，而且这一单永远显示"还没完成"，长期挂在待处理清单里（G1）。
2. **抖音团购券的钱永远停在"待平台结算"**——代码里有一个写好的结清方法，但**没有任何地方能调到它**，也没有「5 天」这个口径和定时任务（G2 + G3）；线上日志里券只出现过 1 次、**一次都没结清过**。
3. **退货的"钱留在我们这里"这条路是断的**——落点表「客户往来货款」被整表删除，现在她说「钱先存着」会在写入前直接失败（G5）；同时**采购退货整整一侧没有任何资金记录**（G4）。
