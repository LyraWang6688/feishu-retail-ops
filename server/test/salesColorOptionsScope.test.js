// 「颜色候选推哪些」按**交易类型**配置（第四刀，业务负责人 2026-10-07 逐字）：
//   「现货和未付是需要看在售的颜色，但是**预付是需要看这个货号的颜色**，
//     还是要配置先行，要模块化进行设置～」
//
// ⇒ 现货 / 未付：候选**只推在售**（明确标成「下架」的颜色不进候选）；
//    预付：候选**不按在售过滤**（预付卖的就是没货、要调货的那一双）。
//
// ⚠️ 本文件与 `salesPrepaidColorResolution.test.js` 同一套路：**不注入假的 references**，
//    走**真实的 `V1ReferenceResolver`**（= 真机链路）—— 「货品状态」是「货品信息」
//    那条记录上的**真字段**，只有走真 resolver 才测得到"谁给候选、谁带状态"。
//
// 验收标准（先写、后做、逐条对照）见 `docs/sales-color-candidate-scope-2026-10-07.md`。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeSalesResult } = require('../src/services/doubaoService');
const {
  salesColorOptionsScopeFor,
  SALES_COLOR_OPTIONS_SCOPE,
  SALES_PARSE_POLICY_DEFAULT,
} = require('../src/config/salesTradeTypePolicy');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';

// ── 假 Base（形状照 `salesPrepaidColorResolution.test.js`：字段名走 schema）──
const fakeBase = ({ products = [], liveInventory = [], productIndexRows = null } = {}) => {
  const records = new Map([
    ['product', products],
    ['liveInventory', liveInventory],
    ['behavior', [
      { record_id: 'bhv_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货销售' } },
      { record_id: 'bhv_unpaid', fields: { 行为编码: 'SALE_UNPAID', 行为名称: '未付销售' } },
      { record_id: 'bhv_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预付销售' } },
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
  // ⭐ 远端读计数：过滤**不许**新增任何一次读表 —— 这里把它数出来当证据。
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
      // 产品索引那条路（`productIndexRows` 传了才有）与解析 A 走的是同一个键。
      if (key === 'product' && productIndexRows) return productIndexRows;
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

// 「货品信息」里的一行：**带上「货品状态」**（飞书公式：在售 / 下架）——生产表就是这么一列。
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
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'color-scope-')), idField: 'task_id' });

// 走真实链路：真 gateway（假 Base）+ 真 `V1ReferenceResolver`（不注入替身）。
// `rawParsed=true`：解析结果**原样**交给服务（不经过 `normalizeSalesResult` 的归一化），
// 用来构造"服务拿到一个映射不到编码的交易类型"这条边界。
const runSale = async ({
  taskId, text, parsed, products = [], liveInventory = [], productIndexRows = null, rawParsed = false,
}) => {
  const store = makeStore();
  const cards = [];
  const messages = [];
  const logs = [];
  const gateway = fakeBase({ products, liveInventory, productIndexRows });
  const service = new LarkMvpService({
    client: {},
    gateway,
    recognizer: { parseSalesText: async () => (rawParsed ? parsed : normalizeSalesResult(parsed, text)) },
    store,
  });
  // B（库存可得性）被调用了几次、每次的输入是什么 —— "选色之前一次都不跑" / "候选空了不跑"
  // 这两条都靠它当证据。
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

const itemLine = (itemNo, tradeType, { payments = [], owed } = {}) => ({
  intent: 'sale', trade_type: tradeType,
  items: [{ item_no: itemNo, color: '', size: 37, quantity: 1, actual_amount: 228 }],
  payments, ...(owed === undefined ? {} : { owed }), agreed_total: 228, missing_fields: [],
});

const jsonLogs = (logs) => logs
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const CASH = (itemNo = 'B26002-52') => itemLine(itemNo, '现货', { payments: [{ amount: 228, method: '微信' }] });
const UNPAID = (itemNo = 'B26002-52') => itemLine(itemNo, '未付', { owed: 228 });
const PREPAID = (itemNo = 'B26002-52') => itemLine(itemNo, '预付',
  { payments: [{ amount: 100, method: '微信' }], owed: 128 });

// 一个货号两个颜色：黑色**在售**、巧克力**下架**（她的口径：下架 = 实时库存数量 0）。
const ON_SALE_BLACK = productRow({ recordId: 'p_black', itemNo: 'B26002-52', color: '黑色' });
const OFF_SHELF_CHOCO = productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力', status: '下架' });
const MIXED_PRODUCTS = [OFF_SHELF_CHOCO, ON_SALE_BLACK];
// 实时库存里两个颜色都还有实物 —— 专门用来证明"过滤掉的颜色不会被 B 重新捞回来"。
const BOTH_IN_STOCK = [
  liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: 'p_black' }),
  liveRow({ itemNo: 'B26002-52', color: '巧克力', size: 37, productRecordId: 'p_choco' }),
];

