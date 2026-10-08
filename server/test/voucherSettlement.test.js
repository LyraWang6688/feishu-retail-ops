// 【团购券待结算】块 + 「确认到账」按钮 —— 业务负责人 2026-10-08 批准并逐字给口径
//（见 docs/push-blocks-caliber-2026-10-08.md 第六节 / 第十节）。
//
// 这个文件盯的是**五件事**（先写"应该长什么样"，再实现 —— 她定的流程）：
//   ① 结算日分组：`创建时间(上海日) + 5 个自然日`，只显示 `结算日 ≤ 今天`；
//      今天 / 昨天 / 更早各一行，**结算日倒序**；结算日 < 今天 的那行附「（逾期 N 天）」；
//   ② 金额：逐笔取「券的平台结算款」（交易方式名字里的价 → 券表售价 → 平台结算款）；
//      **解析不到就退回该笔「收款金额」+ warn**（不静默、不编数）；
//   ③ 「确认到账」：把那**一个结算日**的全部「待平台结算」→ 已收款 + 写「收款时间 = 点击那一刻」；
//   ④ **幂等**：连点两次只写一次（第二次回「这一批已经确认过了」）；
//   ⑤ 按钮 value **只带结算日**（名单由服务端按结算日重新查）；空批次不出现该区块。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { resolveVoucherSettlementConfig } = require('../src/config/voucherSettlement');
const { VoucherSettlementService, addDays, dayDiff } = require('../src/services/voucherSettlementService');
const { PaymentService } = require('../src/services/paymentService');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { visibleCardText } = require('../src/utils/pendingDealPushCard');
const { fakeCandidates } = require('./helpers/pendingPushTestData');

const CHAT_ID = 'oc_test_voucher_settle';
// 上海时间：**今天 = 2026-10-08**（UTC 02:00 = 北京 10:00）。
const NOW = new Date('2026-10-08T02:00:00.000Z');
const TODAY = '2026-10-08';

const paymentFields = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
const voucherFields = V1_BITABLE_SCHEMA.tables.groupBuyVoucher.fields;

// ── 真表形状的替身（**只认语义键**，与 gateway.fields 同一套映射）────────────────
const fakeGateway = ({ payments = [], vouchers = [], fieldOverrides = {}, touchFailures = [] } = {}) => {
  const rows = new Map(payments.map((record) => [record.record_id, record]));
  const updates = [];
  const gateway = {
    table: (key) => {
      const table = { ...V1_BITABLE_SCHEMA.tables[key] };
      if (key === 'paymentRecord') table.fields = { ...table.fields, ...fieldOverrides.payment };
      if (key === 'groupBuyVoucher') table.fields = { ...table.fields, ...fieldOverrides.voucher };
      return table;
    },
    listAll: async (key) => {
      if (key === 'paymentRecord') return [...rows.values()];
      if (key === 'groupBuyVoucher') return vouchers;
      return [];
    },
    get: async (key, id) => (key === 'paymentRecord' ? rows.get(id) || null : null),
    update: async (key, id, semanticValues) => {
      // 与真网关同一件事：**语义键 → 真表字段名**（这样断言的字段名就是真表上的列名）。
      const fields = {};
      for (const [semanticKey, value] of Object.entries(semanticValues || {})) {
        if (value === undefined) continue;
        const name = gateway.table(key).fields[semanticKey];
        if (!name) throw new Error(`“${V1_BITABLE_SCHEMA.tables[key].tableName}”未配置语义字段: ${semanticKey}`);
        fields[name] = value;
      }
      updates.push({ tableKey: key, recordId: id, fields });
      if (touchFailures.includes(id)) throw new Error(`写库失败（替身）：${id}`);
      const current = rows.get(id);
      if (current) rows.set(id, { ...current, fields: { ...current.fields, ...fields } });
      return { record_id: id };
    },
    create: async () => { throw new Error('本链路不新建记录'); },
  };
  return { gateway, updates, rows };
};

const paymentRecord = (recordId, { id, method = '抖音代金券（89.9）', amount = 85.4,
  status = '待平台结算', createdAt = '2026-09-27', extraFields = {} } = {}) => ({
  record_id: recordId,
  fields: {
    [paymentFields.salesEntry]: id === undefined ? [] : [{ record_ids: [id], text: `XSD-${recordId}` }],
    [paymentFields.method]: [{ record_ids: [`pm_${recordId}`], text: method }],
    [paymentFields.amount]: amount,
    [paymentFields.status]: status,
    [paymentFields.createdAt]: Date.parse(`${createdAt}T00:00:00+08:00`),
    ...extraFields,
  },
});

