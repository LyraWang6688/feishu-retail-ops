// ⭐ 2026-10-07：9 点推送加【采购】区（与【销售】区并存；销售在前、采购在后，顺序可配）。
//
// 业务负责人的口径（逐字）：
//   「你每天 9 点发通知的时候，**看未到货的情况就直接去那个表里查**，
//    然后再把消息**深链**发到用户群里」
// ⇒ 采购候选 = 「报货批次」表里 **到货状态 = 未到货**（直接查这张表）。
//
// 这个文件盯的是**这条消息的形状与候选口径**：
//   ⑩ 两个大区**逐字**（含空区行为、深链缺失的脚注）
//   ⑪ **销售区逐字不变**（哨兵：同一批候选，加不加采购区，销售那半逐字节相同）
//   F2 供应商从**「信息填写」关联**取；取不到就不显示、**不编**
//   F3 深链走本地映射（chat_id + thread_id）→ 话题深链；拿不到 → 照发 + 脚注，候选一条都不丢
//   F4 顺序可配；空区连标题都不出现；两区都空 → **不发**
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { LarkMessageLinkResolver } = require('../src/services/larkMessageLinkResolver');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
// ⭐ 2026-10-08：默认形态是**消息卡片**；本文件里"读发出去那条消息"的地方统一用 `visibleOf`
//   （卡片里她看得见的字）；几处直接 `buildText` 的（纯文本降级模板）逐字留着。
const { visibleCardText } = require('../src/utils/pendingDealPushCard');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_push';
const DAY_KEY = '2026-10-07';
const NOW = new Date('2026-10-07T02:00:00.000Z'); // 北京 10:00

// ⚠️ 文案默认值的**唯一真源**是 config/pendingDealPush；这里先取一遍默认值再覆盖关心的键。
const settings = (overrides = {}) => ({
  ...resolvePendingDealPushConfig({}),
  enabled: true,
  chatId: CHAT_ID,
  linkLookupEnabled: false,
  linkRequired: false,
  ...overrides,
});

const ORDER_A = {
  salesEntryRecordId: 'sale_a',
  orderNo: 'XSD-20261007-001',
  pendingAmount: 128,
  fulfillmentStatus: '未交付',
  items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '37' }],
};

// 「信息填写」那 14 列里我们只用得上 报货批次号 / 编号 / 供应商
const reportRow = (recordId, batchNo, supplier) => ({
  record_id: recordId,
  fields: { 报货批次号: batchNo, 编号: ['prod_1'], 供应商: supplier === undefined ? [] : [supplier] },
});
const batchRow = (recordId, batchNo, arrivalStatus) => ({
  record_id: recordId,
  fields: { 报货批次号: batchNo, 到货状态: arrivalStatus, 幂等键: `k_${recordId}` },
});

const fakeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => records[key] || [],
  get: async (key, id) => (records[key] || []).find((row) => row.record_id === id) || null,
  update: async () => ({}),
  create: async () => ({ recordId: 'x' }),
});

const fakeClient = () => {
  const creates = [];
  return {
    creates,
    client: {
      im: {
        message: {
          create: async (payload) => {
            creates.push(payload);
            return { code: 0, data: { message_id: 'om_push_1' } };
          },
          reply: async () => { throw new Error('本推送必须发到主聊天，不许 reply'); },
        },
      },
    },
  };
};

