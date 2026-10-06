#!/usr/bin/env node
/**
 * ws-selftest.mjs —— ⭐ 把【测试群的真实消息】喂给**真实链路**，回复**真的发回测试群**。
 *
 * 它做的只有一件事：**把"生产上从飞书推过来的那条事件"从长连接里接住，原样交给生产的
 * 那一个入口 `LarkMvpService.acceptMessage`**（`src/routes/larkEvents.js` 第 43 行调的就是
 * 它，一字不差），然后观察结果。**不另写一套链路**：
 *
 *   飞书长连接(测试应用) ──im.message.receive_v1──> acceptMessage(event)   ← 生产同一个入口
 *                                                        │
 *                                        SalesGroupFlow / PurchaseFlow / 卡片 / 写表
 *                                                        │
 *                                  真实的 `this.client`（= 测试应用）──> 真的发回测试群
 *                                                        │
 *                                  同一个长连接 ──card.action.trigger──> service.handleCardAction
 *                                          （她在群里点「确认」那一下）
 *
 * ⭐ 关键设计（为什么这样才叫"真链路"）：
 *   · 事件**不改造**：`acceptMessage` 要的形态就是 v2 事件里的 `event` 本体（webhook 路由
 *     也是这么直接传的），所以这里只做"信封拆一层 + 兜住 SDK 版本差异"，**不重排字段**；
 *   · IM **不用本地替身**：`this.client` 就是真的 `lark.Client`（测试应用凭证），
 *     只在它的 `im.message.*` 方法外面套一层**记录器**（照常发出去，只是把出站 payload
 *     与飞书回带的 thread_id 记下来）—— 这是"看得出回复有没有走 reply_in_thread"的唯一硬证据；
 *   · 四个状态字段（确认/销售/资金/库存）**回读真表**，不靠日志推断。
 *
 * 🔴 硬闸门（写死在脚本里，任一条不满足**当场拒绝运行**）：
 *   ① 目标 Base 必须 = `FEISHU_V1_E2E_TEST_APP_TOKEN`，且 `FEISHU_TARGET_ENV=test`
 *      —— 本脚本会**真写**测试 Base（销售主表/明细/收款/库存流水），生产 Base 只读；
 *   ② 只允许【测试群】那一个 chat_id：`PURCHASE_CHAT_ID` 必须 == 下面写死的 `ALLOWED_CHAT_ID`；
 *      而且**运行期收到的每条消息**都再判一次 chat_id —— 别的群/私聊的消息**一律不喂进链路**
 *      （不喂 = 零远端调用 = 绝不可能发到别的群）；
 *   ③ 只认**测试应用**凭证（`LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`），缺了直接退出，
 *      **绝不回退** `LARK_AGENT_*`；两者指向同一个应用时（本机只有一个测试应用）需显式
 *      `WS_LISTEN_ALLOW_SAME_APP=true` 才放行（与 `ws-listen.mjs` 同一把闸门）；
 *   ④ 不打印任何 secret：app_secret / token 一律不落屏；人员 open_id 打码。
 *
 * 用法：
 *   node scripts/ws-selftest.mjs --env-file <主工作区>/.env --seconds 600
 *   node scripts/ws-selftest.mjs --check-only            # 只做只读体检（不连长连接、不写表）
 *
 * 参数：
 *   --seconds <n>         跑多久（默认 600）
 *   --quiet-seconds <n>   一条消息之后"安静"多少秒算处理完（默认 20）
 *   --settle-max <n>      "等处理完"的上限秒数（默认 120）
 *   --auto-confirm        ⚠️ 脚本代按「确认」（走的是生产的 handleCardAction，与她在群里点按钮
 *                          同一条路）——只在"她不在电脑前、只想看到四个字段被写对"时用；
 *                          默认关闭（默认由她本人在群里点）。
 *   --check-only          只读体检：校验闸门 + 表结构 + 冒烟读四个字段，不连长连接、不写。
 *   --env-file <path>     额外的环境文件（在 <repo>/.env 之后、<repo>/.env.local 之前加载）
 *
 * 退出码：0 = 正常跑完 / 只读体检通过；1 = 凭证或闸门不通过；2 = 长连接没建立。
 *
 * 环境变量加载顺序（后者覆盖前者）：<repo>/.env → --env-file → <repo>/.env.local
 * ⚠️ 必须在 require 业务模块**之前**加载：`v1BitableSchema` 是 require 时求值 tableId 的
 *    （2026-10-06 的 `app.js` dotenv 顺序事故，见 AGENTS.md 第 5 条）。
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
const seconds = Math.max(5, Number(flags.seconds || 600));
const quietSeconds = Math.max(2, Number(flags['quiet-seconds'] || 20));
const settleMaxSeconds = Math.max(quietSeconds, Number(flags['settle-max'] || 120));
const checkOnly = flags['check-only'] === true;
const autoConfirm = flags['auto-confirm'] === true;

// ── 环境文件（必须在 require 业务模块之前）────────────────────────────────────
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
const { V1BitableGateway, textValue, linkedRecordIds } = require('../src/services/v1BitableGateway');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SALES_STATUS_FIELDS } = require('../src/config/salesStatusDimensions');
const { resolveBotOpenId } = require('../src/config/groupPurchase');
const { isMentioned } = require('../src/utils/larkMessageText');
const { larkLogger } = require('../src/utils/larkLogger');

// ── 常量：唯一允许的群 ───────────────────────────────────────────────────────
// ⚠️ 这是【测试群】。脚本**绝不会**往其它任何 chat 发东西（运行期还会再判一次）。
const ALLOWED_CHAT_ID = 'oc_9f2cb1ff23ee442a5facbb1fc24ae1f9';

// ── 输出小工具 ───────────────────────────────────────────────────────────────
const line = (char = '─') => console.log(char.repeat(78));
const head = (title) => { console.log(''); line('═'); console.log(`  ${title}`); line('═'); };
const say = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// 时间一律上海时间（+8）——服务器/JSON 是 UTC，直接念数字她对不上（AGENTS.md 第 6 条）。
const shanghai = (at = new Date()) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(at).replace(/\//g, '-');
// open_id 打码（人员身份不落屏；chat/message/thread id 不是 secret，保留全文当证据）。
const mask = (value) => {
  const str = String(value || '');
  if (!str) return '(空)';
  if (str.length <= 10) return `${str.slice(0, 2)}***${str.slice(-2)}`;
  return `${str.slice(0, 6)}…${str.slice(-4)}`;
};

head('测试群真链路自测 · 长连接 → 真实 LarkMvpService → 真回复 → 回读测试 Base');
say('  环境文件：');
for (const source of envSources) say(`    · ${source}`);
const modeLabel = checkOnly
  ? '只读体检（--check-only：不连长连接、不写任何表）'
  : (flags['probe-reply'] === true
    ? '出站记录器自检（--probe-reply：不连长连接、不写任何表、不会真的发消息）'
    : `真跑 ${seconds}s（会真写测试 Base、真发消息到测试群）`);
say(`  模式：${modeLabel}`);
say(`  只允许的群：${ALLOWED_CHAT_ID}（测试群）`);

// ── 闸门 ①：目标必须是【测试 Base】──────────────────────────────────────────
const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
const isTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';

// ── 闸门 ②：群白名单（PURCHASE_CHAT_ID 必须就是测试群）──────────────────────
const envChatId = String(process.env.PURCHASE_CHAT_ID || '').trim();
const chatAllowed = envChatId === ALLOWED_CHAT_ID;

// ── 闸门 ③：只认测试应用凭证 ─────────────────────────────────────────────────
const testAppId = String(process.env.LARK_TEST_APP_ID || '').trim();
const testAppSecret = String(process.env.LARK_TEST_APP_SECRET || '').trim();
const productionAppId = String(process.env.LARK_AGENT_APP_ID || '').trim();
const allowSameApp = /^(1|true|yes|on)$/i.test(String(process.env.WS_LISTEN_ALLOW_SAME_APP || '').trim());
const sameApp = Boolean(productionAppId) && testAppId === productionAppId;
const sameAppBlocked = sameApp && !allowSameApp;

say('');
say(`  目标 Base 是否 = 测试 Base        ：${isTestBase ? '是 ✅' : '**不是** ✗'}`);
say(`  FEISHU_TARGET_ENV                 ：${targetEnv || '（未设置）'}`);
say(`  PURCHASE_CHAT_ID 是否 = 测试群     ：${chatAllowed ? '是 ✅' : `**不是**（当前 ${mask(envChatId)}）✗`}`);
say(`  测试应用凭证                       ：${testAppId && testAppSecret ? `${testAppId}（app_id 不是密钥，可打印；secret 不打印）` : '**缺失** ✗'}`);
say(`  生产应用护栏                       ：${productionAppId ? (sameApp ? '测试应用 == LARK_AGENT_APP_ID（本机只有一个测试应用，属已知基线）' : '测试应用 ≠ 生产应用 ✅') : '⚠️ 未配置 LARK_AGENT_APP_ID，无法比对'}`);
if (sameApp) {
  const note = allowSameApp
    ? '已按 WS_LISTEN_ALLOW_SAME_APP=true 放行'
    : (checkOnly
      ? '只读体检不受这条限制（不连长连接）；真跑时需 WS_LISTEN_ALLOW_SAME_APP=true'
      : '未放行 —— 需显式 WS_LISTEN_ALLOW_SAME_APP=true（与 ws-listen.mjs 同一把闸门）');
  say(`    ⚠️ ${note}`);
}

const gateFailures = [];
if (!isTestBase) gateFailures.push('目标 Base 不是授权的测试 Base（或 FEISHU_TARGET_ENV ≠ test）—— 本脚本会真写业务表，只允许测试 Base');
if (!chatAllowed) gateFailures.push(`PURCHASE_CHAT_ID 不等于测试群 ${ALLOWED_CHAT_ID} —— 拒绝运行（只允许发到测试群）`);
if (!testAppId || !testAppSecret) gateFailures.push('缺少测试应用凭证 LARK_TEST_APP_ID / LARK_TEST_APP_SECRET（绝不回退 LARK_AGENT_*）');
// ⚠️ 这一条只在**真的要连**的时候拦（--check-only 不连长连接，纯只读，拦它没有意义）。
if (sameAppBlocked && !checkOnly) {
  gateFailures.push('LARK_TEST_APP_ID == LARK_AGENT_APP_ID 且未设 WS_LISTEN_ALLOW_SAME_APP=true'
    + '（本机只有一个测试应用时，用 `WS_LISTEN_ALLOW_SAME_APP=true node scripts/ws-selftest.mjs …` 放行）');
}
if (gateFailures.length) {
  say('');
  say('🔴 拒绝运行：');
  for (const failure of gateFailures) say(`   · ${failure}`);
  process.exit(1);
}
say('  闸门：全部通过 ✅');

// ── 项目日志 tee：把项目代码打出来的结构化日志**原样透传**，同时留一份当证据 ──────
// logger.js 里 `console.log(line)` 是**调用时**取的，所以在这里套一层就能抓到
// （`lark.group.message.accepted` / `sales.group.sale.dispatched` / `inventory.change.applied` …
//  这些是**项目代码打出来的**，正是"走了哪条链路"的硬证据）。
// 顺带一提：logger 自己会把 open_id / secret 类字段打码，所以这里落屏也不会泄密。
const projectLogs = [];
const installLogTee = () => {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
          const parsed = JSON.parse(args[0]);
          if (parsed && typeof parsed === 'object' && parsed.event) {
            projectLogs.push({ level, event: parsed.event, meta: parsed });
          }
        }
      } catch { /* 不是项目日志，忽略 */ }
      original(...args);
    };
  }
};
installLogTee();

