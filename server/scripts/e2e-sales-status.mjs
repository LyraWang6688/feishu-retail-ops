#!/usr/bin/env node
/**
 * e2e-sales-status.mjs —— 在**测试 Base** 上把「一条销售单从建单到交付」整条链路跑一遍，
 * 验证四个状态维度（确认状态 / 销售状态 / 资金状态 / 库存状态）**真的被写对了**。
 *
 * 为什么要有它：
 *   `salesStatusDimensions` 那一层是"配置 + 写点"，单测只能证明"逻辑对"；
 *   真正要证明的是**打真表时四个字段有没有值、值对不对**。这个脚本就是那份证据。
 *
 * 走的是**项目代码**（不是手拼 SDK、**不用飞书 CLI**）：
 *   1. `LarkMvpService.createSalesEntryWithOrderNo` —— 建单（唯一的建单入口，会写「确认状态=未确认」）
 *   2. `LarkMvpService.handleCardAction({ action: 'confirm_sale' })` —— **她点「确认」那一下**：
 *        · 写「确认状态 = 已确认」（本次新加的写点）
 *        · `V1PostingService.postSale` → `SalesOrderService`：写明细/收款 + 销售状态/资金状态
 *        · 交付 `SalesDeliveryService`：扣库存 + 库存状态
 *   3. 回读销售主表，打印四个字段的**实际值** + 记录 id + 单号。
 *
 * 用法：
 *   node scripts/e2e-sales-status.mjs --env-file <主工作区>/.env
 *   node scripts/e2e-sales-status.mjs --env-file ... --apply     # 不加 --apply 只做"只读体检"
 *   node scripts/e2e-sales-status.mjs --env-file ... --apply --product <rec> --size 42
 *
 * 🔴 硬闸门（写死在脚本里）：
 *   · 目标 Base 必须 = `FEISHU_V1_E2E_TEST_APP_TOKEN`，且 `FEISHU_TARGET_ENV=test`；
 *     否则**拒绝运行**（本脚本会真写表，只能写测试 Base）。
 *   · 默认**只做只读体检**（列数据源），加 `--apply` 才写。
 *   · 不打印任何 token / secret；IM 全走**本地替身**（不发真实消息、不发卡片）。
 *
 * 环境变量加载顺序（后者覆盖前者）：<repo>/.env → --env-file → <repo>/.env.local
 * ⚠️ 必须在 require 业务模块**之前**加载：`v1BitableSchema` 是 require 时求值 tableId 的。
 */

import fs from 'node:fs';
import path from 'node:path';
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
const { LarkMvpService } = require('../src/services/larkMvpService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const {
  SALES_STATUS_FIELDS, LEGACY_SALES_STATUS_FIELDS, POSTED_VALUES, isPosted,
} = require('../src/config/salesStatusDimensions');

// ── 硬闸门 ───────────────────────────────────────────────────────────────────
const targetAppToken = String(V1_BITABLE_SCHEMA.appToken || '').trim();
const testAppToken = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
const isAuthorizedTestBase = Boolean(testAppToken) && targetAppToken === testAppToken && targetEnv === 'test';
const apply = flags.apply === true;

head('销售四维状态 · 测试 Base 端到端');
say('  环境文件：');
for (const source of envSources) say(`    · ${source}`);
say(`  目标 Base 是否 = 授权测试 Base：${isAuthorizedTestBase ? '是' : '**不是**'}`);
say(`  FEISHU_TARGET_ENV：${targetEnv || '（未设置）'}`);
say(`  模式：${apply ? '真写（--apply）' : '只读体检（未加 --apply）'}`);

if (!isAuthorizedTestBase) {
  say('');
  say('🔴 拒绝运行：目标 Base 不是授权的测试 Base（或 FEISHU_TARGET_ENV ≠ test）。');
  say('   本脚本会**真写销售主表/明细/收款/库存**，只允许在测试 Base 上跑。');
  process.exit(2);
}

