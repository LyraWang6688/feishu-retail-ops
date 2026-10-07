// 「A 给全部颜色候选 → 她选 → B 查实时库存 → **类型就此定下来**」——走**真实链路**的回归用例。
//
// 真机事实（业务负责人 2026-10-07，生产）：
//   「B26002-52 37 码，定金微信交了 100 元，下次欠 128 元」（**没说颜色**）
// 「货品信息」里 B26002-52 有两条（巧克力 / 黑色）⇒ 必须出候选让她选。
//
// 🔴 2026-10-07 口径大改之后本文件多钉一件事：**类型 = 库存有没有**
//   「库存里有这双 → 现货（当场交付 + 扣库存）；库存里没有 → 预定（不交付、等货到了再交付）」
//   ⇒ 选完颜色那一次实时库存查询的结果，直接决定这一行是 `SALE_CASH` 还是 `SALE_PREPAID`。
//
// ⚠️ 本文件与 `larkMvpService.test.js` 的关键区别：这里**不注入假的 references / posting**，
//    走的是**真实的 `V1ReferenceResolver` + `V1PostingService`**（= 真机链路）。
//    既有用例一直注入 `productInfoResolver` 这种箭头函数替身，绕过了 `this` 绑定，
//    所以真机上那条 bug 在测试里**看不见**（这就是这份文件存在的理由）。
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
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';

