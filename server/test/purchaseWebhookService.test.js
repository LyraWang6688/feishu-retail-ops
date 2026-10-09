const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');

// 新品的记录链接要用 Base token 拼。本地/CI 没有真配置时给个测试值，
// 才能断言「链接带上了正确的 record_id」。（每个测试文件是独立进程，不会污染别的用例。）
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 采购单现在**发到群**（业务负责人：「不用再看经办人了」），群 id 从配置读、**没有默认值**。
// 这个文件里绝大多数用例真正关心的是"采购事实写没写、附件写没写回"，出图/发图是它们的
// 必经步骤，所以在这里给一个测试群 id。
// ⚠️ 「没配群 id 时会怎样」是单独一条用例，它走构造入参 `sandboxChatId` 显式覆盖，
// 不靠改这个全局值（同进程里并发跑用例时改全局会互相污染）。
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-test-'));

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

// 「尺码」是指向「尺码管理」的关联字段：写入用关联 ID，读取时解析回整数。
const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const mapFields = (tableKey, semanticValues) => {
  const schema = V1_BITABLE_SCHEMA.tables[tableKey];
  const out = {};
  Object.entries(semanticValues || {}).forEach(([key, value]) => {
    const fieldName = schema?.fields?.[key];
    if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
    if (value !== undefined) out[fieldName] = value;
  });
  return out;
};