// ── 客户端：bitable 走真的；IM 全走本地替身（不外发）─────────────────────────
const { appId, appSecret } = getLarkAgentCredentials();
const realClient = new lark.Client({ appId, appSecret });
const imCalls = [];
const okResponse = (extra = {}) => ({ code: 0, msg: 'ok', data: { message_id: 'om_selftest', ...extra } });
const fakeImClient = {
  bitable: realClient.bitable,
  im: {
    message: {
      create: async (args) => { imCalls.push(['message.create', args?.data?.msg_type]); return okResponse(); },
      reply: async (args) => { imCalls.push(['message.reply', args?.data?.msg_type]); return okResponse(); },
      patch: async (args) => { imCalls.push(['message.patch', args?.path?.message_id]); return okResponse(); },
    },
    messageReaction: {
      create: async () => { imCalls.push(['reaction.create']); return okResponse(); },
    },
  },
};
const gateway = new V1BitableGateway({ client: realClient });

// ── 只读体检：表结构 + 挑一条"有门盒库存"的货品 ─────────────────────────────
head('只读体检（一个字都没写）');
const validation = await gateway.validateTables([
  'salesEntry', 'salesDetail', 'paymentRecord', 'product', 'sizeManagement', 'behavior',
  'liveInventory', 'inventoryLedger', 'paymentMethod',
]);
for (const item of validation) say(`  OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`);

const sizeRecords = await gateway.listAll('sizeManagement');
const sizeByNumber = new Map(sizeRecords.map((row) => [Number(textValue(row.fields['尺码'])), row.record_id]));
const liveInventory = await gateway.listAll('liveInventory');
const doorBoxRows = liveInventory.filter((row) => textValue(row.fields['所属状态']) === '门盒');

const wantedProduct = String(flags.product || '').trim();
const wantedSize = Number(flags.size || 42);
const candidate = doorBoxRows.find((row) => {
  const productId = linkedRecordIds(row.fields['编号'])[0];
  if (wantedProduct && productId !== wantedProduct) return false;
  const sizeId = linkedRecordIds(row.fields['尺码'])[0];
  return sizeByNumber.get(wantedSize) === sizeId;
});
if (!candidate) throw new Error(`测试 Base 里找不到「${wantedSize} 码 + 门盒」的实时库存行，请用 --product/--size 指定`);
const productRecordId = linkedRecordIds(candidate.fields['编号'])[0];
const productRow = await gateway.get('product', productRecordId);
const itemNo = textValue(productRow.fields[gateway.table('product').fields.itemNo]);

say(`  数据源：货品 ${productRecordId}（货号 ${itemNo}）· 尺码 ${wantedSize} · 门盒库存行 ${candidate.record_id}`);

// 「录单人」是真表上的**用户字段**：必须用一个真的 open_id，编一个会让飞书回
// UserFieldConvFail（1254066）。默认从已有记录里取一个，也允许 --sender 指定。
const someEntry = (await gateway.listAll('salesEntry')).find((row) => row.fields['录单人']);
const senderOpenId = String(flags.sender
  || someEntry?.fields?.['录单人']?.[0]?.id
  || '').trim();
if (!senderOpenId) throw new Error('测试 Base 里找不到可用的录单人 open_id，请用 --sender 指定');
say(`  录单人：从已有记录取到一个真实 open_id（不打印其值）`);
say(`  表结构校验通过；本次将新建 1 条销售主表 + 1 条明细 + 1 条收款 + 1 条库存流水（测试 Base）。`);

if (!apply) {
  say('');
  say('  ✅ 只读体检结束：**没有写任何东西**。要跑完整链路请加 --apply。');
  process.exit(0);
}

// ── 真跑：建单 → 她点「确认」→ 交付 ────────────────────────────────────────
head('跑链路（走项目代码）');
const store = new JsonTaskStore({
  dir: fsSync.mkdtempSync(path.join(serverRoot, 'data', 'selftest-e2e-')),
  idField: 'task_id',
});
const service = new LarkMvpService({ client: fakeImClient, gateway, store });

