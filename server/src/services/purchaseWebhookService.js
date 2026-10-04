const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation, normalizeColor } = require('./v1ReferenceResolver');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { recordUrl } = require('../utils/feishuLinks');
const doubaoService = require('./doubaoService');
// 采购申请确认卡片（purchaseRequestConfirmationCard）**不再从这段链路发出**（免确认），
// 卡片本身仍留在 utils/larkCards 并且 handleCardAction 仍能处理它——
// 线上已经发出去的老卡片要能点得动，将来要回滚也只需要把 publishPurchaseRequest 换回发卡片。
const { purchaseArrivalDetailCard, purchaseStatusCard } = require('../utils/larkCards');
const { InventoryService } = require('./inventoryService');
const { buildPurchaseQuantities } = require('./purchaseQuantityPolicy');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');

// 采购卡片上可以触发副作用（写采购事实）的动作。
const PURCHASE_CARD_ACTIONS = [
  'confirm_purchase_request',
  'cancel_purchase_request',
  'confirm_purchase_arrival',
  'cancel_purchase_arrival',
];

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

/**
 * 飞书 SDK 抛错时 message 往往只有 "Request failed with status code 400"，
 * 真正有用的错误码和原因在 response.data 里（例如缺权限的 99991672）。
 * 出图/发图的失败只会写日志，所以日志必须带上这两个字段，否则线上排查只能靠猜。
 */
const larkErrorText = (error) => {
  const data = error?.response?.data;
  const code = data?.code ?? error?.code;
  const message = data?.msg || error?.message || 'unknown';
  return code ? `${message} (Code: ${code})` : message;
};

// 鞋盒/吊牌上的「品名」：女鞋 → B、男鞋 → A。单选选项就是 A/B 两个字。
// 识别不出性别就留空：默认成 A 会把女鞋写进男鞋，比空着更难发现。
const genderToCategory = (value) => {
  const label = String(value || '').trim();
  if (/女/.test(label)) return 'B';
  if (/男/.test(label)) return 'A';
  return '';
};

/**
 * 从货品记录里读「还缺哪些资料」。
 *
 * 「缺失信息说明」是飞书公式：齐备时返回「齐备」，否则返回缺的字段名（如「成本、品类」）。
 * 和销售侧 loadProductIndex 同一个思路——不自己逐字段判断，单一数据源留在表里。
 * 「样例图」是附件字段，不在公式里，要单独看有没有图。
 *
 * 公式刚建完记录时可能还没算出来，所以 readable 要区分「齐备」和「读不到」，
 * 读不到时只敢说"还没齐、去补"，不敢说"齐备"。
 */
const productInfoGaps = (record, productTable) => {
  const fields = record?.fields || {};
  const completeness = textValue(fields[productTable.fields.completeness]).trim();
  const sampleImages = fields[productTable.fields.sampleImage];
  return {
    missing: completeness && completeness !== '齐备'
      ? completeness.split('、').map((name) => name.trim()).filter(Boolean)
      : [],
    missingSampleImage: !(Array.isArray(sampleImages) && sampleImages.length > 0),
    completeness_readable: Boolean(completeness),
  };
};

// 记录链接只是给她点进去补资料用的：读不到 app token（本地/测试）时给不出链接，
// 但绝不能因此打断建档和入库——货已经在仓库里了。
const productRecordUrl = (tableId, recordId) => {
  let appToken = '';
  try { appToken = V1_BITABLE_SCHEMA.appToken; } catch { appToken = ''; }
  return recordUrl({ appToken, tableId, recordId });
};