// ── 假 Base：形状照 `salesMvp.test.js`（字段名走 schema，写库入参看得见）──
const fakeBase = ({ products = [], liveInventory = [] } = {}) => {
  const records = new Map([
    ['product', products],
    ['liveInventory', liveInventory],
    ['behavior', [
      { record_id: 'bhv_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
      { record_id: 'bhv_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } },
      // 现货交付要扣库存 —— 库存行为也在同一张「行为管理」表里（真机形状）。
      { record_id: 'behavior_sale', fields: {
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
    ['salesEntry', [{ record_id: 'order_1', fields: {} }]],
  ]);
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
    // 交付扣库存会把这双从「实时库存」里删掉（一双鞋一条记录）。
    delete: async (key, id) => {
      const rows = records.get(key) || [];
      const index = rows.findIndex((row) => row.record_id === id);
      if (index >= 0) rows.splice(index, 1);
      return true;
    },
  };
  return gateway;
};

const productRow = ({ recordId, number, itemNo, color, status = '在售' }) => ({
  record_id: recordId, fields: { 编号: number, 货号: itemNo, 颜色: color, 货品状态: status },
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
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'color-type-')), idField: 'task_id' });

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
    // ⚠️ 库存引擎的**幂等台账**必须落在临时目录：默认目录是 `server/data/inventory_operations`
    //   （gitignored 的本机残留），同一个 operation_id 会被上一次跑留下的记录判成"流水不一致"。
    delivery: new SalesDeliveryService({
      gateway,
      inventory: new InventoryService({
        gateway,
        store: new JsonTaskStore({
          dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inv-ops-')), idField: 'operation_id',
        }),
      }),
    }),
  });
  service.sendTaskCard = async (task, card) => { cards.push({ messageId: task.message_id, card }); return 'om_card'; };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  await store.create({ task_id: taskId, type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: `om_${taskId}`,
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: text });
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

// 卡片上「选颜色」那些按钮的**逐字**文字（钉住"候选只显示颜色名"）。
const colorButtonTexts = (card) => (card.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns.flatMap((column) => column.elements))
  .filter((child) => child.tag === 'button' && child.value?.action === 'choose_sale_color')
  .map((child) => child.text.content);

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

// 她嘴上说的性质（提示）：定金 ⇒ 预定；后端仍以**库存**为准。
const PREPAID_PARSE = itemLine('B26002-52', '预定', { payments: [{ amount: 100, method: '微信' }], owed: 128 });

const mainEntryWithTradeType = (gateway, recordId) =>
  (gateway.records.get('salesEntry') || []).find((row) => row.record_id === recordId);

// ── ① 真机那一单：多颜色 + **这个尺码一双都没有** → 选完颜色 = 预定 ────────────
test('① 多颜色 + 库存里没有 → 出候选让她选；选完记**预定**（不交付、明细挂上货品）', async () => {
  const { service, store, gateway, cards, task } = await runSale({
    taskId: 'prepaid_multi', text: 'B26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: PREPAID_PARSE, products: REAL_MACHINE_PRODUCTS,
  });

  assert.deepEqual(task.draft.missing_fields, []);
  assert.equal(task.status, 'ready_to_confirm');
  const item = task.draft.items[0];
  assert.equal(item.needs_color, true, '多颜色必须让她选颜色');
  assert.deepEqual(item.color_options.map((option) => option.color), ['黑色', '巧克力']);
  assert.deepEqual(item.color_options.map((option) => option.recordId), [BLACK, CHOCO]);
  assert.equal(item.product_record_id, '', '没选颜色之前不许替她挑一个');
  assert.equal(item.color, '');
  assert.equal(item.trade_type_code, '', '颜色没定、库存没查 ⇒ 类型还没定');
  // 🔴 「甲 去掉」：候选**只有颜色名** —— 就算这个尺码一双都没有，候选上也不标「无货」。
  for (const option of item.color_options) {
    assert.ok(!('stock_status' in option), `候选上不许再有 stock_status：${JSON.stringify(option)}`);
  }

  const cardText = JSON.stringify(cards[0].card);
  assert.match(cardText, /请选择颜色/);
  assert.match(cardText, /choose_sale_color/);
  // 反向断言（收严）：逐字只有颜色名（旧版这两个按钮是「黑色（无货）」「巧克力（无货）」）。
  assert.deepEqual(colorButtonTexts(cards[0].card).slice().sort(), ['巧克力', '黑色']);
  assert.doesNotMatch(cardText, /有货|无货/);

  // 没选颜色 → 不许入账（与现货同一条规矩）。
  const refused = await confirm(service, 'prepaid_multi');
  assert.equal(refused.toast.type, 'warning');
  assert.match(refused.toast.content, /选择颜色/);

  // 她在卡片上点了「黑色」。
  const chosen = await chooseColor(service, 'prepaid_multi', {
    recordId: BLACK, colorName: '黑色', productNumber: 'B26002-52黑色' });
  assert.equal(chosen.toast.type, 'success', '没货不是错误：记成预定就好');
  const afterChoose = await store.get('prepaid_multi');
  assert.equal(afterChoose.draft.items[0].product_record_id, BLACK);
  assert.equal(afterChoose.draft.items[0].needs_color, false);
  assert.equal(afterChoose.draft.items[0].trade_type_code, 'SALE_PREPAID');
  assert.equal(afterChoose.draft.items[0].trade_type, '预定');

  // 确认入账：明细挂上货品（「编号」非空）、履约状态 = 未交付、库存流水一个字都不写。
  const posted = await confirm(service, 'prepaid_multi');
  assert.equal(posted.toast.type, 'success');
  const finalTask = await store.get('prepaid_multi');
  assert.equal(finalTask.status, 'posted');
  const details = gateway.records.get('salesDetail');
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['编号'], [BLACK], '明细要挂上货品');
  assert.equal(details[0].fields['履约状态'], '未交付', '预定 = 未交付');
  assert.match(JSON.stringify(details[0].fields['交易类型']), /bhv_prepaid/,
    '明细的交易类型**单选关联它自己那一行**');
  assert.equal(gateway.records.get('inventoryLedger'), undefined, '预定不扣库存');
  // 主表「交易类型」多选 = 预定那一条。
  const entry = mainEntryWithTradeType(gateway, finalTask.sales_entry_record_id);
  assert.match(JSON.stringify(entry.fields['交易类型']), /bhv_prepaid/);
});

// ── ② 同样一条原话、库里**有**黑色 → 选完颜色 = 现货（交付 + 扣库存）────────────
test('② 同样输入、库存里**有**那一个颜色 → 选完记**现货**（已交付 + 扣库存）', async () => {
  const { service, store, gateway, task } = await runSale({
    taskId: 'cash_multi', text: 'B26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: PREPAID_PARSE, products: REAL_MACHINE_PRODUCTS,
    liveInventory: [liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK })],
  });
  assert.equal(task.draft.items[0].trade_type_code, '', '录单阶段还没查库存 ⇒ 类型未定');

  const chosen = await chooseColor(service, 'cash_multi', {
    recordId: BLACK, colorName: '黑色', productNumber: 'B26002-52黑色' });
  assert.equal(chosen.toast.type, 'success');
  const afterChoose = await store.get('cash_multi');
  assert.equal(afterChoose.draft.items[0].trade_type_code, 'SALE_CASH', '库存里有 → 现货');
  assert.equal(afterChoose.draft.items[0].trade_type, '现货');
  assert.deepEqual(afterChoose.draft.items[0].stock, { doorBox: 1, sample: 0, warehouse: 0 });

  const posted = await confirm(service, 'cash_multi');
  assert.equal(posted.toast.type, 'success');
  const finalTask = await store.get('cash_multi');
  const details = gateway.records.get('salesDetail');
  assert.deepEqual(details[0].fields['编号'], [BLACK]);
  assert.equal(details[0].fields['履约状态'], '已交付', '现货 = 已交付');
  const ledger = gateway.records.get('inventoryLedger') || [];
  assert.ok(ledger.length >= 1, '现货要扣库存（库存流水必须有记录）');
  const entry = mainEntryWithTradeType(gateway, finalTask.sales_entry_record_id);
  assert.match(JSON.stringify(entry.fields['交易类型']), /bhv_cash/);
  assert.doesNotMatch(JSON.stringify(entry.fields['交易类型']), /bhv_prepaid/);
});

