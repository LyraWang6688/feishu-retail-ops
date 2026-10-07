# 到货落点改到「报货批次」那一行（2026-10-07）

业务负责人口径（逐字）：

> 「我们到货验收数据表需要写入的点**变到了报货批次里面**。到货日这些是**多表关联的自动字段**，
>  所以你现在要做的，就是把原本写到到货验收数据表里的字段改写到报货批次里：
>  **1. 验收原话：改写到报货批次  2. 验收人：改写到报货批次  3. 确认状态：改到报货批次**
>  也就是说，我们要把原来到货信息数据表里的落点改写到报货批次里面，
>  **「采购入库.采购到货批次」字段删除了，不需要了**，你重新看下～」

生产真表（本机看不到生产，以业务负责人给的只读核对结果为准）：

- 「到货验收」表**已被她删除**（schema 里的 tableId `tblvLOXKESNTbZ7v` 已不存在）；
- 「报货批次」= 11 列，其中 `验收原话`[文本] / `验收人`[创建人=自动, type 1003] / `确认状态`[文本]；
  另有 `到货日`[更新时间=自动]；
- 「采购入库」= 10 列，`采购到货批次` 已删除。

---

## 一、改完之后应该是什么样（验收标准）

| # | 验收标准 |
| - | -------- |
| AC1 | `V1_BITABLE_SCHEMA.tables` 里**没有** `purchaseArrival`；`v1SchemaScopes.purchase` 不再列它；全仓（`server/src`、`server/public`、`server/scripts`）不再引用这个表键，也不再引用表名「到货验收」（历史沿革注释除外） |
| AC2 | `purchaseOrderBatch.fields` **新增** `acceptanceText: '验收原话'`、`confirmStatus: '确认状态'`；**不新增** `到货日` / `验收人` 的映射（飞书自动字段，代码不读不写） |
| AC3 | `purchaseInbound.fields` **没有** `batch`（「采购到货批次」已删除）；`confirmArrival` 写「采购入库」时载荷里只有 编号 / 尺码 / 数量 / 采购行为 / 采购申请（不含 采购到货批次、不含 入库时间） |
| AC4 | 点「是」确认到货之后：**「报货批次」那一行**上出现 ① `验收原话` = 她说的累积原话、② `确认状态` = 已确认、③ `到货状态` = 已到货；**不再**创建「到货验收」行（表都不存在，代码里也没有这个写点） |
| AC5 | 幂等：重复点「是」/ 飞书重投 → 批次行不重复创建、采购入库不重复写、库存不重复加；幂等键从「到货记录 id」换成**批次 record id**（见第三节清单） |
| AC6 | 全链路（12 件那种多行到货核对）走通：明细 → 卡片 → 点「是」→ 批次行落点 + 采购入库逐行 + 库存 |
| AC7 | 9 点推送**不受影响**：仍按「报货批次.到货状态 == `config/purchaseArrivalStatus` 里的 pending」筛（`purchasePendingBatchService` 一行不改） |
| AC8 | 工作台：`/api/workbench/purchase/arrivals` 改读「报货批次」并投影批次级的 到货状态 / 确认状态 / 验收原话；前端「到货验收情况」面板同步（最小处置，见第五节） |
| AC9 | 配置先行：确认状态字面量进 `config/purchaseAcceptance.js`（**不写死在 service 里**）；到货状态继续走 `config/purchaseArrivalStatus.js` |
| AC10 | 代码不写任何飞书自动字段：「到货日」（更新时间）、「验收人」（创建人）既无映射也无写入点 |
| AC11 | 全量 `node --test --test-concurrency=1` 连跑 2 次 fail=0 |

---

## 二、关键 diff（实现落点）

### 2.1 schema（`server/src/config/v1BitableSchema.js`）

- **删** `purchaseArrival` 整段（表已不存在，留着部署闸门 `v1:schema-check:all` 必红）。
- **删** `purchaseInbound.fields.batch`（「采购到货批次」已删除；继续写会报「未配置语义字段」）。
- **加** `purchaseOrderBatch.fields.acceptanceText = '验收原话'`、`confirmStatus = '确认状态'`。
- 表名 `到货验收` 在 `purchaseArrivalIntake` 的历史注释里保留（历史沿革，不改）。

### 2.2 到货确认落点（`purchaseArrivalConversationService` + `purchaseOrderBatchService`）