class PurchaseWebhookService {
  constructor(options = {}) {
    this.client = options.client || (() => {
      const { appId, appSecret } = getLarkAgentCredentials();
      return new lark.Client({ appId, appSecret, logger: larkLogger });
    })();
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    // 「尺码」是指向「尺码管理」的关联字段，报单解析与到货比对都通过它换算。
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway, sizeReferences: options.sizeReferences,
    });
    this.recognizer = options.recognizer || doubaoService;
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    // 「明细 → PNG」。默认是 SVG+sharp 的真实实现；测试注入假实现就能断言
    // "每个供应商一张图"、"先发图后写表"，而不必在单测里真的跑一遍图形库。
    this.images = options.images || { render: renderPurchaseRequestPng };
    this.enablePurchaseInventory = true;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/purchase_webhook_tasks'),
      idField: 'task_id',
    });
    this.queues = new Map();
    // 卡片确认按 taskId 串行。重复的卡片事件（双击、飞书重投）会同时读到
    // awaiting_confirmation 并各自走一遍副作用，把同一批采购事实写两遍；
    // 卡片上的「处理中」只是 UX，后端必须自己保证同一任务不并行。
    this.confirmationQueue = new KeyedSerialQueue();
    this.batchReadMaxRetries = options.batchReadMaxRetries ?? 3;
    this.batchReadRetryDelay = options.batchReadRetryDelay ?? 1000;
    this.inflightInbound = new Map();
    // 批次聚合：按报货批次号聚合同一批次的多条报单明细
    this.batchQueues = new Map(); // key: 报货批次号, value: { recordIds: Set, timer, taskId }
    this.activeBatches = new Set(); // 正在处理的批次号，用于全局并发限制
    this.MAX_ACTIVE_BATCHES = options.maxActiveBatches ?? 3; // 全局最多同时处理3个批次
    this.BATCH_WAIT_MS = options.batchWaitMs ?? 30000; // 批次等待窗口30秒（最后一条到达后重置）
  }

  async parseReportQuantities(fields, reportTable) {
    const linkedSizes = await this.getSizeReferences().resolveLinkedCells(fields[reportTable.fields.size]);
    const recordIdBySize = new Map(linkedSizes.map((item) => [item.size, item.recordId]));
    const items = await buildPurchaseQuantities({
      selectedSizes: linkedSizes.map((item) => item.size),
      quantityDescription: textValue(fields[reportTable.fields.quantityDescription]),
      parseOverrides: (description, context) => this.recognizer.parsePurchaseReportText(description, context),
    });
    return items.map((item) => ({ ...item, size_record_id: recordIdBySize.get(item.size) }));
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
    // posting 也算「已经在处理」：确认动作正在写远端时，重复的 webhook 不能
    // 把任务降级回 processing 再解析一遍，那会重发确认卡片并丢掉恢复进度。
    if (existing && ['queued', 'processing', 'awaiting_confirmation', 'posting', 'posted', 'cancelled', 'batch_waiting'].includes(existing.status)) {
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
    // 免确认之后，采购申请一旦写成（posted）就是终态：重复投递的 webhook
    // （飞书重投、双击、两个请求几乎同时进来）不能再解析一遍、更不能把图再发一遍。
    // accept() 通常已经拦掉了，但并发到达的两次 accept 会各自入队，这里才是最终防线。
    if (kind === 'supplier-report' && task?.status === 'posted') {
      logInfo('purchase.webhook.posted_ignored', { record_id: recordId, task_id: taskId });
      return task;
    }
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
      // 采购报单免确认后没有「待确认」这个中间态了：写成功就是 posted。
      // 保持「已经写出的更靠后的状态不被覆盖回去」这个原则不变。
      let status = current?.status;
      if (!status || status === 'processing') {
        status = kind === 'supplier-report'
          ? (result?.ignored && result?.status === '已取消' ? 'cancelled' : 'posted')
          : 'awaiting_confirmation';
      }
      return this.store.update(taskId, { status, result });
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
      let behaviorRecordId = '';
      let operatorOpenId = '';
      const parseErrors = [];

      for (const record of batchRecords) {
        const fields = record?.fields || {};
        const status = textValue(fields[reportTable.fields.status]);
        if (['已生成申请', '已取消'].includes(status)) continue;
        reportRecordIds.push(record.record_id);
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
          // 供应商要记在**每一条明细**上，不能只记批次级的那一个：
          // 同一个报货批次里可能有好几个供应商，出图必须按供应商拆开，
          // 只留第一个的话第二家的货会被画进第一家的单子里。
          const itemSupplierId = productSupplierIds[0] || '';
          if (itemSupplierId) {
            if (!supplierRecordId) supplierRecordId = itemSupplierId;
            else if (supplierRecordId !== itemSupplierId) {
              logInfo('purchase.batch.multi_supplier', { batch_no: batchNo, record_id: record.record_id, supplier: itemSupplierId });
            }
          }
          const productInfo = this.productDisplayInfo(product.record, productTable);
          const parsed = await this.parseReportQuantities(fields, reportTable);
          for (const item of parsed) {
            allItems.push({
              ...item,
              product_record_id: product.recordId,
              product_number: productInfo.number,
              item_no: productInfo.itemNo,
              color: productInfo.color,
              supplier_record_id: itemSupplierId,
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
        behavior_record_id: behaviorRecordId,
        items: allItems,
        operator_open_id: operatorOpenId,
      };

      // 免确认：解析完直接写采购申请（不再发确认卡片、也不再写"待确认"）。
      // 报单记录的终态由 confirmPurchaseRequest 统一改成「已生成申请」。
      const updated = await this.store.update(batchTaskId, { draft, batch_no: batchNo });
      const result = await this.publishPurchaseRequest(batchTaskId, updated);
      logInfo('purchase.batch.posted', { batch_no: batchNo, task_id: batchTaskId, record_count: reportRecordIds.length, item_count: allItems.length });
      return { status: 'posted', batch_no: batchNo, item_count: allItems.length, request_count: result.request_ids?.length || 0 };
    } catch (error) {
      // 免确认之后批次任务自己就是终态的唯一负责人：这里不落状态的话，
      // 任务会永远停在 batch_waiting，重收 webhook 会被当成重复投递直接跳过，
      // 整批货就静默卡死了。失败要和单条路径一样能重试。
      await this.store.update(batchTaskId, { status: 'failed', error: error.message, batch_no: batchNo }).catch(() => undefined);
      for (const rid of recordIds) {
        await this.gateway.update('purchaseReport', rid, { status: '解析失败', failureReason: error.message }).catch(() => undefined);
      }
      throw error;
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
   * 货品记录里出图要用的三个展示字段。
   *
   * 「颜色」是关联字段，飞书在 link cell 里会带回被关联记录的主字段文本，
   * 所以 textValue 直接就能拿到颜色名，不需要再多查一次「颜色管理」。
   */
  productDisplayInfo(record, productTable) {
    const fields = record?.fields || {};
    return {
      number: textValue(fields[productTable.fields.number]),
      itemNo: textValue(fields[productTable.fields.itemNo]),
      color: textValue(fields[productTable.fields.color]),
    };
  }

  /**
   * 免确认生成采购申请。
   *
   * 产品负责人明确要求：报单解析完直接写「采购申请」，不再发确认卡片、不再等她点。
   * 理由是这批货本来就是她自己报的——「供应商报单」记录本身就是她的输入，
   * 再让她点一次「确认」只是重复劳动，还会因为忘了点让货卡住。
   *
   * ⚠️ 销售链路「未确认不写账」的红线**不受影响**：那条链路是她口述、AI 可能听错，
   * 必须由她核对后确认；采购这条是产品负责人单独定的口径，不要"顺手统一"。
   *
   * ⚠️ 幂等与回滚没有削弱：这里仍然走 confirmPurchaseRequest，
   * 也就是原来那套 posting_plan + createOnceByKey + 幂等键的写法，
   * 只是把"等卡片点确认"换成"解析完直接调用同一个确认函数"。
   * 要回滚成确认卡片，把这里换回 sendCard(purchaseRequestConfirmationCard(...)) 即可。
   */
  async publishPurchaseRequest(taskId, task) {
    // 免确认路径没有卡片消息可更新，明确跳过一次卡片 patch（否则会打无意义的告警日志）。
    return this.confirmPurchaseRequest(taskId, task, {}, { skipCardUpdate: true });
  }

  /**
   * 发送图片消息（飞书图片消息要先用 im.image 上传拿 image_key）。
   *
   * ⚠️ 上传图片用的是应用身份权限 im:resource:upload（或 im:resource）。
   * 没开通时这里会以 99991672 失败，日志里带上错误码，便于线上直接定位到权限问题。
   */
  async sendImage(openId, imageBuffer) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送图片');
    let upload;
    try {
      upload = await this.client.im.image.create({
        data: { image_type: 'message', image: imageBuffer },
      });
    } catch (error) {
      throw new Error(`上传采购申请图片失败：${larkErrorText(error)}`);
    }
    // SDK 会剥掉外层信封、把 image_key 放在顶层；保留 .data.image_key 兜底，
    // 免得将来换了 http 实现之后这里静默拿不到 key。
    const imageKey = upload?.image_key || upload?.data?.image_key;
    if (!imageKey) throw new Error('采购申请图片上传成功但未返回 image_key');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    });
    if (response.code !== 0) throw new Error(`发送采购申请图片失败: ${response.msg} (Code: ${response.code})`);
    return imageKey;
  }

  async sendText(openId, content) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送说明');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: content }) },
    });
    if (response.code !== 0) throw new Error(`发送采购申请说明失败: ${response.msg} (Code: ${response.code})`);
  }

  // 同一个供应商的明细合成一张图。没有供应商的明细（历史草稿）归到一组，
  // 宁可出一张"未标注供应商"的图，也不能拆成一人一张。
  groupItemsBySupplier(items) {
    const groups = new Map();
    (items || []).forEach((item, index) => {
      const supplierRecordId = item?.supplier_record_id || '';
      const key = supplierRecordId || '__unknown__';
      if (!groups.has(key)) groups.set(key, { supplierRecordId, items: [], indexes: [] });
      const group = groups.get(key);
      group.items.push(item);
      group.indexes.push(index);
    });
    return [...groups.values()];
  }

  async resolveSupplierName(supplierRecordId) {
    if (!supplierRecordId) return '';
    const table = this.gateway.table('supplier');
    const record = await this.gateway.get('supplier', supplierRecordId).catch(() => null);
    return textValue(record?.fields?.[table.fields.name]).trim();
  }

  /**
   * 采购申请写完之后：按供应商出图 → 发给报单人 → 写回「采购申请单」附件。
   *
   * ⚠️ 顺序是有意为之：**先发图，再写回附件**。
   * 她已经拿到图才能转发给供应商，附件只是留档；写回失败绝不能让她收不到图。
   * 因此附件写入的异常只记警告，绝不向上抛。
   *
   * 这个方法也绝不向上抛异常：调用它的时候采购事实已经落地，
   * 抛出去会让 process() 把任务判成 failed、把报单记录标成「解析失败」，
   * 她会以为这批货没报上，而实际上已经报上了。
   */
  async deliverSupplierImages(taskId, task, posting = {}) {
    try {
      return await this.deliverSupplierImagesInner(taskId, task, posting);
    } catch (error) {
      // 兜底：调用方是"采购事实已经写完"的收尾流程，这里漏出去的异常会把任务判成 failed。
      logError('purchase.request.image.delivery_failed', { task_id: taskId, error: error.message });
      return { sent: [], failed: [{ supplier: '', error: error.message }] };
    }
  }

  async deliverSupplierImagesInner(taskId, task, posting = {}) {
    const draft = task?.draft || {};
    const items = draft.items || [];
    if (!items.length) return { sent: [], failed: [] };
    const operatorOpenId = draft.operator_open_id;
    if (!operatorOpenId) {
      logWarn('purchase.request.image.no_operator', { task_id: taskId });
      return { sent: [], failed: [] };
    }
    const sent = [];
    const failed = [];
    for (const group of this.groupItemsBySupplier(items)) {
      const supplierName = await this.resolveSupplierName(group.supplierRecordId).catch(() => '');
      const label = supplierName || '未标注供应商';
      const rowCount = group.items.length;
      const totalPairs = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      let png;
      try {
        png = await this.images.render({
          supplierName,
          batchNo: posting.batch_no || draft.batch_no || '',
          items: group.items,
        });
        await this.sendImage(operatorOpenId, png);
        await this.sendText(operatorOpenId, `${label} 这批 ${rowCount} 条（共 ${totalPairs} 双），图可以直接转给供应商。`);
      } catch (error) {
        failed.push({ supplier: label, error: error.message });
        logError('purchase.request.image.send_failed', { task_id: taskId, supplier: label, error: error.message });
        // 图没发出去就不写附件：保持"先发图、再写回"的顺序，留下人工补发的余地。
        continue;
      }
      const requestRecordIds = group.indexes
        .map((index) => posting.request_id_by_item_key?.[`${taskId}:${index}`])
        .filter(Boolean);
      try {
        const written = await this.writeSupplierImageAttachment({
          taskId, supplierName: label, png, requestRecordIds,
        });
        if (written?.written) logInfo('purchase.request.image.attachment_written', { task_id: taskId, ...written });
      } catch (error) {
        // 只告警：她已经有图了。
        logWarn('purchase.request.image.attachment_write_failed', { task_id: taskId, supplier: label, error: error.message });
      }
      sent.push(label);
    }
    const summary = { sent, failed };
    if (failed.length) {
      // 图没发出去（例如机器人缺 im:resource 图片上传权限）时把失败留在任务里：
      // 采购事实已经写成、任务已是 posted，重收 webhook 会被当成重复投递跳过，
      // 所以必须留下这条记录，运维才知道哪一批图欠着、补完权限按 task 补发。
      await this.store.update(taskId, { image_delivery: { ...summary, at: new Date().toISOString() } })
        .catch((error) => logWarn('purchase.request.image.delivery_persist_failed', { task_id: taskId, error: error.message }));
    }
    return summary;
  }

  /**
   * 把某个供应商的采购申请图写进「采购申请」的附件字段。
   *
   * 规则（产品负责人明确给的）：
   * - 同一「报货批次」+ 同一「供应商」只写一条 → 写进「明细ID」最小的那条记录；
   * - 重复执行（重跑批次）不得写出第二条 → 目标记录已经有附件就跳过，连上传都不做。
   *
   * 为什么按「明细ID」而不是数组下标挑：明细ID 是飞书 auto_number，写入即定，
   * 而 posting_plan 的数组顺序、远端返回顺序在重试之后都可能变。
   */
  async writeSupplierImageAttachment({ taskId, supplierName, png, requestRecordIds }) {
    if (!requestRecordIds?.length) {
      logWarn('purchase.request.image.no_request_record', { task_id: taskId, supplier: supplierName });
      return { written: false, reason: 'no_request_record' };
    }
    if (typeof this.gateway.uploadAttachment !== 'function') {
      throw new Error('gateway 不支持附件上传（uploadAttachment）');
    }
    const requestTable = this.gateway.table('purchaseRequest');
    const candidates = [];
    for (const recordId of requestRecordIds) {
      const record = await this.gateway.get('purchaseRequest', recordId).catch(() => null);
      candidates.push({
        recordId,
        detailId: Number(textValue(record?.fields?.[requestTable.fields.detailId])) || 0,
        attachment: record?.fields?.[requestTable.fields.attachment],
      });
    }
    // 明细ID 读不到时（字段缺失/权限）退回按 recordId 排序：至少保证"每次选同一条"的稳定性。
    candidates.sort((a, b) => (a.detailId - b.detailId) || String(a.recordId).localeCompare(String(b.recordId)));
    const target = candidates[0];
    if (attachmentTokens(target.attachment).length) {
      logInfo('purchase.request.image.attachment_exists', { task_id: taskId, record_id: target.recordId });
      return { written: false, skipped: true, record_id: target.recordId };
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-request-image-'));
    try {
      const safeName = String(supplierName || 'supplier').replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'supplier';
      const filePath = path.join(tempDir, `${safeName}-采购申请.png`);
      await fs.promises.writeFile(filePath, png);
      const fileToken = await this.gateway.uploadAttachment(filePath);
      await this.gateway.update('purchaseRequest', target.recordId, { attachment: [{ file_token: fileToken }] });
      return { written: true, record_id: target.recordId, file_token: fileToken };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
        // 使用 linkedRecordIds 处理关联字段，兼容飞书API返回的多种格式
        const productIds = linkedRecordIds(record.fields?.[table.fields.product]);
        // 单选字段可能返回字符串或数组，统一处理
        const stateValue = record.fields?.[table.fields.state];
        const state = Array.isArray(stateValue) ? stateValue[0] : stateValue;
        return productIds.includes(productRecordId) && String(state) === '样品';
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
    const detailId = textValue(fields[table.fields.detailId]);
    const productIds = linkedRecordIds(fields[table.fields.product]);
    if (productIds.length !== 1) throw new Error('供应商报单必须关联一个货品编号');
    const behaviorIds = linkedRecordIds(fields[table.fields.behavior]);
    // 从货品信息表的供应商关联字段直接获取供应商 record_id
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    if (productSupplierIds.length === 0) throw new Error('货品信息中未关联供应商，请先在货品信息中设置供应商');
    const supplierRecordId = productSupplierIds[0];
    const parsed = await this.parseReportQuantities(fields, table);
    const operatorOpenId = this.recordOperator(record, table.fields.operator);
    const productInfo = this.productDisplayInfo(product.record, productTable);
    const items = parsed.map((item) => ({
      ...item,
      product_record_id: product.recordId,
      product_number: productInfo.number,
      // 货号/颜色单独带上：出图时「货号 | 颜色」是两列，
      // 「编号」是「货号+颜色」的拼接，不能拿来当货号用。
      item_no: productInfo.itemNo,
      color: productInfo.color,
      supplier_record_id: supplierRecordId,
      report_record_id: recordId,
      detail_id: detailId,
    }));
    const draft = {
      report_record_id: recordId,
      product_record_id: product.recordId,
      product_number: productInfo.number,
      supplier_record_id: supplierRecordId,
      behavior_record_id: behaviorIds[0] || '',
      items,
      operator_open_id: operatorOpenId,
    };
    // 免确认：不再写「待确认」、不再发确认卡片，解析完直接写采购申请。
    // 报单记录的处理状态终态由 confirmPurchaseRequest 改成「已生成申请」。
    const updated = await this.store.update(taskId, { draft });
    const result = await this.publishPurchaseRequest(taskId, updated);
    logInfo('purchase.report.posted', { record_id: recordId, task_id: taskId, item_count: parsed.length, request_count: result.request_ids?.length || 0 });
    return { status: 'posted', item_count: parsed.length };
  }

  /**
   * 到货明细 → 货品记录。
   *
   * 匹配不到货品时**自动建档**再返回新记录：货已经到了，不能因为资料没录就把它挡在门外
   * （产品负责人确认过的口径）。只填确定知道的字段，其余留空由她在飞书里补。
   *
   * 「货号对应多个颜色」这种歧义不走建档——那是识别抖动，建档只会造出重复货品。
   */
  async resolveArrivalProduct(raw, context) {
    try {
      const product = await this.references.resolveProduct({ itemNo: raw.item_no, color: raw.color });
      return { product, created: null };
    } catch (error) {
      if (error.code !== 'PRODUCT_NOT_FOUND') throw error;
      const created = await this.ensureArrivalProduct(raw, context);
      const productTable = this.gateway.table('product');
      return {
        created,
        product: {
          recordId: created.recordId,
          record: created.record || { record_id: created.recordId, fields: { [productTable.fields.itemNo]: raw.item_no } },
        },
      };
    }
  }

  /**
   * 建档进度落盘。
   *
   * 建档是远端写入，按项目约定必须把已经写出的 record_id 落盘：任务失败后重收 webhook
   * 会重跑一次到货解析，那时飞书列表可能还没读到刚建的货品，只靠"再查一遍"不足以防重复。
   */
  async persistArrivalCreation(context) {
    if (!context.taskId) return;
    try {
      await this.store.update(context.taskId, {
        arrival_created_products: context.createdLog,
        arrival_created_colors: context.createdColors,
      });
    } catch (error) {
      logWarn('purchase.arrival.created_product_persist_failed', { task_id: context.taskId, error: error.message });
    }
  }

  /**
   * 从已落盘的任务里恢复上一次的建档结果，重试时直接复用，不再重复建。
   */
  buildArrivalCreationContext(task) {
    const products = Array.isArray(task?.arrival_created_products) ? task.arrival_created_products : [];
    const colors = Array.isArray(task?.arrival_created_colors) ? task.arrival_created_colors : [];
    const context = {
      taskId: task?.task_id || '',
      productCache: new Map(),
      colorIndex: new Map(),
      createdColors: colors.map((item) => ({ ...item })),
      createdLog: products.map((item) => ({ ...item })),
      colorTableLoaded: false,
    };
    // 上次已经建好的颜色先占位：重试时同一个颜色名不会再建第二条。
    for (const item of context.createdColors) {
      if (item?.name) context.colorIndex.set(normalizeColor(item.name), item.color_record_id);
    }
    for (const item of context.createdLog) {
      context.productCache.set(`${item.item_no}|${item.color}`, {
        is_new: true,
        recordId: item.product_record_id,
        record: null,
        item_no: item.item_no,
        color: item.color,
        supplier: item.supplier || '',
        label: `${item.item_no}${item.color}`,
        color_created: Boolean(item.color_created),
        gaps: null,
      });
    }
    return context;
  }

  /**
   * 按颜色名找「颜色管理」的记录，找不到就新建一条并记下来。
   *
   * 颜色表是**共享主数据**：OCR 抖一下（「棕色」/「棕」）就多建一条，以后同一个颜色
   * 会散成好几条，所以比对用 normalizeColor（去空白、去末尾「色」），
   * 并且整张表只读一次、同一次到货里同名颜色只建一条。
   */
  async ensureArrivalColor(color, context) {
    const colorTable = this.gateway.table('color');
    if (!context.colorTableLoaded) {
      for (const record of await this.gateway.listAll('color')) {
        const name = normalizeColor(textValue(record?.fields?.[colorTable.fields.name]));
        if (name && !context.colorIndex.has(name)) context.colorIndex.set(name, record.record_id);
      }
      context.colorTableLoaded = true;
    }
    const key = normalizeColor(color);
    if (context.colorIndex.has(key)) return { recordId: context.colorIndex.get(key), created: false };

    const created = await this.gateway.create('color', { name: color });
    const recordId = created?.recordId || '';
    if (!recordId) throw new Error(`颜色「${color}」新建失败`);
    context.colorIndex.set(key, recordId);
    context.createdColors.push({ name: color, color_record_id: recordId });
    await this.persistArrivalCreation(context);
    logInfo('purchase.arrival.color_created', { color, color_record_id: recordId });
    return { recordId, created: true };
  }

  /**
   * 给识别到的新品建一条「货品信息」，然后原样返回新记录。
   *
   * 只写确定知道的字段：货号、颜色（关联）、供应商（关联，找不到就留空）、类别（A/B，认不出就留空）。
   * 刻意不写「编号」「货品状态」「缺失信息说明」——这三个在飞书里是公式字段，
   * 写进去会直接 FieldNameNotFound，而且它们的值本来就该由表自己算。
   */
  async ensureArrivalProduct(raw, context) {
    const itemNo = String(raw.item_no || '').trim();
    const color = String(raw.color || '').trim();
    const cacheKey = `${itemNo}|${color}`;
    const cached = context.productCache.get(cacheKey);
    // 同一个「货号+颜色」在一次到货里会有多个尺码：复用第一条建好的记录（含上次重试建的），
    // 不要再建第二条。
    if (cached) {
      // 从上次重试恢复出来的条目还没有回读数据，补一次即可说明"还差什么"。
      if (!cached.gaps) {
        cached.record = (await this.gateway.get('product', cached.recordId).catch(() => null)) || cached.record;
        cached.gaps = productInfoGaps(cached.record, this.gateway.table('product'));
      }
      return { ...cached };
    }

    const productTable = this.gateway.table('product');
    const values = { itemNo };
    if (color) values.color = relation((await this.ensureArrivalColor(color, context)).recordId);

    // 供应商也只在识别到名字、且供应商表里确实有这条时才关联；找不到留空，不新建、不猜。
    const supplierName = String(raw.supplier || '').trim();
    if (supplierName) {
      try {
        const supplier = await this.references.resolveSupplier(supplierName);
        if (supplier?.recordId) values.supplier = relation(supplier.recordId);
      } catch (error) {
        logWarn('purchase.arrival.supplier_not_found', { item_no: itemNo, supplier: supplierName, error: error.message });
      }
    }
    const category = genderToCategory(raw.gender || raw.category);
    if (category) values.category = category;

    const created = await this.gateway.create('product', values);
    const recordId = created?.recordId || created?.record_id || '';
    if (!recordId) throw new Error(`新品建档失败：${itemNo}${color}`);

    const entry = {
      is_new: true,
      recordId,
      record: created?.record || null,
      item_no: itemNo,
      color,
      supplier: supplierName,
      label: `${itemNo}${color}`,
      color_created: context.createdColors.some((item) => normalizeColor(item.name) === normalizeColor(color)),
      gaps: null,
    };
    context.productCache.set(cacheKey, entry);
    context.createdLog.push({
      item_no: itemNo, color, product_record_id: recordId, supplier: supplierName, color_created: entry.color_created,
    });
    // 先落盘再回读：哪怕回读或后续步骤失败，重试也能凭这条记录跳过重复建档。
    await this.persistArrivalCreation(context);

    // 建档后回读一次：公式（缺失信息说明）是飞书算的，创建响应里通常还没有值。
    // 回读失败不影响入库，只是这张卡片少说了"还差什么"。
    try {
      entry.record = (await this.gateway.get('product', recordId)) || entry.record;
    } catch (error) {
      logWarn('purchase.arrival.created_product_readback_failed', { product_record_id: recordId, error: error.message });
    }
    entry.gaps = productInfoGaps(entry.record, productTable);
    logInfo('purchase.arrival.product_created', {
      item_no: itemNo, color, product_record_id: recordId, color_created: entry.color_created,
      missing: entry.gaps.missing, missing_sample_image: entry.gaps.missingSampleImage,
    });
    return entry;
  }

  /**
   * 解析采购到货记录。
   *
   * 「类型」决定用哪种识别：
   * - 到货单：供应商出库单/送货单的表格照片，一张图里有很多「款号×颜色×尺码」
   * - 其它（含空值、鞋盒）：一张张鞋盒照片。空值按鞋盒处理——这个单选字段是后来加的，
   *   历史记录没有值，不能因此把它们判成失败
   *
   * 两条识别路径的输出同构（item_no / color / size / quantity 明细），
   * 所以「匹配货品 → 与申请比对 → 草稿 → 卡片确认」的后续流程完全共用。
   */
  async processArrival(recordId, taskId) {
    const table = this.gateway.table('purchaseArrival');
    const record = await this.gateway.get('purchaseArrival', recordId);
    const fields = record?.fields || {};
    const currentStatus = textValue(fields[table.fields.confirmStatus]);
    if (['已确认', '已入库', '已取消'].includes(currentStatus)) return { ignored: true, status: currentStatus };
    await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别中', failureReason: '' });
    const isDocument = textValue(fields[table.fields.type]).trim() === '到货单';
    const tokens = attachmentTokens(fields[table.fields.images]);
    if (!tokens.length) {
      throw new Error(isDocument ? '采购到货记录没有到货单图片附件' : '采购到货记录没有鞋盒图片附件');
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-arrival-'));
    try {
      const recognized = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const filePath = path.join(tempDir, `${index + 1}.jpg`);
        const media = await this.client.drive.media.download({ path: { file_token: tokens[index] } });
        await media.writeFile(filePath);
        recognized.push(...await (isDocument
          ? this.recognizer.recognizePurchaseDocument(filePath)
          : this.recognizer.recognizeLabels(filePath, 'purchase')));
      }
      if (!recognized.length) throw new Error(isDocument ? '到货单上没有识别到任何明细' : '图片上没有识别到任何鞋盒');
      const arrivalTable = this.gateway.table('purchaseArrival');
      const batchIds = linkedRecordIds(fields[arrivalTable.fields.batch]);
      // 业务上存在「供应商直接送货、没有先走采购申请」的到货，这种记录不会选报货批次号。
      // 没有批次号就不再报错，也不和申请比对——全部按实际到货入库，草稿里标记 direct_arrival，
      // 卡片上写清楚"无申请直接到货"，免得她以为系统漏比对了。
      // 选了多个批次号仍然是配置错误：无法判断该拿哪一批的申请来比对。
      if (batchIds.length > 1) throw new Error('采购到货只能选择一个报货批次号');
      const directArrival = batchIds.length === 0;
      const requestTable = this.gateway.table('purchaseRequest');
      let batchNo = '';
      let requests = [];
      if (!directArrival) {
        if (!this.gateway.table('purchaseOrderBatch').tableId) throw new Error('未配置报货批次表ID：FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID');
        const batch = await this.gateway.get('purchaseOrderBatch', batchIds[0]);
        const batchTable = this.gateway.table('purchaseOrderBatch');
        batchNo = textValue(batch?.fields?.[batchTable.fields.batchNo]);
        requests = (await this.gateway.listAll('purchaseRequest')).filter(
          (item) => linkedRecordIds(item.fields?.[requestTable.fields.batchNo]).includes(batchIds[0])
        );
      }
      const actual = [];
      const unrecognized = [];
      const supplierNameCache = {};
      const productTable = this.gateway.table('product');
      const supplierTable = this.gateway.table('supplier');
      // 新品建档的共享状态：同一次到货里同一个「货号+颜色」只建一条货品，同名颜色只建一条颜色。
      // 上一次重试已经建过的记录从这里恢复，不会再建第二条。
      const creationContext = this.buildArrivalCreationContext(await this.store.get(taskId));
      for (const raw of recognized) {
        try {
          const resolved = await this.resolveArrivalProduct(raw, creationContext);
          const { product } = resolved;
          // 从货品信息表关联获取供应商名称
          const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
          let supplierName = raw.supplier || '';
          if (productSupplierIds.length > 0) {
            const supplierId = productSupplierIds[0];
            if (!supplierNameCache[supplierId]) {
              const supplierRecord = await this.gateway.get('supplier', supplierId);
              supplierNameCache[supplierId] = textValue(supplierRecord?.fields?.[supplierTable.fields.name]);
            }
            supplierName = supplierNameCache[supplierId] || supplierName;
          }
          actual.push({
            product_record_id: product.recordId,
            // 新品刚建档时「编号」公式可能还没算出来，先用「货号+颜色」把明细显示出来。
            product_number: textValue(product.record?.fields?.[productTable.fields.number]) || (resolved.created?.label || ''),
            item_no: raw.item_no,
            color: raw.color,
            size: Number(raw.size),
            quantity: Number(raw.quantity || 1),
            supplier: supplierName,
            // 草稿里记下哪些是刚建档的新品，卡片据此单独讲清楚。
            created_product: Boolean(resolved.created),
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
      // 新品清单直接从建档缓存里取：同一次到货里同一「货号+颜色」的多个尺码只算一个新品，
      // 上一次重试已经建好的也算在内（卡片上仍要告诉她这批有新品、还差什么）。
      const createdProducts = [...creationContext.productCache.values()];
      // 恢复出来的条目（这次识别里已经不再出现）没有回读数据：缺口按"读不到"处理，
      // 仍然告诉她有这么个新品，但不敢说资料齐备。
      for (const entry of createdProducts) {
        if (!entry.gaps) entry.gaps = productInfoGaps(entry.record, productTable);
      }
      // 直接到货没有申请可比：不生成差异行，否则每一行都会被算成「多N」，反而误导她。
      const differences = directArrival ? [] : await this.compareArrival(requests, groupedActual, requestTable);
      const operatorOpenId = this.recordOperator(record, arrivalTable.fields.inspector);
      const draft = {
        arrival_record_id: recordId,
        direct_arrival: directArrival,
        batch_record_id: batchIds[0] || '',
        batch_no: batchNo,
        operator_open_id: operatorOpenId, requests, actual: groupedActual, differences, unrecognized,
        // 新品自动建档的结果：卡片要告诉她建了哪些、颜色表补了哪条、还差什么、去哪补。
        created_products: createdProducts.map((entry) => ({
          product_record_id: entry.recordId,
          item_no: entry.item_no,
          color: entry.color,
          supplier: entry.supplier,
          label: entry.label,
          color_created: entry.color_created,
          missing: entry.gaps.missing,
          missing_sample_image: entry.gaps.missingSampleImage,
          completeness_readable: entry.gaps.completeness_readable,
          url: productRecordUrl(productTable.tableId, entry.recordId),
        })),
        created_colors: creationContext.createdColors.map((item) => item.name),
      };
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别成功', confirmStatus: '待确认' });
      await this.store.update(taskId, { recognized, draft, status: 'awaiting_confirmation' });
      await this.sendCard(operatorOpenId, purchaseArrivalDetailCard(taskId, draft));
      logInfo("purchase.arrival.card.sent", { record_id: recordId, task_id: taskId, direct_arrival: directArrival, arrival_type: isDocument ? '到货单' : '鞋盒', item_count: actual.length, unrecognized_count: unrecognized.length, difference_count: differences.length, created_product_count: createdProducts.length, created_color_count: creationContext.createdColors.length });
      return { status: 'awaiting_confirmation', item_count: actual.length, difference_count: differences.length, created_product_count: createdProducts.length };
    } catch (error) {
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别失败', failureReason: error.message }).catch(() => undefined);
      logWarn('purchase.arrival.recognition.failed', { record_id: recordId, task_id: taskId, error: error.message });
      throw error;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async compareArrival(requests, actual, requestTable) {
    const map = new Map();
    const key = (productId, size) => `${productId}|${size}`;
    for (const row of requests) {
      const productId = linkedRecordIds(row.fields?.[requestTable.fields.product])[0];
      if (!productId) continue;
      const resolvedSize = await this.getSizeReferences().resolveLinkedCell(row.fields?.[requestTable.fields.size]);
      const item = map.get(key(productId, resolvedSize.size)) || {
        product_record_id: productId,
        size: resolvedSize.size,
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
    if (!taskId || !PURCHASE_CARD_ACTIONS.includes(action)) return null;
    // 同一个 taskId 的确认/取消串行执行：第二个请求要等第一个结束后重新读任务，
    // 才能看到 posted 而不是又走一遍创建。
    return this.confirmationQueue.run(taskId, () =>
      this.handleCardActionLocked(taskId, action, operatorOpenId, event));
  }

  async handleCardActionLocked(taskId, action, operatorOpenId, event) {
    // 排队结束后重新读取：锁外读到的 task 可能已经被前一个动作改过状态，
    // 拿旧对象判断状态正是并发重复写入的来源。
    const task = await this.store.get(taskId);
    if (!task?.draft) throw new Error('采购申请草稿不存在或已过期');
    if (task.draft.operator_open_id !== operatorOpenId) throw new Error('只能由原始填写人确认采购流程');
    if (task.status === 'cancelled') return { toast: { type: 'info', content: '本次采购流程已取消' } };
    if (action === 'cancel_purchase_arrival') {
      if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库，不能取消' } };
      await this.gateway.update('purchaseArrival', task.draft.arrival_record_id, { confirmStatus: '已取消' });
      await this.store.update(taskId, { status: 'cancelled' });
      this.inflightInbound.delete(taskId);
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货已取消', '用户已取消本次采购到货。', 'grey'));
      return { toast: { type: 'info', content: '采购到货已取消' } };
    }
    if (action === 'confirm_purchase_arrival') {
      if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
      // 正式写库前先落 posting：崩溃后重进这个流程会按已持久化的进度恢复，
      // 而不是因为「看到 posting 就一直提示处理中」卡死。
      await this.store.update(taskId, { status: 'posting' });
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货处理中', '已收到确认，正在入库；请勿重复点击。', 'blue'));
      let result;
      try {
        result = await this.confirmArrival(taskId, task, operatorOpenId);
      } catch (error) {
        await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货未完成', `已停止自动处理：${error.message}`, 'red'));
        throw error;
      }
      // 处理完成后更新卡片为"已入库"状态
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购到货已入库', '入库完成，库存已更新。', 'green'));
      return result;
    }
    if (action === 'cancel_purchase_request') {
      if (task.status === 'posted') return { toast: { type: 'info', content: '采购申请已生成，不能取消' } };
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
    await this.store.update(taskId, { status: 'posting' });
    await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购申请处理中', '已收到确认，正在生成采购申请；请勿重复点击。', 'blue'));
    try {
      return await this.confirmPurchaseRequest(taskId, task, event);
    } catch (error) {
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(task.draft, '采购申请未完成', `已停止自动处理：${error.message}`, 'red'));
      throw error;
    }
  }

  /**
   * 生成并持久化 Posting Plan。
   *
   * 这个计划有两个作用，缺一不可：
   * 1. 幂等键的唯一来源——重试时必须复用同一批键，每次重新生成等于没有幂等；
   * 2. 崩溃后的恢复清单——知道「应该写几条、写到哪一条」。
   *
   * 所以它必须在任何远端写入之前落盘；落盘失败就不能开始写。
   */
  async ensurePostingPlan(taskId, task) {
    if (task.posting_plan?.version === 1) return task.posting_plan;
    const draft = task.draft || {};
    const items = draft.items || [];
    if (!items.length) throw new Error('采购申请草稿没有任何明细，无法生成采购计划');
    const plan = {
      version: 1,
      batch_key: `purchase_batch:${taskId}`,
      // 批次号也只生成一次：重试时重新取号会变成一个已存在批次的新号。
      batch_no: draft.batch_no || (await this.nextBatchNo()),
      items: items.map((item, index) => ({
        // item_key 是「计划里第几条」的稳定标识，随计划一起持久化，
        // 因此重试时不会因为数组顺序变化而换键。
        item_key: `${taskId}:${index}`,
        request_key: `purchase_request:${taskId}:${index}`,
        report_record_id: item.report_record_id || draft.report_record_id || '',
        product_record_id: item.product_record_id,
        size: Number(item.size),
        quantity: Number(item.quantity),
        behavior_record_id: draft.behavior_record_id || '',
      })),
    };
    const updated = await this.store.update(taskId, { posting_plan: plan, posting_stage: 'posting_plan_created' });
    return updated.posting_plan;
  }

  /**
   * 确认生成采购申请（支持批量和单条）。
   *
   * 每一步都遵循「先按幂等键回查远端，再决定是否创建」，并在创建后立刻把
   * record_id 写回 posting_progress。这样无论是「远端已建、本地没记」还是
   * 「本地记了、进程重启」，重试都只会补齐缺的那部分。
   *
   * options.skipCardUpdate：免确认路径没有卡片消息可更新，跳过那次 patch。
   */
  async confirmPurchaseRequest(taskId, task, event = {}, options = {}) {
    const draft = task.draft;
    const isBatch = draft.is_batch === true;
    const plan = await this.ensurePostingPlan(taskId, task);
    const progress = { ...(task.posting_progress || {}) };
    const requestIdByItemKey = { ...(progress.requests || {}) };

    // 报货批次：批次号与幂等键都来自已落盘的计划。
    let batchRecordId = progress.batch_record_id;
    if (!batchRecordId) {
      const batch = await createOnceByKey({
        gateway: this.gateway,
        tableKey: 'purchaseOrderBatch',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: plan.batch_key,
        label: '报货批次',
        values: { batchNo: plan.batch_no, idempotencyKey: plan.batch_key },
      });
      batchRecordId = batch.recordId;
      progress.batch_record_id = batchRecordId;
      await this.store.update(taskId, { posting_progress: progress, posting_stage: 'batch_created' });
    }

    // 逐条创建采购申请
    const requestIds = [];
    for (const item of plan.items) {
      let recordId = requestIdByItemKey[item.item_key];
      if (!recordId) {
        const sizeReference = await this.getSizeReferences().resolveByNumber(item.size);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'purchaseRequest',
          keyField: IDEMPOTENCY_KEY_FIELD,
          keyValue: item.request_key,
          label: `采购申请 ${item.item_key}`,
          values: {
            batchNo: relation(batchRecordId),
            product: relation(item.product_record_id),
            size: relation(sizeReference.recordId),
            quantity: item.quantity,
            behavior: relation(item.behavior_record_id),
            idempotencyKey: item.request_key,
          },
        });
        recordId = created.recordId;
        requestIdByItemKey[item.item_key] = recordId;
        progress.requests = requestIdByItemKey;
        await this.store.update(taskId, {
          posting_progress: progress,
          posting_stage: `request_created:${item.item_key}`,
        });
      }
      requestIds.push(recordId);
    }

    // 批量更新所有报单记录状态为"已生成申请"，并关联采购申请
    const reportIds = isBatch ? (draft.report_record_ids || []) : [draft.report_record_id];
    for (const rid of reportIds) {
      // 找出这条报单记录对应的采购申请：对应关系来自计划，不再依赖临时数组下标。
      const itemRequestIds = plan.items
        .filter((item) => item.report_record_id === rid)
        .map((item) => requestIdByItemKey[item.item_key])
        .filter(Boolean);
      await this.gateway.update('purchaseReport', rid, {
        status: '已生成申请',
        request: itemRequestIds.length > 0 ? itemRequestIds : requestIds,
      }).catch(() => undefined);
    }
    progress.reports_linked = true;
    await this.store.update(taskId, {
      status: 'posted',
      posting_progress: progress,
      posting_stage: 'posted',
      batch_record_id: batchRecordId,
      batch_no: plan.batch_no,
      request_ids: requestIds,
    });
    logInfo('purchase.request.created', { task_id: taskId, batch_record_id: batchRecordId, batch_no: plan.batch_no, request_count: requestIds.length, is_batch: isBatch });
    const posting = {
      request_ids: requestIds,
      request_id_by_item_key: requestIdByItemKey,
      batch_record_id: batchRecordId,
      batch_no: plan.batch_no,
    };
    // 采购事实已经落地之后的收尾动作：按供应商出图 → 发给她 → 写回附件。
    // 现场出图失败也只记日志（方法内部已吞异常），绝不把任务判成失败。
    await this.deliverSupplierImages(taskId, task, posting);
    // 更新卡片为"已完成"状态（免确认路径没有卡片，跳过）
    if (!options.skipCardUpdate) {
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard({ ...draft, batch_no: plan.batch_no }, '采购申请已生成', `报货批次号：${plan.batch_no}；共 ${requestIds.length} 条明细已写入。`, 'green'));
    }
    return { toast: { type: 'success', content: `采购申请已生成：${plan.batch_no}（共${requestIds.length}条明细）` }, ...posting };
  }

  async confirmArrival(taskId, task, operatorOpenId) {
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
    const arrival = task.draft;
    const requestTable = this.gateway.table('purchaseRequest');
    const inboundTable = this.gateway.table('purchaseInbound');
    // 查询"采购入库"行为的 record_id（采购行为是关联字段，不能直接传字符串）
    const behaviorTable = this.gateway.table('behavior');
    const behaviorMatches = (await this.gateway.listAll('behavior')).filter(
      (record) => textValue(record.fields?.[behaviorTable.fields.name]).trim() === '采购入库'
    );
    if (behaviorMatches.length !== 1) throw new Error('行为管理中"采购入库"必须且只能有一条记录');
    const purchaseInboundBehaviorId = behaviorMatches[0].record_id;
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
      const size = (await this.getSizeReferences().resolveLinkedCell(record.fields?.[inboundTable.fields.size])).size;
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
        size: relation((await this.getSizeReferences().resolveByNumber(item.size)).recordId),
        quantity: item.quantity,
        behavior: relation(purchaseInboundBehaviorId),
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
      const size = (await this.getSizeReferences().resolveLinkedCell(request.fields?.[requestTable.fields.size])).size;
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
