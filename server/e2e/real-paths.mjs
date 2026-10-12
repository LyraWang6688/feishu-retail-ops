/**
 * ⭐⭐⭐ **真写真飞书**的端到端自动化（只写**授权的测试 Base**）。
 *
 * 为什么要有它（业务负责人 2026-10-12）：
 *   「目前**测试表和生产表已经保持一致了**」＋「你**发版之前自己做自动化测试了吗**？」
 * ⇒ 单测 + CI + 部署闸门 + 真启动都盖不到"**真飞书行为**"那一层（字段真写进去没有、
 *   公式列/关联列真带出来没有、库存真扣了没有）⇒ 这一条把它补上。
 *
 * 用法（逐字）：
 *   cd server && FEISHU_TARGET_ENV=test node --test --test-concurrency=1 e2e/real-paths.mjs
 *   （package.json 里就是 `pnpm run e2e:real`；**不在 `pnpm test` 里**——
 *     CI 没有凭证，测试套件不许依赖它。）
 *
 * 🔴 铁律（违反即**拒绝运行**，不是"注意"）：
 *   ① 只写 `FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的测试 Base：`app_token` 必须**逐字等于**它，
 *      且在 `FEISHU_V1_FORBIDDEN_APP_TOKENS`（生产清单）里 ⇒ 命中即拒（沿用 `scripts/e2e-run.mjs`
 *      与 `utils/writeTargetGuard` 的既有闸门）；
 *   ② `FEISHU_TARGET_ENV` 必须是 `test`；
 *   ③ **走项目代码**：调 service / 入口函数（`createScanWriteService` / `SalesDeliveryService` /
 *      `AfterSalesService` / `PurchaseOrderBatchService` …），**不手拼飞书 API**、不用 CLI；
 *   ④ 每次运行用**本次唯一的 tag** 做幂等键 / 单号后缀 ⇒ 反复跑不互相污染（测试数据不用删）；
 *   ⑤ 缺凭证 ⇒ **明确打印"已跳过"**（`node:test` 的 skip），**绝不假装通过**。
 *
 * ⚠️ 本文件放在 `server/e2e/`（**不在 `server/test/`、也不叫 `*.test.js`**）——Node 的默认
 *   测试发现规则会把 `test/**\/*.js` 与 `**\/*.test.js` 都当成测试文件，放那儿就会被
 *   `pnpm test`（CI）捡走 ⇒ 这里刻意避开那两个模式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// ⭐ F-1 / F-2（独立复核挑出）：**退出码**与**跳过项**都必须有唯一判定处、且落在报告产物里。
import { buildReport, exitCodeFor, summarize, summaryLine } from '../scripts/lib/e2e-report.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ⚠️ dotenv 必须在**任何业务模块之前**加载：`config/v1BitableSchema.js` 的表 ID 是模块级求值
//    （2026-10-06 那次"空表 ID ⇒ 静默 404"的事故就是这么来的）。
require('dotenv').config({ path: path.join(repoRoot, '.env'), quiet: true });

const say = (...parts) => console.log('   ', ...parts);
const fingerprint = (value) => {
  const raw = String(value || '');
  return raw ? `${raw.slice(0, 6)}…(len=${raw.length})` : '(空)';
};
const tag = `e2e${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const uuid = () => crypto.randomUUID();

// ── 报告产物（F-1/F-2）────────────────────────────────────────────────────────
// ⚠️ 为什么要有它：`node --test` 下 `t.skip` / `t.todo` **都不影响退出码** ⇒
//    "全跳过"也会 exit 0 ⇒ 任何看退出码的自动化都会**假绿**。
//    ⇒ 每个场景的结果记进 `scenarios`，跳过项记进 `skipped`（带原因），最后一起落盘。
// ⚠️ `base` 只放**指纹**（报告会被当证据存下来，明文 token 不许进文件）。
const REPORT_DIR = path.join(repoRoot, 'server', 'data', 'e2e-runs');
const scenarios = [];
const skipped = [];
// ⚠️ 传输层抖动（`read ECONNRESET` / 超时 / 5xx）**不是断言失败** —— 只对**只读**调用做有限重试，
//    并把每一次重试记进报告（`transport_retries`）⇒ 不许静默把抖动当"产品坏了"，也不许静默吞掉。
const transportRetries = [];

const writeReport = ({ fatal = '' } = {}) => {
  const summary = summarize({ scenarios, skipped });
  const report = buildReport({ base: fingerprint(targetBase), scenarios, skipped });
  report.script = 'server/e2e/real-paths.mjs';
  report.tag = tag;
  // 她按上海时间安排现场 ⇒ 报告里直接给 +8（AGENTS 第 6 条）。
  report.ran_at = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
  report.commit = process.env.E2E_COMMIT || '';
  // ⭐ 报告自带**被测脚本的指纹**：复核方要记"被测对象"（脚本 sha256），别靠人工抄。
  report.script_sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  report.transport_retries = transportRetries;
  if (fatal) report.fatal = fatal;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `real-paths-${tag}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(summaryLine(summary));
  if (fatal) console.log(`🔴 ${fatal}`);
  console.log(`报告：${file}`);
  return { summary, file };
};

/**
 * 场景壳：把一个场景的**成败**如实记进报告（`checks[].pass === false` ⇒ 未达标）。
 * ⚠️ 断言照旧抛（`node --test` 的红），这里只负责**留证据**。
 */
const scenario = (name, body) => test(name, async (t) => {
  try {
    await body(t);
    scenarios.push({ name, status: 'passed', checks: [{ label: '场景体（全部断言通过）', pass: true }] });
  } catch (error) {
    scenarios.push({
      name,
      status: 'failed',
      checks: [{ label: '场景体', pass: false, error: String(error?.message || error) }],
    });
    throw error;
  }
});

