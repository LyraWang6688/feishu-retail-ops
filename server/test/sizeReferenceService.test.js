const test = require('node:test');
const assert = require('node:assert/strict');
const { SizeReferenceService } = require('../src/services/sizeReferenceService');

const gatewayFor = (rows) => ({
  table: () => ({ fields: { size: '尺码' } }),
  listAll: async () => rows,
});
const rows = [38, 39, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

test('size references resolve numeric business values and Feishu link cells', async () => {
  const service = new SizeReferenceService({ gateway: gatewayFor(rows) });
  assert.deepEqual(await service.resolveByNumber(38), { recordId: 'size_38', size: 38 });
  assert.deepEqual(await service.resolveLinkedCell([{ record_ids: ['size_39'], text: '39' }]),
    { recordId: 'size_39', size: 39 });
  assert.deepEqual(await service.resolveLinkedCells(['size_38', 'size_40']), [
    { recordId: 'size_38', size: 38 }, { recordId: 'size_40', size: 40 },
  ]);
});

test('size references reject decimals, missing sizes and ambiguous links', async () => {
  const service = new SizeReferenceService({ gateway: gatewayFor(rows) });
  await assert.rejects(service.resolveByNumber(42.5), /正整数/);
  await assert.rejects(service.resolveByNumber('42.0'), /正整数/);
  await assert.rejects(service.resolveByNumber('0x2a'), /正整数/);
  await assert.rejects(service.resolveByNumber(41), /找不到 41 码/);
  await assert.rejects(service.resolveLinkedCell(['size_38', 'size_39']), /只能关联一个/);
  await assert.rejects(service.resolveLinkedCell([]), /为空/);
  await assert.rejects(service.resolveLinkedCell(['unknown']), /不在尺码管理/);
});

test('schema validation requires an integer-size source and single link to that table', async () => {
  const gateway = gatewayFor(rows);
  gateway.table = (key) => key === 'sizeManagement'
    ? { tableName: '尺码管理', tableId: 'size_table', fields: { size: '尺码' } }
    : { tableName: '实时库存', fields: { size: '尺码' } };
  gateway.listFields = async (key) => key === 'sizeManagement'
    ? [{ field_name: '尺码', type: 2 }]
    : [{ field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }];
  const service = new SizeReferenceService({ gateway });
  await service.validateSchema(['liveInventory']);
  gateway.listFields = async (key) => key === 'sizeManagement'
    ? [{ field_name: '尺码', type: 2 }]
    : [{ field_name: '尺码', type: 18, property: { table_id: 'wrong_table', multiple: false } }];
  await assert.rejects(service.validateSchema(['liveInventory']), /单选关联/);
});

test('duplicate size management rows fail closed', async () => {
  const service = new SizeReferenceService({ gateway: gatewayFor([
    rows[0], { record_id: 'duplicate_38', fields: { 尺码: '38' } },
  ]) });
  await assert.rejects(service.resolveByNumber(38), /重复记录/);
});

test('clearing size cache rereads size management', async () => {
  const data = [...rows];
  const service = new SizeReferenceService({ gateway: gatewayFor(data) });
  await assert.rejects(service.resolveByNumber(41), /找不到/);
  data.push({ record_id: 'size_41', fields: { 尺码: 41 } });
  service.clearCache();
  assert.deepEqual(await service.resolveByNumber(41), { recordId: 'size_41', size: 41 });
});

test('new sizes and rebuilt link IDs refresh on lookup misses without a restart', async () => {
  const data = [...rows];
  const service = new SizeReferenceService({ gateway: gatewayFor(data) });
  assert.deepEqual(await service.resolveByNumber(38), { recordId: 'size_38', size: 38 });
  data.push({ record_id: 'size_41', fields: { 尺码: 41 } });
  assert.deepEqual(await service.resolveByNumber(41), { recordId: 'size_41', size: 41 });
  data[0] = { record_id: 'rebuilt_38', fields: { 尺码: 38 } };
  assert.deepEqual(await service.resolveLinkedCell(['rebuilt_38']), { recordId: 'rebuilt_38', size: 38 });
  await assert.rejects(service.resolveLinkedCell(['size_38']), /不在尺码管理/);
});

test('deleted and recreated mappings are reloaded after bounded cache expiry', async () => {
  let clock = 0;
  const data = [...rows];
  const service = new SizeReferenceService({ gateway: gatewayFor(data),
    cacheTtlMs: 30_000, now: () => clock });
  assert.deepEqual(await service.resolveByNumber(38), { recordId: 'size_38', size: 38 });
  data.splice(0, 1);
  clock = 30_001;
  await assert.rejects(service.resolveByNumber(38), /找不到 38 码/);
  data.push({ record_id: 'rebuilt_38', fields: { 尺码: 38 } });
  assert.deepEqual(await service.resolveByNumber(38), { recordId: 'rebuilt_38', size: 38 });
});
