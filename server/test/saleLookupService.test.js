const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { linkedRecordIds } = require('../src/services/v1BitableGateway');
const { SaleLookupService, readOnlyGateway } = require('../src/services/saleLookupService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const DAY_MS = 24 * 60 * 60 * 1000;
// 固定"现在"：2026-10-05 16:00（上海）。所有窗口断言都相对它算，避免测试跨天变脆。
const NOW = new Date('2026-10-05T16:00:00+08:00');
const TODAY_9AM = Date.parse('2026-10-05T09:00:00+08:00');
const daysAgo = (n) => TODAY_9AM - n * DAY_MS;

const productRow = (recordId, itemNo, color) => ({
  record_id: recordId,
  fields: { 货号: itemNo, 颜色: color, 编号: `${itemNo}|${color}` },
});

// ⚠️ 主表判据一读的是「销售状态」（原「订单状态」那列已被业务负责人 2026-10-06 整列删除）。
// 默认给「已写入」= 一笔正常入过账的新单；想造"退过"或"不认识"的单就分别传值 / 不传。
const entryRow = ({ id, orderNo, recordedAt = daysAgo(0), salesStatus = '已写入' }) => ({
  record_id: id,
  fields: { 销售单号: orderNo, 录单日: recordedAt, 销售状态: salesStatus },
});

const detailRow = ({ id, orderId, productId, soldAt = daysAgo(0), sizeRecordId = 'size_38', amount = 230, tradeType = '' }) => ({
  record_id: id,
  fields: {
    编号: [{ record_ids: [productId], text: '' }],
    销售单号: orderId ? [{ record_ids: [orderId], text: '' }] : [],
    销售日: soldAt,
    尺码: sizeRecordId ? [{ record_ids: [sizeRecordId], text: '' }] : [],
    成交金额: amount,
    ...(tradeType ? { 交易类型: [{ text: tradeType }] } : {}),
  },
});

const sizeStub = (byRecordId) => ({
  resolveLinkedCell: async (cell) => {
    const id = linkedRecordIds(cell)[0];
    if (!(id in byRecordId)) throw new Error(`尺码关联记录不存在: ${id}`);
    return { size: byRecordId[id] };
  },
});

// 写操作一律记下来并抛错：本期的核心验收点就是"这条链路一次业务写都没有"。
const makeGateway = ({ details = [], entries = [], products = [], writes = [], reads = [] } = {}) => ({
  table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
  listAll: async (tableKey) => {
    reads.push(tableKey);
    return { salesDetail: details, salesEntry: entries, product: products }[tableKey] || [];
  },
  create: async (...args) => { writes.push(['create', ...args]); throw new Error('本链路不允许写业务表'); },
  update: async (...args) => { writes.push(['update', ...args]); throw new Error('本链路不允许写业务表'); },
  delete: async (...args) => { writes.push(['delete', ...args]); throw new Error('本链路不允许写业务表'); },
});

const makeService = async (options = {}) => {
  const { details = [], entries = [], products = [], sizes = {}, writes = [], reads = [] } = options;
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-lookup-test-')),
    idField: 'task_id',
  });
  const gateway = makeGateway({ details, entries, products, writes, reads });
  const cards = [];
  let replyFails = options.replyFails === true;
  const service = new SaleLookupService({
    gateway,
    store,
    sizeReferences: sizeStub({ size_38: 38, size_39: 39, size_40: 40, ...sizes }),
    config: options.config || { days: 5, ttlMs: 10 * 60 * 1000 },
    now: options.now || (() => NOW),
    replyCard: async (_messageId, card) => {
      if (replyFails) throw new Error('reply failed');
      cards.push(card);
      return 'om_card';
    },
    sendCard: async (_openId, card) => { cards.push(card); return 'om_card_fallback'; },
  });
  return { service, store, gateway, cards, disableReply: () => { replyFails = true; } };
};

const newTask = (store, overrides = {}) => store.create({
  task_id: 'sale_query_1',
  type: 'sale',
  status: 'received',
  message_id: 'om_query',
  sender_open_id: 'ou_1',
  original_text: '帮我查 6035 黑',
  ...overrides,
});

test('候选查询：命中 1 条时返回日期/货号/颜色/尺码/金额/销售单号', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-20261003-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1', soldAt: daysAgo(2) })],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    { ...candidates[0], sold_at: undefined },
    {
      record_id: 'd1', sold_at: undefined, date: '2026-10-03', item_no: '6035', color: '黑',
      size: 38, actual_amount: 230, sales_order_no: 'XSD-20261003-0001', sales_entry_record_id: 'e1',
    });
});

