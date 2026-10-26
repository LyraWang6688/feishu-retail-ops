'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSalesOrderNoCache } = require('../src/services/salesOrderNoCache');

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-order-no-'));
  let clock = Date.parse('2026-10-26T10:00:00+08:00');
  const calls = { list: 0 };
  const gateway = {
    table: () => ({ fields: { orderNo: '销售单号' } }),
    listByFilter: async () => {
      calls.list += 1;
      return [
        { record_id: 'a', fields: { 销售单号: 'XSD-20261026-0003' } },
        { record_id: 'b', fields: { 销售单号: 'XSD-20261026-0007' } },
        { record_id: 'c', fields: { 销售单号: 'XSD-20261025-0099' } },
      ];
    },
  };
  const cache = createSalesOrderNoCache({ gateway, file: path.join(dir, 'cache.json'), now: () => clock });
  return { cache, calls, dir, advance: (ms) => { clock += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('第一次从当天最大号开始，之后本地递增不再读表', async () => {
  const h = make();
  try {
    const a = await h.cache.next();
    assert.equal(a.orderNo, 'XSD-20261026-0008');
    assert.equal(h.calls.list, 1);
    const b = await h.cache.next();
    assert.equal(b.orderNo, 'XSD-20261026-0009');
    assert.equal(h.calls.list, 1, '之后不许再读表');
  } finally { h.cleanup(); }
});

test('持久化后新实例继续用同一个序号', async () => {
  const h = make();
  try {
    await h.cache.next();
    const second = createSalesOrderNoCache({
      gateway: { table: () => ({ fields: { orderNo: '销售单号' } }), listByFilter: async () => { throw new Error('不该读表'); } },
      file: h.cache.file,
      now: () => Date.parse('2026-10-26T11:00:00+08:00'),
    });
    const n = await second.next();
    assert.equal(n.orderNo, 'XSD-20261026-0009');
  } finally { h.cleanup(); }
});

test('跨天重新从表里初始化；bump 可推进序号', async () => {
  const h = make();
  try {
    const a = await h.cache.next();
    assert.equal(a.sequence, 8);
    h.cache.bump(20);
    const b = await h.cache.next();
    assert.equal(b.sequence, 21);
    h.advance(24 * 60 * 60 * 1000);
    const c = await h.cache.next();
    assert.equal(c.date, '20261027');
    assert.equal(c.sequence, 1);
  } finally { h.cleanup(); }
});
