#!/usr/bin/env node
/**
 * e2e-run.mjs —— 在**本地**把采购链路整条跑通，**不依赖飞书表变更事件**。
 *
 * 为什么要有这个脚本：
 *   采购链路的入口是「多维表格记录变更事件」，但事件只是**入口**——
 *   `processSupplierReturn` / `handleReportBatch` / `processSupplierReport` 都能直接调。
 *   所以本地可以：写一条「供应商对接」记录 → 调 accept() 跑完整链路 → 打印真实效果。
 *   这样每次改完代码都能自己验收，不用等业务负责人在飞书里操作一遍。
 *
 * 子命令：
 *   node scripts/e2e-run.mjs setup   预置测试 Base 的前置数据（缺什么补什么，幂等）
 *   node scripts/e2e-run.mjs inspect 只读：打印环境指向 + 货品/实时库存现状（不写任何表）
 *   node scripts/e2e-run.mjs return  跑一条「采购退货」：写记录 → 跑链路 → 打印验收对照
 *   node scripts/e2e-run.mjs probe-message --message-id <id1,id2,...>
 *                                    只读：拿这几条消息的详情（thread_id / parent_id），
 *                                    核实「它们是不是同一个话题」。不写表、不发消息。
 *
 * `return` 常用参数：
 *   --qty <n>        退货数量（默认 2）——**每条**记录的数量
 *   --records <n>    写几条**同批次号**的退货记录（默认 1）
 *                    · 2 条 = 验证「同一个批次号只出一张图、只发一次群」（归批窗口的意义）
 *                    · 配合 --gap-ms 复现生产实测：「同一次提交拆成 2 次推送、相隔 16 秒」
 *   --gap-ms <ms>    同批号相邻两条之间的间隔（默认：records>1 时 16000，否则 0）
 *                    · >0 = 分条推送（逐条 accept）；0 = 同一包推送（走 acceptMany）
 *   --batch-no <s>   指定报货批次号（默认按时间生成；同一次运行的多条记录共用它）
 *   --product <rec>  货品记录 id（默认自动挑一条库存最多的货品）
 *   --size <n>       指定尺码（B 情况：只退这个尺码；不填 = A 情况：该货品全退）
 *   --report <rec>   复用一条已有的「供应商对接」记录（只借它的货品，仍会新建一条退货记录）
 *   --env-file <p>   额外的环境变量文件（凭证等），会先加载，再被 <repo>/.env.local 覆盖
 *   --real-im        真的往飞书发图/发消息（默认必须「拦」：用假的 IM 客户端记录，不外发）
 *   --chat-id <id>   覆写采购群 id（默认读 PURCHASE_CHAT_ID）
 *   --no-probe       真发时不调只读接口核话题（默认会用 im.message.get 拿那条图消息的详情）
 *
 * 环境变量加载顺序（后者覆盖前者）：
 *   1. <repo>/.env                  （worktree 里通常没有）
 *   2. --env-file <p>               （凭证；一般指主工作区的 .env）
 *   3. <repo>/.env.local            （**测试 Base 的表 ID**，明确指向测试环境）
 *   ⚠️ 绝不修改主工作区的 .env。
 *
 * 安全闸门（写死在脚本里，防止误伤生产）：
 *   · Base app_token 必须等于授权可写的**测试 Base**；等于生产 Base 直接拒绝运行；
 *   · FEISHU_TARGET_ENV 必须是 test（除非显式 --force-env）。
 * 这个脚本**只写测试 Base**，生产 Base 一个字都不写。
 *
 * 产物（每次运行一个目录）：
 *   server/data/selftest/runs/<record_id>/report.json     结构化证据
 *   server/data/selftest/runs/<record_id>/return-order.png 真正生成的那张退货单图
 *   server/data/selftest/runs/<record_id>/task.json        本地任务记录（幂等状态）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/scripts → server → <repo root>
const repoRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.resolve(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'return';
const flags = {};
for (let index = mode === argv[0] ? 1 : 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) {
    flags[key] = next;
    index += 1;
  } else {
    flags[key] = true;
  }
}

const flag = (name, fallback) => (flags[name] === undefined ? fallback : flags[name]);
const num = (name, fallback) => {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} 必须是整数，收到 ${raw}`);
  return value;
};

// ── 环境变量（必须在 require 业务模块之前加载：schema 是 require 时求值的）──────
const loadEnv = () => {
  const sources = [];
  const records = [
    { label: '<repo>/.env', path: path.join(repoRoot, '.env'), override: false },
    { label: `--env-file ${flag('env-file', '')}`, path: flag('env-file', ''), override: false },
    { label: '<repo>/.env.local', path: path.join(repoRoot, '.env.local'), override: true },
  ];
  for (const item of records) {
    if (!item.path) continue;
    if (!fs.existsSync(item.path)) { sources.push(`${item.label}（不存在，跳过）`); continue; }
    const result = dotenv.config({ path: item.path, override: item.override, quiet: true });
    sources.push(`${item.label}（注入 ${Object.keys(result.parsed || {}).length} 项）`);
  }
  return sources;
};
const envSources = loadEnv();

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { person, relation } = require('../src/services/v1ReferenceResolver');
const { classifyReportBehavior, REPORT_BEHAVIOR } = require('../src/services/purchaseReportBehaviorPolicy');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');

// 授权可写的测试 Base（业务负责人明确授权：测试 Base 可随便写）。
const TEST_APP_TOKEN = 'GqMMbhnxGaaEdDsNz2Tcug1nnlb';
// 生产 Base：**只读**，一个字都不许写。写死在这里做闸门。
const PROD_APP_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh';

const line = (char = '─') => console.log(char.repeat(72));
const head = (title) => { console.log(''); line('═'); console.log(`  ${title}`); line('═'); };
const say = (...args) => console.log(...args);

const runDir = (recordId) => path.join(serverRoot, 'data', 'selftest', 'runs', recordId);

// ── 飞书客户端：bitable/drive 走真的，IM 默认用假的（拦住真实外发）──────────────
/**
 * ⚠️ IM 替身必须与官方 SDK 的**调用形状**一致，否则跑的根本不是生产那条代码路径。
 * 生产代码 `purchaseWebhookService.sendImage/sendText` 用三种调用：
 *   · `im.image.create({ data: { image_type, image } })`
 *   · `im.message.create({ params: { receive_id_type }, data: { receive_id, msg_type, content } })`
 *   · `im.message.reply({ path: { message_id }, data: { msg_type, content } })`
 *     ——把第 2 条起（文字 @、多供应商时的第 2 张图）挂到第 1 条的话题下。
 * 替身**曾经漏掉 `reply`**：链路在「发群」那一步抛
 * `this.client.im.message.reply is not a function` → 话题功能**根本没被验到**，
 * 而且 `send_failed` 之后 `continue`，连「图写回单据信息附件」都整段跳过
 * （验收 ⑤ 的 `附件数=[0,0]` 就是这么来的，不是假的 drive 没记）。
 * ⇒ 两个替身都要有 `reply`，并且都记下 `path.message_id` —— 那是判断
 *   「第 2 条是不是回复同一条（= 同一个话题）」的唯一硬证据。
 */
