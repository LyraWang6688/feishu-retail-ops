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
// 采购环节的行为编码（单一来源）。入库行要挂的「采购行为」= PURCHASE_BEHAVIORS.INBOUND。
// ⚠️ 别拿 inventoryService 的 STOCK_PURCHASE_INCREASE 顶替：那是**库存环节**的另一条行为记录。
const { PURCHASE_BEHAVIORS } = require('../config/purchaseBehaviors');
const { recordUrl } = require('../utils/feishuLinks');
const doubaoService = require('./doubaoService');
// 采购申请确认卡片（purchaseRequestConfirmationCard）**不再从这段链路发出**（免确认），
// 卡片本身仍留在 utils/larkCards 并且 handleCardAction 仍能处理它——
// 线上已经发出去的老卡片要能点得动，将来要回滚也只需要把 publishPurchaseRequest 换回发卡片。
// ⚠️ 2026-10-05：`purchaseArrivalDetailCard`（到货明细确认卡片）已随「拍照识别」退场删除——
// 到货不再有"识别结果待确认"这一步，也就没有要发的卡片。
const { purchaseStatusCard } = require('../utils/larkCards');
// MOVEMENT_PURCHASE_DECREASE 是 #83 采购退货扣库存用的流水类型（退货独占链，见 processSupplierReturn）。
const { InventoryService, MOVEMENT_PURCHASE_DECREASE } = require('./inventoryService');
const {
  buildPurchaseQuantities,
  isPurchaseQuantityMismatch,
  buildPurchaseQuantityMismatchNotice,
} = require('./purchaseQuantityPolicy');
// 「采购行为」分流：采购申请（尺码 + 数量说明）还是采购退货（数量，无尺码）。
// 退货要走完全不同的一条链路（直接扣库存 + 出退货单，不经到货/入库），
// 所以必须在解析之前认出来。
const { REPORT_BEHAVIOR, classifyReportBehavior } = require('./purchaseReportBehaviorPolicy');
// 归批窗口：#81 用「按报货批次号开的短窗口」取代了旧的「到齐」判据，
// reportCompletenessPolicy（Σ双数 >= 合计数量）已随 #81 整体删除。
const { resolveReportBatchWindowMs } = require('../config/reportBatchWindow');
// 「读一条报单记录」的重试次数/间隔（业务负责人 2026-10-06：「到齐 ＋ 重试 3 次」）。
// 两个值都可配（REPORT_READ_MAX_RETRIES / REPORT_READ_RETRY_DELAY_MS），见该文件头。
const { resolveReportReadRetry } = require('../config/reportReadRetry');
// 「采购退货」自己的归批窗口（业务负责人 2026-10-06 拍板：30 秒）。
// ⚠️ 与报货那条链路的 reportBatchWindow **刻意分成两份配置、两套状态**：
// 退货实测被飞书拆到 16 秒才到，4 秒的报货窗口兜不住；而报货的 4 秒是她要的体感，
// 不能被退货的需求带跑（AGENTS.md《底层工程原则》的「解耦」）。
const { resolvePurchaseReturnBatchWindowMs } = require('../config/purchaseReturnBatchWindow');
const { buildArrivalCostPlan, isBlankCost, costValueOf } = require('./arrivalCostPolicy');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng, RETURN_TITLE } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { withTimeout, withTimeoutProxy } = require('../utils/withTimeout');
const { getLarkAgentCredentials } = require('../config/larkAgent');
// 采购单改成发到**群**（业务负责人：「不用再看经办人了」）。
// 群 id 从配置读，**没有默认值**（见 config/groupPurchase 里的说明）。
const { resolvePurchaseChatId } = require('../config/groupPurchase');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
// 「这批发到群里的是采购申请单还是采购退货单」的批次类型标记（到货核对靠它区分话题）。
const { ARRIVAL_BATCH_KINDS } = require('../config/arrivalConversation');
// 「这条写入属于哪一笔采购业务」—— 关联键的唯一取用口（**白名单**，非白名单键与空值
// 一律不进日志）。与销售链路同一套：只把调用方**已经知道**的键带下去，不查表、不推导。
const { mergeCorrelation, correlationFields } = require('../utils/correlationFields');

/**
 * 采购侧的关联键包（只进日志，**不改任何业务判断、不进任何业务 input**）。
 *
 * 与销售链路的 `options.correlation` 是同一个范式：显式传参、不用 AsyncLocalStorage
 * （库存引擎有跨请求重放，从上下文读会指向错的那一笔）。
 *
 * 四个键各自"从哪来"（**拿不到就不传**，`mergeCorrelation` 会把空值 / 非白名单键丢掉，
 * 所以不会写成 `"batch_no":""`）：
 *   · `task_id`                    —— 本地采购任务（报货/退货 = purchase_supplier-report_…；
 *                                     到货核对 = arrival_reconcile_…，那是另一套 task，如实照传）
 *   · `batch_no`                   —— 采购批次号（表单填的 202610071 / 自动的 BH-…）
 *   · `purchase_report_record_id`  —— 「供应商对接」那条报单记录
 *   · `purchase_arrival_record_id` —— 「采购到货」那条记录
 */
const purchaseCorrelation = ({ taskId, batchNo, reportRecordId, arrivalRecordId } = {}) =>
  mergeCorrelation({
    task_id: taskId,
    batch_no: batchNo,
    purchase_report_record_id: reportRecordId,
    purchase_arrival_record_id: arrivalRecordId,
  });

// 采购卡片上可以触发副作用（写采购事实）的动作。
//
// ⚠️ 2026-10-05：「采购到货」的拍照识别链路整体退场，随之删掉了
// `confirm_purchase_arrival` / `cancel_purchase_arrival` 两个动作。
// 线上可能还有极少数**历史**到货卡片没点过，但那张卡片对应的记录现在
// 只会被当成"表里的一条数据"（确认状态字段还在，可人工改），不再有自动入库动作。
const PURCHASE_CARD_ACTIONS = [
  'confirm_purchase_request',
  'cancel_purchase_request',
];

const idFor = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;

/**
 * 「回复某条消息」时要不要**进话题**：`options.inThread === true` → `reply_in_thread: true`。
 *
 * 为什么需要这个字段（业务负责人 2026-10-07 真机测试后提的）：
 *   · 飞书里**回复 ≠ 话题**：不带 `reply_in_thread` 的回复只是**引用回复**，
 *     在普通群里就表现为**又一条并列消息** —— 她看到的就是"图一条、@文字一条，两条消息"；
 *   · 带 `reply_in_thread: true` 才是**话题**：主群里我们那条回复会**创建**话题，
 *     响应里回带 `thread_id`（`PurchaseBatchLocator` 正是拿它写「话题 ↔ 批次」映射的）。
 * ⚠️ **只在真的在回复某条消息时才有意义**（调用方只在 `replyToMessageId` 非空时传它）：
 *    顶层 `create` 没有"回复谁"这回事，带上这个字段没有意义。
 * ⚠️ 字段名与用法与 `larkMvpService.replyMessage(..., { inThread: true })` **完全一致**
 *    （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`）——
 *    **不新引 SDK、也不换调用方式**。
 * ⚠️ 默认 `false` ⇒ 不传时出站 payload 与改动前**逐字节相同**（单测钉住了这一条）。
 */
const replyThreadFields = (options = {}) => (options?.inThread === true ? { reply_in_thread: true } : {});

// 采购退货归批的**批次类型标记**。只写在本地任务记录（JsonTaskStore）里，
// 用来在 PM2 重启后把"还在等窗口的退货"从所有 batch_waiting 任务里认出来、
// 重开窗口继续处理（见 recoverPendingReturnBatches）。**不写业务表**。
// 报货那条链路的 batch_waiting 不带这个标记，两条链路互不误认。
const PURCHASE_RETURN_BATCH_KIND = 'purchase-return';

// （原先这里有个 number() 小工具，只被 confirmArrivalLocked 里那段"算到货状态"的
//  回写用；那段按业务负责人口径删掉后它就没有调用方了，随之删除，不留死代码。）

const attachmentTokens = (value) => (Array.isArray(value) ? value : [])
  .map((item) => item?.file_token || item?.fileToken || item?.token || '')
  .filter(Boolean);

const aggregateArrivalItems = (items) => {
  const byKey = new Map();
  for (const item of items) {
    const size = Number(item.size);
    const quantity = Number(item.quantity);
    // ⚠️ 新品在建档之前还没有 product_record_id（建档排在确认之后/新流程的编排里），
    // 所以这一步身份要退回「货号+颜色」——**不能**退回空串：
    // 两个不同新品都会落到空 key 上，被错当成同一条明细合并（尺码一样时数量翻倍，
    // 入库会跟着错）。老货品仍然用 product_record_id 聚合，行为不变。
    const identity = item.product_record_id || `pending:${textValue(item.item_no)}|${textValue(item.color)}`;
    if (identity === 'pending:|' || !Number.isInteger(size) || size <= 0 ||
      !Number.isInteger(quantity) || quantity <= 0) throw new Error('到货明细的货品、尺码或数量无效');
    const key = `${identity}|${size}`;
    if (byKey.has(key)) byKey.get(key).quantity += quantity;
    else byKey.set(key, { ...item, size, quantity });
  }
  return [...byKey.values()];
};

// （原先这里有个 sleep()，只被已删除的「识别失败态重试写入」用到，随那段一起删掉。）

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