const voucherRecord = (recordId, { purchasePrice = 89.9, faceValue = 100, settlementAmount = 85.4,
  status = '在售', name = '抖音代金券' } = {}) => ({
  record_id: recordId,
  fields: {
    [voucherFields.name]: name,
    [voucherFields.purchasePrice]: purchasePrice,
    [voucherFields.faceValue]: faceValue,
    [voucherFields.settlementAmount]: settlementAmount,
    [voucherFields.status]: status,
  },
});

const newSettlementService = ({ payments, vouchers, fieldOverrides, now = NOW, touchFailures,
  settings = {} } = {}) => {
  const fake = fakeGateway({ payments, vouchers, fieldOverrides, touchFailures });
  const resolved = { ...resolveVoucherSettlementConfig({}), ...settings };
  const service = new VoucherSettlementService({
    gateway: fake.gateway,
    settings: resolved,
    now: () => now,
  });
  return { service, ...fake, settings: resolved };
};

// ── ① 结算日分组 ────────────────────────────────────────────────────────────
test('结算日 = 创建时间(上海日) + 5 个自然日；只显示 ≤ 今天；一行一个结算日、倒序、逾期加后缀', async () => {
  const { service } = newSettlementService({
    payments: [
      // 核销 09-27 ⇒ 结算 10-02（逾期 6 天）
      paymentRecord('pay_overdue', { id: 'sale_overdue', createdAt: '2026-09-27' }),
      // 核销 10-01 ⇒ 结算 10-06（逾期 2 天）；与上一笔同一个结算日的**另一笔**
      paymentRecord('pay_overdue_2', { id: 'sale_overdue_2', createdAt: '2026-10-01' }),
      // 核销 10-02 ⇒ 结算 10-07（昨天，逾期 1 天）
      paymentRecord('pay_yesterday', { id: 'sale_yesterday', createdAt: '2026-10-02' }),
      // 核销 10-03 ⇒ 结算 10-08（**今天**，逾期 0 天）
      paymentRecord('pay_today', { id: 'sale_today', createdAt: '2026-10-03' }),
      // 核销 10-04 ⇒ 结算 10-09（**明天**）⇒ 不显示
      paymentRecord('pay_tomorrow', { id: 'sale_tomorrow', createdAt: '2026-10-04' }),
    ],
    vouchers: [voucherRecord('vch_899')],
  });
  const { rows, pendingRowCount } = await service.listSettlements({ now: NOW });
  // ⚠️ 5 笔待结算、只显示 4 笔（明天那一笔不进这一屏）。
  assert.equal(pendingRowCount, 5);
  assert.deepEqual(rows.map((row) => row.settleDay), ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-02']);
  assert.deepEqual(rows.map((row) => row.isToday), [true, false, false, false]);
  assert.deepEqual(rows.map((row) => row.overdueDays), [0, 1, 2, 6]);
  assert.deepEqual(rows.map((row) => row.count), [1, 1, 1, 1]);
  // 同一结算日的两笔合成一行（10-02 那行那一笔；10-06 那行是 10-01 核销的那笔）
  assert.equal(rows.find((row) => row.settleDay === '2026-10-06').count, 1);
});

test('同一结算日的多笔合成一行：金额是那几笔的合计（不是每笔一行）', async () => {
  const { service } = newSettlementService({
    payments: [
      paymentRecord('pay_a', { id: 'sale_a', createdAt: '2026-10-01' }), // 结算 10-06
      paymentRecord('pay_b', { id: 'sale_b', createdAt: '2026-10-01' }), // 结算 10-06
      paymentRecord('pay_c', { id: 'sale_c', createdAt: '2026-10-01', method: '抖音代金券（49.9）' }),
    ],
    vouchers: [
      voucherRecord('vch_899', { purchasePrice: 89.9, settlementAmount: 85.4 }),
      voucherRecord('vch_499', { purchasePrice: 49.9, settlementAmount: 47.4 }),
    ],
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settleDay, '2026-10-06');
  assert.equal(rows[0].count, 3);
  // 85.4 + 85.4 + 47.4 = 218.2（**券的平台结算款**，不是收款金额 / 售价 / 面值）
  assert.equal(rows[0].totalAmount, 218.2);
});

test('结算日的日期算术：1001 → 1006（跨月 / 跨年也算得对）', () => {
  assert.equal(addDays('2026-10-01', 5), '2026-10-06');
  assert.equal(addDays('2026-10-28', 5), '2026-11-02');
  assert.equal(addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(dayDiff('2026-10-02', '2026-10-08'), 6);
});

test('创建时间读不出来 ⇒ 按**今天**当结算日照进候选（绝不静默丢一笔）', async () => {
  const { service } = newSettlementService({
    payments: [paymentRecord('pay_no_time', { id: 'sale_no_time', createdAt: '2026-09-27',
      extraFields: { [paymentFields.createdAt]: '' } })],
    vouchers: [voucherRecord('vch_899')],
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settleDay, TODAY);
  assert.equal(rows[0].overdueDays, 0);
});

// ── ② 金额：券的平台结算款 + 解析不到退回收款金额 ─────────────────────────────
test('金额取券的「平台结算款」：交易方式名字里的价 → 券表售价 → 平台结算款', async () => {
  const { service } = newSettlementService({
    payments: [paymentRecord('pay_1', { id: 'sale_1', method: '抖音代金券（89.9）',
      // ⚠️ 收款金额是 85.4（她当天已改对）；这里故意写成 99 看金额到底取哪一边
      amount: 99, createdAt: '2026-10-03' })],
    vouchers: [voucherRecord('vch_899', { purchasePrice: 89.9, settlementAmount: 85.4 })],
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows[0].totalAmount, 85.4);
  assert.deepEqual(rows[0].records, ['pay_1']);
});

test('解析不到券（名字里没有价）⇒ **退回该笔「收款金额」**，并且不静默（warn 带 record_id）', async () => {
  const { service } = newSettlementService({
    payments: [paymentRecord('pay_no_price', { id: 'sale_no_price', method: '抖音团购券',
      amount: 85.4, createdAt: '2026-10-03' })],
    vouchers: [voucherRecord('vch_899')],
  });
  // ⚠️ service 是**模块级** `const { logWarn } = require('../utils/logger')` ⇒ 给模块对象换一个
  //    属性是抓不到的；`mock.method` 会把"这个函数的当前值"换掉，destructure 拿到的只是引用，
  //    所以这里改用**捕获 `console.warn`**（`utils/logger` 的 warn 就是走它）。
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => { warnings.push(JSON.parse(String(line))); };
  let rows;
  try {
    ({ rows } = await service.listSettlements({ now: NOW }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(rows[0].totalAmount, 85.4); // ← 退回收款金额
  const fallback = warnings.find((entry) => entry.event === 'voucher_settlement.amount.fallback');
  assert.ok(fallback, '解析不到券必须记一条 warn（不静默）');
  assert.deepEqual(fallback.payment_record_ids, ['pay_no_price']);
  assert.deepEqual(fallback.reasons, ['no_price_in_method']);
});

test('名字里有价、但券表里没有这一档 ⇒ 同样退回收款金额（不拿别的券顶替）', async () => {
  const { service } = newSettlementService({
    payments: [paymentRecord('pay_other', { id: 'sale_other', method: '抖音代金券（199）',
      amount: 188, createdAt: '2026-10-03' })],
    vouchers: [voucherRecord('vch_899')],
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows[0].totalAmount, 188);
});

test('券表整表读挂了 ⇒ 全部退回收款金额，**一笔都不丢**', async () => {
  const fake = fakeGateway({
    payments: [paymentRecord('pay_1', { id: 'sale_1', amount: 85.4, createdAt: '2026-10-03' })],
    vouchers: [voucherRecord('vch_899')],
  });
  const failing = { ...fake.gateway, listAll: async (key) => {
    if (key === 'groupBuyVoucher') throw new Error('券表读挂了');
    return fake.gateway.listAll(key);
  } };
  const service = new VoucherSettlementService({
    gateway: failing, settings: resolveVoucherSettlementConfig({}), now: () => NOW,
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalAmount, 85.4);
});

test('金额读不出来 ⇒ 那一行照出、金额给占位（amountKnown=false），绝不静默丢一行', async () => {
  const { service } = newSettlementService({
    payments: [paymentRecord('pay_bad', { id: 'sale_bad', amount: '',
      extraFields: { [paymentFields.amount]: '' }, createdAt: '2026-10-03' })],
    vouchers: [],
  });
  const { rows } = await service.listSettlements({ now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountKnown, false);
  assert.equal(rows[0].totalAmount, 0);
});

// ── ③④ 确认到账：整批改已收款 + 写收款时间 + 幂等 ──────────────────────────────
test('点「确认到账」：那**一个结算日**的全部待结算 → 已收款 + 写收款时间 = 点击那一刻', async () => {
  const { service, updates } = newSettlementService({
    payments: [
      paymentRecord('pay_1', { id: 'sale_1', createdAt: '2026-09-27' }), // 结算 10-02
      paymentRecord('pay_2', { id: 'sale_2', createdAt: '2026-10-01' }), // 结算 10-06
      paymentRecord('pay_3', { id: 'sale_3', createdAt: '2026-10-02' }), // 结算 10-07
    ],
    vouchers: [voucherRecord('vch_899')],
  });
  const clickedAt = new Date('2026-10-08T03:15:00.000Z');
  const result = await service.confirmSettlementDay('2026-10-06', { now: clickedAt });
  // ⚠️ 只动**那一个结算日**（不是"所有待结算"）。
  assert.equal(result.confirmedCount, 1);
  assert.equal(result.alreadySettled, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].recordId, 'pay_2');
  assert.deepEqual(updates[0].fields, {
    [paymentFields.status]: '已收款',
    // 「收款时间 = 点击那一刻」——全仓**唯一**允许代码写的时间字段。
    [paymentFields.receivedAt]: clickedAt.getTime(),
    [paymentFields.tradeDirection]: '收入',
  });
});

test('同一个结算日的多笔一次全改（整批，不是逐条挑）', async () => {
  const { service, updates } = newSettlementService({
    payments: [
      paymentRecord('pay_1', { id: 'sale_1', createdAt: '2026-10-01' }),
      paymentRecord('pay_2', { id: 'sale_2', createdAt: '2026-10-01' }),
      paymentRecord('pay_3', { id: 'sale_3', createdAt: '2026-10-03' }),
    ],
    vouchers: [voucherRecord('vch_899')],
  });
  const result = await service.confirmSettlementDay('2026-10-06', { now: NOW });
  assert.equal(result.confirmedCount, 2);
  assert.deepEqual([...updates].map((entry) => entry.recordId).sort(), ['pay_1', 'pay_2']);
});

test('幂等：连点两次只写一次；第二次回「这一批已经确认过了」', async () => {
  const { service, updates } = newSettlementService({
    payments: [paymentRecord('pay_1', { id: 'sale_1', createdAt: '2026-10-01' })],
    vouchers: [voucherRecord('vch_899')],
  });
  const first = await service.confirmSettlementDay('2026-10-06', { now: NOW });
  const second = await service.confirmSettlementDay('2026-10-06', { now: new Date(NOW.getTime() + 1000) });
  assert.equal(first.confirmedCount, 1);
  assert.equal(updates.length, 1, '第二次点击**一个字节都不许写**');
  assert.equal(second.confirmedCount, 0);
  assert.equal(second.alreadySettled, true);
  assert.equal(second.notFoundDay, true);
  const toast = service.confirmationToast(second);
  assert.equal(toast.type, 'info');
  assert.match(toast.content, /已经确认过了/);
});

test('空批次：那一个结算日没有待结算 ⇒ 不写、也不抛（回"已经确认过了"）', async () => {
  const { service, updates } = newSettlementService({
    payments: [paymentRecord('pay_1', { id: 'sale_1', createdAt: '2026-10-01' })],
    vouchers: [voucherRecord('vch_899')],
  });
  const result = await service.confirmSettlementDay('2026-09-01', { now: NOW });
  assert.equal(result.confirmedCount, 0);
  assert.equal(result.alreadySettled, true);
  assert.equal(updates.length, 0);
});

test('成功那句人话：已确认 N 笔、共 ¥X（金额来自真正写成功的那些笔）', async () => {
  const { service } = newSettlementService({
    payments: [
      paymentRecord('pay_1', { id: 'sale_1', amount: 85.4, createdAt: '2026-10-01' }),
      paymentRecord('pay_2', { id: 'sale_2', amount: 85.4, createdAt: '2026-10-01' }),
    ],
    vouchers: [voucherRecord('vch_899')],
  });
  const result = await service.confirmSettlementDay('2026-10-06', { now: NOW });
  const toast = service.confirmationToast(result);
  assert.equal(toast.type, 'success');
  assert.equal(toast.content, '已确认 2 笔、共 ¥170.80（结算日 2026-10-06）');
});

test('部分失败 ⇒ 如实说写了几笔、哪几笔失败（不报成功、不静默）', async () => {
  const { service } = newSettlementService({
    payments: [
      paymentRecord('pay_1', { id: 'sale_1', createdAt: '2026-10-01' }),
      paymentRecord('pay_2', { id: 'sale_2', createdAt: '2026-10-01' }),
    ],
    vouchers: [voucherRecord('vch_899')],
    touchFailures: ['pay_2'],
  });
  const result = await service.confirmSettlementDay('2026-10-06', { now: NOW });
  assert.equal(result.confirmedCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].payment_record_id, 'pay_2');
  assert.equal(service.confirmationToast(result).type, 'warning');
});

test('缺结算日 ⇒ 明确报错（不猜是哪一天）', async () => {
  const { service } = newSettlementService({ payments: [], vouchers: [] });
  await assert.rejects(() => service.confirmSettlementDay('', { now: NOW }), /缺少结算日/);
});

// ── ⑤ 推送接线：区块出现位置 / 空批次 / 按钮 value ─────────────────────────────
const pushSettings = (overrides = {}) => ({
  ...resolvePendingDealPushConfig({}),
  enabled: true,
  chatId: CHAT_ID,
  linkLookupEnabled: false,
  linkRequired: false,
  ...overrides,
});

const fakePushClient = () => {
  const creates = [];
  const patches = [];
  return {
    creates,
    patches,
    client: {
      im: {
        message: {
          create: async (payload) => {
            creates.push(payload);
            return { code: 0, data: { message_id: 'om_push_voucher' } };
          },
          patch: async (payload) => {
            patches.push(payload);
            return { code: 0 };
          },
          reply: async () => { throw new Error('这条推送必须发到主聊天，不许 reply'); },
        },
      },
    },
  };
};

const newPushService = ({ settlements = [], orders = [], overrides = {}, settlementsStub } = {}) => {
  const { client, creates, patches } = fakePushClient();
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-push-')), idField: 'task_id',
  });
  const service = new PendingDealPushService({
    settings: pushSettings(overrides),
    candidates: fakeCandidates({ orders }),
    settlements: settlementsStub || { listSettlements: async () => ({ rows: settlements, pendingRowCount: settlements.length }) },
    client,
    chatId: CHAT_ID,
    store,
    now: () => NOW,
    scheduleRetry: () => ({}),
  });
  return { service, creates, patches, store };
};

const settlementRow = (settleDay, { totalAmount = 85.4, overdueDays = 0, count = 1, amountKnown = true } = {}) => ({
  settleDay, totalAmount, overdueDays, count, amountKnown, isToday: overdueDays === 0, records: [`pay_${settleDay}`],
});

test('只有券那一块有候选时**照样发**（空批次不出现该区块；有候选就出现）', async () => {
  // 三个区都空 ⇒ 不发
  const empty = newPushService({ settlements: [] });
  const emptyResult = await empty.service.sendDailyPush({ now: NOW });
  assert.equal(emptyResult.reason, 'no_pending_order');
  assert.equal(empty.creates.length, 0);

  // 只有券块 ⇒ 发，且消息里只有券那一块
  const only = newPushService({ settlements: [settlementRow('2026-10-02', { overdueDays: 6 })] });
  const result = await only.service.sendDailyPush({ now: NOW });
  assert.equal(only.creates.length, 1);
  assert.equal(result.settlementCount, 1);
  assert.deepEqual(result.settlements, ['2026-10-02']);
  const card = JSON.parse(only.creates[0].data.content);
  const text = visibleCardText(card);
  assert.match(text, /【团购券待结算】1 笔/);
  assert.match(text, /2026-10-02 应结算 ¥85\.40（逾期 6 天）/);
  assert.match(text, /确认到账/);
  // 销售那块（表头那行"待处理的销售单"）**不该出现**（一笔销售都没有）
  assert.doesNotMatch(text, /待处理的销售单/);
});

test('区块顺序：销售两块 → 团购券待结算 → 采购（默认顺序，配置可改）', async () => {
  const { service, creates } = newPushService({
    orders: [{ salesEntryRecordId: 'sale_a', orderNo: 'XSD-1', pendingAmount: 128,
      fulfillmentStatus: '未交付', items: [{ itemNo: 'B26002-52', size: '37' }] }],
    settlements: [settlementRow('2026-10-08', { overdueDays: 0 })],
  });
  await service.sendDailyPush({ now: NOW });
  const text = visibleCardText(JSON.parse(creates[0].data.content));
  const salesIndex = text.indexOf('【预定】');
  const voucherIndex = text.indexOf('【团购券待结算】');
  assert.ok(salesIndex >= 0 && voucherIndex >= 0);
  assert.ok(salesIndex < voucherIndex, '券那块必须排在销售两块之后');
});

test('按钮 value **只带结算日**（action + settle_day），名单由服务端按结算日重新查', async () => {
  const { service, creates } = newPushService({
    settlements: [settlementRow('2026-10-02', { overdueDays: 6 })],
  });
  await service.sendDailyPush({ now: NOW });
  const card = JSON.parse(creates[0].data.content);
  const columnSet = card.elements.find((element) => element.tag === 'column_set');
  const buttonColumn = columnSet.columns.find((column) =>
    (column.elements || []).some((child) => child.tag === 'button'));
  const button = buttonColumn.elements.find((child) => child.tag === 'button');
  assert.equal(button.text.content, '确认到账');
  assert.deepEqual(button.behaviors, [{
    type: 'callback',
    value: { action: 'confirm_voucher_settlement', settle_day: '2026-10-02' },
  }]);
  // ⚠️ **不带名单**：value 里除了 action / settle_day 不许再有别的键
  assert.deepEqual(Object.keys(button.behaviors[0].value).sort(), ['action', 'settle_day']);
});

test('纯文本降级形态里也有这一块（左栏文字 · 右栏按钮文案）', async () => {
  const { service, creates } = newPushService({
    settlements: [settlementRow('2026-10-02', { overdueDays: 6 })],
    overrides: { messageFormat: 'text' },
  });
  await service.sendDailyPush({ now: NOW });
  const payload = JSON.parse(creates[0].data.content);
  assert.match(payload.text, /【团购券待结算】1 笔/);
  assert.match(payload.text, /2026-10-02 应结算 ¥85\.40（逾期 6 天） · 确认到账/);
});

test('券那块读表失败**不拖垮**销售 / 采购那两块（记 warn、当成没有这一块）', async () => {
  const { service, creates } = newPushService({
    orders: [{ salesEntryRecordId: 'sale_a', orderNo: 'XSD-1', pendingAmount: 128,
      fulfillmentStatus: '未交付', items: [{ itemNo: 'B26002-52', size: '37' }] }],
    settlementsStub: { listSettlements: async () => { throw new Error('收款明细读挂了'); } },
  });
  const result = await service.sendDailyPush({ now: NOW });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(creates.length, 1);
  const text = visibleCardText(JSON.parse(creates[0].data.content));
  assert.match(text, /【预定】/);
  assert.doesNotMatch(text, /【团购券待结算】/);
});

test('配置关掉那一块 ⇒ 一次远端调用都不发（显式开关，配置先行）', async () => {
  let called = 0;
  const { service, creates } = newPushService({
    orders: [{ salesEntryRecordId: 'sale_a', orderNo: 'XSD-1', pendingAmount: 128,
      fulfillmentStatus: '未交付', items: [{ itemNo: 'B26002-52', size: '37' }] }],
    overrides: { voucher: { ...resolveVoucherSettlementConfig({}), enabled: false } },
    settlementsStub: { listSettlements: async () => { called += 1; return { rows: [] }; } },
  });
  await service.sendDailyPush({ now: NOW });
  assert.equal(called, 0);
  assert.equal(creates.length, 1);
});

test('确认之后**卡面**要变：那一行消失；全确认完则换一句「已确认到账」', async () => {
  // 这一条只盯**卡面补丁**本身（业务幂等由上面那些用例钉着）：用回调带回的
  // `open_message_id` patch **她点的那张卡**。
  const patches = [];
  const client = { im: { message: { patch: async (payload) => { patches.push(payload); return { code: 0 }; } } } };
  const settings = pushSettings();
  const remaining = [settlementRow('2026-10-07', { overdueDays: 1 })];
  const service = new PendingDealPushService({
    settings,
    client,
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-patch-')), idField: 'task_id',
    }),
    settlements: { listSettlements: async () => ({ rows: remaining, pendingRowCount: 1 }) },
    now: () => NOW,
  });
  const event = { context: { open_message_id: 'om_clicked' } };
  const ok = await service.patchSettlementCard({ event, context: { interactionId: 'it_9' } });
  assert.equal(ok, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path.message_id, 'om_clicked');
  const card = JSON.parse(patches[0].data.content);
  assert.match(visibleCardText(card), /2026-10-07 应结算 ¥85\.40（逾期 1 天）/);
  // 刚确认掉的那一行（10-02）**不在了**
  assert.doesNotMatch(visibleCardText(card), /2026-10-02/);

  // 全确认完：换一句「已确认到账」，不留一个点不动的空壳
  const done = new PendingDealPushService({
    settings,
    client,
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-patch-done-')), idField: 'task_id',
    }),
    settlements: { listSettlements: async () => ({ rows: [], pendingRowCount: 0 }) },
    now: () => NOW,
  });
  assert.equal(await done.patchSettlementCard({ event }), true);
  const doneCard = JSON.parse(patches[1].data.content);
  assert.equal(visibleCardText(doneCard), '（已确认到账）');
});

test('没有回调消息 id 时**不去猜**那张卡（返回 false，不 patch、不抛）', async () => {
  const patches = [];
  const client = { im: { message: { patch: async (payload) => { patches.push(payload); return { code: 0 }; } } } };
  const service = new PendingDealPushService({
    settings: pushSettings(),
    client,
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-patch-none-')), idField: 'task_id',
    }),
    settlements: { listSettlements: async () => ({ rows: [], pendingRowCount: 0 }) },
    now: () => NOW,
  });
  assert.equal(await service.patchSettlementCard({ event: {} }), false);
  assert.equal(patches.length, 0);
});

// ── ⑥ 服务端分派：动作名 → 那个 service（**位置在 `if (!draftId) throw` 之前**）──────
const { LarkMvpService } = require('../src/services/larkMvpService');

const dispatchService = () => {
  const calls = [];
  const pendingDealPush = {
    confirmVoucherSettlement: async (value, event, context, operatorOpenId) => {
      calls.push({ value, event, context, operatorOpenId });
      return { toast: { type: 'success', content: '已确认 1 笔、共 ¥85.40' } };
    },
  };
  const service = new LarkMvpService({
    client: {}, gateway: {}, references: {}, posting: {}, recognizer: {},
    store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-dispatch-')), idField: 'task_id',
    }),
    botOpenId: 'ou_bot',
    pendingDealPush,
  });
  return { service, calls };
};

