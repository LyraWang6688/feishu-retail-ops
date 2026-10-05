const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDocumentRows } = require('../src/services/doubaoService');
const doubaoService = require('../src/services/doubaoService');

// 到货单是表格照片，模型很容易把表头那一排毫米制尺码照抄下来。
// 提示词里已经要求换算，这里再兜一层确定性的规则（欧码 = (数值 - 50) / 5）。
test('document rows convert millimetre sizes to EU sizes', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 240, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 250, quantity: 2 },
  ]);
  assert.deepEqual(rows, [
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 40, quantity: 2 },
  ]);
});

test('document rows keep EU sizes and coerce string numbers', () => {
  const rows = normalizeDocumentRows([{ item_no: ' 628-6 ', color: '米紫', size: '36', quantity: '1' }]);
  assert.deepEqual(rows, [{ item_no: '628-6', color: '米紫', size: 36, quantity: 1 }]);
});

test('document rows drop rows that would write a wrong size or quantity', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 1 },
    { item_no: '', color: '棕色', size: 38, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 0, quantity: 1 },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 0 },
    { item_no: '1366-31', color: '棕色', size: 42.5, quantity: 1 },
  ]);
  assert.deepEqual(rows, [{ item_no: '1366-31', color: '棕色', size: 37, quantity: 1 }]);
});

test('document rows tolerate a non-array model response', () => {
  assert.deepEqual(normalizeDocumentRows(null), []);
  assert.deepEqual(normalizeDocumentRows({ items: [] }), []);
});

// ─── 模型客户端的超时 ───
//
// 到货识别"卡死"的一半原因是客户端根本没设超时：OpenAI SDK 默认 timeout 600s
// 且失败重试 2 次，一次视觉调用最坏能挂半小时，而用户只会看到「识别中」。

const withEnv = (values, run) => {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const LLM_CREDENTIALS = {
  VISION_LLM_API_KEY: 'test_key',
  VISION_LLM_BASE_URL: 'https://example.invalid/v1',
  VISION_LLM_MODEL: 'vision-test',
  TEXT_LLM_API_KEY: 'test_key',
  TEXT_LLM_BASE_URL: 'https://example.invalid/v1',
  TEXT_LLM_MODEL: 'text-test',
};

test('视觉客户端有硬超时且不重试；文字客户端保持 SDK 默认（不碰销售链路）', () => {
  const savedClients = doubaoService.clients;
  doubaoService.clients = Object.create(null);
  try {
    withEnv({ ...LLM_CREDENTIALS, VISION_LLM_TIMEOUT_MS: '' }, () => {
      const vision = doubaoService.getClient('vision');
      assert.equal(vision.timeout, 60_000, '视觉识别必须有 60 秒上限');
      assert.equal(vision.maxRetries, 0, '不重试：重试会把最坏耗时再乘一遍');

      const text = doubaoService.getClient('text');
      // 不传 timeout 就是 SDK 默认值：销售录单那条链路这次一行没动。
      assert.equal(text.timeout, 600_000);
    });

    // 线上如果发现 60 秒太紧，用环境变量就能调宽，不必改代码。
    doubaoService.clients = Object.create(null);
    withEnv({ ...LLM_CREDENTIALS, ...{ VISION_LLM_TIMEOUT_MS: '90000' } }, () => {
      assert.equal(doubaoService.getClient('vision').timeout, 90_000);
    });
  } finally {
    doubaoService.clients = savedClients;
  }
});

// ─── 到货单价格 → unit_cost ───
// 产品负责人的口径：单据上有价格，那就是成本。模型可能把「销售价」列回成
// unit_cost / unitCost / cost / price，字符串里还可能带 ￥ / 元 / 千分位。

test('document rows parse the per-piece price into unit_cost', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 2, unit_cost: '￥199.00' },
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1, unitCost: '1,299元/双' },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 1, price: '209' },
  ]);
  assert.deepEqual(rows.map((row) => row.unit_cost), [199, 199, 1299, 209]);
});

test('document rows keep only a partial set of prices (rows without a price stay on the sheet)', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
    { item_no: '8088', color: '灰色', size: 38, quantity: 1 },
  ]);
  assert.equal(rows.length, 2, '没有价格的行仍然要入库，只是不写成本');
  assert.equal(rows[0].unit_cost, 199);
  assert.equal('unit_cost' in rows[1], false, '没价格时不能挂一个 undefined/null 的 unit_cost');
});

test('document rows drop unusable prices instead of writing a wrong cost', () => {
  const rows = normalizeDocumentRows([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: '面议' },
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 1, unit_cost: 0 },
    { item_no: '1366-31', color: '棕色', size: 38, quantity: 1, unit_cost: '199-299' },
    { item_no: '1366-31', color: '棕色', size: 39, quantity: 1, unit_cost: '199' },
  ]);
  assert.deepEqual(rows.map((row) => row.unit_cost), [undefined, undefined, undefined, 199]);
  // 更严格地说：非法价格连 key 都不该出现（否则下游会把 null 当成"识别到了价格"）。
  assert.equal('unit_cost' in rows[0], false);
  assert.equal('unit_cost' in rows[1], false);
  assert.equal('unit_cost' in rows[2], false);
});
