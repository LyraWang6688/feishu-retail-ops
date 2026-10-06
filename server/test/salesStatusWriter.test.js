// 四个状态维度的写入口（services/salesStatusWriter）。
//
// 两条硬边界，各一条测试：
//   ① 只写白名单里的四个语义键（写错键名当场被挡，不会写到"另一个同名字段"上）；
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

test('写语义键：四个维度一次写下去，走 gateway.update（字段名由 schema 提供）', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  const ok = await writer.write('rec_1', {
    userAction: '已确认', sales: '已写入', funds: '已写入', stock: '已写入',
  });
  assert.equal(ok, true);
  assert.deepEqual(updates, [{
    tableKey: 'salesEntry',
    recordId: 'rec_1',
    values: { userAction: '已确认', sales: '已写入', funds: '已写入', stock: '已写入' },
  }]);
});

test('不认识的键被丢掉：不会把值写到别的字段上去', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  await writer.write('rec_1', {
    userAction: '已确认',
    // 不在白名单里的键一律丢掉：这件事必须**由数据结构保证**，而不是靠每个调用点记得别写。
    // （旧字段 confirmStatus / orderStatus 连映射都从 schema 删了，谁也写不出去。）
    founds: '已写入',
    '乱写的键': 'x',
  });
  assert.deepEqual(updates[0].values, { userAction: '已确认' });
});

test('空值 = 这一次不写这一维（不是"清空"）：不覆盖读那一侧要退回的旧字段', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  await writer.write('rec_1', { userAction: '已确认', funds: '', sales: null, stock: undefined });
  assert.deepEqual(updates[0].values, { userAction: '已确认' });
});

test('没有任何可写内容 / 没有 record_id → 直接返回 false，一次请求都不发', async () => {
  const { gateway, updates } = makeGateway();
  const writer = new SalesStatusWriter({ gateway });
  assert.equal(await writer.write('rec_1', {}), false);
  assert.equal(await writer.write('', { userAction: '已确认' }), false);
  assert.equal(await writer.write(undefined, { userAction: '已确认' }), false);
  assert.equal(updates.length, 0);
});

test('🔴 写失败只记警告、不抛（记进度绝不能带崩记账/扣库存）', async () => {
  const { gateway } = makeGateway({ fail: true });
  const writer = new SalesStatusWriter({ gateway });
  await assert.doesNotReject(() => writer.write('rec_1', { funds: '已写入' }));
  assert.equal(await writer.write('rec_1', { funds: '已写入' }), false);
});

test('没有 gateway 直接报错（配错了要当场知道，而不是静默什么都写不出去）', () => {
  assert.throws(() => new SalesStatusWriter({}), /requires gateway/);
});
