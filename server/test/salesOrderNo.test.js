const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextSalesOrderNo,
  allocateSalesOrderNo,
  shanghaiDateStamp,
} = require('../src/services/salesOrderNo');

// 生产数据实测：改字段类型前序号是**全局递增**的，历史 85 条单号都是
// XSD-<当天日期>-<全局序号>，例如 XSD-20261004-0168、XSD-20261005-0169…0172。
// 这就是线上那批，日期跨了两天。
const LEGACY_GLOBAL_NOS = [
  'XSD-20261004-0168',
  'XSD-20261005-0169',
  'XSD-20261005-0170',
  'XSD-20261005-0171',
  'XSD-20261005-0172',
];
// 只含「日期段不是今天」的旧全局号——判定"今天第一个号是不是 0001"必须用这一组。
const OLD_DAY_GLOBAL_NOS = [
  'XSD-20261004-0168',
  'XSD-20261004-0169',
  'XSD-20261004-0170',
  'XSD-20261003-0167',
  'XSD-20260930-0152',
];

const SHANGHAI_NOON = new Date('2026-10-05T12:00:00+08:00');

test('单号格式为 XSD-YYYYMMDD-NNNN，序号补零到 4 位', () => {
  const result = nextSalesOrderNo({ existingNos: [], now: SHANGHAI_NOON });
  assert.equal(result.orderNo, 'XSD-20261005-0001');
  assert.equal(result.sequence, 1);
  assert.match(result.orderNo, /^XSD-\d{8}-\d{4}$/);
});

test('当天一条记录都没有时，第一个号是 0001', () => {
  assert.equal(nextSalesOrderNo({ existingNos: [], now: SHANGHAI_NOON }).orderNo, 'XSD-20261005-0001');
  assert.equal(nextSalesOrderNo({ now: SHANGHAI_NOON }).sequence, 1, '不传 existingNos 也应从 0001 开始');
  assert.equal(nextSalesOrderNo({ existingNos: [null, '', '不是单号'], now: SHANGHAI_NOON }).sequence, 1);
});

test('当天已有记录时取最大值 + 1，不回头填补空缺', () => {
  const result = nextSalesOrderNo({
    existingNos: ['XSD-20261005-0001', 'XSD-20261005-0003', 'XSD-20261005-0005'],
    now: SHANGHAI_NOON,
  });
  assert.equal(result.orderNo, 'XSD-20261005-0006');
  assert.equal(result.sequence, 6);
  assert.equal(result.todayCount, 3);
  // 中间缺 0002、0004：绝不能补缺（补缺可能把一个已经发出过的号再发一次）
  assert.notEqual(result.orderNo, 'XSD-20261005-0002');
  assert.notEqual(result.orderNo, 'XSD-20261005-0004');
});

test('序号跨越 10 之后仍然补零到 4 位', () => {
  assert.equal(nextSalesOrderNo({ existingNos: ['XSD-20261005-0009'], now: SHANGHAI_NOON }).orderNo,
    'XSD-20261005-0010');
  assert.equal(nextSalesOrderNo({ existingNos: ['XSD-20261005-0099'], now: SHANGHAI_NOON }).orderNo,
    'XSD-20261005-0100');
});

test('非今天的旧全局号（含 0169/0170）不参与计算，今天第一条仍是 0001', () => {
  // 关键：只识别「日期段 == 今天」的号。否则这些 016x/0170 会把 max 顶到 170，
  // 今天的第一个号就变成 0171，"每天重置"直接失效。
  const result = nextSalesOrderNo({ existingNos: OLD_DAY_GLOBAL_NOS, now: SHANGHAI_NOON });
  assert.equal(result.orderNo, 'XSD-20261005-0001');
  assert.equal(result.sequence, 1);
  assert.equal(result.todayCount, 0, '昨天/前天的号一条都不算今天的');
});

test('同一天里遗留的旧全局号（0169-0172）继续参与计算，不会倒退重发 0001', () => {
  // ⚠️ 这条是本次改动最容易踩的坑：线上 2026-10-05 已经有 XSD-20261005-0169…0172。
  // 如果"只认今天格式"被误解成"忽略今天的高序号"，今天下一单就会重新发出 0001，
  // 和当天已有的号撞上。正确行为是接在最大值后面继续递增。
  const result = nextSalesOrderNo({ existingNos: LEGACY_GLOBAL_NOS, now: SHANGHAI_NOON });
  assert.equal(result.orderNo, 'XSD-20261005-0173');
  assert.equal(result.todayCount, 4);
  assert.notEqual(result.orderNo, 'XSD-20261005-0001');
});

