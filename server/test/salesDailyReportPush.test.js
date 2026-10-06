/**
 * ②「销售战报 · 定时推送」的验收标准（业务负责人 2026-10-06 逐字口径，
 * 口径文件：docs/sales-daily-report-push-2026-10-06.md）。
 *
 * 这份用例盯的是**口径与边界**，不是实现细节：
 *   □ 时间（北京时间）：9 / 12 / 15 / 18 / 21 点 ＋ 22 点（**当日收官，卡片上要能一眼分开**）；
 *   □ 形式是**消息卡片**，发到群里（`chat_id`）的**主聊天**（create，绝不 reply 进话题）；
 *   □ **销售单数** = 销售明细里「履约状态 = 已履约」的**条数**（今天是哪一天按上海自然日算）；
 *   □ **销售金额** = 收款明细里「已收款」且**收款时间是今天、截至推送那一刻**的合计；
 *   □ 同一天同一时段只推一次；**过掉的时段不补推**（只记一条可排查的 missed）；
 *   □ 时间点 / 群列表 / 开关 / 两个筛选值**全在配置里**（改口径不改代码）；
 *   □ 开关是**显式布尔**（空串 = 关）；群一个都没配 → 不推、**绝不回落到私聊**。
 */
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesDailyReportService, slotMarkerId } = require('../src/services/salesDailyReportService');
const { resolveSalesDailyReportPushConfig } = require('../src/config/salesDailyReportPush');
const { salesDailyReportCard, salesDailyReportCardText } = require('../src/utils/salesDailyReportCard');
const { readFlag } = require('../src/config/envValue');
const { startShanghaiDailyScheduler, shanghaiHour } = require('../src/utils/shanghaiDailyScheduler');

const CHAT_A = 'oc_report_a';
const CHAT_B = 'oc_report_b';
const DAY = '2026-10-06';
// 北京时间 = UTC+8：北京 09:00 / 12:00 / 13:00 / 15:30 / 22:00
const AT_09 = new Date(`${DAY}T01:00:00.000Z`);
const AT_12 = new Date(`${DAY}T04:00:00.000Z`);
const AT_13 = new Date(`${DAY}T05:00:00.000Z`);
const AT_1530 = new Date(`${DAY}T07:30:00.000Z`);
const AT_22 = new Date(`${DAY}T14:00:00.000Z`);
const at = (iso) => Date.parse(iso);

const tempStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const settings = (overrides = {}) => ({
  enabled: true,
  chatIds: [CHAT_A],
  chatFallback: false,
  hours: [9, 12, 15, 18, 21],
  summaryHour: 22,
  slots: [9, 12, 15, 18, 21, 22],
  intervalMs: 600000,
  // 与 config 的默认值保持一致（她逐字说「已履约」，真表选项叫「已交付」→ 两个都算）。
  fulfilledStatuses: ['已履约', '已交付'],
  paymentStatus: '已收款',
  ...overrides,
});

/** 假网关：只实现本服务要用的"读两张表"。 */
const fakeGateway = ({ details = [], payments = [] } = {}) => ({
  table: (key) => {
    if (key === 'salesDetail') {
      return { tableName: '销售明细', fields: { soldAt: '销售日', fulfillmentStatus: '履约状态' } };
    }
    if (key === 'paymentRecord') {
      return {
        tableName: '收款明细',
        fields: {
          status: '收款状态', receivedAt: '收款时间', amount: '收款金额', tradeDirection: '交易方向',
        },
      };
    }
    return { tableName: key, fields: {} };
  },
  listAll: async (key) => (key === 'salesDetail' ? details : payments),
});

const detail = ({ id = 'd1', status = '已履约', soldAt = at(`${DAY}T02:00:00.000Z`) } = {}) => ({
  record_id: id, fields: { 履约状态: status, 销售日: soldAt },
});
const payment = ({
  id = 'p1', status = '已收款', receivedAt = at(`${DAY}T02:00:00.000Z`), amount = 100, direction = '收入',
} = {}) => ({
  record_id: id, fields: { 收款状态: status, 收款时间: receivedAt, 收款金额: amount, 交易方向: direction },
});

