// 「维度 1：每天 9 点推最近 7 天**待处理**（预定 / 现货待收）的销售单」的验收用例。
//
// 这份文件盯的是**业务规则与口径**，不是实现细节：
//   □ 「哪些单」**复用**第二次交付那套筛选（这里只注入它，不重写候选口径）；
//   □ 每笔一行：单号 + 【预定/现货待收】 + 货号 尺码 + 待收金额 + 深链；发到**群的主聊天**
//     （不是话题、不引用任何消息）；
//   □ **按【预定 / 现货待收】分区**（2026-10-07 口径大改后）：区块顺序、标题、行格式全在 config；
//     分区那条口径自己的用例在 `pendingDealPushSections.test.js`（那里是逐字对照）；
//   □ 深链拿不到时**照推**（单号 + 金额本身就该看得见），并在文案里说清楚；
//   □ 同一天只推一次（跨天照推）；开关关着时连一条都不发；
//   □ 所有开关都是**显式布尔**：空串 = 关，不回退默认值（这是最容易静默坏掉的一条）；
//   □ 群 id 没配 → 不推，且**绝不**回落到发给某个人。
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
const { resolvePendingDealPushConfig, readFlag } = require('../src/config/pendingDealPush');
const { startShanghaiDailyScheduler, shanghaiHour } = require('../src/utils/shanghaiDailyScheduler');
// ⭐ 2026-10-08：默认形态改成**消息卡片**；本文件里那些"逐字"断言改盯**卡片里她看得见的字**
//   （去掉 ** / text_tag / font 壳，文字链接摊成「文案 URL」）—— 卡片结构本身由
//   `pendingDealPushCard.test.js` 逐元素钉住。
const { visibleCardText } = require('../src/utils/pendingDealPushCard');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_push';
const DAY_1_MORNING = new Date('2026-10-06T02:00:00.000Z'); // 北京 10:00，当天已过 9 点
const DAY_1_AFTERNOON = new Date('2026-10-06T06:00:00.000Z'); // 北京 14:00，同一天
const DAY_2_MORNING = new Date('2026-10-07T02:00:00.000Z'); // 北京 10:00，第二天

// ⚠️ 文案 / 模板的默认值**只有一处**（config/pendingDealPush）——这里不复制第二份，
//    先取一遍配置默认值再覆盖本文件关心的那几个键。
const settings = (overrides = {}) => ({
  ...resolvePendingDealPushConfig({}),
  enabled: true,
  chatId: CHAT_ID,
  hour: 9,
  intervalMs: 600000,
  linkLookupEnabled: false,
  linkRequired: false,
  ...overrides,
});

// 两笔单：一笔还没交付（预定）、一笔货已交付但钱没结清（现货待收）——
// 正好把「按履约状态分区」那条口径跑起来。
// `items` 是 2026-10-07 新要的「货号 + 尺码」事实（由 listPendingDeliveries 的 includeItems 给）；
// `fulfillmentStatus` 是**分区判据**（不是交易类型编码）。
const ORDER_A = {
  salesEntryRecordId: 'sale_a', orderNo: 'XSD-A-1', pendingAmount: 1280, saleDate: '2026-10-05T00:00:00.000Z',
  tradeTypeLabel: '预定', fulfillmentStatus: '未交付',
  items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '37' }],
};
const ORDER_B = {
  salesEntryRecordId: 'sale_b', orderNo: 'XSD-B-2', pendingAmount: 300.5, saleDate: '2026-10-06T00:00:00.000Z',
  tradeTypeLabel: '现货', fulfillmentStatus: '已交付',
  items: [{ kind: 'shoe', itemNo: '6A637-7', size: '43' }],
};

// 假的「第二次交付」服务：**只**提供本服务要复用的那一个方法 + 一个 client。
// 刻意不实现别的——本服务若偷偷绕过它自己筛单，这里会直接报错。
const fakeSecondDelivery = (orders = []) => ({
  client: { im: { message: { create: async () => ({ code: 0, data: { message_id: 'om_fallback' } }) } } },
  listPendingDeliveries: async () => orders,
});

