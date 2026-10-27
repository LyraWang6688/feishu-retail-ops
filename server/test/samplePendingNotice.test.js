/**
 * ⭐⭐ 2026-10-11（业务负责人 20:30 逐条确认）：**待办汇总发采购群**
 *
 * 她的口径（Lead 确认）：
 *   · **一天 5 次**：`09:00 → 12:00 → 15:00 → 18:00 → 21:00`（时点做**配置**，不写死）；
 *   · **完全单独一条消息**（**不并进**现有 9 点推送那条）；
 *   · **发之前配的那个群** = `PURCHASE_CHAT_ID`（`config/groupPurchase.js` 的 `resolvePurchaseChatId()`）；
 *   · 文案逐字：`待办还有 N 条：待补充 X 条 · 待补样品 Y 条 · 待交割 Z 条 → 去工作台处理`（进配置）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PN1 时点来自**配置**（默认 9/12/15/18/21，可改），并交给既有
 *         `startShanghaiDailyScheduler` 的 `hours`（不自己写定时器）。
 *  AC-PN2 文案逐字 + 计数（待补充 X · 待补样品 Y · 待交割 Z ⇒ 共 N）＋**发到采购群**
 *         （`PURCHASE_CHAT_ID`）；⚠️ **没配群 ⇒ 大声 warn 跳过、绝不回落私聊**。
 *  AC-PN3 **同一个时点只发一次**（调度器每个 tick 都会调 `run`）＋ **共 0 条不发**（配置可控）。
 *  AC-PN4 通知用的**计数口径与工作台订单列表一致**（后端纯函数 ≡ 前端 `salesSectionOf`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sample_notice';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sample_notice_secret';

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createSamplePendingNoticeService } = require('../src/services/samplePendingNoticeService');
const { resolveSamplePendingNoticeConfig } = require('../src/config/samplePendingNotice');
const { workbenchSectionOf, workbenchCountsOf } = require('../src/services/workbenchOrderSections');

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `sample-notice-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const ORDER = {
  fulfillment_status: '已交付', payment_status: '已收款',
  details: [{ product: 'X', color: '黑', size: 40, requires_size: true }],
  payments: [{ method: '微信' }],
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-PN1 时点 = 配置
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PN1 一天 5 个时点来自配置（默认 9/12/15/18/21，可改；空串 = 关掉）', () => {
  const defaults = resolveSamplePendingNoticeConfig({});
  assert.deepEqual(defaults.hours, [9, 12, 15, 18, 21]);
  assert.equal(defaults.enabled, true, '默认开（生产靠 .env 控）');
  const custom = resolveSamplePendingNoticeConfig({ SAMPLE_PENDING_NOTICE_HOURS: '8,20' });
  assert.deepEqual(custom.hours, [8, 20], '时点可配');
  const disabled = resolveSamplePendingNoticeConfig({ SAMPLE_PENDING_NOTICE_ENABLED: '' });
  assert.equal(disabled.enabled, false, '设成空串 = 关掉（与既有 readFlag 同一条语义）');
  // 非法时点要**当场报错**（而不是安静地一天一次都不发）
  assert.throws(() => resolveSamplePendingNoticeConfig({ SAMPLE_PENDING_NOTICE_HOURS: '9,25' }), /0~23|hour/i);
  assert.throws(() => resolveSamplePendingNoticeConfig({ SAMPLE_PENDING_NOTICE_HOURS: 'abc' }), /0~23|hour/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PN2 文案逐字 + 发采购群（未配群 ⇒ 跳过）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PN2 文案逐字 + 发给采购群；没配群 ⇒ 跳过（不回落私聊）', async () => {
  const dir = tempDir('notice');
  const sentTexts = [];
  const service = createSamplePendingNoticeService({
    settings: resolveSamplePendingNoticeConfig({}),
    store: new JsonTaskStore({ dir, idField: 'task_id' }),
    listOrders: async () => ({ orders: [ORDER, { ...ORDER, sample_pending: true }] }),
    send: async (text) => { sentTexts.push(text); return true; },
  });
  try {
    const result = await service.send({ now: new Date('2026-10-11T09:05:00+08:00') });
    assert.equal(result.sent, true, JSON.stringify(result));
    // ⚠️ 2026-10-12 修正口径（现场 9 点那条通知 `total=76` 与 `10+8+5` 打架）：
    //    `total` = **三段待办之和**（待补充 + 待交割）——**已两清那一类不算待办**；
    //    `sample`（待补样品）是 `supplement`（待补充）的**子集**，不重复加。
    //    这里的 fixture = 1 单两清 + 1 单待补样品 ⇒ 待办只有 1 条。
    assert.deepEqual(result.counts, { supplement: 1, sample: 1, pending: 0, afterSales: 1, total: 1 });
    // 文案逐字（她给的那句 + 「其中」把子集关系说清）
    assert.equal(sentTexts[0], '待办还有 1 条：待补充 1 条 · 其中待补样品 1 条 · 待交割 0 条 → 去工作台处理');

    // ⚠️ 没配群 ⇒ **大声跳过**、绝不回落私聊：走**真的** sendPurchaseGroupNotice 那条路
    const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
    const warnings = [];
    const originals = { warn: console.warn };
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let posted = 0;
    const webhooks = new PurchaseWebhookService({
      gateway: { table: () => ({ fields: {} }) },
      client: { im: { message: { create: async () => { posted += 1; return { code: 0, data: {} }; } } } },
    });
    delete process.env.PURCHASE_CHAT_ID;
    const skipped = await webhooks.sendPurchaseGroupNotice('待办还有 0 条');
    console.warn = originals.warn;
    assert.equal(skipped, false, '没配群 ⇒ 返回 false（没发出去）');
    assert.equal(posted, 0, '一个远端调用都不做');
    assert.ok(warnings.some((line) => line.includes('purchase.group_notice.skipped')), '要有一条大声的 warn');

    // 配了群 ⇒ 真的发到那个 chat_id
    process.env.PURCHASE_CHAT_ID = 'oc_purchase_group';
    const targets = [];
    const webhooksWithGroup = new PurchaseWebhookService({
      gateway: { table: () => ({ fields: {} }) },
      client: { im: { message: { create: async (payload) => {
        targets.push(payload.data.receive_id);
        return { code: 0, data: { message_id: 'om_1' } };
      } } } },
    });
    const ok = await webhooksWithGroup.sendPurchaseGroupNotice('待办还有 2 条');
    assert.equal(ok, true);
    assert.deepEqual(targets, ['oc_purchase_group'], '发的是采购群（PURCHASE_CHAT_ID）');
    delete process.env.PURCHASE_CHAT_ID;
  } finally { rmDir(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PN3 同一时点只发一次；0 条不发
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PN3 同一个时点只发一次（调度器每 tick 都会调）；共 0 条不发', async () => {
  const dir = tempDir('once');
  let orders = [{ ...ORDER, sample_pending: true }];
  const sent = [];
  const store = new JsonTaskStore({ dir, idField: 'task_id' });
  const service = createSamplePendingNoticeService({
    settings: resolveSamplePendingNoticeConfig({}),
    store,
    listOrders: async () => ({ orders }),
    send: async (text) => { sent.push(text); return true; },
  });
  const at9 = new Date('2026-10-11T09:01:00+08:00');
  try {
    assert.equal((await service.send({ now: at9 })).sent, true);
    // 同一个时点内的第二次（10 分钟后调度器又 tick 一次）⇒ 不再发
    const again = await service.send({ now: new Date('2026-10-11T09:11:00+08:00') });
    assert.equal(again.sent, false);
    assert.equal(again.reason, 'already_sent');
    assert.equal(sent.length, 1);
    // 到了下一个时点 ⇒ 再发一条
    assert.equal((await service.send({ now: new Date('2026-10-11T12:01:00+08:00') })).sent, true);
    assert.equal(sent.length, 2);
    // 共 0 条 ⇒ **不发**（不是"发一条 0 条的"）
    //    ⚠️ 2026-10-12：`total` 只数**待办**（待补充 + 待交割）——已两清不算待办。
    orders = [];
    assert.equal((await service.send({ now: new Date('2026-10-11T15:01:00+08:00') })).sent, false);
    assert.equal(sent.length, 2);
  } finally { rmDir(dir); }
});

test('AC-PN3b ⚠️ 去重槽位 = 最近一个已过的【配置时点】（否则 18 点后每次 tick 都会多发一条）', async () => {
  // 这一条是 2026-10-11 **真启动核对**时抓到的真 bug：调度器"过了整点之后每个 tick 都调"，
  // 若拿"当前整点"当槽位，18:00 发过之后 20:33 又会算出一个新槽位 ⇒ 一天多发。
  const dir = tempDir('slot');
  const sent = [];
  const service = createSamplePendingNoticeService({
    settings: resolveSamplePendingNoticeConfig({}),
    store: new JsonTaskStore({ dir, idField: 'task_id' }),
    listOrders: async () => ({ orders: [{ ...ORDER, sample_pending: true }] }),
    send: async (text) => { sent.push(text); return true; },
  });
  try {
    // 18:02 ⇒ 槽位 18（发）
    const first = await service.send({ now: new Date('2026-10-11T18:02:00+08:00') });
    assert.equal(first.sent, true);
    assert.equal(first.slot, '2026-10-11-18');
    // 20:33（过了 18 点、还没到 21 点）⇒ 仍是 **18 那个槽位** ⇒ 不重复发
    const mid = await service.send({ now: new Date('2026-10-11T20:33:00+08:00') });
    assert.equal(mid.sent, false);
    assert.equal(mid.reason, 'already_sent');
    assert.equal(mid.slot, '2026-10-11-18');
    assert.equal(sent.length, 1, '一天里这一点只发一条');
    // 21:01 ⇒ 新槽位 21（发）
    assert.equal((await service.send({ now: new Date('2026-10-11T21:01:00+08:00') })).slot, '2026-10-11-21');
    assert.equal(sent.length, 2);
    // 22:40 ⇒ 还是 21 那个槽位 ⇒ 不发
    assert.equal((await service.send({ now: new Date('2026-10-11T22:40:00+08:00') })).reason, 'already_sent');
    // 早上 8 点（还没到第一个配置时点）⇒ 不发
    const early = await service.send({ now: new Date('2026-10-12T08:00:00+08:00') });
    assert.equal(early.sent, false);
    assert.equal(early.reason, 'before_first_hour');
  } finally { rmDir(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PN4 计数口径与工作台一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PN4 通知的计数口径 ≡ 工作台订单列表的判据（同一组 fixture 结论一致）', async () => {
  const fixtures = [
    { name: '两清', order: ORDER, section: 'afterSales' },
    { name: '待交割', order: { ...ORDER, fulfillment_status: '未交付' }, section: 'pending' },
    { name: '缺资金信息', order: { ...ORDER, payments: [] }, section: 'supplement' },
    { name: '缺货品信息', order: { ...ORDER, details: [] }, section: 'supplement' },
    { name: '待补样品', order: { ...ORDER, sample_pending: true }, section: 'supplement' },
    { name: '待补样品+缺资金', order: { ...ORDER, sample_pending: true, payments: [] }, section: 'supplement' },
  ];
  // 后端纯函数
  for (const fixture of fixtures) {
    assert.equal(workbenchSectionOf(fixture.order), fixture.section, `后端：${fixture.name}`);
  }
  const counts = workbenchCountsOf(fixtures.map((fixture) => fixture.order));
  // ⚠️ 2026-10-12 修正：`total` = 待补充 + 待交割 = 4 + 1 = 5（**已两清那 1 条不算待办**；
  //    待补样品 2 条是"待补充 4 条"里的子集，**不重复加**）。
  assert.deepEqual(counts, { supplement: 4, sample: 2, pending: 1, afterSales: 1, total: 5 });
  // 前端同一份判据（真跑那个 ES 模块）
  // ⭐ 2026-10-17 成对迁移（依据：她逐字「只保留二次交割以及售后」）：
  //   前端订单列表**两段**（`pending` / `afterSales`）；通知仍**三段**（多一个「待补充」给提醒用）。
  //   ⇒ `supplement`（缺信息 / 待补样品）在前端**并入 `pending`**；其余同名对得上 ✓
  const front = await loadFrontendOrders();
  for (const fixture of fixtures) {
    const expected = fixture.section === 'supplement' ? 'pending' : (fixture.section === 'afterSales' ? 'settled' : fixture.section);
    assert.equal(front.salesSectionOf(fixture.order), expected, `前端：${fixture.name}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PN5 🔴 2026-10-12 现场事故：`total` 与文案三段打架（`total=76` / `10+8+5=23`）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PN5 `total` = 待补充 + 待交割（恒等式）；文案里的数字与 counts 逐字一致；与工作台两段对得上', async () => {
  const base = {
    fulfillment_status: '已交付', payment_status: '已收款',
    details: [{ product: 'X', color: '黑', size: 40, requires_size: true }],
    payments: [{ method: '微信' }],
  };
  // ① 现场那一组数字（真机日志）：10 条待补充（其中 8 条是待补样品）· 5 条待交割 · 61 条已两清
  const orders = [
    ...Array.from({ length: 2 }, () => ({ ...base, payments: [] })),                    // 待补充（缺资金），不含待补样品
    ...Array.from({ length: 8 }, () => ({ ...base, sample_pending: true })),            // 待补充（待补样品）
    ...Array.from({ length: 5 }, () => ({ ...base, fulfillment_status: '未交付' })),    // 待交割
    ...Array.from({ length: 61 }, () => ({ ...base })),                                 // 已两清（**不是待办**）
  ];
  const counts = workbenchCountsOf(orders);
  assert.equal(orders.length, 76, '取数口径不变：工作台列表里就是这 76 单');
  assert.deepEqual(counts, { supplement: 10, sample: 8, pending: 5, afterSales: 61, total: 15 });
  // ② 🔴 恒等式：**列出来的三段之和 = total**（她一眼就能对上）
  assert.equal(counts.total, counts.supplement + counts.pending,
    'total 必须等于"待补充 + 待交割"（待补样品是待补充的子集，不重复加；已两清不是待办）');
  for (const [label, value, section] of [
    ['待补充', counts.supplement, 'supplement'],
    ['待补样品', counts.sample, 'supplement'],
    ['待交割', counts.pending, 'pending'],
  ]) {
    assert.ok(value <= counts.total, `${label} 不该超过 total`);
    if (section === 'supplement') assert.ok(counts.sample <= counts.supplement, '待补样品 ⊆ 待补充');
  }
  // ③ 文案里的每个数字 = counts 里那个数（**逐字**，不是"大概对"）
  const dir = tempDir('invariant');
  const sent = [];
  const service = createSamplePendingNoticeService({
    settings: resolveSamplePendingNoticeConfig({}),
    store: new JsonTaskStore({ dir, idField: 'task_id' }),
    listOrders: async () => ({ orders }),
    send: async (text) => { sent.push(text); return true; },
  });
  try {
    await service.send({ now: new Date('2026-10-12T09:00:00+08:00') });
  } finally { rmDir(dir); }
  assert.equal(sent[0],
    '待办还有 15 条：待补充 10 条 · 其中待补样品 8 条 · 待交割 5 条 → 去工作台处理');
  const numbers = sent[0].match(/\d+/g).map(Number);
  assert.deepEqual(numbers, [counts.total, counts.supplement, counts.sample, counts.pending],
    '文案里出现的 4 个数字必须依次 = total / 待补充 / 待补样品 / 待交割');
  // ④ 与**工作台页面**同一口径（⭐ 2026-10-17：前端**两段** —— 待补充并入待交割；
  //    通知仍三段，所以这里比的是"待补充 + 待交割 = 前端的待交割"）
  const front = await loadFrontendOrders();
  const sections = orders.map((order) => front.salesSectionOf(order));
  // 2026-10-28：已两清且无售后 ⇒ 离开交割单，也不进售后单。
  assert.equal(sections.filter((section) => section === 'pending').length, counts.supplement + counts.pending,
    '前端「待交割」= 通知的「待补充 + 待交割」');
  assert.equal(sections.filter((section) => section === 'settled').length, counts.afterSales,
    '已两清单离开交割单（通知仍单独计数）');
  assert.equal(sections.filter((section) => section === 'afterSales').length, 0,
    '前端不再有「售后单=已两清」列表');
  assert.equal(sections.filter((section) => section === 'supplement').length, 0,
    '🔴 前端不再有「待补充」段（她 2026-10-17 ✗）');
  assert.equal(orders.filter((order) => order.sample_pending).length, counts.sample, '待补样品一致');
});

// ── 前端模块（与既有工作台用例同一套复制做法）──────────────────────────────
async function loadFrontendOrders() {
  const WORKBENCH = path.join(__dirname, '../public/workbench');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-notice-front-'));
  const copy = (from, to, replacements = []) => {
    let source = fs.readFileSync(path.join(WORKBENCH, from), 'utf8');
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'", true]]);
  copy('config/orders.js', 'ordersConfig.mjs', [
    ["from './links.js'", "from './links.mjs'", true],
    ["from './query.js'", "from './query.mjs'", true],
  ]);
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/ui.js', 'ui.mjs', [["from './api-client.js'", "from './api-client.mjs'", true]]);
  copy('features/orders/index.js', 'orders.mjs', [
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
    ["from '../../config/orders.js'", "from './ordersConfig.mjs'"],
  ]);
  return import(pathToFileURL(path.join(dir, 'orders.mjs')).href);
}