const fakeClient = ({ failChatIds = [] } = {}) => {
  const creates = [];
  const client = {
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          const chatId = payload?.data?.receive_id;
          if (failChatIds.includes(chatId)) return { code: 99991, msg: 'mock send failed' };
          return { code: 0, data: { message_id: `om_report_${creates.length}` } };
        },
        reply: async () => { throw new Error('战报必须发到主聊天，不许 reply 进话题'); },
      },
    },
  };
  return { client, creates };
};

const newService = ({ details, payments, settings: overrides, client, store, chatIds, failChatIds } = {}) => {
  const resolved = settings(overrides);
  const { client: defaultClient, creates } = fakeClient({ failChatIds });
  const service = new SalesDailyReportService({
    settings: resolved,
    gateway: fakeGateway({ details, payments }),
    client: client || defaultClient,
    store: store || tempStore('sales-report-slot-'),
    ...(chatIds === undefined ? {} : { chatIds }),
  });
  return { service, creates };
};

// ─────────────────────────────────────────────────────────────────────────────
// 一、配置：时间点 / 群列表 / 开关 / 两个筛选值（改口径不改代码）
// ─────────────────────────────────────────────────────────────────────────────

test('默认配置：9/12/15/18/21 + 22 点收官、默认关、没有群、口径值按她的话', () => {
  const config = resolveSalesDailyReportPushConfig({});
  assert.equal(config.enabled, false, '默认关（显式开才会起定时器）');
  assert.deepEqual(config.hours, [9, 12, 15, 18, 21]);
  assert.equal(config.summaryHour, 22);
  assert.deepEqual(config.slots, [9, 12, 15, 18, 21, 22]);
  assert.equal(config.intervalMs, 600000);
  // 她逐字说「已履约」，真表里的选项叫「已交付」——默认两个都算（不会重复计数）。
  assert.deepEqual(config.fulfilledStatuses, ['已履约', '已交付']);
  assert.equal(config.paymentStatus, '已收款');
  assert.deepEqual(config.chatIds, [], '没配群就是空（绝不回落到私聊）');
});

test('群是【列表】：PURCHASE_CHAT_ID 回落在没设时生效；显式设空 = 一个都不发', () => {
  const fallback = resolveSalesDailyReportPushConfig({ PURCHASE_CHAT_ID: 'oc_purchase' });
  assert.deepEqual(fallback.chatIds, ['oc_purchase'], '她说的就是"收采购图/退货单那个群"');
  assert.equal(fallback.chatFallback, true);

  const explicit = resolveSalesDailyReportPushConfig({
    PURCHASE_CHAT_ID: 'oc_purchase', SALES_DAILY_REPORT_PUSH_CHAT_IDS: `${CHAT_A}, ${CHAT_B}`,
  });
  assert.deepEqual(explicit.chatIds, [CHAT_A, CHAT_B], '将来加运营群只改这一行');
  assert.equal(explicit.chatFallback, false);

  const empty = resolveSalesDailyReportPushConfig({
    PURCHASE_CHAT_ID: 'oc_purchase', SALES_DAILY_REPORT_PUSH_CHAT_IDS: '',
  });
  assert.deepEqual(empty.chatIds, [], '显式空 = 就是不发，**不回退**到采购群');
});

test('时段可配：非法整点抛错、去重排序、收官不能混在常规时段里', () => {
  assert.deepEqual(resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_HOURS: '15, 9,9,12' }).hours, [9, 12, 15]);
  assert.throws(() => resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_HOURS: '25' }), /0~23/);
  assert.throws(() => resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_HOURS: '九点' }), /0~23/);
  // 收官那一条两边都放 = 配置错，启动时就吵（否则会在同一个整点推两条）。
  assert.throws(() => resolveSalesDailyReportPushConfig({
    SALES_DAILY_REPORT_PUSH_HOURS: '9,12,15,18,21,22', SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR: '22',
  }), /同时出现/);
  // 不要把收官那条也算成常规时段。
  assert.deepEqual(
    resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_HOURS: '', SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR: '22' }).slots,
    [22],
  );
  // 收官留空 = 不要那一条。
  const noSummary = resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR: '' });
  assert.equal(noSummary.summaryHour, null);
  assert.deepEqual(noSummary.slots, [9, 12, 15, 18, 21]);
});

