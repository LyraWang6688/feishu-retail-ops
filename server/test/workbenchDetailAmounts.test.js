/**
 * ⭐⭐ 工作台【订单列表】里**逐件补「实收金额」**的验收标准（业务负责人 **2026-10-11**）。
 *
 * 她的原话（逐字）：「**待补充的时候，一定要把每件的实收都留下来**」。
 *
 * 背景（先只读核过，见交付报告）：
 *   · 她选了"方案甲" ⇒ 扫码建单可以**一分钱都不填**（明细「实收金额」留空）；
 *   · 全仓**没有**任何函数能改已写入明细的「实收金额」：`salesOrderService.confirm` 是
 *     "只建不改"（金额不等就抛「与当前草稿不一致，已停止重试」），`salesDetail` 的两处
 *     update 只写「履约状态」；
 *   ⇒ 所以这里**新增一条窄写入路径**：`SalesFollowupService.updateDetailAmounts`
 *     ＋ `POST /api/workbench/sales/detail-amounts`（鉴权走工作台既有闸门）。
 *
 * 🔴 **两条红线**（都在**写任何一个字节之前**判）：
 *   ① **改后实收合计不许小于已收合计** —— 否则读侧 `salesProgressService.js:74-76`
 *      的"已收 > 实收 ⇒ 抛错"会让这一单**整单读不出来**；
 *      ⚠️ 只要有**任何一件**实收还是空、而已收 > 0 ⇒ 也算"算不出来" ⇒ 拦住。
 *   ② **同步那条【未收款】的金额**（= 改后实收合计 − 已收合计）—— 否则紧接着的
 *      「补收款」会按**旧差额**去"一次收清"，两边对不上 ⇒ 补款直接报错。
 *
 * ⚠️ **留空的件 = 这一件先不动**（不是"清空"）：只写她真填了的那几件。
 * ⚠️ 副作用（要在报告里讲明）：**改过实收的单，不能再拿扫码那一次的草稿走 `confirm` 重试**
 *    —— 那会命中它"与当前草稿不一致"的防串单保护。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-DA1 **逐件补实收**：她填的那几件写进「销售明细.实收金额」；**没填的件一个字不动**；
 *          留空不等于"清空"。
 *  AC-DA2 **红线①（不许小于已收）**：改后合计 < 已收 ⇒ 拦住；**有件还是空 + 已收 > 0** ⇒ 拦住；
 *          两种都**一个字都不写**。
 *  AC-DA3 **红线②（同步【未收款】金额）**：差额同步进那条待收款记录（下一步"补收款"才收得清）；
 *          没有待收款记录时**不新建**（那一步由既有「补收款」做）。
 *  AC-DA4 **幂等**：同一把 `request_id` 重放 ⇒ 不写第二遍、把上次结果还给她；
 *          内容不同 ⇒ 大声拦（不许当成同一次）。
 *  AC-DA5 **页面上能填**：待补充的单（有件缺实收）渲染出**逐件**输入框（预填现有的值）、
 *          字段名 = 「实收金额」，动作 = `submit-detail-amount`，POST 走
 *          `ORDERS_API.detailAmounts`；实收已经齐的单**不画这个块**（不留噪音）；
 *          块里**没有说明书句**。
 *  AC-DA6 **拦住的那几类**：单子没入账 / 要改的明细不属于这一单 / 金额不是大于 0 的数 / 一件都没填。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_detail_amount_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'detail_amount_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const uuid = () => crypto.randomUUID();

const DETAIL = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
const PAYMENT = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
const ENTRY = V1_BITABLE_SCHEMA.tables.salesEntry.fields;

/** 假网关：只认语义键，**把每一次写都记下来**（既有测试同一套做法）。 */
const fakeGateway = ({ details = [], payments = [], posted = true } = {}) => {
  const records = {
    salesEntry: [{
      record_id: 'order_1',
      fields: {
        [ENTRY.orderNo]: 'XSD-20261011-0001',
        // ⚠️ 「账做完了没有」这一道闸门读的是**「资金状态」**（`postedOf` ⇒ `funds`），
        //    不是「销售状态」——见 `config/salesStatusDimensions.js:115-116`。
        ...(posted ? { [ENTRY.funds]: '已写入', [ENTRY.sales]: '已写入' } : {}),
      },
    }],
    salesDetail: details,
    paymentRecord: payments,
  };
  const writes = [];
  const semantic = (table, values) => {
    const out = {};
    for (const [key, value] of Object.entries(values)) {
      const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
      if (!name) throw new Error(`未配置语义字段: ${table}.${key}`);
      out[name] = value;
    }
    return out;
  };
  return {
    records,
    writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    get: async (key, id) => (records[key] || []).find((row) => row.record_id === id) || null,
    listAll: async (key) => records[key] || [],
    update: async (key, id, values) => {
      const row = (records[key] || []).find((item) => item.record_id === id);
      if (!row) throw new Error(`${key} ${id} not found`);
      const fields = semantic(key, values);
      Object.assign(row.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return row;
    },
  };
};

const detailRow = (id, amount) => ({
  record_id: id,
  fields: {
    [DETAIL.salesEntry]: ['order_1'],
    ...(amount === null || amount === undefined ? {} : { [DETAIL.actualAmount]: amount }),
  },
});

const pendingRow = (id, amount) => ({
  record_id: id,
  fields: { [PAYMENT.salesEntry]: ['order_1'], [PAYMENT.status]: '未收款', [PAYMENT.amount]: amount },
});

const build = ({ details, payments, paidAmount = 0, posted = true } = {}) => {
  const gateway = fakeGateway({ details, payments, posted });
  const sales = { recordsForSale: async () => gateway.records.paymentRecord || [] };
  const progress = { forOrder: async () => ({ paidAmount }) };
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'detail-amount-')), idField: 'task_id',
  });
  const service = new SalesFollowupService({ gateway, payments: sales, progress, store });
  return { gateway, service, store };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA1 逐件补实收（留空 = 这一件不动）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DA1 逐件补实收：她填的那几件写进「实收金额」；没填的件一个字不动', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', null), detailRow('detail_2', 100)],
  });
  const result = await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [{ detailRecordId: 'detail_1', amount: '399' }],
    requestId: uuid(),
  });
  assert.deepEqual(result.changed, [{ record_id: 'detail_1', actual_amount: 399 }]);
  assert.equal(gateway.records.salesDetail[0].fields[DETAIL.actualAmount], 399, '她填的那件写进去了');
  assert.equal(gateway.records.salesDetail[1].fields[DETAIL.actualAmount], 100, '没填的那件原样不动');
  assert.equal(result.total_amount, 499, '合计 = 现有的两件之和');
  assert.equal(result.paid_amount, 0);
  assert.equal(result.owed, null, '没有待收款记录 ⇒ 不新建（补收款那一步由既有「补收款」做）');
});

