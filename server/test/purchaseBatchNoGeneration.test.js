const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseBatchNoGenerator } = require('../src/services/purchaseBatchNoGenerator');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { extractBatchNos } = require('../src/services/purchaseBatchNo');
const { GroupPurchaseFlowService } = require('../src/services/groupPurchaseFlowService');
const { resolvePurchaseGroupReplies } = require('../src/config/groupPurchase');
const {
  resolvePurchaseBatchNoConfig,
  buildBatchNoPattern,
  formatBatchDate,
} = require('../src/config/purchaseBatchNo');

// ⭐ 2026-10-07 业务负责人：报货批次号**不再手填**，改由后端代码生成
//   （格式 `CGD-20261007-0003` = 前缀 + 上海日期 + 4 位补零序号，每天归零）。
//
// 这个文件把验收标准逐条钉住（编号与 task brief 一致）：
//   ① 一批（一包）只出一个号、格式逐字 `CGD-20261007-0001`
//   ② 同天第 2 包 → `0002`
//   ③ 跨天归零
//   ④ 补零（第 10 个 → `0010`）
//   ⑤ 重投 / 重试不生成第二个号
//   ⑥ 并发不重号
//   ⑫ 旧数据 / 旧格式号零改动（且不参与计数）
//   ⑬ 群准入 / 定位认得 `CGD-`
//
// ⚠️ 测试数据是**编的**，但都符合业务常理（报货不会有 0 双、一双鞋就是整数双）。

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-batch-no-'));
const table = (key) => V1_BITABLE_SCHEMA.tables[key];

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

const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

const makeGateway = (records = {}) => ({
  uploads: [],
  table,
  get: async (tableKey, recordId) => (records[tableKey] || []).find((r) => r.record_id === recordId) || null,
  listAll: async (tableKey) => {
    if (tableKey === 'sizeManagement' && !records.sizeManagement) return SIZE_RECORDS;
    if (tableKey === 'behavior' && !records.behavior) return [];
    return records[tableKey] || [];
  },
  create: async (tableKey, semanticValues) => {
    const fields = mapFields(tableKey, semanticValues);
    const recordId = `new_${tableKey}_${(records[tableKey] || []).length + 1}`;
    const record = { record_id: recordId, fields };
    (records[tableKey] ||= []).push(record);
    return { recordId, record };
  },
  update: async (tableKey, recordId, semanticValues) => {
    const patch = mapFields(tableKey, semanticValues);
    const record = (records[tableKey] || []).find((r) => r.record_id === recordId);
    if (record) record.fields = { ...record.fields, ...patch };
    return record || { record_id: recordId };
  },
  uploadAttachment: async (filePath) => {
    (makeGateway.lastUploads ||= []).push(filePath);
    return `file_token_${(makeGateway.lastUploads || []).length}`;
  },
});


const makeService = (options = {}) => {
  const gateway = options.gateway || makeGateway();
  const store = options.store || new JsonTaskStore({ dir: tempDir() });
  const service = new PurchaseWebhookService({
    gateway,
    store,
    references: {
      resolveProduct: async () => ({
        recordId: 'prod_1',
        record: { record_id: 'prod_1', fields: { 编号: '8088黑', 货号: '8088', 颜色: [{ text: '黑色' }], 供应商: ['sup_1'] } },
      }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '金猴' } } }),
    },
    recognizer: { parsePurchaseReportText: async () => [{ size: 36, quantity: 2 }] },
    inventory: { applyPurchase: async () => ({}) },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'img_key' }) },
        message: {
          create: async () => ({ code: 0, msg: 'success' }),
          reply: async () => ({ code: 0, msg: 'success' }),
        },
      },
    },
    images: { render: async () => Buffer.from('fake-png') },
    batchReadMaxRetries: 1,
    batchReadRetryDelay: 0,
    reportBatchWindowMs: 20,
    batchLocatorStore: options.batchLocatorStore,
    // ⭐ 注入固定时钟（照 ④ 的写法）：批次号的"今天"取自**真实时钟**，
    //    不钉住它，跨午夜后断言里的 `CGD-20261007-…` 会变成 `CGD-20261008-…`（②/⑥ 曾因此变红）。
    batchNoGenerator: options.now
      ? new PurchaseBatchNoGenerator({
        gateway, now: options.now, settings: resolvePurchaseBatchNoConfig({}),
      })
      : undefined,
  });
  return { service, store, gateway };
};


// 「入口把号写回这一包的记录」是异步的（accept 里 await 完成才入队）；
// 但 process() 是 setImmediate 之后才跑。断言"号"要等写回落定。

// ── 生成器本身：格式 / 计数 / 跨天 / 补零 ───────────────────────────────────────