// ── 真的 lark.Client（测试应用）+ 出站记录器 ─────────────────────────────────
// ⚠️ `this.client` 就是这一个对象（**不是替身**）：消息真的发出去；
//    只在它身上套一层记录器，把"出站 payload"与"飞书回带的响应"记下来。
const realClient = new lark.Client({ appId: testAppId, appSecret: testAppSecret, logger: larkLogger });
const outbound = [];
const recordOutbound = (kind, args, run) => {
  const entry = {
    at: new Date().toISOString(), kind,
    to: args?.data?.receive_id || args?.path?.message_id || '',
    msg_type: args?.data?.msg_type || '',
    // ⭐ 这就是"是不是话题形式"的**唯一硬证据**：出站 payload 里带没带 reply_in_thread。
    reply_in_thread: args?.data?.reply_in_thread === true ? true : undefined,
    chat_id: args?.data?.receive_id_type === 'chat_id' ? args?.data?.receive_id : '',
    response: null, error: null,
  };
  outbound.push(entry);
  return Promise.resolve()
    .then(() => run(args))
    .then((response) => {
      entry.response = {
        code: response?.code, msg: response?.msg,
        message_id: response?.data?.message_id || '',
        thread_id: response?.data?.thread_id || '',
      };
      return response;
    })
    .catch((error) => { entry.error = error?.message || String(error); throw error; });
};
// 只包这三个出口（都是 im.message 上的方法）；读接口一个都不碰。
for (const kind of ['reply', 'create', 'patch']) {
  const original = realClient.im.message[kind];
  if (typeof original === 'function') {
    realClient.im.message[kind] = (args) => recordOutbound(`im.message.${kind}`, args, (a) => original.call(realClient.im.message, a));
  }
}
const originalReaction = realClient.im.messageReaction?.create;
if (typeof originalReaction === 'function') {
  realClient.im.messageReaction.create = (args) => recordOutbound('im.messageReaction.create', args, (a) => originalReaction.call(realClient.im.messageReaction, a));
}

