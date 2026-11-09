# V1 模块边界与接口

这不是“模块之间完全没有依赖”：一笔交易会涉及商品、销售、收款和库存。目标是依赖明确的业务接口，而不是让一个模块改写另一个模块的内部字段或让页面直接计算业务结果。

| 模块 | 负责的事实 | 供其他模块调用的接口 | 不负责 |
| --- | --- | --- | --- |
| 销售 | 一张销售主单、多条商品明细及写入状态 | `SalesOrderService.confirm(input)`；`SalesDeliveryService.deliver(input)` | 收款记录实现、库存流水实现、采购事实 |
| 收款 | 一次实际收款一条记录；同一销售单可有多笔 | `PaymentService.record(input)`；`recordInitialBatch(orderId, payments)` | 销售明细、库存变化、金额公式 |
| 库存 | 库存流水及一双一条的实时库存 | `InventoryService.applySale(input)`；`applyPurchase(input)`；`applyPurchaseBatch(entries)` | 判断订单是否已付款、解析销售或采购原文 |
| 采购 | 报货申请与到货验收事实（落「采购主表」） | `PurchaseWebhookService.publishPurchaseRequest`；工作台验收 → `PurchaseArrivalConversationService` / `scanArrivalService` → `InventoryService.applyPurchaseBatch` | 销售单、收款记录 |
| 查询 | 将飞书表记录转换为稳定的工作台响应 | `GET /api/workbench/inventory`（+ `/inventory/products`、`/inventory/stock`、`/inventory/categories` —— 都是「库存手工调整」页在用） | 写入、修正业务事实或在浏览器重复计算 |

> ⚠️ **2026-10-08**：`GET /api/workbench/sales/today` 与 `GET /api/workbench/sales/query` 这两条
> **自建的销售查询接口已删除**（业务负责人逐字：「现有的**我们自己搭的**销售查询/库存查询页面与接口
> （`/api/workbench/*`），**顺手删掉**～」）—— 销售查询 / 库存查询都改走**飞书多维表格网页外链**
> （工作台「信息查询」两个板块的两张卡），这一维**不再自建接口**。
> ⚠️ **`GET /api/workbench/inventory` 保留**：它是**共用**的（「库存手工调整」页在用），不是孤儿。
> 逐条对照见 `docs/workbench-two-tabs-and-external-query-2026-10-08.md`。

## 调用顺序与不变量

- 首次销售确认：销售主表 → 销售明细 → 本次收款记录（零笔或多笔）。**不扣库存**。一单多鞋共用一张销售主表。
- 后续补款：只新增收款记录，不重建销售明细，也不触碰库存。
- 实际交付：交付服务核对销售明细，再调用库存的 `applySale`，成功后更新交付数量和履约状态。当前一条明细只支持一次性交付全部数量。
- 采购申请不改变库存；验收确认后按**实到数量**加库存（`InventoryService.applyPurchaseBatch`），并回写「采购主表」的到货状态与批次累计（实际数量 / 发生金额）。🔴 **不写任何入库明细**——「采购入库」表已于 2026-10-07 整表删除，行为开关同批删除；退货**不需要验收**。
- 库存操作幂等键：销售侧用来源明细 ID；采购加库存用 `STOCK_MOVEMENTS[*].operationKey`（批次 record id｜货品｜尺码）——两者**不是**同一种来源。其他模块不要直接创建库存流水或实时库存记录。
- 飞书字段名和表 ID 统一由 `v1BitableSchema.js` 与 `V1BitableGateway` 映射。字段变更先调整映射并运行相应范围的 schema-check，不在页面中硬编码中文字段名。

## 对页面开发的交接

查询页只修改 `server/public/workbench/`，遵守 [工作台查询接口约定](workbench-query-contract.md)。如需新查询指标，先讨论业务定义，由后端增加/修改查询响应和测试；页面只展示已定义的数据。`/api/workbench/sales/payments`、`/sales/deliveries` 是写入入口，不能为了做查询页而更改其请求或重试语义。

`LarkMvpService` 现在承担消息入口守卫（群聊 / 私聊消息到达即拒绝，不建任务、不读表、不写表）与部分共享编排；群聊销售入口与旧采购卡片已于 2026-10-12 退场。改此文件时必须同时运行销售和采购回归测试。V1 的共用飞书网关也是刻意共享的基础设施，因此不能承诺字段重命名对其他模块完全无影响。
