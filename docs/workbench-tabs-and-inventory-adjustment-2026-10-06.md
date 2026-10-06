# 工作台改造：3 个一级 tab ＋ 库存手工调整（2026-10-06）

> 状态：**已实现**（本文件记录实现口径与仍然待她定的项）
> 相关代码：`server/public/workbench/`（前端）· `server/src/services/inventoryAdjustmentService.js`（新）
> · `server/src/services/inventoryService.js`（`transitionState` 新增）· `server/src/routes/workbenchInventoryAdjustment.js`（新）
> 前置方案：`docs/inventory-adjustment-plan-2026-10-06.md`（行为注册表那一轮）

---

## 1. 她定的（逐字确认过的）

> 「新加一个 tab，就是常用功能……今日销售改为销售查询，因为要不仅仅可以查询今日的，
> 可以按照区间或者某日的查询，以及实时库存的，先重点做这 3 个，其余的入口可以先隐去，
> 先不做，核心是做这 3 个，并且它们都有独立的页面」

| # | 决定 | 落点 |
| --- | --- | --- |
| ① | 一级 tab 只留 **常用功能 / 销售查询 / 实时库存**，其余**入口隐去、代码保留** | `server/public/workbench/index.html` · `main.js` |
| ② | **今日销售 → 销售查询**，支持**按某日**和**按区间** | `sales-query.html` · `features/sales/index.js` · `GET /api/workbench/sales/query` |
| ③ | 三个 tab **各有独立页面** | `common.html` · `sales-query.html` · `inventory.html` |
| ④ | 常用功能里两个入口：**库存手工调整** ＋ **采购退货**，各自独立子页 | `inventory-adjustment.html` · `purchase-return.html` |
| ⑤ | 盘点调整 = **改数量，可增可减**（盘多了加、盘少了减） | `STOCK_MANUAL_INCREASE` / `STOCK_MANUAL_DECREASE` + `applyChange` |
| ⑥ | 换季调整 = **改状态，数量不变**；转冻结 = 门盒/样品 → 仓库；转释放 = 仓库 → 门盒/样品 | `FREEZE_STATE_TRANSITION` / `UNFREEZE_STATE_TRANSITION`（`inventoryService.js`） |
| ⑦ | **转释放回门盒还是样品，由她在界面上选** | `UNFREEZE_STATE_TRANSITION = { from: ['仓库'], to: null, targets: ['门盒','样品'] }` + 页面下拉 |
| ⑧ | 幂等用**界面侧的 requestId**（每次提交生成一个，重试复用同一个） | `features/inventory/adjustment.js` 的 `state.pendingRequest` → `requestId:货号:尺码:状态` |

### ⑤/⑥ 已把上一轮的「待定②」定死了

`docs/inventory-adjustment-plan-2026-10-06.md` 的待定 ② 问「冻结落到哪个字段」，答案是
**方案 B：直接改「所属状态」到「仓库」**（不新增「冻结状态」列）。

⚠️ **已知代价（必须记住）**：记录进了「仓库」以后，**原来在门盒还是样品就查不到了**
（「库存流水」没有操作人列、也没有指向单据的来源列，翻不回来）。
所以转释放**必须**由入口选目标状态 —— 代码不替她猜，也不许默认成门盒。

---

## 2. 接口

### 2.1 销售查询（新增，不破坏老接口）

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api/workbench/sales/query` | `date=YYYY-MM-DD` 或 `from=…&to=…` | 新入口；两者都不传 = 今天 |
| `GET /api/workbench/sales/today` | `date=YYYY-MM-DD` | **保持原样**（内部走同一个实现，响应形状不变） |

- 区间是**含首尾**的闭区间；上限 `SALES_QUERY_MAX_RANGE_DAYS = 92`（`server/src/config/workbenchQuery.js`，可配）。
- 日期格式错 / 起止颠倒 / 超过上限 → **400** 并原样说哪里填错（不再是静默空结果）。
- 响应多两个字段：`from` / `to` / `is_range`；`date` 在区间查询时是空串（单日查询还是那一天）。

### 2.2 库存手工调整（写入，新增）

| 接口 | 用途 |
| --- | --- |
| `POST /api/workbench/inventory/adjustments/count` | 盘点调整：`{ productRecordId, size, state, mode: 'counted'\|'delta', countedQuantity?, delta?, requestId }` |
| `POST /api/workbench/inventory/adjustments/season` | 换季调整：`{ action: 'season_freeze'\|'season_release', targets: [{productRecordId,size,state,quantity}], toState?, requestId }` |

配套**只读**接口（页面用）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/workbench/inventory/products?keyword=` | 货号选择器（返回 `record_id`） |
| `GET /api/workbench/inventory/stock?productRecordId=&size=` | 当前库存（门盒/样品/仓库 各几条） |
| `GET /api/workbench/inventory/categories` | 品类清单（取自「实时库存」的「品类」公式列） |
| `GET /api/workbench/purchase/requests?reportBehavior=purchase_return` | 「采购退货」子页的退货行 |

### 2.3 幂等怎么落