// ── 出站记录器自检（--probe-reply）────────────────────────────────────────────
// 目的：**证明"reply_in_thread=true"这条证据真的被抓到了**，而不是只写在注释里。
// 做法：朝一个**根本不存在的 message_id** 发一次带 reply_in_thread 的回复 —— 飞书会拒绝它，
//       所以**不会真的往任何一个群/任何人发东西**；但我们的记录器应当已抓到出站 payload。
if (flags['probe-reply'] === true) {
  head('出站记录器自检（--probe-reply：不会真的发出任何消息）');
  await realClient.im.message
    .reply({
      path: { message_id: 'om_ws_selftest_probe_this_is_not_a_real_message' },
      data: { msg_type: 'text', content: JSON.stringify({ text: 'probe' }), reply_in_thread: true },
    })
    .catch((error) => say(`  预期内的失败（message_id 是编的）：${error?.message || error}`));
  say(`  记录器抓到的出站记录：${JSON.stringify(outbound, null, 2)}`);
  say(`  ${outbound[0]?.reply_in_thread === true
    ? '  ✅ 出站 payload 里的 reply_in_thread=true 被正确捕获（"是不是话题形式"这条证据可信）'
    : '  ❌ 没抓到 reply_in_thread —— 证据链有问题，不要相信本脚本的结论'}`);
  process.exit(0);
}

const gateway = new V1BitableGateway({ client: realClient });

// ── 本地存储：指向**本次会话专用目录**（只写 server/data/ 下的临时目录，gitignored）──
// 为什么用临时目录：① 让"本次会话建了哪些任务/话题映射"可枚举、可打印；
// ② 不污染主工作区的既有本地任务记录。走的是项目自己的 JsonTaskStore / Locator，不是另写一套。
// ⚠️ `server/data/` 是 gitignored 的：干净 worktree 里可能还不存在，先建出来（只建目录，不写业务表）。
fs.mkdirSync(path.join(serverRoot, 'data'), { recursive: true });
const sessionDir = fs.mkdtempSync(path.join(serverRoot, 'data', 'ws-selftest-'));
const salesStore = new JsonTaskStore({ dir: path.join(sessionDir, 'lark_mvp_tasks'), idField: 'task_id' });
const threadStore = new JsonTaskStore({ dir: path.join(sessionDir, 'sales_group_threads'), idField: 'task_id' });
say(`  本次会话本地目录：${path.relative(repoRoot, sessionDir)}（server/data/ 下，gitignored）`);

