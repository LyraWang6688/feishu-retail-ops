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

const reportRecord = (recordId, fields = {}) => ({
  record_id: recordId,
  fields: {
    处理状态: '待解析',
    采购行为: ['beh_1'],
    经办人: [{ id: 'ou_user_1' }],
    编号: ['prod_1'],
    尺码: ['size_36'],
    数量说明: '36码2双',
    ...fields,
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

const waitFor = async (label, check, { attempts = 800, pause = 5 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(`等待「${label}」超时`);
};

// 「入口把号写回这一包的记录」是异步的（accept 里 await 完成才入队）；
// 但 process() 是 setImmediate 之后才跑。断言"号"要等写回落定。
const waitForWrittenBack = (gateway, recordId) => waitFor(
  `记录 ${recordId} 拿到报货批次号`,
  async () => Boolean((await gateway.get('purchaseReport', recordId))?.fields?.['报货批次号']),
);

// ── 生成器本身：格式 / 计数 / 跨天 / 补零 ───────────────────────────────────────

test('① 格式逐字：CGD- + 上海日期 + 4 位补零序号（今天的第一个号就是 0001）', async () => {
  // 2026-10-07 10:00（上海）= 02:00Z
  const now = () => new Date('2026-10-07T02:00:00Z');
  const gateway = makeGateway({ purchaseOrderBatch: [], purchaseReport: [] });
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

test('① 一个 webhook 报货包 = 一个号：一包 3 条记录只出一个号，且都写回同一列', async () => {
  const gateway = makeGateway({
    purchaseReport: [
      reportRecord('rep_pkg_1'),
      reportRecord('rep_pkg_2', { 尺码: ['size_37'], 数量说明: '37码1双' }),
      reportRecord('rep_pkg_3'),
    ],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  const { service, store, gateway: gw } = makeService({ gateway });
  const accepted = await service.acceptMany('supplier-report', ['rep_pkg_1', 'rep_pkg_2', 'rep_pkg_3']);
  assert.equal(accepted.records.length, 3);
  const rows = await Promise.all(['rep_pkg_1', 'rep_pkg_2', 'rep_pkg_3']
    .map((id) => gw.get('purchaseReport', id)));
  const numbers = rows.map((row) => row.fields['报货批次号']);
  assert.equal(new Set(numbers).size, 1, `一包只能有一个号，实际：${JSON.stringify(numbers)}`);
  assert.match(numbers[0], /^CGD-\d{8}-\d{4}$/);
  // 三条任务都跑完（证明写回没有把链路打断）
  const ids = accepted.records.map((item) => item.taskId);
  await waitFor('三条都进终态', async () => {
    const tasks = await Promise.all(ids.map((id) => store.get(id)));
    return tasks.every((task) => ['posted', 'completed', 'failed'].includes(task?.status));
  });
});

test('② 同天第 2 包 → 0002（计数取 max+1，不是条数+1）', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_2')],
    // 「报货批次」里已经有今天第 1 个号（上一包写的）
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001', 幂等键: 'k1' } }],
    purchaseRequest: [],
  });
  // ⭐ 固定时钟：2026-10-07 10:00（上海）= 02:00Z —— "今天"永远是 20261007，跨午夜也不变。
  const { service, gateway: gw } = makeService({ gateway, now: () => new Date('2026-10-07T02:00:00Z') });
  await service.acceptMany('supplier-report', ['rep_2']);
  await waitForWrittenBack(gw, 'rep_2');
  assert.equal((await gw.get('purchaseReport', 'rep_2')).fields['报货批次号'], 'CGD-20261007-0002');
});

test('④ 补零：今天第 10 个 → 0010', async () => {
  const existing = Array.from({ length: 9 }, (_, index) => ({
    record_id: `bat_${index + 1}`,
    fields: { 报货批次号: `CGD-20261007-000${index + 1}`, 幂等键: `k${index}` },
  }));
  const gateway = makeGateway({ purchaseOrderBatch: existing, purchaseReport: [] });
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
    purchaseReport: [
      { record_id: 'rep_y', fields: { 报货批次号: 'CGD-20261006-0009' } },
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
    purchaseReport: [],
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

test('② 计数同时数两张表：退货占掉的号下一次报货不会重发（并集求 max）', async () => {
  const gateway = makeGateway({
    // 「报货批次」只有 0001（报货写的）
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001' } }],
    // 「信息填写」里有 0002（入口写回写在那一列上）
    purchaseReport: [{ record_id: 'rep_1', fields: { 报货批次号: 'CGD-20261007-0002' } }],
  });
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T02:00:00Z'),
    settings: resolvePurchaseBatchNoConfig({}),
  });
  assert.equal((await generator.next()).batchNo, 'CGD-20261007-0003');
});

test('③/④/② 配置先行：前缀 / 日期格式 / 位数 / 时区 / 识别前缀都是配置', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [], purchaseReport: [] });
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

// ── 入口：重投 / 并发 ─────────────────────────────────────────────────────────

test('⑤ 重投不生成第二个号：同一条记录再收一次 webhook，号不变', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_dup')],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  const { service, store, gateway: gw } = makeService({ gateway });
  const first = await service.accept('supplier-report', 'rep_dup');
  await waitForWrittenBack(gw, 'rep_dup');
  const firstNo = (await gw.get('purchaseReport', 'rep_dup')).fields['报货批次号'];

  await waitFor('第一条跑完', async () => {
    const task = await store.get(first.taskId);
    return Boolean(task) && (task.result !== undefined || task.status === 'failed');
  });
  const second = await service.accept('supplier-report', 'rep_dup');
  assert.equal(second.taskId, first.taskId);
  const secondNo = (await gw.get('purchaseReport', 'rep_dup')).fields['报货批次号'];
  assert.equal(secondNo, firstNo, '重投不许换号');
  // 而且没有多写一条「报货批次」（重投被幂等挡掉）
  assert.equal((await gw.listAll('purchaseOrderBatch')).length, 1);
});

test('⑤ 重试不生成第二个号：入口写回之后重跑 acceptMany，号不变、只写一次', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_retry_1'), reportRecord('rep_retry_2', { 尺码: ['size_37'] })],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  const { service, gateway: gw } = makeService({ gateway });
  await service.acceptMany('supplier-report', ['rep_retry_1', 'rep_retry_2']);
  await waitForWrittenBack(gw, 'rep_retry_1');
  const numbers = await Promise.all(['rep_retry_1', 'rep_retry_2'].map(async (id) => (await gw.get('purchaseReport', id)).fields['报货批次号']));
  assert.equal(new Set(numbers).size, 1);
  // ⚠️ 关键：**第二次**投递时，那一列已经非空 ⇒ 只能复用，不许再算一个新号
  await service.acceptMany('supplier-report', ['rep_retry_1', 'rep_retry_2']);
  const after = await Promise.all(['rep_retry_1', 'rep_retry_2'].map(async (id) => (await gw.get('purchaseReport', id)).fields['报货批次号']));
  assert.deepEqual(after, numbers, '重试不许生成第二个号');
});

test('⑥ 并发不重号：两包几乎同时进来，各拿各的号（串行队列）', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_c_1'), reportRecord('rep_c_2')],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  // ⭐ 固定时钟（同 ②）：两包谁先谁后由串行队列决定，但"今天"必须是 20261007。
  const { service, gateway: gw } = makeService({ gateway, now: () => new Date('2026-10-07T02:00:00Z') });
  // 两包**同时**投递（不 await 第一包）：没有串行保护的话它们会读到同一个 max → 同一个号。
  await Promise.all([
    service.acceptMany('supplier-report', ['rep_c_1']),
    service.acceptMany('supplier-report', ['rep_c_2']),
  ]);
  await Promise.all([waitForWrittenBack(gw, 'rep_c_1'), waitForWrittenBack(gw, 'rep_c_2')]);
  const first = (await gw.get('purchaseReport', 'rep_c_1')).fields['报货批次号'];
  const second = (await gw.get('purchaseReport', 'rep_c_2')).fields['报货批次号'];
  assert.notEqual(first, second, `两包不能重号：${first} / ${second}`);
  assert.deepEqual([first, second].sort(), ['CGD-20261007-0001', 'CGD-20261007-0002'].sort());
});

test('⑤ 同一条记录在队列里被并发的两次投递抢到：复用先写进去的那个号（记 collision）', async () => {
  const gateway = makeGateway({
    purchaseReport: [reportRecord('rep_race')],
    purchaseOrderBatch: [],
    purchaseRequest: [],
  });
  const { service, gateway: gw } = makeService({ gateway });
  // 同一个包并发两次（模拟重投与首次几乎同时到达）
  await Promise.all([
    service.acceptMany('supplier-report', ['rep_race']),
    service.acceptMany('supplier-report', ['rep_race']),
  ]);
  await waitForWrittenBack(gw, 'rep_race');
  const value = (await gw.get('purchaseReport', 'rep_race')).fields['报货批次号'];
  assert.match(value, /^CGD-\d{8}-\d{4}$/);
  // 那条记录只被写过**一个**号（不是先 0001 再 0002）
  const written = (await gw.listAll('purchaseReport'))
    .map((row) => row.fields['报货批次号'])
    .filter((item) => item && item.startsWith('CGD-'));
  assert.deepEqual(written, [value]);
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
