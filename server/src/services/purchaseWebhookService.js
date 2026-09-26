const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const doubaoService = require('./doubaoService');
const { purchaseRequestConfirmationCard, purchaseArrivalComparisonCard, purchaseStatusCard } = require('../utils/larkCards');
const { InventoryService } = require('./inventoryService');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');

const idFor = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;

const number = (value) => Number(textValue(value));

const attachmentTokens = (value) => (Array.isArray(value) ? value : [])
  .map((item) => item?.file_token || item?.fileToken || item?.token || '')
  .filter(Boolean);

const aggregateArrivalItems = (items) => {
  const byKey = new Map();
  for (const item of items) {
    const size = Number(item.size);
    const quantity = Number(item.quantity);
    if (!item.product_record_id || !Number.isInteger(size) || size <= 0 ||
      !Number.isInteger(quantity) || quantity <= 0) throw new Error('到货识别结果的货品、尺码或数量无效');
    const key = `${item.product_record_id}|${size}`;
    if (byKey.has(key)) byKey.get(key).quantity += quantity;
    else byKey.set(key, { ...item, size, quantity });
  }
  return [...byKey.values()];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.enablePurchaseInventory = true;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/purchase_webhook_tasks'),
      idField: 'task_id',
    });
    this.queues = new Map();
    this.batchReadMaxRetries = options.batchReadMaxRetries ?? 3;
    this.batchReadRetryDelay = options.batchReadRetryDelay ?? 1000;
    this.inflightInbound = new Map();
    // 批次聚合：按报货批次号聚合同一批次的多条报单明细
    this.batchQueues = new Map(); // key: 报货批次号, value: { recordIds: Set, timer, taskId }
    this.activeBatches = new Set(); // 正在处理的批次号，用于全局并发限制
    this.MAX_ACTIVE_BATCHES = options.maxActiveBatches ?? 3; // 全局最多同时处理3个批次
    this.BATCH_WAIT_MS = options.batchWaitMs ?? 30000; // 批次等待窗口30秒（最后一条到达后重置）
  }

  enqueue(kind, recordId, work) {
    const key = `${kind}:${recordId}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next);
    next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => {});
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
    if (existing && ['queued', 'processing', 'awaiting_confirmation', 'posted', 'cancelled', 'batch_waiting'].includes(existing.status)) {
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
      let result;
      if (kind === 'supplier-report') {
        // 检查是否有报货批次号，有则走批次聚合，无则走单条处理（兼容旧数据）
        const batchNo = await this.readReportBatchNo(recordId);
        if (batchNo) {
          result = await this.enqueueBatch(batchNo, recordId, taskId);
        } else {
          result = await this.processSupplierReport(recordId, taskId);
        }
      } else {
        result = await this.processArrival(recordId, taskId);
      }
      const current = await this.store.get(taskId);
      return this.store.update(taskId, { status: current?.status || 'awaiting_confirmation', result });
    } catch (error) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      if (kind === 'supplier-report') {
        await this.gateway.update('purchaseReport', recordId, { status: '解析失败', failureReason: error.message }).catch(() => undefined);
      }
      if (kind === 'arrival') {
        await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别失败', failureReason: error.message }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * 读取报单记录的报货批次号（文本字段）
   * 遇到飞书 Data not ready 时自动重试，最多3次
   */
  async readReportBatchNo(recordId) {
    const maxRetries = this.batchReadMaxRetries;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const table = this.gateway.table('purchaseReport');
        const record = await this.gateway.get('purchaseReport', recordId);
        const fields = record?.fields || {};
        const batchNo = textValue(fields[table.fields.batchNoText]) || '';
        if (batchNo) return batchNo;
        // 批次号为空时也重试（可能是数据还没同步）
        if (attempt < maxRetries) {
          logWarn('purchase.batch.batch_no_empty', { record_id: recordId, attempt });
          await new Promise(resolve => setTimeout(resolve, this.batchReadRetryDelay * attempt));
        }
      } catch (error) {
        logWarn('purchase.batch.read_failed', { record_id: recordId, attempt, error: error.message });
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    return '';
  }

  /**
   * 按报货批次号聚合：加入等待队列，最后一条到达后等 BATCH_WAIT_MS 再批量处理
   */
  async enqueueBatch(batchNo, recordId, taskId) {
    const existing = this.batchQueues.get(batchNo);
    if (existing) {
      existing.recordIds.add(recordId);
      clearTimeout(existing.timer);
    } else {
      this.batchQueues.set(batchNo, { recordIds: new Set([recordId]), taskId });
    }
    const queue = this.batchQueues.get(batchNo);
    // 用第一条记录的 taskId 作为批次任务的 taskId
    const batchTaskId = queue.taskId;
    await this.store.update(taskId, { status: 'batch_waiting', batch_no: batchNo }).catch(() => undefined);
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      this.batchQueues.delete(batchNo);
      this.processSupplierBatch(batchNo, [...queue.recordIds], batchTaskId).catch((error) => {
        logError('purchase.batch.processing.failed', { batch_no: batchNo, error: error.message });
      });
    }, this.BATCH_WAIT_MS);
    logInfo('purchase.batch.queued', { batch_no: batchNo, record_id: recordId, task_id: taskId, pending_count: queue.recordIds.size });
    return { status: 'batch_waiting', batch_no: batchNo };
  }

  /**
   * 批量处理同一报货批次号下的所有报单明细
   */
  async processSupplierBatch(batchNo, recordIds, batchTaskId) {
    // 全局并发限制：超过最大并发数则延迟重试
    if (this.activeBatches.size >= this.MAX_ACTIVE_BATCHES) {
      logWarn('purchase.batch.concurrent_limit', { batch_no: batchNo, active_count: this.activeBatches.size });
      setTimeout(() => {
        this.processSupplierBatch(batchNo, recordIds, batchTaskId).catch((error) => {
          logError('purchase.batch.retry.failed', { batch_no: batchNo, error: error.message });
        });
      }, 10000);
      return;
    }
    this.activeBatches.add(batchNo);
    try {
      const reportTable = this.gateway.table('purchaseReport');
      const productTable = this.gateway.table('product');
      // 用文本字段筛选该批次下的所有报单记录（文本字段支持API筛选）
      const allRecords = await this.gateway.listAll('purchaseReport');
      const batchRecords = allRecords.filter((record) => {
        const fields = record?.fields || {};
        const no = textValue(fields[reportTable.fields.batchNoText]);
        return no === batchNo;
      });
      if (batchRecords.length === 0) throw new Error(`报货批次号 ${batchNo} 下没有找到报单记录`);

      // 逐条解析，收集所有明细
      const allItems = [];
      const reportRecordIds = [];
      let supplierRecordId = '';
      let supplierName = '';
      let behaviorRecordId = '';
      let operatorOpenId = '';
      const parseErrors = [];

      for (const record of batchRecords) {
        const fields = record?.fields || {};
        const status = textValue(fields[reportTable.fields.status]);
        if (['已生成申请', '已取消'].includes(status)) continue;
        reportRecordIds.push(record.record_id);
        const description = textValue(fields[reportTable.fields.description]);
        const detailId = textValue(fields[reportTable.fields.detailId]);
        const productIds = linkedRecordIds(fields[reportTable.fields.product]);
        if (productIds.length !== 1) {
          parseErrors.push(`记录 ${record.record_id}：必须关联一个货品编号`);
          continue;
        }
        const behaviorIds = linkedRecordIds(fields[reportTable.fields.behavior]);
        behaviorRecordId = behaviorRecordId || behaviorIds[0] || '';
        // 从货品信息表的供应商关联字段直接获取供应商 record_id（不读报单表公式字段）
        try {
          const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
          const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
          if (productSupplierIds.length > 0) {
            if (!supplierRecordId) {
              supplierRecordId = productSupplierIds[0];
            } else if (supplierRecordId !== productSupplierIds[0]) {
              logInfo("purchase.batch.multi_supplier", { batch_no: batchNo, record_id: record.record_id, supplier: productSupplierIds[0] });
            }
          }
          const productNumber = textValue(product.record?.fields?.[productTable.fields.number]);
          const parsed = await this.recognizer.parsePurchaseReportText(description);
          for (const item of parsed) {
            allItems.push({
              ...item,
              product_record_id: product.recordId,
              product_number: productNumber,
              report_record_id: record.record_id,
              detail_id: detailId,
            });
          }
        } catch (error) {
          parseErrors.push(`记录 ${record.record_id}：${error.message}`);
        }
        if (!operatorOpenId) operatorOpenId = this.recordOperator(record, reportTable.fields.operator);
      }

      if (parseErrors.length > 0) throw new Error(`批次解析存在问题：\n${parseErrors.join('\n')}`);
      if (allItems.length === 0) throw new Error(`报货批次号 ${batchNo} 下没有解析到任何明细`);
      if (!supplierRecordId) throw new Error('无法从货品信息获取供应商，请检查货品的供应商关联字段');

      // 按明细ID→尺码排序（明细ID决定货号展示顺序）
      allItems.sort((a, b) => {
        if (String(a.detail_id) !== String(b.detail_id)) return String(a.detail_id).localeCompare(String(b.detail_id));
        return Number(a.size) - Number(b.size);
      });

      const draft = {
        is_batch: true,
        batch_no: batchNo,
        report_record_ids: reportRecordIds,
        supplier_record_id: supplierRecordId,
        supplier: supplierName,
        behavior_record_id: behaviorRecordId,
        items: allItems,
        operator_open_id: operatorOpenId,
      };

      // 批量更新所有报单记录状态为"待确认"
      for (const rid of reportRecordIds) {
        await this.gateway.update('purchaseReport', rid, { status: '待确认', failureReason: '' }).catch(() => undefined);
      }

      await this.store.update(batchTaskId, { status: 'awaiting_confirmation', draft, batch_no: batchNo });
      await this.sendCard(operatorOpenId, purchaseRequestConfirmationCard(batchTaskId, draft));
      logInfo('purchase.batch.card.sent', { batch_no: batchNo, task_id: batchTaskId, record_count: reportRecordIds.length, item_count: allItems.length });
      return { status: 'awaiting_confirmation', batch_no: batchNo, item_count: allItems.length };
    } finally {
      this.activeBatches.delete(batchNo);
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

  /**
   * 决定采购入库的库存状态：
   * - 如果该编号（货号）下完全没有样品库存（不管哪个尺码），则先作为样品入库
   * - 如果该编号下已有任意尺码的样品库存，则作为门盒入库
   * 这和销售相反（销售先卖门盒，再卖样品）
   */
  async resolvePurchaseInboundState(productRecordId) {
    try {
      // 查询该编号下所有尺码的样品库存记录（不指定尺码）
      const allLiveRecords = await this.gateway.listAll('liveInventory');
      const table = this.gateway.table('liveInventory');
      const sampleRecords = allLiveRecords.filter((record) => {
        const productIds = Array.isArray(record.fields?.[table.fields.product])
          ? record.fields[table.fields.product].map((p) => p?.record_id || p?.id)
          : [];
        const state = record.fields?.[table.fields.state];
        return productIds.includes(productRecordId) && state === '样品';
      });
      return sampleRecords.length === 0 ? '样品' : '门盒';
    } catch (error) {
      logWarn('purchase.inbound.state_check.failed', { product_record_id: productRecordId, error: error.message });
      return '门盒'; // 查询失败时默认入门盒
    }
  }

  /**
   * 单条处理供应商报单（兼容没有报货批次号的旧数据）
   * 供应商从货品信息表的关联字段直接获取，不读报单表公式字段
   */
  async processSupplierReport(recordId, taskId) {
    const table = this.gateway.table('purchaseReport');
    const productTable = this.gateway.table('product');
    const record = await this.gateway.get('purchaseReport', recordId);
    const fields = record?.fields || {};
    const status = textValue(fields[table.fields.status]);
    if (['已生成申请', '已取消'].includes(status)) return { ignored: true, status };
    const description = textValue(fields[table.fields.description]);
    const detailId = textValue(fields[table.fields.detailId]);
    const productIds = linkedRecordIds(fields[table.fields.product]);
    if (productIds.length !== 1) throw new Error('供应商报单必须关联一个货品编号');
    const behaviorIds = linkedRecordIds(fields[table.fields.behavior]);
    // 从货品信息表的供应商关联字段直接获取供应商 record_id
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    if (productSupplierIds.length === 0) throw new Error('货品信息中未关联供应商，请先在货品信息中设置供应商');
    const supplierRecordId = productSupplierIds[0];
    const parsed = await this.recognizer.parsePurchaseReportText(description);
    const operatorOpenId = this.recordOperator(record, table.fields.operator);
    const draftId = taskId;
    const draft = {
      report_record_id: recordId,
      product_record_id: product.recordId,
      product_number: textValue(product.record?.fields?.[productTable.fields.number]),
      supplier_record_id: supplierRecordId,
      behavior_record_id: behaviorIds[0] || '',
      supplier: '',
      items: parsed.map((item) => ({ ...item, product_record_id: product.recordId, product_number: textValue(product.record?.fields?.[productTable.fields.number]), detail_id: detailId })),
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
      const unrecognized = [];
      for (const raw of recognized) {
        try {
          const product = await this.references.resolveProduct({ itemNo: raw.item_no, color: raw.color });
          actual.push({
            product_record_id: product.recordId,
            product_number: textValue(product.record?.fields?.[this.gateway.table('product').fields.number]),
            size: Number(raw.size),
            quantity: Number(raw.quantity || 1),
          });
        } catch (error) {
          unrecognized.push({ ...raw, error: error.message });
          logWarn('purchase.arrival.product_not_found', { record_id: recordId, item_no: raw.item_no, color: raw.color, size: raw.size, error: error.message });
        }
      }
      if (actual.length === 0) {
        throw new Error(`所有货品都识别失败：${unrecognized.map(u => `${u.item_no || ''}${u.color || ''}`).join('、')}`);
      }
      const groupedActual = aggregateArrivalItems(actual);
      const differences = this.compareArrival(requests, groupedActual, requestTable);
      const operatorOpenId = this.recordOperator(record, arrivalTable.fields.inspector);
      const draft = { arrival_record_id: recordId, batch_record_id: batchIds[0], batch_no: batchNo, operator_open_id: operatorOpenId, requests, actual: groupedActual, differences, unrecognized };
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别成功', confirmStatus: '待确认' });
      await this.store.update(taskId, { recognized, draft, status: 'awaiting_confirmation' });
      await this.sendCard(operatorOpenId, purchaseArrivalComparisonCard(taskId, draft));
      logInfo("purchase.arrival.card.sent", { record_id: recordId, task_id: taskId, item_count: actual.length, unrecognized_count: unrecognized.length, difference_count: differences.length });
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
      map.set(key(row.product_record_id, item.size), item);
    }
    return [...map.values()].map((item) => {
      const difference = item.actual - item.requested;
      return { ...item, label: difference === 0 ? '一致' : difference > 0 ? `多${difference}` : `少${Math.abs(difference)}` };
    });
  }


  /**
   * 更新采购消息卡片（类似销售的 updateSalesActionCard）
   */
  async updatePurchaseActionCard(task, event, card) {
    const messageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id;
    if (!messageId) {
      console.warn('lark.purchase.card.update.skipped', { task_id: task.task_id, reason: 'missing_message_id' });
      return false;
    }
    try {
      const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
      if (!patch) return false;
      const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== 0) throw new Error(response.msg + ' (Code: ' + response.code + ')');
      return true;
    } catch (error) {
      console.warn('lark.purchase.card.update.failed', { task_id: task.task_id, error: error.message });
      return false;
    }
  }

  async handleCardAction(value, operatorOpenId, event = {}) {
    const taskId = value?.draft_id;
    const action = value?.action;
    if (!taskId || !['confirm_purchase_request', 'cancel_purchase_request', 'confirm_purchase_arrival', 'cancel_purchase_arrival'].includes(action)) return null;
    const task = await this.store.get(taskId);
    if (!task?.draft) throw new Error('采购申请草稿不存在或已过期');
    if (task.draft.operator_open_id !== operatorOpenId) throw new Error('只能由原始填写人确认采购流程');
    if (action === 'cancel_purchase_arrival') {
      await this.gateway.update('purchaseArrival', task.draft.arrival_record_id, { confirmStatus: '已取消' });
      await this.store.update(taskId, { status: 'cancelled' });
      this.inflightInbound.delete(taskId);
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货已取消', '用户已取消本次采购到货。', 'grey'));
      return { toast: { type: 'info', content: '采购到货已取消' } };
    }
    if (action === 'confirm_purchase_arrival') {
      if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
      // 立即更新卡片为"处理中"状态，防止重复点击
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货处理中', '已收到确认，正在入库；请勿重复点击。', 'blue'));
      const result = await this.confirmArrival(taskId, task, operatorOpenId);
      // 处理完成后更新卡片为"已入库"状态
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货已入库', '入库完成，库存已更新。', 'green'));
      return result;
    }
    if (action === 'cancel_purchase_request') {
      // 支持批量和单条两种取消
      const reportIds = task.draft.report_record_ids || [task.draft.report_record_id];
      for (const rid of reportIds) {
        await this.gateway.update('purchaseReport', rid, { status: '已取消' }).catch(() => undefined);
      }
      await this.store.update(taskId, { status: 'cancelled' });
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购申请已取消', '用户已取消本次采购申请。', 'grey'));
      return { toast: { type: 'info', content: '采购申请已取消' } };
    }
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购申请已生成' } };
    // 立即更新卡片为"处理中"状态，防止重复点击
    await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购申请处理中', '已收到确认，正在生成采购申请；请勿重复点击。', 'blue'));
    return this.confirmPurchaseRequest(taskId, task, event);
  }

  /**
   * 确认生成采购申请（支持批量和单条）
   */
  async confirmPurchaseRequest(taskId, task, event = {}) {
    const draft = task.draft;
    const isBatch = draft.is_batch === true;
    const reportIds = isBatch ? draft.report_record_ids : [draft.report_record_id];
    const batchNo = draft.batch_no || (await this.nextBatchNo());
    // 创建报货批次记录
    const batch = await this.gateway.create('purchaseOrderBatch', {
      batchNo,
    });
    // 逐条创建采购申请
    const requestIds = [];
    for (const item of draft.items) {
      const request = await this.gateway.create('purchaseRequest', {
        batchNo: relation(batch.recordId),
        product: relation(item.product_record_id),
        size: item.size,
        quantity: item.quantity,
        behavior: relation(draft.behavior_record_id),
      });
      requestIds.push(request.recordId);
    }
    // 批量更新所有报单记录状态为"已生成申请"，并关联采购申请
    for (const rid of reportIds) {
      // 找出这条报单记录对应的采购申请（通过 report_record_id 匹配）
      const itemRequestIds = isBatch
        ? requestIds.filter((_, idx) => draft.items[idx]?.report_record_id === rid)
        : requestIds;
      await this.gateway.update('purchaseReport', rid, {
        status: '已生成申请',
        request: itemRequestIds.length > 0 ? itemRequestIds : requestIds,
      }).catch(() => undefined);
    }
    await this.store.update(taskId, { status: 'posted', batch_record_id: batch.recordId, batch_no: batchNo, request_ids: requestIds });
    logInfo('purchase.request.created', { task_id: taskId, batch_record_id: batch.recordId, batch_no: batchNo, request_count: requestIds.length, is_batch: isBatch });
    // 更新卡片为"已完成"状态
    await this.updatePurchaseActionCard(task, event, purchaseStatusCard({ ...draft, batch_no: batchNo }, '采购申请已生成', `报货批次号：${batchNo}；共 ${requestIds.length} 条明细已写入。`, 'green'));
    return { toast: { type: 'success', content: `采购申请已生成：${batchNo}（共${requestIds.length}条明细）` } };
  }

  async confirmArrival(taskId, task, operatorOpenId) {
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
    const arrival = task.draft;
    const requestTable = this.gateway.table('purchaseRequest');
    const inboundTable = this.gateway.table('purchaseInbound');
    if (!this.inflightInbound.has(taskId)) this.inflightInbound.set(taskId, new Map());
    const inflightMap = this.inflightInbound.get(taskId);
    const normalizeEntry = (value) => (typeof value === 'string' ? { recordId: value, inventoryApplied: false } : value);
    const persistedCreated = {};
    for (const [key, value] of Object.entries(task.draft?.inbound_created || {})) {
      persistedCreated[key] = normalizeEntry(value);
    }
    const existingByKey = new Map();
    for (const [key, value] of inflightMap) existingByKey.set(key, value);
    for (const [key, value] of Object.entries(persistedCreated)) {
      if (!existingByKey.has(key)) existingByKey.set(key, value);
    }
    const existingInbounds = await this.gateway.listAll('purchaseInbound');
    for (const record of existingInbounds) {
      const batchIds = linkedRecordIds(record.fields?.[inboundTable.fields.batch]);
      if (!batchIds.includes(arrival.arrival_record_id)) continue;
      const productId = linkedRecordIds(record.fields?.[inboundTable.fields.product])[0];
      const size = number(record.fields?.[inboundTable.fields.size]);
      const key = `${productId}|${size}`;
      if (productId && !existingByKey.has(key)) {
        existingByKey.set(key, { recordId: record.record_id, inventoryApplied: false });
      }
    }
    const persistEntry = async (key, entry) => {
      inflightMap.set(key, entry);
      persistedCreated[key] = entry;
      try {
        await this.store.update(taskId, { draft: { ...task.draft, inbound_created: persistedCreated } });
      } catch (error) {
        logWarn('purchase.arrival.inbound_created.persist_failed', { task_id: taskId, key, error: error.message });
      }
    };
    const created = [];
    for (const item of aggregateArrivalItems(arrival.actual || [])) {
      const key = `${item.product_record_id}|${item.size}`;
      // 决定入库状态：没有样品则入样品库，有样品则入门盒库
      const inboundState = await this.resolvePurchaseInboundState(item.product_record_id);
      const existing = existingByKey.get(key);
      if (existing) {
        created.push(existing.recordId);
        if (this.enablePurchaseInventory && !existing.inventoryApplied) {
          await this.inventory.applyPurchase({
            purchaseInboundRecordId: existing.recordId,
            productRecordId: item.product_record_id,
            size: item.size,
            quantity: item.quantity,
            occurredAt: Date.now(),
            state: inboundState,
          });
          existing.inventoryApplied = true;
          await persistEntry(key, existing);
        }
        continue;
      }
      const match = (arrival.differences || []).find(
        (row) => row.product_record_id === item.product_record_id && Number(row.size) === Number(item.size)
      );
      const inbound = await this.gateway.create('purchaseInbound', {
        product: relation(item.product_record_id),
        size: item.size,
        quantity: item.quantity,
        
        batch: relation(arrival.arrival_record_id),
        supplierOrder: match?.request_record_id ? relation(match.request_record_id) : undefined,
        inboundAt: Date.now(),
      });
      created.push(inbound.recordId);
      const entry = { recordId: inbound.recordId, inventoryApplied: false };
      await persistEntry(key, entry);
      if (this.enablePurchaseInventory) {
        await this.inventory.applyPurchase({
          purchaseInboundRecordId: inbound.recordId,
          productRecordId: item.product_record_id,
          size: item.size,
          quantity: item.quantity,
          occurredAt: Date.now(),
          state: inboundState,
        });
        entry.inventoryApplied = true;
        await persistEntry(key, entry);
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
    this.inflightInbound.delete(taskId);
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
