# 时间字段写入收口：除「收款时间」外代码一律不写 — 执行报告

- 日期：2026-10-06
- 分支：`fix/no-time-field-writes`（从最新 `origin/main` 开；PR base = `main`）
- 生产 Base：🔴 **全程只读**（在服务器上用项目自己的 gateway 读字段，不写一个字）
- 测试 Base / 本地 `.env`：未改；服务器代码 / `.env` / 进程：**未动**（只往 `/tmp` 放了一次性只读脚本）

---

## 0. 口径（业务负责人 2026-10-06，已确认两轮）

> 「关于时间的，我们代码这边应该除了"收款"那个需要写入，其他时间其实我在飞书里面都已经设置了，
>  它们是自动创建的字段」；对我列出的写入点她又回：「这些都不需要了，你可以看下，没有相关字段了」。

⇒ **唯一允许代码写的时间字段 = `receivedAt`（「收款时间」）**；
其余时间字段代码零写入，交给飞书自动字段（表里的「创建时间」`type=1001` / 「更新时间」`type=1002`）。

## 0.1 验收标准（先写，后跑）

| # | 标准 | 结论 |
|---|---|---|
| ① | 代码里**唯一**写时间字段的地方 = `receivedAt`（收款时间） | ✅ 达标（见 §2、§3） |
| ② | 其余时间字段**代码零写入**（grep 可证） | ✅ 达标（见 §2） |
| ③ | 删掉映射的字段**必须在生产真表里确实不存在** | ✅ 达标：`报单时间`、`入库时间` 真表都没有（见 §1） |
| ④ | `v1:schema-check:all` 在服务器上跑 **GREEN**（新 schema 注入） | ✅ `GATE_RESULT=GREEN`（见 §5） |
| ⑤ | 全量测试连跑 2 次 `fail=0` | ✅ 见 §4 |

---

## 1. ⭐ 生产真表只读核对（本次最关键的调查）

做法：服务器 `/tmp` 一次性只读脚本，`require('/opt/box2bitable/server/...')` 用**项目自己的**
`V1BitableGateway.listFields` 读生产 Base（`FEISHU_V1_BITABLE_APP_TOKEN` 在服务器上指向生产）。
只调 `appTableField.list`，不写、不改、不重启、不打 secret。

| 表 | 真表列数 | 「发生时间」 | 「入库时间」 | 「报单时间」 | 自动时间列 |
|---|---|---|---|---|---|
| 供应商对接（purchaseReport） | 14 | ✗ 无 | ✗ 无 | **✗ 无** | 创建时间(1001) / 更新时间(1002) |
| 采购入库（purchaseInbound） | 11 | ✗ 无 | **✗ 无** | ✗ 无 | 创建时间(1001) / 更新时间(1002) |
| 库存流水（inventoryLedger） | 10 | ✗ 无 | ✗ 无 | ✗ 无 | 创建时间(1001) / 更新时间(1002) |
| 客户往来货款（customerCredit） | 12 | **✅ 还在** | ✗ 无 | ✗ 无 | 创建时间(1001) / 更新时间(1002) |

### ⭐ 结论：「发生时间」在真表里到底有没有？——**分表回答**

- **「库存流水」里：没有。** 它 2026-10-05 就被业务负责人从生产表删掉了，代码里的映射
  也在 `662cf0e`（已在 `origin/main`）同步删除 —— 所以**本次这一处无事可做**（任务书里
  「库存流水 fields 约 :200 删 `occurredAt`」的定位已过时：`v1BitableSchema.js:200` 那一行
  实际属于**客户往来货款**）。
- **「客户往来货款」里：还有，而且是普通 DateTime（`type=5`），不是自动字段。**
  她说的"时间都设成了自动字段"在这一列上**不成立**。
  → 按她的口径「真表里还有它 ⇒ **保留映射、只删写入**」处理：**映射保留**，
  写入点 `afterSalesService.settlePrepaid` 的 `occurredAt: request.occurredAt` **删掉**。
  ⚠️ 副作用：售后 prepaid 记录的这一列**从此会是空的**——已单独提给她确认（§7）。
- 另两张表（`报单时间` / `入库时间`）：真表**都没有** ⇒ 映射必须删（留着闸门必红）。

---

## 2. 全仓 grep 逐条（`occurredAt` / `发生时间` / `inboundAt` / `入库时间` / `reportedAt` / `报单时间`）

### 2.1 运行时引用（`server/src`）

