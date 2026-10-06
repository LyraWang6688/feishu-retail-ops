#!/usr/bin/env node
/**
 * e2e-report-qty.mjs —— 验收「供应商报货的**数量说明不是默认 1**时，
 * AI 能不能准确识别 ＋「单据信息」是不是同步增加」。
 *
 * 业务负责人的原话（逐字）：
 *   「以及采购申请里数量不是默认 1 的时候，AI 是否可以准确识别，
 *     以及是否单据信息会同步增加」
 *
 * 为什么单独一个脚本（而不是加进 e2e-run.mjs）：
 *   · e2e-run.mjs 现在只有 setup / inspect / return 三个子命令，没有"报货"；
 *   · 而且有别人正在改那个文件（补 reply）——并行改同一个文件会在合并时打架，
 *     所以这里**新建一个独立脚本**，两者互不影响。
 *
 * 入口**走项目自己的代码**（不是用 CLI 手工拼结果）：
 *   new PurchaseWebhookService({...}) → service.accept('supplier-report', recordId)
 *   —— 这就是生产上「表变更事件」走的那条路（AGENTS.md 第 7 条：
 *      测试必须直接加载项目源码、调项目自己的入口函数）。
 *
 * 子命令：
 *   node scripts/e2e-report-qty.mjs run      跑全部用例（默认）：写测试 Base → 跑链路 → 出对照表
 *   node scripts/e2e-report-qty.mjs inspect  只读：打印环境指向、货品/尺码/行为现状（不写任何表）
 *   node scripts/e2e-report-qty.mjs criteria 只打印**跑之前写下来的验收标准**（不联网、不写表）
 *
 * 常用参数：
 *   --only <id,id>       只跑指定用例（见 criteria 输出里的 id）
 *   --repeat <n>         每个用例重复 n 次（默认 1）：区分"这个说法系统性不被识别"与"模型偶发抽风"
 *   --product <rec>      货品记录 id（默认取 FEISHU_V1_E2E_PRODUCT_RECORD_ID，再兜底库存最多的货品）
 *   --env-file <p>       额外的环境变量文件（凭证），在 <repo>/.env 之后、<repo>/.env.local 之前加载
 *   --real-im            ⚠️ 真的往飞书发图/发消息（默认**必须拦**：用假 IM 客户端，不外发）
 *   --timeout <ms>       单个用例等链路跑完的上限（默认 180000）
 *
 * 环境变量加载顺序（后者覆盖前者）：
 *   1. <repo>/.env          （worktree 里通常是软链到主工作区的 .env）
 *   2. --env-file <p>
 *   3. <repo>/.env.local    （可选）
 *
 * ── 安全闸门（写死在脚本里，且**不含任何 token 明文**）────────────────────────
 *   ① 目标 Base app_token 必须 **等于** `FEISHU_V1_E2E_TEST_APP_TOKEN`（都从 .env 读）；
 *   ② `FEISHU_TARGET_ENV` 必须是 `test`；
 *   ③ 可选加固：若环境里给了生产 Base token 的指纹（`FEISHU_PROD_APP_TOKEN_SHA256`，
 *      sha256 十六进制前若干位），命中即拒绝运行。
 *   ⚠️ 这里**刻意不照抄** e2e-run.mjs 里"把生产 token 明文写死当闸门"的写法
 *      （AGENTS.md 列为待改的已知违规）——闸门靠"与 .env 里的测试 Base 相等"成立，
 *      不需要知道生产 token 是什么值。
 *   ⚠️ 全程不打印任何 token / secret 值，只打印「有没有」与指纹。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *   · 只写测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN 指向的那个）；生产 Base 一个字都不写；
 *   · 严禁飞书 CLI：读写一律经项目自己的 gateway（官方 SDK）；
 *   · 不真发群消息：IM 默认用假客户端记录（--real-im 才会真发）。
 *
 * 产物（每次运行一个目录）：
 *   server/data/selftest-report-qty/runs/<run_id>/report.json   结构化证据（含每个用例的原文/解析/单据行）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数，收到 ${raw}`);
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
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const doubaoService = require('../src/services/doubaoService');

const say = (...args) => console.log(...args);
const line = (char = '─') => say(char.repeat(78));
const head = (title) => { say(''); line('═'); say(`  ${title}`); line('═'); };
const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const fp = (value) => sha256Hex(value).slice(0, 12);

// ── 安全闸门：只看"目标 == .env 里授权的测试 Base"，不硬编码任何 token ─────────
const guardEnvironment = () => {
  const target = String(V1_BITABLE_SCHEMA.appToken || '');
  const testToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
  const prodFp = String(process.env.FEISHU_PROD_APP_TOKEN_SHA256 || '').trim().toLowerCase();

  say(`  目标 Base app_token 指纹：${target ? fp(target) : '(空)'}（只打指纹，不打值）`);
  say(`  FEISHU_V1_E2E_TEST_APP_TOKEN：${testToken ? '已配置' : '✗ 未配置'}`);
  say(`  目标 == 授权可写的测试 Base：${target && target === testToken ? '是 ✓' : '否 ✗'}`);
  say(`  FEISHU_TARGET_ENV：${targetEnv || '(未设置)'}${targetEnv === 'test' ? ' ✓' : ' ✗（必须是 test）'}`);
  say(`  生产 Base 指纹闸门（FEISHU_PROD_APP_TOKEN_SHA256）：${prodFp ? `已配置（${prodFp.slice(0, 8)}…）` : '未配置（可选加固）'}`);
  say(`  模型（TEXT_LLM_MODEL）：${process.env.TEXT_LLM_MODEL || '(未配置)'}｜API key：${process.env.TEXT_LLM_API_KEY ? '已配置' : '✗ 未配置'}`);
  say(`  采购群 PURCHASE_CHAT_ID：${process.env.PURCHASE_CHAT_ID ? '已配置' : '未配置'}`);

  if (!target) throw new Error('未配置 FEISHU_V1_BITABLE_APP_TOKEN，拒绝运行');
  if (!testToken) throw new Error('未配置 FEISHU_V1_E2E_TEST_APP_TOKEN —— 无法确认目标是授权的测试 Base，拒绝运行');
  if (target !== testToken) {
    throw new Error('目标 app_token ≠ FEISHU_V1_E2E_TEST_APP_TOKEN —— 本脚本只允许写测试 Base，已拒绝运行');
  }
  if (targetEnv !== 'test') throw new Error('FEISHU_TARGET_ENV 不是 test，拒绝运行');
  if (prodFp && sha256Hex(target).startsWith(prodFp)) {
    throw new Error('目标 app_token 的指纹命中生产 Base 指纹（FEISHU_PROD_APP_TOKEN_SHA256），已拒绝运行');
  }
};

// ── 飞书客户端：bitable / drive 是真的，IM 默认用假的（拦住真实外发）──────────
const createClient = ({ realIm }) => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const real = new lark.Client({ appId, appSecret });
  const outbox = { images: [], messages: [] };
  const record = (params) => { outbox.messages.push(params); return outbox.messages.length; };
  const replyResult = (index) => ({ code: 0, msg: 'success', data: { message_id: `om_selftest_${index}`, thread_id: '' } });
  if (realIm) {
    const recordingIm = {
      image: {
        create: async (params = {}) => {
          outbox.images.push({ bytes: params?.data?.image?.length || 0, image_type: params?.data?.image_type });
          return real.im.image.create(params);
        },
      },
      message: {
        create: async (params = {}) => { record(params); return real.im.message.create(params); },
        reply: async (params = {}) => { record(params); return real.im.message.reply(params); },
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
      create: async (params = {}) => replyResult(record(params)),
      // 采购单第 2 条起是「回复第 1 条」（走话题），假客户端也要能应。
      reply: async (params = {}) => replyResult(record(params)),
    },
  };
  // 只替换 im：bitable / drive 仍然是真客户端 → 表是真的在读写。
  return { client: { bitable: real.bitable, drive: real.drive, im: fakeIm }, outbox, imIsFake: true };
};

// ── 服务组装（照 e2e-run.mjs 的做法：项目自己的 service + 项目自己的 gateway）──
const buildService = ({ client }) => {
  const gateway = new V1BitableGateway({ client });
  const store = new JsonTaskStore({
    dir: path.join(serverRoot, 'data', 'selftest-report-qty', 'purchase_webhook_tasks'),
    idField: 'task_id',
  });
  const inventoryStore = new JsonTaskStore({
    dir: path.join(serverRoot, 'data', 'selftest-report-qty', 'inventory_operations'),
    idField: 'operation_id',
  });
  // AI 解析结果录制器：把模型**原样**吐出来的东西记下来，作为"AI 解析出多少"的证据。
  // 只包一层，解析/校验逻辑本身仍然走项目代码（doubaoService.parsePurchaseReportText）：
  //   · 在 SDK 客户端上录**原始响应**（模型返回的 JSON 原文，含解析失败时返回的空数组）；
  //   · 在外层录**项目代码解析后的 items**（成功）或错误信息（失败）。
  // 这样"她说 X、AI 听成 Y"能直接拿原文对照，而不是只看链路最后的报错。
  const rawModelOutputs = [];
  const applyRawRecorder = () => {
    const llmClient = doubaoService.getClient('text');
    const completions = llmClient?.chat?.completions;
    if (!completions || completions.__selftestRecorded) return;
    const original = completions.create.bind(completions);
    completions.create = async (params) => {
      const response = await original(params);
      rawModelOutputs.push({
        model: params?.model || '',
        content: response?.choices?.[0]?.message?.content || '',
      });
      return response;
    };
    completions.__selftestRecorded = true;
  };
  applyRawRecorder();

  const aiParses = [];
  const recognizer = {
    async parsePurchaseReportText(text, context = {}) {
      const mark = rawModelOutputs.length;
      const selectedSizes = Array.isArray(context?.selectedSizes) ? context.selectedSizes.slice() : [];
      try {
        const items = await doubaoService.parsePurchaseReportText(text, context);
        aiParses.push({
          text: String(text || ''),
          selectedSizes,
          model: process.env.TEXT_LLM_MODEL || '',
          ok: true,
          items: items.map((item) => ({ size: item.size, quantity: item.quantity })),
          raw: rawModelOutputs.slice(mark),
        });
        return items;
      } catch (error) {
        // 解析失败（模型给了空数组 / 给了非法尺码或数量）也要留证：这正是"错的情况"。
        aiParses.push({
          text: String(text || ''),
          selectedSizes,
          model: process.env.TEXT_LLM_MODEL || '',
          ok: false,
          error: error.message,
          items: null,
          raw: rawModelOutputs.slice(mark),
        });
        throw error;
      }
    },
  };
  const service = new PurchaseWebhookService({
    client,
    gateway,
    store,
    recognizer,
    inventory: new InventoryService({ gateway, store: inventoryStore }),
  });
  return { gateway, store, service, aiParses };
};

// ── 验收标准（**跑之前先写下来** —— 业务负责人的规矩：先写预期，再跑，再逐条对照）──
const CRITERIA = [
  '① AI 解析出的【总双数】= 数量说明里说的数（分尺码说时，每个尺码的数量也要对）',
  '② 「单据信息」（= 采购申请）新增的行数 = 实际明细行数（勾了几个尺码就有几行；'
    + '分尺码说 → 每个尺码一行，数量各自正确）',
  '③ 「供应商对接」处理状态 = 「已生成申请」，且「关联采购申请」回填到本次生成的那几行',
  '④ 说不清/说不通（0 双、2.5 双）时必须**拒绝写单**：宁可不写，也不许猜一个整数写进去',
  '⑤ 全程只写测试 Base；IM 用假客户端（不发群、不发图）——链路本身仍然是真的',
];

// 用例：每个用例 = 在「供应商对接」新建一条记录（货品 + 尺码 + 数量说明）→ accept → 读结果。
// ⚠️ 单条用例**不写报货批次号**：走「没有批次号的单条处理」这条路（同一次 accept 入口，
//    少一个 4 秒归批窗口、每条用例互不干扰）。归批那条路单独放在 B1 里测。
const CASES = [
  { id: 'C1', label: '3 双', sizes: [38], text: '3 双', expect: { type: 'post', bySize: { 38: 3 } } },
  { id: 'C2', label: '共 5 双', sizes: [38], text: '共 5 双', expect: { type: 'post', bySize: { 38: 5 } } },
  { id: 'C3', label: '2 双', sizes: [38], text: '2 双', expect: { type: 'post', bySize: { 38: 2 } } },
  {
    id: 'C4', label: '分尺码：38 码 2 双，39 码 3 双', sizes: [38, 39],
    text: '38 码 2 双，39 码 3 双', expect: { type: 'post', bySize: { 38: 2, 39: 3 } },
  },
  { id: 'C5', label: '1 双（对照组）', sizes: [38], text: '1 双', expect: { type: 'post', bySize: { 38: 1 } } },
  { id: 'C6', label: '一双（中文数字）', sizes: [38], text: '一双', expect: { type: 'post', bySize: { 38: 1 } } },
  { id: 'C7', label: '两双（中文数字）', sizes: [38], text: '两双', expect: { type: 'post', bySize: { 38: 2 } } },
  { id: 'C8', label: '0 双（边界：应拒绝）', sizes: [38], text: '0 双', expect: { type: 'reject' } },
  { id: 'C9', label: '10 双', sizes: [38], text: '10 双', expect: { type: 'post', bySize: { 38: 10 } } },
  { id: 'C10', label: '2.5 双（边界：应拒绝）', sizes: [38], text: '2.5 双', expect: { type: 'reject' } },
];

// 补充诊断用例（默认**不跑**，用 --only D1,D2… 或 --diagnostics 跑）：
// 首轮发现「10 双」连续 4 次都被模型解析成空数组（链路直接失败），
// 这几个变体用来定位「是两位数本身的问题，还是缺了尺码/量词上下文」。
const DIAGNOSTIC_CASES = [
  { id: 'D1', label: '共 10 双（加"共"）', sizes: [38], text: '共 10 双', expect: { type: 'post', bySize: { 38: 10 } } },
  { id: 'D2', label: '38 码 10 双（显式尺码）', sizes: [38], text: '38 码 10 双', expect: { type: 'post', bySize: { 38: 10 } } },
  { id: 'D3', label: '10双（无空格）', sizes: [38], text: '10双', expect: { type: 'post', bySize: { 38: 10 } } },
  { id: 'D4', label: '9 双（个位数对照）', sizes: [38], text: '9 双', expect: { type: 'post', bySize: { 38: 9 } } },
  { id: 'E1', label: '11 双（另一个两位数）', sizes: [38], text: '11 双', expect: { type: 'post', bySize: { 38: 11 } } },
  { id: 'E2', label: '12 双（再一个两位数）', sizes: [38], text: '12 双', expect: { type: 'post', bySize: { 38: 12 } } },
];

// 加分用例：一次提交 = 多条记录（每条一个尺码）+ 同一个报货批次号 → 走真正的归批窗口。
// 这是生产表单提交多尺码时的形态，用来回答"单据信息会不会同步增加"。
const BATCH_CASE = {
  id: 'B1',
  label: '分尺码 + 归批（两条记录同一报货批次号，各自只说一个尺码）',
  text: '38 码 2 双，39 码 3 双',
  rows: [{ sizes: [38] }, { sizes: [39] }],
  expect: { type: 'post', bySize: { 38: 2, 39: 3 } },
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const waitForTask = async (store, taskId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let task = null;
  let last = '';
  while (Date.now() < deadline) {
    task = await store.get(taskId);
    const now = `${task?.status || 'missing'}`;
    if (now !== last) { last = now; }
    if (task && ['posted', 'completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await sleep(400);
  }
  return task;
};

const sumItems = (items) => (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
const bySizeOf = (items) => (items || []).reduce((acc, item) => {
  const key = String(item.size);
  acc[key] = (acc[key] || 0) + Number(item.quantity || 0);
  return acc;
}, {});
// 把「模型原文 → 项目代码解析结果」写成人能读的一行（失败时也写，这正是最有价值的证据）。
const describeParses = (parses) => (parses && parses.length
  ? parses.map((item) => {
    const heads = `尺码=[${item.selectedSizes.join(',')}]`;
    const raw = item.raw?.[0]?.content;
    const rawText = raw === undefined ? '(未录到响应)' : String(raw).replace(/\s+/g, ' ');
    return item.ok
      ? `${heads} 模型原文=${rawText} → 解析出 ${JSON.stringify(item.items)}`
      : `${heads} 模型原文=${rawText} → ✗ ${item.error}`;
  }).join(' ｜ ')
  : '(没有调用到解析器)');
const parseCells = (parses) => (parses && parses.length
  ? parses.map((item) => (item.ok ? JSON.stringify(item.items) : `✗ ${item.error}`)).join('+')
  : '(未调用)');

// ── inspect：只读现状 ───────────────────────────────────────────────────────
const cmdInspect = async () => {
  const { client } = createClient({ realIm: false });
  const { gateway } = buildService({ client });
  head('inspect：本脚本指向哪个 Base、链路前置条件如何（只读，不写任何表）');
  guardEnvironment();
  say('  环境变量来源：');
  for (const item of envSources) say(`    · ${item}`);

  const sizeTable = gateway.table('sizeManagement');
  const sizes = await gateway.listAll('sizeManagement');
  say(`  「尺码管理」共 ${sizes.length} 条：${sizes.map((r) => textValue(r.fields?.[sizeTable.fields.size])).sort((a, b) => Number(a) - Number(b)).join('、')}`);

  const productTable = gateway.table('product');
  const preferred = process.env.FEISHU_V1_E2E_PRODUCT_RECORD_ID || '';
  const live = await gateway.listAll('liveInventory');
  const liveTable = gateway.table('liveInventory');
  const counts = new Map();
  for (const row of live) {
    for (const id of linkedRecordIds(row.fields?.[liveTable.fields.product])) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const products = await gateway.listAll('product');
  const show = (record) => (record
    ? `${record.record_id} ${textValue(record.fields?.[productTable.fields.number])}`
    : '(不存在)');
  say(`  E2E 货品（FEISHU_V1_E2E_PRODUCT_RECORD_ID）：${preferred ? show(products.find((r) => r.record_id === preferred)) : '(未配置)'}`);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  say('  实时库存最多的 3 个货品：');
  for (const [recordId, count] of top) say(`    ${show(products.find((r) => r.record_id === recordId))} → ${count} 行`);

  const behaviorTable = gateway.table('behavior');
  const behaviors = await gateway.listAll('behavior');
  say(`  「行为管理」里 code=PURCHASE_ORDER 的行为：${behaviors
    .filter((r) => textValue(r.fields?.[behaviorTable.fields.code]) === 'PURCHASE_ORDER')
    .map((r) => `${textValue(r.fields?.[behaviorTable.fields.name])}=${r.record_id}`).join('，') || '(缺失！报货会被当成采购申请处理，但仍需要它在记录里)'}`);
  return 0;
};

const cmdCriteria = async () => {
  head('【验收标准（跑之前写下来的）】');
  for (const item of CRITERIA) say(`  ${item}`);
  head('【用例清单】');
  for (const item of CASES) say(`  ${item.id}  尺码=[${item.sizes.join(',')}]  数量说明：「${item.text}」  预期=${JSON.stringify(item.expect)}`);
  say(`  ${BATCH_CASE.id}  尺码=[38]+[39]（两条记录）  数量说明：「${BATCH_CASE.text}」  预期=${JSON.stringify(BATCH_CASE.expect)}`);
  return 0;
};

// ── run：跑用例 ─────────────────────────────────────────────────────────────
const cmdRun = async () => {
  const realIm = flag('real-im', false) === true || flag('real-im', false) === 'true';
  const timeoutMs = num('timeout', 180_000);
  const only = String(flag('only', '')).split(',').map((item) => item.trim()).filter(Boolean);

  const { client, outbox, imIsFake } = createClient({ realIm });
  const { gateway, store, service, aiParses } = buildService({ client });

  head('【验收标准（跑之前写下来的）】');
  for (const item of CRITERIA) say(`  ${item}`);

  head('① 环境');
  guardEnvironment();
  say(`  IM：${imIsFake ? '已拦截（假客户端记录，不发真实消息）✓' : '⚠️ 真实外发（会真的发到采购群）'}`);
  say('  环境变量来源：');
  for (const item of envSources) say(`    · ${item}`);

  head('② 前置数据');
  // 尺码：size → record_id
  const sizeTable = gateway.table('sizeManagement');
  const sizeRecords = await gateway.listAll('sizeManagement');
  const sizeIdByNumber = new Map(sizeRecords.map((row) => [Number(textValue(row.fields?.[sizeTable.fields.size])), row.record_id]));
  const resolveSize = (size) => {
    const recordId = sizeIdByNumber.get(Number(size));
    if (!recordId) throw new Error(`「尺码管理」里没有 ${size} 码`);
    return recordId;
  };

  // 货品：--product > FEISHU_V1_E2E_PRODUCT_RECORD_ID > 实时库存最多的那个
  const productTable = gateway.table('product');
  const productRows = await gateway.listAll('product');
  let productRecordId = String(flag('product', '') || process.env.FEISHU_V1_E2E_PRODUCT_RECORD_ID || '');
  if (!productRecordId) {
    const liveTable = gateway.table('liveInventory');
    const counts = new Map();
    for (const row of await gateway.listAll('liveInventory')) {
      for (const id of linkedRecordIds(row.fields?.[liveTable.fields.product])) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) throw new Error('测试 Base 的实时库存是空的，挑不出货品');
    productRecordId = top[0];
  }
  const product = productRows.find((row) => row.record_id === productRecordId);
  if (!product) throw new Error(`货品记录不存在：${productRecordId}`);
  const productLabel = textValue(product.fields?.[productTable.fields.number]);
  say(`  货品：${productRecordId} ${productLabel}`);

  // 采购申请行为（报货分流靠它；留空会被当成采购申请，但表里最好显式带上）
  const behaviorTable = gateway.table('behavior');
  const behaviorRows = await gateway.listAll('behavior');
  const orderBehavior = behaviorRows.find((row) => textValue(row.fields?.[behaviorTable.fields.code]) === 'PURCHASE_ORDER');
  say(`  采购申请行为（PURCHASE_ORDER）：${orderBehavior ? `${textValue(orderBehavior.fields?.[behaviorTable.fields.name])}（${orderBehavior.record_id}）` : '✗ 缺失'}`);

  // 经办人：借一条已有报单记录的 operator（@人要真的 open_id；取不到就留空，链路照跑）
  const reportTable = gateway.table('purchaseReport');
  let operatorOpenId = '';
  for (const row of await gateway.listAll('purchaseReport')) {
    const cell = row.fields?.[reportTable.fields.operator];
    const first = Array.isArray(cell) ? cell[0] : cell;
    const id = first?.id || first?.open_id || '';
    if (id) { operatorOpenId = id; break; }
  }
  say(`  经办人 open_id：${operatorOpenId ? '已借到（不打印值）' : '(没取到 → 群消息不会 @人，不影响单据)'}`);

  const requestTable = gateway.table('purchaseRequest');

  // ── 单个用例的执行器 ──
  const runOne = async (testCase) => {
    const parseMark = aiParses.length;
    const requestsBefore = new Set((await gateway.listAll('purchaseRequest')).map((row) => row.record_id));
    const values = {
      product: relation(productRecordId),
      size: testCase.sizes.flatMap((size) => relation(resolveSize(size))),
      quantityDescription: testCase.text,
    };
    if (orderBehavior) values.behavior = relation(orderBehavior.record_id);
    if (operatorOpenId) values.operator = person(operatorOpenId);
    // 处理状态**不写**：留空 = 一条刚提交、还没处理过的表单记录。
    const created = await gateway.create('purchaseReport', values);
    const recordId = created.recordId;

    const accepted = await service.accept('supplier-report', recordId);
    const task = await waitForTask(store, accepted.taskId, timeoutMs);
    const fresh = await gateway.get('purchaseReport', recordId);
    const requestsAfter = await gateway.listAll('purchaseRequest');
    const newRowIds = requestsAfter
      .filter((row) => !requestsBefore.has(row.record_id))
      .map((row) => row.record_id);
    const mine = requestsAfter.filter((row) => {
      const key = textValue(row.fields?.[requestTable.fields.idempotencyKey]);
      return key.startsWith(`purchase_request:${accepted.taskId}:`);
    });
    const rows = mine.map((row) => ({
      record_id: row.record_id,
      size: Number(textValue(row.fields?.[requestTable.fields.size])) || textValue(row.fields?.[requestTable.fields.size]),
      quantity: Number(row.fields?.[requestTable.fields.quantity]),
      idempotencyKey: textValue(row.fields?.[requestTable.fields.idempotencyKey]),
    })).sort((a, b) => Number(a.size) - Number(b.size));

    return {
      recordId,
      taskId: accepted.taskId,
      duplicate: Boolean(accepted.duplicate),
      taskStatus: task?.status || 'missing',
      taskError: task?.error || '',
      status: textValue(fresh?.fields?.[reportTable.fields.status]),
      requestLinks: linkedRecordIds(fresh?.fields?.[reportTable.fields.request]),
      rows,
      newRowIds,
      modelParses: aiParses.slice(parseMark),
      planItems: (task?.posting_plan?.items || []).map((item) => ({ size: item.size, quantity: item.quantity })),
      draftItems: (task?.draft?.items || []).map((item) => ({ size: item.size, quantity: item.quantity })),
    };
  };

  const judge = (testCase, result) => {
    const actualBySize = bySizeOf(result.rows);
    const expectedTotal = sumItems(Object.entries(testCase.expect.bySize || {}).map(([size, quantity]) => ({ size, quantity })));
    const actualTotal = sumItems(result.rows);
    const rawTotal = sumItems((result.modelParses || [])[0]?.items || []);
    if (testCase.expect.type === 'reject') {
      const pass = result.taskStatus === 'failed' && result.rows.length === 0 && result.status !== '已生成申请';
      return {
        pass,
        totalExpected: null,
        totalActual: actualTotal,
        aiTotal: rawTotal,
        note: pass
          ? `按预期拒绝写单：任务 failed（${result.taskError || '无错误信息'}），单据信息 0 行 ✓`
          : `本应拒绝却写单/没失败：任务 ${result.taskStatus}，单据信息 ${result.rows.length} 行，状态=${result.status || '(空)'}`,
      };
    }
    const expectedBySize = Object.fromEntries(Object.entries(testCase.expect.bySize).map(([size, quantity]) => [String(size), quantity]));
    const rowsOk = result.rows.length === Object.keys(expectedBySize).length;
    const sizesOk = Object.entries(expectedBySize).every(([size, quantity]) => actualBySize[size] === quantity);
    const noExtra = Object.keys(actualBySize).every((size) => expectedBySize[size] !== undefined);
    const totalOk = actualTotal === expectedTotal;
    const statusOk = result.status === '已生成申请'
      && result.requestLinks.length === result.rows.length && result.rows.length > 0;
    const pass = rowsOk && sizesOk && noExtra && totalOk && statusOk && result.taskStatus !== 'failed';
    const notes = [];
    if (!totalOk) notes.push(`总双数 ${actualTotal} ≠ 她说的 ${expectedTotal}`);
    if (!rowsOk) notes.push(`单据信息 ${result.rows.length} 行 ≠ 预期 ${Object.keys(expectedBySize).length} 行`);
    if (!sizesOk || !noExtra) notes.push(`按尺码对不上（实际 ${JSON.stringify(actualBySize)}，预期 ${JSON.stringify(expectedBySize)}）`);
    if (!statusOk) notes.push(`处理状态=${result.status || '(空)'}，回填 ${result.requestLinks.length} 条 / 单据 ${result.rows.length} 行`);
    if (result.taskStatus === 'failed') notes.push(`任务失败：${result.taskError}`);
    return {
      pass,
      totalExpected: expectedTotal,
      totalActual: actualTotal,
      aiTotal: rawTotal,
      note: pass ? '与预期一致 ✓' : notes.join('；'),
    };
  };

  const selected = only.length
    ? [...CASES, ...DIAGNOSTIC_CASES].filter((item) => only.includes(item.id))
    : (flag('diagnostics', false) === true ? [...CASES, ...DIAGNOSTIC_CASES] : CASES);
  // --repeat：同一个说法的模型解析天然有波动（同样一句话可能一次解析出来、一次返回空）。
  // 默认 1 次；要区分"这个说法系统性不被识别"还是"模型偶发抽风"就加 --repeat 3。
  const repeat = num('repeat', 1);
  const results = [];

  head('③ 逐条跑（每条：新建「供应商对接」记录 → accept("supplier-report") → 等链路 → 读结果）');
  for (const testCase of selected) {
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      const tag = repeat > 1 ? `${testCase.id}#${attempt}` : testCase.id;
      line();
      say(`  ${tag} 数量说明原文：「${testCase.text}」｜尺码=[${testCase.sizes.join(',')}]`);
      let result;
      try {
        result = await runOne(testCase);
      } catch (error) {
        say(`    ✗ 用例执行出错：${error.message}`);
        results.push({ case: { ...testCase, id: tag }, error: error.message });
        continue;
      }
      const verdict = judge(testCase, result);
      say(`    「供应商对接」record_id = ${result.recordId}｜任务 ${result.taskId}`);
      say(`    任务状态=${result.taskStatus}${result.taskError ? `（错误：${result.taskError}）` : ''}`);
      say(`    AI 解析：${describeParses(result.modelParses)}`);
      say(`    写入明细（含默认 1 的尺码）：${JSON.stringify(result.draftItems)}`);
      say(`    「单据信息」新增 ${result.rows.length} 行：${JSON.stringify(result.rows.map((row) => ({ 尺码: row.size, 数量: row.quantity, id: row.record_id })))}`);
      say(`    「供应商对接」处理状态=${result.status || '(空)'}｜关联采购申请 ${result.requestLinks.length} 条`);
      say(`    判定：${verdict.pass ? '✅ 通过' : '❌ 未通过'} —— ${verdict.note}`);
      results.push({ case: { ...testCase, id: tag }, result, verdict });
    }
  }

  // ── 加分用例：归批 ──
  if (!only.length || only.includes(BATCH_CASE.id)) {
    line();
    say(`  ${BATCH_CASE.id} ${BATCH_CASE.label}`);
    say(`    数量说明原文：「${BATCH_CASE.text}」（两条记录各自只勾一个尺码，共用同一个报货批次号 → 走 4 秒归批窗口）`);
    try {
      const parseMark = aiParses.length;
      const requestsBefore = new Set((await gateway.listAll('purchaseRequest')).map((row) => row.record_id));
      const batchNo = `SELFTEST-QTY-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      const created = [];
      for (const row of BATCH_CASE.rows) {
        const values = {
          product: relation(productRecordId),
          size: row.sizes.flatMap((size) => relation(resolveSize(size))),
          quantityDescription: BATCH_CASE.text,
          batchNoText: batchNo,
        };
        if (orderBehavior) values.behavior = relation(orderBehavior.record_id);
        if (operatorOpenId) values.operator = person(operatorOpenId);
        created.push(await gateway.create('purchaseReport', values));
      }
      say(`    报货批次号=${batchNo}｜record_id = ${created.map((item) => item.recordId).join(', ')}`);
      const accepted = [];
      for (const item of created) accepted.push(await service.accept('supplier-report', item.recordId));
      const tasks = [];
      for (const item of accepted) tasks.push(await waitForTask(store, item.taskId, timeoutMs));
      const requestsAfter = await gateway.listAll('purchaseRequest');
      const batchTaskId = accepted[0].taskId;
      const rows = requestsAfter
        .filter((row) => textValue(row.fields?.[requestTable.fields.idempotencyKey]).startsWith(`purchase_request:${batchTaskId}:`))
        .map((row) => ({
          record_id: row.record_id,
          size: Number(textValue(row.fields?.[requestTable.fields.size])) || textValue(row.fields?.[requestTable.fields.size]),
          quantity: Number(row.fields?.[requestTable.fields.quantity]),
        })).sort((a, b) => Number(a.size) - Number(b.size));
      const reports = [];
      for (const item of created) reports.push(await gateway.get('purchaseReport', item.recordId));
      const verdict = judge(BATCH_CASE, {
        taskStatus: tasks.every((task) => ['posted', 'completed'].includes(task?.status)) ? 'posted' : (tasks[0]?.status || 'missing'),
        taskError: tasks.map((task) => task?.error).filter(Boolean).join(' / '),
        rows,
        modelParses: aiParses.slice(parseMark),
        status: textValue(reports[0]?.fields?.[reportTable.fields.status]),
        requestLinks: linkedRecordIds(reports[0]?.fields?.[reportTable.fields.request]),
      });
      say(`    AI 解析：${describeParses(aiParses.slice(parseMark))}`);
      say(`    「单据信息」新增 ${rows.length} 行：${JSON.stringify(rows.map((row) => ({ 尺码: row.size, 数量: row.quantity, id: row.record_id })))}`);
      for (const [index, report] of reports.entries()) {
        say(`    记录 ${created[index].recordId} 处理状态=${textValue(report?.fields?.[reportTable.fields.status]) || '(空)'}｜关联采购申请 ${linkedRecordIds(report?.fields?.[reportTable.fields.request]).length} 条`);
      }
      say(`    判定：${verdict.pass ? '✅ 通过' : '❌ 未通过'} —— ${verdict.note}`);
      results.push({ case: BATCH_CASE, result: { recordIds: created.map((item) => item.recordId), batchNo, rows }, verdict });
      // 记一下这一批新增的行（未使用，仅便于人工核对）
      void requestsBefore;
    } catch (error) {
      say(`    ✗ 用例执行出错：${error.message}`);
      results.push({ case: BATCH_CASE, error: error.message });
    }
  }

  // ── 总表 ──
  head('④ 对照表（数量说明原文 | AI 解析结果 | 单据信息行数/数量 | 对/错）');
  const pad = (text, width) => {
    const value = String(text);
    let visual = 0;
    for (const char of value) visual += /[\u4e00-\u9fa5（）【】「」，：]/.test(char) ? 2 : 1;
    return value + ' '.repeat(Math.max(1, width - visual));
  };
  say(`  ${pad('用例', 6)}${pad('数量说明原文', 26)}${pad('AI 解析结果', 30)}${pad('单据信息', 30)}判定`);
  for (const entry of results) {
    if (entry.error) {
      say(`  ${pad(entry.case.id, 6)}${pad(entry.case.text || entry.case.label, 26)}${pad(`执行出错：${entry.error}`, 30)}${pad('-', 30)}❌`);
      continue;
    }
    const ai = parseCells(entry.result.modelParses);
    const written = entry.result.rows
      ? `${entry.result.rows.length} 行 / ${sumItems(entry.result.rows)} 双 ${JSON.stringify(bySizeOf(entry.result.rows))}`
      : '-';
    say(`  ${pad(entry.case.id, 6)}${pad(entry.case.text || entry.case.label, 26)}${pad(ai, 30)}${pad(written, 30)}${entry.verdict.pass ? '✅' : '❌'}`);
    if (!entry.verdict.pass) say(`        ↳ ${entry.verdict.note}`);
    if (entry.verdict.pass && entry.case.expect.type === 'reject') say('        ↳ 按预期拒绝写单 ✓');
  }
  const passed = results.filter((entry) => entry.verdict?.pass).length;
  head(`⑤ 结论：${passed}/${results.length} 个用例与"跑之前写下的验收标准"一致`);
  for (const entry of results.filter((item) => !item.verdict?.pass)) {
    say(`  ✗ ${entry.case.id}「${entry.case.text || entry.case.label}」：${entry.error || entry.verdict.note}`);
  }

  const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const runPath = path.join(serverRoot, 'data', 'selftest-report-qty', 'runs', runId);
  fs.mkdirSync(runPath, { recursive: true });
  const payload = {
    ran_at: new Date().toISOString(),
    ran_at_shanghai: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    mode: 'report-qty',
    base_app_token_fingerprint: fp(V1_BITABLE_SCHEMA.appToken),
    target_env: process.env.FEISHU_TARGET_ENV || '',
    im: imIsFake ? 'intercepted(fake)' : 'real',
    llm_model: process.env.TEXT_LLM_MODEL || '',
    product: { record_id: productRecordId, label: productLabel },
    criteria: CRITERIA,
    results: results.map((entry) => ({
      case: entry.case,
      error: entry.error || '',
      verdict: entry.verdict || null,
      result: entry.result || null,
    })),
    outbox: { images: outbox.images, message_count: outbox.messages.length },
    passed,
    total: results.length,
  };
  fs.writeFileSync(path.join(runPath, 'report.json'), JSON.stringify(payload, null, 2));
  say(`  证据目录：${runPath}`);
  return passed === results.length ? 0 : 1;
};

const main = async () => {
  head(`feishu-retail-ops 供应商报货「数量说明 ≠ 1」自测（mode=${mode}）`);
  say(`  worktree：${repoRoot}`);
  if (mode === 'inspect') return cmdInspect();
  if (mode === 'criteria') return cmdCriteria();
  if (mode === 'run') return cmdRun();
  say(`未知子命令：${mode}（可用：run / inspect / criteria）`);
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
