#!/usr/bin/env node
/**
 * e2e-group-thread.mjs —— **群聊 / 话题 · 六场景自动化 E2E**。
 *
 * 业务负责人 2026-10-07 的口径（逐字）：
 *   「按照我们**销售和采购都在群聊**，**一个事件在一个话题里完事**的逻辑来做，
 *    你看看是不是可以把**自动化测试**给做了」
 *
 * 换句话说：把「**一条群消息 / 一个话题 → 一整条业务链路走完**」做成**可重复运行**的
 * 自动化测试。六个场景（每个 = 一个话题里闭环，验收标准见
 * `docs/e2e-group-thread-2026-10-07.md`，也在跑之前由本脚本打印一遍）：
 *
 *   s1 销售录单   群话题发文字 → 识别 → 确认卡片 → 确认 → 入账销售明细 → 交付 → 扣库存
 *   s2 销售退货   话题里说「退那双…」→ 定位那笔销售 → 确认 → 退货入账 + 库存加回
 *   s3 换货       话题里说「换成…」→ 新鞋出库（现货销售 SALE_CASH）+ 旧鞋入库
 *   （原 s4 采购报单 / s5 采购退货两个场景**已随「信息填写」入口退场删除**，2026-10-09）
 *   s6 补样品     群销售消耗了样品 → 补样品卡片**回到那条销售话题**（reply_in_thread；不发私聊）
 *
 * 硬纪律（业务负责人 2026-10-06 明确，逐条守）：
 *   ⭐ **走项目代码**：直接 require 项目源码、调项目自己的入口——
 *      `LarkMvpService.acceptMessage` / `handleCardAction` /
 *      （原话里还有 `PurchaseWebhookService.accept('supplier-report', …)` ——
 *       那条「信息填写」表变更入口已于 2026-10-09 随整表删除退场），
 *      让**生产上那条链路**真跑。**不是**用 CLI 手工拼结果。
 *   🔴 **严禁飞书 CLI**（**包括"读表验证"**）：验证一律走项目自己的只读路径
 *      （`V1BitableGateway` 的 get / listAll / listFields）——脚本把结果打印出来。
 *   🔴 **只写测试 Base**：写入目标必须**逐字等于** `FEISHU_V1_E2E_TEST_APP_TOKEN`，
 *      并且 `FEISHU_TARGET_ENV=test`；否则**拒绝运行**（生产 Base 只读，一个字都不许写）。
 *   🔴 **不硬编码任何 token/secret**：闸门的值一律从环境（`.env`）读。
 *
 * 子命令：
 *   node scripts/e2e-group-thread.mjs inspect
 *       只读：打印测试 Base 现状（实时库存候选 / 单价 / 行为管理 / 采购前置），不写任何表。
 *   node scripts/e2e-group-thread.mjs run [--only s1,s6] [--show-logs] [--all]
 *       跑销售侧场景（s1/s2/s3/s6，写测试 Base）；`--all` 连补充场景 e1..e5 一起跑。
 *       ⚠️ 原 s4/s5（采购报单 / 采购退货）已随「信息填写」入口退场删除。
 *
 * 飞书外发：默认**全部拦住**（记录型 IM 替身），只把出站 payload 记下来当证据
 *   （「回复是不是话题形式」唯一的可核对证据就是 `reply_in_thread: true`）。
 *   真发要显式 `--real-im`（本机没有测试群，默认不发）。
 *
 * 产物：server/data/selftest/group-thread-e2e/report.json
 *   （含每个场景的 checks、业务表实际值、出站消息、项目代码自己的日志事件）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/test → server → <repo root>
const repoRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.resolve(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'run';
const flags = {};
for (let index = mode === argv[0] ? 1 : 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1; } else { flags[key] = true; }
}
const flag = (name, fallback) => (flags[name] === undefined ? fallback : flags[name]);
const only = String(flag('only', '') || '').split(',').map((item) => item.trim()).filter(Boolean);
const showLogs = Boolean(flags['show-logs']);

// ── 日志：拦住项目代码的结构化日志（它们是"项目代码跑过了"的证据）──────────────
const capturedLogs = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(args[0]);
        if (parsed && parsed.event) {
          capturedLogs.push(parsed);
          if (showLogs) originalConsole[level](args[0]);
          return;
        }
      } catch (_error) { /* 不是结构化日志，原样输出 */ }
    }
    originalConsole[level](...args);
  };
}
const say = (...args) => originalConsole.log(...args);
const line = (char = '─') => say(char.repeat(78));
const head = (title) => { say(''); line('═'); say(`  ${title}`); line('═'); };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const fingerprint = (value) => {
  const raw = String(value || '');
  return raw ? `${raw.slice(0, 6)}…(len=${raw.length})` : '<empty>';
};

// ── 环境变量（必须在 require 业务模块之前：schema 是 require 时求值的）─────────
const loadEnv = () => {
  const sources = [];
  for (const item of [
    { label: '<repo>/.env', file: path.join(repoRoot, '.env'), override: false },
    { label: `--env-file ${flag('env-file', '')}`, file: flag('env-file', ''), override: false },
    { label: '<repo>/.env.local', file: path.join(repoRoot, '.env.local'), override: true },
  ]) {
    if (!item.file) continue;
    if (!fs.existsSync(item.file)) { sources.push(`${item.label}（不存在，跳过）`); continue; }
    const result = dotenv.config({ path: item.file, override: item.override, quiet: true });
    sources.push(`${item.label}（注入 ${Object.keys(result.parsed || {}).length} 项）`);
  }
  return sources;
};
const envSources = loadEnv();

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const lark = require('@larksuiteoapi/node-sdk');
const { person, relation } = require('../src/services/v1ReferenceResolver');
// ⛔ 2026-10-09：原先这里 import 的是 `purchaseReportBehaviorPolicy`（「采购行为」分流）
//   与 `PurchaseWebhookService`（s4/s5 采购报单/退货场景用的）—— 那两个场景随
//   「信息填写」整表删除一起退场，本脚本现在**只跑销售侧场景**，两个 import 都不再需要。
//   （策略模块本身**还在**：改名成 `services/purchaseBehaviorPolicy.js`，
//     现役调用方是 `services/purchaseQueryService`。）
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { LarkMvpService, idFor } = require('../src/services/larkMvpService');
const { normalizeAfterSalesResult } = require('../src/services/doubaoService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService, STOCK_MOVEMENTS, MOVEMENT_SALE_RETURN, MOVEMENT_SALE_CASH,
  MOVEMENT_PURCHASE_DECREASE } = require('../src/services/inventoryService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const dims = require('../src/config/salesStatusDimensions');
const { AFTER_SALES_CARD_ACTIONS, AFTER_SALES_TASK_STATUS } = require('../src/config/afterSalesFlow');
const { larkLogger } = require('../src/utils/larkLogger');

// ── 参数常量（测试标识，不是凭证）──────────────────────────────────────────────
// 「录单人」是飞书的**人员字段**：写一个不存在的 open_id 会让建单直接
// `UserFieldConvFail (1254066)`（第一次跑就是这么失败的）。
// 所以这里**跑起来时**从测试 Base 已有的销售主表里取一个真实 open_id 当模拟操作人
// （只在本地当"发消息的人"，不外发、不打印）。
let operatorOpenId = '';
const CHAT_ID = 'oc_e2e_sales_group_test';

const personIdOf = (cell) => {
  if (Array.isArray(cell)) {
    for (const item of cell) { const id = personIdOf(item); if (id) return id; }
    return '';
  }
  if (cell && typeof cell === 'object') return cell.id || cell.open_id || '';
  return '';
};

const pickRealOperatorOpenId = async (gateway) => {
  const fields = gateway.table('salesEntry').fields;
  const entries = await gateway.listAll('salesEntry');
  for (const record of entries) {
    const id = personIdOf(record.fields?.[fields.sender]);
    if (id) return { openId: id, source: `测试 Base 销售主表已有记录的「录单人」` };
  }
  return { openId: '', source: '' };
};

// ── 环境闸门 ────────────────────────────────────────────────────────────────
// 🔴 这里**不硬编码任何 token**（AGENTS.md 第 7 条）。两道闸门：
//   ① 主闸门：写入目标必须**逐字等于** `FEISHU_V1_E2E_TEST_APP_TOKEN`（授权可写的测试 Base）。
//      它天然挡住了生产 Base —— 除了"有人把两个变量都指向生产"这种蓄意行为。
//   ② 皮带：如果环境里给了**禁止写入清单**（`FEISHU_V1_FORBIDDEN_APP_TOKENS`，
//      逗号分隔；也可以是单数的 `FEISHU_V1_PROD_APP_TOKEN`），命中即拒绝。
//      ⚠️ 本机 `.env` **刻意不放生产 token**（AGENTS.md 第 8 条：物理上够不着），
//      所以这条皮带在本机是"空转"的；装到服务器上时把生产 app_token 填进
//      `FEISHU_V1_FORBIDDEN_APP_TOKENS` 就同时有了"== 生产 → 拒绝"这条。
const forbiddenAppTokens = () => String(
  process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '',
).split(',').map((item) => item.trim()).filter(Boolean);

const guardEnvironment = () => {
  const target = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
  const authorizedTestBase = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim().toLowerCase();
  if (!target) throw new Error('缺少 FEISHU_V1_BITABLE_APP_TOKEN，无法确定写入目标');
  if (!authorizedTestBase) throw new Error('缺少 FEISHU_V1_E2E_TEST_APP_TOKEN（授权可写的测试 Base），拒绝运行');
  const forbidden = forbiddenAppTokens();
  if (forbidden.includes(target)) {
    throw new Error(`检测到 app_token 在【禁止写入清单】里（生产 Base ${fingerprint(target)}）—— 本脚本只允许写测试 Base，已拒绝运行`);
  }
  if (target !== authorizedTestBase) {
    throw new Error(
      `写入目标与【授权测试 Base】不一致，拒绝运行：` +
      `FEISHU_V1_BITABLE_APP_TOKEN=${fingerprint(target)} vs ` +
      `FEISHU_V1_E2E_TEST_APP_TOKEN=${fingerprint(authorizedTestBase)}`,
    );
  }
  if (targetEnv !== 'test' && !flags['force-env']) {
    throw new Error(`FEISHU_TARGET_ENV 必须是 test（当前 "${targetEnv}"），拒绝运行`);
  }
  return { target, targetEnv, forbiddenCount: forbidden.length };
};

// ── IM 替身：记录出站 payload，不外发 ─────────────────────────────────────────
const makeImSim = () => {
  const replies = [];
  const creates = [];
  const patches = [];
  const reactions = [];
  const images = [];
  const uploads = [];
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
    replies.push({
      parent_message_id: parent, message_id: messageId, msg_type: data?.msg_type || '',
      reply_in_thread: data?.reply_in_thread === true, thread_id: threadId,
      content: data?.content || '',
    });
    return { code: 0, msg: 'ok', data: { message_id: messageId, ...(threadId ? { thread_id: threadId } : {}) } };
  };
  const create = async ({ params, data } = {}) => {
    const messageId = nextId('om_create');
    creates.push({ message_id: messageId, receive_id: data?.receive_id || '',
      receive_id_type: params?.receive_id_type || '', msg_type: data?.msg_type || '',
      content: data?.content || '' });
    return { code: 0, msg: 'ok', data: { message_id: messageId } };
  };
  const patch = async ({ path: p, data } = {}) => {
    patches.push({ message_id: p?.message_id || '', content: data?.content || '' });
    return { code: 0, msg: 'ok', data: {} };
  };
  const im = {
    // 采购链路发图前要先把 PNG 传到飞书拿 image_key。这里是替身：**不真传**，
    // 只记下"收到了多少字节"，证明项目代码确实渲染并上传了那张图。
    image: {
      create: async ({ data } = {}) => {
        images.push({ bytes: data?.image?.length || 0, image_type: data?.image_type || '' });
        return { code: 0, msg: 'ok', data: { image_key: `img_sim_${images.length}` } };
      },
    },
    message: { reply, create, patch },
    messageReaction: {
      create: async ({ path: p, data } = {}) => {
        reactions.push({ message_id: p?.message_id || '', emoji_type: data?.reaction_type?.emoji_type || '' });
        return { code: 0, msg: 'ok', data: {} };
      },
    },
    v1: { message: { patch } },
  };
  return { im, replies, creates, patches, reactions, images, uploads, threadsByParent };
};

