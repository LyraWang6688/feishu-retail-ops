// 退换货第二期·第二步（接线 + 确认卡片）的测试。
//
// 覆盖（对应业务负责人列出的验收点）：
//   · 入口 A：先查 → 说「第 2 笔，退货，钱先存着」→ 出确认卡片（跨消息上下文）
//   · 入口 B：直接说「退那双 6035 黑」——不经查询也能定位；1 条出卡 / 多条出候选卡片（无按钮）/ 0 条明确提示
//   · 回库状态：她没说 → 卡片上有按钮（默认原状态）；她说了 → 按她说的
//   · 钱怎么走：**没有默认值**、也**没有兜底交互**——她说了按她说的（唯一路径）；
//     差价 = 0 → 不动钱；万一模型真没解析出钱怎么走 → 抛明确的错拦住（业务表零写入）
//   · 确认 → 真的调执行器（断言调用次数与参数）；取消 → 不调执行器、不写任何业务表
//   · 重复确认两次 → 执行器只生效一次（执行器总闸门）
//   · 失败 → 明确告诉她原因，状态可重试
//
// 说明：这里用**真的** SaleLookupService（只读定位）与**真的** AfterSalesService（执行器 +
// 总闸门），只把飞书写入换成内存假 Base、把库存换成端口桩。这样断言的是"接线真的把
// 她确认过的那一笔交给了执行器"，而不是"某个 mock 被调了"。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SaleLookupService } = require('../src/services/saleLookupService');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { AfterSalesFlowService } = require('../src/services/afterSalesFlowService');
const { AFTER_SALES_TASK_STATUS, AFTER_SALES_CARD_ACTIONS, afterSalesContextId,
  resolveAfterSalesSettlement } = require('../src/config/afterSalesFlow');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const DAY_MS = 24 * 60 * 60 * 1000;
// 固定"现在"：2026-10-05 16:00（上海）。窗口/过期断言都相对它算，避免跨天变脆。
const NOW = new Date('2026-10-05T16:00:00+08:00');
const TODAY_9AM = Date.parse('2026-10-05T09:00:00+08:00');
const daysAgo = (n) => TODAY_9AM - n * DAY_MS;

// ---------------------------------------------------------------------------
// 只读侧：销售记录（供真的 SaleLookupService 定位）
// ---------------------------------------------------------------------------

const productRow = (recordId, itemNo, color) => ({
  record_id: recordId, fields: { 货号: itemNo, 颜色: color, 编号: `${itemNo}|${color}`, 单价: 300 },
});
const entryRow = ({ id, orderNo, recordedAt, orderStatus = '已完成' }) => ({
  record_id: id, fields: { 销售单号: orderNo, 录单日: recordedAt, 订单状态: orderStatus },
});
const detailRow = ({ id, orderId, productId, soldAt, sizeRecordId, amount = 230 }) => ({
  record_id: id,
  fields: {
    编号: [{ record_ids: [productId], text: '' }],
    销售单号: [{ record_ids: [orderId], text: '' }],
    销售日: soldAt,
    尺码: [{ record_ids: [sizeRecordId], text: '' }],
    成交金额: amount,
  },
});

// 两笔可退的 6035 黑（39 码最近、38 码更早）+ 一笔 1366-33 黑（1 条就命中）。
const SALES = {
  products: [productRow('p1', '6035', '黑'), productRow('p2', '1366-33', '黑')],
  entries: [
    entryRow({ id: 'e2', orderNo: 'XSD-20261004-0001', recordedAt: daysAgo(1) }),
    entryRow({ id: 'e_old', orderNo: 'XSD-20261002-0001', recordedAt: daysAgo(3) }),
    entryRow({ id: 'e_single', orderNo: 'XSD-20261003-0001', recordedAt: daysAgo(2) }),
  ],
  details: [
    detailRow({ id: 'd_new', orderId: 'e2', productId: 'p1', soldAt: daysAgo(1), sizeRecordId: 'size_39' }),
    detailRow({ id: 'd_old', orderId: 'e_old', productId: 'p1', soldAt: daysAgo(3), sizeRecordId: 'size_38' }),
    detailRow({ id: 'd_single', orderId: 'e_single', productId: 'p2', soldAt: daysAgo(2), sizeRecordId: 'size_40' }),
  ],
  sizes: { size_38: 38, size_39: 39, size_40: 40 },
};

const salesGateway = () => ({
  table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
  listAll: async (tableKey) => ({
    salesDetail: SALES.details, salesEntry: SALES.entries, product: SALES.products,
  }[tableKey] || []),
});

const sizeStub = (byRecordId) => ({
  resolveLinkedCell: async (cell) => {
    const ids = Array.isArray(cell) ? [...new Set(cell.map((item) => item?.record_ids?.[0] || item).filter(Boolean))] : [];
    const id = ids[0];
    if (!(id in byRecordId)) throw new Error(`尺码关联记录不存在: ${id}`);
    return { size: byRecordId[id] };
  },
  resolveByNumber: async (value) => {
    const size = Number(value);
    const recordId = Object.keys(byRecordId).find((key) => byRecordId[key] === size);
    if (!recordId) throw new Error(`尺码管理中找不到 ${size} 码`);
    return { recordId, size };
  },
});

// ---------------------------------------------------------------------------
// 写入侧：内存假 Base（供真的 AfterSalesService 落库）
// ---------------------------------------------------------------------------

const behaviorRow = (recordId, code, name, direction) => ({
  record_id: recordId, fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true },
});

