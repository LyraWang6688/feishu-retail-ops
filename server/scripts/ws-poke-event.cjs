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
 * ⚠️ 内置闸门：目标 Base 是生产 Base 时直接拒绝执行。
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

const { V1BitableGateway } = require('../src/services/v1BitableGateway');

const PROD_APP_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh';
const appToken = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
if (!appToken) { console.error('缺少 FEISHU_V1_BITABLE_APP_TOKEN'); process.exit(1); }
if (appToken === PROD_APP_TOKEN) { console.error('拒绝执行：目标 Base 是生产 Base'); process.exit(1); }

(async () => {
  const gateway = new V1BitableGateway();
  const created = await gateway.create('accessory', { name: `SELFTEST-WS-PROBE-${Date.now()}` });
  console.log(`EVENT_PROBE_CREATED ${created.recordId} at ${new Date().toISOString()}`);
})().catch((error) => { console.error('ERR', error.message); process.exit(1); });