test('AC-DA1b 留空 ≠ 清空：她只填一件，另一件**保持原值**（服务端只写她真填的）', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', 200), detailRow('detail_2', 100)],
  });
  await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [
      { detailRecordId: 'detail_1', amount: '' },          // 留空 = 不动
      { detailRecordId: 'detail_2', amount: '250' },
    ],
    requestId: uuid(),
  });
  assert.equal(gateway.records.salesDetail[0].fields[DETAIL.actualAmount], 200, '留空的那件没有被清空');
  assert.equal(gateway.records.salesDetail[1].fields[DETAIL.actualAmount], 250);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA2 🔴 红线①：改后实收合计不许小于已收合计
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DA2 改后实收合计 < 已收合计 ⇒ 拦住、**一个字都不写**（否则整单在列表里读不出来）', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', 300)], paidAmount: 500,
  });
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [{ detailRecordId: 'detail_1', amount: '300' }],
    requestId: uuid(),
  }), /还少/);
  assert.deepEqual(gateway.writes, [], '一个字都不写');
});

test('AC-DA2b 还有件是空 + 已收 > 0 ⇒ 也算"算不出来"⇒ 拦住、一个字不写', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', null), detailRow('detail_2', 100)], paidAmount: 50,
  });
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [{ detailRecordId: 'detail_2', amount: '120' }],
    requestId: uuid(),
  }), /还有 1 件没填/);
  assert.deepEqual(gateway.writes, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA3 🔴 红线②：同步那条【未收款】的金额（下一步"补收款"才收得清）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DA3 有那条【未收款】⇒ 差额同步进它（差额 = 改后实收合计 − 已收合计）', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', null)], payments: [pendingRow('pay_pending', 400)],
  });
  const result = await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [{ detailRecordId: 'detail_1', amount: '500' }],
    requestId: uuid(),
  });
  assert.deepEqual(result.owed, { record_id: 'pay_pending', amount: 500 });
  assert.equal(gateway.records.paymentRecord[0].fields[PAYMENT.amount], 500, '待收款那条同步成新差额');
  assert.equal(gateway.records.paymentRecord[0].fields[PAYMENT.status], '未收款', '状态一个字不动');
  // 补收款那一步用的就是它 ⇒ 两边对得上（服务端 addPayment 的"一次收清"判据）
  assert.deepEqual(gateway.writes.map((item) => item.table), ['salesDetail', 'paymentRecord']);
});