const executorBase = () => {
  const seed = {
    behavior: [
      behaviorRow('behavior_return', 'SALE_RETURN', '销售退货', '增加'),
      behaviorRow('behavior_exchange', 'SALE_EXCHANGE', '销售换货', '不影响'),
      behaviorRow('behavior_compensation', 'SALE_COMPENSATION', '销售赔货', '减少'),
      behaviorRow('behavior_cash', 'SALE_CASH', '现货销售', '减少'),
    ],
    sizeManagement: [
      { record_id: 'size_38', fields: { 尺码: 38 } },
      { record_id: 'size_39', fields: { 尺码: 39 } },
      { record_id: 'size_40', fields: { 尺码: 40 } },
    ],
    paymentMethod: [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }],
    product: [
      { record_id: 'p1', fields: { 货号: '6035', 颜色: '黑', 单价: 230 } },
      { record_id: 'p2', fields: { 货号: '1366-33', 颜色: '黑', 单价: 300 } },
    ],
    salesEntry: [
      { record_id: 'e2', fields: { 销售单号: 'XSD-20261004-0001', 原话: '卖一双 6035 黑 39', 订单状态: '已完成', 资金状态: '已写入' } },
      { record_id: 'e_old', fields: { 销售单号: 'XSD-20261002-0001', 原话: '卖一双 6035 黑 38', 订单状态: '已完成', 资金状态: '已写入' } },
      { record_id: 'e_single', fields: { 销售单号: 'XSD-20261003-0001', 原话: '卖一双 1366-33 黑 40', 订单状态: '已完成', 资金状态: '已写入' } },
    ],
    salesDetail: [
      { record_id: 'd_new', fields: { 销售单号: ['e2'], 编号: ['p1'], 尺码: ['size_39'], 成交金额: 230, 履约状态: '已交付' } },
      { record_id: 'd_old', fields: { 销售单号: ['e_old'], 编号: ['p1'], 尺码: ['size_38'], 成交金额: 230, 履约状态: '已交付' } },
      { record_id: 'd_single', fields: { 销售单号: ['e_single'], 编号: ['p2'], 尺码: ['size_40'], 成交金额: 230, 履约状态: '已交付' } },
    ],
    paymentRecord: [
      { record_id: 'pay_new', fields: { 关联销售单: ['e2'], 交易方式: ['method_wechat'], 收款金额: 230, 收款状态: '已收款' } },
      { record_id: 'pay_old', fields: { 关联销售单: ['e_old'], 交易方式: ['method_wechat'], 收款金额: 230, 收款状态: '已收款' } },
      { record_id: 'pay_single', fields: { 关联销售单: ['e_single'], 交易方式: ['method_wechat'], 收款金额: 230, 收款状态: '已收款' } },
    ],
    customerCredit: [],
    inventoryLedger: [],
    liveInventory: [
      { record_id: 'live_39', fields: { 编号: ['p1'], 尺码: ['size_39'], 所属状态: '门盒' } },
      { record_id: 'live_38', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒' } },
    ],
  };
  const records = new Map(Object.entries(seed)
    .map(([key, rows]) => [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  const writes = { create: {}, update: {}, delete: {} };
  let sequence = 0;
  const gateway = {
    records,
    writes,
    table(key) { return V1_BITABLE_SCHEMA.tables[key]; },
    fieldName(key, semantic) {
      const name = V1_BITABLE_SCHEMA.tables[key]?.fields?.[semantic];
      if (!name) throw new Error(`${key}: unknown field ${semantic}`);
      return name;
    },
    listFields: async (key) => Object.entries(V1_BITABLE_SCHEMA.tables[key].fields)
      .map(([, fieldName]) => ({ field_name: fieldName, type: 1 })),
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
    findOneByText: async (key, semantic, expected) => {
      const name = gateway.fieldName(key, semantic);
      return (records.get(key) || []).find((row) => String(row.fields[name] ?? '').trim() === String(expected).trim()) || null;
    },
    async create(key, values) {
      writes.create[key] = (writes.create[key] || 0) + 1;
      const fields = {};
      for (const [semantic, value] of Object.entries(values)) {
        if (value !== undefined) fields[gateway.fieldName(key, semantic)] = value;
      }
      const record = { record_id: `rec_${++sequence}`, fields };
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
      return { recordId: record.record_id };
    },
    async update(key, id, values) {
      writes.update[key] = (writes.update[key] || 0) + 1;
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      if (!record) throw new Error(`${key} ${id} not found`);
      for (const [semantic, value] of Object.entries(values)) record.fields[gateway.fieldName(key, semantic)] = value;
      return record;
    },
    async delete(key, id) {
      writes.delete[key] = (writes.delete[key] || 0) + 1;
      records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id));
      return true;
    },
  };
  return gateway;
};

// 库存端口：只回答"被调过没有、参数对不对"，库存引擎的内部实现由 afterSalesService.test.js 覆盖。
const fakeInventory = () => ({
  calls: [],
  async applyChange(input) {
    this.calls.push({ ...input });
    return { direction: '增加', ledgerRecordId: `led_${this.calls.length}`, liveRecordIds: [], quantity: input.quantity };
  },
});

// 换货/赔货要解析"换成的那一双"：货品与尺码都注入桩，不读远端。
const referencesStub = () => ({
  gateway: { table: () => ({ fields: { price: '单价' } }) },
  resolveProduct: async ({ itemNo, color }) => {
    const record = itemNo === '1366-33'
      ? { record_id: 'p2', fields: { 货号: '1366-33', 颜色: color || '黑', 单价: 300 } }
      : { record_id: 'p1', fields: { 货号: itemNo, 颜色: color || '黑', 单价: 230 } };
    return { recordId: record.record_id, record, ambiguousCount: 1 };
  },
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const tempStore = (prefix) => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  idField: 'task_id',
});

/**
 * 组装一套"真定位 + 真执行器 + 假 Base"的售后编排。
 * options.executor 传端口时用桩（只断言"被调了、参数对不对"）。
 */
const build = (options = {}) => {
  let clock = NOW;
  const gateway = salesGateway();
  const base = executorBase();
  const inventory = fakeInventory();
  const store = tempStore('after-sales-flow-');
  const cards = { all: [], updated: [], sent: [] };
  const texts = [];
  const lookup = new SaleLookupService({
    gateway,
    store,
    sizeReferences: sizeStub(SALES.sizes),
    now: () => clock,
    replyCard: async (_messageId, card) => { cards.all.push(card); return 'om_lookup'; },
    sendCard: async (_openId, card) => { cards.all.push(card); return 'om_lookup_fallback'; },
  });
  const afterSales = options.executor || new AfterSalesService({
    gateway: base,
    inventory,
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-ops-')), idField: 'operation_id',
    }),
    now: () => clock.getTime(),
  });
  const flow = new AfterSalesFlowService({
    gateway,
    store,
    lookup,
    executor: afterSales,
    references: options.references || referencesStub(),
    sizeReferences: sizeStub(SALES.sizes),
    now: () => clock,
    replyCard: async (_messageId, card) => { cards.all.push(card); return 'om_flow'; },
    sendCard: async (_openId, card) => { cards.all.push(card); cards.sent.push(card); return 'om_flow_sent'; },
    sendText: async (_openId, message) => texts.push(message),
    updateCard: async (_task, _event, card) => { cards.updated.push(card); return true; },
  });
  return {
    flow, lookup, store, gateway, base, inventory, afterSales, cards, texts,
    setClock: (date) => { clock = date; },
    cardAction: (value, operatorOpenId = 'ou_1', event = { context: { open_message_id: 'om_card' } }) =>
      flow.handleCardAction(value, event, operatorOpenId, { interactionId: 'act_1' }),
  };
};

