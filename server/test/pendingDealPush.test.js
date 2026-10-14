/** ⚠️ 2026-10-12 旧断言改写（业务负责人改表名，Lead 定口径）：
 *  改前（逐字）：`'【采购】未到货的报货批次：{count} 批'`（以及渲染出来的同名文本）
 *  改后（逐字）：`'【采购】未到货的采购单：{count} 批'`
 *  理由：她把「报货批次」这张表改名成了「采购主表」；**用户可见文案**按 Lead 的口径用业务说法
 *        「采购单」（短、她看得懂）。⚠️ 只换了这一个词，其余断言（格式/数量/顺序）一条没放宽。
 *
 * ⚠️ 2026-10-14 第二次改写（**深链整体退场**，业务负责人逐字：「**现在深链已经没有了，
 *    把之前的清除掉**」）——逐条「改前 → 改后 → 依据」：
 *  ① `linkLookupEnabled: true` / `linkRequired: false` 两个配置键（严格全等那份）
 *     改前逐字：`linkLookupEnabled: true,` `linkRequired: false,`
 *     改后逐字：（两行删除）
 *     依据：她「现在深链已经没有了，把之前的清除掉」⇒ 深链开关没有读取点了。
 *  ② `lineParts` 改前逐字：`['{index}. {item}', '{tag}', '{amount}', '{link}']`
 *     改后逐字：`['{index}. {item}', '{tag}', '{amount}']`
 *     依据：同上（只去"点不动的链接"，其余各段一字不动）。
 *  ③ `purchaseLineParts` 改前逐字：末段 `'{link}'`；改后逐字：（该段删除）
 *  ④ `linkText: '查看话题'` / `linkTextTemplate: '{text} {url}'` /
 *     `footerTemplate: '（{count} 笔的深链暂不可用…）'` / `purchaseFooterTemplate: '（{count} 批的…）'`
 *     改前逐字：见上面四个键；改后逐字：（四行删除）
 *  ⑤ `card.lineParts` 末段 `'{link}'` / `card.linkTemplate: '[{text}]({url})'` /
 *     `card.buttonText: '查看话题'` ⇒ 改后逐字：（三处删除）
 *  ⑥ 「必须有链接」⇒「**必须没有**」的那几条：见本文件里
 *     `正常推：…一个链接都不出现` / `本地映射里存着话题深链时也**不出现**链接` /
 *     `linkRequired 已随深链删除` 三条。
 */
// 「维度 1：每天 9 点推最近 7 天**待处理**（预定 / 现货待收）的销售单」的验收用例。
//
// 这份文件盯的是**业务规则与口径**，不是实现细节：
//   □ 「哪些单」**复用**第二次交付那套筛选（这里只注入它，不重写候选口径）；
//   □ 每笔一行：【预定/现货待收】 + 货号 颜色 尺码 + 待收金额；发到**群的主聊天**
//     （不是话题、不引用任何消息）；
//   □ **按【预定 / 现货待收】分区**（2026-10-07 口径大改后）：区块顺序、标题、行格式全在 config；
//     分区那条口径自己的用例在 `pendingDealPushSections.test.js`（那里是逐字对照）；
//   □ 🔴 2026-10-14 起**推送里一个链接都不出现**（深链退场，她：「把之前的清除掉」），
//     但**每行的文字一字不变** —— 这是本文件里那三条"必须没有"的哨兵；
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
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig, readFlag } = require('../src/config/pendingDealPush');
// ⭐ 2026-10-08（第二步）：【团购券待结算】那块的口径真源（严格全等断言引用它的默认值，
//   不在本文件里抄第二份 —— 改一处就够）。
const { resolveVoucherSettlementConfig } = require('../src/config/voucherSettlement');
const { startShanghaiDailyScheduler, shanghaiHour } = require('../src/utils/shanghaiDailyScheduler');
// ⭐ 2026-10-08：默认形态改成**消息卡片**；本文件里那些"逐字"断言改盯**卡片里她看得见的字**
//   （去掉 ** / text_tag / font 壳，文字链接摊成「文案 URL」）—— 卡片结构本身由
//   `pendingDealPushCard.test.js` 逐元素钉住。
const { visibleCardText } = require('../src/utils/pendingDealPushCard');
// ⭐ 2026-10-08（第一步）：候选口径改成"逐件 / 逐条一行"之后，本文件里那些
//   "一大票单据"要翻译成**行**（`{ sections, rows, purchase }`）——
//   翻译器只做搬运，业务口径由 `pendingPushCandidateCaliber.test.js` 直接盯住。
const { fakeCandidates } = require('./helpers/pendingPushTestData');

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
  // 🔴 2026-10-14：`linkLookupEnabled` / `linkRequired` 两个深链开关**已从配置里删除**
  //   （她「现在深链已经没有了，把之前的清除掉」）—— 这里不再注入它们。
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