test('① 格式逐字：CGD- + 上海日期 + 4 位补零序号（今天的第一个号就是 0001）', async () => {
  // 2026-10-07 10:00（上海）= 02:00Z
  const now = () => new Date('2026-10-07T02:00:00Z');
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now, settings: resolvePurchaseBatchNoConfig({}),
  });
  const first = await generator.next({ source: 'intake', taskId: 'task_1' });
  assert.equal(first.batchNo, 'CGD-20261007-0001');
  assert.equal(first.sequence, 1);
  assert.equal(first.todayCount, 0);
  assert.equal(first.attempts, 1);
  assert.equal(first.datePart, '20261007');
});

test('① 号源只有「报货批次」一张表：表里今天的号参与计数，生成 0002', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001', 幂等键: 'k1' } }],
  });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0002');
  assert.equal(next.todayCount, 1, '只数「报货批次」那一张表');
});

test('② 同一天取 max+1（不是条数+1）：已有 0001 / 0003 → 下一个是 0004', async () => {
  const gateway = makeGateway({
    // 两条号、中间有空洞（某号作废）：条数+1 会给出 0003（撞号），max+1 才安全。
    purchaseOrderBatch: [
      { record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001', 幂等键: 'k1' } },
      { record_id: 'bat_3', fields: { 报货批次号: 'CGD-20261007-0003', 幂等键: 'k3' } },
    ],
  });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0004');
  assert.equal(next.sequence, 4);
  assert.equal(next.todayCount, 2);
});

test('④ 补零：今天第 10 个 → 0010', async () => {
  const existing = Array.from({ length: 9 }, (_, index) => ({
    record_id: `bat_${index + 1}`,
    fields: { 报货批次号: `CGD-20261007-000${index + 1}`, 幂等键: `k${index}` },
  }));
  const gateway = makeGateway({ purchaseOrderBatch: existing });
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T02:00:00Z'),
    settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0010');
  assert.equal(next.sequence, 10);
  assert.equal(next.todayCount, 9);
});

test('③ 跨天归零：昨天到 0009，今天第一个仍然是 0001', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [
      { record_id: 'bat_y', fields: { 报货批次号: 'CGD-20261006-0009', 幂等键: 'ky' } },
    ],
  });
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T02:00:00Z'),
    settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0001');
  assert.equal(next.todayCount, 0, '只数"同一天"的号');
});

test('⑫ 旧号零改动、且不参与计数：手填的 202610071 / 202610072 与 BH- 都不匹配', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [
      // 今天已经存在的**旧格式**号：纯数字（她手填的）与 BH- 前缀的
      { record_id: 'bat_old_1', fields: { 报货批次号: '202610071', 幂等键: 'k1' } },
      { record_id: 'bat_old_2', fields: { 报货批次号: '202610072', 幂等键: 'k2' } },
      { record_id: 'bat_old_3', fields: { 报货批次号: 'BH-20261007-0001', 幂等键: 'k3' } },
      // 位数不对的也不许参与（5 位序号）
      { record_id: 'bat_old_4', fields: { 报货批次号: 'CGD-20261007-00012', 幂等键: 'k4' } },
    ],
  });
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T02:00:00Z'),
    settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  // ⇒ 今天下一个新号仍然是 0001（旧号不匹配、不参与）
  assert.equal(next.batchNo, 'CGD-20261007-0001');
  assert.equal(next.todayCount, 0);
  // 旧记录**一个字都没动**
  assert.deepEqual(
    (await gateway.listAll('purchaseOrderBatch')).map((row) => row.fields['报货批次号']),
    ['202610071', '202610072', 'BH-20261007-0001', 'CGD-20261007-00012'],
  );
});

test('② 号源只有「报货批次」一张表：别的任何一张表一被读就抛，生成照常', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001' } }],
  });
  const originalListAll = gateway.listAll;
  // ⭐ 2026-10-09：号源收窄成**一张表** —— 原先还要并上「信息填写」那一列
  //   （入口按包写回 / 退货也消耗号），那张表已被业务负责人整表删除。
  //   这里把"读别的表"变成硬失败：只要生成器还去读第二张表，这条用例当场红。
  gateway.listAll = async (tableKey) => {
    if (tableKey !== 'purchaseOrderBatch') throw new Error(`取号只许读「报货批次」，实际读了：${tableKey}`);
    return originalListAll(tableKey);
  };
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0002', '只数「报货批次」，不再跨表求并集');
});