const newTask = (store, overrides = {}) => store.create({
  task_id: 't_after_sales',
  type: 'sale',
  status: 'received',
  message_id: 'om_msg',
  sender_open_id: 'ou_1',
  original_text: '退那双 6035 黑',
  ...overrides,
});

const cardText = (card) => JSON.stringify(card);

// 收集卡片里所有 button 的 value.action（column_set / action 两种结构都认）。
const cardButtons = (card) => (card.elements || []).flatMap((element) => {
  if (element.tag === 'action') return element.actions || [];
  if (element.tag !== 'column_set') return [];
  return (element.columns || []).flatMap((column) => column.elements || []).filter((child) => child.tag === 'button');
});

// ---------------------------------------------------------------------------
// 入口 A：先查、再选
// ---------------------------------------------------------------------------

test('入口 A：先查 → 说「第 2 笔，退货，钱先存着」→ 出确认卡片，执行器还没被调用', async () => {
  const { flow, lookup, store, cards, texts } = build();
  // 先查（第一期链路）：候选按顺序 [d_new(39码, 昨天), d_old(38码, 3 天前)]
  const queryTask = await newTask(store, { task_id: 't_query', original_text: '帮我查 6035 黑' });
  const queryResult = await lookup.handleQuery(queryTask, { intent: 'sale_query', item_no: '6035', color: '黑' });
  assert.deepEqual(queryResult.candidates.map((row) => row.record_id), ['d_new', 'd_old']);

  // 接线层在查询之后做的事：把候选按人记一份（跨消息上下文）
  await flow.rememberCandidates('ou_1', queryResult.candidates);

  // 第二条消息是**新任务**（每条用户消息一个任务），所以只能靠上面那份按人上下文对上序号
  const returnTask = await newTask(store, {
    task_id: 't_return', original_text: '第 2 笔，退货，钱先存着',
  });
  const result = await flow.handle(returnTask, {
    intent: 'return', action: 'return', ordinal: 2, settlement: 'prepaid',
  });

  assert.equal(result.located, true);
  assert.equal(result.source, 'ordinal');
  const stored = await store.get('t_return');
  assert.equal(stored.status, AFTER_SALES_TASK_STATUS.CONFIRMING);
  // 「第 2 笔」= d_old（38 码，3 天前那笔），不是最近那笔
  assert.equal(stored.after_sales_plan.original_sales_detail_record_ids[0], 'd_old');
  assert.equal(stored.after_sales_plan.original_sales_order_no, 'XSD-20261002-0001');
  assert.equal(stored.after_sales_plan.settlement, 'prepaid');
  assert.equal(stored.after_sales_plan.diff_amount, -230);
  assert.equal(stored.after_sales_plan.restock_state, '门盒');
  assert.equal(stored.after_sales_plan.restock_state_explicit, false);
  // 出的是一张**有按钮**的确认卡片（它要动账）。
  // 这里一共两张卡：第一张是查询的候选卡片，第二张才是售后确认卡片。
  assert.equal(cards.all.length, 2);
  assert.equal(cards.all[0].header.title.content, '最近 5 天的销售记录');
  const confirmation = cards.all.at(-1);
  assert.equal(confirmation.header.title.content, '请确认售后');
  assert.match(cardText(confirmation), /6035黑/);
  assert.match(cardText(confirmation), /退货/);
  assert.match(cardText(confirmation), /存为预存额度/);
  assert.deepEqual(cardButtons(confirmation).map((button) => button.value.action),
    ['choose_after_sales_restock', 'choose_after_sales_restock', 'confirm_after_sales', 'cancel_after_sales']);
  assert.deepEqual(texts, []);
});

// ---------------------------------------------------------------------------
// 入口 B：她直接说（不依赖先查）
// ---------------------------------------------------------------------------

test('入口 B：直接说「退那双 1366-33 黑」→ 没查过也能定位，命中 1 条直接出确认卡片', async () => {
  const { flow, store, cards, texts } = build();
  const task = await newTask(store, { original_text: '退那双 1366-33 黑，退现金' });

  const result = await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });

  assert.equal(result.located, true);
  assert.equal(result.source, 'direct');
  const stored = await store.get('t_after_sales');
  assert.deepEqual(stored.after_sales_plan.original_sales_detail_record_ids, ['d_single']);
  assert.equal(cards.all.length, 1);
  assert.match(cardText(cards.all[0]), /1366-33黑/);
  assert.deepEqual(texts, []);
});