- `createArrivalRecord`（往「到货验收」建行）→ **删除**，换成 `writeAcceptanceToBatch(task)`：
  按**批次 record id**（拿不到就按**批次号**回查）定位「报货批次」那一行，把 `验收原话` 写上去。
- `confirmArrival` 收尾那一步
  `gateway.update('purchaseArrival', …, { confirmStatus: '已确认' })`
  → `orderBatches.markConfirmed({ batchRecordId, batchNo })`，写的是**批次行**的 `确认状态`。
- `到货状态 = 已到货` 继续由既有的 `notifyBatchArrived → markArrived` 负责（**不重复写、不冲突**）。

### 2.3 幂等 / 关联键替换（`arrival_record_id` → 批次 record id）

| 位置 | 改前 | 改后 |
| ---- | ---- | ---- |
| `utils/correlationFields.js` 白名单 | `purchase_arrival_record_id`（「采购到货」那条记录） | `purchase_batch_record_id`（「报货批次」那条记录） |
| `purchaseWebhookService.purchaseCorrelation` | 形参 `arrivalRecordId` | 形参 `batchRecordId` |
| 到货任务草稿 | `draft.arrival_record_id` | `draft.batch_record_id`（任务上已有的那个键） |
| 到货任务记录 | `task.arrival_record_id`（建完落盘） | **删除**：批次 record id 本来就在任务上（`batch_record_id`），不再需要第二个 id |
| `ensureArrivalProducts` 的 correlation / 日志 | `arrivalRecordId: draft.arrival_record_id`、日志键 `arrival_record_id` | `batchRecordId: draft.batch_record_id`、日志键 `batch_record_id` |
| `purchaseInbound` 幂等回查 | 按 `采购入库.采购到货批次 == 到货记录 id` 回查 | 按 `采购入库.采购申请 ∈ 这一批的申请行` 回查（字段没了，只能换判据） |
| 收尾日志 `purchase.arrival.posted` | `arrival_record_id` | `batch_record_id` |

### 2.4 采购入库写入

`batch: relation(arrival.arrival_record_id)` **删除**；其余（编号 / 尺码 / 数量 / 采购行为 / 采购申请）不变。

### 2.5 工作台处置（AC8 的理由）

选 **「改读报货批次」**，不是「摘掉面板」：她要看的「这一批到货了没有、核对确认了没有」
正好就是「报货批次」那一行的三列，改读之后面板仍有信息量；
而摘掉面板等于把一个能用的视图删掉。改动面很小（后端一个投影函数 + 前端一列文案），
所以**前端不需要"最小处置"降级**。

- 后端 `purchaseQueryService.listPurchaseArrivals` 改成读 `purchaseOrderBatch`，
  投影 `batch_no / arrival_status / confirm_status / acceptance_text`。
- 前端「到货验收情况」子标签**保留**，列改成 报货批次号 / 到货状态 / 确认状态 / 验收原话。
- ⚠️ 不再显示「到货日」：它在真表上是**更新时间**（自动字段），且批次行会因为写附件等原因被刷新，
  把它当"到货日"展示会误导；代码里也**不为它建映射**（AC2 / AC10）。

---

## 三、`arrival_record_id` → 批次 record id 的替换清单

| # | 位置 | 改前 | 改后 |
| - | ---- | ---- | ---- |
| 1 | `utils/correlationFields.js` 白名单 | `purchase_arrival_record_id` | `purchase_batch_record_id` |
| 2 | `purchaseWebhookService.purchaseCorrelation` | 形参 `arrivalRecordId` | 形参 `batchRecordId` |
| 3 | 到货任务草稿 | `draft.arrival_record_id` | `draft.batch_record_id`（任务上已有的键） |
| 4 | 到货任务记录 | `task.arrival_record_id`（建完行再落盘） | **删除**（批次 record id 本来就在任务上，见 `readBatchRecordId`） |
| 5 | `ensureArrivalProducts` correlation | `arrivalRecordId: draft.arrival_record_id` | `batchRecordId: draft.batch_record_id` |
| 6 | `ensureArrivalProducts` 成本冲突日志 | `arrival_record_id` | `batch_record_id` |
| 7 | `purchaseInbound` **远端回查判据** | `采购入库.采购到货批次 == 到货记录 id` | `采购入库.采购申请 ∈ 本批的申请行`（**字段没了，只能换判据**） |
| 8 | `purchase.arrival.posted` 日志 | `arrival_record_id` | `batch_record_id` |
| 9 | `purchaseArrivalConversationService` 收尾日志 | `arrival_record_id` | `batch_record_id` |
| 10 | `purchaseArrivalConversationService.confirmLocked` | 先 `createArrivalRecord` 拿 id、再落盘 `task.arrival_record_id` | 整段删除（不再建行、不再需要这个 id） |