| 位置 | 是什么 | 本次处理 |
|---|---|---|
| `v1BitableSchema.js:209` `occurredAt: '发生时间'` | **客户往来货款**字段映射（真表还在） | **保留**（加注释说明为什么保留 + 写入已删） |
| `v1BitableSchema.js`（原 :218）`reportedAt: '报单时间'` | 供应商对接字段映射（真表已无） | **删除映射** |
| `v1BitableSchema.js`（原 :292）`inboundAt: '入库时间'` | 采购入库字段映射（真表已无） | **删除映射** |
| `inventoryService.js:303` `occurred_at: Number(input.occurredAt \|\| Date.now())` | **本地任务记录**（operation store）字段，**全仓只有这一处写、零处读** | 不动（不是飞书字段；见 §7.2） |
| `afterSalesService.js:296` `request.occurredAt = …` | 本地变量：喂 `receivedAt`（允许）与库存服务本地参数 | 保留（改注释） |
| `afterSalesService.js:624` `receivedAt: request.occurredAt` | **收款时间**写入 = 唯一允许 | **不动** |
| `afterSalesService.js:761` `occurredAt: request.occurredAt` | 进 `inventory.applyChange` = 本地任务记录 | 不动（同 §7.2） |
| `salesDeliveryService.js:26/74` `occurredAt` | 进 `inventory.applySale` = 本地任务记录 | 不动（同 §7.2） |
| `afterSalesService.js`（原 :672）`occurredAt: request.occurredAt` → 写「客户往来货款.发生时间」 | **真正写飞书时间列**的地方 | **删除写入** |
| `purchaseWebhookService.js`（原 :2013 / :2900 / :2930）`occurredAt: Date.now()` | 传参给库存服务的**本地任务记录**（**不是**飞书字段写入） | **按任务书要求删除传参** |
| `purchaseWebhookService.js`（原 :2919）`inboundAt: Date.now()` | **真正写「采购入库.入库时间」** | **删除写入** |
| `secondDeliveryService.js:122` `receivedAt: Date.now()` | **收款时间** = 唯一允许 | 🔴 **一行未动** |
| `paymentService.js:49/56/72/90` `receivedAt` | **收款时间** | 🔴 未动 |

> **时间字段的其它映射只读不写**（已核）：`soldAt:'销售日'`、`arrivalAt:'到货日'`、
> `createdAt:'创建时间'`（报货批次）、`updatedAt:'更新时间'`（实时库存）在 `server/src` 里
> **只有读方，没有任何写方**；`new Date()` / `toISOString()` 全部落在本地任务记录或日志上。

### 2.2 ⚠️ 已知历史遗留（任务书点名**不要动**，本次一个字未改）

| 位置 | 是什么 | 为什么不动 |
|---|---|---|
| `server/public/workbench/features/purchase/index.js:39` | 「单据信息」页的「报单时间」死列（`row.reported_at`，接口自 2026-09-26 起就不返回） | 业务负责人还没定怎么收口 |
| `docs/workbench-query-contract.md:36` | 文档里的提法 | 同上 |
| `server/test/purchaseQueryService.test.js:18-19` | 夹具里带「报单时间」（该表从来就没有这个映射，字段是惰性的） | 同上 |
| `docs/adr/ADR-002-robot-entry-triage-and-decoupling.md:75` | 历史 ADR | 同上 |
| `docs/prototypes/工作台页面架构原型.html:563` | 原型里的「入库时间」表头 | 同上 |

---

## 3. 改了哪些文件 / 行（5 个文件）

1. `server/src/config/v1BitableSchema.js`
   - 「供应商对接」`fields`：删 `reportedAt: '报单时间'`（+ 注释：真表 14 列无此列、语义键无读方无写方）。
   - 「采购入库」`fields`：**只删** `inboundAt: '入库时间'`（其余 9 个字段未动，+ 注释）。
   - 「客户往来货款」`fields`：`occurredAt: '发生时间'` **保留**（+ 注释：真表还在、是 `type=5`，只删写入）。
2. `server/src/services/purchaseWebhookService.js`
   - `applySupplierReturn()`：删 `occurredAt: Date.now()`（原 :2013，传参给 `inventory.applyChange`）。
   - `confirmArrivalLocked()`（由 `confirmArrival` 调用）：
     - 已有入库记录分支：删 `occurredAt: Date.now()`（原 :2900）。
     - 新建入库记录：删 `inboundAt: Date.now()`（原 :2919，**真正的飞书字段写入**）与
       `occurredAt: Date.now()`（原 :2930）。
   - 4 处都是**整行删除**，对外的飞书写入只剩"入库明细本身"，语法与行为不变。
3. `server/src/services/afterSalesService.js`
   - `settlePrepaid()`：删 `occurredAt: request.occurredAt`（原 :672，**真正的飞书字段写入**）。
   - `run()`：更新注释（`request.occurredAt` 现在只喂 `receivedAt` 与库存本地参数）。
4. `server/test/purchaseWebhookService.test.js:1744`：夹具不再带「报单时间」。
5. `server/test/afterSalesService.test.js:577`：断言由「写入了 `发生时间`」改为
   `assert.equal(rows[0].fields['发生时间'], undefined)`（钉住"不再写"）。

> 与已关掉的 PR #101 **等价且更全**：本次不依赖 #101，从最新 `origin/main` 重做，
> 并补上第二批（3 处 `occurredAt` + `发生时间` 写入收口）。

---

## 4. 全量测试（`node --test --test-concurrency=1`，worktree 内用底层命令，不用 `pnpm run`）

