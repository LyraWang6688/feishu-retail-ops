// 回填口径（config/salesStatusBackfill）与回填脚本（scripts/backfill-sales-status）的用例。
//
// 重点不是"能不能写"，而是**写得对不对 + 写不出去**：
//   · 旧值 → 新值的映射逐条钉死（写错的值会永久留在飞书选项里）；
//   · 「入账中」必须留空（不替历史编事实）；
//   · 新字段已有值时不许覆盖（脚本可以重复跑）；
//   · 真跑只在 app_token == 测试 Base 时允许，其余一律拒绝、且**在发请求之前**拒绝；
//   · 干跑一次写调用都不能发生。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKFILL_LEGACY_CONFIRM_FIELD,
  BACKFILL_TARGET_FIELDS,
  BACKFILL_EXCLUDED_DIMENSIONS,
  BACKFILL_EXCLUDED_FIELDS,
  BACKFILL_VALUES,
  planRecord,
  planBackfill,
  fingerprint,
  assertBackfillTarget,
  formatImpactList,
} = require('../src/config/salesStatusBackfill');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { parseArgs, applyPlan, run } = require('../scripts/backfill-sales-status');

const FIELDS = V1_BITABLE_SCHEMA.tables.salesEntry.fields;

const record = (id, legacyValue, extra = {}) => ({
  record_id: id,
  fields: {
    销售单号: `XSD-${id}`,
    [BACKFILL_LEGACY_CONFIRM_FIELD]: legacyValue,
    ...extra,
  },
});

test('回填只碰「确认状态」「资金状态」，销售/库存状态不在范围内', () => {
  assert.deepEqual(BACKFILL_TARGET_FIELDS, { userAction: '确认状态', funds: '资金状态' });
  assert.deepEqual([...BACKFILL_EXCLUDED_DIMENSIONS], ['sales', 'stock']);
  assert.deepEqual([...BACKFILL_EXCLUDED_FIELDS], ['销售状态', '库存状态']);
  // 目标字段名必须就是 schema 里新维度的字段名（改名前回填会写到旧列上）。
  assert.equal(FIELDS.userAction, BACKFILL_TARGET_FIELDS.userAction);
  assert.equal(FIELDS.funds, BACKFILL_TARGET_FIELDS.funds);
  // 值域必须与 salesStatusDimensions 的四组字面量一致（这里只用到其中三个）。
  assert.equal(BACKFILL_VALUES.funds.WRITTEN, '已写入');
  assert.equal(BACKFILL_VALUES.funds.FAILED, '写入失败');
  assert.equal(BACKFILL_VALUES.userAction.PENDING, '未确认');
  assert.equal(BACKFILL_VALUES.userAction.CANCELLED, '已取消');
  assert.equal(BACKFILL_VALUES.userAction.TO_MODIFY, '待修改');
});

test('旧值 → 新字段的映射逐条钉死', () => {
  const cases = [
    ['已入账', 'funds', '已写入'],
    ['入账失败', 'funds', '写入失败'],
    ['待确认', 'userAction', '未确认'],
    ['已取消', 'userAction', '已取消'],
    ['待修改', 'userAction', '待修改'],
  ];
  for (const [legacy, dimension, value] of cases) {
    const item = planRecord(record('rec_1', legacy), { fieldNames: FIELDS });
    assert.equal(item.action, 'update', `${legacy} 应该会改`);
    assert.deepEqual(item.changes, [{
      semanticKey: dimension, field: BACKFILL_TARGET_FIELDS[dimension], from: '', to: value,
    }], `${legacy} 的改动计划`);
  }
});

test('「入账中」刻意留空：不写任何字段，但留一句人看得懂的理由', () => {
  const item = planRecord(record('rec_1', '入账中'), { fieldNames: FIELDS });
  assert.equal(item.action, 'skip');
  assert.deepEqual(item.changes, []);
  assert.match(item.reason, /留空/);
  assert.match(item.reason, /闸门保持关闭/);
});

test('空值 / 未定义的值都不猜，只跳过', () => {
  const empty = planRecord(record('rec_1', ''), { fieldNames: FIELDS });
  assert.equal(empty.action, 'skip');
  assert.match(empty.reason, /旧字段为空/);
  const unknown = planRecord(record('rec_2', '某个她手工加的选项'), { fieldNames: FIELDS });
  assert.equal(unknown.action, 'skip');
  assert.match(unknown.reason, /没有回填规则/);
});

