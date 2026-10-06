#!/usr/bin/env node
/**
 * e2e-sales-status.mjs —— 在**测试 Base** 上把销售链路整条跑一遍，
 * 验证四个状态维度（确认状态 / 销售状态 / 资金状态 / 库存状态）**真的被写对了**。
 *
 * 为什么要有它：
 *   `salesStatusDimensions` 那一层是"配置 + 写点"，单测只能证明"逻辑对"；
 *   真正要证明的是**打真表时四个字段有没有值、值对不对**。这个脚本就是那份证据。
 *
 * 走的是**项目代码**（不是手拼 SDK、**不用飞书 CLI**）：
 *   · `--kind spot`（默认）—— 建单 + 手动草稿 + 点「确认」：
 *       `LarkMvpService.createSalesEntryWithOrderNo` → `handleCardAction({confirm_sale})`
 *   · `--kind two-detail|two-payment|prepaid|unpaid|return|exchange` —— **完整生产入口**：
 *       `LarkMvpService.acceptMessage(群消息事件)` → AI 解析 → 确认卡片 → `handleCardAction`
 *       →（预付 / 未付）**在话题里再发一句话** → 回读。
 *       走群话题入口是**必须**的：`SalesThreadProgressService.handle` 的第一道判据就是
 *       `task.chat_type === 'group'` ＋ `task.sales_entry_record_id`（见该 service 注释），
 *       私聊任务这两个字段都没有 → 二次处理一次都不会执行。
 *
 * 用法：
 *   node scripts/e2e-sales-status.mjs --env-file <主工作区>/.env                   # 只读体检
 *   node scripts/e2e-sales-status.mjs --env-file ... --apply                     # 现货一笔（老路径）
 *   node scripts/e2e-sales-status.mjs --env-file ... --apply --kind two-payment
 *   node scripts/e2e-sales-status.mjs --env-file ... --apply --kind all           # 六个场景全跑
 *
 * 🔴 硬闸门（写死在脚本里）：
 *   · 目标 Base 必须 = `FEISHU_V1_E2E_TEST_APP_TOKEN`，且 `FEISHU_TARGET_ENV=test`；
 *     否则**拒绝运行**（本脚本会真写表，只能写测试 Base）。
 *   · 默认**只做只读体检**（列数据源），加 `--apply` 才写。
 *   · 不打印任何 token / secret；IM 全走**本地替身**（不发真实消息、不发卡片），
 *     替身把**出站 payload 原样记下来** —— 「回复是不是话题形式」的证据就是它。
 *
 * 环境变量加载顺序（后者覆盖前者）：<repo>/.env → --env-file → <repo>/.env.local
 * ⚠️ 必须在 require 业务模块**之前**加载：`v1BitableSchema` 是 require 时求值 tableId 的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── 日志：拦住项目代码的结构化日志（它们是"项目代码跑过了"的证据）──────────────
// ⚠️ 必须在 require 业务模块之前接管：logger 在调用时读 console。
const capturedLogs = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(args[0]);
        if (parsed && parsed.event) {
          capturedLogs.push(parsed);
          if (flags['show-logs']) originalConsole[level](args[0]);
          return;
        }
      } catch (_error) { /* 不是结构化日志，原样输出 */ }
    }
    originalConsole[level](...args);
  };
}
const eventsSince = (from, names) =>
  capturedLogs.slice(from).filter((entry) => names.includes(entry.event)).map((entry) => entry.event);

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
const fsSync = fs;
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, textValue, linkedRecordIds } = require('../src/services/v1BitableGateway');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService, idFor } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const {
  SALES_STATUS_FIELDS, POSTED_VALUES, isPosted,
  userActionOf, salesStatusOf, postedOf, stockStatusOf,
} = require('../src/config/salesStatusDimensions');
const { AFTER_SALES_CARD_ACTIONS, AFTER_SALES_TASK_STATUS } = require('../src/config/afterSalesFlow');
const { PROGRESS_TASK_STATUS } = require('../src/config/salesProgressIntake');

// ── 硬闸门 ───────────────────────────────────────────────────────────────────
const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
const isAuthorizedTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';
const apply = flags.apply === true;
const kind = String(flags.kind || 'spot').trim();
const WAIT_MS = Number(flags['wait-ms'] || 240_000);
// 话题里那句话：**要么很快被受理，要么会被静默丢掉**（见 runDeferred 的注释），
// 所以这一段不必等满 4 分钟——等不到就如实记「没有任何效果」。
const WORD_WAIT_MS = Number(flags['word-wait-ms'] || 90_000);
const KNOWN_KINDS = ['spot', 'two-detail', 'two-payment', 'prepaid', 'unpaid', 'return', 'exchange', 'all'];

const fingerprint = (value) => {
  const raw = String(value || '');
  return raw ? `${raw.slice(0, 6)}…(len=${raw.length})` : '<empty>';
};

head('销售四维状态 · 测试 Base 端到端');
say('  环境文件：');
for (const source of envSources) say(`    · ${source}`);
say(`  目标 Base 是否 = 授权测试 Base：${isAuthorizedTestBase ? '是' : '**不是**'}（${fingerprint(targetAppToken)}）`);
say(`  FEISHU_TARGET_ENV：${targetEnv || '（未设置）'}`);
say(`  模式：${apply ? '真写（--apply）' : '只读体检（未加 --apply）'}`);
say(`  场景（--kind）：${kind}`);
say('  飞书外发：全部拦住（记录型 IM 替身；出站 payload 留作证据）');

if (!KNOWN_KINDS.includes(kind)) {
  say(`\n🔴 未知 --kind：${kind}（可用：${KNOWN_KINDS.join(' / ')}）`);
  process.exit(2);
}
if (!isAuthorizedTestBase) {
  say('');
  say('🔴 拒绝运行：目标 Base 不是授权的测试 Base（或 FEISHU_TARGET_ENV ≠ test）。');
  say('   本脚本会**真写销售主表/明细/收款/库存**，只允许在测试 Base 上跑。');
  process.exit(2);
}

// ── 客户端：bitable 走真的；IM 全走本地替身（不外发，但**记下出站 payload**）────
const { appId, appSecret } = getLarkAgentCredentials();
const realClient = new lark.Client({ appId, appSecret });

const makeImSim = () => {
  const outbound = [];   // 「话题形式回复」的唯一证据来源
  const reactions = [];
  const threadsByParent = new Map();
  let seq = 0;
  const nextId = (prefix) => `${prefix}_${++seq}`;
  const reply = async ({ path: p, data } = {}) => {
    const parent = String(p?.message_id || '');
    let threadId = '';
    if (data?.reply_in_thread === true) {
      if (!threadsByParent.has(parent)) threadsByParent.set(parent, `omt_sim_${threadsByParent.size + 1}`);
      threadId = threadsByParent.get(parent);
    }
    const messageId = nextId('om_reply');
    outbound.push({
      api: 'im.message.reply', parent_message_id: parent, message_id: messageId,
      msg_type: data?.msg_type || '', reply_in_thread: data?.reply_in_thread === true,
      thread_id: threadId, content: data?.content || '',
    });
    return { code: 0, msg: 'ok', data: { message_id: messageId, ...(threadId ? { thread_id: threadId } : {}) } };
  };
  const create = async ({ data } = {}) => {
    const messageId = nextId('om_create');
    outbound.push({
      api: 'im.message.create', message_id: messageId, receive_id: data?.receive_id || '',
      msg_type: data?.msg_type || '', reply_in_thread: false, thread_id: '', content: data?.content || '',
    });
    return { code: 0, msg: 'ok', data: { message_id: messageId } };
  };
  const patch = async ({ path: p, data } = {}) => {
    outbound.push({ api: 'im.message.patch', message_id: p?.message_id || '', content: data?.content || '' });
    return { code: 0, msg: 'ok', data: {} };
  };
  const im = {
    message: { reply, create, patch },
    messageReaction: {
      create: async ({ path: p, data } = {}) => {
        reactions.push({ message_id: p?.message_id || '', emoji_type: data?.reaction_type?.emoji_type || '' });
        return { code: 0, msg: 'ok', data: {} };
      },
    },
    v1: { message: { patch } },
  };
  return { im, outbound, reactions, threadsByParent };
};

