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

// 抓 warn 级结构化日志（`utils/logger` 的 warn → `console.warn`）。
// 只用来钉"没有群上下文时**确实记了一条** `lark.private_chat.send_skipped`"，
// 免得静默失效（改了行为却没有任何可排查的痕迹）。
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
};

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
  const taskSends = [];
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
    // 渠道感知出口：**只有显式传了才注入** —— 生产在 `larkMvpService` 里注入 `sendTaskCard`。
    // 不传时走 service 自己的缺省，而缺省**不再回落私聊**（没有群上下文 → 不发 + 记 skip）：
    // 这样"显式注入"和"缺省不发"两条路都能被单独钉住。
    // 🔴 2026-10-07「私聊链路移除」：这里原来还有一个 `sendCard(openId, card)` 打桩
    //    （`privateSends`）—— 那个 open_id 发送器已从 service 里整体删除，打桩一并删掉。
    ...(options.sendCardToTask
      ? {
        sendCardToTask: async (task, card) => {
          taskSends.push({ task, card });
          return options.sendCardToTask(task, card);
        },
      }
      : {}),
  });
  return {
    service, store, gateway, cards, taskSends,
    disableReply: () => { replyFails = true; },
  };
};

// 🔴 2026-10-07 三次收尾：`replyCardByTask` 的**主回复**也按渠道分流了 ——
//    非群任务在函数入口就 `skipNoGroupContext` + 返 `null`（不再"回她那条私聊消息"）。
//    ⇒ 走 `handleQuery`（= 查销售记录）的用例**必须显式带群上下文**，
//    否则卡片没有去处。见 docs/private-chat-removal-2026-10-07.md 第七节。
const GROUP_CTX = { chat_type: 'group', chat_id: 'oc_sales_group' };

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
  const task = await newTask(store, GROUP_CTX);
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
  const task = await newTask(store, GROUP_CTX);
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
  const task = await newTask(store, GROUP_CTX);
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
  const customTask = await newTask(custom.store, GROUP_CTX);
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
  const zero = await newTask(store, { task_id: 'zero_query', ...GROUP_CTX });
  await service.handleQuery(zero, { intent: 'sale_query', item_no: '9999', color: '黑' });
  assert.equal(service.resolvePendingCandidates(await store.get('zero_query')).status, 'empty');
});

test('查询卡片：0 条也在原消息下回一张卡，优先 reply', async () => {
  const { service, store, cards } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
    details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
  });
  const task = await newTask(store, GROUP_CTX);
  await service.handleQuery(task, { intent: 'sale_query', item_no: '9999', color: '黑' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].header.title.content, '最近 5 天的销售记录');
  assert.match(JSON.stringify(cards[0]), /没查到/);
  assert.equal(await store.get('sale_query_1').then((row) => row.card_message_id), 'om_card');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 2026-10-06「私聊切除」②：`saleLookupService.replyCardByTask` 的兜底。
//   以前：群话题里回复失败会**掉进私聊**（`sendCard(task.sender_open_id)`）。
//   现在：`chat_type === 'group'` → 走**渠道感知出口**（回到那个话题），
//        出口再失败也**只记日志、如实失败**，绝不静默发她私聊。
//
// 🔴 2026-10-07「私聊链路移除」收尾（本 PR）：**非群任务那条路也清掉了**。
//   以前：非群任务回复失败 → `sendCard(task.sender_open_id, card)`（偷偷发私聊）。
//   现在：没有群上下文 = **没有去处** → 只记 `lark.private_chat.send_skipped`、返 `null`，
//        一个远端调用都不做；`this.sendCard` 这个 open_id 发送器**整体删除**。
//   要让它发到某处，只能由调用方**显式注入** `sendCardToTask`
//   （生产注入的是 `larkMvpService.sendTaskCard`，它自己按 chat_type 分流）。
//
// 🔴 2026-10-07 **三次收尾**（本 PR）：剩的**主回复**也按渠道分流了。
//   以前：非群任务**任何** `chat_type` 都先 `replyCard(task.message_id, card)`
//        （= 回她那条私聊消息）—— 兜底清了、主回复还在。
//   现在：非群在 `replyCardByTask` 入口就 `skipNoGroupContext` + 返 `null`，
//        `replyCard` **一次都不被调用**；**群那条（主回复 + 群兜底）逐字未动**。
// ─────────────────────────────────────────────────────────────────────────────

const lookupFixture = () => ({
  products: [productRow('p1', '6035', '黑')],
  entries: [entryRow({ id: 'e1', orderNo: 'XSD-0001' })],
  details: [detailRow({ id: 'd1', orderId: 'e1', productId: 'p1' })],
});

