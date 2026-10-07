# 「采购入库」表被整表删除 ⇒ 到货链路只保留「更新报货批次 + 加库存」（2026-10-07 深夜）

> 本文是**先写的验收标准**（业务纪律：先写"按我们的链路应该实现的效果"，再动手），
> 第 6 节起是**改动后的逐条对照**与证据。

## 0. 业务负责人的口径（逐字）

> 「甲 **不再写任何入库明细**：只更新「报货批次」（到货状态=已到货 + 验收原话 + 确认状态）
>  + **加库存**（库存流水 / 实时库存照写）—— 也就是"**入库明细表整个不要了**"」

生产真表事实（Lead 2026-10-07 23:5x 只读核过）：

| 表 | tableId | 事实 |
| --- | --- | --- |
| ~~采购入库~~ | ~~`tblK3Uzd0nN1GJrr`~~ | **已被她整个删除**（Base 里查不到） |
| 具体信息 → **报货信息** | `tbli1ygPtss5CWCH`（不变） | 仍是 11 列 |
| 报货批次 | `tblwezby9wRea9qi` | 11 列；⚠️**确认状态已从文本改成单选** |
| 信息填写 | `tblo0ffzFt7vyQw2` | 14 列（未变） |

## 1. 改动前的事实基线（本机只读侦察）

- `inventoryService.applyPurchase(input)` 用 `input.purchaseInboundRecordId` 做两件事：
  ① `operationId(kind, source)` —— **本地幂等键**；
  ② `STOCK_MOVEMENTS[采购增加].ledgerSource = 'purchaseInbound'` ⇒ 写
     「库存流水.**关联采购**」= 关联到**已删除的「采购入库」**。
- `purchaseWebhookService.confirmArrivalLocked` 里「采购入库」的写入/读取点：
  `gateway.table('purchaseInbound')` · `listAll('purchaseInbound')`（回查已写过的行）·
  `create('purchaseInbound', …)` · `draft.inbound_created` 落盘 ·
  `store.update({ inbound_record_ids })` · 为入库行的「采购行为」做的
  `PURCHASE_BEHAVIORS.INBOUND`(`PURCHASE_IN`) 行为查找。
- schema：`V1_BITABLE_SCHEMA.tables.purchaseInbound` 整段；
  `inventoryLedger.fields.purchaseInbound = '关联采购'`；
  `v1SchemaScopes` 的 `purchase` / `inventory` 两个范围 + `V1_SIZE_LINK_TABLES` 都含它。
- `config/purchaseBehaviors.js` 的**唯一**消费者就是那个入库行的「采购行为」⇒ 会成孤儿。
- ⚠️ **本机看不到生产**：本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` 与
  `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值**（27 字符，md5 `7d2c77bfca91a3db6987cfd0e16cc80e`）⇒
  本机只能读测试 Base。测试 Base 的「库存流水」**仍有**「关联采购」(SingleLink)、
  「报货批次」**只有 4 列**（远落后于生产）。

## 2. 验收标准

### A. 到货链路不再写任何入库明细

- **A1** 全仓（`src` / `public` / `scripts` / `test`）不再引用表键 `'purchaseInbound'`、
  环境变量 `FEISHU_V1_PURCHASE_INBOUND_TABLE_ID`、`tables.purchaseInbound` / `table('purchaseInbound')`；
  `V1_BITABLE_SCHEMA.tables.purchaseInbound === undefined`。
- **A2** 一次完整到货确认（话题里说原话 → 点卡片「是」）之后，记录型 gateway 上
  **没有任何** `purchaseInbound` 的 create/update/delete。
- **A3** `config/purchaseBehaviors.js`（`PURCHASE_IN`）随入库行一起退场：不再有读取点。

### B. 「加库存」必须保住（不能顺手把入库能力废掉）

