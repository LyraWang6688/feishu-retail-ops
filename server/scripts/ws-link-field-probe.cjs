#!/usr/bin/env node
/**
 * ws-link-field-probe.cjs —— **一次性**探针：在**测试 Base** 造一条**关联字段**（「配品销售.名称」→「其他配品」）
 * 的记录变更事件，把**真实 `after_value` 原文**打印/落盘（task-45 / AC-EV1）。
 *
 * 为什么要自己写一个（而不直接用 `ws-poke-event.cjs`）：
 *   · 那个脚本往「其他配品」加**空记录**（没有关联字段 ⇒ 拿不到"关联列在事件里的形状"）；
 *   · 它还有一道 `LARK_TEST_APP_ID === LARK_AGENT_APP_ID ⇒ 拒绝` 的闸门，
 *     而**本机 `.env` 两个变量本来就指向同一个测试应用**（AGENTS.md 第 8 条已说明这个现状）
 *     ⇒ 本脚本沿用 `ws-listen.mjs` 的**同名逃生阀**：`WS_PROBE_ALLOW_SAME_APP=true` 才放行。
 *
 * 🔴 只碰**测试 Base**（`.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN`；本机它 == `FEISHU_V1_E2E_TEST_APP_TOKEN`）；
 *   命中「禁止写入清单」直接拒绝执行；**不打印 secret**；不用飞书 CLI。
 *
 * 用法：
 *   WS_PROBE_ALLOW_SAME_APP=true node scripts/ws-link-field-probe.cjs --seconds 45
 * 产出：stdout 的 `AFTER_VALUE_RAW {...}` 一行（完整 JSON）+ `/tmp/ws-link-field-probe-event.json`
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : '';
};
for (const item of [
  { path: path.join(repoRoot, '.env'), override: false },
  { path: flag('env-file'), override: false },
  { path: path.join(repoRoot, '.env.local'), override: true },
]) {
  if (item.path && fs.existsSync(item.path)) dotenv.config({ path: item.path, override: item.override, quiet: true });
}

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resolveAccessorySaleIntakeConfig } = require('../src/config/accessorySaleIntake');

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

// ── 闸门（与既有 ws-* 脚本同一口径）────────────────────────────────────────────
const forbidden = String(process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const appToken = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
if (!appToken) { console.error('缺少 FEISHU_V1_BITABLE_APP_TOKEN'); process.exit(1); }
if (forbidden.includes(appToken)) { console.error('❌ 目标 Base 在【禁止写入清单】里 ⇒ 拒绝执行'); process.exit(1); }
const testAppId = String(process.env.LARK_TEST_APP_ID || '').trim();
const testAppSecret = String(process.env.LARK_TEST_APP_SECRET || '').trim();
if (!testAppId || !testAppSecret) { console.error('缺少 LARK_TEST_APP_ID / LARK_TEST_APP_SECRET（只认测试应用，不回退 LARK_AGENT_*）'); process.exit(1); }
const sameApp = testAppId === String(process.env.LARK_AGENT_APP_ID || '').trim();
const allowSameApp = /^(1|true|yes|on)$/i.test(String(process.env.WS_PROBE_ALLOW_SAME_APP || '').trim());
if (sameApp && !allowSameApp) {
  console.error('❌ LARK_TEST_APP_ID 与 LARK_AGENT_APP_ID 相同 ⇒ 拒绝执行'
    + '（确认它确实是测试应用、且 .env 指向测试 Base 后，可设 WS_PROBE_ALLOW_SAME_APP=true 放行）');
  process.exit(1);
}
if (!forbidden.length) {
  console.warn('⚠️ 未配置 FEISHU_V1_FORBIDDEN_APP_TOKENS ⇒ 本机这道"生产 Base"闸门是空转的（AGENTS.md 第 7/8 条）');
}
if (sameApp) {
  console.warn('⚠️ 已按 WS_PROBE_ALLOW_SAME_APP=true 放行：LARK_TEST_APP_ID 与 LARK_AGENT_APP_ID 指向同一个应用');
}

const seconds = Number(flag('seconds') || 45);
// 「配品销售」表 id：**配置取**（`config.tableId`，可用 `ACCESSORY_SALE_TABLE_ID` 覆盖）
// ⚠️ 本机 `.env` **没有**这个键 ⇒ 默认值是**生产**表 id（`tblkT1QTUsESnl5b`），在测试 Base 上会
//    `TableIdNotFound` —— 这恰好是"本机物理够不着生产"的现场证据 ✓。
//    要打测试 Base 的那张表，把它的 id 传进 `ACCESSORY_SALE_TABLE_ID`（见 docs 里的命令）。
const saleTableId = resolveAccessorySaleIntakeConfig().tableId;
const accessoryTableId = V1_BITABLE_SCHEMA.tables.accessory.tableId; // 「其他配品」表

const client = new lark.Client({ appId: testAppId, appSecret: testAppSecret, logger: silentLogger });
const gateway = new V1BitableGateway({ client });

(async () => {
  console.log(`应用：测试应用 app_id=${testAppId}（secret 不打印）`);
  console.log(`Base：${appToken.slice(0, 6)}…（本机 == FEISHU_V1_E2E_TEST_APP_TOKEN: ${appToken === process.env.FEISHU_V1_E2E_TEST_APP_TOKEN}）`);
  console.log(`表：配品销售=${saleTableId} · 其他配品=${accessoryTableId}`);

  // ① 找一条真实存在的「其他配品」记录，作为要写入的关联目标
  const rows = await gateway.listAll('accessory');
  const target = rows.map((r) => ({ id: r.record_id, name: r.fields?.['名称'] })).find((r) => r.id);
  if (!target) { console.error('「其他配品」里没有可用记录 ⇒ 无法造关联字段事件'); process.exit(1); }
  console.log(`关联目标：「其他配品」record_id=${target.id} 名称=${JSON.stringify(target.name)}`);

  // ② 订阅这张 Base 的变更事件（幂等；只改"事件推给谁"，不写表数据）
  try {
    await client.drive.v1.file.subscribe({ path: { file_token: appToken }, params: { file_type: 'bitable' } });
    console.log('已订阅该 Base 的记录变更事件 ✓');
  } catch (error) {
    console.warn(`订阅失败（继续尝试收事件）：${error?.message}`);
  }

  // ③ 长连接：把事件**完整**落盘（不截断）
  let resolveCaptured;
  const captured = new Promise((resolve) => { resolveCaptured = resolve; });
  const onEvent = (event) => {
    const dump = { at: new Date().toISOString(), event };
    fs.writeFileSync('/tmp/ws-link-field-probe-event.json', JSON.stringify(dump, null, 2));
    console.log('📥 收到事件 drive.file.bitable_record_changed_v1');
    const actions = event?.event?.action_list || event?.action_list || [];
    for (const action of actions) {
      console.log(`AFTER_VALUE_RAW ${JSON.stringify(action)}`);
    }
    if (actions.length) resolveCaptured(dump);
    return {};
  };
  const register = {
    'drive.file.bitable_record_changed_v1': onEvent,
    'drive.file.bitable_record_changed_v1_v1': onEvent,
  };
  const ws = new lark.WSClient({
    appId: testAppId, appSecret: testAppSecret, loggerLevel: 'info', autoReconnect: false,
    handshakeTimeoutMs: 15_000,
    onReady: async () => {
      console.log('✅ 长连接已建立 ⇒ 3s 后写探针记录');
      // ④ 在「配品销售」里建一条**带关联字段**的记录（字段名用中文列名，飞书 API 认）
      setTimeout(async () => {
        try {
          const created = await client.bitable.appTableRecord.create({
            path: { app_token: appToken, table_id: saleTableId },
            data: { fields: { 名称: [target.id], 数量: 1, 金额: 1 } },
          });
          const rid = created?.data?.record?.record_id || '';
          fs.writeFileSync('/tmp/ws-link-field-probe-record.json', JSON.stringify({ record_id: rid, link_target: target, raw: created }, null, 2));
          console.log(`PROBE_RECORD_CREATED ${rid}  raw=${JSON.stringify(created).slice(0, 400)}`);
        } catch (error) {
          console.error(`写探针记录失败：${error?.message}`);
          resolveCaptured({ error: error?.message });
        }
      }, 3000);
    },
    onError: (error) => console.warn(`❌ 长连接失败：${error?.message}`),
  });
  await ws.start({ eventDispatcher: new lark.EventDispatcher({}).register(register) });

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), seconds * 1000));
  const result = await Promise.race([captured, timeout]);
  if (result?.timeout) { console.log(`TIMEOUT ${seconds}s 内没收到事件`); process.exitCode = 2; }
  else console.log('CAPTURED /tmp/ws-link-field-probe-event.json');
  process.exit(process.exitCode || 0);
})().catch((error) => { console.error('ERR', error?.message); process.exit(1); });
