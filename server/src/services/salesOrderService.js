const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { PaymentService } = require('./paymentService');
const { SalesProgressService, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { sellableKindOf } = require('../config/sellableKinds');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { logInfo, logError } = require('../utils/logger');
const { mergeCorrelation } = require('../utils/correlationFields');

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
};

class SalesOrderService {
  constructor({ gateway, references, payments, progress, sizeReferences, status } = {}) {
    if (!gateway) throw new Error('SalesOrderService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
    this.payments = payments || new PaymentService({ gateway, references: this.references });
    this.progress = progress || new SalesProgressService({ gateway });
    // 四个状态维度的唯一写入口（名字与取值都在 config/salesStatusDimensions）。
    this.status = status || new SalesStatusWriter({ gateway });
    // 「尺码」已改为关联「尺码管理」：写入前要解析出关联记录，幂等比对也要按关联记录比。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences });
    this.queue = Promise.resolve();
  }

  // ⚠️ 关联键走**尾部可选参数**（`options.correlation`），**不塞进 `input`**。
  //    统一约定：既有业务入参对象的形状一个字段都不变（哪天真被谁改坏了，
  //    既有测试里的逐字 deepEqual 会当场挂掉）。
  confirm(input, options = {}) {
    const next = this.queue.then(() => this._confirm(input, options), () => this._confirm(input, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _confirm(input, options = {}) {
    const salesEntryRecordId = input.salesEntryRecordId;
    if (!salesEntryRecordId) throw new Error('缺少销售主表 record_id');
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('至少需要一条销售明细');
    await this.gateway.validateTables?.(['product', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord']);
    // ⭐ 关联键（2026-10-07 业务负责人拍板「日志改下吧！」）：
    //   这一整段（写主表状态 → 写销售明细 → 写收款明细 → 落表日志）以前**一个键都没有**，
    //   按 task_id grep 只能看到卡片那半，看不到明细 / 收款。
    //   ⚠️ 它只是**每次调用显式传下去的普通对象**，不落在 service 实例上
    //      （这些 service 是启动时构造的单例，放实例上会跨请求串台）。
    //   `sales_entry_record_id` 这一层自己就知道；`task_id` 由调用方（本地任务层）给；
    //   `order_no` 下面读过主表就补上（**不额外请求**：那条记录本来就要读）。
    let correlation = mergeCorrelation(options.correlation, { sales_entry_record_id: salesEntryRecordId });
    // 「入账中」落在四个维度字段上（旧「确认状态（旧）」那一列已被她整列删除）：
    //   · 销售状态 = 未写入（销售明细还没开始写）
    //   · 资金状态 = 未写入（收款明细还没开始写）
    // 显式写这两列（而不是留空），是为了让"到哪一步了"在表里看得见。
    await this.gateway.update('salesEntry', salesEntryRecordId, { failureReason: '' }, { correlation });
    await this.status.write(salesEntryRecordId, {
      sales: WRITE.sales.none, funds: WRITE.funds.none,
    }, correlation);
    // A previous attempt may have completed all detail/receipt writes before a read failed.
    // The persisted task is the source of that stage on the next card callback.
    let financialRecorded = input.knownFinancialComplete === true;
    // 进度计数的口径：明细/收款**各写成功几条**（失败时用来区分"部分写入"和"全败"）。
    // 放在 try 外面，catch 里才能读到。
    let detailPlan = 0;
    let detailsPersisted = 0;
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
      // 单号就在这条**已经读到的**主表记录上 ⇒ 零额外请求地补进关联键。
      // 读不到（AI 还没生成 / 老单）就不写这个键，不是写一个空串。
      correlation = mergeCorrelation(correlation, { order_no: textValue(entry?.fields?.[entryFields.orderNo]) });
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
      detailPlan = rows.length;
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
          }, { correlation });
          row.recordId = created.recordId;
        }
        detailsPersisted += 1;
        await input.onRecordPersisted?.('details', row.index, row.recordId);
      }
      // 「货」这一维写完了（收款还没开始）：先落「已写入」，这样后面收款失败时
      // 她也能从表里一眼看出"明细是好的、坏在钱那一列"。
      await this.status.write(salesEntryRecordId, { sales: WRITE.sales.done }, correlation);
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
        correlation,
      });
      financialRecorded = true;
      // 「钱」这一维写完了。⚠️ 这正是 6 处闸门判据读的那一列：
      // 闸门认的是**两代字面量**（旧「已入账」/ 新「已写入」），见 config/salesStatusDimensions。
      await this.status.write(salesEntryRecordId, { funds: WRITE.funds.done }, correlation);
      await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
      const order = await withSalesReadRetry(
        () => this.gateway.get('salesEntry', salesEntryRecordId), 'sale_entry_by_id',
      );
      const sourceNo = textValue(order?.fields?.[this.gateway.table('salesEntry').fields.orderNo]) || salesEntryRecordId;
      // ⚠️ 这条日志只回答【落表这一步】做了什么，**不是**"整单扣没扣库存"。
      //    2026-10-07 的真实误判：有人把 `inventory_applied: false` 读成了"整单没扣库存"，
      //    其实库存在**交付那一步**（SalesDeliveryService）才扣，而且那单已经扣了。
      //    ⇒ 字段名一律带**范围**（`inventory_applied_by_this_step`），并写明**下一步做什么**
      //      （`inventory_planned` / `inventory_step`）。库存真扣完时的**正向证据**是
      //      `sales.inventory.applied`（见 salesDeliveryService），不要拿这条当日志判据。
      logInfo('v1.sale.posted', { sales_entry_record_id: salesEntryRecordId, detail_count: detailRecordIds.length,
        payment_count: paymentRecordIds.length, step: 'posting', inventory_applied_by_this_step: false,
        inventory_planned: true, inventory_step: 'after_delivery', ...correlation });
      // 返回值里的 inventoryApplied 与上面那条日志**逐字同义**：本步不动库存。
      return { sourceNo, detailRecordIds, paymentRecordIds, inventoryApplied: false };
    } catch (error) {
      error.saleRecordsWritten = financialRecorded;
      // 失败时把两个维度写到**它能被看懂的那一档**：
      //   · 销售状态：没开始写 = 未写入；写了但没写全 = 部分写入；全写上了 = 已写入；一条都没成 = 写入失败
      //   · 资金状态：收款明细全部记上了 = 已写入；否则 = 写入失败（这一维的值域里没有"部分"）
      const salesStatus = detailPlan === 0 ? WRITE.sales.none
        : detailsPersisted === 0 ? WRITE.sales.failed
          : detailsPersisted >= detailPlan ? WRITE.sales.done : WRITE.sales.partial;
      await this.status.write(salesEntryRecordId, {
        sales: salesStatus,
        funds: financialRecorded ? WRITE.funds.done : WRITE.funds.failed,
      }, correlation);
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        failureReason: financialRecorded ? `销售记录已写入，后续同步待恢复：${error.message}` : error.message,
      }, { correlation }).catch(() => undefined);
      logError(financialRecorded ? 'v1.sale.sync_pending' : 'v1.sale.post_failed', {
        sales_entry_record_id: salesEntryRecordId, error: error.message, ...correlation,
      });
      throw error;
    }
  }
}

module.exports = { SalesOrderService };
