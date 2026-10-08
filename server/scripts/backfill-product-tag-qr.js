#!/usr/bin/env node
/**
 * backfill-product-tag-qr.js —— 给「货品信息」的存量记录补上**「标签二维码」**这一列。
 *
 * 干什么：读「货品信息」每条记录 → 用 `config/tagQrCode.js` 里的规范
 *   （`https://hm.bamamei.online/s/{编号}`，编号 URL 编码）出 PNG → 上传拿 `file_token`
 *   → 写回**附件列**「标签二维码」。生成 / 上传 / 写回**全部复用**
 *   `services/tagQrCodeService`（这里不自己拼飞书请求，也不用飞书 CLI）。
 *
 * 用法：
 *   node scripts/backfill-product-tag-qr.js                       # 干跑（默认，一个字都不写）
 *   node scripts/backfill-product-tag-qr.js --dry-run             # 同上（显式写出来）
 *   node scripts/backfill-product-tag-qr.js --write               # 真写（要过下面的闸门）
 *   node scripts/backfill-product-tag-qr.js --limit=50            # 只看/只做前 50 条
 *   node scripts/backfill-product-tag-qr.js --only=recA --only=recB   # 只做指定记录（可多次）
 *   node scripts/backfill-product-tag-qr.js --concurrency=1       # 并发（默认 2，飞书上传接口不支持并发）
 *   node scripts/backfill-product-tag-qr.js --interval-ms=500     # 每批之间歇多久（默认 300ms）
 *   node scripts/backfill-product-tag-qr.js --overwrite           # 显式覆盖已有值（默认不覆盖）
 *   node scripts/backfill-product-tag-qr.js --env-file <p>        # 额外环境变量文件
 *
 * 🔴 **硬闸门（能不能真写）**：沿用仓库既有闸门形状 `utils/writeTargetGuard.assertWritableBase`
 *   —— 只有 **`FEISHU_TARGET_ENV=test`** 或 **`FEISHU_ALLOW_PRODUCTION_WRITE=true`**
 *   两者之一成立，`--write` 才放行；否则**拒绝运行（退出码 2）**，一个字都不写。
 *   ⚠️ 默认就是干跑：不显式给 `--write` 一个字都不写（连上传素材都不会发生）。
 *   ⚠️ 生产写入由 Lead 在服务器上带 `FEISHU_ALLOW_PRODUCTION_WRITE=true` 跑。
 *
 * 🔴 **幂等**：这一列**已经有值就跳过**（记 `already_present`），只有带 `--overwrite`
 *   才重写（覆盖前 service 会先记一条 `product.tag_qr.overwriting`）。
 *   跑第二遍应当是 **0 条要写**。
 *
 * 🔴 **可重试 / 不静默**：逐条打印结果（跳过 / 写成功 / 失败），失败**计数并以退出码 1 结束**；
 *   失败的记录 id 一并落进报告文件，重跑时用 `--only=<失败的那些>` 单独补。
 *
 * 🔴 安全：只用**项目自己的** `V1BitableGateway`（不手拼 SDK、不用飞书 CLI）；
 *   **不打印任何 token / secret**（连 Base 的 app_token 也不打，只说"是否 = 授权测试 Base"）。
 *
 * 环境变量加载顺序（后者覆盖前者）：1）<repo>/.env  2）--env-file <p>  3）<repo>/.env.local
 * ⚠️ 必须在 require 业务模块**之前**加载：`v1BitableSchema` 是 require 时求值 tableId 的。
 *    所以下面 `main()` 里是**懒 require**（`require.main === module` 才走到），
 *    这样单测可以安全地 require 本文件拿纯函数，而不会顺带把仓库 .env 注进测试进程。
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

const line = (char = '─') => console.log(char.repeat(78));
const head = (title) => { console.log(''); line('═'); console.log(`  ${title}`); line('═'); };
const say = (...args) => console.log(...args);

// ── 参数（纯函数，单测直接调）────────────────────────────────────────────────
/**
 * 解析命令行参数。支持 `--k=v` 与 `--k v` 两种写法；`--only` 可重复。
 * `--write` 与 `--dry-run` 同时给 ⇒ **以 dry-run 为准**（宁可少写，不可误写）。
 */