// ⚠️ 为什么要有它：飞书有些失败是**HTTP 层**的（SDK 直接抛 axios 错），任务记录里只会留下
//    `Request failed with status code 400` 这种**查不动**的一句话。这个代理把出错的接口、
//    HTTP 状态、飞书的 code/msg、URL 一起记下来 —— 沿用 `e2e-run.mjs` 里已有的那条做法。
const wrapApiForDiagnostics = (target, prefix, sink) => {
  if (!target || typeof target !== 'object') return target;
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop);
      if (typeof value === 'function') {
        return async (...args) => {
          try {
            return await value.apply(obj, args);
          } catch (error) {
            const payload = error?.response?.data || {};
            sink.push({
              api: `${prefix}.${String(prop)}`,
              status: error?.response?.status ?? null,
              code: payload?.code ?? error?.code ?? null,
              msg: String(payload?.msg || error?.message || '').slice(0, 300),
              url: String(error?.response?.config?.url || ''),
              at: new Date().toISOString(),
            });
            throw error;
          }
        };
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return wrapApiForDiagnostics(value, `${prefix}.${String(prop)}`, sink);
      }
      return value;
    },
  });
};

// 真 client（bitable / drive 走真的）＋ IM 换成替身：同一份 client 对象两种用途
const makeClient = (sim, apiErrors = []) => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const real = new lark.Client({ appId, appSecret, logger: larkLogger });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'im') return sim.im;
      if (prop === 'bitable') return wrapApiForDiagnostics(target.bitable, 'bitable', apiErrors);
      if (prop === 'drive') return wrapApiForDiagnostics(target.drive, 'drive', apiErrors);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

// ── 断言收集 ────────────────────────────────────────────────────────────────
const makeScenario = (key, name, expectation) => ({
  key, name, expectation, checks: [], data: {}, logs: [], notes: [], error: '',
});

const normalize = (value) => {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'number') return `#${value}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
};

const check = (scenario, label, expected, actual, passOverride) => {
  const pass = passOverride === undefined
    ? JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual))
    : Boolean(passOverride);
  scenario.checks.push({ label, expected, actual, pass });
  return pass;
};

const note = (scenario, text) => { scenario.notes.push(text); };

// 只保留本场景窗口内（processSalesTask 走完）产生的日志：
// 用 "从发起这条群消息" 到 "读回结果" 之间的日志，避免把别的场景的串进来。
const logsSince = (from) => capturedLogs.slice(from);
const eventsOf = (logs, names) => logs.filter((entry) => names.includes(entry.event));

// ── Harness ────────────────────────────────────────────────────────────────
const makeHarness = ({ label }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-group-thread-${label}-`));
  const store = new JsonTaskStore({ dir: path.join(dir, 'lark_mvp_tasks'), idField: 'task_id' });
  const salesGroupThreads = new SalesGroupThreadLocator({
    store: new JsonTaskStore({ dir: path.join(dir, 'sales_group_threads'), idField: 'task_id' }),
  });
  const afterSalesStore = new JsonTaskStore({ dir: path.join(dir, 'after_sales'), idField: 'operation_id' });
  const sim = makeImSim();
  const apiErrors = [];
  const client = makeClient(sim, apiErrors);
  const gateway = new V1BitableGateway({ client });
  // ⭐ **完全自足**：库存操作 / 售后 / 二次交付 三份本地落盘都进本次的临时目录，
  //    **一个字节都不写 `server/data/*`**（那是生产口径的落盘位置）。
  //    为什么必须这样（2026-10-07 实测踩到）：这三个 service 的**默认** store 目录是
  //    `server/data/...`；只要那个目录在跑的过程中被别的进程动过（那次是 worktree 被清理），
  //    链路就会以 `ENOENT: ... scandir .../data/inventory_operations` 这种**与业务无关**的
  //    方式失败（售后执行器报错、交付只完成一半 → 补样品卡片也不出现）。
  //    自测必须能把「代码有问题」和「环境被动了」分开 —— 所以状态一律落在自己手里。
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: path.join(dir, 'inventory_operations'), idField: 'operation_id' }),
  });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const service = new LarkMvpService({
    client, gateway, store, salesGroupThreads, delivery,
    secondDelivery: new SecondDeliveryService({
      gateway, delivery,
      store: new JsonTaskStore({ dir: path.join(dir, 'second_delivery_reminder'), idField: 'task_id' }),
    }),
    // 售后执行器单独一个本地存储目录（生产上它也是自己一份，不与销售任务混）
    afterSales: new AfterSalesService({ gateway, inventory, store: afterSalesStore }),
  });
  return { label, dir, store, afterSalesStore, salesGroupThreads, sim, client, gateway, service, inventory, apiErrors };
};

const sendGroupMessage = async (h, { text, messageId, threadId = '', parentId = '' }) => {
  const event = {
    message: {
      message_id: messageId, chat_id: CHAT_ID, chat_type: 'group', message_type: 'text',
      create_time: String(Date.now()), thread_id: threadId, parent_id: parentId,
      mentions: [], content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: operatorOpenId } },
  };
  const accepted = await h.service.acceptMessage(event);
  return { accepted, taskId: idFor('sale', messageId) };
};

const waitFor = async (predicate, { timeoutMs = 180_000, intervalMs = 400, label = '等待' } = {}) => {
  const started = Date.now();
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} 超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
};

const waitTask = (h, taskId, predicate, options = {}) =>
  waitFor(async () => {
    const task = await h.store.get(taskId);
    return task && predicate(task) ? task : null;
  }, { label: `任务 ${taskId}`, ...options });

const SALE_TERMINAL = (task) =>
  ['needs_info', 'failed', 'ignored', 'posted', 'posted_delivery_pending', 'query_answered',
    'progress_applied', 'progress_failed'].includes(task.status)
  || String(task.status || '').startsWith('after_sales_')
  || (task.status === 'ready_to_confirm' && Boolean(task.card_message_id));

const AFTER_SALES_TERMINAL = (task) =>
  [AFTER_SALES_TASK_STATUS.DONE, AFTER_SALES_TASK_STATUS.CANCELLED, AFTER_SALES_TASK_STATUS.ASKING]
    .includes(task.status);

const confirmCard = (h, { taskId, cardMessageId, action = 'confirm_sale' }) =>
  h.service.handleCardAction({
    action: { value: { draft_id: taskId, action } },
    operator: { operator_id: { open_id: operatorOpenId } },
    context: { open_message_id: cardMessageId },
  }, { interactionId: `itx_${action}_${taskId}` });

// ── 读回：四个字段 / 明细 / 收款 / 库存流水 / 实时库存 ──────────────────────────
const readEntry = async (h, salesEntryRecordId) => {
  const fields = h.gateway.table('salesEntry').fields;
  const entry = await h.gateway.get('salesEntry', salesEntryRecordId);
  return {
    record_id: salesEntryRecordId,
    order_no: textValue(entry?.fields?.[fields.orderNo]),
    原话: textValue(entry?.fields?.[fields.originalText]),
    交易类型: textValue(entry?.fields?.[fields.tradeType]),
    dims: {
      确认状态: dims.userActionOf(entry, fields),
      销售状态: dims.salesStatusOf(entry, fields),
      资金状态: dims.postedOf(entry, fields),
      库存状态: dims.stockStatusOf(entry, fields),
    },
    failure: textValue(entry?.fields?.[fields.failureReason]),
  };
};

const readDetailsOf = async (h, salesEntryRecordId) => {
  const fields = h.gateway.table('salesDetail').fields;
  const all = await h.gateway.listAll('salesDetail');
  return all
    .filter((record) => linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId))
    .map((record) => detailRowOf(record, fields));
};

// 按 record_id 直接读销售明细（售后新建的行关联的是**原主表**，不能按新主表反查）
const readDetailsByIds = async (h, recordIds = []) => {
  const fields = h.gateway.table('salesDetail').fields;
  const rows = [];
  for (const recordId of recordIds) {
    const record = await h.gateway.get('salesDetail', recordId);
    if (record) rows.push(detailRowOf(record, fields));
  }
  return rows;
};

const detailRowOf = (record, fields) => ({
  record_id: record.record_id,
  履约状态: textValue(record.fields?.[fields.fulfillmentStatus]),
  成交金额: textValue(record.fields?.[fields.actualAmount]),
  交易类型: textValue(record.fields?.[fields.tradeType]),
  货品: textValue(record.fields?.[fields.product]),
  配品: textValue(record.fields?.[fields.accessory]),
  尺码: textValue(record.fields?.[fields.size]),
  销售日: textValue(record.fields?.[fields.soldAt]),
});

