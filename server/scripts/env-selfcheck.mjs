#!/usr/bin/env node
/**
 * env-selfcheck.mjs —— **本机环境自检（只读，零写入）**。
 *
 * 为什么要有它（2026-10-12 的真实误判，业务负责人已指出）：
 *   ① 有人说「测试表里没有采购那两张表」——实际是**本机 `.env` 里两个采购表 ID 过期**
 *      （更新 ID 后，两张表各 17 个字段、字段名与生产完全一致）；
 *   ② 又有人说「测试表里《采购明细.尺码》类型不对」——实际**逐字读真表**是
 *      `type=18 SingleLink → 尺码管理(本 Base 自己的)`，类型**完全正确**；
 *   ③ ⭐ 把 ID 改对之后，采购闸门**自己就全绿了** ⇒ 那条报错是「本机 ID 过期」的**副作用**。
 *   ⇒ 教训：**别把报错文本当成"表结构不一致"的结论**。
 *      这个脚本把「哪张表 ID 不对 / 哪张表缺字段」**分开报**，让"ID 过期"当场暴露。
 *
 * 它做什么（全部只读）：
 *   · `appTable.list` 一次：拿到目标 Base 里**真实存在的表**（table_id → 表名）；
 *   · 逐表 `appTableField.list`（经项目网关 `V1BitableGateway.listFields`）：字段名清单；
 *   · 逐行核对：**表 ID 存在吗** · **真表名 == schema 的 tableName 吗** · **schema 映射的字段齐吗**；
 *   · 两条通用自证：目标 Base **逐字等于** `FEISHU_V1_E2E_TEST_APP_TOKEN` 吗 ·
 *     「生产禁止清单」是否为空（本机应"够不着生产"）；
 *   · 另附：`.env` 里**写着但 schema 从不读取**的 `FEISHU_V1_*_TABLE_ID` 变量
 *     —— 那是"**ID 放错变量名**"的温床（脚本改了 ID 却没生效，最容易在这条上踩空）。
 *
 * 🔴 安全：
 *   · **只读**：只调 `appTable.list` / `appTableField.list`，一个写接口都不碰；
 *   · **不打印明文 token / secret**：一律指纹（`前6位…(len=N)`）；收尾还会**自查输出**，
 *     一旦发现明文 token 就**阻断打印**并以退出码 1 收场；
 *   · **任何单条失败都不抛**：逐条如实标 ✗，最后用**退出码**表达"有没有红"。
 *
 * 退出码：`0` = 全绿；`1` = 有红。红来自四类：
 *   ① 有表出问题（范围见下"谁能影响退出码"）；
 *   ② 自证「目标 Base 逐字等于授权测试 Base」**不成立**；
 *   ③ 目标 Base **命中生产禁止清单**；
 *   ④ **前提缺失**：缺飞书应用凭证 / 读不到 Base 表清单 / 「表 → 环境变量名」映射自检对不上。
 *   ⚠️ `FEISHU_TARGET_ENV` 只**如实输出**，不单独决定退出码（它是写表类脚本自己的闸门）。
 *
 * 谁能影响退出码（刻意这样设计，避免"可选项常年报红"把真警报淹掉）：
 *   某张表出问题 ⇒ 影响退出码，当且仅当
 *   **① 它在 `V1_SCHEMA_SCOPES` 的闸门范围内**，或 **② 本机 `.env` 里显式配过它对应的变量**。
 *   两者都不满足（例如 `付款明细`：本机没配、也不在闸门里，`schema` 用的是**生产默认 ID**）
 *   ⇒ 只打 ⚠️ 说明，**不**影响退出码。
 *
 * 用法：
 *   cd server && node scripts/env-selfcheck.mjs
 *   cd server && node scripts/env-selfcheck.mjs --env-file ../.env --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const schemaSourcePath = path.join(serverRoot, 'src', 'config', 'v1BitableSchema.js');

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1; } else { flags[key] = true; }
}

// ── 小工具（纯函数，便于离线单测）─────────────────────────────────────────────
/** 只打指纹，绝不打明文（token / open_id / chat_id 都走它）。 */
export const fingerprint = (value) => {
  const raw = String(value ?? '');
  return raw ? `${raw.slice(0, 6)}…(len=${raw.length})` : '(空)';
};

