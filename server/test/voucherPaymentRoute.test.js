'use strict';

/**
 * ⭐⭐ 2026-10-16（task-57 · 抖音团购券 · 业务负责人逐字）：
 *   「**抖音团购券**……**差额的计算按照面值来**，但是**收款明细里的收款金额按照平台结算款**来」
 *   「是的，抖音团购券的是**待平台结算**」
 *
 * 本文件钉的是**接线那一半**（判据本身已在 main：`test/voucherPaymentRules.test.js` ✓）：
 *   AC-VP1 ⭐ 券行（金额**留空** ✓ 关联列非空即认定是券）⇒ 交出去那一笔 = 【平台结算款】
 *   AC-VP2 ⭐ 差额按【面值】：`balanceDeltaCents` = 面值 − 结算款，从**货品那一侧**扣掉
 *            （她例：货品 300 ＋ 面值 100 的券 ⇒ 未收款 **200** ✓ 而不是 300 − 47.40 = 252.60 ✗）
 *   AC-VP3 ⭐ 领券那一笔收款的状态 = 【**待平台结算**】（`paymentService.record` 按同一判据落 ✓）
 *   AC-VP4 ⭐ **券方式金额可空**：一行券都没有时**原样返回**（不拦、也不读券目录 ✓）
 *   AC-VP5 🔴 认不出那张券 ⇒ **大声 warn `scan.write.voucher_method_unmapped`** + **拦住**（绝不当普通收款 ✗）
 *   AC-VP6 🔴 券目录里在售、却没被任何收款方式关联 ⇒ 同样打那个事件（**不拦单** ✓ 但绝不静默 ✗）
 *   AC-VP7 🔴 收款方式表读不到：有**金额空**的行 ⇒ 拦住；每行都有金额 ⇒ 原样放行（+ warn）
 *   AC-VP8 ⭐ 路由接线：资金页那一发交出去的 `payments` 与 `lineAmounts` 就是上面那两个口径
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_vp';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'vp_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'vp_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createPaymentMethodsService } = require('../src/services/paymentMethodsService');
const { createVoucherPaymentService } = require('../src/services/voucherPaymentService');
const { PaymentService } = require('../src/services/paymentService');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { VOUCHER_METHOD_UNMAPPED_EVENT } = require('../src/config/voucherPayment');

const VOUCHER_METHOD = '抖音团购券（47.40）';
/** ⭐ 她截图里的真值：面值 100 / 平台结算款 47.40（另一张 85.40）✓ */
const VOUCHER_ROW = {
  record_id: 'rec_v1',
  fields: { 券名称: '47.4抵100', 售价: 47.4, 面值: 100, 平台结算款: 47.4, 销售状态: '在售' },
};

/** 假的「收款方式管理」＋「团购券管理」两张表（**关联列非空** = 券 ✓）。 */
const tableGateway = ({ methods, vouchers = [VOUCHER_ROW], calls = [] } = {}) => ({
  async listAll(tableKey) {
    calls.push(tableKey);
    if (tableKey === 'paymentMethod') return methods;
    if (tableKey === 'groupBuyVoucher') return vouchers;
    return [];
  },
  table(key) { return { tableId: `tbl_${key}` }; },
});