const makeClient = (sim) => new Proxy(realClient, {
  get(target, prop) {
    if (prop === 'im') return sim.im;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const gateway = new V1BitableGateway({ client: realClient });

// ── 只读体检：表结构 + 挑数据 ────────────────────────────────────────────────
head('只读体检（一个字都没写）');
const validation = await gateway.validateTables([
  'salesEntry', 'salesDetail', 'paymentRecord', 'product', 'sizeManagement', 'behavior',
  'liveInventory', 'inventoryLedger', 'paymentMethod',
]);
for (const item of validation) say(`  OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`);

// 「库存行为」是个关联字段：流水里的「变动数量」**永远是正数**，方向由行为的「库存方向」决定。
// （读的是真表：销售出库 = 行为「销售减少」· 数量 1；退货回库 = 行为「销售退货」· 数量 1。）
const behaviorFields = gateway.table('behavior').fields;
const behaviorRows = await gateway.listAll('behavior');
const behaviorDirectionByName = new Map(behaviorRows.map((row) => [
  textValue(row.fields?.[behaviorFields.name]),
  textValue(row.fields?.[behaviorFields.stockDirection]),
]));

const sizeRecords = await gateway.listAll('sizeManagement');
const sizeByNumber = new Map(sizeRecords.map((row) => [Number(textValue(row.fields['尺码'])), row.record_id]));
const liveInventory = await gateway.listAll('liveInventory');
const doorBoxRows = liveInventory.filter((row) => textValue(row.fields['所属状态']) === '门盒');

// 「录单人」是真表上的**用户字段**：必须用一个真的 open_id，编一个会让飞书回
// UserFieldConvFail（1254066）。默认从已有记录里取一个，也允许 --sender 指定。
const existingEntries = await gateway.listAll('salesEntry');
const someEntry = existingEntries.find((row) => row.fields['录单人']);
const senderOpenId = String(flags.sender
  || someEntry?.fields?.['录单人']?.[0]?.id
  || '').trim();
if (!senderOpenId) throw new Error('测试 Base 里找不到可用的录单人 open_id，请用 --sender 指定');
say(`  录单人：取自${flags.sender ? ' --sender' : '测试 Base 已有记录'}（指纹 ${fingerprint(senderOpenId)}，不打印其值）`);

// 数据源：把 (货品, 尺码) 组合起来，按「门盒有货 + 有单价」挑。
const products = await gateway.listAll('product');
const productFields = gateway.table('product').fields;
const productById = new Map(products.map((row) => [row.record_id, row]));
const sizeIdToNumber = new Map([...sizeByNumber.entries()].map(([number, id]) => [id, number]));
const candidateMap = new Map();
for (const row of doorBoxRows) {
  const productRecordId = linkedRecordIds(row.fields['编号'])[0];
  const sizeRecordId = linkedRecordIds(row.fields['尺码'])[0];
  if (!productRecordId || !sizeRecordId) continue;
  const key = `${productRecordId}|${sizeRecordId}`;
  if (!candidateMap.has(key)) {
    const product = productById.get(productRecordId);
    candidateMap.set(key, {
      key, productRecordId, sizeRecordId,
      itemNo: textValue(product?.fields?.[productFields.itemNo]),
      color: textValue(product?.fields?.[productFields.color]),
      price: Number(textValue(product?.fields?.[productFields.price])) || 0,
      size: Number(sizeIdToNumber.get(sizeRecordId)),
      doorBox: 0,
    });
  }
  candidateMap.get(key).doorBox += 1;
}
const pool = [...candidateMap.values()]
  .filter((item) => item.doorBox >= 1 && item.itemNo && item.size && item.price > 0);
// ⚠️ 优先挑「这个货号 + 这个尺码在门盒里**只有一种颜色**」的组合：
//    多个颜色时卡片会要求她**再点一次颜色**才肯确认（见 startSale 里的说明）——
//    那是真实行为，但会让每个场景都多一步、也更难看清本场景要验的东西。
const colorsByItemNoSize = new Map();
for (const item of pool) {
  const key = `${item.itemNo}|${item.size}`;
  if (!colorsByItemNoSize.has(key)) colorsByItemNoSize.set(key, new Set());
  colorsByItemNoSize.get(key).add(item.color);
}
const colorVariantsOf = (item) => (colorsByItemNoSize.get(`${item.itemNo}|${item.size}`) || new Set()).size;
pool.sort((left, right) => (colorVariantsOf(left) - colorVariantsOf(right))
  || left.itemNo.localeCompare(right.itemNo) || (left.size - right.size));
say(`  实时库存候选（门盒 >= 1 且有单价）：${pool.length} 个 (货品, 尺码) 组合`
  + `（其中单色组合 ${pool.filter((item) => colorVariantsOf(item) === 1).length} 个）`);

const wantedProduct = String(flags.product || '').trim();
const wantedSize = Number(flags.size || 42);
const candidate = doorBoxRows.find((row) => {
  if (wantedProduct && linkedRecordIds(row.fields['编号'])[0] !== wantedProduct) return false;
  return sizeByNumber.get(wantedSize) === linkedRecordIds(row.fields['尺码'])[0];
});
const productRecordIdForSpot = candidate
  ? linkedRecordIds(candidate.fields['编号'])[0]
  : (pool[0]?.productRecordId || '');
const productRowForSpot = productRecordIdForSpot ? await gateway.get('product', productRecordIdForSpot) : null;
const itemNoForSpot = productRowForSpot
  ? textValue(productRowForSpot.fields[gateway.table('product').fields.itemNo]) : '';

say(`  现货路径数据源：货品 ${productRecordIdForSpot || '（无）'}（货号 ${itemNoForSpot || '—'}）· 尺码 ${wantedSize}`);
say('  表结构校验通过。');

if (!apply) {
  say('');
  say('  本次将新建的（测试 Base）：1 条销售主表 + N 条明细 + M 条收款 + K 条库存流水。');
  say('  ✅ 只读体检结束：**没有写任何东西**。要跑完整链路请加 --apply。');
  say(`  可用的 --kind：${KNOWN_KINDS.join(' / ')}`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// 真跑
// ══════════════════════════════════════════════════════════════════════════════
const storeDir = fsSync.mkdtempSync(path.join(serverRoot, 'data', 'selftest-e2e-'));

const readEntry = async (salesEntryRecordId) => {
  const entry = await gateway.get('salesEntry', salesEntryRecordId);
  return {
    record_id: salesEntryRecordId,
    order_no: textValue(entry?.fields?.[gateway.table('salesEntry').fields.orderNo]),
    trade_type: textValue(entry?.fields?.[gateway.table('salesEntry').fields.tradeType]),
    dims: {
      确认状态: userActionOf(entry, gateway.table('salesEntry').fields),
      销售状态: salesStatusOf(entry, gateway.table('salesEntry').fields),
      资金状态: postedOf(entry, gateway.table('salesEntry').fields),
      库存状态: stockStatusOf(entry, gateway.table('salesEntry').fields),
    },
  };
};
const readDetailsOf = async (salesEntryRecordId) => {
  const fields = gateway.table('salesDetail').fields;
  return (await gateway.listAll('salesDetail'))
    .filter((record) => linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId))
    .map((record) => ({
      record_id: record.record_id,
      履约状态: textValue(record.fields?.[fields.fulfillmentStatus]),
      成交金额: textValue(record.fields?.[fields.actualAmount]),
      交易类型: textValue(record.fields?.[fields.tradeType]),
    }));
};
const readPaymentsOf = async (salesEntryRecordId) => {
  const fields = gateway.table('paymentRecord').fields;
  return (await gateway.listAll('paymentRecord'))
    .filter((record) => linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId))
    .map((record) => ({
      record_id: record.record_id,
      收款状态: textValue(record.fields?.[fields.status]),
      收款金额: textValue(record.fields?.[fields.amount]),
      交易方式: textValue(record.fields?.[fields.method]),
      交易方向: textValue(record.fields?.[fields.tradeDirection]),
      收款时间: textValue(record.fields?.[fields.receivedAt]),
    }));
};
const readLedgerForDetails = async (detailRecordIds) => {
  const fields = gateway.table('inventoryLedger').fields;
  const wanted = new Set(detailRecordIds);
  return (await gateway.listAll('inventoryLedger'))
    .filter((record) => linkedRecordIds(record.fields?.[fields.salesDetail]).some((id) => wanted.has(id)))
    .map((record) => {
      const behavior = textValue(record.fields?.[fields.behavior]);
      return {
        库存行为: behavior,
        变动数量: textValue(record.fields?.[fields.quantityChange]),
        方向: behaviorDirectionByName.get(behavior) || '（行为表里没有这条行为）',
        库存键: textValue(record.fields?.[fields.stockKey]),
      };
    });
};
/** 流水只比「行为 + 数量」（方向由行为决定，已在上面展开成人看的列）。 */
const ledgerPairs = (ledger) => ledger
  .map((row) => ({ 库存行为: row.库存行为, 变动数量: row.变动数量 }))
  .sort((a, b) => `${a.库存行为}${a.变动数量}`.localeCompare(`${b.库存行为}${b.变动数量}`));

// ⚠️ 售后的流水**不一定挂在原明细、也不一定挂在新主表明细上**（退货那条是"退回的鞋回库"，
//    关联字段可能为空）。所以售后这一段**不按关联筛**，改用"整表前后差集" —— 这条口径
//    与"是哪条明细"无关，只要这一次售后真写了流水就一定看得见（2026-10-06 踩过：
//    按关联筛，退货明明写了流水、脚本却报 0 条）。
const snapshotLedgerIds = async () =>
  new Set((await gateway.listAll('inventoryLedger')).map((row) => row.record_id));
const readNewLedgerSince = async (beforeIds, keyPrefixes = []) => {
  const fields = gateway.table('inventoryLedger').fields;
  const rows = await gateway.listAll('inventoryLedger');
  return rows.filter((row) => !beforeIds.has(row.record_id)).map((record) => {
    const behavior = textValue(record.fields?.[fields.behavior]);
    return {
      库存行为: behavior,
      变动数量: textValue(record.fields?.[fields.quantityChange]),
      方向: behaviorDirectionByName.get(behavior) || '（行为表里没有这条行为）',
      库存键: textValue(record.fields?.[fields.stockKey]),
    };
  // ⚠️ 再按**库存键前缀**（货号|颜色）收一次：同一台机器上可能同时有别的自测在写流水，
  //    光靠"整表差集"会把别人的流水算进来（2026-10-06 就这么数出过 3 条）。
  }).filter((row) => !keyPrefixes.length || keyPrefixes.some((prefix) => row.库存键.startsWith(prefix)));
};
const liveSnapshot = async () => {
  const fields = gateway.table('liveInventory').fields;
  return (await gateway.listAll('liveInventory')).map((record) => ({
    productRecordId: linkedRecordIds(record.fields?.[fields.product])[0] || '',
    sizeRecordId: linkedRecordIds(record.fields?.[fields.size])[0] || '',
    state: textValue(record.fields?.[fields.state]),
  }));
};
const doorBoxOf = (snapshot, pick) => snapshot
  .filter((row) => row.productRecordId === pick.productRecordId && row.sizeRecordId === pick.sizeRecordId
    && row.state === '门盒')
  .length;

const CHAT_ID = 'oc_e2e_sales_status_test';

// ── 场景账本 ────────────────────────────────────────────────────────────────
const scenarios = [];
const makeScenario = (key, name, expectation) => ({
  key, name, expectation, checks: [], data: {}, notes: [], error: '',
});
const normalize = (value) => {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'number') return `#${value}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k])]));
  return value;
};
const check = (scenario, label, expected, actual, passOverride) => {
  const pass = passOverride === undefined
    ? JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual))
    : Boolean(passOverride);
  scenario.checks.push({ label, expected, actual, pass });
  return pass;
};

// ══════════════════════════════════════════════════════════════════════════════
// 路径 A：现货 · 一单一笔交易（老路径，行为保持逐字不变）
// ══════════════════════════════════════════════════════════════════════════════
const runSpotLegacy = async () => {
  head('跑链路（走项目代码：建单 → 点「确认」→ 交付）');
  const sim = makeImSim();
  const store = new JsonTaskStore({ dir: storeDir, idField: 'task_id' });
  const service = new LarkMvpService({ client: makeClient(sim), gateway, store });

  const created = await service.createSalesEntryWithOrderNo({
    task_id: 'selftest-sale',
    original_text: `卖一双 ${itemNoForSpot} ${wantedSize} 码，100 元微信`,
    sender_open_id: senderOpenId,
  });
  const salesEntryRecordId = created?.recordId;
  if (!salesEntryRecordId) throw new Error('建单没有返回 record_id');
  say(`  ① 建单完成：销售主表 ${salesEntryRecordId}`);

  const afterCreate = await gateway.get('salesEntry', salesEntryRecordId);
  const readBack = (record) => ({
    userAction: textValue(record.fields?.[SALES_STATUS_FIELDS.userAction]).trim(),
    sales: textValue(record.fields?.[SALES_STATUS_FIELDS.sales]).trim(),
    funds: textValue(record.fields?.[SALES_STATUS_FIELDS.funds]).trim(),
    stock: textValue(record.fields?.[SALES_STATUS_FIELDS.stock]).trim(),
  });
  say(`     建单后：${JSON.stringify(readBack(afterCreate))}`);

  const draftId = 'selftest-draft-1';
  await store.create({
    task_id: draftId,
    type: 'sale',
    status: 'ready_to_confirm',
    sender_open_id: senderOpenId,
    sales_entry_record_id: salesEntryRecordId,
    draft: {
      delivery_status: '已交付',
      payment_method: '微信',
      total_paid: 100,
      payments: [{ amount: 100, method: '微信', status: '已收款' }],
      items: [{
        kind: 'shoe',
        product_record_id: productRecordIdForSpot,
        item_no: itemNoForSpot,
        color: '',
        size: wantedSize,
        quantity: 1,
        actual_amount: 100,
      }],
    },
  });

  const liveBefore = await liveSnapshot();
  const actionResult = await service.handleCardAction({
    action: { value: { draft_id: draftId, action: 'confirm_sale' } },
    operator: { operator_id: { open_id: senderOpenId } },
    context: { open_message_id: 'om_selftest' },
  });
  say(`  ② 点了「确认」：${JSON.stringify(actionResult)}`);

  const finalRecord = await gateway.get('salesEntry', salesEntryRecordId);
  const values = readBack(finalRecord);
  const orderNo = textValue(finalRecord.fields?.[gateway.table('salesEntry').fields.orderNo]);
  const details = await readDetailsOf(salesEntryRecordId);
  const receipts = await readPaymentsOf(salesEntryRecordId);
  const liveAfter = await liveSnapshot();
  const spotPick = { productRecordId: productRecordIdForSpot, sizeRecordId: sizeByNumber.get(wantedSize) };

  head('验收：四个状态字段的实际值（测试 Base）');
  say(`  record_id : ${salesEntryRecordId}`);
  say(`  销售单号  : ${orderNo}`);
  say(`  确认状态  : '${values.userAction}'   （期望：已确认）`);
  say(`  销售状态  : '${values.sales}'   （期望：已写入）`);
  say(`  资金状态  : '${values.funds}'   （期望：已写入）`);
  say(`  库存状态  : '${values.stock}'   （期望：已写入）`);
  say(`  闸门判据 isPosted(资金状态) = ${isPosted(values.funds)}   （POSTED_VALUES = ${JSON.stringify(POSTED_VALUES)}）`);
  say(`  销售明细  : ${details.length} 条 · 履约状态 ${JSON.stringify(details.map((row) => row.履约状态))}`);
  say(`  收款明细  : ${receipts.length} 条 · ${JSON.stringify(receipts.map((row) => `${row.收款状态}/${row.收款金额}`))}`);
  say(`  实时库存（门盒）: ${doorBoxOf(liveBefore, spotPick)} → ${doorBoxOf(liveAfter, spotPick)}`);
  say(`  IM 替身调用：${sim.outbound.length} 次（全部拦在本地，没有真实外发）`);

  const expectations = [
    ['确认状态', values.userAction, '已确认'],
    ['销售状态', values.sales, '已写入'],
    ['资金状态', values.funds, '已写入'],
    ['库存状态', values.stock, '已写入'],
  ];
  const failures = expectations.filter(([, actual, expected]) => actual !== expected);
  say('');
  if (failures.length) {
    say(`  ✗ 未达标：${failures.map(([name, actual, expected]) => `${name}='${actual}'（期望 '${expected}'）`).join('；')}`);
    process.exit(1);
  }
  say('  ✅ 四个字段全部达标（记录 id 见上）。');
};

// ══════════════════════════════════════════════════════════════════════════════
// 路径 B：完整生产入口（群消息 → AI → 卡片 → 确认 →（话题）二次处理）
// ══════════════════════════════════════════════════════════════════════════════
const waitFor = async (label, predicate, timeoutMs = 240_000) => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} 超时（${timeoutMs}ms）`);
    await sleep(500);
  }
};
const SALE_TERMINAL = (task) =>
  ['needs_info', 'failed', 'ignored', 'posted', 'posted_delivery_pending', 'query_answered',
    'progress_applied', 'progress_failed',
    // ⭐ 「已完毕」但问不出收款方式时，进展就停在"回问了一句"——
    //    不认它的话这里会干等 4 分钟，把"她得说一句方式"报成"超时"。
    PROGRESS_TASK_STATUS.ASKING].includes(task.status)
  || String(task.status || '').startsWith('after_sales_')
  || (task.status === 'ready_to_confirm' && Boolean(task.card_message_id));