/**
 * 从 `v1BitableSchema.js` 源码里解析出「每个表 → 它读的环境变量名」。
 *
 * 为什么不写死一张表：**schema 会加表、会改变量名**；写死的映射一旦漏了新表，
 * 自检就会"**静默地少检查一张表**"——那正是这个脚本要防的那类假绿。
 * 所以在 main() 里会拿解析结果与 `V1_BITABLE_SCHEMA.tables` **交叉核对**：
 * 对不上就当场标 ✗（宁可吵，也不许悄悄漏表）。
 */
export const parseTableEnvVars = (source) => {
  const out = new Map();
  let current = null;
  let sawTableName = false;
  for (const line of String(source || '').split('\n')) {
    const open = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*):\s*\{\s*$/);
    if (open) { current = open[1]; sawTableName = false; continue; }
    if (/^ {4}\},?\s*$/.test(line)) { current = null; sawTableName = false; continue; }
    if (!current) continue;
    if (/^\s*tableName:\s*'/.test(line)) sawTableName = true;
    const envVar = line.match(/tableId:\s*getEnv\('([A-Z0-9_]+)'/);
    if (envVar) {
      // 只有先见过 `tableName` 才认；否则说明解析器跟丢了表边界（宁可漏配也不猜）。
      if (sawTableName) out.set(current, envVar[1]);
      sawTableName = false;
    }
  }
  return out;
};

