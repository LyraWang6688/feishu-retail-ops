'use strict';

/**
 * 售后（衍生单）· **退货写入**（异步 worker 调它；表单 POST 只做入队）。
 *
 * 业务负责人 2026-10-29 定稿 / 2026-11-08 落库：
 *   · **不新建销售主表 / 售后单**：在原销售主表上丰富（售后类型多选累加「退货」+ 售后次数 +1）；
 *   · 货：原销售明细「履约状态」→ 已退货；库存流水 +1（行为 =「销售增加」）；
 *        实时库存 +1，默认落**门盒**（不再问样品/门盒）；
 *   · 钱：**新建一条 S交易明细**（不改原行）——
 *        直接退款：`{单号}-退款-NN` · 支付方式=她选的 · 收支方向=退回 · 钱款状态=已退款；
 *        货款留存：`{单号}-留存-NN` · 支付方式/收支方向不填 · 钱款状态=已留存；
 *        金额 = 这双鞋在销售明细里的金额 · 收付日 = 点击当天 · 关联原销售单；
 *   · 幂等：本地任务记录按 requestId 分片，每步写完落盘 —— 重试/断点续做不重复写。
 */
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService } = require('./inventoryService');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { nextId, stateFor } = require('./salesRecordIds');
const { createPaymentMethodsService } = require('./paymentMethodsService');
const { AFTER_SALES_DERIVED } = require('../config/afterSalesDerived');
const { logInfo } = require('../utils/logger');

const DEFAULT_STORE_DIR = path.join(__dirname, '../../data/after_sales_returns');
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;

const normalizeList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : (item?.name || item?.text || '')))
      .map((item) => String(item || '').trim()).filter(Boolean);
  }
  const text = String(value ?? '').trim();
  return text ? [text] : [];
};

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