test('② 非群任务：**主回复也不走**（即便 replyCard 打桩成功、也注入了 sendCardToTask）—— 没有群上下文就没有去处', async () => {
  const { service, store, cards, taskSends } = await makeService({
    ...lookupFixture(),
    // ⚠️ 2026-10-07 三次收尾：这里**故意让 `replyCard` 可用**（原来打的是"回复必失败"）——
    //    改之前非群任务会先走主回复，那样这张卡就漏出去了；现在入口就分流，
    //    `replyCard` 一次都不该被调（`cards` 是它的记账数组，空 = 没漏）。
    // 故意把出口注进去：非群任务**也不该**碰它 —— 分流的判据（chat_type）在 service 自己这层，
    // 而不是靠"出口恰好看了一眼 chat_type"。这样"非群 = 不发"不依赖任何注入方守规矩。
    sendCardToTask: async () => 'om_injected_card',
  });
  const task = await newTask(store); // 没有 chat_type = 没有群上下文
  const returned = await service.replyCardByTask(task, { header: { title: { content: 'x' } } });

  assert.equal(returned, null, '没有去处 → 明确返"没发出去"');
  assert.equal(taskSends.length, 0, '非群任务不许走渠道感知出口');
  assert.deepEqual(cards, [], '主回复一次都不许走（那就是"回她那条私聊消息"）');
  assert.equal(await store.get('sale_query_1').then((row) => row.card_message_id), undefined,
    '没发出去就不许写 card_message_id');
});

test('② 非群任务 + 没有注入出口 → **不发** + 记 `send_skipped` + 返 null（缺省不再回落私聊）', async () => {
  const logs = captureLogs();
  let cardMessageId;
  try {
    const { service, store, cards } = await makeService({
      ...lookupFixture(),
      // 刻意**不注入** sendCardToTask → 走 service 自己的缺省；
      // `replyCard` 保持可用，用来证明"非群连主回复都不走"。
    });
    const task = await newTask(store); // 没有 chat_type = 没有群上下文
    const returned = await service.replyCardByTask(task, { header: { title: { content: 'x' } } });

    assert.equal(returned, null, '没有去处 → 明确返"没发出去"（调用方不许记 card_message_id）');
    assert.deepEqual(cards, [], '一条消息都不发（尤其是**不许**发给 task.sender_open_id）');
    cardMessageId = await store.get('sale_query_1').then((row) => row.card_message_id);
  } finally {
    logs.restore();
  }
  assert.equal(cardMessageId, undefined, '没发出去就不许写 card_message_id');
  const skipped = logs.events('lark.private_chat.send_skipped');
  assert.equal(skipped.length, 1, '可排查：不是静默失败');
  assert.match(skipped[0], /"kind":"card"/);
  assert.match(skipped[0], /"reason":"no_group_context"/);
});

test('③ 非群任务走 `handleQuery` **全链路**：查得到也不出卡、记 skip、不留 card_message_id', async () => {
  // ⚠️ 直接造任务（不带 `chat_type`）= 磁盘上遗留的旧任务形状 —— 生产上私聊入口已不再建任务，
  //    这条只在重放遗留 JSON 时走到。钉的是"整条查询链路都不回落私聊"，不只是一次方法调用。
  const logs = captureLogs();
  let cardMessageId;
  let stored;
  try {
    const { service, store, cards, taskSends } = await makeService({
      ...lookupFixture(), // 查得到 1 条 —— 有内容可发，仍然不发
      sendCardToTask: async () => 'om_injected_card', // 故意注入：非群也**不许**碰
    });
    const task = await newTask(store);
    await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });
    assert.deepEqual(cards, [], '非群任务一条消息都不发（尤其不许回落私聊）');
    assert.equal(taskSends.length, 0, '非群任务也不许走渠道感知出口');
    stored = await store.get('sale_query_1');
    cardMessageId = stored.card_message_id;
  } finally {
    logs.restore();
  }
  assert.equal(cardMessageId, undefined, '没发出去就不许写 card_message_id');
  // 堵的是**发送**，不是查询：候选上下文照旧存下来（她下一句「第 1 笔」还要用）。
  assert.equal(stored.pending_candidates.length, 1);
  const skipped = logs.events('lark.private_chat.send_skipped');
  assert.equal(skipped.length, 1, '可排查：不是静默失败');
  assert.match(skipped[0], /"kind":"card"/);
  assert.match(skipped[0], /"reason":"no_group_context"/);
  assert.match(skipped[0], /"task_id":"sale_query_1"/);
  assert.equal(logs.events('sale_lookup.card.sent').length, 0, '没发出去就不许记「已发出」');
});

test('② 这个 service 里**没有** open_id 卡片发送器（`sendCard` 已整体删除）', async () => {
  const { service } = await makeService({});
  assert.equal(service.sendCard, undefined, 'ⓐ：代码里一行私聊都不留');
  assert.equal(typeof service.sendCardToTask, 'function', '只留"任务感知"的出口');
});