const parseArgs = (argv = []) => {
  const flags = {};
  const only = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    let key = body;
    let value = true;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; index += 1; }
    }
    if (key === 'only') { only.push(String(value)); continue; }
    flags[key] = value;
  }
  const asInt = (value, fallback) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  };
  // `--write` 与 `--dry-run` 同时给 ⇒ **以 dry-run 为准**（宁可少写，不可误写）。
  const write = flags.write === true && flags['dry-run'] !== true;
  return {
    write,
    dryRun: !write,
    overwrite: flags.overwrite === true,
    only,
    limit: asInt(flags.limit, 0),
    // 0 = 没给 ⇒ 由调用方回落到 config 的默认值（见 config/tagQrCode 的 batch）。
    concurrency: asInt(flags.concurrency, 0),
    // -1 = 没给 ⇒ 回落到 config；0 = 用户明确要求"不歇"。
    intervalMs: asInt(flags['interval-ms'], -1),
    envFile: typeof flags['env-file'] === 'string' ? flags['env-file'] : '',
  };
};

/** 按 `--only` / `--limit` 从全量记录里挑出本次要处理的那些（顺序保持表里的顺序）。 */
const selectTargets = (records, { only = [], limit = 0 } = {}) => {
  let targets = Array.isArray(records) ? records : [];
  if (only.length) {
    const wanted = new Set(only.map((id) => String(id).trim()).filter(Boolean));
    targets = targets.filter((record) => wanted.has(record?.record_id));
  }
  if (limit > 0) targets = targets.slice(0, limit);
  return targets;
};

/**
 * 干跑清单：`[{ record_id, number, action, reason, scan_url, file_name, existing_file_names }]`。
 *
 * ⚠️ 这里**只算不写**（不读表以外的任何东西、不上传、不写库），而且 URL / 文件名用的是
 *    **service 自己那两个方法**（同一个 config、同一套规则 ⇒ 清单与真写不会漂）。
 * ⚠️ 真写时 service 会**再判一次**（清单是"写之前的预估"）：表可能在干跑与真写之间被改过。
 *
 * @param {Array} records `gateway.listAll('product')` 的结果（只读）
 * @param {{only?: string[], limit?: number, overwrite?: boolean}} flags
 * @param {object} deps
 * @param {{buildScanUrl: Function, buildFileName: Function}} deps.service 标签二维码 service
 * @param {Function} deps.textValue `services/v1BitableGateway` 的取值器（与链路上同一个）
 * @param {Function} deps.attachmentsOf 附件格解析（与 service 同一个）
 * @param {string} deps.numberField 「编号」的物理列名（来自 schema）
 * @param {string} deps.tagQrField 「标签二维码」的物理列名（来自 schema）
 *   ⚠️ 这些依赖**由调用方传**而不是本文件顶部 require：`.env` 必须在 require 业务模块
 *      **之前**加载（`v1BitableSchema` 是 require 时求值 tableId 的），所以本文件的业务
 *      require 全部在 `main()` 里懒加载；`buildPlans` 保持纯函数，单测可以直接喂桩。
 */
const buildPlans = (records, flags, { service, textValue, attachmentsOf, numberField, tagQrField }) =>
  selectTargets(records, flags).map((record) => {
    const recordId = record?.record_id;
    const number = textValue(record?.fields?.[numberField]).trim();
    const existing = attachmentsOf(record?.fields?.[tagQrField]);
    let action = 'write';
    let reason = 'empty';
    let scanUrl = '';
    let fileName = '';
    try {
      if (!number) { action = 'skip'; reason = 'number_missing'; }
      else {
        scanUrl = service.buildScanUrl(number);
        fileName = service.buildFileName(number);
        if (existing.length && !flags.overwrite) { action = 'skip'; reason = 'already_present'; }
        else if (existing.length) { action = 'write'; reason = 'overwrite_requested'; }
      }
    } catch (error) {
      // 配置写错（模板没有 {number} / 占位符不认识…）时**不猜**：标成 skip + config_error。
      action = 'skip';
      reason = `config_error: ${error.message}`;
    }
    return {
      record_id: recordId,
      number,
      action,
      reason,
      scan_url: scanUrl,
      file_name: fileName,
      existing_file_names: existing.map((item) => item.name),
    };
  });

/** 环境变量文件（返回"注入了什么"的人可读说明；不打印任何值）。 */
const loadEnvFiles = (envFile = '') => {
  const sources = [];
  for (const item of [
    { label: '<repo>/.env', file: path.join(repoRoot, '.env'), override: false },
    { label: `--env-file ${envFile || ''}`, file: envFile, override: false },
    { label: '<repo>/.env.local', file: path.join(repoRoot, '.env.local'), override: true },
  ]) {
    if (!item.file) continue;
    if (!fs.existsSync(item.file)) { sources.push(`${item.label}（不存在，跳过）`); continue; }
    const loaded = dotenv.config({ path: item.file, override: item.override, quiet: true });
    sources.push(`${item.label}（注入 ${Object.keys(loaded.parsed || {}).length} 项）`);
  }
  return sources;
};

