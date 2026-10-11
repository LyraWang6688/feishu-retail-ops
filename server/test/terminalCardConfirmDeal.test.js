// 「已入账」终态卡上的【确认成交】按钮（预定 / 现货未收清）。
//
// 业务负责人的口径（2026-10-07，逐字）：
//   「一旦判定这一单是**预订或者现货未收**，入账之后就会给用户发一个消息卡片，
//    确认该笔交易是否成交。**只有当用户点击"是"的时候，才会触发我们后续的流程**。」
//   ★ 她拍板的实现方式（**甲**）：「把【确认成交】按钮**做在那张已经在你手里的卡上**
//     （就是"销售订单处理中/已入账"那张**终态卡**）—— **不新发消息**，你在原卡上点」
//
// 这个文件盯的是**业务规则本身**（验收标准见 docs/terminal-card-confirm-deal-2026-10-07.md 第 4 节）：
//   · 按钮**只在需要它的单子上**出现（预定未交付 / 现货有欠款）；现货已交付已结清的一律没有；
//   · 卡面上**只有一个**按钮，没有"取消 / 否 / 稍后"；
//   · 点一下 = 走**既有**的「成交」那一条路（未交付→已交付 + 扣库存；待收→已收 + 收款时间）；
//   · 重复点**不重复写**（幂等）；
//   · 预定单货还没到（库存不足）→ **明确说清**、**一个字节都不写**（不写半成品账）；
//   · 点成功后**被点的那张卡**被 patch 成「已成交」（不新发消息）；
//   · 回调先同步响应（3 秒硬限制），重活异步；
//   · **别的卡片一个字都不动**。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
const larkCards = require('../src/utils/larkCards');
const {
  SALES_CONFIRM_DEAL_ACTIONS,
  CONFIRM_DEAL_TASK_STATUS,
  SALES_CONFIRM_DEAL_DEFAULTS_BY_KEY,
  needsConfirmDeal,
  resolveSalesConfirmDealConfig,
} = require('../src/config/salesConfirmDeal');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || 'ou_test_bot_open_id';

const ENTRY_ID = 'order_1';

// ─────────────────────────────────────────────────────────────────────────────
// 假 Base / 假飞书：语义字段名 → 真实字段名的映射与线上 schema 完全一致，
// 所以"到底写进哪一列"是被真正验证的（写错字段名会在这里直接抛错）。
// ─────────────────────────────────────────────────────────────────────────────
const fakeGateway = (seed = {}) => {
  let seq = 0;
  const records = new Map(Object.entries(seed).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  const writes = [];
  const apply = (key, values) => {
    const fields = {};
    for (const [name, value] of Object.entries(values || {})) {
      if (value === undefined) continue;
      const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      fields[field] = value;
    }
    return fields;
  };
  const gateway = {
    records, writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${key}_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: apply(key, values) });
      writes.push({ table: key, op: 'create', recordId, semantic: values });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      Object.assign(record.fields, apply(key, values));
      writes.push({ table: key, op: 'update', recordId: id, semantic: values });
      return record;
    },
  };
  return gateway;
};

// 库存：记下每一次「销售减少」的调用（= 扣库存），并可以按用例让某一次失败（货还没到）。
// ⚠️ `applySaleCalls` = **尝试**次数（含失败的）；`appliedSaleCalls` = **真的扣成了**的那些。
//    "货没到"时交付引擎**会尝试**一次然后失败 ⇒ 只有后者能证明"库存没被扣"。
const fakeInventory = ({ failWith = '' } = {}) => {
  const applySaleCalls = [];
  const appliedSaleCalls = [];
  return {
    applySaleCalls,
    appliedSaleCalls,
    applySale: async (input) => {
      applySaleCalls.push(input);
      if (failWith) throw new Error(failWith);
      appliedSaleCalls.push(input);
      return { productRecordId: input.productRecordId, sampleConsumedQuantity: 0, consumedLiveRecordIds: [] };
    },
    getSaleResult: async () => null,
  };
};

