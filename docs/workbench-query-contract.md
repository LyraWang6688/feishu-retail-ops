# 工作台查询页接口约定（V1）

页面只调用同域名的 `/api/workbench/*` 接口，由现有飞书网页登录会话鉴权；不要在浏览器中使用飞书应用密钥、直连多维表格，或重新实现销售、收款、库存计算。

## 今日销售明细

`GET /api/workbench/sales/today`，可选 `?date=YYYY-MM-DD`，不传时按北京时间的今天查询。只返回已确认的销售明细；日期优先取明细的“销售日”，缺失时取关联销售主表的“发送时间”。两者都缺失的记录不计入当天。

响应主要字段：

- `date`：业务日期。
- `summary.order_count`：去重后的销售单数。
- `summary.detail_count`、`summary.quantity`：明细数、商品数量。
- `summary.receivable_amount`：当天明细的公式应收合计；只要有一条明细的公式值缺失，就返回 `null`，页面须显示“待公式计算”，不能显示 0 元。
- `summary.paid_amount`、`summary.payment_summary`：这些**当天销售单截至查询时**累计收到的钱及支付方式分布；不是“当天收到的所有款”，后续补收旧订单尾款不会计入这里。
- `rows[]`：每条销售明细一行，包含 `record_id`、`sales_entry_record_id`、`sales_order_no`、`sold_at`、`product_number`、`item_no`、`color`、`size`、`quantity`、`gift`、`receivable_amount`、`payment_method`。其中 `payment_method` 是所属订单的收款方式展示，不是这条商品独立收款；`receivable_amount` 缺失时为 `null`。

不要把整单收款金额复制到每条商品行再相加。若将来需要“今日到账”，应新增以收款时间筛选 `paymentRecord` 的独立接口。

## 实时库存

`GET /api/workbench/inventory?keyword=...&size=...`。`rows[]` 按货品 record_id、尺码、所属状态分组；`quantity` 为该组在实时库存表中的记录数，一条库存记录代表一双。页面只展示返回值，不自行套用库存流水或采购申请计算数量。

## 页面开发边界

页面代码归 `server/public/workbench/`；查询规则归后端 `server/src/services/v1WorkbenchService.js`。单纯调整布局、导航、移动端卡片时，不要修改机器人、采购、销售入账、收款写入、库存写入服务。后端响应字段若要变更，先更新本约定和回归测试。`POST /api/workbench/sales/payments` 与 `/sales/deliveries` 是写入接口，不属于查询页重设计范围。