test('AC-DA3b 差额算成 0（已收 = 改后实收合计）⇒ 那条待收款同步成 0，不删记录', async () => {
  const { gateway, service } = build({
    details: [detailRow('detail_1', null)], payments: [pendingRow('pay_pending', 500)], paidAmount: 300,
  });
  const result = await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1',
    amounts: [{ detailRecordId: 'detail_1', amount: '300' }],
    requestId: uuid(),
  });
  assert.equal(result.owed.amount, 0, '不欠了');
  assert.equal(gateway.records.paymentRecord[0].fields[PAYMENT.amount], 0);
  assert.equal(gateway.records.paymentRecord.length, 1, '不去删记录（本版没有删除这条路径）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA4 幂等（与「补收款」同一套：一个 request_id 一把键）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DA4 同一把 request_id 重放 ⇒ 不写第二遍；内容不同 ⇒ 大声拦', async () => {
  const { gateway, service } = build({ details: [detailRow('detail_1', null)] });
  const requestId = uuid();
  const first = await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '399' }], requestId,
  });
  const again = await service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '399' }], requestId,
  });
  assert.deepEqual(again, first, '第二次把上一次的结果还给她');
  assert.equal(gateway.writes.length, 1, '只写一次');
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '400' }], requestId,
  }), /内容不一致/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA6 拦住的那几类（人话，不是内部错）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DA6 没入账 / 明细不属于这一单 / 金额 ≤ 0 / 一件都没填 ⇒ 逐条人话拦住', async () => {
  const notPosted = build({ details: [detailRow('detail_1', null)], posted: false });
  await assert.rejects(() => notPosted.service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '399' }], requestId: uuid(),
  }), /尚未确认入账/);

  const { service } = build({ details: [detailRow('detail_1', null)] });
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_other', amount: '399' }], requestId: uuid(),
  }), /不属于这一张销售单/);
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '0' }], requestId: uuid(),
  }), /大于 0/);
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [{ detailRecordId: 'detail_1', amount: '  ' }], requestId: uuid(),
  }), /还没有要补的实收金额/);
  await assert.rejects(() => service.updateDetailAmounts({
    salesEntryRecordId: 'order_1', amounts: [], requestId: 'not-a-uuid',
  }), /有效 request_id/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DA5 页面上能填（真跑前端模块，与既有 workbench 用例同一套做法）
// ═══════════════════════════════════════════════════════════════════════════

const loadFrontendModules = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-amount-front-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { config: load('orders-config'), orders: load('orders-index') };
};

const ORDER = (details) => ({
  record_id: 'order_1', order_no: 'XSD-20261011-0001',
  fulfillment_status: '已交付', payment_status: '',
  receivable_amount: null, paid_amount: 0, pending_amount: null,
  details,
  payments: [],
});

test('AC-DA5 待补充的单：逐件输入框（预填现值）+ 字段名「实收金额」+ 没有说明书句', async () => {
  const { config, orders } = loadFrontendModules();
  const [front, mod] = await Promise.all([config, orders]);

  assert.equal(front.ORDERS_API.detailAmounts, '/api/workbench/sales/detail-amounts',
    '接口路径进配置（唯一来源）');
  assert.equal(front.ORDERS_TEXTS.detailAmountLabel, '实收金额',
    '字段名与扫码页逐字一致（两个入口填的是同一份字段）');

  const html = mod.orderDetailHtml(ORDER([
    { record_id: 'detail_1', product: 'XHB8095', size: 38, actual_amount: null, fulfillment_status: '已交付' },
    { record_id: 'detail_2', product: 'XHB8095', size: 39, actual_amount: 120, fulfillment_status: '已交付' },
  ]), { methods: ['微信'] });
  assert.ok(html.includes('data-action-block="detail-amount"'), '有件缺实收 ⇒ 画这个块');
  assert.equal((html.match(/data-field="detail-amount"/g) || []).length, 2, '逐件一个输入框');
  assert.match(html, /data-detail="detail_1"[^>]*value=""/, '缺的那件预填空');
  assert.match(html, /data-detail="detail_2"[^>]*value="120"/, '已填的那件**预填现值**（不用重打）');
  assert.ok(html.includes('data-action="submit-detail-amount"'), '提交按钮走同一个动作名');
  assert.ok(html.includes('实收金额'), '字段名就在页面上');
  // 块里**没有说明书句**（她 2026-10-10 的硬要求：只留能填能点的）
  const start = html.indexOf('data-action-block="detail-amount"');
  const block = html.slice(start, html.indexOf('</details>', start));
  for (const banned of ['请先', '你需要', '说明', '注意', '可以', '如果']) {
    assert.equal(block.includes(banned), false, `补实收块里出现了说明性字眼「${banned}」`);
  }

  const complete = mod.orderDetailHtml(ORDER([
    { record_id: 'detail_1', product: 'XHB8095', size: 38, actual_amount: 399, fulfillment_status: '已交付' },
  ]), { methods: ['微信'] });
  assert.equal(complete.includes('data-action-block="detail-amount"'), false,
    '实收已经齐的单**不画**这个块（不留噪音）');
});
