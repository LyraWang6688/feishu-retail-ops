# 工作台查询页接口约定（V1）

页面只调用同域名的 `/api/workbench/*` 接口，由现有飞书网页登录会话鉴权；不要在浏览器中使用飞书应用密钥、直连多维表格，或重新实现销售、收款、库存计算。

## 今日销售明细

`GET /api/workbench/sales/today`，可选 `?date=YYYY-MM-DD`，不传时按北京时间的今天查询。只返回已确认的销售明细；日期优先取明细的“销售日”，缺失时取关联销售主表的“发送时间”。两者都缺失的记录不计入当天。

响应主要字段：

- `date`：业务日期。
- `summary.order_count`：去重后的销售单数。
- `summary.detail_count`、`summary.quantity`：明细数、商品数量。
- `summary.receivable_amount`：当天明细“成交金额”合计；只要有一条明细缺少成交金额，就返回 `null`，页面显示“待录入”，不能显示 0 元。货品标价公式不作为真实成交额。
- `summary.paid_amount`、`summary.payment_summary`：这些**当天销售单截至查询时已收清**的钱及支付方式分布；不是“当天收到的所有款”，后续补收旧订单尾款不会计入这里。
- `summary.platform_pending_amount`：这些销售单尚待平台结算的券款，不计入已收金额。
- `rows[]`：每条销售明细一行，包含 `record_id`、`sales_entry_record_id`、`sales_order_no`、`sold_at`、`product_number`、`item_no`、`color`、`size`、`quantity`、`gift`、`receivable_amount`、`list_amount`、`payment_method`。`receivable_amount` 对应真实成交金额，`list_amount` 对应表格标价公式；`payment_method` 是所属订单的收款方式展示，不是这条商品独立收款。

不要把整单收款金额复制到每条商品行再相加。若将来需要“今日到账”，应新增以收款时间筛选 `paymentRecord` 的独立接口。

## 实时库存

`GET /api/workbench/inventory?keyword=...&size=...`。`rows[]` 按货品 record_id、尺码、所属状态分组；`quantity` 为该组在实时库存表中的记录数，一条库存记录代表一双。页面只展示返回值，不自行套用库存流水或采购申请计算数量。

## 后续收款与交付

`GET /api/workbench/sales/orders` 返回已入账订单的 `orders[]`。每单包含 `receivable_amount`（明细成交金额合计，缺失时 `null`）、`paid_amount`（已收清金额）、`platform_pending_amount`（待平台结算金额）、`pending_amount`（仍需向顾客收取的余额）、`payment_status`、`fulfillment_status`、`pending_delivery_quantity`、`details[]`、`payments[]`。每条 `payments[]` 包含 `status` 和 `received_at`。工作台筛出 `pending_amount > 0` 的待收款订单，以及 `pending_delivery_quantity > 0` 的待交付订单；无需预建待收款占位记录。明细包含 `actual_amount`、`quantity`、`delivered_quantity`。

`POST /api/workbench/sales/payments` 仅在实际收到款时新增收款记录，不得超过待收金额。`POST /api/workbench/sales/deliveries` 只对选中的未交付明细扣减门盒库存，门盒不足时扣样品并触发补样品提醒；不自动扣仓库。每条明细当前一次性交付全部数量。两者完成后重新从明细和收款记录同步销售主表状态。

## 采购管理（只读）

采购页面有三个独立的飞书表单入口：货品上新、供应商报货、到货验收。表单仍在飞书录入；页面只负责打开入口和查询进度。

`GET /api/workbench/purchase/requests` 返回 `{success, rows, total}`，支持 `batchNo`、`arrivalStatus` 精确筛选。每行包含 `record_id`、`batch_no`、`product_number`、`product_record_id`、`size`、`quantity`、`arrival_status`、`reported_at`、`supplier_record_id`。

`GET /api/workbench/purchase/arrivals` 返回 `{success, rows, total}`，支持 `batchNo`、`confirmStatus`、`recognitionStatus` 精确筛选。每行包含 `record_id`、`batch_no`、`batch_record_id`、`supplier_record_id`、`arrival_at`、`recognition_status`、`confirm_status`、`failure_reason`、`image_count`。

两个接口都与销售查询共用飞书网页登录鉴权、禁止浏览器直连飞书 OpenAPI。查询失败返回 HTTP 502 和 `{success:false,error}`；页面必须显示错误，不能把失败显示成“暂无记录”。

## 页面开发边界

页面代码归 `server/public/workbench/`；业务规则归后端服务。单纯调整布局、导航、移动端卡片时，不要修改机器人、采购、销售入账、收款写入、库存写入服务。后端响应字段若要变更，先更新本约定和回归测试。
