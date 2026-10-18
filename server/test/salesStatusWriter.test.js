// 「写入状态」的唯一写入口（services/salesStatusWriter，2026-10-18 新模型）。
//
// 硬边界：
//   ① 只写「写入状态」，且值必须在值域内；旧维度键一律忽略；
//   ② **状态写失败绝不影响业务写入**（不抛、只记 warning、返回 false）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesStatusWriter } = require('../src/services/salesStatusWriter');

const makeGateway = (options = {}) => {
  const updates = [];
  const gateway = {
    update: async (tableKey, recordId, values) => {
      if (options.fail) throw new Error('飞书 500');
      updates.push({ tableKey, recordId, values });
      return { record_id: recordId };
    },
    table: () => ({ tableName: '销售主表' }),
  };
  return { gateway, updates };
};

test('写「写入状态」：值原样落到 salesEntry', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.write('rec_1', { writeStatus: '成功' }), true);
  assert.deepEqual(updates, [{
    tableKey: 'salesEntry', recordId: 'rec_1', values: { writeStatus: '成功' },
  }]);
});

test('旧维度键一律忽略（那四列已被业务负责人删除）', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.write('rec_1', {
    userAction: '已确认', sales: '已写入', funds: '已写入', stock: '已写入',
  }), false);
  assert.equal(updates.length, 0);
});

test('值不在值域内 → 拒绝写入，一次请求都不发', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.write('rec_1', { writeStatus: '已写入' }), false);
  assert.equal(await writer.write('rec_1', { writeStatus: '' }), false);
  assert.equal(updates.length, 0);
});

test('writePending / writeFinal 便捷方法：未完成 / 成功 / 部分失败 / 失败', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.writePending('rec_1'), true);
  assert.equal(await writer.writeFinal('rec_1', '成功'), true);
  assert.equal(await writer.writeFinal('rec_1', '部分失败'), true);
  assert.equal(await writer.writeFinal('rec_1', '失败'), true);
  assert.equal(await writer.writeFinal('rec_1', '未完成'), false);
  assert.deepEqual(updates.map((u) => u.values.writeStatus), ['未完成', '成功', '部分失败', '失败']);
});

test('没有 record_id / 没有值 → 返回 false，不发请求', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.write('', { writeStatus: '成功' }), false);
  assert.equal(await writer.write(undefined, { writeStatus: '成功' }), false);
  assert.equal(await writer.write('rec_1', {}), false);
  assert.equal(updates.length, 0);
});

test('🔴 写失败只记警告、不抛（记进度绝不能带崩记账/扣库存）', async () => {
  const { gateway } = makeGateway({ fail: true });
  const writer = new SalesStatusWriter({ gateway });
  await assert.doesNotReject(() => writer.write('rec_1', { writeStatus: '成功' }));
  assert.equal(await writer.write('rec_1', { writeStatus: '成功' }), false);
});

test('没有 gateway 直接报错（配错了要当场知道，而不是静默什么都写不出去）', () => {
  assert.throws(() => new SalesStatusWriter({}), /requires gateway/);
});
