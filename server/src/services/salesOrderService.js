const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { PaymentService } = require('./paymentService');
const { SalesProgressService, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { sellableKindOf } = require('../config/sellableKinds');
const { SALES_STATUS_VALUES } = require('../config/salesStatusDimensions');
const { SalesStatusService } = require('./salesStatusService');
const { logInfo, logError } = require('../utils/logger');

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
};

class SalesOrderService {
  constructor({ gateway, references, payments, progress, sizeReferences, salesStatus } = {}) {
    if (!gateway) throw new Error('SalesOrderService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
    this.payments = payments || new PaymentService({ gateway, references: this.references });
    this.progress = progress || new SalesProgressService({ gateway });
    // 四个状态维度的「达成情况」写入只有一处实现（见 services/salesStatusService）。
    this.salesStatus = salesStatus || new SalesStatusService({ gateway });
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
    // ⚠️ 这里**不再写「确认状态」**：
    //   · 新口径下「确认状态」= **用户有没有点确认按钮**，只有卡片处理器（larkMvpService）
    //     知道她点没点，入账服务不知道；
    //   · 旧代码在这里写的「入账中」不属于新值域（未确认/已确认/已取消/待修改），
    //     继续写只会把「入账中」永久留在飞书选项里。
    //   这一句保留下来，只为"重试时清掉上一次的失败原因"。
    await this.gateway.update('salesEntry', salesEntryRecordId, { failureReason: '' });
    // A previous attempt may have completed all detail/receipt writes before a read failed.
    // The persisted task is the source of that stage on the next card callback.
    let financialRecorded = input.knownFinancialComplete === true;
    // 明细是否已经**全部**落表（用于出错时把「销售状态」补写回"已写入"，见下面 catch）。
    let detailsRecorded = false;
    try {
      // 销售明细的「交易类型」必须和「销售主表」保持一致（业务负责人口径）：
      // 明细行的数量记的都是正数，退货 / 换货只能靠「交易类型」表明这一行的方向，
      // 所以它得跟主表说同一件事。
      //
      // 为什么是**读主表已经写好的那条关联**、不在这里重新解析一次：
      // 重新解析就有两处结论，两处就可能不一致；读同一处写下去，天然一致。
      // 主表没解析出交易类型时（AI 没认出来）这里留空——空着比写错方向好。
      const entryFields = this.gateway.table('salesEntry').fields;
      const entry = await withSalesReadRetry(
        () => this.gateway.get('salesEntry', salesEntryRecordId), 'sale_entry_trade_type',
      );
      const tradeTypeRecordId = linkedRecordIds(entry?.fields?.[entryFields.tradeType])[0] || '';
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
      // ② 销售状态：销售明细写进去了没有。
      //    全写完 → 已写入 · 写了一半 → 部分写入 · 一条都没成 → 写入失败。
      //    ⚠️ 已经存在的明细（幂等重试匹配上的）也算"写进去了"——她问的是"明细在不在"。
      try {
        for (const row of rows) {
          if (!row.recordId) {
            const created = await this.gateway.create('salesDetail', {
              salesEntry: relation(salesEntryRecordId),
              // 鞋写「编号」，配品写「配品」——字段由可售品配置声明。
              [row.item.linkField]: relation(row.item.linkRecordId),
              ...(row.item.sizeRecordId ? { size: relation(row.item.sizeRecordId) } : {}),
              gift: row.item.gift,
              actualAmount: row.item.actualAmount, fulfillmentStatus: row.item.fulfillmentStatus,
              // 主表写的是哪条「行为管理」记录，明细就写同一条（见上面读主表那段注释）。
              ...(tradeTypeRecordId ? { tradeType: relation(tradeTypeRecordId) } : {}),
            });
            row.recordId = created.recordId;
          }
          await input.onRecordPersisted?.('details', row.index, row.recordId);
        }
      } catch (error) {
        const written = rows.filter((row) => row.recordId).length;
        await this.salesStatus.markQuietly(salesEntryRecordId, 'sales',
          written === 0 ? SALES_STATUS_VALUES.sales.FAILED : SALES_STATUS_VALUES.sales.PARTIAL,
          { written_detail_count: written, expected_detail_count: rows.length });
        throw error;
      }
      detailsRecorded = true;
      await this.salesStatus.mark(salesEntryRecordId, 'sales', SALES_STATUS_VALUES.sales.WRITTEN,
        { detail_count: rows.length });
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
      let paymentRecordIds;
      try {
        paymentRecordIds = await this.payments.recordInitialBatch(salesEntryRecordId, expectedPayments, {
          knownRecordIds: input.knownRecordIds?.payments,
          onRecordPersisted: (index, id) => input.onRecordPersisted?.('payments', index, id),
        });
      } catch (error) {
        // ③ 资金状态：收款明细没写成 → 写入失败。（这一维没有"部分"——一笔账要么记上要么没记。）
        await this.salesStatus.markQuietly(salesEntryRecordId, 'funds', SALES_STATUS_VALUES.funds.FAILED,
          { expected_payment_count: expectedPayments.length });
        throw error;
      }
      financialRecorded = true;
      // ③ 资金状态：收款明细写完了 → 已写入。
      //    ⚠️ **6 处闸门读的就是这一列**（交付 / 补记收款 / 二次交付成交 / 待成交提醒 /
      //       今日销售 / 订单列表），所以这里用 mark（写失败会抛、走下面的重试），不静默。
      await this.salesStatus.mark(salesEntryRecordId, 'funds', SALES_STATUS_VALUES.funds.WRITTEN,
        { payment_count: paymentRecordIds.length });
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
      // 补写达成情况：明细 / 收款明细其实已经落表，只是上面那一次状态写入（或之后的同步）
      // 失败了。补不上也只记 warn —— 那两列会因此停在中途值，闸门关着，日志里看得见。
      if (detailsRecorded) {
        await this.salesStatus.markQuietly(salesEntryRecordId, 'sales', SALES_STATUS_VALUES.sales.WRITTEN,
          { recovered_after_error: true });
      }
      if (financialRecorded) {
        await this.salesStatus.markQuietly(salesEntryRecordId, 'funds', SALES_STATUS_VALUES.funds.WRITTEN,
          { recovered_after_error: true });
      }
      await this.gateway.update('salesEntry', salesEntryRecordId, {
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
