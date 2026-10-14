/** ⚠️ 2026-10-12 旧断言改写（业务负责人改表名，Lead 定口径）：
 *  改前（逐字）：`'【采购】未到货的报货批次：{count} 批'`（以及渲染出来的同名文本）
 *  改后（逐字）：`'【采购】未到货的采购单：{count} 批'`
 *  理由：她把「报货批次」这张表改名成了「采购主表」；**用户可见文案**按 Lead 的口径用业务说法
 *        「采购单」（短、她看得懂）。⚠️ 只换了这一个词，其余断言（格式/数量/顺序）一条没放宽。
 *
 * ⚠️ 2026-10-14 第二次改写（**深链整体退场**，业务负责人逐字：「**现在深链已经没有了，
 *    把之前的清除掉**」）——本文件里逐条的「改前 → 改后 → 依据」：
 *  ① 行（`column_set`）改前：**两栏**（文字说明 | 「查看话题」按钮，`open_url` 跳 `APP_LINK`）；
 *     改后：**只有第 1 栏文字**（不给点不动的按钮）。
 *  ② 脚注（`note` 元素）改前：`（N 笔的深链暂不可用…）` / `（N 批的…）`；改后：**整块不再出现**。
 *  ③ 纯文本降级行末段改前：` · 查看话题 <URL>`；改后：（该段删除）。
 *  ④ 「必须有链接」⇒「**必须没有**」的哨兵：见 ② ②/⑤/A5 三条 + ⑧ 的逐字文本。
 *  依据：她「现在深链已经没有了，把之前的清除掉」；**行的文字一字不变**，只去链接与那句脚注。
 */
// 「9 点待处理单推送 = **消息卡片**」的验收用例（业务负责人 2026-10-08 口径）。
//
// 逐字口径：
//   「甲 **改成消息卡片**（`interactive`）—— · 单号**加粗**、类型用彩色标签、【待收金额】突出显示 ·
//    长链接改成「**查看原话**」这样的**文字链接**（URL 藏起来，不再占一行）· 分区块加分割线、
//    采购区单独一块 · 客户端不支持时降级成纯文本（可用飞书的 fallback）」
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……然后销售按照**预定和现货待收**分区」
//   ⚠️ 上面那句"长链接"是 **2026-10-08 当时**的口径；2026-10-14 她已改口
//      「现在深链已经没有了，把之前的清除掉」⇒ 本文件里凡涉及链接的断言都按**没有链接**钉住。
//
// 本文件盯的是**这条消息长什么样**（验收标准 A1–A13；文本降级模板的逐字哨兵仍在
// pendingDealPush / pendingDealPushSections / pendingDealPushPurchaseSection 三个文件里）：
//   ① 卡片 JSON 结构（分区 / 分割线 / 无裸 URL / 无链接按钮）
//   ② 行内容 = 货号 + 颜色 + 尺码 + 待收金额（🔴 不再有类型标签、不再有链接）
//   ④ 待收 0 → 「已付清」；金额读不出来 → 整段不渲染
//   ⑤ 本地映射里有深链也**不渲染**（深链已退场）
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
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { resolvePushRetryConfig } = require('../src/config/pushRetry');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { visibleCardText } = require('../src/utils/pendingDealPushCard');
// ⭐ 2026-10-08（第一步）：候选口径变成"逐件 / 逐条一行" ⇒ 本文件里那些"单据对象"
//   统一由这个翻译器变成**行**（业务口径由 `pendingPushCandidateCaliber.test.js` 直接盯住）。
const { fakeCandidates, saleRowsFromOrders } = require('./helpers/pendingPushTestData');

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
  // 🔴 2026-10-14：`linkLookupEnabled` / `linkRequired` 已随深链从配置删除，不再注入。
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
  purchasePending, candidates, retrySettings, sleep,
} = {}) => {
  const { client, creates } = injected ? { client: injected, creates: injected.creates } : fakeClient();
  const service = new PendingDealPushService({
    settings: settings(overrides),
    // ⚠️ 2026-10-08（第一步）：候选**不再**从 `secondDelivery.listPendingDeliveries` 来
    //（那个方法被成交提醒共用、一个字都不许改）⇒ 注入候选取数的替身。
    candidates: candidates || fakeCandidates({ orders }),
    // ⚠️ 2026-10-14：`locator` / `resolver` 两个注入**已随深链删除**（本类不再认识它们）。
    //    上面的 `locator` 形参留着只是不改调用点 —— 传了也没用；它的用途只剩
    //    "把本地映射种进去，证明**映射里有深链、推送里也不出现**"（见 ② ⑤ 两条）。
    client,
    chatId: CHAT_ID,
    store: store || tmpStore('pending-card-day-'),
    pin: fakePin(),
    scheduleRetry: () => ({}),
    // ⚠️ 2026-10-08（P0）：本文件盯的是**卡片长什么样** ⇒ 默认把"瞬时错误小退避"关掉
    //    （`maxRetries: 0`），免得每次 `create` 都被重试 3 次、把 ⑧ 那条降级用例的计数与耗时搞乱。
    //    瞬时层本身由 `pendingDealPushRetry.test.js` 直接钉住。
    retrySettings: retrySettings || resolvePushRetryConfig({ PUSH_TRANSIENT_RETRY_MAX_RETRIES: '0' }),
    sleep: sleep || (async () => {}),
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
  // 结构：块标题 / 行（两栏 column_set）/ hr / 块标题 / 行（首块之前与尾块之后都没有 hr）。
  assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'column_set', 'hr', 'div', 'column_set']);
  assert.equal(card.elements[0].text.content, '**【预定】1 笔**');
  assert.equal(card.elements[3].text.content, '**【现货待收】1 笔**');
  assert.equal(card.elements[0].text.tag, 'lark_md');
});

