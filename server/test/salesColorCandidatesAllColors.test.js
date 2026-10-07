// 颜色候选 = **全部颜色** + 「有货 / 无货」标注 = 现货 / 预定的预告（2026-10-07 口径大改）。
//
// 业务负责人的三步流程（逐字）：
//   「1. 货品信息还是要先查这个货品有没有、信息全不全
//    2. 这里要给到**全色**，让用户去选
//    3. 用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」
// ⇒ ① 候选**不再按「在售 / 下架」过滤**（原 `colorOptionsScope` / 全下架拦截已整体删除）；
//    ② 「有货 / 无货」标注保留 —— 它现在直接预告这一双会记成现货还是预定；
//    ③ 她选完之后那一次**实时库存**查询**就是类型判据**（有货 → 现货；没货 → 预定）。
//
// ⚠️ 本文件**不注入假的 references**：走真实的 `V1ReferenceResolver`（= 真机链路），
//    因为「货品状态」「颜色候选」都是真表上读出来的。
//
// 验收标准见 `docs/sales-type-by-stock-2026-10-07.md`（AC-1 / AC-2）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeSalesResult } = require('../src/services/doubaoService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';

// ── 假 Base（形状照 `salesPrepaidColorResolution.test.js`：字段名走 schema）──
const fakeBase = ({ products = [], liveInventory = [] } = {}) => {
  const records = new Map([
    ['product', products],
    ['liveInventory', liveInventory],
    ['behavior', [
      { record_id: 'bhv_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
      { record_id: 'bhv_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } },
    ]],
    ['paymentMethod', [
      { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
      { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
    ]],
    ['sizeManagement', [37, 38, 39, 40].map((size) => ({
      record_id: `size_${size}`, fields: { 尺码: size },
    }))],
    ['salesEntry', [{ record_id: 'order_1', fields: {} }]],
  ]);
  const write = (key, values) => Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const field = V1_BITABLE_SCHEMA.tables[key]?.fields?.[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      return [field, value];
    }));
  // 远端读计数：候选这条路**不许**因为口径变化多读任何一张表。
  const reads = { product: 0, liveInventory: 0, total: 0 };
  let seq = 0;
  const gateway = {
    reads,
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => {
      reads.total += 1;
      if (key in reads) reads[key] += 1;
      return records.get(key) || [];
    },
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `${key}_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: write(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      if (record) Object.assign(record.fields, write(key, values));
      return record;
    },
  };
  return gateway;
};

const productRow = ({ recordId, itemNo, color, status = '在售' }) => ({
  record_id: recordId,
  fields: { 编号: `${itemNo}|${color}|B`, 货号: itemNo, 颜色: color, 货品状态: status },
});

const liveRow = ({ itemNo, color, size, state = '门盒', productRecordId }) => ({
  record_id: `live_${itemNo}_${color}_${size}_${state}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: state,
    编号: [{ id: productRecordId }],
    尺码: [`size_${size}`],
  },
});

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'color-all-')), idField: 'task_id' });

const runSale = async ({ taskId, text, parsed, products = [], liveInventory = [] }) => {
  const store = makeStore();
  const cards = [];
  const messages = [];
  const logs = [];
  const gateway = fakeBase({ products, liveInventory });
  const service = new LarkMvpService({
    client: {},
    gateway,
    recognizer: { parseSalesText: async () => normalizeSalesResult(parsed, text) },
    store,
  });
  const stockLookups = [];
  const resolveStock = service.resolveStockAvailabilityForSale.bind(service);
  service.resolveStockAvailabilityForSale = (input, index) => {
    stockLookups.push(input);
    return resolveStock(input, index);
  };
  service.sendTaskCard = async (task, card) => { cards.push({ messageId: task.message_id, card }); return 'om_card'; };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  await store.create({ task_id: taskId, type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: `om_${taskId}`,
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: text });
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => { logs.push(String(line)); };
  console.warn = (line) => { logs.push(String(line)); };
  try {
    await service.processSalesTask(taskId);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return { service, store, gateway, cards, messages, logs, stockLookups, task: await store.get(taskId) };
};

const chooseColor = (service, taskId, { itemIndex = 0, recordId, colorName, productNumber }) =>
  service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'choose_sale_color', draft_id: taskId, item_index: itemIndex,
      record_id: recordId, color_name: colorName, product_number: productNumber } },
  });

// 解析层给的 `trade_type` 现在只是**她嘴上的性质**（提示），不再是类型判据。
const itemLine = (itemNo, tradeType, { payments = [], owed } = {}) => ({
  intent: 'sale', trade_type: tradeType,
  items: [{ item_no: itemNo, color: '', size: 37, quantity: 1, actual_amount: 228 }],
  payments, ...(owed === undefined ? {} : { owed }), agreed_total: 228, missing_fields: [],
});