// ── ① 现货：下架色不进候选 ────────────────────────────────────────────────
test('① 现货 + 一在售一下架 → 候选里只有「在售」那个颜色；下架色不出现（卡片上也没有）', async () => {
  const { task, cards, stockLookups, gateway, logs } = await runSale({
    taskId: 'cash_scope', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });

  const item = task.draft.items[0];
  assert.equal(task.status, 'ready_to_confirm');
  assert.equal(item.needs_color, true);
  assert.deepEqual(item.color_options.map((option) => option.color), ['黑色'],
    '下架（巧克力）不许出现在候选里');
  // 候选仍然带「这个尺码有没有货」的标注（第五刀的口径不变）。
  assert.deepEqual(item.color_options.map((option) => option.stock_status), ['available']);
  // 状态跟着候选一起回来了（不是过滤完就丢）—— 排查"为什么没给我这个颜色"看得见。
  assert.deepEqual(item.color_options.map((option) => option.status), ['在售']);

  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /黑色（有货）/);
  assert.doesNotMatch(cardText, /巧克力/);
  assert.match(cardText, /choose_sale_color/);

  // 她还没选颜色 ⇒ B 一次都不跑（第三刀的口径不变）。
  assert.deepEqual(stockLookups, [], '选颜色之前 B 不许跑');
  // 过滤**零新增远端请求**：这里只读 2 次「货品信息」（解析 A + 建档索引，都是**既有的**读）
  // 与 1 次「实时库存」（既有的并行预读）。**强证据**在 ⑩（丢掉的颜色数不同、读表次数相同）。
  assert.equal(gateway.reads.product, 2);
  assert.equal(gateway.reads.liveInventory, 1);

  // ⭐ 正向证据日志：为什么没给我「巧克力」—— 看这条。
  const filtered = jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered');
  assert.ok(filtered, '过滤必须留下一条正向证据日志');
  assert.deepEqual({
    trade_type_code: filtered.trade_type_code,
    item_no: filtered.item_no,
    size: filtered.size,
    scope: filtered.scope,
    kept: filtered.kept,
    dropped: filtered.dropped,
    dropped_colors: filtered.dropped_colors,
  }, {
    trade_type_code: 'SALE_CASH', item_no: 'B26002-52', size: 37,
    scope: 'inStockOnly', kept: 1, dropped: 1, dropped_colors: ['巧克力'],
  });
  assert.ok(filtered.task_id, '日志要带 task_id（写入类 / 排查类日志的关联键）');
});

// ── ② 未付：同一条口径（同样输入）────────────────────────────────────────
test('② 未付 + 同样输入 → 与现货一致：下架色不出现', async () => {
  const { task, cards } = await runSale({
    taskId: 'unpaid_scope', text: 'B26002-52 37 码，228 元未付',
    parsed: UNPAID(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });
  assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color), ['黑色']);
  assert.doesNotMatch(JSON.stringify(cards[0].card), /巧克力/);
});