// 记录的"发出去的那条消息"：create 与 reply **分开记**，因为本服务的硬要求是
// 「发到主聊天」= 只能走 create、不能带 reply_in_thread。
const fakeClient = (messageId = 'om_push_1') => {
  const creates = [];
  const client = {
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          return { code: 0, data: { message_id: messageId } };
        },
        reply: async () => {
          throw new Error('本推送必须发到主聊天，不许 reply 到话题里');
        },
      },
    },
  };
  return { client, creates };
};

const seedMapping = async (locator, { salesEntryRecordId, messageId, threadId = '', orderNo = '', appLink = '' }) => {
  await locator.rememberSaleThread({
    salesEntryRecordId, messageId, threadId, orderNo, chatId: CHAT_ID,
  });
  if (appLink) await locator.store.update(messageKey(messageId), { app_link: appLink });
};

// 卡片里"她看得见的字"：`**` / `<text_tag>` / `<font>` 壳去掉，`[文案](url)` 摊成 `文案 url`。
const visibleOf = (create) => visibleCardText(JSON.parse(create.data.content));

const newService = ({ orders, locator, client, settings: overrides = {}, store, chatId = CHAT_ID } = {}) => {
  const resolvedSettings = settings(overrides);
  const { client: defaultClient, creates } = fakeClient();
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    secondDelivery: fakeSecondDelivery(orders),
    locator: locator || new SalesGroupThreadLocator({ store: tmpStore('pending-push-mapping-') }),
    resolver: new LarkMessageLinkResolver({
      client: client || {},
      lookupEnabled: resolvedSettings.linkLookupEnabled,
    }),
    client: client || defaultClient,
    chatId,
    store: store || tmpStore('pending-push-day-'),
  });
  return { service, creates, settings: resolvedSettings };
};

// ─────────────────────────────────────────────────────────────────────────────
// 一、配置：显式布尔（空串 = 关，不回退默认值）
// ─────────────────────────────────────────────────────────────────────────────

test('开关是显式布尔：空串 = 关，不回退默认值；认不出来的值当场抛错', () => {
  assert.equal(readFlag({}, 'X', false), false, '没设 → 默认值');
  assert.equal(readFlag({}, 'X', true), true, '没设 → 默认值');
  // ⭐ 这条是核心：`|| 默认值` 的写法会在这里回退成 true，于是"清空变量关不掉"。
  assert.equal(readFlag({ X: '' }, 'X', true), false, '显式空串 = 关');
  assert.equal(readFlag({ X: 'false' }, 'X', true), false);
  assert.equal(readFlag({ X: '0' }, 'X', true), false);
  assert.equal(readFlag({ X: 'true' }, 'X', false), true);
  assert.equal(readFlag({ X: 'on' }, 'X', false), true);
  assert.throws(() => readFlag({ X: '也许吧' }, 'X', false), /显式布尔/);
});

