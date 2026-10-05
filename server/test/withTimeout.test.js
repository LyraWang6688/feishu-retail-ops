const test = require('node:test');
const assert = require('node:assert/strict');
const { withTimeout, withTimeoutProxy, TimeoutError } = require('../src/utils/withTimeout');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

test('正常返回时原样透传结果，不做多余包装', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, '调用'), 'ok');
  // 超时时间不合法（0 / 负数 / 非数字）时不包装，等价于原来的行为。
  assert.equal(await withTimeout(Promise.resolve('raw'), 0, '调用'), 'raw');
  assert.equal(await withTimeout(Promise.resolve('raw'), undefined, '调用'), 'raw');
});

test('超时会抛 TimeoutError，并且带上"是哪一步超时"', async () => {
  await assert.rejects(withTimeout(never(), 400, '下载到货图片'), (error) => {
    assert.ok(error instanceof TimeoutError);
    assert.equal(error.name, 'TimeoutError');
    // 复用 ETIMEDOUT，日志和上层判断都认这个码。
    assert.equal(error.code, 'ETIMEDOUT');
    assert.match(error.message, /下载到货图片超时/);
    return true;
  });
});

test('底层请求在超时之后才失败，也不会变成 unhandledRejection', async () => {
  // 超时是「我们不等了」，不是「对面一定失败了」：对面晚一点 reject 不能把进程搞崩。
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let failLate;
    const slow = new Promise((_, reject) => { failLate = reject; });
    await assert.rejects(withTimeout(slow, 400, '慢调用'), /超时/);
    failLate(new Error('对面终于失败了'));
    await wait(800);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('withTimeoutProxy 只包异步方法：同步方法（gateway.table 这类）必须保持同步', async () => {
  // 这个坑踩过：把同步的 table() 变成 Promise，`gateway.table('x').fields.y` 全成了 undefined，
  // 直接把整条采购链路打挂。
  const table = { fields: { images: '图片' } };
  const slow = withTimeoutProxy({
    table: () => table,
    fields: () => ({ a: 1 }),
    get: async () => 'record',
    listAll: async () => ['a'],
  }, { timeoutMs: 400, prefix: 'gateway.' });

  assert.equal(slow.table('purchaseArrival'), table);
  assert.deepEqual(slow.fields(), { a: 1 });
  assert.equal(await slow.get(), 'record');
  assert.deepEqual(await slow.listAll(), ['a']);

  // 同步方法同步抛错，也要原样抛出（不能变成 rejected promise）。
  const throwing = withTimeoutProxy({
    boom: () => { throw new Error('同步错误'); },
    hang: async () => never(),
  }, { timeoutMs: 400, prefix: 'gateway.' });
  assert.throws(() => throwing.boom(), /同步错误/);
  await assert.rejects(throwing.hang(), /gateway\.hang超时/);
});

test('withTimeoutProxy 在超时为 0 时原样返回对象，不改变任何行为', () => {
  const target = { get: async () => 1 };
  assert.equal(withTimeoutProxy(target, { timeoutMs: 0 }), target);
});