// 假的「第二次交付」服务：⭐ 2026-10-08（第一步）起**本链路不再问它要候选**
// （`listPendingDeliveries` 被成交提醒共用、一个字都不许改）——保留这个替身只用来证明
// "即使它还在，候选也不从它来"（`candidates` 才是入口）。
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

// 卡片里"她看得见的字"：`**` / `<text_tag>` / `<font>` 壳去掉。
const visibleOf = (create) => visibleCardText(JSON.parse(create.data.content));

// 卡片 JSON 里**所有按钮的跳转地址**（🔴 2026-10-14 起推送里应当**一个都没有**）。
const cardButtonUrls = (create) => JSON.parse(create.data.content).elements
  .flatMap((element) => (element.columns || []).flatMap((column) => column.elements))
  .filter((element) => element.tag === 'button')
  .flatMap((element) => (element.behaviors || []).map((behavior) => behavior.default_url || behavior.url || ''));

// 卡片 JSON 里**所有按钮的文案**（同上：推送里不该再有「查看话题」）。
const cardButtonTexts = (create) => JSON.parse(create.data.content).elements
  .flatMap((element) => (element.columns || []).flatMap((column) => column.elements))
  .filter((element) => element.tag === 'button')
  .map((element) => element.text?.content || '');

const newService = ({ orders, locator, client, settings: overrides = {}, store, chatId = CHAT_ID } = {}) => {
  const resolvedSettings = settings(overrides);
  const { client: defaultClient, creates } = fakeClient();
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    // ⚠️ 2026-10-08（第一步）：候选不再从 `secondDelivery` 来（那个方法被成交提醒共用、
    //    一个字都不许改）⇒ 注入**候选取数**的替身。
    candidates: fakeCandidates({ orders }),
    // ⚠️ 2026-10-14：`locator` / `resolver` 两个注入**已随深链删除**（本类不再认识它们）。
    //    `locator` 参数留着只为把本地映射**种进去**（证明"映射里有深链，推送里也不出现"）。
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
    // 🔴 2026-10-14：`linkLookupEnabled` / `linkRequired` 两个深链开关**整键删除**
    //   （改前逐字：`linkLookupEnabled: true,` `linkRequired: false,`）
    //   依据：她「现在深链已经没有了，把之前的清除掉」。
    // 「发出后置顶」是**显式开关、默认关**（2026-10-07 加）：断言仍然是严格全等，
    // 只是多认了一个键 —— 不是放宽。
    pinEnabled: false,
    // ⭐ 2026-10-08 加：发送形态（默认卡片）与失败重试窗口
    //（P0 起默认 = 每 10 分钟一次 × 6，由 config/pushRetry 的按天策略派生）。
    //    断言仍然是**严格全等**，只是把新增的默认值也钉进去 —— 不是放宽。
    messageFormat: 'card',
    retryDelaysMs: [600000, 1200000, 1800000, 2400000, 3000000, 3600000],
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
    // ⚠️ 2026-10-08：**去掉 `{orderNo}`**（她明确说不需要单号）。
    // 🔴 2026-10-14：**再去掉 `{link}`** ——
    //    改前逐字：`['{index}. {item}', '{tag}', '{amount}', '{link}']`
    //    改后逐字：`['{index}. {item}', '{tag}', '{amount}']`
    //    依据：她「现在深链已经没有了，把之前的清除掉」（只去链接，其余各段一字未动）。
    lineParts: ['{index}. {item}', '{tag}', '{amount}'],
    lineSeparator: ' · ',
    // ⭐ 2026-10-08 晚：货号与尺码**中间加颜色**（她：「还需要在货号和尺码中间加上颜色」）。
    itemTemplate: '{itemNo} {color} {size}',
    itemSeparator: '、',
    sizeTemplate: '{size}码',
    amountTemplate: '待收 {amount}',
    paidUpText: '已付清',
    // 🔴 2026-10-14：`linkText` / `linkTextTemplate` / `footerTemplate` 三个深链键**整键删除**
    //   （改前逐字：`linkText: '查看话题',` `linkTextTemplate: '{text} {url}',`
    //    `footerTemplate: '（{count} 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）',`）
    //   依据：她「现在深链已经没有了，把之前的清除掉」。
    // ⚠️ 2026-10-07 加「【销售】区 + 【采购】区」那批键：断言仍然是**严格全等**
    //    （多一个键就红），只是把新增的默认值也钉进去 —— 不是放宽。
    //    ⭐ `salesAreaTitle: ''` 是「销售区不额外多一行」的实现方式（空串 = 那一行不出现）。
    // ⭐ 2026-10-08（第二步）：大区多了一个 `voucher`（【团购券待结算】），默认顺序 =
    //    **销售 → 团购券待结算 → 采购**（她的口径：券那块放在销售两块之后、采购之前）。
    areas: ['sales', 'voucher', 'purchase'],
    salesAreaTitle: '',
    purchaseAreaTitle: '【采购】未到货的采购单：{count} 批',
    // 🔴 2026-10-14：采购行模板的末段 `'{link}'` 已删除 ——
    //    改前逐字：`['{index}. {batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}', '{link}']`
    //    改后逐字：`['{index}. {batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}']`
    //    依据：她「现在深链已经没有了，把之前的清除掉」。
    purchaseLineParts: [
      '{index}. {batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}',
    ],
    purchaseLineSeparator: ' · ',
    purchaseSupplierSeparator: '、',
    // 🔴 2026-10-14：`purchaseFooterTemplate` 整键删除
    //   （改前逐字：`'（{count} 批的深链暂不可用，见日志 sales.pending_deal_push.purchase_link.missing）'`）。
    // ── 卡片标记骨架（2026-10-08）──────────────────────────────────────────────
    card: {
      headerColor: 'blue',
      sectionTitleTemplate: '**{title}**',
      // 🔴 2026-10-14：末段 `'{link}'` 删除（改前逐字：`['{index}. {item}', '{tag}', '{amount}', '{link}']`）。
      lineParts: ['{index}. {item}', '{tag}', '{amount}'],
      lineSeparator: ' · ',
      itemTemplate: '**{item}**',
      tagTemplate: "<text_tag color='{color}'>{text}</text_tag>",
      amountTemplate: "<font color='{color}'>待收 {amount}</font>",
      amountColor: 'red',
      // 🔴 2026-10-14：`linkTemplate: '[{text}]({url})'` 与 `buttonText: '查看话题'`
      //   两个深链键**整键删除**（依据同上：深链退场）。
      // ⭐ 2026-10-08 晚：每行**两栏**（她拍板）—— 严格全等，新键也钉进来（不是放宽）。
      //    ⚠️ 2026-10-14 起销售 / 采购那两栏**只剩第 1 栏**（第 2 栏那颗跳深链的按钮没了）；
      //       `columnWeights` 仍被【团购券待结算】的回调按钮用着，所以键留着。
      rowTextParts: ['{item}', '{amount}'],
      rowTextSeparator: ' · ',
      missingItemText: '（未读到货号/尺码）',
      // ⭐ 2026-10-08 晚：采购那行新加的两个字段（报货日 / 录入数量）**读不到时的占位**。
      purchaseRowTextParts: ['{batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}'],
      missingReportedAtText: '（未读到）',
      missingQuantityText: '（未读到）',
      columnWeights: [4, 1],
      // ⭐ 2026-10-08（第二步）：【团购券待结算】那一行右栏「确认到账」按钮的配色。
      voucherButtonType: 'primary',
    },
    // ⭐ 2026-10-08（第二步）：【团购券待结算】那块的口径 —— **真源在 `config/voucherSettlement`**
    //    （天数 5 / 「待平台结算」/ 文案 / 按钮动作名 / 金额解析正则），这里只把它挂进整份配置。
    //    严格全等的断言用**那一份的默认值**（不在这里抄一遍，免得两处慢慢走歪）。
    voucher: resolveVoucherSettlementConfig({}),
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
// 三、🔴 深链解析器**已整体退场**（2026-10-14）
// ─────────────────────────────────────────────────────────────────────────────

test('深链解析器整个文件已删除（她：「现在深链已经没有了，把之前的清除掉」）', () => {
  // 「改前」：本文件原来有一整段 `LarkMessageLinkResolver` 的解析用例
  //   （存的优先 / 现查 `im.message.get` / 都没有就返回空 / 绝不自己拼 URL）。
  // 「改后」：改用例钉住**这个模块本体已经没了**（与私聊退场、`writeToSalesEntry` 退场同一套写法：
  //   留下的不是"删掉就不管"，而是"以后有人加回来就红"）。
  // 「依据」：业务负责人 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  assert.throws(
    () => require('../src/services/larkMessageLinkResolver'),
    { code: 'MODULE_NOT_FOUND' },
    '深链解析器不许被加回来：这条推送里已经没有链接了',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、每日推送本身
// ─────────────────────────────────────────────────────────────────────────────

test('正常推：按【预定 / 现货待收】分两块，每笔一行（标签 + 货号尺码 + 待收金额），发到群的主聊天', async () => {
  // ⚠️ 本地映射**故意种上深链**（app_link + thread_link）：证明"映射里就算有链接，推送里也不再出现"。
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
  // 分区：预定在前、现货待收在后。
  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
  //   改前逐字：`assert.match(text, /\n【预定】1 笔\nB26002-52 37码 · 待收 ¥1280\.00 \| 查看话题\n/);`
  //   改后逐字：`assert.match(text, /\n【预定】1 笔\nB26002-52 37码 · 待收 ¥1280\.00\n/);`
  //   依据：她「现在深链已经没有了，把之前的清除掉」——
  //        **行的文字一字不变**（B26002-52 37码 · 待收 ¥1280.00），少的只是 ` | 查看话题`；
  //        脚注那一行没了之后，最后一行就是正文的最后一行（所以末行断言用 `$`）。
  assert.match(text, /\n【预定】1 笔\nB26002-52 37码 · 待收 ¥1280\.00\n/);
  assert.match(text, /\n【现货待收】1 笔\n6A637-7 43码 · 待收 ¥300\.50$/);
  // 🔴 「必须没有」：两行**都不带**链接栏；卡片里一个跳转按钮都没有。
  //   改前逐字：`assert.doesNotMatch(text, /6A637-7 43码 · 待收 ¥300\.50 \| 查看话题/);`
  //            `assert.match(text, /1 笔的深链暂不可用/);`
  //            `assert.equal(result.missingLinkCount, 1);`
  //   改后逐字：见下面三条。
  assert.doesNotMatch(text, /查看话题/, '深链已退场：卡片上不该再有「查看话题」');
  assert.doesNotMatch(text, /深链暂不可用/, '那句脚注也一起退了（她：「把之前的清除掉」）');
  assert.doesNotMatch(text, /https?:\/\//, '推送里不该再有任何 URL');
  assert.deepEqual(cardButtonUrls(creates[0]), [], '销售行不再有 open_url 按钮（本地映射里明明种了深链）');
  assert.deepEqual(cardButtonTexts(creates[0]), [], '连按钮元素都不该有');
  assert.equal(result.missingLinkCount, undefined, '`missingLinkCount` 这个返回键已随深链删除');
});

test('本地只有【话题深链】（她给的格式拼的那条）时，推送里**照样不出现**链接', async () => {
  // 「改前」：这条用例叫「本地只有【话题深链】时，也照样带上链接」——
  //   断言 `| 查看话题` 那一栏在，并解析出按钮的 `default_url` 是 `client/thread/open?...`。
  // 「改后」：同一条链三环已按她 2026-10-14 的口径清掉 ⇒ 本地映射里**有**话题深链也不再被渲染。
  // 「依据」：她逐字「现在深链已经没有了，把之前的清除掉」。
  const { buildSalesThreadLink } = require('../src/config/salesThreadLink');
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-threadlink-') });
  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a', threadId: 'omt_a', orderNo: 'XSD-A-1' });
  // 飞书不回带 app_link（实测现状）→ 只有按她给的格式拼出来的 thread_link。
  await locator.store.update(messageKey('om_a'), {
    thread_link: buildSalesThreadLink({ chatId: CHAT_ID, threadId: 'omt_a' }),
  });

  const { service, creates } = newService({ orders: [ORDER_A], locator });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1, '照推（链接退场与"推不推"无关）');
  const text = visibleOf(creates[0]);
  // 行文字逐字保留（与"必须有链接"那版**同一串字**，只少了后面的链接栏）。
  assert.match(text, /【预定】1 笔\nB26002-52 37码 · 待收 ¥1280\.00/);
  assert.doesNotMatch(text, /查看话题/);
  assert.deepEqual(cardButtonUrls(creates[0]), [], '话题深链也不再渲成按钮');
  assert.doesNotMatch(text, /applink\.feishu\.cn/);
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

test('linkRequired 这个开关**已随深链删除**：就算传它，也不会再让推送"宁可不发"', async () => {
  // 「改前」逐字：`test('linkRequired=true 且拿不到深链：宁可不推，也不推一条点不开的清单', …)`
  //   （断言 `result.reason === 'link_unavailable'` 且 `creates.length === 0`）。
  // 「改后」：`linkRequired` 这个配置键已随深链整键删除 ⇒ 传它不再有任何效果；
  //   推送**照发**，而且行里没有任何链接（这正是她要的：货号尺码 + 金额本身就该看得见）。
  // 「依据」：她 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const locator = new SalesGroupThreadLocator({ store: tmpStore('pending-push-required-') });
  await seedMapping(locator, { salesEntryRecordId: 'sale_a', messageId: 'om_a' });
  const { service, creates } = newService({ orders: [ORDER_A], locator, settings: { linkRequired: true } });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, '', '不再有 link_unavailable 这条早退');
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(creates.length, 1, '照发');
  const text = visibleOf(creates[0]);
  assert.match(text, /B26002-52 37码 · 待收 ¥1280\.00/);
  assert.doesNotMatch(text, /查看话题/);
  assert.deepEqual(cardButtonUrls(creates[0]), []);
});

test('一笔单在本地映射里没有记录：照推货号 + 金额（现在**每一行**都是这样，没有链接）', async () => {
  // 「改前」逐字：`test('一笔单在本地映射里没有记录：照推货号 + 金额，只是没有深链', …)`
  //   ＋ `assert.equal(result.missingLinkCount, 1);`
  // 「改后」：链接整体退场 ⇒ 没有"缺链接"这个说法了（`missingLinkCount` 也返回 undefined）。
  // 「依据」：她 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const { service, creates } = newService({ orders: [ORDER_A] });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.missingLinkCount, undefined, '深链计数已随深链删除');
  const text = visibleOf(creates[0]);
  assert.match(text, /B26002-52 37码 · 待收 ¥1280\.00/);
  assert.doesNotMatch(text, /查看话题/);
});

test('金额读不出来时**整段不渲染**（不显示 ¥— / ¥0.00 / NaN）；一件货号尺码都没有时**不留残句**', () => {
  const { service } = newService({ orders: [] });
  const text = service.buildText({
    dayKey: '2026-10-06',
    // ⚠️ 2026-10-08 口径变更：金额读不出来时**不再**渲染 `¥—` 占位（业务负责人点名的 nit），
    //    而是整段不出现；`facts` 空 = 「货号 颜色 尺码」那一段也整段不出现 ——
    //    绝不能拼出 ` ·  · 待收 ¥—` 或 ` 码` 这种空壳。
    // ⚠️ 2026-10-08（第一步）：入口是**行**（`rows` + `sections`），不再是"单据"。
    // 🔴 2026-10-14：`missingLinkCount` 参数与行上的 `url` 已随深链删除，这里不再传。
    sections: service.buildSections([
      { rowId: 'd1', salesEntryRecordId: 'sale_x', criterion: 'undelivered', facts: [], pendingAmount: null },
    ]),
    rows: [
      { rowId: 'd1', salesEntryRecordId: 'sale_x', criterion: 'undelivered', facts: [], pendingAmount: null },
    ],
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
  assert.doesNotMatch(text, /查看话题/, '不要链接（深链已退场）');
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