const buildHarness = (label) => {
  const dir = fsSync.mkdtempSync(path.join(storeDir, `${label}-`));
  const store = new JsonTaskStore({ dir: path.join(dir, 'tasks'), idField: 'task_id' });
  const salesGroupThreads = new SalesGroupThreadLocator({
    store: new JsonTaskStore({ dir: path.join(dir, 'threads'), idField: 'task_id' }),
  });
  const sim = makeImSim();
  const service = new LarkMvpService({
    client: makeClient(sim),
    gateway,
    store,
    salesGroupThreads,
    afterSales: new AfterSalesService({
      gateway,
      store: new JsonTaskStore({ dir: path.join(dir, 'after_sales'), idField: 'operation_id' }),
    }),
  });
  return { dir, store, salesGroupThreads, sim, service };
};

const sendGroupMessage = async (h, { text, messageId, threadId = '' }) => {
  const accepted = await h.service.acceptMessage({
    message: {
      message_id: messageId, chat_id: CHAT_ID, chat_type: 'group', message_type: 'text',
      create_time: String(Date.now()), thread_id: threadId, parent_id: '',
      mentions: [], content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: senderOpenId } },
  });
  return { accepted, taskId: idFor('sale', messageId) };
};
const waitTask = (h, taskId, predicate, label, timeoutMs) =>
  waitFor(label || `任务 ${taskId}`, async () => {
    const task = await h.store.get(taskId);
    return task && predicate(task) ? task : null;
  }, timeoutMs);
