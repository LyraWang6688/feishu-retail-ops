const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { PaymentService } = require('./paymentService');
const { SalesProgressService, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { sellableKindOf } = require('../config/sellableKinds');
const { logInfo, logError } = require('../utils/logger');

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
};

class SalesOrderService {
  constructor({ gateway, references, payments, progress, sizeReferences } = {}) {
    if (!gateway) throw new Error('SalesOrderService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
    this.payments = payments || new PaymentService({ gateway, references: this.references });
    this.progress = progress || new SalesProgressService({ gateway });
    // 「尺码」已改为关联「尺码管理」：写入前要解析出关联记录，幂等比对也要按关联记录比。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences });
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
    // A previous attempt may have completed all detail/receipt writes before a read failed.
    // The persisted task is the source of that stage on the next card callback.
    let financialRecorded = input.knownFinancialComplete === true;
    try {
      const expected = [];
      for (const item of input.items) {
        // 可售品按属性走：鞋才需要解析尺码和跟踪库存，配品只记「卖了什么、收了多少」。
        const kind = sellableKindOf(item);
        const actualAmountCents = cents(item.actualAmount, '销售明细成交金额');
        if (actualAmountCents <= 0) throw new Error('销售明细成交金额必须大于 0');
        if (positiveInteger(item.quantity, '销售数量') !== 1) {
          throw new Error(kind.requiresSize
            ? '一条销售明细只能记录一双鞋；请逐双说明成交金额'
            : '一条销售明细只能记录一件配品');
        }
        const row = {
          kind: kind.key,
          linkField: kind.detailLinkField,
          actualAmount: actualAmountCents / 100,
          gift: item.gift ? String(item.giftDescription || '有赠品').trim() : '',
          // 配品当场结清、不跟踪交付，直接写成已交付，不会进待交付列表也不会扣库存。
          fulfillmentStatus: kind.requiresFulfillment ? '未交付' : '已交付',
        };
        if (!kind.requiresSize) {
          const accessoryRecordId = String(item.accessoryRecordId || '').trim();
          if (!accessoryRecordId) throw new Error('配品明细缺少配品记录，请先在「其他配品」里确认这一件');
          expected.push({ ...row, linkRecordId: accessoryRecordId, size: null, sizeRecordId: '' });
          continue;
        }
        const product = await this.references.resolveProduct({ ...item, matchMode: 'sales' });
        const size = positiveInteger(item.size, '尺码');
        const sizeReference = await this.getSizeReferences().resolveByNumber(size);
        expected.push({ ...row, linkRecordId: product.recordId, size, sizeRecordId: sizeReference.recordId });
      }
      const payments = input.payments || (input.totalPaid && input.paymentMethod
        ? [{ amount: input.totalPaid, method: input.paymentMethod, operatorOpenId: input.operatorOpenId }]
        : []);
      if (payments.some((payment) => payment.status === '未收款')) {
        throw new Error('待收款记录由销售入账自动生成，请勿作为实际收款提交');
      }
      const totalCents = expected.reduce((sum, item) => sum + cents(item.actualAmount, '成交金额'), 0);
      const paidCents = payments.reduce((sum, payment) => sum + cents(payment.amount, '收款金额'), 0);
      if (paidCents > totalCents) throw new Error('本次收款超过本单成交金额');
      if ((input.knownRecordIds?.details || []).slice(expected.length).some(Boolean)) {
        throw new Error('已保存的销售明细数量超过当前草稿，已停止重试');
      }
      const table = this.gateway.table('salesDetail').fields;
      const existing = (await withSalesReadRetry(() => this.gateway.listAll('salesDetail'), 'sale_detail_list')).filter((record) =>
        linkedRecordIds(record.fields?.[table.salesEntry]).includes(salesEntryRecordId));
      for (const id of input.knownRecordIds?.details || []) {
        if (!id || existing.some((record) => record.record_id === id)) continue;
        existing.push(await withSalesReadRetry(
          () => readSaleLinkedRecord(this.gateway, 'salesDetail', id, table.salesEntry, salesEntryRecordId),
          'sale_detail_by_id',
        ));
      }
      const used = new Set();
      const reserved = new Set((input.knownRecordIds?.details || []).filter(Boolean));
      const rows = expected.map((item, index) => {
        const knownId = input.knownRecordIds?.details?.[index];
        const match = existing.find((record) => !used.has(record.record_id) &&
          (knownId ? record.record_id === knownId : !reserved.has(record.record_id)) &&
          linkedRecordIds(record.fields?.[table[item.linkField]]).includes(item.linkRecordId) &&
          // 尺码是单选关联：鞋必须正好是这一条；配品没有尺码，关联必须为空。
          (item.sizeRecordId
            ? singleLinked(record.fields?.[table.size], item.sizeRecordId)
            : linkedRecordIds(record.fields?.[table.size]).length === 0) &&
          Number(textValue(record.fields?.[table.actualAmount])) === item.actualAmount &&
          textValue(record.fields?.[table.gift]) === item.gift);
        if (knownId && !match) throw new Error(`已记录的销售明细 ${knownId} 与当前草稿不一致，已停止重试`);
        if (match) {
          used.add(match.record_id);
        }
        return { item, recordId: match?.record_id || '', index };
      });
      if (existing.some((record) => !used.has(record.record_id))) {
        throw new Error('销售主表已有与当前草稿不一致的明细，已停止自动重试');
      }
      for (const row of rows) {
        if (!row.recordId) {
          const created = await this.gateway.create('salesDetail', {
            salesEntry: relation(salesEntryRecordId),
            // 鞋写「编号」，配品写「配品」——字段由可售品配置声明。
            [row.item.linkField]: relation(row.item.linkRecordId),
            ...(row.item.sizeRecordId ? { size: relation(row.item.sizeRecordId) } : {}),
            gift: row.item.gift,
            actualAmount: row.item.actualAmount, fulfillmentStatus: row.item.fulfillmentStatus,
          });
          row.recordId = created.recordId;
        }
        await input.onRecordPersisted?.('details', row.index, row.recordId);
      }
      const detailRecordIds = rows.map((row) => row.recordId);
      const outstandingCents = totalCents - paidCents;
      // 未收款只在**她明说欠**时才补（业务负责人口径：「如果用户说欠多少钱，你再做欠款，
      // 用户又没说呀」）。owed 是她原话里说出的欠款金额（AI 解析出来的）：
      //   · 「119 的腰带，是收到了 100 元微信」→ owed 为空 → 这一单成交就是 100，不挂未收款；
      //   · 「卖了 119，先给 100，还欠 19」    → owed=19 → 补一条未收款 19。
      // 后端不拿「成交 − 已收」的差额去猜是还价还是欠款：她说欠才算欠。
      const owedCents = input.owed ? cents(input.owed, '欠款金额') : 0;
      if (owedCents > 0 && owedCents !== outstandingCents) {
        // 说出的欠款和「成交 − 已收」对不上：宁可拦下来人工核对，也不静默写一条错账。
        throw new Error('她说的欠款与「成交金额−已收金额」不一致，请核对后再确认');
      }
      const expectedPayments = owedCents > 0
        ? [...payments, { amount: outstandingCents / 100, status: '未收款' }] : payments;
      const paymentRecordIds = await this.payments.recordInitialBatch(salesEntryRecordId, expectedPayments, {
        knownRecordIds: input.knownRecordIds?.payments,
        onRecordPersisted: (index, id) => input.onRecordPersisted?.('payments', index, id),
      });
      financialRecorded = true;
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '已入账',
      });
      await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
      const order = await withSalesReadRetry(
        () => this.gateway.get('salesEntry', salesEntryRecordId), 'sale_entry_by_id',
      );
      const sourceNo = textValue(order?.fields?.[this.gateway.table('salesEntry').fields.orderNo]) || salesEntryRecordId;
      logInfo('v1.sale.posted', { sales_entry_record_id: salesEntryRecordId, detail_count: detailRecordIds.length,
        payment_count: paymentRecordIds.length, inventory_applied: false });
      return { sourceNo, detailRecordIds, paymentRecordIds, inventoryApplied: false };
    } catch (error) {
      error.saleRecordsWritten = financialRecorded;
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: financialRecorded ? '已入账' : '入账失败',
        failureReason: financialRecorded ? `销售记录已写入，后续同步待恢复：${error.message}` : error.message,
      }).catch(() => undefined);
      logError(financialRecorded ? 'v1.sale.sync_pending' : 'v1.sale.post_failed', {
        sales_entry_record_id: salesEntryRecordId, error: error.message,
      });
      throw error;
    }
  }
}

module.exports = { SalesOrderService };