test('新字段已有值时绝不覆盖（脚本可以安全地重复跑）', () => {
  const item = planRecord(record('rec_1', '已入账', { 资金状态: '写入失败' }), { fieldNames: FIELDS });
  assert.equal(item.action, 'skip');
  assert.match(item.reason, /不覆盖/);
  assert.match(item.reason, /写入失败/);
});

test('汇总：会改几条、按维度拆分、按旧值分布', () => {
  const { summary } = planBackfill([
    record('a', '已入账'), record('b', '已入账'), record('c', '入账失败'),
    record('d', '待确认'), record('e', '入账中'), record('f', ''), record('g', '未知值'),
  ], { fieldNames: FIELDS });
  assert.equal(summary.scanned, 7);
  assert.equal(summary.willUpdate, 4);
  assert.equal(summary.skipped, 3);
  assert.deepEqual(summary.byDimension, { userAction: 1, funds: 3 });
  const byValue = Object.fromEntries(summary.byLegacyValue.map((row) => [row.legacyValue, row]));
  assert.equal(byValue['已入账'].count, 2);
  assert.equal(byValue['已入账'].willUpdate, 2);
  assert.equal(byValue['入账中'].willUpdate, 0);
  assert.equal(byValue[''].outcome, '旧字段为空 → 不改');
  assert.equal(byValue['未知值'].outcome, '未定义的值 → 不改');
});

test('token 只以指纹出现，不泄漏原文', () => {
  const token = 'GqMMbhnxGaaEdDsNz2Tcug1nnlb';
  const print = fingerprint(token);
  assert.ok(!print.includes(token));
  assert.ok(!print.includes(token.slice(0, 4)));
  assert.match(print, /^sha256:[0-9a-f]{8}$/);
  assert.equal(fingerprint(''), '(未配置)');
  assert.equal(fingerprint(token), fingerprint(token), '同一 token 指纹稳定');
});

test('硬闸门：真跑只允许 app_token == 测试 Base；干跑任何时候都放行', () => {
  const testToken = 'test_base_token';
  // 干跑：目标是谁都行（只读）。
  assert.equal(assertBackfillTarget({ appToken: 'prod', testAppToken: testToken, apply: false }).targetIsTestBase, false);
  assert.equal(assertBackfillTarget({ appToken: testToken, testAppToken: testToken, apply: false }).targetIsTestBase, true);
  // 真跑：必须逐字相等。
  assert.equal(assertBackfillTarget({ appToken: testToken, testAppToken: testToken, apply: true }).targetIsTestBase, true);
  assert.throws(
    () => assertBackfillTarget({ appToken: 'prod_token', testAppToken: testToken, apply: true }),
    /拒绝真跑/,
  );
  // 没配测试 Base = 证不出目标是谁 → 也不许真跑。
  assert.throws(
    () => assertBackfillTarget({ appToken: 'prod_token', testAppToken: '', apply: true }),
    /拒绝真跑/,
  );
  // 目标 Base 没配 → 连干跑都不许（读都没地方读）。
  assert.throws(() => assertBackfillTarget({ appToken: '', testAppToken: testToken }), /没有配置目标 Base/);
  // 拒绝信息里不许回显 token 原文。
  assert.throws(
    () => assertBackfillTarget({ appToken: 'prod_token', testAppToken: testToken, apply: true }),
    (error) => !error.message.includes('prod_token') && !error.message.includes(testToken),
  );
});

test('影响清单：人看得懂的那几句必须在', () => {
  const plan = planBackfill([
    record('rec_1', '已入账'), record('rec_2', '入账失败'), record('rec_3', '入账中'),
    record('rec_4', '待确认'), record('rec_5', ''),
  ], { fieldNames: FIELDS });
  const text = formatImpactList({
    plan, mode: 'dry-run', appToken: 'test_base_token', testAppToken: 'test_base_token',
    tableName: '销售主表', tableId: 'tblTEST', envLabel: 'test', sampleSize: 2,
  });
  assert.match(text, /DRY-RUN/);
  assert.match(text, /扫描记录    : 5 条/);
  assert.match(text, /会修改      : 3 条（确认状态 1 条 \/ 资金状态 2 条）/);
  assert.match(text, /不改        : 2 条/);
  assert.match(text, /已入账/);
  assert.match(text, /销售状态 \/ 库存状态/);
  // 示例里要能看见"从什么改成什么"。
  assert.match(text, /资金状态：「」 → 「已写入」/);
  assert.match(text, /1\) rec_1/);
});