const createClient = ({ realIm }) => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const real = new lark.Client({ appId, appSecret });
  // ⚠️ drive 一直都是**真**客户端（附件真的上传到测试 Base）——这里加的不是替身，
  // 是**留证**：记下每次 `uploadAttachment` 的调用与飞书的应答。上次报告里只看到
  // 「每条单据信息行的附件数=[0,0]」，分不清是"没走到上传"还是"上传被飞书拒了"。
  const outbox = { images: [], messages: [], driveUploads: [] };
  const recordingDrive = {
    media: {
      uploadAll: async (params = {}) => {
        const base = {
          file_name: params?.data?.file_name || '',
          size: params?.data?.size || 0,
          parent_type: params?.data?.parent_type || '',
        };
        try {
          const response = await real.drive.media.uploadAll(params);
          outbox.driveUploads.push({
            ...base,
            ok: true,
            code: response?.code ?? null,
            msg: response?.msg || '',
            file_token_present: Boolean(
              response?.file_token || response?.data?.file_token || response?.data?.data?.file_token,
            ),
          });
          return response;
        } catch (error) {
          // HTTP 400 这类异常把飞书的 code/msg 藏在 error.response.data 里 —— 必须捞出来，
          // 否则报告里只剩一句 "Request failed with status code 400"（等于没查清）。
          const payload = error?.response?.data || {};
          outbox.driveUploads.push({
            ...base,
            ok: false,
            status: error?.response?.status ?? null,
            code: payload?.code ?? error?.code ?? null,
            msg: String(payload?.msg || error?.message || '').slice(0, 400),
            permission_violations: Array.isArray(payload?.error?.permission_violations)
              ? payload.error.permission_violations.map((item) => item?.type || String(item)).slice(0, 10)
              : [],
          });
          throw error;
        }
      },
    },
  };
  /**
   * 统一记录一条"发出去的消息"。字段照 SDK 形状，外加两个判定话题用的字段：
   *   · `reply_to_message_id` = reply 的 `path.message_id`（顶层消息为空）
   *   · `response.message_id / thread_id` = 飞书回给我们的那条消息的 id 与话题 id
   */
  const recordMessage = ({ kind, params, data, path: pathArg, response }) => {
    const entry = {
      kind,
      params: params || null,
      data: data || null,
      reply_to_message_id: String(pathArg?.message_id || ''),
      response: {
        message_id: response?.data?.message_id || response?.message_id || '',
        thread_id: response?.data?.thread_id || response?.thread_id || '',
      },
    };
    outbox.messages.push(entry);
    return entry;
  };
  if (realIm) {
    // 真发，但同时记录发了什么（证据照收）。
    const recordingIm = {
      image: {
        create: async (params = {}) => {
          outbox.images.push({ bytes: params?.data?.image?.length || 0, image_type: params?.data?.image_type });
          return real.im.image.create(params);
        },
      },
      message: {
        create: async (params = {}) => {
          const response = await real.im.message.create(params);
          recordMessage({ kind: 'create', params, data: params.data, response });
          return response;
        },
        // ⚠️ 真的转发到官方 client 的 `im.message.reply`，参数形状一个字都不改
        //（`{ path: { message_id }, data: { msg_type, content } }`）。
        reply: async (params = {}) => {
          const response = await real.im.message.reply(params);
          recordMessage({ kind: 'reply', data: params.data, path: params.path, response });
          return response;
        },
      },
    };
    // probeClient：只读核对用的**原始** client（recordingIm 上只挂了发消息用的方法，
    // 没有 im.message.get；拿详情验话题要走原始 client，且只调只读接口）。
    return { client: { bitable: real.bitable, drive: recordingDrive, im: recordingIm }, outbox, imIsFake: false, probeClient: real };
  }
  // 假飞书：thread_id 由"话题根消息 id"派生 → 「回复同一条 = 同一个话题」这件事
  // 在**默认模式（拦发）下也验得了**。真机上 thread_id 由飞书给；这里是模拟，
  // 只能证明"我们每次都回复同一条"，不能替代真发的证据（真发另有只读接口核对）。
  const fakeThreadIdOf = (rootMessageId) => `omt_selftest_${rootMessageId || 'unknown'}`;
  const fakeOk = (messageId, threadId = '') => ({
    code: 0, msg: 'success', data: { message_id: messageId, thread_id: threadId },
  });
  const fakeIm = {
    image: {
      create: async ({ data } = {}) => {
        outbox.images.push({ bytes: data?.image?.length || 0, image_type: data?.image_type });
        return { code: 0, image_key: `img_selftest_${outbox.images.length}` };
      },
    },
    message: {
      create: async (params = {}) => {
        // 顶层消息：飞书不给 thread_id（普通群里话题是她回复那一刻才产生的）。
        const response = fakeOk(`om_selftest_${outbox.messages.length + 1}`);
        recordMessage({ kind: 'create', params, data: params.data, response });
        return response;
      },
      reply: async (params = {}) => {
        const root = String(params?.path?.message_id || '');
        const response = fakeOk(`om_selftest_${outbox.messages.length + 1}`, fakeThreadIdOf(root));
        recordMessage({ kind: 'reply', data: params.data, path: params.path, response });
        return response;
      },
    },
  };
  // 只替换 im：bitable 是真的、drive 是真客户端外面套了一层录音（见 recordingDrive）
  // → 表是真的在读写，附件也是真的上传真回写（上传失败会记下飞书的 code/msg）。
  // 假客户端模式：probeClient 指向**真** client，但只用于只读的 im.message.get。
  return { client: { bitable: real.bitable, drive: recordingDrive, im: fakeIm }, outbox, imIsFake: true, probeClient: real };
};

const buildService = ({ client }) => {
  const gateway = new V1BitableGateway({ client });
  const store = new JsonTaskStore({
    dir: path.join(serverRoot, 'data', 'selftest', 'purchase_webhook_tasks'),
    idField: 'task_id',
  });
  const inventoryStore = new JsonTaskStore({
    dir: path.join(serverRoot, 'data', 'selftest', 'inventory_operations'),
    idField: 'operation_id',
  });
  const service = new PurchaseWebhookService({
    client,
    gateway,
    store,
    inventory: new InventoryService({ gateway, store: inventoryStore }),
  });
  return { gateway, store, service };
};

// ── 小工具 ──────────────────────────────────────────────────────────────────
const listAllSafe = async (gateway, tableKey) => {
  try { return await gateway.listAll(tableKey); } catch (error) {
    say(`  ⚠️ 读取「${gateway.table(tableKey).tableName}」失败：${error.message}`);
    return [];
  }
};

const fieldTypeOf = async (gateway, tableKey, semanticKey) => {
  const table = gateway.table(tableKey);
  const wanted = table.fields[semanticKey];
  const fields = await gateway.listFields(tableKey, { refresh: true });
  const hit = fields.find((item) => item.field_name === wanted);
  return hit?.type ?? null;
};

// 数量字段在测试 Base / 生产 Base 的类型可能不同（number vs text），按真实类型写。
const coerceNumberCell = (type, value) => (type === 2 ? value : String(value));

const resolveReturnBehavior = async (gateway) => {
  const table = gateway.table('behavior');
  const records = await listAllSafe(gateway, 'behavior');
  const hits = records.map((record) => ({
    recordId: record.record_id,
    name: textValue(record.fields?.[table.fields.name]),
    code: textValue(record.fields?.[table.fields.code]),
    enabled: record.fields?.[table.fields.enabled],
  })).filter((item) => classifyReportBehavior(item) === REPORT_BEHAVIOR.PURCHASE_RETURN);
  return hits;
};

/**
 * 从"能识别成退货"的行为里挑一条**采购侧**的用来造数据。
 * ⚠️ 分类正则 `/退货|return|.../i` 会把「销售退货 / SALE_RETURN」也算成退货，
 * 所以不能盲取第一条；这里优先 STOCK_PURCHASE_DECREASE，其次 PURCHASE_*RETURN*。
 */
