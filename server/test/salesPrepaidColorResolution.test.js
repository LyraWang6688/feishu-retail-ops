// 预付单的「选颜色」链路（2026-10-07 真机 bug 的回归用例）。
//
// 真机事实（业务负责人 2026-10-07，生产）：她说
//   「B26002-52 37 码，定金微信交了 100 元，下次欠 128 元」（**没说颜色**）
// 「货品信息」里 B26002-52 有**两条**（巧克力 / 黑色），预付又**不查实时库存**，
// 结果入账后「销售明细」那一行**没有「编号」**（商品关联），草稿里
// `product_record_id` / `color` 全空，也**没有** `needs_color` / `color_options`
// ⇒ 她连颜色都没得选。
//
// ⚠️ 本文件与 `larkMvpService.test.js` 的关键区别：这里**不注入假的 references**，
//    走的是**真实的 `V1ReferenceResolver`**（= 真机链路）。
//    既有用例一直注入 `productInfoResolver` 这种箭头函数替身，绕过了 `this` 绑定，
//    所以真机上那条 bug 在测试里**看不见**（这就是这份文件存在的理由）。
//
// 设计口径（业务负责人 2026-10-07 逐字）：
//   「用户**不用在销售原话里面说颜色**，我们拿到这个货号之后，会去货品信息里面找，
//     **看能不能确定一个唯一值。如果不能确定唯一值，就给到选消息卡片的流程**」
//   「既然现货是有的，那为什么预付没有呢？」
// ⇒ 三种交易类型同一条口径：唯一 → 直接用；多颜色 → 出候选让她选。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeSalesResult } = require('../src/services/doubaoService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';

// ── 假 Base：形状照 `salesMvp.test.js`（字段名走 schema，写库入参看得见）──
// 与真机同款：`create/update` 收的是**语义键**，这里翻成真表字段名再落进内存记录里，
// 所以「销售明细有没有挂上货品」可以直接在 `records.get('salesDetail')` 上断言。
const fakeBase = ({ products = [], liveInventory = [] } = {}) => {
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
    ['sizeManagement', [37, 38, 39, 40, 41, 42, 43, 44].map((size) => ({
      record_id: `size_${size}`, fields: { 尺码: size },
    }))],
    ['salesEntry', [{ record_id: 'order_1', fields: {} }]],
  ]);
  // 入站（listAll）里的记录用**真字段名**；出站（create）也落真字段名 —— 两边一致，
  // 断言时看到的就是表里那一列。
  const write = (key, values) => Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const field = V1_BITABLE_SCHEMA.tables[key]?.fields?.[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      return [field, value];
    }));
  let seq = 0;
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
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

// 「货品信息」里的一行（真机那两条：编号 = 货号|颜色|类别）。
const productRow = ({ recordId, number, itemNo, color }) => ({
  record_id: recordId, fields: { 编号: number, 货号: itemNo, 颜色: color },
});

// 「实时库存」里的一行（现货 / 未付 的**库存来源**：B 用它查"这个颜色有没有货"，
// 也是候选「有货 / 无货」标注的依据；A 读不到货品时它才兜底提供候选）。
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
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'prepaid-color-')), idField: 'task_id' });

// 走**真实链路**：真 gateway（假 Base）+ **真 `V1ReferenceResolver`**（不注入替身）
// + 真 `V1PostingService`（不注入替身）—— 这句话就是这份文件的全部价值。
const runSale = async ({ taskId, text, parsed, products = [], liveInventory = [] }) => {
  const store = makeStore();
  const cards = [];
  const messages = [];
  const logs = [];
  const gateway = fakeBase({ products, liveInventory });
  const service = new LarkMvpService({
    client: {},
    gateway,
    // references / posting 都不传：由构造函数装**生产同款**的真实实现。
    recognizer: { parseSalesText: async () => normalizeSalesResult(parsed, text) },
    store,
  });
  service.sendTaskCard = async (task, card) => { cards.push({ messageId: task.message_id, card }); return 'om_card'; };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  await store.create({ task_id: taskId, type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: `om_${taskId}`,
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: text });
  // 日志也是证据（「货号没建档」那条 warn 说了什么，这里看得见）。
  const originalWarn = console.warn;
  console.warn = (line) => { logs.push(String(line)); };
  try {
    await service.processSalesTask(taskId);
  } finally {
    console.warn = originalWarn;
  }
  return { service, store, gateway, cards, messages, logs, task: await store.get(taskId) };
};

