# 销售订单列表「老前端」整体清理（2026-10-29）

> 业务负责人定稿：销售订单列表**只剩三条路径** —— **交割单**（独立页）/ **售后单**（飞书扫一扫 → 售后落地页）/
> **草稿箱**（占位）。「以前点击订单列表直接给的那个前端」**不用保留**；它已经不需要的后端路由可以删；
> **但后端业务服务层必须保留**（写售后时要复用）。
>
> 分两刀：
> - **第一刀（PR #923，已合并）**：删旧详情里的「补收款 / 交付」两个内嵌入口 + `POST /sales/payments`、`POST /sales/deliveries`；
> - **第二刀（本 PR）**：删旧订单列表 / 订单详情 / 老售后折叠区 / 二次交付 / 补实收 / 补样品 / 待交割分组 /
>   钱货两清分类 / 旧 deep-link，以及它们已经没有活调用方的后端路由。

## 一、删除清单（本 PR）

### 前端 `server/public/workbench/features/orders/index.js`（1399 → 约 640 行）

| # | 删掉的 | 说明 |
|---|---|---|
| 1 | 老订单列表行（`ordersListHtml` / `lineHtml` / `detailsBlock`） | 只有不可达的「待交割列表」会渲染 |
| 2 | 老分组列表（`ordersSectionsHtml`，待交割三类细分） | 同上 |
| 3 | 钱货两清 / 待交割分类（`salesCategoryOf` / `salesInfoOf` / `salesSectionOf`） | 结果只喂给上面两个不可达列表 |
| 4 | 订单详情页（`orderDetailHtml` / `paymentBlock`） | 只有老列表「查看/操作」能进 |
| 5 | 逐件补实收 / 补样品 / 二次交付 表单与提交 | 都在老详情页里 |
| 6 | 老售后折叠区（退/换/赔表单、同款/换货品选择、差价建议、幂等 requestId） | 同上；**后端执行器/接口保留**，新售后独立页复用 |
| 7 | 旧售后 deep-link（`?after_sales_order=…`）+ 内部销售/采购子 tab | 新售后页已改扫一扫；单领域模式本来就没有子 tab |

同时删掉的配置（`server/public/workbench/config/orders.js`，363 → 144 行）：
`salesCategoryOf/salesInfoOf/salesSectionOf` 用的 `ORDER_STATE_FIELDS`、`DELIVERED_FULFILLMENT`、`PAID_PAYMENT_STATUS`、
`ORDERS_SUB_TABS`、`COLLECTION_METHODS` / `DEFAULT_COLLECTION_METHOD` / `REFUND_METHOD_PLACEHOLDER` / `RESTOCK_STATES`、
`AFTER_SALES_ACTIONS` / `SETTLEMENTS`、旧列表/详情/售后/二次交付/补实收/补样品的全部文案与接口常量。

### 后端（只删「没有活调用方」的路由；服务层一行不动）

| 路由 | 原调用方 | 处理 |
|---|---|---|
| `POST /api/workbench/sales/detail-amounts` | 老详情「补实收」 | **删路由** |
| `POST /api/workbench/sales/sample-fill` | 老详情「补样品」 | **删路由** |
| `POST /api/workbench/sales/retry` | 老详情「未完成可点重试」 | **删路由** |
| `POST /api/workbench/sales/second-delivery` | 老详情「二次交付」 | **删路由** |
| （PR #923 已删）`POST /sales/payments` · `POST /sales/deliveries` | 老详情「补收款 / 交付」 | 已删 |

## 二、明确保留（业务负责人点名 / 下一步要复用）

| 保留 | 为什么 |
|---|---|
| **三卡入口**（`ordersSectionCardsHtml` / `config/orders.js` 的 `SALES_SECTIONS`） | 订单列表页就是它 |
| **飞书扫一扫**（`scanAfterSales`）→ `/workbench/after-sales.html?productRecordId=…` | 售后单入口 |
| **首屏缓存三个纯函数**（`ORDERS_CACHE_KEY` / `readCachedOrders` / `writeCachedOrders` / `createFirstPaintLoader`） | 业务负责人点名保留；入口页**不拉订单**（e2e AC-ENTRY 钉住 0 个 `/sales/orders` 请求），缓存能力留给将来的列表 |
| **交割单独立页**及其接口 `/api/workbench/sales/delivery*` | 不是老订单列表的一部分，**不许删** |
| **售后后端全套**：`POST /api/workbench/sales/after-sales`、`GET /sales/after-sales/scan-candidates`、`AfterSalesService`、`WorkbenchOrderActionService`、`config/afterSales` | 新售后独立页（退货 + 换货，赔货灰度）要复用 |
| **业务服务层**：`SalesFollowupService`（`addPayment` / `updateDetailAmounts` / `fillSample` 等）、`salesDeliveryService`、`SecondDeliveryService`、`salesDeliveryPaymentService`、`samplePendingService` | 「只删页面接线，不删能力」；独立页以后从服务层接 |
| 采购验收页（`mode: 'purchase'`，hidden）+ `ARRIVAL_*` 配置 | 采购验收仍在用 |

## 三、验证（本 PR 的实际输出）

- 全量 `pnpm test`：**2261 条，0 fail，1 skip**；
- e2e（Playwright，mobile + tablet）：**40 passed**，含
  - `AC-ENTRY 工作台入口：订单列表「交割单」卡片跳到独立页（入口不拉订单）`；
  - `五个领域 tab + 订单列表懒加载`（三卡都在、入口 0 个 `/sales/orders` 请求）；
  - 售后扫一扫落地页（三按钮交互）。
- `size:check`：绿（orders/index.js 净减 ~760 行，config 净减 ~220 行）；
- `observability:events --check`：绿（事件目录与源码一致）；
- 未部署、未写生产 Base。

## 四、发现 / 未纳入

- `GET /api/workbench/sales/orders` 目前**没有活页面调用**（入口页按 e2e 口径不拉订单），
  但业务负责人要求「保留首屏缓存」，且它是**读取类**接口 ⇒ **本次保留**，等需要列表时再接。
- 采购验收页（`hidden: true`）仍挂载、仍可读采购申请；它不属于「老订单列表」，
  **本次不动**（要做清理另开任务）。
- 历史文档（`docs/workbench-two-tabs-and-external-query-2026-10-08.md` 等）里提到这些旧路由的记录**保留不改**（历史事实）。
