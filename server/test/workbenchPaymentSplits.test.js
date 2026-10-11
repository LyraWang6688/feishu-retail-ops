/**
 * ⭐⭐ 工作台「补收款」**支持分笔** 的验收标准（业务负责人 **2026-10-12** 批准：「1. 可以做」）。
 *
 * 她的口径（Lead 转述，逐条）：
 *   ① **支持分笔**：每次提交记**一条收款行**（方式由她填、**每笔可不同**），累计到**收满待收**为止；
 *   ② **收满之后**：那条【未收款】按既有口径**同步**（差额同步成 **0**、**不删记录**）——
 *      与「逐件补实收」那条链（`updateDetailAmounts`）**口径一致**；
 *   ③ 红线：**不许超收**（本次收款 > 当前待收 ⇒ 拦住 + 人话差额）· **幂等**（同一 `request_id`
 *      重放不重复记；内容不同 ⇒ 大声拦）· **不改任何状态维度**（读侧现算 ⇒ 状态自动跟上）·
 *      **方式照她说、不猜、不设默认**；
 *   ④ **既有判据改写**：`salesFollowupService` 原来有一条硬判据
 *      「本版请一次收清这条待收款记录；分笔补款暂不支持」⇒ **它的前提没了**（详见 AC-PS1 的注释）。
 *
 * ⚠️ 本文件用的是**真的** `SalesFollowupService` / `PaymentService` / `SalesProgressService`
 *    （只有飞书那一层是内存替身）—— 所以"记了几条行、那条未收款变成多少"是**跑出来的**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PS1 ⭐ **分笔 200 + 300 收满**：两次提交 ⇒ **两条**收款行（各一笔、各自的方式），
 *         那条【未收款】先同步成剩余 300、收满后同步成 **0**；收款状态现算成「已收款」。
 *  AC-PS2 **超收拦住（零写入）**：本次金额 > 当前待收 ⇒ 拦住 + 人话差额，**一个字节都不写**。
 *  AC-PS3 **幂等**：同一 `request_id` 同内容重放 ⇒ 不写第二遍、把上次结果还给她；
 *         内容不同 ⇒ 大声拦（不许当成同一次）。
 *  AC-PS4 **收满后那条【未收款】同步成 0 且不删记录**（一次收满也一样）。
 *  AC-PS5 **每笔方式可不同**（微信 200 + 现金 300 ⇒ 两条行、两个方式；系统不替她选）。
 *  AC-PS6 **无【未收款】的单仍能分笔**（回归：这条本来就支持）。
 *  AC-PS7 **既有「待补充 / 待交割 / 售后列表」三态不受影响**（读侧现算口径照旧）。
 *  AC-PS8 **页面上能连着分几笔**：补收款表单 = 金额（预填当前待收）+ 收款方式 + 提交，
 *         页面里**没有**"一次收清 / 暂不支持"这类话、也没有说明书腔。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_payment_splits_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'payment_splits_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const uuid = () => crypto.randomUUID();

const ENTRY = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
const DETAIL = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
const PAYMENT = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
const METHOD = V1_BITABLE_SCHEMA.tables.paymentMethod.fields;

const ORDER = 'o1';
const DETAIL_ID = 'd1';

/** 一张"已入账、已交付、实收 500"的单；可带上那条【未收款】占位（`pending`）。 */
const seed = ({ actualAmount = 500, pendingAmount = null, pending = true, payments = [] } = {}) => ({
  salesEntry: [{
    record_id: ORDER,
    fields: { [ENTRY.orderNo]: 'XSD-20261012-0001', [ENTRY.funds]: '已写入', [ENTRY.sales]: '已写入' },
  }],
  salesDetail: [{
    record_id: DETAIL_ID,
    fields: {
      [DETAIL.salesEntry]: [ORDER],
      [DETAIL.product]: ['prod_a'],
      [DETAIL.size]: ['size_40'],
      [DETAIL.fulfillmentStatus]: '已交付',
      [DETAIL.actualAmount]: actualAmount,
    },
  }],
  paymentRecord: [
    ...(pending && pendingAmount !== null
      ? [{ record_id: 'pay_pending', fields: { [PAYMENT.salesEntry]: [ORDER], [PAYMENT.status]: '未收款', [PAYMENT.amount]: pendingAmount } }]
      : []),
    ...payments,
  ],
  paymentMethod: [
    { record_id: 'pm_wechat', fields: { [METHOD.name]: '微信' } },
    { record_id: 'pm_cash', fields: { [METHOD.name]: '现金' } },
  ],
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
const fakeGateway = (tables) => {
  const writes = [];
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('假网关不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((row) => row.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((row) => String(row.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, record_id: record.record_id, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    delete: async () => { throw new Error('测试网关：收款链路不许删记录'); },
  };
};

const build = (options = {}) => {
  const tables = options.tables || seed(options);
  const gateway = fakeGateway(tables);
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'payment-splits-')), idField: 'task_id',
  });
  const service = new SalesFollowupService({ gateway, store });
  return { gateway, service, tables };
};