const confirm = (service, taskId) => service.handleCardAction({
  operator: { operator_id: { open_id: 'ou_1' } },
  action: { value: { action: 'confirm_sale', draft_id: taskId } },
});

const chooseColor = (service, taskId, { itemIndex = 0, recordId, colorName, productNumber }) =>
  service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'choose_sale_color', draft_id: taskId, item_index: itemIndex,
      record_id: recordId, color_name: colorName, product_number: productNumber } },
  });

// 真机那两条「货品信息」记录（业务负责人 2026-10-07 逐条核过）。
const REAL_MACHINE_PRODUCTS = [
  productRow({ recordId: 'rec28eceOYVkYe', number: 'B26002-52|巧克力|B', itemNo: 'B26002-52', color: '巧克力' }),
  productRow({ recordId: 'rec28ece5rVS2G', number: 'B26002-52|黑色|B', itemNo: 'B26002-52', color: '黑色' }),
];
const CHOCO = 'rec28eceOYVkYe';
const BLACK = 'rec28ece5rVS2G';

const itemLine = (itemNo, tradeType, { payments = [], owed } = {}) => ({
  intent: 'sale', trade_type: tradeType,
  items: [{ item_no: itemNo, color: '', size: 37, quantity: 1, actual_amount: 228 }],
  payments, ...(owed === undefined ? {} : { owed }), agreed_total: 228, missing_fields: [],
});

const PREPAID_PARSE = itemLine('B26002-52', '预付', { payments: [{ amount: 100, method: '微信' }], owed: 128 });

// ── ① 预付 + 多颜色：正是真机那一单 ────────────────────────────────────────
test('预付 + 多颜色 + 她没说颜色 → 出颜色候选让她选；选完 recordId 落定、入账时明细挂上货品', async () => {
  const { service, store, gateway, cards, task } = await runSale({
    taskId: 'prepaid_multi', text: 'B26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: PREPAID_PARSE, products: REAL_MACHINE_PRODUCTS,
  });

  // 她没缺项（她自己说清了），照常出确认卡片 —— 但卡片上要有颜色可选。
  assert.deepEqual(task.draft.missing_fields, []);
  assert.equal(task.status, 'ready_to_confirm');
  const item = task.draft.items[0];
  // ⭐ 这就是这次要修的 bug：多颜色时必须有候选，且**不许猜**（recordId 留空）。
  assert.equal(item.needs_color, true, '多颜色必须让她选颜色（真机 bug：预付这条链路没给）');
  assert.deepEqual(item.color_options.map((option) => option.color), ['黑色', '巧克力']);
  assert.deepEqual(item.color_options.map((option) => option.recordId), [BLACK, CHOCO]);
  assert.equal(item.product_record_id, '', '没选颜色之前不许替她挑一个');
  assert.equal(item.color, '');
  // 候选来自「货品信息」，不是「实时库存」：展示串与解析 B 同形状（货号 + 颜色）。
  assert.deepEqual(item.color_options.map((option) => option.number), ['B26002-52黑色', 'B26002-52巧克力']);
  assert.ok(item.color_options.every((option) => option.stock === undefined), '预付没查库存，候选里不该有库存数字');

  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /请选择颜色/);
  assert.match(cardText, /choose_sale_color/);
  assert.match(cardText, /黑色/);
  assert.match(cardText, /巧克力/);

  // 没选颜色 → 不许入账（与现货同一条规矩）。
  const refused = await confirm(service, 'prepaid_multi');
  assert.equal(refused.toast.type, 'warning');
  assert.match(refused.toast.content, /选择颜色/);
  assert.equal((await store.get('prepaid_multi')).status, 'ready_to_confirm', '未选颜色不能进入入账');

  // 她在卡片上点了「黑色」。
  const chosen = await chooseColor(service, 'prepaid_multi', {
    recordId: BLACK, colorName: '黑色', productNumber: 'B26002-52黑色' });
  assert.equal(chosen.toast.type, 'success');
  const afterChoose = await store.get('prepaid_multi');
  assert.equal(afterChoose.draft.items[0].product_record_id, BLACK);
  assert.equal(afterChoose.draft.items[0].needs_color, false);

  // 确认入账：**销售明细必须挂上货品（「编号」非空）**。
  const posted = await confirm(service, 'prepaid_multi');
  assert.equal(posted.toast.type, 'success');
  assert.equal((await store.get('prepaid_multi')).status, 'posted');
  const details = gateway.records.get('salesDetail');
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['编号'], [BLACK], '预付入账后销售明细要挂上货品');
  // 预付 = 未交付（既有口径没动）。
  assert.equal(details[0].fields['履约状态'], '未交付');
});