// 假飞书 client：把真实的 patch / reply payload **原样抓下来**。
// ⭐ `failPatches` = 让**前 N 次** patch 失败（模拟卡片被撤回 / 权限 / 网络抖动）——
//    bug 2 要测的是「第一次 patch 失败后，再点一次能不能把卡面修好」，所以必须能模拟失败。
//    `patchAttempts` = 每一次尝试（含失败的），`patched` = **真正成功**的那些。
const fakeClient = ({ failPatches = 0 } = {}) => {
  const patched = [];
  const patchAttempts = [];
  const replies = [];
  let failuresLeft = failPatches;
  return {
    patched, patchAttempts, replies,
    im: {
      message: { reply: async (request) => {
        replies.push(request);
        return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_1' } };
      } },
      v1: { message: { patch: async (request) => {
        patchAttempts.push(request);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('测试模拟：卡片已被撤回，这次 patch 失败');
        }
        patched.push(request);
        return { code: 0, data: {} };
      } } },
    },
  };
};

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const BEHAVIOR_ROWS = [
  { record_id: 'behavior_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
  { record_id: 'behavior_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } },
];

// 一张已入账的单要用的最小种子：鞋 + 尺码 + 收款方式 + 主表 + 明细（± 一条待收款）。
const baseSeed = ({ tradeTypeCode, fulfillmentStatus, owed, paidReceived = 0 }) => {
  const seed = {
    behavior: BEHAVIOR_ROWS,
    paymentMethod: [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }],
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1', 货号: 'P1' } }],
    salesEntry: [{ record_id: ENTRY_ID, fields: {
      资金状态: '已写入', 销售单号: 'XSD-1',
      交易类型: [tradeTypeCode === 'SALE_PREPAID' ? 'behavior_prepaid' : 'behavior_cash'],
    } }],
    salesDetail: [{ record_id: 'd_1', fields: {
      销售单号: [ENTRY_ID], 编号: ['product_1'], 尺码: ['size_40'],
      履约状态: fulfillmentStatus, 实收金额: 260,
    } }],
    paymentRecord: [],
  };
  if (paidReceived > 0) {
    seed.paymentRecord.push({ record_id: 'pay_paid', fields: {
      关联销售单: [ENTRY_ID], 收款金额: paidReceived, 收款状态: '已收款', 收款方式: ['method_wechat'],
    } });
  }
  if (owed > 0) {
    seed.paymentRecord.push({ record_id: 'pay_pending', fields: {
      关联销售单: [ENTRY_ID], 收款金额: owed, 收款状态: '未收款',
    } });
  }
  return seed;
};

const draftFor = ({ tradeTypeCode, owed, paidTotal = 0 }) => ({
  items: [{ trade_type_code: tradeTypeCode, trade_type: tradeTypeCode === 'SALE_PREPAID' ? '预定' : '现货',
    size: 40, quantity: 1, actual_amount: 260, product_record_id: 'product_1', item_no: 'P1' }],
  payments: paidTotal > 0 ? [{ amount: paidTotal, method: '微信', status: '已收款' }] : [],
  agreed_total: 260,
  ...(owed > 0 ? { owed } : {}),
});

const makeHarness = ({ seed, draft, status = 'posted', inventoryOptions = {},
  inventory: injectedInventory, clientOptions = {}, taskPatch = {} } = {}) => {
  const gateway = fakeGateway(seed);
  const inventory = injectedInventory || fakeInventory(inventoryOptions);
  const client = fakeClient(clientOptions);
  const store = tmpStore('confirm-deal-task-');
  const salesDelivery = new SalesDeliveryService({ gateway, inventory });
  const secondDelivery = new SecondDeliveryService({
    gateway, delivery: salesDelivery, store: tmpStore('confirm-deal-2nd-'), chatId: '',
  });
  const service = new LarkMvpService({
    client, gateway, store,
    references: new V1ReferenceResolver(gateway),
    recognizer: {}, posting: {},
    delivery: salesDelivery,
    secondDelivery,
    purchaseBatchLocatorStore: tmpStore('confirm-deal-locator-'),
    salesGroupThreadStore: tmpStore('confirm-deal-thread-'),
    salesMessageLinks: { rememberFromSend: async (input) => ({ record: input }) },
  });
  const task = {
    task_id: 'sale_1', type: 'sale', status,
    sender_open_id: 'ou_1', sales_entry_record_id: ENTRY_ID,
    chat_type: 'group', chat_id: 'oc_1', message_id: 'om_trigger', card_message_id: 'om_card',
    draft, posting_result: { sourceNo: 'XSD-1', detailRecordIds: ['d_1'] },
    ...taskPatch,
  };
  return { service, gateway, inventory, client, store, task };
};

const createTask = async (store, task) => { await store.create(task); return task; };

const clickConfirmDeal = (service, { draftId = 'sale_1', messageId = 'om_card' } = {}) =>
  service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    context: { open_message_id: messageId },
    action: { value: {
      action: SALES_CONFIRM_DEAL_ACTIONS.CONFIRM,
      draft_id: draftId,
      sales_entry_record_id: ENTRY_ID,
    } },
  });

const cardButtons = (card) => (card?.elements || [])
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => (element.columns || []).flatMap((column) => column.elements || []))
  .filter((child) => child.tag === 'button');

const lastPatchedCard = (client) =>
  (client.patched.length ? JSON.parse(client.patched.at(-1).data.content) : null);

// 绿色成交卡底部那句 note（= 卡片上"这单怎么了"的说明行）。
const cardNote = (card) => (card?.elements || [])
  .filter((element) => element.tag === 'note')
  .flatMap((element) => (element.elements || []))
  .map((child) => String(child?.content || ''))
  .join('');

// 这张卡是不是被 patch 成「已成交」的样子（标题 = 配置里的成交标题）。
const isSettledCard = (client) => client.patched.some((item) =>
  JSON.parse(item.data.content).header?.title?.content === resolveSalesConfirmDealConfig().settledTitle);

// 抓结构化日志（`src/utils/logger.js`；info → stdout、warn/error → stderr），只旁听、照样转发。
// 与 `larkMvpService.test.js` 里那个同名工具同源：用来钉住"落没落那条带 written:false 的 warn"。
const captureLogs = async (fn) => {
  const lines = [];
  const patch = (stream) => {
    const original = stream.write;
    stream.write = function write(chunk, ...rest) {
      const text = String(chunk);
      if (text.includes('"event"')) lines.push(text);
      return original.apply(stream, [chunk, ...rest]);
    };
    return () => { stream.write = original; };
  };
  const restoreOut = patch(process.stdout);
  const restoreErr = patch(process.stderr);
  try { return { value: await fn(), logs: lines.join('') }; } finally { restoreOut(); restoreErr(); }
};

const logEvents = (logs, event) => String(logs || '').split('\n')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((line) => line && line.event === event);

