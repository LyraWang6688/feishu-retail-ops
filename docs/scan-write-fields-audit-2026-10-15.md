# 扫码页 · **写入字段核对表**（销售 / 补货 / 退货 / 配品）

> **用途**：业务负责人要求逐条核对「**写入哪些数据表里的哪些字段**」（她的原话，逐字）：
> 「**这个我也需要和你具体核对写入哪些数据表里的哪些字段**」。
>
> **怎么读这张表**
> - 语义键与字段中文名**一律取自** `server/src/config/v1BitableSchema.js`（**不凭记忆** ✓）；本表只**加行号引用**，不改任何映射。
> - 代码行号基准：`main` = **`3c737b2`**（2026-10-15 晚）。文件路径都相对 `server/`。
> - **值从哪来** 三类：`她填` / `代码算` / `飞书自动`。
>   ⭐ 业务负责人口径（2026-10-06）：**时间字段里只有「收款时间」由代码写**，其余时间列是飞书自动字段
>   ⇒ 本表把"代码写的时间列"和"飞书自动的时间列"分开列（见第 5 节）。
> - **不确定的一律写「待确认」**，不猜、不编（见第 9 节）。
> - 🔴 本表是**只读分析**：生成过程**一个字节都没写**（没跑测试、没碰表、没用飞书 CLI）。
>
> 架构口径见姊妹篇：`docs/scan-page-architecture-2026-10-15.md`。

## 0. 总览

| 链路 | 入口 | 写哪些表 | 是否异步 |
|---|---|---|---|
| **销售** | 扫码页「提交这一单」（货品页 → 资金页 → 成功页） | 销售主表 · 销售明细 · 收款明细 · 实时库存（扣减/删除）· 库存流水 | ⭐ **异步**（`SCAN_SALE_ASYNC_WRITE_ENABLED`，默认 `true`） |
| **补货**（生成报货订单） | 扫码页补货表单 | 采购主表 · 采购明细 ·（出图回填采购主表附件） | **同步**（待确认是否有异步计划） |
| **退货** | 扫码页退货表单 | 采购主表 · 采购明细 · 实时库存（扣减/删除）· 库存流水 | **同步**（同上） |
| **配品** | 扫码页销售表单里「配品」那一行 | **销售明细**（同一张表的一行；不单独建表） | 随销售 ⇒ **异步** |

**写入的唯一通道**：所有业务写入都经 `services/v1BitableGateway.js` 的 `create/update/delete`
（本表引用的 `create/update` 都是它的调用点）。

---

## 1. 销售链路

### 1.1 销售主表（`salesEntry`）

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 销售主表 | `tblLjFe3NjU61xKB`（`FEISHU_V1_SALES_ENTRY_TABLE_ID`） | `orderNo` | 销售单号 | 代码算（按日分配 + 撞号复查） | `services/salesEntryService.js:65`（写回）、`:81`（建单时带上） | `submitKey`（会话轮次键）⇒ 主表只建一次的判据；见 `scanWriteService` 的 `wasResume` | 异步（第一次跑就建完 ⇒ **先回单号**） |
| 销售主表 | 同上 | `sender` | 录单人 | 代码算（扫码页登录身份 open_id → 人员） | `services/salesEntryService.js:79` | — | 同上 |
| 销售主表 | 同上 | `userAction` | 确认状态 | 她动作 ⇒ 代码落值：建单 =「未确认」；**她点资金页按钮 =「已确认」** | 建单：`services/salesEntryService.js:80`；已确认：`services/scanWriteService.js:1163` → `services/salesStatusWriter.js:55` | — | **异步**（后台那一跑写） |
| 销售主表 | 同上 | `sales` / `funds` / `stock` | 销售状态 / 资金状态 / 库存状态 | 代码算（各业务写入器） | 唯一写入口 `services/salesStatusWriter.js:55` | — | 异步 |
| 销售主表 | 同上 | `tradeType` | 交易类型 | 代码算（按**实时库存有没有** ⇒ 现货 / 预定；混合单写多个） | `services/salesOrderService.js:292` | — | 异步 |
| 销售主表 | 同上 | `gift` | 赠品 | **她填**（销售页「赠品」框） | `services/salesOrderService.js:237` | — | 异步 |
| 销售主表 | 同上 | `afterSalesCount` | 售后次数 | 代码算（售后链路，非本入口） | `services/afterSalesService.js:1205` | — | 同步（售后入口） |

