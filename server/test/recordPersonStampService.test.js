'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecordPersonStampService, operatorOf } = require('../src/services/recordPersonStampService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const make = () => {
  const writes = [];
  return {
    writes,
    gateway: {
      async update(tableKey, recordId, values) {
        writes.push({ tableKey, recordId, values });
      },
    },
  };
};

test('事件新增记录：上新员 / 打印者写实际操作人', async () => {
  const { gateway, writes } = make();
  const service = createRecordPersonStampService({ gateway });
  const actions = [{ action: 'record_added', record_id: 'rec_1', operator_id: { open_id: 'ou_1' } }];
  await service.handle('product', actions);
  await service.handle('labelPrintRequest', actions);
  assert.deepEqual(writes[0].values, { newStaff: [{ id: 'ou_1' }] });
  assert.deepEqual(writes[1].values, { printedBy: [{ id: 'ou_1' }] });
});

test('只写 record_added；没有操作人就不猜', async () => {
  const { gateway, writes } = make();
  const service = createRecordPersonStampService({ gateway });
  await service.handle('product', [{ action: 'record_edited', record_id: 'rec_1', operator_id: { open_id: 'ou_1' } }]);
  await service.handle('labelPrintRequest', [{ action: 'record_added', record_id: 'rec_2' }]);
  assert.deepEqual(writes, []);
  assert.equal(operatorOf({ operator: 'ou_2' }), 'ou_2');
});
