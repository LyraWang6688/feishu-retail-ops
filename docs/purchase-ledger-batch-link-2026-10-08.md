# 「库存流水.关联采购」补刀：采购加库存写【报货批次】那一行的 record id（2026-10-08）

> 本文是**先写的验收标准**（业务纪律：先写"按我们的链路应该实现的效果"，再动手），
> 第 5 节起是**改动后的逐条对照**与证据。

## 0. 业务负责人的口径（逐字）

> 「【库存流水.关联采购】**还在**（关联类型），指向 已删除的「采购入库」⇒ 所以它的处置
>  （删掉这个映射、不再传关联 id）是对的，继续写必然失败，**改成了报货批次**」
> 「①「关联采购」补刀（写批次 record id）**历史不用补了**」

⇒ 两件事：**代码改成写批次 record id**；**历史流水不回填**（既有的一个字都不动）。

生产真表事实（Lead 2026-10-08 00:0x 只读核过，**本机看不到生产，以这份为准**）：

| 表 | tableId | 事实 |
| --- | --- | --- |
| 库存流水 | `tbl7Xo4OPmaN2NdP` | 11 列；「**关联采购**」= **关联(type 18)**，目标表 = **「报货批次」`tblwezby9wRea9qi`** ✅（她已改好，可直接写） |
| 报货批次 | `tblwezby9wRea9qi` | 关联的对端；schema 表键 `purchaseOrderBatch` |

## 1. 改动前的事实基线（本机只读侦察，HEAD `4b1b0d7`）

- `STOCK_MOVEMENTS['STOCK_PURCHASE_INCREASE'].ledgerSource = null`（#253 删的），
  `v1BitableSchema.tables.inventoryLedger.fields` 里**没有**指向「关联采购」的映射。
- 幂等（#253 那套，**本次一个字都不许动**）：
  `purchaseIncreaseSourceId(input)` = `purchase_increase:<批次记录id | 批次号 | 到货核对任务id>|<货品record_id>|<尺码>`，
  它**只做本地幂等键**（`operationId` / `findOperationBySource` / `store` 落盘）；
  `applyPurchase` 靠 `findOperationBySource` 回查本地任务取 `state`，让重放与首次提交同形状。
- 写流水的唯一地方：`executeOperation` 里 `gateway.create('inventoryLedger', …)`，
  来源列由 `movement.ledgerSource` 驱动 —— `ledgerSource` 同时被
  **写**（`executeOperation`）、**按来源回查**（`findLedger`：`applyChange` 的预检 /
  `findOperationLedger` / `auditExistingOperationRecords`）两处用。
- ⚠️ **关键约束**：`source_record_id` 是**三元组**（一个批次里每个 货品+尺码 各一条），
  **不能**拿来当远端关联值 —— 一个批次会挂出 N 条流水、且 `findLedger` 按它回查会
  判成「存在重复库存流水」。所以**不能**把 `ledgerSource` 直接改回一个非 null 值。

## 2. 验收标准（先写；逐条对照见第 5 节）

### A. schema（映射加回来，语义键名换准）

- **AC-1** `V1_BITABLE_SCHEMA.tables.inventoryLedger.fields` 里有指向物理列名
  「关联采购」的映射；**语义键名不再叫 `purchaseInbound`**（那说的是已被整表删除的
  「采购入库」表，留着名字本身就是错的口径），改叫 **`purchaseBatch`**（对端 = 报货批次）。
- **AC-2** 旧表键 / 旧语义键（`purchaseInbound`）**不许**因为这次补刀回来；
  全仓（src/public/scripts/test）仍不引用表键 `'purchaseInbound'` 与
  `FEISHU_V1_PURCHASE_INBOUND_TABLE_ID`（守门在 `purchaseInboundRemoval.test.js` ① / ①-补）。

### B. 写入（只改采购加库存这一条行为的来源）

- **AC-3** 采购加库存写出的那一条「库存流水」，**「关联采购」= 报货批次那一行的 record id**
  （逐字断言 `['batch_1']` / `[BATCH_RECORD_ID]`），并且**仍不带**「关联销售」。
- **AC-4** ⭐ 拿不到批次 record id 时**这一列一个字都不写**（字段不出现），
  **绝不编**（不回退成批次号、也不回退成到货核对任务 id 或三元组键）；
  此时加库存其余部分照常成功。
