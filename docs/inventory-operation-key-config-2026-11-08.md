# 库存操作键统一配置化方案

> 2026-11-08 制定。对应 issue：[#961](https://github.com/LyraWang6688/feishu-retail-ops/issues/961)。
>
> 本文只记录现状、方案与迁移约束，不代表代码已配置化；当前实现仍是分散的 `sourceId` 函数。

## 1. 库存操作键是什么

代码：

```text
server/src/services/inventory/keys.js
```

两个键：

```js
operationId(kind, sourceRecordId)
  = `inventory_${kind}_${sha256(sourceRecordId).slice(0,20)}`

operationItemKey(operationId, sequence)
  = `${operationId}:${sequence}`
```

- `sourceRecordId`：这一次库存操作的**来源身份**（业务单据 / 请求 / 三元组）。
- `operationId`：把来源身份加上行为 kind 后哈希成短键。
- `operationItemKey`：一次操作里的第 N 双（一对库存记录一个序号）。

它们是**本地幂等键**，不是业务表字段，不参与金额 / 状态判据。

## 2. 作用

```text
1. 本地任务记录丢失后，判断“这一件是不是已经建过 / 扣过”
2. 崩溃后续跑，判断“该不该重放”
3. 同一来源重复提交，保证只写一次
4. 远端实时库存 / 库存流水出现重复记录时，靠它拦住
```

远端拦截点在：

```text
server/src/services/inventory/ledger.js
assertNoDuplicateOperationItems
```

同一操作同一序号在实时库存里出现 >1 条，就抛：

```text
实时库存中已存在 N 条库存操作键为 … 的记录
库存事实重复，请人工核对后再入库
```

## 3. 当前哪些行为涉及

| 行为 | sourceRecordId 当前来源 | item 序号 |
|---|---|---|
| 销售交付扣减 | 销售明细 record_id（`saleBatch`） | 每双从 1 开始 |
| 采购入库增加 | `purchase_increase:<批次身份>|<货品>|<尺码>`（`purchaseIncreaseSourceId`） | 每双从 1 开始 |
| 采购退货减少 | `purchase_return:<批次身份>|<货品>|<尺码>`（`purchaseReturnSourceId`） | 每双从 1 开始 |
| 售后销售增加 / 赔货 / 换货 | 销售明细 record_id（`saleBatch` / 售后链路） | 每双从 1 开始 |
| 补样品（门盒→样品） | 销售明细 record_id（`samplePromotionId`） | 每双从 1 开始 |
| 人工转冻结 / 转释放 / 门盒↔样品 | 工作台请求的 `requestId`（`stateTransition`） | 按状态变更记录 |
| 人工调增 / 调减 | 人工调整入口的 `requestId` / 来源 | 每双从 1 开始 |

## 4. 现状问题

### 4.1 来源拼法分散

```text
purchaseIncreaseSourceId
purchaseReturnSourceId
samplePromotionId
stateTransition 的 requestId
```

每个行为各自实现，新增行为要记得加一处。

### 4.2 配置层缺一块

`STOCK_MOVEMENTS` 已经配置：

```text
方向
消耗哪些状态
库存流水来源 / 关联列
是否触发补样品
```

但**没有配置幂等来源**。同一层信息被拆成两处：行为语义在 `movements.js`，来源拼法在 `keys.js`。

### 4.3 历史撞键

历史采购入库的 sourceId 曾漏掉尺码，导致同款不同码共用同一个 `operationId:1`。

生产 4 组、测试 0 组：

```text
数据本身没有重复入库
只是不同尺码被标成了同一个操作键
只会在旧批次重放时被 assertNoDuplicateOperationItems 拦住
新入库不受影响
```

## 5. 目标形态

在 `STOCK_MOVEMENTS` 每个行为里增加声明式字段：

```js
{
  direction: '减少',
  consumes: [...],
  operationKey: {
    // 来源身份由哪些输入字段组成（按顺序、稳定）
    sourceFields: ['purchaseBatchRecordId', 'productRecordId', 'size'],
    // 缺省回落顺序（拿不到前一个才试后一个）
    sourceFallbacks: ['purchaseBatchNo', 'arrivalTaskId'],
    // 是否每个（货品 + 尺码）独立一把键
    perItem: true,
    // 前缀，保持与现有 operationId 的 kind 兼容
    kind: 'purchase_increase',
    // 缺失时的明确错误（不编 id）
    missingMessage: '采购入库缺少来源标识（批次记录 id / 批次号 / 到货核对任务 id 至少要有一个）',
  },
}
```

由唯一入口生成：

```text
operationSourceIdOf(movement, input)
operationIdOf(movement, input)
operationItemKeyOf(movement, input, sequence)
```

`keys.js` 只保留纯哈希 / 序号工具，不再逐个行为写 `sourceId` 函数。

## 6. 兼容要求

### 6.1 键字符串不能变

新配置必须逐字复现当前每个行为的 `sourceRecordId` / `operationId`：

```text
purchase_increase:<批次身份>|<货品>|<尺码>
purchase_return:<批次身份>|<货品>|<尺码>
<salesDetailRecordId>
<requestId>
```

否则历史任务 / 库存流水 / 本地 journal 会认不出旧操作。

### 6.2 历史撞键不自动修

- 不动历史 4 组数据；
- 不重算历史键；
- 只作为巡检指标：撞键组数 = 生产 4 / 测试 0，涨了说明旧逻辑又写进来了。

### 6.3 两类来源不能混

```text
业务单据来源：批次 / 销售明细 / 退货任务
人工请求来源：requestId
```

人工调整不能用批次号顶替，业务单据不能用 requestId 顶替。

### 6.4 缺字段不编 id

拿不到来源身份时按配置抛明确错误，不生成假 id。

## 7. 迁移步骤

### 第 1 步：补配置，不改行为

- 给现有每个行为加 `operationKey`；
- 新入口逐字复现现有 sourceId；
- golden test 对照旧函数输出；
- 暂不删除旧函数。

### 第 2 步：切换调用方

- `purchaseBatch` / `purchaseReturnBatch` / `saleBatch` / `stateTransition` / `samplePromotion` 改调统一入口；
- 旧 `sourceId` 函数保留一个版本，标 deprecated；
- 全量 + e2e + 真实测试 Base 回归。

### 第 3 步：删除旧函数

- 确认无调用后删除 `purchaseIncreaseSourceId` / `purchaseReturnSourceId` / `samplePromotionId`；
- 保留 `operationId` / `operationItemKey` 纯工具。

### 第 4 步：加巡检

只读检查：

```text
库存操作键撞键组数
空操作键历史行数
```

不写数据，只报指标。

## 8. 验收标准

```text
1. 每个行为有 operationKey 配置
2. 新入口生成的 sourceId / operationId 与旧函数逐字一致（golden test）
3. 缺字段时明确抛错，不编 id
4. 历史撞键仍为生产 4 / 测试 0，不自动修
5. 新增库存行为只改配置 + 行为表，不改写入件
6. 全量 + e2e 通过
7. 部署闸门能拦住“配置缺失”
```

## 9. 边界

- 本方案不改历史数据；
- 生产 Base 只读，不写；
- 不部署，部署需业务负责人当次明确指令；
- 不改变远端库存流水 / 实时库存的表结构。

## 10. 关联

- `server/src/services/inventory/keys.js`
- `server/src/services/inventory/movements.js`（`STOCK_MOVEMENTS`）
- `server/src/services/inventory/ledger.js`（`assertNoDuplicateOperationItems`）
- `server/src/services/inventory/purchaseBatch.js`
- `server/src/services/inventory/purchaseReturnBatch.js`
- `server/src/services/inventory/saleBatch.js`
- `server/src/services/inventory/stateTransition.js`
- issue #961
