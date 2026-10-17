# 人工库存行为（调增 / 调减 / 转冻结 / 转释放 / 样品转门盒 / 门盒转样品）改动方案

> 日期：2026-10-06 · 状态：**第一步（注册）已做 ✓ · 第二步（入口）也已做 ✓**
> 相关代码：`server/src/services/inventoryService.js`（`STOCK_MOVEMENTS` 行为注册表）
>
> ⚠️ **第二步（工作台入口）已于同日实现**，实现口径与仍然待她定的项见
> **`docs/workbench-tabs-and-inventory-adjustment-2026-10-06.md`**。
> 本轮（第一步）只把 6 个行为编码注册进注册表，让 `validateStockBehaviors()`
>（部署闸门 `v1:schema-check:all` 的一部分）开始核对它们。
>
> 下面第 3 节是**当初的方案**，第 2 节是已落地的注册。读的时候注意：
> 第 3 节里的「待定 ②（冻结落到哪个字段）」**已经定了** ——
> **转冻结 = 门盒/样品 → 仓库；转释放 = 仓库 → 门盒/样品（回哪个由她在界面选）**，
> 即只改「所属状态」，不新增「冻结状态」列。其余待定项仍未定，见上面那份新文档的第 4 节。

---

## 1. 现有库存机制的要点（读代码的结论）

### 1.1 数量类操作怎么落

唯一入口是 `InventoryService.applyChange(input)`，链路（`inventoryService.js:352` 起）：

```
applyChange
  ├─ 校验：productRecordId / sourceRecordId / size / quantity(正整数) / state ∈ {门盒,样品,仓库}
  ├─ 闸门：requireQuantityMovement(kind)   ← 本轮新增，状态类行为在这里就被拦下
  ├─ runForStock(`${productRecordId}|${size}|${state}`)  ← 按「货号|尺码|状态」串行排队
  │    ├─ ensureSchema()（校验表结构 + 尺码关联 + 「库存操作键」幂等键字段）
  │    ├─ sizeReferences.resolveByNumber(size)  ← 尺码是**关联字段**，写的是 record_id
  │    ├─ resumePending(stockKey)  ← 先把同键的未完成任务跑完，再开新的
  │    ├─ 幂等键 id = operationId(kind, sourceRecordId) → 命中已有任务就复用
  │    └─ 新建本地任务（journal）→ executeOperation
  └─ executeOperation
       ├─ findOperationLedger(operation)      ← 先看远端是不是已经写过这条流水
       ├─ auditExistingOperationRecords(...)  ← 把已有事实逐条核对；对不上→转人工，绝不猜
       ├─ 写「库存流水」：变动数量 = quantity（**永远是正数**）、库存行为 = 关联行为记录
       │    （ledgerSource 决定挂「关联销售」还是「关联采购」；为 null 的整列不写）
       ├─ 增加：create quantity 条「实时库存」（每条带「库存操作键」）
       └─ 减少：delete quantity 条「实时库存」（逐条 get 确认后才删）
```

两个容易搞错的点：

- **「变动数量」是绝对值，不带符号。** 增减由「库存行为」→「库存方向」表达
  （`delta = direction === '减少' ? -quantity : quantity` 只用来算目标数量和挑记录）。
  所以流水里的「变动数量」手工调增和手工调减都是 `+N`，**不是 `+N / −N`**。
- 「实时库存」的**「库存键」是飞书公式字段**（2026-10-06 实测测试 Base：
  `公式 = 货号|颜色|类别|尺码`），代码**不写、也写不了**它，新建记录自动算出来。
  ⚠️ 若哪天它被改成普通文本列，代码新建的记录会没有库存键 →
  `liveInventoryIndex` 会**静默跳过整条记录**（线上现象是"这一双不存在"）。

### 1.2 幂等靠什么（三层，缺一不可）

| 层 | 键 / 手段 | 位置 | 解决什么 |
| --- | --- | --- | --- |
| 任务级 | `operationId(kind, sourceRecordId)` = `inventory_<kind>_<sha256(source)[:20]>` | 本地 journal `server/data/inventory_operations/*.json` | 同一来源明细重跑只命中同一条任务 |
| 远端级 | 「库存操作键」= `<operationId>:<第N双>` | 「实时库存」文本列，`createOnceByKey` 先按键回查再 create | create 成功但响应/落盘丢了，不会把 +1 变成 +2 |
| 流水级 | 按 `ledgerSource`（关联销售 / 关联采购）+ 库存行为 回查 | `findLedger` | 恢复时确认"这条流水是不是我写的" |

