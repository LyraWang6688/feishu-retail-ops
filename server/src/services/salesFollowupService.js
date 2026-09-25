const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { PaymentService, amount } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService, progressFromRecords, cents } = require('./salesProgressService');

class SalesFollowupService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
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
      orders: orders.filter((order) => textValue(order.fields?.[orderFields.confirmStatus]) === '已入账')
        .map((order) => {
          const orderDetails = details.filter((detail) => linkedRecordIds(detail.fields?.[detailFields.salesEntry]).includes(order.record_id));
          const orderPayments = payments.filter((payment) => linkedRecordIds(payment.fields?.[paymentFields.salesEntry]).includes(order.record_id));
          const progress = progressFromRecords(orderDetails, orderPayments, detailFields, paymentFields);
          return {
          record_id: order.record_id,
          order_no: textValue(order.fields?.[orderFields.orderNo]) || order.record_id,
          fulfillment_status: progress.fulfillmentStatus,
          payment_status: progress.paymentStatus,
          receivable_amount: progress.receivableAmount,
          paid_amount: progress.paidAmount,
          pending_amount: progress.pendingAmount,
          pending_delivery_quantity: progress.pendingDeliveryQuantity,
          details: orderDetails
            .map((detail) => ({
              record_id: detail.record_id,
              product: productById.get(linkedRecordIds(detail.fields?.[detailFields.product])[0]) || '',
              size: Number(textValue(detail.fields?.[detailFields.size])),
              quantity: Number(textValue(detail.fields?.[detailFields.quantity])),
              delivered_quantity: Number(textValue(detail.fields?.[detailFields.deliveredQuantity]) || 0),
              actual_amount: textValue(detail.fields?.[detailFields.actualAmount]) === '' ? null : Number(textValue(detail.fields?.[detailFields.actualAmount])),
            })),
          payments: orderPayments
            .map((payment) => ({
              record_id: payment.record_id,
              amount: Number(textValue(payment.fields?.[paymentFields.amount])),
              method: methodById.get(linkedRecordIds(payment.fields?.[paymentFields.method])[0]) || '',
            })),
        }; })
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
      if (textValue(order?.fields?.[fields.confirmStatus]) !== '已入账') throw new Error('销售订单尚未确认入账');
      amount(input.amount);
      const before = await this.progress.forOrder(input.salesEntryRecordId);
      if (before.pendingAmount === null) throw new Error('销售明细尚未填写成交金额，不能计算待收款');
      if (cents(input.amount, '收款金额') > cents(before.pendingAmount, '待收金额')) {
        throw new Error(`本次收款超过待收金额 ￥${before.pendingAmount}`);
      }
      if (!await this.payments.references.resolvePaymentMethod(input.method)) throw new Error('收款缺少支付方式');
      await this.store.create({ task_id: taskId, fingerprint, status: 'pending' });
      const created = await this.payments.record(input);
      const result = { recordId: created.recordId };
      await this.store.update(taskId, { status: 'recorded', result });
      await this.progress.sync(input.salesEntryRecordId, { paymentRecordIds: [created.recordId] });
      await this.store.update(taskId, { status: 'completed', result });
      return result;
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

module.exports = { SalesFollowupService };
