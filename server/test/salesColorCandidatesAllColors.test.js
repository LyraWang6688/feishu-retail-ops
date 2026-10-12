// 颜色候选 = **全部颜色**（只显示颜色名）（2026-10-07 口径大改）。
//
// 业务负责人的三步流程（逐字）：
//   「1. 货品信息还是要先查这个货品有没有、信息全不全
//    2. 这里要给到**全色**，让用户去选
//    3. 用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」
// ⇒ ① 候选**不再按「在售 / 下架」过滤**（原 `colorOptionsScope` / 全下架拦截已整体删除）；
//    ② 🔴 **候选只显示颜色名**（「甲 去掉」：候选只显示颜色（黑色 / 绿色），
//       选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"）——
//       「有货 / 无货」预览标注连同 `stock_status` 字段一并删除；
//    ③ 她选完之后那一次**实时库存**查询**就是类型判据**（有货 → 现货；没货 → 预定）。
//
// ⚠️ 本文件**不注入假的 references**：走真实的 `V1ReferenceResolver`（= 真机链路），
//    因为「货品状态」「颜色候选」都是真表上读出来的。
//
// 验收标准见 `docs/color-candidate-no-stock-preview-2026-10-07.md`。
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

// 卡片上「选颜色」那些按钮的**逐字**文字（按出现顺序）—— 用来钉住"候选只显示颜色名"。
const colorButtonTexts = (card) => (card.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns.flatMap((column) => column.elements))
  .filter((child) => child.tag === 'button' && child.value?.action === 'choose_sale_color')
  .map((child) => child.text.content);

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


// ⭐ 新增（2026-10-07「甲 去掉」）：**多颜色 → 候选按钮逐字只有颜色名**。
// 用她口径里的原例（`黑色` / `绿色`），且**库里一个有货、一个没货** ——
// 这种"两个候选库存状况不同"正是旧版会拼出 `黑色（有货）/ 绿色（无货）` 的场景，
// 现在必须**一模一样地**只剩两个颜色名。

// ── ② 全都没货：候选照旧全部列出（只显示颜色名）；选了就记预定（AC-2.4 + AC-1.2/1.3）──



// ── ③ 全下架（原来的"候选被过滤空"那条路）已彻底退场 ────────────────────────

// ── ④ 零新增远端请求：候选两个 / 一个 / 全没货，读表次数完全一样 ──────────────

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
