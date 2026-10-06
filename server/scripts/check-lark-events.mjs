#!/usr/bin/env node
/**
 * check-lark-events.mjs —— 「机器人还收不收得到消息」的自检脚本。
 *
 * 为什么要有它（**今天真实发生过**）：
 *   业务负责人在飞书开放平台把【事件回调】的请求地址填成了
 *   `https://workbench.bamamei.online/api/auth/feishu/callback`，飞书报
 *   「Challenge code 没有返回」——**侥幸没保存成功**。否则机器人就收不到群消息和
 *   卡片点击了，而且**此前没有任何监控**：可能几天后才发现"机器人不回话"，
 *   那几天漏的单子就丢了。
 *   现在事件入口每次收到请求都会把时间写进 `server/data/lark_event_heartbeat.json`
 *   （见 routes/larkEvents.js 与 infrastructure/larkEventHeartbeat.js），
 *   本脚本读它：**太久没收到事件 = 机器人可能瞎了** → 发一条飞书告警。
 *
 * 判断口径（与 GET /api/lark/events/health **共用同一套**，见 config/larkEventHeartbeat.js）：
 *   · 主判据是 `lastEventAt`（任何到达的事件，**含 URL 验证 challenge**——
 *     能收到验证就说明链路通）；
 *   · 阈值 `LARK_EVENT_STALE_MINUTES`（默认 180 分钟），命令行 `--minutes` 可临时覆盖；
 *   · **没有数据时绝不误报**：文件不存在 / 从没收到过任何事件 → 只报告"没有数据"，退出码 0。
 *     「没有数据」和「确实很久没收到」是两件事，不能混。
 *
 * 用法：
 *   node scripts/check-lark-events.mjs                  # 自检；超阈值且开关开启时发告警
 *   node scripts/check-lark-events.mjs --dry-run        # 只打印，绝不发消息
 *   node scripts/check-lark-events.mjs --json           # 机器可读输出（给监控系统用）
 *   node scripts/check-lark-events.mjs --minutes 60     # 临时把阈值改成 60 分钟
 *   node scripts/check-lark-events.mjs --file <path>    # 读别处的心跳文件
 *   node scripts/check-lark-events.mjs --env-file <p>   # 额外环境变量文件
 *
 * 退出码（便于 cron / 监控区分）：
 *   0 = 正常（含"没有数据，不告警"）；2 = 已超阈值但**没有发送**（开关关着 / --dry-run）；
 *   1 = 出错（环境变量缺失、发消息失败等）。
 *
 * 怎么挂定时（**推荐 cron，别在 app 里起 setInterval**）：
 *   · 为什么不用 app 内定时器：会和服务耦合，且每次重启/发版会打乱节奏、
 *     还可能因为进程刚起来就误报。自检是**运维动作**，交给系统调度更稳。
 *   · crontab（每 30 分钟跑一次，只在营业时段 08:00–21:00 跑，避免夜里误报）：
 *       0,30 8-21 * * * cd /path/to/feishu-retail-ops/server && \
 *         LARK_EVENT_ALERT_ENABLED=true /usr/bin/node scripts/check-lark-events.mjs \
 *         >> /var/log/lark-events-check.log 2>&1
 *   · pm2（同样每 30 分钟一次，跑完不常驻）：
 *       pm2 start scripts/check-lark-events.mjs --name lark-events-check \
 *         --cron "0,30 8-21 * * *" --no-autorestart
 *   · 也可以用服务器的 crontab -e 直接加一行。
 *   ⚠️ 只有显式 `LARK_EVENT_ALERT_ENABLED=true` 时才会真的发消息（默认关）——
 *      这样在开发机上手动跑不会往生产群发假告警。
 *
 * 安全：
 *   · **只读**：除了"把心跳文件读出来"，不改任何业务数据、不打印任何 secret；
 *   · 只有超阈值且开关开启时，才用项目自己的飞书应用身份发**一条纯文本告警**。
 *
 * 环境变量（全部可配，见 .env.example）：
 *   LARK_EVENT_STALE_MINUTES      超时阈值（分钟，默认 180）
 *   LARK_EVENT_ALERT_ENABLED      **显式布尔**，只有 true/1/yes/on 才发（默认关）
 *   LARK_EVENT_ALERT_TARGET       purchase_group（默认，用 PURCHASE_CHAT_ID）| owner
 *   LARK_EVENT_ALERT_OPEN_ID      target=owner 时的接收人 open_id
 *   LARK_EVENT_ALERT_MENTION_ALL  群里告警是否 @所有人（显式布尔，默认关）
 *   LARK_EVENT_CALLBACK_URL       告警文案里的正确回调地址
 *   LARK_EVENT_HEARTBEAT_FILE     心跳文件覆盖路径
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

if (flags.help === true) {
  fs.writeSync(1, `${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '')}\n`);
  process.exit(0);
}

// 一律同步写到 fd 1：脚本最后用 process.exit 结束，异步的 console.log 在
// 管道（如 `--json | jq`）里可能在退出时被丢掉半截。同步写不丢、也不会乱序。
const writeOut = (text) => {
  try {
    fs.writeSync(1, `${text}\n`);
  } catch {
    // stdout 被下游关掉（例如 `| head`）——不该因此让自检报错。
  }
};
const say = (...args) => { if (flags.json !== true) writeOut(args.map((value) => String(value)).join(' ')); };

// ── 环境变量（要在 require 业务模块之前加载）─────────────────────────────────
// 与 app.js 一致：`<repo>/.env`（worktree 里通常没有，需要临时软链或 --env-file）。
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
const {
  resolveStaleMinutes,
  isAlertEnabled,
  resolveAlertTarget,
  resolveAlertOpenId,
  isMentionAllEnabled,
  resolveCallbackUrl,
  evaluateLarkEventHeartbeat,
  buildLarkEventStaleAlertText,
  shanghaiTimeLabel,
  ALERT_TARGET_OWNER,
  ALERT_TARGET_PURCHASE_GROUP,
} = require('../src/config/larkEventHeartbeat');
const { readHeartbeatFile, DEFAULT_HEARTBEAT_FILE } = require('../src/infrastructure/larkEventHeartbeat');
const { resolvePurchaseChatId } = require('../src/config/groupPurchase');

const finish = (code, payload) => {
  if (flags.json === true) writeOut(JSON.stringify(payload, null, 2));
  process.exit(code);
};

// ── 判定 ─────────────────────────────────────────────────────────────────────
const flagMinutes = flags.minutes === undefined ? null : Number(flags.minutes);
if (flagMinutes !== null && (!Number.isFinite(flagMinutes) || flagMinutes <= 0)) {
  fs.writeSync(2, `--minutes 需要正整数（收到：${flags.minutes}）\n`);
  process.exit(1);
}
const staleMinutes = flagMinutes === null ? resolveStaleMinutes() : Math.floor(flagMinutes);
const heartbeatFile = typeof flags.file === 'string' ? flags.file : DEFAULT_HEARTBEAT_FILE;
const dryRun = flags['dry-run'] === true;
const alertEnabled = isAlertEnabled();

const heartbeat = readHeartbeatFile(heartbeatFile);
const evaluation = evaluateLarkEventHeartbeat(heartbeat, { staleMinutes, now: new Date() });

const alertTarget = resolveAlertTarget();
const base = {
  heartbeatFile,
  staleMinutes,
  alertEnabled,
  alertTarget,
  dryRun,
  lastEventAt: evaluation.lastEventAt,
  lastBusinessEventAt: evaluation.lastBusinessEventAt,
  minutesSinceLastEvent: evaluation.minutesSinceLastEvent,
  minutesSinceLastBusinessEvent: evaluation.minutesSinceLastBusinessEvent,
  hasData: evaluation.hasData,
  status: evaluation.status,
};

say('');
say('══════════════════════════════════════════════════════════════════════════════');
say('  飞书事件心跳自检（机器人还收不收得到消息）');
say('══════════════════════════════════════════════════════════════════════════════');
say(`  环境文件：${envSources.join(' · ') || '（无）'}`);
say(`  心跳文件：${heartbeatFile}`);
say(`  阈值：${staleMinutes} 分钟 · 告警开关：${alertEnabled ? '开' : '关（默认）'}`);
say(`  最后一次任何事件：${shanghaiTimeLabel(evaluation.lastEventAt)}`);
say(`  最后一次业务事件：${shanghaiTimeLabel(evaluation.lastBusinessEventAt)}`);

// ① 没有数据：首次运行 / 文件不存在 / 从没收到过任何事件 —— **绝不误报**。
if (!evaluation.hasData) {
  say('');
  say('  ⓘ 没有心跳数据（文件不存在，或从没收到过任何飞书事件）。');
  say('    「没有数据」不等于「很久没收到」⇒ 不告警，退出码 0。');
  finish(0, { ...base, outcome: 'no_data', alerted: false });
}

// ② 正常。
if (evaluation.status === 'ok') {
  say('');
  say(`  ✓ 正常：最近一次事件在 ${evaluation.minutesSinceLastEvent} 分钟前（阈值 ${staleMinutes} 分钟）。`);
  finish(0, { ...base, outcome: 'ok', alerted: false });
}

// ③ 超阈值。
const alertText = buildLarkEventStaleAlertText({
  minutesSinceLastEvent: evaluation.minutesSinceLastEvent,
  lastEventAt: evaluation.lastEventAt,
  callbackUrl: resolveCallbackUrl(),
});

say('');
say(`  ⚠️ 已超过阈值：最近 ${evaluation.minutesSinceLastEvent} 分钟没有收到任何飞书事件。`);
if (dryRun) {
  say('  --dry-run：只打印，不发送。将要发送的内容：');
  say('  ┌────────────────────────────────────────────────────────────');
  for (const line of alertText.split('\n')) say(`  │ ${line}`);
  say('  └────────────────────────────────────────────────────────────');
  finish(2, { ...base, outcome: 'stale_dry_run', alerted: false, alertText });
}

if (!alertEnabled) {
  say('  告警开关未开启（LARK_EVENT_ALERT_ENABLED 未显式设为 true）⇒ 不发送。');
  say('  ⇒ 要真的收到告警，请在 .env 里显式写 LARK_EVENT_ALERT_ENABLED=true 再挂定时。');
  finish(2, { ...base, outcome: 'stale_alert_disabled', alerted: false, alertText });
}

// ④ 发告警。目标：默认采购群（已有 PURCHASE_CHAT_ID，是现成的运维告警通道）；
//    也可显式切到业务负责人私聊（LARK_EVENT_ALERT_TARGET=owner + LARK_EVENT_ALERT_OPEN_ID）。
let receiveIdType;
let receiveId;
if (alertTarget === ALERT_TARGET_OWNER) {
  receiveIdType = 'open_id';
  receiveId = resolveAlertOpenId();
  if (!receiveId) {
    say('  ✗ 告警目标是 owner，但 LARK_EVENT_ALERT_OPEN_ID 未配置 ⇒ 无法发送。');
    finish(1, { ...base, outcome: 'error_missing_open_id', alerted: false, alertText });
  }
} else {
  receiveIdType = 'chat_id';
  receiveId = resolvePurchaseChatId();
  if (!receiveId) {
    say('  ✗ 告警目标是采购群，但 PURCHASE_CHAT_ID 未配置 ⇒ 无法发送。');
    finish(1, { ...base, outcome: 'error_missing_chat_id', alerted: false, alertText });
  }
}

// @所有人只对群有意义（显式布尔，默认关）。
const mentionAll = alertTarget === ALERT_TARGET_PURCHASE_GROUP && isMentionAllEnabled();
const text = mentionAll ? `<at user_id="all">所有人</at>\n${alertText}` : alertText;

try {
  const lark = require('@larksuiteoapi/node-sdk');
  const { getLarkAgentCredentials } = require('../src/config/larkAgent');
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret });
  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
  });
  if (response.code !== 0) throw new Error(`发送飞书消息失败: ${response.msg} (Code: ${response.code})`);
  say(`  ✓ 告警已发送（目标：${alertTarget}${mentionAll ? ' + @所有人' : ''}）。`);
  finish(0, { ...base, outcome: 'alert_sent', alerted: true, mentionAll, alertText });
} catch (error) {
  say(`  ✗ 告警发送失败：${error.message}`);
  finish(1, { ...base, outcome: 'error_send_failed', alerted: false, error: error.message, alertText });
}