// ── 主流程（只有 `node scripts/backfill-product-tag-qr.js` 才会走到这里）──────
const main = async () => {
  const flags = parseArgs(process.argv.slice(2));
  const envSources = loadEnvFiles(flags.envFile);

  // ⚠️ 懒 require：必须在 .env 注入**之后**（schema 的 tableId 是 require 时求值的）。
  const lark = require('@larksuiteoapi/node-sdk');
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  const { V1BitableGateway, textValue } = require('../src/services/v1BitableGateway');
  const { createTagQrCodeService, attachmentsOf } = require('../src/services/tagQrCodeService');
  const { TAG_QR_CODE } = require('../src/config/tagQrCode');
  const { assertWritableBase } = require('../src/utils/writeTargetGuard');
  const { getLarkAgentCredentials } = require('../src/config/larkAgent');

  const table = V1_BITABLE_SCHEMA.tables.product;
  const numberField = table.fields.number;
  const tagQrField = table.fields.tagQrCode;
  const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
  const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
  const isAuthorizedTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';

  const limit = flags.limit || TAG_QR_CODE.batch.limit;
  // 并发**下限 1**：飞书「上传素材」接口不支持并发调用（并发会回 `1061045`）。
  const concurrency = Math.max(1, flags.concurrency || TAG_QR_CODE.batch.concurrency);
  const intervalMs = flags.intervalMs >= 0 ? flags.intervalMs : TAG_QR_CODE.batch.intervalMs;

  head('货品信息「标签二维码」存量补齐');
  say('  环境文件：');
  for (const source of envSources) say(`    · ${source}`);
  say(`  二维码内容模板（唯一真源）：${TAG_QR_CODE.scanUrl.urlTemplate}`);
  say(`  目标 Base 是否 = 授权测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN）：${isAuthorizedTestBase ? '是' : '**不是**'}`);
  say(`  FEISHU_TARGET_ENV：${targetEnv || '（未设置）'}`);
  say(`  FEISHU_ALLOW_PRODUCTION_WRITE：${String(process.env.FEISHU_ALLOW_PRODUCTION_WRITE || '') || '（未设置）'}`);
  say(`  模式：${flags.write ? '真写（--write）' : '干跑（dry-run，默认；一个字都不写）'}`);
  say(`  已有值是否覆盖：${flags.overwrite ? '是（--overwrite，覆盖前会先记一条 product.tag_qr.overwriting）' : '否（已有值跳过）'}`);
  say(`  并发 / 每批间隔：${concurrency} / ${intervalMs}ms`);

  // ── 硬闸门：能不能真写 ────────────────────────────────────────────────────
  if (flags.write) {
    try {
      assertWritableBase({ appToken: targetAppToken, scriptName: 'backfill-product-tag-qr' });
    } catch (error) {
      say('');
      say(`🔴 拒绝真写：${error.message}`);
      say('   ⇒ 本脚本对生产 Base 只允许 **干跑**（打印影响清单，一个字都不写）。');
      say('   ⇒ 要在生产上真写，请在服务器上显式带 `FEISHU_ALLOW_PRODUCTION_WRITE=true` 再跑。');
      process.exit(2);
    }
  }

  // ── 读（只读）───────────────────────────────────────────────────────────────
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret });
  const gateway = new V1BitableGateway({ client });
  const service = createTagQrCodeService({ gateway, config: TAG_QR_CODE });

  const records = await gateway.listAll('product');
  say('');
  say(`  货品信息：读到 ${records.length} 条记录（只读）`);

  const targets = selectTargets(records, { only: flags.only, limit });

  // ── 算（干跑清单 —— 与 service 用**同一套** URL / 文件名规则，见 buildPlans）──
  const plans = buildPlans(records, { ...flags, limit }, {
    service, textValue, attachmentsOf, numberField, tagQrField,
  });

  const toWrite = plans.filter((item) => item.action === 'write');
  const skipped = plans.filter((item) => item.action !== 'write');
  const counts = {};
  for (const item of plans) counts[item.reason] = (counts[item.reason] || 0) + 1;

  head('影响清单（干跑结论）');
  say(`  本次目标记录：${targets.length} 条` + (limit ? `（--limit=${limit}）` : '') + (flags.only.length ? `（--only 给了 ${flags.only.length} 个 id）` : ''));
  say(`  将写入：${toWrite.length} 条；将跳过：${skipped.length} 条`);
  for (const [reason, count] of Object.entries(counts)) {
    const label = {
      empty: '这一列是空的（要补）',
      already_present: '已经有值（幂等，跳过）',
      overwrite_requested: '已经有值 + --overwrite（要覆盖）',
      number_missing: '没有「编号」（生不出码，跳过）',
    }[reason] || reason;
    say(`    · ${label}：${count} 条`);
  }
  if (toWrite.length) {
    say('');
    line();
    say('  将要写的前 5 条（样例；完整清单看报告文件）：');
    for (const item of toWrite.slice(0, 5)) {
      say(`    · ${item.record_id}｜编号=${item.number}`);
      say(`        二维码内容=${item.scan_url}`);
      say(`        附件名=${item.file_name}`);
    }
  }
  const missing = skipped.filter((item) => item.reason === 'number_missing');
  if (missing.length) {
    say('');
    say(`  ⚠️ ${missing.length} 条记录没有「编号」，跳过（这些生不出码来，需要先补编号）：`);
    for (const item of missing.slice(0, 10)) say(`    · ${item.record_id}`);
  }
  const configErrors = skipped.filter((item) => String(item.reason).startsWith('config_error'));
  if (configErrors.length) {
    say('');
    say(`  🔴 ${configErrors.length} 条因为配置问题算不出 URL —— 先修 config 再跑：`);
    for (const item of configErrors.slice(0, 5)) say(`    · ${item.record_id}：${item.reason}`);
  }

  // ── 报告落盘（不含任何 token）───────────────────────────────────────────────
  const reportDir = path.join(serverRoot, 'data', 'selftest', 'backfill');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `product-tag-qr-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const writeReport = (extra = {}) => fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: flags.write ? 'write' : 'dry-run',
    overwrite: flags.overwrite,
    authorized_test_base: isAuthorizedTestBase,
    table: { tableName: table.tableName },
    limit, concurrency, interval_ms: intervalMs,
    counts,
    plans,
    ...extra,
  }, null, 2));

  if (!flags.write) {
    writeReport();
    say('');
    say(`  报告已落盘：${path.relative(repoRoot, reportPath)}`);
    say('');
    say('  ✅ 干跑结束：**一个字都没写**（连素材都没上传）。要真写请加 --write（且必须过闸门）。');
    process.exit(0);
  }

  // ── 写（只有 --write 且闸门通过才会走到这里）────────────────────────────────
  head('写入');
  say(`  ⚠️ 真写模式：读表与写入都会由 service 再判一次（上面的清单是"写之前的预估"）。`);
  const results = [];
  let written = 0;
  let skippedCount = 0;
  const failed = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  for (let offset = 0; offset < toWrite.length; offset += concurrency) {
    const batch = toWrite.slice(offset, offset + concurrency);
    const settled = await Promise.all(batch.map(async (item) => {
      try {
        const result = await service.syncRecord(item.record_id, {
          reason: 'backfill',
          // `--overwrite` 时明确告诉 service"该覆盖"；否则走幂等（已有值就跳过）。
          numberChanged: flags.overwrite ? true : undefined,
        });
        return { item, result };
      } catch (error) {
        return { item, error };
      }
    }));
    for (const entry of settled) {
      if (entry.error) {
        failed.push({ record_id: entry.item.record_id, error: entry.error.message });
        say(`  ✘ ${entry.item.record_id}（编号=${entry.item.number}）：${entry.error.message}`);
        continue;
      }
      const { result } = entry;
      results.push(result);
      if (result.status === 'written') {
        written += 1;
        say(`  ✔ ${result.record_id}（编号=${entry.item.number}）← file_token=${result.file_token}｜${result.file_name}`);
      } else {
        skippedCount += 1;
        say(`  · ${result.record_id} 跳过：${result.reason}`);
      }
    }
    if (offset + concurrency < toWrite.length && intervalMs) await sleep(intervalMs);
  }

  const summary = {
    planned: toWrite.length,
    written,
    skipped: skippedCount,
    failed: failed.length,
    results,
    failed_records: failed,
  };
  writeReport({ summary });
  say('');
  say(`  写入完成：成功 ${written} 条，跳过 ${skippedCount} 条，失败 ${failed.length} 条。`);
  if (failed.length) {
    say('');
    say('  🔴 失败清单（重跑可用 --only=<id> 单独补）：');
    for (const item of failed) say(`    · ${item.record_id}：${item.error}`);
  }
  say(`  报告已落盘：${path.relative(repoRoot, reportPath)}`);
  process.exit(failed.length ? 1 : 0);
};

module.exports = { parseArgs, selectTargets, buildPlans, loadEnvFiles };

if (require.main === module) {
  main().catch((error) => {
    console.error('');
    console.error(`🔴 运行失败：${error.message}`);
    console.error(error.stack);
    process.exit(1);
  });
}