const confirmCard = (h, { taskId, cardMessageId, action = 'confirm_sale' }) =>
  h.service.handleCardAction({
    action: { value: { draft_id: taskId, action } },
    operator: { operator_id: { open_id: senderOpenId } },
    context: { open_message_id: cardMessageId },
  }, { interactionId: `itx_${action}_${taskId}` });

/** 建单（发一条群消息 → 等 AI 出卡片），把「是不是话题形式回复」记成证据。 */
const startSale = async (h, { text, messageId, picks }) => {
  const logsFrom = capturedLogs.length;
  const { accepted, taskId } = await sendGroupMessage(h, { text, messageId });
  let task = await waitTask(h, taskId, SALE_TERMINAL, `解析 ${messageId}`);
  const replies = h.sim.outbound.filter((row) => row.api === 'im.message.reply' && row.parent_message_id === messageId);
  const cardReply = replies.slice(-1)[0] || null;
  // ⚠️ 真表上的真实行为（不是脚本的绕路）：**只要这个货号 + 尺码在库里有多个颜色**，
  //    卡片就要求她**再点一次颜色**才肯确认 —— 即便她原话里已经说了颜色
  //    （`larkMvpService` 第 1303 行：`found.colors.length > 1` → `needs_color: true`）。
  //    这里走的就是她点卡片的那条真实链路（`choose_sale_color`），不是绕过它。
  const colourSteps = [];
  if (task?.draft?.items?.some((item) => item.needs_color)) {
    for (let round = 0; round < 4; round += 1) {
      const pending = (task.draft.items || [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.needs_color);
      if (!pending.length) break;
      for (const { item, index } of pending) {
        // 选**我们自己挑的那条货品记录**（就是实时库存里那行门盒）—— 意图明确，不猜。
        const wanted = picks?.[index]?.productRecordId;
        const option = (item.color_options || []).find((row) => row.recordId === wanted)
          || (item.color_options || [])[0];
        if (!option) throw new Error(`第 ${index + 1} 条明细没有可选颜色，无法继续`);
        colourSteps.push({
          item_index: index,
          原话里的颜色: item.color || task.draft?.color || '',
          卡片候选: (item.color_options || []).map((row) => row.color),
          选了: option.color,
          选的记录: option.recordId,
        });
        await h.service.handleCardAction({
          action: {
            value: {
              draft_id: taskId, action: 'choose_sale_color', item_index: index, record_id: option.recordId,
            },
          },
          operator: { operator_id: { open_id: senderOpenId } },
          context: { open_message_id: task.card_message_id },
        }, { interactionId: `itx_choose_color_${taskId}_${index}` });
      }
      await sleep(600);
      task = await h.store.get(taskId);
    }
    if (task?.draft?.items?.some((item) => item.needs_color)) throw new Error('选颜色没收敛（卡片仍要求选色）');
    if (colourSteps.length) {
      say(`     ⚠️ 卡片要求「先选颜色」才肯接受确认（原话里的颜色没被自动采用）：${JSON.stringify(colourSteps)}`);
    }
  }
  return { accepted, taskId, task, cardReply, logsFrom, colourSteps };
};

const confirmAndRead = async (h, { taskId, cardMessageId, salesEntryRecordId, pick, liveBefore }) => {
  const logsFrom = capturedLogs.length;
  // 点「确认」的**返回值**要留下来：它带着 toast（成功/拒绝理由），
  // 是"点了没反应"这类问题唯一的现场证据。
  let actionResult = null;
  let actionError = '';
  try {
    actionResult = await confirmCard(h, { taskId, cardMessageId });
  } catch (error) {
    actionError = error.message;
  }
  let task = null;
  let waitError = '';
  const waitMs = WAIT_MS;
  say(`     · 点「确认」的返回：${JSON.stringify(actionResult)}${actionError ? ` / 抛错：${actionError}` : ''}`);
  try {
    task = await waitTask(h, taskId,
      (row) => ['posted', 'posted_delivery_pending'].includes(row.status) || Boolean(row.posting_error),
      `入账 ${taskId}`, waitMs);
  } catch (error) {
    waitError = error.message;
  }
  const liveAfter = pick ? await liveSnapshot() : null;
  if (waitError) {
    throw new Error(`${waitError}；点「确认」的返回=${JSON.stringify(actionResult)}`
      + `${actionError ? `；点「确认」抛错=${actionError}` : ''}`);
  }
  return {
    task, actionResult, actionError,
    entry: await readEntry(salesEntryRecordId),
    details: await readDetailsOf(salesEntryRecordId),
    payments: await readPaymentsOf(salesEntryRecordId),
    doorBox: {
      before: liveBefore && pick ? doorBoxOf(liveBefore, pick) : null,
      after: liveAfter && pick ? doorBoxOf(liveAfter, pick) : null,
    },
    liveAfter,
    logsFrom,
  };
};

const describePick = (pick) =>
  `${pick.itemNo} ${pick.color} ${pick.size}码（门盒=${pick.doorBox} 单价=${pick.price}）`;

const taken = new Set();
const take = (filter) => {
  const found = pool.find((item) => !taken.has(item.key) && (!filter || filter(item)));
  if (found) taken.add(found.key);
  return found;
};
/**
 * 换货要**两双同货号同颜色的不同尺码**（同一件货品的两个尺码才谈得上"换一个码"）。
 * ⚠️ 不能只从 pool 里"随便拿一个再看有没有配对"—— 那个货号可能只有这一个尺码有货
 *    （2026-10-06 就这么报过「找不到换货目标」）。所以这里**先找配对、再占用**。
 */
const takePair = () => {
  const byItemColor = new Map();
  for (const item of pool) {
    if (taken.has(item.key)) continue;
    const key = `${item.itemNo}|${item.color}`;
    if (!byItemColor.has(key)) byItemColor.set(key, []);
    byItemColor.get(key).push(item);
  }
  for (const list of byItemColor.values()) {
    const sizes = [...new Set(list.map((item) => item.size))];
    if (sizes.length >= 2) {
      const chosen = sizes.slice(0, 2).map((size) => list.find((item) => item.size === size));
      chosen.forEach((item) => taken.add(item.key));
      return chosen;
    }
  }
  return null;
};
// ── 场景 1：现货 · 一单两笔交易（两条明细 / 两双鞋）────────────────────────
const runTwoDetail = async () => {
  const pickA = take();
  const pickB = take((item) => item.key !== pickA?.key);
  const scenario = makeScenario('two-detail', '现货 · 一单两笔交易', [
    '2 条销售明细（都已交付）',
    '1 条收款明细（已收款）',
    '四字段：已确认 / 已写入 / 已写入 / 已写入',
    '实时库存：两双鞋各 门盒 -1（合计 -2）',
    '2 条库存流水（现货销售，各 -1）',
    '机器人回复带 reply_in_thread: true',
  ]);
  if (!pickA || !pickB) { scenario.error = '测试 Base 里找不到两组门盒有货的数据'; return scenario; }
  scenario.data.picks = [describePick(pickA), describePick(pickB)];
  const h = buildHarness('two-detail');
  try {
    scenario.data.text = `卖两双，${pickA.itemNo} ${pickA.color} ${pickA.size}码 ${pickA.price}，`
      + `${pickB.itemNo} ${pickB.color} ${pickB.size}码 ${pickB.price}，微信 ${pickA.price + pickB.price}`;
    const liveBefore = await liveSnapshot();
    const started = await startSale(h, { text: scenario.data.text, messageId: 'om_e2e_two_detail', picks: [pickA, pickB] });
    scenario.data.draft = {
      trade_type: started.task.draft?.trade_type,
      delivery_status: started.task.draft?.delivery_status,
      item_count: started.task.draft?.items?.length,
      payments: started.task.draft?.payments,
      missing_fields: started.task.draft?.missing_fields,
    };
    check(scenario, 'AI 解析出卡片（ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    scenario.data.card_reply = started.cardReply ? {
      parent_message_id: started.cardReply.parent_message_id,
      msg_type: started.cardReply.msg_type,
      reply_in_thread: started.cardReply.reply_in_thread,
      thread_id: started.cardReply.thread_id,
    } : null;
    check(scenario, '机器人回复带 reply_in_thread: true', true, started.cardReply?.reply_in_thread === true);
    const startsThread = await h.salesGroupThreads.findByMessageId('om_e2e_two_detail');
    check(scenario, '话题 id 被本地映射记住（能按话题定位同一笔）', true, Boolean(startsThread?.thread_id));

    const result = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id, pick: pickA, liveBefore,
    });
    const liveAfter = result.liveAfter || await liveSnapshot();
    check(scenario, '销售明细条数', 2, result.details.length);
    check(scenario, '每条明细履约状态', ['已交付', '已交付'], result.details.map((row) => row.履约状态).sort());
    check(scenario, '收款明细条数', 1, result.payments.length);
    check(scenario, '收款状态', ['已收款'], result.payments.map((row) => row.收款状态));
    check(scenario, '四个字段', {
      确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入',
    }, result.entry.dims);
    check(scenario, '实时库存门盒变化（合计）', -2,
      (doorBoxOf(liveAfter, pickA) - doorBoxOf(liveBefore, pickA))
      + (doorBoxOf(liveAfter, pickB) - doorBoxOf(liveBefore, pickB)));
    scenario.data.ledger = await readLedgerForDetails(result.details.map((row) => row.record_id));
    check(scenario, '库存流水（行为 / 变动数量 / 方向）',
      [{ 库存行为: '销售减少', 变动数量: '1' }, { 库存行为: '销售减少', 变动数量: '1' }],
      ledgerPairs(scenario.data.ledger));
    scenario.data.entry = result.entry;
    scenario.data.details = result.details;
    scenario.data.payments = result.payments;
    scenario.data.ledger = scenario.data.ledger || await readLedgerForDetails(result.details.map((row) => row.record_id));
    scenario.data.inventory = {
      [`${pickA.itemNo}${pickA.color}${pickA.size}码`]: { before: doorBoxOf(liveBefore, pickA), after: doorBoxOf(liveAfter, pickA) },
      [`${pickB.itemNo}${pickB.color}${pickB.size}码`]: { before: doorBoxOf(liveBefore, pickB), after: doorBoxOf(liveAfter, pickB) },
    };
    scenario.data.project_logs = eventsSince(started.logsFrom, ['v1.sale.posted', 'inventory.change.applied', 'sales.delivery.completed']);
    if (result.task.posting_error) scenario.error = result.task.posting_error;
    return scenario;
  } catch (error) { scenario.error = error.message; return scenario; }
};