test('配置默认值：默认关、9 点、10 分钟一 tick、没有群 id、没有置顶、没有任何拼链接的口子', () => {
  // ⚠️ 2026-10-07 加「分区 + 文案」那批键：断言仍然是**严格全等**（多一个键就红），
  //    只是把新增的默认值也钉进去 —— 不是放宽。
  assert.deepEqual(resolvePendingDealPushConfig({}), {
    enabled: false,
    chatId: '',
    hour: 9,
    intervalMs: 600000,
    linkLookupEnabled: true,
    linkRequired: false,
    // 「发出后置顶」是**显式开关、默认关**（2026-10-07 加）：断言仍然是严格全等，
    // 只是多认了一个键 —— 不是放宽。
    pinEnabled: false,
    // ⭐ 2026-10-08 加：发送形态（默认卡片）与失败重试窗口（默认 5/15 分钟）。
    //    断言仍然是**严格全等**，只是把新增的默认值也钉进去 —— 不是放宽。
    messageFormat: 'card',
    retryDelaysMs: [300000, 900000],
    // 分区顺序：预定在前、现货待收在后（理由见 pendingDealPushService 顶部注释）。
    // ⚠️ 每个区块多了一个 `tagColor`（卡片上那个**彩色类型标签**的颜色）—— 同样是严格全等。
    blocks: [
      { key: 'prepaid', criterion: 'undelivered', title: '【预定】', tagColor: 'blue' },
      { key: 'cash_pending', criterion: 'delivered_unpaid', title: '【现货待收】', tagColor: 'orange' },
    ],
    otherTitle: '【其他】',
    headerTemplate: '⏰ {day} 最近 7 天待处理的销售单（预定 / 现货待收）：{total} 笔{blockCounts}',
    blockCountsTemplate: '（{counts}）',
    blockCountTemplate: '{title}{count} 笔',
    blockCountSeparator: ' / ',
    sectionTemplate: '{title}{count} 笔\n{lines}',
    // ⚠️ 2026-10-08：**去掉 `{orderNo}`**（她明确说不需要单号）；金额与链接段各自可整段消失。
    lineParts: ['{index}. {item}', '{tag}', '{amount}', '{link}'],
    lineSeparator: ' · ',
    // ⭐ 2026-10-08 晚：货号与尺码**中间加颜色**（她：「还需要在货号和尺码中间加上颜色」）。
    itemTemplate: '{itemNo} {color} {size}',
    itemSeparator: '、',
    sizeTemplate: '{size}码',
    amountTemplate: '待收 {amount}',
    paidUpText: '已付清',
    linkText: '查看话题',
    linkTextTemplate: '{text} {url}',
    footerTemplate: '（{count} 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）',
    // ⚠️ 2026-10-07 加「【销售】区 + 【采购】区」那批键：断言仍然是**严格全等**
    //    （多一个键就红），只是把新增的默认值也钉进去 —— 不是放宽。
    //    ⭐ `salesAreaTitle: ''` 是「销售区不额外多一行」的实现方式（空串 = 那一行不出现）。
    areas: ['sales', 'purchase'],
    salesAreaTitle: '',
    purchaseAreaTitle: '【采购】未到货的报货批次：{count} 批',
    purchaseLineParts: ['{index}. {batchNo}', '{supplier}', '{link}'],
    purchaseLineSeparator: ' · ',
    purchaseSupplierSeparator: '、',
    purchaseFooterTemplate: '（{count} 批的深链暂不可用，见日志 sales.pending_deal_push.purchase_link.missing）',
    // ── 卡片标记骨架（2026-10-08）──────────────────────────────────────────────
    card: {
      headerColor: 'blue',
      sectionTitleTemplate: '**{title}**',
      lineParts: ['{index}. {item}', '{tag}', '{amount}', '{link}'],
      lineSeparator: ' · ',
      itemTemplate: '**{item}**',
      tagTemplate: "<text_tag color='{color}'>{text}</text_tag>",
      amountTemplate: "<font color='{color}'>待收 {amount}</font>",
      amountColor: 'red',
      linkTemplate: '[{text}]({url})',
      // ⭐ 2026-10-08 晚：每行**两栏**（她拍板）—— 严格全等，新键也钉进来（不是放宽）。
      rowTextParts: ['{item}', '{amount}'],
      rowTextSeparator: ' · ',
      missingItemText: '（未读到货号/尺码）',
      purchaseRowTextParts: ['{batchNo}', '{supplier}'],
      buttonText: '查看话题',
      columnWeights: [4, 1],
    },
  });
  assert.equal(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_HOUR: '7' }).hour, 7);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_HOUR: '25' }), /整数/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_INTERVAL_MS: '0' }), /整数/);
  assert.throws(() => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_ENABLED: '开' }), /显式布尔/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、本地映射反查：一笔销售 → 它当初那条群消息
// ─────────────────────────────────────────────────────────────────────────────