/** 飞书错误码：SDK 抛的异常藏在 `response.data.code`，网关自己抛的放在 `bitableCode`。 */
export const feishuCodeOf = (error) => {
  const candidates = [
    error?.response?.data?.code, error?.bitableCode, error?.code, error?.cause?.response?.data?.code,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
};

export const feishuMessageOf = (error) => String(
  error?.response?.data?.msg || error?.message || error || '',
).slice(0, 300);

/**
 * ⭐ 这一步就是本次事故的解药：**"表 ID 不对" 必须与 "表缺字段" 分开报**。
 *    · `1254041 TableIdNotFound` / `NOTEXIST` / `404 page not found`（table_id 为空）
 *      ⇒ `stale_id`（ID 过期 / 不对）；
 *    · 其他 ⇒ `read_failed`（读失败，原样带 code + msg）。
 *   ⚠️ 绝不允许把前者归纳成"表结构不一致"。
 */
export const classifyReadError = (error) => {
  const code = feishuCodeOf(error);
  const msg = feishuMessageOf(error);
  if (code === 1254041 || /TableIdNotFound|table\s*not\s*found|1254041/i.test(msg)) {
    return { kind: 'stale_id', code, message: msg, reason: 'TableIdNotFound（1254041）：表 ID 过期 / 指向了别的 Base' };
  }
  if (code === 1254005 || /NOTEXIST/i.test(msg)) {
    return { kind: 'stale_id', code, message: msg, reason: `该表在目标 Base 里不存在（code=${code}）` };
  }
  if (/404 page not found/i.test(msg)) {
    return { kind: 'unconfigured', code, message: msg, reason: 'table_id 为空 → 请求打到了 /tables//records（配置缺失，不是表结构问题）' };
  }
  return { kind: 'read_failed', code, message: msg, reason: `读取失败（code=${code ?? 'unknown'}）` };
};

/** schema 映射里期望存在的字段名（去重、去掉空值）。 */
export const expectedFieldNames = (fields = {}) => [...new Set(Object.values(fields).filter(Boolean))];

/** 缺了哪些（只报"schema 要、真表没有"；真表多出来的列不报——闸门也不管它）。 */
export const diffFields = (expected = [], actual = []) => {
  const have = new Set(actual);
  return expected.filter((name) => !have.has(name));
};

/** 输出里绝不许出现明文凭证：一旦出现，调用方**阻断打印**。 */
export const findSecretLeaks = (text, secrets = []) => [...new Set(
  (secrets || []).map((value) => String(value || '')).filter((value) => value.length >= 8),
)].filter((secret) => String(text || '').includes(secret));

// ── 核心：跑一遍自检（可用假 client 离线单测）────────────────────────────────
/**
 * @param {object} args
 * @param {object} args.client        飞书 client（或替身，需有 bitable.appTable.list / appTableField.list）
 * @param {Array}  args.tables        [{ key, envVar, tableId, expectedName, fieldNames: [] }]
 * @param {object} args.env           用于判断"本机有没有显式配过这个变量"
 * @param {Array}  args.inScopeKeys   V1_SCHEMA_SCOPES.all（闸门范围内的表 key）
 * @param {string} args.appToken      目标 Base
 */
export const runSelfcheck = async ({
  client, gateway: gatewayArg, tables = [], env = {}, inScopeKeys = [], appToken = '', clientError = '',
}) => {
  const inScope = new Set(inScopeKeys);
  const baseTables = [];
  let baseError = null;
  if (!client) {
    baseError = {
      kind: 'read_failed',
      reason: `没有可用的飞书客户端：${clientError || '缺少 LARK_AGENT_APP_ID / LARK_AGENT_APP_SECRET'}`,
      message: '',
    };
  } else if (!appToken) {
    baseError = { kind: 'unconfigured', reason: '缺少 FEISHU_V1_BITABLE_APP_TOKEN：无法确定目标 Base' };
  } else {
    try {
      let pageToken;
      do {
        // eslint-disable-next-line no-await-in-loop
        const response = await client.bitable.appTable.list({
          path: { app_token: appToken },
          params: { page_size: 200, page_token: pageToken },
        });
        baseTables.push(...(response?.data?.items || []));
        pageToken = response?.data?.has_more ? response?.data?.page_token : undefined;
      } while (pageToken);
    } catch (error) {
      const classified = classifyReadError(error);
      // ⚠️ 这是**整张 Base** 都读不到（token 不对 / 无权限 / 网络），
      //    与"某张表的 ID 过期"是两件事 —— 措辞上必须分开。
      baseError = {
        ...classified,
        kind: 'base_unreadable',
        reason: `整张 Base 读不到（appToken 不对 / 无权限 / 网络）：${classified.reason}`,
      };
    }
  }
  const byId = new Map(baseTables.map((item) => [String(item.table_id || ''), String(item.name || '')]));
  const idByName = new Map();
  for (const item of baseTables) {
    const name = String(item.name || '');
    if (!idByName.has(name)) idByName.set(name, String(item.table_id || ''));
  }
  // 字段读取**走项目网关**（AGENTS 第 7 条：验证也走项目代码），而不是自己拼 SDK。
  // ⚠️ 这里构造它（而不是模块顶层 require）：`v1BitableSchema` 是 require 时求值 tableId 的，
  //    必须先 loadEnv 再 require —— 见 main() 的顺序。
  let gateway = gatewayArg;
  if (!gateway && client) {
    const { V1BitableGateway } = createRequire(import.meta.url)('../src/services/v1BitableGateway');
    gateway = new V1BitableGateway({ client });
  }

  const rows = [];
  for (const table of tables) {
    const tableId = String(table.tableId || '');
    const configured = Boolean(String(env[table.envVar] ?? '').trim());
    const scope = inScope.has(table.key);
    // ⭐ 谁影响退出码：闸门范围内的表，或本机显式配过的变量（见文件头）。
    const impactsExit = scope || configured;
    const row = {
      key: table.key,
      envVar: table.envVar,
      tableId,
      expectedName: table.expectedName,
      realName: '',
      fieldCount: null,
      missing: [],
      status: 'ok',
      scope: scope ? '闸门内' : '闸门外的可选项',
      configured,
      impactsExit,
      detail: '',
      suggestion: '',
    };

    if (!tableId) {
      row.status = 'unconfigured';
      row.detail = `${table.envVar} 未配置（schema 也没有默认值）`;
    } else if (baseError) {
      // 整张 Base 都没读到 ⇒ **不许**逐行判"ID 过期"或"缺字段"，那是两码事。
      row.status = 'base_unreadable';
      row.detail = `${baseError.reason}｜逐表结论不可用（先解决 Base 本身）`;
    } else if (!byId.has(tableId)) {
      row.status = 'stale_id';
      row.detail = `表 ID ${tableId} 在目标 Base 里**不存在** ⇒ ID 过期 / 指向了别的 Base`;
      const guess = idByName.get(table.expectedName);
      // 表名对得上 ⇒ 直接把"该填哪个 ID"给出来（本次误判就是差这一步）。
      if (guess) row.suggestion = `疑似应对应「${table.expectedName}」= ${guess} ⇒ 设 ${table.envVar}=${guess}`
        + '（该 ID 取自**当前目标 Base**，别跨环境抄）';
    } else {
      row.realName = byId.get(tableId);
      try {
        if (!gateway) throw new Error('没有可用的项目网关（缺少飞书客户端）');
        // eslint-disable-next-line no-await-in-loop
        const fields = await gateway.listFields(table.key, { refresh: true });
        row.fieldCount = fields.length;
        row.missing = diffFields(table.fieldNames, fields.map((item) => item.field_name));
        if (row.missing.length) {
          row.status = 'missing_fields';
          row.detail = `缺字段：${row.missing.join('、')}`;
        } else if (row.realName !== table.expectedName) {
          row.status = 'name_mismatch';
          row.detail = `真表名「${row.realName}」≠ schema 期望「${table.expectedName}」`
            + '（闸门只按 tableId 校验字段名、**不校验表名** ⇒ 表改名必须自己同步）';
        } else {
          row.status = 'ok';
          row.detail = `${row.fieldCount} 个字段，schema 映射齐`;
        }
      } catch (error) {
        const classified = classifyReadError(error);
        row.status = classified.kind;
        row.detail = `${classified.reason}｜${classified.message}`;
      }
    }
    rows.push(row);
  }
  return { rows, baseTables, baseError };
};

// ── 渲染（纯函数，便于单测断言"没有明文 token"）─────────────────────────────
const STATUS_LABEL = {
  ok: 'OK ✅',
  stale_id: '✗ ID 过期/不对',
  name_mismatch: '✗ 表名不一致',
  missing_fields: '✗ 缺字段',
  read_failed: '✗ 读失败',
  base_unreadable: '✗ Base 读不到',
  unconfigured: '✗ 未配置',
};

const padEnd = (value, width) => {
  const text = String(value ?? '');
  // 中文按 2 列算，避免表格错行。
  const shown = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - shown));
};

