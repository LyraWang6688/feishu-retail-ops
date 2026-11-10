'use strict';

/**
 * 标签二维码：**只由 recordId 决定**（2026-11-11 业务负责人定案：
 * 「把与编号有关的内容都删除，不用做兼容了，就是用 recordId」）。
 *
 * 判据：内容 `/r/{recordId}`、文件名 `tag-qr-{recordId}.png`；
 * 旧编号命名的附件 ⇒ 覆盖升级；没有「编号」字段的记录也照样生成。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const {
  createTagQrCodeService, attachmentsOf, buildRecordIdScanUrl,
} = require('../src/services/tagQrCodeService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
const QR_FIELD = F[TAG_QR_CODE.fields.tagQrCode];

const fakeGateway = (rows) => {
  const records = new Map(rows.map((row) => [row.record_id, { record_id: row.record_id, fields: { ...row.fields } }]));
  const updates = [];
  const tokenNames = new Map();
  let tokenSeq = 0;
  const snapshot = (row) => (row ? { record_id: row.record_id, fields: { ...row.fields } } : null);
  return {
    updates,
    get: async (table, id) => snapshot(records.get(id)),
    listAll: async () => [...records.values()].map(snapshot),
    uploadAttachment: async (filePath) => {
      const token = `fake_token_${++tokenSeq}`;
      tokenNames.set(token, require('node:path').basename(filePath));
      return token;
    },
    update: async (table, id, values) => {
      const row = records.get(id);
      const mapped = Object.fromEntries(Object.entries(values).map(([key, value]) => {
        const mappedValue = key === TAG_QR_CODE.fields.tagQrCode
          ? value.map((item) => ({ ...item, name: item.name || tokenNames.get(item.file_token) || '' }))
          : value;
        return [F[key] || key, mappedValue];
      }));
      Object.assign(row.fields, mapped);
      updates.push({ table, id, values: mapped });
      return snapshot(row);
    },
  };
};

const serviceFor = (gateway) => createTagQrCodeService({
  gateway,
  generatePng: async () => Buffer.from('fake-png'),
});

const oldNumberNamed = () => ({
  record_id: 'rec_old',
  fields: { [QR_FIELD]: [{ file_token: 'old_token', name: 'tag-qr-906_黑色_男.png' }] },
});
const identityNamed = () => ({
  record_id: 'rec_new',
  fields: { [QR_FIELD]: [{ file_token: 'new_token', name: 'tag-qr-rec_new.png' }] },
});
const missing = () => ({ record_id: 'rec_missing', fields: {} });
const noNumberFieldAtAll = () => ({ record_id: 'rec_plain', fields: {} });

test('AC-TQ1 旧编号命名的附件：按 recordId 覆盖升级（不再是 skipped_existing）', async () => {
  const gateway = fakeGateway([oldNumberNamed()]);
  const service = serviceFor(gateway);
  const result = await service.syncRecord('rec_old');
  assert.equal(result.status, 'written');
  assert.equal(result.file_name, 'tag-qr-rec_old.png');
  assert.equal(result.scan_url, buildRecordIdScanUrl('rec_old'));
  assert.equal(gateway.updates.length, 1);
  assert.equal(gateway.updates[0].values[QR_FIELD][0].file_token, 'fake_token_1');
});

test('AC-TQ2 已是 recordId 规范名的附件：跳过（幂等，不重复写）', async () => {
  const gateway = fakeGateway([identityNamed()]);
  const service = serviceFor(gateway);
  const result = await service.syncRecord('rec_new');
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already_present');
  assert.equal(gateway.updates.length, 0);
});

test('AC-TQ3 只认「创建」事件：record_added 生成；record_edited / record_updated 一律不处理', async () => {
  const gateway = fakeGateway([oldNumberNamed(), identityNamed()]);
  const service = serviceFor(gateway);
  // 业务负责人 2026-11-11：其余的记录编辑 / 更新都不需要了 ⇒ 改事件连读都不该触发写
  for (const action of ['record_edited', 'record_updated']) {
    // eslint-disable-next-line no-await-in-loop
    const ignored = await service.handleTableChanges([{ record_id: 'rec_old', action }]);
    assert.deepEqual(ignored.results, [], `${action} 不应写`);
  }
  assert.equal(gateway.updates.length, 0, '修改事件不触发二维码写库');
  // 新增事件：旧格式 ⇒ 升级；重复「新增」（事件重投）⇒ 幂等跳过
  const created = await service.handleTableChanges([{ record_id: 'rec_old', action: 'record_added' }]);
  assert.equal(created.results[0].status, 'written');
  assert.equal(gateway.updates.length, 1);
  const again = await service.handleTableChanges([{ record_id: 'rec_old', action: 'record_added' }]);
  assert.equal(again.results[0].status, 'skipped');
  assert.equal(gateway.updates.length, 1);
});

test('AC-TQ4 没有「编号」字段的记录也照样生成（与编号无关）', async () => {
  const gateway = fakeGateway([noNumberFieldAtAll()]);
  const service = serviceFor(gateway);
  const result = await service.syncRecord('rec_plain');
  assert.equal(result.status, 'written');
  assert.equal(result.file_name, 'tag-qr-rec_plain.png');
  assert.equal(gateway.updates.length, 1);
});

test('AC-TQ5 回填脚本：旧格式 ⇒ stale_file_name；规范名 ⇒ already_present；不读编号', () => {
  const { buildPlans } = require('../scripts/backfill-product-tag-qr.js');
  const gateway = fakeGateway([oldNumberNamed(), identityNamed(), noNumberFieldAtAll()]);
  const service = serviceFor(gateway);
  const plans = buildPlans([oldNumberNamed(), identityNamed(), noNumberFieldAtAll()], { overwrite: false }, {
    service,
    attachmentsOf,
    tagQrField: QR_FIELD,
  });
  const oldPlan = plans.find((item) => item.record_id === 'rec_old');
  const newPlan = plans.find((item) => item.record_id === 'rec_new');
  const plainPlan = plans.find((item) => item.record_id === 'rec_plain');
  assert.equal(oldPlan.action, 'write');
  assert.equal(oldPlan.reason, 'stale_file_name');
  assert.equal(oldPlan.file_name, 'tag-qr-rec_old.png');
  assert.equal(oldPlan.scan_url, buildRecordIdScanUrl('rec_old'));
  assert.equal(newPlan.action, 'skip');
  assert.equal(newPlan.reason, 'already_present');
  assert.equal(plainPlan.action, 'write', '没有编号字段 ⇒ 仍要生成');
});