const readPaymentsOf = async (h, salesEntryRecordId) => {
  const fields = h.gateway.table('paymentRecord').fields;
  const all = await h.gateway.listAll('paymentRecord');
  return all
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

const readLedgerForDetails = async (h, detailRecordIds) => {
  const fields = h.gateway.table('inventoryLedger').fields;
  const wanted = new Set(detailRecordIds);
  const all = await h.gateway.listAll('inventoryLedger');
  return all
    .filter((record) => linkedRecordIds(record.fields?.[fields.salesDetail]).some((id) => wanted.has(id)))
    .map((record) => ({
      record_id: record.record_id,
      库存行为: textValue(record.fields?.[fields.behavior]),
      变动数量: textValue(record.fields?.[fields.quantityChange]),
      库存键: textValue(record.fields?.[fields.stockKey]),
      关联销售: linkedRecordIds(record.fields?.[fields.salesDetail]),
    }));
};

// 按 record_id 直接读「库存流水」（售后这次**真正写的那几条**）：
// 只按来源明细筛选会把首次销售那条「销售减少」也捞进来（换货的原行同时挂着两条）。
const readLedgerByIds = async (h, recordIds = []) => {
  const fields = h.gateway.table('inventoryLedger').fields;
  const rows = [];
  for (const recordId of recordIds) {
    const record = await h.gateway.get('inventoryLedger', recordId);
    if (!record) continue;
    rows.push({
      record_id: record.record_id,
      库存行为: textValue(record.fields?.[fields.behavior]),
      变动数量: textValue(record.fields?.[fields.quantityChange]),
      库存键: textValue(record.fields?.[fields.stockKey]),
      关联销售: linkedRecordIds(record.fields?.[fields.salesDetail]),
    });
  }
  return rows;
};

// 实时库存按「货品记录 + 尺码记录」快照（与实时库存索引同一套定位口径）
const liveSnapshot = async (h) => {
  const fields = h.gateway.table('liveInventory').fields;
  const rows = await h.gateway.listAll('liveInventory');
  return rows.map((record) => ({
    record_id: record.record_id,
    productRecordId: linkedRecordIds(record.fields?.[fields.product])[0] || '',
    sizeRecordId: linkedRecordIds(record.fields?.[fields.size])[0] || '',
    state: textValue(record.fields?.[fields.state]),
    stockKey: textValue(record.fields?.[fields.stockKey]),
  }));
};

const liveOfPair = (snapshot, productRecordId, sizeRecordId) => {
  const rows = snapshot.filter((row) => row.productRecordId === productRecordId && row.sizeRecordId === sizeRecordId);
  const byState = {};
  for (const row of rows) byState[row.state] = (byState[row.state] || 0) + 1;
  return { total: rows.length, byState };
};

const diffLive = (before, after) => {
  const states = [...new Set([...Object.keys(before.byState), ...Object.keys(after.byState)])].sort();
  const delta = {};
  for (const state of states) delta[state] = (after.byState[state] || 0) - (before.byState[state] || 0);
  return { total: after.total - before.total, byState: delta };
};

// ── 测试 Base 只读盘点（挑数据用）─────────────────────────────────────────────
const collectStockCandidates = async (gateway) => {
  const liveFields = gateway.table('liveInventory').fields;
  const productFields = gateway.table('product').fields;
  const [liveRows, products] = await Promise.all([
    gateway.listAll('liveInventory'),
    gateway.listAll('product'),
  ]);
  const byId = new Map(products.map((record) => [record.record_id, record]));
  const groups = new Map();
  for (const record of liveRows) {
    const productRecordId = linkedRecordIds(record.fields?.[liveFields.product])[0] || '';
    const sizeRecordId = linkedRecordIds(record.fields?.[liveFields.size])[0] || '';
    const state = textValue(record.fields?.[liveFields.state]);
    const stockKey = textValue(record.fields?.[liveFields.stockKey]);
    if (!productRecordId || !sizeRecordId) continue;
    const key = `${productRecordId}|${sizeRecordId}`;
    if (!groups.has(key)) {
      const product = byId.get(productRecordId);
      const itemNo = textValue(product?.fields?.[productFields.itemNo]);
      const color = textValue(product?.fields?.[productFields.color]);
      const price = Number(textValue(product?.fields?.[productFields.price])) || null;
      groups.set(key, {
        key, productRecordId, sizeRecordId, stockKey, itemNo, color, price,
        size: Number(String(stockKey).split('|')[3]) || null,
        states: {},
      });
    }
    const group = groups.get(key);
    group.states[state] = (group.states[state] || 0) + 1;
  }
  return [...groups.values()]
    .map((group) => ({ ...group, doorBox: group.states['门盒'] || 0, sample: group.states['样品'] || 0,
      warehouse: group.states['仓库'] || 0 }))
    .filter((group) => group.itemNo && group.size)
    // 同一货号+尺码有**两个颜色**时，确认卡片会要求先选颜色（`needs_color`）——
    // 那不是本任务的场景，而且选色卡片只能点、不能靠文字，所以挑数据时排除掉。
    .map((group, _index, all) => ({
      ...group,
      uniqueColor: all.filter((item) => item.itemNo === group.itemNo && item.size === group.size).length === 1,
    }))
    .sort((left, right) => (right.doorBox - left.doorBox) || left.itemNo.localeCompare(right.itemNo));
};

// 已经有过销售明细的「货号|颜色」集合：售后按货号+颜色定位，如果这一款已经卖过，
// 候选就会有多条（她得说"第 N 笔"，那不在本任务的六场景里）。
// ⇒ 挑数据时直接排除掉"卖过的款"，保证售后定位唯一。
const collectSoldItemColors = async (gateway) => {
  const salesDetail = gateway.table('salesDetail').fields;
  const product = gateway.table('product').fields;
  const [details, products] = await Promise.all([
    gateway.listAll('salesDetail'), gateway.listAll('product'),
  ]);
  const byId = new Map(products.map((record) => [record.record_id, record]));
  const sold = new Set();
  for (const detail of details) {
    const productId = linkedRecordIds(detail.fields?.[salesDetail.product])[0] || '';
    const record = byId.get(productId);
    if (!record) continue;
    const itemNo = textValue(record.fields?.[product.itemNo]);
    const color = textValue(record.fields?.[product.color]);
    if (itemNo) sold.add(`${itemNo}|${color}`);
  }
  return sold;
};

// 「行为管理」是库存引擎的**闸门**，两列都会拦：
//   · 「库存方向」必须与代码注册表（`STOCK_MOVEMENTS`）一致；
//   · 「是否启用」必须是勾上的（`=== true`）。
// 任一不满足，`InventoryService.resolveStockBehavior` 会当场抛错 —— 它不猜、也不静默扣错。
// 实测（2026-10-06）：**测试 Base** 的「销售退货」(SALE_RETURN) 这两列**都没配**
// （方向空、未启用）→ 售后执行器在"退回的鞋回库"那一步直接失败。
// 生产表的这两列据代码注释是「增加 + 启用」。这是**测试 Base 与生产不一致**，不是代码问题
// ⇒ 本脚本在测试 Base 里显式补齐，并**在报告里如实列出改了哪一行**（生产 Base 一个字都不写）。
const ensureBehaviorDirections = async (gateway, { fixKinds = [] } = {}) => {
  const fields = gateway.table('behavior').fields;
  const records = await gateway.listAll('behavior');
  const byCode = new Map(records.map((record) =>
    [textValue(record.fields?.[fields.code]).trim(), record]));
  const mismatches = [];
  const fixed = [];
  const fix = async (record, patch, entry) => {
    await gateway.update('behavior', record.record_id, patch);
    fixed.push(entry);
  };
  for (const [kind, movement] of Object.entries(STOCK_MOVEMENTS)) {
    const record = byCode.get(kind);
    if (!record) {
      mismatches.push({ kind, name: '(缺记录)', issue: '记录不存在', expected: movement.direction });
      continue;
    }
    const name = textValue(record.fields?.[fields.name]).trim();
    const current = textValue(record.fields?.[fields.stockDirection]).trim();
    if (current !== movement.direction) {
      mismatches.push({ kind, name, issue: '库存方向', current: current || '(空)', expected: movement.direction });
      if (fixKinds.includes(kind)) {
        await fix(record, { stockDirection: movement.direction },
          { kind, name, from: current || '(空)', to: movement.direction, field: '库存方向' });
      }
    }
    if (record.fields?.[fields.enabled] !== true) {
      mismatches.push({ kind, name, issue: '是否启用', current: '未启用', expected: '启用' });
      if (fixKinds.includes(kind)) {
        await fix(record, { enabled: true },
          { kind, name, from: '未启用', to: '启用', field: '是否启用' });
      }
    }
  }
  return { mismatches, fixed };
};

// 同一货号 + 颜色，已有多少条销售明细（售后按货号定位时会不会撞车）
const recentSalesOf = async (gateway, itemNo, color) => {
  const salesDetail = gateway.table('salesDetail').fields;
  const product = gateway.table('product').fields;
  const salesEntry = gateway.table('salesEntry').fields;
  const [details, products, entries] = await Promise.all([
    gateway.listAll('salesDetail'), gateway.listAll('product'), gateway.listAll('salesEntry'),
  ]);
  const productById = new Map(products.map((record) => [record.record_id, record]));
  const entryById = new Map(entries.map((record) => [record.record_id, record]));
  const rows = [];
  for (const detail of details) {
    const productId = linkedRecordIds(detail.fields?.[salesDetail.product])[0] || '';
    const record = productById.get(productId);
    if (textValue(record?.fields?.[product.itemNo]) !== itemNo) continue;
    if (color && textValue(record?.fields?.[product.color]) !== color) continue;
    const entryId = linkedRecordIds(detail.fields?.[salesDetail.salesEntry])[0] || '';
    rows.push({
      detail_record_id: detail.record_id,
      sales_status: textValue(entryById.get(entryId)?.fields?.[salesEntry.sales]),
      trade_type: textValue(detail.fields?.[salesDetail.tradeType]),
    });
  }
  return rows;
};

// ── inspect ────────────────────────────────────────────────────────────────
const cmdInspect = async () => {
  const guard = guardEnvironment();
  head('inspect：测试 Base 现状（只读，不写任何表）');
  say(`  worktree            ：${repoRoot}`);
  say(`  .env 来源           ：${envSources.join(' / ')}`);
  say(`  写入目标 app_token  ：${fingerprint(guard.target)}`);
  say(`  FEISHU_TARGET_ENV   ：${guard.targetEnv}`);
  const gateway = new V1BitableGateway();
  const candidates = await collectStockCandidates(gateway);
  say('');
  say(`  实时库存「门盒」有货的 (货品, 尺码) 组合，共 ${candidates.length} 个，前 20：`);
  for (const item of candidates.slice(0, 20)) {
    say(`    ${item.itemNo.padEnd(10)} ${String(item.color).padEnd(4)} ${String(item.size).padEnd(3)}码  `
      + `门盒=${item.doorBox} 样品=${item.sample} 仓库=${item.warehouse} 单价=${item.price ?? '—'}  `
      + `product=${item.productRecordId} size=${item.sizeRecordId}`);
  }
  const fieldTypes = {};
  for (const tableKey of ['salesEntry', 'salesDetail', 'paymentRecord', 'inventoryLedger', 'liveInventory']) {
    const fields = await gateway.listFields(tableKey);
    fieldTypes[tableKey] = fields.map((f) => ({ name: f.field_name, type: f.type, ui: f.ui_type }));
  }
  say('');
  say('  字段类型（只读 appTableField.list）：');
  for (const [tableKey, list] of Object.entries(fieldTypes)) {
    const interesting = list.filter((f) => /销售日|录单日|收款时间|确认状态|销售状态|资金状态|库存状态|创建时间/.test(f.name));
    say(`    ${tableKey}: ${interesting.map((f) => `${f.name}(type=${f.type})`).join(' · ') || '—'}`);
  }
  const behaviors = await gateway.listAll('behavior');
  const behaviorFields = gateway.table('behavior').fields;
  say('');
  say('  行为管理（名称 / 编码 / 方向 / 启用）：');
  for (const record of behaviors) {
    say(`    ${textValue(record.fields?.[behaviorFields.name]).padEnd(20)} `
      + `${textValue(record.fields?.[behaviorFields.code]).padEnd(26)} `
      + `库存方向=${textValue(record.fields?.[behaviorFields.stockDirection]) || '—'} `
      + `启用=${textValue(record.fields?.[behaviorFields.enabled]) || '—'}`);
  }
  const paymentMethods = await gateway.listAll('paymentMethod');
  say('');
  say(`  收款方式：${paymentMethods.map((r) => textValue(r.fields?.[gateway.table('paymentMethod').fields.name])).join(' / ')}`);
  const [entries, details, payments] = await Promise.all([
    gateway.listAll('salesEntry'), gateway.listAll('salesDetail'), gateway.listAll('paymentRecord'),
  ]);
  say('');
  say(`  测试 Base 现有：销售主表 ${entries.length} 条 · 销售明细 ${details.length} 条 · 收款明细 ${payments.length} 条`);

  // ⛔ 2026-10-09：这里原有「采购侧的只读前置（s4 / s5 需要）」——
  //   那两个场景（采购报单 / 采购退货）随「信息填写」整表删除一起退场，
  //   本脚本现在**只跑销售侧场景**。这里只留两行与销售场景无关的环境指纹。
  say('');
  say(`  采购群 PURCHASE_CHAT_ID：${fingerprint(process.env.PURCHASE_CHAT_ID)}`);
  say(`  禁止写入清单（生产 app_token）：${forbiddenAppTokens().length} 个`);
  return { candidates, fieldTypes };
};

// ── 场景通用：新开一笔（主群 @ / 像销售）─────────────────────────────────────
const startSale = async (h, { text, messageId, expectDeliver }) => {
  const logsFrom = capturedLogs.length;
  const { accepted, taskId } = await sendGroupMessage(h, { text, messageId });
  const task = await waitTask(h, taskId, SALE_TERMINAL, { label: `解析 ${messageId}` });
  const cardReply = h.sim.replies.filter((reply) => reply.reply_in_thread).slice(-1)[0] || null;
  return { accepted, taskId, task, logsFrom, cardReply };
};

const confirmAndRead = async (h, { taskId, cardMessageId, salesEntryRecordId, detailIdsBefore }) => {
  const logsFrom = capturedLogs.length;
  const toast = await confirmCard(h, { taskId, cardMessageId });
  const task = await waitTask(h, taskId,
    (row) => ['posted', 'posted_delivery_pending'].includes(row.status) || Boolean(row.posting_error),
    { label: `入账 ${taskId}` });
  const entry = await readEntry(h, salesEntryRecordId);
  const details = await readDetailsOf(h, salesEntryRecordId);
  const payments = await readPaymentsOf(h, salesEntryRecordId);
  const ledger = await readLedgerForDetails(h, details.map((row) => row.record_id));
  void detailIdsBefore;
  return { toast, task, entry, details, payments, ledger, logs: logsSince(logsFrom) };
};

// ── 场景②：现货 × 3 ─────────────────────────────────────────────────────────
const runSpotScenario = async ({ key, name, textFor, picks, expect }) => {
  const scenario = makeScenario(key, name, expect.expectation);
  const h = makeHarness({ label: key });
    scenario.data.api_errors = h.apiErrors;
  try {
    const text = textFor(picks);
    scenario.data.text = text;
    const liveBefore = await liveSnapshot(h);
    const started = await startSale(h, { text, messageId: `om_e2e_${key}` });
    scenario.data.accepted = started.accepted;
    scenario.data.task_status_after_parse = started.task.status;
    scenario.data.draft = {
      trade_type: started.task.draft?.trade_type,
      delivery_status: started.task.draft?.delivery_status,
      items: (started.task.draft?.items || []).map((item) => ({
        item_no: item.item_no, color: item.color, size: item.size, actual_amount: item.actual_amount,
      })),
      payments: started.task.draft?.payments,
      owed: started.task.draft?.owed,
      missing_fields: started.task.draft?.missing_fields,
    };
    check(scenario, '解析出卡片（task.status = ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    // ① 话题形式回复：第一张卡片就是 reply_in_thread 的回复
    check(scenario, '卡片回复走话题（reply_in_thread: true）', true, Boolean(started.cardReply?.reply_in_thread));
    check(scenario, '话题 id 回带并被本地映射记住', true,
      Boolean(await h.salesGroupThreads.findByMessageId(`om_e2e_${key}`).then((r) => r?.thread_id)));

    const result = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id,
    });
    const liveAfter = await liveSnapshot(h);

    scenario.data.entry = result.entry;
    scenario.data.details = result.details;
    scenario.data.payments = result.payments;
    scenario.data.ledger = result.ledger;
    scenario.data.toast = result.toast?.toast?.content;
    scenario.data.posting_error = result.task.posting_error || '';
    scenario.data.inventory = picks.map((pick) => ({
      pick: `${pick.itemNo}${pick.color}${pick.size}码`,
      before: liveOfPair(liveBefore, pick.productRecordId, pick.sizeRecordId),
      after: liveOfPair(liveAfter, pick.productRecordId, pick.sizeRecordId),
      delta: diffLive(
        liveOfPair(liveBefore, pick.productRecordId, pick.sizeRecordId),
        liveOfPair(liveAfter, pick.productRecordId, pick.sizeRecordId),
      ),
    }));
    scenario.logs = eventsOf(result.logs, ['v1.sale.posted', 'inventory.change.applied',
      'bitable.record.created', 'bitable.record.updated', 'sales.delivery.completed',
      'sales.status.written']);

    check(scenario, '销售明细条数', expect.detailCount, result.details.length);
    check(scenario, '收款明细条数', expect.paymentCount, result.payments.length);
    check(scenario, '明细履约状态', expect.detailStatus, result.details.map((row) => row.履约状态));
    check(scenario, '收款状态', expect.paymentStatus, result.payments.map((row) => row.收款状态));
    check(scenario, '四个字段', expect.dims, result.entry.dims);
    check(scenario, '库存流水（库存行为 / 变动数量）', expect.ledger, result.ledger.map((row) => ({
      库存行为: row.库存行为, 变动数量: row.变动数量,
    })));
    check(scenario, '实时库存变化（门盒）', expect.liveDoorBoxDelta,
      scenario.data.inventory.reduce((sum, row) => sum + (row.delta.byState['门盒'] || 0), 0));
    if (result.task.posting_error) scenario.error = result.task.posting_error;
    return scenario;
  } catch (error) {
    scenario.error = error.message;
    return scenario;
  }
};