const service = new LarkMvpService({
  client: realClient,
  store: salesStore,
  salesGroupThreadStore: threadStore,
});
const botOpenId = resolveBotOpenId();
say(`  机器人 open_id（判 @ 用，打码）：${mask(botOpenId)}   （来自 .env 的 LARK_BOT_OPEN_ID）`);
say(`  主群是否仍要求 @（mainChatRequireMention）：${service.mainChatRequireMention}`);

// ── 只读读表工具 ─────────────────────────────────────────────────────────────
const tableFields = (key) => gateway.table(key).fields;

const readFourFields = async (recordId) => {
  const record = await gateway.get('salesEntry', recordId);
  const fields = record?.fields || {};
  return {
    recordId,
    orderNo: textValue(fields[tableFields('salesEntry').orderNo]),
    originalText: textValue(fields[tableFields('salesEntry').originalText]),
    four: {
      确认状态: textValue(fields[SALES_STATUS_FIELDS.userAction]).trim(),
      销售状态: textValue(fields[SALES_STATUS_FIELDS.sales]).trim(),
      资金状态: textValue(fields[SALES_STATUS_FIELDS.funds]).trim(),
      库存状态: textValue(fields[SALES_STATUS_FIELDS.stock]).trim(),
    },
  };
};

const readSaleBundle = async (recordId) => {
  const four = await readFourFields(recordId);
  const detailKey = tableFields('salesDetail').salesEntry;
  const paymentKey = tableFields('paymentRecord').salesEntry;
  const details = (await gateway.listAll('salesDetail'))
    .filter((row) => linkedRecordIds(row.fields?.[detailKey]).includes(recordId));
  const receipts = (await gateway.listAll('paymentRecord'))
    .filter((row) => linkedRecordIds(row.fields?.[paymentKey]).includes(recordId));

  // 库存流水：靠「关联销售」指回**本次的销售明细**记录（与销售链路同一个连接关系）。
  const ledgerKey = tableFields('inventoryLedger').salesDetail;
  const detailIds = new Set(details.map((row) => row.record_id));
  const ledgers = (await gateway.listAll('inventoryLedger'))
    .filter((row) => linkedRecordIds(row.fields?.[ledgerKey]).some((id) => detailIds.has(id)));

  const behaviorById = new Map((await gateway.listAll('behavior'))
    .map((row) => [row.record_id, textValue(row.fields?.[tableFields('behavior').name])]));

  const movements = ledgers.map((row) => {
    const fields = row.fields || {};
    const behaviorIds = linkedRecordIds(fields[tableFields('inventoryLedger').behavior]);
    return {
      recordId: row.record_id,
      behavior: behaviorIds.map((id) => behaviorById.get(id) || id).join(',') || '(未写)',
      quantityChange: textValue(fields[tableFields('inventoryLedger').quantityChange]),
      stockKey: textValue(fields[tableFields('inventoryLedger').stockKey]),
      product: linkedRecordIds(fields[tableFields('inventoryLedger').product])[0] || '',
      operator: (fields[tableFields('inventoryLedger').operator] || []).length ? '有（人工）' : '（空=系统自动）',
    };
  });

  return { ...four, detailCount: details.length, receiptCount: receipts.length, movements };
};

