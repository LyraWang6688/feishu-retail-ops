#!/usr/bin/env node
/**
 * ws-poke-event.cjs —— 往测试 Base 的「其他配品」表加一条空记录，用来**制造一次真实的表变更事件**。
 *
 * 用途：验证"长连接/webhook 到底收不收得到事件"。配合 `ws-listen.mjs` 用：
 *   终端 A： node scripts/ws-listen.mjs --seconds 120 --env-file <主工作区 .env>
 *   终端 B： node scripts/ws-poke-event.cjs --env-file <主工作区 .env>
 *
 * 为什么选「其他配品」：它**不在** larkEvents 的采购分派表里（只有「供应商对接」会触发采购链路），
 * 所以即便有接收方在看这个 Base，也不会有任何业务副作用（测试表数据也不用删）。
 *
 * ⚠️ 凭证只认测试应用 `LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`（与 ws-listen.mjs 同一口径）：
 *    · `V1BitableGateway` 会用 `getLarkAgentCredentials()`（生产应用）自己建客户端，
 *      所以这里**显式注入**一个用测试凭证建的 client（`{ client }`），把它挡在业务代码之外；
 *    · 缺测试凭证直接报错退出，**不设 `LARK_AGENT_*` 回退**；
 *    · app_id 等于生产应用 `LARK_AGENT_APP_ID` 时拒绝执行（只与环境变量比较，不硬编码）；
 *    · 只打印 app_id（不是密钥），**绝不打印 secret**（lark client 用静默 logger，避免 SDK 打请求体里的 secret）。
 *
 * ⚠️ 内置闸门：目标 Base 是生产 Base 时直接拒绝执行（原样保留）。
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

// 🔴 禁止写入清单（生产 Base）**从 .env 读，不硬编码**（AGENTS.md 第 7 条）。
//    `.env` 里填 `FEISHU_V1_FORBIDDEN_APP_TOKENS`（或单数 `FEISHU_V1_PROD_APP_TOKEN`），
//    逗号分隔；命中即拒绝执行。
//    ⚠️ 本机 `.env` 刻意不放生产 token（AGENTS.md 第 8 条），这条闸门在本机是空转的；
//    真正的保护是「本机 / 本地测试应用根本够不着生产 Base」。
const forbiddenAppTokens = String(
  process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '',
).split(',').map((item) => item.trim()).filter(Boolean);
const appToken = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
if (!appToken) { console.error('缺少 FEISHU_V1_BITABLE_APP_TOKEN'); process.exit(1); }
if (forbiddenAppTokens.includes(appToken)) { console.error('拒绝执行：目标 Base 在禁止写入清单里（生产 Base）'); process.exit(1); }

// ── 凭证：只认「测试应用」，绝不碰生产应用 ────────────────────────────────────
// （上面的生产 Base 闸门原样保留；这里管的是"用哪个应用去写这条探针记录"。）
const testAppId = String(process.env.LARK_TEST_APP_ID || '').trim();
const testAppSecret = String(process.env.LARK_TEST_APP_SECRET || '').trim();
if (!testAppId || !testAppSecret) {
  const missing = [!testAppId && 'LARK_TEST_APP_ID', !testAppSecret && 'LARK_TEST_APP_SECRET'].filter(Boolean);
  console.error(`❌ 缺少测试应用凭证：${missing.join('、')}`);
  console.error('   本地测试脚本只允许用测试应用，不会回退到 LARK_AGENT_*（生产应用，生产走 webhook）。');
  process.exit(1);
}
const productionAppId = String(process.env.LARK_AGENT_APP_ID || '').trim();
if (productionAppId && testAppId === productionAppId) {
  console.error('❌ 拒绝执行：LARK_TEST_APP_ID 与生产应用 LARK_AGENT_APP_ID 相同——禁止用生产应用做本地探针。');
  process.exit(1);
}
// 静默 logger：SDK 的默认 logger 在报错时可能把请求配置（含 app_secret）打出来。
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

(async () => {
  // app_id 不是密钥，可以打印；**secret 绝不打印**。
  console.log(`应用：测试应用（LARK_TEST_APP_ID）app_id=${testAppId}（app_secret 不打印）  Base：${appToken}`);
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId: testAppId, appSecret: testAppSecret, logger: silentLogger }) });
  const created = await gateway.create('accessory', { name: `SELFTEST-WS-PROBE-${Date.now()}` });
  console.log(`EVENT_PROBE_CREATED ${created.recordId} at ${new Date().toISOString()}`);
})().catch((error) => { console.error('ERR', error.message); process.exit(1); });