const methodRows = () => [
  { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
  { record_id: 'pm_v1', fields: { 收款方式: VOUCHER_METHOD, 团购券管理: ['rec_v1'] } },
];

const serviceOf = (gateway, options = {}) => createVoucherPaymentService({
  gateway,
  paymentMethods: createPaymentMethodsService(gateway, options),
});

const warningsOf = (fn) => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  return Promise.resolve().then(fn).finally(() => { console.warn = original; })
    .then((value) => ({ value, warns: warns.map((line) => JSON.parse(line)) }));
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-VP1 / AC-VP2 ⭐ 一张券两个数各归各位（面值算差额 / 结算款入明细）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-VP1/AC-VP2 ⭐ 券行（金额留空）⇒ 明细那笔 =【平台结算款】；差额侧扣 (面值 − 结算款)', async () => {
  const service = serviceOf(tableGateway({ methods: methodRows() }));
  const out = await service.resolveRows([
    { method: VOUCHER_METHOD, amount: '' },
    { method: '现金', amount: '200' },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.payments, [
    { method: VOUCHER_METHOD, amount: 47.4 },
    { method: '现金', amount: '200' },
  ], '券那一行的金额 = 平台结算款（**不是面值 100** ✗）；非券行**原样** ✓');
  assert.equal(out.faceValueCents, 10000, '面值 100 元');
  assert.equal(out.balanceDeltaCents, 5260, '面值 − 结算款 = 52.60（要从**货品那一侧**扣掉）');
  // 她例：货品 300 ＋ 面值 100 的券 ⇒ 未收款 200 ✓
  const adjusted = service.adjustLineAmounts(['300'], out.balanceDeltaCents);
  assert.deepEqual(adjusted.amounts, ['247.4'], '货品那一侧 = 300 − 52.60 = 247.40');
  const owed = Math.round(Number(adjusted.amounts[0]) * 100) - Math.round(47.4 * 100);
  assert.equal(owed / 100, 200, '差额（未收款）= 247.40 − 47.40 = **200** ✓（按面值算 ✓）');
  assert.notEqual(owed / 100, 300 - 47.4, '⭐ 按结算款算会得到 252.60 ✗ —— 两种算法**必须不同**（否则这条是空跑）');
});

test('AC-VP2b ⭐ 券行金额**留空也算这一笔**（绝不做成"没有这一笔"⇒ 差额变"一分没付" ✗）', async () => {
  const service = serviceOf(tableGateway({ methods: methodRows() }));
  const out = await service.resolveRows([{ method: VOUCHER_METHOD, amount: '' }]);
  assert.equal(out.payments.length, 1, '这一行**必须在**（留空只是"她不用填"，不是"没这笔" ✗）');
  assert.equal(Number(out.payments[0].amount), 47.4, '金额由券目录给（平台结算款）');
});

test('AC-VP2c ⭐ 多行扣不下时如实回传（不扣成负数 ✗ 也不静默丢一笔钱 ✗）', async () => {
  const service = serviceOf(tableGateway({ methods: methodRows() }));
  const out = service.adjustLineAmounts(['10', '', '20'], 5260);
  assert.deepEqual(out.amounts, ['0', '', '0'], '逐行扣到 0 为止（**不许负**）');
  assert.equal(out.appliedCents, 3000, '只扣得下 30 元');
  assert.equal(out.unappliedCents, 2260, '扣不下的如实回传');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-VP4 ⭐ 没有券 ⇒ 逐字原样（不读券目录、不拦）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-VP4 ⭐ 一行券都没有 ⇒ 原样返回、**券目录一次都不读**（既有链路逐字不变 ✓）', async () => {
  const calls = [];
  const service = serviceOf(tableGateway({ methods: methodRows(), calls }));
  calls.length = 0;
  const out = await service.resolveRows([{ method: '现金', amount: '300' }]);
  assert.deepEqual(out.payments, [{ method: '现金', amount: '300' }], '原样');
  assert.equal(out.balanceDeltaCents, 0, '没有券就不扣');
  assert.deepEqual(calls, ['paymentMethod'], '只读了收款方式表（**没有**读团购券管理 ✗）');
});