- **AC-5** ⭐ **其他行为的来源一个都不许动**：
  `SALE_DECREASE` / `SALE_RETURN` / `SALE_COMPENSATION` / `SALE_CASH` 仍是 `salesDetail`；
  `PURCHASE_DECREASE` 与 6 条人工库存行为的 `ledgerSource` 仍是 `null`；
  采购退货的流水**不带**「关联采购」。
- **AC-6** 采购加库存的 `ledgerSource` **仍为 null**（本次补的是**只写不查**的关联列，
  不是把 `findLedger` 那条"按来源回查"接回来）。

### C. 幂等 / 重放（#253 那套，一行都不改）

- **AC-7** 同一（批次身份｜货品｜尺码）重复调用 ⇒ 仍只有 **1 条流水 + 一组实时库存**
  （不因多写一个关联 id 而变）。
- **AC-8** `source_record_id` 的形状**逐字不变**（`purchase_increase:batch_1|product_1|38`）；
  `operationId` / `findOperationBySource` / 重放取 `state` 的逻辑**零改动**。
- **AC-9** ⭐ 崩溃恢复（流水创建失败 → 本地任务停在 `prepared` → 下一次调用经
  `resumePending` 续跑）时，**重放写出的那条流水同样带批次 record id** ——
  也就是批次 id 必须在 prepare 那一刻就落进本地任务（否则"重放的那一条"会静默丢关联）。

### D. 其他链路不回退

- **AC-10** 到货确认的**真实链路**（真实 `InventoryService` + 真实 `JsonTaskStore`）：
  12 行（去 3 行 0 双）→ 9 条流水 + 9 双实时库存，**每条流水都挂批次 record id**。
- **AC-11** 9 点推送（按「报货批次.到货状态 = 未到货」筛）与 `pendingDealPush*`、销售侧、
  `app.js` **一个字都不动**；全量测试 fail=0（连跑 2 次）。

## 3. 设计（两处代码 + 一处本地落盘）

`ledgerSource`（**参与幂等/恢复**）与「关联采购」（**只写不查**）是**两件事**，
所以拆成两个配置项，而不是把一个值塞进 `ledgerSource`：

1. **schema**：`inventoryLedger.fields.purchaseBatch = '关联采购'`。
2. **写入**：`STOCK_MOVEMENTS['STOCK_PURCHASE_INCREASE']` 新增
   ```js
   ledgerLink: { field: 'purchaseBatch', inputKey: 'purchaseBatchRecordId',
                 operationKey: 'purchase_batch_record_id' }
   ```
   `executeOperation` 建流水时按它多写一列（值取本地任务上的 `purchase_batch_record_id`；
   空则整列不写）。
3. **本地落盘**（AC-9 必需）：`applyChange` 落本地任务时把
   `input.purchaseBatchRecordId` 存成 `purchase_batch_record_id` —— 它**不是幂等判据**，
   只是"重放时要有得写"的载荷。

⭐ **语义键名为什么选 `purchaseBatch`（而不是沿用 `purchaseInbound`）**：
`purchaseInbound` 是那张**已被整表删除的「采购入库」表**的名字。这一列在生产真表里
已经被她改成指向「报货批次」——继续用旧键名，等于代码里留着"这一列指向采购入库"的错口径
（下一个人读到这里会以为对端还是那张表）。`purchaseBatch` 与表键 `purchaseOrderBatch`
（报货批次）同源，一眼能看出对端是谁；且它**不是表键**，不会与 `tables.purchaseOrderBatch` 撞名。

⚠️ **不碰**：`ledgerSource` 的读写两侧、`findLedger` / `ledgerMatchesOperation` /
`auditExistingOperationRecords` / `purchaseIncreaseSourceId` / `applyPurchase` /
`confirmArrivalLocked` 的库存循环结构（**只改了一处注释**）、`pendingDealPush*`、销售侧、`app.js`。
🔴 **不写任何表**（本机没有生产凭证；不跑任何写库脚本、不写迁移）。

## 4. 历史不回填

不写迁移脚本、不改既有流水行：本次只影响**改动之后新写**的采购加库存流水。
（她的口径：「①「关联采购」补刀（写批次 record id）**历史不用补了**」）

## 5. 逐条对照（改动后）

