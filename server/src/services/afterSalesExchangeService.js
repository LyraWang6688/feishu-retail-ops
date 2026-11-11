'use strict';

/**
 * 售后（衍生单）· **换货写入**（异步 worker 调它；表单 POST 只做本地形状校验 + 入队）。
 *
 * 2026-10-29 定稿 + 2026-11-11 业务负责人补充：
 *   · 不新建销售主表 / 售后单：在原主表上累加售后类型「换货」、售后次数 +1、**总金额按差价回填**；
 *   · 货：原明细 → 已退货；**新增一条销售明细**（已交付 / 交易类型=换货 / 销售日=点击当天 /
 *         金额=她填的实收金额）；库存两条（旧鞋回门盒 / 新鞋出门盒）；
 *   · 钱：只看差价 —— 补差价 `-收款-NN`（收入/已收款）、退差价 `-退款-NN`（退回/已退款）；
 *   · 三块关联（销售明细 / 库存流水 / 收款明细）都写回**原销售主表**（双向关联自动回显）；
 *   · 幂等：本地任务记录按 requestId 分片，每步写完落盘 —— 重试/断点续做不重复写。
 */
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { textValue } = require('./v1BitableGateway');
const { salesLinkRecordIds } = require('./afterSalesLinkIds');
const { InventoryService } = require('./inventoryService');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { nextId, stateFor } = require('./salesRecordIds');
const { createPaymentMethodsService } = require('./paymentMethodsService');
const { AFTER_SALES_EXCHANGE: EX } = require('../config/afterSalesExchange');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_STORE_DIR = path.join(__dirname, '../../data/after_sales_exchanges');
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const normalizeList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : (item?.name || item?.text || '')))
      .map((item) => String(item || '').trim()).filter(Boolean);
  }
  const text = String(value ?? '').trim();
  return text ? [text] : [];
};
const numberOrNull = (value) => {
  const text = textValue(value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

class AfterSalesExchangeService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('AfterSalesExchangeService requires gateway');
    this.gateway = options.gateway;
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.paymentMethods = options.paymentMethods || createPaymentMethodsService(this.gateway);
    this.now = options.now || (() => Date.now());
    this.store = options.store || new JsonTaskStore({
      dir: options.dir || EX.jobsDir || DEFAULT_STORE_DIR,
      idField: 'request_id',
    });
  }

  get texts() { return EX.texts; }

  /** 只校验表单形状（不读飞书）：POST 立刻返回；飞书校验留给后台 worker。 */
  validateShape(payload = {}) {
    const requestId = String(payload.requestId || '').trim();
    if (!REQUEST_ID_PATTERN.test(requestId)) throw badRequest(this.texts.needRequestId);
    const salesEntryRecordId = String(payload.salesEntryRecordId || '').trim();
    if (!salesEntryRecordId) throw badRequest(this.texts.needEntry);
    const detailRecordId = String(payload.detailRecordId || '').trim();
    if (!detailRecordId) throw badRequest(this.texts.needDetail);
    const scenario = String(payload.scenario || payload.kind || '').trim();
    const validScenarios = Object.values(EX.scenarios);
    if (!scenario) throw badRequest(this.texts.needScenario);
    if (!validScenarios.includes(scenario)) throw badRequest(this.texts.invalidScenario);
    const out = { requestId, salesEntryRecordId, detailRecordId, scenario };
    if (scenario === EX.scenarios.NEW_ITEM) {
      out.newProductRecordId = String(payload.newProductRecordId || '').trim();
      if (!out.newProductRecordId) throw badRequest(this.texts.needNewProduct);
      const amount = Number(String(payload.newAmount ?? '').trim());
      if (!Number.isFinite(amount) || amount <= 0) throw badRequest(this.texts.needNewAmount);
      out.newAmount = amount;
      const method = String(payload.diffPaymentMethod || payload.paymentMethod || '').trim();
      out.diffMethodName = method;
    }
    const newSize = Number(String(payload.newSize ?? '').trim());
    if (!Number.isFinite(newSize) || newSize <= 0) throw badRequest(this.texts.needNewSize);
    out.newSize = newSize;
    return out;
  }

  /** 后台 worker 用：读飞书原单/明细/新货品/尺码/差价方式（不写任何东西）。 */
  async prepare(payload = {}) {
    const shaped = this.validateShape(payload);
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;

    // ⭐ 2026-11-11（提速）：原单 / 原明细互不依赖 ⇒ 并行读
    const [entry, detail] = await Promise.all([
      this.gateway.get('salesEntry', shaped.salesEntryRecordId),
      this.gateway.get('salesDetail', shaped.detailRecordId),
    ]);
    if (!entry) throw badRequest(this.texts.entryNotFound);
    const orderNo = textValue(entry.fields?.[entryFields.orderNo]).trim();
    if (!detail) throw badRequest(this.texts.detailNotFound);
    if (!salesLinkRecordIds(detail.fields?.[detailFields.salesEntry]).includes(shaped.salesEntryRecordId)) {
      throw badRequest(this.texts.detailNotInEntry);
    }
    const status = textValue(detail.fields?.[detailFields.fulfillmentStatus]).trim();
    if (status === EX.original.fulfillmentStatus) throw badRequest(this.texts.alreadyReturned);
    if (!EX.original.returnableStatuses.includes(status)) throw badRequest(this.texts.detailNotExchangeable);
    const originalAmount = numberOrNull(detail.fields?.[detailFields.actualAmount]);
    if (originalAmount == null) throw badRequest(this.texts.originalAmountMissing);
    if (originalAmount <= 0) throw badRequest(this.texts.originalAmountInvalid);
    const originalProductId = salesLinkRecordIds(detail.fields?.[detailFields.product])[0] || '';
    if (!originalProductId) throw badRequest(this.texts.missingOriginalProduct);
    const originalSizeRecordId = salesLinkRecordIds(detail.fields?.[detailFields.size])[0] || '';
    if (!originalSizeRecordId) throw badRequest(this.texts.missingOriginalSize);

    const sizeFields = this.gateway.table('sizeManagement').fields;
    const originalSizeRecord = await this.gateway.get('sizeManagement', originalSizeRecordId);
    const originalSize = Number(textValue(originalSizeRecord?.fields?.[sizeFields.size]));
    if (!Number.isFinite(originalSize)) throw badRequest(this.texts.originalSizeUnreadable);
    // 页面只传尺码数字（销售尺码分组模型里没有 size 记录 id）⇒ 按数字反查「尺码管理」记录。
    // ⭐ 2026-11-11（提速）：尺码表 & 交易类型（行为配置）互不依赖 ⇒ 并行读
    const [sizeRows, behavior] = await Promise.all([
      this.gateway.listAll('sizeManagement'),
      this.references.resolveBehavior(EX.newLine.tradeTypeCode),
    ]);
    const newSizeRecord = (sizeRows || []).find((row) =>
      Number(textValue(row.fields?.[sizeFields.size])) === shaped.newSize) || null;
    if (!newSizeRecord) throw badRequest(this.texts.newSizeNotFound);
    const newSizeRecordId = newSizeRecord.record_id;
    const newSize = shaped.newSize;

    let newProductRecordId = originalProductId;
    let newAmount = originalAmount;
    let diff = 0;
    if (shaped.scenario === EX.scenarios.NEW_ITEM) {
      newProductRecordId = shaped.newProductRecordId;
      const newProduct = await this.gateway.get('product', newProductRecordId);
      if (!newProduct) throw badRequest(this.texts.newProductNotFound);
      newAmount = shaped.newAmount;
      diff = Number((newAmount - originalAmount).toFixed(2));
    }

    let method = null;
    if (diff !== 0) {
      if (!shaped.diffMethodName) throw badRequest(this.texts.needDiffMethod);
      const listed = await this.paymentMethods.listWithVouchers();
      const detailed = listed?.detailed || listed?.items || [];
      const hit = detailed.find((item) => item.name === shaped.diffMethodName && item.recordId);
      if (!hit) throw badRequest(this.texts.unknownPaymentMethod);
      if (diff < 0 && hit.refundable === false) throw badRequest(this.texts.diffMethodNotAllowed);
      method = hit;
    }

    return {
      ...shaped, orderNo, originalAmount, originalProductId, originalSize,
      newProductRecordId, newSizeRecordId, newSize, newAmount, diff, method,
      exchangeBehaviorRecordId: behavior.recordId,
      moneyMode: diff > 0 ? EX.money.collect : (diff < 0 ? EX.money.refund : ''),
    };
  }

  /** 执行一次换货写入（异步 worker 调用）。 */
  async execute(payload = {}, options = {}) {
    const requestId = String(payload?.requestId || '').trim();
    if (!REQUEST_ID_PATTERN.test(requestId)) throw badRequest(this.texts.needRequestId);
    const storeId = `after_sales_exchange_${requestId}`;
    let progress = await this.store.get(storeId);
    if (progress?.status === 'completed' && progress.result) return progress.result;

    const prepared = await this.prepare(payload);
    const save = (patch) => this.store.update(storeId, patch);
    if (!progress) progress = await this.store.create({ request_id: storeId, status: 'preparing', payload });

    const detailFields = this.gateway.table('salesDetail').fields;

    // ① 原明细 → 已退货（幂等）
    const current = await this.gateway.get('salesDetail', prepared.detailRecordId);
    const currentStatus = textValue(current?.fields?.[detailFields.fulfillmentStatus]).trim();
    if (currentStatus !== EX.original.fulfillmentStatus) {
      if (!EX.original.returnableStatuses.includes(currentStatus)) {
        throw new Error(`${this.texts.detailNotExchangeable}（当前：${currentStatus || '空'}）`);
      }
      await this.gateway.update('salesDetail', prepared.detailRecordId, {
        fulfillmentStatus: EX.original.fulfillmentStatus,
      }, { correlation: options.correlation });
    }
    await save({ status: 'original_marked', original_marked_at: new Date().toISOString() });

    // ② 新明细：同单号连续排号；已存在就复用（断点重试 / 重放都不建第二行）
    const read = await stateFor({
      gateway: this.gateway, tableKey: 'salesDetail',
      entryIds: [prepared.salesEntryRecordId], idField: detailFields.detailId,
    });
    const detailId = nextId({ state: read.state, orderNo: prepared.orderNo, kind: 'detail' });
    const existing = (read.rows || []).find((row) =>
      textValue(row.fields?.[detailFields.detailId]).trim() === detailId) || null;
    let newDetailRecordId = existing?.record_id || '';
    if (!newDetailRecordId) {
      const created = await this.gateway.create('salesDetail', {
        salesEntry: relation(prepared.salesEntryRecordId),
        ...(detailId ? { detailId } : {}),
        product: relation(prepared.newProductRecordId),
        size: relation(prepared.newSizeRecordId),
        actualAmount: prepared.newAmount,
        soldAt: this.now(),
        tradeType: relation(prepared.exchangeBehaviorRecordId),
        fulfillmentStatus: EX.newLine.fulfillmentStatus,
      }, { correlation: options.correlation });
      newDetailRecordId = created.recordId;
    }
    await save({
      status: 'new_detail_created',
      new_detail: { record_id: newDetailRecordId, detail_id: detailId, amount: prepared.newAmount },
      new_detail_created_at: new Date().toISOString(),
    });

    // ③ 库存两条：旧鞋 +1（销售增加）、新鞋 −1（现货销售）；都挂原销售主表
    const restock = await this.inventory.applyChange({
      kind: EX.stock.returnedBehaviorCode,
      productRecordId: prepared.originalProductId,
      size: prepared.originalSize,
      // 仅作兜底；增加库存时由库存内核自动决定样品/门盒。
      state: EX.stock.restockState,
      quantity: EX.stock.quantity,
      sourceRecordId: prepared.detailRecordId,
      salesEntryRecordId: prepared.salesEntryRecordId,
    }, { correlation: options.correlation });
    const newStock = await this.inventory.applyChange({
      kind: EX.stock.newBehaviorCode,
      productRecordId: prepared.newProductRecordId,
      size: prepared.newSize,
      // 减少库存时不参与选行；保留字段只为本地任务形状兼容。
      state: EX.stock.restockState,
      quantity: EX.stock.quantity,
      sourceRecordId: newDetailRecordId,
      salesEntryRecordId: prepared.salesEntryRecordId,
    }, { correlation: options.correlation });
    await save({ status: 'stock_applied', stock: { restock, new: newStock } });

    // ④ 差价：补=收款 / 退=退款（差价 0 不建）
    let money = progress.money || null;
    if (prepared.diff !== 0 && !money?.payment_record_id) {
      const paymentFields = this.gateway.table('paymentRecord').fields;
      const readPay = await stateFor({
        gateway: this.gateway, tableKey: 'paymentRecord',
        entryIds: [prepared.salesEntryRecordId], idField: paymentFields.receiptId,
      });
      const kind = EX.money.kindByMode[prepared.moneyMode];
      const receiptId = nextId({ state: readPay.state, orderNo: prepared.orderNo, kind });
      const found = (readPay.rows || []).find((row) =>
        textValue(row.fields?.[paymentFields.receiptId]).trim() === receiptId) || null;
      let recordId = found?.record_id || '';
      if (!recordId) {
        const created = await this.gateway.create('paymentRecord', {
          salesEntry: relation(prepared.salesEntryRecordId),
          ...(receiptId ? { receiptId } : {}),
          ...(prepared.method ? { method: relation(prepared.method.recordId) } : {}),
          tradeDirection: EX.money.directionByMode[prepared.moneyMode],
          amount: Math.abs(prepared.diff),
          status: EX.money.statusByMode[prepared.moneyMode],
          receivedAt: this.now(),
        }, { correlation: options.correlation });
        recordId = created.recordId;
      }
      money = {
        payment_record_id: recordId,
        receipt_id: receiptId,
        mode: prepared.moneyMode,
        amount: Math.abs(prepared.diff),
        status: EX.money.statusByMode[prepared.moneyMode],
      };
      await save({ status: 'money_recorded', money });
    }

    // ⑤ 原销售主表：售后类型 +1 / 次数 +1 / 总金额按差价回填
    const masterFields = this.gateway.table('salesEntry').fields;
    const entryNow = await this.gateway.get('salesEntry', prepared.salesEntryRecordId);
    const currentTypes = normalizeList(entryNow?.fields?.[masterFields[EX.master.typeField]]);
    const currentCount = Number(textValue(entryNow?.fields?.[masterFields[EX.master.countField]])) || 0;
    const currentTotal = numberOrNull(entryNow?.fields?.[masterFields[EX.master.totalField]]);
    let master = progress.master || null;
    const alreadyApplied = master
      && master.after_sales_count === currentCount
      && normalizeList(master.after_sales_types).join('|') === currentTypes.join('|');
    if (!alreadyApplied) {
      if (master && master.before_sales_count !== currentCount) {
        throw new Error(`原销售单的「售后次数」已被改动（期望 ${master.before_sales_count}，实际 ${currentCount}），请人工核对`);
      }
      const nextTypes = [...new Set([...currentTypes, EX.master.typeValue])];
      const nextTotal = currentTotal == null ? null : Number((currentTotal + prepared.diff).toFixed(2));
      await this.gateway.update('salesEntry', prepared.salesEntryRecordId, {
        [EX.master.typeField]: nextTypes,
        [EX.master.countField]: currentCount + EX.master.countDelta,
        ...(nextTotal == null ? {} : { [EX.master.totalField]: nextTotal }),
      }, { correlation: options.correlation });
      if (nextTotal == null) logWarn('workbench.orders.after_sales.exchange.total_missing', {
        request_id: requestId, sales_entry_record_id: prepared.salesEntryRecordId,
      });
      master = {
        before_sales_count: currentCount,
        after_sales_count: currentCount + EX.master.countDelta,
        after_sales_types: nextTypes,
        total_before: currentTotal,
        total_after: nextTotal,
      };
      await save({ status: 'master_enriched', master });
    }

    const result = {
      action: 'exchange', requestId,
      scenario: prepared.scenario,
      salesEntryRecordId: prepared.salesEntryRecordId,
      orderNo: prepared.orderNo,
      detailRecordId: prepared.detailRecordId,
      newDetail: { record_id: newDetailRecordId, detail_id: detailId },
      moneyMode: prepared.moneyMode,
      diffAmount: prepared.diff,
      money,
      master,
    };
    await save({ status: 'completed', result, completed_at: new Date().toISOString() });
    logInfo('workbench.orders.after_sales.exchange.completed', {
      request_id: requestId,
      action: 'exchange',
      scenario: prepared.scenario,
      sales_entry_record_id: prepared.salesEntryRecordId,
      order_no: prepared.orderNo,
      detail_record_id: prepared.detailRecordId,
      new_detail_record_id: newDetailRecordId,
      money_mode: prepared.moneyMode,
      diff_amount: prepared.diff,
      payment_record_id: money?.payment_record_id || '',
      receipt_id: money?.receipt_id || '',
      after_sales_count: master?.after_sales_count ?? null,
    });
    return result;
  }
}

module.exports = { AfterSalesExchangeService };
