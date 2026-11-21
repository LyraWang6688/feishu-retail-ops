'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSalesDailyCashService } = require('../src/services/salesDailyCashService');

const F = V1_BITABLE_SCHEMA.tables.salesSummary;
const R = F.readOnlyFields;
const translate = (fields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [F.fields[key] || key, value]));

const freshGateway = () => {
  const records = [];
  let next = 1;
  return {
    records,
    async listAll(tableKey) {
      assert.equal(tableKey, 'salesSummary');
      return records;
    },
    async create(tableKey, fields) {
      assert.equal(tableKey, 'salesSummary');
      assert.equal(Object.prototype.hasOwnProperty.call(fields, 'saleDate'), false, '销售日由飞书自动生成，代码不写');
      const mapped = translate(fields);
      // 模拟飞书自动字段：创建后「销售日」自动带当天。
      if (!Object.prototype.hasOwnProperty.call(mapped, R.saleDate.name)) {
        mapped[R.saleDate.name] = Date.parse('2026-11-21T00:00:00+08:00');
      }
      const record = { record_id: `rec_${next += 1}`, fields: mapped };
      records.push(record);
      return { recordId: record.record_id, record };
    },
    async update(tableKey, recordId, fields) {
      assert.equal(tableKey, 'salesSummary');
      const record = records.find((item) => item.record_id === recordId);
      Object.assign(record.fields, translate(fields));
      return { recordId };
    },
    async get(tableKey, recordId) {
      assert.equal(tableKey, 'salesSummary');
      return records.find((item) => item.record_id === recordId) || null;
    },
  };
};

const serviceOf = (gateway) => createSalesDailyCashService({
  gateway,
  now: () => new Date('2026-11-21T10:00:00+08:00'),
});

test('每日现金：当天无记录返回 null', async () => {
  const gateway = freshGateway();
  const out = await serviceOf(gateway).getToday();
  assert.equal(out.date, '2026-11-21');
  assert.equal(out.record, null);
});

test('每日现金：首次保存创建一条；关店保存拿走金额更新同一条', async () => {
  const gateway = freshGateway();
  const service = serviceOf(gateway);
  const first = await service.save({ openingAmount: '500' });
  assert.equal(first.record.opening_amount, 500);
  assert.equal(gateway.records.length, 1);
  assert.equal(gateway.records[0].fields[R.saleDate.name], Date.parse('2026-11-21T00:00:00+08:00'), '销售日由飞书自动带出');
  gateway.records[0].fields[R.closingCash.name] = 1300;
  const second = await service.save({ withdrawalAmount: 200 });
  assert.equal(gateway.records.length, 1, '同一天只更新，不新建第二条');
  assert.equal(second.record.withdrawal_amount, 200);
  assert.equal(second.record.realtime_amount, 1300, '公式字段只读展示，不由本服务写');
  assert.equal(gateway.records[0].fields[F.fields.withdrawalCash], 200);
});

test('每日现金：没有期初记录时不能只保存拿走金额', async () => {
  const gateway = freshGateway();
  await assert.rejects(() => serviceOf(gateway).save({ withdrawalAmount: 50 }), (error) => (
    error.statusCode === 400 && error.message === 'opening_amount_required'
  ));
  assert.equal(gateway.records.length, 0);
});