> 映射段：`config/v1BitableSchema.js:132-220`（`salesEntry`）。
> ⚠️ 已删除、**代码不再写**的历史列（映射与写入点**一起删过**）：`originalText`（原话）、`parseStatus`（解析状态）、旧「确认状态（旧）」—— 见 `salesEntryService.js:68-75` 的注释。

### 1.2 销售明细（`salesDetail`）— 鞋行

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 销售明细 | `tblxW5WMKDULyolA`（`FEISHU_V1_SALES_DETAIL_TABLE_ID`） | `salesEntry` | 销售单号 | 代码算（刚建那张单的 record_id） | `services/salesOrderService.js:255` | 已有 `detail_ids` 复用（`knownRecordIds`）＋ `onRecordPersisted` | 异步 |
| 销售明细 | 同上 | `product`（鞋）/ `accessory`（配品） | 编号 / 配品 | **她扫的码**（鞋）· **她选的配品**（配品）—— 由可售品配置声明写哪一列 | `services/salesOrderService.js:258`（`[row.item.linkField]`） | 同上 | 异步 |
| 销售明细 | 同上 | `size` | 尺码 | **她选**（配品行没有尺码 ⇒ 不写这一列） | `services/salesOrderService.js:259` | 同上 | 异步 |
| 销售明细 | 同上 | `actualAmount` | 实收金额 | **她填**（**留空 ⇒ 这一列不写**，不写 0） | `services/salesOrderService.js:263` | 同上 | 异步 |
| 销售明细 | 同上 | `fulfillmentStatus` | 履约状态 | 代码算（现货 = 已交付 / 预定 = 未交付）；交付那一刻由交付链路改写 | 建行：`services/salesOrderService.js:264`；交付改成「已交付」：`services/salesDeliveryService.js:107` | 同上 | 异步 |
| 销售明细 | 同上 | `tradeType` | 交易类型 | 代码算（这一行自己的行为记录；解析不到退回主表那条） | `services/salesOrderService.js:266` | 同上 | 异步 |
| 销售明细 | 同上 | `detailId` | 销售明细ID | 代码算（明细序号游标） | `services/salesOrderService.js:256` | 同上 | 异步 |

> 映射段：`config/v1BitableSchema.js:221-249`（`salesDetail`）。
> ⚠️ 明细**不带**赠品（那一列 2026-10-08 已被她整列删除）—— 见 `salesOrderService.js:260-262` 的注释。

### 1.3 收款明细（`paymentRecord`）

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 收款明细 | `tblTpLOtTLhWxXvm`（`FEISHU_V1_PAYMENT_RECORD_TABLE_ID`） | `salesEntry` | 关联销售单 | 代码算 | `services/paymentService.js:76` | `submitKey` + 既有 `requestId`（补记收款那条） | 异步 |
| 收款明细 | 同上 | `method` | 收款方式 | **她选**（扫码页收款方式；默认「微信」只是**页面预选**） | `services/paymentService.js:79` | 同上 | 异步 |
| 收款明细 | 同上 | `amount` | 收款金额 | **她填** | `services/paymentService.js:80` | 同上 | 异步 |
| 收款明细 | 同上 | `status` | 收款状态 | 代码算（「已收款」/「未收款」） | `services/paymentService.js:81`（创建）、`:104`（补记） | 同上 | 异步 |
| 收款明细 | 同上 | `receivedAt` | **收款日** | ⭐ **代码算（她点确认那一刻）** —— **唯一由代码写的时间列** | `services/paymentService.js:82`（创建）、`:105`（补记） | 同上 | 异步 |
| 收款明细 | 同上 | `tradeDirection` | 交易方向 | 代码算（收入方向；【未收款】那条**不写**） | `services/paymentService.js:84`（创建）、`:108`（补记） | 同上 | 异步 |
| 收款明细 | 同上 | `receiptId` | 收款明细ID | 代码算（收款序号） | `services/paymentService.js:73`（生成）、`:78`（创建时写） | 同上 | 异步 |