**correlation 的 `purchase_arrival_record_id` 改成了什么/为什么**：
改成 **`purchase_batch_record_id`**（「报货批次」那一行的 record_id）。
理由：这个键的语义是"**这条日志属于哪一批的到货那一段**"，落点从「到货验收」那一行
搬到「报货批次」那一行 ⇒ 指向同一件事的那个 id 换成了批次记录 id。
**没有删掉这个键**（不是不需要溯源）：批次级动作还能靠 `batch_no` 串，
但"那一行具体是哪条记录"仍然是有用的排查信息，而且与 `purchase_report_record_id` 同族、命名自解释。
⚠️ 为什么不叫 `batch_record_id`：本仓采购链路日志里 `batch_no` 已经是"批次号"，
再放一个同前缀的 `batch_record_id` 会让人混（一个号、一个记录 id）。

---

## 四、证据

### 4.1 先红后绿（改动前的 `main` = `f3bd452`）

把新用例 `server/test/arrivalLandingOnBatch.test.js` 与改写后的
`server/test/purchaseTableRenameSync.test.js` 原样放到 `main`（工作区未改动的源码）上跑：

```
$ node --test --test-concurrency=1 test/arrivalLandingOnBatch.test.js test/purchaseTableRenameSync.test.js
ℹ tests 21 / ℹ pass 8 / ℹ fail 13        # exit=1   （完整输出留档 /tmp/red-on-main.log）
```

其中代表性失败（**逐字**）：

```
✖ ① 点「是」之后：到货信息的落点 = **「报货批次」那一行**（三个值都在、且互不冲突）
  AssertionError [ERR_ASSERTION]: 验收原话（她说的原话）
    actual: undefined   expected: '都到了\n完毕'
  —— 改动前她写的原话进了「到货验收」那一行，批次行上**什么都没有**

✖ ④-2 崩溃恢复：本地 inbound_created 丢了 → 靠**采购申请关联**认出已写过的入库行，不重复写
  AssertionError [ERR_ASSERTION]: 4 !== 2
  —— 把已写入库行上的「采购到货批次」抹掉（= 生产现在的形状）后，改动前的回查判据
     永远认不出已写过的两行 ⇒ **重复建了两条入库**

✖ B5 「到货验收」表的读写点全清：全仓不再引用这个表键（去注释后扫描）
  offenders: src/config/v1BitableSchema.js: 还在用 purchaseArrival 这个表键；…
```

改动后（同一批用例，本分支）：

```
$ cd server && node --test --test-concurrency=1 test/arrivalLandingOnBatch.test.js test/purchaseTableRenameSync.test.js
ℹ tests 21 / ℹ pass 21 / ℹ fail 0
```

### 4.2 全量（`node --test --test-concurrency=1`，**连跑 2 次**，在独立 worktree 里）

```
run1: ℹ tests 1224 / ℹ pass 1224 / ℹ fail 0   (exit=0)
run2: ℹ tests 1224 / ℹ pass 1224 / ℹ fail 0   (exit=0)
```

### 4.3 CI

`gh pr checks` / `gh pr view --json mergeStateStatus` 的实际输出见本 PR 描述
（合入前必须是 `CLEAN`；**禁止 `--admin`**）。

---

## 五、验收标准逐条对照

