/**
 * 采购页提交判据（AC-P11..P16）：同步校验 → 种子草稿 → 后台 `engine.submitDraft` → 既有写入件。
 * 关键口径：提交前零写入；复用既有 `multiItemOrderService` + `publishPurchaseRequest`；
 * `submitKey` 原样透传 + 同 key 重复提交 ⇒ reused；异步先回 accepted、后台失败如实留痕。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  config, makeEnv, itemsOf, productRecord, SUBMIT_KEY,
} = require('./support/procurementSubmitEnv');

test('AC-P12 submitKey 非法 ⇒ 400 人话 + 零写入 + 零后台', async () => {
  const env = makeEnv();
  for (const key of ['', 'short', 'a'.repeat(200), 'has space', 'bad/chars']) {
    const result = await env.service.submit({ openId: env.openId, submitKey: key, items: itemsOf() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'submit_key_invalid');
    assert.equal(result.message, config.texts.submitKeyInvalid);
  }
  assert.equal(env.data.size, 0, '校验失败不许写会话');
  assert.equal(env.scheduled.length, 0, '校验失败不许排后台');
});

test('AC-P12 空单 / items 形状坏 ⇒ 400 + 零写入', async () => {
  const env = makeEnv();
  for (const items of [[], null, [{ entries: [] }], [{ productRecordId: 'recA' }]]) {
    const result = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items });
    assert.equal(result.ok, false);
    assert.ok(['empty_items', 'item_invalid'].includes(result.code));
  }
  assert.equal(env.data.size, 0);
  assert.equal(env.scheduled.length, 0);
});

test('AC-P12 同一货品同一尺码重复 ⇒ duplicate_line（引擎判据）+ 零写入', async () => {
  const env = makeEnv();
  const result = await env.service.submit({
    openId: env.openId, submitKey: SUBMIT_KEY,
    items: [{
      productRecordId: 'recA',
      entries: [{ size: 39, quantity: 1 }, { size: 39, quantity: 2 }],
    }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'duplicate_line');
  assert.equal(env.data.size, 0);
  assert.equal(env.scheduled.length, 0);
});

test('AC-P12 超过 20 货品 / 超过 50 行 ⇒ too_many_products / too_many_lines + 零写入', async () => {
  const many = makeEnv();
  const manyResult = await many.service.submit({
    openId: many.openId, submitKey: SUBMIT_KEY,
    items: Array.from({ length: 21 }, (_, index) => ({ productRecordId: `rec${index}`, entries: [{ size: 39, quantity: 1 }] })),
  });
  assert.equal(manyResult.code, 'too_many_products');
  const long = makeEnv();
  const longResult = await long.service.submit({
    openId: long.openId, submitKey: SUBMIT_KEY,
    items: [{ productRecordId: 'recA', entries: Array.from({ length: 51 }, (_, index) => ({ size: 100 + index, quantity: 1 })) }],
  });
  assert.equal(longResult.code, 'too_many_lines');
  assert.equal(many.data.size + long.data.size, 0);
});

test('AC-P12 货品记录 ID 查不到 ⇒ product_missing（人话）+ 零写入 + 零后台', async () => {
  const env = makeEnv({ products: [productRecord('recOther')] });
  const result = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'product_missing');
  assert.equal(result.message, config.texts.productMissing);
  assert.equal(env.data.size, 0);
  assert.equal(env.scheduled.length, 0);
});

test('AC-P13/P14 成功：种子草稿 + 只排一次后台；后台跑 = 一次既有 publishPurchaseRequest', async () => {
  const env = makeEnv();
  const result = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.message, config.texts.submitAccepted);
  const draft = env.draftOf();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.submit_key, SUBMIT_KEY);
  assert.equal(draft.items[0].supplier_record_id, 'recSupplier', '供应商由服务端按记录ID权威反查');
  // Bug-2 回归：batch 形状归一化后，payload 不许出现 `[object Object]`、颜色必须解析出来
  assert.equal(draft.items[0].number, 'no_recA');
  assert.equal(draft.items[0].item_no, 'item_recA');
  assert.equal(draft.items[0].color, '黑色');
  assert.equal(/\[object Object\]/.test(JSON.stringify(draft.items)), false);
  assert.equal(env.scheduled.length, 1);
  assert.equal(env.scheduled[0].chain, 'replenish');
  assert.equal(env.scheduled[0].submitKey, SUBMIT_KEY);
  assert.equal(env.behaviorCalls.length, 1, '采购行为在排后台之前当场解析');

  const backgroundResult = await env.scheduled[0].run();
  assert.equal(backgroundResult.ok, true);
  assert.equal(env.purchaseCalls.length, 1, '只走一次既有写入件');
  const { taskId, payload } = env.purchaseCalls[0];
  assert.match(taskId, /scan_replenish_/);
  assert.match(taskId, /procurement_test_key_0001/);
  assert.equal(payload.is_batch, true);
  assert.deepEqual(payload.items.map((line) => [line.product_record_id, line.size, line.quantity]), [
    ['recA', 39, 1], ['recA', 40, 2],
  ]);
  assert.equal(env.draftOf().status, 'submitted', '提交成功后草稿状态 = submitted（下一单换键）');
});

test('AC-P15 同一 submitKey 重复提交 ⇒ reused，不再排后台、不再写一次', async () => {
  const env = makeEnv();
  await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  await env.scheduled[0].run();
  const again = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(env.scheduled.length, 1);
  assert.equal(env.purchaseCalls.length, 1);
});

test('AC-P14 采购行为解析不到 ⇒ 502 人话 + 零写入 + 零后台（不假装成功）', async () => {
  const env = makeEnv({ behavior: () => { throw new Error('行为管理中找不到已配置行为：PURCHASE_ORDER'); } });
  const result = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'behavior_missing');
  assert.equal(env.data.size, 0);
  assert.equal(env.scheduled.length, 0);
});

test('AC-P14 后台写入抛错 ⇒ 不假成功：HTTP 已 accepted，但会话落 failed + last_error', async () => {
  const env = makeEnv({ purchase: () => { throw new Error('bitable down'); } });
  const result = await env.service.submit({ openId: env.openId, submitKey: SUBMIT_KEY, items: itemsOf(['recA']) });
  assert.equal(result.ok, true);
  const backgroundResult = await env.scheduled[0].run();
  assert.equal(backgroundResult.ok, false);
  const draft = env.draftOf();
  assert.equal(draft.status, 'failed');
  assert.match(String(draft.last_error), /bitable down/);
});