test('按销售单反查群消息映射：命中 / 查不到返回 null / 同一笔取最早那条', async () => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-lookup-') });
  assert.equal(await locator.findBySalesEntryRecordId(''), null, '空 id 不猜');
  assert.equal(await locator.findBySalesEntryRecordId('sale_a'), null, '没有映射就是 null，不是"最近一笔"');

  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a', threadId: 'omt_a', orderNo: 'XSD-A-1' });
  const hit = await locator.findBySalesEntryRecordId('sale_a');
  assert.equal(hit.message_id, 'om_a');
  assert.equal(hit.thread_id, 'omt_a');
  assert.equal(hit.order_no, 'XSD-A-1');

  // 同一笔销售落了两条（补记 / 重试）：取**最早**的那条 = 她当初说的那句话。
  await locator.store.create({
    task_id: messageKey('om_a_later'), kind: 'sales_group_thread', sales_entry_record_id: 'sale_a',
    message_id: 'om_a_later', thread_id: 'omt_a', created_at: '2026-10-06T12:00:00.000Z',
  });
  await locator.store.update(messageKey('om_a'), { created_at: '2026-10-01T00:00:00.000Z' });
  assert.equal((await locator.findBySalesEntryRecordId('sale_a')).message_id, 'om_a');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、深链解析：存的 → 现查；都没有就返回空（**绝不自己拼**）
// ─────────────────────────────────────────────────────────────────────────────

test('深链解析：本地存着的优先；现查能拿到就用现查的；都没有就返回空', async () => {
  const storedFirst = new LarkMessageLinkResolver({ lookupEnabled: true });
  assert.deepEqual(
    await storedFirst.resolve({ storedAppLink: 'https://stored/link', messageId: 'om_1' }),
    { url: 'https://stored/link', source: 'stored' },
  );

  const viaApi = new LarkMessageLinkResolver({
    client: { im: { message: { get: async () => ({ code: 0, data: { items: [{ message_app_link: 'https://api/link' }] } }) } } },
    lookupEnabled: true,
  });
  assert.deepEqual(await viaApi.resolve({ messageId: 'om_1' }), { url: 'https://api/link', source: 'message_get' });

  // 实测的现状：get 不返回这个字段 → 返回空。**没有模板可退**（那个口子已删）。
  const emptyApi = new LarkMessageLinkResolver({
    client: { im: { message: { get: async () => ({ code: 0, data: { items: [{ message_id: 'om_1' }] } }) } } },
    lookupEnabled: true,
  });
  assert.deepEqual(await emptyApi.resolve({ messageId: 'om_1' }), { url: '', source: 'unavailable' });
  // 🔴 曾经有第三级「运营自己填的 URL 模板」——2026-10-06 按业务负责人的话整个删掉了。
  //    这条用例钉住"删干净了"：构造参数里传 template 也不该有任何效果（代码里没人读它）。
  const legacyTemplateArg = new LarkMessageLinkResolver({
    client: { im: { message: { get: async () => ({ code: 0, data: { items: [] } }) } } },
    lookupEnabled: true,
    template: 'https://tpl/{chat_id}/{thread_id}/{message_id}',
  });
  assert.deepEqual(
    await legacyTemplateArg.resolve({ messageId: 'om_1', threadId: 'omt_1', chatId: 'oc_1' }),
    { url: '', source: 'unavailable' },
    '模板口子必须彻底不生效：要么真链接、要么空',
  );

  // 查挂了也不能把整轮推送带崩。
  const broken = new LarkMessageLinkResolver({ client: { im: { message: { get: async () => { throw new Error('boom'); } } } }, lookupEnabled: true });
  assert.deepEqual(await broken.resolve({ messageId: 'om_1' }), { url: '', source: 'unavailable' });
  // 关掉现查 → 一次远端调用都不发。
  const off = new LarkMessageLinkResolver({ client: { im: { message: { get: async () => { throw new Error('不该被调用'); } } } }, lookupEnabled: false });
  assert.deepEqual(await off.resolve({ messageId: 'om_1' }), { url: '', source: 'unavailable' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、每日推送本身
// ─────────────────────────────────────────────────────────────────────────────

test('正常推：按【预付 / 未付】分两块，每笔一行（单号 + 标签 + 货号尺码 + 待收金额 + 深链），发到群的主聊天', async () => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-push-') });
  await seedMapping(locator, {
    salesEntryRecordId: 'sale_a', messageId: 'om_a', threadId: 'omt_a', orderNo: 'XSD-A-1',
    appLink: 'https://applink.feishu.cn/client/message/link?message_id=om_a',
  });
  await seedMapping(locator, { salesEntryRecordId: 'sale_b', messageId: 'om_b', threadId: 'omt_b', orderNo: 'XSD-B-2' });

  const { service, creates } = newService({ orders: [ORDER_A, ORDER_B], locator });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });

  assert.equal(result.pushedOrderCount, 2);
  assert.equal(creates.length, 1);
  // 主聊天 = 走 create + receive_id_type=chat_id，**绝不能**带 reply_in_thread。
  assert.equal(creates[0].params.receive_id_type, 'chat_id');
  assert.equal(creates[0].data.receive_id, CHAT_ID);
  assert.equal(creates[0].data.reply_in_thread, undefined);
  // ⚠️ 2026-10-08 口径变更：默认形态从纯文本改成**消息卡片**。
  assert.equal(creates[0].data.msg_type, 'interactive');

  const text = visibleOf(creates[0]);
  // 表头：总数 2 笔（口径不变）＋ 分区计数（预定 1 / 现货待收 1）。
  assert.match(text, /^⏰ 2026-10-06 最近 7 天待处理的销售单（预定 \/ 现货待收）：2 笔（【预定】1 笔 \/ 【现货待收】1 笔）\n/);
  // 分区：预定在前、现货待收在后；每块里每行**两栏**（文字说明 + 「查看话题」按钮）。
  // ⚠️ 2026-10-08 晚她的口径：去掉单号、序号与彩色类型标签；类型由**区域标题**表达，
  //    深链放在按钮的 `default_url` 里（`visibleCardText` 把它摊成「文字栏 | 查看话题」）。
  assert.match(text, /\n【预定】1 笔\nB26002-52 37码 · 待收 ¥1280\.00 \| 查看话题\n/);
  assert.match(text, /\n【现货待收】1 笔\n6A637-7 43码 · 待收 ¥300\.50\n/);
  // 第 2 笔没有深链 → **只有文字栏**（不给点不动的按钮）；另起一行说明，不能编一条 URL 出来。
  assert.doesNotMatch(text, /6A637-7 43码 · 待收 ¥300\.50 \| 查看话题/);
  assert.match(text, /1 笔的深链暂不可用/);
  assert.equal(result.missingLinkCount, 1);
});

test('本地只有【话题深链】（她给的格式拼的那条）时，也照样带上链接', async () => {
  const { buildSalesThreadLink } = require('../src/config/salesThreadLink');
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-threadlink-') });
  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a', threadId: 'omt_a', orderNo: 'XSD-A-1' });
  // 飞书不回带 app_link（实测现状）→ 只有按她给的格式拼出来的 thread_link。
  await locator.store.update(messageKey('om_a'), {
    thread_link: buildSalesThreadLink({ chatId: CHAT_ID, threadId: 'omt_a' }),
  });

  const { service, creates } = newService({ orders: [ORDER_A], locator });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.missingLinkCount, 0, '话题深链也算链接，不该报"缺链接"');
  const text = visibleOf(creates[0]);
  assert.match(text, /\| 查看话题/, '有深链 ⇒ 按钮那栏在');
  // 深链现在放在**按钮的 default_url** 里（不再是正文里的文字链接）。
  const urls = JSON.parse(creates[0].data.content).elements
    .flatMap((element) => (element.columns || []).flatMap((column) => column.elements))
    .filter((element) => element.tag === 'button')
    .map((element) => element.behaviors[0].default_url);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /https:\/\/applink\.feishu\.cn\/client\/thread\/open\?open_chat_id=/);
  assert.match(urls[0], /open_thread_id=omt_a/);
});