// 实时库存：按「库存键」数一数现在有几双（用来展示"库存变化"的另一半）。
const liveInventoryCountByStockKey = async () => {
  const keyField = tableFields('liveInventory').stockKey;
  const rows = await gateway.listAll('liveInventory');
  const counts = new Map();
  for (const row of rows) {
    const key = textValue(row.fields?.[keyField]) || '(无库存键)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
};

// ── 只读体检 ─────────────────────────────────────────────────────────────────
head('只读体检（一个字都不写）');
const validation = await gateway.validateTables([
  'salesEntry', 'salesDetail', 'paymentRecord', 'behavior', 'liveInventory', 'inventoryLedger',
]);
for (const item of validation) say(`  OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`);
const liveBefore = await liveInventoryCountByStockKey();
say(`  实时库存：${liveBefore.size} 个库存键 · 共 ${[...liveBefore.values()].reduce((a, b) => a + b, 0)} 双`);

if (checkOnly) {
  head('只读体检结束');
  say('  ✅ 闸门通过、表结构可读、四个状态字段的名字在表里都存在。**没有写任何东西、没有连长连接。**');
  say('  要跑真链路：node scripts/ws-selftest.mjs --env-file <主工作区>/.env --seconds 600');
  process.exit(0);
}

// ── 事件形态转换：飞书事件 → `acceptMessage` 的输入 ──────────────────────────
/**
 * ⚠️ 这里**不是**"另写一套链路"，而是"拆信封 + 兜版本差异"：
 *   · webhook 路由（`src/routes/larkEvents.js` 第 43 行）拿到 v2 信封后，把里面的 `event`
 *     直接传给了 `acceptMessage`；长连接 SDK 分派给我们的**已经是那个 `event`**。
 *   · 所以两边的输入形态**本来就相同**，本函数只是：① 万一是整封信封就拆一层；
 *     ② 把 `content` 统一成字符串（飞书事件里它本来就是 JSON 字符串）。
 *   · **不重排、不改名、不补字段** —— 补了就不再是"生产同一条路"了。
 */
const toAcceptMessageInput = (raw) => {
  const event = (raw && typeof raw === 'object' && raw.message) ? raw : (raw?.event || raw);
  if (!event || typeof event !== 'object') return null;
  const message = event.message;
  if (!message || typeof message !== 'object') return null;
  if (message.content != null && typeof message.content !== 'string') {
    message.content = JSON.stringify(message.content);
  }
  return event;
};

const describeIncoming = (event) => {
  const message = event.message || {};
  const text = extractTextForDisplay(message);
  return {
    message_id: message.message_id || '',
    chat_id: message.chat_id || '',
    chat_type: message.chat_type || '',
    thread_id: String(message.thread_id || '').trim(),
    parent_id: message.parent_id || '',
    message_type: message.message_type || '',
    sender_open_id: event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || '',
    mention_count: Array.isArray(message.mentions) ? message.mentions.length : 0,
    bot_mentioned: isMentioned(message.mentions, botOpenId),
    text,
  };
};

// 只用于**显示**的正文（和 acceptMessage 内部用的是项目同一个函数，避免"我看到的不一样"）。
function extractTextForDisplay(message) {
  try {
    const { extractSalesMessageText } = require('../src/utils/larkMessageText');
    return extractSalesMessageText(message);
  } catch { return ''; }
}

// ── 规则：只有【测试群】的群消息才喂进链路 ───────────────────────────────────
const admitIncoming = (info) => {
  if (info.chat_type !== 'group') return { ok: false, reason: `非群聊（chat_type=${info.chat_type || '空'}）` };
  if (info.chat_id !== ALLOWED_CHAT_ID) return { ok: false, reason: `不是测试群（chat_id=${mask(info.chat_id)}）` };
  // 防空转：万一飞书把我们**自己发的**卡片/消息也推回来，绝不能当成"她说的销售原话"再处理一遍
  // （那会自己回自己、无限套娃）。
  if (botOpenId && info.sender_open_id && info.sender_open_id === botOpenId) {
    return { ok: false, reason: '机器人自己发的消息（防自回环）' };
  }
  return { ok: true };
};

// ── 等待"处理完"：项目日志 / 出站调用 / **串行队列** 三样都安静下来 ─────────────
// ⚠️ 只看"日志与出站调用安静"会**误判**：AI 解析那一段可能十几秒既不打日志也不发消息，
//    于是"处理完了"是假的（卡片还没发、表还没写）。所以再把项目自己的**发送串行队列**
//    （`LarkMvpService.senderQueues`：`enqueueForSender` 里在跑的任务 promise）当作"还在忙"的判据。
const settle = async () => {
  const deadline = Date.now() + settleMaxSeconds * 1000;
  let lastLog = projectLogs.length;
  let lastOut = outbound.length;
  let lastActivity = Date.now();
  const busy = () => (service?.senderQueues?.size || 0) > 0;
  for (;;) {
    if (Date.now() >= deadline) return false;
    await sleep(1000);
    if (projectLogs.length !== lastLog || outbound.length !== lastOut || busy()) {
      lastLog = projectLogs.length; lastOut = outbound.length; lastActivity = Date.now();
    } else if (Date.now() - lastActivity >= quietSeconds * 1000) {
      return true;
    }
  }
};

// ── 单条消息的处理 + 汇报 ────────────────────────────────────────────────────
const reports = [];
const saleEntryIds = new Set();

const processOne = async (item) => {
  const info = item.info;
  const logMark = projectLogs.length;
  const outMark = outbound.length;
  say('');
  line('━');
  say(`  📥 收到消息 #${reports.length + 1}   ${shanghai(new Date(item.at))}（上海时间）`);
  line('━');
  say(`     message_id   : ${info.message_id}`);
  say(`     chat_id      : ${info.chat_id}  ${info.chat_id === ALLOWED_CHAT_ID ? '（= 测试群 ✅）' : '（**不是测试群** ✗）'}`);
  say(`     chat_type    : ${info.chat_type}`);
  say(`     thread_id    : ${info.thread_id || '（空 → 主群消息）'}`);
  say(`     parent_id    : ${info.parent_id || '（空）'}`);
  say(`     message_type : ${info.message_type}`);
  say(`     mentions     : ${info.mention_count} 个（@了机器人？${info.bot_mentioned ? '是' : '否'}）`);
  say(`     发送人       : ${mask(info.sender_open_id)}（打码）`);
  say(`     正文（项目 extractSalesMessageText 取出来的）: ${JSON.stringify(info.text)}`);

  // ⭐ 生产那一个入口：与 `src/routes/larkEvents.js` 第 43 行**同一个调用**。
  let accepted = null;
  let thrown = null;
  try {
    accepted = await service.acceptMessage(item.event);
  } catch (error) {
    thrown = error?.message || String(error);
  }

  const isAccepted = accepted?.accepted === true;
  // 没被理（闸门挡掉）时不会有任何远端调用，等一下只是让日志落地。
  await settle();

  const newLogs = projectLogs.slice(logMark);
  const newOut = outbound.slice(outMark);

  say('');
  say('  🛣 走的链路');
  if (thrown) say(`     ❌ acceptMessage 抛错：${thrown}`);
  else say(`     acceptMessage 返回：${JSON.stringify(accepted)}`);
  const chainEvents = newLogs.filter((log) => /^(lark|sales|inventory|bitable|v1)\./.test(log.event));
  if (chainEvents.length) {
    say('     项目代码打出的链路日志（原样透传，这里摘要）：');
    for (const log of chainEvents.slice(0, 24)) {
      const meta = { ...log.meta };
      delete meta.ts; delete meta.level; delete meta.event;
      if (meta.sender_open_id) meta.sender_open_id = mask(meta.sender_open_id);
      if (meta.operator_open_id) meta.operator_open_id = mask(meta.operator_open_id);
      say(`       · ${log.event} ${JSON.stringify(meta).slice(0, 300)}`);
    }
    if (chainEvents.length > 24) say(`       · …（还有 ${chainEvents.length - 24} 条）`);
  } else {
    say('     （本次没有任何业务链路日志 → 消息被闸门静默挡掉，零远端调用）');
  }

  // ── 回复发到哪（reply_in_thread 是"是不是话题形式"的硬证据）─────────────────
  say('');
  say('  📤 回复发到哪（真实 this.client 的出站 payload + 飞书回带的响应）');
  if (!newOut.length) {
    say('     （本次没有任何出站 IM 调用）');
  } else {
    newOut.forEach((call, index) => {
      const threadFlag = call.reply_in_thread === true
        ? 'reply_in_thread=true ✅（话题形式）'
        : '未带 reply_in_thread（主群/私聊形态）';
      const resp = call.response
        ? `code=${call.response.code} message_id=${call.response.message_id || '-'} 飞书回带 thread_id=${call.response.thread_id || '(-)'}`
        : (call.error ? `❌ ${call.error}` : '（无响应）');
      say(`     #${index + 1} ${call.kind} msg_type=${call.msg_type} → ${call.to}`);
      say(`        ${threadFlag}`);
      say(`        响应：${resp}`);
    });
    const replyCalls = newOut.filter((call) => call.kind === 'im.message.reply');
    const threaded = replyCalls.filter((call) => call.reply_in_thread === true);
    if (threaded.length) {
      const threadIds = [...new Set(threaded.map((call) => call.response?.thread_id).filter(Boolean))];
      say(`     ⭐ 结论：${threaded.length}/${replyCalls.length} 条**回复**走了 reply_in_thread，落在话题 ${threadIds.join(', ') || '(飞书未回带 thread_id)'}`);
    } else if (replyCalls.length) {
      say(`     ⭐ 结论：${replyCalls.length} 条回复**都没有带** reply_in_thread（= 主群 / 私聊形态）`);
    } else {
      say('     ⭐ 结论：本次没有"回复"，只有其它出站调用（见上）。');
    }
  }

  // ── 本次会话的本地映射（项目代码自己写的：话题 ↔ 销售）────────────────────
  const tasks = await salesStore.list();
  const task = tasks.find((row) => row.message_id === info.message_id);
  if (task) {
    say('');
    say('  🧭 本地任务（项目代码写的路由状态，不写业务表）');
    say(`     task_id=${task.task_id} type=${task.type} status=${task.status} channel=${task.chat_type || 'p2p'}`);
    say(`     sales_entry_record_id=${task.sales_entry_record_id || '(还没建)'} card_message_id=${task.card_message_id || '(无)'}`);
    say(`     group_thread_id=${task.group_thread_id || '(空)'}`);
    if (task.sales_entry_record_id) saleEntryIds.add(task.sales_entry_record_id);
  }

  // ── 四个字段 + 明细/收款 + 库存变化 ────────────────────────────────────────
  const bundles = [];
  if (task?.sales_entry_record_id) {
    bundles.push(await readSaleBundle(task.sales_entry_record_id));
  }
  for (const bundle of bundles) {
    say('');
    say('  🧾 销售主表 · 四个状态字段（回读真表）');
    say(`     record_id : ${bundle.recordId}    销售单号 : ${bundle.orderNo || '(空)'}`);
    say(`     原话      : ${JSON.stringify(bundle.originalText)}`);
    say(`     确认状态  : '${bundle.four.确认状态}'`);
    say(`     销售状态  : '${bundle.four.销售状态}'`);
    say(`     资金状态  : '${bundle.four.资金状态}'`);
    say(`     库存状态  : '${bundle.four.库存状态}'`);
    say(`  📦 明细 ${bundle.detailCount} 条 · 收款 ${bundle.receiptCount} 条`);
    say('  📉 库存变化');
    if (!bundle.movements.length) {
      say('     库存流水 0 条（还没确认 / 或这笔不扣库存）');
    } else {
      const counts = await liveInventoryCountByStockKey();
      for (const movement of bundle.movements) {
        const before = liveBefore.get(movement.stockKey);
        const after = counts.get(movement.stockKey);
        const delta = (before == null || after == null) ? '（库存键未对上，无法比对）' : `${before} → ${after} 双`;
        say(`     · ${movement.behavior} 变动 ${movement.quantityChange} · 库存键 ${movement.stockKey || '(空)'} · 实时库存 ${delta} · 操作人 ${movement.operator}`);
      }
    }
  }
  if (!bundles.length) {
    say('');
    say('  🧾 销售主表 · 四个状态字段：本次没有建出销售单（消息没归销售 / 是采购或反问）');
  }

  reports.push({
    at: item.at, info, accepted, thrown, outbound: newOut,
    chainEvents: chainEvents.map((log) => log.event), task: task || null, bundles,
  });
  return isAccepted;
};

// ── 长连接：收事件 ───────────────────────────────────────────────────────────
const queue = [];
let receivedCount = 0;
let ignoredCount = 0;

const onMessageEvent = (raw) => {
  receivedCount += 1;
  const event = toAcceptMessageInput(raw);
  if (!event) {
    ignoredCount += 1;
    say(`  ⚠️ 收到一个读不出 message 的事件，已忽略：${JSON.stringify(raw).slice(0, 300)}`);
    return {};
  }
  const info = describeIncoming(event);
  const admission = admitIncoming(info);
  if (!admission.ok) {
    ignoredCount += 1;
    say('');
    say(`  🚫 收到【不该处理】的消息：${admission.reason} —— **不喂进链路**（零远端调用，绝不发到别的群/私聊）`);
    say(`     message_id=${info.message_id} chat_type=${info.chat_type} chat_id=${mask(info.chat_id)}`);
    return {};
  }
  queue.push({ at: new Date().toISOString(), event, info });
  say(`  📨 收到测试群消息（已入队）：${info.message_id} thread_id=${info.thread_id || '(主群)'} 正文=${JSON.stringify(info.text).slice(0, 120)}`);
  return {};
};

// 卡片动作：她在群里点「确认 / 取消」那一下，走的也是长连接 —— 与生产路由
// （`src/routes/larkEvents.js` 第 76 行）同一个入口 `service.handleCardAction`。
const onCardAction = (raw) => {
  const event = (raw && typeof raw === 'object' && raw.action) ? raw : (raw?.event || raw);
  const value = event?.action?.value || {};
  const openId = event?.operator?.operator_id?.open_id || event?.operator?.open_id || '';
  say('');
  say(`  🖱️ 收到卡片动作：action=${value.action} draft_id=${value.draft_id || '-'} 操作人=${mask(openId)}`);
  queue.push({ at: new Date().toISOString(), card: true, event, info: null });
  return { toast: { type: 'info', content: '已收到，正在处理' } };
};

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': onMessageEvent,
  'card.action.trigger': onCardAction,
});

