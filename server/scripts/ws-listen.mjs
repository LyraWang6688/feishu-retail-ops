#!/usr/bin/env node
/**
 * ws-listen.mjs —— 只做一件事：用**测试应用**的凭证在本地开一条飞书「长连接」，把收到的事件打印出来。
 *
 * ⚠️ 只认「测试应用」的凭证（业务负责人 2026-10-06 定的口径：
 *    生产环境推到开发者服务器 = webhook；**本地做测试才用长连接**）：
 *   · 凭证只从 `LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET` 读；
 *   · 缺任何一个**直接报错退出**，**绝不回退到 `LARK_AGENT_*`**——回退就等于偷偷连生产应用；
 *   · app_id 等于生产应用 `LARK_AGENT_APP_ID` 时**拒绝运行**（只与环境变量比较，不硬编码生产 app_id）；
 *   · 启动时只打印 app_id（**不是密钥，可以打印**），**绝不打印 secret**（连前 4 位都不打）。
 *
 * ⚠️ 这个脚本**只连、只看**：
 *   · 不写任何多维表格；
 *   · 不调用任何飞书写接口（不发消息、不改记录）；
 *   · 到点自动断开（默认 60 秒）。
 * 目的就是回答一个问题：「本机这台电脑，能不能用测试应用收到飞书推给我们的长连接事件？」
 *
 * 用法：
 *   node scripts/ws-listen.mjs --seconds 60 --env-file <主工作区 .env>
 *   node scripts/ws-listen.mjs --events im.message.receive_v1,drive.file.bitable_record_changed_v1
 *
 * 退出码：0 = 连上了（不管有没有事件）；1 = 凭证配置不对（缺测试凭证 / 测试凭证就是生产应用）；
 *         2 = 连不上（长连接没开 / 凭证不对 / 网络不通）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const flags = {};
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1; } else { flags[key] = true; }
}
const seconds = Number(flags.seconds || 60);
const eventKeys = String(flags.events || 'drive.file.bitable_record_changed_v1,im.message.receive_v1').split(',').map((s) => s.trim()).filter(Boolean);

for (const item of [
  { path: path.join(repoRoot, '.env'), override: false },
  { path: flags['env-file'] ? String(flags['env-file']) : '', override: false },
  { path: path.join(repoRoot, '.env.local'), override: true },
]) {
  if (item.path && fs.existsSync(item.path)) dotenv.config({ path: item.path, override: item.override, quiet: true });
}

// ── 凭证：只认「测试应用」，绝不碰生产应用 ────────────────────────────────────
// ⚠️ 不 require ../src/config/larkAgent（那读的是生产应用 LARK_AGENT_*，生产走 webhook）。
// ⚠️ 也**不设** LARK_AGENT_* 回退：回退 = 悄悄连上生产应用，等于把测试打到生产上。
const testAppId = String(process.env.LARK_TEST_APP_ID || '').trim();
const testAppSecret = String(process.env.LARK_TEST_APP_SECRET || '').trim();
if (!testAppId || !testAppSecret) {
  const missing = [!testAppId && 'LARK_TEST_APP_ID', !testAppSecret && 'LARK_TEST_APP_SECRET'].filter(Boolean);
  console.error(`❌ 缺少测试应用凭证：${missing.join('、')}`);
  console.error('   长连接只允许用测试应用（LARK_TEST_APP_ID / LARK_TEST_APP_SECRET），不会回退到 LARK_AGENT_*（生产应用）。');
  process.exit(1);
}

// ⭐ 显式护栏：测试应用的 app_id 不得等于生产应用的 app_id。
//    只与环境变量比较（生产取值以线上 .env 为准），**不硬编码生产 app_id**。
const productionAppId = String(process.env.LARK_AGENT_APP_ID || '').trim();
// ⚠️ 本机可能【只有一个测试应用】：项目代码只读 LARK_AGENT_*，本机跑自测必须把它填成测试应用，
//    于是 LARK_TEST_APP_ID 与 LARK_AGENT_APP_ID 指向同一个（测试）应用 —— 那不是"连生产"。
//    但**默认仍然拒绝**：只有【显式】声明"我知道它们是同一个、而它是测试应用"时才放行。
const allowSameApp = /^(1|true|yes|on)$/i.test(String(process.env.WS_LISTEN_ALLOW_SAME_APP || '').trim());
if (productionAppId && testAppId === productionAppId && !allowSameApp) {
  console.error('❌ 拒绝运行：LARK_TEST_APP_ID 与生产应用 LARK_AGENT_APP_ID 相同——这不是测试应用，禁止用长连接连生产。');
  console.error('   若本机只有一个测试应用（已确认它不是生产应用），可设 WS_LISTEN_ALLOW_SAME_APP=true 放行。');
  process.exit(1);
}
if (productionAppId && testAppId === productionAppId && allowSameApp) {
  console.log('⚠️ 已按 WS_LISTEN_ALLOW_SAME_APP=true 放行：两个变量指向同一个应用。');
  console.log('   ⚠️ 请自行确认它确实是【测试应用】，且 .env 指向的是【测试 Base】。');
  console.log(`   Base 归属自检：FEISHU_TARGET_ENV=${process.env.FEISHU_TARGET_ENV || '(未配)'} ` +
    `V1_BASE==E2E_TEST_BASE=${String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '') === String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '')}`);
}

const appId = testAppId;
const appSecret = testAppSecret;

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

let appToken = '';
try { appToken = V1_BITABLE_SCHEMA.appToken; } catch { appToken = ''; }

console.log('════════════════════════════════════════════════════════════════════════');
console.log('  本地长连接试连（只连、不处理、不写任何表）');
console.log('  ⚠️ 本次连接使用【测试应用】，不碰生产应用');
console.log('════════════════════════════════════════════════════════════════════════');
console.log(`  应用类型           ：测试应用（凭证来自 LARK_TEST_APP_ID / LARK_TEST_APP_SECRET）`);
console.log(`  app_id            ：${appId}    ← app_id 不是密钥，可以打印`);
console.log(`  app_secret         ：（不打印，只在 .env 里）`);
console.log(`  本地 .env 指向 Base：${appToken || '(未配置)'}`);
console.log(`  订阅的事件         ：${eventKeys.join(', ')}`);
console.log(`  连接时长           ：${seconds}s`);
console.log(`  生产应用护栏       ：${productionAppId ? '已开启（比对 LARK_AGENT_APP_ID）' : '⚠️ 未启用——本次 .env 未配置 LARK_AGENT_APP_ID，无法比对生产 app_id'}`);
console.log('');

const received = [];
const register = {};
for (const key of eventKeys) {
  register[key] = (event) => {
    received.push({ at: new Date().toISOString(), event_key: key, event });
    console.log(`  📥 收到事件 ${key}`);
    console.log(`     ${JSON.stringify(event).slice(0, 1200)}`);
    // ⚠️ 到此为止：不写表、不回复、不处理。
    return {};
  };
  // 有些事件在 SDK 里带 _v1 后缀，宽泛地再注册一份，避免"注册的名字不对导致收不到"的假阴性。
  if (!key.endsWith('_v1')) register[`${key}_v1`] = register[key];
}

const wsClient = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: 'info',
  autoReconnect: false,
  handshakeTimeoutMs: 15_000,
  onReady: () => console.log(`  ✅ 长连接已建立（${new Date().toISOString()}）`),
  onError: (error) => console.log(`  ❌ 长连接失败：${error?.message}`),
  onReconnecting: () => console.log('  ↻ 正在重连…'),
  onReconnected: () => console.log('  ✅ 重连成功'),
});

let connected = false;
try {
  await wsClient.start({ eventDispatcher: new lark.EventDispatcher({}).register(register) });
  connected = true;
} catch (error) {
  console.log(`  ❌ start() 抛错：${error?.message}`);
}

const heartbeat = setInterval(() => {
  const status = wsClient.getConnectionStatus?.();
  console.log(`  …状态 ${JSON.stringify(status)} 已收事件 ${received.length} 条（${new Date().toISOString()}）`);
}, 10_000);

await new Promise((resolve) => { setTimeout(resolve, Math.max(3, seconds) * 1000); });
clearInterval(heartbeat);
const status = wsClient.getConnectionStatus?.();
try { wsClient.close({ force: true }); } catch { /* 断开时的异常不影响结论 */ }

// start() 是长驻的：如果它 resolve 了，说明连接已建立；否则靠 onReady 判断。
if (!connected && status?.state === 'connected') connected = true;

console.log('');
console.log('════════════════════════════════════════════════════════════════════════');
console.log(`  结论：${connected ? '本地长连接**能**建立' : '本地长连接**没能**建立'}`);
console.log(`  最终连接状态：${JSON.stringify(status)}`);
console.log(`  这段时间收到事件：${received.length} 条`);
console.log('════════════════════════════════════════════════════════════════════════');
process.exitCode = connected ? 0 : 2;