// ── ② 预付 + 单颜色：直接用，不让她选（与现货一致）──────────────────────────
test('预付 + 单颜色 → 直接用唯一那条，不让她选颜色，入账明细同样挂上货品', async () => {
  const { service, store, gateway, cards, task } = await runSale({
    taskId: 'prepaid_single', text: 'B26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: PREPAID_PARSE,
    products: [productRow({ recordId: BLACK, number: 'B26002-52|黑色|B', itemNo: 'B26002-52', color: '黑色' })],
  });

  const item = task.draft.items[0];
  assert.equal(item.product_record_id, BLACK, '货号唯一 → 直接用它，不用她选');
  assert.equal(item.color, '黑色');
  assert.ok(!item.needs_color, '唯一值时不该多出选颜色的步骤');
  assert.ok(!item.color_options);
  assert.doesNotMatch(JSON.stringify(cards[0].card), /choose_sale_color/);

  const posted = await confirm(service, 'prepaid_single');
  assert.equal(posted.toast.type, 'success');
  assert.deepEqual(gateway.records.get('salesDetail')[0].fields['编号'], [BLACK]);
});

// ── ③ 预付 + 货号不存在：仍然如实报错（**不许**静默通过）────────────────────
// ⚠️ 「货号到底有没有建档」这条判据（挡在确认之前）由另一条改动负责，不在本文件；
//    这里钉住的只有一件事：解析 A **不许**把"找不到货品"变成"悄悄给他一条记录"。
test('预付 + 货号不存在 → 不编记录、不给她选；真实解析器仍然拒绝（不静默）', async () => {
  const { gateway, task, logs } = await runSale({
    taskId: 'prepaid_missing', text: '26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: itemLine('26002-52', '预付', { payments: [{ amount: 100, method: '微信' }], owed: 128 }),
    products: REAL_MACHINE_PRODUCTS,
  });

  const item = task.draft?.items?.[0] || {};
  assert.equal(item.product_record_id || '', '', '找不到货品时不许编一个 recordId');
  assert.ok(!item.needs_color, '连货品记录都没有，谈不上给颜色候选');
  assert.ok(!item.color_options);

  // 入账那一步用的同一个解析器，对这个货号**仍然抛错**（AGENTS.md 第 17 条：不静默）。
  const resolver = new V1ReferenceResolver(gateway);
  await assert.rejects(
    () => resolver.resolveProduct({ itemNo: '26002-52', matchMode: 'sales' }),
    /找不到货品：26002-52/,
  );
  // A 的失败要**如实记账**：错误信息必须是真实的"找不到货品"，
  // 而不是像 2026-10-07 真机那样被 this 丢失的 TypeError 顶掉。
  const failure = logs.map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'lark.sales.product_info.resolve_failed');
  assert.ok(failure, '解析 A 失败必须留下一条日志');
  assert.match(failure.error, /找不到货品：26002-52/);
});