const wsClient = new lark.WSClient({
  appId: testAppId,
  appSecret: testAppSecret,
  loggerLevel: 'warn',
  autoReconnect: true,
  handshakeTimeoutMs: 15_000,
  onReady: () => say(`  ✅ 长连接已建立（${shanghai()} 上海时间）`),
  onError: (error) => say(`  ❌ 长连接失败：${error?.message}`),
  onReconnecting: () => say('  ↻ 正在重连…'),
  onReconnected: () => say('  ✅ 重连成功'),
});

head('连接长连接（测试应用）');
say(`  长连接应用 = 回复应用 = ${testAppId}（同一个测试应用 ⇒ 回复用的就是真实 this.client，不是替身）`);
let connected = false;
try {
  await wsClient.start({ eventDispatcher: dispatcher });
  connected = true;
} catch (error) {
  say(`  ❌ start() 抛错：${error?.message}`);
}
if (!connected && wsClient.getConnectionStatus?.()?.state === 'connected') connected = true;
if (!connected) {
  say('  🔴 长连接没能建立 —— 不进入处理循环（不会处理任何消息）。');
  process.exit(2);
}

say('');
say('  ⭐ 现在开始等【测试群】的真实消息。请对方在测试群里发一句话（例如销售原话）。');
say(`  ⭐ 脚本会跑 ${seconds}s，最后打印总汇报。`);
if (autoConfirm) {
  say('  ⚠️ --auto-confirm 已开启：脚本会在草稿就绪后代按「确认」（走生产 handleCardAction，同一条路）。');
  say('     默认推荐做法是**你本人在群里点卡片上的按钮**（那个点击也会从这个长连接进来）。');
}

