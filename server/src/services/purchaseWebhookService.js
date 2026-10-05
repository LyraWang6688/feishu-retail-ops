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
// 「到齐」判据（Σ双数 >= 合计数量）：批次到齐才写采购申请，未到齐什么都不做。
const { evaluateReportCompleteness } = require('./reportCompletenessPolicy');
const { buildArrivalCostPlan, isBlankCost, costValueOf } = require('./arrivalCostPolicy');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { withTimeout, withTimeoutProxy } = require('../utils/withTimeout');
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

// 「识别失败原因」这一列是写给验收人看的，不是给日志看的：只能是一句短的人话。
// 原文太长（贴一段模型返回或 axios 堆栈）她看不懂，也就不看了。
const humanizeArrivalFailure = (error) => {
  const message = String(error?.message || '未知错误');
  // 超时有好几种长相：我们自己包的 TimeoutError（"…超时"）、axios（ETIMEDOUT /
  // ECONNABORTED）、OpenAI SDK 自己的 APIConnectionTimeoutError（"Request timed out."）。
  // 都得归到同一句人话上，否则用户会看到一列英文。
  if (error?.name === 'TimeoutError' || error?.name === 'APIConnectionTimeoutError' ||
    error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED' ||
    /超时|timed?\s*out/i.test(message)) {
    return '识别超时';
  }
  if (/没有.*(图片|附件)/.test(message)) return '没读到图片';
  if (/识别不到|没有识别到/.test(message)) return '图片里没识别到明细';
  if (/只能选择一个报货批次号/.test(message)) return '报货批次号选多了';
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
};

// 失败提示说人话、给出下一步动作：只告诉她「失败了」等于把问题丢回给她。
const arrivalFailureNotice = (reason) =>
  `到货图片识别没成功（${reason}），请重传一次图片，或直接在记录里手工填写～`;

// 收到就开始处理时先回一句。识别（尤其是模型那一步）可能要几十秒到几分钟，
// 这段时间她看不到任何反馈，会以为系统卡死——2026-10-05 的线上反馈就是这样。
const ARRIVAL_RECEIVED_NOTICE = '收到到货申请，正在识别图片～';

// ── 「未到齐」告警 ────────────────────────────────────────────────────────────
// 产品负责人定的判据要「说人话」：她填的是这一批一共几双，我们只收到了几双，
// 所以她需要的是一句「你说 5 双，我只收到 3 双」＋一个下一步动作，
// 而不是一行「completeness check failed」。文案里不出现任何内部术语。
const defaultReportIncompleteMessage = ({ declaredTotal, receivedQuantity, batchNo }) =>
  `报货批次 ${batchNo}：你说这一批 ${declaredTotal} 双，我只收到 ${receivedQuantity} 双 —— ` +
  '是不是还有明细没提交？把剩下的明细补上，我就把采购申请一起生成～';