> 映射段：`config/v1BitableSchema.js:250-287`（`paymentRecord`）。
> ⚠️ 「未收款」那一条的形状由**既有业务层**决定（状态=未收款、**方式留空**、金额=差额、关联=既有销售单）——
> 见 `services/paymentService.js` 的 `MONEY_DIRECTION_INCOME` 注释与 `scanWriteService` 的 `owed` 段。

### 1.4 实时库存（`liveInventory`）· 库存流水（`inventoryLedger`）— 现货行「提交即交付 + 扣库存」

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 库存流水 | `tbl7Xo4OPmaN2NdP`（`FEISHU_V1_INVENTORY_LEDGER_TABLE_ID`） | `product` / `size` | 编号 / 尺码 | 代码算（来自本次交付的那一行明细） | `services/inventoryService.js:1259-1260` | **本地任务记录 + 真实三元组**（货品｜尺码｜来源行），不是远端幂等键 | 异步 |
| 库存流水 | 同上 | `quantityChange` | 变动数量 | 代码算（**恒为正数**；方向写在「库存行为」） | `services/inventoryService.js:1261` | 同上 | 异步 |
| 库存流水 | 同上 | `behavior` | 库存行为 | 代码算（销售 = `STOCK_SALE_DECREASE`，见 `inventoryService.js:70`） | `services/inventoryService.js:1262` | 同上 | 异步 |
| 库存流水 | 同上 | `salesDetail` | 关联销售 | 代码算（**只有带来源列的动作才写**；注册表声明 `ledgerSource`） | `services/inventoryService.js:1264-1266`（`movement.ledgerSource` 声明的那一列；销售这一路 = `salesDetail`） | 同上 | 异步 |
| 实时库存 | `tblTr5qgiZXPADLP`（`FEISHU_V1_LIVE_INVENTORY_TABLE_ID`） | （**删行**，不是改字段） | —— | 代码算（一双一条 ⇒ 卖出去就把那一行**删掉**） | `services/inventoryService.js:1299`（`gateway.delete('liveInventory', …)`） | 同上 | 异步 |
| 实时库存 | 同上 | `state` | 所属状态 | 代码算（**状态迁移**那一路：门盒 → 样品 等） | `services/inventoryService.js:1215`（`{ state: '样品' }`）、`:1077` | 同上 | 异步 |
| 库存流水 | 同上 | （状态迁移那一路）`quantityChange` = **0** | 变动数量 | 代码算（迁移不是增减 ⇒ 写 0） | `services/inventoryService.js:1204-1209` | 同上 | 异步 |

> 映射段：`liveInventory` = `config/v1BitableSchema.js:561-580`；`inventoryLedger` = `:523-560`。
> ⚠️ 「操作人」（`operator`）只在**人工调整**那条链路写；扫码销售这条**不写**（待确认是否有例外，见第 9 节）。

---

## 2. 补货链路（生成报货订单）

### 2.1 采购主表（`purchaseOrderBatch`）

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 采购主表 | `tblwezby9wRea9qi`（`FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID`） | `batchNo` | 报货批次号 | 代码算（`CGD-YYYYMMDD-NNNN` 生成器） | `services/purchaseWebhookService.js:1588`（`createOnceByKey` 的 `values.batchNo`） | ⭐ **`幂等键` = plan 的 `batch_key`**（同一批只建一行） | 同步 |
| 采购主表 | 同上 | `idempotencyKey` | 幂等键 | 代码算（plan 的批次键） | `services/purchaseWebhookService.js:1588` 的 `values.idempotencyKey` | 同上（远端回查就靠这一列） | 同步 |
| 采购主表 | 同上 | `arrivalStatus` | 到货状态 | 代码算（新建 = **未到货** `pendingStatus`） | `services/purchaseWebhookService.js:1588` 的 `values.arrivalStatus`；后续到货改写见 `services/purchaseOrderBatchService.js:206` | 同上 | 同步 |
| 采购主表 | 同上 | `behavior` | 采购行为 | 代码算（= 行为管理里**采购申请**那一档的记录 id） | `services/purchaseWebhookService.js:1588` 的 `values.behavior` | 同上 | 同步 |
| 采购主表 | 同上 | `document` | 单据（附件） | 代码算（出图后**回填**；已有 token 原样带上，不冲掉别人） | `services/purchaseOrderBatchService.js:451` | 按批次行 record_id | 同步（出图那段异步，但**不回阻塞成单**） |

