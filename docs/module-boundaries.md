# V1 模块边界与接口

这不是“模块之间完全没有依赖”：一笔交易会涉及商品、销售、收款和库存。目标是依赖明确的业务接口，而不是让一个模块改写另一个模块的内部字段或让页面直接计算业务结果。

| 模块 | 负责的事实 | 供其他模块调用的接口 | 不负责 |
| --- | --- | --- | --- |
| 销售 | 一张销售主单、多条商品明细及确认状态 | `SalesOrderService.confirm(input)`；`SalesDeliveryService.deliver(input)` | 收款记录实现、库存流水实现、采购入库 |
| 收款 | 一次实际收款一条记录；同一销售单可有多笔 | `PaymentService.record(input)`；`recordInitialBatch(orderId, payments)` | 销售明细、库存变化、金额公式 |
| 库存 | 库存流水及一双一条的实时库存 | `InventoryService.applySale(input)`；`applyPurchase(input)` | 判断订单是否已付款、解析销售或采购原文 |
| 采购 | 报单、到货确认及采购入库事实 | `PurchaseWebhookService` 接受 record_id；确认到货后调用 `InventoryService.applyPurchase` | 销售单、收款记录 |
| 查询 | 将飞书表记录转换为稳定的工作台响应 | `GET /api/workbench/sales/today`；`GET /api/workbench/inventory` | 写入、修正业务事实或在浏览器重复计算 |

## 调用顺序与不变量

- 首次销售确认：销售主表 → 销售明细 → 本次收款记录（零笔或多笔）。**不扣库存**。一单多鞋共用一张销售主表。
- 后续补款：只新增收款记录，不重建销售明细，也不触碰库存。
- 实际交付：交付服务核对销售明细，再调用库存的 `applySale`，成功后更新交付数量和履约状态。当前一条明细只支持一次性交付全部数量。
- 采购申请不改变库存；确认实际到货、写入采购入库明细后，采购模块调用库存的 `applyPurchase`（受现有开关控制）。
- 库存操作以来源明细 ID 做幂等键；销售明细与采购入库明细是两种不同的来源。其他模块不要直接创建库存流水或实时库存记录。
- 飞书字段名和表 ID 统一由 `v1BitableSchema.js` 与 `V1BitableGateway` 映射。字段变更先调整映射并运行相应范围的 schema-check，不在页面中硬编码中文字段名。

## 对页面开发的交接

查询页只修改 `server/public/workbench/`，遵守 [工作台查询接口约定](workbench-query-contract.md)。如需新查询指标，先讨论业务定义，由后端增加/修改查询响应和测试；页面只展示已定义的数据。`/api/workbench/sales/payments`、`/sales/deliveries` 是写入入口，不能为了做查询页而更改其请求或重试语义。

`LarkMvpService` 当前仍是机器人销售与旧采购卡片的共享入口，属于后续可继续拆分的编排层；改此文件时必须同时运行销售和采购回归测试。V1 的共用飞书网关也是刻意共享的基础设施，因此不能承诺字段重命名对其他模块完全无影响。