// ═══════════════════════════════════════════════════════════════════════════
// 一、判据：按钮**只在需要它的单子上**（AC-1 / AC-2 / AC-3）
// ═══════════════════════════════════════════════════════════════════════════

test('判据：预定（未交付）→ 要按钮；现货 + 欠款 → 要；现货已交付已结清 → 不要', () => {
  // 预定：货没交（类型决定），无论钱收没收清都要这个按钮。
  assert.deepEqual(needsConfirmDeal({ draft: draftFor({ tradeTypeCode: 'SALE_PREPAID' }) }),
    { needed: true, reason: 'undelivered' });
  // 现货 + 欠款：货交了，钱没结清。
  assert.deepEqual(needsConfirmDeal({ draft: draftFor({ tradeTypeCode: 'SALE_CASH', owed: 260 }) }),
    { needed: true, reason: 'unsettled' });
  // 现货 + 已交付 + 已结清：干净的单一 —— **不许**打扰她。
  assert.deepEqual(needsConfirmDeal({ draft: draftFor({ tradeTypeCode: 'SALE_CASH', paidTotal: 260 }) }),
    { needed: false, reason: 'completed' });
  // 预定 + 已全款（定金全款）：货还没交，仍然要。
  assert.deepEqual(needsConfirmDeal({ draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }) }),
    { needed: true, reason: 'undelivered' });
  // 交付失败过（货其实没交出去）→ 也要，否则那几双永远没有回来的入口。
  assert.deepEqual(needsConfirmDeal({
    draft: draftFor({ tradeTypeCode: 'SALE_CASH', paidTotal: 260 }),
    deliveryFailures: [{ detailRecordId: 'd_1', error: '库存不够' }],
  }), { needed: true, reason: 'delivery_failed' });
});

test('终态卡：预订单的「已入账」卡上有且**只有**一个按钮，文案「确认成交」', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, client, store } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, {
    task_id: 'sale_prepaid', type: 'sale', status: 'posted', sender_open_id: 'ou_1',
    sales_entry_record_id: ENTRY_ID, chat_type: 'group', message_id: 'om_trigger', card_message_id: 'om_card',
    draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
    posting_result: { sourceNo: 'XSD-1', detailRecordIds: ['d_1'] },
  });

  await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_prepaid' } },
  });

  const card = lastPatchedCard(client);
  const buttons = cardButtons(card);
  assert.equal(buttons.length, 1, '卡面上只能有一个按钮');
  assert.equal(buttons[0].text.content, '确认成交');
  assert.equal(buttons[0].value.action, SALES_CONFIRM_DEAL_ACTIONS.CONFIRM);
  assert.equal(buttons[0].value.sales_entry_record_id, ENTRY_ID);
  // 「选项只能点是」：没有取消 / 否 / 稍后。
  for (const forbidden of ['取消', '否', '稍后', '不成交']) {
    assert.ok(!cardButtons(card).some((button) => String(button.text.content).includes(forbidden)),
      `不许有第二个选项：${forbidden}`);
  }
});

test('终态卡：现货 + 有欠款 → 有按钮；现货 + 已交付 + 已结清 → **没有**按钮', async () => {
  const owedSeed = baseSeed({ tradeTypeCode: 'SALE_CASH', fulfillmentStatus: '已交付', owed: 260 });
  const owedHarness = makeHarness({
    seed: owedSeed, draft: draftFor({ tradeTypeCode: 'SALE_CASH', owed: 260 }),
    taskPatch: { task_id: 'sale_owed' },
  });
  await createTask(owedHarness.store, owedHarness.task);
  await owedHarness.service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_owed' } },
  });
  assert.equal(cardButtons(lastPatchedCard(owedHarness.client)).length, 1, '现货欠款的单要有按钮');

  const cleanSeed = baseSeed({ tradeTypeCode: 'SALE_CASH', fulfillmentStatus: '已交付', owed: 0, paidReceived: 260 });
  const cleanHarness = makeHarness({
    seed: cleanSeed, draft: draftFor({ tradeTypeCode: 'SALE_CASH', paidTotal: 260 }),
    taskPatch: { task_id: 'sale_clean' },
  });
  await createTask(cleanHarness.store, cleanHarness.task);
  await cleanHarness.service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_clean' } },
  });
  const cleanCard = lastPatchedCard(cleanHarness.client);
  assert.deepEqual(cardButtons(cleanCard), [], '现货已交付已结清的单**不许**被打扰');
  assert.ok(!JSON.stringify(cleanCard).includes('确认成交'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、点【确认成交】：走**既有**的「成交」那一条路（AC-5）
// ═══════════════════════════════════════════════════════════════════════════

test('点【确认成交】预定单：未交付→已交付 + 扣库存 + 待收→已收（含收款时间）', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, gateway, inventory, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, task);

  const before = Date.now();
  const result = await clickConfirmDeal(service);

  // ① 货那一半：未交付 → 已交付，并且**真的扣了库存**（走 SalesDeliveryService）。
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  assert.equal(inventory.applySaleCalls.length, 1, '预定单成交要扣一次库存');
  assert.equal(inventory.applySaleCalls[0].productRecordId, 'product_1');
  assert.equal(inventory.applySaleCalls[0].size, 40);
  // ② 钱那一半：那条「未收款」→「已收款」＋「收款时间」＝ 点击时刻 ＋ 补交易方向。
  const receipt = gateway.records.get('paymentRecord').find((row) => row.record_id === 'pay_pending');
  assert.equal(receipt.fields['收款状态'], '已收款');
  assert.ok(Number(receipt.fields['收款时间']) >= before, '收款时间必须是点击那一刻');
  assert.deepEqual(receipt.fields['收款方式'], ['method_wechat']);
  assert.equal(receipt.fields['交易方向'], '收入');
  // ③ 回话 + toast 如实说清成交了什么。
  assert.equal(result.toast.type, 'success');
  assert.match(result.toast.content, /成交/);
});