test('⑨ 采购区：为空时整块（含它前面那条分割线）都不出现；有候选时单独一块', async () => {
  const empty = newService({ orders: [RESERVED], locator: await withLinks([RESERVED]) });
  await empty.service.sendDailyPush({ now: DAY });
  const emptyCard = cardOf(empty.creates[0]);
  assert.deepEqual(emptyCard.elements.map((element) => element.tag), ['div', 'column_set']);
  assert.ok(!emptyCard.elements.some((element) => element.tag === 'hr'), '采购区为空 → 一条分割线都不该有');
  // 🔴 2026-10-14：脚注（深链缺失提示）已随深链删除 ⇒ 这张卡**任何情况下**都不该有 note 元素。
  assert.ok(!emptyCard.elements.some((element) => element.tag === 'note'), '深链脚注已退场：不该有 note');

  const records = {
    // ⭐ 2026-10-09：供应商改从**批次行自己那一列**取（「信息填写」整表已删除）。
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261008-0001', 到货状态: '未到货', 供应商: [{ text: '金猴' }] } }],
  };
  const filled = newService({
    orders: [],
    records,
    // 采购候选也走**同一条候选入口**（真实口径由 PurchasePendingBatchService 取，
    // 这里只喂一条"批次 + 供应商"的行给渲染层）。
    candidates: fakeCandidates({
      purchase: [{ batchNo: 'CGD-20261008-0001', suppliers: ['金猴'], reportedAt: '', quantity: '' }],
    }),
  });
  const filledResult = await filled.service.sendDailyPush({ now: DAY });
  assert.equal(filledResult.purchaseBatchCount, 1);
  const card = cardOf(filled.creates[0]);
  // 只有采购候选 ⇒ 没有销售表头（表头那句写的是"待处理的销售单"），块标题就是抬头。
  assert.equal(card.header, undefined);
  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
  //   改前逐字：`assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'column_set', 'note']);`
  //   改后逐字：`assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'column_set']);`
  //   依据：她「现在深链已经没有了，把之前的清除掉」⇒ 那条（N 批的深链暂不可用…）脚注没了。
  assert.deepEqual(card.elements.map((element) => element.tag), ['div', 'column_set']);
  assert.equal(card.elements[0].text.content, '**【采购】未到货的采购单：1 批**');
  // 采购行：**只出第 1 栏**（原来的「查看话题」按钮已随深链删除），行文字照旧。
  const row = card.elements[1];
  assert.equal(row.tag, 'column_set');
  assert.equal(row.columns.length, 1, '深链已退场 ⇒ 只有第 1 栏文字');
  // ⭐ 2026-10-08 晚：采购那行末尾加了她点名的两样（报货日 + 录入数量）；
  //    这一批没填过那两列 ⇒ 给占位（**不编值**、也不让这一行消失）。
  assert.equal(row.columns[0].elements[0].text.content,
    'CGD-20261008-0001 · 金猴 · 报货日 （未读到） · 录入数量 （未读到）');
  // 🔴 「必须没有」：整张卡里一个 URL / 一个按钮 / 一句脚注都不许有。
  assert.ok(!JSON.stringify(card).includes('http'), '一个 URL 都不许出现');
  assert.ok(!card.elements.some((element) => element.tag === 'note'), '脚注已退场');
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 行内容：货号 + 颜色 + 尺码（加粗）+ 突出显示的待收金额（🔴 不再有链接）
// ─────────────────────────────────────────────────────────────────────────────

test('② 行内容逐字：**只有文字栏**（加粗货号+尺码 · 高亮待收）；**没有单号**、**没有链接按钮**、没有裸 URL', async () => {
  // 「改前」逐字（这条用例的旧名字与旧断言）：
  //   `test('② 行内容逐字：**两栏**（加粗货号+尺码 · 高亮待收 | 「查看话题」按钮跳深链）；**没有单号**、正文没有裸 URL', …)`
  //   `assert.equal(row.columns.length, 2, '第 1 栏文字说明 + 第 2 栏「查看话题」按钮');`
  //   `assert.equal(button.text.content, '查看话题');`
  //   `assert.deepEqual(button.behaviors, [{ type: 'open_url', default_url: APP_LINK }]);`
  //   `assert.deepEqual(buttonUrls, [APP_LINK], '深链只在按钮上出现一次');`
  //   `assert.equal(visibleOf(creates[0]).split('\n')[2], 'JC002 40码 · 待收 ¥128.00 | 查看话题');`
  // 「改后」：**第 2 栏（跳深链的按钮）整栏消失** —— 本地映射里明明种了 APP_LINK，
  //   渲染层也不再出按钮；行文字**一字不变**（`JC002 40码 · 待收 ¥128.00`）。
  // 「依据」：业务负责人 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const { service, creates } = newService({ orders: [RESERVED], locator: await withLinks([RESERVED]) });
  await service.sendDailyPush({ now: DAY });

  const elements = elementsOf(creates[0]);
  const row = elements[1];
  assert.equal(row.tag, 'column_set', '每行仍是一个 column_set（只是只剩一栏）');
  assert.equal(row.columns.length, 1, '🔴 只有第 1 栏文字说明（第 2 栏那颗跳深链的按钮已删）');
  assert.equal(row.columns[0].elements[0].text.content,
    "**JC002 40码** · <font color='red'>待收 ¥128.00</font>");
  // 类型由**区域标题**表达（行里不再有彩色标签）；区域标题仍在第一行。
  assert.equal(elements[0].text.content, '**【预定】1 笔**');
  assert.ok(!JSON.stringify(cardOf(creates[0])).includes('<text_tag'), '行里不再放类型彩色标签');

  // 🔴 她明确说不需要单号。
  assert.ok(!JSON.stringify(cardOf(creates[0])).includes('XSD-P-1'), '卡片里不许出现单号');
  // 🔴 「必须没有」：整张卡里一个按钮都没有，更没有 URL（`APP_LINK` 种在映射里也不许出现）。
  const buttons = elements
    .flatMap((element) => (element.columns || []).flatMap((column) => column.elements))
    .filter((element) => element.tag === 'button');
  assert.deepEqual(buttons, [], '深链已退场：一个按钮都不许有');
  assert.ok(!JSON.stringify(cardOf(creates[0])).includes('http'), '一个 URL 都不许出现');
  assert.ok(!JSON.stringify(cardOf(creates[0])).includes(APP_LINK.split('?')[0]), '连 applink 前缀都不许有');
  // 她看得见的字：行文字**逐字不变**，只是后面不再跟 ` | 查看话题`。
  assert.equal(visibleOf(creates[0]).split('\n')[2], 'JC002 40码 · 待收 ¥128.00');
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
  const line = elementsOf(creates[0])[1].columns[0].elements[0].text.content;
  assert.match(line, /^\*\*6A637-7 43码、腰带\*\*/);
  assert.ok(!/腰带\s*码/.test(line));
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 待收 0 → 「已付清」；金额读不出来 → 整段不渲染（绝不 ¥— / ¥0.00 / NaN）
// ─────────────────────────────────────────────────────────────────────────────

test('④ 待收 0 → 「已付清」；金额读不出来 → **整段不渲染**（不出现 ¥— / ¥0.00 / NaN）', () => {
  const { service } = newService({ orders: [] });
  // ⚠️ 2026-10-08（第一步）：`buildCardRow` 的入参是**行**（`{ facts, pendingAmount }`）。
  const rowOf = (order) => saleRowsFromOrders([order])[0];
  const paidUp = service.buildCardRow({ ...rowOf(CASH_PENDING), pendingAmount: 0 });
  assert.ok(paidUp.text.includes('已付清'), paidUp.text);
  assert.ok(!paidUp.text.includes('待收 ¥'), '不许再渲染「待收 ¥0.00」');

  const unknown = service.buildCardRow({ ...rowOf(CASH_PENDING), pendingAmount: null });
  assert.ok(!unknown.text.includes('¥'), `金额拿不到不许渲染占位：${unknown.text}`);
  assert.ok(!unknown.text.includes('NaN'));
  assert.equal(unknown.text, '**6A637-7 43码**',
    '空的金额段整段不要，也不留空的 · ');
  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
  //   改前逐字：`assert.equal(service.buildCardRow({ ...rowOf(CASH_PENDING), pendingAmount: null, url: APP_LINK }).url, APP_LINK);`
  //   改后逐字：`assert.equal(service.buildCardRow({ ...rowOf(CASH_PENDING), pendingAmount: null, url: APP_LINK }).url, undefined);`
  //   依据：她「现在深链已经没有了，把之前的清除掉」⇒ 行上再带 `url` 也不会被渲染。
  assert.equal(
    service.buildCardRow({ ...rowOf(CASH_PENDING), pendingAmount: null, url: APP_LINK }).url, undefined,
    '行里不再返回 url（深链退场）—— 渲染层因此不会出按钮',
  );
  // 货号/尺码读不出来 → 给占位，**绝不静默丢掉这一行**。
  const noItem = service.buildCardRow({ ...rowOf(CASH_PENDING), facts: [], pendingAmount: null });
  assert.match(noItem.text, /未读到货号\/尺码/);

  // 纯文本降级那边同一套口径（段序与卡片一致）。
  const text = service.buildLine({ ...rowOf(CASH_PENDING), pendingAmount: null, url: '' }, 0, '【现货待收】');
  assert.equal(text, '1. 6A637-7 43码 · 【现货待收】');
  assert.equal(service.buildLine({ ...rowOf(CASH_PENDING), pendingAmount: 0, url: '' }, 0, '【现货待收】'),
    '1. 6A637-7 43码 · 【现货待收】 · 已付清');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 本地映射里存着深链 ⇒ 推送里**一个链接都不出现**（深链已整体退场）
// ─────────────────────────────────────────────────────────────────────────────

test('⑤ 映射里存着深链也**不渲染**：只出文字栏、没有按钮、没有脚注；行文字一字不变', async () => {
  // 「改前」逐字（这条用例的旧名字与旧断言）：
  //   `test('⑤ 缺深链：那一行**只出文字栏**（不给点不动的按钮、也不留空壳），脚注 + missingLinkCount 照旧', …)`
  //   `assert.equal(result.missingLinkCount, 2);`
  //   `const note = card.elements.find((element) => element.tag === 'note');`
  //   `assert.match(note.elements[0].content, /^（2 笔的深链暂不可用/);`
  // 「改后」：这几条**整体反过来** —— 本文件原来用"本地映射里没有 app_link"造"缺深链"，
  //   现在改成"映射里**有** app_link"（`APP_LINK`）：链接数据在，渲染层也不再出按钮、不出脚注；
  //   `missingLinkCount` 这个返回键已随深链删除。
  // 「依据」：业务负责人 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const locator = await withLinks([RESERVED, CASH_PENDING]); // ⚠️ 这次给的是**有** app_link
  const { service, creates } = newService({ orders: [RESERVED, CASH_PENDING], locator });
  const result = await service.sendDailyPush({ now: DAY });

  assert.equal(result.missingLinkCount, undefined, '深链计数已随深链删除');
  assert.equal(result.pushedOrderCount, 2, '照推');
  const card = cardOf(creates[0]);
  const rows = card.elements.filter((element) => element.tag === 'column_set');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.columns.length, 1, '深链已退场 ⇒ 只出第 1 栏文字说明');
  }
  assert.equal(rows[0].columns[0].elements[0].text.content,
    "**JC002 40码** · <font color='red'>待收 ¥128.00</font>");
  assert.ok(!JSON.stringify(card).includes('http'), '映射里有深链也一个 URL 都不许出现');
  assert.ok(!JSON.stringify(card).includes('button'), '一个按钮都不许有');
  assert.equal(card.elements.find((element) => element.tag === 'note'), undefined, '脚注已退场');
  assert.ok(!visibleOf(creates[0]).includes('查看话题'));
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 降级：format=text（纯文本仍可读）；卡片发不出去 → 自动改发纯文本
// ─────────────────────────────────────────────────────────────────────────────

test('⑧ 降级：PENDING_DEAL_PUSH_MESSAGE_FORMAT=text → 发纯文本，内容仍可读（无单号、**无链接**）', async () => {
  const { service, creates } = newService({
    orders: [RESERVED], locator: await withLinks([RESERVED]), settings: { messageFormat: 'text' },
  });
  const result = await service.sendDailyPush({ now: DAY });
  assert.equal(creates[0].data.msg_type, 'text');
  assert.equal(result.messageFormat, 'text');
  const text = textOf(creates[0]);
  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
  //   改前逐字：末行 `'1. JC002 40码 · 【预定】 · 待收 ¥128.00 · 查看话题 ' + APP_LINK`
  //   改后逐字：末行 `'1. JC002 40码 · 【预定】 · 待收 ¥128.00'`
  //   依据：她「现在深链已经没有了，把之前的清除掉」—— 前面那三段文字一字不变。
  assert.equal(text, [
    '⏰ 2026-10-08 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔',
    '【预定】1 笔',
    '1. JC002 40码 · 【预定】 · 待收 ¥128.00',
  ].join('\n'));
  assert.ok(!text.includes('XSD-P-1'), '纯文本降级里也不出现单号');
  assert.ok(!text.includes('查看话题'), '纯文本降级里也不出现链接文案');
  assert.ok(!text.includes('http'), '纯文本降级里也不出现 URL');
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

test('A5 深链脚注**已退场**：销售 / 采购都在推，卡片里也一个 note 元素都没有', async () => {
  // 「改前」逐字（旧名字与旧断言）：`test('A5 深链缺失脚注仍然进卡片（note 元素），销售 / 采购各一行', …)`
  //   `const lines = note.elements[0].content.split('\n');`
  //   `assert.match(lines[0], /^（1 笔的深链暂不可用/);`
  //   `assert.match(lines[1], /^（1 批的深链暂不可用/);`
  // 「改后」：两句脚注随深链一起删掉 ⇒ **没有 note 元素**（销售 / 采购两个区都在，照样没有）。
  // 「依据」：业务负责人 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const records = {
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261008-0001', 到货状态: '未到货' } }],
  };
  const locator = await withLinks([RESERVED]);
  const { service, creates } = newService({
    orders: [RESERVED],
    records,
    locator,
    candidates: fakeCandidates({
      orders: [RESERVED],
      purchase: [{ batchNo: 'CGD-20261008-0001', suppliers: [], reportedAt: '', quantity: '' }],
    }),
  });
  await service.sendDailyPush({ now: DAY });
  const card = cardOf(creates[0]);
  assert.equal(card.elements.find((element) => element.tag === 'note'), undefined, '脚注整块退场');
  // 两个区都还在（销售 + 采购）—— 退场的是脚注，不是区。
  const titles = card.elements.filter((element) => element.tag === 'div').map((element) => element.text.content);
  assert.ok(titles.some((title) => title.includes('【预定】')), '销售区照旧');
  assert.ok(titles.some((title) => title.includes('【采购】')), '采购区照旧');
  assert.ok(!JSON.stringify(card).includes('深链暂不可用'));
});
