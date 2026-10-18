'use strict';

/**
 * ⭐⭐ task-62【货 / 钱分离】· **AC-MS-M3 反向哨兵** —— ⭐「**两条线互不依赖**」✓
 *
 * ## 依据（业务负责人 2026-10-16 22:0x 逐字）
 *   「**货就是货，资金就是资金，它俩是独立的呀**：货：看它是现货还是预订。
 *     **如果是现货，就是要扣库存**；如果是预订，就不扣库存，**等二次交付的时候再扣库存**」
 *   「**看货品累计金额和第一次付款金额是不是有差额。有差额后面就要付钱，没差额就是付完了呀**，
 *     两条是独立的线，用同一个销售单号做关联」＋「**啥叫钱没入账就不许出库存？不用呀。**」
 *
 * ## 这一条钉的是什么（一句话）
 *   🔴 **库存扣没扣，都不影响【未收款】那一条的金额** ✓
 *   · 差额 = **货品累计金额 − 第一次付款金额**
 *     （`services/salesOrderService.js` 的 `outstandingCents = totalCents - paidCents` ——
 *      **全仓唯一**那个差额算法 ✓）
 *   · 与「库存那一维」（现货/预订 · 交付 · 实时库存 · 库存流水）**没有任何关系** ✗
 *
 * ## 判据（**先写后做**；每条都能真红 ✓）
 *   **AC-MS-M3** ⭐⭐ **两种库存情形 ⇒ 钱那一维逐字一致**：
 *     同一条销售单、同一份「货」（同货品 / 同实收合计 300）、同一次付款（100）——
 *     只让**库存那一维**不同：
 *       (甲) **现货 ⇒ 货那一跑当场扣库存**（门盒扣掉 · 流水 +1 · 履约 = 已交付 ✓）
 *       (乙) **预订 ⇒ 货那一跑不扣**（门盒还在 · 流水 0 · 履约 = 未交付 ✓）
 *       (乙′) **同一个尺码、只翻「现货 / 预订」这一个开关**（把库存那一维单独隔离出来 ✓）
 *     ⇒ 【未收款】那一条的**金额**、收款行的**形状与顺序**、`owed_amount`、主表「总金额」、
 *       「资金状态」**三次逐字一致** ✓
 *       （库存那一维的差异**一个字都不许渗进钱那一维** ✗）
 *   **AC-MS-M3-R** ⭐ **反向（钱那条线真的在算差额，不是常量）**：
 *     **只改「第一次付款金额」**（一笔不付 / 100 / 250 / 300）⇒ 差额必须**跟着变**
 *     （300 / 200 / 50 / **没有那条**），且**两种库存情形下逐字一致** ✓
 *     ⇒ 「差额跟着库存状态走」这类假实现 ⇒ 这条红 ✓（变异自证见 PR 描述 ✓）
 *
 * ## 与既有判据的分工（**不重复、不放宽**）
 *   · 库存那一维本身（现货扣 / 预订不扣 / 同一条明细不重复扣）＝
 *     `saleMoneySplitDeferFunds.test.js` 的 **AC-MSD3 / MSD3b** ✓
 *   · 业务层那条【未收款】的构造逐字未动 ＝ `saleMoneySplitGoodsHalf.test.js` 的 **AC-MSG4 / MSG8** ✓
 *   · 「少付 ⇒ 恰一条【未收款】（差额 = 累计）」＝ `scanSaleE2E.test.js` 的 **AC-E2E-8** ✓
 *   ⇒ 上面三条**一个字节都没动** ✓；本文件只补它们**都没单独钉**的那一条：**两维之间的独立性** ✓
 *
 * ⚠️ 走的是**真** `scanWriteService.submitSale` ＋ **真** `SalesOrderService` /
 *    `SalesDeliveryService` / `InventoryService`（只有飞书那一层是内存替身）⇒
 *    「库存**真的**扣了 / **真的**没扣」与「差额**真的**是算出来的」都是**跑出来的** ✓
 * ⚠️ 本文件是**纯新增**：既有一条判据都没删 / 没 skip / 没放宽 ✓（**没有成对迁移** ✓）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证（与既有用例同形）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_ms_money_stock';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'ms_money_stock_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../src/config/salesStatusDimensions');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SERVERSRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';

// ── 列名（**只从 schema 取**，不许在用例里写第二份中文列名 ✗）──────────────────────────
const F = (table, key) => V1_BITABLE_SCHEMA.tables[table].fields[key];
const TOTAL = F('salesEntry', 'totalAmount');
const ORDER_NO = F('salesEntry', 'orderNo');
const FUNDS = F('salesEntry', 'writeStatus');
const STOCK = F('salesEntry', 'writeStatus');
const DETAIL_AMOUNT = F('salesDetail', 'actualAmount');
const DETAIL_FULFILLMENT = F('salesDetail', 'fulfillmentStatus');
const PAY_AMOUNT = F('paymentRecord', 'amount');
const PAY_STATUS = F('paymentRecord', 'status');

// ── 夹具（照测试 Base 的真实列形状；与 `saleMoneySplitDeferFunds.test.js` 同一套种子）──────
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
const SIZE_RECORDS = [40, 41].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 一双门盒（"有货"的那一双 —— 现货行扣的就是它）。 */
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedTables = () => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
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
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
const createFakeGateway = (tables = seedTables()) => {
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
      const record = { record_id: `${key}_${sequence}`, fields: physical(key, values) };
      tables[key] = [...(tables[key] || []), record];
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      Object.assign(record.fields, physical(key, values));
      return record;
    },
    // 卖出那一双会把「实时库存」里那条记录**删掉**（既有库存引擎的语义）；别的表一律不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `money-stock-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套"真的在跑"的扫码写链路：真 service ＋ 真业务层 ＋ 真库存引擎，只有飞书那层是替身。 */
