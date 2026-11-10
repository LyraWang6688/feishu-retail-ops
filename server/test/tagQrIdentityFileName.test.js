'use strict';

/**
 * 标签二维码：**文件名统一按 identity（recordId）** 的回归判据（2026-11-11）。
 *
 * 线上真事（2026-11-10/11）：
 *   · 二维码内容 2026-10-12 已切到 `/r/{recordId}`；
 *   · 但巡检按 `buildFileName(recordId)` 判"过期"、`syncRecord` 却按 `buildFileName(number)` 判"已同步"
 *     ⇒ 旧编号命名的附件永远被跳过（每小时 94 条候选、`written=0`）；
 *   · 本文件把"巡检 / 执行 / 回填脚本"三处**同一份规范名**钉住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { textValue } = require('../src/services/v1BitableGateway');
const {
  createTagQrCodeService, numberFromFileName, sanitizeNumberForFileName, attachmentsOf, buildRecordIdScanUrl,
} = require('../src/services/tagQrCodeService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
const QR_FIELD = F[TAG_QR_CODE.fields.tagQrCode];
const NUMBER_FIELD = F[TAG_QR_CODE.fields.number];

const fakeGateway = (rows) => {
  const records = new Map(rows.map((row) => [row.record_id, { record_id: row.record_id, fields: { ...row.fields } }]));
  const updates = [];
  let tokenSeq = 0;
  const snapshot = (row) => (row ? { record_id: row.record_id, fields: { ...row.fields } } : null);
  return {
    updates,
    get: async (table, id) => snapshot(records.get(id)),
    listAll: async () => [...records.values()].map(snapshot),
    uploadAttachment: async () => `fake_token_${++tokenSeq}`,
    update: async (table, id, values) => {
      const row = records.get(id);
      const mapped = Object.fromEntries(Object.entries(values).map(([key, value]) => [F[key] || key, value]));
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
  fields: {
    [NUMBER_FIELD]: '906|黑色|男',
    [QR_FIELD]: [{ file_token: 'old_token', name: 'tag-qr-906_黑色_男.png' }],
  },
});
const identityNamed = () => ({
  record_id: 'rec_new',
  fields: {
    [NUMBER_FIELD]: '907|白色|男',
    [QR_FIELD]: [{ file_token: 'new_token', name: 'tag-qr-rec_new.png' }],
  },
});
const missing = () => ({
  record_id: 'rec_missing',
  fields: { [NUMBER_FIELD]: '908|红色|男' },
});

test('AC-TQ1 旧编号命名的附件：syncRecord 必须按 identity 重写（不再是 skipped_existing）', async () => {
  const gateway = fakeGateway([oldNumberNamed()]);
  const service = serviceFor(gateway);
  const result = await service.syncRecord('rec_old');
  assert.equal(result.status, 'written');
  assert.equal(result.reason, 'stale_file_name');
  assert.equal(result.file_name, 'tag-qr-rec_old.png', '规范名按 recordId，不是编号');
  assert.equal(gateway.updates.length, 1);
  assert.equal(gateway.updates[0].values[QR_FIELD][0].file_token, 'fake_token_1');
});

test('AC-TQ2 已是 identity 规范名的附件：跳过（幂等，不重复写）', async () => {
  const gateway = fakeGateway([identityNamed()]);
  const service = serviceFor(gateway);
  const result = await service.syncRecord('rec_new');
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already_present');
  assert.equal(gateway.updates.length, 0);
});

test('AC-TQ3 频检：旧编号命名 ⇒ 候选并真的写；identity 命名 ⇒ consistent；缺附件 ⇒ 补', async () => {
  const gateway = fakeGateway([oldNumberNamed(), identityNamed(), missing()]);
  const service = serviceFor(gateway);
  const summary = await service.sweepStaleTagQrCodes({ intervalMs: 0 });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.consistent, 1, 'identity 规范名那条算一致');
  assert.equal(summary.candidates, 2, '旧编号 + 缺附件');
  assert.equal(summary.written, 2, '🔴 改前这里恒为 0（写不进去）');
  assert.equal(summary.failed.length, 0);
  const writtenNames = gateway.updates.map((item) => item.values[QR_FIELD][0].file_token);
  assert.deepEqual(writtenNames, ['fake_token_1', 'fake_token_2']);
  assert.equal(gateway.updates.some((item) => item.id === 'rec_new'), false);
});

test('AC-TQ4 回填脚本：旧编号命名 ⇒ 待更新（stale_file_name），URL/文件名都按 identity', async () => {
  const { buildPlans } = require('../scripts/backfill-product-tag-qr.js');
  const gateway = fakeGateway([oldNumberNamed(), identityNamed()]);
  const service = serviceFor(gateway);
  const plans = buildPlans([oldNumberNamed(), identityNamed()], { overwrite: false }, {
    service,
    textValue,
    attachmentsOf,
    numberField: NUMBER_FIELD,
    tagQrField: QR_FIELD,
    numberFromFileName,
    sanitizeNumberForFileName,
  });
  const oldPlan = plans.find((item) => item.record_id === 'rec_old');
  const newPlan = plans.find((item) => item.record_id === 'rec_new');
  assert.equal(oldPlan.action, 'write');
  assert.equal(oldPlan.reason, 'stale_file_name');
  assert.equal(oldPlan.file_name, 'tag-qr-rec_old.png');
  assert.equal(oldPlan.scan_url, buildRecordIdScanUrl('rec_old'));
  assert.equal(newPlan.action, 'skip');
  assert.equal(newPlan.reason, 'already_present');
});