- **B1** 12 件那种多行：**逐条**（货品+尺码）调 `inventory.applyPurchase`，
  数量 = **实际数**，`state` 仍按「该货号还没有样品 → 样品；有 → 门盒」。
- **B2** 库存幂等键（本地 `source_record_id`）改成**真实三元组**
  `批次记录id | 货品record_id | 尺码`（原键是「采购入库」行 id，那张表没有了）
  ⇒ 同一个 (货品+尺码) 重复调用、或崩溃后重放，用**同一个键**。
- **B3** 「库存流水.关联采购」：**远端一个字都不传**（不编 id）——
  `MOVEMENT_PURCHASE_INCREASE.ledgerSource = null`，schema 里 `inventoryLedger.purchaseInbound` 删除。
- **B4** 崩溃恢复：本地任务草稿里的进度丢了之后重放 ⇒ 会对同一个键**再调一次**
  `applyPurchase`；用**真实** `InventoryService` + `JsonTaskStore` 钉住
  「流水只有一条、实时库存只加一次」（幂等由库存自己的本地日志兜住）。

### C. 「报货批次」三个值照写

- **C1** 到货状态 = 配置里的「已到货」（`config/purchaseArrivalStatus.js`，由对话链路写）。
- **C2** 验收原话 = 她的原话（**入库之前**写；写的是同一个值 ⇒ 幂等）。
- **C3** 确认状态 = 配置里的值（`PURCHASE_ACCEPTANCE_CONFIRMED_STATUS`，当前 `已确认`；**入库之后**写）。
- **C4** 飞书自动字段一个都不写：不写「报货日」「到货日」「验收人」（payload 里没有这些物理列名）。

### D. 幂等 / 重放不重复加库存

- **D1** 重复点「是」（飞书重投）：批次行 / 库存都不重复；第二次按 `status=posted` 早退。
- **D2** 同一个 taskId 的并发确认走 `confirmationQueue` 串行，不重复加库存。

### E. 9 点推送不受影响

- **E1** 候选口径逐字不变：`PurchasePendingBatchService.listPendingBatches()` 仍只按
  「报货批次.到货状态 = 未到货」筛；确认过的批次**不在**候选里。
  （`pendingDealPush*` 一个文件都不改。）

### F. 表名同步：具体信息 → 报货信息

- **F1** `V1_BITABLE_SCHEMA.tables.purchaseRequest.tableName === '报货信息'`（**tableId 不变**）。
- **F2** 用户可见文案不再出现「具体信息」（工作台采购页 4 处 → 「报货信息」）。
- **F3** 语义键名 `purchaseRequest` / 各字段语义键**一个都不动**。

### G. 配置先行 + 部署闸门

- **G1** 「报货批次.确认状态」现在是**单选** ⇒ 把它的取值纳入**单选取值契约**：
  `v1:schema-check:purchase` 对着真表 `property.options` 校验（含 `已确认`）。
  ⚠️ 取值**不自己改**；不一致时闸门**判红**（而往单选写不存在的取值，飞书会**自动建选项** ⇒ 表被污染）。
- **G2** `v1SchemaScopes` 不再含 `purchaseInbound`（purchase / inventory 两个范围 + 尺码关联表清单）。

### H. 边界（不碰）

- **H1** 销售侧任何文件 / `pendingDealPush*` / `src/app.js` 零改动。
- **H2** 不写任何生产表；不部署（部署要业务负责人当次命令）。

## 3. 实现（贴合"解耦 · 模块化 · 配置先行"）

