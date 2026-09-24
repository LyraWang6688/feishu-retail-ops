const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { InventoryService } = require('./inventoryService');
const { logError, logInfo } = require('../utils/logger');

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const positiveNumber = (value, label) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label}必须大于 0`);
  return result;
};

const sameNumber = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;

const giftText = (item) => (item.gift ? String(item.giftDescription || '有赠品').trim() : '');

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
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.queue = Promise.resolve();
    this.schemaValidation = new Map();
    this.enableSalesInventory =
      options.enableSalesInventory ?? process.env.ENABLE_SALES_INVENTORY === 'true';
    this.enablePurchaseInventory =
      options.enablePurchaseInventory ?? process.env.ENABLE_PURCHASE_INVENTORY === 'true';
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

  field(tableKey, record, semanticKey) {
    const fieldName = this.gateway.table(tableKey).fields[semanticKey];
    return record?.fields?.[fieldName];
  }

  relationHas(tableKey, record, semanticKey, recordId) {
    return linkedRecordIds(this.field(tableKey, record, semanticKey)).includes(recordId);
  }

  async listRecords(tableKey) {
    if (typeof this.gateway.listAll !== 'function') return [];
    return this.gateway.listAll(tableKey);
  }

  consumeMatching(records, usedRecordIds, predicate) {
    const record = records.find((candidate) => !usedRecordIds.has(candidate.record_id) && predicate(candidate));
    if (record) usedRecordIds.add(record.record_id);
    return record || null;
  }

  async reconcileSaleDetails(items, salesEntryRecordId, paymentMethodRecordId, behaviorRecordId) {
    const existing = (await this.listRecords('salesDetail')).filter((record) =>
      this.relationHas('salesDetail', record, 'salesEntry', salesEntryRecordId)
    );
    const used = new Set();
    const rows = items.map((item) => {
      const record = this.consumeMatching(existing, used, (candidate) => {
        const productMatches = this.relationHas('salesDetail', candidate, 'product', item.productRecordId);
        const paymentMatches = paymentMethodRecordId
          ? this.relationHas('salesDetail', candidate, 'paymentMethod', paymentMethodRecordId)
          : linkedRecordIds(this.field('salesDetail', candidate, 'paymentMethod')).length === 0;
        const behaviorMatches = this.relationHas('salesDetail', candidate, 'behavior', behaviorRecordId);
        return (
          productMatches &&
          paymentMatches &&
          behaviorMatches &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'size')), item.size) &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'quantity')), item.quantity) &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'paidAmount')), item.paidAmount) &&
          textValue(this.field('salesDetail', candidate, 'gift')) === giftText(item)
        );
      });
      return { item, record, recordId: record?.record_id || '' };
    });
    if (existing.some((record) => !used.has(record.record_id))) {
      throw new Error('销售录单已存在与当前草稿不一致的销售明细，已停止自动重试');
    }
    return rows;
  }

  async reconcilePurchaseInbound(items, batchRecordId) {
    const existing = (await this.listRecords('purchaseInbound')).filter((record) =>
      this.relationHas('purchaseInbound', record, 'batch', batchRecordId)
    );
    const used = new Set();
    const rows = items.map((item) => {
      const record = this.consumeMatching(existing, used, (candidate) =>
        this.relationHas('purchaseInbound', candidate, 'product', item.productRecordId) &&
        sameNumber(textValue(this.field('purchaseInbound', candidate, 'size')), item.size) &&
        sameNumber(textValue(this.field('purchaseInbound', candidate, 'quantity')), item.quantity) &&
        sameNumber(textValue(this.field('purchaseInbound', candidate, 'unitCost')), item.unitCost)
      );
      return { item, record, recordId: record?.record_id || '' };
    });
    if (existing.some((record) => !used.has(record.record_id))) {
      throw new Error('采购到货批次已存在与当前草稿不一致的入库明细，已停止自动重试');
    }
    return rows;
  }

  async createMissingSaleDetails(rows, salesEntryRecordId, paymentMethodRecordId, behaviorRecordId) {
    for (const row of rows) {
      if (row.recordId) continue;
      const detail = await this.gateway.create('salesDetail', {
        product: relation(row.item.productRecordId),
        quantity: row.item.quantity,
        size: row.item.size,
        paidAmount: row.item.paidAmount,
        gift: giftText(row.item),
        paymentMethod: relation(paymentMethodRecordId),
        salesEntry: relation(salesEntryRecordId),
        behavior: relation(behaviorRecordId),
      });
      row.recordId = detail.recordId;
    }
    return rows;
  }

  async createMissingPurchaseInbound(rows, batchRecordId, operatorOpenId, occurredAt) {
    for (const row of rows) {
      if (row.recordId) continue;
      const inbound = await this.gateway.create('purchaseInbound', {
        size: row.item.size,
        quantity: row.item.quantity,
        operator: person(operatorOpenId),
        confirmed: true,
        batch: relation(batchRecordId),
        supplierOrder: relation(row.item.supplierOrderRecordId),
        product: relation(row.item.productRecordId),
        inboundAt: occurredAt,
        unitCost: row.item.unitCost,
      });
      row.recordId = inbound.recordId;
    }
    return rows;
  }

  postSale(input) {
    return this.runSerial(() => this._postSale(input));
  }

  async _postSale(input) {
    await this.ensureSchema('sale', ['product', 'behavior', 'paymentMethod', 'salesEntry', 'salesDetail']);
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
      if (resolved.length !== 1) throw new Error('V1 一条销售消息只能包含一条商品明细');
      const paidTotal = positiveNumber(input.totalPaid, '实收金额');
      const allocated = [{ ...resolved[0], paidAmount: paidTotal }];
      const sourceNo = await this.getDocumentNo('salesEntry', salesEntryRecordId, 'orderNo');
      const detailRows = await this.reconcileSaleDetails(
        allocated,
        salesEntryRecordId,
        paymentMethod?.recordId || '',
        behavior.recordId,
      );
      const recoveredDetailCount = detailRows.filter((row) => row.recordId).length;
      await this.createMissingSaleDetails(
        detailRows,
        salesEntryRecordId,
        paymentMethod?.recordId || '',
        behavior.recordId,
      );
      const detailRecordIds = detailRows.map((row) => row.recordId);
      const inventoryResults = [];
      if (this.enableSalesInventory) {
        for (const row of detailRows) {
          inventoryResults.push(
            await this.inventory.applySale({
              salesDetailRecordId: row.recordId,
              productRecordId: row.item.productRecordId,
              size: row.item.size,
              quantity: row.item.quantity,
              occurredAt,
            })
          );
        }
      }

      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '已入账',
      });
      logInfo('v1.sale.posted', {
        sales_entry_record_id: salesEntryRecordId,
        item_count: allocated.length,
        recovered_detail_count: recoveredDetailCount,
        inventory_applied: this.enableSalesInventory,
      });
      return {
        sourceNo,
        detailRecordIds,
        inventoryResults,
        inventoryApplied: this.enableSalesInventory,
      };
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
    await this.ensureSchema('purchase', ['product', 'supplier', 'purchaseBatch', 'purchaseInbound']);
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
      const resolved = await this.resolveItems(input.items);
      const normalized = resolved.map((item) => ({
        ...item,
        unitCost: positiveNumber(item.unitCost, '入库单价'),
      }));
      const sourceNo = await this.getDocumentNo('purchaseBatch', batchRecordId, 'batchNo');
      const inboundRows = await this.reconcilePurchaseInbound(normalized, batchRecordId);
      const recoveredInboundCount = inboundRows.filter((row) => row.recordId).length;
      await this.createMissingPurchaseInbound(inboundRows, batchRecordId, input.operatorOpenId, occurredAt);
      const inboundRecordIds = inboundRows.map((row) => row.recordId);
      const inventoryResults = [];
      if (this.enablePurchaseInventory) {
        for (const row of inboundRows) {
          inventoryResults.push(
            await this.inventory.applyPurchase({
              purchaseInboundRecordId: row.recordId,
              productRecordId: row.item.productRecordId,
              size: row.item.size,
              quantity: row.item.quantity,
              occurredAt,
            })
          );
        }
      }

      await this.gateway.update('purchaseBatch', batchRecordId, { confirmStatus: '已入账' });
      logInfo('v1.purchase.posted', {
        batch_record_id: batchRecordId,
        item_count: normalized.length,
        recovered_inbound_count: recoveredInboundCount,
        inventory_applied: this.enablePurchaseInventory,
      });
      return {
        sourceNo,
        inboundRecordIds,
        inventoryResults,
        inventoryApplied: this.enablePurchaseInventory,
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