| 验收条款 | 结论 | 证据 |
| --- | --- | --- |
| AC-1 schema 有「关联采购」映射、键名 `purchaseBatch` | ✅ | `v1BitableSchema.js` 新增 `purchaseBatch: '关联采购'`；`purchaseLedgerBatchLink.test.js`「schema：映射加回来了」 |
| AC-2 旧表键/旧键名不许回来 | ✅ | `purchaseInboundRemoval.test.js` ①（全仓扫描）＋ ①-补（`hasOwnProperty(ledgerFields, DELETED_TABLE_KEY) === false`、`tables.purchaseInbound === undefined`）全绿 |
| AC-3 流水带批次 record id（逐字） | ✅ | `purchaseLedgerBatchLink.test.js` ①（`deepEqual` 整个 fields，含 `关联采购: ['recBatch0001']`）＋ ①-补（一个批次两条流水共用同一批次 id） |
| AC-4 拿不到就不传、绝不编 | ✅ | `purchaseLedgerBatchLink.test.js` ②（批次号 / 到货任务 id 两种兜底身份各跑一遍：`Object.hasOwn(fields,'关联采购') === false`，且整个字段值里搜不到被禁的那些 id）；`test_inventory_e2e.js` 同口径（只给批次号 ⇒ 断言该列为 `undefined`） |
| AC-5 其他行为一个都不动 | ✅ | `purchaseLedgerBatchLink.test.js` ③（销售流水 = `关联销售:['detail_1']`、无 `关联采购`；采购退货流水逐字 deepEqual 只有 4 列）＋ ③-补（11 个行为编码的 `ledgerSource` 逐条比对，且都不带 `ledgerLink`） |
| AC-6 `ledgerSource` 仍为 null | ✅ | `purchaseLedgerBatchLink.test.js` ③-补；`purchaseInboundRemoval.test.js` ①-补 同断言 |
| AC-7 重复调用仍 1 流水 + 一组库存 | ✅ | `purchaseLedgerBatchLink.test.js` ④（连调两次：`ledgerRecordId` 相同、流水 1 条、实时库存 2 条） |
| AC-8 幂等键形状逐字不变 | ✅ | `purchaseLedgerBatchLink.test.js` ④-补3（`purchase_increase:recBatch0001|product_1|38`、批次号兜底、一个都没有时抛错）+ ④-补2（重放 state 取自本地任务）；`purchaseInboundRemoval.test.js` ④-补 正则断言 |
| AC-9 崩溃恢复写出的那条也带批次 id | ✅ | `purchaseLedgerBatchLink.test.js` ④-补（gateway 第一次建流水抛错 → 本地任务 `prepared` 且 `purchase_batch_record_id === 'recBatch0001'` → 再调一次经 `resumePending` 续跑 → 写出的流水带 `关联采购: ['recBatch0001']`） |
| AC-10 真实到货链路 9 条流水全带批次 id | ✅ | `purchaseInboundRemoval.test.js` ②（真实 `InventoryService` + 真实 `JsonTaskStore`，12 行 → 9 条流水 / 9 双库存；每条流水断言 `关联采购 === [BATCH_RECORD_ID]`） |
| AC-11 其他链路不回退 + 全量 2 次 | ✅ | 全量 `node --test --test-concurrency=1` **1338/1338 通过 ×2**（fail=0）；`arrivalLandingOnBatch`（含 9 点推送 ⑥）全绿；`pendingDealPush*` / 销售侧 / `app.js` **无 diff** |

## 6. 证据

### 6.1 先红后绿

**改动前**（只有新测试文件，没动 src）：
`node --test test/purchaseLedgerBatchLink.test.js` → **tests 12 / pass 5 / fail 7**，
红的 7 条（逐字）：

```
✖ ① 采购加库存的流水**带上**「关联采购」= 报货批次那一行的 record id（逐字 deepEqual）
✖ ①-补 同一批次的多个（货品+尺码）→ 多条流水共用同一个批次 record id（幂等键仍是三元组）
✖ ③-补 来源注册表：**只有**采购增加的来源被补了这一刀（其余逐字不变）
✖ ④ 同一（批次｜货品｜尺码）重复调用 → 仍只 1 条流水 + 一组实时库存，且关联值不变
✖ ④-补 崩溃恢复：流水写失败 → 本地任务停在 prepared → 续跑写出的那条**也带**批次 id
✖ ④-补4 加了关联列之后，**按来源回查流水**那条路仍然不生效（ledgerSource=null ⇒ 不查）
✖ schema：映射加回来了（`purchaseBatch` → 「关联采购」）
```

（② / ③ / ④-补2 / ④-补3 / schema-补 在改动前就是绿的 —— 它们是**护栏**：
证明"拿不到就不传""其他行为不带""幂等没动"这几件在补刀前后**都成立**。）