### 2.2 采购明细（`purchaseRequest`，表名已改叫「采购明细」）

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 采购明细 | `tbli1ygPtss5CWCH`（`FEISHU_V1_PURCHASE_REQUEST_TABLE_ID`） | `batchNo` | 报货批次号（**关联采购主表**） | 代码算（刚建那张主表的 record_id） | `services/purchaseWebhookService.js:1644`（`values.batchNo`） | ⭐ **`幂等键` = `item.request_key`**（每条明细一把） | 同步 |
| 采购明细 | 同上 | `product` | 编号 | **她勾的货品** ⇒ 代码落关联 | `services/purchaseWebhookService.js:1644` | 同上 | 同步 |
| 采购明细 | 同上 | `size` | 尺码 | **她勾的尺码** ⇒ 代码落关联 | `services/purchaseWebhookService.js:1644` | 同上 | 同步 |
| 采购明细 | 同上 | `quantity` | 数量 | **她填**（空 ⇒ 按配置默认 1） | `services/purchaseWebhookService.js:1644` | 同上 | 同步 |
| 采购明细 | 同上 | `detailId` | 采购明细ID | 代码算（明细序号游标 `detailIdCursor`） | `services/purchaseWebhookService.js:1644` | 同上 | 同步 |
| 采购明细 | 同上 | `idempotencyKey` | 幂等键 | 代码算 | `services/purchaseWebhookService.js:1644` | 同上（远端回查） | 同步 |

> 🔴 **明细侧刻意不写「采购行为」**：那一列是**按「报货批次号」关联主表的 Lookup（只读）**，
> 明细的值由主表带出来；写它会失败。见 `config/v1BitableSchema.js:359-363` 与源码哨兵
> `test/purchaseBehaviorLookupReadOnly.test.js`。

---

## 3. 退货链路

### 3.1 采购主表（`purchaseOrderBatch`）—— 退货批次

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 采购主表 | `tblwezby9wRea9qi` | `batchNo` | 报货批次号 | 代码算（批次号生成器） | `services/purchaseOrderBatchService.js:151`（`createOnceByKey` 的 `values.batchNo`） | ⭐ **`幂等键` = `purchase_batch:<批次号>`** | 同步 |
| 采购主表 | 同上 | `idempotencyKey` | 幂等键 | 代码算 | `services/purchaseOrderBatchService.js:151` | 同上 | 同步 |
| 采购主表 | 同上 | `behavior` | 采购行为 | 代码算（= 行为管理里**采购退货**那一档；**按编码 `PURCHASE_RETURN` 解析**，不按名字） | `services/purchaseOrderBatchService.js:151` | 同上 | 同步 |
| 采购主表 | 同上 | 🔴 **`arrivalStatus` 刻意不写** | 到货状态 | ——（退货批次留空 ⇒ 9 点推送与工作台待验收列表都看不见它） | `services/purchaseOrderBatchService.js:158` 注释（「**没有** arrivalStatus」） | — | — |
| 采购主表 | 同上 | `quantity` | 录入数量 | 代码算（这一批的录入数量合计；**拿不到/0 ⇒ 这一列不写**） | `services/purchaseOrderBatchService.js:151` 段（`batchQuantityFields`，见 `:169-172` 注释） | 按批次行 | 同步 |