test('点【确认成交】现货欠款单：只补收款，**一点库存都不碰**', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_CASH', fulfillmentStatus: '已交付', owed: 260 });
  const { service, gateway, inventory, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_CASH', owed: 260 }),
  });
  await createTask(store, task);

  await clickConfirmDeal(service);

  assert.equal(gateway.records.get('paymentRecord').find((row) => row.record_id === 'pay_pending')
    .fields['收款状态'], '已收款');
  assert.equal(inventory.applySaleCalls.length, 0, '现货单第一次交付已经扣过库存，成交只补收款');
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、幂等：重复点不重复写（AC-6）
// ═══════════════════════════════════════════════════════════════════════════

test('幂等：同一张卡连点两次 → 第二次只回「已经成交」，不重复交付 / 扣库存 / 写收款', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, task);

  const first = await clickConfirmDeal(service);
  assert.equal(first.toast.type, 'success');
  const writesAfterFirst = gateway.writes.length;
  const patchesAfterFirst = client.patched.length;
  const taskAfterFirst = await store.get('sale_1');

  // 第二次（网络重试 / 她再点一次）
  const second = await clickConfirmDeal(service);
  assert.equal(second.toast.type, 'info');
  assert.match(second.toast.content, /已经成交|无需重复/);
  assert.equal(inventory.applySaleCalls.length, 1, '扣库存只许发生一次');
  assert.equal(gateway.writes.length, writesAfterFirst, '第二次一个字节都不许写');
  // ⭐ bug 2 修复后**有意**的行为变化：第二次点击会**再 patch 一次卡面**（卡面自愈的机会）。
  //    旧的断言（"第二次不该再 patch"）正是 bug 2 的成因 —— 它把"唯一一次自愈机会"关掉了。
  //    ⚠️ 变的只有**卡片呈现**：业务表一个字节不写、本地任务记录也不再改（见下一条断言）。
  assert.equal(client.patched.length, patchesAfterFirst + 1,
    '第二次只补一次卡面 patch（自愈），不重复写库');
  assert.deepEqual(await store.get('sale_1'), taskAfterFirst, '本地任务记录也不许再改（confirm_deal_at 保持首次）');
  assert.equal((await store.get('sale_1')).confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.SETTLED);
});

test('幂等（第二道）：任务状态被抹掉也拦得住 —— 底层状态已是已交付 / 已收款就不再写', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, gateway, inventory, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, task);

  await clickConfirmDeal(service);
  // 把本地任务上的"已成交"标记抹掉（模拟本地记录丢失 / 换了一台机器）
  await store.update('sale_1', { confirm_deal_status: '' });
  const writesBefore = gateway.writes.length;

  const again = await clickConfirmDeal(service);
  assert.equal(again.toast.type, 'info', '底层事实已经是成交过 → 不重复写');
  assert.equal(inventory.applySaleCalls.length, 1, '不许重复扣库存');
  assert.equal(gateway.writes.length, writesBefore, '不许重复写收款 / 明细');
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、预定单货还没到（库存不足）→ 明确说清、**不写半成品账**（AC-7）
// ═══════════════════════════════════════════════════════════════════════════

test('预定单货还没到（库存不足）：明确提示、不写收款、不写已交付、卡片不变灰', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, gateway, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
    inventoryOptions: { failWith: '库存里没有 40 码这一双' },
  });
  await createTask(store, task);

  const result = await clickConfirmDeal(service);

  // ① 回话**明确说清**（文案来自配置）：货还没到 → 先走到货入库，再到这张卡上点。
  const config = resolveSalesConfirmDealConfig();
  const replyText = JSON.parse(client.replies.at(-1).data.content).text;
  assert.ok(replyText.includes(config.shortStock), `回话要说清货没到：${replyText}`);
  assert.match(replyText, /到货入库/);
  assert.match(replyText, /确认成交/);
  assert.notEqual(result.toast.type, 'success', '货没交出去就不许报成功');

  // ② **不写半成品账**：收款一个字节没动、明细还是未交付。
  const receipt = gateway.records.get('paymentRecord').find((row) => row.record_id === 'pay_pending');
  assert.equal(receipt.fields['收款状态'], '未收款', '货还没到就不许先把钱记成已收');
  assert.equal(receipt.fields['收款时间'], undefined);
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '未交付');
  // ③ 卡片**不变灰**（她还能再点）：不 patch 成"已成交"。
  assert.ok(!client.patched.some((item) => JSON.parse(item.data.content)
    .header?.title?.content === resolveSalesConfirmDealConfig().settledTitle),
  '货没到就不许把卡片写成已成交');
  // ④ 状态如实（可排查）。
  assert.equal((await store.get('sale_1')).confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.SHORT_STOCK);
});

