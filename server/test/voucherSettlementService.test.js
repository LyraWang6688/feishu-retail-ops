'use strict';

/**
 * 抖音团购券 · 平台结算到账（按日期对平，一分不差才改）。
 *
 * AC（对业务负责人 2026-11-08 口径逐条钉住）：
 *   AC-VS1 ⭐ 三方金额完全相等 ⇒ 该创建日全部结清 + 群通知；
 *   AC-VS2 ⭐ 差 **1 分** ⇒ 一笔都不改，只在群里报差异（「必须一分不差」）；
 *   AC-VS3 ⭐ 没到结算日（创建日 + 5）⇒ 不查平台、不结；
 *   AC-VS4 ⭐ 提现记录缺失 ⇒ 不结（账单对、提现没对也不算到账）；
 *   AC-VS5 ⭐ 已收款 / 未收款 ⇒ 不处理（幂等）；
 *   AC-VS6 ⭐ 开关关掉 ⇒ 连表都不读；
 *   AC-VS7 ⭐ 上海自然日边界：UTC 16:30 = 上海次日 00:30；
 *   AC-VS8 ⭐ 没有创建时间的记录 ⇒ 跳过、不崩；
 *   AC-VS9 ⭐ 没配群 ⇒ 业务照做，只记 chat_missing；
 *   AC-VS10 ⭐ 没配 accountId ⇒ 不执行（reason=account_missing）；
 *   AC-VS11 ⭐ 平台账单查询失败 ⇒ 不结、按差异报（不带病改数据）；
 *   AC-VS12 ⭐ 单笔结清失败 ⇒ 其余照常，失败笔点名；
 *   AC-VS13 ⭐ 金额换算：'85.4' / '¥85.40' ⇒ 8540 分。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createVoucherSettlementService, shanghaiDayOf, addDays, toCents,
} = require('../src/services/voucherSettlementService');
const { createVoucherSettlementConfig } = require('../src/config/voucherSettlement');

const FIELDS = Object.freeze({
  status: '钱款状态',
  amount: '交易金额',
  createdAt: '创建时间',
  receiptId: '交易明细ID',
});

const shanghai = (y, m, d, hour = 12, minute = 0) => Date.UTC(y, m - 1, d, hour - 8, minute, 0);

const config = (overrides = {}) => ({
  enabled: true,
  settleDays: 5,
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
      footer: '已改为「已收款」并写入收付日',
    },
    accountMissing: '没配账号',
    chatMissing: '没配群',
  },
  ...overrides,
});

const record = (id, { status = '待平台结算', amount = '85.4', createdAt, receiptId } = {}) => ({
  record_id: id,
  fields: {
    [FIELDS.status]: status,
    [FIELDS.amount]: amount,
    [FIELDS.createdAt]: createdAt,
    [FIELDS.receiptId]: receiptId || `${id}-收款-01`,
  },
});

const ok = (data) => ({ ok: true, data });

const build = ({
  records = [], config: cfg = config(), bills = {}, withdraws = {},
  billFail = false, settleImpl, now = shanghai(2026, 11, 6, 14),
} = {}) => {
  const settled = [];
  const sent = [];
  const billCalls = [];
  const withdrawCalls = [];
  const gateway = { table: () => ({ fields: FIELDS }), listAll: async () => records };
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

const billOf = (...goodsCents) => ({ ledger_records: goodsCents.map((goods) => ({ amount: { goods } })) });
const withdrawOf = (...amounts) => ({ bill_withdraw_records: amounts.map((amount) => ({ amount })) });

test('AC-VS1 ⭐ 三方金额全等 ⇒ 全部结清 + 通知', async () => {
  const created = shanghai(2026, 11, 1, 12); // 创建日 11-01 ⇒ 结算日 11-06
  const { service, settled, sent, billCalls, withdrawCalls } = build({
    records: [
      record('rec_1', { createdAt: created, amount: '85.4' }),
      record('rec_2', { createdAt: created, amount: '47.4' }),
    ],
    bills: { '2026-11-01': billOf(8540, 4740) },
    withdraws: { '2026-11-06': withdrawOf(13280) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 2, JSON.stringify(out));
  assert.equal(out.mismatchCount, 0);
  assert.equal(settled.length, 2);
  assert.equal(settled[0].options.correlation.settle_day, '2026-11-06');
  assert.equal(billCalls[0].billDate, '2026-11-01', '账单按创建日查');
  assert.equal(withdrawCalls[0].startDate, '2026-11-06', '提现按结算日查');
  assert.equal(withdrawCalls[0].endDate, '2026-11-06');
  assert.match(sent[0].text, /创建 2026-11-01（结算 2026-11-06）：2 笔 · ¥132\.80（账单 ¥132\.80 \/ 提现 ¥132\.80）/);
});

test('AC-VS2 ⭐ 差 1 分 ⇒ 一笔都不改，只报差异', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({
    records: [record('rec_1', { createdAt: created, amount: '85.4' })],
    bills: { '2026-11-01': billOf(8541) }, // 账单多 1 分
    withdraws: { '2026-11-06': withdrawOf(8540) },
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0, '差一分也不许改');
  assert.match(sent[0].text, /差异未结/);
  assert.match(sent[0].text, /我方 ¥85\.40 \/ 账单 ¥85\.41 \/ 提现 ¥85\.40/);
});

test('AC-VS3 ⭐ 没到结算日 ⇒ 不查平台、不结', async () => {
  const created = shanghai(2026, 11, 2, 12); // 结算日 11-07 > 今天 11-06
  const { service, settled, billCalls, withdrawCalls, sent } = build({
    records: [record('rec_1', { createdAt: created })],
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(settled.length, 0);
  assert.equal(billCalls.length, 0);
  assert.equal(withdrawCalls.length, 0);
  assert.equal(sent.length, 0);
});

test('AC-VS4 ⭐ 提现记录缺失 ⇒ 不结（账单对也不算到账）', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({
    records: [record('rec_1', { createdAt: created })],
    bills: { '2026-11-01': billOf(8540) },
    withdraws: {}, // 没有提现
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /提现 ¥0\.00/);
});

test('AC-VS5 ⭐ 已收款 / 未收款 ⇒ 不处理', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled } = build({
    records: [
      record('rec_paid', { createdAt: created, status: '已收款' }),
      record('rec_unpaid', { createdAt: created, status: '未收款' }),
    ],
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
    gateway: { table: () => ({ fields: FIELDS }), listAll: async () => { read += 1; return []; } },
    payments: { settlePlatformReceipt: async () => ({}) },
    laike: { settleBill: async () => ok({}), settleWithdraw: async () => ok({}) },
    config: config({ enabled: false }),
  });
  const out = await service.run();
  assert.equal(out.skipped, 'disabled');
  assert.equal(read, 0);
});

test('AC-VS7 ⭐ 上海自然日边界：UTC 16:30 = 上海次日 00:30', async () => {
  const lateNight = Date.UTC(2026, 9, 31, 16, 30); // 上海 11-01 00:30
  const beforeMidnight = Date.UTC(2026, 9, 31, 15, 30); // 上海 10-31 23:30
  assert.equal(shanghaiDayOf(lateNight), '2026-11-01');
  assert.equal(shanghaiDayOf(beforeMidnight), '2026-10-31');
  assert.equal(addDays('2026-11-01', 5), '2026-11-06');
});

test('AC-VS8 ⭐ 没有创建时间的记录 ⇒ 跳过、不崩', async () => {
  const { service, settled } = build({
    records: [record('rec_no_time', { createdAt: undefined })],
  });
  const out = await service.run();
  assert.equal(out.ok, true);
  assert.equal(out.settledCount, 0);
  assert.equal(settled.length, 0);
});

test('AC-VS9 ⭐ 没配群 ⇒ 业务照做，只记 chat_missing', async () => {
  const warnings = [];
  const service = createVoucherSettlementService({
    gateway: {
      table: () => ({ fields: FIELDS }),
      listAll: async () => [record('rec_1', { createdAt: shanghai(2026, 11, 1, 12) })],
    },
    payments: { settlePlatformReceipt: async () => ({}) },
    laike: {
      settleBill: async () => ok(billOf(8540)),
      settleWithdraw: async () => ok(withdrawOf(8540)),
    },
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
  const { service, settled } = build({ records: [record('rec_1', { createdAt: shanghai(2026, 11, 1, 12) })], config: config({ accountId: '' }) });
  const out = await service.run();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'account_missing');
  assert.equal(settled.length, 0);
});

test('AC-VS11 ⭐ 平台账单查询失败 ⇒ 不结、按差异报', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, settled, sent } = build({
    records: [record('rec_1', { createdAt: created })],
    billFail: true,
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.equal(settled.length, 0);
  assert.match(sent[0].text, /差异未结/);
});

test('AC-VS12 ⭐ 单笔结清失败 ⇒ 其余照常、失败笔点名', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const { service, sent } = build({
    records: [
      record('rec_ok', { createdAt: created }),
      record('rec_bad', { createdAt: created }),
    ],
    bills: { '2026-11-01': billOf(17080) },
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
  assert.match(sent[0].text, /rec_bad-收款-01/);
});

test('AC-VS13 ⭐ 金额换算：85.4 / ¥85.40 ⇒ 8540 分', () => {
  assert.equal(toCents('85.4'), 8540);
  assert.equal(toCents('¥85.40'), 8540);
  assert.equal(toCents([{ text: '47.4' }]), 4740);
  assert.equal(toCents(85.4), 8540);
  assert.equal(toCents(''), 0);
});

test('AC-VS14 ⭐ 配置默认：14:00 跑、结算 5 天', () => {
  const cfg = createVoucherSettlementConfig({});
  assert.equal(cfg.hour, 14);
  assert.equal(cfg.settleDays, 5);
  assert.equal(cfg.enabled, true);
});
