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
const { InventoryService, MOVEMENT_PURCHASE_DECREASE } = require('./inventoryService');
const { buildPurchaseQuantities } = require('./purchaseQuantityPolicy');
// 「采购行为」分流：采购申请（尺码 + 数量说明）还是采购退货（数量，无尺码）。
// 退货要走完全不同的一条链路（直接扣库存 + 出退货单，不经到货/入库），
// 所以必须在解析之前认出来。
const { REPORT_BEHAVIOR, classifyReportBehavior } = require('./purchaseReportBehaviorPolicy');
// 归批窗口：#81 用「按报货批次号开的短窗口」取代了旧的「到齐」判据，
// reportCompletenessPolicy（Σ双数 >= 合计数量）已随 #81 整体删除。
const { resolveReportBatchWindowMs } = require('../config/reportBatchWindow');
const { buildArrivalCostPlan, isBlankCost, costValueOf } = require('./arrivalCostPolicy');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng, RETURN_TITLE } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { withTimeout, withTimeoutProxy, TimeoutError } = require('../utils/withTimeout');
const {
  ARRIVAL_WAITING_NOTICE,
  resolveArrivalWaitConfig,
  arrivalRescuedNotice,
} = require('./arrivalWaitPolicy');
const { getLarkAgentCredentials } = require('../config/larkAgent');
// 采购单改成发到**群**（业务负责人：「不用再看经办人了」）。
// 群 id 从配置读，**没有默认值**（见 config/groupPurchase 里的说明）。
const { resolvePurchaseChatId } = require('../config/groupPurchase');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');

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
    // ⚠️ 新品在「发确认卡片之前不建档」（产品负责人 2026-10-05 定的顺序），所以这一步
    // 它还没有 product_record_id。身份退回「货号+颜色」——**不能**退回空串：
    // 两个不同新品都会落到空 key 上，被错当成同一条明细合并（尺码一样时数量翻倍，
    // 卡片和入库都会跟着错）。老货品仍然用 product_record_id 聚合，行为不变。
    const identity = item.product_record_id || `pending:${textValue(item.item_no)}|${textValue(item.color)}`;
    if (identity === 'pending:|' || !Number.isInteger(size) || size <= 0 ||
      !Number.isInteger(quantity) || quantity <= 0) throw new Error('到货识别结果的货品、尺码或数量无效');
    const key = `${identity}|${size}`;
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

// 鞋盒/吊牌上的「品名」：女鞋 → B、男鞋 → A。单选选项就是 A/B 两个字。
// 识别不出性别就留空：默认成 A 会把女鞋写进男鞋，比空着更难发现。
const genderToCategory = (value) => {
  const label = String(value || '').trim();
  if (/女/.test(label)) return 'B';
  if (/男/.test(label)) return 'A';
  return '';
};

/**
 * 「采购退货」格式的数量：「数量」是 number 字段（业务负责人 2026-10-05 改的字段结构）。
 *
 * 非法/为空就抛错，由 process() 落成**可重试的失败**——绝不静默算成 0：
 * 一条退货记录数量读成 0，等于什么都没退，而她还以为系统处理过了。
 */
const parseReturnQuantity = (value) => {
  const quantity = Number(textValue(value));
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('采购退货的「数量」必须是正整数');
  return quantity;
};

/**
 * 退货核对结果 → 一句人话（业务负责人的口径：「把差额明确告诉她」）。
 *
 * 只在**对不上**的时候发（差额、或库存里一双都没有）：对得上时图本身就是回执，
 * 再发一条等于刷屏。文案里不出现"实时库存/校验/差额"以外的内部术语，
 * 最后一律给出下一步动作（补数量 / 重新提交一条）。
 */