test('AC-VP4b ⭐ 券方式、但金额她填了数也照旧换口径（收款明细那一笔永远是结算款 ✓）', async () => {
  const service = serviceOf(tableGateway({ methods: methodRows() }));
  const out = await service.resolveRows([{ method: VOUCHER_METHOD, amount: '100' }]);
  assert.equal(Number(out.payments[0].amount), 47.4, '写进库的是平台结算款（她填的面值不落表 ✓ 口径②）');
  assert.equal(out.balanceDeltaCents, 5260, '差额侧仍按面值扣 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-VP5 / AC-VP6 / AC-VP7 🔴 缺映射 / 读不到 ⇒ 大声（绝不静默 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test(`AC-VP5 🔴 券方式认不出那张券 ⇒ 打 \`${VOUCHER_METHOD_UNMAPPED_EVENT}\` + 拦住（不当普通收款 ✗）`, async () => {
  const gateway = tableGateway({ methods: methodRows(), vouchers: [] });
  const service = serviceOf(gateway);
  const { value, warns } = await warningsOf(() => service.resolveRows([{ method: VOUCHER_METHOD, amount: '' }]));
  assert.equal(value.ok, false, '认不出 ⇒ **拦住这一单**（一个字都不写 ✓）');
  assert.equal(value.reason, 'voucher_method_unmapped');
  const entry = warns.find((item) => item.event === VOUCHER_METHOD_UNMAPPED_EVENT);
  assert.ok(entry, `必须**大声** warn（实际 warns=${JSON.stringify(warns)}）`);
  assert.equal(entry.method, VOUCHER_METHOD, '日志要写清是**哪条方式**认不出');
  assert.equal(entry.voucher_record_id, 'rec_v1', '以及它关联到哪个券记录 id');
});

test('AC-VP6 🔴 在售券没有被任何收款方式关联 ⇒ 同样打那个事件（不拦单 ✓ 但绝不静默 ✗）', async () => {
  // 「团购券管理」里有两张在售券，收款方式表只关联了 rec_v1 ⇒ rec_v2 她**根本点不到**
  const gateway = tableGateway({
    methods: [{ record_id: 'pm_cash', fields: { 收款方式: '现金' } },
      { record_id: 'pm_v1', fields: { 收款方式: VOUCHER_METHOD, 团购券管理: ['rec_v1'] } }],
    vouchers: [VOUCHER_ROW, {
      record_id: 'rec_v2',
      fields: { 券名称: '85.4抵100', 售价: 85.4, 面值: 100, 平台结算款: 85.4, 销售状态: '在售' },
    }],
  });
  const service = serviceOf(gateway);
  // 她这一单确实用了券（rec_v1）⇒ 券目录会被读到（**没券的单子不读** ✓ 见 AC-VP4）⇒ 顺手把"点不到的券"报出来 ✓
  const { value, warns } = await warningsOf(() => service.resolveRows([{ method: VOUCHER_METHOD, amount: '' }]));
  assert.equal(value.ok, true, '与这一单无关 ⇒ **不拦单** ✓');
  const entry = warns.find((item) => item.event === VOUCHER_METHOD_UNMAPPED_EVENT);
  assert.ok(entry, '在售券没人关联 ⇒ 必须大声 warn（不许静默 ✗）');
  assert.equal(entry.count, 1, '如实带上有几张券点不到');
  assert.deepEqual(entry.voucher_record_ids, ['rec_v2'], '并写清是哪一张');
});

test('AC-VP7 🔴 收款方式表读不到：有**金额空**的行 ⇒ 拦住；每行都有金额 ⇒ 原样放行 + warn', async () => {
  const broken = { async listAll() { throw new Error('bitable 503'); }, table() { return { tableId: 't' }; } };
  const service = serviceOf(broken);
  const first = await warningsOf(() => service.resolveRows([{ method: '现金', amount: '' }]));
  assert.equal(first.value.ok, false, '有金额空的行 ⇒ 认不出是不是券 ⇒ **拦住**（不静默当普通收款 ✗）');
  assert.ok(first.warns.find((item) => item.event === VOUCHER_METHOD_UNMAPPED_EVENT), '拦住也要大声');

  const second = await warningsOf(() => service.resolveRows([{ method: '现金', amount: '300' }]));
  assert.equal(second.value.ok, true, '每行都有金额（没有"券被整行丢掉"的风险）⇒ 原样放行 ✓');
  assert.deepEqual(second.value.payments, [{ method: '现金', amount: '300' }], '原样');
  assert.ok(second.warns.find((item) => item.event === VOUCHER_METHOD_UNMAPPED_EVENT), '放行也要大声');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-VP3 ⭐ 领券那一笔收款的状态 =【待平台结算】（写入层按同一判据落）
// ═══════════════════════════════════════════════════════════════════════════

const recordGateway = ({ create }) => ({
  async listAll(tableKey) {
    if (tableKey === 'paymentMethod') return methodRows();
    return [];
  },
  table(key) { return { tableId: `tbl_${key}`, fields: { name: '收款方式', voucher: '团购券管理' } }; },
  async create(tableKey, fields) { create.push({ tableKey, fields }); return { record_id: 'pr_1' }; },
});

test('AC-VP3 ⭐ 券方式的收款 ⇒ 状态【待平台结算】（不收 `收款时间`、不写方向 ✓）', async () => {
  const created = [];
  const payments = new PaymentService({ gateway: recordGateway({ create: created }) });
  await payments.record({
    salesEntryRecordId: 'entry_1', method: VOUCHER_METHOD, amount: 47.4,
  }, { receiptId: 'XSD-20261016-0001-收款-01' });
  assert.equal(created.length, 1);
  assert.equal(created[0].fields.status, '待平台结算', '她逐字：「抖音团购券的是**待平台结算**」');
  assert.equal(created[0].fields.amount, 47.4, '金额仍是调用方给的**平台结算款** ✓');
  assert.equal(created[0].fields.receivedAt, undefined, '钱还在平台上 ⇒ 不许写收款时间 ✗');
  assert.equal(created[0].fields.tradeDirection, undefined, '没到账 ⇒ 不写方向 ✗');
});

test('AC-VP3b ⭐ 非券方式一个字都不变（已收款 + 收款时间 + 方向 ✓）；显式状态以调用方为准 ✓', async () => {
  const created = [];
  const payments = new PaymentService({ gateway: recordGateway({ create: created }) });
  await payments.record({ salesEntryRecordId: 'entry_1', method: '现金', amount: 100 }, { receiptId: 'r1' });
  assert.equal(created[0].fields.status, '已收款', '非券照旧');
  assert.ok(created[0].fields.receivedAt > 0, '真收到钱 ⇒ 写收款时间 ✓');
  assert.equal(created[0].fields.tradeDirection, '收入', '真到账才写方向 ✓');

  created.length = 0;
  await payments.record({
    salesEntryRecordId: 'entry_1', method: VOUCHER_METHOD, amount: 47.4, status: '已收款',
  }, { receiptId: 'r2' });
  assert.equal(created[0].fields.status, '已收款', '**显式**给过状态 ⇒ 以调用方为准（群聊那条链路逐字不变 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-VP8 ⭐ 路由接线：资金页那一发交出去的 payments / lineAmounts 就是那两个口径
// ═══════════════════════════════════════════════════════════════════════════

const COOKIE = (() => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    open_id: 'ou_vp', name: '自检', exp: Date.now() + 36e5,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

const NUMBER = 'JX505|咖色|B';
const VIEW = () => ({
  found: true, number: NUMBER, item_no: 'JX505', color: '咖色', category_name: '休闲鞋',
  price_text: '¥300', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});

/** 走**真路由**：只把她那一发交出去的 `submitSale` 入参接住（写服务换成替身 ✓ 一条都不真写 ✓）。 */
const withServer = async (gateway, run) => {
  const captured = [];
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_vp'; next(); });
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway,
    config: SCAN_PAGE,
    startSnapshot: false,
    service: { lookup: async () => VIEW() },
    writeService: {
      sessions: {
        // 她先在货品页填了「每件实收 300」⇒ 会话草稿行 + submitPending 都记着它 ✓
        get: async () => ({
          sale: {
            paymentStep: 'pending',
            lines: [{ item_no: 'JX505', size: '40', amount: '300' }],
            submitPending: { size: '40', amount: '300', lineAmounts: ['300'] },
          },
        }),
        setLastRealm: async () => {},
        submitKeyFor: () => 'scan_sale:vp:1',
      },
      submitSale: async (input) => {
        captured.push(input);
        return { ok: true, order_no: 'XSD-20261016-0001', detail_count: 1, payment_count: 1 };
      },
    },
  }));
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base, captured); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const postPay = (base, body) => fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
  method: 'POST',
  headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    action: SCAN_PAGE.paymentStep.payAction, submit_key: 'scan_sale:vp:1', ...body,
  }).toString(),
});