// ── ① 缺凭证 ⇒ 明确跳过（不假装通过）─────────────────────────────────────────
const REQUIRED = [
  'LARK_AGENT_APP_ID', 'LARK_AGENT_APP_SECRET',
  'FEISHU_V1_BITABLE_APP_TOKEN', 'FEISHU_V1_E2E_TEST_APP_TOKEN',
];
const missing = REQUIRED.filter((key) => !String(process.env[key] || '').trim());

// ── ② 闸门（有凭证时**必须**过；不过就 red，不是 skip）───────────────────────
const forbidden = String(
  process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '',
).split(',').map((item) => item.trim()).filter(Boolean);
const targetBase = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
const authorizedBase = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const guardProblems = [];
if (!missing.length) {
  if (forbidden.includes(targetBase)) guardProblems.push('目标 Base 在**禁止写入清单**里（生产 Base）');
  if (targetBase !== authorizedBase) {
    guardProblems.push(`目标 Base 不等于授权的测试 Base（授权 ${fingerprint(authorizedBase)}，`
      + `当前 ${fingerprint(targetBase)}）`);
  }
  if (String(process.env.FEISHU_TARGET_ENV || '').trim() !== 'test') {
    guardProblems.push('FEISHU_TARGET_ENV 不是 test');
  }
}

// ⚠️ 图片/群消息：这一趟**不发任何飞书消息**（她正在用群；测试绝不刷她的群）。
//    「PURCHASE_CHAT_ID 留空 ⇒ 图与说明不发」是既有口径（AGENTS 里写着的），这里显式清掉。
const chatIdBefore = process.env.PURCHASE_CHAT_ID;
delete process.env.PURCHASE_CHAT_ID;

/**
 * ⭐ **测试 Base 的表 ID 自愈**：本机 `.env` 里那些 `FEISHU_V1_*_TABLE_ID=` 是**空值**，
 *    而 `v1BitableSchema` 的 `getEnv(key, fallback)` 对空串会**回落生产表 ID**
 *    ⇒ 读测试 Base 会 `TableIdNotFound (1254041)`（本轮实测就是这个）。
 *    ⇒ 开工前按**表名**从测试 Base 查出 id、写进 `process.env`（必须在 require 业务模块**之前**，
 *      因为表 ID 是模块级求值）。⚠️ 只改本进程内存，不动 `.env`。
 */
const TABLE_ENV = [
  [['货品信息'], 'FEISHU_V1_PRODUCT_TABLE_ID'],
  [['颜色管理'], 'FEISHU_V1_COLOR_TABLE_ID'],
  [['品类管理'], 'FEISHU_V1_CATEGORY_TABLE_ID'],
  [['其他配品'], 'FEISHU_V1_ACCESSORY_TABLE_ID'],
  [['行为管理'], 'FEISHU_V1_BEHAVIOR_TABLE_ID'],
  [['尺码管理'], 'FEISHU_V1_SIZE_TABLE_ID'],
  [['收款方式管理'], 'FEISHU_V1_PAYMENT_METHOD_TABLE_ID'],
  [['供应商管理'], 'FEISHU_V1_SUPPLIER_TABLE_ID'],
  [['销售主表'], 'FEISHU_V1_SALES_ENTRY_TABLE_ID'],
  [['销售明细'], 'FEISHU_V1_SALES_DETAIL_TABLE_ID'],
  [['收款明细'], 'FEISHU_V1_PAYMENT_RECORD_TABLE_ID'],
  [['付款明细'], 'FEISHU_V1_PAYMENT_DETAIL_TABLE_ID'],
  [['采购明细', '报货信息'], 'FEISHU_V1_PURCHASE_REQUEST_TABLE_ID'],
  [['采购主表', '报货批次'], 'FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID'],
  [['库存流水'], 'FEISHU_V1_INVENTORY_LEDGER_TABLE_ID'],
  [['实时库存'], 'FEISHU_V1_LIVE_INVENTORY_TABLE_ID'],
];

const resolveTestBaseTableIds = async () => {
  const { getLarkAgentCredentials } = require('../src/config/larkAgent');
  const lark = require('@larksuiteoapi/node-sdk');
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret });
  const res = await client.bitable.appTable.list({
    path: { app_token: authorizedBase }, params: { page_size: 100 },
  });
  const items = (res?.data?.items) || [];
  const byName = new Map(items.map((item) => [String(item.name || '').trim(), item.table_id]));
  const mapped = [];
  for (const [names, envKey] of TABLE_ENV) {
    const id = names.map((name) => byName.get(name)).find(Boolean);
    if (id) { process.env[envKey] = id; mapped.push(`${names[0]}=${id}`); }
  }
  say(`测试 Base 共 ${items.length} 张表；按表名自愈了 ${mapped.length} 个表 ID`);
  const miss = TABLE_ENV.filter(([, envKey]) => !process.env[envKey]).map(([names]) => names[0]);
  if (miss.length) say(`⚠️ 测试 Base 里没有这些表（相关链路会跳过/失败）：${miss.join(' / ')}`);
};

let deps = null;
if (!missing.length && !guardProblems.length) {
  await resolveTestBaseTableIds();
  deps = require('./real-paths-deps.cjs');
}

