/**
 * `scripts/backfill-product-tag-qr.js` 的**纯函数**护栏（不连网、不碰任何 Base）。
 *
 * 钉住三件事：
 *   ① **默认干跑**：不给 `--write` 就是 dry-run；`--write` 与 `--dry-run` 同时给 ⇒ 干跑赢；
 *   ② 参数解析：`--limit` / `--only`（可多次）/ `--concurrency` / `--interval-ms`；
 *   ③ **闸门形状**：`FEISHU_TARGET_ENV=test` 或 `FEISHU_ALLOW_PRODUCTION_WRITE=true`
 *      才放行真写 —— 生产写入靠后一个（Lead 在服务器上带它跑）。
 *
 * ⚠️ 刻意**不跑**脚本的 `main()`：那会去读真表（本机有测试 Base 的凭证）。
 *    这里只 require 模块拿纯函数 —— `main()` 有 `require.main === module` 守卫。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, selectTargets, buildPlans } = require('../scripts/backfill-product-tag-qr');
const { assertWritableBase } = require('../src/utils/writeTargetGuard');
const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { textValue } = require('../src/services/v1BitableGateway');
const {
  createTagQrCodeService, attachmentsOf, buildFileName, numberFromFileName, sanitizeNumberForFileName,
} = require('../src/services/tagQrCodeService');

test('① 默认是干跑：不给 --write 一个字都不写', () => {
  assert.deepEqual(parseArgs([]), {
    write: false,
    dryRun: true,
    overwrite: false,
    only: [],
    limit: 0,
    concurrency: 0,
    intervalMs: -1,
    envFile: '',
  });
  assert.equal(parseArgs(['--dry-run']).write, false);
  assert.equal(parseArgs(['--write']).write, true);
  assert.equal(parseArgs(['--write']).dryRun, false);
});

test('① --write 与 --dry-run 同时给 ⇒ 以干跑为准（宁可少写，不可误写）', () => {
  const flags = parseArgs(['--write', '--dry-run']);
  assert.equal(flags.write, false);
  assert.equal(flags.dryRun, true);
});

test('② 参数：--limit / --only（可多次）/ --concurrency / --interval-ms / --env-file', () => {
  const flags = parseArgs([
    '--write', '--limit=50', '--only=recA', '--only', 'recB',
    '--concurrency=1', '--interval-ms=0', '--env-file', '/tmp/x.env', '--overwrite',
  ]);
  assert.equal(flags.limit, 50);
  assert.deepEqual(flags.only, ['recA', 'recB']);
  assert.equal(flags.concurrency, 1);
  assert.equal(flags.intervalMs, 0);
  assert.equal(flags.envFile, '/tmp/x.env');
  assert.equal(flags.overwrite, true);
});

test('② 参数：写错的值回落到默认（不因为一个错参数就按奇怪的并发跑）', () => {
  const flags = parseArgs(['--limit=abc', '--concurrency=-3', '--interval-ms=oops']);
  assert.equal(flags.limit, 0);
  assert.equal(flags.concurrency, 0);
  assert.equal(flags.intervalMs, -1);
  // 0 与"没给"要能分开：0 = 用户明确要求"不歇"；-1 = 回落到 config。
  assert.equal(parseArgs(['--interval-ms=0']).intervalMs, 0);
  assert.equal(TAG_QR_CODE.batch.concurrency, 2, 'config 里的默认并发是小的那个（飞书上传接口不支持并发）');
});

test('② 选记录：--only 按 id 过滤、--limit 截断、顺序保持表里的顺序', () => {
  const records = ['a', 'b', 'c', 'd'].map((id) => ({ record_id: id }));
  assert.deepEqual(selectTargets(records).map((r) => r.record_id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectTargets(records, { limit: 2 }).map((r) => r.record_id), ['a', 'b']);
  assert.deepEqual(
    selectTargets(records, { only: ['d', 'b'] }).map((r) => r.record_id),
    ['b', 'd'],
    '顺序按表里的顺序，不按 --only 给的顺序',
  );
  assert.deepEqual(selectTargets(records, { only: ['zzz'] }), []);
  assert.deepEqual(selectTargets(undefined), []);
});

test('③ 闸门形状：默认拒绝写生产，FEISHU_ALLOW_PRODUCTION_WRITE=true 才放行', () => {
  // 什么都没有 ⇒ 拒绝
  assert.throws(
    () => assertWritableBase({ appToken: 'base_x', env: {}, scriptName: 'backfill-product-tag-qr' }),
    /已拒绝写入/,
  );
  // 写的值不是 'true'（大小写不敏感）也不算开闸
  assert.throws(() => assertWritableBase({ appToken: 'base_x', env: { FEISHU_ALLOW_PRODUCTION_WRITE: '1' } }), /已拒绝写入/);
  assert.throws(() => assertWritableBase({ appToken: 'base_x', env: { FEISHU_ALLOW_PRODUCTION_WRITE: '' } }), /已拒绝写入/);
  // 测试 Base 直接放行
  assert.equal(assertWritableBase({ appToken: 'base_x', env: { FEISHU_TARGET_ENV: 'test' } }), 'base_x');
  // 生产：必须显式开闸（Lead 在服务器上带这一个变量跑）
  assert.equal(assertWritableBase({ appToken: 'base_x', env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'TRUE' } }), 'base_x');
  // 连 Base 都没配 ⇒ 更早一步就拒
  assert.throws(() => assertWritableBase({ appToken: '  ', env: {} }), /没有配置目标 Base/);
});

// ── 干跑清单（buildPlans）：**只算不写**，规则与 service 同源 ─────────────

const F = V1_BITABLE_SCHEMA.tables.product.fields;
// 用**真的** service 出 URL / 文件名 ⇒ 清单与真写不可能漂。
const planService = createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('x') });
const planDeps = {
  service: planService,
  textValue,
  attachmentsOf,
  numberField: F.number,
  tagQrField: F.tagQrCode,
  numberFromFileName,
  sanitizeNumberForFileName,
};
const planRecords = [
  { record_id: 'rec_empty', fields: { [F.number]: 'YD6693-2|黑色|A' } },
  { record_id: 'rec_has', fields: { [F.number]: 'YD6693-2|黑色|A', [F.tagQrCode]: [{ file_token: 't1', name: 'whatever.png' }] } },
  { record_id: 'rec_no_number', fields: { [F.number]: '' } },
];

test('干跑清单：空列→写；已有值**且文件名与当前编号一致**→跳过（幂等）；没有编号→跳过并说清原因', () => {
  // ⚠️ 2026-10-12 改断言（**"幂等：真的同步过就不重复写"这条本意没变**）：
  //   改前：`rec_has`（附件名 `whatever.png`）⇒ `skip / already_present` —— **只看"有值"**。
  //   改后：同样这条 ⇒ `write / stale_file_name`（`whatever.png` 与当前编号该有的规范名不符 =
  //         真机那种"旧码"形状）。判据从"有值就跳过"改成"文件名/编号对得上才跳过"。
  const synced = [{
    record_id: 'rec_synced',
    fields: {
      [F.number]: 'YD6693-2|黑色|A',
      [F.tagQrCode]: [{ file_token: 't9', name: buildFileName('YD6693-2|黑色|A') }],
    },
  }];
  const plans = buildPlans(planRecords, {}, planDeps);
  assert.deepEqual(plans.map((item) => [item.record_id, item.action, item.reason]), [
    ['rec_empty', 'write', 'empty'],
    ['rec_has', 'write', 'stale_file_name'],
    ['rec_no_number', 'skip', 'number_missing'],
  ]);
  const syncedPlans = buildPlans(synced, {}, planDeps);
  assert.deepEqual([syncedPlans[0].action, syncedPlans[0].reason], ['skip', 'already_present'],
    '真的同步过（文件名 = 当前编号的规范名）⇒ 仍然跳过');
  // 清单里的 URL 就是规范里那一个（与 service 同源）
  assert.equal(plans[0].scan_url, 'https://hm.bamamei.online/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA');
  assert.equal(plans[0].file_name, planService.buildFileName('YD6693-2|黑色|A'));
  assert.deepEqual(plans[1].existing_file_names, ['whatever.png']);
  assert.equal(plans[2].scan_url, '', '算不出来的不许编 URL');
});

test('AC-QR-BF-1 ⭐⭐ 干跑**默认就要比对**：附件名与当前编号不符 ⇒ 报"待更新"（并列出新旧名），不再一律 already_present', () => {
  // 【2026-10-12 真机发现】改前："这一列有值 ⇒ 跳过（already_present）"——
  //   可她的附件名里还带着**旧货号前缀**（`tag-qr-QPL2635-1_黑_A.png` vs 当前 `2635-1|黑|A`），
  //   干跑因此报"已完成"，**误导了一轮排查**。现在默认就是比对。
  const records = [
    { record_id: 'rec_stale', fields: {
      [F.number]: '2635-1|黑|A',
      [F.tagQrCode]: [{ file_token: 't1', name: 'tag-qr-QPL2635-1_黑_A.png' }],
    } },
    { record_id: 'rec_ok', fields: {
      [F.number]: '2635-1|黑|A',
      [F.tagQrCode]: [{ file_token: 't2', name: buildFileName('2635-1|黑|A') }],
    } },
  ];
  const plans = buildPlans(records, {}, planDeps);
  const stale = plans.find((item) => item.record_id === 'rec_stale');
  const ok = plans.find((item) => item.record_id === 'rec_ok');
  assert.equal(stale.action, 'write', '附件名与当前编号不符 ⇒ **待更新**（不是 already_present）');
  assert.equal(stale.reason, 'stale_file_name');
  assert.deepEqual(stale.existing_file_names, ['tag-qr-QPL2635-1_黑_A.png'], '干跑要如实列出**旧**附件名');
  assert.equal(stale.file_name, 'tag-qr-2635-1_黑_A.png', '以及**新**文件名，方便人工核');
  assert.deepEqual([ok.action, ok.reason], ['skip', 'already_present'], '真的同步过的才报 already_present');
});

test('干跑清单：--overwrite 时已有值改成"要覆盖"；没有 --overwrite 不许覆盖', () => {
  const overwrite = buildPlans(planRecords, { overwrite: true }, planDeps);
  assert.deepEqual(overwrite.map((item) => [item.record_id, item.action, item.reason]), [
    ['rec_empty', 'write', 'empty'],
    ['rec_has', 'write', 'overwrite_requested'],
    ['rec_no_number', 'skip', 'number_missing'],
  ]);
  const plain = buildPlans(planRecords, { overwrite: false }, planDeps);
  // ⚠️ 2026-10-12 改：`rec_has` 的附件名与当前编号不符 ⇒ 现在**本来就会写**（`stale_file_name`）。
  assert.equal(plain[1].action, 'write');
  assert.equal(plain[1].reason, 'stale_file_name');
});

test('干跑清单：--limit / --only 也作用在清单上（顺序按表里给的顺序）', () => {
  assert.deepEqual(
    buildPlans(planRecords, { limit: 2 }, planDeps).map((item) => item.record_id),
    ['rec_empty', 'rec_has'],
  );
  assert.deepEqual(
    buildPlans(planRecords, { only: ['rec_no_number', 'rec_empty'] }, planDeps).map((item) => item.record_id),
    ['rec_empty', 'rec_no_number'],
  );
});

test('干跑清单：配置写错（模板没有 {number}）时标 config_error，不静默给个空 URL', () => {
  const brokenConfig = {
    ...TAG_QR_CODE,
    scanUrl: { urlTemplate: 'https://hm.bamamei.online/s/' },
  };
  const brokenService = createTagQrCodeService({
    gateway: {}, config: brokenConfig, generatePng: async () => Buffer.from('x'),
  });
  const plans = buildPlans(planRecords, {}, { ...planDeps, service: brokenService });
  assert.equal(plans[0].action, 'skip');
  assert.match(plans[0].reason, /^config_error: .*没有 \{number\} 占位符/);
  assert.equal(plans[0].scan_url, '');
});