test('入口 B：命中多条 → 出候选卡片（无按钮、带序号），并把候选记进上下文让她能说「第 1 笔」', async () => {
  const { flow, store, cards, texts } = build();
  const task = await newTask(store, { original_text: '退那双 6035 黑' });

  const result = await flow.handle(task, { intent: 'return', action: 'return', item_no: '6035', color: '黑' });

  assert.equal(result.located, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(cards.all.length, 1);
  const candidateCard = cards.all[0];
  // ⚠️ 候选卡片刻意没有任何按钮：她要用自然语言回「第 1 笔」。
  assert.deepEqual(cardButtons(candidateCard), []);
  assert.equal(cardText(candidateCard).includes('"action"'), false);
  assert.match(cardText(candidateCard), /1\. /);
  assert.match(cardText(candidateCard), /2\. /);
  assert.equal((await store.get('t_after_sales')).status, AFTER_SALES_TASK_STATUS.ASKING);

  // 候选按卡片顺序记进了"按人"上下文：下一句「第 1 笔，退货」能直接对上。
  const context = await store.get(afterSalesContextId('ou_1'));
  assert.deepEqual(context.pending_candidates.map((row) => row.record_id), ['d_new', 'd_old']);
  assert.deepEqual(texts, []);

  const next = await newTask(store, { task_id: 't_pick', original_text: '第 1 笔，退货' });
  // 钱没说 → **没有默认走向、也没有兜底交互**：这一笔直接大声拦住（详见下面「钱怎么走」一组）
  await assert.rejects(
    () => flow.handle(next, { intent: 'return', action: 'return', ordinal: 1 }),
    /没解析出这次的钱怎么走/,
  );
  assert.equal((await store.get('t_pick')).after_sales_plan, undefined);
  assert.deepEqual(texts, []);
});

test('入口 B：命中 0 条 → 明确告诉她没找到，并问她大概是哪天买的', async () => {
  const { flow, store, cards } = build();
  const task = await newTask(store, { original_text: '退那双 9999 黑' });

  const result = await flow.handle(task, { intent: 'return', action: 'return', item_no: '9999', color: '黑' });

  assert.equal(result.located, false);
  assert.equal(result.reason, 'no_match');
  assert.equal(cards.all.length, 1);
  assert.match(cardText(cards.all[0]), /没查到/);
  assert.match(cardText(cards.all[0]), /哪天买的/);
  assert.equal((await store.get('t_after_sales')).status, AFTER_SALES_TASK_STATUS.ASKING);
});

test('入口 B：连货号都没说（「我要退货」）→ 问她要货号，不猜也不写任何东西', async () => {
  const { flow, store, cards, texts, base } = build();
  const task = await newTask(store, { original_text: '我要退货' });

  const result = await flow.handle(task, { intent: 'return', action: 'return' });

  assert.equal(result.reason, 'no_item_info');
  assert.deepEqual(cards.all, []);
  assert.deepEqual(texts, ['退哪一双？发我货号，比如"6035 黑"。']);
  // 只写本地任务状态，业务表一个字节都没写
  assert.deepEqual(base.writes.create, {});
  assert.deepEqual(base.writes.update, {});
});

// ---------------------------------------------------------------------------
// 退回的鞋放哪：她没说 / 她说了
// ---------------------------------------------------------------------------

test('退回的鞋放哪：她没说 → 卡片上有选择且默认门盒；她说了 → 按她说的填并传给执行器', async () => {
  // 钱这块她说了（退现金），所以这两条只盯"退回的鞋放哪"；钱的规则在下面单独一组。
  const silent = build();
  const silentTask = await newTask(silent.store, { original_text: '退那双 1366-33 黑，退现金' });
  await silent.flow.handle(silentTask, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });
  const silentPlan = (await silent.store.get('t_after_sales')).after_sales_plan;
  assert.equal(silentPlan.restock_state, '门盒');
  assert.equal(silentPlan.restock_state_explicit, false);
  const restockButtons = cardButtons(silent.cards.all[0]).filter((button) =>
    button.value.action === 'choose_after_sales_restock');
  assert.deepEqual(restockButtons.map((button) => button.value.state), ['门盒', '样品']);
  // 默认那一项是 primary（手机上高亮），另一项是 default
  assert.deepEqual(restockButtons.map((button) => button.type), ['primary', 'default']);
  assert.match(cardText(silent.cards.all[0]), /默认/);

  const spoken = build();
  const spokenTask = await newTask(spoken.store, { original_text: '退那双 1366-33 黑，放样品' });
  await spoken.flow.handle(spokenTask, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', restock_state: '样品',
    settlement: 'cash',
  });
  const spokenPlan = (await spoken.store.get('t_after_sales')).after_sales_plan;
  assert.equal(spokenPlan.restock_state, '样品');
  assert.equal(spokenPlan.restock_state_explicit, true);
  assert.match(cardText(spoken.cards.all[0]), /样品/);
});

test('她在卡片上改回库状态 → 卡片重渲染、状态记为显式选择', async () => {
  const { flow, store, cards, cardAction } = build();
  const task = await newTask(store, { original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });

  const toast = await cardAction({ action: 'choose_after_sales_restock', draft_id: 't_after_sales', state: '样品' });

  assert.equal(toast.toast.type, 'success');
  const plan = (await store.get('t_after_sales')).after_sales_plan;
  assert.equal(plan.restock_state, '样品');
  assert.equal(plan.restock_state_explicit, true);
  assert.equal(cards.updated.length, 1);
  assert.equal(cards.updated[0].header.title.content, '请确认售后');
});

// ---------------------------------------------------------------------------
// 钱怎么走：**没有默认值**，也**没有兜底交互**（业务负责人的红线）
//
// 「不是啊，退货不是默认现金啊，都有啊！只不过是分为是不是当前退钱还是先预存着而已」
// 「不用啊，你为什么要做兜底呢？……都会说清楚的呀。所以，为什么你还要再去做兜底呢？」
//
//   · 她说了 → 按她说的（**唯一路径**）；
//   · 差价 = 0 → 不动钱，不用定；
//   · 万一模型真没解析出钱怎么走 → **抛明确的错拦住这一笔**、业务表零写入
//     （不默认、不追问、不记待回答的计划、不出卡片）。
//   · 卡片上没有资金选择按钮（她纠正过：「会说的，所以不用再有要卡片按钮的链路了」）。
// ---------------------------------------------------------------------------