test('开关是显式布尔：空串 = 关，不回退默认值；认不出来的值当场抛错', () => {
  assert.equal(readFlag({ X: '' }, 'X', true), false);
  assert.equal(resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_ENABLED: '' }).enabled, false);
  assert.equal(resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_ENABLED: 'true' }).enabled, true);
  assert.throws(() => resolveSalesDailyReportPushConfig({ SALES_DAILY_REPORT_PUSH_ENABLED: '开' }), /显式布尔/);
});

test('两个筛选值可配（她把「履约状态」选项改名时只改配置，不碰代码）', () => {
  const config = resolveSalesDailyReportPushConfig({
    SALES_DAILY_REPORT_FULFILLED_STATUSES: '已履约,已交付,已交付',
    SALES_DAILY_REPORT_PAYMENT_STATUS: '已收款',
  });
  assert.deepEqual(config.fulfilledStatuses, ['已履约', '已交付']);
  assert.equal(config.paymentStatus, '已收款');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、两个数字的口径
// ─────────────────────────────────────────────────────────────────────────────

test('销售单数 = 今天「履约状态=已履约」的条数（一条明细 = 一双鞋 = 一个单子）', async () => {
  const { service } = newService({
    details: [
      detail({ id: 'd1' }), detail({ id: 'd2' }),
      detail({ id: 'd3', status: '未交付' }),
      detail({ id: 'd4', status: '已退货' }),
      detail({ id: 'd5', soldAt: at('2026-10-05T02:00:00.000Z') }), // 昨天
      detail({ id: 'd6', soldAt: at('2026-10-07T02:00:00.000Z') }), // 明天（不该算）
    ],
  });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesCount, 2, '只数今天已履约那两条');
  assert.deepEqual(stats.statusHistogram, { 已履约: 2, 未交付: 1, 已退货: 1 });
});

test('销售金额 = 今天「已收款」且截至推送那一刻的合计（待平台结算/未收款/昨天/未来都不算）', async () => {
  const { service } = newService({
    payments: [
      payment({ id: 'p1', amount: 300 }),
      payment({ id: 'p2', amount: 1200.5, receivedAt: at(`${DAY}T07:00:00.000Z`) }),
      payment({ id: 'p3', amount: 999, status: '待平台结算' }),
      payment({ id: 'p4', amount: 999, status: '未收款' }),
      payment({ id: 'p5', amount: 999, receivedAt: at('2026-10-05T02:00:00.000Z') }),
      payment({ id: 'p6', amount: 999, receivedAt: at(`${DAY}T08:00:00.000Z`) }), // 15:30 之后收的
    ],
  });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesAmount, 1500.5, '只算今天、已收款、且不晚于推送时刻');
  assert.equal(stats.paymentCount, 2);
});

test('退款（交易方向=退回）在收款明细里也是「已收款」：如实统计并在卡片上提示，不擅自冲抵', async () => {
  const { service } = newService({
    payments: [
      payment({ id: 'p1', amount: 1000 }),
      payment({ id: 'p2', amount: 200, direction: '退回' }),
    ],
  });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesAmount, 1200, '她的字面口径：已收款 + 今天，含退回');
  assert.equal(stats.refundAmount, 200);
  assert.equal(stats.refundCount, 1);

  // ⚠️ 卡片上**不写**这条说明（她明确要求卡片上不出现计算逻辑）——只保证统计如实、日志有记录。
  const card = service.buildCard({ dayKey: DAY, hour: 15, stats });
  assert.doesNotMatch(JSON.stringify(card), /退回|冲抵/, '卡片上不出现口径说明');
});