**改动后**：同一命令 → **tests 12 / pass 12 / fail 0**。
全量 1338 用例也全绿（这条改动没有把任何既有用例推翻，被推翻的只有
`purchaseInboundRemoval` ② / `inventoryMvp` 采购用例里**记录旧口径的那两条断言**——
它们记的是"不许写「关联采购」"，已按她 2026-10-08 的口径改成"必须写批次 record id"）。

### 6.2 「幂等那套未动」的证据

`git diff -- server/src/services/inventoryService.js` 里，**没有任何一行代码**
落在这些标识符上（只有注释提到它们）：

```
$ git diff -- server/src/services/inventoryService.js \
  | grep -E "^[+-].*(operationId|purchaseIncreaseSourceId|findOperationBySource|findLedger|ledgerMatchesOperation|auditExistingOperationRecords|resumePending|applyPurchase\()"
  → 命中的全部是注释行（`//`），没有一行是代码
```

具体来说，本次 `inventoryService.js` 的**代码级**改动只有 5 行（其余全是注释）：

| 位置 | 改动 |
| --- | --- |
| `STOCK_MOVEMENTS[采购增加]` | 新增 `ledgerLink: {…}`（`ledgerSource: null` **原样不动**） |
| 新增两个 helper | `movementLedgerLinkPatch` / `movementLedgerLinkValue`（纯取值，无判据） |
| `applyChange` 的 `store.create` | `+ ...movementLedgerLinkPatch(movement, input)`（多存一个载荷字段） |
| `executeOperation` 的 `create('inventoryLedger')` | `+ …ledgerLinkValue ? {['关联采购']: relation(值)} : {}`（多写一列） |
| `purchaseWebhookService` | **仅一处注释**（把"远端没有任何关联列可写"改成事实）；库存循环**结构零改动** |

`source_record_id` / `operationId` / `findOperationBySource` / `findLedger` /
`ledgerMatchesOperation` / `auditExistingOperationRecords` / `resumePending` /
`applyPurchase` 的函数体**一个字符都没变**。

### 6.3 全量测试

```
=== RUN 1 ===  ℹ tests 1338  ℹ pass 1338  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0
=== RUN 2 ===  ℹ tests 1338  ℹ pass 1338  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0
```

命令：在独立 worktree 的 `server/` 下 `node --test --test-concurrency=1`（= `pnpm test`），
worktree HEAD = 本次分支（`git rev-parse --short HEAD` 见第 8 节）。

### 6.4 CI

（PR 开出后回填，见第 8 节）

## 7. 不确定处（**如实说，不猜**）

1. 🔴 **本机看不到生产**：`关联采购` 目标表 = 「报货批次」是 Lead 2026-10-08 00:0x
   只读核过的事实，**我没有第二次核过**（本机 `.env` 指向测试 Base / 无生产只读口径）。
   ⇒ 代码侧据此写成"值 = 批次那一行的 record id"。若真表这列的**目标表**其实还是别的，
   写入会被飞书拒绝（而不是写错一行）——那种情况应立刻停手报她。
2. ⚠️ **本机测试 Base 落后于生产**：#253 的只读侦察记过，测试 Base 的「库存流水」
   仍有「关联采购」(SingleLink)，而「报货批次」在测试 Base 上列数落后。
   ⇒ 本机**没有**对测试 Base 做任何写入验证（也不该做：那会写一行测试数据）；
   `test_inventory_e2e.js` 恰好是**只给批次号**的调用 ⇒ 它**不会**碰这一列。
   真正"把批次 id 写进关联列"的端到端验证，要么在**对齐后的测试 Base** 上做，
   要么由她在生产上自然跑到 —— 本机不写生产表，这条**未做**。
3. ⚠️ **关联值只在"批次记录 id 拿得到"时写**：到货链路的历史草稿里
   `batch_record_id` 可能为空（`arrivalTaskId` 兜底的那种孤儿调用）⇒ 那一条流水
   **没有**「关联采购」。这符合她"拿不到就不传、绝不编"，但**代价如实说**：
   那少数流水在表里仍无法按批次回查。
4. ⚠️ **历史流水不回填**（她明确"历史不用补了"）⇒ 2026-10-08 之前写的采购加库存流水
   这一列仍为空。要"从流水反查批次"时，只有**这次改动之后**写的那批查得到。

## 8. 交付物 / 版本

- 分支：`fix/purchase-ledger-batch-link`（worktree `.local/purchase-ledger-batch-link`）
- 基线：`origin/main` = `4b1b0d7`（PR #256 合并后）
- PR：_（回填）_
- CI：_（回填）_
