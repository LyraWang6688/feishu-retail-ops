const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { PaymentService, amount } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService, progressFromRecords, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { logWarn } = require('../utils/logger');

class SalesFollowupService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
    // 「尺码」是关联字段：待交付列表里的尺码要走共享解析，不靠关联单元格的显示文本。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences: options.sizeReferences });
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/sales_followup_tasks'), idField: 'task_id',
    });
    this.queue = Promise.resolve();
  }

  async listOrders() {
    const [orders, details, methods, payments, products] = await Promise.all([
      this.gateway.listAll('salesEntry'), this.gateway.listAll('salesDetail'),
      this.gateway.listAll('paymentMethod'), this.gateway.listAll('paymentRecord'),
      this.gateway.listAll('product'),
    ]);
    const orderFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const methodFields = this.gateway.table('paymentMethod').fields;
    const productFields = this.gateway.table('product').fields;
    const methodById = new Map(methods.map((item) => [item.record_id, textValue(item.fields?.[methodFields.name])]));
    const productById = new Map(products.map((item) => [item.record_id,
      textValue(item.fields?.[productFields.number]) || item.record_id]));
    return {
      methods: [...new Set(methodById.values())].filter(Boolean),
      // ⭐ 「账做完了没有」= 两代字面量都算（见 config/salesStatusDimensions 的 POSTED_VALUES）。
      orders: (await Promise.all(orders.filter((order) => isPosted(postedOf(order, orderFields)))
        .map(async (order) => {
          const orderNo = textValue(order.fields?.[orderFields.orderNo]) || order.record_id;
          try {
            const orderDetails = details.filter((detail) => linkedRecordIds(detail.fields?.[detailFields.salesEntry]).includes(order.record_id));
            const orderPayments = payments.filter((payment) => linkedRecordIds(payment.fields?.[paymentFields.salesEntry]).includes(order.record_id));
            const progress = progressFromRecords(orderDetails, orderPayments, detailFields, paymentFields);
            return {
              record_id: order.record_id,
              order_no: orderNo,
              fulfillment_status: progress.fulfillmentStatus,
              payment_status: progress.paymentStatus,
              receivable_amount: progress.receivableAmount,
              paid_amount: progress.paidAmount,
              pending_amount: progress.pendingAmount,
              platform_pending_amount: progress.platformPendingAmount,
              pending_delivery_quantity: progress.pendingDeliveryQuantity,
              details: await Promise.all(orderDetails
                .map(async (detail) => {
                  // ⭐ 2026-10-09（工作台订单列表要"点进去操作"）：
                  //   明细上多带两个**只读的关联 record_id**（货品 / 尺码），页面才能把
                  //   「换货同款换码」「售后指哪一条明细」原样交给既有业务层。
                  //   ⚠️ 纯新增字段：既有字段名与取值一个字节没动（既有用例仍逐条断言）。
                  const sizeEntry = await this.getSizeReferences()
                    .resolveLinkedCell(detail.fields?.[detailFields.size]);
                  return {
                    record_id: detail.record_id,
                    product: productById.get(linkedRecordIds(detail.fields?.[detailFields.product])[0]) || '',
                    product_record_id: linkedRecordIds(detail.fields?.[detailFields.product])[0] || '',
                    size: sizeEntry.size,
                    size_record_id: sizeEntry.recordId || '',
                    quantity: 1,
                    delivered_quantity: textValue(detail.fields?.[detailFields.fulfillmentStatus]) === '已交付' ? 1 : 0,
                    fulfillment_status: textValue(detail.fields?.[detailFields.fulfillmentStatus]) || '未交付',
                    actual_amount: textValue(detail.fields?.[detailFields.actualAmount]) === '' ? null : Number(textValue(detail.fields?.[detailFields.actualAmount])),
                  };
                })),
              payments: orderPayments
                .map((payment) => ({
                  record_id: payment.record_id,
                  amount: Number(textValue(payment.fields?.[paymentFields.amount])),
                  status: textValue(payment.fields?.[paymentFields.status]) || '已收款',
                  received_at: payment.fields?.[paymentFields.receivedAt] || null,
                  method: methodById.get(linkedRecordIds(payment.fields?.[paymentFields.method])[0]) || '',
                })),
            };
          } catch (error) {
            // ⭐ 2026-10-08 小修（业务负责人批准的"小修"）：**单条订单出问题不许整页失败**。
            //   线上事实（2026-10-08 01:41 +8）：一条含「已换货」明细的销售单，让
            //   `GET /api/workbench/sales/orders` 整页 500（event=workbench.sales.orders.failed）。
            //   ⚠️ 语义层的缺口已经堵上（`progressFromRecords` 现在认 `已退货 / 已换货 / 已赔货`，
            //      判据 = config/afterSales.isAfterSalesFulfillment）；这一层管的是**剩下的**
            //      单条数据不自洽（例：收款状态是预期之外的取值、收款超过成交额、尺码关联解析不出来）
            //      —— 跳过该单、如实记一条 warn，其余订单**照常返回**。
            //   ⚠️ **不是静默吞错**：warn 带 `order_no` 与原因；计算器本身照旧大声抛
            //      （预期之外的状态不会在这里被当成已知）。
            logWarn('workbench.sales.orders.order_skipped', {
              order_no: orderNo,
              sales_entry_record_id: order.record_id,
              error: error.message,
              hint: '这一单的数据不自洽，已跳过；其余订单照常返回',
            });
            return null;
          }
        })))
        .filter(Boolean)
        .reverse(),
    };
  }

  async addPayment(input) {
    const work = async () => {
      const requestId = String(input.requestId || '');
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('收款请求缺少有效 request_id');
      const taskId = `payment_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
      const fingerprint = JSON.stringify([input.salesEntryRecordId, input.method, Number(input.amount), input.operatorOpenId]);
      const existing = await this.store.get(taskId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('request_id 对应的收款内容不一致');
        if (existing.status === 'completed') return existing.result;
        if (existing.status === 'recorded') {
          await this.progress.sync(input.salesEntryRecordId, { paymentRecordIds: [existing.result.recordId] });
          await this.store.update(taskId, { status: 'completed' });
          return existing.result;
        }
        throw new Error('这笔收款结果待核对，请勿重新提交');
      }
      const order = await this.gateway.get('salesEntry', input.salesEntryRecordId);
      const fields = this.gateway.table('salesEntry').fields;
      if (!isPosted(postedOf(order, fields))) throw new Error('销售订单尚未确认入账');
      amount(input.amount);
      const before = await this.progress.forOrder(input.salesEntryRecordId);
      if (before.pendingAmount === null) throw new Error('销售明细尚未填写成交金额，不能计算待收款');
      if (cents(input.amount, '收款金额') > cents(before.pendingAmount, '待收金额')) {
        throw new Error(`本次收款超过待收金额 ￥${before.pendingAmount}`);
      }
      if (!await this.payments.references.resolvePaymentMethod(input.method)) throw new Error('收款缺少支付方式');
      const pending = (await this.payments.recordsForSale(input.salesEntryRecordId)).filter((record) =>
        textValue(record.fields?.[this.gateway.table('paymentRecord').fields.status]) === '未收款');
      if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
      if (pending.length && cents(input.amount, '收款金额') !== cents(
        textValue(pending[0].fields?.[this.gateway.table('paymentRecord').fields.amount]), '待收记录金额')) {
        throw new Error('本版请一次收清这条待收款记录；分笔补款暂不支持');
      }
      await this.store.create({ task_id: taskId, fingerprint, status: 'pending' });
      const result = pending.length
        ? { recordId: pending[0].record_id } : { recordId: (await this.payments.record(input)).recordId };
      if (pending.length) await this.payments.collectPendingReceipt(result.recordId, input);
      await this.store.update(taskId, { status: 'recorded', result });
      await this.progress.sync(input.salesEntryRecordId, { paymentRecordIds: [result.recordId] });
      await this.store.update(taskId, { status: 'completed', result });
      return result;
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

module.exports = { SalesFollowupService };
