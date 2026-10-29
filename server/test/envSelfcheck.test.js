'use strict';

/**
 * envSelfcheck.test.js —— `scripts/env-selfcheck.mjs` 的**离线**闸门（不联网、不写任何表、不需要真凭证）。
 *
 * 为什么它必须存在：这个脚本的全部价值是「**把 'ID 过期' 与 '缺字段' 分开报**」——
 * 一旦有人把这两条合并、或让它"读不到也照绿"，本机 ID 过期就会**再次**被读成"表结构不一致"
 * （2026-07-12 的真实误判）。所以这里把四条 AC 钉死：
 *   ① ID 过期 ⇒ 该行 `stale_id` 且**退出码非零**；
 *   ② ID 对但缺字段 ⇒ `missing_fields` 且**逐字列出缺哪个**；
 *   ③ 全部正确 ⇒ **退出码 0**；
 *   ④ 输出里**不含明文 token**（自证段只打指纹）。
 * 另外：脚本的"表 → 环境变量名"映射是**解析 schema 源码**得来的（不写死），
 * 这里也钉一条——新增表被静默漏检时必须能看出来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'env-selfcheck.mjs');

// 动态 import：脚本用 `import.meta.url === pathToFileURL(argv[1])` 守卫 main()，
// 所以这里 import 它**不会**连飞书、也不会读 .env。
const load = () => import(pathToFileURL(scriptPath).href);

const fakeClient = ({ tables = [], fields = {} } = {}) => ({
  bitable: {
    appTable: {
      list: async () => ({ code: 0, data: { items: tables, has_more: false } }),
    },
  },
  __fields: fields,
});

// 网关替身：只实现 runSelfcheck 用到的那一个方法（真网关的逻辑另有单测覆盖）。
const fakeGateway = ({ fields = {}, errors = {} } = {}) => ({
  listFields: async (tableKey) => {
    if (errors[tableKey]) throw errors[tableKey];
    return (fields[tableKey] || []).map((name) => ({ field_name: name }));
  },
});

const tableRow = (over) => ({
  key: 'product',
  envVar: 'FEISHU_V1_PRODUCT_TABLE_ID',
  tableId: 'tblA',
  expectedName: '货品信息',
  fieldNames: ['货号', '颜色'],
  ...over,
});

test('classifyReadError：TableIdNotFound 必须单独判成「ID 过期」，不许混成缺字段', async () => {
  const { classifyReadError } = await load();
  const sdkError = { response: { data: { code: 1254041, msg: 'TableIdNotFound' } } };
  assert.equal(classifyReadError(sdkError).kind, 'stale_id');
  assert.equal(classifyReadError({ bitableCode: 1254041, message: 'x' }).kind, 'stale_id');
  assert.equal(classifyReadError({ message: 'NOTEXIST' }).kind, 'stale_id');
  assert.equal(classifyReadError({ message: '404 page not found' }).kind, 'unconfigured');
  assert.equal(classifyReadError({ response: { data: { code: 99991663, msg: 'rate limit' } } }).kind, 'read_failed');
});

test('parseTableEnvVars：解析 schema 源码里的「表 → 环境变量名」（含 tableName 与 tableId 之间夹注释）', async () => {
  const { parseTableEnvVars } = await load();
  const fixture = [
    'const V1_BITABLE_SCHEMA = {',
    '  tables: {',
    '    product: {',
    "      tableName: '货品信息',",
    "      tableId: getEnv('FEISHU_V1_PRODUCT_TABLE_ID', 'tblDefault'),",
    '      fields: { number: \'编号\' },',
    '    },',
    '    purchaseRequest: {',
    '      // 夹一段注释：改名沿革（真实文件里就是这样）',
    "      tableName: '采购明细',",
    "      tableId: getEnv('FEISHU_V1_PURCHASE_REQUEST_TABLE_ID', 'tblX'),",
    '    },',
    '  },',
    '};',
  ].join('\n');
  const parsed = parseTableEnvVars(fixture);
  assert.equal(parsed.get('product'), 'FEISHU_V1_PRODUCT_TABLE_ID');
  assert.equal(parsed.get('purchaseRequest'), 'FEISHU_V1_PURCHASE_REQUEST_TABLE_ID');
  assert.equal(parsed.size, 2);
});

test('真 schema 源码：每张表都能解析到它读的环境变量名（新增表不许被静默漏检）', async () => {
  const { parseTableEnvVars } = await load();
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'config', 'v1BitableSchema.js'), 'utf8',
  );
  const parsed = parseTableEnvVars(source);
  // 在**不加载 env** 的前提下 require schema（tableId 取默认值即可，我们只比对 key）
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  const keys = Object.keys(V1_BITABLE_SCHEMA.tables);
  assert.deepEqual([...parsed.keys()].sort(), [...keys].sort(),
    '「表 → 环境变量名」映射必须与 schema.tables 一一对应；对不上就说明解析器漏了表');
});

test('AC①：表 ID 过期 ⇒ 该行 stale_id · 计入退出码 ⇒ 退出码非零', async () => {
  const { runSelfcheck, exitCodeFor } = await load();
  const result = await runSelfcheck({
    client: fakeClient({ tables: [{ table_id: 'tblB', name: '别的表' }] }),
    gateway: fakeGateway(),
    tables: [tableRow()],
    env: { FEISHU_V1_PRODUCT_TABLE_ID: 'tblA' },
    inScopeKeys: ['product'],
    appToken: 'base_token_fake',
  });
  assert.equal(result.rows[0].status, 'stale_id');
  assert.equal(result.rows[0].impactsExit, true);
  const { exitCode, reasons } = exitCodeFor({ rows: result.rows });
  assert.equal(exitCode, 1);
  assert.match(reasons.join('\n'), /ID 过期/);
});

test('AC①b：ID 过期但 Base 里有同名表 ⇒ 直接给出「该填哪个 ID」（本次误判差的就是这一步）', async () => {
  const { runSelfcheck } = await load();
  const result = await runSelfcheck({
    client: fakeClient({ tables: [{ table_id: 'tblNew', name: '货品信息' }] }),
    gateway: fakeGateway(),
    tables: [tableRow()],
    env: { FEISHU_V1_PRODUCT_TABLE_ID: 'tblOld' },
    inScopeKeys: ['product'],
    appToken: 'base_token_fake',
  });
  assert.equal(result.rows[0].status, 'stale_id');
  assert.match(result.rows[0].suggestion, /tblNew/);
  assert.match(result.rows[0].suggestion, /FEISHU_V1_PRODUCT_TABLE_ID=tblNew/);
});

test('AC②：ID 正确但缺字段 ⇒ 标 ✗ 且逐字列出缺哪个', async () => {
  const { runSelfcheck, exitCodeFor } = await load();
  const result = await runSelfcheck({
    client: fakeClient({ tables: [{ table_id: 'tblA', name: '货品信息' }] }),
    gateway: fakeGateway({ fields: { product: ['货号'] } }),
    tables: [tableRow()],
    env: { FEISHU_V1_PRODUCT_TABLE_ID: 'tblA' },
    inScopeKeys: ['product'],
    appToken: 'base_token_fake',
  });
  assert.equal(result.rows[0].status, 'missing_fields');
  assert.deepEqual(result.rows[0].missing, ['颜色']);
  assert.match(result.rows[0].detail, /颜色/);
  assert.equal(exitCodeFor({ rows: result.rows }).exitCode, 1);
});

test('AC②b：真表名与 schema 期望不一致 ⇒ 单独标 name_mismatch（闸门按 tableId 走、拦不住表改名）', async () => {
  const { runSelfcheck } = await load();
  const result = await runSelfcheck({
    client: fakeClient({ tables: [{ table_id: 'tblA', name: '货品信息（旧名）' }] }),
    gateway: fakeGateway({ fields: { product: ['货号', '颜色'] } }),
    tables: [tableRow()],
    env: { FEISHU_V1_PRODUCT_TABLE_ID: 'tblA' },
    inScopeKeys: ['product'],
    appToken: 'base_token_fake',
  });
  assert.equal(result.rows[0].status, 'name_mismatch');
  assert.match(result.rows[0].detail, /不校验表名/);
});

test('AC③：全部正确 ⇒ 每行 ok · 退出码 0', async () => {
  const { runSelfcheck, exitCodeFor } = await load();
  const result = await runSelfcheck({
    client: fakeClient({
      tables: [
        { table_id: 'tblA', name: '货品信息' },
        { table_id: 'tblC', name: '采购明细' },
      ],
    }),
    gateway: fakeGateway({ fields: { product: ['货号', '颜色'], purchaseRequest: ['数量'] } }),
    tables: [tableRow(), tableRow({
      key: 'purchaseRequest', envVar: 'FEISHU_V1_PURCHASE_REQUEST_TABLE_ID',
      tableId: 'tblC', expectedName: '采购明细', fieldNames: ['数量'],
    })],
    env: { FEISHU_V1_PRODUCT_TABLE_ID: 'tblA', FEISHU_V1_PURCHASE_REQUEST_TABLE_ID: 'tblC' },
    inScopeKeys: ['product', 'purchaseRequest'],
    appToken: 'base_token_fake',
  });
  assert.deepEqual(result.rows.map((row) => row.status), ['ok', 'ok']);
  assert.equal(exitCodeFor({ rows: result.rows }).exitCode, 0);
});

test('可选项（闸门外的表 · 本机没配过）出问题 ⇒ 只提示、不计入退出码', async () => {
  const { runSelfcheck, exitCodeFor } = await load();
  const result = await runSelfcheck({
    client: fakeClient({ tables: [] }),
    gateway: fakeGateway(),
    tables: [tableRow({
      key: 'paymentDetail', envVar: 'FEISHU_V1_PAYMENT_DETAIL_TABLE_ID',
      tableId: 'tblProdDefault', expectedName: 'P交易明细', fieldNames: [],
    })],
    env: {}, inScopeKeys: [], appToken: 'base_token_fake',
  });
  assert.equal(result.rows[0].status, 'stale_id');
  assert.equal(result.rows[0].impactsExit, false);
  assert.equal(exitCodeFor({ rows: result.rows }).exitCode, 0, '可选项不许把退出码刷红（否则真警报会被淹掉）');
});

test('AC④：输出里不含明文 token（只有指纹）', async () => {
  const { renderReport, findSecretLeaks, fingerprint } = await load();
  const secret = 'GqMMbhnxGaaEdDsNz2Tcug1nnlb';
  const text = renderReport({
    rows: [tableRow({ status: 'stale_id', detail: 'ID 过期', impactsExit: true, scope: '闸门内' })],
    selfProofs: [{
      ok: true,
      label: 'FEISHU_V1_BITABLE_APP_TOKEN 逐字等于 FEISHU_V1_E2E_TEST_APP_TOKEN',
      value: `相等（${fingerprint(secret)}）`,
    }],
    envSources: ['/repo/.env（注入 3 项）'], repo: '/repo', envInjected: 3,
  });
  assert.equal(text.includes(secret), false, '报告里不许出现明文 token');
  assert.match(text, /GqMMbh…\(len=27\)/);
  assert.deepEqual(findSecretLeaks(text, [secret]), []);
  assert.deepEqual(findSecretLeaks(`leak ${secret}`, [secret]), [secret]);
});

test('前提缺失（读不到 Base 表清单）⇒ 逐行标 Base 读不到（不许混成 ID 过期）且退出码非零', async () => {
  const { runSelfcheck, exitCodeFor } = await load();
  const result = await runSelfcheck({
    client: null,
    tables: [tableRow()],
    env: {},
    inScopeKeys: ['product'],
    appToken: '',
    clientError: '缺少 LARK_AGENT_APP_ID',
  });
  assert.equal(result.rows[0].status, 'base_unreadable');
  const { exitCode, reasons } = exitCodeFor({ rows: result.rows, baseError: result.baseError });
  assert.equal(exitCode, 1);
  assert.match(reasons.join('\n'), /前提缺失/);
  // Base 读不到时不许逐行刷"ID 过期"（那正是要分开的两件事）。
  assert.deepEqual(reasons.filter((row) => /ID 过期/.test(row)), []);
});

test('自证 ① 不成立（目标不是授权测试 Base）⇒ 退出码非零', async () => {
  const { exitCodeFor } = await load();
  const ok = exitCodeFor({ rows: [], selfProofOk: true });
  assert.equal(ok.exitCode, 0);
  const bad = exitCodeFor({ rows: [], selfProofOk: false });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.reasons.join('\n'), /不是\*\*授权测试 Base/);
});

test('目标命中生产禁止清单 ⇒ 退出码非零', async () => {
  const { exitCodeFor } = await load();
  const bad = exitCodeFor({ rows: [], targetInForbidden: true });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.reasons.join('\n'), /禁止清单/);
});

test('脚本只读：源码里不许出现写接口（create / update / delete / batch_create）', async () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  for (const forbidden of [
    /appTableRecord\.create/, /appTableRecord\.update/, /appTableRecord\.delete/,
    /appTableRecord\.batchCreate/, /appTableRecord\.batchUpdate/, /appTableField\.create/,
  ]) {
    assert.equal(forbidden.test(source), false, `env-selfcheck 只读，不许出现：${forbidden}`);
  }
  // 只读面必须只在两处：appTable.list + appTableField.list（经项目网关）。
  assert.match(source, /appTable\.list/);
  assert.match(source, /listFields/);
});