// ── 处理循环 ─────────────────────────────────────────────────────────────────
let running = true;
const stop = (signal) => { say(`\n  ⏹ 收到 ${signal}，准备收尾…`); running = false; };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;
let lastHeartbeat = Date.now();

const autoConfirmAttempted = new Set();
const autoConfirmPending = async () => {
  if (!autoConfirm) return;
  const tasks = await salesStore.list({ status: 'ready_to_confirm' });
  for (const task of tasks) {
    if (!task.sender_open_id) continue;
    // 同一张草稿只代按一次：失败也不重试（重试会变成刷屏 + 重复写表）。
    if (autoConfirmAttempted.has(task.task_id)) continue;
    autoConfirmAttempted.add(task.task_id);
    say(`  🖱️ --auto-confirm：代按「确认」 draft_id=${task.task_id}（走 handleCardAction）`);
    try {
      const result = await service.handleCardAction({
        action: { value: { draft_id: task.task_id, action: 'confirm_sale' } },
        operator: { operator_id: { open_id: task.sender_open_id } },
        context: { open_message_id: task.card_message_id || '' },
      });
      say(`     结果：${JSON.stringify(result)}`);
    } catch (error) {
      say(`     ❌ 代按失败：${error?.message}`);
    }
    await settle();
  }
};

