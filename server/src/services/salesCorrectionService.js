'use strict';

/**
 * 销售「确认单」：最近 N 天销售单的整单更正（2026-11-28）。
 *
 * 口径（业务负责人定稿）：
 *   · 只改原记录：销售主表 / 销售明细 / S交易明细 / 库存流水；
 *   · 实时库存按四象限：现货→现货对调一行、现货→预订补原码、预订→现货删新码、预订→预订不动；
 *   · 跨现货/预订时库存流水允许新增/删除一条；
 *   · 5 个上海自然日、写入成功、无售后；本人或管理员。
 *
 * 这里只做编排和业务校验；库存动作全部委托 InventoryService.correctSaleDetailSize。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { textValue, personText } = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { relation, V1ReferenceResolver } = require('./v1ReferenceResolver');
const { getConfigRows } = require('./configTableCache');
const { saleSizeGroups } = require('../views/scanPageRealm');
const { salesTradeTypeForStock } = require('../config/salesTradeTypePolicy');
const { SALES_CORRECTION } = require('../config/salesCorrection');
const { logInfo, logWarn } = require('../utils/logger');

const money = (value, label) => {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(SALES_CORRECTION.texts.amountInvalid);
  return Math.round(Number(text) * 100) / 100;
};
const personOpenIds = (value) => (Array.isArray(value) ? value : [value]).flatMap((cell) => {
  if (!cell || typeof cell !== 'object') return [];
  if (Array.isArray(cell.value)) return personOpenIds(cell.value);
  const id = String(cell.id || cell.open_id || cell.user_id || '').trim();
  return id ? [id] : [];
});
const shanghaiStartOfWindow = (now = Date.now(), days = 5) => {
  const sh = new Date(now + 8 * 60 * 60 * 1000);
  const y = sh.getUTCFullYear();
  const m = sh.getUTCMonth();
  const d = sh.getUTCDate();
  const startShanghai = Date.UTC(y, m, d - (days - 1));
  return startShanghai - 8 * 60 * 60 * 1000;
};
const dayKey = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
};

class SalesCorrectionService {
  constructor({
    gateway, followup, inventory, scanPageService, config = SALES_CORRECTION,
    store, auditDir, now = () => Date.now(), references,
  } = {}) {
    if (!gateway) throw new Error('SalesCorrectionService requires gateway');
    if (!followup) throw new Error('SalesCorrectionService requires followup');
    if (!inventory) throw new Error('SalesCorrectionService requires inventory');
    this.gateway = gateway;
    this.followup = followup;
    this.inventory = inventory;
    this.scanPageService = scanPageService;
    this.config = config;
    this.now = now;
    this.references = references || new V1ReferenceResolver(gateway);
    this.store = store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/sales_corrections'),
      idField: 'task_id',
    });
    this.auditDir = auditDir || path.join(__dirname, '../../data/sales_corrections');
    this.queue = Promise.resolve();
  }

  isAdmin(actor = {}) {
    const roles = Array.isArray(actor.roleNames) ? actor.roleNames : [actor.role];
    return roles.includes(this.config.roles.admin) || (actor.permissions || []).includes(this.config.permissions.any);
  }

  canEdit(order, actor = {}) {
    if (!order?.editable) return false;
    if (this.isAdmin(actor)) return true;
    const openId = String(actor.openId || actor.open_id || '').trim();
    return Boolean(openId) && (order.sender_open_ids || []).includes(openId);
  }

  async list({ actor = {}, days = this.config.windowDays } = {}) {
    const base = await this.followup.listOrders();
    const masterRows = await this.gateway.listAll('salesEntry').catch(() => []);
    const masterById = new Map(masterRows.map((row) => [row.record_id, row]));
    const fields = this.gateway.table('salesEntry').fields;
    const start = shanghaiStartOfWindow(this.now(), days);
    const orders = (base.orders || []).filter((order) => {
      const master = masterById.get(order.record_id);
      const recorded = dayKey(master?.fields?.[fields.recordedAt] ?? order.recorded_at);
      return recorded >= start && recorded <= this.now();
    }).map((order) => {
      const master = masterById.get(order.record_id);
      const mf = master?.fields || {};
      const afterCount = Number(textValue(mf[fields.afterSalesCount]) || 0);
      const afterType = textValue(mf[fields.afterSalesType]).trim();
      const writeStatus = textValue(mf[fields.writeStatus]).trim();
      const reasons = [];
      if (writeStatus && !this.config.allowedWriteStatuses.includes(writeStatus)) reasons.push('status');
      if (afterCount > 0 || afterType) reasons.push('after_sales');
      const preview = {
        ...order,
        sender: personText(mf[fields.sender]),
        sender_open_ids: personOpenIds(mf[fields.sender]),
        after_sales_by: personText(mf[fields.afterSalesBy]),
        after_sales_count: afterCount,
        after_sales_type: afterType,
        write_status: writeStatus,
        gift: textValue(mf[fields.gift]),
        accessory: textValue(mf[fields.accessory]),
        accessory_amount: Number(textValue(mf[fields.accessoryAmount]) || 0),
        total_amount: Number(textValue(mf[fields.totalAmount]) || order.total_amount || 0),
      };
      preview.editable = reasons.length === 0;
      preview.blocked_reasons = reasons;
      preview.can_edit = this.canEdit(preview, actor);
      return preview;
    }).sort((a, b) => dayKey(b.recorded_at) - dayKey(a.recorded_at));
    return { days, windowStart: new Date(start).toISOString(), methods: base.methods || [], orders };
  }

  async correct({ submitKey, salesEntryRecordId, details = [], payments = [], gift, accessory, accessoryTotal } = {}, { actor = {}, requestId = '' } = {}) {
    const key = String(submitKey || '').trim();
    if (!key) throw new Error(this.config.texts.submitKeyMissing);
    const taskId = `sales_correction_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    const fingerprint = JSON.stringify([salesEntryRecordId, details, payments, gift, accessory, accessoryTotal]);
    const existing = await this.store.get(taskId).catch(() => null);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('同一个提交键对应了不同的修改内容');
      if (existing.status === 'completed') return existing.result;
      throw new Error('这次修改结果待核对，请勿重复提交');
    }
    const master = await this.gateway.get('salesEntry', String(salesEntryRecordId || ''));
    if (!master) throw new Error(this.config.texts.notEditable);
    const fields = this.gateway.table('salesEntry').fields;
    const recorded = dayKey(master.fields?.[fields.recordedAt]);
    if (recorded < shanghaiStartOfWindow(this.now(), this.config.windowDays)) throw new Error(this.config.texts.outsideWindow);
    const writeStatus = textValue(master.fields?.[fields.writeStatus]).trim();
    if (writeStatus && !this.config.allowedWriteStatuses.includes(writeStatus)) throw new Error(this.config.texts.statusBlocked);
    if (Number(textValue(master.fields?.[fields.afterSalesCount]) || 0) > 0 || textValue(master.fields?.[fields.afterSalesType]).trim()) {
      throw new Error(this.config.texts.afterSalesBlocked);
    }
    const orderPreview = (await this.list({ actor })).orders.find((order) => order.record_id === salesEntryRecordId);
    if (!orderPreview || !this.canEdit(orderPreview, actor)) throw new Error(this.config.texts.forbidden);
    const detailRows = (await this.gateway.listAll('salesDetail')).filter((row) =>
      strictLinkedRecordIds(row.fields?.[this.gateway.table('salesDetail').fields.salesEntry]).includes(salesEntryRecordId));
    const paymentRows = (await this.gateway.listAll('paymentRecord')).filter((row) =>
      strictLinkedRecordIds(row.fields?.[this.gateway.table('paymentRecord').fields.salesEntry]).includes(salesEntryRecordId));
    const detailById = new Map(detailRows.map((row) => [row.record_id, row]));
    const paymentById = new Map(paymentRows.map((row) => [row.record_id, row]));
    const behaviorRows = await getConfigRows({ gateway: this.gateway, tableKey: 'behavior' });
    const behaviorFields = this.gateway.table('behavior').fields;
    const codeOfTradeType = (id) => textValue(behaviorRows.find((row) => row.record_id === strictLinkedRecordIds(id)[0])?.fields?.[behaviorFields.code]).trim();

    const changedDetails = [];
    for (const input of Array.isArray(details) ? details : []) {
      const row = detailById.get(String(input?.recordId || ''));
      if (!row) throw new Error(this.config.texts.detailNotFound);
      const detailFields = this.gateway.table('salesDetail').fields;
      const currentSize = await this.inventory.sizeReferences.resolveLinkedCell(row.fields?.[detailFields.size]);
      const currentAmount = textValue(row.fields?.[detailFields.actualAmount]);
      const currentCode = codeOfTradeType(row.fields?.[detailFields.tradeType]);
      const nextSize = input.size === undefined || input.size === '' ? currentSize.size : Number(input.size);
      const nextAmount = input.actualAmount === undefined || String(input.actualAmount).trim() === ''
        ? currentAmount : money(input.actualAmount, this.config.labels.detailAmount);
      const sizeChanged = String(nextSize) !== String(currentSize.size);
      if (!sizeChanged && String(nextAmount) === String(currentAmount)) continue;
      let nextTradeType = null;
      let productRecordId = strictLinkedRecordIds(row.fields?.[detailFields.product])[0];
      let fromInStock = currentCode === 'SALE_CASH';
      let toInStock = false;
      if (sizeChanged) {
        if (!productRecordId || !this.scanPageService) throw new Error('缺少货品身份，无法校验尺码库存');
        const view = await this.scanPageService.lookup({ recordId: productRecordId, requestId });
        const groups = saleSizeGroups(view);
        const target = [...groups.inStock, ...groups.prepaid, ...groups.folded].find((item) => String(item.size_text) === String(nextSize));
        if (!target) throw new Error(this.config.texts.sizeRequired);
        toInStock = groups.inStock.some((item) => String(item.size_text) === String(nextSize));
        const nextCode = salesTradeTypeForStock({ inStock: toInStock });
        nextTradeType = await this.references.resolveSalesTradeType(nextCode);
      }
      changedDetails.push({
        row, currentSize, currentAmount, currentCode, nextSize, nextAmount, productRecordId,
        fromInStock, toInStock, nextTradeType, sizeChanged,
      });
    }

    const changedPayments = [];
    for (const input of Array.isArray(payments) ? payments : []) {
      const row = paymentById.get(String(input?.recordId || ''));
      if (!row) throw new Error(this.config.texts.paymentNotFound);
      const pf = this.gateway.table('paymentRecord').fields;
      const currentAmount = textValue(row.fields?.[pf.amount]);
      const currentMethodId = strictLinkedRecordIds(row.fields?.[pf.method])[0] || '';
      const nextAmount = input.amount === undefined || String(input.amount).trim() === '' ? currentAmount : money(input.amount, this.config.labels.paymentAmount);
      const nextMethodName = String(input.method || '').trim();
      const nextMethod = nextMethodName ? await this.references.resolvePaymentMethod(nextMethodName) : null;
      const methodChanged = nextMethod && (!currentMethodId || nextMethod.recordId !== currentMethodId);
      if (!methodChanged && String(nextAmount) === String(currentAmount)) continue;
      changedPayments.push({ row, nextAmount, nextMethod, methodChanged });
    }

    if (!changedDetails.length && !changedPayments.length
      && String(gift ?? '') === textValue(master.fields?.[fields.gift])
      && String(accessory ?? '') === textValue(master.fields?.[fields.accessory])
      && (accessoryTotal === undefined || String(accessoryTotal) === textValue(master.fields?.[fields.accessoryAmount]))) {
      throw new Error(this.config.texts.noChanges);
    }

    // 先算改后的应收 / 已收，禁止改成「已收 > 应收」的负未收。
    const detailAmountById = new Map(detailRows.map((row) => [
      row.record_id, Number(textValue(row.fields?.[this.gateway.table('salesDetail').fields.actualAmount]) || 0),
    ]));
    for (const item of changedDetails) detailAmountById.set(item.row.record_id, Number(item.nextAmount) || 0);
    const projectedDetailTotal = [...detailAmountById.values()].reduce((sum, value) => sum + value, 0);
    const projectedAccessory = accessoryTotal === undefined
      ? Number(textValue(master.fields?.[fields.accessoryAmount]) || 0) : money(accessoryTotal, this.config.labels.accessoryAmount);
    const projectedGrandTotal = projectedDetailTotal + projectedAccessory;
    const paymentAmountById = new Map(paymentRows.map((row) => [
      row.record_id, Number(textValue(row.fields?.[this.gateway.table('paymentRecord').fields.amount]) || 0),
    ]));
    for (const item of changedPayments) paymentAmountById.set(item.row.record_id, Number(item.nextAmount) || 0);
    const projectedPaid = paymentRows.reduce((sum, row) => {
      const status = textValue(row.fields?.[this.gateway.table('paymentRecord').fields.status]).trim();
      return sum + (status === this.config.paymentStatus.unpaid || status === this.config.paymentStatus.refunded
        || status === this.config.paymentStatus.retained ? 0 : (paymentAmountById.get(row.record_id) || 0));
    }, 0);
    if (projectedPaid > projectedGrandTotal) throw new Error(this.config.texts.overpaid);

    // 先冻结任务，再写；失败保留 failed 状态，重试会拒绝以免半截数据被当成新请求。
    await this.store.create({ task_id: taskId, fingerprint, status: 'pending' });
    const audit = { task_id: taskId, request_id: requestId, operator: actor.openId || actor.open_id || '', at: new Date().toISOString(), sales_entry_record_id: salesEntryRecordId, details: [], payments: [] };
    try {
      for (const item of changedDetails) {
        if (String(item.nextSize) !== String(item.currentSize.size)) {
          const stock = await this.inventory.correctSaleDetailSize({
            salesDetailRecordId: item.row.record_id,
            salesEntryRecordId,
            productRecordId: item.productRecordId,
            fromSize: item.currentSize.size,
            toSize: item.nextSize,
            fromInStock: item.fromInStock,
            toInStock: item.toInStock,
            operatorOpenId: audit.operator,
            correctionId: taskId,
            correlation: { request_id: requestId, sales_entry_record_id: salesEntryRecordId, task_id: taskId },
          });
          audit.details.push({ record_id: item.row.record_id, kind: 'size', from: item.currentSize.size, to: item.nextSize, from_in_stock: item.fromInStock, to_in_stock: item.toInStock, stock });
        }
        const df = this.gateway.table('salesDetail').fields;
        const nextSize = await this.inventory.sizeReferences.resolveByNumber(item.nextSize);
        await this.gateway.update('salesDetail', item.row.record_id, {
          size: relation(nextSize.recordId),
          ...(item.sizeChanged && item.nextTradeType ? { tradeType: relation(item.nextTradeType.recordId) } : {}),
          ...(String(item.nextAmount) !== String(item.currentAmount) ? { actualAmount: item.nextAmount } : {}),
        }, { correlation: { request_id: requestId } });
        audit.details.push({ record_id: item.row.record_id, kind: 'amount', from: item.currentAmount, to: item.nextAmount });
      }

      for (const item of changedPayments) {
        const pf = this.gateway.table('paymentRecord').fields;
        await this.gateway.update('paymentRecord', item.row.record_id, {
          ...(item.methodChanged ? { method: relation(item.nextMethod.recordId) } : {}),
          ...(String(item.nextAmount) !== String(textValue(item.row.fields?.[pf.amount])) ? { amount: item.nextAmount } : {}),
        }, { correlation: { request_id: requestId } });
        audit.payments.push({ record_id: item.row.record_id, from_method: textValue(item.row.fields?.[pf.method]), to_method: item.nextMethod?.record?.fields?.[this.gateway.table('paymentMethod').fields.name] || '', from: textValue(item.row.fields?.[pf.amount]), to: item.nextAmount });
      }

      const allDetails = (await this.gateway.listAll('salesDetail')).filter((row) =>
        strictLinkedRecordIds(row.fields?.[this.gateway.table('salesDetail').fields.salesEntry]).includes(salesEntryRecordId));
      const totalAmount = allDetails.reduce((sum, row) => sum + Number(textValue(row.fields?.[this.gateway.table('salesDetail').fields.actualAmount]) || 0), 0);
      const nextAccessoryAmount = accessoryTotal === undefined ? Number(textValue(master.fields?.[fields.accessoryAmount]) || 0) : money(accessoryTotal, this.config.labels.accessoryAmount);
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        totalAmount,
        ...(gift === undefined ? {} : { gift: String(gift) }),
        ...(accessory === undefined ? {} : { accessory: String(accessory) }),
        ...(accessoryTotal === undefined ? {} : { accessoryAmount: nextAccessoryAmount }),
      }, { correlation: { request_id: requestId } });

      await this.syncPending(salesEntryRecordId, totalAmount + nextAccessoryAmount, requestId);
      await fs.promises.mkdir(this.auditDir, { recursive: true });
      await fs.promises.writeFile(path.join(this.auditDir, `${taskId}.audit.json`), JSON.stringify(audit, null, 2));
      await this.store.update(taskId, { status: 'completed', result: { ok: true, total_amount: totalAmount, audit } });
      logInfo('sales.correction.applied', { request_id: requestId, sales_entry_record_id: salesEntryRecordId, task_id: taskId });
      this.followup.ordersCache?.invalidate?.();
      return { ok: true, total_amount: totalAmount, audit };
    } catch (error) {
      await this.store.update(taskId, { status: 'failed', error: String(error?.message || error) }).catch(() => undefined);
      logWarn('sales.correction.failed', { request_id: requestId, sales_entry_record_id: salesEntryRecordId, task_id: taskId, error: String(error?.message || error) });
      throw error;
    }
  }

  async syncPending(salesEntryRecordId, grandTotal, requestId) {
    const pf = this.gateway.table('paymentRecord').fields;
    const rows = (await this.gateway.listAll('paymentRecord')).filter((row) =>
      strictLinkedRecordIds(row.fields?.[pf.salesEntry]).includes(salesEntryRecordId));
    const paid = rows.filter((row) => {
      const status = textValue(row.fields?.[pf.status]).trim();
      return status && status !== this.config.paymentStatus.unpaid && status !== this.config.paymentStatus.refunded && status !== this.config.paymentStatus.retained;
    }).reduce((sum, row) => sum + Number(textValue(row.fields?.[pf.amount]) || 0), 0);
    const owed = Math.max(0, Math.round((grandTotal - paid) * 100) / 100);
    const pending = rows.filter((row) => textValue(row.fields?.[pf.status]).trim() === this.config.paymentStatus.unpaid);
    if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
    if (pending.length === 1) {
      await this.gateway.update('paymentRecord', pending[0].record_id, { amount: owed }, { correlation: { request_id: requestId } });
    } else if (owed > 0) {
      await this.gateway.create('paymentRecord', {
        salesEntry: relation(salesEntryRecordId), amount: owed, status: this.config.paymentStatus.unpaid,
        tradeDirection: this.config.tradeDirection.income,
      }, { correlation: { request_id: requestId } });
    }
  }
}

module.exports = { SalesCorrectionService, shanghaiStartOfWindow, personOpenIds };