test('③/④/② 配置先行：前缀 / 日期格式 / 位数 / 时区 / 识别前缀都是配置', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T16:30:00Z'), // 上海 = 2026-10-08 00:30（跨天由时区决定）
    settings: resolvePurchaseBatchNoConfig({
      PURCHASE_BATCH_NO_PREFIX: 'PO-',
      PURCHASE_BATCH_NO_DATE_FORMAT: 'YYYY-MM-DD',
      PURCHASE_BATCH_NO_DIGITS: '3',
      PURCHASE_BATCH_NO_TIMEZONE: 'Asia/Shanghai',
    }),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'PO-2026-10-08-001', '时区决定"今天"，格式与位数都来自配置');

  // 认哪些前缀也是配置：空列表 = 一个都认不出（**启动时抛错**，不静默）
  assert.throws(() => resolvePurchaseBatchNoConfig({ PURCHASE_BATCH_NO_PREFIXES: ' ' }), /至少要有一个前缀/);
  assert.throws(() => resolvePurchaseBatchNoConfig({ PURCHASE_BATCH_NO_PREFIX: ' ' }), /不能是空串/);
  assert.throws(() => resolvePurchaseBatchNoConfig({ PURCHASE_BATCH_NO_DATE_FORMAT: 'MMDD' }), /必须含 YYYY/);
  assert.throws(() => resolvePurchaseBatchNoConfig({ PURCHASE_BATCH_NO_DIGITS: 'x' }), /整数/);
  const custom = resolvePurchaseBatchNoConfig({ PURCHASE_BATCH_NO_PREFIXES: 'CGD-,BH-,X-' });
  assert.ok(buildBatchNoPattern(custom).test('X-20261007-0001'), '配置里加前缀就认它');
  assert.equal(formatBatchDate(new Date('2026-10-07T02:00:00Z'), custom), '20261007');
});

// ── 取号的幂等 / 并发保护（2026-10-09：入口退场后，这些性质由
//    「posting_plan 冻结号」＋ 生成器自己的串行队列与进程内已发集合保证）──────────

/** 造一个"扫码补货"的本地任务（与 `scanWriteService` 落盘的草稿同形）。 */
const seedPostingTask = async (store, taskId = 'task_freeze') => store.create({
  task_id: taskId,
  kind: 'scan_replenish',
  status: 'posting',
  draft: {
    is_batch: true,
    operator_open_id: 'ou_user_1',
    supplier_record_id: 'sup_1',
    items: [{
      product_record_id: 'prod_1', item_no: '8088', color: '黑色',
      size: 36, quantity: 2, behavior_record_id: 'beh_1',
    }],
  },
});

test('⑤ 重投不换号：posting_plan 冻结批次号，ensurePostingPlan 跑两次拿到同一个号', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const { service, store } = makeService({ gateway, now: () => new Date('2026-10-07T02:00:00Z') });
  const task = await seedPostingTask(store, 'task_freeze');
  const first = await service.ensurePostingPlan('task_freeze', task);
  // 重试（本地已经落盘）：拿回**同一份**计划，号不变、也不再多取一个号。
  const second = await service.ensurePostingPlan('task_freeze', await store.get('task_freeze'));
  assert.equal(first.batch_no, 'CGD-20261007-0001');
  assert.equal(second.batch_no, first.batch_no, '重试不许换号');
  assert.deepEqual(second.items.map((item) => item.request_key), first.items.map((item) => item.request_key));
});

test('⑤ 本进程同一个号绝不发第二遍：表里读不到刚发的号 → 重算下一个并记 collision', async () => {
  // 远端不落库（模拟"写回失败 / 复制延迟"）：第二次算号仍会读到同名 max ⇒ 算出同一个号。
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  const first = await generator.next();
  const second = await generator.next();
  assert.equal(first.batchNo, 'CGD-20261007-0001');
  assert.equal(second.batchNo, 'CGD-20261007-0002', '同一个号绝不发第二遍（进程内已发集合兜底）');
  assert.equal(second.attempts, 2, '第二次是重算出来的');
});

test('⑥ 并发不重号：runExclusive 串行算号，两包各拿一个号', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  // 两包**同时**进来（不 await 第一包）：串行队列保证它们不读到同一个 max。
  const numbers = await Promise.all([
    generator.runExclusive(() => generator.next()),
    generator.runExclusive(() => generator.next()),
  ]);
  const values = numbers.map((item) => item.batchNo).sort();
  assert.deepEqual(values, ['CGD-20261007-0001', 'CGD-20261007-0002']);
});

test('⑤ 撞号时记一条可 grep 的 purchase.batch_no.collision（排查用）', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const generator = new PurchaseBatchNoGenerator({
    gateway, now: () => new Date('2026-10-07T02:00:00Z'), settings: resolvePurchaseBatchNoConfig({}),
  });
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await generator.next();
    await generator.next();
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(lines.some((line) => line.includes('purchase.batch_no.collision')),
    `撞号必须留下可 grep 的日志，实际：${lines.join(' | ')}`);
});