// 在**捕获日志**的情况下跑一段（选颜色发生在 runSale 之外，日志要单独收）。
const captureLogs = async (fn) => {
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => { logs.push(String(line)); };
  console.warn = (line) => { logs.push(String(line)); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return logs;
};

const jsonLogs = (logs) => logs
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const CASH = (itemNo = 'B26002-52') => itemLine(itemNo, '现货', { payments: [{ amount: 228, method: '微信' }] });

const BLACK = 'p_black';
const CHOCO = 'p_choco';
const ON_SALE_BLACK = productRow({ recordId: BLACK, itemNo: 'B26002-52', color: '黑色' });
const OFF_SHELF_CHOCO = productRow({ recordId: CHOCO, itemNo: 'B26002-52', color: '巧克力', status: '下架' });
const MIXED_PRODUCTS = [OFF_SHELF_CHOCO, ON_SALE_BLACK];
const BOTH_IN_STOCK = [
  liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK }),
  liveRow({ itemNo: 'B26002-52', color: '巧克力', size: 37, productRecordId: CHOCO }),
];

// ── ① 候选 = 全部颜色（撤掉"只推在售"）────────────────────────────────────
test('① 一个在售 + 一个下架 → **两个颜色都出候选**（不再按在售过滤）；照标「有货 / 无货」', async () => {
  const { task, cards, stockLookups } = await runSale({
    taskId: 'all_colors', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });

  const item = task.draft.items[0];
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(item.needs_color, true);
  assert.deepEqual(item.color_options.map((option) => option.color).sort(), ['巧克力', '黑色'],
    '下架的颜色也要给她（预定 = 没货，过滤掉就没法选到没货的那双）');
  assert.deepEqual(item.color_options.map((option) => option.stock_status), ['available', 'available']);
  // 状态仍然跟着候选一起回来（trace 用；它**不再**决定候选）。
  assert.deepEqual(item.color_options.map((option) => option.status).sort(), ['下架', '在售']);

  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /黑色（有货）/);
  assert.match(cardText, /巧克力（有货）/);
  // 她还没选颜色 ⇒ B 一次都不跑（这一条口径没变）。
  assert.deepEqual(stockLookups, [], '选颜色之前 B 不许跑');
  // 这时类型**还没定**（空串）。
  assert.equal(item.trade_type_code, '', '没查库存之前不许替她定类型');
  assert.equal(item.trade_type, '');
});

test('①b 「货品状态」读不到（空串）→ 候选照旧全部保留（空 ≠ 下架）', async () => {
  const { task } = await runSale({
    taskId: 'status_blank', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [
      productRow({ recordId: BLACK, itemNo: 'B26002-52', color: '黑色', status: '' }),
      productRow({ recordId: CHOCO, itemNo: 'B26002-52', color: '巧克力', status: '' }),
    ],
    liveInventory: BOTH_IN_STOCK,
  });
  assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color).sort(),
    ['巧克力', '黑色']);
});

// ── ② 全都没货：候选照旧全部列出、全部标「无货」；选了就记预定（AC-2.4 + AC-1.2/1.3）──
test('② 全部颜色都没货 → 全部候选 + 全部标「无货」；她选了其中一个 → 记**预定**（不交付、不拦单）', async () => {
  const { service, store, gateway, cards, messages, task } = await runSale({
    taskId: 'all_out', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: [], // 这个尺码一双都没有
  });

  const item = task.draft.items[0];
  assert.equal(task.status, 'ready_to_confirm', '没货不再是缺项 —— 照出卡片');
  assert.deepEqual(task.draft.missing_fields, []);
  assert.deepEqual(item.color_options.map((option) => option.stock_status), ['unavailable', 'unavailable']);
  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /黑色（无货）/);
  assert.match(cardText, /巧克力（无货）/);
  assert.deepEqual(messages, [], '不再有"库存里没有…请核实"那种拦截');

  // 她点了「黑色」——实时库存里没有 ⇒ **预定**。
  const chosen = await chooseColor(service, 'all_out', {
    recordId: BLACK, colorName: '黑色', productNumber: 'B26002-52黑色' });
  assert.equal(chosen.toast.type, 'success', '没货不是错误：照常把颜色定下来、记成预定');
  const settled = await store.get('all_out');
  const settledItem = settled.draft.items[0];
  assert.equal(settledItem.product_record_id, BLACK, '货品记录以她选中的那条候选为准');
  assert.equal(settledItem.color, '黑色');
  assert.equal(settledItem.needs_color, false);
  assert.equal(settledItem.trade_type_code, 'SALE_PREPAID');
  assert.equal(settledItem.trade_type, '预定');
  assert.equal(settled.status, 'ready_to_confirm');
});

