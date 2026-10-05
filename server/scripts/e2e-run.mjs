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
 *
 * `return` 常用参数：
 *   --qty <n>        退货数量（默认 2）
 *   --product <rec>  货品记录 id（默认自动挑一条库存最多的货品）
 *   --size <n>       指定尺码（B 情况：只退这个尺码；不填 = A 情况：该货品全退）
 *   --report <rec>   复用一条已有的「供应商对接」记录（只借它的货品，仍会新建一条退货记录）
 *   --env-file <p>   额外的环境变量文件（凭证等），会先加载，再被 <repo>/.env.local 覆盖
 *   --real-im        真的往飞书发图/发消息（默认必须「拦」：用假的 IM 客户端记录，不外发）
 *   --chat-id <id>   覆写采购群 id（默认读 PURCHASE_CHAT_ID）
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
const createClient = ({ realIm }) => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const real = new lark.Client({ appId, appSecret });
  const outbox = { images: [], messages: [] };
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
          outbox.messages.push(params);
          return real.im.message.create(params);
        },
      },
    };
    return { client: { bitable: real.bitable, drive: real.drive, im: recordingIm }, outbox, imIsFake: false };
  }
  const fakeIm = {
    image: {
      create: async ({ data } = {}) => {
        outbox.images.push({ bytes: data?.image?.length || 0, image_type: data?.image_type });
        return { code: 0, image_key: `img_selftest_${outbox.images.length}` };
      },
    },
    message: {
      create: async (params = {}) => {
        outbox.messages.push(params);
        return { code: 0, msg: 'success', data: { message_id: `om_selftest_${outbox.messages.length}`, thread_id: '' } };
      },
    },
  };
  // 只替换 im：bitable / drive 仍然是真客户端 → 表是真的在读写。
  return { client: { bitable: real.bitable, drive: real.drive, im: fakeIm }, outbox, imIsFake: true };
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

