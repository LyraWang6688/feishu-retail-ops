'use strict';

/**
 * 抖音团购券 · 平台结算到账（**按每张券自己的「结算规则」**，三方金额一分不差才改）。
 *
 * AC（业务负责人 2026-11-08 + 2026-11-10 口径）：
 *   AC-VS1  ⭐ 三方金额全等 + 券规则 5 天 ⇒ 结清并通知；
 *   AC-VS2  ⭐ 差 1 分 ⇒ 一笔都不改，只报差异；
 *   AC-VS3  ⭐ 没到结算日 ⇒ 不查平台、不结；
 *   AC-VS4  ⭐ 提现记录缺失 ⇒ 不结；
 *   AC-VS5  ⭐ 已收款/未收款 ⇒ 不处理；
 *   AC-VS6  ⭐ 开关关掉 ⇒ 连表都不读；
 *   AC-VS7  ⭐ 上海自然日边界；
 *   AC-VS8  ⭐ 没有创建时间 ⇒ 跳过；
 *   AC-VS9  ⭐ 没配群 ⇒ 业务照做、只记 chat_missing；
 *   AC-VS10 ⭐ 没配 accountId ⇒ 不执行；
 *   AC-VS11 ⭐ 平台账单查询失败 ⇒ 不结、按差异报；
 *   AC-VS12 ⭐ 单笔结清失败 ⇒ 其余照常、失败笔点名；
 *   AC-VS13 ⭐ 金额换算；
 *   AC-VS14 ⭐ 配置默认 14:00（不再有全局结算天数）；
 *   AC-VS15 ⭐ **两张券不同规则**（5 天 / 7 天）⇒ 各按各的结算日；
 *   AC-VS16 ⭐ 规则解析不出 ⇒ 不结、报「未配置结算规则」；
 *   AC-VS17 ⭐ 券方式未映射 ⇒ 同上（不猜、不结）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createVoucherSettlementService, shanghaiDayOf, addDays, toCents, parseSettleDays,
} = require('../src/services/voucherSettlementService');
const { createVoucherSettlementConfig } = require('../src/config/voucherSettlement');

const PAY_FIELDS = Object.freeze({
  status: '钱款状态', amount: '交易金额', createdAt: '创建时间', receiptId: '交易明细ID', method: '支付方式',
});
const METHOD_FIELDS = Object.freeze({ name: '收款方式', voucher: '团购券管理' });
const VOUCHER_FIELDS = Object.freeze({ settleRule: '结算规则', name: '券名称', externalId: '券ID' });

const shanghai = (y, m, d, hour = 12, minute = 0) => Date.UTC(y, m - 1, d, hour - 8, minute, 0);

const config = (overrides = {}) => ({
  enabled: true,
  accountId: '7365018427183990825',
  pendingStatus: '待平台结算',
  settledStatus: '已收款',
  chatId: 'oc_ops_group',
  texts: {
    groupTitle: '【团购券已结算】',
    lineOf: {
      day: '· 创建 {day}（结算 {settleDay}）：{count} 笔 · ¥{amount}（账单 ¥{bill} / 提现 ¥{withdraw}）',
      mismatch: '⚠️ 差异未结 · 创建 {day}（结算 {settleDay}）：我方 ¥{amount} / 账单 ¥{bill} / 提现 ¥{withdraw}',
      failed: '⚠️ {count} 笔没结清（下次自动重试）：{ids}',
      ruleMissing: '⚠️ 未配置结算规则（未结清）：{ids}',
      footer: '已改为「已收款」并写入收付日',
    },
    accountMissing: '没配账号',
    chatMissing: '没配群',
  },
  ...overrides,
});

const payment = (id, { status = '待平台结算', amount = '85.4', createdAt, method = '抖音代金券（89.9）', receiptId } = {}) => ({
  record_id: id,
  fields: {
    [PAY_FIELDS.status]: status,
    [PAY_FIELDS.amount]: amount,
    [PAY_FIELDS.createdAt]: createdAt,
    [PAY_FIELDS.method]: method,
    [PAY_FIELDS.receiptId]: receiptId || `${id}-收款-01`,
  },
});

const methodRow = (id, name, voucherRecordId) => ({
  record_id: id,
  fields: { [METHOD_FIELDS.name]: name, [METHOD_FIELDS.voucher]: voucherRecordId ? [{ record_ids: [voucherRecordId] }] : [] },
});

const voucherRow = (id, rule, sku = `sku-${id}`) => ({ record_id: id, fields: { [VOUCHER_FIELDS.settleRule]: rule, [VOUCHER_FIELDS.externalId]: sku } });

const ok = (data) => ({ ok: true, data });

const build = ({
  records = [], methods = [methodRow('m1', '抖音代金券（89.9）', 'v1')],
  vouchers = [voucherRow('v1', '核销日+5个自然日')],
  config: cfg = config(), bills = {}, withdraws = {}, billFail = false,
  settleImpl, now = shanghai(2026, 11, 6, 14),
} = {}) => {
  const settled = [];
  const sent = [];
  const billCalls = [];
  const withdrawCalls = [];
  const tables = {
    paymentRecord: { fields: PAY_FIELDS },
    paymentMethod: { fields: METHOD_FIELDS },
    groupBuyVoucher: { fields: VOUCHER_FIELDS },
  };
  const rows = { paymentRecord: records, paymentMethod: methods, groupBuyVoucher: vouchers };
  const gateway = {
    table: (key) => tables[key],
    listAll: async (key) => rows[key] || [],
  };
  const payments = {
    settlePlatformReceipt: async (id, at, options) => {
      settled.push({ id, at, options });
      if (settleImpl) return settleImpl(id, at, options);
      return { record_id: id };
    },
  };
  const laike = {
    settleBill: async (args) => {
      billCalls.push(args);
      if (billFail) return { ok: false, reason: 'upstream_failed' };
      return ok(bills[args.billDate] || { ledger_records: [] });
    },
    settleWithdraw: async (args) => {
      withdrawCalls.push(args);
      return ok(withdraws[args.startDate] || { bill_withdraw_records: [] });
    },
  };
  const service = createVoucherSettlementService({
    gateway, payments, laike, config: cfg, now: () => now,
    sendText: async (chatId, text) => { sent.push({ chatId, text }); },
  });
  return { service, settled, sent, billCalls, withdrawCalls };
};

const billOf = (...entries) => ({
  ledger_records: entries.map((entry) => (
    typeof entry === 'number'
      ? { amount: { goods: entry } }
      : { sku_id: entry.sku, amount: { goods: entry.goods } }
  )),
});
const withdrawOf = (...amounts) => ({ bill_withdraw_records: amounts.map((amount) => ({ amount })) });

test('AC-VS1 ⭐ 三方全等 + 券规则 5 天 ⇒ 结清并通知', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent, billCalls, withdrawCalls } = build({
    records: [payment('rec_1', { createdAt: created }), payment('rec_2', { createdAt: created, amount: '47.4', method: '抖音代金券（49.9）' })],
    methods: [methodRow('m1', '抖音代金券（89.9）', 'v1'), methodRow('m2', '抖音代金券（49.9）', 'v2')],
    vouchers: [voucherRow('v1', '核销日+5个自然日'), voucherRow('v2', '核销日+5个自然日')],
    bills: { '2026-11-01': billOf({ sku: 'sku-v1', goods: 8540 }, { sku: 'sku-v2', goods: 4740 }) },
    withdraws: { '2026-11-06': withdrawOf(13280) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 2, JSON.stringify(out));
  assert.equal(settled.length, 2);
  assert.equal(billCalls[0].billDate, '2026-11-01');
  assert.equal(withdrawCalls[0].startDate, '2026-11-06');
  assert.match(sent[0].text, /2 笔 · ¥132\.80/);
});

test('AC-VS2 ⭐ 差 1 分 ⇒ 一笔都不改', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({
    records: [payment('rec_1', { createdAt: created })],
    bills: { '2026-11-01': billOf(8541) },
    withdraws: { '2026-11-06': withdrawOf(8540) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /差异未结/);
});

test('AC-VS3 ⭐ 没到结算日 ⇒ 不查平台、不结', async () => {
  const created = shanghai(2026, 11, 2, 12);
  const { service, settled, billCalls } = build({ records: [payment('rec_1', { createdAt: created })] });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(billCalls.length, 0);
  assert.equal(settled.length, 0);
});

test('AC-VS4 ⭐ 提现记录缺失 ⇒ 不结', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled } = build({
    records: [payment('rec_1', { createdAt: created })],
    bills: { '2026-11-01': billOf(8540) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0);
});

test('AC-VS5 ⭐ 已收款/未收款 ⇒ 不处理', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled } = build({
    records: [payment('rec_paid', { createdAt: created, status: '已收款' }), payment('rec_unpaid', { createdAt: created, status: '未收款' })],
    bills: { '2026-11-01': billOf(0) },
    withdraws: { '2026-11-06': withdrawOf(0) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(settled.length, 0);
});

test('AC-VS6 ⭐ 开关关掉 ⇒ 连表都不读', async () => {
  let read = 0;
  const service = createVoucherSettlementService({
    gateway: { table: () => ({ fields: PAY_FIELDS }), listAll: async () => { read += 1; return []; } },
    payments: { settlePlatformReceipt: async () => ({}) },
    laike: { settleBill: async () => ok({}), settleWithdraw: async () => ok({}) },
    config: config({ enabled: false }),
  });
  const out = await service.run();
  assert.equal(out.skipped, 'disabled');
  assert.equal(read, 0);
});

test('AC-VS7 ⭐ 上海自然日边界', () => {
  assert.equal(shanghaiDayOf(Date.UTC(2026, 9, 31, 16, 30)), '2026-11-01');
  assert.equal(shanghaiDayOf(Date.UTC(2026, 9, 31, 15, 30)), '2026-10-31');
  assert.equal(addDays('2026-11-01', 5), '2026-11-06');
});

test('AC-VS8 ⭐ 没有创建时间 ⇒ 跳过', async () => {
  const { service, settled } = build({ records: [payment('rec_no_time', { createdAt: undefined })] });
  const out = await service.run();
  assert.equal(out.ok, true);
  assert.equal(out.settledCount, 0);
  assert.equal(settled.length, 0);
});

test('AC-VS9 ⭐ 没配群 ⇒ 业务照做、只记 chat_missing', async () => {
  const warnings = [];
  const created = shanghai(2026, 11, 1, 12);
  const service = createVoucherSettlementService({
    gateway: {
      table: (k) => ({ paymentRecord: { fields: PAY_FIELDS }, paymentMethod: { fields: METHOD_FIELDS }, groupBuyVoucher: { fields: VOUCHER_FIELDS } })[k],
      listAll: async (k) => ({
        paymentRecord: [payment('rec_1', { createdAt: created })],
        paymentMethod: [methodRow('m1', '抖音代金券（89.9）', 'v1')],
        groupBuyVoucher: [voucherRow('v1', '核销日+5个自然日')],
      })[k] || [],
    },
    payments: { settlePlatformReceipt: async () => ({}) },
    laike: { settleBill: async () => ok(billOf({ sku: 'sku-v1', goods: 8540 })), settleWithdraw: async () => ok(withdrawOf(8540)) },
    config: config({ chatId: '' }),
    now: () => shanghai(2026, 11, 6, 14),
    logger: { logInfo: () => {}, logWarn: (...args) => warnings.push(args) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 1);
  assert.equal(out.notified, false);
  assert.ok(warnings.some(([event]) => event === 'voucher.settlement.chat_missing'));
});

test('AC-VS10 ⭐ 没配 accountId ⇒ 不执行', async () => {
  const { service, settled } = build({ records: [payment('rec_1', { createdAt: shanghai(2026, 11, 1, 12) })], config: config({ accountId: '' }) });
  const out = await service.run();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'account_missing');
  assert.equal(settled.length, 0);
});

test('AC-VS11 ⭐ 平台账单查询失败 ⇒ 不结、按差异报', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({ records: [payment('rec_1', { createdAt: created })], billFail: true });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /差异未结/);
});

test('AC-VS12 ⭐ 单笔结清失败 ⇒ 其余照常、失败笔点名', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, sent } = build({
    records: [payment('rec_ok', { createdAt: created }), payment('rec_bad', { createdAt: created })],
    bills: { '2026-11-01': billOf({ sku: 'sku-v1', goods: 17080 }) },
    withdraws: { '2026-11-06': withdrawOf(17080) },
    settleImpl: (id) => {
      if (id === 'rec_bad') throw new Error('飞书 400');
      return { record_id: id };
    },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 1);
  assert.equal(out.failedCount, 1);
  assert.match(sent[0].text, /⚠️ 1 笔没结清/);
});

test('AC-VS13 ⭐ 金额换算', () => {
  assert.equal(toCents('85.4'), 8540);
  assert.equal(toCents('¥85.40'), 8540);
  assert.equal(toCents([{ text: '47.4' }]), 4740);
  assert.equal(toCents(''), 0);
});

test('AC-VS14 ⭐ 配置默认 14:00（不再有全局结算天数）', () => {
  const cfg = createVoucherSettlementConfig({});
  assert.equal(cfg.hour, 14);
  assert.equal(cfg.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'settleDays'), false);
});

test('AC-VS15 ⭐ 两张券不同规则（5 天 / 7 天）⇒ 各按各的结算日', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, withdrawCalls, sent } = build({
    records: [
      payment('rec_a', { createdAt: created }), // 券 v1：5 天 ⇒ 11-06
      payment('rec_b', { createdAt: created, method: '抖音代金券（49.9）' }), // 券 v2：7 天 ⇒ 11-08
    ],
    methods: [methodRow('m1', '抖音代金券（89.9）', 'v1'), methodRow('m2', '抖音代金券（49.9）', 'v2')],
    vouchers: [voucherRow('v1', '核销日+5个自然日'), voucherRow('v2', '核销日+7个自然日')],
    bills: { '2026-11-01': billOf({ sku: 'sku-v1', goods: 8540 }, { sku: 'sku-v2', goods: 8540 }) },
    withdraws: { '2026-11-06': withdrawOf(8540), '2026-11-08': withdrawOf(8540) },
    now: shanghai(2026, 11, 8, 14),
  });
  const out = await service.run();
  assert.equal(out.settledCount, 2, JSON.stringify(out));
  const days = withdrawCalls.map((c) => c.startDate).sort();
  assert.deepEqual(days, ['2026-11-06', '2026-11-08'], '5 天券和 7 天券各查各的结算日');
  assert.match(sent[0].text, /创建 2026-11-01（结算 2026-11-06）/);
  assert.match(sent[0].text, /创建 2026-11-01（结算 2026-11-08）/);
});

test('AC-VS16 ⭐ 规则解析不出 ⇒ 不结、报「未配置结算规则」', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent, billCalls } = build({
    records: [payment('rec_1', { createdAt: created })],
    vouchers: [voucherRow('v1', '')],
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.ruleMissingCount, 1);
  assert.equal(billCalls.length, 0, '没有规则 ⇒ 不去查平台');
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /未配置结算规则/);
});

test('AC-VS17 ⭐ 券方式未映射 ⇒ 不结、不猜', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({
    records: [payment('rec_1', { createdAt: created, method: '未知方式' })],
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.ruleMissingCount, 1);
  assert.equal(out.ruleMissing[0].reason, 'voucher_unmapped');
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /未配置结算规则/);
});

test('AC-VS18 ⭐ 规则文本解析', () => {
  assert.equal(parseSettleDays('核销日+5个自然日'), 5);
  assert.equal(parseSettleDays('核销日+7天'), 7);
  assert.equal(parseSettleDays('T+3'), 3);
  assert.equal(parseSettleDays(''), null);
  assert.equal(parseSettleDays('随便写'), null);
});