test('AC-VP8 ⭐ 资金页点按钮：交出去的 payments =【结算款】、lineAmounts =【货品 − (面值 − 结算款)】', async () => {
  await withServer(tableGateway({ methods: methodRows() }), async (base, captured) => {
    // 她只选了券、**金额留空**（券的金额本来就可以不填 ✓）；货品那一侧是 300
    const response = await postPay(base, {
      [SCAN_WRITE.fields.paymentMethod]: VOUCHER_METHOD,
      [SCAN_WRITE.fields.paymentAmount]: '',
    });
    assert.equal(response.status, 200, '券方式金额留空**不许被拦**（也不许 400 ✓）');
    assert.equal(captured.length, 1, '该建单那一刻交了一次（幂等键没拆 ✓）');
    const input = captured[0];
    assert.deepEqual(input.payments, [{ method: VOUCHER_METHOD, amount: 47.4 }],
      '收款明细那一笔的金额 =【平台结算款】✓（不是面值 100 ✗）');
    assert.deepEqual(input.lineAmounts, ['247.4'],
      '货品那一侧已扣掉券的 (面值 − 结算款)：300 − 52.60 = 247.40 ⇒ 差额 = 200 ✓（按面值算 ✓）');
  });
});

test('AC-VP8b 🔴 券认不出 ⇒ 拦住那一单（400 + 人话 + **零写入**）+ 打那个事件', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  try {
    // 券方式关联到一个**不在券目录里**的记录 ⇒ 认不出
    await withServer(tableGateway({
      methods: [{ record_id: 'pm_v1', fields: { 收款方式: VOUCHER_METHOD, 团购券管理: ['rec_missing'] } }],
      vouchers: [VOUCHER_ROW],
    }), async (base, captured) => {
      const response = await postPay(base, {
        [SCAN_WRITE.fields.paymentMethod]: VOUCHER_METHOD,
        [SCAN_WRITE.fields.paymentAmount]: '',
      });
      assert.equal(response.status, 400, '拦住（"她能改"的那一类 ⇒ 400 ✓）');
      assert.equal(captured.length, 0, '🔴 **一个字都不许写**（不许当普通收款记一笔 ✗）');
      const html = await response.text();
      assert.match(html, /data-view="payment-step"/, '停在资金页给她改 ✓');
      const entry = warns.map((line) => JSON.parse(line))
        .find((item) => item.event === VOUCHER_METHOD_UNMAPPED_EVENT);
      assert.ok(entry, '必须**大声** warn（不许静默 ✗）');
    });
  } finally { console.warn = original; }
});

test('AC-VP8c ⭐ 没有券的正常收款：交出去的两个数组**逐字不变**（回归哨兵 ✓）', async () => {
  await withServer(tableGateway({ methods: methodRows() }), async (base, captured) => {
    const response = await postPay(base, {
      [SCAN_WRITE.fields.paymentMethod]: '现金',
      [SCAN_WRITE.fields.paymentAmount]: '300',
    });
    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].payments, [{ method: '现金', amount: '300' }], '非券行原样');
    assert.deepEqual(captured[0].lineAmounts, ['300'], '没有券就不动货品那一侧 ✓');
  });
});
