#!/usr/bin/env node
/**
 * ws-listen.mjs —— 只做一件事：用**现有凭证**在本地开一条飞书「长连接」，把收到的事件打印出来。
 *
 * ⚠️ 这个脚本**只连、只看**：
 *   · 不写任何多维表格；
 *   · 不调用任何飞书写接口（不发消息、不改记录）；
 *   · 到点自动断开（默认 60 秒）。
 * 目的就是回答一个问题：「本机这台电脑，能不能收到飞书推给我们应用的事件？」
 *
 * 用法：
 *   node scripts/ws-listen.mjs --seconds 60 --env-file <主工作区 .env>
 *   node scripts/ws-listen.mjs --events im.message.receive_v1,drive.file.bitable_record_changed_v1
 *
 * 退出码：0 = 连上了（不管有没有事件）；2 = 连不上（长连接没开 / 凭证不对 / 网络不通）。
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

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const { appId, appSecret } = getLarkAgentCredentials();
let appToken = '';
try { appToken = V1_BITABLE_SCHEMA.appToken; } catch { appToken = ''; }

console.log('════════════════════════════════════════════════════════════════════════');
console.log('  本地长连接试连（只连、不处理、不写任何表）');
console.log('════════════════════════════════════════════════════════════════════════');
console.log(`  app_id            ：${appId}`);
console.log(`  本地 .env 指向 Base：${appToken || '(未配置)'}`);
console.log(`  订阅的事件         ：${eventKeys.join(', ')}`);
console.log(`  连接时长           ：${seconds}s`);
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