### 3.2 采购明细（`purchaseRequest`）—— 退货明细

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 采购明细 | `tbli1ygPtss5CWCH` | `batchNo` | 报货批次号（关联主表） | 代码算 | `services/purchaseReturnService.js:208`（`values.batchNo`） | ⭐ **`幂等键` = `docKey`** | 同步 |
| 采购明细 | 同上 | `product` | 编号 | 代码算（她扫码那一款） | `services/purchaseReturnService.js:208` | 同上 | 同步 |
| 采购明细 | 同上 | `size` | 尺码 | **实时库存里实际存在的尺码**（她 2026-10-15 口径） | `services/purchaseReturnService.js:208` | 同上 | 同步 |
| 采购明细 | 同上 | `quantity` | 数量 | 代码算（`item.taken` = **实际能退的数量**；超库存时如实少退并回报差额） | `services/purchaseReturnService.js:208` | 同上 | 同步 |
| 采购明细 | 同上 | `detailId` | 采购明细ID | 代码算（游标） | `services/purchaseReturnService.js:208` | 同上 | 同步 |
| 采购明细 | 同上 | `idempotencyKey` | 幂等键 | 代码算 | `services/purchaseReturnService.js:208` | 同上 | 同步 |

### 3.3 实时库存 / 库存流水 —— 退货扣减

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 库存流水 | `tbl7Xo4OPmaN2NdP` | `product` / `size` / `quantityChange` / `behavior` | 编号 / 尺码 / 变动数量 / 库存行为 | 代码算（行为 = `STOCK_PURCHASE_DECREASE`，见 `inventoryService.js:77`；数量恒正） | `services/inventoryService.js:1259-1262` | 本地任务记录 + 真实三元组 | 同步 |
| 实时库存 | `tblTr5qgiZXPADLP` | （**删行**） | —— | 代码算（双数扣减 ⇒ 删掉对应行） | `services/inventoryService.js:1299` | 同上 | 同步 |

> ⚠️ 退货**不带**「关联采购」（`inventoryLedger.purchaseBatch`）—— 注册表里这一路的 `ledgerSource` 为 `null`
> （见 `inventoryService.js:1265-1268` 的注释：采购退货 / 采购加库存没有可按来源回查的列）。

---

## 4. 配品链路（表单入口，已上线）

配品**不单独建表**：它是**销售明细里独立的一行** —— `配品` 有值、`编号`/`尺码` 留空、**实收金额单列**。
「其他配品」表（`accessory`，tableId 由 `FEISHU_V1_ACCESSORY_TABLE_ID` 配，**无硬编码默认值**）只**读**（名称 / 单价），**不写**。

| 表名（中文） | tableId | 语义键 | 字段中文名 | 值从哪来 | 写入代码位置 | 幂等键 | 是否异步 |
|---|---|---|---|---|---|---|---|
| 销售明细 | `tblxW5WMKDULyolA` | `salesEntry` | 销售单号 | 代码算（同一张单） | `services/salesOrderService.js:255` | 已有 `detail_ids` 复用 | 异步（随销售） |
| 销售明细 | 同上 | `accessory` | 配品 | **她选**（下拉里「其他配品」的名称 ⇒ 关联记录 id） | `services/salesOrderService.js:258`（`[row.item.linkField]`，配品这一路 = `accessory`） | 同上 | 异步 |
| 销售明细 | 同上 | `actualAmount` | 实收金额 | **她填**（配品那一格；留空 ⇒ 不写） | `services/salesOrderService.js:263` | 同上 | 异步 |
| 销售明细 | 同上 | `fulfillmentStatus` | 履约状态 | 代码算（配品**不跟踪库存** ⇒ 不走交付扣减） | `services/salesOrderService.js:264` | 同上 | 异步 |
| 销售明细 | 同上 | `tradeType` | 交易类型 | 代码算（沿用主表那条 / 行自己的值） | `services/salesOrderService.js:266` | 同上 | 异步 |
| 销售明细 | 同上 | `detailId` | 销售明细ID | 代码算（游标） | `services/salesOrderService.js:256` | 同上 | 异步 |

> 「配品实收金额」与「配品」这两个键都在 `config/v1BitableSchema.js:221-249`（`salesDetail`）里；
> 页面文案与字段名见 `config/scanWrite.js` 的 `FIELDS.accessory` / `TEXTS.accessory*`。

