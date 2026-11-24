'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PERSON_FIELDS, DEFAULT_BLOCKED_OPEN_IDS } = require('../src/config/personFields');
const { personPatch, appendPerson, isBlockedOperator } = require('../src/services/personFieldService');

test('7 个人员字段全部登记，且模式正确', () => {
  assert.deepEqual(Object.keys(PERSON_FIELDS).sort(), [
    'inventoryLedger', 'labelPrintRequest', 'liveInventory',
    'purchaseOrderBatch', 'salesEntry',
  ]);
  assert.equal(PERSON_FIELDS.inventoryLedger.operator.mode, 'set');
  assert.equal(PERSON_FIELDS.labelPrintRequest.printedBy.mode, 'set');
  assert.equal(PERSON_FIELDS.salesEntry.sender.mode, 'set');
  assert.equal(PERSON_FIELDS.salesEntry.afterSalesBy.mode, 'append');
  assert.equal(PERSON_FIELDS.purchaseOrderBatch.reportedBy.mode, 'set');
  assert.equal(PERSON_FIELDS.purchaseOrderBatch.acceptedBy.mode, 'set');
  assert.equal(PERSON_FIELDS.liveInventory.warehouseStaff.mode, 'set');
});

test('人员字段：设置 / 追加 / 去重 / 空操作人不写', () => {
  assert.deepEqual(personPatch({ tableKey: 'inventoryLedger', fieldKey: 'operator', operatorOpenId: 'ou_human' }),
    { operator: [{ id: 'ou_human' }] });
  assert.deepEqual(personPatch({
    tableKey: 'salesEntry', fieldKey: 'afterSalesBy', operatorOpenId: 'ou_new', existing: [{ id: 'ou_old' }],
  }), { afterSalesBy: [{ id: 'ou_old' }, { id: 'ou_new' }] });
  assert.deepEqual(personPatch({
    tableKey: 'salesEntry', fieldKey: 'afterSalesBy', operatorOpenId: 'ou_old', existing: [{ id: 'ou_old' }],
  }), { afterSalesBy: [{ id: 'ou_old' }] });
  assert.deepEqual(personPatch({ tableKey: 'inventoryLedger', fieldKey: 'operator', operatorOpenId: '' }), {});
});

test('应用号 open_id 命中禁止名单 ⇒ 不写', () => {
  const bot = DEFAULT_BLOCKED_OPEN_IDS[0];
  assert.equal(isBlockedOperator(bot), true);
  assert.deepEqual(personPatch({ tableKey: 'liveInventory', fieldKey: 'warehouseStaff', operatorOpenId: bot }), {});
  assert.deepEqual(personPatch({
    tableKey: 'salesEntry', fieldKey: 'afterSalesBy', operatorOpenId: bot, existing: [{ id: 'ou_human' }],
  }), {});
});

test('配置里的字段都能在 schema 里找到（防止语义键写错）', () => {
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  for (const [tableKey, fields] of Object.entries(PERSON_FIELDS)) {
    for (const [fieldKey, policy] of Object.entries(fields)) {
      assert.ok(V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[policy.field], `${tableKey}.${fieldKey} 映射缺失`);
    }
  }
});
