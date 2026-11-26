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
  assert.equal(h.inventoryCalls[1].input.kind, 'STOCK_SALE_DECREASE', '新鞋出库必须用库存环节的「销售减少」');
  assert.equal(h.inventoryCalls[1].input.productRecordId, 'product_old', '换尺码新货品=原货品');
  assert.equal(h.inventoryCalls[1].input.size, 41);
  assert.equal(h.inventoryCalls[1].input.salesEntryRecordId, 'entry_1', '新鞋流水必须挂原销售主表');
  assert.equal(h.inventoryCalls[1].input.salesDetailRecordId, h.inventoryCalls[1].input.sourceRecordId, 'STOCK_SALE_DECREASE 的来源身份必须是新销售明细');

  assert.deepEqual(h.state.entry.fields['售后类型'], ['换货']);
  assert.equal(h.state.entry.fields['售后次数'], 2);
  assert.equal(h.state.entry.fields['鞋类总额'], 180, '差价 0 ⇒ 总金额不变');
  assert.equal(result.newDetail.detail_id, 'XSD-20261111-0001-02');
  assert.equal(result.moneyMode, '');
});

test('AC-EX6 ⭐ 0 元原明细换尺码：只走货，不建钱行（2026-11-26）', async () => {
  const h = makeService();
  h.state.detail.fields['实收金额'] = 0;
  const result = await h.service.execute(basePayload());

  assert.equal(h.state.detail.fields['履约状态'], '已退货');
  assert.equal(h.state.details.length, 2);
  assert.equal(h.state.details[1].fields['实收金额'], 0, '新明细金额 = 原金额 0');
  assert.equal(h.state.payments.length, 1, '差价 0 ⇒ 不动钱（只有原收款行）');
  assert.equal(result.moneyMode, '');
  assert.equal(h.state.entry.fields['售后次数'], 2);
  assert.equal(h.state.entry.fields['鞋类总额'], 180, '总额不变');
});

test('AC-EX7 ⭐ 未收款换款式：不建差价行，原未收款行改成新金额（2026-11-26）', async () => {
  const h = makeService();
  h.state.payments[0].fields['钱款状态'] = '未收款';
  const result = await h.service.execute(basePayload({
    scenario: EXCHANGE.scenarios.NEW_ITEM,
    newProductRecordId: 'product_new',
    newAmount: 200,
    newSize: 41,
  }));

  assert.equal(h.state.payments.length, 1, '不新建差价行');
  const update = h.state.calls.update.find((item) => item.key === 'paymentRecord');
  assert.ok(update, '要把未收款行改成新金额');
  assert.equal(update.recordId, 'pay_1');
  assert.equal(update.fields['交易金额'], 200);
  assert.equal(result.money?.retargeted, true);
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

  assert.equal(h.state.entry.fields['鞋类总额'], 250, '180 + 70');
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
  assert.equal(h.state.entry.fields['鞋类总额'], 150, '180 − 30');
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

test('AC-EX5b 半写入后重试：progress.prepared 存在 ⇒ 不再被已退货原明细拦住', async () => {
  const h = makeService();
  const payload = basePayload();
  const prepared = await h.service.prepare(payload);
  await h.service.store.create({
    request_id: `after_sales_exchange_${payload.requestId}`,
    status: 'prepared',
    payload,
    prepared,
  });
  // 模拟第一次已经改了原明细、随后库存失败
  h.state.detail.fields['履约状态'] = '已退货';
  const result = await h.service.execute(payload);
  assert.equal(h.state.detail.fields['履约状态'], '已退货');
  assert.equal(h.state.details.length, 2, '复用已建的新明细，不再新建第二条');
  assert.equal(h.inventoryCalls.length, 2, '从库存步骤继续执行');
  assert.equal(result.newDetail.record_id, 'new_salesDetail_1');
});

test('AC-EX5 非「已交付」明细 ⇒ 400，零写入', async () => {
  const h = makeService();
  h.state.detail.fields['履约状态'] = '已退货';
  await assert.rejects(h.service.execute(basePayload()), (error) => error.statusCode === 400);
  assert.equal(h.state.calls.create.length, 0);
  assert.equal(h.state.calls.update.length, 0);
});
test('AC-EX6b 原尺码当前无库存 ⇒ 无条件进入候选；选中时回库直接为样品', async () => {
  const h = makeExchangeGateway();
  const promoted = [];
  const inventoryCalls = [];
  const service = new AfterSalesExchangeService({
    gateway: h.gateway,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'as-exchange-sample-original-')),
    now: () => NOW,
    paymentMethods: h.paymentMethods,
    inventory: {
      readLiveInventoryForProduct: async () => [],
      sampleReplacementCandidates: async () => [
        { size: 41, doorBoxCount: 0, sampleCount: 1, warehouseCount: 0 },
      ],
      applyChange: async (input, options) => {
        inventoryCalls.push({ input, options });
        return input.kind === 'STOCK_SALE_DECREASE'
          ? { sampleConsumedQuantity: 1 } : { sampleConsumedQuantity: 0 };
      },
    },
    samples: { promote: async (input) => { promoted.push(input); return { ok: true }; } },
  });
  const result = await service.execute(basePayload({ newSize: 41, samplePromotionSize: 40 }));
  assert.equal(result.newDetail.record_id, 'new_salesDetail_1');
  assert.equal(inventoryCalls[0].input.state, '样品', '原尺码回库直接是样品');
  assert.equal(inventoryCalls[0].options.statePolicy, 'explicit');
  assert.equal(promoted.length, 0, '已经是样品，不再重复 promote');
});

test('AC-EX6 换到只有样品的尺码：要求选另一个尺码补样品，并在出库后执行补样品', async () => {
  const h = makeExchangeGateway();
  const promoted = [];
  const inventoryCalls = [];
  const inventory = {
    readLiveInventoryForProduct: async () => [],
    sampleReplacementCandidates: async () => [
      { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
      { size: 41, doorBoxCount: 0, sampleCount: 1, warehouseCount: 0 },
      { size: 42, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    ],
    applyChange: async (input) => {
      inventoryCalls.push(input);
      return input.kind === 'STOCK_SALE_DECREASE'
        ? { sampleConsumedQuantity: 1 }
        : { sampleConsumedQuantity: 0 };
    },
  };
  const service = new AfterSalesExchangeService({
    gateway: h.gateway,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'as-exchange-sample-')),
    now: () => NOW,
    paymentMethods: h.paymentMethods,
    inventory,
    samples: { promote: async (input) => { promoted.push(input); return { ok: true }; } },
  });

  await assert.rejects(service.execute(basePayload({ newSize: 41 })), (error) => (
    error.statusCode === 400 && /补样品/.test(error.message)
  ));
  assert.equal(inventoryCalls.length, 0, '没选补样品尺码时零库存写入');

  const result = await service.execute(basePayload({ newSize: 41, samplePromotionSize: 42 }));
  assert.equal(result.newDetail.record_id, 'new_salesDetail_1');
  assert.equal(inventoryCalls[0].state, '门盒', '原尺码没被选 ⇒ 回库门盒');
  assert.equal(promoted.length, 1, '扣掉样品后补一个样品');
  assert.equal(promoted[0].productRecordId, 'product_old');
  assert.equal(promoted[0].size, 42);
  assert.equal(promoted[0].salesDetailRecordId, 'new_salesDetail_1');
});