test('parseArgs：默认干跑，--apply 才真跑，非法值当场报错', () => {
  assert.equal(parseArgs([]).mode, 'dry-run');
  assert.equal(parseArgs(['--apply']).mode, 'apply');
  assert.equal(parseArgs(['--limit', '5']).limit, 5);
  assert.equal(parseArgs(['--limit=7']).limit, 7);
  assert.equal(parseArgs(['--sample=1']).sampleSize, 1);
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
  assert.throws(() => parseArgs(['--limit', 'abc']), /--limit/);
});

// --- 脚本：干跑不写、真跑逐条写 -------------------------------------------------------

const fakeGateway = ({ records = [], appToken = 'test_base_token' } = {}) => {
  const updates = [];
  const schema = {
    ...V1_BITABLE_SCHEMA,
    appToken,
    tables: {
      ...V1_BITABLE_SCHEMA.tables,
      salesEntry: { ...V1_BITABLE_SCHEMA.tables.salesEntry },
    },
  };
  return {
    updates,
    table: (key) => schema.tables[key],
    listFields: async () => Object.values(schema.tables.salesEntry.fields).map((name) => ({ field_name: name })),
    listAll: async () => records,
    update: async (tableKey, recordId, values) => { updates.push({ tableKey, recordId, values }); },
  };
};

test('run：干跑一次 update 都不发生，并打印影响清单', async () => {
  const gateway = fakeGateway({ records: [record('rec_1', '已入账')] });
  const lines = [];
  const result = await run({
    options: { mode: 'dry-run', json: false, limit: 0, sampleSize: 3 },
    env: { FEISHU_V1_BITABLE_APP_TOKEN: 'test_base_token', FEISHU_V1_E2E_TEST_APP_TOKEN: 'test_base_token', FEISHU_TARGET_ENV: 'test' },
    gateway,
    out: (line) => lines.push(line),
  });
  assert.equal(gateway.updates.length, 0, '干跑不许写');
  assert.equal(result.updated.length, 0);
  assert.ok(lines.join('\n').includes('DRY-RUN'));
});

test('run：真跑按语义键逐条写，并跳过不该改的', async () => {
  const gateway = fakeGateway({ records: [record('rec_1', '已入账'), record('rec_2', '入账中'), record('rec_3', '待确认')] });
  const result = await run({
    options: { mode: 'apply', json: false, limit: 0, sampleSize: 3 },
    env: { FEISHU_V1_BITABLE_APP_TOKEN: 'test_base_token', FEISHU_V1_E2E_TEST_APP_TOKEN: 'test_base_token', FEISHU_TARGET_ENV: 'test' },
    gateway,
    out: () => {},
  });
  assert.deepEqual(gateway.updates, [
    { tableKey: 'salesEntry', recordId: 'rec_1', values: { funds: '已写入' } },
    { tableKey: 'salesEntry', recordId: 'rec_3', values: { userAction: '未确认' } },
  ]);
  assert.equal(result.updated.length, 2);
  assert.equal(result.failed.length, 0);
});

test('run：目标不是测试 Base 时真跑被拒，且一条请求都没发出去', async () => {
  const gateway = fakeGateway({ records: [record('rec_1', '已入账')] });
  let listCalled = false;
  gateway.listAll = async () => { listCalled = true; return []; };
  await assert.rejects(() => run({
    options: { mode: 'apply', json: false, limit: 0, sampleSize: 3 },
    env: { FEISHU_V1_BITABLE_APP_TOKEN: 'production_token', FEISHU_V1_E2E_TEST_APP_TOKEN: 'test_base_token' },
    gateway,
    out: () => {},
  }), /拒绝真跑/);
  assert.equal(listCalled, false, '闸门必须在读表之前就拦下来');
  assert.equal(gateway.updates.length, 0);
});

test('applyPlan：一条失败不中断整批，失败逐条报出来', async () => {
  const items = planBackfill([record('a', '已入账'), record('b', '已入账')], { fieldNames: FIELDS }).items;
  const lines = [];
  const result = await applyPlan({
    items,
    out: (line) => lines.push(line),
    gateway: {
      update: async (_table, recordId) => {
        if (recordId === 'b') throw new Error('飞书说不行');
      },
    },
  });
  assert.equal(result.updated.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].recordId, 'b');
  assert.equal(result.failed[0].error, '飞书说不行');
  assert.ok(lines.join('\n').includes('✓ a'));
  assert.ok(lines.join('\n').includes('✗ b'));
});