test('② 群任务回复失败：走渠道感知出口回到那个话题，**一条私聊都不发**', async () => {
  const { service, store, taskSends } = await makeService({
    ...lookupFixture(),
    replyFails: true,
    sendCardToTask: async () => 'om_topic_card',
  });
  const task = await newTask(store, { chat_type: 'group', chat_id: 'oc_sales_group', group_thread_id: 'omt_1' });
  await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });

  assert.equal(taskSends.length, 1, '群任务必须走渠道感知出口（回话题）');
  assert.equal(taskSends[0].task.chat_id, 'oc_sales_group');
  assert.equal(await store.get('sale_query_1').then((row) => row.card_message_id), 'om_topic_card');
});

test('② 群任务两条路都失败：如实失败（不留 card_message_id）+ 记日志，不静默掉进私聊', async () => {
  const { service, store, taskSends } = await makeService({
    ...lookupFixture(),
    replyFails: true,
    sendCardToTask: async () => { throw new Error('topic reply failed'); },
  });
  const task = await newTask(store, { chat_type: 'group', chat_id: 'oc_sales_group' });
  // 兜底再失败**不抛出去**（否则会把这条查询判成处理失败，她会以为"查了没反应"）；
  // 返回值是空串 = "这次没发出去"，调用方按失败处理。
  await service.handleQuery(task, { intent: 'sale_query', item_no: '6035', color: '黑' });

  assert.equal(taskSends.length, 1, '仍然试过一次群出口');
  assert.equal(await store.get('sale_query_1').then((row) => row.card_message_id), undefined);
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

// ─── ⭐ 群话题里的售后：只能在那**一笔**销售里找（绝不跨单去捞）─────────────────
//
// BUG：afterSalesFlowService 传了 `salesEntryRecordId`，但 findCandidates 的签名里
// 没有这个参数 → 静默忽略 → 仍按「货号 + 颜色」在全表捞，可能抓到**别的单**同一双鞋。
// 业务负责人的口径：「同一笔的售后，绝不跨单去捞」。
test('⭐ 传了 salesEntryRecordId → 只返回那一笔的明细；不传时仍是全表（回归）', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      { record_id: 'e_this', fields: { 销售单号: 'XSD-THIS', 录单日: daysAgo(0), 销售状态: '已写入' } },
      { record_id: 'e_other', fields: { 销售单号: 'XSD-OTHER', 录单日: daysAgo(0), 销售状态: '已写入' } },
    ],
    details: [
      detailRow({ id: 'd_this', orderId: 'e_this', productId: 'p1' }),
      detailRow({ id: 'd_other', orderId: 'e_other', productId: 'p1' }),
    ],
  });

  const all = await service.findCandidates({ itemNo: '6035', color: '黑' });
  assert.deepEqual(all.map((row) => row.record_id).sort(), ['d_other', 'd_this'],
    '不传限定时，行为与改动前一致：全表按货号颜色捞');

  const scoped = await service.findCandidates({
    itemNo: '6035', color: '黑', salesEntryRecordId: 'e_this',
  });
  assert.deepEqual(scoped.map((row) => row.record_id), ['d_this'],
    '话题里已定位到 e_this：绝不能把 e_other 的那双也捞进来');

  // 这一笔里没有那双 → 回空（让她知道"这一笔里没有"，而不是拿别单的顶上）
  const scopedMiss = await service.findCandidates({
    itemNo: '9999', color: '黑', salesEntryRecordId: 'e_this',
  });
  assert.deepEqual(scopedMiss, []);
});

test('⭐ 只给 salesEntryRecordId（不带货号颜色）也能定位那一笔的明细', async () => {
  const { service } = await makeService({
    products: [productRow('p1', '6035', '黑')],
    entries: [
      { record_id: 'e_this', fields: { 销售单号: 'XSD-THIS', 录单日: daysAgo(0), 销售状态: '已写入' } },
      { record_id: 'e_other', fields: { 销售单号: 'XSD-OTHER', 录单日: daysAgo(0), 销售状态: '已写入' } },
    ],
    details: [
      detailRow({ id: 'd_this', orderId: 'e_this', productId: 'p1' }),
      detailRow({ id: 'd_other', orderId: 'e_other', productId: 'p1' }),
    ],
  });
  const scoped = await service.findCandidates({ salesEntryRecordId: 'e_this' });
  assert.deepEqual(scoped.map((row) => row.record_id), ['d_this']);
  // 三个限定条件全空才回空（"查全部"不是这个功能要回答的问题）
  assert.deepEqual(await service.findCandidates({}), []);
});