// 配置层：删掉的那个默认值不许加回来（这是本次改动的根因，用测试锁住）
test('配置层：**不存在**默认资金走向；只有她明说了才解析得出走向', () => {
  const flowConfig = require('../src/config/afterSalesFlow');
  assert.equal('DEFAULT_AFTER_SALES_SETTLEMENT' in flowConfig, false, '钱不能有默认值');
  assert.equal(resolveAfterSalesSettlement(''), '');
  assert.equal(resolveAfterSalesSettlement(undefined), '');
  assert.equal(resolveAfterSalesSettlement('退我现金'), 'cash');
  // 自然语言里带关键词也算说了；但两族都出现（说法自相矛盾）时返回空 → 大声拦住，不猜
  assert.equal(resolveAfterSalesSettlement('退我微信'), 'cash');
  assert.equal(resolveAfterSalesSettlement('钱先给我存着'), 'prepaid');
  assert.equal(resolveAfterSalesSettlement('现金还是先存着'), '');
  assert.equal(resolveAfterSalesSettlement('钱先存着'), 'prepaid');
  // 也没有"为没解析出来而准备的卡片动作"
  assert.equal(Object.values(AFTER_SALES_CARD_ACTIONS).includes('choose_after_sales_settlement'), false);
});

test('她说了「钱先存着」→ 结算 = 预存，直接出确认卡片', async () => {
  const { flow, store, cards, texts } = build();
  const task = await newTask(store, { original_text: '退那双 1366-33 黑，钱先存着' });

  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'prepaid',
  });

  const plan = (await store.get('t_after_sales')).after_sales_plan;
  assert.equal(plan.settlement, 'prepaid');
  assert.equal(plan.settlement_explicit, true);
  assert.equal(plan.requires_settlement, false);
  assert.equal((await store.get('t_after_sales')).status, AFTER_SALES_TASK_STATUS.CONFIRMING);
  assert.equal(cards.all.length, 1);
  assert.match(cardText(cards.all[0]), /钱：存为预存额度/);
  // 钱这块**没有任何按钮**
  assert.equal(cardText(cards.all[0]).includes('choose_after_sales_settlement'), false);
  assert.deepEqual(texts, []);
});

test('她说了「退我现金」/「退给她 230，微信退」→ 结算 = 收款明细', async () => {
  for (const [text, spoken] of [
    ['退那双 1366-33 黑，退我现金', '退我现金'],
    ['退那双 1366-33 黑，退给她 230，微信退', '微信'],
    ['退那双 1366-33 黑，退现金', 'cash'],
  ]) {
    const { flow, store, cards, texts } = build();
    const task = await newTask(store, { original_text: text });

    await flow.handle(task, {
      intent: 'return', action: 'return', item_no: '1366-33', color: '黑',
      settlement: resolveAfterSalesSettlement(spoken) || spoken,
    });

    assert.equal((await store.get('t_after_sales')).after_sales_plan.settlement, 'cash', text);
    assert.match(cardText(cards.all[0]), /钱：退现金/, text);
    assert.equal(cardText(cards.all[0]).includes('choose_after_sales_settlement'), false);
    assert.deepEqual(texts, [], text);
  }
});

// 这是本组最关键的一条：模型没解析出钱怎么走时，**大声拦住**，绝不猜、绝不写。
test('⚠️ 没解析出钱怎么走 → 抛明确的错拦住、业务表零写入、不出卡片（不默认现金）', async () => {
  const { flow, store, cards, texts, base } = build();
  const task = await newTask(store, { task_id: 't_unparsed', original_text: '退那双 1366-33 黑' });

  await assert.rejects(
    () => flow.handle(task, { intent: 'return', action: 'return', item_no: '1366-33', color: '黑' }),
    (error) => {
      // 报错要说得清"缺什么、她该干什么"，不能是内部字段名
      assert.match(error.message, /没解析出这次的钱怎么走/);
      assert.match(error.message, /退现金 \/ 存为预存额度/);
      assert.match(error.message, /重发一次/);
      return true;
    },
  );

  // 拦住 = 什么都不做：没有卡片、没有业务写入、任务没被改成"待确认"
  assert.deepEqual(cards.all, [], '不许出确认卡片');
  assert.deepEqual(base.writes, { create: {}, update: {}, delete: {} }, '业务表必须零写入');
  assert.deepEqual(texts, [], '不追问、不设计交互，只报错');
  assert.equal((await store.get('t_unparsed')).after_sales_plan, undefined);
  assert.equal((await store.get('t_unparsed')).status, 'received');
});

test('她说了一句和钱自相矛盾的话（"现金还是先存着"）→ 同样拦住，不猜', async () => {
  const { flow, store, base } = build();
  const task = await newTask(store, { task_id: 't_contradict', original_text: '退那双 1366-33 黑，现金还是先存着' });

  await assert.rejects(
    () => flow.handle(task, {
      intent: 'return', action: 'return', item_no: '1366-33', color: '黑',
      settlement: resolveAfterSalesSettlement('现金还是先存着'),
    }),
    /没解析出这次的钱怎么走/,
  );
  assert.deepEqual(base.writes, { create: {}, update: {}, delete: {} });
});

test('差价 = 0（不动钱）→ 卡片直接写「不动钱」，不用定也不报错', async () => {
  const calls = [];
  const { flow, store, cards, texts, cardAction } = build({
    executor: { execute: async (request) => { calls.push(request); return {}; } },
  });
  const task = await newTask(store, { task_id: 't_free', original_text: '退那双 1366-33 黑，不退钱' });

  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', diff_amount: 0,
  });

  const plan = (await store.get('t_free')).after_sales_plan;
  assert.equal(plan.diff_amount, 0);
  assert.equal(plan.settlement, null);
  assert.equal(plan.requires_settlement, false);
  assert.equal(cards.all.length, 1);
  assert.deepEqual(texts, []);
  assert.match(cardText(cards.all[0]), /钱：不动钱/);
  assert.match(cardText(cards.all[0]), /差价：￥0/);

  const toast = await cardAction({ action: 'confirm_after_sales', draft_id: 't_free' });
  assert.equal(toast.toast.type, 'success');
  assert.equal(calls.length, 1);
  // 传给执行器的就是"不动钱"：settlement 空 + 差价 0（执行器按这个口径写"没动钱"）
  assert.equal(calls[0].settlement, null);
  assert.equal(calls[0].diffAmount, 0);
});