if (missing.length) {
  skipped.push({ name: '真写 E2E（全部场景）', reason: `缺测试凭证：${missing.join(' / ')}` });
  test('真写 E2E（已跳过）：缺测试凭证', (t) => {
    t.skip(`已跳过（缺 ${missing.join(' / ')}）—— 这一条**只能**在有测试 Base 凭证的机器上跑；`
      + 'CI 没有凭证，所以它刻意不在 `pnpm test` 里。');
  });
  test.after(() => {
    writeReport();
    // ⭐ 一条都没跑、却有跳过项 ⇒ **非 0**（3）。否则"缺凭证"会被看退出码的自动化读成"通过"。
    process.exitCode = 3;
  });
} else if (guardProblems.length) {
  test('真写 E2E 安全闸门', () => {
    assert.fail(`🔴 拒绝运行：${guardProblems.join('；')}`);
  });
  test.after(() => {
    writeReport({ fatal: `拒绝运行：${guardProblems.join('；')}` });
    process.exitCode = exitCodeFor({ error: true });
  });
} else {
  const {
    V1_BITABLE_SCHEMA, V1BitableGateway, linkedRecordIds, textValue,
    createScanPageService, createScanWriteService, createScanSessionService,
    SalesDeliveryService, SalesFollowupService, SalesProgressService, PaymentService,
    AfterSalesService, InventoryService, PurchaseOrderBatchService, JsonTaskStore, SCAN_PAGE, SCAN_WRITE,
  } = deps;

  // ⚠️ 「销售主表.录单人」是**人员字段**：拿一个假的 `ou_xxx` 去写会被飞书拒
  //    （`UserFieldConvFail 1254066`，本轮实测）。⇒ 用一个**真实存在**的 open_id
  //    （`.env` 里的机器人 open_id；它在同一个租户里）；拿不到就**不写这一列**。
  const OPERATOR = String(process.env.LARK_BOT_OPEN_ID || '').trim();
  if (!OPERATOR) say('⚠️ 没有 LARK_BOT_OPEN_ID ⇒ 本轮不写「录单人」（人员字段拿假 id 会被飞书拒）');

  const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `e2e-real-${label}-`));

  /** 抓项目代码打的结构化日志（`product.tag_qr.*` 这些就是"项目代码真的跑了"的证据）。 */
  const captureLogs = async (run) => {
    const lines = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (line) => { lines.push(String(line)); };
    console.warn = (line) => { lines.push(String(line)); };
    try {
      const value = await run();
      return { value, events: lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) };
    } finally { console.log = original.log; console.warn = original.warn; }
  };
  const gateway = new V1BitableGateway();
  const tables = { entry: 'salesEntry', detail: 'salesDetail', payment: 'paymentRecord', ledger: 'inventoryLedger', live: 'liveInventory' };
  const fieldsOf = (key) => V1_BITABLE_SCHEMA.tables[key].fields;
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /**
   * 只读调用的**传输层**有限重试（最多 3 次）。
   * ⚠️ 只认传输层错误（连接被重置/超时/网关 5xx）——**断言错、字段错、权限错一律直接抛**，
   *    绝不把"业务失败"重试成"通过"。
   */
  const isTransportError = (error) => /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|ERR_SOCKET|\b50[234]\b/.test(
    String(error?.message || error),
  );
  const readWithRetry = async (label, run) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await run();
      } catch (error) {
        if (attempt >= 3 || !isTransportError(error)) throw error;
        transportRetries.push({ label, attempt, error: String(error.message || error) });
        say(`⚠️ 传输层抖动（${label}）：${error.message} ⇒ 第 ${attempt + 1} 次重试`);
        // eslint-disable-next-line no-await-in-loop
        await wait(1500 * attempt);
      }
    }
  };
  const rowsOf = (key) => readWithRetry(`listAll(${key})`, () => gateway.listAll(key));
  const rowOf = (key, id) => readWithRetry(`get(${key})`, () => gateway.get(key, id));
  const cell = (row, key, semantic) => row?.fields?.[fieldsOf(key)[semantic]];

  /** 建一整套真链路的写入侧（会话 / 写服务 / 交付 / 库存）。 */
  const buildWriteSide = () => {
    const sessions = createScanSessionService({ dir: tempDir('session') });
    const inventory = new InventoryService({
      gateway, store: new JsonTaskStore({ dir: tempDir('inv'), idField: 'operation_id' }),
    });
    const delivery = new SalesDeliveryService({ gateway, inventory });
    const write = createScanWriteService({
      gateway, sessions, delivery, purchase: {},
      purchaseStore: new JsonTaskStore({ dir: tempDir('purchase'), idField: 'task_id' }),
    });
    return { sessions, inventory, delivery, write };
  };

  const openSession = async (side, openId) => {
    const session = await side.sessions.get(openId) || await side.sessions.ensure(openId);
    return side.sessions.submitKeyFor(openId, session, 'sale');
  };

  /**
   * 造一张真单（走扫码建单那条链路的**项目代码**）。
   * `lines` = [{ size, inStock, amount }]，`payments` 同 `submitSale` 的收款行。
   */
  const createSale = async ({ product, lines, payments = [], paymentStatus = '', paidAmount = '', owed = '' }) => {
    const side = buildWriteSide();
    // 会话/幂等键按 openId 分人 ⇒ 同一个真 open_id + 唯一 tag 的会话目录不冲突
    const openId = OPERATOR || `ou_${tag}_${crypto.randomBytes(3).toString('hex')}`;
    const key = await openSession(side, openId);
    for (const line of lines) {
      const added = await side.write.addSaleLine({
        openId, requestId: `rr${crypto.randomBytes(6).toString('hex')}`,
        productRecordId: product.record_id, number: product.number, itemNo: product.itemNo,
        color: product.color, size: String(line.size), inStock: line.inStock === true,
        amount: line.amount === undefined ? '' : String(line.amount),
      });
      assert.equal(added.ok, true, `加单失败：${JSON.stringify(added)}`);
    }
    const result = await side.write.submitSale({
      openId, submitKey: key, requestId: `rs${crypto.randomBytes(6).toString('hex')}`,
      payments, paymentStatus, paidAmount,
      lineAmounts: lines.map((line) => (line.amount === undefined ? '' : String(line.amount))),
    });
    assert.equal(result.ok, true, `提交失败：${JSON.stringify(result)}`);
    return { side, openId, key, result };
  };

  // ── 夹具：从测试 Base 里挑真实的一条货品；**用项目代码造一双门盒**当现货 ─────────
  const loadProductFixture = async () => {
    const productId = String(process.env.FEISHU_V1_E2E_PRODUCT_RECORD_ID || '').trim();
    const itemNoEnv = String(process.env.FEISHU_V1_E2E_ITEM_NO || '').trim();
    const wantedSize = String(process.env.FEISHU_V1_E2E_SIZE || '').trim();
    const products = await rowsOf('product');
    const product = products.find((row) => row.record_id === productId)
      || products.find((row) => textValue(cell(row, 'product', 'itemNo')) === itemNoEnv);
    assert.ok(product, `测试 Base 里找不到货品（FEISHU_V1_E2E_PRODUCT_RECORD_ID=${productId} / ITEM_NO=${itemNoEnv}）`);
    const number = textValue(cell(product, 'product', 'number')).trim();
    const itemNo = textValue(cell(product, 'product', 'itemNo')).trim() || itemNoEnv;
    const color = textValue(cell(product, 'product', 'color')).trim();
    assert.ok(number, '货品的「编号」是空的（测试 Base 的公式列没算出来 / 字段没配）');
    // 尺码：现货用 env 里那个（下面**造一双门盒**）；预订用另一个码（测试 Base 里挑一个存在的）
    const sizeField = fieldsOf('sizeManagement').size;
    const sizeRows = await rowsOf('sizeManagement');
    const sizeIdOfNumber = new Map();
    for (const row of sizeRows) {
      const value = Number(row.fields?.[sizeField]);
      if (value) sizeIdOfNumber.set(value, row.record_id);
    }
    const allSizes = [...sizeIdOfNumber.keys()];
    const stockedSize = Number(wantedSize) || allSizes[0];
    const emptySize = allSizes.find((size) => size !== stockedSize);
    assert.ok(stockedSize && sizeIdOfNumber.get(stockedSize),
      '找不到可用尺码（FEISHU_V1_E2E_SIZE / 尺码管理 都空）');
    assert.ok(emptySize, '尺码管理里只有一个码 ⇒ 做不了"现货 + 预订混一单"');
    return {
      record_id: product.record_id, number, itemNo, color, wantedSize, stockedSize, emptySize,
      // ⭐ 尺码**关联列**要的是「尺码管理」的 `record_id`（不是 `size_42` 这种拼出来的字符串）——
      //    售后「新出货那一双」的 `sizeId` 必须是真 id，否则 `resolveLinkedCell` 当场抛
      //    （2026-10-12 实测：`size_42` 这种假 id 走不通）。
      sizeIdOf: (size) => sizeIdOfNumber.get(Number(size)),
    };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  scenario(`① 扫码建单（现货 ${tag} + 预订混一单）⇒ 主表/明细/明细ID/库存`, async () => {
    const product = await loadProductFixture();
    // 前置：**用项目代码**给"现货那一双"造一条「实时库存」（门盒）——不依赖测试 Base 恰好有货；
    //       幂等：已经有这一条就不再入（`applyPurchase` 自己按 商品+尺码+状态 去重/累加）。
    await buildWriteSide().inventory.applyPurchase({
      purchaseBatchNo: `${tag}-fixture`, productRecordId: product.record_id,
      size: product.stockedSize, state: '门盒', quantity: 1,
    });
    const before = (await rowsOf('liveInventory')).length;
    const sale = await createSale({
      product,
      lines: [{ size: product.stockedSize, inStock: true, amount: '150' }, { size: product.emptySize, inStock: false, amount: '130' }],
      payments: [{ method: '微信', amount: '280' }],
      paymentStatus: '全付',
    });
    const entry = await rowOf(tables.entry, sale.result.sales_entry_record_id);
    const orderNo = textValue(cell(entry, 'salesEntry', 'orderNo'));
    say(`单号=${orderNo} · detail_count=${sale.result.detail_count} · payment_count=${sale.result.payment_count}`);
    assert.match(orderNo, /^XSD-\d{8}-\d{4}$/, '主表「销售单号」要是 XSD-… 那个形状');
    assert.deepEqual(
      linkedRecordIds(cell(entry, 'salesEntry', 'tradeType')).length, 2,
      '主表「交易类型」= 混合单 ⇒ **两个值**（现货 + 预订）',
    );
    for (const [semantic, label] of [['sales', '销售状态'], ['funds', '资金状态'], ['stock', '库存状态']]) {
      assert.ok(textValue(cell(entry, 'salesEntry', semantic)), `主表「${label}」要有值`);
    }
    const details = (await rowsOf(tables.detail)).filter((row) =>
      linkedRecordIds(cell(row, 'salesDetail', 'salesEntry')).includes(sale.result.sales_entry_record_id));
    assert.equal(details.length, 2, '明细 2 行');
    const ids = details.map((row) => textValue(cell(row, 'salesDetail', 'detailId'))).sort();
    assert.deepEqual(ids, [`${orderNo}-01`, `${orderNo}-02`], '明细ID = 单号-01/-02');
    const statuses = details.map((row) => textValue(cell(row, 'salesDetail', 'fulfillmentStatus'))).sort();
    assert.deepEqual(statuses, ['已交付', '未交付'], '现货行已交付 / 预订行未交付');
    const after = (await rowsOf('liveInventory')).length;
    assert.equal(after, before - 1, '现货那一双真的从「实时库存」扣掉了（整表行数 -1）');
    const ledger = (await rowsOf(tables.ledger)).filter((row) =>
      linkedRecordIds(cell(row, 'inventoryLedger', 'salesDetail')).some((id) =>
        details.some((detail) => detail.record_id === id)));
    assert.equal(ledger.length, 1, '库存流水 1 条（只有现货那一双）');
    say(`明细ID=${ids.join(' / ')} · 履约状态=${statuses.join(' / ')} · 库存流水=${ledger.length} 条 · 实时库存 ${before}→${after}`);
  });

  scenario(`② 收款（全付微信 280 + 分笔补款 ${tag}）⇒ 收款明细ID 递增 + 占位同步`, async () => {
    const product = await loadProductFixture();
    // 先一张"部分付"的单：定金 100 + 欠 140 ⇒ 会补一条【未收款】占位
    const sale = await createSale({
      product,
      lines: [{ size: product.emptySize, inStock: false, amount: '240' }],
      payments: [{ method: '微信', amount: '100' }],
      paymentStatus: '部分付', paidAmount: '100', owed: '140',
    });
    const orderNo = textValue(cell(await rowOf(tables.entry, sale.result.sales_entry_record_id), 'salesEntry', 'orderNo'));
    const paymentsOfSale = async () => (await rowsOf(tables.payment)).filter((row) =>
      linkedRecordIds(cell(row, 'paymentRecord', 'salesEntry')).includes(sale.result.sales_entry_record_id));
    let rows = await paymentsOfSale();
    const idsOf = (list) => list.map((row) => textValue(cell(row, 'paymentRecord', 'receiptId'))).sort();
    assert.deepEqual(idsOf(rows), [`${orderNo}-收款-01`, `${orderNo}-收款-02`],
      '定金 = -01、【未收款】占位 = -02（占位行也占号）');
    const first = rows.find((row) => textValue(cell(row, 'paymentRecord', 'receiptId')) === `${orderNo}-收款-01`);
    assert.equal(Number(cell(first, 'paymentRecord', 'amount')), 100, '收款金额 = 100');
    assert.equal(textValue(cell(first, 'paymentRecord', 'status')), '已收款', '状态 = 已收款');
    const receivedAt = Number(cell(first, 'paymentRecord', 'receivedAt'));
    assert.ok(Math.abs(Date.now() - receivedAt) < 10 * 60 * 1000, `「收款日」≈ 现在（实际 ${new Date(receivedAt).toISOString()}）`);
    assert.ok(linkedRecordIds(cell(first, 'paymentRecord', 'method')).length === 1, '「收款方式」有关联记录');

    // 分笔补款：两次 ⇒ -03 / -04，且【未收款】占位行金额同步
    const followup = new SalesFollowupService({
      gateway, payments: new PaymentService({ gateway }), progress: new SalesProgressService({ gateway }),
      store: new JsonTaskStore({ dir: tempDir('followup'), idField: 'task_id' }),
    });
    for (const amount of [100, 40]) {
      const paid = await followup.addPayment({
        requestId: uuid(), salesEntryRecordId: sale.result.sales_entry_record_id,
        amount, method: '现金', operatorOpenId: 'ou_e2e_real',
      });
      assert.ok(paid.recordId, `补款失败：${JSON.stringify(paid)}`);
    }
    rows = await paymentsOfSale();
    assert.deepEqual(idsOf(rows), [
      `${orderNo}-收款-01`, `${orderNo}-收款-02`, `${orderNo}-收款-03`, `${orderNo}-收款-04`,
    ], '分笔补款接着排号（不重排已有行）');
    const placeholder = rows.find((row) => textValue(cell(row, 'paymentRecord', 'status')) === '未收款');
    assert.ok(placeholder, '那条【未收款】占位行还在（不删记录）');
    assert.equal(Number(cell(placeholder, 'paymentRecord', 'amount')), 0, '收满 ⇒ 占位行金额同步成 0');
    say(`收款明细ID=${idsOf(rows).join(' / ')} · 占位行金额=${cell(placeholder, 'paymentRecord', 'amount')} · 收款日=${new Date(receivedAt).toISOString()}`);
  });

  scenario(`③ 交付（预订行 ⇒ 已交付 + 扣库存）${tag}`, async () => {
    const product = await loadProductFixture();
    const sale = await createSale({
      product,
      lines: [{ size: product.emptySize, inStock: false, amount: '130' }],
      payments: [{ method: '微信', amount: '130' }], paymentStatus: '全付',
    });
    const details = (await rowsOf(tables.detail)).filter((row) =>
      linkedRecordIds(cell(row, 'salesDetail', 'salesEntry')).includes(sale.result.sales_entry_record_id));
    assert.equal(details.length, 1);
    assert.equal(textValue(cell(details[0], 'salesDetail', 'fulfillmentStatus')), '未交付', '交付前 = 未交付');
    // 交付要真扣库存 ⇒ 先给这一双造/找一条「实时库存」行（走项目代码：InventoryService 的补货入库）
    await sale.side.inventory.applyPurchase({
      purchaseBatchNo: `${tag}-deliver`, productRecordId: product.record_id,
      size: product.emptySize, state: '门盒', quantity: 1,
    });
    const liveBefore = (await rowsOf('liveInventory')).length;
    const delivered = await sale.side.delivery.deliver({
      salesEntryRecordId: sale.result.sales_entry_record_id,
      detailRecordIds: details.map((row) => row.record_id),
      occurredAt: Date.now(),
    });
    say(`交付结果：${JSON.stringify(delivered).slice(0, 240)}`);
    const after = await rowOf(tables.detail, details[0].record_id);
    assert.equal(textValue(cell(after, 'salesDetail', 'fulfillmentStatus')), '已交付', '交付后履约状态 = 已交付');
    const liveAfter = (await rowsOf('liveInventory')).length;
    assert.ok(liveAfter <= liveBefore + 1, `实时库存没有因为交付变多（${liveBefore} → ${liveAfter}）`);
    const entry = await rowOf(tables.entry, sale.result.sales_entry_record_id);
    assert.equal(textValue(cell(entry, 'salesEntry', 'stock')), '已写入', '主表「库存状态」= 已写入');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ④ 售后三条（退货 / 换货 / 赔货）—— 各自拿一张**新单**，互不干扰
  // ═══════════════════════════════════════════════════════════════════════════

  const salesBehaviorIdOf = async (code) => {
    const behaviors = await rowsOf('behavior');
    const row = behaviors.find((item) => textValue(item.fields?.[fieldsOf('behavior').code]) === code);
    assert.ok(row, `「行为管理」里没有 ${code} 这条（测试 Base 缺前置数据）`);
    return row.record_id;
  };

  const runAfterSales = async ({ action, product }) => {
    const sale = await createSale({
      product,
      lines: [{ size: product.emptySize, inStock: false, amount: '200' }],
      payments: [{ method: '微信', amount: '200' }], paymentStatus: '全付',
    });
    const entry = await rowOf(tables.entry, sale.result.sales_entry_record_id);
    const orderNo = textValue(cell(entry, 'salesEntry', 'orderNo'));
    const details = (await rowsOf(tables.detail)).filter((row) =>
      linkedRecordIds(cell(row, 'salesDetail', 'salesEntry')).includes(sale.result.sales_entry_record_id));
    // ⭐ 出货那一双（换货的新鞋 / 赔出去的那双）走 `SALE_CASH` / `SALE_COMPENSATION` 的
    //    「**减少** + 消耗门盒」⇒ 先用**项目代码**给这一双造一条「门盒」库存
    //    （与 ③ 交付同一条做法：不依赖测试 Base 恰好有货，也不让库存那一步失败）。
    //    ⚠️ 出货用 `stockedSize`（被退的那双是 `emptySize`）—— 业务上"退一双、另换/另赔一双"。
    const outgoingSize = product.stockedSize;
    const outgoingSizeId = product.sizeIdOf(outgoingSize);
    assert.ok(outgoingSizeId, `「尺码管理」里找不到 ${outgoingSize} 的 record_id`);
    if (action !== 'return') {
      const inventory = new InventoryService({
        gateway, store: new JsonTaskStore({ dir: tempDir(`aftersales-fixture-${action}`), idField: 'operation_id' }),
      });
      await inventory.applyPurchase({
        purchaseBatchNo: `${tag}-${action}-fixture`, productRecordId: product.record_id,
        size: outgoingSize, state: '门盒', quantity: 1,
      });
    }
    const service = new AfterSalesService({
      gateway, store: new JsonTaskStore({ dir: tempDir(`aftersales-${action}`), idField: 'operation_id' }),
    });
    const request = {
      action,
      originalText: `E2E ${tag} ${action}`,
      originalSalesEntryRecordId: sale.result.sales_entry_record_id,
      originalSalesOrderNo: orderNo,
      originalSalesDetailRecordIds: details.map((row) => row.record_id),
      // ⚠️ 「换货」和「**赔货**」都**必须**带 `newLines`（`config/afterSales.js` 里 `acceptsNewLines: true`）——
      //    赔货没有新出货商品会被**入参校验当场拒**（那是口径，不是产品 bug）。
      //    `amount` 必须 > 0（执行器对赔货那条会把实收金额固定成 0，见 `newLineAmount`）。
      newLines: action === 'return' ? [] : [{
        productId: product.record_id, sizeId: outgoingSizeId, amount: 300,
      }],
      diffAmount: action === 'exchange' ? 100 : (action === 'return' ? -200 : 0),
      settlement: 'cash',
      restockState: '门盒',
      // ⚠️ 售后单要写「经办人」（**人员字段**）⇒ 必须是**真实存在**的 open_id。
      //    2026-10-12 实测：拿 `ou_e2e_real` 这种假 id 会被飞书拒 ——
      //    `bitable.record.create_failed … UserFieldConvFail (1254066)`（与建单时「录单人」同一个坑）。
      operatorOpenId: OPERATOR,
    };
    const result = await service.execute(request);
    return { sale, entry, orderNo, details, request, result };
  };

  scenario(`④ 售后 · 退货 ${tag}`, async () => {
    const product = await loadProductFixture();
    const { details, orderNo, result } = await runAfterSales({ action: 'return', product });
    say(`售后结果：${JSON.stringify(result).slice(0, 300)}`);
    const after = await rowOf(tables.detail, details[0].record_id);
    assert.equal(textValue(cell(after, 'salesDetail', 'fulfillmentStatus')), '已退货', '原明细行 = 已退货');
    say(`原单 ${orderNo} 的原明细已置「已退货」· 售后单=${result?.masterRecordId || result?.master_record_id || '(见结果)'}`);
  });

  scenario(`④ 售后 · 换货 ${tag}`, async () => {
    const product = await loadProductFixture();
    const { details, result } = await runAfterSales({ action: 'exchange', product });
    say(`售后结果：${JSON.stringify(result).slice(0, 300)}`);
    const after = await rowOf(tables.detail, details[0].record_id);
    assert.equal(textValue(cell(after, 'salesDetail', 'fulfillmentStatus')), '已换货', '原明细行 = 已换货');
  });

  scenario(`④ 售后 · 赔货 ${tag}`, async () => {
    const product = await loadProductFixture();
    const { details, result } = await runAfterSales({ action: 'compensation', product });
    say(`售后结果：${JSON.stringify(result).slice(0, 300)}`);
    const after = await rowOf(tables.detail, details[0].record_id);
    assert.equal(textValue(cell(after, 'salesDetail', 'fulfillmentStatus')), '已赔货', '原明细行 = 已赔货');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ⑥ 采购验收（到货状态 / 实际数量 / 实际金额）
  // ═══════════════════════════════════════════════════════════════════════════

  scenario(`⑥ 采购验收：到货状态 / 实际数量 / 实际金额 ${tag}`, async () => {
    const batches = new PurchaseOrderBatchService({ gateway, store: new JsonTaskStore({ dir: tempDir('batch'), idField: 'task_id' }) });
    const batchNo = `CGD-E2E-${tag}`;
    const created = await batches.createForReturnBatch(batchNo, { behaviorRecordId: await salesBehaviorIdOf('SALE_RETURN') });
    assert.ok(created.recordId, `建批次行失败：${JSON.stringify(created)}`);
    await batches.markArrived(batchNo);
    const written = await batches.writeAcceptance({ batchRecordId: created.recordId, actualQuantity: 2, actualAmount: 560 });
    say(`验收写入：${JSON.stringify(written).slice(0, 200)}`);
    const row = await rowOf('purchaseOrderBatch', created.recordId);
    assert.equal(textValue(cell(row, 'purchaseOrderBatch', 'arrivalStatus')), '已到货', '「到货状态」= 已到货');
    assert.equal(Number(cell(row, 'purchaseOrderBatch', 'actualQuantity')), 2, '「实际数量」= 2');
    assert.equal(Number(cell(row, 'purchaseOrderBatch', 'actualAmount')), 560, '「实际金额」= 560');
    say(`批次=${batchNo} · 到货状态=${textValue(cell(row, 'purchaseOrderBatch', 'arrivalStatus'))} · 实际数量=${cell(row, 'purchaseOrderBatch', 'actualQuantity')} · 实际金额=${cell(row, 'purchaseOrderBatch', 'actualAmount')}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ⑤ 采购报货 / ⑦ 二维码：**没盖到的部分如实标出来**（不假装通过）
  // ═══════════════════════════════════════════════════════════════════════════

  // ⚠️ ⑤ 是**本轮唯一允许的跳过**（也是唯一诚实的结论）：入口吃"事件解析出的 task" + 要出图/发群。
  //    ⭐ 跳过必须**落在报告里**（`skipped: [{name, reason}]`）——只打一句控制台 ⚠️ 不算证据（F-2）。
  test('⑤ 采购报货（已跳过：入口吃「事件解析出的 task」+ 要出图发群）', (t) => {
    const reason = '报货入口 `PurchaseWebhookService.publishPurchaseRequest(taskId, task)` 吃的是'
      + '**表变更事件解析出来的 task**（不是几个参数），且要按供应商渲染 PNG、发到采购群；'
      + '本趟**禁止任何飞书外发**（测试绝不刷她的群）⇒ 本轮**未覆盖**，不是通过。'
      + '⚠️ 另与「采购主表.采购行为」那条已知缺口有关（没有代码在写主表那一列 ⇒ 明细的 Lookup 带不出值）。';
    skipped.push({ name: '⑤ 采购报货', reason });
    t.skip(reason);
  });

  scenario(`⑦ 二维码（源字段判据）· 清掉⇒生成 · 改货号⇒覆盖写 · 无关字段⇒跳过 · 再跑⇒不重复写 ${tag}`, async () => {
    const { createTagQrCodeService, buildFileName, attachmentsOf } = require('../src/services/tagQrCodeService');
    const product = await loadProductFixture();
    const F = fieldsOf('product');
    // ⚠️ 这一条要**直接读真表**（不拿配置当结论）：测试 Base 的「货品信息」必须真有「标签二维码」列，
    //    否则第 ① 步的清空会失败、报错还会指错方向（`F.tagQrCode` 永远是真值，它只是配置里的字段名）。
    const productFields = await gateway.listFields('product');
    assert.ok(productFields.some((field) => field.field_name === F.tagQrCode),
      `测试 Base「货品信息」没有「${F.tagQrCode}」列 —— 先跑一次 \`node scripts/e2e-product-tag-qr.js\` 让它补列`);
    const namesOf = (row) => attachmentsOf(row?.fields?.[F.tagQrCode]).map((item) => String(item.name || ''));
    const service = createTagQrCodeService({ gateway });
    const original = await rowOf('product', product.record_id);
    const originalItemNo = textValue(original.fields?.[F.itemNo]).trim();
    try {
      // ① 前置数据：把这条真记录的二维码**清空**（只写测试 Base）⇒ "新增路"就有数据可走了
      await gateway.update('product', product.record_id, { tagQrCode: [] });
      assert.equal(namesOf(await rowOf('product', product.record_id)).length, 0, '① 二维码已清空');

      // ② 走项目代码生成 ⇒ 断言附件真的写进去了（+ `product.tag_qr.written` 日志）
      const first = await captureLogs(() => service.syncRecord(product.record_id, { reason: `e2e_${tag}` }));
      const firstNames = namesOf(await rowOf('product', product.record_id));
      say(`② syncRecord ⇒ ${JSON.stringify(first.value)} · 附件=${firstNames.join(',')}`);
      assert.ok(firstNames.length >= 1, `② 二维码附件没写进去：${JSON.stringify(first.value)}`);
      assert.ok(first.events.some((item) => item.event === 'product.tag_qr.written'), '② 要有 `product.tag_qr.written`');
      const numberBefore = textValue((await rowOf('product', product.record_id)).fields?.[F.number]).trim();
      assert.equal(firstNames[0], buildFileName(product.record_id), '② 附件名 = 按「记录 ID」算出来的文件名');

      // ③ 改**源字段**（货号）⇒ 身份是记录 ID ⇒ 码**不变**、**不重写**
      const newItemNo = `${originalItemNo}-E2E${tag}`;
      await gateway.update('product', product.record_id, { itemNo: newItemNo });
      let numberAfter = numberBefore;
      for (let attempt = 0; attempt < 20 && numberAfter === numberBefore; attempt += 1) {
        await wait(1500);   // ⚠️ 飞书**公式列有延迟**（实测 1~10 秒）——这也是"每天兜底巡检"存在的理由
        numberAfter = textValue((await rowOf('product', product.record_id)).fields?.[F.number]).trim();
      }
      assert.notEqual(numberAfter, numberBefore, `③ 改了货号但「编号」公式一直是旧值（${numberBefore}）——公式列延迟过头了`);
      const second = await captureLogs(() => service.syncRecord(product.record_id, { reason: 'source_field_changed' }));
      const secondNames = namesOf(await rowOf('product', product.record_id));
      say(`③ 改货号 ⇒ 编号 ${numberBefore} → ${numberAfter} · 附件=${secondNames.join(',')}`);
      assert.equal(secondNames.join(","), firstNames.join(","), '③ 改货号 ⇒ 码不该变（身份 = 记录 ID）');
      assert.equal(second.events.some((item) => item.event === 'product.tag_qr.written'), false, '③ 改货号 ⇒ 不该重写');

      // ④ 只改**无关字段**（单价）⇒ 编号没变 ⇒ **跳过**（不许无谓重写）
      //    ⭐ 这里走**事件那一路**的判据：`numberChanged: false` =
      //    「表变更事件里，组成编号那几个源字段的前后值相同」（`handleTableChanges` 就是这么传的，
      //    见 `tagQrCodeService.js` 第 681/710 行；事件判不了时传 `null`）。
      //    ⚠️ 原来这里没传 `numberChanged`（= `undefined`）= **脚本/回填那一档** ⇒ 产品代码如实记
      //    `product.tag_qr.skipped_existing` + `already_present`（不是 `skipped_number_unchanged`）——
      //    断言写错了日志名 ⇒ 假红。**改断言不改产品代码**。
      const afterThird = await captureLogs(async () => {
        await gateway.update('product', product.record_id, { price: 123 });
        return service.syncRecord(product.record_id, {
          reason: 'unrelated_field_changed', numberChanged: false,
        });
      });
      const thirdNames = namesOf(await rowOf('product', product.record_id));
      say(`④ 改无关字段 ⇒ ${JSON.stringify(afterThird.value)}`);
      assert.equal(thirdNames.join(','), secondNames.join(','), '④ 编号没变 ⇒ 附件不该动');
      assert.ok(afterThird.events.some((item) => item.event === 'product.tag_qr.skipped_number_unchanged'),
        '④ 事件那一路"编号没变"要留下 `product.tag_qr.skipped_number_unchanged` 这条日志（可 grep）');

      // ⑤ 幂等：再跑一次 ⇒ 还是不重复写
      //    ⚠️ 这一档**故意不传** `numberChanged`（= `undefined`）= 回填脚本/新增那一档
      //    ⇒ 产品代码走**幂等**判据，如实记 `product.tag_qr.skipped_existing` + `already_present`。
      const again = await captureLogs(() => service.syncRecord(product.record_id, { reason: 'e2e_again' }));
      const againNames = namesOf(await rowOf('product', product.record_id));
      say(`⑤ 再跑一次（幂等档）⇒ ${JSON.stringify(again.value)} · 附件=${againNames.join(',')}`);
      assert.equal(againNames.join(','), thirdNames.join(','), '⑤ 再跑不该多出附件、也不该改名');
      assert.equal(again.events.some((item) => item.event === 'product.tag_qr.written'), false, '⑤ 不该再写一次');
      assert.ok(again.events.some((item) => item.event === 'product.tag_qr.skipped_existing'),
        '⑤ 幂等档要留下 `product.tag_qr.skipped_existing` 这条日志（可 grep）');
    } finally {
      // 收拾干净：货号改回去（测试数据不用删，但**这一条是复用的 E2E 货品**，别把它改花）
      await gateway.update('product', product.record_id, { itemNo: originalItemNo }).catch(() => undefined);
      say(`（已把货号改回 ${originalItemNo}；测试 Base 的二维码附件留着不动）`);
    }
  });

  test.after(() => {
    if (chatIdBefore) say('（本轮把 PURCHASE_CHAT_ID 清空 ⇒ 没有向任何飞书群发消息；只写测试 Base）');
    say(`本轮 tag = ${tag}（幂等键 / 单号后缀都用它 ⇒ 反复跑不互相污染；测试数据不用删）`);
    const { summary } = writeReport();
    // ⭐ F-1：**退出码由 `exitCodeFor` 一处说了算**（未达标 ⇒ 非 0）。
    process.exitCode = summary.failed > 0 ? exitCodeFor({ failed: summary.failed }) : 0;
  });
}