test('②b 判据是库存：**同样输入**、库里只有「黑色」→ 选黑色 = 现货，选巧克力 = 预定', async () => {
  const onlyBlack = [liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK })];
  const chose = async (taskId, recordId, colorName) => {
    const run = await runSale({
      taskId, text: 'B26002-52 37 码，228 元微信',
      parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: onlyBlack,
    });
    assert.equal(run.task.draft.items[0].trade_type_code, '', '录单阶段类型未定');
    await chooseColor(run.service, taskId, { recordId, colorName });
    return (await run.store.get(taskId)).draft.items[0];
  };
  const cash = await chose('pick_in', BLACK, '黑色');
  assert.equal(cash.trade_type_code, 'SALE_CASH', '库存里有 → 现货');
  assert.equal(cash.trade_type, '现货');
  assert.deepEqual(cash.stock, { doorBox: 1, sample: 0, warehouse: 0 });

  const prepaid = await chose('pick_out', CHOCO, '巧克力');
  assert.equal(prepaid.trade_type_code, 'SALE_PREPAID', '库存里没有 → 预定');
  assert.equal(prepaid.trade_type, '预定');
  assert.equal(prepaid.stock, undefined, '预定不占库存，不写库存分布');
});

test('②c 类型结论来自库存（正向证据日志 `lark.sales.trade_type.decided`）', async () => {
  const { service } = await runSale({
    taskId: 'decided_log', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });
  const logs = await captureLogs(() =>
    chooseColor(service, 'decided_log', { recordId: CHOCO, colorName: '巧克力' }));
  const decided = jsonLogs(logs).filter((entry) => entry.event === 'lark.sales.trade_type.decided');
  assert.ok(decided.length >= 1, '每一次定类型都要留下正向证据');
  const last = decided.at(-1);
  assert.equal(last.judged_by, 'realtime_stock');
  assert.equal(last.in_stock, true);
  assert.equal(last.trade_type_code, 'SALE_CASH');
  assert.equal(last.step, 'color_chosen');
});

// ── ③ 全下架（原来的"候选被过滤空"那条路）已彻底退场 ────────────────────────
test('③ 全部颜色都是「下架」→ 仍然出全部候选、**不再拦**、不再有"都下架了"那句话', async () => {
  const { task, cards, messages, logs } = await runSale({
    taskId: 'all_off_shelf', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [
      productRow({ recordId: BLACK, itemNo: 'B26002-52', color: '黑色', status: '下架' }),
      productRow({ recordId: CHOCO, itemNo: 'B26002-52', color: '巧克力', status: '下架' }),
    ],
    liveInventory: BOTH_IN_STOCK,
  });
  assert.equal(task.status, 'ready_to_confirm');
  assert.deepEqual(task.draft.missing_fields, []);
  assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color).sort(),
    ['巧克力', '黑色']);
  assert.deepEqual(messages, []);
  assert.match(JSON.stringify(cards[0].card), /choose_sale_color/);
  // 老的两条日志 / 配置随"过滤"一起退场：一条都不许再出现。
  const events = jsonLogs(logs).map((entry) => entry.event);
  assert.ok(!events.includes('lark.sales.color_options.filtered'));
  assert.ok(!events.includes('lark.sales.stock_existence.skipped'));
});

// ── ④ 零新增远端请求：候选两个 / 一个 / 全没货，读表次数完全一样 ──────────────
test('④ 候选给全部颜色没有多读任何一张表（货品信息 2 次、实时库存 1 次，与原来一致）', async () => {
  const both = await runSale({
    taskId: 'reads_both', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });
  const none = await runSale({
    taskId: 'reads_none', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: [],
  });
  assert.deepEqual({ ...none.gateway.reads }, { ...both.gateway.reads });
  assert.equal(both.gateway.reads.product, 2);
  assert.equal(both.gateway.reads.liveInventory, 1);
});

// ── ⑤ 不再有"按交易类型决定候选范围"的配置（撤掉 #230 的证据）───────────────
test('⑤ 候选范围那套配置 / 方法已整体退场（`colorOptionsScope` 不许再加回来）', () => {
  const policy = require('../src/config/salesTradeTypePolicy');
  assert.equal(policy.SALES_COLOR_OPTIONS_SCOPE, undefined);
  assert.equal(policy.salesColorOptionsScopeFor, undefined);
  const colorChoice = require('../src/config/salesColorChoice');
  assert.equal(colorChoice.SALES_PRODUCT_STATUS_OFF_SHELF, undefined);
  assert.equal(colorChoice.SALES_COLOR_SCOPE_EMPTY_TEXT, undefined);
  assert.equal(colorChoice.formatColorOptionsScopeEmptyText, undefined);
  const service = new LarkMvpService({ client: {}, gateway: {}, store: {}, recognizer: {} });
  assert.equal(service.colorOptionsInScope, undefined, '过滤方法本身也不该还在');
});