export const renderReport = ({
  rows = [], selfProofs = [], envNotes = [], baseTableCount = 0, baseError = null, envSources = [],
  repo = '', envInjected = 0,
}) => {
  const out = [];
  const line = (char = '─') => out.push(char.repeat(96));
  out.push('════════════════════════════════════════════════════════════════════════════════════════');
  out.push('  本机环境自检 · 只读 · 零写入（env-selfcheck）');
  out.push('════════════════════════════════════════════════════════════════════════════════════════');
  out.push(`  仓库：${repo}`);
  out.push(`  环境变量来源（后者覆盖前者）：${envSources.join(' → ') || '(未加载)'}（共注入 ${envInjected} 项）`);
  if (baseError) out.push(`  ⚠️ Base 表清单读取失败：${baseError.reason}｜${baseError.message || ''}`);
  else out.push(`  目标 Base 里共 ${baseTableCount} 张表（appTable.list，只读）`);

  out.push('');
  line('═');
  out.push('  自证 ①：目标 Base 是不是【授权测试 Base】');
  line('═');
  for (const item of selfProofs) out.push(`  ${item.ok ? '✅' : '✗'} ${item.label}：${item.value}`);

  out.push('');
  line('═');
  out.push('  逐表核对（table_id 存在性 / 真表名 / schema 字段缺口 —— 三者**分开**判）');
  line('═');
  out.push(`  ${padEnd('环境变量', 44)}${padEnd('table_id', 20)}${padEnd('真表名', 16)}`
    + `${padEnd('期望名', 16)}${padEnd('字段', 6)}${padEnd('结论', 18)}闸门`);
  line();
  for (const row of rows) {
    out.push(`  ${padEnd(row.envVar, 44)}${padEnd(row.tableId || '(空)', 20)}`
      + `${padEnd(row.realName || '—', 16)}${padEnd(row.expectedName, 16)}`
      + `${padEnd(row.fieldCount === null ? '—' : row.fieldCount, 6)}`
      + `${padEnd(STATUS_LABEL[row.status] || row.status, 18)}`
      + `${row.scope === '闸门内' ? '内' : '外'}${row.impactsExit ? '(计)' : ''}`);
    if (row.status !== 'ok') {
      out.push(`      └─ ${row.envVar}｜${row.detail}`);
      if (row.suggestion) out.push(`      └─ 💡 ${row.suggestion}`);
    }
  }

  const stale = rows.filter((row) => row.status === 'stale_id');
  if (stale.length) {
    out.push('');
    out.push('  ⚠️ 「ID 过期 / 不对」不等于「表缺字段」——先按 💡 把 ID 改对，再跑一次；');
    out.push('     ⚠️ 不要拿这条报错去下"表结构不一致"的结论（2026-10-12 就是这么误判的）。');
  }

  if (envNotes.length) {
    out.push('');
    line('═');
    out.push('  附：`.env` 里写着、但 schema **从不读取**的 TABLE_ID 变量（⚠️「ID 放错变量名」的温床）');
    line('═');
    for (const note of envNotes) out.push(`  ${note}`);
    out.push('  ℹ️ 改这些变量**不会有任何效果**（schema 读的是别的名字）⇒ 别在这里改 ID。');
  }

  const counted = rows.filter((row) => row.impactsExit);
  const bad = counted.filter((row) => row.status !== 'ok');
  out.push('');
  line('═');
  out.push('  结论');
  line('═');
  const stat = (status) => rows.filter((row) => row.status === status).length;
  out.push(`  共 ${rows.length} 张表：OK ${stat('ok')} · ID 过期/不对 ${stat('stale_id')} · 表名不一致 ${stat('name_mismatch')}`
    + ` · 缺字段 ${stat('missing_fields')} · 读失败 ${stat('read_failed')} · 未配置 ${stat('unconfigured')}`
    + ` · Base 读不到 ${stat('base_unreadable')}`);
  out.push(`  计入退出码的 ${counted.length} 张（闸门内 / 本机显式配置过）：红 ${bad.length} 张`
    + `${bad.length ? ` ⇒ ${bad.map((row) => `${row.envVar}(${STATUS_LABEL[row.status]})`).join(' · ')}` : ''}`);
  return out.join('\n');
};