const created = await service.createSalesEntryWithOrderNo({
  task_id: 'selftest-sale',
  original_text: `卖一双 ${itemNo} ${wantedSize} 码，100 元微信`,
  sender_open_id: senderOpenId,
});
const salesEntryRecordId = created?.recordId;
if (!salesEntryRecordId) throw new Error('建单没有返回 record_id');
say(`  ① 建单完成：销售主表 ${salesEntryRecordId}（单号 ${created.orderNo || '（见下）'}）`);

const afterCreate = await gateway.get('salesEntry', salesEntryRecordId);
const readBack = (record) => ({
  userAction: textValue(record.fields?.[SALES_STATUS_FIELDS.userAction]).trim(),
  sales: textValue(record.fields?.[SALES_STATUS_FIELDS.sales]).trim(),
  funds: textValue(record.fields?.[SALES_STATUS_FIELDS.funds]).trim(),
  stock: textValue(record.fields?.[SALES_STATUS_FIELDS.stock]).trim(),
  legacy: textValue(record.fields?.[LEGACY_SALES_STATUS_FIELDS.legacyConfirm]).trim(),
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
      product_record_id: productRecordId,
      item_no: itemNo,
      color: '',
      size: wantedSize,
      quantity: 1,
      actual_amount: 100,
    }],
  },
});

const actionResult = await service.handleCardAction({
  action: { value: { draft_id: draftId, action: 'confirm_sale' } },
  operator: { operator_id: { open_id: senderOpenId } },
  context: { open_message_id: 'om_selftest' },
});
say(`  ② 点了「确认」：${JSON.stringify(actionResult)}`);

// ── 回读四个字段 ────────────────────────────────────────────────────────────
head('验收：四个状态字段的实际值（测试 Base）');
const finalRecord = await gateway.get('salesEntry', salesEntryRecordId);
const values = readBack(finalRecord);
const orderNo = textValue(finalRecord.fields?.[gateway.table('salesEntry').fields.orderNo]);
say(`  record_id : ${salesEntryRecordId}`);
say(`  销售单号  : ${orderNo}`);
say(`  确认状态  : '${values.userAction}'   （期望：已确认）`);
say(`  销售状态  : '${values.sales}'   （期望：已写入）`);
say(`  资金状态  : '${values.funds}'   （期望：已写入）`);
say(`  库存状态  : '${values.stock}'   （期望：已扣减）`);
say(`  确认状态（旧）: '${values.legacy}'   （期望：空 —— 旧字段已停写）`);
say(`  闸门判据 isPosted(资金状态) = ${isPosted(values.funds)}   （POSTED_VALUES = ${JSON.stringify(POSTED_VALUES)}）`);

const details = (await gateway.listAll('salesDetail'))
  .filter((row) => linkedRecordIds(row.fields?.[gateway.table('salesDetail').fields.salesEntry]).includes(salesEntryRecordId));
const receipts = (await gateway.listAll('paymentRecord'))
  .filter((row) => linkedRecordIds(row.fields?.[gateway.table('paymentRecord').fields.salesEntry]).includes(salesEntryRecordId));
say(`  关联明细  : ${details.length} 条 · 关联收款 ${receipts.length} 条`);
say(`  IM 替身调用：${imCalls.length} 次（全部拦在本地，没有真实外发）`);

const expectations = [
  ['确认状态', values.userAction, '已确认'],
  ['销售状态', values.sales, '已写入'],
  ['资金状态', values.funds, '已写入'],
  ['库存状态', values.stock, '已扣减'],
  ['确认状态（旧）', values.legacy, ''],
];
const failures = expectations.filter(([, actual, expected]) => actual !== expected);
say('');
if (failures.length) {
  say(`  ✗ 未达标：${failures.map(([name, actual, expected]) => `${name}='${actual}'（期望 '${expected}'）`).join('；')}`);
  process.exit(1);
}
say('  ✅ 四个字段全部达标（记录 id 见上）。');