// ── return：跑一条采购退货 + 验收对照 ────────────────────────────────────────
const cmdReturn = async () => {
  const qty = num('qty', 2);
  const realIm = flag('real-im', false) === true || flag('real-im', false) === 'true';
  const requestedProduct = flag('product', '');
  const requestedReport = flag('report', '');
  const requestedSize = flags.size === undefined ? null : num('size', null);
  if (flags['chat-id']) process.env.PURCHASE_CHAT_ID = String(flags['chat-id']);

  const { client, outbox, imIsFake } = createClient({ realIm });
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

  // ── ② 写一条「供应商对接」记录（真的写测试 Base）──
  head('③ 写入「供应商对接」记录（真写测试 Base）');
  const quantityType = await fieldTypeOf(gateway, 'purchaseReport', 'quantity');
  const values = {
    behavior: relation(returnBehavior.recordId),
    product: relation(productRecordId),
    quantity: coerceNumberCell(quantityType, qty),
    // 处理状态**不写**：它是单选，写一个不存在的选项会直接建记录失败。
    // 留空等价于"一条刚提交、还没处理过的表单记录"，链路照样能跑。
    batchNoText: `SELFTEST-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
  };
  if (requestedSize !== null) {
    const sizeTable = gateway.table('sizeManagement');
    const sizeRecords = await gateway.listAll('sizeManagement');
    const hit = sizeRecords.find((row) => Number(textValue(row.fields?.[sizeTable.fields.size])) === requestedSize);
    if (!hit) throw new Error(`「尺码管理」里没有 ${requestedSize} 码`);
    values.size = relation(hit.record_id);
  }
  if (operatorOpenId) values.operator = person(operatorOpenId);
  const created = await gateway.create('purchaseReport', values);
  const recordId = created.recordId;
  say(`  ✓ 新记录 record_id = ${recordId}`);
  say(`    数量=${qty}（字段类型 type=${quantityType}）尺码=${requestedSize === null ? '(空)' : requestedSize} 货品=${productLabel}`);

  // ── ④ 跑链路（accept = 事件入口走的那条路）──
  head('④ 跑链路：accept("supplier-report") → process → processSupplierReturn → 出图/回填');
  const accepted = await service.accept('supplier-report', recordId);
  say(`  accept → ${JSON.stringify(accepted)}`);
  let task = await waitForTask(store, accepted.taskId);
  say(`  任务状态（轮询到的）：status=${task?.status}${task?.error ? ` error=${task.error}` : ''}`);

  // ── ⑤ 收集实际效果 ──
  const liveAfter = await liveRowsOfProduct(gateway, productRecordId);
  const ledgerAfter = await listAllSafe(gateway, 'inventoryLedger');
  const newLedger = ledgerAfter.filter((row) => !ledgerBefore.has(row.record_id));
  const requestsAfter = await listAllSafe(gateway, 'purchaseRequest');
  const newRequests = requestsAfter.filter((row) => !requestsBefore.has(row.record_id));
  const idempotencyPrefix = `purchase_return:${recordId}:`;
  const myRequests = requestsAfter.filter((row) =>
    textValue(row.fields?.[gateway.table('purchaseRequest').fields.idempotencyKey]).startsWith(idempotencyPrefix));
  const reportAfter = await gateway.get('purchaseReport', recordId);

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
  const imageMessages = outbox.messages.filter((item) => item.data?.msg_type === 'image');
  const textMessages = outbox.messages
    .filter((item) => item.data?.msg_type === 'text')
    .map((item) => {
      const content = JSON.parse(item.data.content || '{}');
      return {
        receive_id: item.data.receive_id,
        receive_id_type: item.params?.receive_id_type,
        text: content.text || '',
        mentions: (content.text || '').match(/<at user_id="([^"]+)"/g) || [],
      };
    });

  const runPath = runDir(recordId);
  fs.mkdirSync(runPath, { recursive: true });
  // 轮询超时可能正好卡在最后一步（写终态）之前，这里再读一次，保证落盘的 task 是最终状态。
  const finalTask = await store.get(accepted.taskId);
  if (finalTask) task = finalTask;
  say(`  任务最终状态（重新读取）：status=${task?.status}`);
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
  const hasReturnBehavior = ledgerRows.some((row) => row.behavior.some((item) => item.code === 'STOCK_PURCHASE_DECREASE'));
  const reportStatus = textValue(reportAfter?.fields?.[reportTable.fields.status]);
  const reportRequests = linkedRecordIds(reportAfter?.fields?.[reportTable.fields.request]);
  const allMatched = reportStatus === '已生成申请' && reportRequests.length === requestRows.length && requestRows.length > 0;

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
      text: `出「采购退货单」：单据信息新增 ${requestRows.length} 行（本次退货涉及 ${new Set(requestRows.map((r) => r.size)).size} 个尺码），合计 ${totalReturned} 双 = 填的 ${qty}`,
      pass: requestRows.length > 0 && totalReturned === qty && totalReturned <= scoped.length,
      evidence: `单据信息行=${JSON.stringify(requestRows.map((r) => ({ id: r.record_id, size: r.size, qty: r.quantity })))}；PNG=${outbox.images.length} 张`,
    },
    {
      id: '②',
      text: `「库存流水」新增 ${qty} 行（每行变动数量 1），库存行为 = 采购减少 / STOCK_PURCHASE_DECREASE`,
      pass: ledgerRows.length === qty && hasReturnBehavior && ledgerRows.every((row) => Number(row.quantityChange) === 1),
      substance: {
        pass: hasReturnBehavior
          && ledgerRows.reduce((sum, row) => sum + Math.abs(Number(row.quantityChange || 0)), 0) === qty,
        text: `实现口径是「一个尺码一行、变动数量=该尺码退掉的双数」（销售/入库也是这个粒度）：`
          + `实际 ${ledgerRows.length} 行、变动数量合计 ${ledgerRows.reduce((sum, row) => sum + Math.abs(Number(row.quantityChange || 0)), 0)} 双、行为 ${JSON.stringify([...new Set(ledgerRows.flatMap((row) => row.behavior.map((b) => b.code)))])}`,
      },
      evidence: `新增流水=${JSON.stringify(ledgerRows.map((r) => ({ id: r.record_id, size: r.size, qty: r.quantityChange, behavior: r.behavior.map((b) => b.code) })))}`,
    },
    {
      id: '③',
      text: `「实时库存」对应尺码减少：被退的 ${qty} 行消失；减到 0 的尺码不再有行`,
      pass: removedLive.length === qty && sizeCheckOk,
      evidence: `消失行=${JSON.stringify(removedLive.map((r) => ({ id: r.record_id, size: r.size, state: r.state })))}；按尺码核对=${JSON.stringify(sizeChecks)}；剩余行=${JSON.stringify(liveAfter.map((r) => ({ id: r.record_id, size: r.size, state: r.state })))}`,
    },
    {
      id: '④',
      text: '「供应商对接」处理状态 = 已生成申请，且「关联采购申请」回填到刚生成的那几行',
      pass: allMatched,
      evidence: `处理状态=${reportStatus || '(空)'}；关联采购申请=${JSON.stringify(reportRequests)}；单据信息行=${JSON.stringify(requestRows.map((r) => r.record_id))}`,
    },
    {
      id: '⑤',
      text: '往群里发 1 张退货单图 + 1 条 @经办人 的文字，并把图写回「单据信息」附件',
      pass: imageMessages.length === 1 && textMessages.length >= 1
        && textMessages.some((item) => item.mentions.length > 0)
        && requestRows.length > 0 && requestRows.every((row) => row.attachmentCount > 0),
      evidence: `图片消息=${imageMessages.length} 条；文字消息=${JSON.stringify(textMessages)}；附件回写（每条单据信息行的附件数）=${JSON.stringify(requestRows.map((r) => r.attachmentCount))}`,
    },
  ];

  head('【验收标准（跑之前写）】');
  for (const check of checks) say(`  ${check.id} ${check.text}`);
  head('【实际结果】');
  for (const check of checks) {
    say(`  ${check.id} ${check.pass ? '✅' : '❌'} ${check.text}`);
    say(`      证据：${check.evidence}`);
    if (check.substance) say(`      业务实质：${check.substance.pass ? '✅' : '❌'} ${check.substance.text}`);
  }
  const passed = checks.filter((check) => check.pass).length;
  head(`【结论】按上面写死的 5 条标准：${passed === checks.length ? '达标（5/5）' : `未达标（${passed}/5）`}`);
  for (const check of checks.filter((item) => !item.pass)) {
    say(`  ${check.id} 未达标：${check.text}`);
    if (check.substance) say(`     ↳ 业务实质${check.substance.pass ? '是达标的' : '也没达标'}：${check.substance.text}`);
  }
  if (task?.status === 'failed') say(`  任务失败原因：${task.error}`);

  const report = {
    ran_at: new Date().toISOString(),
    mode: 'return',
    base_app_token: V1_BITABLE_SCHEMA.appToken,
    im: imIsFake ? 'intercepted(fake)' : 'real',
    chat_id: process.env.PURCHASE_CHAT_ID || '',
    input: { recordId, productRecordId, productLabel, quantity: qty, size: requestedSize, returnBehavior, operatorOpenId },
    task: task ? { task_id: task.task_id, status: task.status, error: task.error || '', return_plan: task.return_plan || null, draft: task.draft || null } : null,
    before: { liveRows: liveBefore, ledgerCount: ledgerBefore.size, requestCount: requestsBefore.size },
    after: { liveRows: liveAfter, removedLive, ledgerRows, requestRows, report: { status: reportStatus, request: reportRequests } },
    outbox: { images: outbox.images, messages: outbox.messages },
    checks: checks.map((check) => ({
      id: check.id, pass: check.pass, text: check.text, evidence: check.evidence,
      substance: check.substance || null,
    })),
    passed,
    total: checks.length,
  };
  fs.writeFileSync(path.join(runPath, 'report.json'), JSON.stringify(report, null, 2));
  if (task) fs.writeFileSync(path.join(runPath, 'task.json'), JSON.stringify(task, null, 2));
  say(`  证据目录：${runPath}`);
  return passed === checks.length ? 0 : 1;
};

const main = async () => {
  head(`feishu-retail-ops 本地端到端自测（mode=${mode}）`);
  say(`  worktree：${repoRoot}`);
  if (mode === 'setup') return cmdSetup();
  if (mode === 'inspect') return cmdInspect();
  if (mode === 'return') return cmdReturn();
  say(`未知子命令：${mode}（可用：setup / inspect / return）`);
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