test('按天认领：同一天推第二遍什么都不做，第二天照推', async () => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-day-claim-') });
  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a' });
  const store = tmpStore('pending-push-claim-store-');
  const { service, creates } = newService({ orders: [ORDER_A], locator, store });

  const first = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(first.pushedOrderCount, 1);

  const second = await service.sendDailyPush({ now: DAY_1_AFTERNOON });
  assert.deepEqual(
    { skipped: second.skipped, reason: second.reason, pushedOrderCount: second.pushedOrderCount },
    { skipped: true, reason: 'already_ran_today', pushedOrderCount: 0 },
  );
  assert.equal(creates.length, 1, '同一天只许有一条消息');

  const nextDay = await service.sendDailyPush({ now: DAY_2_MORNING });
  assert.equal(nextDay.pushedOrderCount, 1, '跨天照推（业务口径：只要还在窗口里就继续发）');
  assert.equal(creates.length, 2);
});

test('没有候选单：不发消息，并记下原因', async () => {
  const { service, creates } = newService({ orders: [] });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, 'no_pending_order');
  assert.equal(creates.length, 0);
});

test('没配群 id：不推、不回落到私聊，并记下原因', async () => {
  const { service, creates } = newService({ orders: [ORDER_A], chatId: '' });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, 'no_chat');
  assert.equal(creates.length, 0, '不知道发哪儿就一条都不发');
});