while (running && Date.now() < deadline) {
  if (queue.length) {
    const item = queue.shift();
    if (item.card) {
      // 卡片动作：与生产路由同一个入口。
      try {
        const result = await service.handleCardAction(item.event, { interactionId: `ws-selftest-${Date.now()}` });
        say(`     handleCardAction → ${JSON.stringify(result)}`);
      } catch (error) {
        say(`     ❌ handleCardAction 抛错：${error?.message}`);
      }
      await settle();
    } else {
      await processOne(item);
      await autoConfirmPending();
    }
    continue;
  }
  if (autoConfirm) await autoConfirmPending();
  if (Date.now() - lastHeartbeat >= 30_000) {
    lastHeartbeat = Date.now();
    const rest = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    say(`  …等待中 ${shanghai()}：收到 ${receivedCount} 条（处理 ${reports.length} / 忽略 ${ignoredCount}）· 剩余 ${rest}s`);
  }
  await sleep(1000);
}

try { wsClient.close({ force: true }); } catch { /* 断开异常不影响结论 */ }

// ── 总汇报 ───────────────────────────────────────────────────────────────────
head('总汇报');
say(`  时间：${shanghai(new Date(startedAt))} → ${shanghai()}（上海时间）· 实际跑 ${Math.round((Date.now() - startedAt) / 1000)}s`);
say(`  收到消息 ${receivedCount} 条：喂进链路 ${reports.length} 条 · 忽略 ${ignoredCount} 条（非测试群 / 读不出）`);
say(`  出站 IM 调用合计 ${outbound.length} 次（全部真的发到了飞书）`);

if (!reports.length) {
  say('');
  say('  ⚠️ 这段时间【测试群没有任何消息进来】—— 所以四个字段没有被写。');
  say('     ⇒ 对方需要在测试群里发一句话（例如「卖一双 8088黑 38 码 200 微信」），');
  say('       并在弹出的卡片上点「确认」，脚本才会读到四个字段。');
}

for (const report of reports) {
  const info = report.info;
  say('');
  line();
  say(`  📥 #${reports.indexOf(report) + 1} ${shanghai(new Date(report.at))} · ${info.message_id}`);
  say(`     正文：${JSON.stringify(info.text)}`);
  say(`     thread_id=${info.thread_id || '(主群)'} · 链路=${JSON.stringify(report.accepted)}`);
  if (report.thrown) say(`     ❌ 抛错：${report.thrown}`);
  const imLines = report.outbound.map((call) => `${call.kind}[${call.msg_type}]${call.reply_in_thread === true ? ' reply_in_thread=true' : ' 无reply_in_thread'}→thread_id=${call.response?.thread_id || '-'}`);
  say(`     回复：${imLines.length ? imLines.join(' | ') : '（无出站调用）'}`);
  for (const bundle of report.bundles) {
    say(`     🧾 ${bundle.orderNo || bundle.recordId}：确认状态='${bundle.four.确认状态}' 销售状态='${bundle.four.销售状态}' 资金状态='${bundle.four.资金状态}' 库存状态='${bundle.four.库存状态}'`);
    say(`        明细 ${bundle.detailCount} 条 · 收款 ${bundle.receiptCount} 条 · 库存流水 ${bundle.movements.length} 条`);
  }
}

// 收尾再扫一遍任务：万一某条消息的 AI 解析在"安静窗口"之后才建出销售单，
// 这里也能把它捞回来（否则四个字段会漏报）。
for (const row of await salesStore.list()) {
  if (row.sales_entry_record_id) saleEntryIds.add(row.sales_entry_record_id);
}

if (saleEntryIds.size) {
  head('四个状态字段 · 最终回读（按销售单）');
  for (const recordId of saleEntryIds) {
    const bundle = await readSaleBundle(recordId);
    say(`  ${bundle.orderNo || '(无单号)'}  record_id=${recordId}`);
    say(`    确认状态='${bundle.four.确认状态}'  销售状态='${bundle.four.销售状态}'  资金状态='${bundle.four.资金状态}'  库存状态='${bundle.four.库存状态}'`);
    say(`    原话：${JSON.stringify(bundle.originalText)}`);
    say(`    明细 ${bundle.detailCount} 条 · 收款 ${bundle.receiptCount} 条 · 库存流水 ${bundle.movements.length} 条`);
    for (const movement of bundle.movements) {
      say(`      · ${movement.behavior} 变动 ${movement.quantityChange} · 库存键 ${movement.stockKey || '(空)'} · 操作人 ${movement.operator}`);
    }
  }
}

const threadMappings = await threadStore.list();
if (threadMappings.length) {
  head('话题 ↔ 销售 的本地映射（项目代码 SalesGroupThreadLocator 写的）');
  for (const mapping of threadMappings) {
    say(`  thread_id=${mapping.thread_id || '(空)'}  parent/message_id=${mapping.message_id || ''}  →  销售 ${mapping.sales_entry_record_id || ''}`);
  }
}

head('结束');
say(`  本次会话本地目录（可自行删除）：${sessionDir}`);
say('  ⚠️ 本次只写了测试 Base；生产 Base 只读、一个字都没写。');
process.exit(0);