| # | 验收标准 | 结果 | 证据 |
| - | -------- | ---- | ---- |
| AC1 | schema 无 `purchaseArrival`；purchase 范围不再列它；全仓不再引用这个表键 | ✅ | `purchaseTableRenameSync.test.js` 的 A3 / B5（去注释后扫 `src`+`public`+`scripts`，是绿的） |
| AC2 | `purchaseOrderBatch` 加 `acceptanceText='验收原话'`、`confirmStatus='确认状态'`；**不**加 到货日 / 验收人 映射 | ✅ | A3 逐字断言 `Object.values(batch)` 不含「到货日」「验收人」 |
| AC3 | `purchaseInbound` 无 `batch`；入库载荷只含 编号/尺码/数量/采购行为/采购申请 | ✅ | A3 ＋ `arrivalLandingOnBatch.test.js` ③（`deepEqual` 列名，多一列都红） |
| AC4 | 点「是」后**批次行**上出现 验收原话 ＋ 确认状态 ＋ 到货状态=已到货；不再建「到货验收」行 | ✅ | `arrivalLandingOnBatch.test.js` ①（同一行三个值）＋ ②（全链路一次 `purchaseArrival` 写入都没有）；`arrivalConversation.test.js` 点「是」① 同形 |
| AC5 | 幂等：重复点「是」/ 本地落盘丢失都不重复写（批次行 / 入库 / 库存） | ✅ | `arrivalLandingOnBatch.test.js` ④-1 / ④-2 / ④-3；`arrivalConversation.test.js` 点「是」⑥ |
| AC6 | 12 件全链路走通 | ✅ | `arrivalLandingOnBatch.test.js` ⑤（3 行 0 双、9 行入库、批次行三个值都在）＋ `arrivalConversation.test.js` 0 双①②③ |
| AC7 | 9 点推送不受影响（仍按 到货状态=未到货 筛） | ✅ | `arrivalLandingOnBatch.test.js` ⑥ / ⑥-补（同一台假 Base 前后对照：确认后不再进候选）＋ `purchasePendingBatchService` **一行未改** |
| AC8 | 工作台到货面板改读「报货批次」 | ✅ | `purchaseTableRenameSync.test.js` B7 / B8 ＋ `purchaseQueryService.test.js` 改写后的两条用例 |
| AC9 | 配置先行：确认状态字面量进 `config/purchaseAcceptance.js` | ✅ | `purchaseArrivalStatus.test.js` 的三条新用例（默认值 / 换值 / 空串抛错） |
| AC10 | 代码不写飞书自动字段（到货日 / 验收人） | ✅ | `arrivalLandingOnBatch.test.js` ⑦（遍历**所有**写入载荷 + 源码级语义键断言）＋ `purchaseOrderBatchService` 的 `wrote_arrival_date/inspector: false` 日志 |
| AC11 | 全量连跑 2 次 fail=0 | ✅ | 见 4.2 |

---

## 六、需要她知情 / 拿不准的判断（**不是"已确认"**）

1. **孤儿调用（草稿上既没有批次号也没有批次记录 id）→ 不阻塞入库**：
   到货信息的两步写入会**跳过**（各记一条日志）。理由：这是历史草稿 / 手工种的任务的形状，
   入库能力本身不该被它挡住（改动前也有一条"没有批次也照样入库"的用例）。
   ⚠️ 真在群里走对话链路时**批次号一定有**，所以生产上不会走到这条分支。
2. **有批次身份但批次行找不到 → 当场停下来报错（不入库）**：
   "到货信息没有落点"= 她这次确认没被记下来，宁可让她看见失败，也不入库了却没有记录。
   ⚠️ 这与**到货状态**（`notifyBatchArrived`）的处置**故意不同**：后者是**投影**，失败只 warn。
3. **工作台面板选择「改读报货批次」而不是「摘掉面板」**（理由见 2.5）；
   ⚠️ 顺带**删掉了「到货验收」那张表单的快捷入口卡**（表被删 ⇒ 表单打不开），
   如果她希望保留那个入口，需要她重新建表/表单后我们再挂回去。
4. **`采购入库` 的远端回查判据**从「采购到货批次」换成「采购申请关联」：
   一个批次的入库行都挂在这批的申请行上，所以"这批的申请行"是等价身份；
   ⚠️ 唯一副作用：如果某一行**没能挂上采购申请**（找不到对应的申请行），
   崩溃恢复时回查认不出它 —— 但那种情况下本地 `inbound_created` 仍然兜底，
   需要"远端写入成功、本地落盘也失败"的双重故障才会用到远端回查。
5. **本机测试 Base 与生产形状不一致**：生产已删「到货验收」表、已删「采购到货批次」列，
   而本机 `.env` 指向的测试 Base 可能还带着它们 ⇒ 本机 `pnpm run v1:schema-check:purchase`
   的结论**只在"缺字段"方向可信**（AGENTS.md 第 11 条③）。**部署前必须在服务器上对着生产跑一次闸门。**
6. 本任务**未验证**（也无从验证）：生产 Base 里「报货批次.确认状态」这一列的**真实类型**
   （brief 说它是**文本**）。若不是文本（例如单选），写「已确认」可能触发飞书自动建选项 ——
   代码侧已把取值做成配置（`PURCHASE_ACCEPTANCE_CONFIRMED_STATUS`），
   但**建议她在服务器上跑一次 `v1:schema-check:all`，或让我们只读核一眼该列类型**。

