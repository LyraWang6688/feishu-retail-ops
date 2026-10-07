// 放开「定金单只支持一条明细」：**一张单多明细 · 交易类型按明细行 · 整单多选**
//
// 业务负责人口径（2026-10-07，逐字）：
//   「它就应该**分两条销售明细，然后三条收款明细**，为什么分不了呢？**这就是一个人买的呀**」
//   「**在销售明细里面分开，它是现货还是预付款**，不就可以了吗？」
//   「**如果它包括多种交易类型，你多选就行了**。**但是实际到我们的销售明细里面，
//     就这一单它是什么，那就是什么**」
//
// 验收标准（动手前先写、实现后逐条对照）见
// `docs/sales-multi-line-trade-type-2026-10-07.md`。
//
// 真机场景（她 2026-10-07 18:37 一条消息 = 一张单）：
//   「119 元，微信。
//     卖了 31678，40 码。
//     定制一双 6681-1，42 码，定金 50 元，下次付 39 元」
//   ⇒ 销售明细 2 条（现货 119 / 预付 89）、收款明细 3 条（119 已收 / 50 已收 / 39 未收）、
//     主表交易类型 = 现货 + 预付（**去重多选**）、**不拆单**。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { normalizeSalesResult } = require('../src/services/doubaoService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  itemTradeTypeCode, orderTradeTypeCodes, isPrepaidTradeType,
} = require('../src/config/salesTradeTypePolicy');
const { deliversForTradeType } = require('../src/config/salesMovements');
const { salesDeliverySummaryFor } = require('../src/config/salesDeliverySummary');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';
const SOURCE = '119 元，微信。\n卖了 31678，40 码。\n定制一双 6681-1，42 码，定金 50 元，下次付 39 元';

// 模型对上面那条原话的**期望输出**：两件各自的成交金额与**各自的交易类型**。
// （119 是现货那件的钱；6681-1 只付了定金 50、下次付 39 ⇒ 成交 89、预付。）
const SCENE_AI = {
  intent: 'sale',
  trade_type: '现货',
  items: [
    { item_no: '31678', color: '黑', size: 40, quantity: 1, actual_amount: 119, trade_type: '现货' },
    { item_no: '6681-1', color: '黑', size: 42, quantity: 1, trade_type: '预付' },
  ],
  payments: [{ amount: 119, method: '微信' }, { amount: 50, method: '微信' }],
};

// ── 假 Base：字段名一律走 schema（形状照 salesColorOptionsScope.test.js）──────────
const productRow = ({ recordId, itemNo, color, status = '在售' }) => ({
  record_id: recordId,
  fields: { 编号: `${itemNo}|${color}|B`, 货号: itemNo, 颜色: color, 货品状态: status },
});