const createHarness = () => {
  const gateway = createFakeGateway();
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const replenishDir = tempDir('replenish');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const deliveryCalls = [];
  // ⚠️ 只包一层"记账"（数它被叫了几次）；交付本体仍是**真的** `SalesDeliveryService` ✓。
  const realDelivery = new SalesDeliveryService({ gateway, inventory });
  const delivery = {
    deliver: (input, options) => {
      deliveryCalls.push({ input, options });
      return realDelivery.deliver(input, options);
    },
  };
  const write = createScanWriteService({
    gateway,
    sessions,
    delivery,
    // ⚠️ `readCache: false` ⇒ 本文件注入的 `sales` 与模块自己构造的那一个**逐字等价**。
    sales: new SalesOrderService({ gateway }),
    readCache: false,
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
  });
  // ⭐ 异步（`config.sale.asyncWrite.enabled` 默认开）：货那一跑是"单号先出、余下转后台"——
  //   ⇒ 用例必须**先等后台那一跑跑完**再回读端状态（与既有 AC-MSD 系列同一条约定 ✓）。
  const rawSubmitSale = write.submitSale;
  write.submitSale = async (input) => {
    const result = await rawSubmitSale(input);
    if (!result?.background) return result;
    const rest = await result.background;
    return {
      ...result,
      ...Object.fromEntries(Object.entries(rest || {}).filter(([, value]) => value !== undefined)),
    };
  };
  return {
    write,
    sessions,
    tables: gateway._tables,
    deliveryCalls,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(replenishDir); },
  };
};

const rowsOf = (h, tableKey) => h.tables[tableKey] || [];
const currentKey = async (h, openId) => (await h.sessions.get(openId)).sale.key;

/**
 * 跑一条完整的 **「货那一跑 ⇒ 钱那一跑」**（**同一个销售单号 / 同一把 `submitKey`** ✓），
 * 把**钱那一维**与**库存那一维**的端状态分开如实取回来。
 *
 * ⚠️ 两种情形**只差"扣不扣库存"这一个事实**：
 *    · `inStock: true` ⇒ 那一行是**现货**（`SALE_CASH`）⇒ 货那一跑当场交付 + 扣库存 ✓
 *    · `inStock: false` ⇒ 那一行是**预订**（`SALE_PREPAID`）⇒ 货那一跑不交付、库存不动 ✓
 *   ⇒ "现货 / 预订"是**扣不扣库存的唯一判据**（`config/salesMovements.js` 的 `deliverOnSubmit`）✓
 *
 * @param {{openId:string, size:number, inStock:boolean, paid:number|null}} spec
 *        `paid === null` ⇒ 一笔都没付（= `payments: []`，AC-E2E-8 那条形状 ✓）
 */