test('金额读不出来时按 0（绝不让 NaN 混进合计）', async () => {
  const { service } = newService({
    payments: [payment({ id: 'p1', amount: '' }), payment({ id: 'p2', amount: '三千' })],
  });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesAmount, 0);
});

test('「已履约 / 已交付」一条都没有、但当天有明细 → 是口径对不上，不是"今天没卖"，要留下可排查信息', async () => {
  const { service } = newService({ details: [detail({ id: 'd1', status: '已换货' })] });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesCount, 0);
  assert.deepEqual(stats.statusHistogram, { 已换货: 1 });
});

test('真表用的是「已交付」：默认口径也能数出来（不因为她用词是「已履约」就数成 0）', async () => {
  const { service } = newService({
    details: [detail({ id: 'd1', status: '已交付' }), detail({ id: 'd2', status: '已交付' }), detail({ id: 'd3', status: '未交付' })],
  });
  const stats = await service.collectStats({ now: AT_1530 });
  assert.equal(stats.salesCount, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、卡片：两个数字 + 22 点收官要和常规一眼分开
// ─────────────────────────────────────────────────────────────────────────────

test('常规时段卡片：标题「截止 HH:00」+ 左右两个大数字块（销售单数 / 销售金额）', () => {
  const card = salesDailyReportCard({ dayKey: DAY, hour: 12, salesCount: 12, salesAmount: 3280 });
  assert.equal(card.header.title.content, '销售战报 · 截止 12:00');
  assert.equal(card.header.template, 'blue');

  // 她要求"两个比较大的、类似按钮形式的板块"，左右并排 —— 结构就是一个两列的 column_set。
  const columns = card.elements[0];
  assert.equal(columns.tag, 'column_set');
  assert.equal(columns.columns.length, 2, '只要两个大块，不要第三个数字块');

  const text = salesDailyReportCardText(card);
  assert.match(text, /销售单数 12 单\s*\|\s*销售金额 ¥3280\.00/);
  const left = JSON.stringify(columns.columns[0]);
  const right = JSON.stringify(columns.columns[1]);
  assert.match(left, /销售单数/);
  assert.match(left, /12 单/);
  assert.match(right, /销售金额/);
  assert.match(right, /¥3280\.00/);
  // 数字要"一眼看到"：用特大字号（xxxx-large = 30px），且数字本身加粗。
  assert.equal(columns.columns[1].elements[1].text.text_size, 'xxxx-large');
  assert.match(columns.columns[1].elements[1].text.content, /\*\*¥3280\.00\*\*/);
});

test('🔴 卡片上不写任何"计算逻辑"（她看完初版明确要求的）', () => {
  const card = salesDailyReportCard({ dayKey: DAY, hour: 15, salesCount: 3, salesAmount: 100 });
  const json = JSON.stringify(card);
  for (const forbidden of ['履约状态', '已履约', '已交付', '收款状态', '已收款', '收款时间', '收款明细', '销售明细', '口径', '一条明细', '推送那一刻']) {
    assert.doesNotMatch(json, new RegExp(forbidden), `卡片上不该出现「${forbidden}」这类解释文字`);
  }
  // 也不做表格 / 长文本 / 备注。
  assert.equal(card.elements.length, 1);
  assert.ok(!card.elements.some((element) => element.tag === 'note' || element.tag === 'table'));
});

test('22 点那条是「当日收官」：标题与页眉色都要和常规分开', () => {
  const card = salesDailyReportCard({ dayKey: DAY, hour: 22, isSummary: true, salesCount: 30, salesAmount: 9999 });
  assert.equal(card.header.title.content, '销售战报 · 截止 22:00 · 今日收官');
  assert.equal(card.header.template, 'violet');
});

test('卡片是飞书交互卡片结构（她要看的是"消息卡片"，不是纯文本）', () => {
  const card = salesDailyReportCard({ dayKey: DAY, hour: 9, salesCount: 0, salesAmount: 0 });
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(card.elements[0].tag, 'column_set');
  // 两个块都是"标签 + 大数字"两行。
  card.elements[0].columns.forEach((column) => {
    assert.equal(column.elements.length, 2);
    assert.equal(column.elements[0].text.text_size, 'notation');
    assert.equal(column.elements[1].text.text_size, 'xxxx-large');
  });
  assert.equal(salesDailyReportCardText(card), '销售战报 · 截止 09:00\n销售单数 0 单  |  销售金额 ¥0.00');
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、发到哪儿 / 认领防重 / 过期不补 / 不回落私聊
// ─────────────────────────────────────────────────────────────────────────────

test('发到群里【主聊天】：receive_id_type=chat_id、interactive 卡片、不带 reply_in_thread', async () => {
  const { service, creates } = newService({ details: [detail({ id: 'd1' })], payments: [payment({ id: 'p1' })] });
  const result = await service.sendReport({ now: AT_12 });

  assert.equal(result.sent, true);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.receive_id_type, 'chat_id');
  assert.equal(creates[0].data.receive_id, CHAT_A);
  assert.equal(creates[0].data.msg_type, 'interactive', '战报必须是消息卡片');
  assert.equal(creates[0].data.reply_in_thread, undefined, '定时触发没有话题可依附，不许 reply 进话题');
  const card = JSON.parse(creates[0].data.content);
  assert.equal(card.header.title.content, '销售战报 · 截止 12:00');
});

test('多个群（将来加运营群）：每群一条卡片', async () => {
  const { service, creates } = newService({ settings: { chatIds: [CHAT_A, CHAT_B] }, details: [detail()] });
  const result = await service.sendReport({ now: AT_12 });
  assert.equal(result.sentTo.length, 2);
  assert.deepEqual(creates.map((call) => call.data.receive_id), [CHAT_A, CHAT_B]);
});

test('按时段认领：同一个整点推第二遍什么都不做；下一个整点照推', async () => {
  const store = tempStore('sales-report-claim-');
  const { service, creates } = newService({ details: [detail()], store });

  const first = await service.sendReport({ now: AT_12 });
  assert.equal(first.sent, true);
  const second = await service.sendReport({ now: new Date(`${DAY}T04:30:00.000Z`) });
  assert.equal(second.reason, 'already_ran_this_slot');
  assert.equal(creates.length, 1, '同一个时段只许有一条消息');

  const nextSlot = await service.sendReport({ now: AT_1530 });
  assert.equal(nextSlot.sent, true);
  assert.equal(creates.length, 2, '到下一个时段照推');
});

test('22 点：卡片带「当日收官」，走的是同一个时段认领', async () => {
  const { service, creates } = newService({ details: [detail()], payments: [payment({ amount: 500 })] });
  const result = await service.sendReport({ now: AT_22 });
  assert.equal(result.isSummary, true);
  const card = JSON.parse(creates[0].data.content);
  assert.equal(card.header.title.content, '销售战报 · 截止 22:00 · 今日收官');
  assert.equal(card.header.template, 'violet');
});

test('🔴 过掉的时段【不补推】：只留一条 missed 记录，别把 12 点的数字当 13 点的快照发出去', async () => {
  const store = tempStore('sales-report-missed-');
  const { service, creates } = newService({ details: [detail()], store });

  const result = await service.sendReport({ now: AT_13 });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not_a_slot_hour');
  assert.equal(creates.length, 0, '13 点不是时段，什么都不发');
  assert.deepEqual(result.missedHours, [9, 12], '9 点、12 点已经错过');

  const missed = await store.get(slotMarkerId(DAY, 12));
  assert.equal(missed.status, 'missed');
  assert.equal(missed.reason, 'slot_passed_before_push');

  // 再 tick 一次：missed 只记一次，不会越积越多。
  const again = await service.sendReport({ now: new Date(`${DAY}T05:10:00.000Z`) });
  assert.deepEqual(again.missedHours, []);
});

test('一次远端失败：同一个小时内重试会补上（failed 才重试）', async () => {
  const store = tempStore('sales-report-retry-');
  const failing = fakeClient({ failChatIds: [CHAT_A] });
  const failingService = new SalesDailyReportService({
    settings: settings(),
    gateway: fakeGateway({ details: [detail()] }),
    client: failing.client,
    store,
  });
  const first = await failingService.sendReport({ now: AT_12 });
  assert.equal(first.sent, false);
  assert.equal(first.status, 'failed');
  assert.equal((await store.get(slotMarkerId(DAY, 12))).status, 'failed');

  const okClient = fakeClient();
  const okService = new SalesDailyReportService({
    settings: settings(),
    gateway: fakeGateway({ details: [detail()] }),
    client: okClient.client,
    store,
  });
  const second = await okService.sendReport({ now: new Date(`${DAY}T04:20:00.000Z`) });
  assert.equal(second.sent, true, '同一个小时内应该重试');
  assert.equal(okClient.creates.length, 1);
});

test('部分群失败：其他群照发，状态记 partial（一个群坏了不连累另一个）', async () => {
  const { service } = newService({
    settings: { chatIds: [CHAT_A, CHAT_B] }, details: [detail()], failChatIds: [CHAT_B],
  });
  const result = await service.sendReport({ now: AT_12 });
  assert.equal(result.status, 'partial');
  assert.equal(result.sentTo.length, 1);
  assert.equal(result.failed.length, 1);
});

test('一个群都没配：不推、记 no_chat，**绝不回落到私聊**', async () => {
  const { service, creates } = newService({ chatIds: [], details: [detail()] });
  const result = await service.sendReport({ now: AT_12 });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no_chat');
  assert.equal(creates.length, 0);
});

test('开关关着：一次远端调用都不发（兜底闸门，防止别处绕过定时器直接调）', async () => {
  const { service, creates } = newService({ settings: { enabled: false }, details: [detail()] });
  const result = await service.sendReport({ now: AT_12 });
  assert.deepEqual({ skipped: result.skipped, reason: result.reason }, { skipped: true, reason: 'disabled' });
  assert.equal(creates.length, 0);
});

test('取数挂了：这个时段记 failed（同小时内可重试），异常往上抛给定时器记日志', async () => {
  const store = tempStore('sales-report-boom-');
  const service = new SalesDailyReportService({
    settings: settings(),
    gateway: {
      table: () => ({ tableName: '销售明细', fields: { soldAt: '销售日', fulfillmentStatus: '履约状态' } }),
      listAll: async () => { throw new Error('bitable 读取失败'); },
    },
    client: fakeClient().client,
    store,
  });
  await assert.rejects(() => service.sendReport({ now: AT_12 }), /bitable 读取失败/);
  assert.equal((await store.get(slotMarkerId(DAY, 12))).status, 'failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、定时器：多整点（复用现成的上海时间轮询器）
// ─────────────────────────────────────────────────────────────────────────────

test('定时器支持多整点：到最早那个整点前不跑，过了就跑', async () => {
  const calls = [];
  let clock = at(`${DAY}T00:30:00.000Z`); // 北京 08:30
  const stop = startShanghaiDailyScheduler({
    run: async ({ now }) => calls.push(now.toISOString()),
    eventPrefix: 'test.sales_report',
    hours: [9, 12, 15, 18, 21, 22],
    intervalMs: 3600000,
    now: () => clock,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0, '北京 8:30 还没到最早那个整点');

  clock = AT_12; // 北京 12:00
  const stop2 = startShanghaiDailyScheduler({
    run: async ({ now }) => calls.push(now.toISOString()),
    eventPrefix: 'test.sales_report.on_time',
    hours: [9, 12, 15, 18, 21, 22],
    intervalMs: 3600000,
    now: () => clock,
  });
  for (let i = 0; i < 100 && !calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  stop();
  stop2();

  assert.equal(shanghaiHour(AT_22), 22);
  assert.throws(() => startShanghaiDailyScheduler({
    run: async () => {}, eventPrefix: 'x', hours: [25],
  }), /0~23/);
});