const pickReturnBehavior = (candidates = []) => {
  const stock = candidates.find((item) => item.code === 'STOCK_PURCHASE_DECREASE');
  if (stock) return { picked: stock, reason: 'code=STOCK_PURCHASE_DECREASE（生产口径的那条）' };
  const purchase = candidates.find((item) => /^purchase/i.test(item.code) || /采购/.test(item.name));
  if (purchase) return { picked: purchase, reason: 'code/名称带「采购」' };
  return { picked: candidates[0], reason: '兜底：第一条能识别成退货的行为（注意可能是销售侧）' };
};

// 扣库存那一步要求「行为管理」里**有且只有一条** STOCK_PURCHASE_DECREASE，
// 且 库存方向=减少、已启用（见 InventoryService.resolveStockBehavior）。
const resolveStockDecreaseBehavior = async (gateway) => {
  const table = gateway.table('behavior');
  const records = await listAllSafe(gateway, 'behavior');
  return records.map((record) => ({
    recordId: record.record_id,
    name: textValue(record.fields?.[table.fields.name]),
    code: textValue(record.fields?.[table.fields.code]),
    direction: textValue(record.fields?.[table.fields.stockDirection]),
    enabled: record.fields?.[table.fields.enabled],
  })).filter((item) => item.code === 'STOCK_PURCHASE_DECREASE');
};