/**
 * ⭐ 退出码的唯一判据（单独成函数：AC 要能离线断言它，不用真连飞书）。
 *   `ID 过期 ⇒ 非零` · `缺字段 ⇒ 非零` · `全对 ⇒ 0`。
 */
export const exitCodeFor = ({
  selfProofOk = true, targetInForbidden = false, baseError = null, mappingProblems = [], rows = [],
} = {}) => {
  // Base 整张读不到时，不再逐行重复罗列（原因已经在 baseError 里说清楚了）。
  const countedBad = baseError ? [] : rows.filter((row) => row.impactsExit && row.status !== 'ok');
  const reasons = [];
  if (!selfProofOk) reasons.push('自证 ①：目标 Base **不是**授权测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN）');
  if (targetInForbidden) reasons.push('目标 Base 命中「生产禁止清单」');
  if (baseError) reasons.push(`前提缺失：${baseError.reason || baseError.kind}`);
  if (mappingProblems.length) reasons.push(`「表 → 环境变量名」映射自检失败：${mappingProblems.join('；')}`);
  if (countedBad.length) {
    reasons.push(`逐表核对红 ${countedBad.length} 张：`
      + countedBad.map((row) => `${row.envVar}(${STATUS_LABEL[row.status] || row.status})`).join('、'));
  }
  return { exitCode: reasons.length ? 1 : 0, reasons, countedBad };
};

