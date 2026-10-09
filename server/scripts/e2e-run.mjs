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
 *   （原 `return` 子命令已随「信息填写」入口退场删除，2026-10-09）
 *   node scripts/e2e-run.mjs probe-message --message-id <id1,id2,...>
 *                                    只读：拿这几条消息的详情（thread_id / parent_id），
 *                                    核实「它们是不是同一个话题」。不写表、不发消息。
 *
 * 记录值/参数口径见各子命令自己的实现（原 `return` 的参数随该子命令一起删除了）。
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

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
// ⚠️ 2026-10-09：缺省子命令原先是 `return`（采购退货 E2E）——那一条已随
//   「信息填写」入口退场删除 ⇒ 缺省改成只读的 `inspect`（列出现状，不写任何表）。
const mode = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'inspect';
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
loadEnv(); // 副作用：按顺序注入环境变量（返回值原先给 return 子命令打印，已随它删除）

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { person, relation } = require('../src/services/v1ReferenceResolver');
const { classifyReportBehavior, REPORT_BEHAVIOR } = require('../src/services/purchaseBehaviorPolicy');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');

// 🔴 授权可写的测试 Base / 禁止写入的生产 Base：**一律从环境（.env）读，不硬编码**
//    （AGENTS.md 第 7 条：不许把任何 token / secret 硬编码进源码）。
//    · `FEISHU_V1_E2E_TEST_APP_TOKEN`：业务负责人授权的测试 Base（可随便写）。
//    · `FEISHU_V1_FORBIDDEN_APP_TOKENS`（或单数的 `FEISHU_V1_PROD_APP_TOKEN`）：
//      逗号分隔的**禁止写入清单**（生产 Base 放这里）—— 命中即拒绝运行。
//      ⚠️ 本机 `.env` **刻意不放生产 token**（AGENTS.md 第 8 条：物理上够不着），
//      所以这条皮带在本机是"空转"的；主闸门是下面那句
//      「app_token 必须逐字等于授权测试 Base」——它本身就挡住了生产 Base。
//      ⚠️ 生产上部署这个脚本时，请在服务器 `.env` 里填 `FEISHU_V1_FORBIDDEN_APP_TOKENS`
//      （线上 `FEISHU_V1_BITABLE_APP_TOKEN` 就是生产 Base 的值）。
const authorizedTestBase = () => String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const forbiddenAppTokens = () => String(
  process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '',
).split(',').map((item) => item.trim()).filter(Boolean);
// 只打印指纹，绝不打印 token 本身。
const tokenFingerprint = (value) => {
  const raw = String(value || '');
  return raw ? `${raw.slice(0, 6)}…(len=${raw.length})` : '(空)';
};

const line = (char = '─') => console.log(char.repeat(72));
const head = (title) => { console.log(''); line('═'); console.log(`  ${title}`); line('═'); };
const say = (...args) => console.log(...args);


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
/**
 * 把 client 的某个命名空间包一层，**只做一件事**：任何调用抛错时把「哪个接口 + 飞书
 * code/msg + 完整 URL」记下来。
 *
 * 为什么需要：自测里最贵的失败是"只看到 400，不知道打的是哪个接口"——
 * 2026-10-06 同批号 2 条退货就是这样失败的（`1254607 Data not ready`，
 * SDK 打印的 error 只有 2 层深，URL 被折叠成 [Object]），根本定不了位。
 */
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

const createClient = ({ realIm }) => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const real = new lark.Client({ appId, appSecret });
  // ⚠️ drive 一直都是**真**客户端（附件真的上传到测试 Base）——这里加的不是替身，
  // 是**留证**：记下每次 `uploadAttachment` 的调用与飞书的应答。上次报告里只看到
  // 「每条单据信息行的附件数=[0,0]」，分不清是"没走到上传"还是"上传被飞书拒了"。
  const outbox = { images: [], messages: [], driveUploads: [], apiErrors: [] };
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
    return {
      client: {
        bitable: wrapApiForDiagnostics(real.bitable, 'bitable', outbox.apiErrors),
        drive: recordingDrive,
        im: wrapApiForDiagnostics(recordingIm, 'im', outbox.apiErrors),
      },
      outbox,
      imIsFake: false,
      probeClient: real,
    };
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
  return {
    client: {
      bitable: wrapApiForDiagnostics(real.bitable, 'bitable', outbox.apiErrors),
      drive: recordingDrive,
      im: wrapApiForDiagnostics(fakeIm, 'im', outbox.apiErrors),
    },
    outbox,
    imIsFake: true,
    probeClient: real,
  };
};


