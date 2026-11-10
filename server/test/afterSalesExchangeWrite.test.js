'use strict';

/**
 * 售后换货**写库**验收标准（2026-10-29 定稿 + 2026-11-11 补充）。
 *
 * AC-EX1 换尺码：原明细→已退货；新明细（已交付/交易类型=换货/销售日=当天/金额=原金额）；
 *        两条库存（旧+1 销售增加 / 新−1 现货销售）都挂原主表；不动钱；
 *        主表售后类型+换货、次数+1、总金额不变。
 * AC-EX2 换款式·补差价：新明细金额=她填的实收金额；新建 `-收款-NN`（收入/已收款/差额）；
 *        主表总金额 = 原总金额 + 差价。
 * AC-EX3 换款式·退差价：新建 `-退款-NN`（退回/已退款/差额）；主表总金额 = 原总金额 − 差额；
 *        退款方式必须「可用于退款」，否则 400 且零写入。
 * AC-EX4 幂等：同一 requestId 重放 ⇒ 零新增写入，返回上次结果。
 * AC-EX5 校验：非「已交付」/ 已退货 ⇒ 400，且一个字节都不写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { AfterSalesExchangeService } = require('../src/services/afterSalesExchangeService');
const { EXCHANGE, makeExchangeGateway } = require('./support/exchangeGateway');

const UUID = () => crypto.randomUUID();
const NOW = Date.parse('2026-11-11T12:00:00+08:00');

const makeService = (overrides = {}) => {
  const h = makeExchangeGateway(overrides);
  const inventoryCalls = [];
  const service = new AfterSalesExchangeService({
    gateway: h.gateway,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'as-exchange-')),
    now: () => NOW,
    paymentMethods: h.paymentMethods,
    inventory: {
      applyChange: async (input, options) => {
        inventoryCalls.push({ input, options });
        return [{ behaviorCode: input.kind, state: input.state, quantity: input.quantity }];
      },
    },
  });
  return { service, state: h.state, inventoryCalls, paymentMethods: h.paymentMethods };
};

const basePayload = (overrides = {}) => ({
  requestId: UUID(),
  salesEntryRecordId: 'entry_1',
  detailRecordId: 'detail_1',
  scenario: EXCHANGE.scenarios.SAME_ITEM,
  newSize: 41,
  ...overrides,
});

test('AC-EX1 换尺码：货/库存/主表都对，钱完全不动', async () => {
  const h = makeService();
  const result = await h.service.execute(basePayload());

  assert.equal(h.state.detail.fields['履约状态'], '已退货', '原明细 → 已退货');
  assert.equal(h.state.details.length, 2, '原有 1 条 + 新建 1 条');
  const created = h.state.details[1].fields;
  assert.equal(created['销售明细ID'], 'XSD-20261111-0001-02', '同单号连续排号');
  assert.equal(created['实收金额'], 180, '换尺码 = 原明细金额');
  assert.equal(created['履约状态'], '已交付');
  assert.equal(created['销售日'], NOW, '销售日 = 点击当天');
  assert.deepEqual(created['交易类型'], ['behavior_exchange']);
  assert.deepEqual(created['销售单号'], ['entry_1'], '新明细挂原主表');

  assert.equal(h.state.payments.length, 1, '换尺码不动钱（只有原收款行）');
  assert.equal(h.inventoryCalls.length, 2, '两条库存');
  assert.equal(h.inventoryCalls[0].input.kind, 'STOCK_SALE_INCREASE');
  assert.equal(h.inventoryCalls[0].input.productRecordId, 'product_old');
  assert.equal(h.inventoryCalls[0].input.salesEntryRecordId, 'entry_1', '库存挂原主表');
  assert.equal(h.inventoryCalls[1].input.kind, 'SALE_CASH');
  assert.equal(h.inventoryCalls[1].input.productRecordId, 'product_old', '换尺码新货品=原货品');
  assert.equal(h.inventoryCalls[1].input.size, 41);

  assert.deepEqual(h.state.entry.fields['售后类型'], ['换货']);
  assert.equal(h.state.entry.fields['售后次数'], 2);
  assert.equal(h.state.entry.fields['总金额'], 180, '差价 0 ⇒ 总金额不变');
  assert.equal(result.newDetail.detail_id, 'XSD-20261111-0001-02');
  assert.equal(result.moneyMode, '');
});

test('AC-EX2 换款式·补差价：新明细用她填的金额 + 新建收款明细 + 总金额回填', async () => {
  const h = makeService();
  const result = await h.service.execute(basePayload({
    scenario: EXCHANGE.scenarios.NEW_ITEM,
    newProductRecordId: 'product_new',
    newSize: 42,
    newAmount: 250,
    diffPaymentMethod: '现金',
  }));

  const created = h.state.details[1].fields;
  assert.equal(created['实收金额'], 250);
  assert.deepEqual(created['编号'], ['product_new']);

  assert.equal(h.state.payments.length, 2, '原收款 1 条 + 新建差价 1 条');
  const pay = h.state.payments[1].fields;
  assert.equal(pay['交易明细ID'], 'XSD-20261111-0001-收款-02');
  assert.equal(pay['收支方向'], '收入');
  assert.equal(pay['钱款状态'], '已收款');
  assert.equal(pay['交易金额'], 70);
  assert.deepEqual(pay['关联销售单'], ['entry_1'], '差价明细挂原主表');
  assert.deepEqual(pay['支付方式'], ['pm_cash']);

  assert.equal(h.state.entry.fields['总金额'], 250, '180 + 70');
  assert.equal(result.diffAmount, 70);
  assert.equal(result.moneyMode, 'collect');
});

test('AC-EX3 换款式·退差价：退回明细 + 总金额按差价回填；不可退款方式 400 且零写入', async () => {
  const h = makeService();
  const result = await h.service.execute(basePayload({
    scenario: EXCHANGE.scenarios.NEW_ITEM,
    newProductRecordId: 'product_new',
    newSize: 42,
    newAmount: 150,
    diffPaymentMethod: '现金',
  }));
  const pay = h.state.payments[1].fields;
  assert.equal(pay['交易明细ID'], 'XSD-20261111-0001-退款-02');
  assert.equal(pay['收支方向'], '退回');
  assert.equal(pay['钱款状态'], '已退款');
  assert.equal(pay['交易金额'], 30);
  assert.equal(h.state.entry.fields['总金额'], 150, '180 − 30');
  assert.equal(result.moneyMode, 'refund');

  const bad = makeService();
  await assert.rejects(bad.service.prepare(basePayload({
    scenario: EXCHANGE.scenarios.NEW_ITEM,
    newProductRecordId: 'product_new',
    newSize: 42,
    newAmount: 150,
    diffPaymentMethod: '微信转账', // 未勾「可用于退款」
  })), (error) => error.statusCode === 400 && /不能用于退款/.test(error.message));
  assert.equal(bad.state.calls.create.length, 0, '校验失败零写入');
});

test('AC-EX4 同一 requestId 重放 ⇒ 零新增写入，结果一致', async () => {
  const h = makeService();
  const payload = basePayload({
    scenario: EXCHANGE.scenarios.NEW_ITEM,
    newProductRecordId: 'product_new',
    newSize: 42,
    newAmount: 250,
    diffPaymentMethod: '现金',
  });
  const first = await h.service.execute(payload);
  const createsAfterFirst = h.state.calls.create.length;
  const updatesAfterFirst = h.state.calls.update.length;
  const second = await h.service.execute(payload);
  assert.deepEqual(second, first, '重放返回上次结果');
  assert.equal(h.state.calls.create.length, createsAfterFirst, '不新建行');
  assert.equal(h.state.calls.update.length, updatesAfterFirst, '不重复写');
});

test('AC-EX5 非「已交付」明细 ⇒ 400，零写入', async () => {
  const h = makeService();
  h.state.detail.fields['履约状态'] = '已退货';
  await assert.rejects(h.service.execute(basePayload()), (error) => error.statusCode === 400);
  assert.equal(h.state.calls.create.length, 0);
  assert.equal(h.state.calls.update.length, 0);
});
