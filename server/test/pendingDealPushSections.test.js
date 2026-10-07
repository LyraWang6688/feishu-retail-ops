// 「待处理单推送：**按【预付 / 未付】分区**，每条补上「货号 + 尺码」」的验收用例
// （业务负责人 2026-10-07 拍板，逐字：「**只需要这些信息，按照预付和未付分区**」）。
//
// 这份文件盯的是**分区这件事本身**，逐字对照她的目标形状：
//   ⏰ 2026-10-07 最近 7 天未付 / 预付、尚未成交的销售单：2 笔
//      1. ·【预付】B26002-52 37码 · 待收 ¥128 · [深链]
//      2. ·【未付】6A637-7 43码 · 待收 ¥228 · [深链]
//   □ ① 按预付 / 未付**分成两个区块**；只有一类时**另一块连标题都不出现**；
//   □ ② 每条 = 单号 + 【预付/未付】 + 货号+尺码 + 待收金额 + 深链；
//   □ ③ 不显示"售出时间"（标注靠分区与行内标签体现）；
//   □ 配品没有尺码 → **绝不拼出「 码」**；缺货号/尺码 → **不留空壳**；
//   □ 保留：候选口径、待收金额口径、深链（含"缺深链"的既有处理）、按天去重与置顶；
//   □ 顺序 / 标题 / 行格式 / 分隔符都在配置里（逻辑里不写死中文）。
//
// ⚠️ 分区的**判据是行为编码**（`SALE_PREPAID` / `SALE_UNPAID`），不是「行为名称」——
//    名称是她在飞书里随手能改的文案，拿它当判据的话，改个名字分区就静默错位。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesGroupThreadLocator, messageKey } = require('../src/services/salesGroupThreadLocator');
const { LarkMessageLinkResolver } = require('../src/services/larkMessageLinkResolver');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_sections';
const DAY = new Date('2026-10-07T02:00:00.000Z'); // 北京 10:00

const PREPAID = {
  salesEntryRecordId: 'sale_prepaid', orderNo: 'XSD-P-1', tradeTypeCode: 'SALE_PREPAID',
  tradeTypeLabel: '预付', pendingAmount: 128, saleDate: '2026-10-06T00:00:00.000Z',
  items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '37' }],
};
const UNPAID = {
  salesEntryRecordId: 'sale_unpaid', orderNo: 'XSD-U-1', tradeTypeCode: 'SALE_UNPAID',
  tradeTypeLabel: '未付', pendingAmount: 228, saleDate: '2026-10-06T00:00:00.000Z',
  items: [{ kind: 'shoe', itemNo: '6A637-7', size: '43' }],
};

const fakeClient = (messageIds = ['om_push_1', 'om_push_2']) => {
  const creates = [];
  let created = 0;
  const client = {
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          const message_id = messageIds[Math.min(created, messageIds.length - 1)];
          created += 1;
          return { code: 0, data: { message_id } };
        },
        reply: async () => { throw new Error('本推送必须发到主聊天，不许 reply 到话题里'); },
      },
    },
  };
  return { client, creates };
};

// 记录置顶调用的假置顶服务（真实现那份的用例在 pendingDealPushPin.test.js）。
const fakePin = () => {
  const calls = [];
  return {
    calls,
    pinLatest: async ({ messageId, chatId, day }) => {
      calls.push({ messageId, chatId, day });
      return { pinned: true, reason: 'pinned', previousMessageId: '' };
    },
  };
};

const textOf = (create) => JSON.parse(create.data.content).text;

const newService = ({
  orders = [], settings: overrides = {}, locator, client, store, chatId = CHAT_ID, pin,
} = {}) => {
  const resolvedSettings = { ...resolvePendingDealPushConfig({}), enabled: true, ...overrides };
  const { client: defaultClient, creates } = fakeClient();
  const usedClient = client || defaultClient;
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    secondDelivery: {
      client: usedClient,
      // ⚠️ 本服务的候选**只能**从这儿来；分区不许自己去找单。
      listPendingDeliveries: async ({ includeItems } = {}) => {
        assert.equal(includeItems, true, '货号尺码要靠 includeItems 拿（不额外读一遍销售明细）');
        return orders;
      },
    },
    locator: locator || new SalesGroupThreadLocator({ store: tmpStore('pending-sections-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client: usedClient,
    chatId,
    store: store || tmpStore('pending-sections-day-'),
    pin: pin || fakePin(),
  });
  return { service, creates };
};

const seed = async (locator, { salesEntryRecordId, messageId, appLink = '' }) => {
  await locator.rememberSaleThread({
    salesEntryRecordId, messageId, threadId: `omt_${messageId}`, orderNo: '', chatId: CHAT_ID,
  });
  if (appLink) await locator.store.update(messageKey(messageId), { app_link: appLink });
};

const withLinks = async (orders) => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-sections-link-') });
  for (const order of orders) {
    await seed(locator, {
      salesEntryRecordId: order.salesEntryRecordId,
      messageId: `om_${order.salesEntryRecordId}`,
      appLink: `https://applink.feishu.cn/client/message/link?message_id=om_${order.salesEntryRecordId}`,
    });
  }
  return locator;
};