// ── 场景③④：预付 / 未付（首次写入 + 话题里的"成交"）──────────────────────────
const runDeferredScenario = async ({ key, name, text, pick, expect }) => {
  const scenario = makeScenario(key, name, expect.expectation);
  const h = makeHarness({ label: key });
    scenario.data.api_errors = h.apiErrors;
  try {
    const liveBefore = await liveSnapshot(h);
    const started = await startSale(h, { text, messageId: `om_e2e_${key}` });
    scenario.data.text = text;
    scenario.data.draft = {
      trade_type: started.task.draft?.trade_type,
      delivery_status: started.task.draft?.delivery_status,
      items: started.task.draft?.items?.length,
      payments: started.task.draft?.payments,
      owed: started.task.draft?.owed,
    };
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    check(scenario, '卡片回复走话题（reply_in_thread: true）', true, Boolean(started.cardReply?.reply_in_thread));
    const threadId = started.cardReply?.thread_id || '';

    const first = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id,
    });
    const liveAfterFirst = await liveSnapshot(h);
    scenario.data.first = {
      entry: first.entry, details: first.details, payments: first.payments, ledger: first.ledger,
      inventory: {
        before: liveOfPair(liveBefore, pick.productRecordId, pick.sizeRecordId),
        after: liveOfPair(liveAfterFirst, pick.productRecordId, pick.sizeRecordId),
      },
      toast: first.toast?.toast?.content,
      logs: eventsOf(first.logs, ['v1.sale.posted', 'inventory.change.applied']).map((e) => e.event),
    };
    check(scenario, '首次：销售明细条数', expect.detailCount, first.details.length);
    check(scenario, '首次：收款明细条数', expect.firstPaymentCount, first.payments.length);
    check(scenario, '首次：明细履约状态', expect.firstDetailStatus,
      first.details.map((row) => row.履约状态));
    check(scenario, '首次：收款状态（含金额）', expect.firstPaymentStatus,
      first.payments.map((row) => `${row.收款状态}/${row.收款金额}`).sort());
    check(scenario, '首次：四个字段', expect.firstDims, first.entry.dims);
    check(scenario, '首次：实时库存门盒变化', expect.firstLiveDoorBoxDelta,
      (liveOfPair(liveAfterFirst, pick.productRecordId, pick.sizeRecordId).byState['门盒'] || 0)
      - (liveOfPair(liveBefore, pick.productRecordId, pick.sizeRecordId).byState['门盒'] || 0));

    // ── 话题里说「已完毕 / 成交」（业务负责人逐字口径）──────────────────────
    const progressMessageId = `om_e2e_${key}_done`;
    const progressFrom = capturedLogs.length;
    const sent = await sendGroupMessage(h, {
      text: expect.doneText, messageId: progressMessageId, threadId,
    });
    const progressTaskId = sent.taskId;
    // ⚠️ 这条消息**可能连任务都没建**：入口闸门在"话题里已定位到销售"时放宽成
    //   「像销售 或 像那笔的进展」，两个都不是 → `acceptSalesText` 直接
    //   `not_sales_candidate` 返回（**静默、零远端调用、不建任务**）。
    //   所以这里**不能无条件 waitTask**（会白等 180 秒），先看任务建没建。
    const progressTask = await h.store.get(progressTaskId);
    if (progressTask) {
      await waitTask(h, progressTaskId, SALE_TERMINAL, { label: `成交 ${progressMessageId}` });
    }
    const progressTaskFinal = progressTask ? await h.store.get(progressTaskId) : null;
    const entryAfterWords = await readEntry(h, started.task.sales_entry_record_id);
    const detailsAfterWords = await readDetailsOf(h, started.task.sales_entry_record_id);
    const paymentsAfterWords = await readPaymentsOf(h, started.task.sales_entry_record_id);
    const liveAfterWords = await liveSnapshot(h);
    const ignoredLogs = eventsOf(logsSince(progressFrom), ['lark.message.ignored', 'lark.group.message.accepted',
      'lark.sales.accepted']).map((entry) => ({ event: entry.event, reason: entry.reason }));
    scenario.data.afterWords = {
      text: expect.doneText,
      task_created: Boolean(progressTask),
      accept_result: sent.accepted,
      task_status: progressTaskFinal?.status || '(没有建任务)',
      progress_kind: progressTaskFinal?.progress_kind || '',
      progress_reason: progressTaskFinal?.progress_reason || '',
      entry: entryAfterWords,
      details: detailsAfterWords.map((row) => row.履约状态),
      payments: paymentsAfterWords.map((row) => ({ 状态: row.收款状态, 金额: row.收款金额, 收款时间: row.收款时间 })),
      inventory: diffLive(
        liveOfPair(liveAfterFirst, pick.productRecordId, pick.sizeRecordId),
        liveOfPair(liveAfterWords, pick.productRecordId, pick.sizeRecordId),
      ),
      ignored_logs: ignoredLogs,
      logs: eventsOf(logsSince(progressFrom), ['sales.thread_progress.detected', 'sales.thread_progress.payment_recorded',
        'sales.thread_progress.delivery_applied', 'v1.sale.posted', 'inventory.change.applied',
        'sales.group.sale.dispatched', 'lark.sales.processing.thread_progress']).map((e) => ({
        event: e.event, kind: e.kind, reason: e.reason,
      })),
    };
    check(scenario, `话题里说「${expect.doneText}」：机器人真的处理了这条（建了任务/动了账）`,
      true, Boolean(progressTask),
      Boolean(progressTask));
    check(scenario, `话题里说「${expect.doneText}」：明细履约状态`, expect.afterWordsDetailStatus,
      detailsAfterWords.map((row) => row.履约状态));
    check(scenario, `话题里说「${expect.doneText}」：收款状态`, expect.afterWordsPaymentStatus,
      paymentsAfterWords.map((row) => row.收款状态).sort());
    check(scenario, `话题里说「${expect.doneText}」：有收款时间（若有已收款）`, true,
      paymentsAfterWords.filter((row) => row.收款状态 === '已收款').every((row) => Boolean(row.收款时间)),
      paymentsAfterWords.filter((row) => row.收款状态 === '已收款').every((row) => Boolean(row.收款时间)));
    check(scenario, `话题里说「${expect.doneText}」：库存变化`, expect.afterWordsLiveDoorBoxDelta,
      scenario.data.afterWords.inventory.byState['门盒'] || 0);

    // ── 再补一句**收款方式**试一次（她原话里没带方式；有待收款时必须知道钱怎么收的）──
    // 目的：把"词不认识"和"缺收款方式所以不敢记账"分开——差在哪必须说清。
    scenario.data.fallbackSteps = [];
    for (const [index, step] of (expect.fallbackTexts || []).entries()) {
      const stepId = `om_e2e_${key}_fb_${index + 1}`;
      const stepFrom = capturedLogs.length;
      const stepSent = await sendGroupMessage(h, { text: step, messageId: stepId, threadId });
      const stepTask = await h.store.get(stepSent.taskId);
      const finalTask = stepTask
        ? await waitTask(h, stepSent.taskId, SALE_TERMINAL, { label: `进展 ${stepId}` })
        : null;
      scenario.data.fallbackSteps.push({
        text: step,
        task_created: Boolean(stepTask),
        task_status: finalTask?.status || '(没有建任务)',
        progress_kind: finalTask?.progress_kind || '',
        progress_reason: finalTask?.progress_reason || '',
        logs: eventsOf(logsSince(stepFrom), ['sales.thread_progress.detected', 'sales.thread_progress.payment_recorded',
          'sales.thread_progress.delivery_applied', 'lark.message.ignored']).map((e) => ({
          event: e.event, kind: e.kind, reason: e.reason,
        })),
      });
    }
    const entryAfterFallback = await readEntry(h, started.task.sales_entry_record_id);
    const detailsAfterFallback = await readDetailsOf(h, started.task.sales_entry_record_id);
    const paymentsAfterFallback = await readPaymentsOf(h, started.task.sales_entry_record_id);
    const liveAfterFallback = await liveSnapshot(h);
    scenario.data.afterFallback = {
      entry: entryAfterFallback,
      details: detailsAfterFallback.map((row) => row.履约状态),
      payments: paymentsAfterFallback.map((row) => ({
        状态: row.收款状态, 金额: row.收款金额, 收款时间: row.收款时间,
      })),
      inventory: diffLive(
        liveOfPair(liveAfterWords, pick.productRecordId, pick.sizeRecordId),
        liveOfPair(liveAfterFallback, pick.productRecordId, pick.sizeRecordId),
      ),
    };
    check(scenario, '补一句收款方式后：明细履约状态', expect.afterFallbackDetailStatus,
      detailsAfterFallback.map((row) => row.履约状态));
    check(scenario, '补一句收款方式后：收款状态', expect.afterFallbackPaymentStatus,
      paymentsAfterFallback.map((row) => row.收款状态).sort());
    check(scenario, '补一句收款方式后：已收款那笔有收款时间', true,
      paymentsAfterFallback.filter((row) => row.收款状态 === '已收款').length > 0
      && paymentsAfterFallback.filter((row) => row.收款状态 === '已收款').every((row) => Boolean(row.收款时间)));
    check(scenario, '补一句收款方式后：实时库存门盒变化', expect.afterFallbackDoorBoxDelta,
      scenario.data.afterFallback.inventory.byState['门盒'] || 0);

    return scenario;
  } catch (error) {
    scenario.error = error.message;
    return scenario;
  }
};