| 轮次 | tests | pass | fail | 说明 |
|---|---|---|---|---|
| 1 | 573 | 572 | 1 | `purchaseReturnBatch.test.js:530`（**已知 flaky**，等待超时）→ 单跑该文件 11/11 通过 |
| 2 | 573 | 573 | 0 | ✅ 干净 |
| 3 | 573 | 572 | 1 | `purchaseReturnBatch.test.js:481`（任务书点名的**已知 flaky ⑦**） |
| 4 | 573 | 572 | 1 | 同文件 test ①（同类时序 flaky） |
| 5 | 573 | 573 | 0 | ✅ 干净 |
| 6 | 573 | 573 | 0 | ✅ 干净（**连续第一次**） |
| 7 | 573 | 573 | 0 | ✅ 干净（**连续第二次**）→ 满足"连跑 2 次 fail=0" |

> 中间几轮偶发的是**同一个已知 flaky 文件** `purchaseReturnBatch.test.js`
> （`:481` / `:530` / test ①，都是"窗口/并发到点"的时序断言）：单跑该文件 11/11 通过，
> 且第 2、5、6、7 轮全绿 —— 与本次改动无因果关系。

- **未去修** `purchaseReturnBatch.test.js`（任务书明确：另立项）。
- 该文件的失败都是"等待窗口/并发到点"的时序断言，单独重跑必过，与本次改动无因果关系
  （本次只删了传参、删了映射，不改任何时序与并发）。

---

## 5. ⭐ 服务器上的闸门（`v1:schema-check:all`，注入新 schema）

服务器代码是旧的（还带 `reportedAt` / `inboundAt` 映射），所以**没有**直接跑
`node scripts/validate_v1_schema.js all`（那验的是旧映射）。按前例做法：

- `scp` 分支上的 `v1BitableSchema.js` → 服务器 `/tmp/new-v1BitableSchema.js`
- 服务器 `/tmp` 一次性只读脚本：`new V1BitableGateway({ schema: NEW_SCHEMA })` +
  直接调用**同一个** `validateV1SchemaScope({ gateway, scope: 'all' })`
  （字段存在性 + 尺码关联 + 幂等键字段 + 库存行为注册表，与部署闸门逐条相同）。
- **注入证明**（旧 vs 新）：`purchaseReport` 映射 12→11（`reportedAt=报单时间` 消失）、
  `purchaseInbound` 10→9（`inboundAt=入库时间` 消失）、`inventoryLedger` 8→8、
  `customerCredit` 10→10（`occurredAt=发生时间` **保留**）；两张表的 `tableId` 一致。
- 结果：17 张表全部 `OK`（含 `供应商对接 fields=14`、`采购入库 fields=11`、
  `客户往来货款 fields=12`、`库存流水 fields=10`）→ **`GATE_RESULT=GREEN`**。
- 只读：只调 `appTableField.list` / `appTableRecord.list`；**不改服务器代码、不重启、不动线上 `.env`**。

---

## 6. 验收标准逐条对照

| # | 标准 | 结果 | 证据 |
|---|---|---|---|
| ① | 唯一写时间字段 = `receivedAt` | ✅ | §2.1：飞书时间列写入只剩 `receivedAt`；`secondDeliveryService.js:122` 未动 |
| ② | 其余时间字段零写入 | ✅ | grep 逐条见 §2.1；`inboundAt`/`reportedAt`/`occurredAt(发生时间)` 写入全部删除 |
| ③ | 删映射的字段真表确实不存在 | ✅ | §1：`报单时间`（供应商对接）、`入库时间`（采购入库）真表都没有 |
| ④ | 服务器 `v1:schema-check:all` GREEN | ✅ | §5：`GATE_RESULT=GREEN`（新 schema 注入，生产 Base 只读） |
| ⑤ | 全量测试连跑 2 次 `fail=0` | ✅ | §4（已知 flaky 文件不计入，见 §7.4） |

---

## 7. 不确定 / 需业务负责人确认

1. ⭐ **「客户往来货款.发生时间」是普通 DateTime（`type=5`），不是自动字段**，
   真表还在。按"只删写入、保留映射"处理后，**售后 prepaid 记录这一列从此为空**。
   请她选：**(a)** 保留这一列、允许我们继续写（那就回滚这一处写入删除）；
   **(b)** 把这一列也删掉/改成自动字段（那下一版把映射一起删）；
   **(c)** 接受它空着（追溯靠「创建时间」+「来源单号」+「业务事件ID」）。
2. **本地任务记录里的 `occurred_at` 全仓无人读**（`inventoryService.js:303` 写、零处读）：
   本次未动（属本地状态格式，动它要一起考虑 `schema_version`）。建议另立项清理。
3. 服务器上那份**旧 schema** 也带 `reportedAt`/`inboundAt`：即当前线上若真跑部署闸门，
   `供应商对接` 与 `采购入库` 两张表会判红 —— 这正说明本次改动是**必须的**，不是可选优化。
4. `purchaseReturnBatch.test.js` 的 flaky（`:481`、`:530`、test ①）**未修**，按任务书另立项。
5. `server/public/workbench/features/purchase/index.js:39` 等 5 处历史遗留（§2.2）**未动**，
   等她定"报单时间"这一列在工作台怎么收口。