`ledgerSource: null` 的动作（现在是采购退货）**拿不到第三层**，只能用本地
`ledger_record_id` + 落盘 journal，恢复能力更弱——代码里已明确标注并留了
「等『关联单据』列」的待办。**人工调整同样属于这一类。**

恢复规则：`resumePending(stockKey)` 在每次新操作前把同键未完成任务补完；
`auditExistingOperationRecords` 只要有一条对不上就抛"请人工核对，不能自动恢复"。

### 1.3 「一双一条」怎么体现

- 「实时库存」**一条记录 = 一双**，表里没有数量列。
- 调增 2 双 = **create 2 条**；调减 2 双 = **delete 2 条**；每次 create 都带第 N 双的
  「库存操作键」（`<opId>:1`、`<opId>:2`…）。
- 现有库存量 = 该 货号 + 尺码 + 所属状态 下的**记录条数**
  （`findLiveInventoryIn(...).length`）。
- 已有测试锁住：`C2/C3/C5`（创建结果未知、响应丢失、重复 applyPurchase 都不得多建）。

### 1.4 两张表 + 行为表的真实字段（只读实测，测试 Base）

- 「实时库存」：库存键(**公式**) · 所属状态(单选 **门盒/样品/仓库**) · 编号(关联) · 尺码(关联) ·
  品类(公式) · 类别(公式) · 更新时间(**自动**) · 库存操作键(文本) · 创建时间(**自动**)
- 「库存流水」：库存流水号(自动编号) · 库存行为(关联) · 编号(关联) · 尺码(关联) ·
  变动数量(数字) · 关联销售(关联) · 关联采购(关联) · 库存键(公式) · 创建时间(自动) · 更新时间(自动)
  → ⚠️ **没有「操作人」列，也没有指向「单据信息」/「调整单」的来源列。**
- 「行为管理」：行为名称 · 行为编码 · 所属环节(单选 采购/销售/库存/资金) · 描述 ·
  资金方向(单选) · 是否启用(复选框) · 库存方向(单选 **增加/减少/不影响/按明细角色**) ·
  创建时间(自动) · 更新时间(自动)

---

## 2. 本轮已做的注册（第 ② 步）

### 2.1 注册表新增 6 条（`inventoryService.js` 的 `STOCK_MOVEMENTS`）

| 行为编码 | 库存方向 | consumes | ledgerSource | stateTransition | 类别 |
| --- | --- | --- | --- | --- | --- |
| `STOCK_MANUAL_INCREASE` 手工调增 | 增加 | null | null | — | 数量类 |
| `STOCK_MANUAL_DECREASE` 手工调减 | 减少 | **待定**（常量 `MANUAL_DECREASE_CONSUMES`，暂 `null`） | null | — | 数量类 |
| `STOCK_FREEZE` 转冻结 | 不影响 | null | null | **待定**（`FREEZE_STATE_TRANSITION`，暂 `null`） | 状态类 |
| `STOCK_UNFREEZE` 转释放 | 不影响 | null | null | **待定**（`UNFREEZE_STATE_TRANSITION`，暂 `null`） | 状态类 |
| `STOCK_SAMPLE_TO_DOORBOX` 样品转门盒 | 不影响 | null | null | `{ from: '样品', to: '门盒' }` | 状态类 |
| `STOCK_DOORBOX_TO_SAMPLE` 门盒转样品 | 不影响 | null | null | `{ from: '门盒', to: '样品' }` | 状态类 |

- 6 个编码集中在 `ADJUSTMENT_BEHAVIORS`（已导出），待定的三个值抽成**独立常量 + `TODO(inventory-adjustment)` 注释**，
  定下来只改常量、逻辑一行不动。
- `STOCK_DOORBOX_TO_SAMPLE` 与既有的 `BEHAVIOR_SAMPLE_PROMOTION` 是**同一个编码**：
  补样品链路（`promoteToSample`）早就在用它，所以这 6 条里真正"谁都碰不到"的是 5 条，不是 6 条。

### 2.2 顺手加的一道闸门（安全，不是入口）