// ── ③ 预付：同样输入 → 全部颜色都在（不按在售过滤）─────────────────────────
test('③ 预付 + 同样输入 → 两个颜色都在候选里（不按在售过滤）；照旧不标「有货 / 无货」', async () => {
  const { task, cards, stockLookups, logs } = await runSale({
    taskId: 'prepaid_scope', text: 'B26002-52 37 码，定金微信 100，下次欠 128',
    parsed: PREPAID(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });

  const item = task.draft.items[0];
  assert.deepEqual(item.color_options.map((option) => option.color).sort(), ['巧克力', '黑色'],
    '预付要看到这个货号的**全部**颜色（含下架那个：预付卖的就是没货的）');
  assert.deepEqual(item.color_options.map((option) => option.stock_status), [undefined, undefined],
    '预付不跑 B ⇒ 候选上不带库存状态');
  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /黑色/);
  assert.match(cardText, /巧克力/);
  assert.doesNotMatch(cardText, /（有货）|（无货）/);
  assert.deepEqual(stockLookups, [], '预付不跑 B（既有口径）');
  assert.equal(jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered'),
    undefined, '不过滤就不记过滤日志（避免噪音：没丢任何颜色）');
});

// ── ④ 单颜色（且下架）：保持既有行为 ─────────────────────────────────────
test('④ 单颜色 + 它「下架」→ 保持既有行为：直接定下来、不摆候选、也不因此拦单', async () => {
  const { task, cards, stockLookups, logs } = await runSale({
    taskId: 'cash_single_off_shelf', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力', status: '下架' })],
    liveInventory: [liveRow({ itemNo: 'B26002-52', color: '巧克力', size: 37, productRecordId: 'p_choco' })],
  });

  const item = task.draft.items[0];
  assert.equal(item.product_record_id, 'p_choco', '单色直接定下来（与改动前逐字一致）');
  assert.equal(item.color, '巧克力');
  assert.ok(!item.needs_color, '不因为她没选颜色而多出一步');
  assert.equal(task.status, 'ready_to_confirm', '"下架"这一条**不在**本刀要拦的范围内（单色不走候选）');
  assert.equal(cards.length, 1);
  // 过滤只发生在候选这条路上：单色路径不记过滤日志。
  assert.equal(jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered'), undefined);
  // 单色 ⇒ A 直接定颜色，B 照旧跑一次（拿这个颜色去查）。
  assert.deepEqual(stockLookups.map((input) => input.color), ['巧克力']);
});

// ── ⑤ 多颜色全下架：过滤后候选为空 ───────────────────────────────────────
test('⑤ 多颜色**全下架** → 候选为空：回可配文案（needs_info），不出卡片、不跑 B、不把下架色捞回来', async () => {
  const { task, cards, messages, stockLookups, gateway, logs } = await runSale({
    taskId: 'cash_all_off_shelf', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [
      productRow({ recordId: 'p_black', itemNo: 'B26002-52', color: '黑色', status: '下架' }),
      productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力', status: '下架' }),
    ],
    // ⚠️ 故意的对抗 fixture：实时库存里**还有**这两条记录。若候选空了还去跑 B，
    //    B 就会把刚过滤掉的颜色重新摆回候选（甚至标成"有货"）——那正是要防的事。
    liveInventory: BOTH_IN_STOCK,
  });

  assert.equal(task.status, 'needs_info', '不许静默什么都不给她');
  assert.deepEqual(cards, [], '不出确认卡片（她没有颜色可选）');
  assert.deepEqual(stockLookups, [], '候选空了不跑 B（否则会把下架色捞回来 / 回一句与原因无关的话）');
  assert.equal(task.draft.items[0].color_options, undefined);
  assert.deepEqual(messages,
    ['货品信息里 B26002-52 的颜色都下架了，没有在售的颜色可选，请核实～'],
    '她看到的是那句**唯一可见的解释**（不是"销售信息还缺…请重新发送"那层套话）');
  assert.ok(task.draft.missing_fields.includes(
    '货品信息里 B26002-52 的颜色都下架了，没有在售的颜色可选，请核实～'));

  const filtered = jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered');
  assert.equal(filtered.dropped, 2);
  assert.deepEqual(filtered.dropped_colors.sort(), ['巧克力', '黑色']);
  assert.equal(filtered.kept, 0);
  // 为什么没查库存：不是"交易类型不查"，而是"候选空了"。
  const skipped = jsonLogs(logs).find((entry) => entry.event === 'lark.sales.stock_existence.skipped');
  assert.equal(skipped.reason, 'color_options_out_of_scope');
  // 读表次数与"有候选"那单**完全一样**（2 次货品信息 / 1 次实时库存都是**录单本来就有的**读：
  // 解析 A + 建档索引 + 实时库存并行预读）—— 候选空了**没有**多读、也没有少读。
  assert.equal(gateway.reads.product, 2);
  assert.equal(gateway.reads.liveInventory, 1);
});

// ── ⑥ 配置认不出来 → 取最保守的默认 ─────────────────────────────────────
test('⑥ 认不出的交易类型编码 → 候选范围取默认 `inStockOnly`（与现货 / 未付同档）', () => {
  assert.equal(salesColorOptionsScopeFor('SALE_CASH'), SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
  assert.equal(salesColorOptionsScopeFor('SALE_UNPAID'), SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
  assert.equal(salesColorOptionsScopeFor('SALE_PREPAID'), SALES_COLOR_OPTIONS_SCOPE.allColors);
  // 空编码 / 没见过的编码 → 默认（最保守的那一档：宁可只推在售）。
  assert.equal(salesColorOptionsScopeFor(''), SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
  assert.equal(salesColorOptionsScopeFor(undefined), SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
  assert.equal(salesColorOptionsScopeFor('SALE_WHATEVER'), SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
  assert.equal(SALES_PARSE_POLICY_DEFAULT.colorOptionsScope, SALES_COLOR_OPTIONS_SCOPE.inStockOnly);
});

test('⑥b 端到端：服务拿到一个映射不到编码的交易类型 → 按默认 `inStockOnly` 过滤（下架色同样不出现）', async () => {
  // ⚠️ 生产上 AI 的解析结果会先过 `normalizeSalesResult`（它把认不出的类型收敛成「现货」），
  //    所以这条边界走**服务层**：解析结果原样交给服务，交易类型编码为空 ⇒ 走默认策略。
  const { task, logs } = await runSale({
    taskId: 'unknown_trade_type', text: 'B26002-52 37 码，228 元',
    parsed: itemLine('B26002-52', '以旧换新', { payments: [{ amount: 228, method: '微信' }] }),
    products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK, rawParsed: true,
  });
  assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color), ['黑色']);
  const filtered = jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered');
  assert.equal(filtered.trade_type_code, '', '认不出的类型 → 编码为空');
  assert.equal(filtered.scope, 'inStockOnly', '编码为空 → 默认档（最保守：只推在售）');
});

// ── ⑦ 状态读不到：不下"下架"的结论（不许把"没有证据"当负向证据）──────────
test('⑦ 「货品状态」读不到（空串）→ 候选**保留**（空 ≠ 下架；由选完颜色之后的 B 给结论）', async () => {
  const { task, logs } = await runSale({
    taskId: 'cash_status_blank', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [
      productRow({ recordId: 'p_black', itemNo: 'B26002-52', color: '黑色', status: '' }),
      productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力', status: '' }),
    ],
    liveInventory: BOTH_IN_STOCK,
  });
  assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color).sort(),
    ['巧克力', '黑色'], '状态读不到时保留候选（否则"飞书抖了一下"会变成"没有在售颜色"）');
  const filtered = jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered');
  assert.equal(filtered.kept, 2);
  assert.equal(filtered.dropped, 0);
});

// ── ⑧ 过滤是纯本地操作：零远端请求 ───────────────────────────────────────
test('⑧ `colorOptionsInScope` 是纯函数：gateway 任何一个调用都会当场炸，它照样能过滤', () => {
  const exploding = new Proxy({}, {
    get: () => { throw new Error('过滤不许碰 gateway / 不许读表'); },
  });
  // 构造时要用一个安分的 gateway（构造器会把别的 service 接上），构造完再换成"一碰就炸"的。
  const service = new LarkMvpService({ client: {}, gateway: {}, store: {}, recognizer: {} });
  service.gateway = exploding;
  const options = [
    { recordId: 'a', color: '黑', number: 'X黑', status: '在售' },
    { recordId: 'b', color: '白', number: 'X白', status: '下架' },
    { recordId: 'c', color: '灰', number: 'X灰', status: '' },
  ];
  const { kept, dropped } = service.colorOptionsInScope({ options, scope: SALES_COLOR_OPTIONS_SCOPE.inStockOnly });
  assert.deepEqual(kept.map((option) => option.color), ['黑', '灰']);
  assert.deepEqual(dropped.map((option) => option.color), ['白'], '丢掉的也要回给调用方（日志要用）');
  // 副本：不许改调用方传进来的数组 / 元素。
  assert.notEqual(kept[0], options[0]);
  // 预付那档：原样（不过滤）。
  const all = service.colorOptionsInScope({ options, scope: SALES_COLOR_OPTIONS_SCOPE.allColors });
  assert.deepEqual(all.kept.map((option) => option.color), ['黑', '白', '灰']);
  assert.deepEqual(all.dropped, []);
});

// ── ⑩ 零新增远端请求（对照证据）──────────────────────────────────────────
test('⑩ 丢 0 个 / 丢 1 个 / 全丢 —— 三种情况读「货品信息」「实时库存」的次数**完全一样**', async () => {
  const runs = {};
  // 两个颜色都在售：过滤跑过、但一个都没丢。
  runs.keptAll = await runSale({
    taskId: 'reads_kept_all', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [ON_SALE_BLACK, productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力' })],
    liveInventory: BOTH_IN_STOCK,
  });
  // 一个在售一个下架：丢掉 1 个。
  runs.droppedOne = await runSale({
    taskId: 'reads_dropped_one', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(), products: MIXED_PRODUCTS, liveInventory: BOTH_IN_STOCK,
  });
  // 两个都下架：候选全丢（走"没有在售颜色"那条路）。
  runs.droppedAll = await runSale({
    taskId: 'reads_dropped_all', text: 'B26002-52 37 码，228 元微信',
    parsed: CASH(),
    products: [
      productRow({ recordId: 'p_black', itemNo: 'B26002-52', color: '黑色', status: '下架' }),
      productRow({ recordId: 'p_choco', itemNo: 'B26002-52', color: '巧克力', status: '下架' }),
    ],
    liveInventory: BOTH_IN_STOCK,
  });

  const reads = (run) => ({ ...run.gateway.reads });
  assert.deepEqual(reads(runs.droppedOne), reads(runs.keptAll),
    '丢掉一个颜色没有多读任何一张表（状态跟着候选一起来）');
  assert.deepEqual(reads(runs.droppedAll), reads(runs.keptAll),
    '候选全丢也没有多读 / 少读（B 是**没被调用**，不是"读了才发现没货"）');
  assert.equal(reads(runs.keptAll).product, 2);
  assert.equal(reads(runs.keptAll).liveInventory, 1);
});

// ── ⑨ 边界：过滤只作用于 A 的候选；B 兜底的候选不带状态、不在这里过滤 ──────
test('⑨ 解析 A 读不到货品信息（兜底走 B）→ 候选照旧由 B 给（候选上没有「货品状态」，不过滤）', async () => {
  // 「货号没建档」那道判据会挡住这条路 ⇒ 这一条用例只关心候选来源，显式把它关掉。
  const previous = process.env.SALES_PRODUCT_REGISTRATION_GUARD_ENABLED;
  process.env.SALES_PRODUCT_REGISTRATION_GUARD_ENABLED = 'false';
  try {
    const { task, logs } = await runSale({
      taskId: 'cash_b_fallback', text: 'B26002-52 37 码，228 元微信',
      parsed: CASH(),
      products: [], // A 找不到货品 ⇒ 候选只能由 B（实时库存）兜底
      liveInventory: BOTH_IN_STOCK,
    });
    assert.equal(task.status, 'ready_to_confirm');
    assert.deepEqual(task.draft.items[0].color_options.map((option) => option.color), ['黑色', '巧克力'],
      'B 兜底那条路一个字没改：过滤只作用于 A 的候选');
    assert.ok(task.draft.items[0].color_options.every((option) => option.status === undefined));
    assert.equal(jsonLogs(logs).find((entry) => entry.event === 'lark.sales.color_options.filtered'), undefined,
      '没有 A 的候选就没有过滤动作（不记假日志）');
  } finally {
    if (previous === undefined) delete process.env.SALES_PRODUCT_REGISTRATION_GUARD_ENABLED;
    else process.env.SALES_PRODUCT_REGISTRATION_GUARD_ENABLED = previous;
  }
});