// 一条实时库存记录 = 一双鞋（门盒 / 样品 / 仓库）。
const liveRow = ({ itemNo, color = '黑', size, state = '门盒', productRecordId }) => ({
  record_id: `live_${itemNo}_${color}_${size}_${state}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: state,
    编号: [{ id: productRecordId }],
    尺码: [`size_${size}`],
  },
});

const fakeBase = ({ products = [], liveInventory = [] } = {}) => {
  const records = new Map([
    ['product', products],
    ['liveInventory', liveInventory],
    ['behavior', [
      { record_id: 'bhv_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货销售' } },
      { record_id: 'bhv_unpaid', fields: { 行为编码: 'SALE_UNPAID', 行为名称: '未付销售' } },
      { record_id: 'bhv_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预付销售' } },
      { record_id: 'bhv_stock_sale', fields: {
        行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
      } },
    ]],
    ['paymentMethod', [
      { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
      { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
    ]],
    ['sizeManagement', [37, 38, 39, 40, 41, 42, 43, 44].map((size) => ({
      record_id: `size_${size}`, fields: { 尺码: size },
    }))],
  ]);
  const write = (key, values) => Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const field = V1_BITABLE_SCHEMA.tables[key]?.fields?.[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      return [field, value];
    }));
  const writes = [];
  let seq = 0;
  const gateway = {
    records,
    writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `${key}_${++seq}`;
      const fields = write(key, values);
      writes.push({ operation: 'create', tableKey: key, recordId, fields });
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      const fields = write(key, values);
      writes.push({ operation: 'update', tableKey: key, recordId: id, fields });
      if (record) Object.assign(record.fields, fields);
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};

const makeStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

// 走**真实链路**：真 gateway（假 Base）+ 真 V1ReferenceResolver + 真 V1PostingService
// （SalesOrderService）+ 真 SalesDeliveryService（真 InventoryService）。
// 只有"发卡片 / 发文字"两个出口打桩 —— 其余全是生产代码。
const runScene = async ({ taskId, text = SOURCE, ai, products = [], liveInventory = [] }) => {
  const store = makeStore('multi-line-sale-');
  const cards = [];
  const messages = [];
  const logs = [];
  const gateway = fakeBase({ products, liveInventory });
  const inventory = new InventoryService({
    gateway,
    // ⚠️ 库存引擎的本地任务记录用**自己的** id 字段（`operation_id`），不是 `task_id` ——
    //    传错会写成 "Task is missing task_id"，交付那一行直接失败。
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'multi-line-inventory-')), idField: 'operation_id',
    }),
  });
  const service = new LarkMvpService({
    client: {},
    gateway,
    store,
    delivery: new SalesDeliveryService({ gateway, inventory }),
    recognizer: { parseSalesText: async () => normalizeSalesResult(ai, text) },
  });
  const stockLookups = [];
  const resolveStock = service.resolveStockAvailabilityForSale.bind(service);
  service.resolveStockAvailabilityForSale = (input, index) => {
    stockLookups.push(input);
    return resolveStock(input, index);
  };
  service.sendTaskCard = async (task, card) => { cards.push({ messageId: task.message_id, card }); return 'om_card'; };
  service.sendTaskText = async (task, message) => { messages.push({ task, message }); return 'om_text'; };
  await store.create({ task_id: taskId, type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: `om_${taskId}`,
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: text });
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => { logs.push(String(line)); };
  console.warn = (line) => { logs.push(String(line)); };
  try {
    await service.processSalesTask(taskId);
    await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
      action: { value: { action: 'confirm_sale', draft_id: taskId } } });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return { service, store, gateway, cards, messages, logs, stockLookups, task: await store.get(taskId) };
};

const detailRows = (gateway) => gateway.records.get('salesDetail') || [];
const paymentRows = (gateway) => gateway.records.get('paymentRecord') || [];
const entryRows = (gateway) => gateway.records.get('salesEntry') || [];
const entryById = (gateway, id) => entryRows(gateway).find((row) => row.record_id === id);

// 她那条消息里两件的货品/库存：31678 有实物（现货那件），6681-1 没有（预付要调货）。
const SCENE_PRODUCTS = [
  productRow({ recordId: 'p_31678', itemNo: '31678', color: '黑' }),
  productRow({ recordId: 'p_6681', itemNo: '6681-1', color: '黑' }),
];
const SCENE_LIVE = [liveRow({ itemNo: '31678', color: '黑', size: 40, productRecordId: 'p_31678' })];

// ══════════════════════════════════════════════════════════════════════════════
// ① 她那条原话 → 一张单、2 条明细、3 条收款、主表交易类型去重多选
// ══════════════════════════════════════════════════════════════════════════════
test('AC-1~AC-10 她那条原话：一张单 · 2 条明细 · 3 条收款 · 主表交易类型多选（现货+预付）', async () => {
  const { gateway, task } = await runScene({
    taskId: 'scene_real', ai: SCENE_AI, products: SCENE_PRODUCTS, liveInventory: SCENE_LIVE,
  });

  // ── AC-10 错误 / 缺项为空：出的是确认卡片，不是"销售信息还缺…" ──
  assert.deepEqual(task.draft.missing_fields, [], `不许再有缺项：${JSON.stringify(task.draft.missing_fields)}`);
  assert.equal(task.status, 'posted');

  // ── AC-7 不拆单：整单只有**一条**销售主表记录 ──
  assert.equal(entryRows(gateway).length, 1, '这就是一个人买的 —— 不拆单');

  // ── AC-1 / AC-2 / AC-3 解析结果：两件各自的金额与类型 ──
  const draftItems = task.draft.items;
  assert.equal(draftItems.length, 2);
  assert.deepEqual(
    draftItems.map((item) => [item.item_no, item.size, item.actual_amount, item.trade_type, item.trade_type_code]),
    [
      ['31678', 40, 119, '现货', 'SALE_CASH'],
      ['6681-1', 42, 89, '预付', 'SALE_PREPAID'],
    ],
  );
  assert.equal(task.draft.agreed_total, 208, '整单成交额 = 各分项之和（119 + 89）');
  assert.equal(task.draft.owed, 39, '她明说的尾款是欠款');

  // ── AC-5 主表「交易类型」= 去重后的**多个**关联（现货 + 预付）──
  const entry = entryById(gateway, task.sales_entry_record_id);
  assert.deepEqual(entry.fields['交易类型'], ['bhv_cash', 'bhv_prepaid'],
    '主表：多种交易类型就多选（去重、按明细行顺序）');

  // ── AC-6 每一条明细行的交易类型**各自单选** ──
  const details = detailRows(gateway);
  assert.equal(details.length, 2);
  assert.deepEqual(details.map((row) => row.fields['交易类型']),
    [['bhv_cash'], ['bhv_prepaid']], '明细行：就这一单它是什么，那就是什么');

  // ── AC-4 收款 3 条：119 已收 / 50 已收 / 39 未收 ──
  assert.deepEqual(
    paymentRows(gateway).map((row) => [row.fields['收款金额'], row.fields['收款状态']]),
    [[119, '已收款'], [50, '已收款'], [39, '未收款']],
  );

  // ── AC-2 / AC-3 金额口径：总额 = 各分项之和，且 已收 + 欠款 对得上 ──
  assert.equal(details.reduce((sum, row) => sum + row.fields['成交金额'], 0), 208);
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 现货件被交付 + 扣库存；预付件不交付（逐条断言）
// ══════════════════════════════════════════════════════════════════════════════
test('AC-8/AC-9 现货件交付并扣库存、预付件不交付（逐条）', async () => {
  const { gateway } = await runScene({
    taskId: 'scene_delivery', ai: SCENE_AI, products: SCENE_PRODUCTS, liveInventory: SCENE_LIVE,
  });

  const details = detailRows(gateway);
  assert.deepEqual(details.map((row) => row.fields['履约状态']), ['已交付', '未交付'],
    '现货那件交付了；预付那件还是未交付（她下次来取）');

  // 库存流水：只有现货那一件产生了扣减（预付不查库存、不扣库存）。
  const ledger = gateway.records.get('inventoryLedger') || [];
  assert.equal(ledger.length, 1, '只有现货件扣了库存');
  assert.deepEqual(ledger[0].fields['关联销售'], [details[0].record_id]);
  assert.equal(ledger[0].fields['变动数量'], 1);

  // 事实表：门盒那双鞋被卖掉了（预付那件本来就没有实物，不受影响）。
  const live = gateway.records.get('liveInventory') || [];
  assert.deepEqual(live.map((row) => row.record_id), [], '31678 40码 门盒那唯一一双被扣掉');
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ 判据粒度：跑不跑 B（实时库存）**按明细行**，不再按整单
// ══════════════════════════════════════════════════════════════════════════════
test('AC-14 一张混合单里：现货件查库存、预付件一次都不查（逐明细的判据）', async () => {
  const { stockLookups } = await runScene({
    taskId: 'scene_parse_gate', ai: SCENE_AI, products: SCENE_PRODUCTS, liveInventory: SCENE_LIVE,
  });
  assert.deepEqual(stockLookups.map((input) => input.itemNo), ['31678'],
    'B 只对现货那件跑过；预付那件不跑（货要调，没货是常态）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ 「定金单只支持一条明细」这条判据确实被放开
// ══════════════════════════════════════════════════════════════════════════════
test('AC-11 原报错串在源码里已经不存在（判据被放开，不是被绕过）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/doubaoService.js'), 'utf8');
  assert.ok(!source.includes('定金单暂只支持一条明细'),
    '那条整单护栏必须已经删除（多明细 + 定金 不再是缺项）');
  // 但「说不清哪一件是预付」这条**新的、可补的**判据必须还在（绝不猜）。
  const { SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS } = require('../src/config/salesTradeTypePolicy');
  assert.ok(source.includes('SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS'));
  assert.ok(SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS.length > 0);
});

test('AC-11b 真机原话解析后，缺项里没有那条旧报错（也不再报缺项）', () => {
  const parsed = normalizeSalesResult(SCENE_AI, SOURCE);
  assert.deepEqual(parsed.missing_fields, []);
  assert.ok(!parsed.missing_fields.some((field) => field.includes('定金单暂只支持一条明细')));
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑤ 单类型单「逐字不变」哨兵（三种各一条）
// ══════════════════════════════════════════════════════════════════════════════
const singleLineAi = (tradeType, extra = {}) => ({
  intent: 'sale', trade_type: tradeType,
  items: [{ item_no: '31678', color: '黑', size: 40, quantity: 1, ...extra }],
  payments: [{ amount: 119, method: '微信' }],
  agreed_total: 119,
});

for (const [tradeType, expectedCode, expectedDetail] of [
  ['现货', 'SALE_CASH', '已交付'],
  ['未付', 'SALE_UNPAID', '已交付'],
  ['预付', 'SALE_PREPAID', '未交付'],
]) {
  test(`AC-12 单类型单（只有${tradeType}）逐字不变：一个类型、一条明细、交付口径不变`, async () => {
    const { gateway, task } = await runScene({
      taskId: `sentinel_${expectedCode}`,
      text: `31678 40码，119元微信`,
      ai: singleLineAi(tradeType),
      products: SCENE_PRODUCTS,
      liveInventory: SCENE_LIVE,
    });
    // 整单仍然只有**一个**类型（"多选"没有把单选也变成两个）。
    assert.deepEqual(task.draft.trade_type_codes, [expectedCode]);
    const entry = entryById(gateway, task.sales_entry_record_id);
    assert.deepEqual(entry.fields['交易类型'], [expectedCode === 'SALE_CASH' ? 'bhv_cash'
      : expectedCode === 'SALE_UNPAID' ? 'bhv_unpaid' : 'bhv_prepaid']);
    const details = detailRows(gateway);
    assert.equal(details.length, 1);
    assert.equal(details[0].fields['交易类型'].length, 1, '明细行永远是单选');
    assert.equal(details[0].fields['履约状态'], expectedDetail);
  });
}

test('AC-12b 判据取值：单类型单下 itemTradeTypeCode / orderTradeTypeCodes 与旧口径逐字相同', () => {
  for (const [label, code] of [['现货', 'SALE_CASH'], ['未付', 'SALE_UNPAID'], ['预付', 'SALE_PREPAID']]) {
    // 老形状（只有整单 label、明细不带类型）→ 每一行都取整单那个值。
    const items = [{ item_no: 'A' }, { item_no: 'B' }];
    assert.deepEqual(orderTradeTypeCodes(items, code), [code], `${label}：整单去重后仍是一个`);
    assert.equal(itemTradeTypeCode(items[0], code), code);
    // 认不出来 → 空串（不兜成现货：那是既有行为，主表关联不写）。
    assert.equal(itemTradeTypeCode({}, ''), '');
    assert.deepEqual(orderTradeTypeCodes([{}], ''), ['']);
    assert.equal(deliversForTradeType(''), true, '认不出 → 仍然交付（既有兜底）');
  }
  assert.equal(isPrepaidTradeType('SALE_PREPAID'), true);
  assert.equal(isPrepaidTradeType('SALE_CASH'), false);
});

test('AC-12c 交付结果那句话：单类型单读到的仍是改动前那两句（逐字）', () => {
  assert.equal(salesDeliverySummaryFor(1, 1).card, '已交付并扣库存。');
  assert.equal(salesDeliverySummaryFor(1, 1).toast, '销售已确认并交付，库存已更新');
  assert.equal(salesDeliverySummaryFor(0, 1).card, '尚未交付，库存未扣减。');
  assert.equal(salesDeliverySummaryFor(0, 1).toast, '销售已确认；预付单尚未交付，库存未扣减');
  // 混合单才有中间那一档。
  assert.equal(salesDeliverySummaryFor(1, 2).card, '部分明细已交付并扣库存，预付明细尚未交付。');
});
