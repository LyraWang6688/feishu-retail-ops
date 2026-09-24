const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { logError, logInfo } = require('../utils/logger');

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const positiveNumber = (value, label) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label}必须大于 0`);
  return result;
};

const sameNumber = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;

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

  async reconcileSaleDetails(items, salesEntryRecordId, paymentMethodRecordId, occurredAt) {
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
        return (
          productMatches &&
          paymentMatches &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'size')), item.size) &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'quantity')), item.quantity) &&
          sameNumber(textValue(this.field('salesDetail', candidate, 'paidAmount')), item.paidAmount) &&
          Boolean(this.field('salesDetail', candidate, 'gift')) === Boolean(item.gift)
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

  async createMissingSaleDetails(rows, salesEntryRecordId, paymentMethodRecordId, occurredAt) {
    for (const row of rows) {
      if (row.recordId) continue;
      const detail = await this.gateway.create('salesDetail', {
        product: relation(row.item.productRecordId),
        quantity: row.item.quantity,
        size: row.item.size,
        paidAmount: row.item.paidAmount,
        gift: Boolean(row.item.gift),
        paymentMethod: relation(paymentMethodRecordId),
        soldAt: occurredAt,
        salesEntry: relation(salesEntryRecordId),
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

  async findMoneyFlow(sourceNo, direction, amount, supplierRecordId = '', paymentMethodRecordId = '') {
    const records = await this.listRecords('moneyLedger');
    const candidates = records.filter((record) => {
        const supplierMatches = supplierRecordId
          ? this.relationHas('moneyLedger', record, 'supplier', supplierRecordId)
          : true;
        return (
          supplierMatches &&
          String(textValue(this.field('moneyLedger', record, 'sourceNo'))) === String(sourceNo) &&
          String(textValue(this.field('moneyLedger', record, 'direction'))) === direction
        );
      });
    if (candidates.length > 1) throw new Error(`来源单号 ${sourceNo} 存在重复资金流水，已停止自动重试`);
    const record = candidates[0] || null;
    if (!record) return null;
    const amountMatches = sameNumber(textValue(this.field('moneyLedger', record, 'amount')), amount);
    const paymentMethodMatches = paymentMethodRecordId
      ? this.relationHas('moneyLedger', record, 'paymentMethod', paymentMethodRecordId)
      : true;
    if (!amountMatches || !paymentMethodMatches) {
      throw new Error(`来源单号 ${sourceNo} 的资金流水与当前付款信息不一致，已停止自动重试`);
    }
    return record;
  }

  async findSupplierPayable(sourceNo, change, supplierRecordId) {
    const records = await this.listRecords('supplierPayable');
    const candidates = records.filter(
        (record) =>
          this.relationHas('supplierPayable', record, 'supplier', supplierRecordId) &&
          String(textValue(this.field('supplierPayable', record, 'sourceNo'))) === String(sourceNo) &&
          Math.sign(Number(textValue(this.field('supplierPayable', record, 'payableChange')))) === Math.sign(change)
    );
    if (candidates.length > 1) throw new Error(`来源单号 ${sourceNo} 存在重复供应商往来流水，已停止自动重试`);
    const record = candidates[0] || null;
    if (!record) return null;
    if (!sameNumber(textValue(this.field('supplierPayable', record, 'payableChange')), change)) {
      throw new Error(`来源单号 ${sourceNo} 的供应商往来流水与当前金额不一致，已停止自动重试`);
    }
    return record;
  }

  async prepareInventory(rows, direction) {
    const ledgers = await this.listRecords('inventoryLedger');
    const groups = new Map();

    for (const row of rows) {
      const stockKey = `${row.item.productRecordId}|${row.item.size}`;
      if (!groups.has(stockKey)) {
        const liveRecord = await this.references.findLiveInventory(row.item.productRecordId, row.item.size);
        const quantityField = this.gateway.table('liveInventory').fields.quantity;
        groups.set(stockKey, {
          stockKey,
          productRecordId: row.item.productRecordId,
          size: row.item.size,
          liveRecord,
          currentQuantity: Number(textValue(liveRecord?.fields?.[quantityField]) || 0),
          rows: [],
        });
      }
      row.ledger = row.recordId
        ? ledgers.find(
            (record) => String(textValue(this.field('inventoryLedger', record, 'sourceRecordId'))) === row.recordId
          ) || null
        : null;
      groups.get(stockKey).rows.push(row);
    }

    for (const group of groups.values()) {
      const firstExisting = group.rows.find((row) => row.ledger);
      let cursor = firstExisting
        ? Number(textValue(this.field('inventoryLedger', firstExisting.ledger, 'beforeQuantity')))
        : group.currentQuantity;
      const allowedCurrentQuantities = new Set([cursor]);
      let sawMissingLedger = false;

      for (const row of group.rows) {
        const expectedChange = direction * row.item.quantity;
        if (row.ledger) {
          if (sawMissingLedger) throw new Error(`库存流水顺序异常：${group.stockKey}`);
          const before = Number(textValue(this.field('inventoryLedger', row.ledger, 'beforeQuantity')));
          const after = Number(textValue(this.field('inventoryLedger', row.ledger, 'afterQuantity')));
          const change = Number(textValue(this.field('inventoryLedger', row.ledger, 'quantityChange')));
          if (!sameNumber(before, cursor) || !sameNumber(change, expectedChange) || !sameNumber(after, before + change)) {
            throw new Error(`库存流水与待入账内容不一致：${group.stockKey}`);
          }
          row.beforeQuantity = before;
          row.afterQuantity = after;
          row.change = change;
          cursor = after;
          allowedCurrentQuantities.add(after);
          continue;
        }

        sawMissingLedger = true;
        row.beforeQuantity = cursor;
        row.change = expectedChange;
        row.afterQuantity = cursor + expectedChange;
        if (row.afterQuantity < 0) {
          throw new Error(
            `库存不足：${row.item.productNumber || row.item.itemNo || row.item.productRecordId} ${row.item.size}码，当前${cursor}，需要${row.item.quantity}`
          );
        }
        cursor = row.afterQuantity;
      }

      if (firstExisting && ![...allowedCurrentQuantities].some((value) => sameNumber(value, group.currentQuantity))) {
        throw new Error(`实时库存与恢复点冲突：${group.stockKey}，当前${group.currentQuantity}`);
      }
      group.targetQuantity = cursor;
    }

    return { rows, groups };
  }

  async applyPreparedInventory({ plan, behaviorRecordId, sourceNo, operatorOpenId, occurredAt }) {
    const results = [];
    for (const row of plan.rows) {
      if (!row.recordId) throw new Error('业务明细未返回 record_id，不能写库存流水');
      if (!row.ledger) {
        const created = await this.gateway.create('inventoryLedger', {
          sourceRecordId: row.recordId,
          sourceNo,
          quantityChange: row.change,
          beforeQuantity: row.beforeQuantity,
          afterQuantity: row.afterQuantity,
          occurredAt,
          operator: person(operatorOpenId),
          postingStatus: '已入账',
          size: row.item.size,
          product: relation(row.item.productRecordId),
          behavior: relation(behaviorRecordId),
        });
        row.ledger = { record_id: created.recordId };
      }
    }

    for (const group of plan.groups.values()) {
      let liveRecordId = group.liveRecord?.record_id || '';
      if (liveRecordId) {
        if (!sameNumber(group.currentQuantity, group.targetQuantity)) {
          await this.gateway.update('liveInventory', liveRecordId, {
            quantity: group.targetQuantity,
            operator: person(operatorOpenId),
            updatedAt: occurredAt,
          });
        }
      } else {
        const live = await this.gateway.create('liveInventory', {
          product: relation(group.productRecordId),
          size: group.size,
          quantity: group.targetQuantity,
          operator: person(operatorOpenId),
          updatedAt: occurredAt,
        });
        liveRecordId = live.recordId;
      }
      group.liveRecordId = liveRecordId;
    }

    for (const row of plan.rows) {
      const stockKey = `${row.item.productRecordId}|${row.item.size}`;
      results.push({ ledgerRecordId: row.ledger.record_id, liveRecordId: plan.groups.get(stockKey).liveRecordId });
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
      if (resolved.length !== 1) throw new Error('V1 一条销售消息只能包含一条商品明细');
      const paidTotal = positiveNumber(input.totalPaid, '实收金额');
      const allocated = [{ ...resolved[0], paidAmount: paidTotal }];
      const sourceNo = await this.getDocumentNo('salesEntry', salesEntryRecordId, 'orderNo');
      const detailRows = await this.reconcileSaleDetails(
        allocated,
        salesEntryRecordId,
        paymentMethod?.recordId || '',
        occurredAt
      );
      const inventoryPlan = await this.prepareInventory(detailRows, -1);
      const recovery = {
        detail_count: detailRows.filter((row) => row.recordId).length,
        inventory_ledger_count: inventoryPlan.rows.filter((row) => row.ledger).length,
        money_flow_count: 0,
      };
      await this.createMissingSaleDetails(
        detailRows,
        salesEntryRecordId,
        paymentMethod?.recordId || '',
        occurredAt
      );
      const detailRecordIds = detailRows.map((row) => row.recordId);

      const inventoryResults = await this.applyPreparedInventory({
        plan: inventoryPlan,
        behaviorRecordId: behavior.recordId,
        sourceNo,
        operatorOpenId: input.operatorOpenId,
        occurredAt,
      });

      let moneyRecordId = '';
      if (paidTotal > 0) {
        const existingFlow = await this.findMoneyFlow(
          sourceNo,
          '收入',
          paidTotal,
          '',
          paymentMethod?.recordId || ''
        );
        if (existingFlow) {
          moneyRecordId = existingFlow.record_id;
          recovery.money_flow_count = 1;
        }
        else {
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
      }

      await this.gateway.update('salesEntry', salesEntryRecordId, {
        confirmStatus: '已入账',
        postedAt: occurredAt,
        behavior: relation(behavior.recordId),
      });
      logInfo('v1.sale.posted', {
        sales_entry_record_id: salesEntryRecordId,
        item_count: allocated.length,
        recovered_detail_count: recovery.detail_count,
        recovered_inventory_ledger_count: recovery.inventory_ledger_count,
        recovered_money_flow_count: recovery.money_flow_count,
      });
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
      const sourceNo = await this.getDocumentNo('purchaseBatch', batchRecordId, 'batchNo');
      const inboundRows = await this.reconcilePurchaseInbound(normalized, batchRecordId);
      const inventoryPlan = await this.prepareInventory(inboundRows, 1);
      const recovery = {
        inbound_count: inboundRows.filter((row) => row.recordId).length,
        inventory_ledger_count: inventoryPlan.rows.filter((row) => row.ledger).length,
        payable_count: 0,
        money_flow_count: 0,
        payable_payment_count: 0,
      };
      await this.createMissingPurchaseInbound(inboundRows, batchRecordId, input.operatorOpenId, occurredAt);
      const inboundRecordIds = inboundRows.map((row) => row.recordId);

      const inventoryResults = await this.applyPreparedInventory({
        plan: inventoryPlan,
        behaviorRecordId: behavior.recordId,
        sourceNo,
        operatorOpenId: input.operatorOpenId,
        occurredAt,
      });

      const payableTotal = money(normalized.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
      let payable = await this.findSupplierPayable(sourceNo, payableTotal, input.supplierRecordId);
      if (payable) recovery.payable_count = 1;
      else {
        const created = await this.gateway.create('supplierPayable', {
          supplier: relation(input.supplierRecordId),
          sourceNo,
          payableChange: payableTotal,
          occurredAt,
          operator: person(input.operatorOpenId),
          postingStatus: '已入账',
          behavior: relation(behavior.recordId),
        });
        payable = { record_id: created.recordId };
      }

      let paymentResult = null;
      if (input.payment?.amount) {
        const paymentAmount = positiveNumber(input.payment.amount, '付款金额');
        if (paymentAmount > payableTotal) throw new Error('本次付款金额不能大于本批次入库应付金额');
        const paymentBehavior = await this.references.resolveBehavior('SUPPLIER_PAYMENT');
        const paymentMethod = await this.references.resolvePaymentMethod(input.payment.method);
        let moneyFlow = await this.findMoneyFlow(
          sourceNo,
          '支出',
          paymentAmount,
          input.supplierRecordId,
          paymentMethod?.recordId || ''
        );
        if (moneyFlow) recovery.money_flow_count = 1;
        else {
          const created = await this.gateway.create('moneyLedger', {
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
          moneyFlow = { record_id: created.recordId };
        }
        let payablePayment = await this.findSupplierPayable(sourceNo, -paymentAmount, input.supplierRecordId);
        if (payablePayment) recovery.payable_payment_count = 1;
        else {
          const created = await this.gateway.create('supplierPayable', {
            supplier: relation(input.supplierRecordId),
            sourceNo,
            payableChange: -paymentAmount,
            occurredAt,
            operator: person(input.operatorOpenId),
            postingStatus: '已入账',
            behavior: relation(paymentBehavior.recordId),
          });
          payablePayment = { record_id: created.recordId };
        }
        paymentResult = { moneyRecordId: moneyFlow.record_id, payableRecordId: payablePayment.record_id };
      }

      await this.gateway.update('purchaseBatch', batchRecordId, { confirmStatus: '已入账' });
      logInfo('v1.purchase.posted', {
        batch_record_id: batchRecordId,
        item_count: normalized.length,
        recovered_inbound_count: recovery.inbound_count,
        recovered_inventory_ledger_count: recovery.inventory_ledger_count,
        recovered_payable_count: recovery.payable_count,
        recovered_money_flow_count: recovery.money_flow_count,
        recovered_payable_payment_count: recovery.payable_payment_count,
      });
      return {
        sourceNo,
        inboundRecordIds,
        inventoryResults,
        payableRecordId: payable.record_id,
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
