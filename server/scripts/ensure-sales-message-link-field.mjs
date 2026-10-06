#!/usr/bin/env node
/**
 * ensure-sales-message-link-field.mjs —— 确保**测试 Base** 的「销售主表」里有
 * **「消息链接」**这一列（业务负责人 2026-10-06 在生产表新建的那一列）。
 *
 * 为什么要有它：
 *   `v1BitableSchema` 已经同步了 `salesEntry.messageLink = '消息链接'`，于是
 *   **测试 Base 没有这一列时，凡是要写它的链路（发卡片存深链）在测试里会被挡住**；
 *   而"在测试表加一列"是允许的（生产表只读）。把它做成脚本而不是一次性手敲，
 *   是为了换测试 Base / 重建测试表之后能一步补齐，并且带上与其它写库脚本同一套硬闸门。
 *
 * 走的是**项目代码**（官方 SDK + 项目配置，**不用飞书 CLI**）。
 * 🔴 硬闸门（写死在脚本里）：
 *   · 目标 Base 必须 = `FEISHU_V1_E2E_TEST_APP_TOKEN`，且 `FEISHU_TARGET_ENV=test`；
 *     否则**拒绝运行**（本脚本会改表结构）。
 *   · 默认**只读体检**；加 `--apply` 才真的建列。
 *   · 已存在就**什么都不做**（先 list 再决定，绝不盲目 set/create）。
 *   · 不打印任何 token / secret。
 *
 * 用法：
 *   node scripts/ensure-sales-message-link-field.mjs --env-file <主工作区>/.env
 *   node scripts/ensure-sales-message-link-field.mjs --env-file ... --apply
 *   node scripts/ensure-sales-message-link-field.mjs --env-file ... --apply --type=url
 *
 * ⚠️ 生产表那一列是**她自己建的**，类型本机读不到（本机没有生产凭证）：
 *   所以代码写值时按**运行时读到的字段类型**决定格式（文本=字符串 / 超链接={text,link}），
 *   本脚本建的测试列默认建成**文本**；要试超链接那一支就 `--type=url`
 *   —— 但同一张表里只能有一个「消息链接」列，要换类型得先手工删列。
 *
 * 环境变量加载顺序（后者覆盖前者）：<repo>/.env → --env-file → <repo>/.env.local
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

const envSources = [];
for (const item of [
  { label: '<repo>/.env', file: path.join(repoRoot, '.env'), override: false },
  { label: `--env-file=${flags['env-file'] || ''}`, file: flags['env-file'] ? path.resolve(String(flags['env-file'])) : '', override: true },
  { label: '<repo>/.env.local', file: path.join(repoRoot, '.env.local'), override: true },
]) {
  if (!item.file || !fs.existsSync(item.file)) continue;
  dotenv.config({ path: item.file, override: item.override, quiet: true });
  envSources.push(item.label);
}

const require = createRequire(import.meta.url);
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const lark = require('@larksuiteoapi/node-sdk');

const FIELD_KEY = 'messageLink';
const FIELD_NAME = V1_BITABLE_SCHEMA.tables.salesEntry.fields[FIELD_KEY];
const FIELD_TYPE = String(flags.type || 'text').toLowerCase() === 'url' ? 15 : 1;
const TYPE_LABEL = FIELD_TYPE === 15 ? '超链接（type=15）' : '文本（type=1）';

// ── 硬闸门 ───────────────────────────────────────────────────────────────────
const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
const isAuthorizedTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';
const apply = flags.apply === true;

head('确保测试 Base 的「销售主表」有「消息链接」列');
say('  环境文件（后者覆盖前者）：');
for (const source of envSources) say(`    · ${source}`);
say(`  目标 Base 是否 = 授权测试 Base：${isAuthorizedTestBase ? '是' : '**不是**'}`);
say(`  FEISHU_TARGET_ENV：${targetEnv || '（未设置）'}`);
say(`  字段：${FIELD_KEY} → 「${FIELD_NAME}」 · 计划类型 ${TYPE_LABEL}`);
say(`  模式：${apply ? '真建（--apply）' : '只读体检（未加 --apply）'}`);

if (!isAuthorizedTestBase) {
  say('');
  say('🔴 拒绝运行：目标 Base 不是授权的测试 Base（或 FEISHU_TARGET_ENV ≠ test）。');
  say('   本脚本会改表结构，只允许在测试 Base 上跑。');
  process.exit(2);
}

const { appId, appSecret } = getLarkAgentCredentials();
// SDK 默认 logger 会把请求配置（含 app secret）打出来，这里全部静音。
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const client = new lark.Client({ appId, appSecret, logger });
const table = V1_BITABLE_SCHEMA.tables.salesEntry;

const listFields = async () => {
  const fields = [];
  let pageToken;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: V1_BITABLE_SCHEMA.appToken, table_id: table.tableId },
      params: { page_size: 200, page_token: pageToken },
    });
    if (response.code !== 0) throw new Error(`读取「${table.tableName}」字段失败: ${response.msg} (${response.code})`);
    fields.push(...(response.data?.items || []));
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken);
  return fields;
};

const main = async () => {
  const before = await listFields();
  const existing = before.find((field) => field.field_name === FIELD_NAME);
  say('');
  say(`  「${table.tableName}」现有 ${before.length} 列；「${FIELD_NAME}」：${existing ? '**已存在**' : '不存在'}`);
  if (existing) {
    say(`  → 已存在（field_id=${existing.field_id} · type=${existing.type}）——什么都不做。`);
    if (existing.type !== FIELD_TYPE) {
      say('  ⚠️ 字段类型与本次 --type 不同：代码按**运行时读到的类型**决定写值格式，所以不用改。');
    }
    return;
  }
  if (!apply) {
    say('  → 只读体检结束：加 `--apply` 才会真的建这一列。');
    return;
  }
  const response = await client.bitable.appTableField.create({
    path: { app_token: V1_BITABLE_SCHEMA.appToken, table_id: table.tableId },
    data: { field_name: FIELD_NAME, type: FIELD_TYPE },
  });
  if (response.code !== 0) throw new Error(`新建「${FIELD_NAME}」失败: ${response.msg} (${response.code})`);
  say(`  ✅ 已新建「${FIELD_NAME}」（field_id=${response.data?.field?.field_id || '(未返回)'} · type=${FIELD_TYPE}）`);
  const after = await listFields();
  say(`  复核：现在 ${after.length} 列，「${FIELD_NAME}」${after.some((field) => field.field_name === FIELD_NAME) ? '在位 ✓' : '仍然不在 ✗'}`);
};

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
