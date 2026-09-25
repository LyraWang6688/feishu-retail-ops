const { linkedRecordIds, textValue } = require('./v1BitableGateway');

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
  const paidCents = receipts.reduce((sum, receipt) =>
    sum + cents(textValue(receipt.fields?.[paymentFields.amount]), '收款金额'), 0);
  if (amountKnown && paidCents > amountCents) throw new Error('累计收款超过成交金额，请核对销售明细或收款记录');
  const fulfillmentStatus = delivered === 0 ? '未交付' : delivered === quantity ? '已交付' : '部分交付';
  const paymentStatus = !amountKnown ? '' : paidCents === 0 ? '未收款' :
    paidCents === amountCents ? '已收清' : '部分收款';
  return {
    receivableAmount: amountKnown ? amountCents / 100 : null,
    paidAmount: paidCents / 100,
    pendingAmount: amountKnown ? (amountCents - paidCents) / 100 : null,
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

  async forOrder(salesEntryRecordId) {
    const [allDetails, allReceipts] = await Promise.all([
      this.gateway.listAll('salesDetail'), this.gateway.listAll('paymentRecord'),
    ]);
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const details = allDetails.filter((record) =>
      linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId));
    const receipts = allReceipts.filter((record) =>
      linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(salesEntryRecordId));
    return progressFromRecords(details, receipts, detailFields, paymentFields);
  }

  async sync(salesEntryRecordId) {
    const progress = await this.forOrder(salesEntryRecordId);
    const fields = { orderStatus: progress.orderStatus, fulfillmentStatus: progress.fulfillmentStatus };
    if (progress.paymentStatus) fields.paymentStatus = progress.paymentStatus;
    await this.gateway.update('salesEntry', salesEntryRecordId, fields);
    return progress;
  }
}

module.exports = { SalesProgressService, progressFromRecords, cents };