test('跨天重置：明天的第一条是 0001，且和今天的 0001 不是同一个号', () => {
  const today = nextSalesOrderNo({ existingNos: [], now: new Date('2026-10-05T09:00:00+08:00') });
  const tomorrow = nextSalesOrderNo({ existingNos: [], now: new Date('2026-10-06T09:00:00+08:00') });
  assert.equal(today.orderNo, 'XSD-20261005-0001');
  assert.equal(tomorrow.orderNo, 'XSD-20261006-0001');
  assert.notEqual(today.orderNo, tomorrow.orderNo, '靠日期段区分，同序号不构成冲突');
  // 今天的记录也不该把明天的序号顶上去
  assert.equal(nextSalesOrderNo({ existingNos: ['XSD-20261005-0001', 'XSD-20261005-0007'],
    now: new Date('2026-10-06T09:00:00+08:00') }).orderNo, 'XSD-20261006-0001');
});

test('时区按东八区算：UTC 还在前一天、上海已过 0 点时用上海日期', () => {
  // 上海 2026-10-06 00:30 == UTC 2026-10-05 16:30
  const afterMidnightInShanghai = new Date('2026-10-05T16:30:00Z');
  assert.equal(shanghaiDateStamp(afterMidnightInShanghai), '20261006');
  assert.equal(nextSalesOrderNo({ existingNos: [], now: afterMidnightInShanghai }).orderNo,
    'XSD-20261006-0001');
  // 上海 2026-10-05 23:59 == UTC 2026-10-05 15:59 —— 同一天，不能提前跳到 6 号
  assert.equal(shanghaiDateStamp(new Date('2026-10-05T15:59:00Z')), '20261005');
  assert.equal(nextSalesOrderNo({ existingNos: [], now: new Date('2026-10-05T15:59:00Z') }).orderNo,
    'XSD-20261005-0001');
});

test('撞号重试：查重时刚好已被别人占用，会 +1 再试并成功', async () => {
  const stored = [];
  let competitorTookSameNumber = false;
  const collisions = [];
  const result = await allocateSalesOrderNo({
    now: SHANGHAI_NOON,
    readExistingNos: async () => [...stored],
    writeOrderNo: async (orderNo, { attempt }) => {
      stored.push(orderNo);
      // 第一次写完，模拟"别人刚好也占了这个号"：当天这个号出现两次
      if (attempt === 1 && !competitorTookSameNumber) {
        competitorTookSameNumber = true;
        stored.push(orderNo);
      }
    },
    onCollision: (info) => collisions.push(info),
  });
  assert.equal(result.orderNo, 'XSD-20261005-0002', '被占的 0001 要 +1 变成 0002');
  assert.equal(result.sequence, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(collisions, [{ attempt: 1, order_no: 'XSD-20261005-0001' }]);
  // 重试是改自己那条记录，不是再建一条：清理后当天只剩一个 0002
  assert.deepEqual(stored.filter((no) => no === result.orderNo).length, 1);
});

test('撞号重试有上限：一直撞就明确报错，不静默写一个重号', async () => {
  const stored = [];
  await assert.rejects(
    () => allocateSalesOrderNo({
      now: SHANGHAI_NOON,
      maxAttempts: 3,
      readExistingNos: async () => [...stored],
      // 每次写完都有第二个人写同一个号：永远撞
      writeOrderNo: async (orderNo) => { stored.push(orderNo, orderNo); },
    }),
    /连续 3 次被并发写入占用/,
  );
  // 每次尝试都往前推进一个号，不会原地打转
  assert.deepEqual([...new Set(stored)], [
    'XSD-20261005-0001', 'XSD-20261005-0002', 'XSD-20261005-0003',
  ]);
});

test('分配器要求注入读写函数，防止被误用成"纯算号"', async () => {
  await assert.rejects(() => allocateSalesOrderNo({ readExistingNos: async () => [] }), /readExistingNos/);
  await assert.rejects(() => allocateSalesOrderNo({ writeOrderNo: async () => undefined }), /readExistingNos/);
});
