const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { PaymentService } = require('./paymentService');
const { SalesProgressService, cents } = require('./salesProgressService');
const { logInfo, logError } = require('../utils/logger');

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
};

class SalesOrderService {
  constructor({ gateway, references, payments, progress } = {}) {
    if (!gateway) throw new Error('SalesOrderService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
    this.payments = payments || new PaymentService({ gateway, references: this.references });
    this.progress = progress || new SalesProgressService({ gateway });
    this.queue = Promise.resolve();
  }

  confirm(input) {
    const next = this.queue.then(() => this._confirm(input), () => this._confirm(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _confirm(input) {
    const salesEntryRecordId = input.salesEntryRecordId;
    if (!salesEntryRecordId) throw new Error('缺少销售主表 record_id');
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('至少需要一条销售明细');
    await this.gateway.validateTables?.(['product', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord']);
    await this.gateway.update('salesEntry', salesEntryRecordId, { confirmStatus: '入账中', failureReason: '' });
    try {
      const expected = [];
      for (const item of input.items) {
        const product = await this.references.resolveProduct(item);
        const actualAmountCents = cents(item.actualAmount, '销售明细成交金额');
        if (actualAmountCents <= 0) throw new Error('销售明细成交金额必须大于 0');
        expected.push({
          productRecordId: product.recordId,
          size: positiveInteger(item.size, '尺码'),
          quantity: positiveInteger(item.quantity, '销售数量'),
          actualAmount: actualAmountCents / 100,
          gift: item.gift ? String(item.giftDescription || '有赠品').trim() : '',
        });
      }
      const payments = input.payments || (input.totalPaid && input.paymentMethod
        ? [{ amount: input.totalPaid, method: input.paymentMethod, operatorOpenId: input.operatorOpenId }]
        : []);
      const totalCents = expected.reduce((sum, item) => sum + cents(item.actualAmount, '成交金额'), 0);
      const paidCents = payments.reduce((sum, payment) => sum + cents(payment.amount, '收款金额'), 0);
      if (paidCents > totalCents) throw new Error('本次收款超过本单成交金额');
      const table = this.gateway.table('salesDetail').fields;
      const existing = (await this.gateway.listAll('salesDetail')).filter((record) =>
        linkedRecordIds(record.fields?.[table.salesEntry]).includes(salesEntryRecordId));
      const used = new Set();
      const rows = expected.map((item) => {
        const match = existing.find((record) => !used.has(record.record_id) &&
          linkedRecordIds(record.fields?.[table.product]).includes(item.productRecordId) &&
          Number(textValue(record.fields?.[table.size])) === item.size &&
          Number(textValue(record.fields?.[table.quantity])) === item.quantity &&
          Number(textValue(record.fields?.[table.actualAmount])) === item.actualAmount &&
          textValue(record.fields?.[table.gift]) === item.gift);
        if (match) {
          used.add(match.record_id);
        }
        return { item, recordId: match?.record_id || '' };
      });
      if (existing.some((record) => !used.has(record.record_id))) {
        throw new Error('销售主表已有与当前草稿不一致的明细，已停止自动重试');
      }
      for (const row of rows) {
        if (!row.recordId) {
          const created = await this.gateway.create('salesDetail', {
            salesEntry: relation(salesEntryRecordId), product: relation(row.item.productRecordId),
            size: row.item.size, quantity: row.item.quantity, gift: row.item.gift,
            actualAmount: row.item.actualAmount,
          });
          row.recordId = created.recordId;
        }
      }
      const detailRecordIds = rows.map((row) => row.recordId);
      const paymentRecordIds = await this.payments.recordInitialBatch(salesEntryRecordId, payments);
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '已入账',
      });
      await this.progress.sync(salesEntryRecordId);
      const order = await this.gateway.get('salesEntry', salesEntryRecordId);
      const sourceNo = textValue(order?.fields?.[this.gateway.table('salesEntry').fields.orderNo]) || salesEntryRecordId;
      logInfo('v1.sale.posted', { sales_entry_record_id: salesEntryRecordId, detail_count: detailRecordIds.length,
        payment_count: paymentRecordIds.length, inventory_applied: false });
      return { sourceNo, detailRecordIds, paymentRecordIds, inventoryApplied: false };
    } catch (error) {
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '入账失败', failureReason: error.message,
      }).catch(() => undefined);
      logError('v1.sale.post_failed', { sales_entry_record_id: salesEntryRecordId, error: error.message });
      throw error;
    }
  }
}

module.exports = { SalesOrderService };