// ── 场景 2：现货 · 一单两笔支付方式（两条收款）──────────────────────────────
const runTwoPayment = async () => {
  const pick = take();
  const scenario = makeScenario('two-payment', '现货 · 一单两笔支付方式', [
    '1 条销售明细（已交付）',
    '2 条收款明细（都已收款，各带收款时间）',
    '四字段：已确认 / 已写入 / 已写入 / 已写入',
    '实时库存：门盒 -1',
    '1 条库存流水（现货销售，-1）',
    '机器人回复带 reply_in_thread: true',
  ]);
  if (!pick) { scenario.error = '测试 Base 里找不到门盒有货的数据'; return scenario; }
  scenario.data.pick = describePick(pick);
  const h = buildHarness('two-payment');
  try {
    const half = Math.round(pick.price / 2);
    scenario.data.text = `卖一双 ${pick.itemNo} ${pick.color} ${pick.size}码，微信 ${half}、现金 ${pick.price - half}`;
    const liveBefore = await liveSnapshot();
    const started = await startSale(h, { text: scenario.data.text, messageId: 'om_e2e_two_payment', picks: [pick] });
    scenario.data.draft = {
      trade_type: started.task.draft?.trade_type,
      payments: started.task.draft?.payments,
      missing_fields: started.task.draft?.missing_fields,
    };
    check(scenario, 'AI 解析出卡片（ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    scenario.data.card_reply = {
      reply_in_thread: started.cardReply?.reply_in_thread, thread_id: started.cardReply?.thread_id,
    };
    check(scenario, '机器人回复带 reply_in_thread: true', true, started.cardReply?.reply_in_thread === true);
    const result = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id, pick, liveBefore,
    });
    const liveAfter = result.liveAfter || await liveSnapshot();
    check(scenario, '销售明细条数', 1, result.details.length);
    check(scenario, '明细履约状态', ['已交付'], result.details.map((row) => row.履约状态));
    check(scenario, '收款明细条数', 2, result.payments.length);
    check(scenario, '收款状态（都已是收款）', ['已收款', '已收款'], result.payments.map((row) => row.收款状态).sort());
    check(scenario, '每条已收款都有收款时间', true,
      result.payments.length > 0 && result.payments.every((row) => Boolean(row.收款时间)));
    check(scenario, '四个字段', {
      确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入',
    }, result.entry.dims);
    check(scenario, '实时库存门盒变化', -1, doorBoxOf(liveAfter, pick) - doorBoxOf(liveBefore, pick));
    scenario.data.ledger = await readLedgerForDetails(result.details.map((row) => row.record_id));
    check(scenario, '库存流水（行为 / 变动数量 / 方向）', [{ 库存行为: '销售减少', 变动数量: '1' }],
      ledgerPairs(scenario.data.ledger));
    scenario.data.entry = result.entry;
    scenario.data.details = result.details;
    scenario.data.payments = result.payments;
    scenario.data.inventory = { before: doorBoxOf(liveBefore, pick), after: doorBoxOf(liveAfter, pick) };
    scenario.data.project_logs = eventsSince(started.logsFrom, ['v1.sale.posted', 'inventory.change.applied', 'sales.delivery.completed']);
    if (result.task.posting_error) scenario.error = result.task.posting_error;
    return scenario;
  } catch (error) { scenario.error = error.message; return scenario; }
};