// ── ④⑤ 现货 / 未付 + 多颜色：**候选改由解析 A（货品信息）提供** ─────────────
// ⭐ 旧行为哨兵（有意改掉，见汇报）：这组原来是「与改动前逐字一致（候选来自实时库存、
//    B 覆盖 A）」的指纹。2026-10-07 第三刀之后口径变了（她的原话：
//    「A 一定要有选颜色的机制……如果有多个颜色，一定要让用户去选择」）：
//      · 候选来自 A 的「货品信息」（顺序 = resolver 的 zh-CN 颜色排序），
//      · **在她选定之前 B 一次都不跑** ⇒ 候选里**没有**库存分布 / 补样品方案，
//      · 候选上改标「这个尺码有没有货」的 `stock_status`（只用录单时已读进来的索引算）。
//    这不是放宽：把 B 下放到"选完颜色之后"，同时钉住"候选一个字段都不能少"。
const A_PROVIDES_CANDIDATES_ITEM = {
  item_no: 'B26002-52', color: '', size: 37, quantity: 1, actual_amount: 228,
  gift: false, gift_description: '', product_record_id: '', product_number: '',
  needs_color: true,
  color_options: [
    { recordId: BLACK, color: '黑色', number: 'B26002-52黑色', stock_status: 'available' },
    { recordId: CHOCO, color: '巧克力', number: 'B26002-52巧克力', stock_status: 'available' },
  ],
};

const MULTI_COLOR_LIVE_ROWS = [
  liveRow({ itemNo: 'B26002-52', color: '巧克力', size: 37, productRecordId: CHOCO }),
  liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK }),
];

test('现货 + 多颜色 → 候选由 A 给（先让她选，B 还没跑）：候选里没有库存数字、只标有没有货', async () => {
  const { task, cards } = await runSale({
    taskId: 'cash_multi', text: 'B26002-52 37 码，228 元微信',
    parsed: itemLine('B26002-52', '现货', { payments: [{ amount: 228, method: '微信' }] }),
    products: REAL_MACHINE_PRODUCTS, liveInventory: MULTI_COLOR_LIVE_ROWS,
  });
  assert.deepEqual(task.draft.items[0], A_PROVIDES_CANDIDATES_ITEM);
  // 候选里没有 stock / sample_plan：那是 B 的产物，而 B 要等她选完才跑。
  assert.ok(task.draft.items[0].color_options.every((option) => option.stock === undefined));
  assert.ok(task.draft.items[0].color_options.every((option) => option.sample_plan === undefined));
  assert.match(JSON.stringify(cards[0].card), /choose_sale_color/);
  // 卡片上「有货 / 无货」照标（两色在这个尺码都有货）。
  assert.match(JSON.stringify(cards[0].card), /黑色（有货）/);
});

test('未付 + 多颜色 → 与现货同一条口径（候选由 A 给，B 等她选完）', async () => {
  const { task } = await runSale({
    taskId: 'unpaid_multi', text: 'B26002-52 37 码，228 元未付',
    parsed: itemLine('B26002-52', '未付', {}),
    products: REAL_MACHINE_PRODUCTS, liveInventory: MULTI_COLOR_LIVE_ROWS,
  });
  assert.deepEqual(task.draft.items[0], A_PROVIDES_CANDIDATES_ITEM);
});

// 现货 + 这个尺码一双都没有：A 仍然是"两个颜色"，所以**候选照旧摆出来**，
// 只是每一个都如实标「无货」；缺货那句话发生在**她选完之后**的 B 之后
// （"全都无货"这个边界是有意保留的，见 docs/ab-color-first-design-2026-10-07.md）。
test('现货 + 这个尺码一双都没有 → 候选照旧摆出来、都标「无货」（缺货发生在选完之后的 B）', async () => {
  const { task, cards, messages } = await runSale({
    taskId: 'cash_shortage', text: 'B26002-52 37 码，228 元微信',
    parsed: itemLine('B26002-52', '现货', { payments: [{ amount: 228, method: '微信' }] }),
    products: REAL_MACHINE_PRODUCTS,
    liveInventory: [], // 这个货号这个尺码一双都没有
  });
  const item = task.draft.items[0];
  assert.equal(item.product_record_id, '');
  assert.equal(item.color, '');
  assert.equal(item.needs_color, true, '「全都无货」也要让她看到候选（而不是静默换一条路）');
  assert.deepEqual(item.color_options.map((option) => option.stock_status), ['unavailable', 'unavailable']);
  assert.equal(task.status, 'ready_to_confirm', '还没跑 B，所以现在还不是"缺货"结论');
  assert.deepEqual(messages, [], '缺货提示发生在 B 之后（现在 B 还没跑）');
  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /黑色（无货）/);
  assert.match(cardText, /巧克力（无货）/);
});