// ── 场景⑤⑥：退货 / 换货 ─────────────────────────────────────────────────────
const runAfterSalesScenario = async ({ key, name, saleText, afterSalesText, pick, expect }) => {
  const scenario = makeScenario(key, name, expect.expectation);
  const h = makeHarness({ label: key });
    scenario.data.api_errors = h.apiErrors;
  try {
    scenario.data.sale_text = saleText;
    scenario.data.after_sales_text = afterSalesText;
    const liveBefore = await liveSnapshot(h);
    const started = await startSale(h, { text: saleText, messageId: `om_e2e_${key}_sale` });
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `原单没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    const threadId = started.cardReply?.thread_id || '';
    const original = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id,
    });
    scenario.data.original_entry = original.entry;
    scenario.data.original_details = original.details;
    const liveAfterSale = await liveSnapshot(h);

    // 售后在**同一个话题**里说（同一笔）—— 先走**完整入口**，看它到底走到哪
    const messageId = `om_e2e_${key}_as`;
    // ⚠️ 实测（2026-10-07 第 7 轮）：飞书偶尔回 `400 / 1254607 Data not ready, please try again later`
    //    （刚写完记录再马上读它就会这样，是**飞书侧瞬时**错误）。这一下会把售后入口当场打成 failed。
    //    ⇒ ① 等状态时给 failed 一个"稳住再看一眼"的缓冲（万一是链路自己重试成功的）；
    //       ② 如果确认是这种瞬时错误，就**像她本人那样再发一次**，并把"重发过"如实记进报告。
    //    这不放松任何业务判据：最终仍必须走到 after_sales_confirming 并跑完确认后的整条链路。
    const TRANSIENT_FEISHU = new Set([1254607, 1254600, 1255001, 99991663]);
    const apiBeforeEntry = h.apiErrors.length;
    const waitEntry = (taskId, label) => waitFor(async () => {
      const row = await h.store.get(taskId);
      if (!row) return null;
      if (row.status === AFTER_SALES_TASK_STATUS.CONFIRMING || AFTER_SALES_TERMINAL(row)) return row;
      if (row.status === 'failed') {
        await sleep(2500);                    // 稳住再看一眼：链路自己重试成功就当没失败过
        const again = await h.store.get(taskId);
        return again && again.status === 'failed' ? again : null;
      }
      return null;
    }, { label, timeoutMs: 120_000, intervalMs: 400 });

    let sendText = afterSalesText;
    let sent = await sendGroupMessage(h, { text: sendText, messageId, threadId });
    const logsFrom = capturedLogs.length;
    let entryTask = await waitEntry(sent.taskId, `售后入口 ${messageId}`);
    const transientOf = (from) => h.apiErrors.slice(from).filter((item) =>
      TRANSIENT_FEISHU.has(Number(item.code)) || Number(item.status) >= 500 || Number(item.status) === 429);
    let transientRetried = false;
    if (entryTask.status !== AFTER_SALES_TASK_STATUS.CONFIRMING && transientOf(apiBeforeEntry).length) {
      transientRetried = true;
      scenario.data.transient_entry_retry = transientOf(apiBeforeEntry);
      note(scenario, `售后入口第一次被飞书**瞬时错误**挡下（${transientOf(apiBeforeEntry)
        .map((item) => `${item.status}/${item.code} ${item.msg}`).join('；')}）→ 重发一次`);
      const retryId = `${messageId}_retry`;
      const apiBeforeRetry = h.apiErrors.length;
      sent = await sendGroupMessage(h, { text: sendText, messageId: retryId, threadId });
      entryTask = await waitEntry(sent.taskId, `售后入口 ${retryId}`);
      scenario.data.transient_entry_retry_second = transientOf(apiBeforeRetry);
    }
    scenario.data.entry_status = entryTask.status;
    scenario.data.entry_message_id = transientRetried ? `${messageId}_retry` : messageId;
    scenario.data.entry_error = entryTask.error || '';
    scenario.data.entry_logs = eventsOf(logsSince(logsFrom),
      ['lark.mvp.task.failed', 'after_sales.confirmed']).map((e) => ({ event: e.event, error: e.error }));
    check(scenario, '售后消息【走完整入口】能出确认卡片（任务进入 after_sales_confirming）',
      true, entryTask.status === AFTER_SALES_TASK_STATUS.CONFIRMING,
      entryTask.status === AFTER_SALES_TASK_STATUS.CONFIRMING);

    // ⚠️ 2026-10-06 实测：**这一步 100% 失败**（`doubaoService.parseSalesText` 的
    //    `normalized.items.length` 对售后结果读 undefined → 「销售文字解析失败」）。
    //    那是**解析层的 bug，已单独报告，这里不修**。
    //    为了让⑤⑥真正要验的东西（库存流水 / 实时库存 / 售后主表四字段 / 钱）能验完，
    //    从**链路的下一跳**继续：用项目自己的 `normalizeAfterSalesResult` 造出解析契约，
    //    再调 `AfterSalesFlowService.handle` —— **就是 processSalesTask 里那一次调用的同一个函数**。
    let task = entryTask;
    if (task.status !== AFTER_SALES_TASK_STATUS.CONFIRMING) {
      const parsed = normalizeAfterSalesResult(expect.rawParsed, afterSalesText);
      scenario.data.flow_parsed = parsed;
      await h.service.afterSalesFlow.handle(task, parsed);
      task = await h.store.get(sent.taskId);
      scenario.data.after_sales_recovered_from = 'next_hop';
    }
    scenario.data.after_sales_task_status = task.status;
    scenario.data.after_sales_plan = task.after_sales_plan ? {
      action: task.after_sales_plan.action,
      original_sales_order_no: task.after_sales_plan.original_sales_order_no,
      diff_amount: task.after_sales_plan.diff_amount,
      settlement: task.after_sales_plan.settlement,
      restock_state: task.after_sales_plan.restock_state,
      new_lines: task.after_sales_plan.new_lines,
      source: task.after_sales_plan.source,
    } : null;
    check(scenario, '话题里的售后进了"待确认"（出确认卡片）', AFTER_SALES_TASK_STATUS.CONFIRMING, task.status);
    if (task.status !== AFTER_SALES_TASK_STATUS.CONFIRMING) {
      scenario.error = `售后没出确认卡片：${task.status} ${task.after_sales_error || ''}`;
      return scenario;
    }
    const cardMessageId = task.card_message_id || '';
    const confirmFrom = capturedLogs.length;
    await confirmCard(h, {
      taskId: sent.taskId, cardMessageId, action: AFTER_SALES_CARD_ACTIONS.CONFIRM,
    });
    const done = await waitTask(h, sent.taskId,
      (row) => AFTER_SALES_TERMINAL(row) || Boolean(row.after_sales_error),
      { label: `售后执行 ${sent.taskId}`, timeoutMs: 240_000 });
    scenario.data.after_sales_result = done.after_sales_result || null;
    scenario.data.after_sales_error = done.after_sales_error || '';
    const liveAfter = await liveSnapshot(h);

    const masterId = done.after_sales_result?.masterRecordId || '';
    const masterEntry = masterId ? await readEntry(h, masterId) : null;
    // ⚠️ 售后的新明细行**关联的还是原销售主表**（不是新那张售后主表）——
    //    执行器刻意这么做：关联新主表会让"这条退货明细属于哪张单"把已退的单整单排除掉。
    //    所以这里按执行器返回的 record_id 直接读，不按新主表反查。
    const afterSalesDetailIds = done.after_sales_result?.detailRecordIds || [];
    const masterDetails = await readDetailsByIds(h, afterSalesDetailIds);
    const masterPayments = masterId ? await readPaymentsOf(h, masterId) : [];
    // 库存流水：按**执行器这次真正写下的** ledgerRecordId 逐条读回（再核对表里的行为/数量）。
    // ⚠️ 不能只按来源明细筛：换货退回那一腿的来源就是**原明细行**，
    //    而那一行上还挂着首次销售写的那条「销售减少」，会一起被捞进来。
    const ledgerIds = (done.after_sales_result?.stock || [])
      .map((row) => row?.result?.ledgerRecordId).filter(Boolean);
    const masterLedger = await readLedgerByIds(h, ledgerIds);
    const originalDetailsAfter = await readDetailsOf(h, started.task.sales_entry_record_id);
    const originalEntryAfter = await readEntry(h, started.task.sales_entry_record_id);

    scenario.data.master_entry = masterEntry;
    scenario.data.master_details = masterDetails;
    scenario.data.master_payments = masterPayments;
    scenario.data.master_ledger = masterLedger;
    scenario.data.original_details_after = originalDetailsAfter;
    scenario.data.original_entry_after = originalEntryAfter;
    // 售后会动**两双**（换货：旧鞋回来 + 新鞋出去），所以按这几组 (货品, 尺码) 分别快照
    const inventoryPairs = expect.inventoryPairs || [{ label: '退回的那一双', pick }];
    scenario.data.inventory = inventoryPairs.map(({ label, pick: row }) => {
      const before = liveOfPair(liveBefore, row.productRecordId, row.sizeRecordId);
      const afterSale = liveOfPair(liveAfterSale, row.productRecordId, row.sizeRecordId);
      const afterReturn = liveOfPair(liveAfter, row.productRecordId, row.sizeRecordId);
      return {
        label,
        货: `${row.itemNo} ${row.color} ${row.size}码`,
        before, afterSale, afterReturn,
        售后净变化: (afterReturn.byState['门盒'] || 0) - (afterSale.byState['门盒'] || 0),
      };
    });
    const netDoorBoxDelta = scenario.data.inventory
      .reduce((sum, row) => sum + row.售后净变化, 0);
    scenario.data.logs = eventsOf([...logsSince(logsFrom), ...logsSince(confirmFrom)],
      ['after_sales.executed', 'inventory.change.applied', 'v1.sale.posted',
        'bitable.record.created', 'bitable.record.updated', 'after_sales.confirmed']);

    check(scenario, '执行结果：动作', expect.action, done.after_sales_result?.action);
    const originalDetailIds = new Set(original.details.map((row) => row.record_id));
    check(scenario, '原明细履约状态', expect.originalFulfillment,
      originalDetailsAfter.filter((row) => originalDetailIds.has(row.record_id)).map((row) => row.履约状态));
    check(scenario, '新单（售后主表）四个字段', expect.masterDims, masterEntry?.dims);
    check(scenario, '售后退回：实时库存门盒变化（两双合计）', expect.returnedDoorBoxDelta, netDoorBoxDelta);
    check(scenario, '库存流水条数', expect.ledgerCount, masterLedger.length);
    check(scenario, '库存流水（库存行为 / 变动数量）', expect.ledger,
      masterLedger.map((row) => ({ 库存行为: row.库存行为, 变动数量: row.变动数量 })).sort((a, b) => a.库存行为.localeCompare(b.库存行为)));
    check(scenario, '售后收款（交易方向 / 金额 / 收款时间）', expect.payment,
      masterPayments.map((row) => ({ 交易方向: row.交易方向, 金额: row.收款金额, 有收款时间: Boolean(row.收款时间) })));
    if (done.after_sales_error) scenario.error = done.after_sales_error;
    return scenario;
  } catch (error) {
    scenario.error = error.message;
    return scenario;
  }
};

// ── 场景①：话题形式回复（单独一条，证据最完整）──────────────────────────────
const runThreadScenario = async ({ pick, price }) => {
  const scenario = makeScenario('s1', '销售录单（话题里发文字 → 识别 → 确认卡片 → 确认 → 入账 → 交付 → 扣库存）',
    ['机器人对群消息的回复带 reply_in_thread: true', '话题 id 被本地映射记住',
      '确认后：销售明细=已交付 / 收款明细=已收款（带收款时间）/ 四字段全写入',
      '库存方向：门盒 -1、1 条「销售减少」流水',
      '有没有多余消息：0 条主动私聊', '话题里的后续消息按 thread_id 定位到同一笔销售']);
  const h = makeHarness({ label: 's1' });
    scenario.data.api_errors = h.apiErrors;
  try {
    const text = `卖一双 ${pick.itemNo} ${pick.color} ${pick.size}码，微信 ${price}`;
    const liveBefore = await liveSnapshot(h);
    scenario.data.detailIdsBefore = [];
    const started = await startSale(h, { text, messageId: 'om_e2e_s1' });
    scenario.data.text = text;
    scenario.data.task_status = started.task.status;
    scenario.data.missing_fields = started.task.draft?.missing_fields || [];
    scenario.data.im_replies = h.sim.replies.map((reply) => ({
      msg_type: reply.msg_type, reply_in_thread: reply.reply_in_thread, thread_id: reply.thread_id,
      content: String(reply.content).slice(0, 200),
    }));
    check(scenario, '解析出确认卡片（ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    const cardReply = started.cardReply;
    scenario.data.card_reply = cardReply ? {
      parent_message_id: cardReply.parent_message_id, msg_type: cardReply.msg_type,
      reply_in_thread: cardReply.reply_in_thread, thread_id: cardReply.thread_id,
    } : null;
    const mapping = await h.salesGroupThreads.findByMessageId('om_e2e_s1');
    scenario.data.mapping = mapping ? {
      message_id: mapping.message_id, thread_id: mapping.thread_id,
      sales_entry_record_id: mapping.sales_entry_record_id,
    } : null;
    check(scenario, '卡片是"回复那条消息"且带 reply_in_thread', true,
      cardReply?.reply_in_thread === true && cardReply.parent_message_id === 'om_e2e_s1');
    check(scenario, '飞书回带的 thread_id 被记进本地映射', true,
      Boolean(mapping?.thread_id) && mapping.thread_id === cardReply?.thread_id);

    // 先按卡片入账（这一步走的是**私聊那条一模一样的**销售链路，只是承载场所变了）
    const posted = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id,
    });
    scenario.data.posted_dims = posted.entry.dims;
    scenario.data.posted_toast = posted.toast?.toast?.content;
    const liveAfter = await liveSnapshot(h);
    scenario.data.details = posted.details;
    scenario.data.payments = posted.payments;
    scenario.data.ledger = posted.ledger;
    scenario.data.outbound = {
      creates: h.sim.creates.length,
      private_creates: h.sim.creates.filter((item) => String(item.receive_id || '').startsWith('ou_')).length,
      replies: h.sim.replies.length,
      reply_in_thread: h.sim.replies.filter((item) => item.reply_in_thread === true).length,
    };
    scenario.data.inventory = diffLive(
      liveOfPair(liveBefore, pick.productRecordId, pick.sizeRecordId),
      liveOfPair(liveAfter, pick.productRecordId, pick.sizeRecordId),
    );
    check(scenario, '销售明细（履约状态）', ['已交付'], posted.details.map((row) => row.履约状态));
    check(scenario, '收款明细（状态 / 金额 / 交易方式 / 有收款时间）',
      [{ 收款状态: '已收款', 收款金额: String(price), 交易方式: '微信', 有收款时间: true }],
      posted.payments.map((row) => ({ 收款状态: row.收款状态, 收款金额: row.收款金额,
        交易方式: row.交易方式, 有收款时间: Boolean(row.收款时间) })));
    check(scenario, '销售主表四字段', { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
      posted.entry.dims);
    check(scenario, '库存流水（库存行为 / 变动数量）', [{ 库存行为: '销售减少', 变动数量: '1' }],
      posted.ledger.map((row) => ({ 库存行为: row.库存行为, 变动数量: row.变动数量 })));
    check(scenario, '库存方向：门盒 -1', -1, scenario.data.inventory.byState['门盒'] || 0);
    check(scenario, '没有多余消息：0 条主动私聊（im.message.create 到 open_id）', 0,
      scenario.data.outbound.private_creates);

    // 话题里再发一句（不引用、不带 @）→ 应当只靠 thread_id 命中同一笔
    const threadId = cardReply?.thread_id || '';
    const secondId = 'om_e2e_s1_second';
    const logsFrom = capturedLogs.length;
    const { taskId } = await sendGroupMessage(h, { text: '那双拿走了', messageId: secondId, threadId });
    const task = await waitTask(h, taskId, SALE_TERMINAL, { label: '话题第二条' });
    scenario.data.second_task = {
      status: task.status, sales_entry_record_id: task.sales_entry_record_id,
      chat_type: task.chat_type, group_thread_id: task.group_thread_id,
      progress_kind: task.progress_kind || '', progress_reason: task.progress_reason || '',
    };
    const locateLogs = eventsOf(logsSince(logsFrom),
      ['sales.group.sale.located', 'sales.group.sale.dispatched', 'sales.group.message.handled']).map((e) => ({
      event: e.event, source: e.source, thread_id: e.thread_id, mode: e.mode,
    }));
    scenario.data.locate_logs = locateLogs;
    check(scenario, '话题里的消息按 thread_id 定位到同一笔', true,
      task.sales_entry_record_id === started.task.sales_entry_record_id);
    check(scenario, '定位来源是 thread_id（不是"最近一笔"）', true,
      locateLogs.some((entry) => entry.source === 'thread_id'));
    scenario.logs = eventsOf(logsSince(0), ['lark.group.message.accepted', 'sales.group.thread.remembered',
      'sales.group.sale.located']).map((e) => ({ event: e.event, source: e.source, thread_id: e.thread_id }));
    return scenario;
  } catch (error) {
    scenario.error = error.message;
    return scenario;
  }
};


// ══════════════════════════════════════════════════════════════════════════
//  补样品（s6）
//  ⛔ 原「采购侧（s4 / s5）」整段已删除（2026-10-09）：那个入口
//    （`PurchaseWebhookService.accept('supplier-report', …)` ← 「信息填写」表变更事件）
//    随业务负责人删掉整张表一起退场。
// ══════════════════════════════════════════════════════════════════════════

// ⛔ `stamp()`（时间戳，用于 s4/s5 的批次号）已随那两个场景删除（2026-10-09）。


// 出站消息清单：判「发到哪个群 / 有没有多余消息」用（证据全来自我们记录的真实调用）。
const outboundSummary = (sim) => {
  const replies = sim.replies.map((item) => ({
    kind: 'reply', to: item.parent_message_id, msg_type: item.msg_type,
    reply_in_thread: item.reply_in_thread === true, thread_id: item.thread_id || '',
    content: String(item.content || ''),
  }));
  const creates = sim.creates.map((item) => ({
    kind: 'create', receive_id: item.receive_id || '', receive_id_type: item.receive_id_type || '',
    msg_type: item.msg_type || '', content: String(item.content || ''),
    mention_all: /user_id="all"|所有人/.test(String(item.content || '')),
  }));
  return {
    replies,
    creates,
    images: sim.images || [],
    privateCreates: creates.filter((item) => item.receive_id.startsWith('ou_')),
    replyInThread: replies.filter((item) => item.reply_in_thread).length,
    createCount: creates.length,
  };
};

// 采购侧 harness

// ── 场景 s6：补样品 ─────────────────────────────────────────────────────────
// 补样品任务的 id 由 service 按销售明细 id 派生（`sample_` + sha256 前 20 位）；
// 这里照同一个口径算出来，好把那条本地任务读回来核对。
const sampleTaskIdFor = (salesDetailRecordId) =>
  `sample_${crypto.createHash('sha256').update(String(salesDetailRecordId)).digest('hex').slice(0, 20)}`;

const runSampleReplacementScenario = async ({ pick }) => {
  const scenario = makeScenario('s6',
    '补样品：群销售消耗了样品 → 卡片**回到那条销售话题**（reply_in_thread；不许发私聊）', [
      '（前置）这双鞋：门盒 ≥ 1 且 样品 ≥ 1，一次卖两双 → 第 2 双只能吃样品',
      '交付后项目代码真的走了补样品链路（补样品卡片出现在那条销售话题里）',
      '卡片是 `im.message.reply` + `reply_in_thread: true`，回复的是**她那句销售消息**',
      '🔴 不许发私聊：0 条 `im.message.create`（open_id）',
      '本地补样品任务：card_message_id 非空、notice_sent = true',
    ]);
  const h = makeHarness({ label: 's6' });
    scenario.data.api_errors = h.apiErrors;
  try {
    // ⚠️ 措辞坑（第一次跑就踩到）：写成「卖两双 X，微信 438」时，模型给出 2 条明细但
    //    **每条都没有成交金额**，而整单金额有值 → 解析判「逐件成交金额合计与整单不一致」，
    //    直接停在 needs_info（连确认卡片都出不来）。所以这里**逐件把价格说清楚**
    //    （与既有脚本里"一单两笔交易"那条能跑通的措辞同一形状）。
    const text = `卖两双，${pick.itemNo} ${pick.color} ${pick.size}码 ${pick.price}，`
      + `${pick.itemNo} ${pick.color} ${pick.size}码 ${pick.price}，微信 ${pick.price * 2}`;
    scenario.data.text = text;
    scenario.data.pick = { 货: `${pick.itemNo} ${pick.color} ${pick.size}码`,
      门盒: pick.doorBox, 样品: pick.sample, 单价: pick.price };
    const started = await startSale(h, { text, messageId: 'om_e2e_s6' });
    scenario.data.draft_items = (started.task.draft?.items || []).map((item) => ({
      quantity: item.quantity, uses_sample: item.uses_sample,
      needs_sample_replacement: Boolean(item.needs_sample_replacement),
      sample_options: (item.sample_replacement_options || []).length,
    }));
    check(scenario, '解析出确认卡片（ready_to_confirm）', 'ready_to_confirm', started.task.status);
    if (started.task.status !== 'ready_to_confirm') {
      scenario.error = `解析没走到卡片：${started.task.status} ${JSON.stringify(started.task.draft?.missing_fields || [])}`;
      return scenario;
    }
    // 这一单**不能**被"先选补哪个门盒"的闸门挡住 —— 挡住了就说明选的数据不对
    // （salesPlanFor 是按整件数量一次性算的，所以"门盒=1 + 样品=1 + 卖两双"才走得通）。
    check(scenario, '这一单没被"先选补样品"闸门挡住（卡片上不要求先选）', true,
      (started.task.draft?.items || []).every((item) => !item.needs_sample_replacement));
    const threadId = started.cardReply?.thread_id || '';

    const repliesBefore = h.sim.replies.length;
    const result = await confirmAndRead(h, {
      taskId: started.taskId, cardMessageId: started.task.card_message_id,
      salesEntryRecordId: started.task.sales_entry_record_id,
    });
    scenario.data.entry = result.entry;
    scenario.data.details = result.details.map((row) => ({ record_id: row.record_id, 履约状态: row.履约状态 }));
    scenario.data.ledger = result.ledger.map((row) => ({ 库存行为: row.库存行为, 变动数量: row.变动数量 }));

    const newReplies = h.sim.replies.slice(repliesBefore);
    const sampleReplies = newReplies.filter((row) => String(row.content).includes('请补选展示样品'));
    scenario.data.replies_after_confirm = newReplies.map((row) => ({
      msg_type: row.msg_type, reply_in_thread: row.reply_in_thread,
      parent_message_id: row.parent_message_id, mark: String(row.content).includes('请补选展示样品') ? '补样品卡片' : '',
    }));

    // 诊断信息：万一交付没完成，报告里要能看出**为什么**（不然只能看到"卡片没出现"）。
    scenario.data.task_status = result.task.status;
    scenario.data.posting_error = result.task.posting_error || '';
    scenario.data.delivery_failures = result.task.delivery_failures || null;
    // ⚠️ 踩过的坑：补样品任务只挂在**被吃掉样品的那一双**上，而它不一定是 details[0]
    //    （实测就是 details[1]）—— 只查第 0 条会把"卡片确实发了"误判成"没发"。
    let sampleTask = null;
    let sampleTaskDetailId = '';
    for (const detail of result.details) {
      const candidate = await h.store.get(sampleTaskIdFor(detail.record_id));
      if (candidate) { sampleTask = candidate; sampleTaskDetailId = detail.record_id; break; }
    }
    scenario.data.sample_task = sampleTask ? {
      sales_detail_record_id: sampleTaskDetailId,
      task_id: sampleTask.task_id, status: sampleTask.status,
      card_message_id: sampleTask.card_message_id || '', notice_sent: sampleTask.notice_sent === true,
      product_record_id: sampleTask.product_record_id || '',
    } : null;
    const outbound = outboundSummary(h.sim);
    scenario.data.outbound = { creates: outbound.createCount, private_creates: outbound.privateCreates.length,
      reply_in_thread: outbound.replyInThread, replies: outbound.replies.length };
    const skipLogs = capturedLogs.filter((entry) => entry.event === 'lark.private_chat.send_skipped');

    check(scenario, '两双都交付了（一双吃门盒、一双吃样品）', ['已交付', '已交付'],
      result.details.map((row) => row.履约状态).sort());
    check(scenario, '交付没有失败项', null, scenario.data.delivery_failures);
    check(scenario, '交付真的消耗了样品（补样品卡片出现了）', 1, sampleReplies.length);
    check(scenario, '补样品卡片是"回复她那句销售消息"', 'om_e2e_s6', sampleReplies[0]?.parent_message_id);
    check(scenario, '补样品卡片带 reply_in_thread: true', true, sampleReplies[0]?.reply_in_thread === true);
    check(scenario, '补样品卡片落在**同一个话题**里', threadId, sampleReplies[0]?.thread_id);
    check(scenario, '🔴 不发私聊：0 条 im.message.create', 0, outbound.createCount);
    check(scenario, '🔴 没有 `lark.private_chat.send_skipped` 兜底记录', 0, skipLogs.length);
    check(scenario, '本地补样品任务 notice_sent = true', true, sampleTask?.notice_sent === true);
    check(scenario, '本地补样品任务 card_message_id 非空', true, Boolean(sampleTask?.card_message_id));
    scenario.logs = eventsOf(capturedLogs, ['v1.sale.posted', 'inventory.change.applied',
      'sales.delivery.completed', 'sales.sample_candidates.failed', 'lark.private_chat.send_skipped'])
      .map((entry) => ({ event: entry.event }));
    return scenario;
  } catch (error) {
    scenario.error = error.message;
    return scenario;
  }
};

// ── 主流程 ──────────────────────────────────────────────────────────────────
// 验收标准**在跑之前**先打印一遍（业务负责人 2026-10-06 定的流程：
// 「先写应该是什么样 → 再跑 → 逐条对照」）。完整版在 docs/e2e-group-thread-2026-10-07.md。
const ACCEPTANCE_CRITERIA = [
  's1 销售录单：话题里发文字 → 确认卡片（reply_in_thread）→ 确认 → 销售明细=已交付 / 收款=已收款 → 门盒 -1 → 0 条私聊',
  's2 销售退货：话题里说「退那双…」→ 按 thread_id 定位那笔 → 确认 → 原明细=已退货 / 新售后主表 / 门盒 +1 / 退款 1 条',
  's3 换货：话题里说「换成…」→ 旧鞋 +1（销售退货行为）/ 新鞋 -1（现货销售 SALE_CASH）/ 净 0 / 2 条流水 / 差价 0 不动钱',
  // ⛔ s4 / s5（采购报单 / 采购退货）的验收标准行**已删除**：那条入口退场了。
  's6 补样品：群销售吃掉样品 → 补样品卡片回到**那条销售话题**（reply_in_thread）→ 0 条私聊 / 0 条 send_skipped 兜底',
];

const cmdRun = async () => {
  const guard = guardEnvironment();
  head('e2e-group-thread：群聊/话题 · 六场景（走项目代码，写测试 Base）');
  say(`  worktree            ：${repoRoot}`);
  say(`  HEAD                ：${require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim()}`);
  say(`  .env 来源           ：${envSources.join(' / ')}`);
  say(`  写入目标 app_token  ：${fingerprint(guard.target)}（= FEISHU_V1_E2E_TEST_APP_TOKEN，测试 Base）`);
  say(`  FEISHU_TARGET_ENV   ：${guard.targetEnv}`);
  say(`  禁止写入清单        ：${guard.forbiddenCount ? `${guard.forbiddenCount} 个（本机通常为 0，见 AGENTS.md 第 8 条）` : '未配置（主闸门已由"必须等于授权测试 Base"兜住）'}`);
  say(`  飞书外发            ：${flags['real-im'] ? '真实发送 ⚠️' : '全部拦住（记录型 IM 替身，把出站 payload 记下来当证据）'}`);
  say(`  采购群 PURCHASE_CHAT_ID：${fingerprint(process.env.PURCHASE_CHAT_ID)}`);

  head('【验收标准（跑之前写下来的；完整版 docs/e2e-group-thread-2026-10-07.md）】');
  for (const item of ACCEPTANCE_CRITERIA) say(`  ${item}`);

  const gateway = new V1BitableGateway();
  const operator = await pickRealOperatorOpenId(gateway);
  if (!operator.openId) {
    throw new Error('测试 Base 里没有取到可用的「录单人」open_id：人员字段写不存在的用户会报 UserFieldConvFail，无法模拟建单');
  }
  operatorOpenId = operator.openId;
  say('');
  say(`  模拟操作人 open_id ：取自${operator.source}（指纹 ${fingerprint(operatorOpenId)}，不打印、不外发）`);

  // 「行为管理」的库存方向 / 启用（库存引擎的闸门）。测试 Base 缺这几行时售后与换货必失败。
  const behaviorFix = await ensureBehaviorDirections(gateway, {
    fixKinds: [MOVEMENT_SALE_RETURN, MOVEMENT_SALE_CASH, MOVEMENT_PURCHASE_DECREASE],
  });
  if (behaviorFix.mismatches.length) {
    say(`  ⚠️ 行为管理库存方向/启用与代码注册表不一致：${behaviorFix.mismatches.length} 条`);
    for (const row of behaviorFix.mismatches) {
      say(`      ${row.name}(${row.kind}) ${row.issue}：当前=${row.current} 期望=${row.expected}`);
    }
  }
  for (const row of behaviorFix.fixed) {
    say(`  ✅ 已在**测试 Base** 补齐：行为管理「${row.name}」(${row.kind}) ${row.field} ${row.from} → ${row.to}`);
  }

  const candidates = await collectStockCandidates(gateway);
  const soldItemColors = await collectSoldItemColors(gateway);
  say(`  已被卖过的「货号|颜色」：${soldItemColors.size} 组（售后按货号定位会撞车，挑数据时排除）`);
  const pool = candidates.filter((item) => item.doorBox >= 1 && item.price && item.uniqueColor
    && !soldItemColors.has(`${item.itemNo}|${item.color}`));
  const taken = new Set();
  const takeFrom = (source, filter) => {
    const found = source.find((item) => !taken.has(item.key) && (!filter || filter(item)));
    if (found) taken.add(found.key);
    return found;
  };
  const take = (filter) => takeFrom(pool, filter);
  const pairsWithTwoSizes = [];
  for (const item of pool) {
    for (const other of pool) {
      if (other.key === item.key) continue;
      if (other.itemNo === item.itemNo && other.color === item.color && other.size !== item.size) {
        pairsWithTwoSizes.push({ itemNo: item.itemNo, color: item.color, list: [item, other] });
      }
    }
  }
  const takePair = () => {
    const found = pairsWithTwoSizes.find((pair) => pair.list.every((item) => !taken.has(item.key)));
    if (!found) return null;
    found.list.forEach((item) => taken.add(item.key));
    return found;
  };

  // 六个必需场景 + 销售侧补充场景（e*，只在 --all / 显式 --only 时跑）
  const s3Pair = takePair();                       // 换货：要一对（旧鞋 + 换出去的新鞋）
  const x2bPair = takePair();
  const s1Pick = take();                           // s1 销售录单（话题）
  const s2Pick = take();                           // s2 销售退货的基准
  // ⚠️ s6 要**故意**从一个更宽的池子里挑：它不需要「这个款没卖过」那个约束
  //    （那是 s2/s3 售后按「货号+颜色」定位历史销售才需要的）。只按 `pool` 挑的后果
  //    实测过：跑一次就把唯一那个"门盒≥1 且 样品≥1"的组合卖成"卖过的款"，
  //    下一次全量运行 s6 就只能被**跳过**（脚本会如实打印"缺少可用数据"）。
  //    补样品这条链路本来就不依赖历史销售定位，所以这里放宽不会让验收变松。
  const samplePool = candidates.filter((item) => item.doorBox >= 1 && item.sample >= 1
    && item.price && item.uniqueColor);
  const s6Pick = takeFrom(samplePool);
  const x2aPick = take();
  const x2cPick = take();
  const x3Pick = take();
  const x4Pick = take();
  const s3Pick = s3Pair ? s3Pair.list[0] : null;
  const exchangeTarget = s3Pair ? s3Pair.list[1] : null;
  const describe = (pick) => (pick
    ? `${pick.itemNo} ${pick.color} ${pick.size}码 门盒=${pick.doorBox} 样品=${pick.sample} 单价=${pick.price}`
    : '（找不到可用数据）');

  // ── 采购侧的数据 ──────────────────────────────────────────────────────────
  const productTable = gateway.table('product');
  const liveTable = gateway.table('liveInventory');
  const productById = new Map((await gateway.listAll('product')).map((row) => [row.record_id, row]));
  const liveCountByProduct = new Map();
  for (const row of await gateway.listAll('liveInventory')) {
    for (const id of linkedRecordIds(row.fields?.[liveTable.fields.product])) {
      liveCountByProduct.set(id, (liveCountByProduct.get(id) || 0) + 1);
    }
  }
  const labelOf = (id) => textValue(productById.get(id)?.fields?.[productTable.fields.number]) || id;

  say('');
  say(`  实时库存候选（门盒有货 + 有单价 + 颜色唯一）：${pool.length} 个 (货品, 尺码) 组合`);
  say('  本次选用的数据（全部来自测试 Base 真实数据）：');
  say(`    s1 销售录单（话题）  ：${describe(s1Pick)}`);
  say(`    s2 销售退货         ：${describe(s2Pick)}`);
  say(`    s3 换货             ：${describe(s3Pick)} → ${describe(exchangeTarget)}`);
  say(`    s6 补样品           ：${describe(s6Pick)}（门盒≥1 + 样品≥1 → 卖两双：第 2 双吃样品）`);
  say(`      （s6 的候选池更宽：${samplePool.length} 个「门盒≥1 且 样品≥1」的组合，不排除"卖过的款"）`);
  if (only.length || flags.all) {
    say(`    x2a 现货·一单一笔   ：${describe(x2aPick)}`);
    say(`    x2b 现货·一单两笔   ：${x2bPair ? `${x2bPair.list[0].itemNo} ${x2bPair.list[0].color} ${x2bPair.list[0].size}码 + ${x2bPair.list[1].size}码` : '（无）'}`);
    say(`    x2c 现货·两笔支付   ：${describe(x2cPick)}`);
    say(`    x3  预付销售         ：${describe(x3Pick)}`);
    say(`    x4  未付销售         ：${describe(x4Pick)}`);
  }

  const price = Number(s1Pick?.price || 0);
  const scenarios = [];
  const required = {
    s1: s1Pick, s2: s2Pick, s3: s3Pick && exchangeTarget, s6: s6Pick,
    x2a: x2aPick, x2b: x2bPair && x2bPair.list[0] && x2bPair.list[1], x2c: x2cPick, x3: x3Pick, x4: x4Pick,
  };
  const extraKeys = ['x2a', 'x2b', 'x2c', 'x3', 'x4'];
  const defaults = flags.all ? Object.keys(required) : [...Object.keys(required).filter((key) => !extraKeys.includes(key))];
  const selected = only.length ? only : defaults;
  const wanted = (key) => selected.includes(key) && Boolean(required[key]);
  const skipped = selected.filter((key) => !required[key]);
  if (skipped.length) say(`  ⚠️ 测试 Base 里缺少可用数据，这些场景不跑：${skipped.join(' / ')}`);

  // ── 六个必需场景 ──────────────────────────────────────────────────────────
  if (wanted('s1')) {
    say('\n  ▶ s1 销售录单（话题闭环）…');
    scenarios.push(await runThreadScenario({ pick: s1Pick, price }));
  }
  if (wanted('s2')) {
    say('  ▶ s2 销售退货 …');
    scenarios.push(await runAfterSalesScenario({
      key: 's2', name: '销售退货（话题里说「退那双 …」→ 定位那笔 → 确认 → 退货入账 + 库存加回）',
      pick: s2Pick,
      saleText: `卖一双 ${s2Pick.itemNo} ${s2Pick.color} ${s2Pick.size}码，微信 ${s2Pick.price}`,
      afterSalesText: `退一双 ${s2Pick.itemNo} ${s2Pick.color} ${s2Pick.size}码，钱退现金`,
      expect: {
        expectation: ['原明细履约状态 → 已退货', '新建售后主表（交易类型=销售退货），四字段=已确认/已写入/已写入/已写入',
          '库存：退回 +1（门盒），1 条库存流水（库存行为=销售退货，变动数量=1）', '钱：退款 1 条（交易方向=退回，带收款时间）',
          '都在同一个话题里；0 条主动私聊'],
        action: 'return',
        originalFulfillment: ['已退货'],
        masterDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        returnedDoorBoxDelta: 1,
        ledgerCount: 1,
        ledger: [{ 库存行为: '销售退货', 变动数量: '1' }],
        payment: [{ 交易方向: '退回', 金额: String(s2Pick.price), 有收款时间: true }],
        rawParsed: {
          intent: 'return', action: 'return', item_no: s2Pick.itemNo, color: s2Pick.color,
          size: s2Pick.size, settlement: '现金',
        },
      },
    }));
  }
  if (wanted('s3')) {
    say('  ▶ s3 换货 …');
    scenarios.push(await runAfterSalesScenario({
      key: 's3', name: '换货（新鞋出库 SALE_CASH + 旧鞋入库）',
      pick: s3Pick,
      saleText: `卖一双 ${s3Pick.itemNo} ${s3Pick.color} ${s3Pick.size}码，微信 ${s3Pick.price}`,
      afterSalesText: `换一双 ${s3Pick.itemNo} ${s3Pick.color} ${s3Pick.size}码，`
        + `换成 ${exchangeTarget.itemNo} ${exchangeTarget.color} ${exchangeTarget.size}码，钱退现金`,
      expect: {
        expectation: ['原明细履约状态 → 已换货', '新建售后主表（交易类型=销售换货），四字段=已确认/已写入/已写入/已写入',
          '库存：旧鞋 +1（销售退货行为）/ 新鞋 -1（现货销售行为，行为编码 SALE_CASH）；两双合计净 0，两条流水',
          '差价 = 0 → 不动钱（不写收款明细）'],
        action: 'exchange',
        inventoryPairs: [
          { label: '被换回的那一双', pick: s3Pick },
          { label: '换出去的那一双', pick: exchangeTarget },
        ],
        originalFulfillment: ['已换货'],
        masterDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        returnedDoorBoxDelta: 0,
        ledgerCount: 2,
        ledger: [{ 库存行为: '现货销售', 变动数量: '1' }, { 库存行为: '销售退货', 变动数量: '1' }],
        payment: [],
        rawParsed: {
          intent: 'exchange', action: 'exchange', item_no: s3Pick.itemNo, color: s3Pick.color,
          size: s3Pick.size, new_item_no: exchangeTarget.itemNo, new_color: exchangeTarget.color,
          new_size: exchangeTarget.size, settlement: '现金',
        },
      },
    }));
  }
  if (wanted('s6')) {
    say('  ▶ s6 补样品 …');
    scenarios.push(await runSampleReplacementScenario({ pick: s6Pick }));
  }

  // ── 销售侧补充场景（e*，默认不跑）─────────────────────────────────────────
  if (wanted('x2a')) {
    say('  ▶ x2a 现货 · 一单一笔交易 …');
    scenarios.push(await runSpotScenario({
      key: 'x2a', name: '现货 · 一单一笔交易',
      picks: [x2aPick],
      textFor: () => `卖一双 ${x2aPick.itemNo} ${x2aPick.color} ${x2aPick.size}码，微信 ${x2aPick.price}`,
      expect: {
        expectation: ['1 条销售明细（已交付）', '1 条收款明细（已收款）',
          '四字段：已确认/已写入/已写入/已写入', '实时库存门盒 -1', '1 条库存流水（库存行为=销售减少，变动数量=1）'],
        detailCount: 1, paymentCount: 1, detailStatus: ['已交付'], paymentStatus: ['已收款'],
        dims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        ledger: [{ 库存行为: '销售减少', 变动数量: '1' }], liveDoorBoxDelta: -1,
      },
    }));
  }
  if (wanted('x2b')) {
    say('  ▶ x2b 现货 · 一单两笔交易 …');
    const [p1, p2] = x2bPair.list;
    scenarios.push(await runSpotScenario({
      key: 'x2b', name: '现货 · 一单两笔交易',
      picks: [p1, p2],
      textFor: () => `卖两双，${p1.itemNo} ${p1.color} ${p1.size}码 ${p1.price}，`
        + `${p2.itemNo} ${p2.color} ${p2.size}码 ${p2.price}，微信 ${p1.price + p2.price}`,
      expect: {
        expectation: ['2 条销售明细（都已交付）', '1 条收款明细（已收款）',
          '四字段：已确认/已写入/已写入/已写入', '实时库存门盒 -2', '2 条库存流水（库存行为=销售减少，各 1）'],
        detailCount: 2, paymentCount: 1, detailStatus: ['已交付', '已交付'], paymentStatus: ['已收款'],
        dims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        ledger: [{ 库存行为: '销售减少', 变动数量: '1' }, { 库存行为: '销售减少', 变动数量: '1' }],
        liveDoorBoxDelta: -2,
      },
    }));
  }
  if (wanted('x2c')) {
    say('  ▶ x2c 现货 · 一单两笔支付方式 …');
    const half = Math.round(x2cPick.price / 2);
    scenarios.push(await runSpotScenario({
      key: 'x2c', name: '现货 · 一单两笔支付方式',
      picks: [x2cPick],
      textFor: () => `卖一双 ${x2cPick.itemNo} ${x2cPick.color} ${x2cPick.size}码，`
        + `微信 ${half}、现金 ${x2cPick.price - half}`,
      expect: {
        expectation: ['1 条销售明细（已交付）', '2 条收款明细（都已是收款）',
          '四字段：已确认/已写入/已写入/已写入', '实时库存门盒 -1', '1 条库存流水（库存行为=销售减少，变动数量=1）'],
        detailCount: 1, paymentCount: 2, detailStatus: ['已交付'], paymentStatus: ['已收款', '已收款'],
        dims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        ledger: [{ 库存行为: '销售减少', 变动数量: '1' }], liveDoorBoxDelta: -1,
      },
    }));
  }
  if (wanted('x3')) {
    say('  ▶ x3 预付销售 …');
    scenarios.push(await runDeferredScenario({
      key: 'x3', name: '预付销售',
      pick: x3Pick,
      text: `预付一双 ${x3Pick.itemNo} ${x3Pick.color} ${x3Pick.size}码，定金 ${Math.round(x3Pick.price / 2)} 微信，`
        + `尾款 ${x3Pick.price - Math.round(x3Pick.price / 2)} 以后付`,
      expect: {
        expectation: ['首次：1 条明细【未交付】＋ 2 条收款（1 已收款 + 1 未收款）', '首次：库存不动（未交付不扣库存）',
          '话题里说「已完毕」→ 认成整单完成、机器人回问收款方式（状态未变）；把方式一起说 → 未交付变已交付 ＋ 未收款变已收款（带收款时间）',
          '四字段：已确认/已写入/已写入/（库存）已写入'],
        detailCount: 1, firstPaymentCount: 2,
        firstDetailStatus: ['未交付'],
        firstPaymentStatus: [`已收款/${Math.round(x3Pick.price / 2)}`,
          `未收款/${x3Pick.price - Math.round(x3Pick.price / 2)}`].sort(),
        firstDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '' },
        firstLiveDoorBoxDelta: 0,
        doneText: '已完毕',
        afterWordsDetailStatus: ['未交付'],
        afterWordsPaymentStatus: ['已收款', '未收款'],
        afterWordsLiveDoorBoxDelta: 0,
        fallbackTexts: ['已完毕，微信'],
        afterFallbackDetailStatus: ['已交付'],
        afterFallbackPaymentStatus: ['已收款', '已收款'],
        afterFallbackDoorBoxDelta: -1,
      },
    }));
  }
  if (wanted('x4')) {
    say('  ▶ x4 未付销售 …');
    scenarios.push(await runDeferredScenario({
      key: 'x4', name: '未付销售',
      pick: x4Pick,
      text: `未付一双 ${x4Pick.itemNo} ${x4Pick.color} ${x4Pick.size}码，成交 ${x4Pick.price}`,
      expect: {
        expectation: ['首次：1 条明细【已交付】（货拿走）＋ 1 条收款【未收款】', '首次：库存扣 1（已交付）',
          '话题里说「成交」→ 认成整单完成、机器人回问收款方式（状态未变）；「成交，微信」→ 未收款变已收款（带收款时间）',
          '四字段：已确认/已写入/已写入/已写入'],
        detailCount: 1, firstPaymentCount: 1,
        firstDetailStatus: ['已交付'],
        firstPaymentStatus: [`未收款/${x4Pick.price}`],
        firstDims: { 确认状态: '已确认', 销售状态: '已写入', 资金状态: '已写入', 库存状态: '已写入' },
        firstLiveDoorBoxDelta: -1,
        doneText: '成交',
        afterWordsDetailStatus: ['已交付'],
        afterWordsPaymentStatus: ['未收款'],
        afterWordsLiveDoorBoxDelta: 0,
        fallbackTexts: ['成交，微信'],
        afterFallbackDetailStatus: ['已交付'],
        afterFallbackPaymentStatus: ['已收款'],
        afterFallbackDoorBoxDelta: 0,
      },
    }));
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  head('结果汇总（预期 vs 实际）');
  for (const scenario of scenarios) {
    const failed = scenario.checks.filter((row) => !row.pass);
    const status = scenario.error && !scenario.checks.length ? '未跑起来'
      : failed.length ? '未达标' : '通过';
    say('');
    say(`  【${scenario.key}】${scenario.name} —— ${status}`);
    for (const row of scenario.checks) {
      say(`    ${row.pass ? '✅' : '❌'} ${row.label}`);
      if (!row.pass) {
        say(`         预期：${JSON.stringify(row.expected)}`);
        say(`         实际：${JSON.stringify(row.actual)}`);
      }
    }
    for (const text of scenario.notes) say(`    · ${text}`);
    if (scenario.error) say(`    ⚠️ 错误：${scenario.error}`);
  }

  const reportDir = path.join(serverRoot, 'data', 'selftest', 'group-thread-e2e');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    generated_at_shanghai: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'),
    repo_root: repoRoot,
    head: require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
    base_fingerprint: fingerprint(guard.target),
    target_env: guard.targetEnv,
    acceptance_criteria: ACCEPTANCE_CRITERIA,
    behavior_fix: behaviorFix,
    selected,
    scenarios,
    log_events: capturedLogs.map((entry) => ({ event: entry.event, ...entry })),
  }, null, 2));
  head('完成');
  say(`  report.json：${reportPath}`);
  const failedCount = scenarios.filter((scenario) => scenario.checks.some((row) => !row.pass)).length;
  say(`  场景：${scenarios.length} 个，未达标 ${failedCount} 个`);
  // 非零退出码：让「一键重跑」在 CI / 脚本里也能当闸门用（有未达标就红）。
  if (failedCount || scenarios.some((scenario) => scenario.error)) process.exitCode = 1;
  return { scenarios, reportPath };
};

const main = async () => {
  if (mode === 'inspect') return cmdInspect();
  if (mode === 'run') return cmdRun();
  say(`未知子命令：${mode}（可用：inspect / run）`);
  process.exitCode = 2;
  return null;
};

// 放在 `server/scripts/` 下：`node --test` **不会**收集它（只收 `test/**` 与 `*.test.js`）。
// 它是真写测试 Base 的端到端脚本，本来就不该混进单测里。
main().then(() => { process.exitCode = process.exitCode || 0; }).catch((error) => {
  originalConsole.error(`[e2e-group-thread] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
