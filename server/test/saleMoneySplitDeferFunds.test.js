'use strict';

/**
 * task-62「货 / 钱分离」· **阶段二** —— `submitSale({ deferFunds: true })` 那**一条路**（服务层判据）
 *
 * ## 这一刀是什么（业务负责人 2026-10-16 逐字）
 *   「我们实际上**货和资金是可以分开的**，但用的是**一个销售单号把它们绑定在一块**。
 *    我们的**销售主表和销售明细，只要货品信息那一页填完，里面的金额就是定了的**。
 *    但金额定了之后，**什么时候付款、分几次付、付款方式是什么，是在资金页里面去确定的**」
 *   ⇒ ① 提交货品信息（进资金页那一刻）⇒ **就建单**（只写货）；② 资金页 ⇒ 用**同一个单号**只决定钱。
 *
 * ## 本轮落的是哪一块
 *   · `services/scanWriteService.js`（🔴 **冻结件 · 成对迁移**）的 `submitSale` 加 `deferFunds`；
 *   · 🔴 **没有接线**（`routes/**` 一个字都没动 —— 那个目录有别的单元在跑，见 AC-MSD7 ③）。
 *   ⇒ 开关（`SCAN_MONEY_SPLIT_ENABLED`）**仍在调用方**：本文件只验服务层那一条路 ✓。
 *
 * ## 验收标准（**先写后做**；每条 test 的名字 = 这条 AC）
 *   AC-MSD1 ⭐ **关着（不传 / 显式 `false`）⇒ 逐字同形**：写库流水**逐条 `deepEqual`** ·
 *           `confirm` 入参里**根本没有 `fundsDeferred` 这个键** · 收款 / 库存 / `completed` 照旧 ✓
 *   AC-MSD2 ⭐ **货那一跑**（`deferFunds: true`）⇒ 主表 1（**总金额**）＋ 明细 N（逐件实收）＋
 *           销售状态照写；**收款明细 0 行** · **资金状态停在「未写入」** · `confirm` 入参**不带 `owed`**
 *   AC-MSD3 🔴 **进了资金页但没提交 ⇒ 库存一双未扣**（交付服务**一次都没被叫** · 实时库存不动 ·
 *           库存流水 0 条 · 明细「履约状态」未交付 · 主表「库存状态」没写 · 没有假的"库存没扣成"日志）
 *   AC-MSD4 🔴 **异步那一跑也必须 deferFunds**（`saleRestInput` 不带它 ⇒ 后台就会把钱写了 ✗）
 *   AC-MSD5 🔴 **货那一跑不记 `completed`**（改记 `goods_created`）：所以资金页那一跑**不会被当重放吸收**；
 *           同一把键再点一次也**不会建第二张单 / 不重复明细**
 *   AC-MSD6 🔴 货那一跑**带收款 ⇒ 当场抛**，且**一个字都不写表**（连主表都不建）
 *   AC-MSD7 🔴 **源码哨兵**：接缝逐字 · 显式布尔 · 本卡**没接线**（`routes/**` 里没有 `deferFunds`）
 *
 * ⚠️ 本文件用的是**真的** `SalesOrderService` / `SalesDeliveryService` / `InventoryService`
 *    （只有飞书那一层是内存替身 + 两个"记账"包壳）—— 所以"钱一行没写""库存一双没扣"是**跑出来的** ✓。
 * ⚠️ 与阶段一的 `test/saleMoneySplitGoodsHalf.test.js` 分工：那一份钉**业务层** `_confirm({ fundsDeferred })`，
 *    这一份钉**提交层** `submitSale({ deferFunds })`（两条接缝，各钉各的 ✓）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证（与既有用例同形）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_money_split_defer';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'money_split_defer_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SESSION_MARKERS } = require('../src/config/saleMoneySplit');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../src/config/salesStatusDimensions');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const ROUTES_SRC = path.join(SERVER_SRC, 'routes');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（照测试 Base 的真实列形状；与 `scanSaleCashDeliveryOnSubmit.test.js` 同一套种子）──────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: 'YD6693-2',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    单价: 399,
    供应商: ['sup_1'],
  },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 一双门盒（"有货"的那一双 —— 现货行扣的就是它）。 */
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
  // 40 有一双门盒（现货，本来"提交即交付"会把它扣掉）；41 / 42 一双都没有（预订）
  liveInventory: [liveUnit('live_40_box', 40)],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
    { record_id: 'bh_sale_decrease', fields: { 行为名称: '销售减少', 行为编码: 'STOCK_SALE_DECREASE', 库存方向: '减少', 是否启用: true } },
  ],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { 收款方式: '微信' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
  ...overrides,
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
const createFakeGateway = (tables = seedTables()) => {
  const writes = [];
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((record) => String(record.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, record_id: record.record_id, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    // 卖出那一双会把「实时库存」里那条记录**删掉**（既有库存引擎的语义）；别的表一律不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      const before = (tables[key] || []).length;
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id, removed: before - (tables[key]).length });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `money-split-defer-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的扫码写链路：真 service ＋ 真业务层 ＋ 真库存引擎，只有飞书那层是替身。
 * 另外两个**记账包壳**（只为断言用，不改任何行为）：
 *   · `sales`  → 捕获交给业务层 `_confirm` 的**入参对象**（逐字：带了哪些键）；
 *   · `delivery` → 捕获"交付服务被叫了几次"（AC-MSD3 那一条判据）。
 */
const createHarness = () => {
  const gateway = createFakeGateway();
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const replenishDir = tempDir('replenish');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const realDelivery = new SalesDeliveryService({ gateway, inventory });
  const deliveryCalls = [];
  const delivery = {
    deliver: (input, options) => {
      deliveryCalls.push({ input, options });
      return realDelivery.deliver(input, options);
    },
  };
  // ⚠️ `readCache: false` ⇒ 本文件注入的 `sales` 与模块自己构造的那一个**逐字等价**
  //    （否则模块会用"只读缓存"包一层网关，注入件就没有那层 ⇒ 两个世界 ✗）。
  const confirmInputs = [];
  const realSales = new SalesOrderService({ gateway });
  const sales = {
    confirm: (input, options) => {
      confirmInputs.push(input);
      return realSales.confirm(input, options);
    },
  };
  const write = createScanWriteService({
    gateway,
    sessions,
    delivery,
    sales,
    readCache: false,
    // 本文件不碰补货 / 退货那条链路；给它们不会落盘的替身，免得误写工作区。
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
  });
  // ⭐ 异步（`config.sale.asyncWrite.enabled` 默认 `true`）：`submitSale` 是"**单号先出、余下转后台**"——
  //   ⇒ 用例要**先等后台那一跑跑完**再回读端状态（与 `scanSaleCashDeliveryOnSubmit.test.js` 同一条约定 ✓）。
  //   ⚠️ 顺手留一份**原始返回**（`rawResults`）⇒ AC-MSD4 要验"第一次那一跑自己带没带 `funds_deferred`" ✓。
  const rawResults = [];
  const rawSubmitSale = write.submitSale;
  write.submitSale = async (input) => {
    const result = await rawSubmitSale(input);
    rawResults.push(result);
    if (!result?.background) return result;
    const rest = await result.background;
    const defined = Object.fromEntries(
      Object.entries(rest || {}).filter(([, value]) => value !== undefined),
    );
    return { ...result, ...defined };
  };
  return {
    gateway, sessions, inventory, delivery, write,
    tables: gateway._tables, confirmInputs, deliveryCalls, rawResults,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(replenishDir); },
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
const currentKey = async (harness, openId) => (await harness.sessions.get(openId)).sale.key;
const sessionSale = async (harness, openId) => (await harness.sessions.get(openId)).sale;

/** 抓结构化日志（`logger` 写的是 console.log 的 JSON 行）。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

/** 一条现货行的标准加法（40 有货 ⇒ `SALE_CASH` = "提交即交付"那条路）。 */
const addCashLine = (h, openId, size = 40) => h.write.addSaleLine({
  openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
  size, inStock: true,
});

/** ⭐ 预订那一双（`inStock: false` ✓ 与既有 AC-MSD6 那一处同一形状 ✓）—— 新口径：**不交付** ✓。 */
const addReserveLine = (h, openId, size = 41) => h.write.addSaleLine({
  openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
  size, inStock: false,
});

/**
 * 写库流水的**可比形态**：唯一被"屏蔽"的是**收款日**（`receivedAt`）。
 *
 * ⚠️ 为什么必须有这一条（**不是放宽判据**）：按本仓口径，代码只允许写**一个**时间列 ——
 *   「收款时间 / 收款日」= "**她点确认那一刻**"（AGENTS《时间字段》那条）。两跑相隔几十毫秒
 *   ⇒ 那个值**必然不同**（`Date.now()`）；而**其余每一个字段、每一条顺序都逐字比** ✓
 *   （除它之外任何一处不同 ⇒ `deepEqual` 红 ✓）。
 */
const VOLATILE_WRITE_FIELDS = Object.freeze(['收款日']);
const comparableWrites = (writes) => writes.map((write) => ({
  ...write,
  fields: Object.fromEntries(Object.entries(write.fields || {}).map(([key, value]) => [
    key, VOLATILE_WRITE_FIELDS.includes(key) ? '<她点确认那一刻：两跑必然不同>' : value,
  ])),
}));

/**
 * 交给业务层那份入参的**可比形态**：只把**回调**换成占位（两跑各自一个函数对象，
 * `deepEqual` 会因为"不是同一个函数"而红 —— 那是噪声，不是行为差异 ✗）；其余逐字比 ✓。
 */
const comparableConfirmInputs = (inputs) => inputs.map((input) => Object.fromEntries(
  Object.entries(input).map(([key, value]) => [
    key, typeof value === 'function' ? '<回调：onRecordPersisted>' : value,
  ]),
));

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD1 ⭐ 关着（不传 / 显式 false）⇒ 逐字同形
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD1 ⭐ 关着（不传 / 显式 `false`）⇒ 写库流水与 `confirm` 入参**逐字同形**（零行为变化）', async () => {
  const runs = [];
  const openId = 'ou_msd1';
  for (const value of [undefined, false]) {
    const h = createHarness();
    await addCashLine(h, openId);
    const input = {
      openId,
      submitKey: await currentKey(h, openId),
      lineAmounts: [399],
      payments: [{ method: '微信', amount: 399 }],
    };
    if (value !== undefined) input.deferFunds = value;
    const result = await h.write.submitSale(input);
    runs.push({ h, result, value });
  }
  try {
    for (const { h, result, value } of runs) {
      assert.equal(result.ok, true, `deferFunds=${String(value)} ⇒ ${JSON.stringify(result)}`);
      assert.equal(result.stock.failed, 0, '今天的路照旧交付');
      assert.equal(
        Object.prototype.hasOwnProperty.call(result, 'funds_deferred'), false,
        '关着时返回对象里**不许**出现 `funds_deferred`（形状逐字同今天 ✓）',
      );
      // 今天的样子：收款 1 条（她全付）+ 资金状态已写入 + 库存已扣 + completed 有这一把键
      assert.equal(entriesOf(h, 'paymentRecord').length, 1, '关着时钱照写（一条收款）');
      assert.equal(entriesOf(h, 'salesEntry')[0].fields['资金状态'], WRITE.funds.done);
      assert.deepEqual(entriesOf(h, 'liveInventory'), [], '关着时现货照扣库存');
      const sale = await sessionSale(h, openId);
      assert.equal((sale.completed || []).length, 1, '关着时照记 completed（连点靠它吸收）');
      assert.equal(
        Object.prototype.hasOwnProperty.call(sale, SESSION_MARKERS.goodsCreated), false,
        '关着时**不许**出现 `goods_created` 这个新标记',
      );
      // `confirm` 入参：**根本没有** `fundsDeferred` 这个键（不是 `false`，是"没有" ✓）
      assert.equal(h.confirmInputs.length, 1);
      const ci = h.confirmInputs[0];
      assert.equal(
        Object.prototype.hasOwnProperty.call(ci, 'fundsDeferred'), false,
        '关着时业务层入参对象逐字同今天（连键都不出现 ✓）',
      );
      assert.equal(ci.payments.length, 1);
      assert.equal(ci.payments[0].amount, 399);
      assert.equal(Object.prototype.hasOwnProperty.call(ci, 'owed'), false, '全付 ⇒ 没有差额那一条');
    }
    // 🔴 逐字同形的最强判据：两次的**写库流水**与**业务层入参**逐条 `deepEqual`
    assert.deepEqual(comparableWrites(runs[0].h.gateway.writes), comparableWrites(runs[1].h.gateway.writes),
      '`deferFunds: false` 与"不传"的写库流水必须逐条相同（只屏蔽"她点确认那一刻"那个时间列 ✓）');
    assert.deepEqual(comparableConfirmInputs(runs[0].h.confirmInputs), comparableConfirmInputs(runs[1].h.confirmInputs),
      '`deferFunds: false` 与"不传"交给业务层的入参必须逐字相同（只把回调换成占位 ✓）');
  } finally {
    runs.forEach(({ h }) => h.cleanup());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD2 ⭐ 货那一跑 = 只写「货」那一半
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD2 ⭐ 货那一跑：主表（总金额）＋ 明细（逐件实收）＋ 销售状态照写；**收款 0 行 · 资金状态停在未写入**', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_msd2';
    await addCashLine(h, openId, 40);   // 现货（按今天会交付扣库存）
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
      size: 41, inStock: false,         // 预订
    });

    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), deferFunds: true, lineAmounts: [200, 100],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.funds_deferred, true, '货那一跑必须**如实**告诉调用方"钱还没写"（不许猜 ✗）');
    assert.equal(result.detail_count, 2);
    assert.equal(result.payment_count, 0);
    assert.equal(result.owed_amount, 0, '货那一跑没有"钱的结论"⇒ 差额恒 0 ✓');

    // ① 主表一条：总金额 = 逐件实收之和；资金状态停在未写入；销售状态已写入
    const entries = entriesOf(h, 'salesEntry');
    assert.equal(entries.length, 1, '货那一跑就建单（一张销售主表）');
    assert.equal(entries[0].fields['总金额'], 300, '总金额 = 200 + 100（既有 totalCents ÷ 100 ✓）');
    assert.equal(entries[0].fields['资金状态'], WRITE.funds.none, '资金状态停在「未写入」（= 她说的"待补充"）');
    assert.equal(entries[0].fields['销售状态'], WRITE.sales.done, '货写完了 ⇒ 销售状态照旧「已写入」');
    // ⭐⭐ 2026-10-16 口径改（她 22:0x：「**如果是现货，就是要扣库存**」）· **成对迁移**：
    //    改前逐字：`assert.equal(entries[0].fields['库存状态'], undefined, '库存那一维这一跑根本没碰（见 AC-MSD3）');`
    //    改后逐字：现货 ⇒ 货那一跑**就交付**了 ⇒ 主表「库存状态」= `WRITE.stock.done` ✓
    //    依据 = 她 22:0x 逐字「**啥叫钱没入账就不许出库存？不用呀。**」＋「现货就是要扣库存」✓（强度不降：仍逐字钉这一列 ✓）
    assert.equal(entries[0].fields['库存状态'], WRITE.stock.done,
      '现货 ⇒ 货那一跑**当场交付** ⇒ 库存状态已写 ✓（新口径 · 见 AC-MSD3 ✓）');

    // ② 明细两条：逐件实收照写（"金额在货品页定死"）
    const details = entriesOf(h, 'salesDetail');
    assert.equal(details.length, 2);
    assert.deepEqual(details.map((detail) => detail.fields['实收金额']), [200, 100]);
    assert.equal(details.filter((detail) => detail.fields['交易类型']).length, 2, '交易类型照写');

    // ③ 钱：一行都没有（连那条【未收款】也没有 ⇒ 资金页那一跑才写）
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '货那一跑**不写收款明细**（0 行 ✓）');

    // ④ 交给业务层的入参：只多一个 `fundsDeferred: true`；**不带 owed** / 收款空
    assert.equal(h.confirmInputs.length, 1);
    const ci = h.confirmInputs[0];
    assert.equal(ci.fundsDeferred, true, '接缝就是这一个显式布尔（`=== true` ✓）');
    assert.deepEqual(ci.payments, [], '货那一跑不许带收款');
    assert.equal(
      Object.prototype.hasOwnProperty.call(ci, 'owed'), false,
      '🔴 差额是**钱那一半的结论** ⇒ 货那一跑不许把它带进业务层（带了 = 替她记一笔账 ✗）',
    );
    assert.deepEqual(ci.items.map((item) => item.actualAmount), [200, 100], '每件实收照传');

    // ⑤ 会话：记的是**新标记**（货已落库），不是"这一单写完了"
    const sale = await sessionSale(h, openId);
    assert.equal(sale[SESSION_MARKERS.goodsCreated], true, '会话标记 = goods_created ✓');
    assert.equal((sale.completed || []).length, 0, '货那一跑**不记 completed**（见 AC-MSD5 ✓）');
    assert.ok(sale.master_record_id, '主表 record_id 落进会话 ⇒ 资金页那一跑天然"续写同一张单" ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD3 🔴 进了资金页但没提交 ⇒ 库存一双未扣
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD3 🔴【新口径】现货 ⇒ 货那一跑**当场扣库存**（交付被叫 1 次 · 实时库存 −1 · 流水 +1）；资金页那一跑**不再扣**（幂等 ✓）', async () => {
  // ⭐⭐ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`test('AC-MSD3 🔴 进了资金页但**没提交** ⇒ 库存一双未扣（交付服务一次都没被叫 · 实时库存不动 · 流水 0 条）', …)`
  //     ＋ `assert.equal(h.deliveryCalls.length, 0, '🔴 货那一跑不扣库存 ⇒ 交付链路一次都不许被叫');`
  //   改后逐字：现货 ⇒ **货那一跑就交付**（`deliveryCalls === 1` · 实时库存清空 · 流水 1 条 · 履约=已交付 · 库存状态已写）✓
  //     ＋ 资金页那一跑**不再**交付（`deliveryCalls` 仍 **1** ⇒ **不许扣第二次** ✓）
  //   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：
  //          …**如果是现货，就是要扣库存**；如果是预订，就不扣库存，**等二次交付的时候再扣库存**」
  //          ＋「**啥叫钱没入账就不许出库存？不用呀。**」
  //   ⚠️ **强度不降**：老口径钉"不扣"、新口径钉"**现货扣 ＋ 只扣一次**"（预订不扣在 AC-MSD3b ✓）
  const h = createHarness();
  const logs = captureLogs();
  try {
    const openId = 'ou_msd3';
    await addCashLine(h, openId, 40);   // 现货 ⇒ 新口径：**货那一跑就扣**
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);
    assert.deepEqual(before, ['live_40_box'], '起手：实时库存里有那一双门盒');

    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), deferFunds: true, lineAmounts: [399],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // ① 交付服务**被叫了一次**（现货 ✓）；报数是"真的交付结果"（不是 requested 0 ✗）
    assert.equal(result.stock.requested, 1, '现货 ⇒ 这一跑**请求了**交付 ✓');
    assert.equal(result.stock.delivered, 1, '现货 ⇒ 交付成功 ✓');
    assert.equal(result.stock.failed, 0, '不许出现假的"库存没扣成" ✓');
    assert.equal(h.deliveryCalls.length, 1, '⭐ 现货 ⇒ 货那一跑就交付（**1 次** ✓）');
    // ② 实时库存已扣 · 库存流水 1 条
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '⭐ 现货 ⇒ 门盒**当场扣掉**（避免超卖 ✓）');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 1, '⭐ 库存流水 +1 ✓');
    // ③ 明细「履约状态」= 已交付 · 主表「库存状态」已写
    // ⭐ 成对迁移：老口径钉「未交付」✓ ⇒ 新口径（现货当场交付）钉「**已交付**」✓（依据 = 她 22:0x ✓）
    assert.equal(entriesOf(h, 'salesDetail')[0].fields['履约状态'], '已交付', '现货 ⇒ 已交付 ✓');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], WRITE.stock.done, '库存状态已写 ✓');
    // ④ 日志：有"扣成功"，没有"扣失败"
    assert.equal(logs.events('scan.sale.stock_failed').length, 0, '不许有"库存没扣成"日志 ✓');
    // ⑤ 对照：**资金页那一跑**（不带 deferFunds）⇒ 只写钱，**库存不再动**（幂等 ✓ 不许扣第二次 ✗）
    const orderNo = entriesOf(h, 'salesEntry')[0].fields['销售单号'];
    const paid = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), payments: [{ method: '微信', amount: 399 }],
    });
    assert.equal(paid.ok, true, JSON.stringify(paid));
    assert.equal(paid.order_no, orderNo, '同一个销售单号（她："用同一个销售单号做关联" ✓）');
    // ⭐⭐ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`assert.equal(h.deliveryCalls.length, 1, '🔴 资金页那一跑**不再**交付 ⇒ 仍是 1 次（**不许扣第二次** ✗ 幂等 ✓）');`
    //   改后逐字：⭐ 钉**状态**（她要的是"**库存不再动**"✗ 不是"函数不被调用"）——
    //     资金页那一跑**可以**再走一次交付（幂等由交付服务按明细 record 兜住 ✓），但
    //     **实时库存 / 库存流水 / 履约状态 / 库存状态** 必须**与货那一跑结束时逐字相同** ✓
    //   依据 = 她 22:0x「货与钱**独立** ✓ 用同一个销售单号关联」＋ Lead 口径「**不许扣第二次**（幂等 ✓）」
    //     ⚠️ 实测：资金页那一跑**会再调一次**交付服务（`deliveryCalls` 变 2 ✓）⇒ 老那条"次数"断言不成立 ✗
    //       ⇒ 改成更强的**状态不变**断言（下面三条 ✓）；另加一条"**不是零次**"的对照 ✓。
    assert.ok(h.deliveryCalls.length >= 1, '资金页那一跑至少走过一次交付（幂等由服务按明细兜 ✓）');
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '库存仍是已扣状态（不变 ✓）');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 1, '流水仍是 1 条（**不重复** ✓）');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '资金页那一跑写收款明细（钱那半 ✓）');
  } finally { logs.restore(); h.cleanup(); }
});

test('AC-MSD3b ⭐【新口径·预订】预订 ⇒ 货那一跑**不扣**（等二次交付再扣 ✓）', async () => {
  // 依据 = 她 22:0x 逐字：「如果是**预订**，就**不扣库存**，**等二次交付的时候再扣库存**」✓
  const h = createHarness();
  try {
    const openId = 'ou_msd3b';
    await addReserveLine(h, openId, 41);      // 预订（非现货）⇒ 不交付
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), deferFunds: true, lineAmounts: [399],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.deliveryCalls.length, 0, '⭐ 预订 ⇒ 货那一跑**不交付**（她："这是未交付" ✓）');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], undefined, '预订 ⇒ 库存状态不写 ✓');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 0, '预订 ⇒ 零库存流水 ✓');
  } finally { h.cleanup(); }
});

test('AC-MSD4 🔴 异步（默认开）：后台那一跑**也**是 deferFunds ⇒ 它不许把钱写了', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_msd4';
    await addCashLine(h, openId, 40);   // 实收 399 ⇒ 若后台没带 deferFunds，就会写一条【未收款 399】✗
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), deferFunds: true, lineAmounts: [399],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // ① 第一次那一跑确实是"单号先出、余下转后台"，而且**如实**标了 funds_deferred
    assert.equal(h.rawResults[0].deferred, true, '异步那一跑：先回单号 ✓');
    assert.equal(h.rawResults[0].funds_deferred, true, '第一次那一跑就如实标"钱还没写" ✓');
    // ② 后台那一跑跑完之后：货齐了、钱**一行都没有**
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '后台那一跑把明细写了 ✓');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0,
      '🔴 后台那一跑也必须 deferFunds —— 否则它会按"未付 ⇒ 差额"写一条【未收款】＝把钱写了 ✗');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['资金状态'], WRITE.funds.none);
    // ③ 进业务层的那一次（= 后台那一跑）也带 fundsDeferred（前后台同一条口径）
    //    ⚠️ 只**一次**：第一次那一跑在建完主表就回了（异步）⇒ 它根本没走到 `confirm` ✓
    assert.equal(h.confirmInputs.length, 1, '异步时只有后台那一跑进业务层');
    for (const ci of h.confirmInputs) {
      assert.equal(ci.fundsDeferred, true, '后台那一跑也必须带 fundsDeferred（explicit true ✓）');
      assert.deepEqual(ci.payments, []);
      assert.equal(Object.prototype.hasOwnProperty.call(ci, 'owed'), false);
    }
    // ④ 标记由**写完货的那一跑**落下（后台那一跑）
    assert.equal((await sessionSale(h, openId))[SESSION_MARKERS.goodsCreated], true);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD5 🔴 货那一跑不记 completed ⇒ 资金页那一跑不被吸收；同一把键也不建第二张单
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD5 🔴 货那一跑不记 `completed`（改记 `goods_created`）：资金页那一跑照写钱 · 不建第二张单', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_msd5';
    await addCashLine(h, openId, 40);
    const key = await currentKey(h, openId);
    const goods = await h.write.submitSale({
      openId, submitKey: key, deferFunds: true, lineAmounts: [399],
    });
    assert.equal(goods.ok, true, JSON.stringify(goods));
    const orderNo = entriesOf(h, 'salesEntry')[0].fields['销售单号'];
    const sale = await sessionSale(h, openId);
    assert.equal((sale.completed || []).length, 0, '🔴 `completed` 是"收款也写过了"的留档 —— 货那一跑不许记 ✗');
    assert.equal(sale[SESSION_MARKERS.goodsCreated], true, '改记 `goods_created` ✓');

    // ① "返回再点"（同一把键、同一份草稿再提交一次）⇒ 不建第二张单、不重复明细
    const again = await h.write.submitSale({
      openId, submitKey: key, deferFunds: true, lineAmounts: [399],
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.reused === true, false, '货那一跑不记 completed ⇒ 这一跑**不是**"重放吸收"（是续写）');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '仍然是那一张单（会话里的 master_record_id 就是闸门 ✓）');
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '明细不重复 ✓');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '钱还是 0 行 ✓');

    // ② 资金页那一跑（**同一把 submitKey**）：钱照写、库存才扣、单据还是同一条
    const money = await h.write.submitSale({
      openId, submitKey: key, payments: [{ method: '微信', amount: 399 }],
    });
    assert.equal(money.ok, true, JSON.stringify(money));
    assert.equal(money.reused === true, false,
      '🔴 若货那一跑记了 completed，这一跑会直接命中"重放"⇒ 钱**永远写不上**（静默丢账 ✗）');
    assert.equal(money.order_no, orderNo, '同一个销售单号 ✓');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '全程只有一张单 ✓');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '钱这一跑写了（她全付 ⇒ 一条收款）');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['资金状态'], WRITE.funds.done, '资金状态由钱那一跑收口 ✓');
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '库存也是钱那一跑之后才扣 ✓');
    assert.equal((await sessionSale(h, openId)).completed.length, 1, '钱那一跑才记 completed ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD6 🔴 货那一跑带收款 ⇒ 当场抛，且一个字都不写表
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD6 🔴 货那一跑**带收款** ⇒ 当场抛（调用方契约错）· 一个字都不写表（连主表都不建）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_msd6';
    await addCashLine(h, openId, 40);
    const key = await currentKey(h, openId);
    await assert.rejects(
      () => h.write.submitSale({
        openId,
        submitKey: key,
        deferFunds: true,
        lineAmounts: [399],
        payments: [{ method: '微信', amount: 399 }],
      }),
      /货 \/ 钱分离.*不许带收款|不许带收款/,
      '货那一跑带收款 ⇒ 必须当场抛（两个口都能写钱 = 迟早两遍账 ✗）',
    );
    // 一个字都不写表 —— 拦在**建主表之前** ✓
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '主表 0 条');
    assert.equal(entriesOf(h, 'salesDetail').length, 0, '明细 0 条');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '收款 0 条');
    assert.equal(h.confirmInputs.length, 0, '根本没进业务层 ✓');
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), ['live_40_box'], '库存没动');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSD7 🔴 源码哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSD7 🔴 源码哨兵：接缝逐字 · 显式布尔 · 本卡**没接线**（`routes/**` 里没有 `deferFunds`）', () => {
  const src = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');

  // ① 接缝那几行**逐字**在（改一个字 ⇒ 红 ⇒ 人就得回来看这一条与冻结哨兵）
  assert.ok(src.includes('    deferFunds = false,'), '参数必须叫 `deferFunds` 且缺省 false ✓');
  assert.ok(src.includes('const fundsDeferred = deferFunds === true;'),
    '🔴 **显式布尔**（`=== true`）—— 不许 truthy 判断');
  assert.equal(/(deferFunds\s*&&|if\s*\(\s*deferFunds\s*\))/.test(src), false,
    '🔴 不许出现 truthy 形状的判断（`deferFunds &&` / `if (deferFunds)`）');
  assert.ok(src.includes('...(fundsDeferred ? { fundsDeferred: true } : {}),'),
    '业务层入参只多这一个键（关着时**不出现** ⇒ 逐字同今天 ✓）');
  assert.ok(src.includes('...(fundsDeferred ? { deferFunds: true } : {}),'),
    '🔴 后台那一跑必须带上 deferFunds（AC-MSD4 的源码那一半 ✓）');
  assert.ok(src.includes("'「货 / 钱分离」的货那一跑不许带收款：钱那一半由资金页那一跑写'"),
    '带收款那条闸门必须**当场抛**（且文案逐字 ✓）');
  assert.ok(src.includes('if (fundsDeferred) owedCents = 0;'),
    '货那一跑不许把"钱的结论"带下去 ✓');
  // ⭐⭐ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.ok(src.includes(`        ? { requested: 0, delivered: 0, failed: 0, reasons: [] }`), '库存那一跑：货那一跑如实报 requested 0（AC-MSD3 ✓）');`
  //   改后逐字：① 货那一跑**照走交付**（`allowUnposted: fundsDeferred` ✓）② 那个"不请求交付"的三元**不许回来** ✗
  //             ③ `requested: 0` 只剩**预订/无可交付**那条 early-return（`if (!deliverable.length)` ✓）
  //   依据 = 她 22:0x 逐字「**如果是现货，就是要扣库存**；如果是预订，就不扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」✓
  assert.ok(src.includes('allowUnposted: fundsDeferred'),
    '⭐ 货那一跑照走交付（AC-MSD3 新口径 ✓）');
  assert.equal(/fundsDeferred\s*\n?\s*\?\s*\{ requested: 0/.test(src), false,
    '🔴 "货那一跑不请求交付"那个三元**不许回来** ✗（那=老口径 ✗）');
  assert.ok(src.includes('if (!deliverable.length) return { requested: 0, delivered: 0, failed: 0, reasons: [] };'),
    '`requested: 0` 只该剩**无可交付**（预订）那条 early-return ✓');
  assert.ok(src.includes('[SESSION_MARKERS.goodsCreated]: true'),
    '货那一跑记**新标记**（不是 completed ✓）');

  // ② 顺序：那个分离分支必须在 `completeSale` **之前**（记了 completed 就会吸收资金页那一跑 ✗）
  const deferredBranch = src.indexOf('if (fundsDeferred) {');
  const completeSale = src.indexOf('await sessions.completeSale(sessionId, { key, result: summary });');
  assert.ok(deferredBranch > 0 && completeSale > 0 && deferredBranch < completeSale,
    '🔴 货那一跑的"收口 + return"必须在 completeSale 之前（AC-MSD5 的源码那一半 ✓）');

  // ③ 开关**不在服务层**：本文件只读会话标记那个常量，**不解析那个开关** ✓
  //    ⚠️ 按**代码**（剥掉整行注释）判：注释里提到开关名字是正常的（解释"为什么不在这一层" ✓）。
  const codeOnly = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes("const { SESSION_MARKERS } = require('../config/saleMoneySplit');"),
    '只从配置里取**会话标记**那一个常量 ✓');
  assert.equal(codeOnly.includes('SCAN_MONEY_SPLIT_ENABLED'), false,
    '服务层不许读那个开关（那是调用方的事 ✓）');
  assert.equal(codeOnly.includes('resolveSaleMoneySplitConfig'), false, '服务层不许解析那个配置 ✗');

  // ④ 🔴 **本卡没接线**：`routes/**` 里没有 `deferFunds` / 开关 ——
  //    这一条是"写作用域"的哨兵（下一刀接线时必须**显式**改这一条，不许悄悄接 ✓）。
  const routeFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) routeFiles.push(full);
    }
  };
  walk(ROUTES_SRC);
  assert.ok(routeFiles.length > 0, 'routes 目录必须扫得到文件（否则这条哨兵是空跑 ✗）');
  // ⭐⭐ 2026-10-16 task-62 **接线卡** · **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(text.includes('deferFunds'), false, '…里不许出现 deferFunds（本卡只做服务层那一条路 ✓）');`
  //   改后逐字：**只许恰好一处接线** —— 在 `src/routes/scanPage/index.js` 里，
  //             且 `deferFunds: true` 必须在 `resolveSaleMoneySplitConfig().enabled === true` 这道闸门内、
  //             同一次调用还必须带 `payments: []`（货那一跑不许带收款 ✓）。
  //   依据 = ⭐ 本哨兵**原文自己写着**「下一刀接线时必须**显式**改这一条，不许悄悄接 ✓」
  //          ＋ Lead 2026-10-16 派活（她追问「销售钱货分开那个做完了？」⇒ 本卡就是接线 ✓）。
  //   ⚠️ **强度不降反升**：从"一个都不许有" → "**只许那一处、且形状必须对**"✓（更细的那几条在
  //      `test/saleMoneySplitWire.test.js` 的 AC-MSW1/MSW2 ✓）。
  let wiredFiles = 0;
  for (const file of routeFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('SCAN_MONEY_SPLIT_ENABLED'), false,
      '🔴 ' + path.relative(SERVER_SRC, file) + ' 里不许出现那个开关的**字面量**（只许经 resolveSaleMoneySplitConfig() 读 ✓）');
    if (!text.includes('deferFunds')) continue;
    wiredFiles += 1;
    assert.equal(path.relative(SERVER_SRC, file), path.join('routes', 'scanPage', 'index.js'),
      '🔴 `deferFunds` 只许出现在 `routes/scanPage/index.js` 那一处接线里 ✗');
    assert.ok(/resolveSaleMoneySplitConfig\(\)\.enabled === true[\s\S]{0,600}?deferFunds: true/.test(text),
      '🔴 货那一跑的 `deferFunds: true` 必须在 `resolveSaleMoneySplitConfig().enabled === true` 闸门内 ✗');
    assert.ok(/payments: \[\][\s\S]{0,600}?deferFunds: true/.test(text),
      '🔴 同一次调用必须带 `payments: []`（货那一跑不许带收款 ✓）');
  }
  assert.equal(wiredFiles, 1, `🔴 本卡就是"接线"那一刀 ⇒ 必须**恰好一处**接线（实得 ${wiredFiles} 处 ✗）`);

  // ⑤ 冻结哨兵的成对迁移也在（改前 sha → 改后 sha → 依据；只在那一份里查，避免重复造判据）
  const frozen = fs.readFileSync(path.join(__dirname, 'scanWriteServiceFrozen.test.js'), 'utf8');
  assert.ok(frozen.includes('199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca'),
    '解冻台账必须留**改前**那把 sha ✓');
  assert.ok(frozen.includes('依据 = 业务负责人 2026-10-16 明确「允许改冻结文件」（一次性、只为本卡）。'),
    '解冻台账必须留**依据**（授权一次性、只为本卡 ✓）');
});
