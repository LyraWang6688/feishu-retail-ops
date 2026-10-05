const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');

const amount = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || Math.abs(Math.round(number * 100) - number * 100) > 1e-6) {
    throw new Error('收款金额必须是大于 0 的两位小数');
  }
  return number;
};
const normalizedStatus = (value) => ['已收清', '已结清'].includes(value) ? '已收款' : value || '已收款';

// 「收款明细.交易方向」是单选（收入 / 退回），和售后链路写「退回」用的是同一套选项。
//
// 为什么只写「收入」这一种：本次只做正常收款。钱真到账才算一次收款事实，
// 所以只在状态落成「已收款」的那一刻写；「未收款」「待平台结算」**刻意留空**——
// 钱还没到，方向还没发生，提前写一个「收入」等于把没收到的钱记成已收。
const MONEY_DIRECTION_INCOME = '收入';

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

  async record({ salesEntryRecordId, method, amount: rawAmount, operatorOpenId, receivedAt,
    status = '已收款' }) {
    status = normalizedStatus(status);
    if (!salesEntryRecordId) throw new Error('收款缺少销售主表 record_id');
    if (!['已收款', '未收款', '待平台结算'].includes(status)) throw new Error('收款状态无效');
    if (status !== '已收款' && receivedAt != null) throw new Error('尚未到账的收款不能填写收款时间');
    const paid = amount(rawAmount);
    const paymentMethod = status === '未收款' ? null : await this.references.resolvePaymentMethod(method);
    if (status !== '未收款' && !paymentMethod) throw new Error('收款缺少支付方式');
    return this.gateway.create('paymentRecord', {
      salesEntry: relation(salesEntryRecordId),
      method: paymentMethod ? relation(paymentMethod.recordId) : undefined,
      amount: paid,
      status,
      receivedAt: status === '已收款' ? Number(receivedAt ?? Date.now()) : undefined,
      // 只有真收到钱的那一条才有方向；未收款不写（见 MONEY_DIRECTION_INCOME 的注释）。
      ...(status === '已收款' ? { tradeDirection: MONEY_DIRECTION_INCOME } : {}),
    });
  }

  async collectPendingReceipt(recordId, { salesEntryRecordId, amount: rawAmount, method, operatorOpenId,
    receivedAt = Date.now() }) {
    const record = await this.gateway.get('paymentRecord', recordId);
    const fields = this.gateway.table('paymentRecord').fields;
    if (!record || !linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId)) {
      throw new Error('待收款记录不属于此销售单');
    }
    if (textValue(record.fields?.[fields.status]) !== '未收款') throw new Error('此记录已不是待收款');
    if (amount(rawAmount) !== Number(textValue(record.fields?.[fields.amount]))) {
      throw new Error('本次金额必须等于这条待收款记录的金额');
    }
    const timestamp = Number(receivedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('实际收款时间无效');
    const paymentMethod = await this.references.resolvePaymentMethod(method);
    if (!paymentMethod) throw new Error('收款缺少支付方式');
    return this.gateway.update('paymentRecord', recordId, {
      status: '已收款', method: relation(paymentMethod.recordId),
      receivedAt: timestamp,
      // 「未收款 → 已收款」这一下就是钱到账的那一下：补齐方向（原来留空）。
      tradeDirection: MONEY_DIRECTION_INCOME,
    });
  }

  async settlePlatformReceipt(recordId, receivedAt = Date.now()) {
    if (!recordId) throw new Error('缺少收款记录 record_id');
    const timestamp = Number(receivedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('实际收款时间无效');
    const record = await this.gateway.get('paymentRecord', recordId);
    if (!record) throw new Error('收款记录不存在');
    const fields = this.gateway.table('paymentRecord').fields;
    const status = textValue(record.fields?.[fields.status]);
    if (status === '已收款' || status === '已收清') return record;
    if (status !== '待平台结算') throw new Error('只有待平台结算的收款可结清');
    // 平台结算到账同样是"钱收到了"，方向这时才补上（待平台结算期间一直留空）。
    return this.gateway.update('paymentRecord', recordId, {
      status: '已收款', receivedAt: timestamp, tradeDirection: MONEY_DIRECTION_INCOME,
    });
  }

  // First confirmation may contain multiple payment methods. Match existing
  // receipts before creating missing ones so a response loss can be retried.
  async recordInitialBatch(salesEntryRecordId, payments = [], options = {}) {
    if (!Array.isArray(payments)) throw new Error('收款记录必须是数组');
    const expected = payments.map((payment) => {
      if (!payment || typeof payment !== 'object') throw new Error('收款记录格式无效');
      return { ...payment, amount: amount(payment.amount), status: normalizedStatus(payment.status) };
    });
    if ((options.knownRecordIds || []).slice(expected.length).some(Boolean)) {
      throw new Error('已保存的收款数量超过当前草稿，已停止重试');
    }
    const existing = await withSalesReadRetry(
      () => this.recordsForSale(salesEntryRecordId), 'sale_payment_list',
    );
    const fields = this.gateway.table('paymentRecord').fields;
    for (const id of options.knownRecordIds || []) {
      if (!id || existing.some((record) => record.record_id === id)) continue;
      existing.push(await withSalesReadRetry(
        () => readSaleLinkedRecord(this.gateway, 'paymentRecord', id, fields.salesEntry, salesEntryRecordId),
        'sale_payment_by_id',
      ));
    }
    const used = new Set();
    const reserved = new Set((options.knownRecordIds || []).filter(Boolean));
    const rows = [];
    for (const [index, payment] of expected.entries()) {
      const status = payment.status;
      const method = status === '未收款' ? null : await this.references.resolvePaymentMethod(payment.method);
      if (status !== '未收款' && !method) throw new Error('收款缺少支付方式');
      const paid = amount(payment.amount);
      const knownId = options.knownRecordIds?.[index];
      const match = existing.find((record) => !used.has(record.record_id) &&
        (knownId ? record.record_id === knownId : !reserved.has(record.record_id)) &&
        (method ? linkedRecordIds(record.fields?.[fields.method]).includes(method.recordId) :
          linkedRecordIds(record.fields?.[fields.method]).length === 0) &&
        Number(textValue(record.fields?.[fields.amount])) === paid &&
        normalizedStatus(textValue(record.fields?.[fields.status])) === status);
      if (knownId && !match) throw new Error(`已记录的收款 ${knownId} 与当前销售草稿不一致，已停止重试`);
      if (match) used.add(match.record_id);
      rows.push({ payment, recordId: match?.record_id || '', index });
    }
    if (existing.some((record) => !used.has(record.record_id))) {
      throw new Error('已有收款与当前销售草稿不一致，已停止自动重试');
    }
    for (const row of rows) {
      if (!row.recordId) row.recordId = (await this.record({ salesEntryRecordId, ...row.payment })).recordId;
      await options.onRecordPersisted?.(row.index, row.recordId);
    }
    return rows.map((row) => row.recordId);
  }
}

module.exports = { PaymentService, amount };
