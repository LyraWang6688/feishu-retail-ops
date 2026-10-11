const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
// ⭐ 2026-10-08：售后"退货改原收款状态"那一支会往「收款明细.收款状态」写 **已退款 / 已留存**
//（业务负责人的退货口径，取值与理由见 `config/afterSales.js`）。
// 这两个取值必须在这里被**认出来**：否则**原单**的任何一次进度计算都会抛「未知收款状态」
// ——查单 / 跟进 / 待处理候选会跟着一起挂（改动前原单的收款行一直是已收款，所以以前不会）。
// ⚠️ 口径选择见 config/afterSales.js 里 `AFTER_SALES_SETTLED_PAYMENT_STATUSES` 的注释
//    （按"已结清"算 = 与改动前一致，且不会把退过款的单又算成"客户还欠钱"）。
//
// ⭐ 2026-10-08 小修（线上工单 bug，业务负责人批准"小修一下"）：
//   同一件事还有**履约状态**那一半 —— 售后会把**原「销售明细」行**的「履约状态」改成
//   `已退货 / 已换货 / 已赔货`（见 config/afterSales.js 的 `AFTER_SALES_FULFILLMENT` 与
//   `AFTER_SALES_ACTION_SPECS.<action>.originalFulfillmentStatus`）。
//   这三种取值以前会走到下面的 throw ⇒ **一条明细把整页工作台订单列表打成 500**：
//     2026-10-08 01:41（+8）level=error event=workbench.sales.orders.failed
//     request_id=fe605d92-b824-4e4f-b86c-ab3c44502829 error="未知销售明细履约状态：已换货"
//   ⚠️ 判据只从 `config/afterSales` 取（`isAfterSalesFulfillment`）——本文件**不新造一份中文**。
const { isAfterSalesFulfillment, isSettledAfterSalesPaymentStatus } = require('../config/afterSales');

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
    const rawStatus = textValue(detail.fields?.[detailFields.fulfillmentStatus]) || '未交付';
    // ⭐ 2026-10-08：售后件（退过 / 换过 / 赔过）在**履约这一维**按"**已结清**"算 ⇒ 归到既有的
    //   「已交付」档，**不再计待交付**（口径出处：本单据 = 业务负责人 2026-10-08 批准的"小修"，
    //   她的原话「那条工作台的 bug（订单列表整页失败）小修一下」；取值出处 = `config/afterSales`
    //   的 `AFTER_SALES_FULFILLMENT_EXCLUDED` / `isAfterSalesFulfillment`）。
    //   为什么归「已交付」而不是"整条跳过"：
    //     · 这两个计数器（`quantity` / `delivered`）只有 未交付 / 已交付 两档，
    //       `pendingDeliveryQuantity = quantity - delivered` 的口径是按这两档写的；
    //     · 归「已交付」⇒ 这一条对 `pendingDeliveryQuantity` 的贡献 **= 0**（与"跳过"完全相同，
    //       "待交付"的数字不动），同时不会把一张**全是售后件**的单算成 `quantity = 0`
    //       （那样它会显示成"未交付"，与事实相反）；
    //     · 与钱那一维的做法**同一个口径**：`已退款 / 已留存` 收款状态在这里按"已结清"算
    //       （见上面文件的注释），履约这一维的"已结清"就是已交付。
    // ⚠️ 这**不兜底吞错**：预期之外的履约状态（例：'已撤单'）照旧在下一行**大声抛**。
    // ⭐ 2026-10-11（B/C）：**配品行**（`config/sellableKinds` 里 `requiresFulfillment: false`
    //    的配品）在写单时就是「已交付」⇒ 它对 `pendingDeliveryQuantity` 的贡献**恒为 0**，
    //    也就是"不参与待交付计算"（与交付那一步显式跳过它同一个口径）。
    //    ⚠️ 刻意**不**把它整个排除出 `quantity`：纯配品单若 quantity=0，会被算成"未交付"
    //    （`delivered === 0 ? '未交付'`），那与事实正好相反。
    const status = isAfterSalesFulfillment(rawStatus) ? '已交付' : rawStatus;
    if (!['未交付', '已交付'].includes(status)) throw new Error(`未知销售明细履约状态：${status}`);
    quantity += 1;
    if (status === '已交付') delivered += 1;
  }
  let paidCents = 0;
  let platformPendingCents = 0;
  for (const receipt of receipts) {
    const status = textValue(receipt.fields?.[paymentFields.status]) || '已收清';
    const value = cents(textValue(receipt.fields?.[paymentFields.amount]), '收款金额');
    if (status === '待平台结算') platformPendingCents += value;
    else if (status === '未收款') continue;
    // 已收款 / 已收清 / 已结清 = 钱到了；已退款 / 已留存 = 售后已经处理完（口径见文件头注释）。
    else if (status === '已收款' || status === '已收清' || status === '已结清'
      || isSettledAfterSalesPaymentStatus(status)) paidCents += value;
    else throw new Error(`未知收款状态：${status}`);
  }
  if (amountKnown && paidCents + platformPendingCents > amountCents) {
    throw new Error('累计收款及待平台结算金额超过成交金额，请核对销售明细或收款记录');
  }
  const fulfillmentStatus = delivered === 0 ? '未交付' : delivered === quantity ? '已交付' : '部分交付';
  const customerPendingCents = amountCents - paidCents - platformPendingCents;
  const paymentStatus = !amountKnown ? '' : paidCents === amountCents ? '已收款' :
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
  constructor({ gateway, retryDelays } = {}) {
    if (!gateway) throw new Error('SalesProgressService requires gateway');
    this.gateway = gateway;
    this.retryDelays = retryDelays;
  }

  async forOrder(salesEntryRecordId, expected = {}) {
    return withSalesReadRetry(() => this._forOrder(salesEntryRecordId, expected), 'sales_progress',
      { delays: this.retryDelays });
  }

  async _forOrder(salesEntryRecordId, expected = {}) {
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
    // The master fulfillment/payment cells are Bitable formulas. Their owners
    // are sales details and payment records, never this service.
    //
    // 🔴 2026-10-06：本方法**不写任何状态列**（只算、只返回 —— 见下面的 return）。
    //    ⚠️ 曾经的「订单状态」映射已被删除（业务负责人 2026-10-06 晚把那一列整列删掉），
    //       所以这里**没有、也不能有**写它的代码。
    //    业务负责人把四个状态维度落到实处，销售那一维的新家是「销售状态」
    //    （由 salesOrderService / afterSalesService 经 SalesStatusWriter 写，
    //     见 config/salesStatusDimensions）。
    //    ⚠️ `progress.orderStatus` 这个**返回值里的 JS 字段**保留：secondDeliveryService
    //       用它判"已完成"（`:287`）、网页工作台也读它 —— 它只是算出来的进度，不是表字段。
    return progress;
  }
}

module.exports = { SalesProgressService, progressFromRecords, cents };