// 现货 + 多颜色 + 实时库存里只有其中一个颜色：她点到"没货"那个颜色时，
// 缺货提示发生在**跑完 B 之后**（B 的输入就是她选的那个颜色）；候选保留，
// 她可以在同一张卡片上换一个有货的颜色 —— 不重发整条销售信息。
test('现货 + 多颜色：点到没货的颜色 → B 之后回「库存里没有…」，候选保留、可换一个颜色', async () => {
  const { service, store, cards, messages } = await runSale({
    taskId: 'cash_pick_out', text: 'B26002-52 37 码，228 元微信',
    parsed: itemLine('B26002-52', '现货', { payments: [{ amount: 228, method: '微信' }] }),
    products: REAL_MACHINE_PRODUCTS,
    liveInventory: [liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK })],
  });

  const picked = await chooseColor(service, 'cash_pick_out', {
    recordId: CHOCO, colorName: '巧克力', productNumber: 'B26002-52巧克力' });
  assert.equal(picked.toast.type, 'warning');
  assert.match(messages.at(-1), /^库存里没有 B26002-52 37码（/, '缺货那句话发生在 B 之后');
  const afterOut = await store.get('cash_pick_out');
  assert.equal(afterOut.status, 'ready_to_confirm', '不把任务打死');
  assert.equal(afterOut.draft.items[0].needs_color, true, '候选保留');
  assert.deepEqual(afterOut.draft.items[0].color_options.map((option) => option.recordId), [BLACK, CHOCO]);
  assert.equal(cards.length, 1, '缺货时卡片不换面（她还要用那张卡上的按钮）');

  // 换一个有货的颜色 → 这一条明细落定；库存分布由 B 现查。
  const again = await chooseColor(service, 'cash_pick_out', {
    recordId: BLACK, colorName: '黑色', productNumber: 'B26002-52黑色' });
  assert.equal(again.toast.type, 'success');
  const settled = await store.get('cash_pick_out');
  assert.equal(settled.draft.items[0].product_record_id, BLACK);
  assert.equal(settled.draft.items[0].needs_color, false);
  assert.deepEqual(settled.draft.items[0].stock, { doorBox: 1, sample: 0, warehouse: 0 });
  assert.equal(cards.length, 2, '录单 1 张 + 选完颜色 1 张');
});

// ── 解析 A 的调用方式（根因的最小钉子）──────────────────────────────────────
// 2026-10-07 真机 bug 的根因：把 `references.resolveProduct` **从对象上摘下来**再调用，
// `this` 丢了 ⇒ 真实 `V1ReferenceResolver` 第一行 `this.gateway` 就抛
// `TypeError: Cannot read properties of undefined (reading 'gateway')` ⇒ 被吞成 `{}`。
// 这条用「一个用 `this` 的类方法替身」把调用方式钉死，不依赖 resolver 的内部实现。
test('解析 A 调用 references.resolveProduct 时必须带 this（摘下来调用会丢 this）', async () => {
  class ResolverUsingThis {
    constructor(marker) { this.marker = marker; }
    async resolveProduct({ itemNo }) { return { recordId: `${this.marker}:${itemNo}` }; }
  }
  const service = new LarkMvpService({ client: {}, gateway: {}, store: makeStore(), recognizer: {},
    references: new ResolverUsingThis('own-this') });
  const info = await service.resolveProductInfoForSale({ itemNo: 'B26002-52' });
  assert.equal(info.productRecordId, 'own-this:B26002-52');
});