const paymentsOf = (tables) => tables.paymentRecord || [];
const paidRows = (tables) => paymentsOf(tables).filter((row) => row.fields[PAYMENT.status] === '已收款');
const pendingRows = (tables) => paymentsOf(tables).filter((row) => row.fields[PAYMENT.status] === '未收款');
const amountOf = (row) => Number(row.fields[PAYMENT.amount]);
const methodOf = (row) => row.fields[PAYMENT.method]?.[0] || '';

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS1 ⭐ 分笔 200 + 300 收满
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS1 ⭐ 分笔 200 + 300 收满：两条收款行 + 【未收款】先 300、收满后 0', async () => {
  // 她的形状：实收 500、那条【未收款】占位 500（未付/部分付留下的）
  const { service, tables } = build({ actualAmount: 500, pendingAmount: 500 });
  const first = await service.addPayment({
    requestId: uuid(), salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1',
  });
  assert.ok(first.recordId, '第一笔记了一条收款行');
  assert.equal(paidRows(tables).length, 1, '第一笔 = 一条「已收款」行（**不再**去改那条占位行）');
  assert.equal(amountOf(paidRows(tables)[0]), 200);
  assert.equal(pendingRows(tables).length, 1, '那条【未收款】还在（不删记录）');
  assert.equal(amountOf(pendingRows(tables)[0]), 300, '【未收款】同步成**剩余** 300');

  const second = await service.addPayment({
    requestId: uuid(), salesEntryRecordId: ORDER, amount: 300, method: '现金', operatorOpenId: 'ou_1',
  });
  assert.ok(second.recordId, '第二笔记了第二条收款行');
  // ⚠️ 2026-10-12 **改写**（原来这里是抛错：`本版请一次收清这条待收款记录；分笔补款暂不支持`）：
  //    改前那条硬判据的前提是"收款只有一次性收清那一条路"；她 2026-10-12 明确「可以做」分笔 ⇒
  //    判据撤销，改成"每笔各记一条行、收满为止"。
  assert.equal(paidRows(tables).length, 2, '两笔 = 两条「已收款」行');
  assert.deepEqual(paidRows(tables).map(amountOf), [200, 300], '各自的金额如实落表');
  assert.equal(pendingRows(tables).length, 1, '那条【未收款】**没有**被删掉');
  assert.equal(amountOf(pendingRows(tables)[0]), 0, '收满 ⇒ 【未收款】同步成 0');
  assert.equal(Number(second.pendingAmount ?? 0), 0, '结果里如实回"还差 0"');

  // 读侧现算：这一单已经收满（状态维度**一个都没被写**，全是现算出来的）
  const progress = await service.progress.forOrder(ORDER);
  assert.equal(progress.paymentStatus, '已收款', '现算的收款状态 = 已收款');
  assert.equal(progress.pendingAmount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS2 超收拦住（零写入）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS2 超收拦住（零写入）：本次收款 > 当前待收 ⇒ 拦住 + 人话差额，一个字节都不写', async () => {
  const { service, gateway, tables } = build({ actualAmount: 500, pendingAmount: 500 });
  const before = JSON.stringify(paymentsOf(tables));
  await assert.rejects(() => service.addPayment({
    requestId: uuid(), salesEntryRecordId: ORDER, amount: 600, method: '微信', operatorOpenId: 'ou_1',
  }), /本次收款超过待收金额/);
  assert.deepEqual(gateway.writes, [], '一个字都不写（连那条失败任务记录都不建）');
  assert.equal(JSON.stringify(paymentsOf(tables)), before, '收款明细一条没变');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS3 幂等（同键重放）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS3 幂等：同一 request_id 同内容重放 ⇒ 不写第二遍；内容不同 ⇒ 大声拦', async () => {
  const { service, tables } = build({ actualAmount: 500, pendingAmount: 500 });
  const requestId = uuid();
  const first = await service.addPayment({
    requestId, salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1',
  });
  const again = await service.addPayment({
    requestId, salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1',
  });
  assert.deepEqual(again, first, '重放 = 把上次结果还给她');
  assert.equal(paidRows(tables).length, 1, '只写了一次');
  assert.equal(amountOf(pendingRows(tables)[0]), 300, '【未收款】也只同步过那一次');
  await assert.rejects(() => service.addPayment({
    requestId, salesEntryRecordId: ORDER, amount: 250, method: '微信', operatorOpenId: 'ou_1',
  }), /内容不一致/);
  assert.equal(paidRows(tables).length, 1, '内容对不上 ⇒ 什么也不写');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS4 收满后【未收款】同步成 0 且不删记录（一次收满也一样）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS4 一次收满：那条【未收款】同步成 0、**不删**（与「逐件补实收」同一条口径）', async () => {
  const { service, gateway, tables } = build({ actualAmount: 500, pendingAmount: 500 });
  await service.addPayment({
    requestId: uuid(), salesEntryRecordId: ORDER, amount: 500, method: '微信', operatorOpenId: 'ou_1',
  });
  assert.equal(pendingRows(tables).length, 1, '记录还在（本链路**没有**删除路径）');
  assert.equal(amountOf(pendingRows(tables)[0]), 0, '金额同步成 0');
  assert.deepEqual(
    gateway.writes.filter((item) => item.table === 'paymentRecord' && item.op === 'update')
      .map((item) => [item.record_id, item.fields[PAYMENT.amount]]),
    [['pay_pending', 0]],
    '只对那条占位行做过一次"金额 → 0"的更新',
  );
  // 收满之后再想收 ⇒ 待收 0，拦住（不许超收）
  await assert.rejects(() => service.addPayment({
    requestId: uuid(), salesEntryRecordId: ORDER, amount: 1, method: '微信', operatorOpenId: 'ou_1',
  }), /本次收款超过待收金额/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS5 每笔方式可不同
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS5 每笔方式可不同：微信 200 + 现金 300 ⇒ 两条行、两个方式（系统不替她选）', async () => {
  const { service, tables } = build({ actualAmount: 500, pendingAmount: 500 });
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1' });
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 300, method: '现金', operatorOpenId: 'ou_1' });
  assert.deepEqual(paidRows(tables).map(methodOf), ['pm_wechat', 'pm_cash'], '每笔方式照她说的记');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS6 无【未收款】的单仍能分笔（回归）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS6 无【未收款】的单仍能分笔（回归：这条本来就支持）', async () => {
  const { service, tables } = build({ actualAmount: 500, pending: false });
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1' });
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 300, method: '现金', operatorOpenId: 'ou_1' });
  assert.equal(paidRows(tables).length, 2);
  assert.equal(pendingRows(tables).length, 0, '本来就没有占位行 ⇒ 也不凭空建一条');
  const progress = await service.progress.forOrder(ORDER);
  assert.equal(progress.paymentStatus, '已收款');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS7 既有三态（待补充 / 待交割 / 售后列表）不受影响
