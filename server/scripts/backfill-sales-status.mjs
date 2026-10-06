#!/usr/bin/env node
/**
 * backfill-sales-status.mjs —— 「确认状态（旧）」→ 四个新状态字段的**一次性回填**。
 *
 * 干什么：读「销售主表」每条记录，按 `config/salesStatusBackfill.js` 的口径
 * （业务负责人 2026-10-06 逐字定的），**只填两列**：
 *   · 已入账   → 资金状态 = 已写入
 *   · 入账失败 → 资金状态 = 写入失败
 *   · 入账中   → 资金状态 = 未写入
 *   · 待确认   → 确认状态 = 未确认（资金状态留空）
 *   · 已取消   → 确认状态 = 已取消
 *   · 待修改   → 确认状态 = 待修改
 * 「销售状态」「库存状态」**不回填**（它们的家是销售明细 / 库存流水，另行处理）。
 *
 * 用法：
 *   node scripts/backfill-sales-status.mjs                 # 干跑（= --dry-run），只打印影响清单
 *   node scripts/backfill-sales-status.mjs --dry-run       # 同上
 *   node scripts/backfill-sales-status.mjs --apply         # 真写（**只允许测试 Base**）
 *   node scripts/backfill-sales-status.mjs --limit 20      # 只看/只改前 20 条命中
 *   node scripts/backfill-sales-status.mjs --env-file <p>  # 额外环境变量文件（默认读 <repo>/.env）
 *
 * 🔴 硬闸门（写死在脚本里）：
 *   · **目标 Base ≠ 授权的测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN）或 FEISHU_TARGET_ENV ≠ test 时，
 *     只允许干跑；带 --apply 直接拒绝运行（退出码 2）。**
 *   · 默认就是干跑：不显式给 `--apply` 一个字都不写。
 *   · 只填空列：新列已有值绝不覆盖（回填没有资格推翻销售/售后刚写进去的事实）。
 *   · 幂等：跑第二遍应该 0 条要改（`already_up_to_date`）。
 *
 * 🔴 安全：
 *   · 只用**项目自己的** V1BitableGateway（不手拼 SDK、**不用飞书 CLI**）；
 *   · **不打印任何 token / secret**（连测试 Base 的 app_token 也不打，只打"与测试 Base 一致/不一致"）。
 *
 * 环境变量加载顺序（后者覆盖前者）：
 *   1. <repo>/.env          2. --env-file <p>        3. <repo>/.env.local
 * ⚠️ 必须在 require 业务模块**之前**加载：`v1BitableSchema` 是 require 时求值 tableId 的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1; }
  else flags[key] = true;
}

const line = (char = '─') => console.log(char.repeat(78));
const head = (title) => { console.log(''); line('═'); console.log(`  ${title}`); line('═'); };
const say = (...args) => console.log(...args);

// ── 环境变量（必须在 require 业务模块之前）────────────────────────────────────
const envSources = [];
for (const item of [
  { label: '<repo>/.env', file: path.join(repoRoot, '.env'), override: false },
  { label: `--env-file ${flags['env-file'] || ''}`, file: flags['env-file'] || '', override: false },
  { label: '<repo>/.env.local', file: path.join(repoRoot, '.env.local'), override: true },
]) {
  if (!item.file) continue;
  if (!fs.existsSync(item.file)) { envSources.push(`${item.label}（不存在，跳过）`); continue; }
  const loaded = dotenv.config({ path: item.file, override: item.override, quiet: true });
  envSources.push(`${item.label}（注入 ${Object.keys(loaded.parsed || {}).length} 项）`);
}

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, textValue } = require('../src/services/v1BitableGateway');
const {
  SALES_STATUS_FIELDS, LEGACY_SALES_STATUS_FIELDS,
} = require('../src/config/salesStatusDimensions');
const { planSalesStatusBackfill } = require('../src/config/salesStatusBackfill');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');

// ── 硬闸门：能不能真写 ───────────────────────────────────────────────────────
const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
const isAuthorizedTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';
const applyRequested = flags.apply === true;

head('销售状态字段回填（一次性）');
say('  环境文件：');
for (const source of envSources) say(`    · ${source}`);
say(`  目标 Base 是否 = 授权测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN）：${isAuthorizedTestBase ? '是' : '**不是**'}`);
say(`  FEISHU_TARGET_ENV：${targetEnv || '（未设置）'}`);
say(`  模式：${applyRequested ? '真写（--apply）' : '干跑（--dry-run，默认）'}`);

if (applyRequested && !isAuthorizedTestBase) {
  say('');
  say('🔴 拒绝真跑：目标 Base 不是授权的测试 Base，或 FEISHU_TARGET_ENV 不是 test。');
  say('   ⇒ 本脚本对生产 Base 只允许 **--dry-run**（打印影响清单，一个字都不写）。');
  process.exit(2);
}

const limit = Number.isSafeInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 0;

// ── 读（只读，走项目 gateway）────────────────────────────────────────────────
const { appId, appSecret } = getLarkAgentCredentials();
const client = new lark.Client({ appId, appSecret });
const gateway = new V1BitableGateway({ client });

const entryFields = gateway.table('salesEntry').fields;
const fieldOf = {
  orderNo: entryFields.orderNo,
  legacyConfirm: entryFields.confirmStatus || LEGACY_SALES_STATUS_FIELDS.legacyConfirm,
  userAction: entryFields.userAction || SALES_STATUS_FIELDS.userAction,
  funds: entryFields.funds || SALES_STATUS_FIELDS.funds,
};

const records = await gateway.listAll('salesEntry');
say('');
say(`  销售主表：读到 ${records.length} 条记录（只读）`);

const cellText = (record, field) => (field ? textValue(record?.fields?.[field]).trim() : '');

// ── 算（纯函数，口径在 config/salesStatusBackfill）───────────────────────────
const plans = records.map((record) => {
  const legacyConfirm = cellText(record, fieldOf.legacyConfirm);
  const userAction = cellText(record, fieldOf.userAction);
  const funds = cellText(record, fieldOf.funds);
  const plan = planSalesStatusBackfill({ legacyConfirm, userAction, funds });
  return {
    record_id: record.record_id,
    order_no: cellText(record, fieldOf.orderNo) || record.record_id,
    legacy_confirm: legacyConfirm,
    user_action: userAction,
    funds,
    ...plan,
  };
});

const toWrite = plans.filter((item) => item.action === 'write');
const legend = {
  write: '将改',
  already_up_to_date: '无需改（已是目标值）',
  skip_has_value: '跳过（新列已有别的值，不覆盖）',
  skip_unmapped: '跳过（旧值不在回填口径里）',
  skip_empty_legacy: '跳过（旧值本来就是空）',
};
const counts = {};
for (const item of plans) counts[item.action] = (counts[item.action] || 0) + 1;

// ── 影响清单（人看得懂）─────────────────────────────────────────────────────
head('影响清单（**她拿这个做决定**）');
say(`  命中「要改」：${toWrite.length} 条` + (limit ? `（本次只显示/只改前 ${limit} 条）` : ''));
say('');
for (const [action, count] of Object.entries(counts)) {
  if (!count) continue;
  say(`    · ${legend[action] || action}：${count} 条`);
}

const shown = limit ? toWrite.slice(0, limit) : toWrite;
if (shown.length) {
  say('');
  line();
  say('  将要改的记录（逐条）：');
  line();
  for (const [index, item] of shown.entries()) {
    const changes = Object.entries(item.patch)
      .map(([key, value]) => {
        const label = key === 'userAction' ? '确认状态' : '资金状态';
        const before = key === 'userAction' ? item.user_action : item.funds;
        return `${label}：'${before}' → '${value}'`;
      })
      .join('；');
    say(`  ${String(index + 1).padStart(3, ' ')}. ${item.record_id}  单号=${item.order_no}`);
    say(`       「确认状态（旧）」= '${item.legacy_confirm}'  ⇒  ${changes}`);
  }
  // 她做决定要靠"例子"，所以上面已经把每一条都列出来了；这里再点出前 3 条当样例。
  say('');
  say('  样例（前 3 条）：');
  for (const item of shown.slice(0, 3)) {
    say(`    · ${item.record_id}｜旧值「${item.legacy_confirm}」→ ${JSON.stringify(item.patch)}`);
  }
} else {
  say('');
  say('  （没有需要改的记录）');
}

// 跳过但值得她知道的那一档：新列已有别的值
const conflict = plans.filter((item) => item.action === 'skip_has_value');
if (conflict.length) {
  say('');
  say(`  ⚠️ ${conflict.length} 条「新列已有别的值」——**脚本不覆盖**，请人工看一眼：`);
  for (const item of conflict.slice(0, 10)) {
    say(`    · ${item.record_id}｜旧值「${item.legacy_confirm}」｜确认状态='${item.user_action}'｜资金状态='${item.funds}'`);
  }
}

// ── 报告落盘（不含任何 token）───────────────────────────────────────────────
const reportDir = path.join(serverRoot, 'data', 'selftest', 'backfill');
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `sales-status-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(reportPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  mode: applyRequested ? 'apply' : 'dry-run',
  authorized_test_base: isAuthorizedTestBase,
  table: { tableName: gateway.table('salesEntry').tableName },
  counts,
  to_write: toWrite,
  plans,
}, null, 2));
say('');
say(`  报告已落盘：${path.relative(repoRoot, reportPath)}`);

// ── 写（只有 --apply 且闸门通过才会走到这里）────────────────────────────────
if (!applyRequested) {
  say('');
  say('  ✅ 干跑结束：**一个字都没写**。要真写请加 --apply（且必须指向测试 Base）。');
  process.exit(0);
}

head('写入');
let written = 0;
let failed = 0;
for (const item of shown) {
  try {
    // gateway.update 收**语义键**（userAction / funds），字段名由 schema 提供。
    await gateway.update('salesEntry', item.record_id, item.patch);
    written += 1;
    say(`  ✔ ${item.record_id} ← ${JSON.stringify(item.patch)}`);
  } catch (error) {
    failed += 1;
    say(`  ✘ ${item.record_id}：${error.message}`);
  }
}
say('');
say(`  写入完成：成功 ${written} 条，失败 ${failed} 条。`);
process.exit(failed ? 1 : 0);