// ── ③ 单颜色：录单当场就定类型（不用她选颜色）────────────────────────────────
test('③ 单颜色 + 库存里没有 → 录单即定**预定**；入账明细同样挂上货品、未交付', async () => {
  const { service, store, gateway, cards, task } = await runSale({
    taskId: 'prepaid_single', text: 'B26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: PREPAID_PARSE,
    products: [productRow({ recordId: BLACK, number: 'B26002-52|黑色|B', itemNo: 'B26002-52', color: '黑色' })],
  });

  const item = task.draft.items[0];
  assert.equal(item.product_record_id, BLACK, '货号唯一 → 直接用它，不用她选');
  assert.equal(item.color, '黑色');
  assert.ok(!item.needs_color, '唯一值时不该多出选颜色的步骤');
  assert.equal(item.trade_type_code, 'SALE_PREPAID');
  assert.doesNotMatch(JSON.stringify(cards[0].card), /choose_sale_color/);

  await confirm(service, 'prepaid_single');
  const details = gateway.records.get('salesDetail');
  assert.deepEqual(details[0].fields['编号'], [BLACK]);
  assert.equal(details[0].fields['履约状态'], '未交付');
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal((await store.get('prepaid_single')).status, 'posted');
});

test('③b 单颜色 + 库存里有 → 录单即定**现货**；已交付 + 扣库存', async () => {
  const { service, store, gateway, task } = await runSale({
    taskId: 'cash_single', text: 'B26002-52 37 码，228 元微信',
    parsed: itemLine('B26002-52', '现货', { payments: [{ amount: 228, method: '微信' }] }),
    products: [productRow({ recordId: BLACK, number: 'B26002-52|黑色|B', itemNo: 'B26002-52', color: '黑色' })],
    liveInventory: [liveRow({ itemNo: 'B26002-52', color: '黑色', size: 37, productRecordId: BLACK })],
  });
  assert.equal(task.draft.items[0].trade_type_code, 'SALE_CASH');
  await confirm(service, 'cash_single');
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  assert.ok((gateway.records.get('inventoryLedger') || []).length >= 1);
  assert.equal((await store.get('cash_single')).status, 'posted');
});

// ── ④ 货号不存在：仍然如实报错（**不许**静默通过）────────────────────────────
test('④ 货号不存在 → 不编记录、不给她选；真实解析器仍然拒绝（不静默）', async () => {
  const { gateway, task, logs } = await runSale({
    taskId: 'prepaid_missing', text: '26002-52 37 码，定金微信交了 100 元，下次欠 128 元',
    parsed: itemLine('26002-52', '预定', { payments: [{ amount: 100, method: '微信' }], owed: 128 }),
    products: REAL_MACHINE_PRODUCTS,
  });

  const item = task.draft?.items?.[0] || {};
  assert.equal(item.product_record_id || '', '', '找不到货品时不许编一个 recordId');
  assert.ok(!item.needs_color, '连货品记录都没有，谈不上给颜色候选');
  // 「货号没建档」那道判据会拦住这一单（配置默认开）—— 这就是 #224 不回退的证据。
  assert.equal(task.status, 'needs_info');

  const resolver = new V1ReferenceResolver(gateway);
  await assert.rejects(
    () => resolver.resolveProduct({ itemNo: '26002-52', matchMode: 'sales' }),
    /找不到货品：26002-52/,
  );
  const failure = logs.map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'lark.sales.product_info.resolve_failed');
  assert.ok(failure, '解析 A 失败必须留下一条日志');
  assert.match(failure.error, /找不到货品：26002-52/);
});

// ── 解析 A 的调用方式（根因的最小钉子，#226 不回退）─────────────────────────
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
