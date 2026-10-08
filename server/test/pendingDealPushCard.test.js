// 「9 点待处理单推送 = **消息卡片**」的验收用例（业务负责人 2026-10-08 口径）。
//
// 逐字口径：
//   「甲 **改成消息卡片**（`interactive`）—— · 单号**加粗**、类型用彩色标签、【待收金额】突出显示 ·
//    长链接改成「**查看原话**」这样的**文字链接**（URL 藏起来，不再占一行）· 分区块加分割线、
//    采购区单独一块 · 客户端不支持时降级成纯文本（可用飞书的 fallback）」
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……然后销售按照**预定和现货待收**分区」
//
// 本文件盯的是**这条消息长什么样**（验收标准 A1–A13；文本降级模板的逐字哨兵仍在
// pendingDealPush / pendingDealPushSections / pendingDealPushPurchaseSection 三个文件里）：
//   ① 卡片 JSON 结构（分区 / 分割线 / 文字链接 / 无裸 URL）
//   ② 行内容 = 货号 + 尺码 + 类型标签 + 待收金额 + 「查看原话」
//   ④ 待收 0 → 「已付清」；金额读不出来 → 整段不渲染
//   ⑤ 深链缺失 → 无链接段 + 脚注计数
//   ⑧ 降级：`format=text` 仍可读；卡片发不出去 → 自动改发纯文本（日志带真实 code/msg）
//   ⑨ 采购区为空不出现、有则一块
// 逐条对照见 docs/pending-push-card-and-retry-2026-10-08.md 第 4 节。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesGroupThreadLocator, messageKey } = require('../src/services/salesGroupThreadLocator');
const { LarkMessageLinkResolver } = require('../src/services/larkMessageLinkResolver');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { visibleCardText } = require('../src/utils/pendingDealPushCard');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_card';
const DAY = new Date('2026-10-08T02:00:00.000Z'); // 北京 10:00

const APP_LINK = 'https://applink.feishu.cn/client/message/link?message_id=om_sale_reserved';
const THREAD_LINK = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_x&open_thread_id=omt_x';

// 预定：还没交付（货还在店里 / 还没到），钱还欠着。她真机那笔的形状：JC002 40码。
const RESERVED = {
  salesEntryRecordId: 'sale_reserved', orderNo: 'XSD-P-1',
  tradeTypeLabel: '预定', fulfillmentStatus: '未交付',
  pendingAmount: 128, saleDate: '2026-10-07T00:00:00.000Z',
  items: [{ kind: 'shoe', itemNo: 'JC002', size: '40' }],
};
// 现货待收：货已经交付、钱还没结清。
const CASH_PENDING = {
  salesEntryRecordId: 'sale_cash_pending', orderNo: 'XSD-U-1',
  tradeTypeLabel: '现货', fulfillmentStatus: '已交付',
  pendingAmount: 228, saleDate: '2026-10-07T00:00:00.000Z',
  items: [{ kind: 'shoe', itemNo: '6A637-7', size: '43' }],
};

const settings = (overrides = {}) => ({
  ...resolvePendingDealPushConfig({}),
  enabled: true,
  chatId: CHAT_ID,
  linkLookupEnabled: false,
  linkRequired: false,
  ...overrides,
});

const fakeClient = (options = {}) => {
  const creates = [];
  const client = {
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          if (options.failInteractive && payload.data.msg_type === 'interactive') {
            throw options.failInteractive();
          }
          return { code: 0, data: { message_id: `om_${creates.length}` } };
        },
        reply: async () => { throw new Error('本推送必须发到主聊天，不许 reply 到话题里'); },
      },
    },
  };
  return { client, creates };
};

const fakePin = () => ({ pinLatest: async () => ({ pinned: false, reason: 'pin_disabled', previousMessageId: '' }) });

const fakeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => records[key] || [],
  get: async () => null,
  update: async () => ({}),
  create: async () => ({ recordId: 'x' }),
});