test('候选查询：命中多条时最近的排前面，同一天按销售单号稳定排序', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      entryRow({ id: 'e1', orderNo: 'XSD-0001' }),
      entryRow({ id: 'e2', orderNo: 'XSD-0002' }),
      entryRow({ id: 'e3', orderNo: 'XSD-0003' }),
    ],
    details: [
      detailRow({ id: 'd1', orderId: 'e1', productId: 'p1', soldAt: daysAgo(4), sizeRecordId: 'size_38' }),
      detailRow({ id: 'd2', orderId: 'e2', productId: 'p1', soldAt: daysAgo(1), sizeRecordId: 'size_39' }),
      detailRow({ id: 'd3', orderId: 'e3', productId: 'p1', soldAt: daysAgo(1), sizeRecordId: 'size_40' }),
    ],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d3', 'd2', 'd1']);
  assert.deepEqual(candidates.map((row) => row.date), ['2026-10-04', '2026-10-04', '2026-10-01']);
  // 顺序稳定：同样输入再查一次结果完全一致（她说「第 2 笔」才对得上）。
  const again = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(again.map((row) => row.record_id), ['d3', 'd2', 'd1']);
});

test('候选查询：0 条时返回空数组（由卡片去说"没查到 + 哪天买的"）', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  assert.deepEqual(await service.findCandidates({ itemNo: '9999', color: '黑' }), []);
  assert.deepEqual(await service.findCandidates({ itemNo: '6035', color: '白' }), []);
});

test('候选查询窗口：4 天前的命中，6 天前的不命中（默认 5 天）', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      entryRow({ id: 'e_in', orderNo: 'XSD-IN' }),
      entryRow({ id: 'e_out', orderNo: 'XSD-OUT' }),
    ],
    details: [
      detailRow({ id: 'd_4days', orderId: 'e_in', productId: 'p1', soldAt: daysAgo(4) }),
      detailRow({ id: 'd_6days', orderId: 'e_out', productId: 'p1', soldAt: daysAgo(6) }),
    ],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_4days']);
  // 窗口可配：调到 7 天，6 天前那笔就进来了。
  const wider = await service.findCandidates({ itemNo: '6035', color: '黑', days: 7 });
  assert.deepEqual(wider.map((row) => row.record_id).sort(), ['d_4days', 'd_6days']);
});

test('排除已退：销售状态=已退货 / 部分退货 的单不出现', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      entryRow({ id: 'e_ok', orderNo: 'XSD-OK' }),
      entryRow({ id: 'e_back', orderNo: 'XSD-BACK', salesStatus: '已退货' }),
      entryRow({ id: 'e_part', orderNo: 'XSD-PART', salesStatus: '部分退货' }),
    ],
    details: [
      detailRow({ id: 'd_ok', orderId: 'e_ok', productId: 'p1' }),
      detailRow({ id: 'd_back', orderId: 'e_back', productId: 'p1' }),
      detailRow({ id: 'd_part', orderId: 'e_part', productId: 'p1' }),
    ],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_ok']);
});

test('排除已退：明细里有「交易类型=销售退货」的行时，整单都排除', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      entryRow({ id: 'e_ok', orderNo: 'XSD-OK' }),
      // 主表「销售状态」还没被写成「已退货」（那一步还没做，等她定），只能靠明细的退货行识别
      // ——这就是双保险的意义。
      entryRow({ id: 'e_back', orderNo: 'XSD-BACK', salesStatus: '已写入' }),
    ],
    details: [
      detailRow({ id: 'd_ok', orderId: 'e_ok', productId: 'p1' }),
      detailRow({ id: 'd_sold', orderId: 'e_back', productId: 'p1', sizeRecordId: 'size_38' }),
      detailRow({ id: 'd_return', orderId: 'e_back', productId: 'p1', sizeRecordId: 'size_39', tradeType: '销售退货' }),
    ],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_ok']);
});

test('货号/颜色匹配：复用 normalizeColor（棕 = 棕色）与 normalizeText（去连字符）', async () => {
  const { service } = await makeService({
    products: [
      productRow('p_brown', '628-6', '棕色'),
      productRow('p_black', '6035', '黑'),
    ],
    entries: [
      entryRow({ id: 'e_brown', orderNo: 'XSD-BROWN' }),
      entryRow({ id: 'e_black', orderNo: 'XSD-BLACK' }),
    ],
    details: [
      detailRow({ id: 'd_brown', orderId: 'e_brown', productId: 'p_brown' }),
      detailRow({ id: 'd_black', orderId: 'e_black', productId: 'p_black' }),
    ],
  });
  // 「棕」命中表里的「棕色」；货号写不写连字符都命中。
  assert.deepEqual((await service.findCandidates({ itemNo: '628-6', color: '棕' })).map((row) => row.record_id),
    ['d_brown']);
  assert.deepEqual((await service.findCandidates({ itemNo: '6286', color: '棕色' })).map((row) => row.record_id),
    ['d_brown']);
  assert.deepEqual((await service.findCandidates({ itemNo: '6035', color: '黑' })).map((row) => row.record_id),
    ['d_black']);
  // 只给货号 = 这个货号下的所有颜色都算候选。
  assert.deepEqual((await service.findCandidates({ itemNo: '628-6' })).map((row) => row.record_id), ['d_brown']);
});