const makeGateway = (records = {}) => {
  const uploads = [];
  // ⭐ 2026-10-07 深夜加的：把每次 create/update 记下来 —— 「到货确认一个业务表都不新建」
  // 这类断言需要"到底写过哪几张表"的**行为证据**（原先只有"某张表有几条记录"）。
  const writes = [];
  // 飞书附件单元格里的 `name` 是**上传时那个文件名**（不是我们写入时给的）。
  // 这里照样模拟：token → 文件名。少了它，「重复执行不新增第二条」就测不出来
  //（去重判据正是"这一批里已经有同名的图了"）。
  const tokenNames = new Map();
  return {
    uploads,
    writes,
    table,
    get: async (tableKey, recordId) => {
      const list = records[tableKey] || [];
      return list.find((r) => r.record_id === recordId) || null;
    },
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement' && !records.sizeManagement) return SIZE_RECORDS;
      if (tableKey === 'behavior' && !records.behavior) {
        return [{ record_id: 'behavior_purchase_in', fields: { '行为名称': '采购入库', '行为编码': 'PURCHASE_IN', '库存方向': '增加', '是否启用': true } }];
      }
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ op: 'create', tableKey, values: fields });
      const recordId = `new_${tableKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const record = { record_id: recordId, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      writes.push({ op: 'update', tableKey, recordId, values: patch });
      // 飞书附件字段读回来带 `name`（= 上传时的文件名）；这里照着补上，
      // 否则「重复执行不新增第二条」的去重判据在假 Base 上永远命中不了。
      if (Array.isArray(patch['单据'])) {
        patch['单据'] = patch['单据'].map((item) => ({
          ...item, name: tokenNames.get(item.file_token) || item.name || '',
        }));
      }
      const list = records[tableKey] || [];
      const record = list.find((r) => r.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    // 采购申请图写回附件字段时用：飞书是先传素材拿 file_token、再把 token 写进附件字段。
    uploadAttachment: async (filePath) => {
      uploads.push(filePath);
      const token = `file_token_${uploads.length}`;
      tokenNames.set(token, path.basename(filePath));
      return token;
    },
  };
};

const makeReferences = (overrides = {}) => ({
  resolveProduct: overrides.resolveProduct || (async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: ['sup_1'] } } })),
  resolveSupplier: overrides.resolveSupplier || (async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '测试供应商' } } })),
});

// ⚠️ 原先这里还有 recognizeLabels / recognizePurchaseDocument 两个假实现（鞋盒 / 到货单识别）。
// 拍照识别链路退场后 service 只剩**文字**解析这一个 recognizer 用途（采购数量说明），
// 所以假实现也只留它。

const makeClient = (overrides = {}) => ({
  im: {
    // 发图要先用 im.image 上传拿 image_key，再发 image 消息。
    image: {
      create: overrides.uploadImage || (async () => ({ image_key: `img_key_${Math.random().toString(36).slice(2, 8)}` })),
    },
    message: {
      create: overrides.sendMessage || (async () => ({ code: 0, msg: 'success' })),
      // 2026-10-06 起：采购单发到群时，第 1 条（图）之后的每条消息都用 `reply`
      // 回复第 1 条（业务负责人拍板：一条开话题 + 后面的回复它）。
      // 默认实现只回一句成功、不带 message_id——绝大多数用例不关心群消息的落点。
      reply: overrides.replyMessage || (async () => ({ code: 0, msg: 'success' })),
    },
  },
});

// 出图的假实现：记录每个供应商一次的渲染调用，测试就能断言
// 「多供应商出多张」「同供应商合成一张」，而不必在单测里真的跑 sharp。
const makeImages = (options = {}) => {
  const calls = [];
  return {
    calls,
    render: async (input) => {
      calls.push(input);
      if (options.render) return options.render(input);
      return Buffer.from(`fake-png:${input.supplierName || ''}:${(input.items || []).length}`);
    },
  };
};

const makeInventory = (options = {}) => {
  const calls = [];
  const sampleRecords = options.sampleRecords || []; // 模拟样品库存记录
  return {
    calls,
    applyPurchase: async (input) => { calls.push(input); return { stockKey: `${input.productRecordId}|${input.size}`, ledgerRecordId: 'ledger_1', liveRecordIds: ['live_1'], movementQuantity: input.quantity, direction: '增加', quantity: input.quantity }; },
    findLiveInventory: async (productRecordId, size, state) => {
      // 默认返回空数组（表示没有样品库存），测试时可通过 options.sampleRecords 配置
      return sampleRecords;
    },
  };
};

const makeService = (options = {}) => {
  const dir = options.dir || tempDir();
  const store = options.store || new JsonTaskStore({ dir });
  const gateway = options.gateway || makeGateway();
  const references = options.references || makeReferences();
  const inventory = options.inventory || makeInventory();
  const client = options.client || makeClient();
  const images = options.images || makeImages();
  const service = new PurchaseWebhookService({
    gateway, references, inventory: inventory.applyPurchase ? inventory : undefined,
    client, store, images, enablePurchaseInventory: options.enablePurchaseInventory ?? true,
    // 对外调用的超时：undefined 时用服务自己的默认值。
    // ⚠️ 到货识别那一组（mediaTimeoutMs / recognitionTimeoutMs / failureWrite* /
    // arrivalNotice* 四个等待阈值）已随识别链路退场删除，构造入参也不再传。
    imTimeoutMs: options.imTimeoutMs,
    gatewayTimeoutMs: options.gatewayTimeoutMs,
    // 群聊定位器（发到群后写 message_id ↔ 批次映射）指向临时目录：
    // 不传的话服务会自建 data/purchase_group_messages，用例之间会互相看见对方的映射。
    batchLocatorStore: options.batchLocatorStore,
    batchLocator: options.batchLocator,
    // 测试用的显式群通道（见 sendPurchaseGroupNotice）：传了就不读 PURCHASE_CHAT_ID，
    // 并发用例之间不会因为环境变量互相污染。
    sandboxChatId: options.sandboxChatId,
  });
  return { service, store, gateway, references, inventory, client, images, dir };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 让"新建"慢一拍：并发/串行用例靠它把两次写入挤到一起（原文件里的工具，保留）。
const slowCreates = (gateway, pause = 5) => {
  const originalCreate = gateway.create;
  gateway.create = async (tableKey, values) => {
    await wait(pause);
    return originalCreate(tableKey, values);
  };
  return gateway;
};

// 发送器契约用例要的最小 service：只关心「发出去的那条 payload 长什么样」。
// ⚠️ 原先借用 `makeGroupPurchaseService`（它会构造一条「信息填写」报单记录）——
//    那条入口已随整表删除退场，这里改成**直接给 service 一个记录型 IM 替身**。
const makeSenderService = () => {
  const sent = [];
  const { service } = makeService({
    sandboxChatId: 'oc_test_purchase_group',
    client: makeClient({
      sendMessage: async (params) => {
        sent.push(params);
        return { code: 0, data: { message_id: `om_sent_${sent.length}`, thread_id: '' } };
      },
      replyMessage: async (params) => {
        sent.push(params);
        const inThread = params?.data?.reply_in_thread === true;
        return { code: 0, data: { message_id: `om_sent_${sent.length}`, thread_id: inThread ? 'omt_sent_thread' : '' } };
      },
    }),
  });
  return { service, sent };
};

// accept() 返回时后台处理并没有结束：它把工作丢进 setImmediate，之后还要解析、
// 写卡片、等批次窗口，耗时取决于机器。固定 sleep 在慢机器上会读到 processing
// 这类中间状态（CI 上就这样失败过），所以统一改为轮询到任务进入稳定状态。
// ⚠️ 原先这里还有 'awaiting_confirmation'（到货识别跑完、等卡片的中间态）。
// 识别链路退场后没有任何一条链路会落到那个状态，所以从"稳定态"里去掉——
// 留着会让等待逻辑把一个永远不会出现的状态当成终点。
const SETTLED_STATUSES = ['failed', 'cancelled', 'posted', 'completed'];

// ⚠️ 批次链路上「status=posted」**不等于**「跑完了」。
//
// confirmPurchaseRequest 写完采购申请后就把任务置成 posted（这是有意的：让重复投递
// 立刻被幂等守卫挡掉，不再发第二遍图），之后还要出图、发图、把附件写回记录，最后才由
// process() 把 result 落盘。所以「处理完了」的唯一可靠判据是**result 已落盘**：
// 只等 status=posted 会在慢机器上读到半成品状态（status 已落盘、result 还没有），
// CI 上就是这样挂的——TypeError: Cannot read properties of undefined (reading 'status')。
// failed 是唯一的例外：它是 process() 的收尾写入，本来就没有 result。


const waitForTask = async (store, taskId, statuses = SETTLED_STATUSES, { attempts = 1500, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await store.get(taskId);
    if (task && statuses.includes(task.status)) return task;
    await wait(pause);
  }
  const last = await store.get(taskId);
  throw new Error(`等待任务进入 ${statuses.join('/')} 超时，当前状态：${last?.status}`);
};

const waitFor = async (label, check, { attempts = 1500, pause = 10 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await wait(pause);
  }
  throw new Error(`等待「${label}」超时`);
};

// ─── 报货批次链路的时间等待 ─────────────────────────────────────────────────
//
// 批次什么时候处理，由「报货批次号 + 短窗口」的归批决定（见下面「归批」一节）；
// 这些用例一律用轮询不变量（waitFor / waitForTask / waitForBatchPosted）等待，
// 不用固定 sleep 卡时间。

// ─── 供应商报单链路（免确认 → 按供应商出图 → 发图 → 写回附件）───

// ⚠️ 原先这里还有一个 cardMessages（只数 interactive 卡片消息）：它服务的是到货详情卡片
// 那几条断言。到货卡片与本文件里的卡片断言一起删掉了，helper 也没人用了。
// 留下一句提醒：断言消息条数时先想清楚"这条链路上会发几种消息"，别被提示类消息带偏。

// ─── 供应商报单链路 ───

// 出图要用的货品信息：货号 / 颜色（关联字段会带回被关联记录的主字段文本）/ 编号 / 供应商。

// ⛔ 2026-10-09：原先这里有个 `waitForBatchPosted`（等「信息填写」的记录全进「已生成申请」）
//   —— 那条报单入口与那张表一起退场，helper 没有调用方了，随之删除。

// 「posted」表示采购申请已经写成，附件写回是它之后的收尾动作（顺序：先发图、再写附件）。
// 所以断言附件不能只等任务状态，要等附件字段真的落到记录上。
//
// ⚠️ 2026-10-07：附件落点从「具体信息.采购申请单」搬到**「报货批次.单据」**
//（业务负责人：「把这些信息挪到我们的'报货批次'里面」；原来那一列她已从生产表删除）。
// 判据本身没变：**每个供应商一张图** → 「单据」里就有几个 file_token。

// ⛔⛔ 2026-10-09：本文件里**由「信息填写」表变更事件驱动**的那批用例**整批删除**。
//
// 事实：业务负责人把「信息填写」表（`purchaseReport`）**整个从 Base 删掉了**，
//   口径是**「自然语言 ＋ AI 录入」整套退场** ⇒ 服务端那条入口（`accept` /
//   `acceptMany` / 报货解析 / 归批 / 采购退货）与它一起退场，这些用例钉的行为不存在了。
// 被删掉的是这些用例（名字留档，便于将来对照 git 历史）：
//   · 供应商报单免确认 / 重收同一条报单 webhook / 多尺码一次报单 / 合并成一张图 /
//     多供应商各一张图 / 先发图再写表 / 发图失败不判失败 / 图片写回「报货批次.单据」 /
//     哨兵：报货确认卡已删除 / 没有手填批次号（入口写回）/ 入口读不到那条记录；
//   · invalid record_id / 带批次号免确认 / 同批次多条合成一个批次任务 / 不再依赖合计数量 /
//     采购申请一条 / 没维护供应商 / 采购退货一条 / 一包多条只处理一次 / 一包里坏 record_id /
//     分两次到达 / 「到齐就发」/ 到齐判据 / 混着申请与退货 / 重复投递 / 并发到达 /
//     未到齐告警退场 / 异常不静默丢单 / 批次早已生成 / product without supplier… /
//     A1 并发重收 / A3 已 posted 重复投递 / B1..B4 崩溃与幂等 / A：发群与 @经办人（3 条）/
//     C：定位回归（3 条）/ A：拿不到经办人 / ③ 行为读不到 / ⑤ 说明对不上（2 条）。
//
// ⭐ **保留**的是**现役能力**的用例：到货确认（加库存 / 幂等 / 旧进度键）、新品建档、
//    成本写入，以及发送器的 `inThread` 契约。
// ⭐「生成采购申请」这条链路的现役覆盖在 **`test/scanPageWrite.test.js`**
//    （扫码补货报单 → 既有免确认 `publishPurchaseRequest` → 「报货批次」＋「报货信息」），
//    以及守门用例 `test/purchaseIntakeRetired.test.js`。

// 货品表里确实没有这条：resolveProduct 抛带 code 的错，建档那一步才敢自动建。
// 「货号对应多个颜色」这类歧义不带这个 code。

// 捕获 warn 日志（logger 的 warn 走 console.warn，一行一个 JSON）。
// 这些测试在同一个文件里顺序执行，await 期间不会有别的用例并发写 console。
const captureWarn = async (run) => {
  const lines = [];
  const original = console.warn;
  console.warn = (line) => {
    try { lines.push(JSON.parse(line)); } catch { lines.push({ event: 'unparsed_warn', raw: String(line) }); }
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.warn = original;
  }
};

// 种一条「识别已经跑完」的到货任务。形状与 processArrival 原先落盘的草稿完全一致；
// 生产上这份草稿将来由「对话到货」流程写入，测试里直接种。
//
// 为什么不从入口进：入口（drive.file.bitable_record_changed_v1 → kind='arrival'）
// 已摘掉，accept('arrival') 不再有处理分支——那是"链路退场"的定义。
//
// ⚠️ 2026-10-07 晚：到货信息的落点变成**「报货批次」那一行** ⇒ 草稿上的键从
//    `arrival_record_id` 换成 `batch_record_id`（＋ `batch_no`）。默认**两个都空** ——
//    那是"孤儿调用"的形状（改动前这些用例就没有批次关联），入库能力照常跑，
//    到货信息的两步写入按设计跳过。要验"写到批次行"的用例，显式传 batchRecordId/batchNo。
const seedArrivalTask = async (store, {
  taskId,
  batchRecordId = '',
  batchNo = '',
  acceptanceText = '',
  // ⭐ 2026-10-09：「实际数量 / 实际金额」是到货核对那一步算好、放在草稿上的两个值
  //   （「验收原话」那一列已被生产表删除，不再落库）。
  actualQuantity,
  actualAmount,
  operatorOpenId = 'ou_1',
  actual = [],
  requests = [],
  pendingCreation = [],
  recognized = [],
  inboundCreated = null,
} = {}) => {
  const id = taskId || `purchase_arrival_${Math.random().toString(36).slice(2, 10)}`;
  await store.create({ task_id: id, kind: 'arrival', record_id: batchRecordId, status: 'awaiting_confirmation' });
  const draft = {
    batch_record_id: batchRecordId,
    batch_no: batchNo,
    acceptance_text: acceptanceText,
    actual_quantity: actualQuantity,
    actual_amount: actualAmount,
    direct_arrival: true,
    operator_open_id: operatorOpenId,
    requests,
    actual,
    unrecognized: [],
    pending_creation: pendingCreation,
    created_products: [],
    created_colors: [],
    creation_state: pendingCreation.length ? 'pending' : 'done',
    creation_error: '',
  };
  if (inboundCreated) draft.inbound_created = inboundCreated;
  await store.update(id, { recognized, draft });
  return store.get(id);
};

// 一条「已经匹配到货品」的到货明细：入库用例的最小输入。
const arrivalActual = (extra = {}) => ({
  product_record_id: 'prod_1',
  product_number: '8088灰',
  item_no: '8088',
  color: '灰色',
  size: 36,
  quantity: 1,
  created_product: false,
  ...extra,
});

// ─── 到货确认：**只加库存 + 写批次行**（confirmArrival）─────────────────────
// ⚠️ 2026-10-06 业务负责人口径：「既然它就是采购申请，那个表就不要动」。
// 所以这些用例**不再**断言「采购申请表的到货状态被回写」——那正是被删掉的行为；
// 现在断言的是**它一个字都没变**（更硬的"零写入"断言在 arrivalConversation.test.js）。
//
// ⚠️ 2026-10-07 **深夜**：「采购入库」表被业务负责人**整表删除** ⇒ 本节从
//    "写入库明细行 + 加库存"整体翻成"**只加库存**（＋批次行两列）"：
//      · 入库明细行、它的「采购行为」查找（按 `PURCHASE_IN` 编码）、按采购申请回查远端，
//        全部**随表退场**（配置模块 `config/purchaseBehaviors` 一并删除）；
//      · 幂等来源从"入库行 id"换成**真实三元组**（批次记录 id ｜ 货品 ｜ 尺码）。
//    守门（全仓不再引用那张表 / 那个配置）在 `purchaseInboundRemoval.test.js` ①。

test('到货确认：加库存 + 到货信息写到**批次行**（不回写采购申请表、不新建任何明细行）', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseRequest: [{ record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
    // ⭐ 到货信息的落点：**「报货批次」那一行**（2026-10-07 晚；原来写「到货验收」那张表）。
    purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 报货批次号: 'BH-TEST-001', 到货状态: '未到货' } }],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_conf',
    batchRecordId: 'batch_1',
    batchNo: 'BH-TEST-001',
    acceptanceText: '38 码少一双',
    actualQuantity: 1,
    actualAmount: 1680,
    actual: [arrivalActual()],
    requests: (await gateway.listAll('purchaseRequest')),
  });

  const result = await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));

  // ⭐ 一个业务表都不新建：入库明细行整体退场（那张表已被她整表删除）。
  assert.deepEqual(gateway.writes.filter((item) => item.op === 'create'), [],
    '到货确认不新建任何业务表记录（库存由 InventoryService 写，这里注入的是假实现）');
  // 「报货信息」（采购申请表）**一个字都不动**：到货状态这一列**没有**被写过。
  assert.equal((await gateway.get('purchaseRequest', 'req_1')).fields.到货状态, undefined,
    '采购申请表的「到货状态」不许被到货链路回写');
  // ⭐ 到货信息的落点 = 批次行：**2026-10-09 起只写「实际数量」「实际金额」**。
  //    ⛔ 「验收原话」「确认状态」两列在生产真表上**已经被删掉**（她 2026-10-09 的只读核对：
  //       报货批次真表 12 列里找不到）⇒ 本用例按新口径改：那两列**一个字都不写**
  //       （写入点与 schema 映射都已经删除）。
  const batch = await gateway.get('purchaseOrderBatch', 'batch_1');
  assert.equal('验收原话' in batch.fields, false, '「验收原话」这一列已从真表删除，代码不许再写');
  assert.equal('确认状态' in batch.fields, false, '「确认状态」这一列已从真表删除，代码不许再写');
  assert.equal(batch.fields.实际数量, 1, '实际数量 = 草稿算出来的实际到货数合计');
  assert.equal(batch.fields.实际金额, 1680, '实际金额 = 她填的整批金额（原样照写，不重算）');
  // 到货日 / 验收人是飞书自动字段（更新时间 / 创建人）—— 代码不写。
  assert.equal('到货日' in batch.fields, false);
  assert.equal('验收人' in batch.fields, false);
  assert.equal(inventory.calls.length, 1, '库存要跟着加一次');
  assert.equal(inventory.calls[0].quantity, 1, '加的是**实际数**');
});

test('到货确认：同一货品+尺码的两条明细合成**一次**加库存（数量 2），重复确认不重复写', async () => {
  const inventory = makeInventory();
  const records = {
    purchaseRequest: [{ record_id: 'req_1', fields: { 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2 } }],
  };
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_two',
    actual: [arrivalActual(), arrivalActual()],
    requests: (await gateway.listAll('purchaseRequest')),
  });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  // 再确认一次：读**最新**任务（已经是 posted），直接返回，不重复写。
  const again = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  // ⚠️ 2026-10-07 晚：表名「采购到货」→「到货验收」→（同日稍晚）**表被删除** ⇒
  //    这句 toast 不再指着任何一张表，改成按现在的落点说（断言仍是逐字）。
  assert.equal(again.toast.content, '这一批已入库');

  assert.equal(inventory.calls.length, 1, '两条同货品+尺码的明细合成一次');
  assert.equal(inventory.calls[0].quantity, 2);
  assert.equal((await gateway.get('purchaseRequest', 'req_1')).fields.到货状态, undefined,
    '采购申请表的「到货状态」不许被到货链路回写');
});

test('到货确认：applyPurchase 的幂等来源 = **真实三元组**（批次记录 id ｜ 货品 ｜ 尺码）', async () => {
  const inventory = makeInventory();
  const records = {};
  const { service, store } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_inv',
    batchRecordId: 'batch_1',
    batchNo: 'BH-TEST-001',
    actual: [arrivalActual()],
  });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].purchaseBatchRecordId, 'batch_1', '批次记录 id 是真值，不是编的');
  assert.equal(inventory.calls[0].purchaseBatchNo, 'BH-TEST-001');
  assert.equal(inventory.calls[0].arrivalTaskId, 'purchase_arrival_inv', '孤儿调用时的兜底身份，也是真值');
  assert.equal(inventory.calls[0].productRecordId, 'prod_1');
  assert.equal(inventory.calls[0].size, 36);
  assert.equal(inventory.calls[0].quantity, 1);
  // ⚠️ 那个随「采购入库」表一起退场的键：一个字段都不许再传（库存那一层不再认识它）。
  assert.equal(inventory.calls[0].purchaseInboundRecordId, undefined,
    '入库行 id 已随那张表退场；来源标识改用上面那三个真值');
});

// ─── 已删除（2026-10-07 深夜）：入库①~⑥「按行为编码找 PURCHASE_IN」那一组 ──────────
// 它们钉的是**入库明细行**的「采购行为」怎么找记录（按编码、不按中文名）。
// 「采购入库」表被业务负责人整表删除之后，那个字段、那次查找、以及
// `config/purchaseBehaviors`（编码的单一来源）**一起退场** ⇒ 这组用例没有测试对象了。
// 守门改由 `purchaseInboundRemoval.test.js` 的 ①-补2 负责：全仓不再有 PURCHASE_BEHAVIORS 读取点。

test('到货确认：没有报货批次（供应商直接送货）照样加库存，不写任何申请状态', async () => {
  const inventory = makeInventory();
  const records = {};
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_direct',
    actual: [arrivalActual()],
  });

  const result = await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.equal(inventory.calls.length, 1, '直接到货也要真的加库存');
  // 两个批次身份都空 ⇒ 来源标识退回到**到货核对任务 id**（仍是真值，不是编的）。
  assert.equal(inventory.calls[0].arrivalTaskId, 'purchase_arrival_direct');
  assert.equal((await gateway.listAll('purchaseRequest')).length, 0);
  assert.deepEqual(gateway.writes.filter((item) => item.op === 'create'), [],
    '不新建任何业务表记录');
});

test('到货确认：加库存中途失败 → 重试补齐第二条，不重复第一条', async () => {
  const inventoryCalls = [];
  let failOnSecond = true;
  const inventory = {
    calls: inventoryCalls,
    async applyPurchase(input) {
      inventoryCalls.push(input);
      if (failOnSecond && inventoryCalls.length === 2) throw new Error('模拟加库存中途失败');
      return { stockKey: `${input.productRecordId}|${input.size}`, ledgerRecordId: 'ledger_1', liveRecordIds: ['live_1'] };
    },
  };
  const records = {};
  const { service, store, gateway } = makeService({ inventory, gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_partial',
    actual: [arrivalActual(), arrivalActual({ size: 37 })],
  });

  await assert.rejects(
    () => service.confirmArrival(task.task_id, task, 'ou_1'),
    /模拟加库存中途失败/,
  );
  assert.deepEqual(inventoryCalls.map((call) => call.size), [36, 37], '36 码成功、37 码失败');
  assert.notEqual((await store.get(task.task_id)).status, 'posted', '失败后任务不应标记为 posted');
  assert.equal((await store.get(task.task_id)).draft.inventory_applied['prod_1|36'].inventoryApplied, true,
    '成功那一条的进度要落盘');

  failOnSecond = false;
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), result.toast.content);

  // 重试：36 码不再加（进度已落盘），只补 37 码。
  assert.deepEqual(inventoryCalls.map((call) => call.size), [36, 37, 37], '不重复第一条');
  assert.equal((await store.get(task.task_id)).status, 'posted');
});

test('到货确认：兼容**旧进度键**①`inventoryApplied:true`（升级那一刻半路的任务不会多加库存）', async () => {
  // 改动前进度写在 `draft.inbound_created` 上（值是 `{recordId, inventoryApplied}`）。
  // 改名成 `inventory_applied` 之后，升级瞬间停在 posting 的任务两种形状都可能出现。
  const inventory = makeInventory();
  const { service, store } = makeService({ inventory, gateway: makeGateway({}) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_legacy_applied',
    actual: [arrivalActual()],
    // 旧键说"已经加过" ⇒ 一个字都不许再动库存。
    inboundCreated: { 'prod_1|36': { recordId: 'old_inbound_1', inventoryApplied: true } },
  });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.equal(inventory.calls.length, 0, '旧键记着已加过库存 ⇒ 重放不许再加一次');
});

test('到货确认：兼容**旧进度键**②`inventoryApplied:false`（那次没加完 → 要补加一次）', async () => {
  const inventory = makeInventory();
  const { service, store } = makeService({ inventory, gateway: makeGateway({}) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_legacy_pending',
    actual: [arrivalActual()],
    inboundCreated: { 'prod_1|36': { recordId: 'old_inbound_2', inventoryApplied: false } },
  });

  await service.confirmArrival(task.task_id, task, 'ou_1');
  assert.equal(inventory.calls.length, 1, '旧键记着"没加完" ⇒ 补加一次');
});

test('A2 同时确认同一个到货：库存只加一次（confirmationQueue 串行）', async () => {
  // 这条并发断言原先靠 handleCardAction 的 confirmationQueue 串行提供。到货卡片动作已删，
  // 串行保证原样挪进了 confirmArrival（见方法头的注释）——所以这里直接并发调它。
  const inventory = makeInventory();
  const records = {};
  const { service, store, gateway } = makeService({ inventory, gateway: slowCreates(makeGateway(records)) });
  const task = await seedArrivalTask(store, { taskId: 'purchase_arrival_race', actual: [arrivalActual()] });

  await Promise.all([
    service.confirmArrival(task.task_id, task, 'ou_1'),
    service.confirmArrival(task.task_id, task, 'ou_1'),
  ]);

  assert.equal(inventory.calls.length, 1, '库存只应增加一次');
  assert.deepEqual(gateway.writes.filter((item) => item.op === 'create'), [], '不新建任何业务表记录');
  assert.equal((await store.get(task.task_id)).status, 'posted');
});

// ─── 建档 + 成本（ensureArrivalProducts / ensureArrivalProduct / applyArrivalCost）──

test('建档：未知货号+颜色建一条货品，带上货号 / 颜色关联 / 供应商 / 类别', async () => {
  const records = {
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [{ record_id: 'sup_9', fields: { 供应商名称: '一代千金' } }],
  };
  const { service, store, gateway } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({ resolveSupplier: async () => ({ recordId: 'sup_9', record: records.supplier[0] }) }),
  });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_create',
    pendingCreation: [{ item_no: '3602', color: '黑色', supplier: '一代千金', gender: '女' }],
  });

  const result = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(result.state, 'done');
  assert.equal(records.product.length, 1, '同一「货号+颜色」只建一条');
  assert.equal(records.product[0].fields.货号, '3602');
  assert.deepEqual(records.product[0].fields.颜色, ['color_black']);
  assert.deepEqual(records.product[0].fields.供应商, ['sup_9']);
  assert.equal(records.product[0].fields.类别, 'B', '标签上是女鞋 → 类别 B');
  assert.equal('编号' in records.product[0].fields, false, '「编号」是飞书公式字段，不能写');
});

test('建档：货号+颜色命中多条时只建一条，链接回填草稿', async () => {
  const records = {
    product: [],
    color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }],
    supplier: [],
  };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_idem',
    pendingCreation: [
      // 同一 货号+颜色 的两个尺码：建档按 货号+颜色 去重。
      { item_no: '1366-31', color: '黑色' },
      { item_no: '1366-31', color: '黑色' },
      { item_no: '1366-32', color: '黑色' },
    ],
  });

  const result = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(result.created, 2, '两个货号各一条');
  assert.equal(records.product.length, 2);
  const saved = await store.get(task.task_id);
  assert.equal(saved.draft.created_products.length, 2);
  assert.match(saved.draft.created_products[0].url, /record=/, '链接要回填到草稿');
  assert.match(saved.draft.created_products[0].url, new RegExp(`record=${records.product[0].record_id}`));

  // 幂等：再跑一次不能多建一条。
  const again = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(again.state, 'done');
  assert.equal(records.product.length, 2, '重复跑建档不能多建一条');
});

test('建档：颜色表缺色时补一条；同类颜色只补一次', async () => {
  const records = { product: [], color: [], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_color',
    pendingCreation: [
      { item_no: '3602', color: '香芋紫' },
      { item_no: '3603', color: '香芋紫色' },
    ],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  // normalizeColor 会去掉末尾的「色」：两个写法算同一个颜色，只补一条。
  assert.equal(records.color.length, 1, '同一颜色（去尾「色」后同名）只补一条');
  assert.equal(records.color[0].fields.颜色, '香芋紫');
  assert.deepEqual(records.product[0].fields.颜色, [records.color[0].record_id]);
});

test('建档：供应商表里没有这个名字就留空，不新建、不猜', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }], supplier: [] };
  const { service, store } = makeService({
    gateway: makeGateway(records),
    references: makeReferences({ resolveSupplier: async () => { throw new Error('找不到供应商'); } }),
  });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_sup',
    pendingCreation: [{ item_no: '3602', color: '黑色', supplier: '不存在的供应商' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(records.supplier.length, 0, '不在供应商表里就不新建');
  assert.equal('供应商' in records.product[0].fields, false, '找不到就留空，绝不猜一个关联');
});

test('建档：标签没有男/女信息时类别留空', async () => {
  const records = { product: [], color: [], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_nogender',
    pendingCreation: [{ item_no: '3602', color: '黑' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal('类别' in records.product[0].fields, false, '认不出男/女就留空——默认成 A 会把女鞋写进男鞋');
});

test('建档：缺失字段（公式 + 样例图）只落在草稿和日志里', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑' } }], supplier: [] };
  const gateway = makeGateway(records);
  const originalGet = gateway.get;
  // 「缺失信息说明」是飞书公式，后端只负责读：齐备时是「齐备」，否则是缺的字段名。
  // 「样例图」是附件字段、不在公式里，要单独看。
  gateway.get = async (tableKey, recordId) => {
    if (tableKey === 'product') {
      return { record_id: recordId, fields: { 货号: '3602', 颜色: ['color_black'], 缺失信息说明: '成本、品类', 样例图: [] } };
    }
    return originalGet(tableKey, recordId);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_gaps',
    pendingCreation: [{ item_no: '3602', color: '黑色' }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  const saved = await store.get(task.task_id);
  assert.deepEqual(saved.draft.created_products[0].missing, ['成本', '品类']);
  assert.equal(saved.draft.created_products[0].missing_sample_image, true);
  assert.equal(saved.draft.created_products[0].completeness_readable, true);
});

test('建档失败可重试：已经建好的那条不重复建，重试只补缺的', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }], supplier: [] };
  // 第一次建档：第一条成功、第二条失败——模拟"建了一半"。
  // 成功那条的 record_id 会随任务落盘（arrival_created_products），重试必须复用它。
  let createCalls = 0;
  const gateway = makeGateway(records);
  const innerCreate = gateway.create;
  gateway.create = async (tableKey, semanticValues) => {
    if (tableKey === 'product') {
      createCalls += 1;
      if (createCalls === 2) throw new Error('模拟第二条建档失败');
    }
    return innerCreate(tableKey, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_retry',
    pendingCreation: [
      { item_no: '3602', color: '黑色' },
      { item_no: '3603', color: '黑色' },
    ],
  });

  const first = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(first.state, 'failed', '有一条没建成功，状态要标失败（不能静默）');
  const afterFirst = await store.get(task.task_id);
  assert.match(afterFirst.draft.creation_error, /模拟第二条建档失败/, '失败原因要写进草稿');
  assert.equal(records.product.length, 1, '第一条已经建好了');
  assert.equal(records.product[0].fields.货号, '3602');

  const retry = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(retry.state, 'done');
  assert.equal(records.product.length, 2, '重试只补建缺的那条，不重复建第一条');
  assert.equal(createCalls, 3, '第一次 2 次（1 成功 1 失败）+ 重试 1 次');
});

test('建档一直失败：草稿给出原因，且 confirmArrival 拒绝假装入库', async () => {
  const records = { product: [], color: [{ record_id: 'color_black', fields: { 颜色: '黑色' } }], supplier: [] };
  const gateway = makeGateway(records);
  gateway.create = async (tableKey, semanticValues) => {
    if (tableKey === 'product') throw new Error('模拟建档总失败');
    return makeGateway(records).create(tableKey, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_create_fail',
    pendingCreation: [{ item_no: '3602', color: '黑色' }],
  });

  const failed = await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(failed.state, 'failed');
  assert.match((await store.get(task.task_id)).draft.creation_error, /模拟建档总失败/);

  const failedTask = await store.get(task.task_id);
  await assert.rejects(
    () => service.confirmArrival(failedTask.task_id, failedTask, 'ou_1'),
    /新品建档没成功/,
    '建档失败必须明确告诉她原因，不能静默',
  );
  assert.deepEqual(gateway.writes.filter((item) => item.op === 'create'), [],
    '建不出货品就什么业务表记录都不写，更不能假装入了库');

  // 失败可重试：修好之后再确认一次，走同一条幂等路径。
  gateway.create = makeGateway(records).create;
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'), '修好之后要能成功入库');
  assert.equal(records.product.length, 1);
});

test('成本：货品「成本」为空时写进去', async () => {
  const records = { product: [{ record_id: 'prod_cost', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_empty',
    actual: [{ product_record_id: 'prod_cost', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { result } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(result.state, 'done');
  assert.equal(records.product.length, 1, '已经匹配到老货品的行不建新货品，只补成本');
  assert.equal(records.product[0].fields.成本, 199, '到货单价要写进货品成本');
  assert.equal(result.cost_written_count, 1);
});

test('成本：货品已有成本时不覆盖，只记一条带三要素的 warn', async () => {
  const records = { product: [{ record_id: 'prod_keep', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'], 成本: 100 } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_kept',
    actual: [{ product_record_id: 'prod_keep', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(records.product[0].fields.成本, 100, '已有成本一律不覆盖');
  const warn = lines.find((line) => line.event === 'purchase.arrival.cost_kept');
  assert.ok(warn, `必须有 cost_kept warn，实际日志：${JSON.stringify(lines)}`);
  assert.equal(warn.item_no, '1366-31');
  assert.equal(String(warn.existing_cost), '100');
  assert.equal(warn.recognized_cost, 199);
});

test('成本：同一货号多行价格不一致时整条不写，只 warn 一次', async () => {
  const records = { product: [{ record_id: 'prod_conflict', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const { service, store } = makeService({ gateway: makeGateway(records) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_conflict',
    actual: [
      { product_record_id: 'prod_conflict', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false },
      { product_record_id: 'prod_conflict', item_no: '1366-31', color: '棕色', size: 37, quantity: 1, created_product: false },
    ],
    recognized: [
      { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
      { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 209 },
    ],
  });

  const { lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal('成本' in records.product[0].fields, false, '价格不一致时一个值都不能写');
  assert.equal(lines.filter((line) => line.event === 'purchase.arrival.cost_kept').length, 0, '不能把冲突当成"已有成本"报 warn');
  const conflict = lines.filter((line) => line.event === 'purchase.arrival.cost_conflict');
  assert.equal(conflict.length, 1, '冲突只 warn 一次：不能每个尺码都报一遍');
  assert.equal(conflict[0].item_no, '1366-31');
  assert.deepEqual(conflict[0].prices, [199, 209]);
});

test('成本：重复跑建档不重复写成本（costApplied 落盘）', async () => {
  const records = { product: [{ record_id: 'prod_retry', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }] };
  const gateway = makeGateway(records);
  const costUpdates = [];
  const realUpdate = gateway.update;
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      costUpdates.push({ recordId, cost: semanticValues.cost });
    }
    return realUpdate(tableKey, recordId, semanticValues);
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_retry',
    actual: [{ product_record_id: 'prod_retry', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(costUpdates.length, 1, '第一次要写成本');
  assert.equal(records.product[0].fields.成本, 199);

  // 再跑一次（相当于新流程的兜底/重试）：靠任务里落盘的 arrival_cost_written 幂等。
  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(costUpdates.length, 1, '不能写第二遍成本');
  assert.equal(records.product[0].fields.成本, 199);
});

test('成本：写成本失败只记 warn，不挡住到货确认', async () => {
  const records = {
    product: [{ record_id: 'prod_fail', fields: { 编号: '1366-31棕色', 供应商: ['sup_A'] } }],
  };
  const gateway = makeGateway(records);
  gateway.update = async (tableKey, recordId, semanticValues) => {
    if (tableKey === 'product' && semanticValues && semanticValues.cost !== undefined) {
      throw new Error('模拟成本字段写不进去');
    }
    return { record_id: recordId };
  };
  const { service, store } = makeService({ gateway });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_cost_fail',
    actual: [{ product_record_id: 'prod_fail', item_no: '1366-31', color: '棕色', size: 36, quantity: 1, created_product: false }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 }],
  });

  const { result: creation, lines } = await captureWarn(async () => service.ensureArrivalProducts(task.task_id, { reason: 'test' }));
  assert.equal(creation.state, 'done', '成本写不进去不算建档失败');
  assert.ok(lines.some((line) => line.event === 'purchase.arrival.cost_write_failed'));

  // 货已经到了：成本写不进去不能把整批到货卡住。
  const result = await service.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.ok(result.toast.content.includes('采购已入库'));
  assert.deepEqual(gateway.writes.filter((item) => item.op === 'create'), [],
    '到货确认不新建任何业务表记录（入库明细行整体退场）');
});

test('成本：新品建档顺带写成本；单据上没有价格就不写成本字段', async () => {
  const withCost = { product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }], supplier: [] };
  const { service, store } = makeService({ gateway: makeGateway(withCost) });
  const task = await seedArrivalTask(store, {
    taskId: 'purchase_arrival_new_cost',
    pendingCreation: [{ item_no: '1366-31', color: '棕色' }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: '￥199.00' }],
  });
  await service.ensureArrivalProducts(task.task_id, { reason: 'test' });
  assert.equal(withCost.product.length, 1, '新品只建一条');
  assert.equal(withCost.product[0].fields.货号, '1366-31');
  assert.equal(withCost.product[0].fields.成本, 199, '新品建档要顺带写成本');

  const noCost = { product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }], supplier: [] };
  const second = makeService({ gateway: makeGateway(noCost) });
  const task2 = await seedArrivalTask(second.store, {
    taskId: 'purchase_arrival_new_nocost',
    pendingCreation: [{ item_no: '1366-31', color: '棕色' }],
    recognized: [{ item_no: '1366-31', color: '棕色', size: 36, quantity: 1 }],
  });
  await second.service.ensureArrivalProducts(task2.task_id, { reason: 'test' });
  assert.equal(noCost.product.length, 1);
  assert.equal('成本' in noCost.product[0].fields, false, '没有可信价格就不许写成本');
});

// ─── 通用守卫（与到货链路无关，但原先挂在到货用例上）────────────────────────

// ⛔ 2026-10-09：从这里到文件末尾的用例**整批删除**（同上面的理由）——
//   它们全部由 `service.accept('supplier-report', …)` / `acceptMany` 驱动，
//   而那条入口已随「信息填写」整表删除退场。
//   被删的最后一组：A：采购单发到群 / 多供应商同一话题 / 未配置群 id / C：定位回归 /
//   A：拿不到经办人 open_id / ③ 行为读不到 / ⑤ 说明与勾选对不上（2 条）。


test('B：发送器的 inThread 契约 —— 只有显式 true 才带 reply_in_thread；顶层 create 一个字段都不多', async () => {
  const { service, sent } = makeSenderService();

  // ① 回复 + inThread:true → 进话题（图与文字落在同一个话题靠的就是这个字段）。
  await service.sendText('oc_test_purchase_group', '进话题', 'chat_id', { replyToMessageId: 'om_root', inThread: true });
  assert.equal(sent[0].path.message_id, 'om_root');
  assert.equal(sent[0].data.reply_in_thread, true);

  // ② 回复但**不传** inThread → payload 与改动前**逐字节相同**（一个字段都不多）。
  //    默认值必须是"不带"：不改动默认行为，才不会误伤别的调用点。
  await service.sendText('oc_test_purchase_group', '只回复', 'chat_id', { replyToMessageId: 'om_root' });
  assert.deepEqual(Object.keys(sent[1].data).sort(), ['content', 'msg_type']);
  assert.equal(sent[1].data.reply_in_thread, undefined, '不传 inThread 就不许带这个字段');

  // ③ 顶层 create（没有回复对象）→ 与改动前逐字节相同：`inThread` 对它没有意义。
  await service.sendText('oc_test_purchase_group', '顶层', 'chat_id', { inThread: true });
  assert.equal(sent[2].params.receive_id_type, 'chat_id');
  assert.deepEqual(Object.keys(sent[2].data).sort(), ['content', 'msg_type', 'receive_id'],
    '顶层消息的 data 与改动前完全一样（inThread 不该泄漏到 create 上）');

  // ④ 图片同理：回复可以进话题，顶层 create 一个字段都不多。
  await service.sendImage('oc_test_purchase_group', Buffer.from('png'), 'chat_id', { replyToMessageId: 'om_root', inThread: true });
  assert.equal(sent[3].data.reply_in_thread, true);
  await service.sendImage('oc_test_purchase_group', Buffer.from('png'), 'chat_id', {});
  assert.deepEqual(Object.keys(sent[4].data).sort(), ['content', 'msg_type', 'receive_id']);

  // ⑤ 群提示：有回复对象 → 进那个话题；没有 → 顶层，一个字段都不多。
  await service.sendPurchaseGroupNotice('差额提示', { replyToMessageId: 'om_root' });
  assert.equal(sent[5].path.message_id, 'om_root');
  assert.equal(sent[5].data.reply_in_thread, true);
  await service.sendPurchaseGroupNotice('队列提示');
  assert.equal(sent[6].params.receive_id_type, 'chat_id');
  assert.equal(sent[6].data.reply_in_thread, undefined);
});

// ⛔ C 组（定位回归：thread_id / message_id / 话题 id 反查回批次）也**已删除**：
//   它们构造"群里那条采购单消息 ↔ 批次"的映射时走的就是报单入口。
//   ⚠️ 定位器本身（`services/purchaseBatchLocator.js`）**还在用**：
//      到货核对（`arrivalConversation` 那条链路）靠 thread_id 找回批次，
//      那一侧的用例在 `test/arrivalConversation.test.js`。