---

## 5. ⭐ 飞书**自动字段**（代码不写）

业务负责人口径（2026-10-06）：「**改完只有收款是代码的事情，其他都应该是飞书的自动字段！**」

| 表 | 字段（中文） | 语义键（若 schema 有映射） | 说明 |
|---|---|---|---|
| 收款明细 | **收款日** | `receivedAt` | ⭐ **例外：由代码写**（她点确认那一刻）—— 见 1.3 |
| 收款明细 | 创建时间 | `createdAt` | **飞书自动**（schema 有映射、**全仓无写入点**） |
| 销售主表 | 录单日 | `recordedAt` | **待确认**：schema 有映射，`src/services` 内**未找到写入点** ⇒ 疑为飞书自动字段（需只读核真表字段类型） |
| 销售明细 | 销售日 | `soldAt` | **待确认**：同上（schema 有映射、未找到写入点） |
| 实时库存 | 更新时间 | `updatedAt` | **待确认**：同上（是否 `type=1002` 需只读核真表） |
| 采购主表 | 报货日 | `createdAt` | **待确认**：schema 有映射，未找到代码写入点 |
| 采购主表 | 到货日 / 验收人 | （**刻意不建映射**） | 飞书**自动**字段（到货日 = 更新时间 1002；验收人 = 创建人 1003）—— 见 `config/v1BitableSchema.js:403-408` |
| 销售明细 / 库存流水 等 | 自动编号类列 | `detailId` / 库存流水号 | ⚠️ **不是时间字段**，不受上面那条口径约束；`采购明细.采购明细ID` 只读核过**已变成人工文本**（`:380-388`）|

## 6. 「schema 有映射、但没有写入点」清单（如实列）

| 表 | 语义键 | 字段中文名 | 结论 |
|---|---|---|---|
| 采购明细 | `detailId` | 采购明细ID | 映射保留（只改名），**代码目前不读也不写**（`v1BitableSchema.js:386-387`） |
| 采购明细 | `behavior` | 采购行为 | **只读**（Lookup，按批次号从主表带出来）⇒ 明细侧不写（`:359-363`） |
| 销售明细 | `listUnitPrice` | 销售单价 | **待确认**：本次 grep `src/services` **未见写入点**；只在 `v1WorkbenchService.js:217` 被**读**。⇒ 疑为"有映射、无写入"（她 2026-10-11 选方案甲后**不再用单价兜底**） |
| 销售主表 | `recordedAt` / 销售明细 `soldAt` / 实时库存 `updatedAt` / 采购主表 `createdAt` | 录单日 / 销售日 / 更新时间 / 报货日 | **待确认**（见第 5 节） |

## 7. 只读引用表（**这些表这条链路只读、不写**）

| 表名（中文） | tableId | 用途 |
|---|---|---|
| 货品信息 | `tbl9z4Oi8Vc57Kin` | 取货号 / 颜色 / 品类 / 价格 / 供应商（扫码页展示与建单） |
| 颜色管理 | `tblZ947YJkRwgo3k` | 颜色解析 |
| 品类管理 | `tbleM3qxsw8s8jAI` | 品类解析 |
| 其他配品 | `FEISHU_V1_ACCESSORY_TABLE_ID`（无硬编码默认值） | 配品下拉 + 单价 |
| 行为管理 | `tblbTvUT4AFsCK4K` | 交易类型 / 库存行为 / 采购行为的**编码解析** |
| 尺码管理 | `FEISHU_V1_SIZE_TABLE_ID`（无硬编码默认值） | 尺码 → 记录 id |
| 收款方式管理 | `tblH7YzA1v5vJzEi` | 收款方式名 → 记录 id |
| 供应商管理 | `tblFfXkLct2ZIGGq` | 供应商（补货出图） |
| 团购券管理 | `tblz2kM1CIGkcWsM` | 券（销售收款那一档） |