const newService = ({
  orders = [], records = {}, settings: overrides = {}, client: injected, locator, store,
  purchasePending,
} = {}) => {
  const { client, creates } = injected ? { client: injected, creates: injected.creates } : fakeClient();
  const service = new PendingDealPushService({
    settings: settings(overrides),
    secondDelivery: {
      client,
      listPendingDeliveries: async ({ includeItems } = {}) => {
        assert.equal(includeItems, true, '货号尺码要靠 includeItems 拿（不额外读一遍销售明细）');
        return orders;
      },
    },
    locator: locator || new SalesGroupThreadLocator({ store: tmpStore('pending-card-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store: store || tmpStore('pending-card-day-'),
    pin: fakePin(),
    scheduleRetry: () => ({}),
    purchasePending: purchasePending || new PurchasePendingBatchService({
      gateway: fakeGateway(records),
      batchLocator: new PurchaseBatchLocator({ store: tmpStore('pending-card-purchase-') }),
    }),
  });
  return { service, creates };
};

const withLinks = async (orders, { appLink = APP_LINK, batchNo } = {}) => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore(batchNo ? 'pending-card-pl-' : 'pending-card-sl-') });
  for (const order of orders) {
    await locator.rememberSaleThread({
      salesEntryRecordId: order.salesEntryRecordId,
      messageId: `om_${order.salesEntryRecordId}`,
      threadId: `omt_${order.salesEntryRecordId}`,
      orderNo: order.orderNo || '',
      chatId: CHAT_ID,
    });
    if (appLink) {
      await locator.store.update(messageKey(`om_${order.salesEntryRecordId}`), { app_link: appLink });
    }
  }
  return locator;
};

const cardOf = (create) => JSON.parse(create.data.content);
const elementsOf = (create) => cardOf(create).elements;
const textOf = (create) => JSON.parse(create.data.content).text;
// 卡片里"她看得见的字"（把 ** 与 text_tag / font 壳去掉，文字链接摊成「文案 URL」）。
const visibleOf = (create) => visibleCardText(cardOf(create));
// 把 markdown 链接的**目标**挖掉之后剩下的正文 —— 用来钉「不许有裸 URL」。
const withoutLinkTargets = (value) => String(value).replace(/\]\([^)]*\)/g, ']()');

// ─────────────────────────────────────────────────────────────────────────────
// ① 卡片结构：标题（含日期与总计）→ 区块 → 块间分割线 → 脚注
// ─────────────────────────────────────────────────────────────────────────────

test('① 发的是卡片（interactive）：标题含日期与总计、两区之间一条分割线、不带 update_multi', async () => {
  const orders = [RESERVED, CASH_PENDING];
  const locator = await withLinks(orders);
  const { service, creates } = newService({ orders, locator });

  const result = await service.sendDailyPush({ now: DAY });
  assert.equal(result.pushedOrderCount, 2);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.receive_id_type, 'chat_id');
  assert.equal(creates[0].data.receive_id, CHAT_ID);
  assert.equal(creates[0].data.reply_in_thread, undefined, '仍然发到群的主聊天，不进话题');
  assert.equal(creates[0].data.msg_type, 'interactive', '① 默认形态 = 消息卡片');

  const card = cardOf(creates[0]);
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.config.update_multi, undefined, '这张卡从不 patch ⇒ 刻意不带 update_multi');
  // 标题：日期 + 总计 + 分区计数（**两个区块**时才带）。
  assert.equal(card.header.template, 'blue');
  assert.equal(
    card.header.title.content,
    '⏰ 2026-10-08 最近 7 天待处理的销售单（预定 / 现货待收）：2 笔（【预定】1 笔 / 【现货待收】1 笔）',
  );
  // 结构：块标题 / 行 / hr / 块标题 / 行（首块之前与尾块之后都没有 hr）。
  assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'div', 'hr', 'div', 'div']);
  assert.equal(card.elements[0].text.content, '**【预定】1 笔**');
  assert.equal(card.elements[3].text.content, '**【现货待收】1 笔**');
  assert.equal(card.elements[0].text.tag, 'lark_md');
});