// ── 场景 3 / 4：预付 / 未付（首次入账 + 话题里的一句话）─────────────────────
const runDeferred = async ({ key, name, textFor, expect }) => {
  const pick = take();
  const scenario = makeScenario(key, name, expect.expectation);
  if (!pick) { scenario.error = '测试 Base 里找不到门盒有货的数据'; return scenario; }
  scenario.data.pick = describePick(pick);
  const h = buildHarness(key);
  try {
    scenario.data.text = textFor(pick);
    const liveBefore = await liveSnapshot();
    const started = await startSale(h, { text: scenario.data.text, messageId: `om_e2e_${key}`, picks: [pick] });
    scenario.data.draft = {
      trade_type: started.task.draft?.trade_type,
      delivery_status: started.task.draft?.delivery_status,
      items: (started.task.draft?.items || []).map((item) => ({ item_no: item.item_no, size: item.size, actual_amount: item.actual_amount })),
      payments: started.task.draft?.payments,
      owed: started.task.draft?.owed,
      missing_fields: started.task.draft?.missing_fields,
    };
    check(scenario, 'AI 解析出卡片（ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    scenario.data.card_reply = {
      reply_in_thread: started.cardReply?.reply_in_thread, thread_id: started.cardReply?.thread_id,
    };
    check(scenario, '机器人回复带 reply_in_thread: true', true, started.cardReply?.reply_in_thread === true);
    const threadId = started.cardReply?.thread_id || '';

    // ── 首次：点「确认」 ───────────────────────────────────────────────────
    const first = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id, pick, liveBefore,
    });
    const liveAfterFirst = first.liveAfter || await liveSnapshot();
    scenario.data.first = {
      entry: first.entry, details: first.details, payments: first.payments,
      inventory: { before: doorBoxOf(liveBefore, pick), after: doorBoxOf(liveAfterFirst, pick) },
      project_logs: eventsSince(started.logsFrom, ['v1.sale.posted', 'inventory.change.applied']),
    };
    check(scenario, '首次：销售明细条数', expect.detailCount, first.details.length);
    check(scenario, '首次：明细履约状态', expect.firstDetailStatus, first.details.map((row) => row.履约状态));
    check(scenario, '首次：收款明细条数', expect.firstPaymentCount, first.payments.length);
    check(scenario, '首次：收款状态 + 金额', expect.firstPaymentStatus(pick),
      first.payments.map((row) => `${row.收款状态}/${row.收款金额}`).sort());
    check(scenario, '首次：四个字段', expect.firstDims, first.entry.dims);
    check(scenario, '首次：实时库存门盒变化', expect.firstDoorBoxDelta,
      doorBoxOf(liveAfterFirst, pick) - doorBoxOf(liveBefore, pick));

    // ── 话题里说话（**她的原话口径**）───────────────────────────────────────
    // ⚠️ 「已完毕」/「成交」这两个词**不在** `config/salesProgressIntake` 的词表里，
    //    于是 `acceptSalesText` 的放宽闸门不生效、`looksLikeSalesText` 也不认它 →
    //    这条消息会被**静默丢掉**（不建任务、不回话、一个字节都不写，见该函数注释）。
    //    所以这里**必须容错**：等不到就如实记「没有任何效果」，再走配置认的词。
    const wordFrom = capturedLogs.length;
    const { taskId: wordTaskId } = await sendGroupMessage(h, {
      text: expect.doneText, messageId: `om_e2e_${key}_words`, threadId,
    });
    let wordTask = null;
    let wordError = '';
    try {
      wordTask = await waitTask(h, wordTaskId, SALE_TERMINAL, `话题里说「${expect.doneText}」`, WORD_WAIT_MS);
    } catch (error) {
      wordError = error.message;
    }
    const entryAfter = await readEntry(started.task.sales_entry_record_id);
    const detailsAfter = await readDetailsOf(started.task.sales_entry_record_id);
    const paymentsAfter = await readPaymentsOf(started.task.sales_entry_record_id);
    const liveAfterWord = await liveSnapshot();
    scenario.data.afterWords = {
      said: expect.doneText,
      task_created: Boolean(wordTask),
      task_status: wordTask ? wordTask.status : `（等 ${WORD_WAIT_MS}ms 也没等到任务终态——这句话没有任何效果）`,
      error: wordError,
      progress_kind: wordTask?.progress_kind || '',
      progress_reason: wordTask?.progress_reason || wordError,
      detail_status: detailsAfter.map((row) => row.履约状态),
      payments: paymentsAfter.map((row) => ({ 状态: row.收款状态, 金额: row.收款金额, 收款时间: row.收款时间 || '' })),
      dims: entryAfter.dims,
      doorBox: doorBoxOf(liveAfterWord, pick),
      project_logs: capturedLogs.slice(wordFrom)
        .filter((entry) => /^sales\.thread_progress|^lark\.sales\.processing\.thread_progress|^lark\.sales\.card/.test(entry.event))
        .map((entry) => ({ event: entry.event, kind: entry.kind, reason: entry.reason, error: entry.error })),
    };
    const wordsWorked = JSON.stringify(detailsAfter.map((row) => row.履约状态).sort())
        === JSON.stringify([...expect.afterWordsDetailStatus].sort())
      && JSON.stringify(paymentsAfter.map((row) => row.收款状态).sort())
        === JSON.stringify([...expect.afterWordsPaymentStatus].sort());
    check(scenario, `话题里说「${expect.doneText}」：明细履约状态（她的口径）`,
      expect.afterWordsDetailStatus, detailsAfter.map((row) => row.履约状态));
    check(scenario, `话题里说「${expect.doneText}」：收款状态（她的口径）`,
      expect.afterWordsPaymentStatus, paymentsAfter.map((row) => row.收款状态).sort());
    check(scenario, `话题里说「${expect.doneText}」：已收款那笔都有收款时间`, true,
      paymentsAfter.filter((row) => row.收款状态 === '已收款').length > 0
      && paymentsAfter.filter((row) => row.收款状态 === '已收款').every((row) => Boolean(row.收款时间)));
    check(scenario, `话题里说「${expect.doneText}」：实时库存门盒（相对她说之前）`,
      expect.afterWordsDoorBoxDelta, doorBoxOf(liveAfterWord, pick) - doorBoxOf(liveBefore, pick));
    if (!wordTask) {
      scenario.notes.push(`⚠️ 「${expect.doneText}」这条消息**没有被受理**（${wordError}）——`
        + '它既不是 config/salesProgressIntake 的进展词，也不是"像销售"的原话，'
        + '所以被 acceptSalesText 的入口闸门静默丢掉了（不建任务、不回话、不写表）。');
    }

    // ── 她的口径没生效时，用**更具体的说法**再试一次（说明差在哪）───────────
    if (!wordsWorked) {
      scenario.notes.push(`⚠️ 「${expect.doneText}」这一步**没有达到预期**：`
        + (wordTask
          ? `这条消息被受理了（终态 ${wordTask.status} · kind=${wordTask.progress_kind || '—'}），但表里没变化。`
          : '这条消息**没有被受理**（见上一条）。')
        + '下面用"更具体的说法"再试一次，看链路本身能不能做。');
    }
    if (!wordsWorked) {
      for (const [index, followUp] of expect.fallbackTexts.entries()) {
        const said = typeof followUp === 'function' ? followUp(pick) : followUp;
        const from = capturedLogs.length;
        const { taskId } = await sendGroupMessage(h, {
          text: said, messageId: `om_e2e_${key}_fb${index}`, threadId,
        });
        let task = null;
        let followUpError = '';
        try {
          task = await waitTask(h, taskId, SALE_TERMINAL, `补一句「${said}」`, WORD_WAIT_MS);
        } catch (error) {
          followUpError = error.message;
        }
        const details = await readDetailsOf(started.task.sales_entry_record_id);
        const payments = await readPaymentsOf(started.task.sales_entry_record_id);
        const live = await liveSnapshot();
        scenario.data.fallback = scenario.data.fallback || [];
        scenario.data.fallback.push({
          said,
          task_created: Boolean(task),
          task_status: task ? task.status : `（等 ${WORD_WAIT_MS}ms 也没等到任务终态）`,
          error: followUpError,
          progress_kind: task?.progress_kind || '',
          progress_reason: task?.progress_reason || followUpError,
          detail_status: details.map((row) => row.履约状态),
          payments: payments.map((row) => ({ 状态: row.收款状态, 金额: row.收款金额, 收款时间: row.收款时间 || '' })),
          dims: (await readEntry(started.task.sales_entry_record_id)).dims,
          doorBox: doorBoxOf(live, pick) - doorBoxOf(liveBefore, pick),
          project_logs: capturedLogs.slice(from)
            .filter((entry) => /^sales\.thread_progress|^lark\.sales\.processing\.thread_progress|^lark\.message\.ignored/.test(entry.event))
            .map((entry) => ({ event: entry.event, kind: entry.kind, reason: entry.reason, error: entry.error })),
        });
      }
    }
    scenario.data.final_entry = await readEntry(started.task.sales_entry_record_id);
    scenario.data.final_details = await readDetailsOf(started.task.sales_entry_record_id);
    scenario.data.final_payments = await readPaymentsOf(started.task.sales_entry_record_id);
    scenario.data.final_doorBoxDelta = doorBoxOf(await liveSnapshot(), pick) - doorBoxOf(liveBefore, pick);
    if (first.task.posting_error) scenario.error = first.task.posting_error;
    return scenario;
  } catch (error) { scenario.error = error.message; return scenario; }
};

// ── 场景 5 / 6：退货 / 换货 ────────────────────────────────────────────────
const AFTER_SALES_TERMINAL = (task) =>
  [AFTER_SALES_TASK_STATUS.DONE, AFTER_SALES_TASK_STATUS.CANCELLED, AFTER_SALES_TASK_STATUS.ASKING]
    .includes(task.status);