test('预定单货到了再点一次：这次真成交（上一次什么都没写，重试是安全的）', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const gateway = fakeGateway(seed);
  // 第一次货没到，第二次货到了：同一个"库存"对象，用开关模拟"到货入库"。
  let inStock = false;
  const applySaleCalls = [];
  const inventory = {
    applySaleCalls,
    applySale: async (input) => {
      applySaleCalls.push(input);
      if (!inStock) throw new Error('库存里没有这一双');
      return { productRecordId: input.productRecordId, sampleConsumedQuantity: 0, consumedLiveRecordIds: [] };
    },
    getSaleResult: async () => null,
  };
  const client = fakeClient();
  const store = tmpStore('confirm-deal-retry-');
  const salesDelivery = new SalesDeliveryService({ gateway, inventory });
  const service = new LarkMvpService({
    client, gateway, store, references: new V1ReferenceResolver(gateway), recognizer: {}, posting: {},
    delivery: salesDelivery,
    secondDelivery: new SecondDeliveryService({ gateway, delivery: salesDelivery, store: tmpStore('cd2-'), chatId: '' }),
    purchaseBatchLocatorStore: tmpStore('cd3-'), salesGroupThreadStore: tmpStore('cd4-'),
    salesMessageLinks: { rememberFromSend: async (input) => ({ record: input }) },
  });
  await createTask(store, {
    task_id: 'sale_1', type: 'sale', status: 'posted', sender_open_id: 'ou_1',
    sales_entry_record_id: ENTRY_ID, chat_type: 'group', message_id: 'om_trigger', card_message_id: 'om_card',
    draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
    posting_result: { sourceNo: 'XSD-1', detailRecordIds: ['d_1'] },
  });

  const first = await clickConfirmDeal(service);
  assert.notEqual(first.toast.type, 'success');

  inStock = true;
  const second = await clickConfirmDeal(service);
  assert.equal(second.toast.type, 'success');
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  assert.equal(gateway.records.get('paymentRecord').find((row) => row.record_id === 'pay_pending')
    .fields['收款状态'], '已收款');
});

// ═══════════════════════════════════════════════════════════════════════════
// 四之一、🔴 bug 1「假成交」：**全款已收（没有待收款）+ 货没到**
// ═══════════════════════════════════════════════════════════════════════════
//
// 改动前：`completeDealFromCard` 的"先做货"闸门**挂在 `pending.length` 上** ⇒
// 全款已收的单整段绕过它 → 交付失败只回一句话、返回值没有 `asked`/`reason`
// → `larkMvpService` 判 `settled = !outcome.asked = true` → **假成交**：
// toast 绿字「已成交：无待处理项」、卡面 patch 成「销售订单已成交」、按钮消失、
// 任务记 `confirm_deal_settled`，而明细仍「未交付」、库存一次都没扣。
// 既有用例只覆盖"有待收款"那支（上一节 `owed: 260`）⇒ 这个分支**没有测试**。

test('🔴 bug1：全款已收 + 货没到 → **不许**说已成交、**卡不变灰**、零写库、明确提示', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付',
    owed: 0, paidReceived: 260 });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }),
    inventoryOptions: { failWith: '库存里没有 40 码这一双' },
  });
  await createTask(store, task);

  // 前提：**全款已收** —— 收款明细里没有任何「未收款」（这正是改动前漏掉的那支）。
  assert.equal(seed.paymentRecord.filter((row) => row.fields['收款状态'] === '未收款').length, 0,
    '前提：这一单没有任何待收款');
  const detailWritesBefore = gateway.writes.filter((item) => item.table === 'salesDetail').length;
  const paymentWritesBefore = gateway.writes.filter((item) => item.table === 'paymentRecord').length;

  const { value: result, logs } = await captureLogs(() => clickConfirmDeal(service));
  const config = resolveSalesConfirmDealConfig();

  // ① toast **不许**假成功、**不许**出现「已成交」；必须是那句"到货后再点"（文案走配置）。
  assert.notEqual(result.toast.type, 'success', '货没交出去就不许报成功');
  assert.ok(!String(result.toast.content).includes('已成交'),
    `toast 不许说已经成交：${result.toast.content}`);
  assert.equal(result.toast.content, config.shortStock);
  assert.match(result.toast.content, /到货入库/);
  assert.match(result.toast.content, /确认成交/);
  // 线程里也要有同一句明确提示（不是"还有 N 双未完成，请到工作台核对"那种含糊话）。
  const replyText = JSON.parse(client.replies.at(-1).data.content).text;
  assert.ok(replyText.includes(config.shortStock), `回话要说清货没到：${replyText}`);

  // ② 卡片**不变灰**：不许 patch 出「已成交」标题（她到货后还要能再点）。
  assert.ok(!isSettledCard(client), '货没到就不许把卡片写成已成交');
  assert.equal(client.patched.length, 0, '一张卡都不许 patch');

  // ③ **零写库**：明细 / 收款一条都没写，库存一次都没扣。
  assert.equal(gateway.writes.filter((item) => item.table === 'salesDetail').length,
    detailWritesBefore, '明细一个字节都不许写');
  assert.equal(gateway.writes.filter((item) => item.table === 'paymentRecord').length,
    paymentWritesBefore, '收款一个字节都不许写');
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '未交付');
  assert.equal(inventory.appliedSaleCalls.length, 0, '库存一次都不许真的扣（交付尝试失败，没扣成）');

  // ④ 状态如实：`confirm_deal_short_stock`（**不是** settled），可排查。
  assert.equal((await store.get('sale_1')).confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.SHORT_STOCK);
  // ⑤ 还落了**一条 warn**，且它自证"这次什么都没写"（`written: false`）。
  const warnings = logEvents(logs, 'sales.confirm_deal.short_stock');
  assert.equal(warnings.length, 1, '要落且只落一条 sales.confirm_deal.short_stock');
  assert.equal(warnings[0].written, false, 'warn 必须自证"这次一个字节都没写"');
  assert.equal(warnings[0].failed_count, 1);
  assert.equal(warnings[0].task_id, 'sale_1');
});