// ─────────────────────────────────────────────────────────────────────────────
// 一、两个区块：各自渲染、顺序、空区块不出现
// ─────────────────────────────────────────────────────────────────────────────

test('两区各自渲染：预付在前、未付在后；每块有自己的标题与计数', async () => {
  const orders = [UNPAID, PREPAID]; // 故意把未付放前面：顺序只由配置决定，不按候选顺序
  const locator = await withLinks(orders);
  const { service, creates } = newService({ orders, locator });
  const result = await service.sendDailyPush({ now: DAY });

  assert.equal(result.pushedOrderCount, 2);
  assert.equal(creates.length, 1);
  const text = textOf(creates[0]);
  assert.equal(text, [
    '⏰ 2026-10-07 最近 7 天未付 / 预付、尚未成交的销售单：2 笔（【预付】1 笔 / 【未付】1 笔）',
    '【预付】1 笔',
    '1. XSD-P-1 【预付】 · B26002-52 37码 · 待收 ¥128.00 · https://applink.feishu.cn/client/message/link?message_id=om_sale_prepaid',
    '【未付】1 笔',
    '1. XSD-U-1 【未付】 · 6A637-7 43码 · 待收 ¥228.00 · https://applink.feishu.cn/client/message/link?message_id=om_sale_unpaid',
  ].join('\n'));
  // ③ 她明确不要"售出时间"：正文里不许出现日期之外的时间段/时间标签。
  assert.doesNotMatch(text, /售出|成交时间|销售日/);
});