// ── ⑬ 群准入 / 定位认得 CGD- ──────────────────────────────────────────────────

test('⑬ 群里识别批次号：CGD- 认得（BH- 作为历史格式也继续认得）', () => {
  assert.deepEqual(extractBatchNos('CGD-20261007-0001 这批到了'), ['CGD-20261007-0001']);
  assert.deepEqual(extractBatchNos('这批到了'), []);
  assert.deepEqual(extractBatchNos('BH-20261005-0001 和 CGD-20261007-0002'),
    ['BH-20261005-0001', 'CGD-20261007-0002']);
  // 形态不对的不认（不猜）：位数不对 / 没前缀 / 小写
  assert.deepEqual(extractBatchNos('CGD-2026-1'), []);
  assert.deepEqual(extractBatchNos('cgd-20261007-0001'), []);
  assert.deepEqual(extractBatchNos('CGD-20261007-00012'), [], '序号必须是正好 4 位');
});

/*
 * 「认不出」的两句回复文案：跟着**识别前缀**走，不再写死 `BH-`。
 * ⚠️ 为什么这条重要：报货批次号改成 `CGD-…` 之后，如果那句话还说「BH-开头的那个」，
 *    她会照着去说一个我们已经**不生成**的前缀 → 机器人永远"认不出"（而且是静默的）。
 */
test('⑬「认不出」的回复文案不再写死 BH-：跟着识别前缀走，且可配 / 留空回落默认', () => {
  const defaults = resolvePurchaseGroupReplies({});
  assert.match(defaults.noBatch, /CGD \/ BH 开头的那个/, `实际：${defaults.noBatch}`);
  assert.match(defaults.ambiguous, /CGD \/ BH 开头的那个/);
  assert.ok(!defaults.noBatch.includes('（BH-开头的那个）'), '旧那句话不能再出现');

  const custom = resolvePurchaseGroupReplies({
    PURCHASE_BATCH_NO_PREFIXES: 'CGD-',
    PURCHASE_GROUP_NO_BATCH_REPLY: '把批次号说给我（{prefixes} 开头）',
  });
  assert.equal(custom.noBatch, '把批次号说给我（CGD 开头）');
  // 没配的那一句回落默认（默认本身也按同一套识别前缀填 `{prefixes}`）
  assert.equal(custom.ambiguous, resolvePurchaseGroupReplies({
    PURCHASE_BATCH_NO_PREFIXES: 'CGD-',
  }).ambiguous);

  // 留空 = 回落默认（这是她唯一能看到的那句话，留空等于把"该怎么办"弄丢）
  assert.match(resolvePurchaseGroupReplies({ PURCHASE_GROUP_NO_BATCH_REPLY: ' ' }).noBatch, /CGD \/ BH 开头的那个/);
});

test('⑬ 定位不到时回的那句话来自配置（service 里没有第二份文案）', async () => {
  const replied = [];
  const service = new GroupPurchaseFlowService({
    locator: { resolve: async () => ({ status: 'not_found', source: 'thread_id' }) },
    replyText: async (messageId, content, options) => { replied.push({ messageId, content, options }); return 'om_r'; },
    replies: { noBatch: '认不出-文案A', ambiguous: '说不清-文案B' },
  });
  await service.handleGroupPurchaseMessage({ messageId: 'om_1', text: '随便说点什么', threadId: 'omt_1' });
  assert.equal(replied.length, 1);
  assert.equal(replied[0].content, '认不出-文案A');
  assert.deepEqual(replied[0].options, { threadId: 'omt_1' }, '回复要落回那条话题');
});

test('⑬ 定位：正文里说 CGD-… 能定位到那一批（没话题、没引用时才走这条）', async () => {
  const store = new JsonTaskStore({ dir: tempDir(), idField: 'task_id' });
  const locator = new PurchaseBatchLocator({ store });
  await locator.rememberGroupMessage({
    batchNo: 'CGD-20261007-0001',
    messageId: 'om_1',
    threadId: 'omt_1',
    chatId: 'oc_1',
    kind: 'purchase-request',
  });
  const located = await locator.resolve({ text: 'CGD-20261007-0001 这批到齐了', parentId: '', threadId: '' });
  assert.equal(located.status, 'matched');
  assert.equal(located.source, 'batch_no');
  assert.equal(located.batchNo, 'CGD-20261007-0001');
  // 说不清的两个号（**两个都在映射里**）：仍然是 ambiguous，不挑一个
  await locator.rememberGroupMessage({
    batchNo: 'CGD-20261007-0002', messageId: 'om_2', threadId: 'omt_2', chatId: 'oc_1',
  });
  assert.equal((await locator.resolve({ text: 'CGD-20261007-0001 和 CGD-20261007-0002' })).status, 'ambiguous');
});
