const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');

const amount = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || Math.abs(Math.round(number * 100) - number * 100) > 1e-6) {
    throw new Error('收款金额必须是大于 0 的两位小数');
  }
  return number;
};

class PaymentService {
  constructor({ gateway, references } = {}) {
    if (!gateway) throw new Error('PaymentService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
  }

  async recordsForSale(salesEntryRecordId) {
    const field = this.gateway.table('paymentRecord').fields.salesEntry;
    return (await this.gateway.listAll('paymentRecord')).filter((record) =>
      linkedRecordIds(record.fields?.[field]).includes(salesEntryRecordId));
  }

  async record({ salesEntryRecordId, method, amount: rawAmount, operatorOpenId, receivedAt }) {
    if (!salesEntryRecordId) throw new Error('收款缺少销售主表 record_id');
    const paid = amount(rawAmount);
    const paymentMethod = await this.references.resolvePaymentMethod(method);
    if (!paymentMethod) throw new Error('收款缺少支付方式');
    return this.gateway.create('paymentRecord', {
      salesEntry: relation(salesEntryRecordId),
      method: relation(paymentMethod.recordId),
      amount: paid,
      receivedAt: Number(receivedAt || Date.now()),
      operator: person(operatorOpenId),
    });
  }

  // First confirmation may contain multiple payment methods. Match existing
  // receipts before creating missing ones so a response loss can be retried.
  async recordInitialBatch(salesEntryRecordId, payments = []) {
    if (!Array.isArray(payments)) throw new Error('收款记录必须是数组');
    const expected = payments.map((payment) => {
      if (!payment || typeof payment !== 'object') throw new Error('收款记录格式无效');
      return { ...payment, amount: amount(payment.amount) };
    });
    const existing = await this.recordsForSale(salesEntryRecordId);
    const fields = this.gateway.table('paymentRecord').fields;
    const used = new Set();
    const rows = [];
    for (const payment of expected) {
      const method = await this.references.resolvePaymentMethod(payment.method);
      if (!method) throw new Error('收款缺少支付方式');
      const paid = amount(payment.amount);
      const match = existing.find((record) => !used.has(record.record_id) &&
        linkedRecordIds(record.fields?.[fields.method]).includes(method.recordId) &&
        Number(textValue(record.fields?.[fields.amount])) === paid);
      if (match) used.add(match.record_id);
      rows.push({ payment, recordId: match?.record_id || '' });
    }
    if (existing.some((record) => !used.has(record.record_id))) {
      throw new Error('已有收款与当前销售草稿不一致，已停止自动重试');
    }
    for (const row of rows) {
      if (row.recordId) continue;
      row.recordId = (await this.record({ salesEntryRecordId, ...row.payment })).recordId;
    }
    return rows.map((row) => row.recordId);
  }
}

module.exports = { PaymentService, amount };