const runAfterSales = async ({ key, name, saleTextFor, afterSalesTextFor, needsExchangePair, expect }) => {
  // 换货要先占一对「同货号同色、两个尺码都有门盒」的（先找配对再占用，见 takePair）。
  const pair = needsExchangePair ? takePair() : null;
  const pick = needsExchangePair ? pair?.[0] : take();
  const scenario = makeScenario(key, name, expect.expectation);
  if (!pick) {
    scenario.error = needsExchangePair
      ? '测试 Base 里找不到「同货号同色 + 两个尺码都门盒有货」的组合，换货跑不了'
      : '测试 Base 里找不到门盒有货的数据';
    return scenario;
  }
  scenario.data.pick = describePick(pick);
  const h = buildHarness(key);
  try {
    scenario.data.sale_text = saleTextFor(pick);
    const liveBefore = await liveSnapshot();
    const started = await startSale(h, { text: scenario.data.sale_text, messageId: `om_e2e_${key}_sale`, picks: [pick] });
    check(scenario, '原单 AI 解析出卡片', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `原单没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    scenario.data.card_reply = {
      reply_in_thread: started.cardReply?.reply_in_thread, thread_id: started.cardReply?.thread_id,
    };
    check(scenario, '机器人回复带 reply_in_thread: true', true, started.cardReply?.reply_in_thread === true);
    const threadId = started.cardReply?.thread_id || '';
    const original = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id, pick, liveBefore,
    });
    const liveAfterSale = original.liveAfter || await liveSnapshot();
    scenario.data.original_entry = original.entry;
    scenario.data.original_details = original.details;
    check(scenario, '原单：明细履约状态', ['已交付'], original.details.map((row) => row.履约状态));
    check(scenario, '原单：实时库存门盒变化', -1, doorBoxOf(liveAfterSale, pick) - doorBoxOf(liveBefore, pick));

    const exchangeTarget = needsExchangePair ? pair[1] : null;
    if (exchangeTarget) scenario.data.exchange_target = describePick(exchangeTarget);
    scenario.data.after_sales_text = afterSalesTextFor(pick, exchangeTarget);

    // 售后之前先给整张「库存流水」照一张 id 快照：之后多出来的那几条就是这次售后写的。
    const ledgerIdsBeforeAfterSales = await snapshotLedgerIds();
    const logsFrom = capturedLogs.length;
    const { taskId } = await sendGroupMessage(h, {
      text: scenario.data.after_sales_text, messageId: `om_e2e_${key}_as`, threadId,
    });
    const task = await waitTask(h, taskId,
      (row) => AFTER_SALES_TERMINAL(row) || row.status === AFTER_SALES_TASK_STATUS.CONFIRMING
        // ⚠️ 也要认「失败 / 缺信息」这两种终态：否则任务**早就 failed 了**，
        //    脚本还在那儿干等 4 分钟，把"失败"报成"超时"（2026-10-06 踩过）。
        || ['failed', 'needs_info', 'ignored'].includes(row.status),
      `售后计划 ${key}`, WAIT_MS);
    scenario.data.after_sales_task_status = task.status;
    scenario.data.after_sales_plan = task.after_sales_plan ? {
      action: task.after_sales_plan.action,
      original_sales_order_no: task.after_sales_plan.original_sales_order_no,
      diff_amount: task.after_sales_plan.diff_amount,
      settlement: task.after_sales_plan.settlement,
      restock_state: task.after_sales_plan.restock_state,
      source: task.after_sales_plan.source,
    } : null;
    check(scenario, '话题里的售后进了「待确认」（出了确认卡片）', AFTER_SALES_TASK_STATUS.CONFIRMING, task.status);
    if (task.status !== AFTER_SALES_TASK_STATUS.CONFIRMING) {
      scenario.error = `售后没出确认卡片：${task.status} ${task.after_sales_error || ''}`;
      return scenario;
    }
    await confirmCard(h, { taskId, cardMessageId: task.card_message_id, action: AFTER_SALES_CARD_ACTIONS.CONFIRM });
    const done = await waitTask(h, taskId, AFTER_SALES_TERMINAL, `售后执行 ${key}`);
    scenario.data.after_sales_result = done.after_sales_result || null;
    scenario.data.after_sales_error = done.after_sales_error || '';
    const liveAfter = await liveSnapshot();

    const masterId = done.after_sales_result?.masterRecordId || '';
    const masterEntry = masterId ? await readEntry(masterId) : null;
    const masterDetails = masterId ? await readDetailsOf(masterId) : [];
    const masterPayments = masterId ? await readPaymentsOf(masterId) : [];
    // ⚠️ 售后的库存流水「关联销售」指向的是**被退/被换的那条【原】明细**（不是新主表的明细），
    //    所以这里读**原明细**的流水，再和售后之前的快照做差集 —— 差集就是这次售后写进去的流水。
    const masterLedger = await readNewLedgerSince(ledgerIdsBeforeAfterSales, [
      `${pick.itemNo}|${pick.color}|`,
      ...(exchangeTarget ? [`${exchangeTarget.itemNo}|${exchangeTarget.color}|`] : []),
    ]);
    const originalDetailsAfter = await readDetailsOf(started.task.sales_entry_record_id);

    scenario.data.master_entry = masterEntry;
    scenario.data.master_details = masterDetails;
    scenario.data.master_payments = masterPayments;
    scenario.data.master_ledger = masterLedger;
    scenario.data.original_details_after = originalDetailsAfter;
    scenario.data.inventory = {
      before: doorBoxOf(liveBefore, pick),
      afterSale: doorBoxOf(liveAfterSale, pick),
      afterAfterSales: doorBoxOf(liveAfter, pick),
      ...(exchangeTarget ? {
        exchangeTargetBefore: doorBoxOf(liveBefore, exchangeTarget),
        exchangeTargetAfter: doorBoxOf(liveAfter, exchangeTarget),
      } : {}),
    };
    scenario.data.project_logs = eventsSince(logsFrom,
      ['after_sales.executed', 'inventory.change.applied', 'v1.sale.posted', 'after_sales.confirmed']);

    check(scenario, '执行结果：动作', expect.action, done.after_sales_result?.action);
    const originalDetailIds = new Set(original.details.map((row) => row.record_id));
    check(scenario, '原明细履约状态', expect.originalFulfillment,
      originalDetailsAfter.filter((row) => originalDetailIds.has(row.record_id)).map((row) => row.履约状态));
    check(scenario, '售后主表四个字段', expect.masterDims, masterEntry?.dims);
    check(scenario, '库存流水条数', expect.ledgerCount, masterLedger.length);
    check(scenario, '库存流水（行为 / 变动数量 / 方向）', expect.ledger, ledgerPairs(masterLedger));
    scenario.data.master_ledger_pairs = ledgerPairs(masterLedger);
    check(scenario, '实时库存门盒（退回来的那双）', expect.pickDoorBoxDelta,
      doorBoxOf(liveAfter, pick) - doorBoxOf(liveAfterSale, pick));
    if (exchangeTarget) {
      check(scenario, '实时库存门盒（换出去的那双）', expect.targetDoorBoxDelta,
        doorBoxOf(liveAfter, exchangeTarget) - doorBoxOf(liveBefore, exchangeTarget));
    }
    check(scenario, '售后收款（交易方向 / 金额 / 有收款时间）', expect.payment(pick),
      masterPayments.map((row) => ({ 交易方向: row.交易方向, 金额: row.收款金额, 有收款时间: Boolean(row.收款时间) })));
    if (done.after_sales_error) scenario.error = done.after_sales_error;
    return scenario;
  } catch (error) { scenario.error = error.message; return scenario; }
};

// ── 调度 ────────────────────────────────────────────────────────────────────
const runGroupKinds = async (kinds) => {
  head('跑链路（走项目代码：群消息 → AI 解析 → 确认卡片 → 点确认 →（话题）二次处理）');
  let head0 = '（取不到）';
  try { head0 = execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch (_error) { /* ignore */ }
  say(`  HEAD：${head0}`);
  say(`  模拟操作人：取自测试 Base 已有记录的「录单人」（指纹 ${fingerprint(senderOpenId)}，不打印其值）`);
  say('  ⚠️ 数据来源：货号 / 颜色 / 尺码 / 单价**全部取自测试 Base 实时库存真实记录**；');
  say('     只是把句子拼出来（没有编造货品、没有编造金额档位）。');

  for (const [item, runner] of [
    ['two-detail', runTwoDetail],
    ['two-payment', runTwoPayment],
  ]) {
    if (!kinds.includes(item)) continue;
    say('');
    line();
    say(`  ▶ ${item} 跑中 …`);
    // ⚠️ 跑完**立刻**打印这一个场景：整轮被中断也不至于什么都留不下。
    scenarios.push(await runner());
    printScenarioBlock(scenarios[scenarios.length - 1]);
  }
  if (kinds.includes('prepaid')) {
    say('');
    line();
    say('  ▶ prepaid 跑中 …');
    scenarios.push(await runDeferred({
      key: 'prepaid', name: '预付销售',
      textFor: (pick) => `预付一双 ${pick.itemNo} ${pick.color} ${pick.size}码，`
        + `定金 ${Math.round(pick.price / 2)} 微信，尾款 ${pick.price - Math.round(pick.price / 2)} 以后付`,
      expect: {
        expectation: [
          '首次：1 条明细【未交付】＋ 2 条收款（1 已收款 + 1 未收款）',
          '首次：库存不动（门盒 0 变化）、库存状态=空',
          '首次：四个字段 = 已确认 / 已写入 / 已写入 /（空）',
          '话题里说「已完毕」→ 未交付变已交付 ＋ 未收款变已收款（带收款时间）',
          '话题里说「已完毕」→ 门盒 -1（交付扣库存）',
        ],
        detailCount: 1, firstPaymentCount: 2,
        firstDetailStatus: ['未交付'],
        firstPaymentStatus: (pick) => [
          `已收款/${Math.round(pick.price / 2)}`,
          `未收款/${pick.price - Math.round(pick.price / 2)}`,
        ].sort(),
        firstDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '' },
        firstDoorBoxDelta: 0,
        doneText: '已完毕',
        afterWordsDetailStatus: ['已交付'],
        afterWordsPaymentStatus: ['已收款', '已收款'],
        afterWordsDoorBoxDelta: -1,
        fallbackTexts: ['那双拿走了', (pick) => `收到微信 ${pick.price - Math.round(pick.price / 2)}`],
      },
    }));
    printScenarioBlock(scenarios[scenarios.length - 1]);
  }
  if (kinds.includes('unpaid')) {
    say('');
    line();
    say('  ▶ unpaid 跑中 …');
    scenarios.push(await runDeferred({
      key: 'unpaid', name: '未付销售',
      textFor: (pick) => `未付一双 ${pick.itemNo} ${pick.color} ${pick.size}码，成交 ${pick.price}`,
      expect: {
        expectation: [
          '首次：1 条明细【已交付】（货拿走）＋ 1 条收款【未收款】',
          '首次：库存扣 1（门盒 -1）、库存状态=已写入',
          '话题里说「成交」→ 未收款变已收款（带收款时间）',
          '话题里说「成交」→ 门盒不再变化（-1 保持）',
        ],
        detailCount: 1, firstPaymentCount: 1,
        firstDetailStatus: ['已交付'],
        firstPaymentStatus: (pick) => [`未收款/${pick.price}`],
        firstDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        firstDoorBoxDelta: -1,
        doneText: '成交',
        afterWordsDetailStatus: ['已交付'],
        afterWordsPaymentStatus: ['已收款'],
        afterWordsDoorBoxDelta: -1,
        fallbackTexts: [(pick) => `收到微信 ${pick.price}`],
      },
    }));
    printScenarioBlock(scenarios[scenarios.length - 1]);
  }
  for (const [item, definition] of [
    ['return', {
      name: '销售退货',
      saleTextFor: (pick) => `卖一双 ${pick.itemNo} ${pick.color} ${pick.size}码，微信 ${pick.price}`,
      afterSalesTextFor: (pick) => `退一双 ${pick.itemNo} ${pick.color} ${pick.size}码，钱退现金`,
      needsExchangePair: false,
      expect: {
        expectation: [
          '原明细履约状态 → 已退货',
          '新建售后主表（交易类型=销售退货），四字段 = 已确认 / 已写入 / 已写入 / 已写入',
          '库存：退回 +1（门盒），1 条库存流水（销售退货，+1）',
          '钱：1 条退款（交易方向=退回，带收款时间）',
        ],
        action: 'return', originalFulfillment: ['已退货'],
        masterDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        ledgerCount: 1, ledger: [{ 库存行为: '销售退货', 变动数量: '1' }],
        pickDoorBoxDelta: 1, targetDoorBoxDelta: null,
        payment: (pick) => [{ 交易方向: '退回', 金额: String(pick.price), 有收款时间: true }],
      },
    }],
    ['exchange', {
      name: '销售换货',
      saleTextFor: (pick) => `卖一双 ${pick.itemNo} ${pick.color} ${pick.size}码，微信 ${pick.price}`,
      afterSalesTextFor: (pick, target) => `换一双 ${pick.itemNo} ${pick.color} ${pick.size}码，`
        + `换成 ${target.itemNo} ${target.color} ${target.size}码，钱退现金`,
      // ⚠️ 换货要**同货号同颜色的两个尺码**（同一件货品才谈得上"换一个码"）；
      //    配对在 `takePair()` 里先找好（找不到就如实说跑不了，不硬凑另一双鞋）。
      needsExchangePair: true,
      expect: {
        expectation: [
          '原明细履约状态 → 已换货',
          '新建售后主表（交易类型=销售换货），四字段 = 已确认 / 已写入 / 已写入 / 已写入',
          '库存：旧鞋 +1、新鞋 -1（净 0；两条流水方向相反）',
          '差价 = 0 → 不动钱（不写收款明细）',
        ],
        action: 'exchange', originalFulfillment: ['已换货'],
        masterDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        ledgerCount: 2,
        // ⚠️ 顺序按 `ledgerPairs` 的排序口径（行为名 + 数量 的字符串序）：现货销售 < 销售退货。
        ledger: [{ 库存行为: '现货销售', 变动数量: '1' }, { 库存行为: '销售退货', 变动数量: '1' }],
        pickDoorBoxDelta: 1, targetDoorBoxDelta: -1,
        payment: () => [],
      },
    }],
  ]) {
    if (!kinds.includes(item)) continue;
    say('');
    line();
    say(`  ▶ ${item} 跑中 …`);
    scenarios.push(await runAfterSales({ key: item, ...definition }));
    printScenarioBlock(scenarios[scenarios.length - 1]);
  }
};

// ── 汇总 ────────────────────────────────────────────────────────────────────
const statusOf = (scenario) => {
  const failed = scenario.checks.filter((row) => !row.pass);
  // ⚠️ 有 error 就**永远不算通过** —— 否则"抛在半路、断言只跑了前几条"会被误报成 ✅。
  if (scenario.error) return { scenario, status: `❌ 未跑完：${scenario.error}`, failed };
  return {
    scenario,
    status: failed.length ? `未达标（${failed.length} 项）` : '通过',
    failed,
  };
};

/** 一个场景的完整块。**跑完立刻打**（免得整轮被中断时什么都留不下）。 */
const printScenarioBlock = (scenario) => {
  const { status, failed } = statusOf(scenario);
  void failed;
  say('');
  line();
  say(`  【${scenario.key}】${scenario.name} —— ${status}`);
  say('  预期：');
  for (const item of scenario.expectation) say(`    · ${item}`);
  say('  实际 / 逐条对照：');
  if (!scenario.checks.length) say(`    （没有到可对照的一步）${scenario.error ? ` 错误：${scenario.error}` : ''}`);
  for (const row of scenario.checks) {
    say(`    ${row.pass ? '✅' : '❌'} ${row.label}`);
    if (!row.pass) {
      say(`         期望：${JSON.stringify(row.expected)}`);
      say(`         实际：${JSON.stringify(row.actual)}`);
    }
  }
  for (const note of scenario.notes) say(`    · ${note}`);
  if (scenario.error && scenario.checks.length) say(`    ⚠️ 错误：${scenario.error}`);
  if (scenario.data.card_reply) {
    say(`  「话题形式回复」证据（IM 替身记下的**出站 payload**）：${JSON.stringify(scenario.data.card_reply)}`);
  }
  if (scenario.data.project_logs?.length) {
    say(`  项目代码日志（只有走项目代码才打得出来）：${JSON.stringify([...new Set(scenario.data.project_logs)])}`);
  }
  // ── 库存变化（流水 ＋ 实时库存）────────────────────────────────────────
  const ledgerRows = scenario.data.master_ledger || scenario.data.ledger || [];
  const inventory = scenario.data.inventory || scenario.data.first?.inventory;
  if (ledgerRows.length || inventory) {
    say('  库存变化：');
    if (ledgerRows.length) {
      for (const row of ledgerRows) {
        say(`    流水：行为「${row.库存行为}」 数量 ${row.变动数量}（方向=${row.方向}） 库存键 ${row.库存键}`);
      }
    } else {
      say('    流水：（无）');
    }
    if (inventory) say(`    实时库存：${JSON.stringify(inventory)}`);
    if (scenario.data.first?.inventory) say(`    首次（点确认后）实时库存：${JSON.stringify(scenario.data.first.inventory)}`);
    if (scenario.data.final_doorBoxDelta !== undefined) {
      say(`    最终（话题说完后）门盒相对开单前的变化：${scenario.data.final_doorBoxDelta}`);
    }
    if (scenario.data.afterWords) {
      const row = scenario.data.afterWords;
      say(`    话题里说「${row.said}」之后：这条消息${row.task_created ? `被受理（任务终态 ${row.task_status}）` : '**没有被受理**'}`
        + ` · 门盒变化 ${row.doorBox - (inventory?.before ?? 0)}`
        + ` · 明细 ${JSON.stringify(row.detail_status)}`
        + ` · 收款 ${JSON.stringify(row.payments)}`
        + ` · 四字段 ${JSON.stringify(row.dims)}`);
      if (row.project_logs?.length) say(`      项目日志：${JSON.stringify(row.project_logs)}`);
    }
    for (const item of scenario.data.fallback || []) {
      say(`    补一句「${item.said}」之后：这条消息${item.task_created ? `被受理（终态 ${item.task_status}，progress_kind=${item.progress_kind}）` : '**没有被受理**'}`
        + ` · 门盒变化 ${item.doorBox} · 明细 ${JSON.stringify(item.detail_status)}`
        + ` · 收款 ${JSON.stringify(item.payments)} · 四字段 ${JSON.stringify(item.dims)}`);
      if (item.project_logs?.length) say(`      项目日志：${JSON.stringify(item.project_logs)}`);
    }
  }
};

const printSummary = () => {
  head('结果汇总：每个场景一行');
  const rows = scenarios.map(statusOf);
  say('');
  line('═');
  say('  一张表（每个场景一行）：');
  line('═');
  say('  | 场景 | 预期 | 实际 | 通过 |');
  say('  |---|---|---|---|');
  for (const { scenario, status, failed } of rows) {
    const actual = scenario.error && !scenario.checks.length ? `未跑起来：${scenario.error}`
      : failed.length ? failed.map((row) => row.label).join('；') : '全部达标';
    say(`  | ${scenario.key} ${scenario.name} | ${scenario.expectation[0]} | ${actual} | ${status.startsWith('通过') ? '✅' : '❌'} |`);
  }
  const failedCount = rows.filter((row) => !row.status.startsWith('通过')).length;
  say('');
  say(`  场景：${rows.length} 个 · 未达标 ${failedCount} 个`);
  return failedCount;
};

const main = async () => {
  if (kind === 'spot') { await runSpotLegacy(); return 0; }
  const kinds = kind === 'all'
    ? ['two-detail', 'two-payment', 'prepaid', 'unpaid', 'return', 'exchange']
    : [kind];
  await runGroupKinds(kinds);
  return printSummary();
};

main().then((failed) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
  originalConsole.error(`[e2e-sales-status] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
