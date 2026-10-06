#!/usr/bin/env node
// 一次性回填脚本：「销售主表」旧「确认状态（旧）」→ 新「确认状态」/「资金状态」。
//
// 口径与纯函数在 `src/config/salesStatusBackfill.js`（可单测），这里只做 IO：
//   读表 → 算计划 → 打印**人看得懂的影响清单** →（只有 --apply 才）写表。
//
// 🔴 安全边界（她 2026-10-06 定的口径）：
//   · **默认就是干跑**（dry-run）：只读、一个字都不写，并打印"会改哪几条、改成什么"。
//   · `--apply` 真跑**只允许打测试 Base**：目标 app_token 必须与 `FEISHU_V1_E2E_TEST_APP_TOKEN`
//     **逐字相等**，否则当场拒绝（见 config/salesStatusBackfill.assertBackfillTarget）。
//     生产 Base 永远只能 dry-run —— 真跑要她本人同意。
//   · 不打印任何 secret：token 只以 sha256 指纹出现。
//
// 用法：
//   node scripts/backfill-sales-status.js                 # 干跑（默认，只读 + 影响清单）
//   node scripts/backfill-sales-status.js --apply         # 真跑（必须是指向测试 Base 的 .env）
//   node scripts/backfill-sales-status.js --limit 5       # 只看前 5 条（干跑调样式用）
//   node scripts/backfill-sales-status.js --json          # 输出机器可读的计划
//
// ⚠️ dotenv 必须在**业务模块之前**加载：`config/v1BitableSchema.js` 的 tableId 是
//    模块级求值，晚一步就会拿到空串（2026-10-06 线上事故，见 AGENTS.md 第 5 条）。
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const {
  BACKFILL_LEGACY_CONFIRM_FIELD,
  BACKFILL_TARGET_FIELDS,
  BACKFILL_EXCLUDED_DIMENSIONS,
  BACKFILL_EXCLUDED_FIELDS,
  planBackfill,
  fingerprint,
  assertBackfillTarget,
  formatImpactList,
} = require('../src/config/salesStatusBackfill');

const SCRIPT_NAME = 'backfill-sales-status';

const USAGE = `用法：node scripts/backfill-sales-status.js [--apply] [--dry-run] [--limit N] [--sample N] [--json]

  （默认）--dry-run   只读、不写，打印影响清单
          --apply     真跑；只在目标 Base == FEISHU_V1_E2E_TEST_APP_TOKEN 时允许
          --limit N   只处理前 N 条记录（干跑调样式用）
          --sample N  影响清单里举几条示例（默认 3）
          --json      输出机器可读的计划（不写表）
          --help      显示这段说明

回填规则见 src/config/salesStatusBackfill.js；只回填 确认状态 / 资金状态，
销售状态 / 库存状态 刻意不回填。`;

const parseArgs = (argv = []) => {
  const options = { mode: 'dry-run', json: false, limit: 0, sampleSize: 3, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--limit') { index += 1; options.limit = Number(argv[index]); }
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--sample') { index += 1; options.sampleSize = Number(argv[index]); }
    else if (arg.startsWith('--sample=')) options.sampleSize = Number(arg.slice('--sample='.length));
    else throw new Error(`不认识的参数：${arg}`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) throw new Error('--limit 必须是非负整数');
  if (!Number.isSafeInteger(options.sampleSize) || options.sampleSize < 0) throw new Error('--sample 必须是非负整数');
  return options;
};

/**
 * 只写"计划里 action === 'update'"的那些记录，逐条报告成败。
 *
 * 刻意**逐条 try/catch**：一条写失败不该中断整批——她要看的是"到底有几条没成"，
 * 而不是跑到一半停住、剩下的连试都没试。
 */
const applyPlan = async ({ gateway, items = [], out = console.log }) => {
  const updated = [];
  const failed = [];
  for (const item of items) {
    if (item.action !== 'update') continue;
    const change = item.changes[0];
    try {
      await gateway.update('salesEntry', item.recordId, { [change.semanticKey]: change.to });
      updated.push(item);
      out(`  ✓ ${item.recordId}${item.orderNo ? ` ${item.orderNo}` : ''}  ${change.field}：「${change.from}」→「${change.to}」`);
    } catch (error) {
      failed.push({ recordId: item.recordId, error: error.message });
      out(`  ✗ ${item.recordId}${item.orderNo ? ` ${item.orderNo}` : ''}  写入失败：${error.message}`);
    }
  }
  return { updated, failed };
};

/** 回填需要读/写的那几个字段必须先在真表里存在，否则当场失败（不许静默回填 0 条）。 */
const assertBackfillFields = async (gateway) => {
  const required = [
    BACKFILL_LEGACY_CONFIRM_FIELD,
    BACKFILL_TARGET_FIELDS.userAction,
    BACKFILL_TARGET_FIELDS.funds,
  ];
  const names = new Set((await gateway.listFields('salesEntry')).map((field) => field.field_name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(`「销售主表」缺少本次回填需要的字段：${missing.join('、')}`
      + '（字段被改名或删除时必须当场失败，不能静默回填 0 条）');
  }
  return required;
};

const buildGateway = () => {
  // SDK 默认 error logger 可能把请求配置（含 app secret）打出来，脚本里静音。
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const { appId, appSecret } = getLarkAgentCredentials();
  return new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger }) });
};

