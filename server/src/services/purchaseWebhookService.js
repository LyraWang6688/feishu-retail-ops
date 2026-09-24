const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const doubaoService = require('./doubaoService');
const { purchaseRequestConfirmationCard, purchaseArrivalComparisonCard } = require('../utils/larkCards');
const { InventoryService } = require('./inventoryService');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');

const idFor = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;

const number = (value) => Number(textValue(value));

const attachmentTokens = (value) => (Array.isArray(value) ? value : [])
  .map((item) => item?.file_token || item?.fileToken || item?.token || '')
  .filter(Boolean);

class PurchaseWebhookService {
  constructor(options = {}) {
    this.client = options.client || (() => {
      const { appId, appSecret } = getLarkAgentCredentials();
      return new lark.Client({ appId, appSecret });
    })();
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.recognizer = options.recognizer || doubaoService;
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.enablePurchaseInventory = options.enablePurchaseInventory ?? process.env.ENABLE_PURCHASE_INVENTORY === 'true';
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/purchase_webhook_tasks'),
      idField: 'task_id',
    });
    this.queues = new Map();
  }

  enqueue(kind, recordId, work) {
    const key = `${kind}:${recordId}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next);
    next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  async accept(kind, recordId) {
    const id = String(recordId || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Webhook缺少有效 record_id');
    const taskId = idFor(`purchase_${kind}`, id);
    const existing = await this.store.get(taskId);
    if (existing?.status === 'completed') {
      logInfo('purchase.webhook.duplicate_ignored', { kind, record_id: id, task_id: taskId });
      return { accepted: true, duplicate: true, taskId };
    }
    if (existing && ['queued', 'processing', 'awaiting_confirmation', 'posted', 'cancelled'].includes(existing.status)) {
      logInfo('purchase.webhook.duplicate_ignored', { kind, record_id: id, task_id: taskId, status: existing.status });
      return { accepted: true, duplicate: true, taskId };
    }
    if (!existing) await this.store.create({ task_id: taskId, kind, record_id: id, status: 'queued' });
    else if (existing.status === 'processing') return { accepted: true, duplicate: true, taskId };
    setImmediate(() => this.enqueue(kind, id, () => this.process(kind, id, taskId)).catch((error) => {
      logError('purchase.webhook.processing.failed', { kind, record_id: id, task_id: taskId, error: error.message });
    }));
    logInfo('purchase.webhook.accepted', { kind, record_id: id, task_id: taskId });
    return { accepted: true, duplicate: false, taskId };
  }

  async process(kind, recordId, taskId) {
    const task = await this.store.get(taskId);
    if (task?.status === 'completed') return task;
    await this.store.update(taskId, { status: 'processing', started_at: new Date().toISOString() });
    try {
      const result = kind === 'supplier-report'
        ? await this.processSupplierReport(recordId, taskId)
        : await this.processArrival(recordId, taskId);
      // The task remains awaiting_confirmation until the card action posts it.
      // A webhook retry must therefore be treated as a duplicate, not as a new parse.
      const current = await this.store.get(taskId);
      return this.store.update(taskId, { status: current?.status || 'awaiting_confirmation', result });
    } catch (error) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      if (kind === 'supplier-report') {
        await this.gateway.update('purchaseReport', recordId, { status: '解析失败', failureReason: error.message }).catch(() => undefined);
      }
      throw error;
    }
  }

  async sendCard(openId, card) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送确认卡片');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`发送采购确认卡失败: ${response.msg} (Code: ${response.code})`);
  }

  recordOperator(record, fieldName) {
    const value = record?.fields?.[fieldName];
    const first = Array.isArray(value) ? value[0] : value;
    return first?.id || first?.open_id || first?.openId || '';
  }

  async processSupplierReport(recordId, taskId) {
    const table = this.gateway.table('purchaseReport');
    const record = await this.gateway.get('purchaseReport', recordId);
    const fields = record?.fields || {};
    const status = textValue(fields[table.fields.status]);
    if (['已生成申请', '已取消'].includes(status)) return { ignored: true, status };
    const description = textValue(fields[table.fields.description]);
    const productIds = linkedRecordIds(fields[table.fields.product]);
    if (productIds.length !== 1) throw new Error('供应商报单必须关联一个货品编号');
    const behaviorIds = linkedRecordIds(fields[table.fields.behavior]);
    const supplierName = textValue(fields[table.fields.supplier]);
    const supplier = await this.references.resolveSupplier(supplierName);
    const parsed = await this.recognizer.parsePurchaseReportText(description);
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const operatorOpenId = this.recordOperator(record, table.fields.operator);
    const draftId = taskId;
    const draft = {
      report_record_id: recordId,
      product_record_id: product.recordId,
      product_number: textValue(product.record?.fields?.[this.gateway.table('product').fields.number]),
      supplier_record_id: supplier.recordId,
      behavior_record_id: behaviorIds[0] || '',
      supplier: supplierName,
      items: parsed.map((item) => ({ ...item, product_record_id: product.recordId, product_number: textValue(product.record?.fields?.[this.gateway.table('product').fields.number]), supplier: supplierName })),
      operator_open_id: operatorOpenId,
    };
    await this.gateway.update('purchaseReport', recordId, { status: '待确认', failureReason: '' });
    await this.store.update(taskId, { status: 'awaiting_confirmation', draft });
    await this.sendCard(operatorOpenId, purchaseRequestConfirmationCard(draftId, draft));
    logInfo('purchase.report.card.sent', { record_id: recordId, task_id: taskId, item_count: parsed.length });
    return { status: 'awaiting_confirmation', item_count: parsed.length };
  }

  async processArrival(recordId, taskId) {
    const table = this.gateway.table('purchaseArrival');
    const record = await this.gateway.get('purchaseArrival', recordId);
    const fields = record?.fields || {};
    const currentStatus = textValue(fields[table.fields.confirmStatus]);
    if (['已确认', '已入库', '已取消'].includes(currentStatus)) return { ignored: true, status: currentStatus };
    await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别中', failureReason: '' });
    const tokens = attachmentTokens(fields[table.fields.images]);
    if (!tokens.length) throw new Error('采购到货记录没有鞋盒图片附件');
    // 图片下载、视觉识别和差异确认将在同一异步任务中完成；权限不足时保留失败状态，便于重试。
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-arrival-'));
    try {
      const recognized = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const filePath = path.join(tempDir, `${index + 1}.jpg`);
        const media = await this.client.drive.media.download({ path: { file_token: tokens[index] } });
        await media.writeFile(filePath);
        recognized.push(...await this.recognizer.recognizeLabels(filePath, 'purchase'));
      }
      const arrivalTable = this.gateway.table('purchaseArrival');
      const batchIds = linkedRecordIds(fields[arrivalTable.fields.batch]);
      if (batchIds.length !== 1) throw new Error('采购到货必须选择一个报货批次号');
      if (!this.gateway.table('purchaseOrderBatch').tableId) throw new Error('未配置报货批次表ID：FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID');
      const batch = await this.gateway.get('purchaseOrderBatch', batchIds[0]);
      const batchTable = this.gateway.table('purchaseOrderBatch');
      const batchNo = textValue(batch?.fields?.[batchTable.fields.batchNo]);
      const requestTable = this.gateway.table('purchaseRequest');
      const requests = (await this.gateway.listAll('purchaseRequest')).filter(
        (item) => textValue(item.fields?.[requestTable.fields.batchNo]) === batchNo
      );
      const actual = [];
      for (const raw of recognized) {
        const product = await this.references.resolveProduct({ itemNo: raw.item_no, color: raw.color });
        actual.push({
          product_record_id: product.recordId,
          product_number: textValue(product.record?.fields?.[this.gateway.table('product').fields.number]),
          size: Number(raw.size),
          quantity: Number(raw.quantity || 1),
        });
      }
      const differences = this.compareArrival(requests, actual, requestTable);
      const operatorOpenId = this.recordOperator(record, arrivalTable.fields.creator);
      const draft = { arrival_record_id: recordId, batch_record_id: batchIds[0], batch_no: batchNo, operator_open_id: operatorOpenId, requests, actual, differences };
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别成功', confirmStatus: '待确认' });
      await this.store.update(taskId, { recognized, draft, status: 'awaiting_confirmation' });
      await this.sendCard(operatorOpenId, purchaseArrivalComparisonCard(taskId, draft));
      logInfo('purchase.arrival.card.sent', { record_id: recordId, task_id: taskId, item_count: actual.length, difference_count: differences.length });
      return { status: 'awaiting_confirmation', item_count: actual.length, difference_count: differences.length };
    } catch (error) {
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别失败', failureReason: error.message }).catch(() => undefined);
      logWarn('purchase.arrival.recognition.failed', { record_id: recordId, task_id: taskId, error: error.message });
      throw error;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  compareArrival(requests, actual, requestTable) {
    const map = new Map();
    const key = (productId, size) => `${productId}|${size}`;
    for (const row of requests) {
      const productId = linkedRecordIds(row.fields?.[requestTable.fields.product])[0];
      if (!productId) continue;
      const item = map.get(key(productId, number(row.fields?.[requestTable.fields.size]))) || {
        product_record_id: productId,
        size: number(row.fields?.[requestTable.fields.size]),
        requested: 0,
        actual: 0,
        request_record_id: row.record_id,
        product_number: '',
      };
      item.requested += number(row.fields?.[requestTable.fields.quantity]);
      map.set(key(productId, item.size), item);
    }
    for (const row of actual) {
      const item = map.get(key(row.product_record_id, row.size)) || {
        product_record_id: row.product_record_id,
        size: row.size,
        requested: 0,
        actual: 0,
        request_record_id: '',
        product_number: row.product_number,
      };
      item.actual += row.quantity;
      item.product_number = item.product_number || row.product_number;
      map.set(key(row.product_record_id, row.size), item);
    }
    return [...map.values()].map((item) => {
      const difference = item.actual - item.requested;
      return { ...item, label: difference === 0 ? '一致' : difference > 0 ? `多${difference}` : `少${Math.abs(difference)}` };
    });
  }

  async handleCardAction(value, operatorOpenId) {
    const taskId = value?.draft_id;
    const action = value?.action;
    if (!taskId || !['confirm_purchase_request', 'cancel_purchase_request', 'confirm_purchase_arrival', 'cancel_purchase_arrival'].includes(action)) return null;
    const task = await this.store.get(taskId);
    if (!task?.draft) throw new Error('采购申请草稿不存在或已过期');
    if (task.draft.operator_open_id !== operatorOpenId) throw new Error('只能由原始填写人确认采购流程');
    if (action === 'cancel_purchase_arrival') {
      await this.gateway.update('purchaseArrival', task.draft.arrival_record_id, { confirmStatus: '已取消' });
      await this.store.update(taskId, { status: 'cancelled' });
      return { toast: { type: 'info', content: '采购到货已取消' } };
    }
    if (action === 'confirm_purchase_arrival') return this.confirmArrival(taskId, task, operatorOpenId);
    if (action === 'cancel_purchase_request') {
      await this.gateway.update('purchaseReport', task.draft.report_record_id, { status: '已取消' });
      await this.store.update(taskId, { status: 'cancelled' });
      return { toast: { type: 'info', content: '采购申请已取消' } };
    }
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购申请已生成' } };
    const batchNo = await this.nextBatchNo();
    const batch = await this.gateway.create('purchaseOrderBatch', {
      batchNo,
      supplier: relation(task.draft.supplier_record_id),
    });
    const requestIds = [];
    for (const item of task.draft.items) {
      const request = await this.gateway.create('purchaseRequest', {
        batchNo,
        product: relation(item.product_record_id),
        size: item.size,
        quantity: item.quantity,
        behavior: relation(task.draft.behavior_record_id),
        supplier: relation(task.draft.supplier_record_id),
      });
      requestIds.push(request.recordId);
    }
    await this.gateway.update('purchaseReport', task.draft.report_record_id, {
      status: '已生成申请',
      request: requestIds,
    });
    await this.store.update(taskId, { status: 'posted', batch_record_id: batch.recordId, batch_no: batchNo, request_ids: requestIds });
    logInfo('purchase.request.created', { task_id: taskId, batch_record_id: batch.recordId, batch_no: batchNo, request_count: requestIds.length });
    return { toast: { type: 'success', content: `采购申请已生成：${batchNo}` } };
  }

  async confirmArrival(taskId, task, operatorOpenId) {
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
    const arrival = task.draft;
    const requestTable = this.gateway.table('purchaseRequest');
    const created = [];
    for (const item of arrival.actual || []) {
      const match = (arrival.differences || []).find(
        (row) => row.product_record_id === item.product_record_id && Number(row.size) === Number(item.size)
      );
      const inbound = await this.gateway.create('purchaseInbound', {
        product: relation(item.product_record_id),
        size: item.size,
        quantity: item.quantity,
        operator: person(operatorOpenId),
        confirmed: true,
        batch: relation(arrival.arrival_record_id),
        purchaseRequest: match?.request_record_id ? relation(match.request_record_id) : undefined,
        inboundAt: Date.now(),
      });
      created.push(inbound.recordId);
      if (this.enablePurchaseInventory) {
        await this.inventory.applyPurchase({
          purchaseInboundRecordId: inbound.recordId,
          productRecordId: item.product_record_id,
          size: item.size,
          quantity: item.quantity,
          occurredAt: Date.now(),
        });
      }
    }
    for (const request of arrival.requests || []) {
      const productId = linkedRecordIds(request.fields?.[requestTable.fields.product])[0];
      const size = number(request.fields?.[requestTable.fields.size]);
      const actualQuantity = (arrival.actual || [])
        .filter((item) => item.product_record_id === productId && Number(item.size) === size)
        .reduce((sum, item) => sum + item.quantity, 0);
      const requestedQuantity = number(request.fields?.[requestTable.fields.quantity]);
      const status = actualQuantity === 0 ? '未到货' : actualQuantity < requestedQuantity ? '部分到货' : actualQuantity > requestedQuantity ? '超额到货' : '全部到货';
      await this.gateway.update('purchaseRequest', request.record_id, { arrivalStatus: status });
    }
    await this.gateway.update('purchaseArrival', arrival.arrival_record_id, { confirmStatus: '已确认' });
    await this.store.update(taskId, { status: 'posted', inbound_record_ids: created });
    logInfo('purchase.arrival.posted', { task_id: taskId, arrival_record_id: arrival.arrival_record_id, inbound_count: created.length, inventory_applied: this.enablePurchaseInventory });
    return { toast: { type: 'success', content: this.enablePurchaseInventory ? '采购已入库，库存已更新' : '采购入库已确认' } };
  }

  async nextBatchNo() {
    const table = this.gateway.table('purchaseOrderBatch');
    if (!table.tableId) throw new Error('未配置报货批次表ID：FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID');
    const records = await this.gateway.listAll('purchaseOrderBatch');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/-/g, '');
    const prefix = `BH-${date}-`;
    const max = records.reduce((current, record) => {
      const value = textValue(record.fields?.[table.fields.batchNo]);
      const match = value.match(new RegExp(`^${prefix}(\\d{4})$`));
      return match ? Math.max(current, Number(match[1])) : current;
    }, 0);
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }
}

module.exports = { PurchaseWebhookService, attachmentTokens };
