# 销售查询自研页（2026-11-18）

## 入口

工作台 → 销售 → 销售查询。

2026-11-18 起从飞书仪表盘外链改为工作台自研页面：

- 配置：`server/public/workbench/config/salesQuery.js`
- 页面：`server/public/workbench/features/sales-query/index.js`
- 后端：`server/src/services/salesQueryService.js`
- 接口：`GET /api/workbench/sales/query?from=YYYY-MM-DD&to=YYYY-MM-DD`

默认今天，上海时区，日期闭区间。

## 第一段：销售金额

来源：S交易明细。

```text
营业总额 = 收付日在区间内 + 钱款状态 ∈ {已收款, 待平台结算} 的交易金额合计
```

按支付方式分组。非鞋类收款（没有关联销售单）计入营业总额。

## 第二段：销售数量

来源：销售明细。

```text
销售日在区间内
履约状态 ∈ {已交付, 未交付}
排除：已退货 / 已换货 / 已赔货
```

按销售明细的 lookup 字段「类别」「品类」分组，同时输出数量与实收金额。

## 第三段：销售明细

来源：销售主表 / 销售明细 / S交易明细。

- 按销售主表「录单日」筛选；
- 一个销售单号一个区块；
- 总金额取销售主表「总金额」；
- 保留全部明细与履约状态；
- 收款方式来自 S交易明细，放在金额下面；
- 非鞋类收款不生成区块。

## 验证

- 2588 tests / 2587 pass / 0 fail / 1 skip
- size / observability 绿