`applyChange` 新增 `requireQuantityMovement(kind)`：**方向 = 不影响 的行为不许走数量通路**。
不加这道闸门，`applyChange({kind:'STOCK_FREEZE'})` 会因为 `direction !== '减少'` 被当成
"增加 N 双"，**凭空建出实时库存且账面看不出来**。闸门在任何远端读写之前抛错，并有单测锁住
（断言流水和实时库存一条都没动）。

### 2.3 校验结果

- **等价校验（假 Base 单测）**：`validateStockBehaviors()` 遍历全表通过；
  新增 2 条单测锁注册表契约 + 状态类闸门；全量 676/676 pass，连跑 2 次 fail=0。
- **真实 Base（本机 = 测试 Base）只读核对**：6 条里 2 条 OK（样品转门盒 / 门盒转样品），
  4 条报「请将行为管理「手工调增」…的库存方向设置为"增加"」等——**证明注册已生效**，
  报错原因是**测试 Base 的行为数据没同步**（这 4 条在测试 Base 里是停用 + 方向为空）。
- ⚠️ 本机 `FEISHU_V1_BITABLE_APP_TOKEN` 与 `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值 = 测试 Base**，
  所以本机**跑不到生产**；生产 Base 的核对只能等部署闸门 `pnpm run v1:schema-check:all`
  在服务器上跑（她的实测是生产 6 条都已启用、方向正确 → 应当能过）。
- ⚠️ 顺带暴露的**存量**问题：本机测试 Base 上 `v1:schema-check:inventory` **改动前就已经红**
  （`SALE_RETURN` 销售退货在测试 Base 里是停用 + 方向为空），与本轮改动无关。

---

## 3. 改动方案（下一步，尚未实现）

### 3.1 模块化落点

**新建 `server/src/services/inventoryAdjustmentService.js`**，只干这 6 件事，与销售/采购链路完全解耦。

- 依赖面只有：`InventoryService`（库存写入的唯一出口，见 `docs/module-boundaries.md`）
  + 幂等来源（requestId / 调整单）。
- 建议接口（命名待定）：
  - `adjustQuantity({ behaviorCode, productRecordId, size, quantity, state, operatorOpenId, requestId })`
  - `transitionState({ behaviorCode, liveRecordIds | { productRecordId, size, fromState, count }, operatorOpenId, requestId })`
- **状态变更的远端写入放在 `InventoryService`**（新方法 `transitionState`），
  adjustment service 只做参数校验、入口编排和幂等——理由：项目规范要求
  "库存写入只经 `InventoryService`"，不要把 `gateway.update('liveInventory', …)` 散到新 service 里。
- 两条通路都复用 `runForStock(stockKey)` 串行队列，避免和销售/采购同时改同一双鞋。

### 3.2 数量类（调增 / 调减）怎么走

- **调增**：`applyChange({ kind: MANUAL_INCREASE, state, quantity: N, sourceRecordId })`
  → 写 1 条流水（变动数量 = N）＋ **创建 N 条**「实时库存」（各带第 N 双键）。
- **调减**：`applyChange({ kind: MANUAL_DECREASE, state, quantity: N, sourceRecordId })`
  → 写 1 条流水（变动数量 = N）＋ **删除 N 条**既有「实时库存」；不足则按现有文案报
  "X和Y库存不足：… 需 N 双，现有 M 双"。
- ⚠️ 消耗哪些状态**还没定**（见待定 ③）。现在 `consumes = null` 的语义是
  **"只消耗调用方明确指定的那一种状态"**（最保守，不会顺手吃掉样品），不是"不消耗"。
- ⚠️ `sourceRecordId` 必须有稳定来源（见待定 ⑤），否则幂等第一层就搭不起来。

### 3.3 状态类（4 个"转"）怎么走

- 只 `update('liveInventory', recordId, { state: to })`：**不新建、不删除记录**，总双数不变。
- 样品 ↔ 门盒：规则明确，已写进 `stateTransition` 配置。
- 冻结 / 释放：等字段定了（待定 ①）。
- **要不要为"转"留一条流水？→ 我建议留，且「变动数量」填 `0`。**
  理由：
  1. **已有先例**：补样品（`promoteToSample`）就是"只改状态、不变量"，它的流水
     `变动数量 = 0`，并且恢复核对也用 0 做判据（`ledgerMatchesOperation(..., quantityChange: 0)`）。
     照抄这个形状，比新造一套"无流水"的状态变更好维护。
  2. **不留就查不到历史**：不留流水的话，"这一双被冻过几次、什么时候冻的"只剩当前状态一个快照；
     按项目规范"每个关键流程节点都要有日志和可排查路径"，状态流转应该留痕。
  3. **0 比空值好**：空值分不清"这条流水没写完"和"这次变动本来就不涉及数量"，
     而 0 有确定语义（数量不变），也能被 `ledgerMatchesOperation` 直接用来做恢复核对。
  - ⚠️ 但「库存流水」**没有操作人列**，只写流水仍答不出"谁冻的"（见待定 ④）。
- 幂等：同一双鞋重复"转"要幂等（已经是目标状态就视为已完成，或直接跳过），仍然要落任务记录。

### 3.4 必须先请业务负责人定的清单

| # | 待定 | 现状 / 为什么必须问 | 我的建议 |
| --- | --- | --- | --- |
| ① | ~~**冻结落到哪个字段**~~ | ✅ **已定（2026-10-06，工作台改造需求）**：**转冻结 = 门盒/样品 → 仓库；转释放 = 仓库 → 门盒/样品**，只改「所属状态」 | 已按"方案 B"实现；代价（释放时原来的状态查不到）由**界面选回门盒/样品**兜住 |
| ② | ~~**入口是什么**~~ | ✅ **已定**：**网页工作台 → 常用功能 → 库存手工调整**（盘点调整 / 换季调整） | 已实现 |
| ③ | **手工调减消耗哪些状态** | 决定"调减 2 双"是扣门盒、扣样品，还是按顺序吃 | **仍未定**；现在按最保守的 `null`（只吃她在页面上选的那一种状态） |
| ④ | **要不要加「操作人」和「关联单据」列** | 实测「库存流水」两者都没有（2026-10-06 再核一次：仍没有）：加操作人才能追责；加来源列才能让手工调整/采购退货拿到第三层幂等回查 | 建议两张列都加（采购退货那边已有同一处 TODO，可一起解决）。加之前操作人只落本地任务 + 日志 |
| ⑤ | ~~**一次人工调整的"稳定来源 id"是什么**~~ | ✅ **已定**：入口侧生成 `requestId`（界面每次提交生成一个、重试复用同一个） | 已实现（`requestId:货号:尺码:状态`） |
| ⑥ | **冻结期间能不能卖** | 取决于 ①：现在"冻结"= 「所属状态」改成「仓库」。`liveInventoryIndex` 只认 `门盒/样品/仓库`，`仓库` 是被认的 → **仓库里的鞋仍然会被销售链路看见**吗？ | **要她确认**：如果"收起来的当季鞋"不应该被卖，就得另加过滤规则 |
| ⑦ | **测试 Base 的「行为管理」要不要我同步** | 测试 Base 里这几条是停用/方向空，本机闸门因此红（另有 `SALE_RETURN` 等存量漂移） | 她点头我就按测试 Base 可写的惯例补齐 |
| ⑧ | **要不要加"反向校验"** | 现在只校验"代码声明的行为表里有没有"，**不校验"表里启用的行为代码有没有声明"** → 实测测试 Base 有 **9 条**行为代码没人声明（`PURCHASE_ORDER` `PURCHASE_IN` `PURCHASE_RETURN` `SALE_PREPAID` `SALE_EXCHANGE` `SALE_GROUP_BUY` `SUPPLIER_PAYMENT` `SALE_INCOME` `SALE_UNPAID`），「库存方向」的 **`按明细角色`** 选项代码里也没人用 | 建议加一条闸门：**「所属环节 = 库存」且启用的行为必须在注册表里声明**，让"表里建好了但代码没接"不再静默 |

---

## 4. 验证与限制

- 全量测试 `node --test --test-concurrency=1` **连跑 2 次**：`tests 676 / pass 676 / fail 0`
  （已知 flaky 的 `purchaseReturnBatch.test.js` 两次都没抖）。
- 真实 Base 校验**只读**：用项目代码（`V1BitableGateway` + `InventoryService`）打测试 Base，
  未使用任何飞书 CLI，未写入一个字；临时探针脚本用完即删。
- **本机无法验证生产**：本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` 指向测试 Base
  （与 `FEISHU_V1_E2E_TEST_APP_TOKEN` 同值），生产 Base 只读、且本机不配生产凭证。
  生产的核对以**部署闸门**为准。