test('候选查询：货号和颜色都没给时不返回全表记录，也不读表', async () => {
  const reads = [];
  const { service } = await makeService({
    reads,
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  assert.deepEqual(await service.findCandidates({}), []);
  // 没有货号颜色就没有可回答的问题：连一次远端读取都不该发生。
  assert.deepEqual(reads, []);
});

test('本期零写入：候选查询和查询流程都不碰 create/update/delete', async () => {
  const writes = [];
  const { service, store, cards } = await makeService({
    writes,
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-20261003-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1', soldAt: daysAgo(1) })],
  });
  // 结构上也写不了：这条链路拿到的网关没有写接口。
  assert.equal(service.gateway.create, undefined);
  assert.equal(service.gateway.update, undefined);
  assert.equal(service.gateway.delete, undefined);
  assert.equal(readOnlyGateway({ table: () => ({}), listAll: async () => [] }).create, undefined);

  await service.findCandidates({ itemNo: '6035', color: '黑' });
  const task = await newTask(store);
  await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });

  assert.deepEqual(writes, [], '查询链路不允许写任何业务表');
  assert.equal(cards.length, 1);
  // 任务状态（本地 JSON）是允许写的：候选上下文必须存下来。
  assert.equal((await store.get('sale_query_1')).pending_candidates.length, 1);
});

test('上下文：候选按卡片顺序存进任务状态，序号能对上', async () => {
  const { service, store, cards } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      entryRow({ id: 'e1', orderNo: 'XSD-0001' }),
      entryRow({ id: 'e2', orderNo: 'XSD-0002' }),
    ],
    details: [
      detailRow({ id: 'd_old', orderId: 'e1', productId: 'p1', soldAt: daysAgo(3), sizeRecordId: 'size_38' }),
      detailRow({ id: 'd_new', orderId: 'e2', productId: 'p1', soldAt: daysAgo(1), sizeRecordId: 'size_39' }),
    ],
  });
  const task = await newTask(store);
  await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });

  const stored = await store.get('sale_query_1');
  assert.deepEqual(stored.pending_candidates.map((row) => row.record_id), ['d_new', 'd_old']);
  assert.equal(stored.status, 'query_answered');
  assert.equal(stored.pending_candidates_expires_at,
    new Date(NOW.getTime() + 10 * 60 * 1000).toISOString());

  // 卡片上的第 1/2 行与 pending_candidates 一一对应（顺序一致，不靠聊天历史）。
  const lines = cards[0].elements[0].text.content.split('\n');
  assert.match(lines[0], /^1\. /);
  assert.match(lines[0], /39码/);
  assert.match(lines[1], /^2\. /);
  assert.match(lines[1], /38码/);

  const resolved = service.resolvePendingCandidate(stored, 2);
  assert.equal(resolved.status, 'ok');
  assert.equal(resolved.candidate.record_id, 'd_old');
  assert.equal(service.resolvePendingCandidate(stored, 3).status, 'out_of_range');
  assert.equal(service.resolvePendingCandidate(stored, 1).candidate.record_id, 'd_new');
});

test('上下文：10 分钟有效，过期后明确要求重新查', async () => {
  const { service, store, cards } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const task = await newTask(store);
  await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });
  const stored = await store.get('sale_query_1');

  const justBefore = new Date(NOW.getTime() + 10 * 60 * 1000 - 1);
  assert.equal(service.resolvePendingCandidates(stored, { now: justBefore }).status, 'ok');
  const justAfter = new Date(NOW.getTime() + 10 * 60 * 1000 + 1);
  const expired = service.resolvePendingCandidates(stored, { now: justAfter });
  assert.equal(expired.status, 'expired');
  assert.deepEqual(expired.candidates, []);
  // 过期要明确提示重新查，而不是拿旧列表继续。
  assert.match(expired.message, /重新.*货号/);
  assert.equal(cards.length, 1);
  // TTL 可配。
  const custom = await makeService({
    config: { days: 5, ttlMs: 1000 },
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const customTask = await newTask(custom.store);
  await custom.service.handleQuery(customTask, { intent: 'sale_query', item_no: '6035', color: '黑' });
  const customStored = await custom.store.get('sale_query_1');
  assert.equal(custom.service.resolvePendingCandidates(customStored,
    { now: new Date(NOW.getTime() + 1001) }).status, 'expired');
});