| 文件 | 改动 |
| --- | --- |
| `src/config/v1BitableSchema.js` | 删 `purchaseInbound` 整段；删 `inventoryLedger.purchaseInbound`；`purchaseRequest.tableName` → `报货信息`；`confirmStatus` 注释同步为单选 |
| `src/config/v1SchemaScopes.js` | 两个范围与尺码关联清单去 `purchaseInbound`；单选取值契约改为**两条** |
| `src/config/purchaseAcceptance.js` | 注释同步（文本→单选）+ 新增 `purchaseAcceptanceOptionContract` |
| `src/config/purchaseBehaviors.js` | **删除**（`PURCHASE_IN` 的唯一消费者已消失） |
| `src/services/inventoryService.js` | `MOVEMENT_PURCHASE_INCREASE.ledgerSource = null`；`applyPurchase` 的来源键换成真实三元组 |
| `src/services/purchaseWebhookService.js` | `confirmArrivalLocked` 删掉全部入库明细写入/回查；保留逐条 `applyPurchase` + 批次行写入 |
| `src/services/purchaseArrivalConversationService.js` | 只改注释（它本来就不写业务表） |
| 工作台 `public/workbench/features/purchase/index.js` | 文案「具体信息」→「报货信息」 |
| `scripts/test_inventory_e2e.js` / `scripts/e2e-run.mjs` / `scripts/list-v1-fields.js` | 去掉对已删表/已删映射的引用 |

## 4. 先红后绿

新用例 `server/test/purchaseInboundRemoval.test.js`（10 条）**在改动前**跑：

```
$ node --test --test-concurrency=1 test/purchaseInboundRemoval.test.js
✖ ① 守门：全仓（src/public/scripts/test）不再引用已删除的「采购入库」表
✖ ①-补 schema / 范围 / 尺码关联清单里都没有它了；「关联采购」映射也删了
✖ ①-补2 「采购入库」行的「采购行为」配置随入库行一起退场（不再有读取点）
✖ ① 到货确认真实链路：一碰「采购入库」表就抛 —— 全程零访问、零写入；库存照加 12 次
✖ ② 真实库存引擎：12 行 → 9 条流水 / 9 双实时库存；`inventory.change.applied` 9 条
✖ ④ 幂等：草稿里的进度丢了（崩溃恢复）→ 重放用**同一个来源标识**，流水仍 9 条、库存仍 9 双
✖ ④-补 来源标识由**真实三元组**（批次记录 id | 货品 | 尺码）决定，一个都不是编的
✖ F 「具体信息」已改名「报货信息」：tableName 同步、tableId 与语义键一个都没动
✖ F-补 工作台采购页的用户可见文案里没有「具体信息」了
✖ G 「报货批次.确认状态」现在是**单选** ⇒ 取值纳入部署闸门的单选取值契约
ℹ tests 10
ℹ pass 0
ℹ fail 10
```

典型的失败原文（三类，逐字）：

```
AssertionError: 她的口径：这张表现在叫「报货信息」  '具体信息' !== '报货信息'
Error: 已删除的表不许再被访问：purchaseInbound        （严 gateway：连读都不许读）
AssertionError: 已删除的表不许再被引用：
  scripts/e2e-run.mjs（读/写它的字段映射）
  scripts/test_inventory_e2e.js（表键、表 ID 环境变量）
  test/arrivalConversation.test.js（表键）…
```

改动后同一文件：**10/10 通过**（见第 6 节）。改完源码后跑的全量与 CI 证据也在第 6 节。

## 5. 待业务负责人/Lead 只读核的两条（本机核不到）

1. 「库存流水」`tbl7Xo4OPmaN2NdP` 上**还有没有**「关联采购」列？若有，指向哪张表？
2. 「报货批次.确认状态」单选的**选项名清单**里有没有 `已确认`？

→ 处置见第 7 节「不确定处」。

---

## 6. 逐条对照（改动后）