test('换货/赔货同理：要补差价而钱没解析出来 → 一样拦住、一样业务表零写入', async () => {
  for (const [taskId, originalText, parsed, expectedAction] of [
    ['t_ex_unparsed', '把 6035 黑 38 换成 1366-33 黑 40', {
      intent: 'exchange', action: 'exchange', item_no: '6035', color: '黑', size: 38,
      new_item_no: '1366-33', new_color: '黑', new_size: 40,
    }, 'exchange'],
    ['t_comp_unparsed', '赔一双 1366-33 黑 40', {
      intent: 'exchange', action: 'compensation', item_no: '6035', color: '黑', size: 38,
      new_item_no: '1366-33', new_color: '黑', new_size: 40,
    }, 'compensation'],
  ]) {
    const { flow, store, cards, base, texts } = build();
    const task = await newTask(store, { task_id: taskId, original_text: originalText });

    await assert.rejects(() => flow.handle(task, parsed), /没解析出这次的钱怎么走/, expectedAction);

    assert.deepEqual(cards.all, [], `${expectedAction} 不许出卡片`);
    assert.deepEqual(texts, [], `${expectedAction} 不追问`);
    assert.deepEqual(base.writes, { create: {}, update: {}, delete: {} });
  }
});

test('换货她说了钱怎么走 → 照她说的走，换成的那双和差价都在计划里', async () => {
  const calls = [];
  const { flow, store, cards, cardAction } = build({
    executor: { execute: async (request) => { calls.push(request); return {}; } },
  });
  const task = await newTask(store, { task_id: 't_ex_cash', original_text: '把 6035 黑 38 换成 1366-33 黑 40，退我现金' });
  await flow.handle(task, {
    intent: 'exchange', action: 'exchange', item_no: '6035', color: '黑', size: 38,
    new_item_no: '1366-33', new_color: '黑', new_size: 40, settlement: 'cash',
  });

  const plan = (await store.get('t_ex_cash')).after_sales_plan;
  assert.equal(plan.action, 'exchange');
  assert.equal(plan.settlement, 'cash');
  assert.deepEqual(plan.new_lines.map((line) => [line.productId, line.sizeId, line.amount]),
    [['p2', 'size_40', 300]]);
  assert.equal(plan.diff_amount, 70);
  assert.match(cardText(cards.all[0]), /换货（换成 1366-33黑 40码）/);
  // 她补差价 70：走收款明细那条腿，卡片上说"收现金"
  assert.match(cardText(cards.all[0]), /钱：收现金/);

  await cardAction({ action: 'confirm_after_sales', draft_id: 't_ex_cash' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settlement, 'cash');
  assert.equal(calls[0].diffAmount, 70);
});

test('兜底（不该发生）：一份"钱还没定"的方案被点到确认 → 抛错拦住、业务表零写入', async () => {
  const calls = [];
  const { flow, store, base, cardAction } = build({
    executor: { execute: async (request) => { calls.push(request); return {}; } },
  });
  const task = await newTask(store, { task_id: 't_inflight', original_text: '退那双 1366-33 黑' });
  // 正常流程不会这样落库（没解析出钱就在 handle 里抛错了）；这里**故意**造一份在途方案
  // （历史卡片 / 别处拼出来的），验证确认那一关也拦得住钱。
  await store.update('t_inflight', {
    status: AFTER_SALES_TASK_STATUS.CONFIRMING,
    after_sales_plan: {
      action: 'return', action_label: '退货',
      candidate: { record_id: 'd_single', item_no: '1366-33', color: '黑', size: 40, actual_amount: 230 },
      original_sales_entry_record_id: 'e_single', original_sales_order_no: 'XSD-20261003-0001',
      original_sales_detail_record_ids: ['d_single'], new_lines: [],
      settlement: null, requires_settlement: true, diff_amount: -230,
      restock_state: '门盒', requires_restock_state: true,
    },
  });

  await assert.rejects(
    () => cardAction({ action: 'confirm_after_sales', draft_id: 't_inflight' }),
    /还没确定钱怎么走/,
  );

  assert.deepEqual(calls, [], '钱没定不许调执行器');
  assert.deepEqual(base.writes, { create: {}, update: {}, delete: {} }, '业务表必须零写入');
  assert.equal((await store.get('t_inflight')).status, AFTER_SALES_TASK_STATUS.CONFIRMING);
});

// ---------------------------------------------------------------------------
// 确认 / 取消 / 重复确认
// ---------------------------------------------------------------------------

test('她点确认 → 真的调执行器，参数就是她确认过的那一笔；卡片回"做完了"', async () => {
  const calls = [];
  const { flow, store, cards, cardAction } = build({
    executor: { execute: async (request) => { calls.push(request); return {
      action: 'return', label: '退货', masterRecordId: 'rec_9', detailRecordIds: ['rec_10'],
      money: { route: 'cash', direction: '退回', amount: 230 }, stock: [],
    }; } },
  });
  const task = await newTask(store, { task_id: 't_confirm', original_text: '第 2 笔，退货，钱先存着' });
  await flow.rememberCandidates('ou_1', [
    { record_id: 'd_new', date: '2026-10-04', item_no: '6035', color: '黑', size: 39,
      actual_amount: 230, sales_order_no: 'XSD-20261004-0001', sales_entry_record_id: 'e2' },
    { record_id: 'd_old', date: '2026-10-02', item_no: '6035', color: '黑', size: 38,
      actual_amount: 230, sales_order_no: 'XSD-20261002-0001', sales_entry_record_id: 'e_old' },
  ]);
  await flow.handle(task, { intent: 'return', action: 'return', ordinal: 2, settlement: 'prepaid' });

  const toast = await cardAction({ action: 'confirm_after_sales', draft_id: 't_confirm' });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    action: 'return',
    originalText: '第 2 笔，退货，钱先存着',
    originalSalesEntryRecordId: 'e_old',
    originalSalesOrderNo: 'XSD-20261002-0001',
    originalSalesDetailRecordIds: ['d_old'],
    newLines: [],
    diffAmount: -230,
    settlement: 'prepaid',
    restockState: '门盒',
    taskId: 't_confirm',
    operatorOpenId: 'ou_1',
  });
  assert.equal(toast.toast.type, 'success');
  assert.equal((await store.get('t_confirm')).status, AFTER_SALES_TASK_STATUS.DONE);
  assert.equal(cards.updated.at(-1).header.title.content, '退货已完成');
  assert.match(cardText(cards.updated.at(-1)), /已写入/);
  assert.match(cardText(cards.updated.at(-1)), /明细 1 条/);
});