// ── 小工具 ──────────────────────────────────────────────────────────────────
const listAllSafe = async (gateway, tableKey) => {
  try { return await gateway.listAll(tableKey); } catch (error) {
    say(`  ⚠️ 读取「${gateway.table(tableKey).tableName}」失败：${error.message}`);
    return [];
  }
};


// 数量字段在测试 Base / 生产 Base 的类型可能不同（number vs text），按真实类型写。

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

/**
 * 等**一批**任务全部落终态。
 * ⚠️ 不能只等第一个：`flushReturnBatch` 是「先写 batchTaskId=posted，再逐条把同批
 * 其余任务写成 completed」——只等第一个的话，会在第二个还是 batch_waiting 时就去
 * 收集证据，报告里就出现"同批其余任务状态=[batch_waiting]"这种假失败。
 */

const guardEnvironment = (gateway) => {
  const appToken = V1_BITABLE_SCHEMA.appToken;
  say(`  Base app_token：${appToken}`);
  say(`  环境标记 FEISHU_TARGET_ENV：${process.env.FEISHU_TARGET_ENV || '(未设置)'}`);
  say(`  采购群 PURCHASE_CHAT_ID：${process.env.PURCHASE_CHAT_ID || '(未设置 → 出图后不会发送)'}`);
  const testBase = authorizedTestBase();
  const forbidden = forbiddenAppTokens();
  if (!appToken) throw new Error('未配置 FEISHU_V1_BITABLE_APP_TOKEN，拒绝运行');
  if (forbidden.includes(appToken)) {
    throw new Error('检测到 app_token 在**禁止写入清单**里（生产 Base）—— 本脚本只允许写测试 Base，已拒绝运行');
  }
  if (!testBase) {
    throw new Error('缺少 FEISHU_V1_E2E_TEST_APP_TOKEN（授权可写的测试 Base），拒绝运行');
  }
  if (appToken !== testBase && flag('force-env', false) !== true) {
    throw new Error(`app_token 不等于授权的测试 Base（${tokenFingerprint(testBase)}，当前 ${tokenFingerprint(appToken)}）。`
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

// ⛔ 2026-10-09：`return` 子命令（跑一条采购退货 + 验收对照）**整个删除**。
//
// 它驱动的入口是「信息填写」表：写一条退货记录 → `accept('supplier-report')`
// → `processSupplierReturn` → 扣库存 / 出退货单 / 发群。
// 业务负责人把那张表**整个从 Base 删掉了**（`TableIdNotFound` 1254041），
// 口径是「自然语言 ＋ AI 录入」整套退场 ⇒ 服务端那一串方法与本子命令一起退场。
//
// ⚠️ 仍然可用的子命令：`setup` / `inspect` / `probe-message`
//   （`setup` 里给退货预置的「采购减少」行为**留着不碍事**：它只影响测试 Base 的
//    行为数据，不影响任何链路；真要清理由业务负责人决定）。
// ⚠️ 要恢复这条自测：从 git 历史取回（`git log -S "cmdReturn"`），
//    前提是那条入口先被重新实现。

const main = async () => {
  head(`feishu-retail-ops 本地端到端自测（mode=${mode}）`);
  say(`  worktree：${repoRoot}`);
  if (mode === 'setup') return cmdSetup();
  if (mode === 'inspect') return cmdInspect();
  if (mode === 'probe-message') return cmdProbeMessage();
  say(`未知子命令：${mode}（可用：setup / inspect / probe-message）`);
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