const runSplitSale = async ({ openId, size, inStock, paid }) => {
  const h = createHarness();
  try {
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
      size, inStock,
    });
    const submitKey = await currentKey(h, openId);
    // ① 货那一跑（= 她点"提交这一单"、进资金页那一刻）：**只写货**，但**现货照扣库存** ✓
    const goods = await h.write.submitSale({
      openId, submitKey, deferFunds: true, lineAmounts: [300],
    });
    assert.equal(goods.ok, true, JSON.stringify(goods));
    const stockState = {
      deliveryCalls: h.deliveryCalls.length,
      liveInventory: rowsOf(h, 'liveInventory').map((record) => record.record_id),
      ledger: rowsOf(h, 'inventoryLedger').length,
      fulfillment: rowsOf(h, 'salesDetail')[0].fields[DETAIL_FULFILLMENT],
      stockColumn: rowsOf(h, 'salesEntry')[0].fields[STOCK],
      goodsDelivered: goods.stock ? goods.stock.delivered : undefined,
    };
    // ② 钱那一跑（= 她在资金页填了/没填第一笔付款 ⇒ 提交）：**同一个销售单号** ✓
    const money = paid === null
      ? await h.write.submitSale({ openId, submitKey })
      : await h.write.submitSale({ openId, submitKey, payments: [{ method: '微信', amount: paid }] });
    assert.equal(money.ok, true, JSON.stringify(money));
    const master = rowsOf(h, 'salesEntry');
    const moneyState = {
      totalAmount: master[0].fields[TOTAL],
      fundsStatus: master[0].fields[FUNDS],
      // ⚠️ 只留**形状与金额**（收款方式那一列是关联 id，与"差额"这件事无关 ⇒ 不进可比形态）
      payments: rowsOf(h, 'paymentRecord').map((record) => ({
        amount: Number(record.fields[PAY_AMOUNT]), status: record.fields[PAY_STATUS],
      })),
      owedAmount: money.owed_amount,
      paidAmount: money.paid_amount,
      paymentCount: money.payment_count,
      masterCount: master.length,
      detailAmounts: rowsOf(h, 'salesDetail').map((record) => record.fields[DETAIL_AMOUNT]),
      orderNo: master[0].fields[ORDER_NO],
    };
    return { goodsOrderNo: goods.order_no, moneyState, stockState, cleanup: h.cleanup };
  } catch (error) {
    h.cleanup();
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-MS-M3 ⭐⭐ 库存扣了 / 没扣 ⇒ 钱那一维（【未收款】金额 ＋ 差额）逐字一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MS-M3 ⭐⭐ 库存扣了 / 没扣 ⇒【未收款】金额＋差额**逐字一致**（两条线互不依赖）', async () => {
  const runs = [];
  try {
    // (甲) 现货 ⇒ 货那一跑**当场扣库存**。
    const cash = await runSplitSale({ openId: 'ou_m3_cash', size: 40, inStock: true, paid: 100 });
    // (乙) 预订 ⇒ 货那一跑**不扣库存**（生产上 `inStock=false` 就是这么来的）。
    const prepaid = await runSplitSale({ openId: 'ou_m3_prepaid', size: 41, inStock: false, paid: 100 });
    // (乙′) **同一个尺码、只翻「现货 / 预订」这一个开关**：把库存那一维**单独隔离**出来
    //      （否则"货"里连尺码也变了，就证不出"只有库存这一维不同" ✓）。
    const prepaidSameLine = await runSplitSale({ openId: 'ou_m3_prepaid_same', size: 40, inStock: false, paid: 100 });
    runs.push(cash, prepaid, prepaidSameLine);

    // ① 前提：**库存那一维真的不同**（否则后面那条"独立性"是空跑 ✗）。
    assert.equal(cash.stockState.deliveryCalls, 1, '甲：现货 ⇒ 货那一跑**真的**交付了一次');
    assert.equal(cash.stockState.goodsDelivered, 1, '甲：货那一跑如实报"交付了 1 双"');
    assert.deepEqual(cash.stockState.liveInventory, [], '甲：那一双门盒**真的扣掉了**');
    assert.equal(cash.stockState.ledger, 1, '甲：库存流水 +1');
    assert.equal(cash.stockState.fulfillment, '已交付', '甲：履约状态 = 已交付');
    assert.equal(cash.stockState.stockColumn, WRITE.writeStatus.pending, '甲：货那一跑后「写入状态」仍 未完成');
    for (const [label, world] of [['乙（预订·另一尺码）', prepaid], ['乙′（预订·同尺码）', prepaidSameLine]]) {
      assert.equal(world.stockState.deliveryCalls, 0, `${label}：预订 ⇒ 货那一跑**不交付**`);
      assert.equal(world.stockState.goodsDelivered, 0, `${label}：货那一跑如实报"一双都没交付"`);
      assert.deepEqual(world.stockState.liveInventory, ['live_40_box'], `${label}：门盒**还在**（库存没扣 ✓）`);
      assert.equal(world.stockState.ledger, 0, `${label}：零库存流水`);
      assert.equal(world.stockState.fulfillment, '未交付', `${label}：履约状态 = 未交付`);
      assert.equal(world.stockState.stockColumn, WRITE.writeStatus.pending, `${label}：货那一跑后写入状态仍 未完成`);
    }

    // ② 🔴 本判据的正题：**钱那一维三次逐字一致**（含那条【未收款】的金额 = 差额）。
    assert.deepEqual(prepaid.moneyState, cash.moneyState, '库存**没扣** ⇒ 钱那一维一个字都不许变');
    assert.deepEqual(prepaidSameLine.moneyState, cash.moneyState, '只翻「现货/预订」⇒ 钱那一维一个字都不许变');

    // ③ 把"差额"那两个数**逐字念出来**（人要能一眼看见：它就是 累计 − 第一笔付款 ✓）。
    assert.deepEqual(cash.moneyState.payments, [
      { amount: 100, status: '已收款' },
      { amount: 200, status: '未收款' },
    ], '【未收款】那一条的金额 = 差额 = 300 − 100 = 200（**与库存状态无关** ✓）');
    for (const [label, world] of [['甲', cash], ['乙', prepaid], ['乙′', prepaidSameLine]]) {
      assert.equal(world.moneyState.owedAmount, 200, `${label}：差额如实报 200`);
      assert.equal(world.moneyState.totalAmount, 300, `${label}：货品累计金额 300（三种情形同值）`);
      assert.equal(world.moneyState.fundsStatus, WRITE.writeStatus.done, `${label}：「写入状态」由钱那一跑收口为成功`);
      assert.equal(world.moneyState.masterCount, 1, `${label}：钱那一跑**不许再建一张主表**`);
    }

    // ④ 同一个销售单号（她：「**用同一个销售单号做关联**」✓）——货/钱两跑绑在同一张单上。
    for (const [label, world] of [['甲', cash], ['乙', prepaid], ['乙′', prepaidSameLine]]) {
      assert.equal(world.moneyState.orderNo, world.goodsOrderNo, `${label}：钱那一跑仍是货那一跑那个单号`);
      assert.ok(world.moneyState.orderNo, `${label}：单号必须真的有值`);
    }
  } finally { runs.forEach((run) => run.cleanup()); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MS-M3-R ⭐ 反向：只改「第一次付款金额」⇒ 差额跟着变（不是常量 · 且与库存无关）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MS-M3-R ⭐ 只改「第一次付款金额」⇒ 差额**跟着变**（且两种库存情形逐字一致）', async () => {
  const runs = [];
  try {
    // 货品累计金额恒 300；只改"第一次付款金额"：
    //   一笔不付 ⇒ 差额 300 · 付 100 ⇒ 200 · 付 250 ⇒ 50 · 付 300 ⇒ **没有那条**（付完了 ✓）
    const CASES = [
      { paid: null, expectedOwed: 300, label: '一笔不付' },
      { paid: 100, expectedOwed: 200, label: '付 100' },
      { paid: 250, expectedOwed: 50, label: '付 250' },
      { paid: 300, expectedOwed: 0, label: '付 300（付完）' },
    ];
    const stockCases = [
      { tag: 'cash', label: '现货（扣库存）', size: 40, inStock: true, world: 'stock-deducted' },
      { tag: 'prepaid', label: '预订（不扣库存）', size: 41, inStock: false, world: 'stock-untouched' },
    ];
    const grid = {};
    for (const stockCase of stockCases) {
      const column = [];
      for (const item of CASES) {
        const run = await runSplitSale({
          openId: `ou_m3r_${stockCase.tag}_${item.paid === null ? 'none' : item.paid}`,
          size: stockCase.size, inStock: stockCase.inStock, paid: item.paid,
        });
        runs.push(run);
        column.push(run);
      }
      grid[stockCase.world] = column.map((run) => run.moneyState);

      // ① 反向证据：**只动付款金额** ⇒ 差额**真的跟着变**（常量 / 死值 ⇒ 这里红 ✓）。
      assert.deepEqual(
        column.map((run) => run.moneyState.owedAmount),
        CASES.map((item) => item.expectedOwed),
        `${stockCase.label}：差额必须随「第一次付款金额」变（3 个不同的数 ⇒ 不是常量 ✓）`,
      );
      // ② 那条【未收款】的**金额与有无**：差额 > 0 ⇒ 恰一条；差额 ≤ 0 ⇒ **一条都没有** ✓。
      column.forEach((run, index) => {
        const owedRows = run.moneyState.payments.filter((row) => row.status === '未收款');
        const expected = CASES[index];
        if (expected.expectedOwed > 0) {
          assert.deepEqual(owedRows, [{ amount: expected.expectedOwed, status: '未收款' }],
            `${stockCase.label}·${expected.label} ⇒ 恰一条【未收款 ${expected.expectedOwed}】`);
        } else {
          assert.deepEqual(owedRows, [],
            `${stockCase.label}·${expected.label} ⇒ 差额 = 0 ⇒ **不许**出现那条【未收款】`);
        }
      });
      // ③ 前提照旧成立：这一列的**库存那一维**真的是"扣了"或"没扣"（否则独立性是空跑 ✗）。
      const first = column[0];
      if (stockCase.inStock) {
        assert.deepEqual(first.stockState.liveInventory, [], `${stockCase.label}：库存真的扣了`);
        assert.equal(first.stockState.ledger, 1, `${stockCase.label}：流水 +1`);
        assert.equal(first.stockState.fulfillment, '已交付', `${stockCase.label}：履约 = 已交付`);
      } else {
        assert.deepEqual(first.stockState.liveInventory, ['live_40_box'], `${stockCase.label}：库存真的没扣`);
        assert.equal(first.stockState.ledger, 0, `${stockCase.label}：零流水`);
        assert.equal(first.stockState.fulfillment, '未交付', `${stockCase.label}：履约 = 未交付`);
      }
    }
    // ④ ⭐ 两种库存情形：**8 个格子并排比 ⇒ 逐字一致**（钱那一维与库存那一维完全无关 ✓）。
    assert.deepEqual(grid['stock-untouched'], grid['stock-deducted'],
      '库存扣了 / 没扣：钱那一维（4 种付款金额）**逐字一致**');

    // ⑤ 静态锚点：差额在源码里**只由** `totalCents − paidCents` 算出来（**全仓唯一**那个算法 ✓）。
    //    ⚠️ 与 AC-MSG8 分工：那一条钉**那条【未收款】的构造逐字未动**，这一条钉**差额的算法**——
    //      两条不是同一件事，各钉各的 ✓（本文件不改它一个字 ✓）。
    const src = fs.readFileSync(path.join(SERVERSRC, 'services', 'salesOrderService.js'), 'utf8');
    assert.ok(src.includes('const outstandingCents = totalCents - paidCents;'),
      '差额的唯一算法必须是 `totalCents - paidCents`（改成读库存状态 ⇒ 这条红 ✓）');
  } finally { runs.forEach((run) => run.cleanup()); }
});