const buildPurchaseReturnNotice = ({ itemNo, color, size, plan }) => {
  const label = `${itemNo || ''}${color || ''}`.trim() || '这个货品';
  const sizeText = size ? `（${size} 码）` : '';
  if (plan.available === 0) {
    return `采购退货没处理：${label}${sizeText} 在实时库存里一双都没有，我没有扣库存，也没有把这条记录标成已处理。` +
      '库存补上之后再提交一条退货记录就好～';
  }
  if (plan.shortfall > 0) {
    return `采购退货：${label}${sizeText} 你说要退 ${plan.declared} 双，实时库存里只有 ${plan.available} 双 —— ` +
      `我先按能对上的 ${plan.taken} 双处理了，差的 ${plan.shortfall} 双对不上。` +
      '要我一起退的话，把数量改成能对上的数再提交一条～';
  }
  if (plan.surplus > 0) {
    return `采购退货：${label}${sizeText} 你填的 ${plan.declared} 双对上了，已经退回。` +
      `⚠️ ${label}${sizeText} 在实时库存里还剩 ${plan.surplus} 双没退（总数是 ${plan.available} 双）——` +
      '要一起退就把数量改成总数再提交一条～';
  }
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
    // 模型识别这一层的超时。**必须和 doubaoService 的视觉超时用同一个来源**：
    // 2026-10-05 线上出过事——.env 里写了 180 秒，但这一层硬编码 60 秒先开火，
    // 一条实际 82 秒才返回的到货单被判成「识别失败」（数据其实是好的）。
    // 默认 180 秒：出库单整张识别实测 82~118 秒。
    this.recognitionTimeoutMs = options.recognitionTimeoutMs
      ?? (Number(process.env.VISION_LLM_TIMEOUT_MS) > 0 ? Number(process.env.VISION_LLM_TIMEOUT_MS) : 180_000);
    this.imTimeoutMs = options.imTimeoutMs ?? 15_000; // 飞书消息
    // 失败态写入本身也可能失败，写不出去就等于记录永远停在「识别中」，所以重试几次。
    this.failureWriteAttempts = options.failureWriteAttempts ?? 3;
    this.failureWriteRetryDelayMs = options.failureWriteRetryDelayMs ?? 200;
    // 到货「等待与提示」的四个阈值：显式入参 > 环境变量 > 默认值（见 arrivalWaitPolicy）。
    // 为什么全部可配：她看完一次 82 秒的真实识别后定的规则，但该设多少要继续用真实数据校准。
    // 语义差别是这次改造的核心：**放弃等待（2 分钟）≠ 失败（3 分钟）**。
    const arrivalWait = resolveArrivalWaitConfig(options);
    this.arrivalNoticeIntervalMs = arrivalWait.noticeIntervalMs; // 每 N 毫秒补一条「还在识别中」
    this.arrivalAbandonWaitMs = arrivalWait.abandonWaitMs; // 超过就放弃等待（只记日志，不判失败）
    this.arrivalFailAfterMs = arrivalWait.failAfterMs; // 超过才判失败
    this.arrivalNoticeMaxCount = arrivalWait.noticeMaxCount; // 补发次数上限（兜底）
    // 正在等待的到货（含已停止的观察点由 stop() 移除）：测试据此断言
    // 「处理完成后不残留任何定时器」，生产上也能一眼看出还有几条在等。
    this.arrivalWaits = new Set();
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
    // 「发到群的那条消息 ↔ 是哪一批」的映射（C 用 parent_id 反查靠它）。
    // ⚠️ 映射写**本地任务记录**，不写业务表：这是机器人的路由信息，
    // 不是经营事实，不该出现在她的多维表格里。
    this.batchLocator = options.batchLocator || new PurchaseBatchLocator({ store: options.batchLocatorStore });
    this.queues = new Map();
    // 卡片确认按 taskId 串行。重复的卡片事件（双击、飞书重投）会同时读到
    // awaiting_confirmation 并各自走一遍副作用，把同一批采购事实写两遍；
    // 卡片上的「处理中」只是 UX，后端必须自己保证同一任务不并行。
    this.confirmationQueue = new KeyedSerialQueue();
    // 新品建档按 taskId 串行。建档现在是**发完卡片之后**才做（见 processArrival），
    // 她点确认时还会兜底再跑一次；两次如果并行，两边各自从任务里恢复建档进度，
    // 就会各建一条同名货品（幂等靠"先落盘再重试"的读回，挡不住真正的并发）。
    // 两个队列不会互相等待死锁：确认走 confirmationQueue，建档走 creationQueue，方向是单向的。
    this.creationQueue = new KeyedSerialQueue();
    this.batchReadMaxRetries = options.batchReadMaxRetries ?? 3;
    this.batchReadRetryDelay = options.batchReadRetryDelay ?? 1000;
    this.inflightInbound = new Map();
    // ── 归批（把同一次表单提交的几条记录认成一批）──────────────────────────────
    // inflightBatches：同一批次号的**串行锁**。同一批正在处理时，后来的记录绝不能
    // 另起一次处理（否则同一批货会写出两套采购申请）。它是幂等的第一道防线，
    // 第二道是记录级的终态判断与采购申请的幂等键。
    this.inflightBatches = new Set();
    // pendingReportBatches：按「报货批次号」归集的短窗口。
    //
    // 为什么必须有：一次表单提交 = N 条记录，逐条处理会出 N 张采购申请图。
    // 首选信号是 webhook 的"同一包"（action_list 里的多个 record_added 一起交给
    // 处理逻辑），但"一包就是一次提交"还没有真机验证过，所以这里按批次号兜底：
    // 窗口内到的记录算一批，窗口到点由一个处理者统一处理整批。
    // 窗口默认 4 秒（REPORT_BATCH_WINDOW_MS 可配；以前那个 30 秒已被业务负责人否掉）。
    // value: { batchNo, batchTaskId, taskIds: Set, timer }
    this.pendingReportBatches = new Map();
    this.reportBatchWindowMs = resolveReportBatchWindowMs(options);
  }

  /**
   * 「采购申请」格式的明细：编号 + 尺码 + 从「数量说明」解析出的数量。
   * 复用 buildPurchaseQuantities（勾选的尺码默认各一双，说明里只写例外），
   * 不另写一套解析。
   */
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

  /**
   * 「采购退货」格式的明细：编号 + 「数量」（number），**没有尺码**。
   *
   * ⚠️ 业务语义（退货到底要不要出图、要不要写「采购申请」表、会不会动库存）
   * 还没有经业务负责人确认过——代码里只做**字段形态**的搬运：
   * 解析出数量，且明确不带尺码（size=null），避免"顺手补一个尺码"发明业务规则。
   * 数量非法时抛错（由 process() 落成可重试的失败），不静默算 0。
   */
  parseReportReturnQuantities(fields, reportTable) {
    const raw = fields?.[reportTable.fields.quantity];
    const quantity = Number(textValue(raw));
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error('采购退货的「数量」必须是正整数');
    }
    return [{ size: null, size_record_id: null, quantity }];
  }

  /**
   * 按「采购行为」把一条报单记录解析成明细。
   * 采购申请 → 尺码 + 数量说明；采购退货 → 数量，无尺码。
   */
  async parseReportItems(fields, reportTable, behaviorKind) {
    if (behaviorKind === REPORT_BEHAVIOR.PURCHASE_RETURN) {
      return this.parseReportReturnQuantities(fields, reportTable);
    }
    return this.parseReportQuantities(fields, reportTable);
  }

  /**
   * 「行为管理」表的 record_id → 行为记录。一次读表建索引，供整批复用：
   * 逐条 get 会让 N 条明细多出 N 次网络往返，而且这里只需要名称/编码。
   * 读不到就返回空索引——分流会退回"采购申请"（今天的行为），不让报货卡住。
   */
  async loadBehaviorIndex() {
    try {
      const behaviorTable = this.gateway.table('behavior');
      const records = await this.gateway.listAll('behavior');
      return new Map(records.map((record) => [record.record_id, {
        name: textValue(record?.fields?.[behaviorTable.fields.name]),
        code: textValue(record?.fields?.[behaviorTable.fields.code]),
      }]));
    } catch (error) {
      logWarn('purchase.report.behavior_index_failed', { error: error.message });
      return new Map();
    }
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

  /**
   * 一次 webhook 推送（同一个 action_list）里的多条记录**一起**交给处理逻辑。
   *
   * 这是归批的**首选**信号：飞书把一次表单提交的多条 record_added 放在同一个包里
   * 推送过来，一包就是一次提交。逐条 accept 也能被下面的批次窗口正确归集，
   * 但显式收成一包，语义更清楚、日志里也能看出"这几条是一起来的"。
   *
   * ⚠️ 「一包就是一次提交」尚未被真机验证，所以处理时机仍然由按「报货批次号」
   * 开的短窗口决定（见 handleReportBatch / flushReportBatch）——包若能拆，
   * 拆出来的记录仍会被同一个窗口收进同一批。
   */
  async acceptMany(kind, recordIds) {
    const ids = (Array.isArray(recordIds) ? recordIds : [recordIds])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (ids.length === 0) return { accepted: true, records: [] };
    const records = [];
    const failed = [];
    for (const id of ids) {
      // 逐条隔离：一包里某条的 record_id 有问题（理论上不该发生）不能连累同包其它记录
      // ——以前每条各占一个 setImmediate、各有一个 catch，这个语义要保持不变。
      try {
        records.push(await this.accept(kind, id));
      } catch (error) {
        failed.push({ record_id: id, error: error.message });
        logError('purchase.webhook.accept_failed', { kind, record_id: id, error: error.message });
      }
    }
    if (ids.length > 1) {
      logInfo('purchase.webhook.accepted_package', {
        kind, record_count: ids.length, accepted_count: records.length, record_ids: ids,
      });
    }
    return { accepted: failed.length === 0, records, failed };
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
    // 到货已经出过卡（awaiting_confirmation）或已入库（posted）时，重复投递的 webhook
    // 不能再解析一遍。accept() 通常会拦掉，但 3 分钟判失败 → 迟到结果救回的窗口里它拦不住：
    // 那一刻任务还是 failed，重投会被排进同一条串行队列，等它真正跑起来时状态已经变回成功，
    // 再跑一遍就会重复建货品、重复发卡。入库本身的幂等在 confirmArrival，这里挡的是识别。
    if (kind === 'arrival' && ['awaiting_confirmation', 'posted'].includes(task?.status)) {
      logInfo('purchase.webhook.arrival_already_processed', { record_id: recordId, task_id: taskId, status: task.status });
      return task;
    }
    await this.store.update(taskId, { status: 'processing', started_at: new Date().toISOString() });
    try {
      let result;
      if (kind === 'supplier-report') {
        // 先按「采购行为」分流，再看批次号：采购退货走自己那条链路
        // （直接扣库存 + 出退货单），**不进归批窗口、也不写采购到货/入库**。
        // 分流放在批次号之前是有意的：一条退货记录即使带了报货批次号，也不该
        // 被报货那套归批/解析拦住（她没有给退货定过归批口径）。
        const behaviorKind = await this.readReportBehaviorKind(recordId);
        if (behaviorKind === REPORT_BEHAVIOR.PURCHASE_RETURN) {
          // 传 task：退货的核对计划要落盘成"只算一次"（见 ensureReturnPlan）。
          result = await this.processSupplierReturn(recordId, taskId, task);
        } else {
          // 有报货批次号就按「报货批次号」归批（一次提交 = 一批）；没有则走单条处理，
          // 兼容批次号字段上线前录入的旧数据。
          const batchNo = await this.readReportBatchNo(recordId);
          if (batchNo) {
            result = await this.handleReportBatch(batchNo, recordId, taskId);
          } else {
            result = await this.processSupplierReport(recordId, taskId);
          }
        }
      } else {
        result = await this.processArrival(recordId, taskId);
      }
      // 已经登记进批次窗口：等窗口到点由**一个**处理者统一处理整批。
      //
      // 这一段必须在下面"读 current 决定终态"之前处理，而且要重新读一次任务：
      // 窗口有可能在（极短的）窗口时长内已经跑完，那时任务已经是 posted/completed
      // 且带着真正的 result——这里不能把它覆盖成 batch_waiting，更不能把 result
      // 换成这个中间态对象。刻意不落 result，也是为了让"任务跑完了"的判据
      // （result 已落盘）不会提前成立、读到半成品。
      if (kind === 'supplier-report' && result?.status === 'batch_waiting') {
        const latest = await this.store.get(taskId);
        if (!latest || latest.status !== 'processing') return latest;
        return this.store.update(taskId, { status: 'batch_waiting', batch_no: result.batch_no });
      }
      const current = await this.store.get(taskId);
      // 采购报单免确认后没有「待确认」这个中间态了：写成功就是 posted。
      // 保持「已经写出的更靠后的状态不被覆盖回去」这个原则不变。
      let status = current?.status;
      if (!status || status === 'processing') {
        if (kind === 'supplier-report' && result?.status === 'batch_inflight') {
          // 同一批的另一条明细正在处理这一批，这次我们什么都没做。
          // 落成 completed 是安全的：处理者是**批次处理者**，它只有在把这一批所有
          // 记录都标成终态之后才会落 posted；真失败了也是批次处理者落 failed，
          // 重收任意一侧的 webhook 都能让它重跑，不会因为这条记录已经 completed 就丢货。
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
        // 这条链路的失败绝大概率是「模型这一步抽了一下」或「读表正好抽了一下」，
        // 都应该是**可重试**的：把记录标成「解析失败」是终态，重收 webhook 会被
        // 幂等守卫跳过，那批货就静默丢了。状态保持不变 + 任务可重试，
        // 两条一起才等于"不丢单"。
        logWarn('purchase.report.batch.failed_retryable', {
          record_id: recordId, task_id: taskId, error: error.message,
        });
      }
      if (kind === 'arrival') {
        // 到货的失败只有这一处出口（processArrival 只负责记录日志再抛出）：
        // 不管是超时、模型报错还是没预料到的异常，都必须把记录推出「识别中」并告诉她，
        // 否则她看到的就只是永远「识别中」——只写日志等于没发生，她看不到日志。
        // 单一出口还有一个好处：状态和通知不会重复发、也不会漏。
        //
        // 例外：等待超时（3 分钟）那一路已经在 processArrival 里写过失败态、也通知过她了
        // （见 startArrivalWaitWatch），这里再走一遍只会重复发一条消息——重复的消息比
        // 没有消息更糟，她会以为又失败了一次。只记日志。
        if (error.arrivalFailureAlreadyNotified) {
          logWarn('purchase.arrival.failure_notice.skipped', {
            record_id: recordId, task_id: taskId, reason: '等待超时时已判过失败并通知，不再重复发',
          });
        } else {
          await this.failArrival(taskId, recordId, error);
        }
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
   * 报货入口：按「报货批次号」归批。
   *
   * 为什么必须有这一层：一次表单提交 = **N 条记录**。逐条处理会出 N 张采购申请图
   * （业务负责人最在意的现象）。归批分两层信号：
   *   · 首选：webhook 的「同一包」——同一包里的多个 record_added 一起交给处理逻辑
   *     （见 acceptMany），一包 = 一次提交；
   *   · 兜底：万一飞书把一包拆开，按「报货批次号」在短窗口内归集，窗口到点统一处理。
   *     ⚠️ 「一包就是一次提交」还没真机验证过，所以处理时机始终由窗口决定：
   *     包若被拆，拆出来的记录仍落在同一个窗口里。
   *
   * 这里只做登记，不读表、不解析、不写任何业务表——真正的处理在 flushReportBatch。
   * 登记后任务停在 batch_waiting（可由后续 webhook 继续加入），不会假装"处理完了"。
   *
   * 为什么不判「到齐」：业务负责人删掉了「合计数量」字段，并明确说
   * 「目前核心的字段就不要了，我们现在也不加判断的逻辑」。留着一个读不到的判据
   * 只会让整批记录永远不处理。
   */
  async handleReportBatch(batchNo, recordId, taskId) {
    const existing = this.pendingReportBatches.get(batchNo);
    if (existing) {
      existing.taskIds.add(taskId);
      logInfo('purchase.batch.joined', {
        batch_no: batchNo, record_id: recordId, pending_count: existing.taskIds.size,
      });
      return { status: 'batch_waiting', batch_no: batchNo };
    }
    const entry = {
      batchNo,
      // 批次处理者的 taskId：整批的草稿、幂等键、出图都以它为 owner。
      // 具体是哪一条记录的 task 不重要——处理时读的是表里的**整批**记录。
      batchTaskId: taskId,
      taskIds: new Set([taskId]),
      timer: null,
    };
    this.pendingReportBatches.set(batchNo, entry);
    // ⚠️ 故意不 unref：窗口到点必须真的触发处理，unref 会让它随进程退出被丢掉，
    // 测试里更会变成"等不到处理"。窗口很短（默认 4 秒），不会拖住谁。
    entry.timer = setTimeout(() => {
      this.flushReportBatch(batchNo).catch((error) => {
        logError('purchase.batch.flush_failed', { batch_no: batchNo, error: error.message });
      });
    }, this.reportBatchWindowMs);
    logInfo('purchase.batch.opened', {
      batch_no: batchNo, record_id: recordId, window_ms: this.reportBatchWindowMs,
    });
    return { status: 'batch_waiting', batch_no: batchNo };
  }

  /**
   * 窗口到点：把这一批交给**一个**处理者（走队列，便于测试与运维判断"还有没有在处理"）。
   *
   * 同一批次正在处理（inflightBatches 命中）时不另起一次处理——把窗口留着，
   * 过一小会儿再试。这样后来的记录不会触发第二次采购申请，也不会被丢掉。
   */
  async flushReportBatch(batchNo) {
    const entry = this.pendingReportBatches.get(batchNo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.inflightBatches.has(batchNo)) {
      logInfo('purchase.batch.inflight_deferred', { batch_no: batchNo, pending_count: entry.taskIds.size });
      this.deferReportBatch(batchNo, entry);
      return;
    }
    this.pendingReportBatches.delete(batchNo);
    const taskIds = [...entry.taskIds];
    const batchTaskId = entry.batchTaskId;
    try {
      const result = await this.enqueue(
        'supplier-report-batch',
        batchNo,
        () => this.runReportBatch(batchNo, batchTaskId),
      );
      if (result?.status === 'batch_inflight') {
        // 处理者还在跑：这一批**没有**被处理，绝不能落 completed（那等于丢单）。
        // 把窗口放回去，等处理者跑完再试一次；到那时会走 already_posted 分支补终态。
        logInfo('purchase.batch.inflight_deferred', { batch_no: batchNo, pending_count: taskIds.length });
        this.deferReportBatch(batchNo, entry);
        return;
      }
      for (const id of taskIds) {
        const status = id === batchTaskId && result?.status === 'posted' ? 'posted' : 'completed';
        await this.store.update(id, { status, result }).catch(() => undefined);
      }
    } catch (error) {
      // 整批失败：每个任务都落成可重试的 failed，报单记录的处理状态保持不动
      //（记录状态由 process() 那一路负责，这里绝不标「解析失败」这个终态）。
      for (const id of taskIds) {
        await this.store.update(id, { status: 'failed', error: error.message }).catch(() => undefined);
      }
      logWarn('purchase.batch.failed_retryable', { batch_no: batchNo, error: error.message });
    }
  }

  /**
   * 把一批放回窗口、稍后重试。
   *
   * 用在"同一批已经有处理者在跑"的时候：不另起一次处理，也不把任务落成终态
   *（落了就等于丢单）。若期间已经有新的窗口（新记录到达时开的），把任务并进去，
   * 只留一个定时器。
   */
  deferReportBatch(batchNo, entry) {
    const existing = this.pendingReportBatches.get(batchNo);
    if (existing) {
      for (const id of entry.taskIds) existing.taskIds.add(id);
      if (existing.timer) clearTimeout(existing.timer);
    } else {
      if (entry.timer) clearTimeout(entry.timer);
      this.pendingReportBatches.set(batchNo, entry);
    }
    const target = this.pendingReportBatches.get(batchNo);
    // 重试间隔至少 1 秒：窗口可以配成 0（不等待），但"同一批正在处理"期间的
    // 重试不能跟着变成 0——那会在一次长处理（模型调用几十秒）里空转刷日志。
    const delay = Math.max(this.reportBatchWindowMs, 1000);
    target.timer = setTimeout(() => {
      this.flushReportBatch(batchNo).catch((error) => {
        logError('purchase.batch.flush_failed', { batch_no: batchNo, error: error.message });
      });
    }, delay);
  }

  /**
   * 真正处理一批报货：读该批次号下的全部记录 → 逐条按「采购行为」解析 → 上锁 →
   * 写采购申请/出图/发图/写回附件（复用 confirmPurchaseRequest 整条现成逻辑）。
   *
   * 幂等与不丢单（这一段的全部意义）：
   *   · 处理前重新读表：窗口期间到的记录全部在内，不依赖任务里记了哪些 id；
   *   · 同一批次号用 inflightBatches 上锁，第二个处理者不重入；
   *   · 已经生成过的批次按记录终态挡掉，并给后来的记录补上终态（不然它永远停在待解析）；
   *   · 抛出去的都是真异常（模型抽风、读表失败），由 flushReportBatch 落成可重试的 failed，
   *     报单记录的处理状态**保持不变**——标成终态失败就是静默丢单。
   */
  async runReportBatch(batchNo, batchTaskId) {
    const reportTable = this.gateway.table('purchaseReport');
    const allRecords = await this.gateway.listAll('purchaseReport');
    const batchRecords = allRecords.filter(
      (record) => textValue(record?.fields?.[reportTable.fields.batchNoText]) === batchNo,
    );
    if (batchRecords.length === 0) {
      // 理论上不该发生（刚读过这条记录就有批次号）。抛错而不是静默返回：
      // 抛出去会让任务落成可重试的 failed，重收 webhook 还能救；静默返回等于丢单。
      logWarn('purchase.batch.no_records', { batch_no: batchNo });
      throw new Error(`报货批次号 ${batchNo} 下没有找到任何报单记录`);
    }
    // 「行为管理」一次读表建索引，整批复用：分流要按行为名称/编码判断这条记录是
    // 采购申请还是采购退货。索引里找不到（fake gateway/旧数据）就退回采购申请。
    const behaviorIndex = await this.loadBehaviorIndex();
    const behaviorKindOf = (record) => {
      const fields = record?.fields || {};
      const behaviorRecordId = linkedRecordIds(fields[reportTable.fields.behavior])[0] || '';
      return classifyReportBehavior(behaviorIndex.get(behaviorRecordId));
    };
    // ⚠️ 采购退货**不在归批窗口里处理**（合并 #83 与 #81 时定的归属）：
    // 退货记录由它自己那条链路负责——processSupplierReturn，按实时库存逐尺码扣减
    // 并出「邯美皮鞋采购退货单」。这里必须先把退货记录摘掉，否则同一批次号下只要
    // 有一条采购申请，窗口一开就会按「整批记录」重读，把退货也当成报货明细写一条
    // 「单据信息」（#81 的旧口径），与退货链路重复出单；更糟的是会给它补上
    // 「已生成申请」终态，把本该扣库存的退货链路整个挡在门外。
    const reportRecords = batchRecords.filter(
      (record) => behaviorKindOf(record) !== REPORT_BEHAVIOR.PURCHASE_RETURN,
    );
    if (reportRecords.length === 0) {
      // 整批都是退货：没有任何采购申请要生成。退货记录各自等自己的 webhook 走
      // 退货链路，**绝不能**在这里给它们补终态（补了就等于把退货吞掉）。
      logInfo('purchase.batch.only_returns', { batch_no: batchNo, record_count: batchRecords.length });
      return { status: 'already_posted', batch_no: batchNo, ignored_record_count: 0 };
    }
    // 某条记录一旦已经是终态（或已经关联了采购申请），说明**这一批的申请已经写过了**，
    // 后来的明细不该再触发第二次申请——先摘出去，再给它补上终态。
    const pendingRecords = reportRecords.filter(
      (record) => !this.isReportRecordPosted(record, reportTable),
    );
    if (pendingRecords.length < reportRecords.length) {
      const finalized = await this.markRecordsAsPosted(
        pendingRecords.map((record) => record.record_id),
        reportTable,
      );
      logInfo('purchase.batch.already_posted', {
        batch_no: batchNo,
        posted_record_count: reportRecords.length - pendingRecords.length,
        ignored_record_count: finalized,
      });
      return { status: 'already_posted', batch_no: batchNo, ignored_record_count: finalized };
    }

    const entries = [];
    for (const record of pendingRecords) {
      const fields = record?.fields || {};
      const behaviorIds = linkedRecordIds(fields[reportTable.fields.behavior]);
      const behaviorRecordId = behaviorIds[0] || '';
      const behaviorKind = classifyReportBehavior(behaviorIndex.get(behaviorRecordId));
      entries.push({
        recordId: record.record_id,
        fields,
        detailId: textValue(fields[reportTable.fields.detailId]),
        behaviorRecordId,
        behaviorKind,
        // 按行为分流解析：采购申请 = 尺码 + 数量说明；采购退货 = 数量、无尺码。
        // 解析失败会抛出，由 flushReportBatch 落成可重试的失败——不静默算 0。
        details: await this.parseReportItems(fields, reportTable, behaviorKind),
      });
    }

    // 上锁：同一批次号串行。另一个处理者正在跑就返回 batch_inflight（调用方会
    // 把窗口留着稍后重试），绝不在这里另起一次写入。
    if (this.inflightBatches.has(batchNo)) {
      logInfo('purchase.batch.inflight_ignored', { batch_no: batchNo });
      return { status: 'batch_inflight', batch_no: batchNo };
    }
    this.inflightBatches.add(batchNo);
    try {
      return await this.processSupplierBatch(batchNo, entries, batchTaskId, reportTable);
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
   * 给这一批里还没到终态的报单记录补上终态。
   *
   * 用在「批次早已生成、又有新记录到达」的场景：那些新记录自己不会走到
   * confirmPurchaseRequest（那一批已经处理完了），不补状态的话它们会永远停在
   * 「待解析」，看起来像被漏掉了。
   *
   * ⚠️ 这是**已有的口径**（测试 `批次早已生成：再到达的新明细...` 锁着它）：
   * 迟到的记录补终态、不并进已生成的那份采购申请。本职能改的是"同一批一次处理"，
   * 不改变"批次已生成之后不补写申请"。
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

  /**
   * 把批次草稿发布成采购申请（出图/发图/写回附件都在 confirmPurchaseRequest 里）。
   *
   * entries 是 runReportBatch 已经解析好的明细，这里不再重新解析——每多解析一次
   * 就是多一次模型调用，N 条明细的批次会变成最坏 O(N²)。
   */
  async processSupplierBatch(batchNo, entries, batchTaskId, reportTable = this.gateway.table('purchaseReport')) {
    const productTable = this.gateway.table('product');
    const allItems = [];
    const reportRecordIds = [];
    let supplierRecordId = '';
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
      // ⚠️ 行为记在**每一条明细**上，不能只记批次级的那一个：同一次提交里可能
      // 混着采购申请和采购退货，采购申请行的「采购行为」必须各自正确。
      const behaviorRecordId = entry.behaviorRecordId
        || linkedRecordIds(fields[reportTable.fields.behavior])[0] || '';
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
            behavior_record_id: behaviorRecordId,
            behavior_kind: entry.behaviorKind,
          });
        }
      } catch (error) {
        parseErrors.push(`记录 ${recordId}：${error.message}`);
      }
    }

    if (parseErrors.length > 0) throw new Error(`批次解析存在问题：\n${parseErrors.join('\n')}`);
    if (allItems.length === 0) throw new Error(`报货批次号 ${batchNo} 下没有解析到任何明细`);
    if (!supplierRecordId) throw new Error('无法从货品信息获取供应商，请检查货品的供应商关联字段');

    // 按明细ID→尺码排序（明细ID决定货号展示顺序）。
    // 退货明细没有尺码（size=null），排在同明细的申请行后面即可：Number(null)=0。
    allItems.sort((a, b) => {
      if (String(a.detail_id) !== String(b.detail_id)) return String(a.detail_id).localeCompare(String(b.detail_id));
      return Number(a.size) - Number(b.size);
    });

    const draft = {
      is_batch: true,
      batch_no: batchNo,
      report_record_ids: reportRecordIds,
      supplier_record_id: supplierRecordId,
      behavior_record_id: allItems[0]?.behavior_record_id || '',
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

  /**
   * 采购单要发到哪儿。**配置先行，没有默认值**。
   *
   * 返回 `{ chatId, sandbox, reason }`：
   *   · 配了 `PURCHASE_CHAT_ID` → 发那个群；
   *   · 没配 → sandbox=true，调用方**大声跳过并记日志**，绝不回落到私聊
   *     （业务负责人明确说「不用再看经办人了」，偷偷发私聊会让人以为已经升级到群）。
   *
   * 沙箱是测试用的显式通道（构造时注入 chatId，不读环境变量）：
   * 用 `process.env` 直接判的话，一个进程里并发跑的用例会互相污染。
   */
  resolvePurchaseGroupTarget(options = {}) {
    if (options.sandboxChatId) return { chatId: options.sandboxChatId, sandbox: true, reason: 'sandbox' };
    const chatId = resolvePurchaseChatId();
    if (!chatId) return { chatId: '', sandbox: false, reason: 'chat_id_unconfigured' };
    return { chatId, sandbox: false, reason: 'configured' };
  }

  /**
   * 采购单发到群里时，@那个记录的**经办人** —— 业务负责人明确改的。
   *
   * 为什么不再 @所有人：她要的是"经办人知道这批单子发了"，@所有人是群骚扰；
   * 经办人目前都在这个采购群里，所以直接在群里 @他（不再单独发私聊）。
   *
   * ⚠️ 拿不到经办人 open_id 时**不加 @**（只发正文）：宁可少一个提醒，也不能 @错人，
   *    更不能退回 @所有人。调用方会同时记一条 warn 日志，便于排查"为什么没 @到"。
   */
  mentionOperatorText(operatorOpenId, content) {
    const openId = String(operatorOpenId || '').trim();
    if (!openId) return String(content || '');
    // 飞书文本消息里的 @ 语法：`<at user_id="ou_xxx"></at>`，名字留空由客户端渲染。
    return `<at user_id="${openId}"></at> ${content}`;
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

  /** ② 每过一个间隔补一条「还在识别中」。发不出去只记日志，绝不能影响识别。 */
  async notifyArrivalWaiting(openId, recordId, taskId, attempt) {
    const sent = await this.sendNoticeText(openId, ARRIVAL_WAITING_NOTICE);
    logInfo('purchase.arrival.waiting_notice', { record_id: recordId, task_id: taskId, attempt, sent });
    return sent;
  }

  /** ⑤ 判失败之后结果才到：记录已改回成功、卡片已发，再补一条说明，别让她以为系统错乱。 */
  async notifyArrivalRescued(openId, elapsedMs, recordId, taskId) {
    const sent = await this.sendNoticeText(openId, arrivalRescuedNotice(elapsedMs));
    logInfo('purchase.arrival.timeout.rescued', {
      record_id: recordId, task_id: taskId, elapsed_ms: elapsedMs, sent,
    });
    return sent;
  }

  /**
   * 启动到货「等待与提示」的定时器。调用方**必须**在流程结束时 stop()
   * （正常完成 / 异常 / 迟到结果救回，三条路径都要）。
   *
   * 三个时间点各自的语义——这是本次改造最容易做错的地方，别混：
   *  - 每 `arrivalNoticeIntervalMs`：补一条「还在识别中，请稍等～」，直到
   *    **处理完成 / 判失败 / 到达补发次数上限**为止。注意「2 分钟放弃等待」不在停止条件里，
   *    她的原话是"直到处理完为止"，放弃等待只是我们不再盯着它；
   *  - `arrivalAbandonWaitMs`：**放弃等待 ≠ 失败**。到点只记一条
   *    `purchase.arrival.wait.abandoned` 日志：**不取消识别请求、不写任何失败态**。
   *    请求还在跑，结果回来照常走完匹配/建档/出卡；
   *  - `arrivalFailAfterMs`：这时才判失败（写「识别失败」+ 告诉她原因）。要是结果在
   *    判失败之后才回来，processArrival 会走「迟到结果救回」分支把状态改回成功。
   *
   * 所有定时器都 unref()：补发提示不能拖住进程退出（否则测试跑完还挂在定时器上）。
   *
   * 返回值 `stop()` 会**同步**停掉全部定时器，并返回「停之前是不是已经判过失败」——
   * 调用方必须在写「识别成功」之前调用它，否则失败定时器可能在成功写入之后才开火，
   * 把记录又写回「识别失败」。`failureSettled` 是判失败那一路的落定 Promise，
   * 救回时要先 await 它，保证两边写入的顺序是"先失败、后成功"。
   * `pendingNotice` 是「最后一次补发提示」的 Promise，出卡片之前要等它落地，
   * 免得她先看到卡片、后面才冒出一条「还在识别中」。
   *
   * `startedAt` 由调用方传入"收到"那一刻（定时器本身是写「识别中」之后才启动的，
   * 见 processArrival 里的说明）：时间阈值按她感知到的等待算，文案里的耗时才准。
   */
  startArrivalWaitWatch({ recordId, taskId, operatorOpenId, startedAt = Date.now() }) {
    const watch = {
      startedAt,
      noticeCount: 0,
      abandoned: false,
      failed: false,
      stopped: false,
      failureSettled: null,
      pendingNotice: null,
      stop: () => false,
    };

    const noticeTimer = setInterval(() => {
      if (watch.stopped) return;
      if (watch.noticeCount >= this.arrivalNoticeMaxCount) {
        // 兜底：到上限只记一条日志、不再发消息（避免某条记录永远卡住时无限刷屏），
        // 顺手把定时器停掉，免得每分钟重复记一条同样的日志。
        clearInterval(noticeTimer);
        logWarn('purchase.arrival.wait.notice_capped', {
          record_id: recordId, task_id: taskId, sent_count: watch.noticeCount, max_count: this.arrivalNoticeMaxCount,
        });
        return;
      }
      watch.noticeCount += 1;
      // 不 await：定时器回调里等 IM 会把下一次触发一起推迟。sendNoticeText 自己吞异常，
      // 这里再兜一层，保证定时器永远不会因为一条提示发不出去而中断。
      watch.pendingNotice = this.notifyArrivalWaiting(operatorOpenId, recordId, taskId, watch.noticeCount).catch(() => undefined);
    }, this.arrivalNoticeIntervalMs);

    const abandonTimer = setTimeout(() => {
      if (watch.stopped) return;
      watch.abandoned = true;
      // ⚠️ 核心约束：这里**只有一条日志**。放弃等待不是失败——不取消识别请求、
      // 不写失败态；请求继续在跑，结果回来照常处理。把这句写进日志，
      // 排查的人一眼就能看懂当时到底发生了什么，而不是靠猜。
      logInfo('purchase.arrival.wait.abandoned', {
        record_id: recordId, task_id: taskId, waited_ms: Date.now() - watch.startedAt,
        note: '不再等待识别结果，但识别请求继续跑，结果回来仍会照常处理，不判失败',
      });
    }, this.arrivalAbandonWaitMs);

    const failTimer = setTimeout(() => {
      if (watch.stopped || watch.failed) return;
      // 先**同步**置位 failed，再开始异步写状态/发消息：processArrival 结束时只要看到
      // failed 就走「救回」分支，不会出现"判了失败却没人把状态改回来"。
      watch.failed = true;
      watch.failureSettled = this.failArrival(
        taskId, recordId, new TimeoutError('到货图片识别', this.arrivalFailAfterMs),
      ).catch((error) => {
        logWarn('purchase.arrival.wait.fail_failed', { record_id: recordId, task_id: taskId, error: error.message });
      });
    }, this.arrivalFailAfterMs);

    for (const timer of [noticeTimer, abandonTimer, failTimer]) {
      if (typeof timer.unref === 'function') timer.unref();
    }

    watch.stop = () => {
      if (watch.stopped) return watch.failed;
      watch.stopped = true;
      clearInterval(noticeTimer);
      clearTimeout(abandonTimer);
      clearTimeout(failTimer);
      this.arrivalWaits.delete(watch);
      return watch.failed;
    };
    this.arrivalWaits.add(watch);
    return watch;
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
   *
   * `receiveIdType` 默认为 open_id（私聊那条路今天仍在用：到货异常告知）；采购单发到群时
   * 由调用方传 `chat_id`（参数名必须跟着 receive_id 的实际类型走，不能写死 open_id）。
   *
   * 返回 `{ imageKey, messageId, threadId }`：采购单发到群之后要把 message_id / thread_id
   * 记进映射，供「话题里的消息 / 引用那条消息 → 是哪一批」反查（见 PurchaseBatchLocator）。
   * `threadId` 只有话题群（或飞书已经给这条消息开了话题）才有值，普通群是空串——
   * 那种情况由定位器在她第一次回复时补记，不影响定位。
   */
  async sendImage(openId, imageBuffer, receiveIdType = 'open_id') {
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
      params: { receive_id_type: receiveIdType },
      data: { receive_id: openId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    });
    if (response.code !== 0) throw new Error(`发送采购申请图片失败: ${response.msg} (Code: ${response.code})`);
    return {
      imageKey,
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
  }

  /**
   * 发一条纯文字。返回 `{ messageId, threadId }`。
   *
   * ⚠️ 返回值从"messageId 字符串"改成对象，是为了把 `thread_id` 一起带出来记映射
   * （话题里后续消息只带 thread_id，不带 parent_id）。本类里只有采购单发到群那一个
   * 调用点，已同步改成解构 `{ messageId, threadId }`。
   */
  async sendText(openId, content, receiveIdType = 'open_id') {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送说明');
    const response = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: content }) },
    });
    if (response.code !== 0) throw new Error(`发送采购申请说明失败: ${response.msg} (Code: ${response.code})`);
    return {
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
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
  async deliverSupplierImages(taskId, task, posting = {}, options = {}) {
    try {
      return await this.deliverSupplierImagesInner(taskId, task, posting, options);
    } catch (error) {
      // 兜底：调用方是"采购事实已经写完"的收尾流程，这里漏出去的异常会把任务判成 failed。
      logError('purchase.request.image.delivery_failed', { task_id: taskId, error: error.message });
      return { sent: [], failed: [{ supplier: '', error: error.message }] };
    }
  }

  // options.title / options.fileNameSuffix：采购退货单与采购申请单共用这一整条
  // 「按供应商出图 → 发到群 → 写回附件」的流程，只有标题和文件名不同（口径就是"格式一样"）。
  async deliverSupplierImagesInner(taskId, task, posting = {}, options = {}) {
    const draft = task?.draft || {};
    const items = draft.items || [];
    if (!items.length) return { sent: [], failed: [] };
    // ⚠️ 采购单**只发群**（业务负责人：「不用再看经办人了」）。
    // operator_open_id 仍然留着——它是「这条记录是谁报的」，用于到货异常告知、
    // 以及权限判断，不再决定采购单发到哪儿。
    const operatorOpenId = draft.operator_open_id;
    const target = this.resolvePurchaseGroupTarget(options);
    if (!target.chatId) {
      // **大声跳过**：不静默、不回落到私聊。这条日志就是排查入口——
      // 线上看到它 = 环境变量 PURCHASE_CHAT_ID 没配，采购单已经写成但图没发出去。
      logWarn('purchase.request.image.skipped', {
        task_id: taskId,
        reason: 'purchase_chat_id_unconfigured',
        env: 'PURCHASE_CHAT_ID',
        operator_open_id: operatorOpenId,
        hint: '未配置采购群，采购申请已生成但图与说明未发送；配好后可按 task 补发',
      });
      return { sent: [], failed: [], skipped: 'chat_id_unconfigured' };
    }
    const sent = [];
    const failed = [];
    // 发到群里的每条消息的 message_id / thread_id：记进本地映射，
    // 供「话题里的消息 / 引用那条消息 → 是哪一批」反查。
    const groupMessages = [];
    if (!operatorOpenId) {
      // 经办人没解析出来（报单记录没填/字段映射缺失）：照发正文，只是不 @ 人。
      // 记 warn 是为了排查"为什么这批单子没 @到经办人"，绝不退回 @所有人。
      logWarn('purchase.request.image.operator_missing', {
        task_id: taskId, chat_id: target.chatId, hint: '未解析出经办人 open_id，这条群消息不会 @任何人',
      });
    }
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
          // 不传就是采购申请单（渲染器里的默认标题），退货传「邯美皮鞋采购退货单」。
          title: options.title,
        });
        const imageResult = await this.sendImage(target.chatId, png, 'chat_id');
        // 图单独一条、文字带 @经办人 单独一条：飞书图片消息没有正文，
        // @ 只能挂在文字那条上（业务负责人明确要 @经办人，不再是 @所有人）。
        const textResult = await this.sendText(
          target.chatId,
          this.mentionOperatorText(operatorOpenId, `${label} 这批 ${rowCount} 条（共 ${totalPairs} 双），图可以直接转给供应商。`),
          'chat_id',
        );
        groupMessages.push(
          { messageId: imageResult.messageId, threadId: imageResult.threadId },
          { messageId: textResult.messageId, threadId: textResult.threadId },
        );
        // 业务负责人要据此测试：发出去那一刻就把「哪个群 / 哪一批 / 哪条消息 / 哪个话题」记全。
        logInfo('purchase.request.image.group_sent', {
          task_id: taskId, chat_id: target.chatId,
          batch_no: posting.batch_no || draft.batch_no || '', supplier: label,
          operator_open_id: operatorOpenId || '',
          image_message_id: imageResult.messageId, image_thread_id: imageResult.threadId,
          text_message_id: textResult.messageId, text_thread_id: textResult.threadId,
        });
      } catch (error) {
        failed.push({ supplier: label, error: error.message });
        logError('purchase.request.image.send_failed', {
          task_id: taskId, supplier: label, chat_id: target.chatId, error: error.message,
        });
        // 图没发出去就不写附件：保持"先发图、再写回"的顺序，留下人工补发的余地。
        continue;
      }
      const requestRecordIds = group.indexes
        .map((index) => posting.request_id_by_item_key?.[`${taskId}:${index}`])
        .filter(Boolean);
      try {
        const written = await this.writeSupplierImageAttachment({
          taskId, supplierName: label, png, requestRecordIds,
          fileNameSuffix: options.fileNameSuffix,
        });
        if (written?.written) logInfo('purchase.request.image.attachment_written', { task_id: taskId, ...written });
      } catch (error) {
        // 只告警：她已经有图了。
        logWarn('purchase.request.image.attachment_write_failed', { task_id: taskId, supplier: label, error: error.message });
      }
      sent.push(label);
    }

    // 「这条消息 / 这条话题 ↔ 是哪一批」的映射：**发完就记**，失败只告警。
    // 记不上只影响 C 的定位（她会被告知"认不出"），绝不能让采购单已经发出去之后
    // 再把任务判成失败。
    const batchNo = posting.batch_no || draft.batch_no || '';
    for (const { messageId, threadId } of groupMessages.filter((item) => item.messageId)) {
      try {
        await this.batchLocator.rememberGroupMessage({
          batchNo,
          messageId,
          threadId,
          chatId: target.chatId,
          suppliers: sent,
          requestIds: posting.request_ids || [],
          detailCount: items.length,
        });
      } catch (error) {
        logWarn('purchase.request.image.batch_mapping_failed', {
          task_id: taskId, message_id: messageId, chat_id: target.chatId,
          batch_no: batchNo, error: error.message,
        });
      }
    }

    const summary = { sent, failed, chat_id: target.chatId };
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
   * 把某个供应商的采购申请图（或采购退货单图）写进「单据信息」的附件字段。
   *
   * 规则（产品负责人明确给的）：
   * - 同一「报货批次」+ 同一「供应商」只写一条 → 写进「明细ID」最小的那条记录；
   * - 重复执行（重跑批次）不得写出第二条 → 目标记录已经有附件就跳过，连上传都不做。
   *
   * 为什么按「明细ID」而不是数组下标挑：明细ID 是飞书 auto_number，写入即定，
   * 而 posting_plan 的数组顺序、远端返回顺序在重试之后都可能变。
   *
   * 「采购退货单」走同一个方法：它的单据信息行也是按同样的规则挑最早那条，
   * 附件字段也是同一个（表已改名为「单据信息」，定位就是给供应商开图片的依据）。
   */
  async writeSupplierImageAttachment({ taskId, supplierName, png, requestRecordIds, fileNameSuffix = '采购申请' }) {
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
      const filePath = path.join(tempDir, `${safeName}-${fileNameSuffix}.png`);
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
    const behaviorRecordId = behaviorIds[0] || '';
    // 单条路径也按「采购行为」分流：采购申请（尺码+数量说明）/ 采购退货（数量，无尺码）。
    // 不这样做的话，一条没有批次号的退货记录会在"必须选尺码"这一步炸掉。
    const behaviorKind = classifyReportBehavior((await this.loadBehaviorIndex()).get(behaviorRecordId));
    // 从货品信息表的供应商关联字段直接获取供应商 record_id
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    if (productSupplierIds.length === 0) throw new Error('货品信息中未关联供应商，请先在货品信息中设置供应商');
    const supplierRecordId = productSupplierIds[0];
    const parsed = await this.parseReportItems(fields, table, behaviorKind);
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
      behavior_record_id: behaviorRecordId,
      behavior_kind: behaviorKind,
    }));
    const draft = {
      report_record_id: recordId,
      product_record_id: product.recordId,
      product_number: productInfo.number,
      supplier_record_id: supplierRecordId,
      behavior_record_id: behaviorRecordId,
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
   * 这条「供应商对接」记录是采购申请还是采购退货（见 purchaseReportBehaviorPolicy）。
   *
   * 读行为记录失败/行为没填/名称不认识 → 一律按**采购申请**处理：那是这条链路今天的行为，
   * 也是"读不到信息时唯一不发明业务规则"的选择。宁可退回现状，也不把普通报货当成退货。
   */
  async readReportBehaviorKind(recordId) {
    const table = this.gateway.table('purchaseReport');
    const behaviorTable = this.gateway.table('behavior');
    const record = await this.gateway.get('purchaseReport', recordId);
    const ids = linkedRecordIds(record?.fields?.[table.fields.behavior]);
    if (!ids.length) return REPORT_BEHAVIOR.PURCHASE_REQUEST;
    let readFailed = false;
    for (const behaviorId of ids) {
      const behavior = await this.gateway.get('behavior', behaviorId).catch(() => {
        readFailed = true;
        return null;
      });
      const kind = classifyReportBehavior({
        name: textValue(behavior?.fields?.[behaviorTable.fields.name]),
        code: textValue(behavior?.fields?.[behaviorTable.fields.code]),
      });
      if (kind === REPORT_BEHAVIOR.PURCHASE_RETURN) return kind;
    }
    if (readFailed) logWarn('purchase.report.behavior_unreadable', { record_id: recordId });
    return REPORT_BEHAVIOR.PURCHASE_REQUEST;
  }

  /**
   * 退货核对：**只读 + 只算，不写任何东西**（业务负责人 2026-10-05 的口径）。
   *
   *   A. 只填数量（没有尺码）→ 该 货号+颜色 全退
   *      · 核对所填数量 vs 该 货号+颜色 在「实时库存」里的**总数**
   *      · ⚠️ **不看形态、不看所属状态**：样品 + 门盒 + 仓库（"仓库"=非当季在售）全部加总
   *   B. 填了尺码 + 数量 → 按 货号+颜色+尺码 去「实时库存」里找
   *
   *   数量对得上 → 这些行**全部**退掉（顺序无关）
   *   数量对不上 → 「能对上的就处理，不能对上的就说这部分对不上」
   *                = 退 min(她填的数量, 库存里有的)，差额交给调用方告诉她
   *
   * 取哪几行的顺序：对得上时是"全部"，顺序只影响日志；对不上时按 record_id 排，
   * 让同一份输入永远得到同一份计划（重试/人工核对时可比对）。
   * 状态**一律不过滤**——这是这条链路和销售出库最关键的区别（销售只吃门盒+样品）。
   */
  async planPurchaseReturn({ productRecordId, declared, size = null }) {
    const liveTable = this.gateway.table('liveInventory');
    const sizeField = liveTable.fields.size;
    // 尺码用关联 record_id 比较（B 情况），不逐个解析成整数：这样别的坏行
    // （尺码关联为空的那种）不会把整条退货链路拖挂，只在真正要退它时才暴露。
    const sizeRecordId = size === null
      ? ''
      : (await this.getSizeReferences().resolveByNumber(size)).recordId;
    const matching = [];
    for (const record of await this.gateway.listAll('liveInventory')) {
      if (!linkedRecordIds(record.fields?.[liveTable.fields.product]).includes(productRecordId)) continue;
      if (sizeRecordId && !linkedRecordIds(record.fields?.[sizeField]).includes(sizeRecordId)) continue;
      matching.push(record.record_id);
    }
    matching.sort((left, right) => String(left).localeCompare(String(right)));
    const take = matching.slice(0, Math.min(declared, matching.length));
    const bySize = new Map();
    for (const recordId of take) {
      const liveRecord = await this.gateway.get('liveInventory', recordId);
      // 这里读不出尺码就抛错（可重试的失败）：要退的这一双说不清是什么尺码，
      // 就写不出对应的「单据信息」行，也不能拍一个尺码了事。
      const linked = await this.getSizeReferences().resolveLinkedCell(liveRecord?.fields?.[sizeField]);
      bySize.set(linked.size, (bySize.get(linked.size) || 0) + 1);
    }
    const sizes = [...bySize.entries()]
      .map(([entrySize, quantity]) => ({ size: entrySize, quantity }))
      .sort((left, right) => left.size - right.size);
    return {
      declared,
      size,
      available: matching.length,
      taken: take.length,
      sizes,
      // 正数 = 库存比她说得少（退不全）；负数（surplus） = 库存比她说得多（还有没退的）。
      shortfall: Math.max(0, declared - take.length),
      surplus: Math.max(0, matching.length - take.length),
    };
  }

  /**
   * 退货核对计划**只算一次**，以后重试都复用落盘的那一份。
   *
   * 为什么必须冻结（和采购申请的 ensurePostingPlan 同一个理由，这里后果更严重）：
   * 核对是拿"她填的数量"去比"当前实时库存里的行"。第一次跑已经把行删掉了，
   * 重试时再算一遍会看到**剩下的**行，然后删掉另一批——库存被多扣，而且多扣的那几双
   * 在业务上完全看不出来（每一条流水都"有来源、有数量"）。冻结之后复跑用的是同一批
   * 尺码和同样的数量，配上"库存操作的 operationId 由单据信息行决定"，复跑是真正的空操作。
   */
  async ensureReturnPlan(taskId, task, input) {
    if (task?.return_plan?.version === 1) return task.return_plan;
    const plan = await this.planPurchaseReturn(input);
    const updated = await this.store.update(taskId, { return_plan: { version: 1, ...plan } });
    return updated.return_plan;
  }

  /**
   * 采购退货链路（业务负责人的完整口径）：
   *
   *   ① 「供应商对接」填表单（编号 + 数量，退货不填尺码）→ 数据是确定性的 → **免确认**
   *   ② 「采购行为」= 采购退货 → 走这条分支
   *   ③ **不再走「采购到货」和「采购入库」**
   *   ④ 直接扣「实时库存」并写「库存流水」（库存行为 = 采购减少 STOCK_PURCHASE_DECREASE）
   *   ⑤ 出图：标题「邯美皮鞋采购退货单」，格式与采购申请单一样
   *   ⑥ 受影响的表只有 4 张：供应商对接 · 单据信息 · 库存流水 · 实时库存（不碰资金）
   *
   * 落库顺序：**先写「单据信息」（拿到记录 id）→ 再用它当库存操作的来源 → 最后出图**。
   * 库存操作的幂等键就是「单据信息」行的 record_id（`operationId(kind, sourceRecordId)`），
   * 而那一行本身由 createOnceByKey 按「幂等键」列保证只写一条，所以重跑拿到的是同一个 id、
   * 同一个库存操作——不会第二次扣库存（已完成的操作用例直接返回上次的结果）。
   *
   * 数量对不上时**尽力处理 + 把差额告诉她**（见 buildPurchaseReturnNotice），
   * 绝不"一处不对就整单不动"。
   */
  async processSupplierReturn(recordId, taskId, task = {}) {
    const table = this.gateway.table('purchaseReport');
    const productTable = this.gateway.table('product');
    const record = await this.gateway.get('purchaseReport', recordId);
    const fields = record?.fields || {};
    const status = textValue(fields[table.fields.status]);
    // 终态挡重复：飞书重投、双击、并发到达时不能把同一批退货扣两遍。
    // （真正扣库存的幂等还有一层：库存操作的 operationId 由「单据信息」行 id 决定。）
    if (['已生成申请', '已取消'].includes(status)) return { ignored: true, status };
    const productIds = linkedRecordIds(fields[table.fields.product]);
    if (productIds.length !== 1) throw new Error('供应商对接必须关联一个货品编号');
    // 供应商沿用采购申请那条的取法：从货品信息的供应商关联字段读，
    // 不新增表字段，也不让她在退货表单里再填一遍（见待确认项）。
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    if (productSupplierIds.length === 0) throw new Error('货品信息中未关联供应商，请先在货品信息中设置供应商');
    const supplierRecordId = productSupplierIds[0];
    const productInfo = this.productDisplayInfo(product.record, productTable);
    const operatorOpenId = this.recordOperator(record, table.fields.operator);
    const behaviorRecordId = linkedRecordIds(fields[table.fields.behavior])[0] || '';
    const declared = parseReturnQuantity(fields[table.fields.quantity]);
    // 「尺码」在表里是单选关联。**空值不是错误**：A 情况（只填数量）本来就不填尺码——
    // 用 resolveLinkedCells 会在空关联上抛「尺码关联字段为空」，把 A 情况整条挡住。
    const linkedSizeIds = linkedRecordIds(fields[table.fields.size]);
    if (linkedSizeIds.length > 1) {
      // 正常最多一个。真出现多个说明字段被改成了多选：一个数量摊不到多个尺码上，
      // 停下来告诉她，绝不替她分配。
      const names = (await this.getSizeReferences().resolveLinkedCells(fields[table.fields.size]))
        .map((item) => item.size).join('、');
      throw new Error(`采购退货的「尺码」只能选一个（现在是 ${names}），请拆成多条记录`);
    }
    const size = linkedSizeIds.length === 1
      ? (await this.getSizeReferences().resolveLinkedCell(fields[table.fields.size])).size
      : null;
    const plan = await this.ensureReturnPlan(taskId, task, { productRecordId: product.recordId, declared, size });
    const items = plan.sizes.map((entry) => ({
      item_no: productInfo.itemNo,
      color: productInfo.color,
      size: entry.size,
      quantity: entry.quantity,
      product_record_id: product.recordId,
      supplier_record_id: supplierRecordId,
      report_record_id: recordId,
    }));
    const draft = {
      is_return: true,
      report_record_id: recordId,
      product_record_id: product.recordId,
      product_number: productInfo.number,
      supplier_record_id: supplierRecordId,
      behavior_record_id: behaviorRecordId,
      operator_open_id: operatorOpenId,
      // 图上那一行「报货批次」用她表单里填的批次号文本（单据信息行的批次关联是
      // 指向「报货批次」表的，退货不建那张表——见交付说明的待确认项）。
      batch_no: textValue(fields[table.fields.batchNoText]),
      items,
      return_plan: plan,
    };
    let updated = await this.store.update(taskId, { draft, return_plan: plan });
    const progress = { returns: {} };
    const docIds = [];
    // 逐尺码处理：一个尺码一行「单据信息」、一次库存操作。
    // 一行一个来源是必须的——库存操作的幂等键就是来源行的 record_id，多个尺码共用一个
    // 来源就不会各自拿到自己的 operationId。
    for (const entry of plan.sizes) {
      const sizeReference = await this.getSizeReferences().resolveByNumber(entry.size);
      const docKey = `purchase_return:${recordId}:${entry.size}`;
      const doc = await createOnceByKey({
        gateway: this.gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: docKey,
        label: `采购退货单 ${recordId} ${entry.size}码`,
        values: {
          behavior: relation(behaviorRecordId),
          product: relation(product.recordId),
          size: relation(sizeReference.recordId),
          quantity: entry.quantity,
          idempotencyKey: docKey,
        },
      });
      docIds.push(doc.recordId);
      progress.returns[String(entry.size)] = doc.recordId;
      updated = await this.store.update(taskId, { posting_progress: progress, posting_stage: `return_doc:${entry.size}` });
      // 扣库存：走 InventoryService.applyChange（不另写一套库存逻辑）。
      // state 只用于本地任务键（同货品+尺码串行/恢复）；真正扣哪些状态由注册表
      // STOCK_PURCHASE_DECREASE 的 consumes 决定 = 门盒 + 样品 + 仓库。
      const change = await this.inventory.applyChange({
        kind: MOVEMENT_PURCHASE_DECREASE,
        productRecordId: product.recordId,
        size: entry.size,
        state: '门盒',
        quantity: entry.quantity,
        sourceRecordId: doc.recordId,
        occurredAt: Date.now(),
      });
      logInfo('purchase.return.stock_applied', {
        record_id: recordId, task_id: taskId, size: entry.size, quantity: entry.quantity,
        doc_id: doc.recordId, ledger_record_id: change?.ledgerRecordId || '', live_record_ids: change?.liveRecordIds || [],
      });
    }

    if (docIds.length) {
      // 报单记录的处理状态：沿用采购申请那条的终态「已生成申请」——行为管理里
      // 只有这一套终态可复用（另加一个「已退货」选项要动她的表，超出本次口径）。
      // 顺带把「关联采购申请」指向刚写的单据信息行，两个方向都可追溯。
      await this.gateway.update('purchaseReport', recordId, {
        status: '已生成申请',
        request: docIds,
      }).catch((error) => logWarn('purchase.return.report_status.failed', {
        record_id: recordId, task_id: taskId, error: error.message,
      }));
      // 出图 → 发给她 → 写回附件（复用采购申请那条完全相同的流程，只换标题）。
      const posting = {
        request_ids: docIds,
        request_id_by_item_key: Object.fromEntries(
          items.map((item, index) => [`${taskId}:${index}`, progress.returns[String(item.size)]]),
        ),
        batch_no: draft.batch_no,
      };
      updated = await this.store.update(taskId, { request_ids: docIds });
      await this.deliverSupplierImages(taskId, updated, posting, {
        title: RETURN_TITLE,
        fileNameSuffix: '采购退货单',
      });
    }

    // 差额/没对上的情况必须说出来——「对不上的就说这部分对不上」。
    // 对得上时不发（图本身就是回执），免得刷屏。
    const notice = buildPurchaseReturnNotice({
      itemNo: productInfo.itemNo, color: productInfo.color, size: plan.size, plan,
    });
    if (notice) {
      const sent = await this.sendNoticeText(operatorOpenId, notice);
      logInfo('purchase.return.notice', {
        record_id: recordId, task_id: taskId, declared: plan.declared, available: plan.available,
        taken: plan.taken, shortfall: plan.shortfall, surplus: plan.surplus, sent,
      });
    }
    logInfo('purchase.return.posted', {
      record_id: recordId, task_id: taskId, declared: plan.declared, available: plan.available,
      taken: plan.taken, size_count: plan.sizes.length, doc_count: docIds.length,
    });
    return {
      status: 'posted',
      is_return: true,
      declared: plan.declared,
      available: plan.available,
      taken: plan.taken,
      shortfall: plan.shortfall,
      surplus: plan.surplus,
      doc_ids: docIds,
    };
  }

  /**
   * 到货明细 → 货品记录。**只匹配，不建档。**
   *
   * ⚠️ 建档不在这里做。产品负责人 2026-10-05 定的顺序是：「发确认卡片之前不做创建的举动，
   * 而是在发完之后同步做，然后用户点确认之后再给到创建好的链接」。所以匹配不到货品时
   * 这里只把这一行标成待建档（pending: true），实际建档交给发完卡片之后的
   * ensureArrivalProducts（幂等、可重试，见那里的注释）。
   *
   * 「货号+颜色命中多条」（男/女鞋常共用货号）仍然不是错误：匹配器取第一条，这里把
   * 条数带回草稿，卡片上标注"匹配到 N 条、已取哪条"，她看得见就行。
   */
  async resolveArrivalProduct(raw) {
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
      return { product, pending: false, ambiguous };
    } catch (error) {
      if (error.code !== 'PRODUCT_NOT_FOUND') throw error;
      // 货品表里没有 = 新品。这个判断在建档之前就有（匹配时就知道），
      // 所以卡片可以先把"哪些货号是新品"标出来，完全不依赖建档结果。
      return { product: null, pending: true, ambiguous: null };
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
   * ⚠️ 只由 ensureArrivalProducts 调用，也就是**发完确认卡片之后**（含她点确认时的兜底重试）。
   * 别把它挪回匹配那一步：产品负责人 2026-10-05 定的顺序是"发卡片之前不做创建"。
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
    // 不要再建第二条——这就是"重复建档只建一条"的落点。
    if (cached) {
      // 从上次重试恢复出来的条目还没有回读数据：补一次回读（只有日志/草稿用得上）。
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
    // 回读失败不影响入库；这些缺口现在只进日志和草稿，不再上卡片
    //（产品负责人：卡片上不写"还差什么字段"）。
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
   * 到货新品建档 + 到货单价格写成本。**发完确认卡片之后**才跑；她点确认时再兜底跑一次。
   *
   * 为什么挪到卡片之后：产品负责人 2026-10-05 的口径是「发确认卡片之前不做创建的举动，
   * 而是在发完之后同步做，然后用户点确认之后再给到创建好的链接」。卡片本身只需要
   * "知道哪些货号是新品"（匹配时就知道），不需要货品记录真的存在，所以顺序可以这么排。
   *
   * 幂等（三道，缺一不可）：
   *   ① 同一个 taskId 的两次调用走 creationQueue **串行**——后台那次和她点确认那次
   *      不会同时从任务里读到"还没建"然后各建一条；
   *   ② buildArrivalCreationContext 从任务里恢复上次已建的 record_id
   *      （arrival_created_products 每建一条就落盘），重试时 ensureArrivalProduct
   *      命中缓存直接返回，**不建第二条货品**；
   *   ③ 颜色的去重靠颜色表整表读一次 + normalizeColor（同名颜色只建一条）。
   *
   * 失败处理：建档失败**不抛**（只有 store 坏了才抛），改成把 creation_state='failed'
   * 和原因写进草稿——确认那一步据此明确告诉她，并且再点一次就能重试。
   * 成本写失败**不算建档失败**（既有的规则：成本写不进去不挡入库，只记 warn）。
   *
   * @returns {Promise<{state: 'done'|'failed', created: number, cost_written_count: number, failures: Array}>}
   */
  async ensureArrivalProducts(taskId, options = {}) {
    return this.creationQueue.run(taskId, async () => {
      const task = await this.store.get(taskId);
      const draft = task?.draft;
      if (!draft) throw new Error('采购到货草稿不存在或已过期');
      const pending = Array.isArray(draft.pending_creation) ? draft.pending_creation : [];
      const productTable = this.gateway.table('product');
      const context = this.buildArrivalCreationContext(task);
      // 价格计划按**识别结果**重建（它随任务一起落盘了）：建档顺带写成本、老货品补成本，
      // 两条路用的是同一份计划，规则仍然是"同货号价格冲突就整条不写"。
      context.arrivalCostPlan = buildArrivalCostPlan(task.recognized || []);

      const failures = [];
      for (const entry of pending) {
        try {
          await this.ensureArrivalProduct(entry, context);
        } catch (error) {
          failures.push({ item_no: entry.item_no, color: entry.color, error: error.message });
          logWarn('purchase.arrival.product_create_failed', {
            task_id: taskId, item_no: entry.item_no, color: entry.color, error: error.message,
          });
        }
      }

      // 已经匹配到老货品的行：成本同样只在卡片发出之后写（"发卡片之前不写成本"）。
      // 按 货号+颜色+货品 去重，免得同一货品的每个尺码各读一次表。
      const costSeen = new Set();
      for (const item of draft.actual || []) {
        if (item.created_product || !item.product_record_id) continue; // 新品的成本在建档时一起写了
        const key = `${item.item_no}|${item.color}|${item.product_record_id}`;
        if (costSeen.has(key)) continue;
        costSeen.add(key);
        try {
          const record = await this.gateway.get('product', item.product_record_id).catch(() => null);
          await this.applyArrivalCost(item, { recordId: item.product_record_id, record }, productTable, context);
        } catch (error) {
          // 成本这条线故意不算进 failures：写不进去不该把她挡在入库外面（见 applyArrivalCost 注释）。
          logWarn('purchase.arrival.cost_write_failed', {
            task_id: taskId, item_no: item.item_no, product_record_id: item.product_record_id, error: error.message,
          });
        }
      }

      // 建档结果直接从缓存取（含上一次重试已经建好、本次识别里不再出现的条目）。
      // 恢复出来的条目没有回读数据：缺口按"读不到"处理（这些字段现在只进日志/草稿，
      // 不再上卡片——卡片上不写"还差什么"，见 larkCards.purchaseArrivalDetailCard）。
      const createdEntries = [...context.productCache.values()];
      for (const entry of createdEntries) {
        if (!entry.gaps) entry.gaps = productInfoGaps(entry.record, productTable);
      }
      const createdProducts = createdEntries.map((entry) => ({
        product_record_id: entry.recordId,
        item_no: entry.item_no,
        color: entry.color,
        supplier: entry.supplier,
        label: entry.label,
        color_created: entry.color_created,
        missing: entry.gaps.missing,
        missing_sample_image: entry.gaps.missingSampleImage,
        completeness_readable: entry.gaps.completeness_readable,
        // 链接回填到草稿：她点确认之后的结果卡片就用它（她点进去补资料）。
        url: productRecordUrl(productTable.tableId, entry.recordId),
      }));

      // 合并进**最新**草稿，不整份覆盖：她可能正好在这期间点了确认，
      // 那一侧会往草稿里写 inbound_created，覆盖掉就等于把入库进度和链接一起冲没了。
      const latest = (await this.store.get(taskId)) || task;
      const creationError = failures.length
        ? failures.map((item) => `${item.item_no || ''}${item.color || ''}：${item.error}`).join('；')
        : '';
      const nextDraft = {
        ...latest.draft,
        created_products: createdProducts,
        created_colors: context.createdColors.map((item) => item.name),
        creation_state: failures.length ? 'failed' : 'done',
        creation_error: creationError,
      };
      await this.store.update(taskId, { draft: nextDraft });
      logInfo('purchase.arrival.creation.finished', {
        task_id: taskId, reason: options.reason || 'unknown', state: nextDraft.creation_state,
        pending_count: pending.length, created_product_count: createdProducts.length,
        created_color_count: nextDraft.created_colors.length,
        cost_written_count: context.costWritten.length, failure_count: failures.length,
      });
      return {
        state: nextDraft.creation_state,
        created: createdProducts.length,
        cost_written_count: context.costWritten.length,
        failures,
      };
    });
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
   *
   * 等待与提示这一段（她 2026-10-05 定的规则，阈值全部可配，见 startArrivalWaitWatch）：
   *   ① 收到 → 立刻「收到到货申请，正在识别图片～」（和写「识别中」并行）
   *   ② 每 1 分钟 → 补发「还在识别中，请稍等～」，直到处理完成 / 判失败 / 到达次数上限
   *   ③ 2 分钟 → 放弃等待（**只记日志，不判失败、不取消请求**），结果回来照常处理
   *   ④ 请求报错 → 判失败（process() 的统一出口）+ 告诉她原因
   *   ⑤ 3 分钟 → 判失败；若结果之后才到 → 状态改回成功 + 卡片 + 说明
   *   ⑥ 处理完成 → 出卡片，且不再补发提示
   * 这套逻辑只包住"等待与提示"，匹配/建档/成本/出卡/入库仍全是原逻辑。
   */
  async processArrival(recordId, taskId) {
    const table = this.gateway.table('purchaseArrival');
    // 读这一条记录实测要几秒——单独记一笔，别和后面的耗时混在一起。
    const readStartedAt = Date.now();
    const record = await this.gateway.get('purchaseArrival', recordId);
    logInfo('purchase.arrival.record.read', {
      record_id: recordId, task_id: taskId, duration_ms: Date.now() - readStartedAt,
    });
    const fields = record?.fields || {};
    const currentStatus = textValue(fields[table.fields.confirmStatus]);
    if (['已确认', '已入库', '已取消'].includes(currentStatus)) return { ignored: true, status: currentStatus };
    // 经办人先算出来并落盘：后面无论在哪一步失败，失败提示都还找得到人。
    const operatorOpenId = this.recordOperator(record, table.fields.inspector);
    await this.store.update(taskId, { arrival_operator_open_id: operatorOpenId }).catch(() => undefined);
    const isDocument = textValue(fields[table.fields.type]).trim() === '到货单';
    const tokens = attachmentTokens(fields[table.fields.images]);
    if (!tokens.length) {
      throw new Error(isDocument ? '采购到货记录没有到货单图片附件' : '采购到货记录没有鞋盒图片附件');
    }
    // 确认有图片、马上要开始处理了，先回一句「收到了」。
    //
    // 顺序很要紧：**发提示要排在「下载图片」「模型识别」之前**。
    // 写状态本身要 2 秒、下载和识别要几十秒到几分钟——2026-10-05 用户实测
    // 从记录进来到收到提示用了 10 秒，其中大头是读记录 8 秒 + 写状态 2 秒；
    // 提示早一秒，她就少一秒"系统是不是没反应"。
    // 发不出去也不影响识别（sendNoticeText 只记日志）。
    //
    // ② 的「写识别中」和「发提示」**并行**：两者都只依赖上面读到的这条记录，互不依赖。
    // 串行的话要多等一次 IM 往返；Promise.all 把这段压到"较慢的那个"。
    // 两个 prompt 各自吞自己的异常（发提示失败不影响写状态，反之由 process() 的
    // 失败出口统一收尾），所以 Promise.all 只会在"写状态"失败时 reject——和改之前一致。
    const noticeStartedAt = Date.now();
    let tempDir = '';
    let wait = null;
    try {
      await Promise.all([
        this.notifyArrivalReceived(operatorOpenId, recordId, taskId),
        this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别中', failureReason: '' }),
      ]);
      logInfo('purchase.arrival.notice.latency', {
        record_id: recordId, task_id: taskId, duration_ms: Date.now() - noticeStartedAt,
      });
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-arrival-'));
      // ⚠️ 等待定时器放在「识别中」**写完**之后才启动，不是图省事：失败定时器一旦开火就会写
      // 「识别失败」，如果它比「识别中」那次写入还早，后写的「识别中」会把失败态盖掉，
      // 记录就永远停在「识别中」（识别再报错时 process() 已经按"判过失败"跳过通知）。
      // startedAt 仍按她感知到的"收到"那一刻算，所以耗时文案和产品语义都不变。
      wait = this.startArrivalWaitWatch({ recordId, taskId, operatorOpenId, startedAt: noticeStartedAt });
    } catch (error) {
      // 这段还在下面那个大 try 之外：写「识别中」或建临时目录失败时必须自己收掉等待定时器，
      // 否则它会一直补发「还在识别中」，3 分钟时还会再判一次失败（重复消息）。
      if (wait) wait.stop();
      throw error;
    }
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
      // 「待建档清单」：发卡片之前只识别、只匹配，不建货品、不写成本
      //（产品负责人 2026-10-05 定的顺序）。这里按 货号+颜色 去重攒好，发完卡片交给
      // ensureArrivalProducts 落库；卡片上的 🆕 也用这同一个判断，两边不会不一致。
      const pendingCreation = [];
      const pendingSeen = new Set();

      // 价格计划：从识别结果里按货号汇总可信单价（同货号价格不一致的整条不写）。
      // 冲突在这里**只打一条 warn**，不然同一货号的每个尺码都会重复报一次。
      // 这份计划只是先算出来放进待建档清单/日志；真正的写入在发完卡片之后。
      const arrivalCostPlan = buildArrivalCostPlan(recognized);
      for (const entry of arrivalCostPlan.values()) {
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
          const resolved = await this.resolveArrivalProduct(raw);
          const { product } = resolved;
          // 从货品信息表关联获取供应商名称（新品还没有货品记录，直接用识别到的供应商名）。
          let supplierName = raw.supplier || '';
          const productSupplierIds = linkedRecordIds(product?.record?.fields?.[productTable.fields.supplier]);
          if (productSupplierIds.length > 0) {
            const supplierId = productSupplierIds[0];
            if (!supplierNameCache[supplierId]) {
              const supplierRecord = await this.gateway.get('supplier', supplierId);
              supplierNameCache[supplierId] = textValue(supplierRecord?.fields?.[supplierTable.fields.name]);
            }
            supplierName = supplierNameCache[supplierId] || supplierName;
          }
          const itemNo = String(raw.item_no || '').trim();
          const color = String(raw.color || '').trim();
          // ⚠️ 成本**不在这里写**（产品负责人：发卡片之前不建货品、不写成本）。写成本统一挪到
          // 发完卡片之后的 ensureArrivalProducts，那里已有的规则一字不变（只写空成本、
          // 同货号价格冲突不写、写失败不挡入库、重试不重复写）。
          if (resolved.pending) {
            // 「待建档清单」按 货号+颜色 去重：同一新品的多个尺码只建一条货品。
            // 这份清单就是"实际要建什么"，卡片上标了哪几个货号是新品也来自同一个判断，
            // 两边不会不一致（她最关心的确定性）。
            const pendingKey = `${itemNo}|${color}`;
            if (!pendingSeen.has(pendingKey)) {
              pendingSeen.add(pendingKey);
              const costEntry = arrivalCostPlan.get(itemNo);
              pendingCreation.push({
                item_no: itemNo,
                color,
                supplier: supplierName,
                // 品名（男/女）原样带过去：建档时按它定类别，认不出就留空，不猜。
                gender: raw.gender,
                category: raw.category,
                // 识别到的成本也记进清单：草稿里一眼能看到"要建成什么样"，线上也好排查。
                cost: costEntry && !costEntry.conflict ? costEntry.cost : null,
              });
            }
          }
          actual.push({
            product_record_id: product?.recordId || '',
            // 新品还没建档，「编号」公式当然也没有：先用「货号+颜色」把明细显示出来。
            product_number: textValue(product?.record?.fields?.[productTable.fields.number])
              || (resolved.pending ? `${itemNo}${color}` : ''),
            item_no: raw.item_no,
            color: raw.color,
            size: Number(raw.size),
            quantity: Number(raw.quantity || 1),
            // 单据上识别到的单件价：只用于卡片上显示、让她核对写进成本的数对不对，
            // 入库链路（采购入库/库存）不读这个字段。没有价格时是 undefined，格子少一行。
            unit_cost: raw.unit_cost,
            supplier: supplierName,
            // 匹配时货品表里没有 = 新品（待建档）。卡片按它在**货号**上标 🆕，
            // 后台按它建档——同一个标志，不会一个说新品、另一个没建。
            created_product: resolved.pending,
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
        // 待建档清单（货号 + 颜色 + 供应商 + 品类 + 成本）：卡片发出去之后按这份清单建档，
        // 建完再往 created_products 里回填记录链接（确认后的结果卡片要用）。
        pending_creation: pendingCreation,
        // 这两项在发卡片时还是空的——建档发生在下面 sendCard 之后（她看卡片的时候后台正在建）。
        created_products: [],
        created_colors: [],
        // 建档进度状态机：pending（卡片已发、还在建）→ done / failed（失败原因写在 creation_error）。
        // 确认入库时据此决定"给链接 / 正在建 / 告诉她失败原因"。
        creation_state: pendingCreation.length ? 'pending' : 'done',
        creation_error: '',
      };
      // ⑥ 处理完成：先在**同步段**里停掉所有等待定时器，并记下"是不是已经判过失败"。
      //    必须在写「识别成功」之前停：失败定时器一旦开火就会去写失败态，
      //    两边顺序反过来，记录最终会停在「识别失败」。
      const rescuedFromTimeout = wait ? wait.stop() : false;
      // 已经发出去的那条「还在识别中」先落地，别让她先看到卡片、后面才冒出一条提示。
      if (wait?.pendingNotice) await wait.pendingNotice;
      // 判失败那一路可能还在写记录、发消息，等它落定再写成功，保证顺序是"先失败、后改回成功"。
      if (wait?.failureSettled) await wait.failureSettled;
      await this.gateway.update('purchaseArrival', recordId, { recognitionStatus: '识别成功', confirmStatus: '待确认', failureReason: '' });
      await this.store.update(taskId, { recognized, draft, status: 'awaiting_confirmation' });
      await this.sendCard(operatorOpenId, purchaseArrivalDetailCard(taskId, draft));
      // ⭐⭐ 「发卡片」与「建档」的分界线就在这里 ⭐⭐
      // 上面：只有识别、匹配、组装草稿 + 发卡片（一次 product 表的写入都没有）。
      // 下面：才建档、才写成本。产品负责人 2026-10-05 的原话：
      //「在发确认卡片之前不做创建的举动，而是在发完之后同步做，然后用户点确认之后再给到创建好的链接」。
      //
      // 建档失败**不能**抛出去：抛出去 process() 会把这条任务判 failed，还会给记录写
      //「识别失败」——识别明明成功了，那是假失败。失败落进草稿（creation_state='failed'
      // + 原因），她点确认时兜底重试，重试还失败就明确告诉她原因（见 handleCardActionLocked）。
      const creation = await this.ensureArrivalProducts(taskId, { reason: 'card_sent' }).catch((error) => {
        logWarn('purchase.arrival.creation.crashed', { record_id: recordId, task_id: taskId, error: error.message });
        return { state: 'failed', created: 0, failures: [{ error: error.message }] };
      });
      logInfo("purchase.arrival.card.sent", { record_id: recordId, task_id: taskId, direct_arrival: directArrival, arrival_type: isDocument ? '到货单' : '鞋盒', item_count: actual.length, unrecognized_count: unrecognized.length, new_product_count: pendingCreation.length, created_product_count: creation.created || 0, creation_state: creation.state, cost_written_count: creation.cost_written_count || 0, rescued_from_timeout: rescuedFromTimeout });
      if (rescuedFromTimeout) {
        // ⑤ 迟到结果救回：判失败之后结果才回来。记录状态已经改回「识别成功」，卡片也已经发了，
        // 再补一条说明，告诉她刚才那条其实识别出来了、可以直接确认入库。
        // ⚠️ 这里**不写任何入库记录**：入库永远要她点卡片确认，走 confirmArrival 那套既有幂等
        // （inbound_created 落盘 + 按到货记录回查远端 + inflightInbound），
        // 所以"先判失败、后到结果"不会重复写入库、也不会重复扣库存。
        await this.notifyArrivalRescued(operatorOpenId, Date.now() - wait.startedAt, recordId, taskId);
      }
      return { status: 'awaiting_confirmation', item_count: actual.length, created_product_count: creation.created || 0, creation_state: creation.state, rescued_from_timeout: rescuedFromTimeout };
    } catch (error) {
      // 只记日志再抛出：把记录推出「识别中」和通知验收人统一交给 process() 的
      // failArrival 一处完成（见那里的注释），避免同一次失败写两遍状态、发两遍消息。
      // 例外：等待超时那一路已经判过失败了，就把标记挂到 error 上让 process() 跳过通知。
      const alreadyFailed = wait ? wait.stop() : false;
      if (wait?.failureSettled) await wait.failureSettled;
      if (alreadyFailed) {
        error.arrivalFailureAlreadyNotified = true;
        logWarn('purchase.arrival.recognition.failed_after_timeout', { record_id: recordId, task_id: taskId, error: error.message });
      } else {
        logWarn('purchase.arrival.recognition.failed', { record_id: recordId, task_id: taskId, error: error.message });
      }
      throw error;
    } finally {
      if (wait) wait.stop();
      // tempDir 为空说明上面那段守卫已经收过尾（还没建出目录），不用删。
      if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
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
      // ⚠️ 刻意**不**撤销已经建好的新品货品（保持改动前的口径）：建档是"补资料"，
      // 货已经在仓库里了，取消的只是"这一批要不要入库"，不是"这个货品存不存在"。
      // 删掉刚建的货品反而会把别的到货/销售引用弄断。
      await this.gateway.update('purchaseArrival', task.draft.arrival_record_id, { confirmStatus: '已取消' });
      await this.store.update(taskId, { status: 'cancelled' });
      this.inflightInbound.delete(taskId);
      // 灰色状态卡不给新品链接：她刚说"取消"，这里再塞链接只会让人以为取消失败了。
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
        // 失败也要带最新草稿：建档失败时原因就写在里面（她点确认之后才知道建没建好）。
        const failed = (await this.store.get(taskId)) || task;
        await this.updatePurchaseActionCard(task, event, purchaseStatusCard(failed.draft || task.draft, '采购到货未完成', `已停止自动处理：${error.message}`, 'red', { showNewProducts: true }));
        throw error;
      }
      // 处理完成后更新卡片为"已入库"状态。
      // ⚠️ 必须重新读一次任务：新品的记录链接（created_products[].url）是确认过程中才回填的，
      // 用动作开始时读到的旧草稿会把链接整段丢掉——产品负责人要的正是这一步的链接。
      const fresh = (await this.store.get(taskId)) || task;
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard(fresh.draft || task.draft, '采购到货已入库', '入库完成，库存已更新。', 'green', { showNewProducts: true }));
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
        // 采购退货没有尺码：这里保留 null，写入时**不写「尺码」字段**。
        // 不能写 Number(null)=0（0 会被尺码解析判成非法）——那等于凭空给退货安一个尺码。
        size: item.size === null || item.size === undefined ? null : Number(item.size),
        quantity: Number(item.quantity),
        // 行为按明细走（同一次提交里可能混着采购申请和采购退货），
        // 明细没带才退回批次级的那一个。
        behavior_record_id: item.behavior_record_id || draft.behavior_record_id || '',
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
        // 采购退货没有尺码：整条记录不写「尺码」字段（relation(undefined) 会被
        // gateway 的 fields() 跳过）。采购申请仍然是"必须有尺码"。
        const sizeReference = item.size === null ? null : await this.getSizeReferences().resolveByNumber(item.size);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'purchaseRequest',
          keyField: IDEMPOTENCY_KEY_FIELD,
          keyValue: item.request_key,
          label: `采购申请 ${item.item_key}`,
          values: {
            batchNo: relation(batchRecordId),
            product: relation(item.product_record_id),
            size: relation(sizeReference?.recordId),
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
    // 「等一小会儿」：她点确认时如果后台建档还没跑完（或上一次失败了），在这里同步补一次。
    // 建档是幂等的、并且和后台那次走同一个 creationQueue，所以不会建出第二条。
    // 入库必须有货品记录，这一步不能省；失败就明确告诉她原因，别静默也不要"假装入库了"。
    const creation = await this.ensureArrivalProducts(taskId, { reason: 'confirm' });
    if (creation.state === 'failed') {
      const reason = creation.failures
        .map((item) => `${item.item_no || ''}${item.color || ''}：${item.error}`)
        .join('；');
      throw new Error(`新品建档没成功：${reason}。请再点一次「确认入库」，我先不入库`);
    }
    // 用**最新**草稿：建档刚把 created_products（含记录链接）写进去，
    // 拿动作开始时那份旧草稿会既看不到链接、也拿不到新货品的 record_id。
    const latest = (await this.store.get(taskId)) || task;
    const draft = latest.draft || task.draft;
    // 新品的明细在建档前没有 product_record_id，这里按「货号+颜色」把刚建好的记录对上。
    const productIdByKey = new Map((draft.created_products || [])
      .map((item) => [`${item.item_no}|${item.color}`, item.product_record_id]));
    const arrival = {
      ...draft,
      actual: (draft.actual || []).map((item) => (item.product_record_id ? item : {
        ...item,
        product_record_id: productIdByKey.get(`${item.item_no}|${item.color}`) || '',
      })),
    };
    const unresolved = arrival.actual.filter((item) => !item.product_record_id);
    if (unresolved.length > 0) {
      // 走到这里说明建档"看着成功"但明细对不上货品（数据异常）。宁可停下来告诉她，
      // 也不能把这几条静默丢掉、只入一部分库。
      throw new Error(`有 ${unresolved.length} 条到货明细没有对应货品（${unresolved
        .map((item) => `${item.item_no || ''}${item.color || ''}`).join('、')}）。请再点一次「确认入库」`);
    }
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
    for (const [key, value] of Object.entries(draft.inbound_created || {})) {
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
    // 落盘基线跟着最新草稿走：建档那一步往草稿里写过链接和 creation_state，
    // 用旧对象整份覆盖会把它们冲掉（她确认之后就看不到链接了）。
    let draftNow = { ...draft };
    const persistEntry = async (key, entry) => {
      inflightMap.set(key, entry);
      persistedCreated[key] = entry;
      try {
        draftNow = { ...draftNow, inbound_created: persistedCreated };
        const updated = await this.store.update(taskId, { draft: draftNow });
        draftNow = updated?.draft || draftNow;
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
