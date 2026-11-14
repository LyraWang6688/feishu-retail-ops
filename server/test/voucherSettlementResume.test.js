'use strict';

/**
 * 抖音团购券 · 平台结算「续对账 + 分页」（2026-11-14 审计修复）。
 *
 *   AC-VS18 ⭐ 首轮部分成功 ⇒ 下一轮按整批金额续对账、只补未结项；
 *   AC-VS19 ⭐ 账单/提现拉全分页（100 条/页）后才核对金额；
 *   AC-VS20 ⭐ 平台第二页失败 ⇒ 不结、按查询失败报差异；
 *   AC-VS21 ⭐ 满页但响应没有游标 ⇒ 不结（不拿"只拉了第一页"的金额改收款状态）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createVoucherSettlementService } = require('../src/services/voucherSettlementService');

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
const billOf = (...entries) => ({
  ledger_records: entries.map((entry) => (typeof entry === 'number'
    ? { amount: { goods: entry } }
    : { sku_id: entry.sku, amount: { goods: entry.goods } })),
});
const withdrawOf = (...amounts) => ({ bill_withdraw_records: amounts.map((amount) => ({ amount })) });

const buildService = ({ rows, laike, settleImpl, cfg = config(), now = shanghai(2026, 11, 6, 14), sent = [] }) => {
  const settled = [];
  const service = createVoucherSettlementService({
    gateway: { table: (key) => TABLES[key], listAll: async (key) => rows[key] || [] },
    payments: {
      settlePlatformReceipt: async (id) => {
        if (settleImpl) settleImpl(id);
        settled.push(id);
      },
    },
    laike,
    config: cfg,
    now: () => now,
    sendText: async (chatId, text) => sent.push(text),
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  return { service, settled };
};

// ── 2026-11-14：部分成功后仍能续对账 + 平台分页（对应审计 P1 三处）──────────
const TABLES = Object.freeze({
  paymentRecord: { fields: PAY_FIELDS },
  paymentMethod: { fields: METHOD_FIELDS },
  groupBuyVoucher: { fields: VOUCHER_FIELDS },
});
test('AC-VS18 ⭐ 首轮部分成功后，下一轮按整批金额续对账、只补未结项', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const methods = [methodRow('m1', '抖音代金券（89.9）', 'v1'), methodRow('m2', '抖音代金券（49.9）', 'v2')];
  const vouchers = [voucherRow('v1', '5'), voucherRow('v2', '5')];
  const rows = {
    paymentRecord: [
      payment('rec_a', { createdAt: created }),
      payment('rec_b', { createdAt: created, amount: '47.4', method: '抖音代金券（49.9）' }),
    ],
    paymentMethod: methods,
    groupBuyVoucher: vouchers,
  };
  let failedOnce = false;
  const laike = {
    settleBill: async () => ok(billOf({ sku: 'sku-v1', goods: 8540 }, { sku: 'sku-v2', goods: 4740 })),
    settleWithdraw: async () => ok(withdrawOf(13280)),
  };
  const { service, settled } = buildService({
    rows,
    laike,
    settleImpl: (id) => {
      if (id === 'rec_b' && !failedOnce) {
        failedOnce = true;
        throw new Error('flaky');
      }
    },
  });

  const first = await service.run();
  assert.equal(first.settledCount, 1, JSON.stringify(first));
  assert.equal(first.failedCount, 1);
  assert.deepEqual(settled, ['rec_a']);

  // 已结的 rec_a 不再是「待平台结算」；平台整天账单/提现仍是 132.80。
  rows.paymentRecord = [payment('rec_b', { createdAt: created, amount: '47.4', method: '抖音代金券（49.9）' })];
  const second = await service.run();
  assert.equal(second.settledCount, 1, JSON.stringify(second));
  assert.equal(second.failedCount, 0);
  assert.equal(second.mismatchCount, 0, '续对账不许被"50 ≠ 100"卡死');
  assert.deepEqual(settled, ['rec_a', 'rec_b']);
});

test('AC-VS19 ⭐ 账单/提现拉全分页（100 条/页）后才核对金额', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const billCalls = [];
  const withdrawCalls = [];
  const billPage1 = Array.from({ length: 100 }, (_, index) => ({
    sku_id: 'sku-v1',
    amount: { goods: index === 0 ? 8540 : 0 },
  }));
  const withdrawPage1 = Array.from({ length: 100 }, () => ({ amount: 0 }));
  const laike = {
    settleBill: async ({ cursor }) => {
      billCalls.push(cursor);
      if (cursor === 0) return ok({ ledger_records: billPage1, cursor: 100, has_more: true });
      return ok({ ledger_records: [{ sku_id: 'sku-v1', amount: { goods: 0 } }], has_more: false });
    },
    settleWithdraw: async ({ cursor }) => {
      withdrawCalls.push(cursor);
      if (cursor === 0) return ok({ bill_withdraw_records: withdrawPage1, cursor: 100, has_more: true });
      return ok({ bill_withdraw_records: [{ amount: 8540 }], has_more: false });
    },
  };
  const { service, settled } = buildService({
    rows: {
      paymentRecord: [payment('rec_1', { createdAt: created })],
      paymentMethod: [methodRow('m1', '抖音代金券（89.9）', 'v1')],
      groupBuyVoucher: [voucherRow('v1', '核销日+5个自然日')],
    },
    laike,
  });
  const out = await service.run();
  assert.equal(out.settledCount, 1, JSON.stringify(out));
  assert.deepEqual(settled, ['rec_1']);
  assert.deepEqual(billCalls, [0, 100]);
  assert.deepEqual(withdrawCalls, [0, 100]);
});

test('AC-VS20 ⭐ 平台第二页失败 ⇒ 不结、按查询失败报差异', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const billPage1 = Array.from({ length: 100 }, (_, index) => ({
    sku_id: 'sku-v1',
    amount: { goods: index === 0 ? 8540 : 0 },
  }));
  const laike = {
    settleBill: async ({ cursor }) => {
      if (cursor === 0) return ok({ ledger_records: billPage1, cursor: 100, has_more: true });
      return { ok: false, reason: 'upstream_timeout' };
    },
    settleWithdraw: async () => ok(withdrawOf(8540)),
  };
  const { service, settled } = buildService({
    rows: {
      paymentRecord: [payment('rec_1', { createdAt: created })],
      paymentMethod: [methodRow('m1', '抖音代金券（89.9）', 'v1')],
      groupBuyVoucher: [voucherRow('v1', '核销日+5个自然日')],
    },
    laike,
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.deepEqual(settled, []);
});

test('AC-VS21 ⭐ 满页但响应没有游标 ⇒ 不结（不拿"只拉了第一页"的金额改收款状态）', async () => {
  const created = shanghai(2026, 11, 1, 12);
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    sku_id: 'sku-v1',
    amount: { goods: index === 0 ? 8540 : 0 },
  }));
  const laike = {
    settleBill: async () => ok({ ledger_records: fullPage }), // 满页，无 cursor / has_more
    settleWithdraw: async () => ok(withdrawOf(8540)),
  };
  const { service, settled } = buildService({
    rows: {
      paymentRecord: [payment('rec_1', { createdAt: created })],
      paymentMethod: [methodRow('m1', '抖音代金券（89.9）', 'v1')],
      groupBuyVoucher: [voucherRow('v1', '核销日+5个自然日')],
    },
    laike,
  });
  const out = await service.run();
  assert.equal(out.settledCount, 0);
  assert.equal(out.mismatchCount, 1);
  assert.deepEqual(settled, []);
});