test('上下文：从没查过 / 查出来 0 条时不给旧列表', async () => {
  const { service, store } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const fresh = await newTask(store, { task_id: 'no_query_yet' });
  assert.equal(service.resolvePendingCandidates(fresh).status, 'empty');
  const zero = await newTask(store, { task_id: 'zero_query' });
  await service.handleQuery(zero, { intent: 'sale_query', item_no: '9999', color: '黑' });
  assert.equal(service.resolvePendingCandidates(await store.get('zero_query')).status, 'empty');
});

test('查询卡片：0 条也在原消息下回一张卡，且优先 reply、失败退回发卡', async () => {
  const { service, store, cards } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const task = await newTask(store);
  await service.handleQuery(task, { intent: 'sale_query', item_no: '9999', color: '黑' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].header.title.content, '最近 5 天的销售记录');
  assert.match(JSON.stringify(cards[0]), /没查到/);
  assert.equal(await store.get('sale_query_1').then((row) => row.card_message_id), 'om_card');

  const fallback = await makeService({
    replyFails: true,
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const fallbackTask = await newTask(fallback.store);
  await fallback.service.handleQuery(fallbackTask, { intent: 'sale_query', item_no: '6035', color: '黑' });
  assert.equal(fallback.cards.length, 1);
  assert.equal(await fallback.store.get('sale_query_1').then((row) => row.card_message_id), 'om_card_fallback');
});

test('退货/换货的占位入口已删除：真执行在 AfterSalesFlowService，这里不再回"还没上线"', async () => {
  // 第一期这里有一个只回"我还没上线，先给你记下了"的方法；第二期接上执行器后它必须消失。
  // 留一个没人调用的旧入口，以后很容易被误接回去、静默吞掉她的退货诉求，所以在这里锁住。
  const { service } = await makeService({});
  assert.equal(service.handleAfterSalesNotReady, undefined);
  // 只读边界不变：这条链路依然拿不到任何写接口。
  assert.equal(service.gateway.create, undefined);
  assert.equal(service.gateway.update, undefined);
  assert.equal(service.gateway.delete, undefined);
});

// ── C：保守处理（2026-10-06）──────────────────────────────────────────────────
// 背景：「订单状态」那一列已被业务负责人**整列删除**（值一起没了），判据一迁到「销售状态」。
// ⚠️ 但**今天还没有任何代码在退货时写「销售状态 = 已退货」**（补写这一步还没做，等她定），
// 所以取不到值（这一列给不出任何信息）时**保守当成"退过"**：宁可少给她一条候选，
// 也不能把"可能已经退过"的单再拿出来退一次。但**新单不能因此消失**——
// 新单的「销售状态」有值（= 这笔单我们认识）。
// ⚠️ 老的（删列之前录的）单子这两列都是空的 ⇒ 会被保守规则挡在候选之外，这是**故意的**。

test('⭐ 保守：销售状态空（老单 / 取不到）→ 当成"退过"，整单排除（+ logWarn）', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      { record_id: 'e_known', fields: { 销售单号: 'XSD-KNOWN', 录单日: daysAgo(0), 销售状态: '已写入' } },
      // 这一列空着：这单退没退过，表里没有任何依据。
      { record_id: 'e_unknown', fields: { 销售单号: 'XSD-UNKNOWN', 录单日: daysAgo(0) } },
    ],
    details: [
      detailRow({ id: 'd_known', orderId: 'e_known', productId: 'p1' }),
      detailRow({ id: 'd_unknown', orderId: 'e_unknown', productId: 'p1' }),
    ],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_known']);
});

test('⭐ 新单（销售状态=已写入）**不**被保守规则排除', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      // 这就是本次改动之后每一条新单的样子（「销售状态」由 salesOrderService 写）。
      { record_id: 'e_new', fields: { 销售单号: 'XSD-NEW', 录单日: daysAgo(0), 销售状态: '已写入' } },
    ],
    details: [detailRow({ id: 'd_new', orderId: 'e_new', productId: 'p1' })],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_new']);
});

test('保守规则不吃掉判据本体：销售状态=已退货 仍然排除', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      { record_id: 'e_back', fields: {
        销售单号: 'XSD-BACK', 录单日: daysAgo(0), 销售状态: '已退货',
      } },
    ],
    details: [detailRow({ id: 'd_back', orderId: 'e_back', productId: 'p1' })],
  });
  const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(candidates, []);
});
