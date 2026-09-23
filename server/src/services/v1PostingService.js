const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { logError, logInfo } = require('../utils/logger');

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const positiveNumber = (value, label) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label}必须大于 0`);
  return result;
};

const allocatePaidAmounts = (items, totalPaid) => {
  const receivables = items.map((item) => money(item.quantity * item.unitPrice - (item.discountAmount || 0)));
  const receivableTotal = money(receivables.reduce((sum, value) => sum + value, 0));
  const paid = totalPaid == null || totalPaid === '' ? receivableTotal : money(totalPaid);
  if (paid < 0 || paid > receivableTotal) throw new Error('实付总额不能小于 0 或大于应收总额');
  let allocated = 0;
  return items.map((item, index) => {
    const paidAmount =
      index === items.length - 1
        ? money(paid - allocated)
        : money(receivableTotal === 0 ? 0 : (paid * receivables[index]) / receivableTotal);
    allocated = money(allocated + paidAmount);
    return { ...item, receivableAmount: receivables[index], paidAmount };
  });
};

class V1PostingService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.queue = Promise.resolve();
    this.schemaValidation = new Map();
  }

  async ensureSchema(scope, tableKeys) {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.schemaValidation.has(scope)) {
      this.schemaValidation.set(scope, this.gateway.validateTables(tableKeys));
    }
    return this.schemaValidation.get(scope);
  }

  runSerial(work) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async resolveItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('至少需要一条商品明细');
    const items = [];
    for (const raw of rawItems) {
      const product = await this.references.resolveProduct(raw);
      items.push({
        ...raw,
        productRecordId: product.recordId,
        size: positiveNumber(raw.size, '尺码'),
        quantity: positiveNumber(raw.quantity, '数量'),
      });
    }
    return items;
  }

  async getDocumentNo(tableKey, recordId, semanticKey) {
    const record = await this.gateway.get(tableKey, recordId);
    const fieldName = this.gateway.table(tableKey).fields[semanticKey];
    return textValue(record?.fields?.[fieldName]) || recordId;
  }

  async preflightInventory(items, direction) {
    const snapshots = [];
    const virtualInventory = new Map();
    for (const item of items) {
      const stockKey = `${item.productRecordId}|${item.size}`;
      let state = virtualInventory.get(stockKey);
      if (!state) {
        const liveRecord = await this.references.findLiveInventory(item.productRecordId, item.size);
        const quantityField = this.gateway.table('liveInventory').fields.quantity;
        state = {
          liveRecord,
          quantity: Number(textValue(liveRecord?.fields?.[quantityField]) || 0),
        };
      }
      const before = state.quantity;
      const change = direction * item.quantity;
      const after = before + change;
      if (after < 0) {
        throw new Error(`库存不足：${item.productNumber || item.itemNo || item.productRecordId} ${item.size}码，当前${before}，需要${item.quantity}`);
      }
      snapshots.push({ ...item, liveRecord: state.liveRecord, beforeQuantity: before, change, afterQuantity: after });
      virtualInventory.set(stockKey, { liveRecord: state.liveRecord, quantity: after });
    }
    return snapshots;
  }

  async applyInventory({ items, behaviorRecordId, sourceNo, sourceRecords, operatorOpenId, occurredAt }) {
    const results = [];
    const liveRecordIds = new Map();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const sourceRecordId = sourceRecords[index];
      const stockKey = `${item.productRecordId}|${item.size}`;
      const ledger = await this.gateway.create('inventoryLedger', {
        sourceRecordId,
        sourceNo,
        quantityChange: item.change,
        beforeQuantity: item.beforeQuantity,
        afterQuantity: item.afterQuantity,
        occurredAt,
        operator: person(operatorOpenId),
        postingStatus: '已入账',
        size: item.size,
        product: relation(item.productRecordId),
        behavior: relation(behaviorRecordId),
      });

      let liveRecordId = liveRecordIds.get(stockKey) || item.liveRecord?.record_id;
      if (liveRecordId) {
        await this.gateway.update('liveInventory', liveRecordId, {
          quantity: item.afterQuantity,
          operator: person(operatorOpenId),
          updatedAt: occurredAt,
        });
      } else {
        const live = await this.gateway.create('liveInventory', {
          product: relation(item.productRecordId),
          size: item.size,
          quantity: item.afterQuantity,
          operator: person(operatorOpenId),
          updatedAt: occurredAt,
        });
        liveRecordId = live.recordId;
      }
      liveRecordIds.set(stockKey, liveRecordId);
      results.push({ ledgerRecordId: ledger.recordId, liveRecordId });
    }
    return results;
  }

  postSale(input) {
    return this.runSerial(() => this._postSale(input));
  }

  async _postSale(input) {
    await this.ensureSchema('sale', [
      'product',
      'behavior',
      'paymentMethod',
      'salesEntry',
      'salesDetail',
      'inventoryLedger',
      'liveInventory',
      'moneyLedger',
    ]);
    const occurredAt = Number(input.occurredAt || Date.now());
    const salesEntryRecordId = input.salesEntryRecordId;
    if (!salesEntryRecordId) throw new Error('缺少销售录单 record_id');
    await this.gateway.update('salesEntry', salesEntryRecordId, {
      confirmStatus: '入账中',
      failureReason: '',
    });

    try {
      const behavior = await this.references.resolveBehavior(input.behaviorCode || 'SALE_CASH');
      const paymentMethod = await this.references.resolvePaymentMethod(input.paymentMethod);
      const resolved = await this.resolveItems(input.items);
      const normalized = resolved.map((item) => ({
        ...item,
        unitPrice: positiveNumber(item.unitPrice, '销售单价'),
        discountAmount: money(item.discountAmount || 0),
      }));
      const allocated = allocatePaidAmounts(normalized, input.totalPaid);
      const inventory = await this.preflightInventory(allocated, -1);
      const sourceNo = await this.getDocumentNo('salesEntry', salesEntryRecordId, 'orderNo');

      const detailRecordIds = [];
      for (const item of allocated) {
        const detail = await this.gateway.create('salesDetail', {
          product: relation(item.productRecordId),
          quantity: item.quantity,
          size: item.size,
          paidAmount: item.paidAmount,
          discountAmount: item.discountAmount,
          gift: Boolean(item.gift),
          paymentMethod: relation(paymentMethod?.recordId),
          soldAt: occurredAt,
          salesEntry: relation(salesEntryRecordId),
          unitPrice: item.unitPrice,
        });
        detailRecordIds.push(detail.recordId);
      }

      const inventoryResults = await this.applyInventory({
        items: inventory,
        behaviorRecordId: behavior.recordId,
        sourceNo,
        sourceRecords: detailRecordIds,
        operatorOpenId: input.operatorOpenId,
        occurredAt,
      });

      const paidTotal = money(allocated.reduce((sum, item) => sum + item.paidAmount, 0));
      let moneyRecordId = '';
      if (paidTotal > 0) {
        const flow = await this.gateway.create('moneyLedger', {
          sourceNo,
          direction: '收入',
          amount: paidTotal,
          paymentMethod: relation(paymentMethod?.recordId),
          occurredAt,
          operator: person(input.operatorOpenId),
          postingStatus: '已入账',
          remark: input.remark || '',
          behavior: relation(behavior.recordId),
        });
        moneyRecordId = flow.recordId;
      }

      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '已入账',
        postedAt: occurredAt,
        behavior: relation(behavior.recordId),
      });
      logInfo('v1.sale.posted', { sales_entry_record_id: salesEntryRecordId, item_count: allocated.length });
      return { sourceNo, detailRecordIds, inventoryResults, moneyRecordId };
    } catch (error) {
      await this.gateway
        .update('salesEntry', salesEntryRecordId, {
          confirmStatus: '入账失败',
          failureReason: error.message,
        })
        .catch(() => undefined);
      logError('v1.sale.post_failed', { sales_entry_record_id: salesEntryRecordId, error: error.message });
      throw error;
    }
  }

  postPurchase(input) {
    return this.runSerial(() => this._postPurchase(input));
  }

  async _postPurchase(input) {
    await this.ensureSchema('purchase', [
      'product',
      'behavior',
      'supplier',
      'purchaseBatch',
      'purchaseInbound',
      'inventoryLedger',
      'liveInventory',
      'supplierPayable',
      'moneyLedger',
    ]);
    const occurredAt = Number(input.occurredAt || Date.now());
    const batchRecordId = input.batchRecordId;
    if (!batchRecordId) throw new Error('缺少采购到货批次 record_id');
    await this.gateway.update('purchaseBatch', batchRecordId, {
      confirmStatus: '入账中',
      failureReason: '',
    });

    try {
      if (!input.supplierRecordId) throw new Error('采购入库必须选择供应商');
      await this.gateway.update('purchaseBatch', batchRecordId, {
        supplier: relation(input.supplierRecordId),
      });
      const behavior = await this.references.resolveBehavior('PURCHASE_IN');
      const resolved = await this.resolveItems(input.items);
      const normalized = resolved.map((item) => ({
        ...item,
        unitCost: positiveNumber(item.unitCost, '入库单价'),
      }));
      const inventory = await this.preflightInventory(normalized, 1);
      const sourceNo = await this.getDocumentNo('purchaseBatch', batchRecordId, 'batchNo');

      const inboundRecordIds = [];
      for (const item of normalized) {
        const inbound = await this.gateway.create('purchaseInbound', {
          size: item.size,
          quantity: item.quantity,
          operator: person(input.operatorOpenId),
          confirmed: true,
          batch: relation(batchRecordId),
          supplierOrder: relation(item.supplierOrderRecordId),
          product: relation(item.productRecordId),
          inboundAt: occurredAt,
          unitCost: item.unitCost,
        });
        inboundRecordIds.push(inbound.recordId);
      }

      const inventoryResults = await this.applyInventory({
        items: inventory,
        behaviorRecordId: behavior.recordId,
        sourceNo,
        sourceRecords: inboundRecordIds,
        operatorOpenId: input.operatorOpenId,
        occurredAt,
      });

      const payableTotal = money(normalized.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
      const payable = await this.gateway.create('supplierPayable', {
        supplier: relation(input.supplierRecordId),
        sourceNo,
        payableChange: payableTotal,
        occurredAt,
        operator: person(input.operatorOpenId),
        postingStatus: '已入账',
        behavior: relation(behavior.recordId),
      });

      let paymentResult = null;
      if (input.payment?.amount) {
        const paymentAmount = positiveNumber(input.payment.amount, '付款金额');
        if (paymentAmount > payableTotal) throw new Error('本次付款金额不能大于本批次入库应付金额');
        const paymentBehavior = await this.references.resolveBehavior('SUPPLIER_PAYMENT');
        const paymentMethod = await this.references.resolvePaymentMethod(input.payment.method);
        const moneyFlow = await this.gateway.create('moneyLedger', {
          sourceNo,
          direction: '支出',
          amount: paymentAmount,
          paymentMethod: relation(paymentMethod?.recordId),
          occurredAt,
          operator: person(input.operatorOpenId),
          postingStatus: '已入账',
          supplier: relation(input.supplierRecordId),
          behavior: relation(paymentBehavior.recordId),
        });
        const payablePayment = await this.gateway.create('supplierPayable', {
          supplier: relation(input.supplierRecordId),
          sourceNo,
          payableChange: -paymentAmount,
          occurredAt,
          operator: person(input.operatorOpenId),
          postingStatus: '已入账',
          behavior: relation(paymentBehavior.recordId),
        });
        paymentResult = { moneyRecordId: moneyFlow.recordId, payableRecordId: payablePayment.recordId };
      }

      await this.gateway.update('purchaseBatch', batchRecordId, { confirmStatus: '已入账' });
      logInfo('v1.purchase.posted', { batch_record_id: batchRecordId, item_count: normalized.length });
      return {
        sourceNo,
        inboundRecordIds,
        inventoryResults,
        payableRecordId: payable.recordId,
        paymentResult,
      };
    } catch (error) {
      await this.gateway
        .update('purchaseBatch', batchRecordId, {
          confirmStatus: '入账失败',
          failureReason: error.message,
        })
        .catch(() => undefined);
      logError('v1.purchase.post_failed', { batch_record_id: batchRecordId, error: error.message });
      throw error;
    }
  }
}

module.exports = {
  V1PostingService,
  allocatePaidAmounts,
  money,
};