// ── main ─────────────────────────────────────────────────────────────────────
const loadEnv = () => {
  const records = [
    { label: path.join(repoRoot, '.env'), path: path.join(repoRoot, '.env'), override: false },
    { label: String(flags['env-file'] || ''), path: String(flags['env-file'] || ''), override: true },
  ];
  const sources = [];
  const loadedPaths = [];
  let injected = 0;
  for (const item of records) {
    if (!item.path) continue;
    if (!fs.existsSync(item.path)) { sources.push(`${item.label}（不存在，跳过）`); continue; }
    const result = dotenv.config({ path: item.path, override: item.override, quiet: true });
    injected += Object.keys(result.parsed || {}).length;
    sources.push(`${item.label}（注入 ${Object.keys(result.parsed || {}).length} 项）`);
    loadedPaths.push(item.path);
  }
  return { sources, injected, loadedPaths };
};

export const main = async () => {
  const envInfo = loadEnv();
  const require = createRequire(import.meta.url);
  const lark = require('@larksuiteoapi/node-sdk');
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  const { V1_SCHEMA_SCOPES } = require('../src/config/v1SchemaScopes');
  const { getLarkAgentCredentials } = require('../src/config/larkAgent');

  const env = process.env;
  const appToken = String(env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
  const e2eToken = String(env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  const forbidden = [
    ...String(env.FEISHU_V1_FORBIDDEN_APP_TOKENS || '').split(',').map((item) => item.trim()).filter(Boolean),
    ...(String(env.FEISHU_V1_PROD_APP_TOKEN || '').trim() ? [String(env.FEISHU_V1_PROD_APP_TOKEN).trim()] : []),
  ];
  const secrets = [
    appToken, e2eToken, env.LARK_AGENT_APP_SECRET, ...forbidden,
  ].filter(Boolean);

  // 自证（两条，硬要求"如实"）
  const selfProofs = [
    {
      ok: Boolean(appToken) && appToken === e2eToken,
      label: 'FEISHU_V1_BITABLE_APP_TOKEN 逐字等于 FEISHU_V1_E2E_TEST_APP_TOKEN',
      value: appToken === e2eToken
        ? `相等（${fingerprint(appToken)}）⇒ 指向授权测试 Base`
        : `**不相等**（当前 ${fingerprint(appToken)} vs 测试 ${fingerprint(e2eToken)}）⇒ 拒绝写表类测试`,
    },
    {
      ok: true,
      label: '生产禁止清单（FEISHU_V1_FORBIDDEN_APP_TOKENS / FEISHU_V1_PROD_APP_TOKEN）',
      value: forbidden.length
        ? `已登记 ${forbidden.length} 个（${forbidden.map(fingerprint).join('、')}）`
        : '均为空 ⇒ 本机没有登记生产 token（AGENTS 第 8 条：物理够不着生产）',
    },
    {
      ok: String(env.FEISHU_TARGET_ENV || '').trim().toLowerCase() === 'test',
      label: 'FEISHU_TARGET_ENV',
      value: `${env.FEISHU_TARGET_ENV || '(未设置)'}（写表类脚本要求 test）`,
    },
  ];
  const targetInForbidden = forbidden.includes(appToken);

  // 表清单 + 「每个表读哪个变量」（源码解析，随后与 schema 交叉核对）
  const envVarMap = parseTableEnvVars(fs.readFileSync(schemaSourcePath, 'utf8'));
  const schemaKeys = Object.keys(V1_BITABLE_SCHEMA.tables || {});
  const mappingProblems = [];
  for (const key of schemaKeys) {
    if (!envVarMap.has(key)) mappingProblems.push(`schema 有表 \`${key}\`，但源码解析没找到它的 \`tableId: getEnv('…')\``);
  }
  for (const key of envVarMap.keys()) {
    if (!schemaKeys.includes(key)) mappingProblems.push(`源码里解析出 \`${key}\`，但 schema.tables 里没有它`);
  }

  const tables = schemaKeys.map((key) => {
    const table = V1_BITABLE_SCHEMA.tables[key];
    return {
      key,
      envVar: envVarMap.get(key) || `(未解析到 ${key} 的环境变量)`,
      tableId: String(table.tableId || '').trim(),
      expectedName: String(table.tableName || ''),
      fieldNames: expectedFieldNames(table.fields),
    };
  });

  // `.env` 里写着、但 schema 不读的 TABLE_ID 变量（"ID 放错变量名"的温床）
  const envFileText = envInfo.loadedPaths.map((item) => fs.readFileSync(item, 'utf8')).join('\n');
  const envTableIdKeys = envFileText.split('\n')
    .map((row) => row.match(/^\s*(FEISHU_V1_[A-Z0-9_]*TABLE_ID)\s*=/)?.[1])
    .filter(Boolean);
  const liveEnvVars = new Set([...envVarMap.values()]);
  const orphanEnvVars = [...new Set(envTableIdKeys)].filter((key) => !liveEnvVars.has(key));
  const envNotes = orphanEnvVars.map((key) => {
    const raw = String(env[key] || '').trim();
    return `⚠️ ${key} = ${fingerprint(raw)}（schema 已不读取；疑似历史遗留 / 变量名改过）`;
  });
  const byValue = new Map();
  for (const key of new Set(envTableIdKeys)) {
    const raw = String(env[key] || '').trim();
    if (!raw) continue;
    if (!byValue.has(raw)) byValue.set(raw, []);
    byValue.get(raw).push(key);
  }
  for (const [raw, keys] of byValue) {
    if (keys.length > 1) envNotes.push(`ℹ️ 同值重复：${keys.join(' 与 ')} 都等于 ${fingerprint(raw)}`);
  }

  // 跑核对（client 只用于只读 appTable.list / appTableField.list）
  // ⚠️ 缺凭证时**不崩**：自证段照打，逐表统一标 ✗（缺凭证本身就是一条要看的红）。
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  let client = null;
  let clientError = '';
  try {
    const { appId, appSecret } = getLarkAgentCredentials();
    client = new lark.Client({ appId, appSecret, logger });
  } catch (error) {
    clientError = error.message;
  }
  const result = await runSelfcheck({
    client,
    tables,
    env,
    inScopeKeys: V1_SCHEMA_SCOPES.all,
    appToken,
    clientError,
  });

  const { exitCode, reasons } = exitCodeFor({
    selfProofOk: selfProofs[0].ok,
    targetInForbidden,
    baseError: result.baseError,
    mappingProblems,
    rows: result.rows,
  });
  const text = renderReport({
    rows: result.rows,
    selfProofs: [
      ...selfProofs,
      {
        ok: !targetInForbidden,
        label: '目标 Base 是否命中禁止写入清单',
        value: targetInForbidden ? '**命中**（生产 Base）⇒ 拒绝任何写表测试' : '未命中 ✅',
      },
      {
        ok: mappingProblems.length === 0,
        label: '「表 → 环境变量名」映射自检（防止新增表被静默漏检）',
        value: mappingProblems.length ? mappingProblems.join('；') : `源码解析 ${envVarMap.size} 张 = schema ${schemaKeys.length} 张 ✅`,
      },
    ],
    envNotes,
    baseTableCount: result.baseTables.length,
    baseError: result.baseError,
    envSources: envInfo.sources,
    repo: repoRoot,
    envInjected: envInfo.injected,
  });

  const leaks = findSecretLeaks(text, secrets);
  if (leaks.length) {
    // 宁可什么都不打，也不把明文凭证写进日志 / 报告文件。
    console.log('✗ 自检输出里检测到明文凭证，已阻断打印（退出码 1）。');
    process.exitCode = 1;
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify({
      ok: exitCode === 0,
      exit_code: exitCode,
      red_reasons: reasons,
      rows: result.rows,
      self_proofs: selfProofs,
      orphan_env_vars: orphanEnvVars,
      mapping_problems: mappingProblems,
      base_table_count: result.baseTables.length,
    }, null, 2));
  } else {
    console.log(text);
    if (reasons.length) {
      console.log('  红的依据：');
      for (const reason of reasons) console.log(`    · ${reason}`);
    }
    console.log(`  退出码 ${exitCode}（${exitCode ? '有红' : '全绿'}）`);
  }
  process.exitCode = exitCode;
};

// ⚠️ 只有"被当脚本直接跑"才执行：单测 `import()` 它时不许连飞书、也不许读 .env。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`✗ 自检自身出错（这不算 Base 的问题）：${error.message}`);
    process.exitCode = 1;
  });
}
