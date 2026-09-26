const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { readSaleLinkedRecord } = require('./salesRecordReader');

const cents = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || Math.abs(number * 100 - Math.round(number * 100)) > 1e-6) {
    throw new Error(`${label}必须是非负的两位小数金额`);
  }
  return Math.round(number * 100);
};

const progressFromRecords = (details, receipts, detailFields, paymentFields) => {
  let amountCents = 0;
  let quantity = 0;
  let delivered = 0;
  let amountKnown = details.length > 0;
  for (const detail of details) {
    const rawAmount = textValue(detail.fields?.[detailFields.actualAmount]).trim();
    if (!rawAmount) amountKnown = false;
    else amountCents += cents(rawAmount, '销售明细成交金额');
    const lineQuantity = Number(textValue(detail.fields?.[detailFields.quantity]));
    const lineDelivered = Number(textValue(detail.fields?.[detailFields.deliveredQuantity]) || 0);
    if (!Number.isInteger(lineQuantity) || lineQuantity <= 0 || !Number.isInteger(lineDelivered) ||
      lineDelivered < 0 || lineDelivered > lineQuantity) throw new Error('销售明细数量或交付数量无效');
    quantity += lineQuantity;
    delivered += lineDelivered;
  }
  let paidCents = 0;
  let platformPendingCents = 0;
  for (const receipt of receipts) {
    const status = textValue(receipt.fields?.[paymentFields.status]) || '已收清';
    const value = cents(textValue(receipt.fields?.[paymentFields.amount]), '收款金额');
    if (status === '待平台结算') platformPendingCents += value;
    else if (status === '已收清' || status === '已结清') paidCents += value;
    else throw new Error(`未知收款状态：${status}`);
  }
  if (amountKnown && paidCents + platformPendingCents > amountCents) {
    throw new Error('累计收款及待平台结算金额超过成交金额，请核对销售明细或收款记录');
  }
  const fulfillmentStatus = delivered === 0 ? '未交付' : delivered === quantity ? '已交付' : '部分交付';
  const customerPendingCents = amountCents - paidCents - platformPendingCents;
  const paymentStatus = !amountKnown ? '' : paidCents === amountCents ? '已收清' :
    customerPendingCents === 0 && platformPendingCents > 0 ? '待平台结算' :
    paidCents === 0 && platformPendingCents === 0 ? '未收款' : '部分收款';
  return {
    receivableAmount: amountKnown ? amountCents / 100 : null,
    paidAmount: paidCents / 100,
    pendingAmount: amountKnown ? customerPendingCents / 100 : null,
    platformPendingAmount: platformPendingCents / 100,
    quantity,
    deliveredQuantity: delivered,
    pendingDeliveryQuantity: quantity - delivered,
    fulfillmentStatus,
    paymentStatus,
    orderStatus: amountKnown && paidCents === amountCents && delivered === quantity ? '已完成' : '已确认',
  };
};

class SalesProgressService {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('SalesProgressService requires gateway');
    this.gateway = gateway;
  }

  async forOrder(salesEntryRecordId, expected = {}) {
    const [allDetails, allReceipts] = await Promise.all([
      this.gateway.listAll('salesDetail'), this.gateway.listAll('paymentRecord'),
    ]);
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const detailsById = new Map(allDetails.filter((record) =>
      linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId))
      .map((record) => [record.record_id, record]));
    const receiptsById = new Map(allReceipts.filter((record) =>
      linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(salesEntryRecordId))
      .map((record) => [record.record_id, record]));
    // Bitable's list endpoint can lag behind a successful create. Read the
    // record IDs returned by that create directly before deriving statuses.
    for (const id of expected.detailRecordIds || []) {
      const record = await readSaleLinkedRecord(this.gateway, 'salesDetail', id,
        detailFields.salesEntry, salesEntryRecordId);
      detailsById.set(id, record);
    }
    for (const id of expected.paymentRecordIds || []) {
      const record = await readSaleLinkedRecord(this.gateway, 'paymentRecord', id,
        paymentFields.salesEntry, salesEntryRecordId);
      receiptsById.set(id, record);
    }
    const details = [...detailsById.values()];
    const receipts = [...receiptsById.values()];
    return progressFromRecords(details, receipts, detailFields, paymentFields);
  }

  async sync(salesEntryRecordId, expected = {}) {
    const progress = await this.forOrder(salesEntryRecordId, expected);
    const fields = { orderStatus: progress.orderStatus, fulfillmentStatus: progress.fulfillmentStatus };
    if (progress.paymentStatus) fields.paymentStatus = progress.paymentStatus;
    await this.gateway.update('salesEntry', salesEntryRecordId, fields);
    return progress;
  }
}

module.exports = { SalesProgressService, progressFromRecords, cents };