| 标准 | 结论 | 证据 |
| --- | --- | --- |
| **A1** 全仓不再引用已删表 | ✅ | 新用例 ①（扫 `src`/`public`/`scripts`/`test` 去注释后**零命中**，本文件是唯一"抓这个词"的尺子、自我排除） |
| **A2** 一次到货确认**零** `purchaseInbound` 写入 | ✅ | 新用例 ①（gateway 一被碰就抛，全程零访问/零写入）＋ `arrivalLandingOnBatch` ③（`create` 集合为空） |
| **A3** 入库行的「采购行为」配置退场 | ✅ | 新用例 ①-补2（`config/purchaseBehaviors.js` 不存在，src 里零 `PURCHASE_BEHAVIORS` 读取点） |
| **B1** 逐条加库存（12 件那种） | ✅ | 新用例 ②（9 行 → 9 条流水 / 9 双实时库存；`inventory.change.applied` 9 条）＋ `arrivalLandingOnBatch` ⑤（12 行里 3 行 0 双 → 9 次） |
| **B2** 来源标识 = 真实三元组且重放稳定 | ✅ | 新用例 ④-补（`source_record_id` 含真实批次记录 id / 货品 / 尺码）＋ `arrivalLandingOnBatch` ④-2（重放逐字同一组标识） |
| **B3** 「库存流水.关联采购」远端一个字不传 | ✅ | 新用例 ①-补（映射已删、`ledgerSource=null`）＋ ②（流水载荷里没有「关联采购」） |
| **B4** 崩溃恢复不重复加库存 | ✅ | 新用例 ④（本地进度抹掉后重放：流水仍 9、实时库存仍 9、库存任务仍 9 条 —— **真实** `InventoryService` + `JsonTaskStore`） |
| **C1** 到货状态 = 已到货 | ✅ | `arrivalLandingOnBatch` ①（批次行三值齐）+ ⑥-补（确认后不再进 9 点候选 = 状态真的变了） |
| **C2** 验收原话 | ✅ | `arrivalLandingOnBatch` ①/④-3（只写一次、写同一个值） |
| **C3** 确认状态 = 配置值 | ✅ | `arrivalLandingOnBatch` ①（`'已确认'` 来自 config） |
| **C4** 不写飞书自动字段 | ✅ | `arrivalLandingOnBatch` ⑦（任何载荷都没有「到货日」「验收人」） |
| **D1** 重复点「是」幂等 | ✅ | `arrivalLandingOnBatch` ④-1、`arrivalConversation` 点「是」⑥ |
| **D2** 并发确认不重复 | ✅ | `purchaseWebhookService` A2（`confirmationQueue` 串行，库存只加一次） |
| **E1** 9 点推送不受影响 | ✅ | `arrivalLandingOnBatch` ⑥/⑥-补（候选仍只按 到货状态=未到货 筛；确认后摘掉）；`pendingDealPush*` **一个文件都没改** |
| **F1/F2/F3** 表名 具体信息→报货信息 | ✅ | 新用例 F（`tableName` + tableId 不变 + 语义键没动）、F-补（工作台文案已换）；`purchaseTableRenameSync` A1/A3 同步 |
| **G1** 确认状态纳入单选取值契约 | ✅ | 新用例 G（契约含 `已确认`）+ `validateV1Schema` 新增用例（不是单选 / 缺选项 → 闸门判红） |
| **G2** scopes 去 `purchaseInbound` | ✅ | 新用例 ①-补 |
| **H1/H2** 边界 | ✅ | 改动文件清单里**没有**销售侧文件 / `pendingDealPush*` / `src/app.js`；全程只读生产（本机根本够不着），未部署 |

### 6.4 全量测试（worktree 内，`node --test --test-concurrency=1`）

**连跑 2 次，均 `fail 0`**：

```
$ cd .local/wt-purchase-inbound-removal/server && pnpm test   # 第 1 次
ℹ tests 1309
ℹ pass 1309
ℹ fail 0
exit=0

$ pnpm test                                                    # 第 2 次（紧接）
ℹ tests 1309
ℹ pass 1309
ℹ fail 0
exit=0
```

（中间两次带失败的运行是**修的过程中**的中间态：第 1 次 12 条、第 2 次 2 条 —— 其中 1 条是
`purchaseReturnBatch` 的偶发时序问题，单跑 12/12 通过，见第 7 节⑥。）