test('bug1 对照：全款已收 + **货到了** → 正常成交（交付 + 扣库存 + 已成交）', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付',
    owed: 0, paidReceived: 260 });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }),
  });
  await createTask(store, task);

  const result = await clickConfirmDeal(service);

  assert.equal(result.toast.type, 'success');
  assert.match(result.toast.content, /已成交/);
  assert.match(result.toast.content, /交付 1 双/);
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  assert.equal(inventory.applySaleCalls.length, 1, '货到了要有且只有一次扣库存');
  assert.ok(isSettledCard(client), '成交了卡片要变灰');
  assert.equal((await store.get('sale_1')).confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.SETTLED);
  // 没有未交付 ⇒ 那句"仍未交付 N 双"**一个字都不许出现**（AC-8 的卡面逐字不变）。
  assert.ok(!JSON.stringify(lastPatchedCard(client)).includes('仍未交付'));
});

test('bug1：货没到一次都没成交（连点两次都拦得住，且第二次仍零写库）', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付',
    owed: 0, paidReceived: 260 });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }),
    inventoryOptions: { failWith: '库存里没有这一双' },
  });
  await createTask(store, task);

  const first = await clickConfirmDeal(service);
  assert.notEqual(first.toast.type, 'success');
  const writesAfterFirst = gateway.writes.length;

  const second = await clickConfirmDeal(service);
  assert.notEqual(second.toast.type, 'success', '还是没货，就还是不许说成交');
  assert.equal(second.toast.content, resolveSalesConfirmDealConfig().shortStock);
  assert.equal(gateway.writes.filter((item) => item.table === 'salesDetail').length, 0);
  assert.equal(gateway.writes.filter((item) => item.table === 'paymentRecord').length, 0);
  // 两次加起来，**钱和货**一条都没写过；只允许「销售主表.库存状态」那一格被写（既有交付语义）。
  assert.deepEqual([...new Set(gateway.writes
    .filter((item) => item.table !== 'salesEntry').map((item) => item.table))], [],
  '钱和货（收款明细 / 销售明细 / 库存流水 / 实时库存）一条都不许写');
  assert.ok(gateway.writes.length >= writesAfterFirst, '写次数只可能持平或多出"库存状态"那一格');
  assert.equal(inventory.appliedSaleCalls.length, 0, '库存一次都没真的扣');
  assert.ok(!isSettledCard(client));
});