test('开关关着：一次远端调用都不发（兜底闸门，防止别处绕过定时器直接调）', async () => {
  const { service, creates } = newService({ orders: [ORDER_A], settings: { enabled: false } });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.deepEqual({ skipped: result.skipped, reason: result.reason }, { skipped: true, reason: 'disabled' });
  assert.equal(creates.length, 0);
});

test('linkRequired=true 且拿不到深链：宁可不推，也不推一条点不开的清单', async () => {
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-required-') });
  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a' });
  const { service, creates } = newService({ orders: [ORDER_A], locator, settings: { linkRequired: true } });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, 'link_unavailable');
  assert.equal(creates.length, 0);
});

test('一笔单在本地映射里没有记录：照推货号 + 金额，只是没有深链', async () => {
  const { service, creates } = newService({ orders: [ORDER_A], locator: new SalesGroupThreadLocator({ store: tmpStore('pending-push-nomap-') }) });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.missingLinkCount, 1);
  const text = visibleOf(creates[0]);
  assert.match(text, /B26002-52 37码 · 待收 ¥1280\.00/);
});

test('金额读不出来时**整段不渲染**（不显示 ¥— / ¥0.00 / NaN）；一件货号尺码都没有时**不留残句**', () => {
  const { service } = newService({ orders: [] });
  const text = service.buildText({
    dayKey: '2026-10-06',
    missingLinkCount: 0,
    // ⚠️ 2026-10-08 口径变更：金额读不出来时**不再**渲染 `¥—` 占位（业务负责人点名的 nit），
    //    而是整段不出现；`items` 空 = 「货号 尺码」那一段也整段不出现 ——
    //    绝不能拼出 ` ·  · 待收 ¥—` 或 ` 码` 这种空壳。
    orders: [{ orderNo: 'XSD-X', fulfillmentStatus: '未交付', pendingAmount: null, items: [], url: '' }],
  });
  assert.equal(text, [
    '⏰ 2026-10-06 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔',
    '【预定】1 笔',
    '1. 【预定】',
  ].join('\n'));
  assert.doesNotMatch(text, /NaN/);
  assert.doesNotMatch(text, /¥/);
  assert.doesNotMatch(text, /码/);
  assert.doesNotMatch(text, /XSD-X/, '不要单号');
  assert.doesNotMatch(text, / ·  · /);
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、定时器：北京时间的整点换算与"没过点不跑"
// ─────────────────────────────────────────────────────────────────────────────

test('东八区小时换算：UTC 01:00 = 北京 9 点（算错就是少推一天）', () => {
  assert.equal(shanghaiHour(new Date('2026-10-06T01:00:00.000Z')), 9);
  assert.equal(shanghaiHour(new Date('2026-10-06T00:59:00.000Z')), 8);
  assert.equal(shanghaiHour(new Date('2026-10-06T16:30:00.000Z')), 0, '跨日：北京时间已到第二天 0 点');
});

test('定时器：没过整点不跑；过了整点跑；参数非法当场抛错', async () => {
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const earlyCalls = [];
  let clock = Date.parse('2026-10-06T00:00:00.000Z'); // 北京 08:00
  const stopEarly = startShanghaiDailyScheduler({
    run: async () => earlyCalls.push('run'), eventPrefix: 'test.pending_push.early',
    hour: 9, intervalMs: 3600000, now: () => clock,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(earlyCalls.length, 0, '北京时间 8 点不该跑');
  stopEarly();

  const calls = [];
  clock = Date.parse('2026-10-06T01:00:00.000Z'); // 北京 09:00
  const stop = startShanghaiDailyScheduler({
    run: async () => calls.push('run'), eventPrefix: 'test.pending_push.on_time',
    hour: 9, intervalMs: 3600000, now: () => clock,
  });
  await waitFor(() => calls.length > 0);
  assert.equal(calls.length, 1);
  stop();

  assert.throws(() => startShanghaiDailyScheduler({ eventPrefix: 'x', hour: 9 }), /缺少 run/);
  assert.throws(() => startShanghaiDailyScheduler({ run: async () => {}, eventPrefix: 'x', hour: 24 }), /0~23/);
  assert.throws(() => startShanghaiDailyScheduler({ run: async () => {}, eventPrefix: 'x', hour: 9, intervalMs: -1 }), /intervalMs/);
});
