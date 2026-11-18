# 库存流水子 tab（2026-11-18）

## 页面

工作台 → 库存：

~~~text
手工调整 / 库存流水 / 全仓查询
~~~

「库存流水」只读，展示：

- 库存行为
- 编号
- 尺码
- 变动数量

按「库存流水.创建时间」由近及远排序。

## 数据源

- 表：库存流水
- 字段映射：server/src/config/v1BitableSchema.js
  - ledgerCreatedAt（只读「创建时间」）
  - behavior / product / size / quantityChange
- 接口：GET /api/workbench/inventory/ledger
- 一次返回最近 200 条；页面显示总条数，并标明只显示最近 200 条

## 配置

- 子 tab：server/public/workbench/config/domains.js
- 页面字段 / 文案 / 接口：server/public/workbench/config/inventoryLedger.js
- 返回条数：server/src/config/workbenchQuery.js 的 WORKBENCH_LEDGER_LIMIT
- 渲染：server/public/workbench/features/inventory/ledger.js
- 样式：server/public/workbench/features/inventory/ledger.css（沿用工作台 tokens）

## 说明

只读，不写库存流水，不改变库存数据。