test('她点取消 → 不调执行器、业务表零写入，只把本地状态置为已取消', async () => {
  const calls = [];
  const { flow, store, cards, cardAction, base } = build({
    executor: { execute: async (request) => { calls.push(request); return {}; } },
  });
  const task = await newTask(store, { task_id: 't_cancel', original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });

  const toast = await cardAction({ action: 'cancel_after_sales', draft_id: 't_cancel' });

  assert.deepEqual(calls, []);
  assert.equal(toast.toast.type, 'info');
  assert.equal((await store.get('t_cancel')).status, AFTER_SALES_TASK_STATUS.CANCELLED);
  assert.deepEqual(base.writes, { create: {}, update: {}, delete: {} });
  assert.equal(cards.updated.at(-1).header.title.content, '已取消售后');
});

test('重复点确认两次 → 执行器只生效一次（第二次走 done 短路，不用再写）', async () => {
  const { flow, store, base, inventory, cardAction } = build();
  const task = await newTask(store, { task_id: 't_twice', original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, { intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash' });

  const first = await cardAction({ action: 'confirm_after_sales', draft_id: 't_twice' });
  const writesAfterFirst = JSON.stringify(base.writes);
  const second = await cardAction({ action: 'confirm_after_sales', draft_id: 't_twice' });

  assert.equal(first.toast.type, 'success');
  assert.equal(second.toast.type, 'info');
  assert.equal(JSON.stringify(base.writes), writesAfterFirst, '第二次确认不应再产生任何业务写入');
  assert.equal(base.writes.create.salesEntry, 1);
  assert.equal(base.writes.create.salesDetail, 1);
  assert.equal(inventory.calls.length, 1, '整次跳过时连库存服务都不调用');
  assert.equal((await store.get('t_twice')).status, AFTER_SALES_TASK_STATUS.DONE);
});

test('本地状态丢了也安全：状态被重置后再点确认 → 执行器总闸门整次跳过，业务表仍只写一次', async () => {
  const { flow, store, base, cardAction } = build();
  const task = await newTask(store, { task_id: 't_gate', original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, { intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash' });
  await cardAction({ action: 'confirm_after_sales', draft_id: 't_gate' });
  const writesAfterFirst = JSON.stringify(base.writes);

  // 模拟"本地任务状态没落盘 / 被重置"：把状态改回待确认，再点一次确认。
  // 这时只能靠执行器自己的总闸门拦住重复写。
  await store.update('t_gate', { status: AFTER_SALES_TASK_STATUS.CONFIRMING });
  const again = await cardAction({ action: 'confirm_after_sales', draft_id: 't_gate' });

  assert.equal(again.toast.type, 'success');
  assert.equal(JSON.stringify(base.writes), writesAfterFirst, '执行器总闸门必须整次跳过');
  assert.equal(base.writes.create.salesEntry, 1);
  assert.equal(base.writes.create.salesDetail, 1);
  assert.equal((await store.get('t_gate')).status, AFTER_SALES_TASK_STATUS.DONE);
});

test('执行器失败 → 明确告诉她原因，状态回到待确认可重试（不静默）', async () => {
  const { flow, store, cards, cardAction } = build({
    executor: { execute: async () => { throw new Error('原单号对不上：主表记录上是「XSD-OTHER」'); } },
  });
  const task = await newTask(store, { task_id: 't_fail', original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, { intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash' });

  const toast = await cardAction({ action: 'confirm_after_sales', draft_id: 't_fail' });

  assert.equal(toast.toast.type, 'warning');
  assert.match(toast.toast.content, /没做成：原单号对不上/);
  assert.equal((await store.get('t_fail')).status, AFTER_SALES_TASK_STATUS.CONFIRMING);
  assert.match(cardText(cards.updated.at(-1)), /原单号对不上/);
  // 失败后卡片必须**还能重试**：原因写在最上面，确认按钮还在。
  assert.equal(cardButtons(cards.updated.at(-1)).map((button) => button.value.action).includes('confirm_after_sales'), true);
});

// ---------------------------------------------------------------------------
// 换货：换成的那一双要能解析出来
// ---------------------------------------------------------------------------

test('换货：解析"换成的那一双"（货号+颜色+尺码+金额），差价按建议值算给她看', async () => {
  const calls = [];
  const { flow, store, cards, cardAction, base } = build({
    executor: { execute: async (request) => { calls.push(request); return {
      action: 'exchange', label: '换货', masterRecordId: 'rec_1', detailRecordIds: ['rec_2'],
      money: { route: 'cash', direction: '收入', amount: 70 }, stock: [],
    }; } },
  });
  const task = await newTask(store, { task_id: 't_exchange', original_text: '把 6035 黑 38 换成 1366-33 黑 40' });
  await flow.handle(task, {
    intent: 'exchange', action: 'exchange', item_no: '6035', color: '黑', size: 38,
    new_item_no: '1366-33', new_color: '黑', new_size: 40, settlement: 'cash',
  });

  const plan = (await store.get('t_exchange')).after_sales_plan;
  assert.equal(plan.action, 'exchange');
  assert.deepEqual(plan.original_sales_detail_record_ids, ['d_old']);
  assert.deepEqual(plan.new_lines.map((line) => [line.productId, line.sizeId, line.amount]),
    [['p2', 'size_40', 300]]);
  // 她没说差价 → 建议值 = 新鞋 300 - 原鞋 230 = 她补 70
  assert.equal(plan.diff_amount, 70);
  assert.match(cardText(cards.all[0]), /换货（换成 1366-33黑 40码）/);
  assert.match(cardText(cards.all[0]), /她补/);

  await cardAction({ action: 'confirm_after_sales', draft_id: 't_exchange' });
  assert.deepEqual(calls[0].newLines, [{ productId: 'p2', sizeId: 'size_40', amount: 300 }]);
  assert.equal(calls[0].diffAmount, 70);
  // 换货的库存那两条腿由执行器负责；这一层没有写业务表
  assert.equal(base.writes.create.salesEntry, undefined);
});

test('换货缺"新的一双"信息 → 明确问她，不出确认卡片', async () => {
  const { flow, store, cards, texts } = build();
  const task = await newTask(store, { original_text: '把 6035 黑 38 换一双' });
  await flow.handle(task, { intent: 'exchange', action: 'exchange', item_no: '6035', color: '黑', size: 38 });

  assert.deepEqual(cards.all, []);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /换成哪一双/);
});

// ---------------------------------------------------------------------------
// 卡片结构（两个已踩过的坑）
// ---------------------------------------------------------------------------

test('确认卡片结构：字号走 div+lark_md，按钮走 column_set（一行多列，手机不竖排）', async () => {
  const { flow, store, cards } = build();
  const task = await newTask(store, { original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });
  const card = cards.all[0];

  // ① markdown 元素不能设字号：所有 text_size 都必须在 div.text 里
  const collect = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((item) => collect(item, out)); return out; }
    if (node && typeof node === 'object') {
      if (node.tag === 'markdown' && ('text_size' in node)) out.push(node);
      Object.values(node).forEach((value) => collect(value, out));
    }
    return out;
  };
  assert.deepEqual(collect(card), [], 'markdown 元素不能设字号');
  assert.equal(cardText(card).includes('"text_size":"heading"'), true);
  assert.equal(cardText(card).includes('"tag":"lark_md"'), true);

  // ② 一行多个按钮必须走 column_set（flex_mode:none + 每列 weighted/weight 1）
  const rows = card.elements.filter((element) => element.tag === 'column_set');
  assert.equal(rows.length, 2, '一行放回库状态，一行放确认/取消');
  for (const row of rows) {
    assert.equal(row.flex_mode, 'none');
    assert.equal(row.horizontal_spacing, '8px');
    for (const column of row.columns) {
      assert.equal(column.width, 'weighted');
      assert.equal(column.weight, 1);
    }
  }
});

// ---------------------------------------------------------------------------
// 多轮上下文的边界
// ---------------------------------------------------------------------------

test('序号上下文过期：说「第 2 笔」但已经过了 10 分钟 → 明确请她重新查，不拿旧列表猜', async () => {
  const { flow, store, cards, texts, setClock } = build();
  await flow.rememberCandidates('ou_1', [
    { record_id: 'd_new', date: '2026-10-04', item_no: '6035', color: '黑', size: 39, actual_amount: 230,
      sales_order_no: 'XSD-20261004-0001', sales_entry_record_id: 'e2' },
    { record_id: 'd_old', date: '2026-10-02', item_no: '6035', color: '黑', size: 38, actual_amount: 230,
      sales_order_no: 'XSD-20261002-0001', sales_entry_record_id: 'e_old' },
  ]);
  setClock(new Date(NOW.getTime() + 11 * 60 * 1000));
  const task = await newTask(store, { original_text: '第 2 笔，退货' });

  const result = await flow.handle(task, { intent: 'return', action: 'return', ordinal: 2 });

  assert.equal(result.reason, 'ordinal_expired');
  assert.deepEqual(cards.all, []);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /超过 10 分钟|重新/);
  assert.equal((await store.get('t_after_sales')).status, AFTER_SALES_TASK_STATUS.ASKING);
});

test('序号越界：说「第 5 笔」但上下文里只有 2 笔 → 如实告诉她有几笔', async () => {
  const { flow, store, texts } = build();
  await flow.rememberCandidates('ou_1', [
    { record_id: 'd_new', date: '2026-10-04', item_no: '6035', color: '黑', size: 39, actual_amount: 230,
      sales_order_no: 'XSD-20261004-0001', sales_entry_record_id: 'e2' },
    { record_id: 'd_old', date: '2026-10-02', item_no: '6035', color: '黑', size: 38, actual_amount: 230,
      sales_order_no: 'XSD-20261002-0001', sales_entry_record_id: 'e_old' },
  ]);
  const task = await newTask(store, { original_text: '第 5 笔，退货' });

  const result = await flow.handle(task, { intent: 'return', action: 'return', ordinal: 5 });

  assert.equal(result.reason, 'ordinal_out_of_range');
  assert.equal(texts.length, 1);
  assert.match(texts[0], /只有 2 笔/);
});

test('不是本人的卡片点不动：别人点确认会被拒绝', async () => {
  const { flow, store, cardAction, base } = build();
  const task = await newTask(store, { original_text: '退那双 1366-33 黑，退现金' });
  await flow.handle(task, {
    intent: 'return', action: 'return', item_no: '1366-33', color: '黑', settlement: 'cash',
  });

  await assert.rejects(() => cardAction({ action: 'confirm_after_sales', draft_id: 't_after_sales' }, 'ou_other'),
    /只能由原始发送人/);
  assert.deepEqual(base.writes.create, {});
});