const run = async ({ options = {}, env = process.env, gateway = null, out = console.log } = {}) => {
  const appToken = String(env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
  const testAppToken = String(env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  // 🔴 闸门放在**建网关之前**：真跑到生产连一次请求都发不出去。
  const gate = assertBackfillTarget({
    appToken, testAppToken, apply: options.mode === 'apply', scriptName: SCRIPT_NAME,
  });
  const client = gateway || buildGateway();
  await assertBackfillFields(client);
  const records = await client.listAll('salesEntry');
  const limited = options.limit > 0 ? records.slice(0, options.limit) : records;
  const table = client.table('salesEntry');
  const plan = planBackfill(limited, { fieldNames: table.fields });

  if (options.json) {
    out(JSON.stringify({
      mode: options.mode,
      targetIsTestBase: gate.targetIsTestBase,
      appTokenFingerprint: fingerprint(appToken),
      testAppTokenFingerprint: fingerprint(testAppToken),
      table: { key: 'salesEntry', tableId: table.tableId },
      legacyField: BACKFILL_LEGACY_CONFIRM_FIELD,
      targetFields: BACKFILL_TARGET_FIELDS,
      notBackfilledDimensions: [...BACKFILL_EXCLUDED_DIMENSIONS],
      notBackfilledFields: [...BACKFILL_EXCLUDED_FIELDS],
      plan,
    }, null, 2));
  } else {
    out(formatImpactList({
      plan,
      mode: options.mode,
      appToken,
      testAppToken,
      tableName: table.tableName,
      tableId: table.tableId,
      envLabel: String(env.FEISHU_TARGET_ENV || '').trim(),
      sampleSize: options.sampleSize,
    }));
  }

  if (options.mode !== 'apply') {
    out('');
    out('（DRY-RUN 结束：没有写任何东西。确认清单没问题后，用 --apply 真跑；'
      + '⚠️ --apply 只在目标 Base == 测试 Base 时允许。）');
    return { mode: options.mode, plan, updated: [], failed: [] };
  }

  out('');
  out('=== APPLY 逐条写入 ===');
  out('（下面每写一条，网关还会打一条 bitable.record.updated 的 JSON 日志——那是证据链，不是错误）');
  const { updated, failed } = await applyPlan({ gateway: client, items: plan.items, out });
  out('');
  out(`=== 写入结束：成功 ${updated.length} 条 / 失败 ${failed.length} 条（计划 ${plan.summary.willUpdate} 条）===`);
  if (failed.length) {
    out('失败记录：');
    for (const item of failed) out(`  ${item.recordId}  ${item.error}`);
  }
  return { mode: options.mode, plan, updated, failed };
};

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  run({ options }).then(({ failed }) => {
    // 有失败就非 0 退出：让"跑完了"和"跑成了"在 CI/终端里也分得开。
    process.exit(failed.length ? 1 : 0);
  }).catch((error) => {
    console.error(`[${SCRIPT_NAME}] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { USAGE, parseArgs, applyPlan, assertBackfillFields, buildGateway, run };