// ═══════════════════════════════════════════════════════════════════════════

const loadOrdersLogic = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-splits-front-'));
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
  return import(pathToFileURL(path.join(dir, 'orders-index.mjs')).href);
};

test('AC-PS7 既有三态不受影响：分笔中 = 待交割；收满 = 售后列表；一条都没收 = 待补充', async () => {
  const front = await loadOrdersLogic();
  const paymentsFor = (rows) => rows.map((row) => ({
    method: methodOf(row) ? '微信' : '', amount: amountOf(row), status: row.fields[PAYMENT.status],
  }));
  const orderWith = (payments) => ({
    record_id: ORDER, order_no: 'XSD-20261012-0001',
    fulfillment_status: '已交付', payment_status: '部分收款',
    details: [{ record_id: DETAIL_ID, product: 'YD1', color: '黑色', size: 40, actual_amount: 500, fulfillment_status: '已交付' }],
    payments,
  });

  // ① 一分都没收（只有那条不带方式的【未收款】）⇒ 资金信息不齐 ⇒ **待补充**
  const bare = orderWith([{ method: '', amount: 500, status: '未收款' }]);
  assert.equal(front.salesSectionOf(bare), 'supplement', '还没收钱 ⇒ 待补充');

  // ② 分笔收了 200（带方式）⇒ 资金信息齐、但还没两清 ⇒ **待交割**
  const half = orderWith([
    { method: '微信', amount: 200, status: '已收款' },
    { method: '', amount: 300, status: '未收款' },
  ]);
  assert.equal(front.salesSectionOf({ ...half, payment_status: '部分收款' }), 'pending', '收了第一笔 ⇒ 待交割');

  // ③ 收满 ⇒ 已交付 + 已收款 ⇒ **售后列表**
  const done = orderWith([
    { method: '微信', amount: 200, status: '已收款' },
    { method: '现金', amount: 300, status: '已收款' },
  ]);
  assert.equal(front.salesSectionOf({ ...done, payment_status: '已收款' }), 'afterSales', '钱货两清 ⇒ 售后列表');

  // ④ 真跑一遍：分笔 200 + 300 之后，读侧现算出来的收款状态就是"已收款"（与③同一档）
  const { service } = build({ actualAmount: 500, pendingAmount: 500 });
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 200, method: '微信', operatorOpenId: 'ou_1' });
  const halfProgress = await service.progress.forOrder(ORDER);
  assert.equal(halfProgress.paymentStatus, '部分收款', '收了一半 ⇒ 部分收款（⇒ 待交割）');
  await service.addPayment({ requestId: uuid(), salesEntryRecordId: ORDER, amount: 300, method: '现金', operatorOpenId: 'ou_1' });
  const doneProgress = await service.progress.forOrder(ORDER);
  assert.equal(doneProgress.paymentStatus, '已收款', '收满 ⇒ 已收款（⇒ 售后列表）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS8 页面上能连着分几笔（无说明书腔）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS8 页面：补收款表单 = 金额（预填当前待收）+ 方式 + 提交；没有"一次收清/暂不支持"这类话', async () => {
  const front = await loadOrdersLogic();
  const html = front.orderDetailHtml({
    record_id: ORDER, order_no: 'XSD-20261012-0001',
    fulfillment_status: '已交付', payment_status: '部分收款',
    paid_amount: 200, pending_amount: 300, receivable_amount: 500, pending_delivery_quantity: 0,
    details: [{ record_id: DETAIL_ID, product: 'YD1', color: '黑色', size: 40, actual_amount: 500, fulfillment_status: '已交付' }],
    payments: [{ record_id: 'p1', method: '微信', amount: 200, status: '已收款' }],
  }, { methods: ['微信', '现金'] });

  assert.ok(html.includes('data-action-block="payment"'), '补收款那一块在');
  assert.match(html, /data-field="payment-amount"[^>]*value="300"/, '金额预填**当前待收**（她接着分下一笔）');
  assert.ok(html.includes('data-field="payment-method"'), '方式由她选（每笔可不同）');
  assert.ok(html.includes('data-action="submit-payment"'), '提交按钮');
  // 页面里**不许**出现"一次收清"那类话（也不许有说明书腔）
  for (const banned of ['一次收清', '暂不支持', '分笔', '说明', '注意', '请先']) {
    assert.equal(html.includes(banned), false, `页面里出现了不该有的话：${banned}`);
  }
  // 源码里也没有（她 2026-10-10：「下面的这些文字解释就不用了」）
  const source = readWorkbench('features/orders/index.js');
  assert.equal(/一次收清|暂不支持/.test(source), false, '补收款这块的源码里不许留"一次收清"那类话');
});