```
sourceRecordId = `${requestId}:${货号}:${尺码}:${状态}`        ← 由入口拼，重试不变
operationId    = `inventory_${行为编码}_${sha256(sourceRecordId)[:20]}`   ← 库存引擎的既有机制
```

- 幂等第一层命中同一条本地任务；第二层是实时库存上的「库存操作键」（`<opId>:第N双`）。
- ⚠️ 「按实际盘点数」这种模式**不能靠重算差额判幂等**：重试时账面已经变了，差额会算成 0，
  反而报"不需要调整"。所以 `InventoryAdjustmentService.adjustCount` 先用
  `InventoryService.findOperationBySource(sourceRecordId)` 回查，命中已完成任务就原样回放结果。
- 一次提交里每个目标身份不同 → 同一批不会互相顶掉；**要再调一次同样的货号+尺码**，
  界面会生成**新的 requestId**（成功后才换新的）。

### 2.4 谁调的（操作人）

**现状：远端「操作人」列这一轮【故意不写】，只落本地 + 日志。**

- 业务负责人 2026-10-06 在生产「库存流水」新增了「操作人」（飞书**人员**字段 type=11），
  并定了口径：**只有人工调整写它**（有值 = 人干的，空 = 系统干的）。
  `v1BitableSchema.inventoryLedger.fields.operator = '操作人'` 的映射**已经由 #135 加上**
  （那一版明确写着"只加映射、不写值"）。
- ⚠️ **为什么这一轮仍然不写**：**测试 Base 的「库存流水」还没有这一列**
  （2026-10-06 用项目代码只读核过：仍是 10 列，没有「操作人」）。
  一写就会 `FieldNameNotFound`，于是**人工调整在唯一允许写入的库里全都失败** ——
  这个功能就彻底没法自测了。要么先给**测试 Base** 也加上这一列，要么明确接受
  "生产能写、测试写不了"，两条都由业务负责人拍板。
- 在拍板之前，人工调整的操作人 open_id 落两处，**不往远端写**：
  - 本地库存任务 `server/data/inventory_operations/*.json` 的 `operator_open_id`；
  - 结构化日志 `inventory.change.applied` / `inventory.state.transitioned` / `inventory.adjustment.*`
    （日志里的 open_id 由 logger 自动打码）。
- **补写只要 3 行**：`executeOperation` 与 `executeStateTransition` 里都已经拿到
  `operation.operator_open_id`，加一个 `operator: personValue(...)` 即可 ——
  等测试 Base 有列之后一起做，改完必须跑一次真实写入验证。

---

## 3. 两条不许破的规矩（代码里已加闸门 + 单测）

1. **方向=不影响的行为绝不许走数量通路**（`requireQuantityMovement`）。
   走进去会被当成"增加 N 双"，**凭空建鞋而且账面完全看不出来**。
2. **反向也拦**：数量类行为不许走状态变更通路（`requireStateMovement`）。
   两条通路互为镜像，两侧都拦。

单测：`server/test/inventoryAdjustmentService.test.js`（15 条）+ `server/test/workbenchSalesRange.test.js`（10 条）
+ `server/test/workbenchInventoryAdjustmentRoute.test.js`（4 条，含"匿名调不到这两个写接口"）。

---

## 4. 仍然待她定的（不在本轮）

| # | 待定 | 现状（本轮按最保守做的） |
| --- | --- | --- |
| ① | **手工调减消耗哪些状态** | `MANUAL_DECREASE_CONSUMES = null` ＝ **只吃她在页面上选的那一种状态**，不会顺手吃样品/仓库 |
| ② | **「操作人」要不要真的写进「库存流水」** | 没写（测试 Base 还没有这一列，写了就没法自测）——见 2.4；映射 #135 已加 |
| ③ | **冻结期间（=「仓库」）的鞋能不能卖** | 现在是**能**：销售链路只认 `门盒/样品/仓库`，`仓库` 是被认的状态。若"收起来的当季鞋不该卖"，要另加过滤规则 |
| ④ | **要不要给「库存流水」加「关联单据」列** | 没加；人工调整与采购退货同属"拿不到远端第三层幂等"的那一类 |
| ⑤ | **按品类批量释放时，默认回门盒还是样品** | 不设默认，**每次都让她选**（信息只存在她的脑子里，代码不许猜） |
| ⑥ | **测试 Base 的「行为管理」6 条要不要同步** | 本机测试 Base 上这 4 条仍是停用/方向为空，所以本机跑 `v1:schema-check:inventory` 会红（另有 `SALE_RETURN` 等存量漂移），与本轮无关 |

---

## 5. 顺带修掉的一个老 bug

`v1WorkbenchService.asDate()` 原先不认 `Date` 实例：`textValue(new Date())` 取 `.text/.name/.value`
全是 undefined → 空串 → `todayKey()` 返回 `''`。而 `/api/workbench/sales/today` 在**不传 `?date=`**
时用的正是 `todayKey()` 这个默认值，于是**筛出来一条都没有**（页面永远显示空）。

现已在 `asDate` 里单独认 `Date` 实例，并加单测锁住（"不传日期时仍然默认今天"）。
⚠️ 这个修复**只影响"不传日期"的调用**；传了 `?date=` 的行为一字未变。