test('只有一类单时：另一个区块**连标题都不出现**', async () => {
  const prepaidOnly = await withLinks([PREPAID]);
  const unpaidOnly = await withLinks([UNPAID]);

  const first = newService({ orders: [PREPAID], locator: prepaidOnly });
  const firstResult = await first.service.sendDailyPush({ now: DAY });
  const firstText = textOf(first.creates[0]);
  assert.equal(firstResult.pushedOrderCount, 1);
  assert.match(firstText, /（【预付】1 笔）/, '表头只报出现过的区块');
  assert.match(firstText, /\n【预付】1 笔\n/);
  assert.doesNotMatch(firstText, /【未付】/);

  const second = newService({ orders: [UNPAID], locator: unpaidOnly });
  const secondResult = await second.service.sendDailyPush({ now: DAY });
  const secondText = textOf(second.creates[0]);
  assert.equal(secondResult.pushedOrderCount, 1);
  assert.match(secondText, /（【未付】1 笔）/);
  assert.doesNotMatch(secondText, /【预付】/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、每条：货号 + 尺码（多件 / 配品 / 缺数据）
// ─────────────────────────────────────────────────────────────────────────────

test('一单多件：逐件列出（用配置的分隔符）；配品没有尺码 → **不拼「码」**', async () => {
  const order = {
    ...UNPAID,
    items: [
      { kind: 'shoe', itemNo: 'B26002-52', size: '37' },
      { kind: 'accessory', itemNo: '腰带', size: '' },
      { kind: 'shoe', itemNo: '6A637-7', size: '43' },
    ],
  };
  const locator = await withLinks([order]);
  const { service, creates } = newService({ orders: [order], locator });
  await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);

  assert.match(text, /1\. XSD-U-1 【未付】 · B26002-52 37码、腰带、6A637-7 43码 · 待收 ¥228\.00/);
  // 🔴 配品没有尺码：绝不许拼出「腰带 码」/「腰带码」这种残句。
  assert.doesNotMatch(text, /腰带\s*码/);
  // 尺码后缀只跟在真实尺码后面（三件里只有两件有尺码）。
  assert.equal(text.match(/码/g).length, 2);
});

test('缺货号 / 缺尺码：**不留空壳**（不出现「 码」、不出现空的分隔段），金额与深链照旧', async () => {
  const orders = [
    { ...PREPAID, items: [] }, // 一件都取不到货号
    { ...UNPAID, items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '' }] }, // 有货号没尺码
  ];
  const locator = await withLinks(orders);
  const { service, creates } = newService({ orders, locator });
  await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);

  assert.equal(text, [
    '⏰ 2026-10-07 最近 7 天未付 / 预付、尚未成交的销售单：2 笔（【预付】1 笔 / 【未付】1 笔）',
    '【预付】1 笔',
    '1. XSD-P-1 【预付】 · 待收 ¥128.00 · https://applink.feishu.cn/client/message/link?message_id=om_sale_prepaid',
    '【未付】1 笔',
    '1. XSD-U-1 【未付】 · B26002-52 · 待收 ¥228.00 · https://applink.feishu.cn/client/message/link?message_id=om_sale_unpaid',
  ].join('\n'));
  assert.doesNotMatch(text, /·\s+·/, '不许留下空的分隔段');
  assert.doesNotMatch(text, /\s码/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、深链缺失：既有行为不变
// ─────────────────────────────────────────────────────────────────────────────

test('缺深链：行内不出现链接段（也不留空分隔符），脚注 + missingLinkCount 照旧', async () => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-sections-nolink-') });
  await seed(locator, { salesEntryRecordId: 'sale_prepaid', messageId: 'om_p' }); // 无 app_link → 拿不到
  const { service, creates } = newService({ orders: [PREPAID, UNPAID], locator });
  const result = await service.sendDailyPush({ now: DAY });

  const text = textOf(creates[0]);
  assert.equal(result.missingLinkCount, 2);
  assert.equal(result.pushedOrderCount, 2, '深链缺失不影响"照推"（默认 linkRequired=false）');
  assert.match(text, /1\. XSD-P-1 【预付】 · B26002-52 37码 · 待收 ¥128\.00$/m);
  assert.match(text, /2 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales\.pending_deal_push\.link\.missing/);
  assert.doesNotMatch(text, /https?:\/\//);
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、分区判据 = 行为编码（不是行为名称），并且绝不静默丢单
// ─────────────────────────────────────────────────────────────────────────────

test('分区看行为**编码**：名称被人改过（"未付销售"）也照样分进预付区', async () => {
  const order = { ...PREPAID, tradeTypeLabel: '未付销售' }; // 名称被改得跟编码不一致
  const locator = await withLinks([order]);
  const { service, creates } = newService({ orders: [order], locator });
  await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);
  assert.match(text, /【预付】1 笔/);
  assert.match(text, /1\. XSD-P-1 【预付】 ·/);
  assert.doesNotMatch(text, /【未付】/);
});

test('编码不在已声明区块里：落进兜底块（**宁可多显示一块，也不让单消失**）', async () => {
  const order = { ...UNPAID, salesEntryRecordId: 'sale_x', orderNo: 'XSD-X-9', tradeTypeCode: 'SALE_SOMETHING_NEW' };
  const locator = await withLinks([order]);
  const { service, creates } = newService({ orders: [order], locator });
  const result = await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);
  assert.equal(result.pushedOrderCount, 1);
  assert.match(text, /（【其他】1 笔）/);
  assert.match(text, /1\. XSD-X-9 【其他】 · 6A637-7 43码 · 待收 ¥228\.00/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、配置先行：顺序 / 标题 / 行格式 / 分隔符都可配；写错当场抛错
// ─────────────────────────────────────────────────────────────────────────────

test('配置可配：换个 env 就换一套顺序、标题、行格式与分隔符（逻辑里没写死）', async () => {
  const settings = resolvePendingDealPushConfig({
    PENDING_DEAL_PUSH_ENABLED: 'true',
    PENDING_DEAL_PUSH_BLOCK_ORDER: 'unpaid,prepaid',
    PENDING_DEAL_PUSH_PREPAID_TITLE: '【定金】',
    PENDING_DEAL_PUSH_UNPAID_TITLE: '【赊账】',
    PENDING_DEAL_PUSH_LINE_SEPARATOR: ' | ',
    PENDING_DEAL_PUSH_LINE_PARTS: '{index}) {orderNo} {tag}|{item}|欠 {amount}|{link}',
    PENDING_DEAL_PUSH_ITEM_SEPARATOR: ' + ',
    PENDING_DEAL_PUSH_SIZE_TEMPLATE: '{size} 号',
    PENDING_DEAL_PUSH_SECTION_TEMPLATE: '{title} {count} 条\n{lines}',
    PENDING_DEAL_PUSH_HEADER_TEMPLATE: '🕘 {day} 共 {total} 条{blockCounts}',
  });
  assert.deepEqual(settings.blocks.map((block) => block.key), ['unpaid', 'prepaid'], '顺序可配');
  assert.equal(settings.blocks[0].title, '【赊账】');

  const locator = await withLinks([PREPAID, UNPAID]);
  const { service, creates } = newService({ orders: [PREPAID, UNPAID], locator, settings });
  await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);
  // ⚠️ 环境变量的值会被 `config/envValue` 去掉首尾空白（全仓同一套），
  //    所以分隔符写 ` | ` 取到的是 `|`；要带空格就把空格写进 `lineParts` 的模板里。
  assert.equal(settings.lineSeparator, '|');
  assert.equal(text, [
    '🕘 2026-10-07 共 2 条（【赊账】1 笔 / 【定金】1 笔）',
    '【赊账】 1 条',
    '1) XSD-U-1 【赊账】|6A637-7 43 号|欠 ¥228.00|https://applink.feishu.cn/client/message/link?message_id=om_sale_unpaid',
    '【定金】 1 条',
    '1) XSD-P-1 【定金】|B26002-52 37 号|欠 ¥128.00|https://applink.feishu.cn/client/message/link?message_id=om_sale_prepaid',
  ].join('\n'));
});

test('配置写错：未知占位符 / 没闭合的大括号 / 空的行模板 / 未知区块，都在**解析时**抛错', () => {
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_ITEM_TEMPLATE: '{itemNO} {size}' }),
    /无法识别的占位符 \{itemNO\}/,
  );
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_HEADER_TEMPLATE: '共 {total 笔' }),
    /没有闭合/,
  );
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_LINE_PARTS: '|  |' }),
    /至少要有一段/,
  );
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_BLOCK_ORDER: 'prepaid,refund' }),
    /没声明的区块「refund」/,
  );
  // 顺序里只写了一半：另一块**不消失**，补在后面（配置写漏不该让一类单静默少推）。
  const partial = resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_BLOCK_ORDER: 'unpaid' });
  assert.deepEqual(partial.blocks.map((block) => block.key), ['unpaid', 'prepaid']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 六、保留的那几件事：按天去重、置顶、主聊天
// ─────────────────────────────────────────────────────────────────────────────

test('分区改动不影响按天去重与置顶：同一天只发一条、置顶的就是那条，第二天照推', async () => {
  const orders = [PREPAID, UNPAID];
  const locator = await withLinks(orders);
  const { client, creates } = fakeClient(['om_day1', 'om_day2']);
  const pin = fakePin();
  const store = tmpStore('pending-sections-pin-day-');
  const { service } = newService({ orders, locator, client, pin, store, settings: { pinEnabled: true } });

  const first = await service.sendDailyPush({ now: DAY });
  assert.equal(first.pushedOrderCount, 2);
  assert.equal(first.pinned, true);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.receive_id_type, 'chat_id', '仍然发到群的主聊天');
  assert.equal(creates[0].data.reply_in_thread, undefined);
  assert.deepEqual(pin.calls, [{ messageId: 'om_day1', chatId: CHAT_ID, day: '2026-10-07' }]);

  const sameDay = await service.sendDailyPush({ now: new Date('2026-10-07T06:00:00.000Z') });
  assert.deepEqual(
    { skipped: sameDay.skipped, reason: sameDay.reason },
    { skipped: true, reason: 'already_ran_today' },
  );
  assert.equal(creates.length, 1, '同一天只许有一条消息');
  assert.equal(pin.calls.length, 1, '同一天不会重复置顶');

  const nextDay = await service.sendDailyPush({ now: new Date('2026-10-08T02:00:00.000Z') });
  assert.equal(nextDay.pushedOrderCount, 2, '跨天照推（只要还在窗口里）');
  assert.equal(creates.length, 2);
  assert.equal(pin.calls.length, 2);
});