const liveRowsOfProduct = async (gateway, productRecordId) => {
  const table = gateway.table('liveInventory');
  const rows = await gateway.listAll('liveInventory');
  return rows
    .filter((record) => linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId))
    .map((record) => ({
      record_id: record.record_id,
      state: textValue(record.fields?.[table.fields.state]),
      size: textValue(record.fields?.[table.fields.size]),
      stockKey: textValue(record.fields?.[table.fields.stockKey]),
    }))
    .sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const waitForTask = async (store, taskId, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < deadline) {
    task = await store.get(taskId);
    if (task && ['posted', 'completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await sleep(300);
  }
  return task;
};

/**
 * 只读：拿一条消息的详情（`im.message.get`）。
 * ⚠️ 飞书这个接口把结果放在 `data.items[0]`（不是 `data`）—— 一开始按 `data` 取，
 * 所有字段都读成空串，看起来"拿到了"其实什么都没拿到。
 */
const getMessageDetail = async (client, messageId) => {
  try {
    const response = await client.im.message.get({ path: { message_id: String(messageId) } });
    const item = (response?.data?.items || [])[0] || response?.data || {};
    return {
      ok: Boolean(item && (item.message_id || item.msg_type || item.thread_id || item.parent_id)),
      query_message_id: String(messageId),
      message_id: item.message_id || '',
      thread_id: item.thread_id || '',
      parent_id: item.parent_id || '',
      root_id: item.root_id || '',
      chat_id: item.chat_id || '',
      msg_type: item.msg_type || '',
      create_time: item.create_time || '',
      error: '',
    };
  } catch (error) {
    const payload = error?.response?.data || {};
    return {
      ok: false,
      query_message_id: String(messageId),
      error: `${payload?.code ?? ''} ${payload?.msg || error?.message || String(error)}`.trim(),
    };
  }
};

const guardEnvironment = (gateway) => {
  const appToken = V1_BITABLE_SCHEMA.appToken;
  say(`  Base app_token：${appToken}`);
  say(`  环境标记 FEISHU_TARGET_ENV：${process.env.FEISHU_TARGET_ENV || '(未设置)'}`);
  say(`  采购群 PURCHASE_CHAT_ID：${process.env.PURCHASE_CHAT_ID || '(未设置 → 出图后不会发送)'}`);
  if (!appToken) throw new Error('未配置 FEISHU_V1_BITABLE_APP_TOKEN，拒绝运行');
  if (appToken === PROD_APP_TOKEN) {
    throw new Error('检测到 app_token 是**生产 Base** —— 本脚本只允许写测试 Base，已拒绝运行');
  }
  if (appToken !== TEST_APP_TOKEN && flag('force-env', false) !== true) {
    throw new Error(`app_token 既不是授权的测试 Base(${TEST_APP_TOKEN})，也不等于生产 Base。`
      + '为安全起见拒绝运行；确认无误可加 --force-env。');
  }
  if (process.env.FEISHU_TARGET_ENV !== 'test' && flag('force-env', false) !== true) {
    throw new Error('FEISHU_TARGET_ENV 不是 test，拒绝运行（确认无误可加 --force-env）');
  }
};

// ── setup：预置测试 Base 的前置数据（幂等）────────────────────────────────────
const cmdSetup = async () => {
  const { client } = createClient({ realIm: false });
  const gateway = new V1BitableGateway({ client });
  head('setup：检查测试 Base 的前置数据');
  guardEnvironment(gateway);

  const table = gateway.table('behavior');
  const existing = await resolveStockDecreaseBehavior(gateway);
  say(`  行为管理里 STOCK_PURCHASE_DECREASE 现有 ${existing.length} 条`);
  if (existing.length === 1) {
    const item = existing[0];
    say(`  ✓ 已存在：${item.name}（${item.code}）方向=${item.direction} 启用=${item.enabled}`);
    if (item.direction !== '减少' || item.enabled !== true) {
      say('  → 方向/启用不对，按契约修正（库存方向=减少、启用）');
      await gateway.update('behavior', item.recordId, { stockDirection: '减少', enabled: true });
      say('  ✓ 已修正');
    }
  } else if (existing.length === 0) {
    const created = await gateway.create('behavior', {
      name: '采购减少',
      code: 'STOCK_PURCHASE_DECREASE',
      stockDirection: '减少',
      enabled: true,
    });
    say(`  ✚ 缺失，已补一条：采购减少 / STOCK_PURCHASE_DECREASE / 减少 / 启用 → ${created.recordId}`);
  } else {
    say('  ✗ 有多条同编码行为，扣库存那一步会拒绝处理（必须且只能有一条），需要人工删到一条');
  }
  const after = await resolveStockDecreaseBehavior(gateway);
  const ok = after.length === 1 && after[0].direction === '减少' && after[0].enabled === true;
  say(`  ${ok ? '✅' : '❌'} 扣库存前置行为就绪`);
  return ok ? 0 : 1;
};

// ── inspect：只读现状 ────────────────────────────────────────────────────────
const cmdInspect = async () => {
  const { client } = createClient({ realIm: false });
  const gateway = new V1BitableGateway({ client });
  head('inspect：本地指向哪个 Base、链路的前置条件如何（只读，不写任何表）');
  guardEnvironment(gateway);

  const returns = await resolveReturnBehavior(gateway);
  say(`  退货分流行为候选：${returns.map((item) => `${item.name}/${item.code}(${item.recordId})`).join('，') || '(没有！)'}`);
  const stock = await resolveStockDecreaseBehavior(gateway);
  say(`  扣库存行为 STOCK_PURCHASE_DECREASE：${stock.map((item) => `${item.name} 方向=${item.direction} 启用=${item.enabled}`).join('，') || '(缺失 → 先跑 setup)'}`);

  const products = await gateway.listAll('product');
  const productTable = gateway.table('product');
  const live = await gateway.listAll('liveInventory');
  const liveTable = gateway.table('liveInventory');
  const counts = new Map();
  for (const row of live) {
    for (const id of linkedRecordIds(row.fields?.[liveTable.fields.product])) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  say('  实时库存最多的 5 个货品（脚本默认会挑第 1 个）：');
  for (const [recordId, count] of top) {
    const product = products.find((item) => item.record_id === recordId);
    say(`    ${recordId} ${textValue(product?.fields?.[productTable.fields.number])} → ${count} 行`);
  }
  return 0;
};

// ── probe-message：只读核对某几条消息的详情（唯一用途：验「是不是一个话题」）────
const cmdProbeMessage = async () => {
  const { client, probeClient } = createClient({ realIm: false });
  const gateway = new V1BitableGateway({ client });
  head('probe-message：只读拿消息详情（im.message.get），不写任何表、不发任何消息');
  guardEnvironment(gateway);
  const ids = String(flag('message-id', '')).split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('用法：node scripts/e2e-run.mjs probe-message --message-id <id1,id2,...>');
  const rows = [];
  for (const id of ids) rows.push(await getMessageDetail(probeClient, id));
  for (const item of rows) {
    if (item.ok) {
      say(`  ✅ ${item.query_message_id}`);
      say(`      message_id=${item.message_id} thread_id=${item.thread_id || '(空)'} parent_id=${item.parent_id || '(空)'} root_id=${item.root_id || '(空)'} chat_id=${item.chat_id || '(空)'} msg_type=${item.msg_type} create_time=${item.create_time}`);
    } else {
      say(`  ❌ ${item.query_message_id} → error=${item.error}`);
    }
  }
  const root = rows[0];
  const allOk = rows.every((item) => item.ok);
  const sameChat = allOk && Boolean(root.chat_id) && rows.every((item) => item.chat_id === root.chat_id);
  const sameThread = allOk && Boolean(root.thread_id) && rows.every((item) => item.thread_id === root.thread_id);
  const repliesToRoot = rows.length > 1 && allOk && rows.slice(1).every((item) => item.parent_id === root.message_id);
  say(`  ${sameChat ? '✅' : '❌'} 同一个 chat：${root.chat_id || '(空)'}`);
  say(`  ${sameThread ? '✅' : '❌'} thread_id 全一致：${rows.map((item) => item.thread_id || '(空)').join(' / ')}`);
  say(`  ${repliesToRoot ? '✅' : '❌'} 第 2 条起的 parent_id 都指向第 1 条：${root.message_id || '(空)'}`);
  const pass = sameChat && sameThread && repliesToRoot;
  say(`  → ${pass ? '飞书侧确认：一个话题 ✅' : '飞书侧：不是一个话题 / 证据不足 ❌'}`);
  return pass ? 0 : 1;
};

// ── return：跑一条采购退货 + 验收对照 ────────────────────────────────────────
const cmdReturn = async () => {
  const qty = num('qty', 2);
  const records = num('records', 1);
  if (records < 1) throw new Error('--records 至少是 1');
  // 默认间隔：多条同批号 = 复现生产那次「同一次提交拆成 2 次推送、相隔 16 秒」。
  const gapMs = num('gap-ms', records > 1 ? 16_000 : 0);
  const realIm = flag('real-im', false) === true || flag('real-im', false) === 'true';
  const requestedProduct = flag('product', '');
  const requestedReport = flag('report', '');
  const requestedSize = flags.size === undefined ? null : num('size', null);
  if (flags['chat-id']) process.env.PURCHASE_CHAT_ID = String(flags['chat-id']);
  const targetChatId = process.env.PURCHASE_CHAT_ID || '';

  const { client, outbox, imIsFake, probeClient } = createClient({ realIm });
  const { gateway, store, service } = buildService({ client });

  head('① 环境（配置指向哪个 Base / 发消息怎么处理）');
  guardEnvironment(gateway);
  say(`  IM：${imIsFake ? '已拦截（假客户端记录，不发真实消息）✓' : '⚠️ 真实外发（会真的发到 PURCHASE_CHAT_ID 那个群）'}`);
  say(`  环境变量来源：`);
  for (const item of envSources) say(`    · ${item}`);

  // ── 前置：扣库存行为必须就绪（不补就必然在扣库存那一步失败）──
  head('② 前置检查');
  const stockBehavior = await resolveStockDecreaseBehavior(gateway);
  const stockReady = stockBehavior.length === 1 && stockBehavior[0].direction === '减少' && stockBehavior[0].enabled === true;
  say(`  扣库存行为 STOCK_PURCHASE_DECREASE：${stockBehavior.length ? JSON.stringify(stockBehavior[0]) : '(缺失)'} → ${stockReady ? '✅ 就绪' : '❌ 未就绪（先跑 `node scripts/e2e-run.mjs setup`）'}`);
  if (!stockReady) {
    say('  链路会在「扣库存」这一步报错退出——这不是代码问题，是测试 Base 的前置数据缺一行。');
    return 2;
  }

  const reportTable = gateway.table('purchaseReport');
  const productTable = gateway.table('product');

  // 货品：--product 指定 > --report 记录的货品 > 库存最多的那个
  let productRecordId = requestedProduct;
  let reusedReport = null;
  if (!productRecordId && requestedReport) {
    reusedReport = await gateway.get('purchaseReport', requestedReport);
    productRecordId = linkedRecordIds(reusedReport?.fields?.[reportTable.fields.product])[0] || '';
  }
  if (!productRecordId) {
    const live = await listAllSafe(gateway, 'liveInventory');
    const liveTable = gateway.table('liveInventory');
    const counts = new Map();
    for (const row of live) {
      for (const id of linkedRecordIds(row.fields?.[liveTable.fields.product])) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) throw new Error('测试 Base 的实时库存是空的，没法跑退货');
    productRecordId = top[0];
    say(`  未指定货品，自动挑库存最多的：${productRecordId}（${top[1]} 行）`);
  }
  const product = await gateway.get('product', productRecordId);
  if (!product) throw new Error(`货品记录不存在：${productRecordId}`);
  const productLabel = textValue(product.fields?.[productTable.fields.number]);
  const supplierIds = linkedRecordIds(product.fields?.[productTable.fields.supplier]);
  say(`  货品：${productRecordId} ${productLabel}｜供应商关联：${supplierIds.join(',') || '(空 → 链路会明确失败)'}`);

  const returnBehaviors = await resolveReturnBehavior(gateway);
  if (!returnBehaviors.length) throw new Error('行为管理里没有能识别成「退货」的行为，无法构造退货记录');
  say(`  能识别成「退货」的行为共 ${returnBehaviors.length} 条：${returnBehaviors.map((item) => `${item.name}/${item.code}`).join('，')}`);
  const forcedBehaviorId = flag('behavior', '');
  const chosen = forcedBehaviorId
    ? { picked: returnBehaviors.find((item) => item.recordId === forcedBehaviorId), reason: `--behavior 指定` }
    : pickReturnBehavior(returnBehaviors);
  if (!chosen.picked) {
    throw new Error(`--behavior ${forcedBehaviorId} 不在"能识别成退货"的行为里：${returnBehaviors.map((item) => item.recordId).join(',')}`);
  }
  const returnBehavior = chosen.picked;
  say(`  本次使用：${returnBehavior.name} / ${returnBehavior.code}（${returnBehavior.recordId}）—— ${chosen.reason}`);
  if (returnBehavior.enabled !== true) say('  ⚠️ 该行为在表里没启用（分流不看它，但业务上应在表单里可见）');

  // 经办人：借已有退货记录的那个 open_id（@经办人 要用真的 open_id）
  let operatorOpenId = '';
  const reports = await listAllSafe(gateway, 'purchaseReport');
  const sample = reusedReport || reports.slice().reverse().find((row) => {
    const value = row.fields?.[reportTable.fields.operator];
    const first = Array.isArray(value) ? value[0] : value;
    return Boolean(first?.id || first?.open_id);
  });
  const operatorCell = sample?.fields?.[reportTable.fields.operator];
  const firstOperator = Array.isArray(operatorCell) ? operatorCell[0] : operatorCell;
  operatorOpenId = firstOperator?.id || firstOperator?.open_id || '';
  say(`  经办人 open_id：${operatorOpenId || '(没取到 → 群里那条文字不会 @人)'}`);

  // 实时库存：跑之前的快照
  const liveBefore = await liveRowsOfProduct(gateway, productRecordId);
  const availableBySize = {};
  for (const row of liveBefore) availableBySize[row.size] = (availableBySize[row.size] || 0) + 1;
  const scoped = requestedSize === null
    ? liveBefore
    : liveBefore.filter((row) => Number(row.size) === requestedSize);
  say(`  实时库存（该货品）：${liveBefore.length} 行；${requestedSize === null ? '不分尺码' : `${requestedSize} 码`}可退 ${scoped.length} 行`);
  say(`    按尺码：${JSON.stringify(availableBySize)}`);
  if (scoped.length === 0) {
    say('  ⚠️ 该货品（这个尺码）在实时库存里一双都没有 → 链路会走「一双都没退成」，验收 ①②③ 都不可能成立');
  }

  const ledgerBefore = new Set((await listAllSafe(gateway, 'inventoryLedger')).map((row) => row.record_id));
  const requestsBefore = new Set((await listAllSafe(gateway, 'purchaseRequest')).map((row) => row.record_id));

  // ── ② 写「供应商对接」记录（真的写测试 Base）──
  head(`③ 写入「供应商对接」记录（真写测试 Base；本次 ${records} 条）`);
  const quantityType = await fieldTypeOf(gateway, 'purchaseReport', 'quantity');
  // ⚠️ 多条记录必须**共用同一个报货批次号** —— 归批窗口就是按它归集的
  //（生产上这是飞书表单里填的那个号；这里由脚本生成一个同值的）。
  const batchNo = String(flag('batch-no', '') || `SELFTEST-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`);
  const values = {
    behavior: relation(returnBehavior.recordId),
    product: relation(productRecordId),
    quantity: coerceNumberCell(quantityType, qty),
    // 处理状态**不写**：它是单选，写一个不存在的选项会直接建记录失败。
    // 留空等价于"一条刚提交、还没处理过的表单记录"，链路照样能跑。
    batchNoText: batchNo,
  };
  if (requestedSize !== null) {
    const sizeTable = gateway.table('sizeManagement');
    const sizeRecords = await gateway.listAll('sizeManagement');
    const hit = sizeRecords.find((row) => Number(textValue(row.fields?.[sizeTable.fields.size])) === requestedSize);
    if (!hit) throw new Error(`「尺码管理」里没有 ${requestedSize} 码`);
    values.size = relation(hit.record_id);
  }
  if (operatorOpenId) values.operator = person(operatorOpenId);

  // ── ④ 跑链路（accept = 事件入口走的那条路）──
  head('④ 跑链路：accept("supplier-report") → 退货归批窗口 → runReturnBatch → 出图/发群/回填');
  say(`  报货批次号 = ${batchNo}`);
  say(`  推送方式 = ${records > 1 && gapMs === 0
    ? '同一包（acceptMany：一次推送里的多条 action）'
    : `分条推送（相邻两条相隔 ${gapMs}ms${gapMs >= 16_000 ? '，复现生产那次 16 秒拆包' : ''}）`}`);
  say(`  归批窗口 = ${process.env.PURCHASE_RETURN_BATCH_WINDOW_MS || '(未设置 → 默认 30000ms)'}`);

  const createdIds = [];
  const acceptedList = [];
  const pushLog = [];
  for (let index = 0; index < records; index += 1) {
    if (index > 0 && gapMs > 0) {
      say(`  … 等 ${gapMs}ms（模拟飞书把同一次提交分条推送）`);
      await sleep(gapMs);
    }
    const created = await gateway.create('purchaseReport', values);
    createdIds.push(created.recordId);
    const accepted = await service.accept('supplier-report', created.recordId);
    acceptedList.push(accepted);
    pushLog.push({ record_id: created.recordId, task_id: accepted.taskId, at: new Date().toISOString() });
    say(`  ✓ [${index + 1}/${records}] record_id = ${created.recordId}｜数量=${qty}（字段类型 type=${quantityType}）尺码=${requestedSize === null ? '(空)' : requestedSize}｜货品=${productLabel}`);
    say(`      accept → ${JSON.stringify(accepted)}`);
  }
  const recordId = createdIds[0];
  // 整批的 owner 是**第一条**记录的任务（见 handleReturnBatch 的 batchTaskId）。
  const batchTaskId = acceptedList[0].taskId;

  // 两条同批号记录是"到点整批一起处理"：等窗口到点，等第一条任务落终态。
  let task = await waitForTask(store, batchTaskId, Math.max(180_000, gapMs + 60_000));
  say(`  整批任务状态（轮询到的）：status=${task?.status}${task?.error ? ` error=${task.error}` : ''}`);
  // 同批其余记录的任务也读一次，确认"跟着这一批处理过了"而不是各自跑了一遍。
  const otherTasks = [];
  for (const accepted of acceptedList.slice(1)) {
    otherTasks.push(await store.get(accepted.taskId));
  }
  for (const item of otherTasks) {
    say(`  同批其余任务：task_id=${item?.task_id} status=${item?.status}${item?.error ? ` error=${item.error}` : ''}`);
  }

  // ── ⑤ 收集实际效果 ──
  const liveAfter = await liveRowsOfProduct(gateway, productRecordId);
  const ledgerAfter = await listAllSafe(gateway, 'inventoryLedger');
  const newLedger = ledgerAfter.filter((row) => !ledgerBefore.has(row.record_id));
  const requestsAfter = await listAllSafe(gateway, 'purchaseRequest');
  const newRequests = requestsAfter.filter((row) => !requestsBefore.has(row.record_id));
  // 每条退货记录各写各的「单据信息」行，幂等键前缀带的是**它自己**的 record_id
  //（`purchase_return:<record_id>:`），所以多条同批号时要按每条记录各收一次。
  const requestTableKey = gateway.table('purchaseRequest').fields.idempotencyKey;
  const sourceRecordOf = (row) => {
    const key = textValue(row.fields?.[requestTableKey]);
    return createdIds.find((id) => key.startsWith(`purchase_return:${id}:`)) || '';
  };
  const myRequests = requestsAfter.filter((row) => Boolean(sourceRecordOf(row)));
  const reportAfter = await gateway.get('purchaseReport', recordId);
  // 同批每条记录的处理状态 / 回填的「关联采购申请」都要看（④ 是逐条判的）。
  const reportStates = [];
  for (const id of createdIds) {
    const record = id === recordId ? reportAfter : await gateway.get('purchaseReport', id);
    reportStates.push({
      record_id: id,
      status: textValue(record?.fields?.[reportTable.fields.status]),
      request: linkedRecordIds(record?.fields?.[reportTable.fields.request]),
    });
  }
  const reportStatus = reportStates[0]?.status || '';
  const reportRequests = reportStates[0]?.request || [];

  const behaviorTable = gateway.table('behavior');
  const behaviorByRecord = new Map((await listAllSafe(gateway, 'behavior')).map((row) => [row.record_id, {
    name: textValue(row.fields?.[behaviorTable.fields.name]),
    code: textValue(row.fields?.[behaviorTable.fields.code]),
  }]));
  const ledgerTable = gateway.table('inventoryLedger');
  const ledgerRows = newLedger.map((row) => ({
    record_id: row.record_id,
    size: textValue(row.fields?.[ledgerTable.fields.size]),
    quantityChange: row.fields?.[ledgerTable.fields.quantityChange],
    behavior: linkedRecordIds(row.fields?.[ledgerTable.fields.behavior])
      .map((id) => behaviorByRecord.get(id) || { name: '', code: id }),
    hasSource: Boolean(
      linkedRecordIds(row.fields?.[ledgerTable.fields.salesDetail]).length
      || linkedRecordIds(row.fields?.[ledgerTable.fields.purchaseInbound]).length,
    ),
  }));

  const requestTable = gateway.table('purchaseRequest');
  const requestRows = myRequests.map((row) => ({
    record_id: row.record_id,
    source_record_id: sourceRecordOf(row),
    size: textValue(row.fields?.[requestTable.fields.size]),
    quantity: row.fields?.[requestTable.fields.quantity],
    behavior: linkedRecordIds(row.fields?.[requestTable.fields.behavior])
      .map((id) => behaviorByRecord.get(id) || { name: '', code: id }),
    idempotencyKey: textValue(row.fields?.[requestTable.fields.idempotencyKey]),
    attachmentCount: Array.isArray(row.fields?.[requestTable.fields.attachment])
      ? row.fields[requestTable.fields.attachment].length
      : (row.fields?.[requestTable.fields.attachment] ? 1 : 0),
  }));

  const removedLive = liveBefore.filter((row) => !liveAfter.some((item) => item.record_id === row.record_id));

  // ── 发出去的消息：区分「发到群里」和「发给经办人私聊」 ──
  // ⚠️ reply 的 params 里**没有 receive_id**（回复谁由 path.message_id 决定），
  // 所以"这条是不是发到群里"要顺着 reply_to_message_id 回溯到那条群消息上——
  // 只按 data.receive_id 过滤会把那条 @经办人 的群文字整条漏掉（正好是第 5 条要验的）。
  const groupMessageIds = new Set(
    outbox.messages
      .filter((item) => item.data?.receive_id === targetChatId)
      .map((item) => item.response?.message_id)
      .filter(Boolean),
  );
  const isGroupMessage = (item) => item.data?.receive_id === targetChatId
    || (item.kind === 'reply' && groupMessageIds.has(item.reply_to_message_id));
  const groupMessages = outbox.messages.filter(isGroupMessage);
  const readText = (item) => {
    const content = JSON.parse(item.data?.content || '{}');
    return {
      kind: item.kind,
      message_id: item.response?.message_id || '',
      reply_to_message_id: item.reply_to_message_id || '',
      thread_id: item.response?.thread_id || '',
      receive_id: item.data?.receive_id || '',
      receive_id_type: item.params?.receive_id_type || '',
      text: content.text || '',
      mentions: (content.text || '').match(/<at user_id="([^"]+)"/g) || [],
    };
  };
  const imageMessages = groupMessages.filter((item) => item.data?.msg_type === 'image');
  const textMessages = groupMessages.filter((item) => item.data?.msg_type === 'text').map(readText);
  const privateMessages = outbox.messages.filter((item) => !isGroupMessage(item))
    .filter((item) => item.data?.msg_type === 'text').map(readText);

  // ── 话题（第 7 条验收标准）：两条消息是不是一个话题 ──
  // 判据（全部来自我们自己记录的**真实调用与真实响应**）：
  //   1. 第 1 条群消息（图）= 顶层消息；第 2 条（文字 @）必须是 `reply`；
  //   2. 它回复的 `path.message_id` 必须**就是**第 1 条的 message_id；
  //   3. 飞书回给两条的 `thread_id` 必须是同一个（有值且相等）。
  const topicRoot = imageMessages[0] || null;
  const topicReplies = groupMessages.filter((item) => item.kind === 'reply');
  const topicRepliesToRoot = topicReplies.filter(
    (item) => item.reply_to_message_id && item.reply_to_message_id === (topicRoot?.response?.message_id || ''),
  );
  const topicEvidence = {
    chat_id: targetChatId,
    root_message_id: topicRoot?.response?.message_id || '',
    root_thread_id: topicRoot?.response?.thread_id || '',
    reply_count: topicReplies.length,
    replies: topicReplies.map(readText),
    replies_to_root: topicRepliesToRoot.length,
    thread_ids: [...new Set(topicReplies.map((item) => item.response?.thread_id || ''))],
    private_messages: privateMessages.map((item) => ({ text: item.text.slice(0, 60), mentions: item.mentions.length })),
  };
  const topic = {
    // 只有一个话题 ⟺ 群里有 ≥2 条消息、除第 1 条外全是回复、且全回复到第 1 条。
    one_thread: groupMessages.length >= 2
      && topicReplies.length === groupMessages.length - 1
      && topicRepliesToRoot.length === topicReplies.length
      && topicReplies.every((item) => Boolean(topicRoot?.response?.message_id)
        && item.reply_to_message_id === topicRoot.response.message_id),
    // thread_id 一致：**普通群里顶层消息的发送响应本来就没有 thread_id**
    //（话题是她回复那一刻才产生的），所以这里为 false 不等于"不是一个话题"——
    // 最终判定要等只读接口 im.message.get 的 parent_id 复核（见下面的 thread_confirmed）。
    same_thread_id: topicReplies.length > 0
      && Boolean(topicRoot?.response?.thread_id)
      && topicReplies.every((item) => item.response?.thread_id === topicRoot.response.thread_id),
    ...topicEvidence,
  };

  const runPath = runDir(recordId);
  fs.mkdirSync(runPath, { recursive: true });
  // 轮询超时可能正好卡在最后一步（写终态）之前，这里再读一次，保证落盘的 task 是最终状态。
  const finalTask = await store.get(batchTaskId);
  if (finalTask) task = finalTask;
  say(`  整批任务最终状态（重新读取）：status=${task?.status}`);
  if (outbox.images.length) {
    // 假客户端记的是字节长度；真图由 deliverSupplierImages 渲染后直接发给 IM。
    // 为了留下可视证据，这里再用同一份渲染器自己渲染一次同样的输入（只读、不写表）。
    try {
      const { renderPurchaseRequestPng, RETURN_TITLE } = require('../src/services/purchaseRequestImageService');
      const supplierTable = gateway.table('supplier');
      const supplier = supplierIds.length ? await gateway.get('supplier', supplierIds[0]).catch(() => null) : null;
      const itemsForImage = (task?.draft?.items || []).map((item) => ({
        item_no: item.item_no, color: item.color, size: item.size, quantity: item.quantity,
      }));
      if (itemsForImage.length) {
        const png = await renderPurchaseRequestPng({
          supplierName: textValue(supplier?.fields?.[supplierTable.fields.name]),
          batchNo: task?.draft?.batch_no || '',
          items: itemsForImage,
          title: RETURN_TITLE,
        });
        fs.writeFileSync(path.join(runPath, 'return-order.png'), png);
      }
    } catch (error) {
      say(`  ⚠️ 留证据用的重渲染失败（不影响链路结论）：${error.message}`);
    }
  }

  const totalReturned = requestRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const expectedTotal = qty * records;
  const hasReturnBehavior = ledgerRows.some((row) => row.behavior.some((item) => item.code === 'STOCK_PURCHASE_DECREASE'));
  // ④ 逐条记录判：每条记录都必须是「已生成申请」，且它回填的「关联采购申请」
  // 正好等于它自己写出的那几行单据信息。
  const docCountOf = (recordRecordId) => requestRows.filter((row) => row.source_record_id === recordRecordId).length;
  const allMatched = requestRows.length > 0 && reportStates.every((item) => item.status === '已生成申请'
    && item.request.length === docCountOf(item.record_id) && docCountOf(item.record_id) > 0);

  // ③ 的判定要精确到"哪个尺码少了几行、减到 0 的尺码是不是一行不剩"。
  const planSizes = Array.isArray(task?.return_plan?.sizes) ? task.return_plan.sizes : [];
  const remainingBySize = liveAfter.reduce((acc, row) => {
    acc[row.size] = (acc[row.size] || 0) + 1;
    return acc;
  }, {});
  const sizeChecks = planSizes.map((entry) => {
    const key = String(entry.size);
    const before = liveBefore.filter((row) => row.size === key).length;
    const after = remainingBySize[key] || 0;
    return { size: entry.size, before, taken: entry.quantity, after, expectedAfter: before - entry.quantity };
  });
  const sizeCheckOk = sizeChecks.length > 0
    && sizeChecks.every((item) => item.after === item.expectedAfter)
    && sizeChecks.filter((item) => item.expectedAfter === 0).every((item) => item.after === 0);

  const checks = [
    {
      id: '①',
      text: `出「退货单」：单据信息新增 ${requestRows.length} 行（本次退货涉及 ${new Set(requestRows.map((r) => r.size)).size} 个尺码），合计 ${totalReturned} 双 = 填的 ${expectedTotal}（${records} 条 × ${qty}）`,
      pass: requestRows.length > 0 && totalReturned === expectedTotal && totalReturned <= scoped.length,
      evidence: `单据信息行=${JSON.stringify(requestRows.map((r) => ({ id: r.record_id, source: r.source_record_id, size: r.size, qty: r.quantity })))}；PNG=${outbox.images.length} 张；群图片消息=${imageMessages.length} 条`,
    },
    {
      id: '②',
      text: `「库存流水」新增 ${expectedTotal} 行（每行变动数量 1），库存行为 = 采购减少 / STOCK_PURCHASE_DECREASE`,
      pass: ledgerRows.length === expectedTotal && hasReturnBehavior && ledgerRows.every((row) => Number(row.quantityChange) === 1),
      substance: {
        pass: hasReturnBehavior
          && ledgerRows.reduce((sum, row) => sum + Math.abs(Number(row.quantityChange || 0)), 0) === expectedTotal,
        text: `实现口径是「一个尺码一行、变动数量=该尺码退掉的双数」（销售/入库也是这个粒度）：`
          + `实际 ${ledgerRows.length} 行、变动数量合计 ${ledgerRows.reduce((sum, row) => sum + Math.abs(Number(row.quantityChange || 0)), 0)} 双、行为 ${JSON.stringify([...new Set(ledgerRows.flatMap((row) => row.behavior.map((b) => b.code)))])}`,
      },
      evidence: `新增流水=${JSON.stringify(ledgerRows.map((r) => ({ id: r.record_id, size: r.size, qty: r.quantityChange, behavior: r.behavior.map((b) => b.code) })))}`,
    },
    {
      id: '③',
      text: `「实时库存」对应尺码减少：被退的 ${expectedTotal} 行消失；减到 0 的尺码不再有行`,
      pass: removedLive.length === expectedTotal && sizeCheckOk,
      evidence: `消失行=${JSON.stringify(removedLive.map((r) => ({ id: r.record_id, size: r.size, state: r.state })))}；按尺码核对=${JSON.stringify(sizeChecks)}；剩余行=${JSON.stringify(liveAfter.map((r) => ({ id: r.record_id, size: r.size, state: r.state })))}`,
    },
    {
      id: '④',
      text: '每条「供应商对接」处理状态 = 已生成申请，且「关联采购申请」回填到它自己刚生成的那几行',
      pass: allMatched,
      evidence: `逐条=${JSON.stringify(reportStates.map((item) => ({ record_id: item.record_id, status: item.status, request: item.request, own_doc_rows: docCountOf(item.record_id) })))}`,
    },
    {
      id: '⑤',
      text: '往群里发 1 张退货单图 + 1 条 @经办人 的文字，并把图写回「单据信息」附件',
      pass: imageMessages.length === 1 && textMessages.length >= 1
        && textMessages.some((item) => item.mentions.length > 0)
        && requestRows.length > 0 && requestRows.every((row) => row.attachmentCount > 0),
      evidence: `群图片消息=${imageMessages.length} 条；群文字消息=${JSON.stringify(textMessages.map((item) => ({ kind: item.kind, reply_to: item.reply_to_message_id, thread_id: item.thread_id, mentions: item.mentions, text: item.text.slice(0, 50) })))}；附件回写（每条单据信息行的附件数）=${JSON.stringify(requestRows.map((r) => r.attachmentCount))}；附件上传尝试=${JSON.stringify(outbox.driveUploads)}`,
    },
  ];
  if (records > 1) {
    checks.push({
      id: '①b',
      text: `同批次号 ${records} 条记录 → 归批窗口把它们认成**一批**：只出 1 张 PNG、只发 1 次群`,
      pass: outbox.images.length === 1 && imageMessages.length === 1 && ledgerRows.length === expectedTotal
        && otherTasks.every((item) => item?.status !== 'failed'),
      evidence: `批次号=${batchNo}；同批记录=${JSON.stringify(createdIds)}；PNG=${outbox.images.length} 张；群图片消息=${imageMessages.length} 条；同批其余任务状态=${JSON.stringify(otherTasks.map((item) => item?.status))}`,
    });
  }

  head('【验收标准（跑之前写）】');
  for (const check of checks) say(`  ${check.id} ${check.text}`);
  head('【实际结果】');
  for (const check of checks) {
    say(`  ${check.id} ${check.pass ? '✅' : '❌'} ${check.text}`);
    say(`      证据：${check.evidence}`);
    if (check.substance) say(`      业务实质：${check.substance.pass ? '✅' : '❌'} ${check.substance.text}`);
  }

  // ── 附件回写（第 5 条的一部分）：到底"没写"还是"写了没记住" ──
  head('【附件回写：图有没有真写进「单据信息」】');
  say(`  drive 是**真**客户端（真上传到测试 Base）：uploadAttachment 被调用 ${outbox.driveUploads.length} 次`);
  for (const item of outbox.driveUploads) {
    say(`    ${item.ok ? '✅' : '❌'} ${item.file_name}（${item.size}B）code=${item.code} msg=${item.msg}`
      + `${item.permission_violations?.length ? ` 缺权限=${JSON.stringify(item.permission_violations)}` : ''}`);
  }
  if (!outbox.driveUploads.length) {
    say('  → 一次都没调用：说明链路在"上传附件"这一步之前就退出了（例如发图失败后 continue）。');
  }
  say(`  读回「单据信息」行的附件数=${JSON.stringify(requestRows.map((r) => ({ id: r.record_id, attachments: r.attachmentCount })))}`);

  // ── 第 7 条验收标准：是不是**一个话题** ──
  head('【第 7 条验收标准：两条消息是不是一个话题】');
  say(`  群 chat_id = ${targetChatId}`);
  say(`  第 1 条（图，顶层）：message_id=${topic.root_message_id || '(无)'} thread_id=${topic.root_thread_id || '(空)'}`);
  for (const item of topic.replies) {
    say(`  第 2+ 条（${item.kind}）：message_id=${item.message_id || '(无)'} reply→${item.reply_to_message_id || '(无)'} thread_id=${item.thread_id || '(空)'} 文本="${item.text.slice(0, 60)}"`);
  }
  say(`  群内消息条数=${groupMessages.length}；其中 reply ${topicReplies.length} 条，reply 到第 1 条 ${topicRepliesToRoot.length} 条`);
  say(`  ${topic.one_thread ? '✅' : '❌'} 硬条件：除第 1 条外**全部**是 reply，且**全部** reply 到第 1 条（没有各自顶层的消息）`);

  // ── 最强证据：用**只读**接口拿那条图消息的详情（项目代码 / 官方 SDK，不用 CLI）──
  const topicProbe = { attempted: false, ok: false, reason: '', messages: [] };
  if (flag('no-probe', false) !== true && realIm && topic.root_message_id) {
    topicProbe.attempted = true;
    const probeIds = [topic.root_message_id, ...topic.replies.map((item) => item.message_id)].filter(Boolean);
    try {
      for (const messageId of probeIds) topicProbe.messages.push(await getMessageDetail(probeClient, messageId));
      topicProbe.ok = topicProbe.messages.every((item) => item.ok);
      topicProbe.reason = topicProbe.messages.map((item) => item.error || '').filter(Boolean).join(' | ');
    } catch (error) {
      topicProbe.reason = error?.message || String(error);
    }
    say(`  只读接口 im.message.get：${topicProbe.ok ? '✅ 拿到' : `❌ 拿不到（${topicProbe.reason || '无返回'}）`}`);
    for (const item of topicProbe.messages) {
      say(`    ${item.query_message_id} → message_id=${item.message_id || '(空)'} thread_id=${item.thread_id || '(空)'} parent_id=${item.parent_id || '(空)'} root_id=${item.root_id || '(空)'} chat_id=${item.chat_id || '(空)'} msg_type=${item.msg_type || '(空)'}`
        + `${item.error ? ` error=${item.error}` : ''}`);
    }
    if (!topicProbe.ok) {
      say('    ⚠️ 拿不到通常是测试应用没开 im:message:readonly —— 照实记「拿不到」，不拿别的证据冒充。');
    } else {
      say('    ⚠️ 逐字段核对：飞书认定的 thread_id / parent_id / chat_id 才是「同一个话题」最硬的证据。');
    }
  } else {
    topicProbe.reason = realIm ? '没有拿到群消息 message_id' : '默认模式（拦发）不调只读接口';
    say(`  只读接口 im.message.get：跳过（${topicProbe.reason}）`);
  }
  // 只读接口拿到 parent_id 时，它比我们自己记的调用参数更硬：parent_id 指向的那条
  // 就是飞书认定的"话题根"。
  // 只读接口复核："第 2 条起的 parent_id 指向第 1 条" + "飞书给的 thread_id 全一致"。
  const probeConfirmsRoot = topicProbe.ok
    && topicProbe.messages.length > 1
    && topicProbe.messages.every((item) => item.chat_id === targetChatId)
    && topicProbe.messages.slice(1).every((item) => item.parent_id === topic.root_message_id
      && item.thread_id === topicProbe.messages[0].thread_id);
  if (topicProbe.ok) say(`  ${probeConfirmsRoot ? '✅' : '❌'} 只读接口复核：第 2 条起的 parent_id 都指向第 1 条，thread_id 全一致`);

  // ── 「一个话题」的最终判定 ──
  // 硬条件：除第 1 条外全是 reply 到第 1 条（= 不会再各占一个话题）。
  // 话题归属：飞书回的 thread_id 全程一致 —— **或** 只读接口确认第 2 条起的 parent_id
  // 都指向第 1 条（普通群 send 本来就不回 thread_id，这时只有只读接口能证）。
  const threadConfirmed = topic.same_thread_id || probeConfirmsRoot;
  topic.thread_confirmed = threadConfirmed;
  topic.thread_evidence = topic.same_thread_id
    ? `发送响应里的 thread_id 全一致（${topic.root_thread_id}）`
    : (probeConfirmsRoot
      ? '发送响应没有 thread_id（普通群），但只读接口确认第 2 条起的 parent_id 都指向第 1 条'
      : 'thread_id 一致与只读接口复核都没有拿到');
  topic.pass = topic.one_thread && threadConfirmed;
  say(`  发送响应里的 thread_id 相同：${topic.same_thread_id ? '✅' : '❌'}（第 1 条=${JSON.stringify(topic.root_thread_id)}，后续=${JSON.stringify(topic.thread_ids)}）`);
  if (!topic.same_thread_id && !probeConfirmsRoot) {
    say('  ⚠️ 只读接口也没能复核（多半是测试应用没开 im:message:readonly）→ 这一条**照实算没验到**。');
  }
  say(`  ${topic.pass ? '✅' : '❌'} 第 7 条「一个话题」判定：硬条件=${topic.one_thread}，话题归属=${
    threadConfirmed ? '成立' : '不成立'}（依据：${topic.thread_evidence}）`);

  const passed = checks.filter((check) => check.pass).length;
  const allChecksPass = passed === checks.length;
  const overall = allChecksPass && topic.pass;
  head(`【结论】5 条标准：${allChecksPass ? `达标（${passed}/${checks.length}）` : `未达标（${passed}/${checks.length}）`}`
    + `｜第 7 条（一个话题）：${topic.pass ? '达标 ✅' : '未达标 ❌'}`
    + `｜合计：${overall ? '全部达标 ✅' : '有未达标项 ❌'}`);
  for (const check of checks.filter((item) => !item.pass)) {
    say(`  ${check.id} 未达标：${check.text}`);
    if (check.substance) say(`     ↳ 业务实质${check.substance.pass ? '是达标的' : '也没达标'}：${check.substance.text}`);
  }
  if (!topic.pass && !topic.one_thread) say('  第 7 条未达标：群里有不是 reply 的顶层消息 → 一次提交会占多个话题。');
  if (!topic.pass && topic.one_thread) say(`  第 7 条未达标：回复到了同一条，但话题归属没被证实 —— ${topic.thread_evidence}。`);
  if (task?.status === 'failed') say(`  任务失败原因：${task.error}`);

  const report = {
    ran_at: new Date().toISOString(),
    mode: 'return',
    base_app_token: V1_BITABLE_SCHEMA.appToken,
    im: imIsFake ? 'intercepted(fake)' : 'real',
    chat_id: targetChatId,
    input: {
      recordId, recordIds: createdIds, batchNo, records, gapMs,
      productRecordId, productLabel, quantityPerRecord: qty, size: requestedSize,
      returnBehavior, operatorOpenId,
    },
    task: task ? { task_id: task.task_id, status: task.status, error: task.error || '', return_plan: task.return_plan || null, draft: task.draft || null } : null,
    batchTasks: acceptedList.map((accepted) => ({ task_id: accepted.taskId })),
    pushes: pushLog,
    before: { liveRows: liveBefore, ledgerCount: ledgerBefore.size, requestCount: requestsBefore.size },
    after: {
      liveRows: liveAfter, removedLive, ledgerRows, requestRows,
      report: { status: reportStatus, request: reportRequests, per_record: reportStates },
    },
    outbox: { images: outbox.images, messages: outbox.messages },
    // 附件回写的**原始证据**：drive 是真客户端，这里是每次 uploadAttachment 的真实应答。
    // 一条都没有 = 根本没走到上传（例如发图失败后 continue）；ok:false = 飞书明确拒绝。
    attachmentUploads: outbox.driveUploads,
    topic: { ...topic, probe: topicProbe, probe_confirms_root: probeConfirmsRoot },
    checks: checks.map((check) => ({
      id: check.id, pass: check.pass, text: check.text, evidence: check.evidence,
      substance: check.substance || null,
    })),
    passed,
    total: checks.length,
    topic_pass: topic.pass,
    overall,
  };
  fs.writeFileSync(path.join(runPath, 'report.json'), JSON.stringify(report, null, 2));
  if (task) fs.writeFileSync(path.join(runPath, 'task.json'), JSON.stringify(task, null, 2));
  say(`  证据目录：${runPath}`);
  return overall ? 0 : 1;
};

const main = async () => {
  head(`feishu-retail-ops 本地端到端自测（mode=${mode}）`);
  say(`  worktree：${repoRoot}`);
  if (mode === 'setup') return cmdSetup();
  if (mode === 'inspect') return cmdInspect();
  if (mode === 'return') return cmdReturn();
  if (mode === 'probe-message') return cmdProbeMessage();
  say(`未知子命令：${mode}（可用：setup / inspect / probe-message / return）`);
  return 3;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error('');
    console.error(`❌ 运行失败：${error.message}`);
    if (error.stack && flag('verbose', false)) console.error(error.stack);
    process.exitCode = 1;
  });