### 6.5 CI

（PR 页 `gh pr checks` 的证据见交付说明；本仓库必需检查 = **server tests / test** + **CodeQL**。）

---

## 7. 不确定处 / 如实说明

① 🔴 **「库存流水.关联采购」的实际形状，本机核不到**（本机 `.env` 指向测试 Base，看不到生产）。
   ⇒ 按"**远端一个字都不传**"处置：`MOVEMENT_PURCHASE_INCREASE.ledgerSource = null`，
   schema 里 `inventoryLedger.purchaseInbound` 删除，**绝不编一个 id 指过去**。
   · **代价**（如实）：采购加库存的流水**不再能回指来源**；崩溃恢复少一层"按来源回查流水"的
     兜底，强度与**采购退货**相同（靠本地 `operation.ledger_record_id` + 落盘的进度）。
   · **如果实际是"她把这列改指到别的表了"**：只改两处（`ledgerSource: '<新语义键>'`
     + `v1BitableSchema` 补一条映射），**幂等键与业务流程一行都不用动**。
② ⚠️ **「报货批次.确认状态」的单选项名，本机核不到**。
   ⇒ 取值**一个字没改**（`PURCHASE_ACCEPTANCE_CONFIRMED_STATUS` 仍是 `已确认`），但我把它
   **纳入部署闸门的单选取值契约**：服务器上跑 `pnpm run v1:schema-check:purchase` 会给结论 ——
   **缺这个选项就闸门判红**（而**不会**让飞书自动建选项把表污染掉）。
   ⚠️ 若闸门报缺选项：**停下报告**，由她决定是加选项还是改配置值（我不动选项名）。
③ ⚠️ **顺手修的一处"与本口径无关、但会挡住 CI"**：
   `server/test/purchaseBatchNoGeneration.test.js` 的 ②⑥ 把日期写死成 `20261007`，而生成器按
   **上海时区**取"今天" ⇒ 上海时间 2026-10-08 00:00 之后这两条**永远红**。
   **已在 pristine main 上实测同样红**（不是本改动引入）——改成给这两条注入固定时钟
   （与本文件其它用例 `now: () => 2026-10-07T02:00:00Z` 同一种做法）。
   ⚠️ 没有这一步，**任何** PR 的 CI 都是红的（每天上海 00:00 之后必红），所以它是本次的前置修复。
④ ⚠️ **删除 `config/purchaseBehaviors.js` 是我的判断**：它的唯一消费者（入库行的「采购行为」）
   随表消失 ⇒ 按"不留孤儿"删掉（知识留在本文与 `inventoryService` 的注释里）。
   若想学 `purchaseArrivalIntake.js` 那样"刻意保留、注明无读取点"，说一声，我改回来。
⑤ ⚠️ **本机 `v1:schema-check:purchase` 预期会红**：测试 Base 的「报货批次」**只有 4 列**
   （远落后于生产）⇒ 闸门必须在**服务器上**对着生产跑。
⑥ ⚠️ **一处偶发时序（未改，如实列出）**：`server/test/purchaseReturnBatch.test.js:410`
   在全量跑时偶发 `TypeError: Cannot read properties of undefined (reading 'length')`
   （断言「报货批次」那一行时它还没建）；**单跑 12/12 通过**，两次连跑全量也都是绿的。
   它属于**既有**用例的时序脆弱性，本 PR 未触碰（怕混进不相干的改动）。
⑦ ⚠️ **工作台两处历史漂移**（不在本次口径内，**未改**，请指示要不要收）：
   · 采购页筛选下拉里的「部分到货 / 已全部到货」——「报货批次.到货状态」真表选项是
     **未到货 / 已到货**（配置里就这两个）；
   · 到货页筛选下拉里的「待确认 / 已入库 / 入库失败 / 已取消」——「确认状态」现在是
     **单选**，选项清单本机核不到（同②）。