> ⚠️ 这些表在 `v1BitableSchema.js` 里**有映射**（为了读），但本条链路**一个字都不写**；
> 唯一例外是「档案类建号」链路（群聊/到货那条会建货品与颜色）—— **不属于扫码页这四条链路**。

## 8. 幂等键一览（同一次提交连点两次 = 只写一次）

| 链路 | 幂等键怎么来的 | 落点 |
|---|---|---|
| 销售（主表 + 明细 + 收款 + 库存） | 扫码页会话的 **`submitKey`**（`scan_sale:<会话 id>:<轮次>`） | 会话在 `data/scan_sessions/`（**本地**）；远端靠"主表 record_id 复用 + `detail_ids`/`payment_ids` 回查" |
| 补货 | `幂等键` = plan 的 `batch_key` / `item.request_key`（**落成真实文本列**） | 采购主表 + 采购明细的「幂等键」列（远端回查） |
| 退货 | 同上（`purchase_batch:<批次号>` / `docKey`） | 同上 |
| 库存（扣减 / 增加） | 本地任务记录 + **真实三元组**（货品｜尺码｜来源行） | 本地；流水**不带远端幂等键** |
| 配品 | 同销售（它就是销售明细的一行） | 同销售 |

## 9. 待确认（**不猜、不编**）

1. 「录单日」（`salesEntry.recordedAt`）、「销售日」（`salesDetail.soldAt`）、「更新时间」（`liveInventory.updatedAt`）、
   「报货日」（`purchaseOrderBatch.createdAt`）在**生产真表**里的字段类型（`1001/1002` = 自动？还是普通 `DateTime`）
   ⇒ 只能**只读核真表**（`appTableField.list`）才能定论；本次只做了代码侧 grep。
2. `salesDetail.listUnitPrice`（销售单价）到底有没有写入点 —— 本次 grep `src/services` 未见；
   可能只存在于历史链路或由人工在表里填 ⇒ **待确认**。
3. 补货 / 退货当前**是否同步**：代码里没找到对应的异步开关（只有销售的 `SCAN_SALE_ASYNC_WRITE_ENABLED`）；
   她 2026-10-15 口径是"**都是异步**" ⇒ **待做**（不是现状）。
4. 到货 / 加库存那条（`confirmArrival` / `applyPurchase`）**不属于扫码页这四条链路**，本表**未展开**；
   若要一起核对，需另开一节（可参考 `docs/arrival-landing-on-batch-2026-10-07.md`）。
5. 「操作人」（`inventoryLedger.operator`）在扫码这四条链路里是否**任何一处**会写 —— 本次 grep 未见表内写入；
   人工调整那条另算 ⇒ **待确认**。

---

## 附：**已核实（Lead 生产只读 · 2026-10-15 22:3x）** —— 时间列到底哪些是"飞书自动"

用项目代码（`appTableField.list`，**只读、一个字节没写**）把七张表的时间列类型全扫了一遍：

| 表 | 时间列（`type` → 含义） |
|---|---|
| 销售主表 | 录单日 `1001`（自动创建时间）· 更新时间 `1002`（自动） |
| 销售明细 | 销售日 **`1001`**（自动！）· 更新时间 `1002` |
| **收款明细** | **收款日 `5`（人工日期 ⇒ 必须代码写）** · 创建时间 `1001` · 更新时间 `1002` |
| 采购主表 | 报货日 `1001` · 到货日 `1002` |
| 采购明细 | 报货日 `1001` · 更新时间 `1002` |
| 库存流水 | 创建时间 `1001` · 更新时间 `1002` |
| 实时库存 | 创建时间 `1001` · 更新时间 `1002` |

⭐ **结论（正好印证她 2026-10-06 的口径）**：
> 「**只有收款是代码的事情，其他都应该是飞书的自动字段**」

⇒ 七张表里**唯一的 `type 5`（人工日期）= 收款明细的「收款日」** ✓ ⇒ **代码只允许写这一个时间列** ✓；
其余时间列**全部是 `1001/1002` 自动** ⇒ **代码一行都不许写** ✗

⇒ **本文件原先的「待确认：时间列在真表的类型」一条，已由本条结清** ✓（不再待确认）