// 「报单时间」是飞书 datetime 字段，API 返回的是**毫秒时间戳**；但导出/测试里
// 也可能是 'yyyy/MM/dd HH:mm' 这类字符串。两种都认，认不出返回 0 由调用方兜底。
const parseReportedAt = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
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
    // 对外调用的超时（毫秒）。为什么每个都要有：见 utils/withTimeout.js 的文件头——
    // 到货链路 2026-10-05 就是写完「识别中」之后永远等不到任何一个 await 返回。
    // 0 表示不设超时，只有极少数测试会这么用。
    this.mediaTimeoutMs = options.mediaTimeoutMs ?? 30_000; // 下载附件：101KB 的图正常 0.3 秒
    this.recognitionTimeoutMs = options.recognitionTimeoutMs ?? 60_000; // 模型识别
    this.imTimeoutMs = options.imTimeoutMs ?? 15_000; // 飞书消息
    // 失败态写入本身也可能失败，写不出去就等于记录永远停在「识别中」，所以重试几次。
    this.failureWriteAttempts = options.failureWriteAttempts ?? 3;
    this.failureWriteRetryDelayMs = options.failureWriteRetryDelayMs ?? 200;
    this.gatewayTimeoutMs = options.gatewayTimeoutMs ?? 60_000;
    // 本服务里所有 gateway 调用都套上超时。这里包的是本服务持有的引用，
    // 不影响别的服务（生产上 LarkMvpService 跟销售链路共用的是另一个引用）。
    this.gateway = withTimeoutProxy(options.gateway || new V1BitableGateway({ client: this.client }), {
      timeoutMs: this.gatewayTimeoutMs,
      prefix: 'gateway.',
    });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    // 注入进来的 references（生产上它内部拿的是没包超时的 gateway）也要包一层：
    // 到货逐行匹配货品时它每次都会全表扫一遍，是这一步里最容易挂住的地方。
    // 没注入时 this.references 已经基于包过超时的 gateway，不必再包。
    this.arrivalReferences = options.references
      ? withTimeoutProxy(this.references, { timeoutMs: this.gatewayTimeoutMs, prefix: 'references.' })
      : this.references;
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
    // ── 批次处理（「到齐」判据，不再是 30 秒窗口）──────────────────────────────
    // inflightBatches：同一批次号的**串行锁**。重复投递、并发到达时，
    // 第二个请求直接返回，不重入（幂等的第一道防线，第二道是下面 record 级的
    // 状态判断与采购申请的幂等键）。
    this.inflightBatches = new Set();
    // 未到齐的批次在这里挂号：到点（默认 5 分钟）仍未到齐就给她发一条人话告警。
    // value: { dueAt, timer }。只在真有「未到齐」的批次时才存在定时器——没活时
    // 不查表，常驻心跳的开销是 0。
    this.pendingReportAlerts = new Map();
    this.reportAlertDelayMs = options.reportAlertDelayMs ?? 5 * 60 * 1000; // 产品负责人定的 5 分钟
    // 测试开关：只「挂号」不装定时器，由用例自己调 sweepBatchAlerts 决定什么时候到点。
    this.disableBatchAlertTimers = options.disableBatchAlertTimers ?? false;
    // 进程重启后从表里的「报单时间」重建告警（内存里的 timer 随重启消失）。
    // ⚠️ 默认开启：产品负责人的要求里「重启不能丢」是硬要求，所以这是一条正常启动路径，
    // 不走开关；读表失败只记一条 warn，不影响服务其余部分。测试默认关掉
    //（options.enableReportAlertBootstrap = false），免得每个用例都多做一次后台读表。
    this.enableReportAlertBootstrap = options.enableReportAlertBootstrap ?? true;
    // 测试开关：不让 bootstrap 在测试进程里做后台 I/O。
    this.disableReportAlertBootstrap = options.disableReportAlertBootstrap ?? false;
    // 实例级告警文案（测试可以换成短句，不必断言整段中文）。
    this.buildReportIncompleteMessage = options.buildReportIncompleteMessage || defaultReportIncompleteMessage;
    if (this.enableReportAlertBootstrap && !this.disableReportAlertBootstrap) {
      // queueMicrotask 而不是 setImmediate：读表是异步的，放到当前同步栈之后就行，
      // 不需要等一个完整的 event-loop 轮次（否则构造函数刚返回时读到的还是"没挂号"）。
      queueMicrotask(() => {
        this.bootstrapReportAlerts().catch((error) => {
          logWarn('purchase.report.alert.bootstrap_failed', { error: error.message });
        });
      });
    }
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
    if (existing && ['queued', 'processing', 'awaiting_confirmation', 'posting', 'posted', 'cancelled'].includes(existing.status)) {
      logInfo('purchase.webhook.duplicate_ignored', { kind, record_id: id, task_id: taskId, status: existing.status });
      return { accepted: true, duplicate: true, taskId };
    }
    if (!existing) await this.store.create({ task_id: taskId, kind, record_id: id, status: 'queued' });
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
        // 有报货批次号走「到齐判据」的批次处理，没有则走单条处理（兼容旧数据）
        const batchNo = await this.readReportBatchNo(recordId);
        if (batchNo) {
          result = await this.handleReportBatch(batchNo, recordId, taskId);
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
        // 「未到齐」不是失败、也不是完成：任务要停在一个**能被重新投递唤醒**的状态。
        // 落成 posted/failed 都会说谎——posted 会让后续明细被当成重复投递直接跳过
        // （那批货就永远差几双），failed 会让她以为报货出错了。
        if (kind === 'supplier-report' && result?.status === 'awaiting_completeness') {
          status = 'awaiting_completeness';
        } else if (kind === 'supplier-report' && result?.status === 'batch_inflight') {
          // 同一批的另一条明细正在处理这一批，这次我们什么都没做。
          // 落成 completed 是安全的：处理者是**批次任务**（第一条明细的 taskId），
          // 它只有在把这一批所有记录都标成终态之后才会落 posted；真失败了也是
          // 批次任务落 failed，重收任意一侧的 webhook 都能让它重跑，
          // 不会因为这条记录已经 completed 就丢货。
          status = 'completed';
        } else if (kind === 'supplier-report' && result?.status === 'already_posted') {
          // 这一批早就生成过采购申请（重启/重投递后又走到这里）：本次什么都没写，
          // 对这条记录来说就是「已经处理过」，终态是 completed。
          status = 'completed';
        } else {
          status = kind === 'supplier-report'
            ? (result?.ignored && result?.status === '已取消' ? 'cancelled' : 'posted')
            : 'awaiting_confirmation';
        }
      }
      return this.store.update(taskId, { status, result });
    } catch (error) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      if (kind === 'supplier-report') {
        // ⚠️ 刻意**不**把报单记录改成「解析失败」。
        // 这条链路的失败绝大概率是「模型这一步抽了一下」或「这一批还没到齐」，
        // 两者都应该是**可重试**的：把记录标成「解析失败」是终态，重收 webhook 会被
        // 幂等守卫跳过，那批货就静默丢了。状态保持不变 + 任务可重试 + 超时告警，
        // 三条一起才等于"不丢单"。
        logWarn('purchase.report.batch.failed_retryable', {
          record_id: recordId, task_id: taskId, error: error.message,
        });
      }
      if (kind === 'arrival') {
        // 到货的失败只有这一处出口（processArrival 只负责记录日志再抛出）：
        // 不管是超时、模型报错还是没预料到的异常，都必须把记录推出「识别中」并告诉她，
        // 否则她看到的就只是永远「识别中」——只写日志等于没发生，她看不到日志。
        // 单一出口还有一个好处：状态和通知不会重复发、也不会漏。
        await this.failArrival(taskId, recordId, error);
      }
      throw error;
    }
  }

  /**
   * 到货识别失败的统一收尾：先把记录推出「识别中」，再通知验收人。
   *
   * 顺序不能反：她能看到的第一个事实是记录上的「识别失败 + 原因」，
   * 消息只是催促她处理。写入失败也必须继续发消息（消息里已经带了原因）。
   */
  async failArrival(taskId, recordId, error) {
    const reason = humanizeArrivalFailure(error);
    const marked = await this.markArrivalRecognitionFailed(recordId, reason);
    logWarn('purchase.arrival.recognition.failed', {
      record_id: recordId, task_id: taskId, reason, failure_marked: marked, error: error.message,
    });
    const operatorOpenId = await this.resolveArrivalOperator(taskId, recordId);
    await this.notifyArrivalFailed(operatorOpenId, reason, recordId, taskId);
    return { reason, marked };
  }

  /**
   * 把「识别中」推出去。这是硬要求：记录不能永远停在「识别中」。
   * 写飞书这一步本身也会失败（它同样是没有超时的外部调用），所以重试几次；
   * 全部失败就大声记日志——至少人工能查到，不会静默。
   */
  async markArrivalRecognitionFailed(recordId, reason) {
    for (let attempt = 1; attempt <= this.failureWriteAttempts; attempt += 1) {
      try {
        await this.gateway.update('purchaseArrival', recordId, {
          recognitionStatus: '识别失败',
          failureReason: reason,
        });
        return true;
      } catch (error) {
        logWarn('purchase.arrival.failure_status.write_failed', {
          record_id: recordId, attempt, max_attempts: this.failureWriteAttempts, error: error.message,
        });
        if (attempt < this.failureWriteAttempts) await sleep(this.failureWriteRetryDelayMs);
      }
    }
    logError('purchase.arrival.failure_status.gave_up', { record_id: recordId, reason });
    return false;
  }

  /**
   * 失败提示发给谁：记录上的「验收人」就是提交这条到货记录的人。
   * 处理一开始就把 open_id 落进任务，所以即使失败发生在读记录之后、识别之前，
   * 这里也还找得到人；任务里没有（比如读记录本身就失败了）就回读一次记录。
   */
  async resolveArrivalOperator(taskId, recordId) {
    const task = await this.store.get(taskId).catch(() => null);
    if (task?.arrival_operator_open_id) return task.arrival_operator_open_id;
    try {
      const table = this.gateway.table('purchaseArrival');
      const record = await this.gateway.get('purchaseArrival', recordId);
      return this.recordOperator(record, table.fields.inspector);
    } catch (error) {
      logWarn('purchase.arrival.operator.read_failed', { record_id: recordId, error: error.message });
      return '';
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
   * 「报货到齐」判据落地的入口（替代原来的 30 秒合并窗口）。
   *
   *   读批次号下**全部**报单记录 → 每条解析双数 → evaluateReportCompleteness 判到齐
   *   未到齐 → 什么都不做（等后续明细到达，只挂一条 5 分钟告警）
   *   到齐   → 上锁 → 写采购申请/出图/发图/写回附件（复用 confirmPurchaseRequest 整条现成逻辑）
   *
   * 为什么不再需要时间窗口：判据本身就是「Σ双数 >= 合计数量」，它已经能**确定**
   * 这一批齐没齐；靠时间猜既不必要也不可靠（3 双和 5 双的到达间隔毫无规律）。
   *
   * 幂等与不丢单（这一段的全部意义）：
   *   · 同一批次号用 inflightBatches 上锁，并发到达的第二个请求直接返回，不重入；
   *   · 已经生成过的批次在做任何解析/写入之前就按记录状态挡掉（重启后靠状态恢复）；
   *   · 「未到齐」不写任何表、不改任何状态，只把任务停在 awaiting_completeness，
   *     这样后续明细的 webhook 还能把它唤醒；
   *   · 抛出去的都是真异常（模型抽风、读表失败），由 process() 落成可重试的 failed，
   *     报单记录的处理状态**保持不变**——标成终态失败就是静默丢单。
   */
  async handleReportBatch(batchNo, recordId, taskId) {
    // 同一批次号同时只能有一个在跑。这里先做一次便宜的早退（避免白读一遍表和解析），
    // 真正的抢锁在下面"读表 + 判到齐"之后（那一步要花模型调用，窗口更长）。
    if (this.inflightBatches.has(batchNo)) {
      logInfo('purchase.batch.inflight_ignored', { batch_no: batchNo, record_id: recordId });
      return { status: 'batch_inflight', batch_no: batchNo };
    }
    // 先读一遍「能不能判」。这一遍读表是为了拿到全批记录（含「合计数量」），
    // 不是为了抢锁，所以放在上锁之前——未到齐的绝大多数请求连锁都不需要碰。
    const reportTable = this.gateway.table('purchaseReport');
    const allRecords = await this.gateway.listAll('purchaseReport');
    const batchRecords = allRecords.filter(
      (record) => textValue(record?.fields?.[reportTable.fields.batchNoText]) === batchNo,
    );
    if (batchRecords.length === 0) {
      // 理论上不该发生（刚读过这条记录就有批次号），真发生了也按「未到齐」处理：
      // 等下一轮心跳或者下一条明细到达，绝不在这里抛错把记录打成失败。
      logWarn('purchase.batch.no_records', { batch_no: batchNo, record_id: recordId });
      const outcome = {
        declaredTotal: null, receivedQuantity: 0, missingQuantity: 0, recordCount: 0, inconsistent: false, reason: 'no_declared_total',
      };
      this.scheduleBatchAlert(outcome, { batchNo, recordIds: [recordId] });
      return { status: 'awaiting_completeness', batch_no: batchNo, ...outcome };
    }
    // 告警的起算点用表里的「报单时间」：它是跨重启稳定的，内存里的定时器不是。
    const earliestReportedAt = batchRecords.reduce((earliest, record) => {
      const parsed = parseReportedAt(record?.fields?.[reportTable.fields.reportedAt]);
      if (!parsed) return earliest;
      return earliest === 0 ? parsed : Math.min(earliest, parsed);
    }, 0);
    const operatorOpenId = batchRecords
      .map((record) => this.recordOperator(record, reportTable.fields.operator))
      .find(Boolean) || '';

    // 幂等与「到齐」的先后顺序很关键：
    // 某条记录一旦已经是终态（或已经关联了采购申请），说明**这一批的申请已经写过了**，
    // 后来的明细不该再触发第二次申请——它自己那一条的双数当然也凑不满整批的
    // 「合计数量」，所以必须先把这一类记录摘出去，否则补录的记录会永远停在「待解析」。
    const pendingRecords = batchRecords.filter(
      (record) => !this.isReportRecordPosted(record, reportTable),
    );
    if (pendingRecords.length < batchRecords.length) {
      // 这一批已经有记录到了终态：按「早已生成」处理，给剩下没到终态的补上终态。
      const finalized = await this.markRecordsAsPosted(
        pendingRecords.map((record) => record.record_id),
        reportTable,
      );
      logInfo('purchase.batch.already_posted', {
        batch_no: batchNo,
        record_id: recordId,
        posted_record_count: batchRecords.length - pendingRecords.length,
        ignored_record_count: finalized,
      });
      return {
        status: 'already_posted',
        batch_no: batchNo,
        ignored_record_count: finalized,
      };
    }

    const entries = [];
    for (const record of pendingRecords) {
      entries.push({
        recordId: record.record_id,
        fields: record?.fields || {},
        detailId: textValue(record?.fields?.[reportTable.fields.detailId]),
        // 每条解析双数：复用报货既有的「数量说明」解析逻辑（parseReportQuantities），
        // 不另写一套。解析失败会抛出，由 process() 落成可重试的失败——不静默算 0。
        details: await this.parseReportQuantities(record?.fields || {}, reportTable),
      });
    }
    // 判据用纯函数：Σ双数 >= 合计数量（>= 兼容多报，不会把批次卡死）。
    const outcome = evaluateReportCompleteness({
      declaredTotal: pendingRecords.map((record) => record?.fields?.[reportTable.fields.totalQuantity]),
      details: entries.flatMap((entry) => entry.details),
    });
    const meta = {
      batchNo,
      recordIds: batchRecords.map((record) => record.record_id),
      operatorOpenId,
      earliestReportedAt,
    };
    if (outcome.inconsistent) {
      // 同一批的「合计数量」不一致只在日志里标出来，不打断处理：
      // 判据按「第一条有合法值」继续算（纯函数的选择），异常数据留给人工核对。
      logWarn('purchase.batch.declared_total_inconsistent', {
        batch_no: batchNo, declared_totals: outcome.declaredTotals,
      });
    }
    if (!outcome.complete) {
      // 未到齐 → 什么都不做。不改「处理状态」、不写任何表，只挂一个到点告警。
      this.scheduleBatchAlert(outcome, meta);
      logInfo('purchase.batch.not_complete', {
        batch_no: batchNo,
        record_id: recordId,
        declared_total: outcome.declaredTotal,
        received_quantity: outcome.receivedQuantity,
        missing_quantity: outcome.missingQuantity,
        record_count: outcome.recordCount,
        reason: outcome.reason,
      });
      return { status: 'awaiting_completeness', batch_no: batchNo, ...outcome };
    }

    // 兜底幂等：到齐之后、上锁之前再确认一次「这一批是不是已经有人写了」
    //（同一 taskId 重入、或另一条明细刚好在同一个瞬间写完了申请）。
    if (await this.isBatchPosted(taskId, batchRecords, reportTable)) {
      logInfo('purchase.batch.already_posted', { batch_no: batchNo, record_id: recordId, ignored_record_count: 0 });
      return { status: 'already_posted', batch_no: batchNo, ignored_record_count: 0 };
    }

    // 到齐 + 没被别人处理过：上锁（同一批次号串行）→ 写采购申请 → 出图 → 发图 → 写回附件。
    // 另一个请求正在处理这一批（它刚拿了锁、状态还没落盘）：直接退出。
    // 报单表读不到"锁"，任务状态也还只有 processing/batch_posted，
    // 所以必须显式检查这一条，否则两条不同记录的并发请求会各写一遍采购申请。
    if (this.inflightBatches.has(batchNo)) {
      logInfo('purchase.batch.inflight_ignored', { batch_no: batchNo, record_id: recordId });
      return { status: 'batch_inflight', batch_no: batchNo };
    }
    this.inflightBatches.add(batchNo);
    try {
      // 记下「这一批已经到齐、进入处理」。它会被 isBatchPosted 当成"已经处理过"，
      // 所以必须在拿锁之后写：否则并发到达的第二条明细会看到它、误以为这一批
      // 早就生成过申请，然后把它的明细静默跳过（那几双就丢了）。
      await this.store.update(taskId, { status: 'batch_posted', batch_no: batchNo }).catch(() => undefined);
      this.cancelBatchAlert(batchNo);
      const result = await this.processSupplierBatch(batchNo, entries, taskId, reportTable);
      // 成功后不再需要告警（多报、提前补齐都会走到这里）。
      this.cancelBatchAlert(batchNo);
      return result;
    } finally {
      // 无论成败都释放锁。失败时也必须释放：任务已被落成可重试的 failed，
      // 重收 webhook 要能立刻重跑；锁留下不删反而会把重试挡住。
      this.inflightBatches.delete(batchNo);
    }
  }

  /**
   * 这一条报单记录是不是「这一批已经生成过申请了」。
   *
   * 判据有两个投影，任一成立就算：处理状态已是终态，或已经关联了采购申请
   *（后者是 confirmPurchaseRequest 写完申请后回写的，即使状态字段因为权限等原因
   * 没写上，关联也能说明事实已经落地）。
   *
   * ⚠️ 它回答的是"**这一条**处理过了"，不是"这一批整批齐了"——批次判据另算。
   */
  isReportRecordPosted(record, reportTable) {
    const fields = record?.fields || {};
    if (['已生成申请', '已取消'].includes(textValue(fields[reportTable.fields.status]))) return true;
    return linkedRecordIds(fields[reportTable.fields.request]).length > 0;
  }

  /**
   * 这一批是否已经生成过采购申请（幂等检查）。三个来源按优先级：
   *
   *   1. 这条记录自己的任务已经 posted 或 batch_posted ——「同一批的另一条明细
   *      正在处理/已经处理完」。报单表里可能还读不到「已生成申请」（写入发生在
   *      最后一步），但同一批次只能有一个处理者，所以这里必须挡掉，
   *      否则并发到达会把同一批货写两遍。
   *      ⚠️ batch_posted 只是"已经有人在处理这一批了"，不是"生成完了"：
   *      调用方必须先绕开它拿到锁，才允许往下写。
   *   2. 报单记录里已经有一条是「已生成申请」/「已取消」——跨进程、跨重启都可靠的标记。
   *      **优先看它而不是本地 TaskStore**：本地任务目录会随部署/容器重建消失，
   *      而报单记录在飞书里。
   *   3. 报单表里的「关联采购申请」已经有值——同上，是远端事实的另一个投影。
   */
  async isBatchPosted(taskId, batchRecords, reportTable) {
    const task = await this.store.get(taskId).catch(() => null);
    if (task && ['posted', 'batch_posted'].includes(task.status)) return true;
    return (batchRecords || []).some((record) => this.isReportRecordPosted(record, reportTable));
  }

  /**
   * 给这一批里还没到终态的报单记录补上终态。
   *
   * 用在「批次早已生成、又有新记录到达」的场景：那些新记录自己不会走到
   * confirmPurchaseRequest（那一批已经处理完了），不补状态的话它们会永远停在
   * 「待解析」，看起来像被漏掉了。
   */
  async markRecordsAsPosted(recordIds, reportTable) {
    let updated = 0;
    for (const recordId of recordIds) {
      const patch = { status: '已生成申请' };
      if (reportTable?.fields?.failureReason) patch.failureReason = '';
      const written = await this.gateway.update('purchaseReport', recordId, patch).catch(() => null);
      if (written) updated += 1;
    }
    return updated;
  }

  // ── 「未到齐」告警 ──────────────────────────────────────────────────────────
  // 产品负责人定的 5 分钟：到点仍未到齐就给她发一条人话消息。
  // 三条硬要求都体现在下面：
  //   · 不改「处理状态」——「没到齐」和「失败」不能混为一谈（整个告警只发消息）；
  //   · 常驻心跳开销小——没有未到齐的批次时 Map 是空的，一个定时器都不存在；
  //   · 重启不丢——定时器只决定"什么时候提醒"，判据每次都重新读表算，
  //     所以进程重启后 bootstrapReportAlerts() 能凭表里的「报单时间」把闹钟重建出来。
  scheduleBatchAlert(outcome, { batchNo, recordIds = [], operatorOpenId = '', earliestReportedAt = 0 } = {}) {
    if (!batchNo || !this.reportAlertDelayMs) return null;
    // 已经挂过就不再重复挂：每次报货到达都会走到这里，不能每条明细都起一个定时器。
    const existing = this.pendingReportAlerts.get(batchNo);
    if (existing) {
      // 补齐记录集合与经办人，让到点时复查能覆盖到最新到达的明细。
      for (const id of recordIds) existing.recordIds.add(id);
      if (!existing.operatorOpenId && operatorOpenId) existing.operatorOpenId = operatorOpenId;
      return existing;
    }
    // 起算点用表里的「报单时间」（能重建、跨重启稳定），读不到才退回「现在」。
    const baseTime = earliestReportedAt || Date.now();
    const dueAt = baseTime + this.reportAlertDelayMs;
    const entry = {
      dueAt,
      batch_no: batchNo,
      recordIds: new Set(recordIds),
      operatorOpenId,
      timer: null,
    };
    if (!this.disableBatchAlertTimers) {
      entry.timer = setTimeout(() => {
        this.sweepBatchAlerts().catch((error) => {
          logWarn('purchase.report.alert.sweep_failed', { batch_no: batchNo, error: error.message });
        });
      }, Math.max(0, dueAt - Date.now()));
      // unref：告警定时器不该拖住进程退出（常驻服务里无所谓，测试/脚本里很关键）。
      if (typeof entry.timer?.unref === 'function') entry.timer.unref();
    }
    this.pendingReportAlerts.set(batchNo, entry);
    logInfo('purchase.report.alert.scheduled', { batch_no: batchNo, due_at: new Date(dueAt).toISOString() });
    return entry;
  }

  cancelBatchAlert(batchNo) {
    const entry = this.pendingReportAlerts.get(batchNo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pendingReportAlerts.delete(batchNo);
  }

  /**
   * 到点的批次逐个复查：**重新读表重算判据**，而不是相信挂号时算出来的结果。
   *
   * 这样即使中途又到了一批明细（正好在到点的临界点上），也不会误报；
   * 反过来，已经到齐的批次在这里会被撤掉告警，不会打扰她。
   */
  async sweepBatchAlerts(now = Date.now()) {
    const due = [...this.pendingReportAlerts.values()].filter((entry) => entry.dueAt <= now);
    if (!due.length) return { checked: 0, alerted: 0 };
    const reportTable = this.gateway.table('purchaseReport');
    const allRecords = await this.gateway.listAll('purchaseReport');
    let alerted = 0;
    for (const entry of due) {
      const batchRecords = allRecords.filter(
        (record) => textValue(record?.fields?.[reportTable.fields.batchNoText]) === entry.batch_no,
      );
      const pendingRecords = batchRecords.filter(
        (record) => !this.isReportRecordPosted(record, reportTable),
      );
      const details = [];
      for (const record of pendingRecords) {
        details.push(...await this.parseReportQuantities(record?.fields || {}, reportTable));
      }
      const outcome = evaluateReportCompleteness({
        declaredTotal: batchRecords.map((record) => record?.fields?.[reportTable.fields.totalQuantity]),
        details,
      });
      if (outcome.complete) {
        // 到点的这一瞬间刚好补齐：撤掉告警，什么都不发。
        this.cancelBatchAlert(entry.batch_no);
        logInfo('purchase.report.alert.resolved_before_deadline', { batch_no: entry.batch_no });
        continue;
      }
      const operatorOpenId = entry.operatorOpenId || batchRecords
        .map((record) => this.recordOperator(record, reportTable.fields.operator))
        .find(Boolean) || '';
      // 只发一条消息。⚠️ 不碰「处理状态」：告警不等于失败，也不等于处理过。
      const sent = await this.sendNoticeText(operatorOpenId, this.buildReportIncompleteMessage({
        batchNo: entry.batch_no,
        declaredTotal: outcome.declaredTotal,
        receivedQuantity: outcome.receivedQuantity,
        missingQuantity: outcome.missingQuantity,
        recordCount: outcome.recordCount,
      }));
      logWarn('purchase.report.alert.incomplete', {
        batch_no: entry.batch_no,
        declared_total: outcome.declaredTotal,
        received_quantity: outcome.receivedQuantity,
        missing_quantity: outcome.missingQuantity,
        record_count: outcome.recordCount,
        sent,
      });
      // 只提醒一次：发完就撤，不重复轰炸（后续明细到达会重新挂号）。
      this.cancelBatchAlert(entry.batch_no);
      alerted += 1;
    }
    return { checked: due.length, alerted };
  }

  /**
   * 进程重启后重建「未到齐」告警。
   *
   * 内存里的定时器随重启消失，但判据的输入（报单记录、合计数量、报单时间）都在表里，
   * 所以能原样重建：按批次号分组 → 跳过已到终态的批次 → 用最早那条「报单时间」
   * ＋5 分钟算出该什么时候提醒。启动时读不到表只记一条 warn，不影响服务的其余部分。
   */
  async bootstrapReportAlerts() {
    const reportTable = this.gateway.table('purchaseReport');
    const allRecords = await this.gateway.listAll('purchaseReport');
    const byBatch = new Map();
    for (const record of allRecords) {
      const batchNo = textValue(record?.fields?.[reportTable.fields.batchNoText]);
      if (!batchNo) continue;
      if (!byBatch.has(batchNo)) byBatch.set(batchNo, []);
      byBatch.get(batchNo).push(record);
    }
    let scheduled = 0;
    let skippedPosted = 0;
    for (const [batchNo, batchRecords] of byBatch) {
      const pendingRecords = batchRecords.filter(
        (record) => !this.isReportRecordPosted(record, reportTable),
      );
      if (!pendingRecords.length) {
        skippedPosted += 1;
        continue;
      }
      const earliestReportedAt = batchRecords.reduce((earliest, record) => {
        const parsed = parseReportedAt(record?.fields?.[reportTable.fields.reportedAt]);
        if (!parsed) return earliest;
        return earliest === 0 ? parsed : Math.min(earliest, parsed);
      }, 0);
      const operatorOpenId = batchRecords
        .map((record) => this.recordOperator(record, reportTable.fields.operator))
        .find(Boolean) || '';
      this.scheduleBatchAlert(null, {
        batchNo,
        recordIds: pendingRecords.map((record) => record.record_id),
        operatorOpenId,
        earliestReportedAt: earliestReportedAt || Date.now(),
      });
      scheduled += 1;
    }
    logInfo('purchase.report.alert.bootstrap', {
      batch_count: byBatch.size, scheduled, skipped_posted: skippedPosted,
    });
    return { scheduled, skippedPosted };
  }

  /**
   * 把批次草稿发布成采购申请（出图/发图/写回附件都在 confirmPurchaseRequest 里）。
   *
   * entries 是 handleReportBatch 已经解析好的明细，这里不再重新解析——每多解析一次
   * 就是多一次模型调用，N 条明细的批次会变成最坏 O(N²)。
   */
  async processSupplierBatch(batchNo, entries, batchTaskId, reportTable = this.gateway.table('purchaseReport')) {
    const productTable = this.gateway.table('product');
    const allItems = [];
    const reportRecordIds = [];
    let supplierRecordId = '';
    let behaviorRecordId = '';
    let operatorOpenId = '';
    const parseErrors = [];

    for (const entry of entries) {
      const { recordId, fields } = entry;
      reportRecordIds.push(recordId);
      if (!operatorOpenId) operatorOpenId = this.recordOperator({ fields }, reportTable.fields.operator);
      const detailId = entry.detailId || textValue(fields[reportTable.fields.detailId]);
      const productIds = linkedRecordIds(fields[reportTable.fields.product]);
      if (productIds.length !== 1) {
        parseErrors.push(`记录 ${recordId}：必须关联一个货品编号`);
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
            logInfo('purchase.batch.multi_supplier', { batch_no: batchNo, record_id: recordId, supplier: itemSupplierId });
          }
        }
        const productInfo = this.productDisplayInfo(product.record, productTable);
        for (const item of entry.details || []) {
          allItems.push({
            ...item,
            product_record_id: product.recordId,
            product_number: productInfo.number,
            item_no: productInfo.itemNo,
            color: productInfo.color,
            supplier_record_id: itemSupplierId,
            report_record_id: recordId,
            detail_id: detailId,
          });
        }
      } catch (error) {
        parseErrors.push(`记录 ${recordId}：${error.message}`);
      }
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
    logInfo('purchase.batch.posted', {
      batch_no: batchNo, task_id: batchTaskId, record_count: reportRecordIds.length, item_count: allItems.length,
    });
    return {
      status: 'posted', batch_no: batchNo, item_count: allItems.length, request_count: result.request_ids?.length || 0,
    };
  }

  async sendCard(openId, card) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送确认卡片');
    const response = await withTimeout(
      this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
      }),
      this.imTimeoutMs,
      '发送采购确认卡',
    );
    if (response.code !== 0) throw new Error(`发送采购确认卡失败: ${response.msg} (Code: ${response.code})`);
  }

  /**
   * 给用户发一条纯文字提示，**尽力而为**：发不出去只记日志，不抛错。
   *
   * 复用现有那套 IM 能力（`client.im.message.create` + `msg_type: 'text'`），
   * 和 sendCard / sendText 完全同一条通道，不另起一套。
   *
   * 刻意只记日志、不抛错：这类提示是"顺带告诉她一声"，发不出去不能反过来
   * 把识别流程搞失败（识别结果已经写进记录了，卡片才是关键产物）。
   *
   * ⚠️ 名字必须和下面的 `sendText` 区分开（合并 #57 时吃过这个亏）：
   * 两个方法都在本类里、名字都叫 `sendText` 时，**后定义的那个会静默覆盖前者**
   * （JS 类体后面的同名方法赢），于是本方法"只记日志"的语义被 `sendText` 的
   * "失败即抛错"顶掉——「收到即提示」一旦发失败就会把整条到货识别打断，
   * 货品根本来不及建档。语义不同就必须名字不同，别再并回去。
   */
  async sendNoticeText(openId, content) {
    if (!openId) {
      logWarn('purchase.text.skipped', { reason: 'missing_open_id', content });
      return false;
    }
    try {
      const response = await withTimeout(
        this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: content }) },
        }),
        this.imTimeoutMs,
        '发送飞书消息',
      );
      if (response.code !== 0) throw new Error(`${response.msg} (Code: ${response.code})`);
      return true;
    } catch (error) {
      logWarn('purchase.text.failed', { content, error: error.message });
      return false;
    }
  }

  async notifyArrivalReceived(openId, recordId, taskId) {
    const sent = await this.sendNoticeText(openId, ARRIVAL_RECEIVED_NOTICE);
    logInfo('purchase.arrival.received_notice', { record_id: recordId, task_id: taskId, sent });
    return sent;
  }

  async notifyArrivalFailed(openId, reason, recordId, taskId) {
    const sent = await this.sendNoticeText(openId, arrivalFailureNotice(reason));
    logInfo('purchase.arrival.failure_notice', { record_id: recordId, task_id: taskId, reason, sent });
    return sent;
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
   * 「货号+颜色命中多条」（男/女鞋常共用货号）不再当错误：匹配器取第一条，这里把
   * 条数带回草稿，卡片上标注"匹配到 N 条、已取哪条"，她看得见就行。
   */
  async resolveArrivalProduct(raw, context) {
    try {
      // 用包过超时的 references：这一步每行都会全表扫一遍货品，是到货链路里
      // 最容易挂住的地方（见构造函数的 arrivalReferences 注释）。
      const product = await this.arrivalReferences.resolveProduct({ itemNo: raw.item_no, color: raw.color });
      const ambiguousCount = Number(product.ambiguousCount) || 0;
      const ambiguous = ambiguousCount > 1
        ? {
          count: ambiguousCount,
          color: product.selectedColor || raw.color || '',
          number: product.selectedNumber || '',
        }
        : null;
      return { product, created: null, ambiguous };
    } catch (error) {
      if (error.code !== 'PRODUCT_NOT_FOUND') throw error;
      const created = await this.ensureArrivalProduct(raw, context);
      const productTable = this.gateway.table('product');
      return {
        created,
        ambiguous: null,
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
   *
   * 成本也一并落盘（arrival_cost_written）：写成本本身是**幂等赋值**，重复写同一个值不会
   * 写坏数据，但"结果未知"（写完还没来得及记录就失败）不能当成"没写过"再走一遍决策——
   * 尤其不能在第二次重试时把它当成"已有成本"而发一条误导的 warn。
   */
  async persistArrivalCreation(context) {
    if (!context.taskId) return;
    try {
      await this.store.update(context.taskId, {
        arrival_created_products: context.createdLog,
        arrival_created_colors: context.createdColors,
        arrival_cost_written: context.costWritten,
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
    const costWritten = Array.isArray(task?.arrival_cost_written) ? task.arrival_cost_written : [];
    const context = {
      taskId: task?.task_id || '',
      productCache: new Map(),
      colorIndex: new Map(),
      createdColors: colors.map((item) => ({ ...item })),
      createdLog: products.map((item) => ({ ...item })),
      colorTableLoaded: false,
      // 本次到货的价格计划（item_no → 可信单价 / 冲突标记），processArrival 里填充。
      arrivalCostPlan: null,
      // 已经处理过成本的货品（写成功，或已判定"不覆盖"）：重试时直接跳过，不重复写。
      costApplied: new Map(costWritten.map((item) => [item.product_record_id, item.cost])),
      costWritten: costWritten.map((item) => ({ ...item })),
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
   * 只写确定知道的字段（产品负责人 2026-10-05 定稿的建档内容）：
   * 货号、颜色（关联）、供应商（关联，找不到就留空）、类别（识别出男/女才填，
   * 认不出留空——默认成 A 会把女鞋写进男鞋）、成本（识别到价格才填，识别不出留空）。
   * 刻意不写「编号」「货品状态」「缺失信息说明」——这三个在飞书里是公式字段，
   * 写进去会直接 FieldNameNotFound，而且它们的值本来就该由表自己算。
   * 也刻意不写「单价」：建档时看到的价格是采购成本，不是销售单价。
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

    // 成本：新品建档顺带把成本写上（产品负责人要求：货号/颜色/供应商/类别/成本一起落）。
    // 合并口径（#63「识别到价格就写成本」× #64「可信价格才写」）：
    //   价格来源统一走 buildArrivalCostPlan（它已按货号汇总、并把 unit_cost/unitCost/cost/price
    //   几种模型写法都算进来）；同货号多行价格不一致（conflict）→ plan 里没有可用 cost，不写。
    // 建档只会新建记录，不存在覆盖已有成本的问题——命中的老货品一律原样使用、不改动。
    const costPlanEntry = context.arrivalCostPlan?.get(itemNo);
    const createdAtCost = costPlanEntry && !costPlanEntry.conflict ? costPlanEntry.cost : null;
    if (createdAtCost !== null) values.cost = createdAtCost;

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
    // 建档时已经把成本写进去了：登记成"已处理"，processArrival 里的 applyArrivalCost
    // 就不会再对它走一次"成本为空 → 写"的判断（重试也不会）。
    if (createdAtCost !== null) {
      context.costApplied.set(recordId, createdAtCost);
      context.costWritten.push({ item_no: itemNo, color, product_record_id: recordId, cost: createdAtCost, source: 'create' });
      logInfo('purchase.arrival.cost_written', {
        item_no: itemNo, color, product_record_id: recordId, cost: createdAtCost, source: 'create',
      });
    }
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
   * 把到货单识别到的价格写进货品「成本」。
   *
   * 产品负责人的口径：「如果有的到货单上有价格的，那就是成本。」
   * 单据上的「销售价 / 单价」列 → 「货品信息」的「成本」字段（number 字段，直接写数字）。
   *
   * 写入规则刻意保守（谁改这里都要先读一遍）：
   *   1. 只在成本**为空**时写（含数字 0 都算已有值，见 arrivalCostPolicy.isBlankCost）；
   *   2. 已有成本 → 不覆盖，记一条 warn（带 货号 / 已有值 / 识别到的值）；
   *   3. 同一货号多行价格不一致 → 整条不写（conflict 在 processArrival 里统一记 warn）；
   *   4. 价格转不成正数 → 不写（plan 里根本没有这个货号）；
   *   5. 重试不重复写：写成功的货品记进 context.costApplied 并落盘，重试直接跳过。
   *
   * 写失败**不抛错**：成本写不进去不该把整批到货卡住（货已经到了，入库优先）；
   * 记 warn 后由下一次重试再试（赋值幂等，重复写同一个值无害）。
   *
   * @returns {Promise<{applied: boolean, reason: string}|null>} 只用于日志/测试断言
   */
  async applyArrivalCost(raw, product, productTable, context) {
    const itemNo = String(raw?.item_no || '').trim();
    const entry = context.arrivalCostPlan?.get(itemNo);
    if (!entry || entry.conflict || entry.cost === null) return null;
    const recordId = product.recordId;
    if (!recordId) return null;

    // 本次（或上次重试）已经处理过这条货品：直接跳过，不重复写、也不再打日志。
    if (context.costApplied.has(recordId)) return { applied: false, reason: 'already_applied' };

    const existing = product.record?.fields?.[productTable.fields.cost];
    if (!isBlankCost(existing)) {
      // 已有成本一律不覆盖；只有「值真的不一样」才 warn。
      // 值相同说明是上一次重试已经写成功了（这就是为什么必须先记账再往下走）。
      if (costValueOf(existing) === entry.cost) {
        context.costApplied.set(recordId, entry.cost);
        logInfo('purchase.arrival.cost_already_set', {
          item_no: itemNo, product_record_id: recordId, cost: entry.cost,
        });
      } else {
        context.costApplied.set(recordId, entry.cost);
        logWarn('purchase.arrival.cost_kept', {
          item_no: itemNo,
          product_record_id: recordId,
          existing_cost: textValue(existing),
          recognized_cost: entry.cost,
          reason: '货品已有成本，识别到的到货单价不覆盖',
        });
      }
      return { applied: false, reason: 'existing_cost' };
    }

    try {
      await this.gateway.update('product', recordId, { cost: entry.cost });
    } catch (error) {
      logWarn('purchase.arrival.cost_write_failed', {
        item_no: itemNo, product_record_id: recordId, cost: entry.cost, error: error.message,
      });
      return { applied: false, reason: 'write_failed' };
    }

    context.costApplied.set(recordId, entry.cost);
    context.costWritten.push({ item_no: itemNo, color: String(raw?.color || '').trim(), product_record_id: recordId, cost: entry.cost, source: 'update' });
    await this.persistArrivalCreation(context);
    logInfo('purchase.arrival.cost_written', { item_no: itemNo, product_record_id: recordId, cost: entry.cost, source: 'update' });
    return { applied: true, reason: 'written' };
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
    // 经办人先算出来并落盘：后面无论在哪一步失败，失败提示都还找得到人。
    const operatorOpenId = this.recordOperator(record, table.fields.inspector);
    await this.store.update(taskId, { arrival_operator_open_id: operatorOpenId }).catch(() => undefined);
    await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别中', failureReason: '' });
    const isDocument = textValue(fields[table.fields.type]).trim() === '到货单';
    const tokens = attachmentTokens(fields[table.fields.images]);
    if (!tokens.length) {
      throw new Error(isDocument ? '采购到货记录没有到货单图片附件' : '采购到货记录没有鞋盒图片附件');
    }
    // 确认有图片、马上要开始处理了，先回一句「收到了」。
    // 必须在识别之前发：识别（模型那一步）可能几十秒到几分钟，这段时间的沉默
    // 就是「系统卡死了」的来源。发不出去也不影响识别（sendText 只记日志）。
    await this.notifyArrivalReceived(operatorOpenId, recordId, taskId);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-arrival-'));
    try {
      const recognized = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const filePath = path.join(tempDir, `${index + 1}.jpg`);
        // 飞书 SDK 不设超时，附件下载可能一直挂着；到货链路必须能自己结束。
        const media = await withTimeout(
          this.client.drive.media.download({ path: { file_token: tokens[index] } }),
          this.mediaTimeoutMs,
          '下载到货图片',
        );
        await withTimeout(media.writeFile(filePath), this.mediaTimeoutMs, '保存到货图片');
        // 模型客户端自己也有 timeout（见 doubaoService.getClient），这里再包一层是
        // 兜住注入进来的识别器与「客户端超时没生效」的情况——超时必须能落到记录上。
        recognized.push(...await withTimeout(
          isDocument
            ? this.recognizer.recognizePurchaseDocument(filePath)
            : this.recognizer.recognizeLabels(filePath, 'purchase'),
          this.recognitionTimeoutMs,
          isDocument ? '识别到货单' : '识别鞋盒图片',
        ));
      }
      if (!recognized.length) throw new Error(isDocument ? '到货单上没有识别到任何明细' : '图片上没有识别到任何鞋盒');
      const arrivalTable = this.gateway.table('purchaseArrival');
      const batchIds = linkedRecordIds(fields[arrivalTable.fields.batch]);
      // 业务上存在「供应商直接送货、没有先走采购申请」的到货，这种记录不会选报货批次号。
      // 没有批次号就不再报错——全部按实际到货入库，草稿里标记 direct_arrival，
      // 卡片上写清楚"无申请直接到货"，免得她以为系统漏了什么。
      // 选了多个批次号仍然是配置错误：无法判断该把入库记录挂到哪一批的申请上。
      // 采购差异比对已经移除（见下方草稿处的说明），这里读申请只为了挂关联和回写到货状态。
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

      // 价格计划：从识别结果里按货号汇总可信单价（同货号价格不一致的整条不写）。
      // 冲突在这里**只打一条 warn**，不然同一货号的每个尺码都会重复报一次。
      creationContext.arrivalCostPlan = buildArrivalCostPlan(recognized);
      for (const entry of creationContext.arrivalCostPlan.values()) {
        if (!entry.conflict) continue;
        logWarn('purchase.arrival.cost_conflict', {
          record_id: recordId,
          item_no: entry.item_no,
          prices: entry.prices,
          reason: '同一货号在到货单上读出多个不同单价，不写成本，请人工核对',
        });
      }

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
          // 成本：只在拿到可信价格、且货品原来没有成本时写。写失败不挡住入库（见方法注释）。
          await this.applyArrivalCost(raw, product, productTable, creationContext);
          actual.push({
            product_record_id: product.recordId,
            // 新品刚建档时「编号」公式可能还没算出来，先用「货号+颜色」把明细显示出来。
            product_number: textValue(product.record?.fields?.[productTable.fields.number]) || (resolved.created?.label || ''),
            item_no: raw.item_no,
            color: raw.color,
            size: Number(raw.size),
            quantity: Number(raw.quantity || 1),
            // 单据上识别到的单件价：只用于卡片上显示、让她核对写进成本的数对不对，
            // 入库链路（采购入库/库存）不读这个字段。没有价格时是 undefined，格子少一行。
            unit_cost: raw.unit_cost,
            supplier: supplierName,
            // 草稿里记下哪些是刚建档的新品，卡片据此单独讲清楚。
            created_product: Boolean(resolved.created),
            // 该货号+颜色在货品表里命中多条时，记下「匹配到 N 条、取了哪条」，卡片要标注。
            ambiguous_match: resolved.ambiguous,
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
      // 采购差异比对已按产品负责人要求整体移除（未来架构：到货在采购申请基础上修改，
      // 差异比对不再需要；产品负责人 2026-10-05 确认）。草稿里仍然保留 requests，
      // 因为入库时要把每条采购入库记录挂回对应的采购申请，并回写申请的到货状态。
      const operatorOpenId = this.recordOperator(record, arrivalTable.fields.inspector);
      const draft = {
        arrival_record_id: recordId,
        direct_arrival: directArrival,
        batch_record_id: batchIds[0] || '',
        batch_no: batchNo,
        operator_open_id: operatorOpenId, requests, actual: groupedActual, unrecognized,
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
      // 采购差异比对已随 #63 移除：这里不再有 difference_count；
      // #64 的成本写入计数保留，便于线上看这一批到底写了几条成本。
      logInfo("purchase.arrival.card.sent", { record_id: recordId, task_id: taskId, direct_arrival: directArrival, arrival_type: isDocument ? '到货单' : '鞋盒', item_count: actual.length, unrecognized_count: unrecognized.length, created_product_count: createdProducts.length, created_color_count: creationContext.createdColors.length, cost_written_count: creationContext.costWritten.length });
      return { status: 'awaiting_confirmation', item_count: actual.length, created_product_count: createdProducts.length };
    } catch (error) {
      // 只记日志再抛出：把记录推出「识别中」和通知验收人统一交给 process() 的
      // failArrival 一处完成（见那里的注释），避免同一次失败写两遍状态、发两遍消息。
      logWarn('purchase.arrival.recognition.failed', { record_id: recordId, task_id: taskId, error: error.message });
      throw error;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * 在草稿保存的采购申请明细里，找「同一货品 + 同一尺码」的那一条。
   *
   * 只用来把采购入库记录的「采购申请」关联字段挂回去（以及回写到货状态用的匹配）。
   * 原来的 compareArrival 差异比对已按产品负责人要求整体移除（未来架构：到货在采购申请
   * 基础上修改，差异比对不再需要；产品负责人 2026-10-05 确认），这里只保留它当时顺手
   * 提供的 request_record_id 语义：同一 货品+尺码 取第一条申请行。
   */
  async findRequestRowForInbound(requests, productRecordId, size, requestTable) {
    for (const row of requests) {
      const productId = linkedRecordIds(row.fields?.[requestTable.fields.product])[0];
      if (productId !== productRecordId) continue;
      const resolvedSize = await this.getSizeReferences().resolveLinkedCell(row.fields?.[requestTable.fields.size]);
      if (Number(resolvedSize.size) === Number(size)) return row;
    }
    return null;
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
      // 差异比对已移除；这里只找同货品+尺码的申请行，把入库记录挂回对应的采购申请。
      const requestRow = await this.findRequestRowForInbound(
        arrival.requests || [], item.product_record_id, item.size, requestTable,
      );
      const inbound = await this.gateway.create('purchaseInbound', {
        product: relation(item.product_record_id),
        size: relation((await this.getSizeReferences().resolveByNumber(item.size)).recordId),
        quantity: item.quantity,
        behavior: relation(purchaseInboundBehaviorId),
        batch: relation(arrival.arrival_record_id),
        supplierOrder: requestRow?.record_id ? relation(requestRow.record_id) : undefined,
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