test('卡片回调：`confirm_voucher_settlement` 走那个 service —— **没有 draft_id 也不许抛**', async () => {
  const { service, calls } = dispatchService();
  const event = {
    operator: { operator_id: { open_id: 'ou_she' } },
    action: { value: { action: 'confirm_voucher_settlement', settle_day: '2026-10-02' } },
    context: { open_message_id: 'om_card_1' },
  };
  const result = await service.handleCardAction(event, { interactionId: 'it_1' });
  assert.match(result.toast.content, /已确认 1 笔/);
  assert.equal(calls.length, 1);
  // ⚠️ 位置判据：这条链路绑的是**收款明细**，落到下面的销售草稿分派会抛「卡片缺少草稿 ID」。
  assert.deepEqual(calls[0].value, { action: 'confirm_voucher_settlement', settle_day: '2026-10-02' });
  assert.equal(calls[0].operatorOpenId, 'ou_she');
  assert.equal(calls[0].context.interactionId, 'it_1');
});

test('卡片回调：缺结算日 ⇒ 回一句"卡片上没有结算日"，**不去猜、也不调写库**', async () => {
  const { service, calls } = dispatchService();
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_she' } },
    action: { value: { action: 'confirm_voucher_settlement' }, form_value: {} },
  }, { interactionId: 'it_2' });
  assert.equal(result.toast.type, 'warning');
  assert.match(result.toast.content, /没有结算日/);
  assert.equal(calls.length, 0);
});

test('卡片回调：动作名不认识时**照旧**落到兜底（本功能没有改坏既有分派）', async () => {
  const { service } = dispatchService();
  await assert.rejects(() => service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_she' } },
    action: { value: { action: 'some_unknown_action' } },
  }, { interactionId: 'it_3' }), /卡片缺少草稿 ID/);
});