// ── 已删除：拍照识别那一套 ────────────────────────────────────────────────
// 2026-10-05 业务负责人删掉了「采购到货」表的「类型」「识别状态」「识别失败原因」三个字段，
// 并决定这条链路整体退场（改成纯对话驱动）。随之下线的还有：
//   · processArrival（唯一入口：读记录 → 写「识别中」→ 下载图片 → 视觉识别 → 匹配 → 出卡）
//   · resolveArrivalProduct（逐行匹配货品）
//   · failArrival / markArrivalRecognitionFailed / resolveArrivalOperator
//   · notifyArrival* / startArrivalWaitWatch（等待与提示、判失败、迟到救回）
//   · humanizeArrivalFailure / arrivalFailureNotice / ARRIVAL_RECEIVED_NOTICE（写给已删字段的文案）
//   · 卡片动作 confirm_purchase_arrival / cancel_purchase_arrival
// 删掉而不是留着：它们写的字段在表里已经不存在，留着只会在日志和卡片上
// 伪装成「识别还在跑」，属于最难查的静默失效。
// ⚠️ `sendNoticeText`（#86 曾跟着一起删，合并 #83 采购退货时为差额提示恢复）
// 已于 2026-10-06「私聊切除」时**删除**：那条提示改走 `sendPurchaseGroupNotice` 发采购群
//（业务负责人：「一律在话题群里，以后私聊路线就没有了」）。私聊出口不再需要它。
// 保留下来的入库 / 建档 / 成本能力见 confirmArrival、ensureArrivalProducts 的注释。

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
    // 对外调用的超时（毫秒）。为什么每个都要有：见 utils/withTimeout.js 的文件头。
    // 0 表示不设超时，只有极少数测试会这么用。
    // ⚠️ 到货链路的 mediaTimeoutMs / recognitionTimeoutMs（下载图片、视觉识别）已随
    // 「拍照识别」退场一起删除；剩下的只有发 IM 消息这一个对外调用。
    this.imTimeoutMs = options.imTimeoutMs ?? 15_000; // 飞书消息
    this.gatewayTimeoutMs = options.gatewayTimeoutMs ?? 60_000;
    // 本服务里所有 gateway 调用都套上超时。这里包的是本服务持有的引用，
    // 不影响别的服务（生产上 LarkMvpService 跟销售链路共用的是另一个引用）。
    this.gateway = withTimeoutProxy(options.gateway || new V1BitableGateway({ client: this.client }), {
      timeoutMs: this.gatewayTimeoutMs,
      prefix: 'gateway.',
    });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    // 「尺码」是指向「尺码管理」的关联字段，报单解析与入库回写都通过它换算。
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway, sizeReferences: options.sizeReferences,
    });
    // ⚠️ 这里只用于**文字**解析（采购「数量说明」→ 尺码/数量）。
    // 到货的视觉识别（recognizeLabels / recognizePurchaseDocument）已随链路退场，
    // 但文字这一组模型和它的调用路径（报货、销售）完好无损。
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
    // 新品建档按 taskId 串行：她点确认时兜底那次和别的调用方如果并行，两边各自从任务里
    // 恢复建档进度，就会各建一条同名货品（幂等靠"先落盘再重试"的读回，挡不住真正的并发）。
    // 两个队列不会互相等待死锁：确认走 confirmationQueue，建档走 creationQueue，方向是单向的。
    //
    // ⚠️ 2026-10-05：建档（ensureArrivalProducts）现在**没有调用方**了——
    // 到货识别退场后，只有确认入库那一步会调它，而入库动作本身要等新的「对话到货」流程接。
    // 这段能力**刻意保留**（它就是将来要用的「建档 + 成本」，也是未合并分支
    // refactor/decouple-creation-and-stock 要剥成 services/productCreationService.js 的那一段），
    // 所以队列、幂等落盘、回读全部原样留着。
    this.creationQueue = new KeyedSerialQueue();
    // 「读一条报单记录」的重试（次数 + 间隔）。两个值都来自 config/reportReadRetry，
    // 可用 REPORT_READ_MAX_RETRIES / REPORT_READ_RETRY_DELAY_MS 配——业务负责人要能自己调。
    const readRetry = resolveReportReadRetry(options);
    this.batchReadMaxRetries = readRetry.maxRetries;
    this.batchReadRetryDelay = readRetry.retryDelayMs;
    this.inflightInbound = new Map();
    // ── 归批（把同一次表单提交的几条记录认成一批）──────────────────────────────
    // inflightBatches：同一批次号的**串行锁**。同一批正在处理时，后来的记录绝不能
    // 另起一次处理（否则同一批货会写出两套采购申请）。它是幂等的第一道防线，
    // 第二道是记录级的终态判断与采购申请的幂等键。
    this.inflightBatches = new Set();
    // pendingReportBatches：按「报货批次号」归集的**到齐待处理**批次。
    //
    // 什么时候处理（业务负责人 2026-10-06 的最终口径「到齐就发」）：这一包里
    // **真正进了链路的每一条**都处理完（成功 / 跳过 / 重试 3 次读不到都算处理完）
    // → 立刻整批处理一次。不再是"时间窗到点就发"。
    // value: { batchNo, batchKind, batchTaskId, taskIds: Set, timer }
    this.pendingReportBatches = new Map();
    this.reportBatchWindowMs = resolveReportBatchWindowMs(options);
    // ── 采购退货的归批（业务负责人 2026-10-06 拍板）──────────────────────────
    // 与报货那一套（pendingReportBatches / inflightBatches）**刻意分成两套**：
    // 处理内容不同（退货扣库存、报货写单据）、失败语义也不同。混成一套之后，
    // 改一边就会动到另一边（AGENTS.md 的「解耦」）。
    //
    // inflightReturnBatches：同一批次号的**串行锁**——同一批正在处理时，后来的记录
    // 绝不另起一次处理（否则同一批退货会扣两遍库存）。它是幂等的第一道防线，
    // 后面还有记录级终态判断、单据幂等键、库存 operationId。
    this.inflightReturnBatches = new Set();
    // pendingReturnBatches：按「报货批次号」归集的**到齐待处理**批次（判据同上）。
    // value: { batchNo, batchKind, batchTaskId, records: Map<recordId, taskId>, timer }
    // ⚠️ records 存 recordId → taskId：整批处理时要**复用每条记录自己的任务**，
    // 因为核对计划（return_plan）按任务冻结，重试时才不会重新算一遍把库存多扣。
    this.pendingReturnBatches = new Map();
    this.purchaseReturnBatchWindowMs = resolvePurchaseReturnBatchWindowMs(options);
    // 测试用的显式群通道（见 sendPurchaseGroupNotice）：传了就只发这个 chat_id，
    // **不读环境变量**——一个进程里并发跑的用例不会因为 PURCHASE_CHAT_ID 互相污染。
    this.sandboxChatId = options.sandboxChatId || '';
    // 「这一包应有几条 / 已经处理完几条」的台账，按 acceptMany 的包 id 归集。
    //
    // 这是「到齐」判据的落地处：larkEvents 把一次 action_list 里的记录作为**一包**
    // 交进来（acceptMany），这里记下 expected=这一包应有的条数；每处理完一条
    // （成功 / 跳过 / 读不到）就 +1；到齐后把这一包登记的批次**立刻**交给处理者。
    // 两层刻意解耦：这里只管"什么时候发图"（第一层），
    // "图上画哪几条"由 runReportBatch / runReturnBatch 按每条有没有内容可画决定（第二层）。
    // value: { packageId, kind, expected, done: Set<recordId>, entries: Set<batchEntry> }
    this.packageProgress = new Map();
    // 重启恢复只跑一次（惰性触发：第一个退货 webhook 到达时，或构造后立刻跑一次）。
    this.returnBatchRecoveryStarted = false;
    // PM2 重启不丢：进程起来时把上次还在等窗口的退货任务重新开窗。
    // 用 setImmediate 而不是构造里同步做：构造函数不该做 IO，而且这里要 await store.list()。
    setImmediate(() => {
      this.recoverPendingReturnBatches().catch((error) => {
        logWarn('purchase.return.batch.recovery_failed', { error: error.message });
      });
    });
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

  /**
   * 一条采购表记录对应的本地任务 id（确定性推导，两端必须用同一个公式）。
   * 整批处理退货时靠它把「表里的记录」对回「等窗口的那个任务」——任务里冻结着
   * 这条记录的核对计划（return_plan），换了 id 就等于重新算一遍计划、可能多扣库存。
   */
  purchaseTaskId(kind, recordId) {
    return idFor(`purchase_${kind}`, recordId);
  }

  async accept(kind, recordId, context = {}) {
    const id = String(recordId || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Webhook缺少有效 record_id');
    const taskId = this.purchaseTaskId(kind, id);
    const existing = await this.store.get(taskId);
    if (existing?.status === 'completed') {
      logInfo('purchase.webhook.duplicate_ignored', { kind, record_id: id, task_id: taskId });
      // 跳过也是「处理完了」（第一层不关心每条的结果）：不记账的话这一包永远不到齐。
      this.recordPackageDone(context, id);
      return { accepted: true, duplicate: true, taskId };
    }
    // posting 也算「已经在处理」：确认动作正在写远端时，重复的 webhook 不能
    // 把任务降级回 processing 再解析一遍，那会重发确认卡片并丢掉恢复进度。
    if (existing && ['queued', 'processing', 'awaiting_confirmation', 'posting', 'posted', 'cancelled'].includes(existing.status)) {
      logInfo('purchase.webhook.duplicate_ignored', { kind, record_id: id, task_id: taskId, status: existing.status });
      this.recordPackageDone(context, id);
      return { accepted: true, duplicate: true, taskId };
    }
    if (!existing) await this.store.create({ task_id: taskId, kind, record_id: id, status: 'queued' });
    setImmediate(() => this.enqueue(kind, id, () => this.process(kind, id, taskId, context)).catch((error) => {
      logError('purchase.webhook.processing.failed', { kind, record_id: id, task_id: taskId, error: error.message });
    }));
    logInfo('purchase.webhook.accepted', { kind, record_id: id, task_id: taskId });
    return { accepted: true, duplicate: false, taskId };
  }

  /**
   * 一次 webhook 推送（同一个 action_list）里的多条记录**一起**交给处理逻辑。
   *
   * 这是归批的**唯一**信号（业务负责人 2026-10-06 的最终口径：**不考虑拆包**）：
   * 飞书把一次表单提交的多条 record_added 放在同一个包里推过来，一包就是一次提交。
   * 这一包**应有几条**决定了"什么时候出图"（到齐就发，见 recordPackageDone）——
   * 不再有"时间窗到点就发"这个兜底。
   *
   * `options.expectedCount` = 这一包应有的条数（larkEvents 传 recordIds.length）。
   * 参数是**可选**的：老调用方（测试/脚本）只传前两个参数时按实际条数算，行为不变。
   */
  async acceptMany(kind, recordIds, options = {}) {
    // 去重：同一个 record_id 在一个 action_list 里出现两次的话，"到齐"的分母不能算两次
    // （否则 done 是 Set、永远差一条，这一包永远不会被处理）。
    const ids = [...new Set((Array.isArray(recordIds) ? recordIds : [recordIds])
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
    if (ids.length === 0) return { accepted: true, records: [] };
    const expected = Number.isSafeInteger(options.expectedCount) && options.expectedCount > 0
      ? Math.min(options.expectedCount, ids.length)
      : ids.length;
    // 包 id：不传就按这一包的 record_id 推导（确定性——同一次事件重投不会开出第二份台账）。
    const packageId = String(options.packageId || '').trim() || idFor('pkg', ids.slice().sort().join(','));
    const context = { packageId, expected };
    this.beginPackage({ packageId, kind, expected });
    const records = [];
    const failed = [];
    for (const id of ids) {
      // 逐条隔离：一包里某条的 record_id 有问题（理论上不该发生）不能连累同包其它记录
      // ——以前每条各占一个 setImmediate、各有一个 catch，这个语义要保持不变。
      try {
        records.push(await this.accept(kind, id, context));
      } catch (error) {
        failed.push({ record_id: id, error: error.message });
        // 收不进来的那条同样算「处理完了」：否则这一包永远差一条、永远不出图。
        this.recordPackageDone(context, id);
        logError('purchase.webhook.accept_failed', { kind, record_id: id, error: error.message });
      }
    }
    if (ids.length > 1) {
      logInfo('purchase.webhook.accepted_package', {
        kind, package_id: packageId, expected_count: expected,
        record_count: ids.length, accepted_count: records.length, record_ids: ids,
      });
    }
    return { accepted: failed.length === 0, records, failed };
  }

  /**
   * 开一份「这一包应有几条」的台账（见构造里的 packageProgress）。
   *
   * 只有一整包（acceptMany）才有它；单条 accept / 脚本直接调时没有包上下文，
   * 那一条自己就是一包（见 recordPackageDone 的兜底分支）。
   */
  beginPackage({ packageId, kind, expected }) {
    if (!packageId) return null;
    const existing = this.packageProgress.get(packageId);
    if (existing) {
      // 同一次事件重投：取更严的期望（不会因此少处理一条）。
      existing.expected = Math.max(existing.expected, expected);
      return existing;
    }
    const tracker = { packageId, kind, expected, done: new Set(), entries: new Set() };
    this.packageProgress.set(packageId, tracker);
    return tracker;
  }

  /**
   * 「这一包里的一条处理完了」——**第一层（到齐）的唯一记账点**。
   *
   * 成功 ✓ 跳过 ✓ 重试 3 次读不到 ✓ **全都必须走这里**：少记一条，这一包就永远
   * 不到齐、永远不出图（这是业务负责人最在意的现象）。这里刻意**不看每条的结果**——
   * "画哪几条"是第二层（runReportBatch / runReturnBatch 按有没有内容可画）的事，两层解耦。
   *
   * `batchEntry`：这条记录登记进的批次（没有 = 它不参与出图，例如读不到批号）。
   */
  recordPackageDone(context, recordId, batchEntry = null) {
    const packageId = String(context?.packageId || '');
    const tracker = packageId ? this.packageProgress.get(packageId) : null;
    if (!tracker) {
      // 没有包上下文（单条 accept / 脚本直接调）：这一条自己就是一包 → 立刻整批处理。
      if (batchEntry) this.flushBatchSoon(batchEntry);
      return;
    }
    if (batchEntry) tracker.entries.add(batchEntry);
    tracker.done.add(recordId);
    if (tracker.done.size < tracker.expected) {
      logInfo('purchase.webhook.package_waiting', {
        package_id: packageId, kind: tracker.kind,
        done: tracker.done.size, expected: tracker.expected,
      });
      return;
    }
    // 到齐：这一包登记的每个批次**立刻**交给处理者。第一层到此结束。
    this.packageProgress.delete(packageId);
    logInfo('purchase.webhook.package_complete', {
      package_id: packageId, kind: tracker.kind,
      done: tracker.done.size, expected: tracker.expected, batch_count: tracker.entries.size,
    });
    for (const entry of tracker.entries) this.flushBatchSoon(entry);
  }

  /**
   * 把「到齐」触发的整批处理放到 setImmediate，并**先等这一批里所有记录的 process()
   * 跑完**：每条记录登记进批次之后还要把自己的任务写成 batch_waiting，如果处理者的
   * 终态写盘先到、那条中间态写盘后到，就会把终态**盖回** batch_waiting（任务看起来
   * 永远没处理完）。等它们落定再处理，终态写盘一定是最后一个。
   */
  flushBatchSoon(entry) {
    if (!entry?.batchNo) return;
    setImmediate(async () => {
      try {
        await this.settleBatchMembers(entry);
      } catch (error) {
        logWarn('purchase.batch.settle_failed', { batch_no: entry.batchNo, error: error.message });
      }
      const flush = entry.batchKind === PURCHASE_RETURN_BATCH_KIND
        ? this.flushReturnBatch(entry.batchNo)
        : this.flushReportBatch(entry.batchNo);
      flush.catch((error) => {
        logError('purchase.batch.flush_failed', { batch_no: entry.batchNo, error: error.message });
      });
    });
  }

  /**
   * 等这一批里所有已登记记录的 process() 队列跑完（见 flushBatchSoon 的竞态说明）。
   * 队列不存在（已跑完/从未入队）就跳过——只等还在跑的。
   */
  async settleBatchMembers(entry) {
    const recordIds = entry?.records ? [...entry.records.keys()] : [];
    const waits = [];
    for (const recordId of recordIds) {
      const pending = this.queues.get(`supplier-report:${recordId}`);
      if (pending) waits.push(pending.catch(() => undefined));
    }
    if (waits.length) await Promise.all(waits);
  }

  /**
   * 处理一条采购表变更。
   *
   * ⚠️ 2026-10-05：「采购到货 → 拍照识别 → 入库」链路已整体退场，所以这里只剩
   * supplier-report 一条分支——`kind === 'arrival'` 的入口在 routes/larkEvents.js 里
   * 也从分派表摘掉了，不会再有人以这个 kind 走进来。
   * 到货表仍然是一张普通的表（到货日/验收原话/确认状态/验收人），只是新增记录不再触发任何事。
   */
  async process(kind, recordId, taskId, context = {}) {
    const task = await this.store.get(taskId);
    if (task?.status === 'completed') {
      // 早退也要记账：这一条算「处理完了」（第一层不看结果），否则它那一包永远差一条。
      this.recordPackageDone(context, recordId);
      return task;
    }
    // 免确认之后，采购申请一旦写成（posted）就是终态：重复投递的 webhook
    // （飞书重投、双击、两个请求几乎同时进来）不能再解析一遍、更不能把图再发一遍。
    // accept() 通常已经拦掉了，但并发到达的两次 accept 会各自入队，这里才是最终防线。
    if (kind === 'supplier-report' && task?.status === 'posted') {
      logInfo('purchase.webhook.posted_ignored', { record_id: recordId, task_id: taskId });
      this.recordPackageDone(context, recordId);
      return task;
    }
    await this.store.update(taskId, { status: 'processing', started_at: new Date().toISOString() });
    try {
      let result;
      // 先按「采购行为」分流，再看批次号：采购退货走自己那条链路
      // （直接扣库存 + 出退货单），**不进报货的归批窗口、也不写采购到货/入库**。
      // 分流放在批次号之前是有意的：退货即使带了报货批次号，也绝不能被报货那套
      // 归批/解析拦住（那会按报货口径重写一遍单据、还会给退货补上终态把库存扣减吞掉）。
      // ⚠️ 2026-10-06 起退货**有自己的一套归批窗口**（handleReturnBatch），见下面。
      const behaviorKind = await this.readReportBehaviorKind(recordId);
      if (behaviorKind === null) {
        // 重试 3 次（1 秒 → 2 秒）仍读不到这条记录 —— 业务负责人 2026-10-06 的原话：
        // 「重试了 3 次之后还是读不到，就算处理完了」。它算处理完（第一层继续、这一包
        // 照样出图），但**没有内容可画**（第二层不进图）。这里绝不静默卡住整批。
        this.recordPackageDone(context, recordId);
        logWarn('purchase.report.record_unreadable', {
          record_id: recordId, task_id: taskId, max_retries: this.batchReadMaxRetries,
        });
        result = { status: 'unreadable', record_id: recordId };
      } else if (behaviorKind === REPORT_BEHAVIOR.PURCHASE_RETURN) {
        // 退货也归批（业务负责人 2026-10-06 拍板）：按「报货批次号」归批，
        // **到齐**之后整批一起处理（一次出单、一次发群）。
        // ⚠️ 用的是退货自己的批次状态/锁，不是报货那条（两条链路解耦）。
        // 没有批次号的旧数据走单条处理，与报货那条链路的兼容口径一致。
        const batchNo = await this.readReportBatchNo(recordId);
        result = batchNo
          ? await this.handleReturnBatch(batchNo, recordId, taskId, context)
          // 传 task：退货的核对计划要落盘成"只算一次"（见 ensureReturnPlan）。
          : await this.processSupplierReturn(recordId, taskId, task);
        // 单条（没有批次号）不进任何批次：自己就是那一包，直接记「处理完了」。
        if (!batchNo) this.recordPackageDone(context, recordId);
      } else {
        // 非退货交给归批分派：有报货批次号就按「报货批次号」归批（一次提交 = 一批）；
        // 没有则走单条处理，兼容批次号字段上线前录入的旧数据。
        // ⚠️ 这里**没有**「非退货 → processArrival」这条路：到货识别已退场、方法也已删除，
        // 而且 kind === 'arrival' 的入口在 routes/larkEvents.js 里同样从分派表摘掉了。
        const batchNo = await this.readReportBatchNo(recordId);
        if (batchNo) {
          result = await this.handleReportBatch(batchNo, recordId, taskId, context);
        } else {
          result = await this.processSupplierReport(recordId, taskId);
          this.recordPackageDone(context, recordId);
        }
      }
      // 已经登记进批次：等这一包**到齐**（见 recordPackageDone）由**一个**处理者统一处理。
      //
      // 这一段必须在下面"读 current 决定终态"之前处理，而且要重新读一次任务：
      // 到齐可能在极短的时间内就已经跑完，那时任务已经是 posted/completed
      // 且带着真正的 result——这里不能把它覆盖成 batch_waiting，更不能把 result
      // 换成这个中间态对象。刻意不落 result，也是为了让"任务跑完了"的判据
      // （result 已落盘）不会提前成立、读到半成品。
      if (result?.status === 'batch_waiting') {
        const latest = await this.store.get(taskId);
        if (!latest || latest.status !== 'processing') return latest;
        const patch = { status: 'batch_waiting', batch_no: result.batch_no };
        // 退货的批次要带类型标记，PM2 重启后才认得出"哪些是等处理的退货"（见恢复逻辑）。
        if (result.batch_kind) patch.batch_kind = result.batch_kind;
        return this.store.update(taskId, patch);
      }
      const current = await this.store.get(taskId);
      // 采购报单免确认后没有「待确认」这个中间态了：写成功就是 posted。
      // 保持「已经写出的更靠后的状态不被覆盖回去」这个原则不变。
      let status = current?.status;
      if (!status || status === 'processing') {
        if (result?.status === 'batch_inflight') {
          // 同一批的另一条明细正在处理这一批，这次我们什么都没做。
          // 落成 completed 是安全的：处理者是**批次处理者**，它只有在把这一批所有
          // 记录都标成终态之后才会落 posted；真失败了也是批次处理者落 failed，
          // 重收任意一侧的 webhook 都能让它重跑，不会因为这条记录已经 completed 就丢货。
          status = 'completed';
        } else if (['already_posted', 'unreadable', 'mismatch'].includes(result?.status)) {
          // 这一批早就生成过申请 / 这条记录读不到 / 说明与勾选对不上（已在群里提示）：
          // 本次没有可写的单据，对这条记录来说就是「已经处理过」，终态是 completed。
          status = 'completed';
        } else {
          status = result?.ignored && result?.status === '已取消' ? 'cancelled' : 'posted';
        }
      }
      return this.store.update(taskId, { status, result });
    } catch (error) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      // 失败也算「处理完了」（第一层）：不记账的话，同包其它记录永远等不到"到齐"。
      this.recordPackageDone(context, recordId);
      // ⚠️ 刻意**不**把报单记录改成「解析失败」。
      // 这条链路的失败绝大概率是「模型这一步抽了一下」或「读表正好抽了一下」，
      // 都应该是**可重试**的：把记录标成「解析失败」是终态，重收 webhook 会被
      // 幂等守卫跳过，那批货就静默丢了。状态保持不变 + 任务可重试，
      // 两条一起才等于"不丢单"。
      logWarn('purchase.report.batch.failed_retryable', {
        record_id: recordId, task_id: taskId, error: error.message,
      });
      throw error;
    }
  }

  /**
   * 读取报单记录的报货批次号（文本字段）
   * 遇到飞书 Data not ready 时自动重试，最多 this.batchReadMaxRetries 次，
   * 间隔 1 秒 → 2 秒（this.batchReadRetryDelay × 第几次），共约 3 秒。
   * 读完仍读不到就返回空串（放弃，不抛错）——上层按"处理完了但不进图"继续。
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
          // 间隔同样走配置（以前这里写死 1000，等于 REPORT_READ_RETRY_DELAY_MS 对它无效）。
          await new Promise(resolve => setTimeout(resolve, this.batchReadRetryDelay * attempt));
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
   *   · **不考虑拆包**（业务负责人 2026-10-06 明确）：飞书把一包拆成几次推送这件事
   *     不再兜底。判「到齐」的分母就是**这一包里进了链路的条数**，不再有时间窗。
   *
   * 这里只做登记，不读表、不解析、不写任何业务表——真正的处理在 flushReportBatch。
   * 登记后任务停在 batch_waiting（可由后续 webhook 继续加入），不会假装"处理完了"。
   *
   * 「到齐」怎么落地：每处理完一条就记一次账（见 recordPackageDone），记满这一包应有的
   * 条数（成功 ✓ 跳过 ✓ 重试 3 次读不到 ✓ 都算）就**立刻**整批处理——这里只管
   * 「什么时候发图」（第一层），"图上画哪几条"由 runReportBatch 按每条有没有内容可画决定
   * （第二层）；两层刻意解耦。
   *
   * ⚠️ 注意「到齐」**不是**判「合计数量」：那个字段业务负责人已经删掉，判据是
   * 「这一包进链路的条目都处理完了吗」，不是「Σ双数 >= 合计数量」。
   */
  async handleReportBatch(batchNo, recordId, taskId, context = {}) {
    const existing = this.pendingReportBatches.get(batchNo);
    if (existing) {
      existing.taskIds.add(taskId);
      existing.records.set(recordId, taskId);
      logInfo('purchase.batch.joined', {
        batch_no: batchNo, record_id: recordId, pending_count: existing.taskIds.size,
      });
      // 这一条登记完了 → 记一笔「到齐」账（它后面成不成都不影响第一层）。
      this.recordPackageDone(context, recordId, existing);
      return { status: 'batch_waiting', batch_no: batchNo };
    }
    const entry = {
      batchNo,
      batchKind: 'supplier-report',
      // 批次处理者的 taskId：整批的草稿、幂等键、出图都以它为 owner。
      // 具体是哪一条记录的 task 不重要——处理时读的是表里的**整批**记录。
      batchTaskId: taskId,
      taskIds: new Set([taskId]),
      // recordId → taskId：flushBatchSoon 靠它把"还在写 batch_waiting 的 process()"等完。
      records: new Map([[recordId, taskId]]),
      timer: null,
    };
    this.pendingReportBatches.set(batchNo, entry);
    logInfo('purchase.batch.opened', { batch_no: batchNo, record_id: recordId });
    this.recordPackageDone(context, recordId, entry);
    return { status: 'batch_waiting', batch_no: batchNo };
  }

  /**
   * 到齐了（或恢复时）：把这一批交给**一个**处理者（走队列，便于测试与运维判断
   * "还有没有在处理"）。
   *
   * 同一批次正在处理（inflightBatches 命中）时不另起一次处理——把批次留在待处理表里，
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
        // 把批次放回去，等处理者跑完再试一次；到那时会走 already_posted 分支补终态。
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
   * 把一批放回待处理表、稍后重试。
   *
   * 用在"同一批已经有处理者在跑"的时候：不另起一次处理，也不把任务落成终态
   *（落了就等于丢单）。若期间已经有新的待处理批次（同批新记录到达时开的），把任务并进去，
   * 只留一个定时器。
   */
  deferReportBatch(batchNo, entry) {
    const existing = this.pendingReportBatches.get(batchNo);
    if (existing) {
      for (const id of entry.taskIds) existing.taskIds.add(id);
      for (const [recordId, taskId] of entry.records || []) existing.records.set(recordId, taskId);
      if (existing.timer) clearTimeout(existing.timer);
    } else {
      if (entry.timer) clearTimeout(entry.timer);
      this.pendingReportBatches.set(batchNo, entry);
    }
    const target = this.pendingReportBatches.get(batchNo);
    // 重试间隔至少 1 秒：REPORT_BATCH_WINDOW_MS 现在只当这个间隔用（它不再是"到点就发图"
    // 的触发条件），配成 0 也不能让重试变成 0——那会在一次长处理（模型调用几十秒）里空转刷日志。
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
    // ⚠️ 采购退货**不在报货的归批窗口里处理**（合并 #83 与 #81 时定的归属；
    // 2026-10-06 起退货有**自己**的归批窗口，见 handleReturnBatch / runReturnBatch）：
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
        // 关联键只进日志：这一批的 task_id ＋ 批次号（报单记录 id 在下面按条补上）。
        { correlation: purchaseCorrelation({ taskId: batchTaskId, batchNo }) },
      );
      logInfo('purchase.batch.already_posted', {
        batch_no: batchNo,
        posted_record_count: reportRecords.length - pendingRecords.length,
        ignored_record_count: finalized,
      });
      return { status: 'already_posted', batch_no: batchNo, ignored_record_count: finalized };
    }

    const entries = [];
    // 「说明和勾选对不上」的记录：收在这里，整批只提示一次（见 notifyQuantityMismatches）。
    const mismatches = [];
    for (const record of pendingRecords) {
      const fields = record?.fields || {};
      const behaviorIds = linkedRecordIds(fields[reportTable.fields.behavior]);
      const behaviorRecordId = behaviorIds[0] || '';
      const behaviorKind = classifyReportBehavior(behaviorIndex.get(behaviorRecordId));
      const detailId = textValue(fields[reportTable.fields.detailId]);
      let details;
      try {
        // 按行为分流解析：采购申请 = 尺码 + 数量说明；采购退货 = 数量、无尺码。
        details = await this.parseReportItems(fields, reportTable, behaviorKind);
      } catch (error) {
        // ⚠️ 「说明和勾选对不上」**不再**把整批打挂（以前：解析层一抛 → 整批 failed、
        // 报单记录「处理状态」留空、静默，运营上就是"提交了没反应"）。她的口径：
        // 这种对不上要在**采购群**说一句（见 notifyQuantityMismatches），而这一条
        // **没有内容可画**（第二层）；同包其它记录照样出图（第一层继续，两层解耦）。
        // ⚠️ 只收这一类错（isPurchaseQuantityMismatch）：其它异常（模型抽风、读表失败）
        // 照旧抛出，由 flushReportBatch 落成可重试的 failed——绝不顺手吞掉。
        if (!isPurchaseQuantityMismatch(error)) throw error;
        mismatches.push({
          recordId: record.record_id,
          detailId,
          code: error.code,
          message: buildPurchaseQuantityMismatchNotice(error, { detailId }),
        });
        logWarn('purchase.report.quantity_mismatch', {
          batch_no: batchNo, record_id: record.record_id, code: error.code, error: error.message,
        });
        continue;
      }
      entries.push({
        recordId: record.record_id,
        fields,
        detailId,
        behaviorRecordId,
        behaviorKind,
        details,
      });
    }
    // 一次提交只提示一次：把这一批里所有"对不上"的合成一条群消息，不逐条刷屏。
    if (mismatches.length) {
      // 「发采购群」也是这条链路的动作之一，提示日志同样要能按同一个键串起来。
      await this.notifyQuantityMismatches(batchNo, mismatches, {
        correlation: purchaseCorrelation({ taskId: batchTaskId, batchNo }),
      });
    }
    if (entries.length === 0) {
      // 整批都没有内容可画（全是对不上）：不写任何单据、也不给记录补终态
      //（她核对后重新提交即可）。任务落 completed —— 这一批"处理完了"。
      logInfo('purchase.batch.no_drawable_records', {
        batch_no: batchNo, mismatch_count: mismatches.length,
      });
      return { status: 'mismatch', batch_no: batchNo, mismatch_count: mismatches.length };
    }

    // 上锁：同一批次号串行。另一个处理者正在跑就返回 batch_inflight（调用方会把
    // 批次留着稍后重试），绝不在这里另起一次写入。
    if (this.inflightBatches.has(batchNo)) {
      logInfo('purchase.batch.inflight_ignored', { batch_no: batchNo });
      return { status: 'batch_inflight', batch_no: batchNo };
    }
    this.inflightBatches.add(batchNo);
    try {
      const batchResult = await this.processSupplierBatch(batchNo, entries, batchTaskId, reportTable);
      if (!mismatches.length) return batchResult;
      // 「哪条对不上、为什么」也留在结果里（和退货那边的 failed_reasons 同一个用途）：
      // 第二层要提示、排查时也要能一眼看出这条为什么没进图。
      return {
        ...batchResult,
        mismatch_record_ids: mismatches.map((item) => item.recordId),
        mismatch_reasons: mismatches.map((item) => ({
          record_id: item.recordId, code: item.code, notice: item.message,
        })),
      };
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
  async markRecordsAsPosted(recordIds, reportTable, options = {}) {
    let updated = 0;
    for (const recordId of recordIds) {
      const patch = { status: '已生成申请' };
      if (reportTable?.fields?.failureReason) patch.failureReason = '';
      // 关联键（task_id / batch_no）由调用方给；**报单记录 id 是这一层自己知道的**，就地补上。
      const correlation = mergeCorrelation(options.correlation, { purchase_report_record_id: recordId });
      const written = await this.gateway.update('purchaseReport', recordId, patch, { correlation }).catch(() => null);
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
    // ⚠️ 2026-10-06 业务负责人拍板：「没维护供应商的货品，也应该能正常出单」。
    // 所以「一条都没关联供应商」（supplierRecordId === ''）**不再是错误**：
    // 明细各自的 supplier_record_id 本来就允许为空，出图时它们归到
    // 「未标注供应商」那一组，照常出一张图（见 groupItemsBySupplier / deliverSupplierImagesInner）。
    // 原来的硬校验「无法从货品信息获取供应商，请检查货品的供应商关联字段」已按她的口径去掉。
    // 已维护供应商的照旧按供应商分组——供应商字段本身一个都没删。

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

  // 🔴 2026-10-07「私聊链路移除」：`sendCard(openId, card)` **整段删除**。
  //    它是「把确认卡片发给经办人私聊」的那条路，**全仓没有调用方**
  //    （采购申请早已改走群：`sendText(chatId, …, 'chat_id')` / `sendPurchaseGroupNotice`），
  //    只留了一行注释说"要回滚成确认卡片就换回它"——留给下个读代码的人一个
  //    "好像还有一条私聊链路"的错觉。要用回来：`git log -S 'sendCard(openId, card)'`。
  //    ⚠️ 本类里「发消息」的四个方法名字仍然必须各不相同（见下面注释）：JS 类体里
  //    后定义的同名方法会**静默覆盖**先定义的，git 合并也不报冲突。

  // ── 已删除：到货「等待与提示」与失败提示整段 ──────────────────────────────
  // 删掉的有：notifyArrivalReceived / notifyArrivalFailed /
  // notifyArrivalWaiting / notifyArrivalRescued / startArrivalWaitWatch。
  //
  // 为什么删：它们服务的对象是「识别中」这个中间态和它对应的三个已删字段
  //（识别状态 / 识别失败原因 / 类型）——"每 1 分钟补一条还在识别中"、
  // "2 分钟放弃等待"、"3 分钟判失败"、"迟到结果救回"全部只在识别流程里有意义。
  // 留着的话没有任何调用方，只会在下次读代码的人脑子里重建一条不存在的流程。
  //
  // ⚠️ 合并 #57 吃过的那个亏（同类方法静默覆盖）在这里仍然有效，别重新引入：
  // 本类里同时存在语义不同的「发消息」方法时，**名字必须不同**——
  // JS 类体里后定义的同名方法会**静默覆盖**先定义的，git 合并也不报冲突。
  // 现在有三个：sendText / sendImage（失败即抛错）
  // 与 sendPurchaseGroupNotice（发群、失败只记日志、返回 false）。
  // ⚠️ 原本还有一个 `sendCard`（发经办人私聊的确认卡），已于 2026-10-07 整体删除（见上）。
  //
  // 🔴 2026-10-06「私聊切除」：`sendNoticeText`（发给经办人私聊的事后通知）**已整体删除**——
  // 它唯一的调用点就是采购退货的差额提示，那条现在改走 `sendPurchaseGroupNotice`
  // （业务负责人：「一律在话题群里，以后私聊路线就没有了」）。
  // 留着它就是留一条没人用的主动私聊出口，下次读代码的人很容易再挂上去。

  /**
   * 在**采购群**（PURCHASE_CHAT_ID，和出图同一个群）说一句纯文本。
   *
   * 业务负责人 2026-10-06 的口径：「"说明和勾选对不上"时要不要在群里给个提示」→
   * 「可以给提示」。所以这是**运营可见的反馈**，不再让她"提交了没反应、只能查日志"。
   *
   * 与 sendText 是刻意分开的语义：
   *   · sendText —— 主链动作，发不出去就算这次处理失败；
   *   · sendPurchaseGroupNotice —— 发给采购群的事后通知，**失败不抛错**（只记日志、返回 false）：
   *     它出现在"这条报货没进图" / "退货数量对不上"之后，绝不能因为一句提示发不出去
   *     就把整批判成失败。
   *
   * 群 id 走 config/groupPurchase（未配置就大声跳过、不回落私聊，与出图同一条口径）。
   * `options.sandboxChatId`（构造入参）是测试用的显式通道：不读环境变量，避免并发用例互相污染。
   *
   * ⭐ `options.replyToMessageId`：传了就**回复那条消息**而不发顶层消息 ——
   *    采购退货的差额提示用它挂到**这一批退货单（图）的那个话题**下，
   *    而不是在群里另开一个话题（业务负责人：「一律在话题群里」）。不传 = 照旧发顶层。
   * ⚠️ 2026-10-07：回复时**同时带 `inThread: true`**（飞书 `reply_in_thread`）。
   *    只"回复某条消息"在飞书里是**引用回复**，不建话题 —— 那正是她看到"两条消息"的原因。
   */
  async sendPurchaseGroupNotice(content, options = {}) {
    // 关联键（task_id / batch_no / 记录 id）：只进日志。不传 = 日志形状**逐字不变**。
    const correlation = correlationFields(options.correlation);
    const target = this.resolvePurchaseGroupTarget({ sandboxChatId: this.sandboxChatId });
    if (!target.chatId) {
      logWarn('purchase.group_notice.skipped', {
        reason: 'purchase_chat_id_unconfigured', env: 'PURCHASE_CHAT_ID', content, ...correlation,
      });
      return false;
    }
    const replyToMessageId = String(options?.replyToMessageId || '').trim();
    try {
      await this.sendText(target.chatId, content, 'chat_id', {
        replyToMessageId: replyToMessageId || undefined,
        // 有回复对象 = 挂在那一批的话题下 → 必须进话题，否则又是一条并列的引用回复。
        inThread: Boolean(replyToMessageId),
      });
      logInfo('purchase.group_notice.sent', {
        chat_id: target.chatId, reply_to_message_id: replyToMessageId, ...correlation,
      });
      return true;
    } catch (error) {
      logWarn('purchase.group_notice.failed', { chat_id: target.chatId, error: error.message, ...correlation });
      return false;
    }
  }

  /**
   * 「说明和勾选对不上」的群提示：**一次提交只提示一次**（把整批合成一条，不逐条刷屏）。
   * 返回是否发出去了（发不出去只记日志，不影响任务终态）。
   */
  async notifyQuantityMismatches(batchNo, mismatches, options = {}) {
    const lines = mismatches.map((item) => `· ${item.message}`);
    const content = [
      `这批报货里有 ${mismatches.length} 条「说明和勾选的尺码对不上」，先没有生成采购申请单：`,
      ...lines,
    ].join('\n');
    const sent = await this.sendPurchaseGroupNotice(content, { correlation: options.correlation });
    logInfo('purchase.report.quantity_mismatch_notified', {
      batch_no: batchNo, mismatch_count: mismatches.length, sent,
      ...correlationFields(options.correlation),
    });
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
   * 要回滚成"发确认卡片等她点"，`sendCard` 也已随私聊链路一起删除（见上），
   * 需要的话从 git 历史里取回（`git log -S 'purchaseRequestConfirmationCard'`）。
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
   *
   * `options.replyToMessageId`：传了就**回复那条消息**（`im.message.reply`）而不是
   * 发一条顶层消息——采购单发到群时用它把第 2 条起的消息都挂到第 1 条的话题下
   * （业务负责人 2026-10-06 拍板，见 deliverSupplierImagesInner）。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`（**只在有 `replyToMessageId` 时有意义**）：
   * 带上它 → `im.message.reply` 的 `data.reply_in_thread = true` → 飞书把这条回复
   * **放进话题**（主群里我们这条回复会**创建**那个话题，响应里回带 `thread_id`）。
   * 🔴 不带它时，"回复某条消息"在飞书里只是**引用回复**、**不建话题** ——
   * 那正是业务负责人看到的"图一条、文字一条，两条并列消息"。
   * ⚠️ 与 `larkMvpService.replyMessage(..., { inThread: true })` 是**同一个字段、同一种用法**
   * （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`），
   * **不新引 SDK、也不换调用方式**。默认 `false` ⇒ 不传时 payload 与改动前**逐字节相同**。
   */
  async sendImage(openId, imageBuffer, receiveIdType = 'open_id', options = {}) {
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
    const content = JSON.stringify({ image_key: imageKey });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'image', content, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'image', content },
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
   *
   * `options.replyToMessageId`：传了就**回复那条消息**而不是发顶层消息——采购单发到群时
   * 用它把「文字 @」挂到第 1 条图的话题下（业务负责人 2026-10-06 拍板）。
   * ⚠️ 一律回复**第 1 条**（不是回复上一条）：飞书的话题 = 一条消息 + 回复它的消息，
   * 回复话题里任何一条都算同一个话题；固定回复第 1 条，归属最稳、也最好解释。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`：见 `replyThreadFields` 的注释 ——
   * **只"回复"不建话题**（飞书那是引用回复），要"图与文字落在同一个话题"就必须带它。
   * 不传时 payload 与改动前**逐字节相同**。
   */
  async sendText(openId, content, receiveIdType = 'open_id', options = {}) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送说明');
    const text = JSON.stringify({ text: content });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'text', content: text, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'text', content: text },
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
      return { sent: [], failed: [{ supplier: '', error: error.message }], thread_root_message_id: '' };
    }
  }

  // options.title / options.fileNameSuffix：采购退货单与采购申请单共用这一整条
  // 「按供应商出图 → 发到群 → 写回附件」的流程，只有标题和文件名不同（口径就是"格式一样"）。
  async deliverSupplierImagesInner(taskId, task, posting = {}, options = {}) {
    const draft = task?.draft || {};
    const items = draft.items || [];
    if (!items.length) return { sent: [], failed: [], thread_root_message_id: '' };
    // 这一层已经知道的关联键：task_id ＋ 批次号（只进日志）。
    // ⚠️ 报单记录 id **刻意不给**：批次草稿里它是**多条**（report_record_ids），
    //    挑一条当代表就是编 —— 每条记录自己那几次写入会各自带自己的 id。
    const batchNo = posting.batch_no || draft.batch_no || '';
    const correlation = purchaseCorrelation({ taskId, batchNo });
    // ⚠️ 采购单**只发群**（业务负责人：「不用再看经办人了」）。
    // operator_open_id 仍然留着——它是「这条记录是谁报的」，用于到货异常告知、
    // 以及权限判断，不再决定采购单发到哪儿。
    const operatorOpenId = draft.operator_open_id;
    // 构造入参里的 sandboxChatId 是**整条链路共用的测试群**（出图与提示发同一个群）：
    // 没配它、也没在读环境变量时（生产），这里等价于原来的 resolvePurchaseGroupTarget(options)。
    const target = this.resolvePurchaseGroupTarget({
      ...options,
      sandboxChatId: options.sandboxChatId || this.sandboxChatId,
    });
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
      return { sent: [], failed: [], skipped: 'chat_id_unconfigured', thread_root_message_id: '' };
    }
    const sent = [];
    const failed = [];
    // 发到群里的每条消息的 message_id / thread_id：记进本地映射，
    // 供「话题里的消息 / 引用那条消息 → 是哪一批」反查。
    const groupMessages = [];
    // 这一批在群里发的**第 1 条消息**（图）的 message_id = 话题根。
    // 它之后的每条消息都回复它（见下），于是整批只占一个话题。
    let threadRootMessageId = '';
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
        // ⚠️ 一条开话题、后面的回复它（业务负责人 2026-10-06 拍板）：
        // 以前图一条、文字一条都是**顶层消息**，飞书里顶层消息各成一个话题，
        // 一次提交就变成 4 条消息 / 4 个话题（生产实测）。
        // 现在：**第 1 条（图）照常顶层发** → 后面每条（文字 @、多供应商时的第 2 张图…）
        // 都 `im.message.reply` 回复**第 1 条**，于是它们都挂在那一个话题下。
        // ⚠️ 固定回复第 1 条，不是回复上一条：飞书的话题 = 一条消息 + 回复它的消息，
        // 回复话题内任何一条都算同一个话题；固定成根消息归属最稳，也最好排查。
        //
        // 🔴 2026-10-07 关键修复（业务负责人真机测试后）：「@了经办人，但不是在同一个话题下
        // 回复的，而是发了两条消息」。根因：**飞书里"回复"≠"话题"** —— 只 `im.message.reply`
        // 是**引用回复**，要**再带 `reply_in_thread: true`** 才进话题（主群里我们这条回复
        // 会**创建**话题，响应才回带 `thread_id`）。
        // ⇒ 这一批里**凡是回复第 1 条图的消息**（第 2 张图、@文字）都带 `inThread: true`。
        // ⚠️ **第 1 条图仍然是顶层 `create`**：群里没有"她的那条消息"可以回复（这条链路是
        // 多维表格记录变更触发的），所以话题的根**只能是这张图** —— 我们自己的第一条消息。
        const imageResult = await this.sendImage(target.chatId, png, 'chat_id', {
          replyToMessageId: threadRootMessageId,
          inThread: Boolean(threadRootMessageId),
        });
        // 第 1 条消息就是这一批的话题根：它之后的每一条都回到它身上。
        if (!threadRootMessageId && imageResult.messageId) threadRootMessageId = imageResult.messageId;
        if (!threadRootMessageId) {
          // 拿不到第 1 条的 message_id 就没法回复它 → 后面的消息只能退回顶层发
          //（话题归属保证不了）。真出现这条日志说明飞书响应里没有 message_id，
          // 属于异常；但**不能因此不发**她那条 @，所以只记一条 warn。
          logWarn('purchase.request.image.thread_root_missing', {
            task_id: taskId, chat_id: target.chatId, supplier: label,
            hint: '发送图片的响应里没有 message_id，后续消息将退回顶层发送（话题归属无法保证）',
          });
        }
        // 图单独一条、文字带 @经办人 单独一条：飞书图片消息没有正文，
        // @ 只能挂在文字那条上（业务负责人明确要 @经办人，不再是 @所有人）。
        // ⚠️ `inThread`：这条必须**进话题**（回复第 1 条图 + `reply_in_thread`）——
        //    她要的就是"图与文字在同一个话题里"，而飞书单靠"回复"只会得到一条引用回复。
        // ⚠️ 第 1 条图没有 `threadRootMessageId`（它就是根）→ 那种情况 `textInThread` 自然是
        //    `false`：顶层 `create` 本来也没有"回复谁 / 进哪个话题"这回事。
        const textInThread = Boolean(threadRootMessageId);
        const textResult = await this.sendText(
          target.chatId,
          this.mentionOperatorText(operatorOpenId, `${label} 这批 ${rowCount} 条（共 ${totalPairs} 双），图可以直接转给供应商。`),
          'chat_id',
          { replyToMessageId: threadRootMessageId, inThread: textInThread },
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
          thread_root_message_id: threadRootMessageId,
          image_message_id: imageResult.messageId, image_thread_id: imageResult.threadId,
          text_message_id: textResult.messageId, text_thread_id: textResult.threadId,
          text_is_reply: Boolean(threadRootMessageId && textResult.messageId),
          // ⭐ 2026-10-07：她要能一眼看出"这次是不是真的进了话题"——把发出去时用的
          // `reply_in_thread` 一起记下来（排查"怎么还是两条消息"时，第一眼就看这个字段）。
          text_reply_in_thread: textInThread,
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
          // 附件写回也是写库：带上这一层的关联键（task_id ＋ batch_no）。
          correlation,
        });
        if (written?.written) {
          logInfo('purchase.request.image.attachment_written', { task_id: taskId, ...written, ...correlation });
        }
      } catch (error) {
        // 只告警：她已经有图了。
        logWarn('purchase.request.image.attachment_write_failed', { task_id: taskId, supplier: label, error: error.message });
      }
      sent.push(label);
    }

    // 「这条消息 / 这条话题 ↔ 是哪一批」的映射：**发完就记**，失败只告警。
    // 记不上只影响 C 的定位（她会被告知"认不出"），绝不能让采购单已经发出去之后
    // 再把任务判成失败。
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
          // 采购申请单 / 采购退货单共用这一条"出图 → 发群 → 记映射"的路，
          // 所以映射里必须带上类型：话题里的到货核对只认采购申请单那一类。
          kind: options.kind || ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
        });
      } catch (error) {
        logWarn('purchase.request.image.batch_mapping_failed', {
          task_id: taskId, message_id: messageId, chat_id: target.chatId,
          batch_no: batchNo, error: error.message,
        });
      }
    }

    // `thread_root_message_id`：这一批在群里发的**第 1 条消息**（图）= 话题根。
    // 把它交回给调用方，退货的差额提示才能**回复它**、落在同一个话题里
    //（业务负责人：「一律在话题群里，以后私聊路线就没有了」）。
    const summary = {
      sent, failed, chat_id: target.chatId, thread_root_message_id: threadRootMessageId,
    };
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
  async writeSupplierImageAttachment({
    taskId, supplierName, png, requestRecordIds, fileNameSuffix = '采购单', correlation = {},
  }) {
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
      await this.gateway.update('purchaseRequest', target.recordId,
        { attachment: [{ file_token: fileToken }] }, { correlation });
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
    // 从货品信息表的供应商关联字段直接获取供应商 record_id；**没有也不算错**
    //（业务负责人 2026-10-06：「没维护供应商的货品，也应该能正常出单」）——
    // 留空即可，出图时归到「未标注供应商」那一组。原来的硬校验
    // 「货品信息中未关联供应商，请先在货品信息中设置供应商」已按她的口径去掉。
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    const supplierRecordId = productSupplierIds[0] || '';
    let parsed;
    try {
      parsed = await this.parseReportItems(fields, table, behaviorKind);
    } catch (error) {
      // 「说明和勾选对不上」（单条路径，没有批次号）：不再整条静默失败——
      // 在采购群说一句（一次提交就这一条 → 一条提示），这条没有内容可画，处理到此为止。
      if (!isPurchaseQuantityMismatch(error)) throw error;
      const notice = buildPurchaseQuantityMismatchNotice(error, {
        detailId, itemNo: this.productDisplayInfo(product.record, productTable).itemNo,
      });
      logWarn('purchase.report.quantity_mismatch', {
        record_id: recordId, code: error.code, error: error.message,
      });
      await this.sendPurchaseGroupNotice(notice);
      return { status: 'mismatch', record_id: recordId, message: notice };
    }
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
    // 批次号就在这次写入的返回值里（单条路径的批次号是 nextBatchNo() 现生成的 BH-…）。
    logInfo('purchase.report.posted', {
      record_id: recordId, task_id: taskId, item_count: parsed.length,
      request_count: result.request_ids?.length || 0,
      ...purchaseCorrelation({ taskId, batchNo: result?.batch_no, reportRecordId: recordId }),
    });
    return { status: 'posted', item_count: parsed.length };
  }

  /**
   * 读一条「供应商对接」记录，带重试（次数/间隔来自 config/reportReadRetry）。
   *
   * 为什么必须有：飞书多维表格是**最终一致**的——记录变更事件先到、记录内容后到
   * （Data not ready / 1254607）。业务负责人 2026-10-06 的口径是「到齐 ＋ 重试 3 次」，
   * 并明确「重试了 3 次之后还是读不到，就算处理完了」。所以这里**读完仍失败就返回 null**
   * （不抛错）——上层按"处理完了、但没有内容可画"继续，绝不让一条读不到的记录把整包拖死。
   */
  async readReportRecordWithRetry(recordId) {
    const maxRetries = this.batchReadMaxRetries;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.gateway.get('purchaseReport', recordId);
      } catch (error) {
        logWarn('purchase.report.read_failed', {
          record_id: recordId, attempt, max_retries: maxRetries, error: error.message,
        });
        if (attempt < maxRetries) {
          // 间隔 1 秒 → 2 秒（第几次失败就等 delay × 几），共约 3 秒。
          await new Promise((resolve) => setTimeout(resolve, this.batchReadRetryDelay * attempt));
        }
      }
    }
    return null;
  }

  /**
   * 这条「供应商对接」记录是采购申请还是采购退货（见 purchaseReportBehaviorPolicy）。
   *
   * 读行为记录失败/行为没填/名称不认识 → 一律按**采购申请**处理：那是这条链路今天的行为，
   * 也是"读不到信息时唯一不发明业务规则"的选择。宁可退回现状，也不把普通报货当成退货。
   *
   * ⚠️ 这条记录**自己的读**是整条链路的"第一枪"（process() 里在 readReportBatchNo 之前），
   * 以前它是裸奔的（无 try/catch、无重试）——一次 Data not ready 就把整批打挂。现在带
   * 重试（同 readReportBatchNo 的那套配置）；**读完仍读不到就返回 null**，由 process()
   * 按「重试 3 次后仍读不到 → 算处理完了、但不进图」处理（业务负责人的原话）。
   */
  async readReportBehaviorKind(recordId) {
    const table = this.gateway.table('purchaseReport');
    const behaviorTable = this.gateway.table('behavior');
    const record = await this.readReportRecordWithRetry(recordId);
    if (!record) return null;
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

  // ── 采购退货的归批（业务负责人 2026-10-06 的最终口径：「到齐 ＋ 重试 3 次」）──
  //
  // 为什么必须归批：一次表单提交 = N 条记录。逐条处理会出 N 张退货单、发 N 次群
  //（2026-10-06 生产实测过：同一次提交的 2 条退货被拆成两次推送 → 2 张单、2 次群）。
  //
  // 现在：按「报货批次号」把退货记录收进**自己的**待处理批次；**这一包到齐**
  //（进了链路的每一条都处理完：成功 ✓ 跳过 ✓ 重试 3 次读不到 ✓）就由**一个**处理者
  // 整批处理（一次出单、一次发群，见 runReturnBatch）。**不再有"时间窗到点就发"**。
  //
  // ⚠️ 思路复用报货那套，状态**刻意不共用**（两套 Map、两把锁、两份配置）：
  // 改一边不会动到另一边（AGENTS.md 的「解耦」）。

  /**
   * 重启恢复：把上次还停在 batch_waiting 的**退货**任务收回来，**立刻**走一次整批处理。
   *
   * 为什么必须有它：待处理批次是进程内的状态，PM2 一重启就没了；没有这一步，
   * 已受理但还没处理的退货会永远卡在 batch_waiting（记录既没出单也没扣库存，
   * 而且因为磁盘上留着任务、重收 webhook 也只会再登记一次）。
   * 恢复只认带 `batch_kind === purchase-return` 的任务——报货的 batch_waiting
   * 不带这个标记，不会被误当成退货。
   *
   * 为什么恢复时可以直接处理、不必再等：判「到齐」的分母是**这一包**，而一包不再拆
   *（业务负责人明确「不考虑拆包」）——重启后落盘的这些 batch_waiting 任务就是那一包。
   * 处理时 runReturnBatch 还会按批次号重读整张表，所以即便有同伴没来得及落盘也不会漏。
   */
  async recoverPendingReturnBatches() {
    if (this.returnBatchRecoveryStarted) return;
    this.returnBatchRecoveryStarted = true;
    // 测试里注入的 store 可能没有 list()（自定义桩）——那种情况没有可恢复的落盘任务。
    if (typeof this.store?.list !== 'function') return;
    let pending = [];
    try {
      pending = (await this.store.list({ status: 'batch_waiting' }))
        .filter((task) => task?.batch_kind === PURCHASE_RETURN_BATCH_KIND && task?.batch_no);
    } catch (error) {
      logWarn('purchase.return.batch.recovery_failed', { error: error.message });
      return;
    }
    if (pending.length === 0) return;
    for (const task of pending) {
      const entry = this.pendingReturnBatches.get(task.batch_no) || {
        batchNo: task.batch_no,
        batchKind: PURCHASE_RETURN_BATCH_KIND,
        batchTaskId: task.task_id,
        records: new Map(),
        timer: null,
      };
      entry.records.set(task.record_id, task.task_id);
      this.pendingReturnBatches.set(task.batch_no, entry);
    }
    for (const entry of this.pendingReturnBatches.values()) {
      logInfo('purchase.return.batch.recovered', {
        batch_no: entry.batchNo, record_count: entry.records.size,
      });
      // 恢复出来的这一包直接就"到齐"了 → 立刻处理（不再重开一个时间窗）。
      this.flushBatchSoon(entry);
    }
  }

  /**
   * 退货入口：按「报货批次号」登记进待处理批次。
   *
   * 只做登记，不读表、不扣库存、不写任何业务表——真正的处理在 runReturnBatch。
   * 登记后任务停在 batch_waiting（可由同包后续记录继续加入），不会假装"处理完了"。
   */
  async handleReturnBatch(batchNo, recordId, taskId, context = {}) {
    // 惰性补一次重启恢复：即使构造时的 setImmediate 已经跑过，这里也只是空转。
    await this.recoverPendingReturnBatches();
    const waiting = { status: 'batch_waiting', batch_no: batchNo, batch_kind: PURCHASE_RETURN_BATCH_KIND };
    const existing = this.pendingReturnBatches.get(batchNo);
    if (existing) {
      existing.records.set(recordId, taskId);
      logInfo('purchase.return.batch.joined', {
        batch_no: batchNo, record_id: recordId, pending_count: existing.records.size,
      });
      // 这一条登记完了 → 记一笔「到齐」账（它后面成不成都不影响第一层）。
      this.recordPackageDone(context, recordId, existing);
      return waiting;
    }
    const entry = {
      batchNo,
      batchKind: PURCHASE_RETURN_BATCH_KIND,
      // 批次处理者的 taskId：整批的出图/发群/写附件都以它为 owner
      //（具体是哪一条记录的 task 不重要——处理时读的是表里的整批记录）。
      batchTaskId: taskId,
      records: new Map([[recordId, taskId]]),
      timer: null,
    };
    this.pendingReturnBatches.set(batchNo, entry);
    logInfo('purchase.return.batch.opened', { batch_no: batchNo, record_id: recordId });
    this.recordPackageDone(context, recordId, entry);
    return waiting;
  }

  /**
   * 到齐了（或恢复时）：把这一批交给**一个**处理者（走队列，便于测试与运维判断
   * "还有没有在处理"）。
   *
   * 同一批次正在处理时不另起一次处理——把批次留着，过一小会儿再试，绝不把任务落成
   * 终态（落了就等于丢单：库存没扣、单据没写，而任务看起来已经完成）。
   */
  async flushReturnBatch(batchNo) {
    const entry = this.pendingReturnBatches.get(batchNo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.inflightReturnBatches.has(batchNo)) {
      logInfo('purchase.return.batch.inflight_deferred', {
        batch_no: batchNo, pending_count: entry.records.size,
      });
      this.deferReturnBatch(batchNo, entry);
      return;
    }
    this.pendingReturnBatches.delete(batchNo);
    const recordTasks = new Map(entry.records);
    const batchTaskId = entry.batchTaskId;
    try {
      const result = await this.enqueue(
        'purchase-return-batch',
        batchNo,
        () => this.runReturnBatch(batchNo, batchTaskId, recordTasks),
      );
      if (result?.status === 'batch_inflight') {
        // 处理者还在跑：这一批**没有被处理**，绝不能落 completed（那等于丢单）。
        logInfo('purchase.return.batch.inflight_deferred', {
          batch_no: batchNo, pending_count: recordTasks.size,
        });
        this.deferReturnBatch(batchNo, entry);
        return;
      }
      // 整批的终态写盘：batchTaskId 拿真正结果，其余条目只是"跟着这一批处理过了"。
      // ⚠️ 逐条隔离（见 runReturnBatch）之后，批里可能有**没处理成**的记录：
      // 它们的任务要保持可重试的 failed，绝不能跟着整批被写成 completed（那样重投递
      // 会被 accept() 当成"已处理"拦掉，那一条就静默丢了）。
      const failedTaskIds = new Set(result?.failed_task_ids || []);
      const taskIds = new Set([...recordTasks.values(), ...(result?.task_ids || [])]);
      for (const id of taskIds) {
        if (failedTaskIds.has(id)) {
          // 失败原因逐条落盘（供她/运维看出"哪条没成、为什么"）。
          const reason = (result?.failed_reasons || []).find((item) => item.task_id === id)?.error
            || result?.failed_reason
            || '这一条没有处理成（可重试）';
          await this.store.update(id, { status: 'failed', error: reason }).catch(() => undefined);
          continue;
        }
        const status = id === batchTaskId && result?.status === 'posted' ? 'posted' : 'completed';
        await this.store.update(id, { status, result }).catch(() => undefined);
      }
    } catch (error) {
      // 整批失败：每个已登记的任务落成**可重试**的 failed，报单记录的处理状态保持不变。
      for (const id of new Set([...recordTasks.values()])) {
        await this.store.update(id, { status: 'failed', error: error.message }).catch(() => undefined);
      }
      logWarn('purchase.return.batch.failed_retryable', { batch_no: batchNo, error: error.message });
    }
  }

  /**
   * 把一批放回窗口、稍后重试（"同一批已经有处理者在跑"时用）。
   * 若期间已经有新的窗口（新记录到达时开的），把记录并进去，只留一个定时器。
   */
  deferReturnBatch(batchNo, entry) {
    const existing = this.pendingReturnBatches.get(batchNo);
    if (existing) {
      for (const [recordId, taskId] of entry.records) existing.records.set(recordId, taskId);
      if (existing.timer) clearTimeout(existing.timer);
    } else {
      if (entry.timer) clearTimeout(entry.timer);
      this.pendingReturnBatches.set(batchNo, entry);
    }
    const target = this.pendingReturnBatches.get(batchNo);
    // 重试间隔至少 1 秒：窗口可以配成 0（不等待），但"同一批正在处理"期间的重试
    // 不能跟着变成 0——那会在一次长处理里空转刷日志。
    const delay = Math.max(this.purchaseReturnBatchWindowMs, 1000);
    target.timer = setTimeout(() => {
      this.flushReturnBatch(batchNo).catch((error) => {
        logError('purchase.return.batch.flush_failed', { batch_no: batchNo, error: error.message });
      });
    }, delay);
  }

  /**
   * 真正处理一批退货：读该批次号下的**全部退货记录** → 逐条冻结核对计划 → 扣库存、
   * 写单据信息 → 整批**只出一次图、只发一次群**。
   *
   * 幂等与不丢单（这一段的全部意义）：
   *   · 处理前重新读表：窗口期间到的记录全部在内，不依赖任务里记了哪几条；
   *   · 退货记录**只在行为=采购退货时**才处理（同一批次号下的采购申请归报货那条链路管，
   *     这里绝不能顺手把它写成退货，更不能给任何记录补终态）；
   *   · 同一批次号用 inflightReturnBatches 上锁，第二个处理者返回 batch_inflight，
   *     由调用方把窗口放回去稍后重试；
   *   · 已经是终态的记录直接跳过（飞书重投/双击）；
   *   · 每条记录的核对计划冻结在它自己的任务里（ensureReturnPlan），配合单据幂等键
   *     与库存 operationId，复跑是真正的空操作；
   *   · 抛出去的都是真异常，由 flushReturnBatch 落成可重试的 failed——
   *     报单记录的处理状态**保持不变**，标成终态失败就是静默丢单。
   */
  async runReturnBatch(batchNo, batchTaskId, recordTasks = new Map()) {
    const table = this.gateway.table('purchaseReport');
    const allRecords = await this.gateway.listAll('purchaseReport');
    const batchRecords = allRecords.filter(
      (record) => textValue(record?.fields?.[table.fields.batchNoText]) === batchNo,
    );
    if (batchRecords.length === 0) {
      // 理论上不该发生（刚读过这条记录就有批次号）。抛错而不是静默返回：
      // 抛出去会让任务落成可重试的 failed，重收 webhook 还能救；静默返回等于丢单。
      logWarn('purchase.return.batch.no_records', { batch_no: batchNo });
      throw new Error(`报货批次号 ${batchNo} 下没有找到任何报单记录`);
    }
    const behaviorIndex = await this.loadBehaviorIndex();
    const kindOf = (record) => classifyReportBehavior(
      behaviorIndex.get(linkedRecordIds(record?.fields?.[table.fields.behavior])[0] || ''),
    );
    const returnRecords = batchRecords.filter((record) => kindOf(record) === REPORT_BEHAVIOR.PURCHASE_RETURN);
    if (returnRecords.length === 0) {
      // 这一批里没有退货（例如她把行为改成了采购申请）：这里什么都不写、也不给任何记录
      // 补终态——采购申请归报货那条链路管，补了终态就会把它整条吞掉。
      logInfo('purchase.return.batch.no_returns', {
        batch_no: batchNo, record_count: batchRecords.length,
      });
      return { status: 'already_posted', batch_no: batchNo, task_ids: [] };
    }
    // 处理顺序：明细ID（决定出图顺序，与报货那条口径一致），同值时按 record_id 稳定排序。
    const ordered = [...returnRecords].sort((left, right) => {
      const byDetail = (Number(textValue(left?.fields?.[table.fields.detailId])) || 0)
        - (Number(textValue(right?.fields?.[table.fields.detailId])) || 0);
      return byDetail || String(left.record_id).localeCompare(String(right.record_id));
    });

    if (this.inflightReturnBatches.has(batchNo)) {
      logInfo('purchase.return.batch.inflight_ignored', { batch_no: batchNo });
      return { status: 'batch_inflight', batch_no: batchNo };
    }
    this.inflightReturnBatches.add(batchNo);
    try {
      const preparedList = [];
      const taskIds = [];
      const skipped = [];
      // 逐条隔离：某一条写失败（读不到货品 / 尺码选了多个 / 单据或库存写失败……）
      // **绝不能拖死整批**——它算「处理完了」（第一层），只是**没有内容可画**
      //（第二层不进图），同批其它记录照样出图、照样发群。这是业务负责人 2026-10-06 的口径：
      // 「重试了 3 次之后还是读不到，就算处理完了」。
      // 失败的那条这里**不发群**（她只要求"说明和勾选对不上"给提示）；只把
      // 「哪条没成、为什么」记进结果与日志，供第二层的提示使用。
      const failedRecords = [];
      for (const record of ordered) {
        const recordId = record.record_id;
        // 复用这条记录自己的任务（里面可能已经冻结了核对计划）；没有就按确定性 id 建一个
        // ——表里的记录不一定都有对应 webhook（重投/补录），不能因为没有任务就丢下它。
        const taskId = recordTasks.get(recordId) || this.purchaseTaskId('supplier-report', recordId);
        try {
          let task = await this.store.get(taskId);
          if (!task) {
            task = await this.store.create({
              task_id: taskId, kind: 'supplier-report', record_id: recordId, status: 'processing',
            });
          }
          const prepared = await this.prepareSupplierReturn(recordId, taskId, task);
          taskIds.push(taskId);
          if (prepared.skipped) {
            skipped.push(recordId);
            continue;
          }
          await this.applySupplierReturn(prepared);
          preparedList.push(prepared);
        } catch (error) {
          failedRecords.push({ record_id: recordId, task_id: taskId, error: error.message });
          logWarn('purchase.return.record_failed', {
            batch_no: batchNo, record_id: recordId, task_id: taskId, error: error.message,
          });
          // 这条保持**可重试的 failed**（flushReturnBatch 会按 failed_task_ids 跳过它，
          // 不让整批的终态把它覆盖成 completed——覆盖了就等于静默丢这一条）。
          // ⚠️ 不破坏幂等：重跑时 prepareSupplierReturn 走冻结的 return_plan，
          // 单据走 createOnceByKey、库存走 operationId，重复执行是空操作。
          await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
        }
      }

      if (preparedList.length === 0) {
        logInfo('purchase.return.batch.already_posted', {
          batch_no: batchNo, ignored_record_count: skipped.length, failed_record_count: failedRecords.length,
        });
        return {
          status: failedRecords.length ? 'failed_records' : 'already_posted',
          batch_no: batchNo,
          ignored_record_ids: skipped,
          task_ids: taskIds,
          failed_record_ids: failedRecords.map((item) => item.record_id),
          failed_task_ids: failedRecords.map((item) => item.task_id),
          failed_reasons: failedRecords.map((item) => ({ record_id: item.record_id, task_id: item.task_id, error: item.error })),
        };
      }

      const requestIds = preparedList.flatMap((prepared) => prepared.docIds);
      // ⭐ 差额提示跟着**这一批退货单的话题**走：出图/发群的返回值里带话题根 message_id，
      //    传给它 → 提示回复那条根消息，和退货单落在同一个话题里（不新开话题、不发私聊）。
      const delivery = await this.deliverReturnImages(batchTaskId, batchNo, preparedList);
      for (const prepared of preparedList) {
        await this.sendReturnNotice(prepared, {
          replyToMessageId: delivery?.thread_root_message_id,
        });
      }
      const totals = preparedList.reduce((sum, prepared) => ({
        declared: sum.declared + prepared.plan.declared,
        available: sum.available + prepared.plan.available,
        taken: sum.taken + prepared.plan.taken,
        // 差额也汇总成整批的数（单条时与那条的差额相同，保持结果字段与单条链路一致）。
        shortfall: sum.shortfall + prepared.plan.shortfall,
        surplus: sum.surplus + prepared.plan.surplus,
      }), { declared: 0, available: 0, taken: 0, shortfall: 0, surplus: 0 });
      const result = {
        status: 'posted',
        is_return: true,
        batch_no: batchNo,
        record_count: preparedList.length,
        skipped_record_ids: skipped,
        // 没成的那几条留在结果里（可重试的 failed 任务 + 为什么），供第二层的提示使用。
        failed_record_ids: failedRecords.map((item) => item.record_id),
        failed_task_ids: failedRecords.map((item) => item.task_id),
        failed_reasons: failedRecords.map((item) => ({ record_id: item.record_id, task_id: item.task_id, error: item.error })),
        ...totals,
        doc_ids: requestIds,
        records: preparedList.map((prepared) => prepared.result),
      };
      logInfo('purchase.return.batch.posted', {
        batch_no: batchNo, task_id: batchTaskId,
        record_count: preparedList.length, skipped_record_count: skipped.length,
        failed_record_count: failedRecords.length,
        item_count: preparedList.reduce((sum, prepared) => sum + prepared.items.length, 0),
        doc_count: requestIds.length,
      });
      return { ...result, task_ids: taskIds };
    } finally {
      // 无论成败都释放锁：失败时任务已落成可重试的 failed，重收 webhook 要能立刻重跑；
      // 锁留下不删反而会把重试挡住。
      this.inflightReturnBatches.delete(batchNo);
    }
  }

  /**
   * 准备一条退货记录的核对计划（**只读 + 冻结**，不写任何业务表）。
   *
   * 返回 `{ skipped: true, status }` 表示这条记录已经是终态（飞书重投/双击/已被处理），
   * 调用方应当跳过它；否则返回本次处理要用的全部上下文（计划、草稿、货品信息、通知对象）。
   */
  async prepareSupplierReturn(recordId, taskId, task = {}) {
    const table = this.gateway.table('purchaseReport');
    const productTable = this.gateway.table('product');
    const record = await this.gateway.get('purchaseReport', recordId);
    const fields = record?.fields || {};
    const status = textValue(fields[table.fields.status]);
    // 终态挡重复：飞书重投、双击、并发到达时不能把同一批退货扣两遍。
    // （真正扣库存的幂等还有两层：库存操作的 operationId 由「单据信息」行 id 决定。）
    if (['已生成申请', '已取消'].includes(status)) return { skipped: true, status };
    const productIds = linkedRecordIds(fields[table.fields.product]);
    if (productIds.length !== 1) throw new Error('供应商对接必须关联一个货品编号');
    // 供应商沿用采购申请那条的取法：从货品信息的供应商关联字段读，
    // 不新增表字段，也不让她在退货表单里再填一遍（见待确认项）。
    // ⚠️ 2026-10-06 业务负责人拍板：**没维护供应商的货品也能正常退货出单**——
    // 这里不再抛错，supplier_record_id 留空，出图时归到「未标注供应商」那一组。
    // 已维护供应商的照旧按供应商分组。
    const product = await this.references.resolveProduct({ productRecordId: productIds[0] });
    const productSupplierIds = linkedRecordIds(product.record?.fields?.[productTable.fields.supplier]);
    const supplierRecordId = productSupplierIds[0] || '';
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
    const updated = await this.store.update(taskId, { draft, return_plan: plan });
    return {
      skipped: false,
      status,
      recordId,
      taskId,
      task: updated,
      plan,
      items,
      draft,
      productInfo,
      supplierRecordId,
      operatorOpenId,
      // 逐尺码对应的「单据信息」行 id（与 items 一一对应），applySupplierReturn 填。
      itemDocIds: [],
      docIds: [],
      result: null,
    };
  }

  /**
   * 应用一条退货记录：逐尺码写「单据信息」→ 扣库存 → 回写报单记录终态。
   *
   * 落库顺序是刻意的（与单条链路一字不差）：**先写「单据信息」（拿到记录 id）→
   * 再用它当库存操作的来源 → 最后出图**。库存操作的幂等键就是「单据信息」行的
   * record_id，而那一行本身由 createOnceByKey 按「幂等键」列保证只写一条，
   * 所以重跑拿到的是同一个 id、同一个库存操作——不会第二次扣库存。
   *
   * ⚠️ 只写业务事实、**不发任何消息**：出图/发群/差额通知由调用方在整批写完
   * 之后统一做（整批只发一次群）。
   */
  async applySupplierReturn(prepared) {
    const { recordId, taskId, plan } = prepared;
    const progress = { returns: {} };
    const docIds = [];
    // 关联键（只进日志）：task_id ＋ 批次号 ＋ 这条「供应商对接」记录自己的 id。
    // ⚠️ 没有批次号的旧退货数据（batchNoText 为空）→ `batch_no` **不出现**，不编。
    const correlation = purchaseCorrelation({
      taskId, batchNo: prepared.draft?.batch_no, reportRecordId: recordId,
    });
    // 逐尺码处理：一个尺码一行「单据信息」、一次库存操作。
    // 一行一个来源是必须的——库存操作的幂等键就是来源行的 record_id，多个尺码共用一个
    // 来源就不会各自拿到自己的 operationId。
    for (const [index, entry] of plan.sizes.entries()) {
      const sizeReference = await this.getSizeReferences().resolveByNumber(entry.size);
      const docKey = `purchase_return:${recordId}:${entry.size}`;
      const doc = await createOnceByKey({
        gateway: this.gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: docKey,
        label: `退货单 ${recordId} ${entry.size}码`,
        correlation,
        values: {
          behavior: relation(prepared.draft.behavior_record_id),
          product: relation(prepared.draft.product_record_id),
          size: relation(sizeReference.recordId),
          quantity: entry.quantity,
          idempotencyKey: docKey,
        },
      });
      docIds.push(doc.recordId);
      prepared.itemDocIds[index] = doc.recordId;
      progress.returns[String(entry.size)] = doc.recordId;
      await this.store.update(taskId, { posting_progress: progress, posting_stage: `return_doc:${entry.size}` });
      // 扣库存：走 InventoryService.applyChange（不另写一套库存逻辑）。
      // state 只用于本地任务键（同货品+尺码串行/恢复）；真正扣哪些状态由注册表
      // STOCK_PURCHASE_DECREASE 的 consumes 决定 = 门盒 + 样品 + 仓库。
      const change = await this.inventory.applyChange({
        kind: MOVEMENT_PURCHASE_DECREASE,
        productRecordId: prepared.draft.product_record_id,
        size: entry.size,
        state: '门盒',
        quantity: entry.quantity,
        sourceRecordId: doc.recordId,
        // ⚠️ 2026-10-06：不再传 occurredAt。
        // 它只落在**本地任务记录**的 occurred_at 上（inventoryService 的 operation store），
        // 全仓 grep 没有任何读方；它也**不写**「库存流水」的时间列——那一列（「发生时间」）
        // 2026-10-05 就被业务负责人从生产表删掉了，映射也早删了。
        // 时间语义一律交给飞书自动的「创建时间」，代码不再自带时间戳。
      }, { correlation });
      logInfo('purchase.return.stock_applied', {
        record_id: recordId, task_id: taskId, size: entry.size, quantity: entry.quantity,
        doc_id: doc.recordId, ledger_record_id: change?.ledgerRecordId || '', live_record_ids: change?.liveRecordIds || [],
        ...correlation,
      });
    }

    if (docIds.length) {
      // 报单记录的处理状态：沿用采购申请那条的终态「已生成申请」——行为管理里
      // 只有这一套终态可复用（另加一个「已退货」选项要动她的表，超出本次口径）。
      // 顺带把「关联采购申请」指向刚写的单据信息行，两个方向都可追溯。
      await this.gateway.update('purchaseReport', recordId, {
        status: '已生成申请',
        request: docIds,
      }, { correlation }).catch((error) => logWarn('purchase.return.report_status.failed', {
        record_id: recordId, task_id: taskId, error: error.message,
      }));
    }
    prepared.docIds = docIds;
    prepared.task = await this.store.update(taskId, { request_ids: docIds });
    prepared.result = {
      status: 'posted',
      is_return: true,
      record_id: recordId,
      declared: plan.declared,
      available: plan.available,
      taken: plan.taken,
      shortfall: plan.shortfall,
      surplus: plan.surplus,
      doc_ids: docIds,
    };
    return prepared;
  }

  /**
   * 整批退货**只出一次图、只发一次群**（复用采购申请那条「按供应商出图 → 发到群 →
   * 写回附件」的完整流程，只换标题）。
   *
   * 整批的明细合成一份草稿挂在批次任务上：同一供应商的明细合成一张图，
   * 多个供应商时也是"每供应商一张图"，且后续的图/文字都会回复第 1 条（见
   * deliverSupplierImagesInner 的话题处理），不会各成一个话题。
   */
  async deliverReturnImages(batchTaskId, batchNo, preparedList) {
    const items = preparedList.flatMap((prepared) => prepared.items);
    const requestIds = preparedList.flatMap((prepared) => prepared.docIds);
    const requestIdByItemKey = {};
    let index = 0;
    for (const prepared of preparedList) {
      for (const docId of prepared.itemDocIds) {
        requestIdByItemKey[`${batchTaskId}:${index}`] = docId;
        index += 1;
      }
    }
    const operatorOpenId = preparedList.map((prepared) => prepared.operatorOpenId).find(Boolean) || '';
    const updated = await this.store.update(batchTaskId, {
      draft: { is_return: true, batch_no: batchNo, operator_open_id: operatorOpenId, items },
      request_ids: requestIds,
      return_record_ids: preparedList.map((prepared) => prepared.recordId),
    });
    return this.deliverSupplierImages(batchTaskId, updated, {
      request_ids: requestIds,
      request_id_by_item_key: requestIdByItemKey,
      batch_no: batchNo,
    }, {
      title: RETURN_TITLE,
      fileNameSuffix: '退货单',
      // ⚠️ 映射里标清这是**退货单**：到货核对看到这个标记就不再处理这条话题
      //（退货单没有尺码，本来也对不上到货明细）。
      kind: ARRIVAL_BATCH_KINDS.PURCHASE_RETURN,
    });
  }

  /**
   * 差额/没对上的情况必须说出来——「对不上的就说这部分对不上」。
   * 对得上时不发（图本身就是回执），免得刷屏。
   *
   * ⭐ 发到**采购群**（不再发经办人私聊）：业务负责人 2026-10-06 的口径是
   * 「一律在话题群里，以后私聊路线就没有了」。传了 `options.replyToMessageId`
   * （= 这一批退货单图的话题根）就**回复它** → 提示与退货单落在**同一个话题**里；
   * 没配采购群就大声跳过、**绝不回落私聊**。
   * 失败只记日志（见 sendPurchaseGroupNotice）——库存已经扣了、单据已经写了，
   * 不能因为一条提示发不出去就把业务事实判成失败。
   */
  async sendReturnNotice(prepared, options = {}) {
    const notice = buildPurchaseReturnNotice({
      itemNo: prepared.productInfo.itemNo,
      color: prepared.productInfo.color,
      size: prepared.plan.size,
      plan: prepared.plan,
    });
    if (!notice) return false;
    const replyToMessageId = String(options?.replyToMessageId || '').trim();
    // 关联键：这条提示属于哪一笔退货（task_id ＋ 批次号 ＋ 报单记录 id），只进日志。
    const correlation = purchaseCorrelation({
      taskId: prepared.taskId, batchNo: prepared.draft?.batch_no, reportRecordId: prepared.recordId,
    });
    const sent = await this.sendPurchaseGroupNotice(notice, { replyToMessageId, correlation });
    logInfo('purchase.return.notice', {
      record_id: prepared.recordId, task_id: prepared.taskId,
      declared: prepared.plan.declared, available: prepared.plan.available,
      taken: prepared.plan.taken, shortfall: prepared.plan.shortfall,
      surplus: prepared.plan.surplus, sent, reply_to_message_id: replyToMessageId,
      ...correlation,
    });
    return sent;
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
    const prepared = await this.prepareSupplierReturn(recordId, taskId, task);
    if (prepared.skipped) return { ignored: true, status: prepared.status };
    await this.applySupplierReturn(prepared);
    let delivery = null;
    if (prepared.docIds.length) {
      // 出图 → 发群 → 写回附件（复用采购申请那条完全相同的流程，只换标题）。
      // ⚠️ 整批出图走 deliverReturnImages（一次发群）；这里单条时 preparedList 只有它自己。
      delivery = await this.deliverReturnImages(taskId, prepared.draft.batch_no, [prepared]);
    }
    // ⭐ 差额提示回复「这一批退货单图」那条根消息 → 落在同一个话题（不再发经办人私聊）。
    await this.sendReturnNotice(prepared, { replyToMessageId: delivery?.thread_root_message_id });
    logInfo('purchase.return.posted', {
      record_id: recordId, task_id: taskId, declared: prepared.plan.declared,
      available: prepared.plan.available, taken: prepared.plan.taken,
      size_count: prepared.plan.sizes.length, doc_count: prepared.docIds.length,
      // 单条退货路径：批次号来自草稿（旧数据可能是空 → 不出现）。
      ...purchaseCorrelation({ taskId, batchNo: prepared.draft?.batch_no, reportRecordId: recordId }),
    });
    return prepared.result;
  }

  /**
   * 建档进度落盘。
   *
   * 建档是远端写入，按项目约定必须把已经写出的 record_id 落盘：任务失败后重试
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
      // 本次到货的价格计划（item_no → 可信单价 / 冲突标记）。
      // 由写草稿的一方从 task.recognized 里重建（见 ensureArrivalProducts）。
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

    const created = await this.gateway.create('color', { name: color }, { correlation: context.correlation });
    const recordId = created?.recordId || '';
    if (!recordId) throw new Error(`颜色「${color}」新建失败`);
    context.colorIndex.set(key, recordId);
    context.createdColors.push({ name: color, color_record_id: recordId });
    await this.persistArrivalCreation(context);
    logInfo('purchase.arrival.color_created', { color, color_record_id: recordId });
    return { recordId, created: true };
  }

  /**
   * 给新品建一条「货品信息」，然后原样返回新记录。
   *
   * ⚠️ 只由 ensureArrivalProducts 调用。它原先的时序约束（"发确认卡片之前不做创建"）已随
   * 到货卡片退场失效——现在没有卡片了，调用方自己决定什么时候建；幂等规则一字不变。
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

    const created = await this.gateway.create('product', values, { correlation: context.correlation });
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
    // 建档时已经把成本写进去了：登记成"已处理"，applyArrivalCost 就不会再对它
    // 走一次"成本为空 → 写"的判断（重试也不会）。
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
   * 到货新品建档 + 到货单价格写成本。
   *
   * ⚠️ 2026-10-05：**这个方法现在没有调用方**——它原本由 processArrival（发完卡片之后）
   * 和到货卡片确认（confirmArrival 兜底）各调一次，两处都随「拍照识别」退场删掉了。
   * **刻意保留**：它就是将来「对话到货」和「货品上新提前」要用的建档能力，
   * 未合并分支 refactor/decouple-creation-and-stock 正把它原样剥成
   * services/productCreationService.js（输入改成结构化明细、不认 OCR / 图片 / 到货任务）。
   *
   * 输入：task.draft.pending_creation（要建什么）+ task.recognized（价格来源）。
   * 两者原先都由 processArrival 写进任务；形状不变，新流程照这个形状写就行。
   *
   * 幂等（三道，缺一不可）：
   *   ① 同一个 taskId 的多次调用走 creationQueue **串行**——调用方之间
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
      // 建档 / 写成本也是写库动作：关联键（task_id ＋ 批次号 ＋ 到货记录 id）挂在这个
      // **只在本进程内传递**的 context 上 —— 不落盘、不进任何业务入参，只进日志。
      context.correlation = purchaseCorrelation({
        taskId, batchNo: draft.batch_no, arrivalRecordId: draft.arrival_record_id,
      });
      // 价格计划按任务里落盘的**到货明细**（task.recognized）重建：建档顺带写成本、
      // 老货品补成本，两条路用的是同一份计划，规则仍然是"同货号价格冲突就整条不写"。
      context.arrivalCostPlan = buildArrivalCostPlan(task.recognized || []);
      // 同一货号读出多个不同单价 → 整条不写，这里**只打一条 warn**（否则同一货号的每个
      // 尺码都会重复报一次）。这段原先在 processArrival 里，识别退场后挪到"建计划的地方"——
      // 规则不变：谁建计划，谁负责报冲突。
      for (const entry of context.arrivalCostPlan.values()) {
        if (!entry.conflict) continue;
        logWarn('purchase.arrival.cost_conflict', {
          task_id: taskId,
          arrival_record_id: draft.arrival_record_id || '',
          item_no: entry.item_no,
          prices: entry.prices,
          reason: '同一货号读出多个不同单价，不写成本，请人工核对',
        });
      }

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

      // 已经匹配到老货品的行：成本跟建档一起补（原来这个顺序由"发完卡片再写"决定，
      // 卡片退场后只保留"成本和建档同一步完成"这个事实）。
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
      // 恢复出来的条目没有回读数据：缺口按"读不到"处理（这些字段只进日志/草稿，
      // 到货明细卡片已随识别链路退场删除，所以不再有"还差什么"上卡片这件事）。
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
   *   3. 同一货号多行价格不一致 → 整条不写（conflict 由调用方统一记一条 warn）；
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
      await this.gateway.update('product', recordId, { cost: entry.cost }, { correlation: context.correlation });
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

  // ── 已删除：processArrival（拍照识别的唯一入口）────────────────────────────
  // 它做过的事：读「采购到货」记录 → 写「识别中」→ 下载图片 → 视觉模型识别（鞋盒 / 到货单）
  // → 逐行匹配货品 → 组装草稿 → 写「识别成功」→ 发到货明细卡片 → 后台建档。
  // 2026-10-05 业务负责人删掉「类型」「识别状态」「识别失败原因」三个字段并决定这条链路退场，
  // 整段随之删除：它写的字段在表里已不存在，留着只会伪装成「识别还在跑」。
  //
  // ⚠️ 保留下来的（**2026-10-06 起有调用方了**：群话题对话式核对，她点「是」之后进来）：
  //   · confirmArrival    —— 写「采购入库」+ 调库存 applyPurchase + 把到货记录标已确认
  //                          （**不再回写采购申请表**，见该方法的注释）
  //   · ensureArrivalProducts / ensureArrivalProduct / ensureArrivalColor / applyArrivalCost
  //                       —— 新品建档 + 成本（未合并分支 refactor/decouple-creation-and-stock
  //                          正把它剥成 services/productCreationService.js）
  //   · aggregateArrivalItems / findRequestRowForInbound / resolvePurchaseInboundState
  // 它们的输入（draft.actual / pending_creation / task.recognized）由
  // services/purchaseArrivalConversationService.js 写入，形状与 processArrival 原先落的草稿一致。

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
    // ⚠️ 2026-10-05：`confirm_purchase_arrival` / `cancel_purchase_arrival` 两个动作
    // 已随「拍照识别」退场删除（见 PURCHASE_CARD_ACTIONS 的注释）。到货的确认状态
    // （待确认/已确认/已取消…）现在是表里的普通字段，需要时人工改。
    if (action === 'cancel_purchase_request') {
      if (task.status === 'posted') return { toast: { type: 'info', content: '采购申请已生成，不能取消' } };
      // 支持批量和单条两种取消
      const reportIds = task.draft.report_record_ids || [task.draft.report_record_id];
      for (const rid of reportIds) {
        // 取消也是写「供应商对接」：同一组关联键（批次号在草稿里，可能没有 → 不出现）。
        await this.gateway.update('purchaseReport', rid, { status: '已取消' }, {
          correlation: purchaseCorrelation({
            taskId, batchNo: task.draft.batch_no, reportRecordId: rid,
          }),
        }).catch(() => undefined);
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
    // 关联键（只进日志）：task_id ＋ 批次号（plan 里已经冻结好了，重试不会换号）；
    // 每条写入再按需补上**它自己那条报单记录**的 id。
    const baseCorrelation = purchaseCorrelation({ taskId, batchNo: plan.batch_no });
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
        correlation: baseCorrelation,
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
          // 「单据信息」这一行属于哪一条报单记录，计划里记着（item.report_record_id）。
          correlation: mergeCorrelation(baseCorrelation, {
            purchase_report_record_id: item.report_record_id,
          }),
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
      }, {
        correlation: mergeCorrelation(baseCorrelation, { purchase_report_record_id: rid }),
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

  /**
   * 到货确认入库：写「采购入库」→ 调库存 applyPurchase → 把到货记录的「确认状态」改成已确认。
   *
   * ⚠️ **不回写采购申请表**（业务负责人 2026-10-06 口径：「那个表就不要动」）。
   * 2026-10-05 之前它还由到货明细卡片的 `confirm_purchase_arrival` 动作调用；
   * 卡片随「拍照识别」退场后它一度是孤儿能力，**现在由「群话题对话式核对」在
   * 她点「是」之后调用**（见 services/purchaseArrivalConversationService.js）。
   *
   * 幂等（缺一不可）：inbound_created 落盘 + 按到货记录回查远端 + inflightInbound，
   * 重复调用不会写出第二条采购入库、也不会重复加库存。
   *
   * 并发：同一个 taskId 的确认走 confirmationQueue **串行**。这条保证原先由
   * handleCardActionLocked（到货卡片那个入口）提供，卡片删除后原样挪进来——
   * 否则两个调用方同时确认时，两边都会在对方落盘之前读到"还没写过"，各写一条入库。
   */
  async confirmArrival(taskId, task, operatorOpenId) {
    return this.confirmationQueue.run(taskId, () => this.confirmArrivalLocked(taskId, task, operatorOpenId));
  }

  /** 真正的入库实现：只由 confirmArrival 串行调用，不要直接调（会丢掉串行保证）。 */
  async confirmArrivalLocked(taskId, task, operatorOpenId) {
    if (task.status === 'posted') return { toast: { type: 'info', content: '采购到货已入库' } };
    // 她点确认时如果建档还没跑完（或上一次失败了），在这里同步补一次。
    // 建档是幂等的、并且和别的调用方走同一个 creationQueue，所以不会建出第二条。
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
    // 关联键（只进日志）：到货核对任务自己的 task_id（`arrival_reconcile_…`，
    // **是另一套 task，如实照传真名**）＋ 批次号 ＋「采购到货」记录 id。
    // ⚠️ 这条链路**拿不到**「供应商对接」报单记录 id（到货任务里只存 request_ids）
    //    —— 拿不到就不传，不编。
    const correlation = purchaseCorrelation({
      taskId, batchNo: draft.batch_no, arrivalRecordId: draft.arrival_record_id,
    });
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
    // 查「采购行为」这条记录的 record_id（关联字段不能直接传字符串）。
    //
    // ⭐ 按「行为编码」匹配，**不按中文名**：编码是稳定标识，她在飞书里改中文名不影响代码。
    //    （2026-10-07 真机：她把生产表里那条从「采购入库」改成了「入库」，按中文名找就直接抛
    //     "必须且只能有一条记录"，她点「是」永远入不了库。）
    //    范式与本仓 `inventoryService.resolveStockBehavior` 一致（那里也是按编码匹配）。
    // ⚠️ 编码取 `config/purchaseBehaviors` 里的**那一个**常量，别在这里再写一份字面量。
    const behaviorTable = this.gateway.table('behavior');
    const behaviorCode = PURCHASE_BEHAVIORS.INBOUND;
    const behaviorMatches = (await this.gateway.listAll('behavior')).filter(
      (record) => textValue(record.fields?.[behaviorTable.fields.code]).trim() === behaviorCode
    );
    if (behaviorMatches.length === 0) {
      throw new Error(`行为管理里找不到编码为「${behaviorCode}」的行为，请先在「行为管理」表补上这一条（名称随便叫，编码必须是 ${behaviorCode}）`);
    }
    if (behaviorMatches.length > 1) {
      throw new Error(`行为管理里编码为「${behaviorCode}」的行为有 ${behaviorMatches.length} 条，只能留一条`);
    }
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
            // ⚠️ 2026-10-06：不再传 occurredAt（同下：只进本地任务记录、无人读）；
            // 时间交给飞书自动的「创建时间」。
            state: inboundState,
          }, { correlation });
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
        // ⚠️ 2026-10-06：不再写「入库时间」——业务负责人已把这一列从生产表删除
        // （生产真表「采购入库」11 列里没有它），入库时刻由飞书自动的「创建时间」承担
        //（同一时刻，不丢信息）；schema 里的 inboundAt 映射也同步删掉了。
      }, { correlation });
      created.push(inbound.recordId);
      const entry = { recordId: inbound.recordId, inventoryApplied: false };
      await persistEntry(key, entry);
      if (this.enablePurchaseInventory) {
        await this.inventory.applyPurchase({
          purchaseInboundRecordId: inbound.recordId,
          productRecordId: item.product_record_id,
          size: item.size,
          quantity: item.quantity,
          // ⚠️ 2026-10-06：不再传 occurredAt（只进本地任务记录、无人读）；
          // 时间交给飞书自动的「创建时间」。
          state: inboundState,
        }, { correlation });
        entry.inventoryApplied = true;
        await persistEntry(key, entry);
      }
    }
    // ⚠️ 2026-10-06：这里原先有一段**回写「单据信息」（采购申请表）**的代码——
    //   for (const request of arrival.requests) { … gateway.update('purchaseRequest', request.record_id,
    //     { arrivalStatus: status }) }   // 未到货 / 部分到货 / 全部到货 / 超额到货
    // 业务负责人当天的口径是：「**既然它就是采购申请，那个表就不要动**」
    //「我们要做的就是**基于采购申请表，再加上用户说的差异来进行实际入库**」。
    // 所以她删掉了这段回写：**采购申请表一个字都不改**（到货差异只体现在
    //「采购入库」/「库存流水」/「实时库存」上）。
    // 这条口径由 `server/test/arrivalConversation.test.js` 的断言钉住：入库全过程
    // 对 `purchaseRequest` 表**零写入**（不是"看起来没写"，而是拿记录型 gateway 断言）。
    //
    // ⚠️ 也刻意**不再**把差异算成「超额到货 / 部分到货」这种状态：新口径下
    // 那个状态无处可写，算出来只会变成一个没人用的中间变量。
    //
    // 到这为止，除「采购到货」这一行自己的「确认状态」之外，入库只写
    //「采购入库」+「库存流水」+「实时库存」三张表。
    await this.gateway.update('purchaseArrival', arrival.arrival_record_id, { confirmStatus: '已确认' }, { correlation });
    await this.store.update(taskId, { status: 'posted', inbound_record_ids: created });
    this.inflightInbound.delete(taskId);
    logInfo('purchase.arrival.posted', {
      task_id: taskId, arrival_record_id: arrival.arrival_record_id, inbound_count: created.length,
      inventory_applied: this.enablePurchaseInventory, ...correlation,
    });
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