test('⑨ 采购区：为空时整块（含它前面那条分割线）都不出现；有候选时单独一块', async () => {
  const empty = newService({ orders: [RESERVED], locator: await withLinks([RESERVED]) });
  await empty.service.sendDailyPush({ now: DAY });
  const emptyCard = cardOf(empty.creates[0]);
  assert.deepEqual(emptyCard.elements.map((element) => element.tag), ['div', 'div']);
  assert.ok(!emptyCard.elements.some((element) => element.tag === 'hr'), '采购区为空 → 一条分割线都不该有');
  assert.ok(!emptyCard.elements.some((element) => element.tag === 'note'), '没有缺链接就不该有脚注');

  const records = {
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261008-0001', 到货状态: '未到货' } }],
    purchaseReport: [{ record_id: 'rep_1', fields: { 报货批次号: 'CGD-20261008-0001', 供应商: ['金猴'] } }],
  };
  const filled = newService({ orders: [], records });
  const filledResult = await filled.service.sendDailyPush({ now: DAY });
  assert.equal(filledResult.purchaseBatchCount, 1);
  const card = cardOf(filled.creates[0]);
  // 只有采购候选 ⇒ 没有销售表头（表头那句写的是"待处理的销售单"），块标题就是抬头。
  assert.equal(card.header, undefined);
  assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'div', 'note']);
  assert.equal(card.elements[0].text.content, '**【采购】未到货的报货批次：1 批**');
  // 这一批没有本地映射 ⇒ 那一行没有链接段（也不留空壳），并且计入脚注。
  assert.equal(card.elements[1].text.content, '1. CGD-20261008-0001 · 金猴');
  assert.match(card.elements[2].elements[0].content, /^（1 批的深链暂不可用/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 行内容：货号 + 尺码（加粗）+ 彩色类型标签 + 突出显示的待收金额 + 「查看原话」
// ─────────────────────────────────────────────────────────────────────────────

test('② 行内容逐字：加粗的货号+尺码 · 彩色类型标签 · 高亮待收 · [查看原话](深链)；**没有单号**、没有裸 URL', async () => {
  const { service, creates } = newService({ orders: [RESERVED], locator: await withLinks([RESERVED]) });
  await service.sendDailyPush({ now: DAY });

  const line = elementsOf(creates[0])[1].text.content;
  assert.equal(line, `1. **JC002 40码** · <text_tag color='blue'>【预定】</text_tag>`
    + ` · <font color='red'>待收 ¥128.00</font> · [查看原话](${APP_LINK})`);

  // 🔴 她明确说不需要单号。
  assert.ok(!JSON.stringify(cardOf(creates[0])).includes('XSD-P-1'), '卡片里不许出现单号');
  // ①② URL **只**藏在文字链接的 () 里，正文一个裸 URL 都没有。
  assert.ok(!/https?:\/\//.test(withoutLinkTargets(JSON.stringify(cardOf(creates[0])))),
    '卡片正文里不许有裸 URL');
  // 她看得见的字（降级文本与卡片在这套字样上逐字对齐）。
  assert.equal(visibleOf(creates[0]).split('\n')[2],
    `1. JC002 40码 · 【预定】 · 待收 ¥128.00 · 查看原话 ${APP_LINK}`);
});

test('② 一单多件逐件列出；配品没有尺码 → 不拼「码」，整件都在加粗段里', async () => {
  const order = {
    ...CASH_PENDING,
    items: [
      { kind: 'shoe', itemNo: '6A637-7', size: '43' },
      { kind: 'accessory', itemNo: '腰带', size: '' },
    ],
  };
  const { service, creates } = newService({ orders: [order], locator: await withLinks([order]) });
  await service.sendDailyPush({ now: DAY });
  const line = elementsOf(creates[0])[1].text.content;
  assert.match(line, /^1\. \*\*6A637-7 43码、腰带\*\*/);
  assert.ok(!/腰带\s*码/.test(line));
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 待收 0 → 「已付清」；金额读不出来 → 整段不渲染（绝不 ¥— / ¥0.00 / NaN）
// ─────────────────────────────────────────────────────────────────────────────

test('④ 待收 0 → 「已付清」；金额读不出来 → **整段不渲染**（不出现 ¥— / ¥0.00 / NaN）', () => {
  const { service } = newService({ orders: [] });
  const paidUp = service.buildCardLine({ ...CASH_PENDING, pendingAmount: 0 }, 0, '【现货待收】', 'orange');
  assert.ok(paidUp.join(' · ').includes('已付清'), paidUp.join(' · '));
  assert.ok(!paidUp.join(' · ').includes('待收 ¥'), '不许再渲染「待收 ¥0.00」');

  const unknown = service.buildCardLine({ ...CASH_PENDING, pendingAmount: null }, 0, '【现货待收】', 'orange');
  const unknownText = unknown.join(' · ');
  assert.ok(!unknownText.includes('¥'), `金额拿不到不许渲染占位：${unknownText}`);
  assert.ok(!unknownText.includes('NaN'));
  assert.equal(unknownText, `1. **6A637-7 43码** · <text_tag color='orange'>【现货待收】</text_tag>`,
    '空的金额段整段不要，也不留空的 · ');
  // 有深链时链接段照旧在（金额缺席不影响它）。
  assert.equal(
    service.buildCardLine({ ...CASH_PENDING, pendingAmount: null, url: APP_LINK }, 0, '【现货待收】', 'orange').join(' · '),
    `1. **6A637-7 43码** · <text_tag color='orange'>【现货待收】</text_tag> · [查看原话](${APP_LINK})`,
  );

  // 纯文本降级那边同一套口径（段序与卡片一致）。
  const text = service.buildLine({ ...CASH_PENDING, pendingAmount: null, url: '' }, 0, '【现货待收】');
  assert.equal(text, '1. 6A637-7 43码 · 【现货待收】');
  assert.equal(service.buildLine({ ...CASH_PENDING, pendingAmount: 0, url: '' }, 0, '【现货待收】'),
    '1. 6A637-7 43码 · 【现货待收】 · 已付清');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 深链缺失 → 无链接段 + 脚注计数
// ─────────────────────────────────────────────────────────────────────────────

test('⑤ 缺深链：行里不出现链接段（也不留空 ` · `），脚注 + missingLinkCount 照旧', async () => {
  const locator = await withLinks([RESERVED, CASH_PENDING], { appLink: '' });
  const { service, creates } = newService({ orders: [RESERVED, CASH_PENDING], locator });
  const result = await service.sendDailyPush({ now: DAY });

  assert.equal(result.missingLinkCount, 2);
  assert.equal(result.pushedOrderCount, 2, '缺深链不影响"照推"（默认 linkRequired=false）');
  const card = cardOf(creates[0]);
  const lines = card.elements.filter((element) => element.tag === 'div').map((element) => element.text.content);
  assert.match(lines[1], /^1\. \*\*JC002 40码\*\* · <text_tag color='blue'>【预定】<\/text_tag> · <font color='red'>待收 ¥128\.00<\/font>$/);
  assert.ok(!lines[1].includes(' · ' + ' · '));
  assert.ok(!JSON.stringify(card).includes('http'), '拿不到深链就一个 URL 都不许出现');
  const note = card.elements.find((element) => element.tag === 'note');
  assert.match(note.elements[0].content, /^（2 笔的深链暂不可用/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 降级：format=text（纯文本仍可读）；卡片发不出去 → 自动改发纯文本
// ─────────────────────────────────────────────────────────────────────────────

test('⑧ 降级：PENDING_DEAL_PUSH_MESSAGE_FORMAT=text → 发纯文本，内容仍可读（无单号、有「查看原话 + URL」）', async () => {
  const { service, creates } = newService({
    orders: [RESERVED], locator: await withLinks([RESERVED]), settings: { messageFormat: 'text' },
  });
  const result = await service.sendDailyPush({ now: DAY });
  assert.equal(creates[0].data.msg_type, 'text');
  assert.equal(result.messageFormat, 'text');
  const text = textOf(creates[0]);
  assert.equal(text, [
    '⏰ 2026-10-08 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔',
    '【预定】1 笔',
    `1. JC002 40码 · 【预定】 · 待收 ¥128.00 · 查看原话 ${APP_LINK}`,
  ].join('\n'));
  assert.ok(!text.includes('XSD-P-1'), '纯文本降级里也不出现单号');
});

test('⑧ 自动降级：卡片发不出去 ⇒ 用同一份纯文本兜底发一次，记 sent + degraded，日志带真实 code/msg', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let creates;
  try {
    const client = fakeClient({
      failInteractive: () => Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: {
            code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-1', method_id: 'method-1',
          },
        },
      }),
    });
    creates = client.creates;
    const store = tmpStore('pending-card-fallback-');
    const { service } = newService({
      orders: [RESERVED], locator: await withLinks([RESERVED]), client: client.client, store,
    });
    const result = await service.sendDailyPush({ now: DAY });

    assert.deepEqual(creates.map((create) => create.data.msg_type), ['interactive', 'text']);
    assert.equal(result.messageFormat, 'text');
    assert.equal(result.degraded, true);
    assert.equal(result.pushedOrderCount, 1);
    const day = await store.get('pending_deal_push_day_2026-10-08');
    assert.equal(day.sent, true, '兜底发出去了 = 今天发出去了，不许再重试（幂等）');
    assert.equal(day.degraded, true);
  } finally {
    console.warn = originalWarn;
  }
  const fallback = warnings.map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'sales.pending_deal_push.card.fallback');
  assert.ok(fallback, '卡片失败要留一条 fallback 日志');
  assert.equal(fallback.code, 1254607);
  assert.equal(fallback.msg, 'Data not ready, please try again later');
  assert.equal(fallback.log_id, 'log-1');
  assert.equal(fallback.method_id, 'method-1');
  assert.ok(!warnings.join('\n').includes('[object]'));
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 文案 nit：标题不再重复计数
// ─────────────────────────────────────────────────────────────────────────────

test('A2 只有一个区块时标题不再补分区计数（她真机看到的「5 笔（【预定】5 笔）」要消失）', async () => {
  const { service, creates } = newService({ orders: [RESERVED], locator: await withLinks([RESERVED]) });
  await service.sendDailyPush({ now: DAY });
  const title = cardOf(creates[0]).header.title.content;
  assert.equal(title, '⏰ 2026-10-08 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔');
  assert.ok(!title.includes('（【预定】1 笔）'), '一个区块时不重复计数');

  // 两个区块时计数仍然在（她要能一眼数出两块各几笔）。
  const both = newService({ orders: [RESERVED, CASH_PENDING], locator: await withLinks([RESERVED, CASH_PENDING]) });
  await both.service.sendDailyPush({ now: DAY });
  assert.match(cardOf(both.creates[0]).header.title.content, /（【预定】1 笔 \/ 【现货待收】1 笔）$/);
});

test('A5 深链缺失脚注仍然进卡片（note 元素），销售 / 采购各一行', async () => {
  const records = {
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261008-0001', 到货状态: '未到货' } }],
    purchaseReport: [],
  };
  const locator = await withLinks([RESERVED], { appLink: '' });
  const { service, creates } = newService({ orders: [RESERVED], records, locator });
  await service.sendDailyPush({ now: DAY });
  const note = elementsOf(creates[0]).find((element) => element.tag === 'note');
  const lines = note.elements[0].content.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^（1 笔的深链暂不可用/);
  assert.match(lines[1], /^（1 批的深链暂不可用/);
});
