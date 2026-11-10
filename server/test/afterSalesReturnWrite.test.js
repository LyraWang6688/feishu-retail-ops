'use strict';

/**
 * 售后退货**写库**的验收标准（2026-10-29 业务负责人定稿口径，2026-11-08 落库）。
 *
 * AC-RW1 **直接退款**：原明细→已退货；库存「销售增加」1 双落门盒；新建 S交易明细
 *        （`{单号}-退款-02` · 支付方式 · 收支方向=退回 · 已退款 · 收付日=点击当天 · 金额=明细金额）；
 *        原单「售后类型」+退货、「售后次数」+1。
 * AC-RW2 **货款留存**：同样新建交易明细，但支付方式/收支方向**不填**、钱款状态=已留存。
 * AC-RW3 幂等：同一 requestId 再跑一次 ⇒ 零新增写入（返回上次结果）。
 * AC-RW4 校验：非「已交付」/ 已退过 / 缺金额 / 退款未选方式 ⇒ 400，且**一个字节都不写**。
 * AC-RW5 异步队列：入队后台执行；临时失败重试；最终失败标 failed（不假成功）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { AfterSalesReturnService } = require('../src/services/afterSalesReturnService');
const { createAfterSalesAsyncService } = require('../src/services/afterSalesAsyncService');
const { AFTER_SALES_DERIVED } = require('../src/config/afterSalesDerived');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const UUID = () => crypto.randomUUID();
const ENTRY = 'entry_1';
const DETAIL = 'detail_1';
const SIZE_ID = 'size_40';
const PRODUCT = 'prod_1';
const ORDER_NO = 'XSD-20261028-0005';

const makeGateway = (overrides = {}) => {
  const tables = {
    salesEntry: { fields: { orderNo: '销售单号', afterSalesType: '售后类型', afterSalesCount: '售后次数' } },
    salesDetail: {
      fields: {
        salesEntry: '销售单号', product: '编号', size: '尺码', fulfillmentStatus: '履约状态', actualAmount: '实收金额',
      },
    },
    sizeManagement: { fields: { size: '尺码' } },
    paymentRecord: {
      fields: {
        salesEntry: '关联销售单', method: '支付方式', tradeDirection: '收支方向',
        amount: '交易金额', status: '钱款状态', receiptId: '交易明细ID', receivedAt: '收付日',
      },
    },
  };
  const state = {
    entry: {
      record_id: ENTRY,
      fields: {
        销售单号: ORDER_NO,
        售后类型: ['换货'],
        售后次数: 1,
      },
    },
    detail: {
      record_id: DETAIL,
      fields: {
        销售单号: [{ record_ids: [ENTRY] }],
        编号: [{ record_ids: [PRODUCT] }],
        尺码: [{ record_ids: [SIZE_ID] }],
        履约状态: '已交付',
        实收金额: 180,
      },
    },
    size: { record_id: SIZE_ID, fields: { 尺码: 40 } },
    payments: [
      { record_id: 'pay_1', fields: { 关联销售单: [{ record_ids: [ENTRY] }], 交易明细ID: `${ORDER_NO}-收款-01`, 交易金额: 180, 钱款状态: '已收款' } },
    ],
    calls: { create: [], update: [], listAll: [] },
  };
  Object.assign(state, overrides.state || {});
  // 与真实网关同一语义：写入用**语义键**，网关按 schema 映射成飞书列名（测试里同样映射）
  const toFeishu = (key, fields = {}) => Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [tables[key]?.fields?.[name] || name, value]),
  );
  const gateway = {
    table: (key) => tables[key],
    get: async (key) => {
      if (key === 'salesEntry') return state.entry;
      if (key === 'salesDetail') return state.detail;
      if (key === 'sizeManagement') return state.size;
      return null;
    },
    listAll: async (key) => { state.calls.listAll.push(key); return key === 'paymentRecord' ? state.payments : []; },
    create: async (key, fields) => {
      const mapped = toFeishu(key, fields);
      state.calls.create.push({ key, fields: mapped });
      const recordId = `new_${state.calls.create.length}`;
      if (key === 'paymentRecord') state.payments.push({ record_id: recordId, fields: mapped });
      return { recordId };
    },
    update: async (key, recordId, fields) => {
      const mapped = toFeishu(key, fields);
      state.calls.update.push({ key, recordId, fields: mapped });
      if (key === 'salesDetail') Object.assign(state.detail.fields, mapped);
      if (key === 'salesEntry') Object.assign(state.entry.fields, mapped);
      return { record_id: recordId };
    },
  };
  return { gateway, state };
};

const makeInventory = () => {
  const calls = [];
  return {
    calls,
    applyChange: async (input, options) => { calls.push({ input, options }); return [{ behaviorCode: input.kind, state: input.state, quantity: input.quantity }]; },
  };
};

const makePaymentMethods = (names = ['现金', '微信扫码']) => ({
  listWithVouchers: async () => ({
    ok: true,
    detailed: names.map((name, index) => ({ name, recordId: `pm_${index + 1}` })),
  }),
});

const buildService = (options = {}) => {
  const { gateway, state } = options.gateway ? options : makeGateway(options);
  const inventory = options.inventory || makeInventory();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-return-'));
  const store = options.store || new JsonTaskStore({ dir, idField: 'request_id' });
  const service = new AfterSalesReturnService({
    gateway, inventory, store,
    paymentMethods: options.paymentMethods || makePaymentMethods(),
    now: () => Date.UTC(2026, 9, 28, 4, 0, 0),
  });
  return { service, gateway, state, inventory, store, dir };
};

const payloadOf = (overrides = {}) => ({
  action: 'return',
  requestId: UUID(),
  salesEntryRecordId: ENTRY,
  detailRecordId: DETAIL,
  moneyMode: 'refund',
  paymentMethod: '现金',
  productRecordId: PRODUCT,
  ...overrides,
});

test('AC-RW1 直接退款：明细已退货 + 库存销售增加落门盒 + 新建退款交易明细 + 主表丰富', async () => {
  const { service, state, inventory } = buildService();
  const result = await service.execute(payloadOf());

  assert.equal(state.detail.fields.履约状态, '已退货');
  assert.equal(inventory.calls.length, 1);
  assert.deepEqual(inventory.calls[0].input, {
    kind: 'STOCK_SALE_INCREASE', productRecordId: PRODUCT, size: 40,
    state: '门盒', quantity: 1,
    // 本地幂等键用明细 id；远端「库存流水.关联销售」用主表 id（见 movements.ledgerLink）
    sourceRecordId: DETAIL, salesEntryRecordId: ENTRY,
  });

  const created = state.calls.create.find((item) => item.key === 'paymentRecord');
  assert.ok(created, '要新建一条交易明细');
  assert.equal(created.fields.交易明细ID, `${ORDER_NO}-退款-02`);
  assert.equal(created.fields.交易金额, 180, '金额=这双鞋的销售明细金额');
  assert.deepEqual(created.fields.支付方式, ['pm_1'], '支付方式 = 她选的（配置表里的 record_id）');
  assert.equal(created.fields.收支方向, '退回');
  assert.equal(created.fields.钱款状态, '已退款');
  assert.equal(created.fields.收付日, Date.UTC(2026, 9, 28, 4, 0, 0), '收付日=点击当天');
  assert.deepEqual(created.fields.关联销售单, [ENTRY]);

  assert.deepEqual(state.entry.fields.售后类型, ['换货', '退货']);
  assert.equal(state.entry.fields.售后次数, 2);
  assert.equal(result.money.receipt_id, `${ORDER_NO}-退款-02`);
});

test('AC-RW2 货款留存：交易明细不填支付方式/收支方向，钱款状态=已留存', async () => {
  const { service, state } = buildService();
  await service.execute(payloadOf({ moneyMode: 'retained', paymentMethod: '' }));
  const created = state.calls.create.find((item) => item.key === 'paymentRecord');
  assert.equal(created.fields.交易明细ID, `${ORDER_NO}-留存-02`);
  assert.equal(created.fields.支付方式, undefined);
  assert.equal(created.fields.收支方向, undefined);
  assert.equal(created.fields.钱款状态, '已留存');
  assert.equal(created.fields.交易金额, 180);
});

test('AC-RW3 幂等：同一 requestId 重放 ⇒ 零新增写入（返回上次结果）', async () => {
  const { service, state } = buildService();
  const payload = payloadOf();
  const first = await service.execute(payload);
  const writesAfterFirst = JSON.stringify(state.calls);
  const second = await service.execute(payload);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(state.calls), writesAfterFirst, '重放不许再写');
});

test('AC-RW4 校验：非已交付/已退货/缺金额/退款未选方式 ⇒ 400 且零写入', async () => {
  for (const [label, mutate, message] of [
    ['已换货', (state) => { state.detail.fields.履约状态 = '已换货'; }, /不能退货/],
    ['已退货', (state) => { state.detail.fields.履约状态 = '已退货'; }, /已经退过货/],
    ['缺金额', (state) => { state.detail.fields.实收金额 = ''; }, /实收金额/],
  ]) {
    const { service, state } = buildService();
    mutate(state);
    await assert.rejects(() => service.execute(payloadOf()), (error) => error.statusCode === 400 && message.test(error.message), label);
    assert.equal(state.calls.create.length + state.calls.update.length, 0, `${label}：零写入`);
  }
  const { service, state } = buildService();
  await assert.rejects(() => service.execute(payloadOf({ paymentMethod: '' })),
    (error) => error.statusCode === 400 && /退款方式/.test(error.message));
  assert.equal(state.calls.create.length + state.calls.update.length, 0);

  const bad = buildService();
  await assert.rejects(() => bad.service.execute(payloadOf({ moneyMode: 'nope' })),
    (error) => error.statusCode === 400);
});

test('AC-RW5 异步队列：入队后台执行；临时失败重试后成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-jobs-'));
  const store = new JsonTaskStore({ dir, idField: 'job_id' });
  let attempts = 0;
  const jobs = createAfterSalesAsyncService({
    store,
    execute: async () => { attempts += 1; if (attempts === 1) throw new Error('飞书 502'); return { ok: true }; },
  });
  const requestId = UUID();
  const { job } = await jobs.enqueue({ type: 'return', requestId, payload: {} });
  assert.equal(job.status, 'queued');
  // 等 worker 跑完（重试 1 次后成功）
  const finished = await new Promise((resolve) => {
    const timer = setInterval(async () => {
      const now = await jobs.get(job.job_id);
      if (now && now.status === 'succeeded') { clearInterval(timer); resolve(now); }
      if (now && now.status === 'failed') { clearInterval(timer); resolve(now); }
    }, 20);
    setTimeout(() => { clearInterval(timer); resolve(null); }, 5000);
  });
  assert.ok(finished, 'job 要有终态');
  assert.equal(finished.status, 'succeeded');
  assert.equal(attempts, 2);
});

test('AC-RW6 配置口径：售后类型写「退货」、门盒默认、行为编码可配', () => {
  assert.equal(AFTER_SALES_DERIVED.defaultRestockState, '门盒');
  assert.equal(AFTER_SALES_DERIVED.master.typeValueByAction.return, '退货');
  assert.equal(AFTER_SALES_DERIVED.money.refundDirection, '退回');
  assert.equal(AFTER_SALES_DERIVED.money.statusByMode.refund, '已退款');
  assert.equal(AFTER_SALES_DERIVED.money.statusByMode.retained, '已留存');
  // 生产「行为管理」里的编码（只读核对过）
  assert.equal(AFTER_SALES_DERIVED.stockBehaviorCode, 'STOCK_SALE_INCREASE');
});
