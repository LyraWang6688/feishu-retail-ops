'use strict';

/**
 * ⭐ 2026-11-17：把飞书工作流「配品销售同步」搬进代码。
 *
 * 钉住：
 *   · 配品销售新增 → S交易明细新增（支付方式/金额/收支方向/钱款状态/收付日）；
 *   · 交易明细ID = PX-<配品销售 record_id>，写前回查 ⇒ 幂等；
 *   · 名称/数量/金额不合法 ⇒ 跳过，不写 0 元；
 *   · 只认 record_added；失败不抛（事件层不炸）。
 */
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCESSORY_SALE_SYNC } = require('../src/config/accessorySaleSync');
const { createAccessorySaleSyncService } = require('../src/services/accessorySaleSyncService');

const silent = { logInfo() {}, logWarn() {} };
const F = ACCESSORY_SALE_SYNC.sourceFields;

const sourceRecord = (overrides = {}) => ({
  record_id: 'rec_src_1',
  created_time: 1794100000000,
  fields: {
    [F.name]: [{ id: 'rec_accessory_1' }],
    [F.quantity]: 1,
    [F.amount]: 15,
    [F.method]: [{ id: 'rec_cash' }],
    ...overrides,
  },
});

const config = (overrides = {}) => ({
  ...ACCESSORY_SALE_SYNC,
  sourceTableId: 'tbl_test_accessory_sale',
  ...overrides,
});

const fakeGateway = ({ record = sourceRecord(), existing = [] } = {}) => {
  const calls = [];
  return {
    calls,
    async getByTableId(input) { calls.push({ op: 'getByTableId', ...input }); return record; },
    async listByFilter(tableKey, formula) { calls.push({ op: 'listByFilter', tableKey, formula }); return existing; },
    async create(tableKey, values, options) {
      calls.push({ op: 'create', tableKey, values, options });
      return { recordId: 'rec_payment_1' };
    },
  };
};

test('AC-AS1 新增配品销售 ⇒ 新增 S交易明细：支付方式/收入/已收款/金额/收付日/幂等ID', async () => {
  const gateway = fakeGateway();
  const service = createAccessorySaleSyncService({ gateway, config: config(), logger: silent });
  const out = await service.processRecord('rec_src_1');

  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(out.receipt_id, 'PX-rec_src_1');
  assert.equal(gateway.calls[0].tableId, 'tbl_test_accessory_sale');
  assert.equal(gateway.calls[0].recordId, 'rec_src_1');
  assert.equal(gateway.calls[1].op, 'listByFilter');
  assert.equal(gateway.calls[1].tableKey, 'paymentRecord');
  assert.match(gateway.calls[1].formula, /PX-rec_src_1/);
  const create = gateway.calls.find((call) => call.op === 'create');
  assert.equal(create.tableKey, 'paymentRecord');
  // 网关吃语义键（method / amount / …），物理列名由 schema 映射。
  assert.deepEqual(create.values.method, ['rec_cash']);
  assert.equal(create.values.amount, 15);
  assert.equal(create.values.tradeDirection, '收入');
  assert.equal(create.values.status, '已收款');
  assert.equal(create.values.receiptId, 'PX-rec_src_1');
  assert.equal(create.values.receivedAt, 1794100000000);
  assert.equal(create.values.salesEntry, undefined, '配品销售不关联销售单');
});

test('AC-AS2 同一配品销售记录重投/重跑 ⇒ 按交易明细ID 回查后跳过，不重复记账', async () => {
  const gateway = fakeGateway({ existing: [{ record_id: 'rec_existing', fields: {} }] });
  const service = createAccessorySaleSyncService({ gateway, config: config(), logger: silent });
  const out = await service.processRecord('rec_src_1');
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'already_synced');
  assert.equal(gateway.calls.filter((call) => call.op === 'create').length, 0);
});

test('AC-AS3 名称/数量/金额不合法 ⇒ 跳过，不写 0 元', async () => {
  for (const [name, record, reason] of [
    ['name_empty', sourceRecord({ [F.name]: [] }), 'name_empty'],
    ['quantity_invalid', sourceRecord({ [F.quantity]: 0 }), 'quantity_invalid'],
    ['amount_invalid', sourceRecord({ [F.amount]: 0 }), 'amount_invalid'],
    ['amount_missing', sourceRecord({ [F.amount]: undefined }), 'amount_invalid'],
  ]) {
    const gateway = fakeGateway({ record });
    const service = createAccessorySaleSyncService({ gateway, config: config(), logger: silent });
    const out = await service.processRecord('rec_src_1');
    assert.equal(out.skipped, true, name);
    assert.equal(out.reason, reason, name);
    assert.equal(gateway.calls.filter((call) => call.op === 'create').length, 0, name);
  }
});

test('AC-AS4 只认 record_added；编辑/删除不补记', async () => {
  const gateway = fakeGateway();
  const service = createAccessorySaleSyncService({ gateway, config: config(), logger: silent });
  const out = await service.handleTableChanges([
    { action: 'record_edited', record_id: 'rec_src_1' },
    { action: 'record_deleted', record_id: 'rec_src_1' },
  ]);
  assert.equal(out.processed, 0);
  assert.equal(gateway.calls.length, 0);
});

test('AC-AS5 未配源表 ⇒ 不读不写；读源失败也不抛', async () => {
  const noTable = createAccessorySaleSyncService({ gateway: fakeGateway(), config: config({ sourceTableId: '' }), logger: silent });
  assert.equal((await noTable.processRecord('rec_src_1')).reason, 'source_table_not_configured');

  const badGateway = {
    async getByTableId() { throw new Error('read down'); },
    async listByFilter() { return []; },
    async create() { throw new Error('should not create'); },
  };
  const bad = createAccessorySaleSyncService({ gateway: badGateway, config: config(), logger: silent });
  const out = await bad.processRecord('rec_src_1');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'read_source_failed');
});