const newService = ({ orders = [], records = {}, mappings = [], settings: overrides = {}, purchasePending } = {}) => {
  const resolvedSettings = settings(overrides);
  const { client, creates } = fakeClient();
  const purchaseBatchLocator = new PurchaseBatchLocator({ store: tmpStore('purchase-push-mapping-') });
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    secondDelivery: {
      client,
      listPendingDeliveries: async () => orders,
    },
    locator: new SalesGroupThreadLocator({ store: tmpStore('pending-push-sales-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store: tmpStore('pending-push-day-'),
    purchasePending: purchasePending || new PurchasePendingBatchService({
      gateway: fakeGateway(records),
      batchLocator: purchaseBatchLocator,
    }),
  });
  return { service, creates, settings: resolvedSettings, purchaseBatchLocator };
};

const remember = async (locator, batchNo, { messageId, threadId, chatId = CHAT_ID }) => {
  await locator.rememberGroupMessage({
    batchNo, messageId, threadId, chatId, kind: 'purchase-request',
  });
};

// 卡片里"她看得见的字"（去掉 ** / text_tag / font 壳，文字链接摊成「文案 URL」）。
const visibleOf = (create) => visibleCardText(JSON.parse(create.data.content));

// ── ⑩ 两个大区逐字 ─────────────────────────────────────────────────────────────

test('⑩ 一条消息两个大区：销售区在上、采购区在下，逐字对上', async () => {
  const records = {
    purchaseOrderBatch: [
      batchRow('bat_1', 'CGD-20261007-0001', '未到货'),
      batchRow('bat_2', 'CGD-20261007-0002', '未到货'),
      // 已到货 / 其它状态的一律不进候选
      batchRow('bat_3', 'CGD-20261007-0003', '已到货'),
      batchRow('bat_4', 'CGD-20261007-0004', ''),
    ],
    purchaseReport: [
      reportRow('rep_1', 'CGD-20261007-0001', '金猴'),
      // 第 2 批没有供应商 → 那一段整段不出现（**不编**）
      reportRow('rep_2', 'CGD-20261007-0002', ''),
    ],
  };
  const { service, creates, purchaseBatchLocator } = newService({ orders: [ORDER_A], records });
  // 第 1 批有话题映射（→ 话题深链）；第 2 批没有 → 缺深链
  await remember(purchaseBatchLocator, 'CGD-20261007-0001', { messageId: 'om_1', threadId: 'omt_1' });

  const result = await service.sendDailyPush({ now: NOW });
  assert.equal(result.purchaseBatchCount, 2);
  assert.equal(result.purchaseMissingLinkCount, 1);
  assert.equal(creates.length, 1);

  const text = visibleOf(creates[0]);
  assert.equal(text, [
    // ⚠️ 2026-10-08：一个销售区块 ⇒ 标题**不再补分区计数**；行里**没有单号**；
    //    两个缺失脚注合并到卡片最下面那一条 note（卡片本来就该把脚注放末尾）。
    '⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔',
    '【预定】1 笔',
    '1. B26002-52 37码 · 【预定】 · 待收 ¥128.00',
    '【采购】未到货的报货批次：2 批',
    '1. CGD-20261007-0001 · 金猴 · 查看原话 https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test_pending_push&open_thread_id=omt_1&openchatid=oc_test_pending_push&openthreadid=omt_1&thread_position=-1',
    '2. CGD-20261007-0002',
    '（1 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）',
    '（1 批的深链暂不可用，见日志 sales.pending_deal_push.purchase_link.missing）',
  ].join('\n'));
  // 两个区块之间**一条分割线**（采购区之前那条）。
  const card = JSON.parse(creates[0].data.content);
  assert.deepEqual(card.elements.map((element) => element.tag),
    ['div', 'div', 'hr', 'div', 'div', 'div', 'note']);
});

test('⑪ 销售区哨兵：同一批销售候选，加不加采购区，**销售那半逐字节相同**（销售区没有大区标题）', async () => {
  const salesOnly = newService({ orders: [ORDER_A], records: { purchaseOrderBatch: [], purchaseReport: [] } });
  const salesText = salesOnly.service.buildText({ orders: [ORDER_A], missingLinkCount: 0, dayKey: DAY_KEY });

  const withPurchase = newService({
    orders: [ORDER_A],
    records: {
      purchaseOrderBatch: [batchRow('bat_1', 'CGD-20261007-0001', '未到货')],
      purchaseReport: [reportRow('rep_1', 'CGD-20261007-0001', '金猴')],
    },
  });
  const combined = withPurchase.service.buildText({
    orders: [ORDER_A],
    missingLinkCount: 0,
    dayKey: DAY_KEY,
    purchaseBatches: [{ batchNo: 'CGD-20261007-0001', suppliers: ['金猴'], url: 'https://x' }],
    purchaseMissingLinkCount: 0,
  });
  // 销售那半（采购区之前的那一段）**逐字节相同**
  assert.equal(combined.slice(0, salesText.length), salesText);
  assert.equal(combined.slice(salesText.length),
    '\n【采购】未到货的报货批次：1 批\n1. CGD-20261007-0001 · 金猴 · 查看原话 https://x');
  // 而且销售区的大区标题是**空串**（默认不给销售区多加一行）
  assert.equal(withPurchase.settings.salesAreaTitle, '');
});

// ── F4 空区行为 ───────────────────────────────────────────────────────────────

test('F4 空区连标题都不出现：只有采购候选时，**没有**销售表头、也没有销售区块', async () => {
  const { service } = newService({
    orders: [],
    records: {
      purchaseOrderBatch: [batchRow('bat_1', 'CGD-20261007-0001', '未到货')],
      purchaseReport: [reportRow('rep_1', 'CGD-20261007-0001', '金猴')],
    },
  });
  const text = service.buildText({
    orders: [],
    missingLinkCount: 0,
    dayKey: DAY_KEY,
    purchaseBatches: [{ batchNo: 'CGD-20261007-0001', suppliers: ['金猴'], url: '' }],
    purchaseMissingLinkCount: 1,
  });
  assert.equal(text, [
    '【采购】未到货的报货批次：1 批',
    '1. CGD-20261007-0001 · 金猴',
    '（1 批的深链暂不可用，见日志 sales.pending_deal_push.purchase_link.missing）',
  ].join('\n'));
  assert.ok(!text.includes('销售单'), '销售区整块不出现（连表头都没有）');
});

test('F4 只有销售候选时：**没有**采购区的任何痕迹', async () => {
  const { service } = newService({ orders: [ORDER_A], records: {} });
  const text = service.buildText({
    orders: [ORDER_A], missingLinkCount: 0, dayKey: DAY_KEY, purchaseBatches: [], purchaseMissingLinkCount: 0,
  });
  assert.equal(text, [
    '⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔',
    '【预定】1 笔',
    '1. B26002-52 37码 · 【预定】 · 待收 ¥128.00',
  ].join('\n'));
  assert.ok(!text.includes('采购'), '没有采购候选时一个字都不提采购');
});

test('F4 两区都空 → **不发**（沿用既有行为：只落一条"今天没有待处理单"）', async () => {
  const { service, creates } = newService({ orders: [], records: {} });
  const result = await service.sendDailyPush({ now: NOW });
  assert.equal(result.pushedOrderCount, 0);
  assert.equal(result.reason, 'no_pending_order');
  assert.equal(creates.length, 0, '两区都空时一条消息都不发');
});

test('F4 顺序可配：PENDING_DEAL_PUSH_AREA_ORDER=purchase,sales → 采购区在前', async () => {
  const { service, creates } = newService({
    orders: [ORDER_A],
    records: {
      purchaseOrderBatch: [batchRow('bat_1', 'CGD-20261007-0001', '未到货')],
      purchaseReport: [reportRow('rep_1', 'CGD-20261007-0001', '金猴')],
    },
    settings: { areas: ['purchase', 'sales'] },
  });
  await service.sendDailyPush({ now: NOW });
  const text = visibleOf(creates[0]);
  assert.ok(text.startsWith('【采购】'), `采购区该在最上面，实际：${text.split('\n')[0]}`);
  // 销售区照样在，只是排在后面；⚠️ 这时**没有销售表头**当卡片标题
  //   ——「最近 7 天待处理的销售单」那句写的是销售单，采购区在上面时顶在卡片最上面是错的。
  assert.ok(text.includes('【预定】'), '销售区照样在，只是排在后面');
  assert.ok(text.includes('B26002-52 37码'), '销售那一行也在');
  assert.ok(!text.includes('最近 7 天待处理的销售单'));
});

// ── F2 / F3 候选与深链 ────────────────────────────────────────────────────────

test('F2 供应商从「信息填写」关联取：多个供应商去重后按配置的连接符拼；取不到就不显示', async () => {
  const records = {
    purchaseOrderBatch: [
      batchRow('bat_1', 'CGD-20261007-0001', '未到货'),
      batchRow('bat_2', 'CGD-20261007-0002', '未到货'),
    ],
    purchaseReport: [
      reportRow('rep_1', 'CGD-20261007-0001', '金猴'),
      reportRow('rep_2', 'CGD-20261007-0001', '奥康'),
      reportRow('rep_3', 'CGD-20261007-0001', '金猴'), // 重复 → 去重
      reportRow('rep_4', 'CGD-20261007-0002', ''), // 取不到 → 空数组
    ],
  };
  const { service } = newService({ orders: [], records });
  const text = service.buildText({
    orders: [],
    dayKey: DAY_KEY,
    purchaseBatches: [
      { batchNo: 'CGD-20261007-0001', suppliers: ['金猴', '奥康'], url: '' },
      { batchNo: 'CGD-20261007-0002', suppliers: [], url: '' },
    ],
    purchaseMissingLinkCount: 0,
  });
  assert.equal(text, [
    '【采购】未到货的报货批次：2 批',
    '1. CGD-20261007-0001 · 金猴、奥康',
    '2. CGD-20261007-0002',
  ].join('\n'));
  assert.ok(!/ · $/.test(text), '供应商取不到时不许留下一段空壳');
});

test('F3 深链走本地映射（chat_id + thread_id）→ 话题深链；拿不到就照发 + 脚注，候选一条不丢', async () => {
  const records = {
    purchaseOrderBatch: [
      batchRow('bat_1', 'CGD-20261007-0001', '未到货'),
      batchRow('bat_2', 'CGD-20261007-0002', '未到货'),
    ],
    purchaseReport: [reportRow('rep_1', 'CGD-20261007-0001', '金猴')],
  };
  const { service, creates, purchaseBatchLocator } = newService({ orders: [], records });
  // 只有第 1 批记过映射；映射里同批次两条（图 + 文字）→ 取第一个"两个 id 都全"的
  await remember(purchaseBatchLocator, 'CGD-20261007-0001', { messageId: 'om_1', threadId: '' });
  await remember(purchaseBatchLocator, 'CGD-20261007-0001', { messageId: 'om_2', threadId: 'omt_2' });

  const result = await service.sendDailyPush({ now: NOW });
  assert.equal(result.purchaseBatchCount, 2, '拿不到深链也不能漏掉候选');
  assert.equal(result.purchaseMissingLinkCount, 1);
  const text = visibleOf(creates[0]);
  assert.match(text, /1\. CGD-20261007-0001 · 金猴 · 查看原话 https:\/\/applink\.feishu\.cn\/client\/thread\/open\?/);
  assert.match(text, /2\. CGD-20261007-0002$/m, '第 2 批照发（那一行不出现链接段）');
  assert.match(text, /（1 批的深链暂不可用，见日志 sales\.pending_deal_push\.purchase_link\.missing）/);
});

test('F1 候选直接查「报货批次」：只有 到货状态 = 未到货 的进候选（其余状态一律不进）', async () => {
  const records = {
    purchaseOrderBatch: [
      batchRow('bat_1', 'CGD-20261007-0001', '未到货'),
      batchRow('bat_2', 'CGD-20261007-0002', '已到货'),
      batchRow('bat_3', 'CGD-20261007-0003', '部分到货'),
      { record_id: 'bat_4', fields: { 报货批次号: 'BH-20261007-0004' } },
    ],
    purchaseReport: [],
  };
  const { service } = newService({ orders: [], records });
  // 直接问那个 service（它的唯一职责就是"该推哪些批次"）
  const pending = await new PurchasePendingBatchService({
    gateway: fakeGateway(records), batchLocator: new PurchaseBatchLocator({ store: tmpStore('f1-') }),
  }).listPendingBatches();
  assert.deepEqual(pending.map((row) => row.batchNo), ['CGD-20261007-0001']);
  const text = service.buildText({
    orders: [],
    dayKey: DAY_KEY,
    purchaseBatches: pending,
    purchaseMissingLinkCount: 0,
  });
  assert.match(text, /：1 批/);
});

test('F3 采购候选读表失败：**不拖垮销售那半边**（照常推销售，采购当空）', async () => {
  const { service, creates } = newService({
    orders: [ORDER_A],
    purchasePending: {
      listPendingBatches: async () => { throw new Error('模拟：读「报货批次」失败'); },
      loadLinkIndex: async () => new Map(),
      resolveThreadLinkFrom: () => ({ mapped: false, threadLink: '', messageId: '' }),
    },
  });
  const result = await service.sendDailyPush({ now: NOW });
  assert.equal(result.pushedOrderCount, 1, '销售照推');
  assert.equal(result.purchaseBatchCount, 0);
  const text = visibleOf(creates[0]);
  assert.ok(text.includes('最近 7 天待处理的销售单'));
  assert.ok(!text.includes('【采购】'));
});

// ── 配置：全部可配且写错当场抛 ────────────────────────────────────────────────

test('D1 大区/采购区的标题、行格式、分隔符、脚注都可配；写错在**解析配置时**就抛', () => {
  const custom = resolvePendingDealPushConfig({
    PENDING_DEAL_PUSH_AREA_ORDER: 'purchase,sales',
    PENDING_DEAL_PUSH_SALES_TITLE: '【销售】{count} 笔',
    PENDING_DEAL_PUSH_PURCHASE_TITLE: '【采购】{count} 批待收货',
    PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS: '{index}、{batchNo}|{supplier}|{link}',
    PENDING_DEAL_PUSH_PURCHASE_LINE_SEPARATOR: ' -- ',
    PENDING_DEAL_PUSH_PURCHASE_SUPPLIER_SEPARATOR: ' / ',
    PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE: '（{count} 批没有深链）',
  });
  assert.deepEqual(custom.areas, ['purchase', 'sales']);
  assert.equal(custom.salesAreaTitle, '【销售】{count} 笔');
  assert.equal(custom.purchaseAreaTitle, '【采购】{count} 批待收货');
  assert.deepEqual(custom.purchaseLineParts, ['{index}、{batchNo}', '{supplier}', '{link}']);
  // ⚠️ 环境变量的首尾空白会被 `readString` 去掉（` -- ` 读进来是 `--`）——与销售区那条
  //    行分隔符同一个规矩；要真带空格就把它写进**段模板**里。
  assert.equal(custom.purchaseLineSeparator, '--');
  assert.equal(custom.purchaseSupplierSeparator, '/');
  assert.equal(custom.purchaseFooterTemplate, '（{count} 批没有深链）');

  // 写错的名字 / 没闭合的括号 / 空的段列表 → 启动时就吵
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_AREA_ORDER: 'sales,unknown' }), /没声明的大区/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PURCHASE_TITLE: '【采购】{cnt}' }), /无法识别的占位符/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PURCHASE_TITLE: '【采购】{count' }), /没有闭合/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS: '  ' }), /至少要有一段/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE: '{nope}' }), /无法识别的占位符/);
  // 漏写一个大区不会让它消失（宁可多显示，也不静默少推一整个区）
  assert.deepEqual(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_AREA_ORDER: 'purchase' }).areas,
    ['purchase', 'sales']);
});
