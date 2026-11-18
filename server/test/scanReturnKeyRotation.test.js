'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScanSessionService } = require('../src/services/scanSessionService');

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-return-key-'));
  return { dir, service: createScanSessionService({ dir }) };
};

test('AC-RK1 退货排后台后立即轮换 key；后台完成只回填结果，不再二次轮换', async () => {
  const h = makeService();
  try {
    const openId = 'ou_return_key_1';
    const first = await h.service.ensure(openId);
    const key1 = first.purchaseReturn.key;
    await h.service.beginPurchaseReturn(openId, { key: key1 });
    const afterBegin = await h.service.get(openId);
    assert.notEqual(afterBegin.purchaseReturn.key, key1, 'begin 后必须是下一把 key');
    assert.match(afterBegin.purchaseReturn.key, /:2$/);
    assert.equal(afterBegin.purchaseReturn.completed[0].pending, true);

    await h.service.completePurchaseReturn(openId, { key: key1, result: { batch_no: 'CGD-1' } });
    const afterDone = await h.service.get(openId);
    assert.equal(afterDone.purchaseReturn.key, afterBegin.purchaseReturn.key, '完成不得二次轮换');
    assert.equal(afterDone.purchaseReturn.completed[0].pending, false);
    assert.equal(afterDone.purchaseReturn.completed[0].batch_no, 'CGD-1');

    // 同一把旧 key 再 begin 是幂等的：不能再跳一把。
    await h.service.beginPurchaseReturn(openId, { key: key1 });
    const afterDuplicate = await h.service.get(openId);
    assert.equal(afterDuplicate.purchaseReturn.key, afterBegin.purchaseReturn.key);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('AC-RK2 两笔连续退货拿到不同 key，互不吸收', async () => {
  const h = makeService();
  try {
    const openId = 'ou_return_key_2';
    const first = await h.service.ensure(openId);
    const key1 = first.purchaseReturn.key;
    await h.service.beginPurchaseReturn(openId, { key: key1 });
    const second = await h.service.get(openId);
    const key2 = second.purchaseReturn.key;
    assert.notEqual(key1, key2);
    await h.service.beginPurchaseReturn(openId, { key: key2 });
    const third = await h.service.get(openId);
    assert.notEqual(key2, third.purchaseReturn.key);
    assert.deepEqual(third.purchaseReturn.completed.map((item) => item.key), [key1, key2]);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