test('🔴 bug2：第一次 patch 失败后，**再点一次**能把卡面修好，且不重复写库', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付',
    owed: 0, paidReceived: 260 });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }),
    // 第一次 patch 失败（卡片被撤回 / 权限 / 网络抖动）——
    // 这正是 `settleConfirmDealCard` 注释里说的"唯一一次自愈机会"没抓住的那个场景。
    clientOptions: { failPatches: 1 },
  });
  await createTask(store, task);

  const first = await clickConfirmDeal(service);
  assert.equal(first.toast.type, 'success', '成交本身是成功的（写库成功、只是卡面没改上）');
  assert.equal(client.patched.length, 0, '前提：第一次 patch 掉了');
  assert.equal(client.patchAttempts.length, 1);
  const writesAfterFirst = gateway.writes.length;
  const taskAfterFirst = await store.get('sale_1');
  assert.equal(taskAfterFirst.confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.SETTLED);

  // 再点一次：走早退分支（任务已 settled）——**早退之前**必须补一次 patch。
  const second = await clickConfirmDeal(service);

  assert.equal(second.toast.type, 'info');
  assert.match(second.toast.content, /已经成交|无需重复/);
  // ① 卡面自愈：这一次真的 patch 成「已成交」，打在**被点的那张卡**上。
  assert.equal(client.patched.length, 1, '早退分支也要补一次卡面 patch');
  assert.equal(client.patched.at(-1).path.message_id, 'om_card');
  const card = JSON.parse(client.patched.at(-1).data.content);
  assert.equal(card.header.title.content, resolveSalesConfirmDealConfig().settledTitle);
  assert.deepEqual(cardButtons(card), [], '修好之后按钮要消失');
  // ② 幂等保住：**业务表一个字节都不写**、库存不重复扣、本地任务记录也不再改。
  assert.equal(gateway.writes.length, writesAfterFirst, '第二次一个字节都不许写');
  assert.equal(inventory.applySaleCalls.length, 1, '不许重复扣库存');
  assert.deepEqual(await store.get('sale_1'), taskAfterFirst,
    '本地任务记录不许再改（confirm_deal_at 保持首次点击的值）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 四之三、成交后变绿那句说明：**别再丢掉「仍未交付 N 双」**
// ═══════════════════════════════════════════════════════════════════════════
//
// 交付**只成了一半**（A 双交出去、B 双没货）时这一单仍算成交（钱货各自记账，
// 见上一份文档第 11 节第 3 条"部分交付"的既有语义）。但绿色卡片的说明里
// **一个字都没提那几双** —— 她只看到"已成交"，那几双就这么从卡面上消失了。
// 现在：说明 = `SETTLED_MESSAGE` ＋ `SETTLED_UNDELIVERED`（`{count}` = 没交付的条数，走配置）。

test('成交后变绿那句说明里含「仍未交付 N 双」（部分交付时；全交付时一个字都不多加）', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付',
    owed: 0, paidReceived: 260 });
  // 两条明细：第一条交得出去，第二条没货（"部分交付"）。
  seed.salesDetail.push({ record_id: 'd_2', fields: {
    销售单号: [ENTRY_ID], 编号: ['product_1'], 尺码: ['size_40'],
    履约状态: '未交付', 实收金额: 260,
  } });
  let saleCalls = 0;
  const inventory = {
    applySaleCalls: [],
    applySale: async (input) => {
      inventory.applySaleCalls.push(input);
      saleCalls += 1;
      if (saleCalls === 2) throw new Error('库存里没有这一双');
      return { productRecordId: input.productRecordId, sampleConsumedQuantity: 0, consumedLiveRecordIds: [] };
    },
    getSaleResult: async () => null,
  };
  const { service, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', paidTotal: 260 }), inventory,
  });
  await createTask(store, task);

  const result = await clickConfirmDeal(service);

  assert.equal(result.toast.type, 'success');
  assert.ok(isSettledCard(client), '部分交付仍算成交（既有的部分交付语义）');
  const note = cardNote(lastPatchedCard(client));
  assert.equal(note, '销售单号：XSD-1；已成交。仍未交付 1 双，请到工作台核对。',
    `绿色卡的说明里必须带上"仍未交付 N 双"：${note}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 四之二、多个收款方式（线上多半是这样）：**不猜方式** —— 货做掉、钱回问一句
// ═══════════════════════════════════════════════════════════════════════════
//
// 卡上只有一个按钮（她明确"选项只能点是"），所以按钮**带不了收款方式**；
// 按 `AGENTS.md` 第 16 条(1)「用户会主动说收款方式」，这里**不替她挑**：
// 货先做掉（不写半成品账），钱回问一句 —— 与她说「已完毕」时逐字同一条路。

test('多个收款方式时不猜方式：货做掉了、钱回问一句、不写收款、卡片不变灰', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  // 库里两个收款方式 → "只有一个"那条不成立，也没有任何默认方式。
  seed.paymentMethod.push({ record_id: 'method_cash', fields: { 收款方式: '现金' } });
  const { service, gateway, inventory, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, task);

  const result = await clickConfirmDeal(service);

  // ① 货那一半做了（未交付 → 已交付 + 扣库存）：她 2026-10-06 明确"不能既不做又报成功"。
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  assert.equal(inventory.applySaleCalls.length, 1);
  // ② 钱那一半一个字节都没写，并且回话**如实说货已经记上了**。
  const receipt = gateway.records.get('paymentRecord').find((row) => row.record_id === 'pay_pending');
  assert.equal(receipt.fields['收款状态'], '未收款');
  const replyText = JSON.parse(client.replies.at(-1).data.content).text;
  assert.match(replyText, /已交付/, '要如实说货已经做掉了，不能让她以为啥也没干');
  assert.match(replyText, /这笔钱是怎么收的/);
  // ③ 没成交 ⇒ **卡片不变灰**（她还能再点 / 在话题里补一句收款方式）。
  assert.equal(result.toast.type, 'info');
  assert.ok(!client.patched.some((item) => JSON.parse(item.data.content)
    .header?.title?.content === resolveSalesConfirmDealConfig().settledTitle));
  assert.equal((await store.get('sale_1')).confirm_deal_status, CONFIRM_DEAL_TASK_STATUS.ASKING);
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、卡片更新：**同一张卡**变「已成交」（AC-8）
// ═══════════════════════════════════════════════════════════════════════════

test('点成功后：**被点的那张卡**被 patch 成「已成交」，不新发消息；payload 带 update_multi', async () => {
  const seed = baseSeed({ tradeTypeCode: 'SALE_PREPAID', fulfillmentStatus: '未交付', owed: 260 });
  const { service, client, store, task } = makeHarness({
    seed, draft: draftFor({ tradeTypeCode: 'SALE_PREPAID', owed: 260 }),
  });
  await createTask(store, task);
  const sentBefore = client.replies.filter((item) => item.data.msg_type === 'interactive').length;

  await clickConfirmDeal(service, { messageId: 'om_card' });

  const config = resolveSalesConfirmDealConfig();
  const patch = client.patched.at(-1);
  assert.equal(patch.path.message_id, 'om_card', 'patch 打的必须是**被点的那张卡**');
  const card = JSON.parse(patch.data.content);
  assert.equal(card.header.title.content, config.settledTitle);
  assert.deepEqual(card.config, { wide_screen_mode: true, update_multi: true });
  assert.deepEqual(cardButtons(card), [], '已成交流程走完 → 按钮必须消失（飞书按钮没有 disabled）');
  assert.ok(JSON.stringify(card).includes('已成交'));
  assert.equal(client.replies.filter((item) => item.data.msg_type === 'interactive').length, sentBefore,
    '甲：不新发卡片消息');
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、回调 3 秒内先响应（AC-9）
// ═══════════════════════════════════════════════════════════════════════════

test('卡片回调：handler **同步**返回 toast，重活在 setImmediate 里跑（3 秒硬限制）', async () => {
  let finished = false;
  const service = {
    handleCardAction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
      return { toast: { type: 'success', content: '好' } };
    },
  };
  const handlers = createLarkEventHandlers(service);
  const returned = handlers['card.action.trigger']({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: SALES_CONFIRM_DEAL_ACTIONS.CONFIRM, sales_entry_record_id: ENTRY_ID } },
  });

  // 同步返回 = 飞书那 3 秒内一定拿到响应；此刻重活**还没跑完**。
  assert.deepEqual(returned, { toast: { type: 'info', content: '已收到，正在处理' } });
  assert.equal(finished, false, '重活不能在同步路径里跑完（那就把它拖成同步重活了）');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(finished, true, '重活确实在后台跑');
});

// ═══════════════════════════════════════════════════════════════════════════
// 七、只改这张终态卡（AC-10）+ 配置先行（AC-4）
// ═══════════════════════════════════════════════════════════════════════════

test('只改这张终态卡：确认卡 / 处理中卡 / 第二次交付卡上都没有这个按钮', () => {
  const items = [{ item_no: 'P1', size: 40, quantity: 1, actual_amount: 260 }];
  const action = SALES_CONFIRM_DEAL_ACTIONS.CONFIRM;
  const hasDealButton = (card) => cardButtons(card).some((button) => button.value?.action === action);

  assert.equal(hasDealButton(larkCards.salesConfirmationCard('d', { items, payments: [], agreed_total: 260 })), false);
  assert.equal(hasDealButton(larkCards.salesProcessingCard({ items }, {
    title: 't', template: 'blue', itemColor: 'grey', progressLine: 'p', note: 'n',
  })), false);
  assert.equal(hasDealButton(larkCards.secondDeliveryCard({
    orders: [{ orderNo: 'XSD-1', salesEntryRecordId: ENTRY_ID, tradeTypeLabel: '预定',
      quantity: 1, pendingAmount: 260, pendingDeliveryQuantity: 1 }],
    methods: ['微信'], dayKey: '2026-10-07',
  })), false);
  // 终态卡**不带**这个开关时也一个按钮都没有（默认关 ⇒ 其余分支逐字不变）。
  assert.equal(hasDealButton(larkCards.salesStatusCard({ items }, '销售订单已入账', '销售单号：XSD-1。', 'green')), false);
});

test('配置先行：按钮 / 提示 / 已成交 / 货没到 四段文案都能用环境变量换（逻辑里不写死中文）', () => {
  const config = resolveSalesConfirmDealConfig({
    SALES_CONFIRM_DEAL_BUTTON_LABEL: '确认啦',
    SALES_CONFIRM_DEAL_HINT: '点了才继续',
    SALES_CONFIRM_DEAL_SETTLED_TITLE: '这单成交了',
    SALES_CONFIRM_DEAL_SHORT_STOCK: '这批还没到，先去入库再回来点',
  });
  assert.equal(config.buttonLabel, '确认啦');
  assert.equal(config.hint, '点了才继续');
  assert.equal(config.settledTitle, '这单成交了');
  assert.equal(config.shortStock, '这批还没到，先去入库再回来点');

  // 按钮文案真的从配置渲染出来（渲染器不写死中文）：显式传一份配置。
  const card = larkCards.salesStatusCard({ items: [] }, 't', 'm', 'green',
    { confirmDeal: { salesEntryRecordId: ENTRY_ID, draftId: 'd', config } });
  assert.ok(JSON.stringify(card).includes('确认啦'));

  // 生产路径：**只**读环境变量（渲染器自己解析），换一个值就换一个词。
  const keys = ['SALES_CONFIRM_DEAL_BUTTON_LABEL', 'SALES_CONFIRM_DEAL_HINT'];
  const backup = keys.map((key) => [key, process.env[key]]);
  try {
    process.env.SALES_CONFIRM_DEAL_BUTTON_LABEL = '点我成交';
    process.env.SALES_CONFIRM_DEAL_HINT = '一段提示';
    const fromEnv = larkCards.salesStatusCard({ items: [] }, 't', 'm', 'green',
      { confirmDeal: { salesEntryRecordId: ENTRY_ID, draftId: 'd' } });
    assert.ok(JSON.stringify(fromEnv).includes('点我成交'));
    assert.ok(JSON.stringify(fromEnv).includes('一段提示'));
  } finally {
    for (const [key, value] of backup) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

  // 默认值就是她要的那一个词。
  assert.equal(resolveSalesConfirmDealConfig({}).buttonLabel, '确认成交');
});

test('配置先行（第二道）：`.env.example` 里那一段与配置默认值逐字一致（新加文案忘写文档 → 红）', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const documented = new Map();
  for (const line of envExample.split('\n')) {
    const match = line.match(/^(SALES_CONFIRM_DEAL_[A-Z0-9_]+)=(.*)$/);
    if (match) documented.set(match[1], match[2]);
  }
  assert.deepEqual([...documented.keys()].sort(),
    Object.keys(SALES_CONFIRM_DEAL_DEFAULTS_BY_KEY).sort(),
    '`.env.example` 的键集合与配置的键集合必须一致');
  for (const [key, fallback] of Object.entries(SALES_CONFIRM_DEAL_DEFAULTS_BY_KEY)) {
    assert.equal(documented.get(key), fallback, `${key} 的默认值与 .env.example 里写的不一致`);
  }
});