class AfterSalesReturnService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('AfterSalesReturnService requires gateway');
    this.gateway = options.gateway;
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.paymentMethods = options.paymentMethods || createPaymentMethodsService(this.gateway);
    this.now = options.now || (() => Date.now());
    this.store = options.store || new JsonTaskStore({
      dir: options.dir || AFTER_SALES_DERIVED.jobsDir || DEFAULT_STORE_DIR,
      idField: 'request_id',
    });
  }

  get texts() { return AFTER_SALES_DERIVED.texts; }

  /**
   * 只读校验 + 读原单/原明细/金额（不写任何东西）。
   * 表单 POST 时先调它 ⇒ 她填错能立刻回页面看见原因（而不是后台才失败）。
   */
  async prepare(payload = {}) {
    const requestId = String(payload.requestId || '').trim();
    if (!REQUEST_ID_PATTERN.test(requestId)) throw badRequest(this.texts.needRequestId);
    const salesEntryRecordId = String(payload.salesEntryRecordId || '').trim();
    if (!salesEntryRecordId) throw badRequest(this.texts.needEntry);
    const detailRecordId = String(payload.detailRecordId || payload.salesDetailRecordId || '').trim();
    if (!detailRecordId) throw badRequest(this.texts.needDetail);
    const moneyMode = String(payload.moneyMode || '').trim();
    if (!moneyMode) throw badRequest(this.texts.needMoneyMode);
    const modeValues = Object.values(AFTER_SALES_DERIVED.money.modes);
    if (!modeValues.includes(moneyMode)) throw badRequest(this.texts.invalidMoneyMode);
    const paymentMethod = String(payload.paymentMethod || '').trim();
    if (moneyMode === AFTER_SALES_DERIVED.money.modes.REFUND && !paymentMethod) {
      throw badRequest(this.texts.needPaymentMethod);
    }

    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry) throw badRequest(this.texts.entryNotFound);
    const entryFields = this.gateway.table('salesEntry').fields;
    const orderNo = textValue(entry.fields?.[entryFields.orderNo]).trim();
    const detail = await this.gateway.get('salesDetail', detailRecordId);
    if (!detail) throw badRequest(this.texts.detailNotFound);
    const detailFields = this.gateway.table('salesDetail').fields;
    if (!linkedRecordIds(detail.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId)) {
      throw badRequest(this.texts.detailNotInEntry);
    }
    const fulfillmentStatus = textValue(detail.fields?.[detailFields.fulfillmentStatus]).trim();
    if (fulfillmentStatus === AFTER_SALES_DERIVED.detailFulfillment.RETURNED) {
      throw badRequest(this.texts.alreadyReturned);
    }
    if (!AFTER_SALES_DERIVED.returnableFulfillmentStatuses.includes(fulfillmentStatus)) {
      throw badRequest(this.texts.detailNotReturnable);
    }
    const rawAmount = textValue(detail.fields?.[detailFields.actualAmount]).trim();
    if (!rawAmount) throw badRequest(this.texts.amountMissing);
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest(this.texts.amountInvalid);
    const productRecordId = linkedRecordIds(detail.fields?.[detailFields.product])[0] || '';
    if (!productRecordId) throw badRequest(this.texts.missingProduct);
    const sizeRecordId = linkedRecordIds(detail.fields?.[detailFields.size])[0] || '';
    if (!sizeRecordId) throw badRequest(this.texts.missingSize);
    const sizeRecord = await this.gateway.get('sizeManagement', sizeRecordId);
    const sizeFields = this.gateway.table('sizeManagement').fields;
    const size = Number(textValue(sizeRecord?.fields?.[sizeFields.size]));
    if (!Number.isFinite(size)) throw badRequest(this.texts.sizeUnreadable);

    // 她选的退款方式必须真的在「支付方式管理」里（配置表唯一数据源）
    let method = null;
    if (moneyMode === AFTER_SALES_DERIVED.money.modes.REFUND) {
      const listed = await this.paymentMethods.listWithVouchers();
      const detailed = listed?.detailed || listed?.items || [];
      const hit = detailed.find((item) => item.name === paymentMethod && item.recordId);
      if (!hit) throw badRequest(this.texts.unknownPaymentMethod);
      method = hit;
    }
    return {
      requestId, salesEntryRecordId, orderNo, detailRecordId, moneyMode, paymentMethod, method,
      amount, productRecordId, size, fulfillmentStatus,
    };
  }

  /** 执行一次退货写入（异步 worker 调用）。 */
  async execute(payload = {}, options = {}) {
    const requestId = String(payload?.requestId || '').trim();
    if (!REQUEST_ID_PATTERN.test(requestId)) throw badRequest(this.texts.needRequestId);
    const storeId = `after_sales_return_${requestId}`;
    let progress = await this.store.get(storeId);
    if (progress?.status === 'completed' && progress.result) return progress.result;

    const prepared = await this.prepare(payload);
    const save = (patch) => this.store.update(storeId, patch);
    if (!progress) {
      progress = await this.store.create({ request_id: storeId, status: 'preparing', payload });
    }

    // ① 货：原销售明细 → 已退货（幂等：已经是目标值就跳过）
    const detailFields = this.gateway.table('salesDetail').fields;
    const current = await this.gateway.get('salesDetail', prepared.detailRecordId);
    const currentStatus = textValue(current?.fields?.[detailFields.fulfillmentStatus]).trim();
    if (currentStatus !== AFTER_SALES_DERIVED.detailFulfillment.RETURNED) {
      if (!AFTER_SALES_DERIVED.returnableFulfillmentStatuses.includes(currentStatus)) {
        throw new Error(`${this.texts.detailNotReturnable}（当前：${currentStatus || '空'}）`);
      }
      await this.gateway.update('salesDetail', prepared.detailRecordId, {
        fulfillmentStatus: AFTER_SALES_DERIVED.detailFulfillment.RETURNED,
      }, { correlation: options.correlation });
    }
    await save({ status: 'detail_marked', detail_marked_at: new Date().toISOString() });

    // ② 货：库存流水 + 实时库存（走既有 InventoryService；幂等由库存操作键兜住）
    const stock = await this.inventory.applyChange({
      kind: AFTER_SALES_DERIVED.stockBehaviorCode,
      productRecordId: prepared.productRecordId,
      size: prepared.size,
      state: AFTER_SALES_DERIVED.defaultRestockState,
      quantity: 1,
      sourceRecordId: prepared.detailRecordId,
    }, { correlation: options.correlation });
    await save({ status: 'stock_applied', stock });

    // ③ 钱：新建一条 S交易明细（退款 / 留存）
    let money = progress.money || null;
    if (!money?.payment_record_id) {
      const paymentFields = this.gateway.table('paymentRecord').fields;
      const read = await stateFor({
        gateway: this.gateway, tableKey: 'paymentRecord',
        entryIds: [prepared.salesEntryRecordId], idField: paymentFields.receiptId,
      });
      const isRefund = prepared.moneyMode === AFTER_SALES_DERIVED.money.modes.REFUND;
      const kind = isRefund ? 'refund' : 'retained';
      const receiptId = nextId({ state: read.state, orderNo: prepared.orderNo, kind });
      // 断点重试：同一 receiptId 已经写过 ⇒ 复用（不写第二遍）
      const existing = (read.rows || []).find((row) =>
        textValue(row.fields?.[paymentFields.receiptId]).trim() === receiptId) || null;
      let recordId = existing?.record_id || '';
      if (!recordId) {
        const created = await this.gateway.create('paymentRecord', {
          salesEntry: relation(prepared.salesEntryRecordId),
          ...(receiptId ? { receiptId } : {}),
          ...(isRefund && prepared.method ? { method: relation(prepared.method.recordId) } : {}),
          ...(isRefund ? { tradeDirection: AFTER_SALES_DERIVED.money.refundDirection } : {}),
          amount: prepared.amount,
          status: AFTER_SALES_DERIVED.money.statusByMode[kind],
          receivedAt: this.now(),
        }, { correlation: options.correlation });
        recordId = created.recordId;
      }
      money = {
        payment_record_id: recordId,
        receipt_id: receiptId,
        kind,
        status: AFTER_SALES_DERIVED.money.statusByMode[kind],
        amount: prepared.amount,
      };
      await save({ status: 'money_recorded', money });
    }

    // ④ 原销售主表：售后类型多选累加 + 售后次数 +1（幂等：已经加过就跳过）
    const masterFields = this.gateway.table('salesEntry').fields;
    const typeValue = AFTER_SALES_DERIVED.master.typeValueByAction.return;
    const entryNow = await this.gateway.get('salesEntry', prepared.salesEntryRecordId);
    const currentTypes = normalizeList(entryNow?.fields?.[masterFields[AFTER_SALES_DERIVED.master.typeField]]);
    const currentCount = Number(textValue(entryNow?.fields?.[masterFields[AFTER_SALES_DERIVED.master.countField]])) || 0;
    let master = progress.master || null;
    const alreadyApplied = master
      && master.after_sales_count === currentCount
      && normalizeList(master.after_sales_types).join('|') === currentTypes.join('|');
    if (!alreadyApplied) {
      if (master && master.before_sales_count !== currentCount) {
        throw new Error(`原销售单的「售后次数」已被改动（期望 ${master.before_sales_count}，实际 ${currentCount}），请人工核对`);
      }
      const nextTypes = [...new Set([...currentTypes, typeValue])];
      await this.gateway.update('salesEntry', prepared.salesEntryRecordId, {
        [AFTER_SALES_DERIVED.master.typeField]: nextTypes,
        [AFTER_SALES_DERIVED.master.countField]: currentCount + AFTER_SALES_DERIVED.master.countDelta,
      }, { correlation: options.correlation });
      master = {
        before_sales_count: currentCount,
        after_sales_count: currentCount + AFTER_SALES_DERIVED.master.countDelta,
        after_sales_types: nextTypes,
      };
      await save({ status: 'master_enriched', master });
    }

    const result = {
      action: 'return', requestId,
      salesEntryRecordId: prepared.salesEntryRecordId,
      orderNo: prepared.orderNo,
      detailRecordId: prepared.detailRecordId,
      moneyMode: prepared.moneyMode,
      money,
      stock,
      master,
    };
    await save({ status: 'completed', result, completed_at: new Date().toISOString() });
    logInfo('workbench.orders.after_sales.completed', {
      request_id: requestId,
      action: 'return',
      sales_entry_record_id: prepared.salesEntryRecordId,
      order_no: prepared.orderNo,
      detail_record_id: prepared.detailRecordId,
      money_mode: prepared.moneyMode,
      payment_record_id: money.payment_record_id,
      receipt_id: money.receipt_id,
      payment_status: money.status,
      after_sales_count: master?.after_sales_count ?? null,
    });
    return result;
  }
}

module.exports = { AfterSalesReturnService };
