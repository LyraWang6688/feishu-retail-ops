// 「待处理单推送：**按【预定 / 现货待收】分区**，每条补上「货号 + 尺码」」的验收用例。
//
// 🔴 2026-10-07 口径大改：交易类型 = **库存有没有**（现货 / 预定），「未付」不再是类型 ⇒
//   · 候选源 = 「**预定（还没交付）**」＋「**现货但钱没结清**」= **尚未完成履约**；
//   · 分区判据从"交易类型编码"改成 **履约状态**（`pendingDealPushCriterionFor`）；
//   · 目标形状（`{title}` 由配置给）：
//       ⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：2 笔
//          1. ·【预定】B26002-52 37码 · 待收 ¥128
//          2. ·【现货待收】6A637-7 43码 · 待收 ¥228
//       🔴 2026-10-14：上面那两行末尾原来的 `[深链]` 段已按她「**现在深链已经没有了，
//          把之前的清除掉**」删掉 —— **行的文字一字不变**，只是不再有链接段 / 链接按钮 / 脚注。
//
// 逐字对照的验收标准见 `docs/sales-type-by-stock-2026-10-07.md` AC-6。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesGroupThreadLocator, messageKey } = require('../src/services/salesGroupThreadLocator');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { visibleCardText } = require('../src/utils/pendingDealPushCard');
// ⭐ 2026-10-08（第一步）：候选口径变成"逐件 / 逐条一行" ⇒ 这里的"单据对象"由翻译器变**行**；
//    ⚠️ **判据本身已经不在这里了** —— 现在长在**行**上、由取数那一处给
//    （`PendingPushCandidateService` + `config/pendingPushCandidates`），
//    逐条盯着它的用例在 `pendingPushCandidateCaliber.test.js`。
const { fakeCandidates } = require('./helpers/pendingPushTestData');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_sections';
const DAY = new Date('2026-10-07T02:00:00.000Z'); // 北京 10:00

// 预定：还没交付（货还在店里 / 还没到），钱还欠着。
const RESERVED = {
  salesEntryRecordId: 'sale_reserved', orderNo: 'XSD-P-1',
  tradeTypeLabel: '预定', fulfillmentStatus: '未交付',
  pendingAmount: 128, saleDate: '2026-10-06T00:00:00.000Z',
  items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '37' }],
};
// 现货待收：货已经交付、钱还没结清（新口径下这类单**必须**进候选）。
const CASH_PENDING = {
  salesEntryRecordId: 'sale_cash_pending', orderNo: 'XSD-U-1',
  tradeTypeLabel: '现货', fulfillmentStatus: '已交付',
  pendingAmount: 228, saleDate: '2026-10-06T00:00:00.000Z',
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

// ⭐ 2026-10-08：默认形态是**消息卡片**。
//   · `visibleOf` = 卡片里她看得见的字（去掉 ** / text_tag / font 壳）；
//   · `textOf`   = **降级纯文本**（只有 `messageFormat:'text'` 或卡片发送失败时才有这一份）。
const cardOf = (create) => JSON.parse(create.data.content);
const visibleOf = (create) => visibleCardText(cardOf(create));
const textOf = (create) => JSON.parse(create.data.content).text;

const newService = ({
  orders = [], settings: overrides = {}, locator, client, store, chatId = CHAT_ID, pin,
} = {}) => {
  const resolvedSettings = { ...resolvePendingDealPushConfig({}), enabled: true, ...overrides };
  const { client: defaultClient, creates } = fakeClient();
  const usedClient = client || defaultClient;
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    // ⚠️ 2026-10-08（第一步）：本服务的候选**只能**从这儿来；
    //    销售单 → 行的翻译在 helper 里，分区仍然是 `buildSections` 按行的 `criterion` 做。
    candidates: fakeCandidates({ orders }),
    // ⚠️ 2026-10-14：`locator` / `resolver` 两个注入**已随深链删除**（本类不再认识它们）；
    //    上面的 `locator` 形参留着只是不改调用点，用途只剩"把本地映射种进去"。
    client: usedClient,
    chatId,
    store: store || tmpStore('pending-sections-day-'),
    pin: pin || fakePin(),
    scheduleRetry: () => ({}),
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
// 〇、分区：按**行自己带的判据**分组（判据怎么来的在取数那一处，见 caliber 文件）
// ─────────────────────────────────────────────────────────────────────────────

test('〇 分组只看行自己的 criterion：undelivered → 预定区；delivered_unpaid → 现货待收区', () => {
  const { service } = newService({ orders: [] });
  const sections = service.buildSections([
    { rowId: 'r1', criterion: 'delivered_unpaid', facts: [] },
    { rowId: 'r2', criterion: 'undelivered', facts: [] },
  ]);
  // 顺序**只由配置决定**（行进来的先后不影响区块顺序）。
  assert.deepEqual(sections.map((section) => section.key), ['prepaid', 'cash_pending']);
  assert.deepEqual(sections[0].rows.map((row) => row.rowId), ['r2']);
  assert.deepEqual(sections[1].rows.map((row) => row.rowId), ['r1']);
  // 没有候选的区块**根本不在**（空块不出现）。
  const onlyUndelivered = service.buildSections([{ rowId: 'r2', criterion: 'undelivered', facts: [] }]);
  assert.deepEqual(onlyUndelivered.map((section) => section.key), ['prepaid']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 一、两个区块：各自渲染、顺序、空区块不出现
// ─────────────────────────────────────────────────────────────────────────────

test('两区各自渲染：预定在前、现货待收在后；每块有自己的标题与计数', async () => {
  const orders = [CASH_PENDING, RESERVED]; // 故意把现货待收放前面：顺序只由配置决定
  const locator = await withLinks(orders);
  const { service, creates } = newService({ orders, locator });
  const result = await service.sendDailyPush({ now: DAY });

  assert.equal(result.pushedOrderCount, 2);
  assert.equal(creates.length, 1);
  // ⭐ 2026-10-08 晚口径：每行**只有文字说明**（没有序号、没有类型标签）。
  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
  //   改前逐字：`'B26002-52 37码 · 待收 ¥128.00 | 查看话题'` / `'6A637-7 43码 · 待收 ¥228.00 | 查看话题'`
  //   改后逐字：`'B26002-52 37码 · 待收 ¥128.00'` / `'6A637-7 43码 · 待收 ¥228.00'`
  //   依据：她「现在深链已经没有了，把之前的清除掉」—— 前半段文字一字不变。
  assert.equal(creates[0].data.msg_type, 'interactive');
  const text = visibleOf(creates[0]);
  assert.equal(text, [
    '⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：2 笔（【预定】1 笔 / 【现货待收】1 笔）',
    '【预定】1 笔',
    'B26002-52 37码 · 待收 ¥128.00',
    '【现货待收】1 笔',
    '6A637-7 43码 · 待收 ¥228.00',
  ].join('\n'));
  assert.doesNotMatch(text, /查看话题/, '深链已退场：不该再有链接栏');
  assert.doesNotMatch(text, /https?:\/\//, '不该再有 URL');
  // ⭐ AC-6.3：现货已交付、钱没结清的单**进了候选**，并落在【现货待收】区。
  assert.match(text, /【现货待收】1 笔/);
  assert.doesNotMatch(text, /售出|成交时间|销售日/);
  assert.doesNotMatch(text, /未付/);
  // 🔴 她明确说不需要单号。
  assert.doesNotMatch(text, /XSD-/);
});

test('只有一类单时：另一个区块**连标题都不出现**，标题也不重复计数', async () => {
  const reservedOnly = await withLinks([RESERVED]);
  const cashOnly = await withLinks([CASH_PENDING]);

  const first = newService({ orders: [RESERVED], locator: reservedOnly });
  const firstResult = await first.service.sendDailyPush({ now: DAY });
  const firstText = visibleOf(first.creates[0]);
  assert.equal(firstResult.pushedOrderCount, 1);
  // ⚠️ 2026-10-08 文案 nit：**只有一个区块时不补分区计数**（她真机看到的
  //    「…：5 笔（【预定】5 笔）」把同一件事说了两遍）。
  assert.equal(firstText.split('\n')[0],
    '⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：1 笔');
  assert.match(firstText, /\n【预定】1 笔\n/);
  assert.doesNotMatch(firstText, /【现货待收】/);

  const second = newService({ orders: [CASH_PENDING], locator: cashOnly });
  const secondResult = await second.service.sendDailyPush({ now: DAY });
  const secondText = visibleOf(second.creates[0]);
  assert.equal(secondResult.pushedOrderCount, 1);
  assert.match(secondText, /：1 笔\n【现货待收】1 笔/);
  assert.doesNotMatch(secondText, /【预定】/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、每条：货号 + 尺码（多件 / 配品 / 缺数据）
// ─────────────────────────────────────────────────────────────────────────────

test('一单多件：逐件列出（用配置的分隔符）；配品没有尺码 → **不拼「码」**', async () => {
  const order = {
    ...CASH_PENDING,
    items: [
      { kind: 'shoe', itemNo: 'B26002-52', size: '37' },
      { kind: 'accessory', itemNo: '腰带', size: '' },
      { kind: 'shoe', itemNo: '6A637-7', size: '43' },
    ],
  };
  const locator = await withLinks([order]);
  const { service, creates } = newService({ orders: [order], locator });
  await service.sendDailyPush({ now: DAY });
  const text = visibleOf(creates[0]);

  assert.match(text, /B26002-52 37码、腰带、6A637-7 43码 · 待收 ¥228\.00/);
  assert.doesNotMatch(text, /腰带\s*码/);
  assert.equal(text.match(/码/g).length, 2);
});

test('缺货号 / 缺尺码：**不留空壳**（不出现「 码」、不出现空的分隔段），金额照旧', async () => {
  const orders = [
    { ...RESERVED, items: [] }, // 一件都取不到货号
    { ...CASH_PENDING, items: [{ kind: 'shoe', itemNo: 'B26002-52', size: '' }] }, // 有货号没尺码
  ];
  const locator = await withLinks(orders);
  const { service, creates } = newService({ orders, locator });
  await service.sendDailyPush({ now: DAY });
  const text = visibleOf(creates[0]);

  // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：两条期望值各去掉末尾的 ` | 查看话题`。
  //   改前逐字：`'（未读到货号/尺码） · 待收 ¥128.00 | 查看话题'` / `'B26002-52 · 待收 ¥228.00 | 查看话题'`
  //   改后逐字：`'（未读到货号/尺码） · 待收 ¥128.00'` / `'B26002-52 · 待收 ¥228.00'`
  assert.equal(text, [
    '⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：2 笔（【预定】1 笔 / 【现货待收】1 笔）',
    '【预定】1 笔',
    // 货号/尺码一件都取不到 ⇒ 给占位（**绝不静默丢掉这一行**），金额照旧
    '（未读到货号/尺码） · 待收 ¥128.00',
    '【现货待收】1 笔',
    'B26002-52 · 待收 ¥228.00',
  ].join('\n'));
  assert.doesNotMatch(text, /查看话题/);
  assert.doesNotMatch(text, /·\s+·/, '不许留下空的分隔段');
  assert.doesNotMatch(text, /\s码/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、🔴 深链已整体退场：本地映射里**有**链接也不渲染
// ─────────────────────────────────────────────────────────────────────────────

test('本地映射里明明有 app_link：行里不出现链接段（也不留空分隔符），没有脚注、没有按钮', async () => {
  // 「改前」逐字（这条用例的旧名字与旧断言）：
  //   `test('缺深链：行内不出现链接段（也不留空分隔符），脚注 + missingLinkCount 照旧', …)`
  //   `assert.equal(result.missingLinkCount, 2);`
  //   `assert.match(text, /2 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales\.pending_deal_push\.link\.missing/);`
  // 「改后」：反过来 —— 本地映射里**种上 app_link**，行里也一样不出现链接；
  //   脚注与 `missingLinkCount` 都随深链删除。
  // 「依据」：业务负责人 2026-10-14 逐字「现在深链已经没有了，把之前的清除掉」。
  const locator = await withLinks([RESERVED, CASH_PENDING]); // ⚠️ 这次映射里**有** app_link
  const { service, creates } = newService({ orders: [RESERVED, CASH_PENDING], locator });
  const result = await service.sendDailyPush({ now: DAY });

  const text = visibleOf(creates[0]);
  assert.equal(result.missingLinkCount, undefined, '深链计数已随深链删除');
  assert.equal(result.pushedOrderCount, 2, '照推');
  assert.match(text, /B26002-52 37码 · 待收 ¥128\.00$/m);
  assert.doesNotMatch(text, /深链暂不可用/, '那句脚注已退场');
  assert.doesNotMatch(text, /查看话题/);
  assert.doesNotMatch(text, /https?:\/\//);
  const card = cardOf(creates[0]);
  assert.equal(card.elements.find((element) => element.tag === 'note'), undefined, '没有脚注元素');
  assert.ok(!JSON.stringify(card).includes('button'), '一个按钮都不许有');
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、兜底：判据认不出来的单绝不静默消失
// ─────────────────────────────────────────────────────────────────────────────

test('判据认不出来（履约状态为空串之外的未知取值）→ 落进兜底块，绝不丢单', async () => {
  // 判据函数对未知取值一律按"还有货没交"处理 ⇒ 正常会进【预定】区。
  // 这里直接给一个**没有对应区块**的判据，验证兜底那一支（服务只认配置里声明的判据）。
  const order = { ...CASH_PENDING, salesEntryRecordId: 'sale_x', orderNo: 'XSD-X-9' };
  const locator = await withLinks([order]);
  // 把两个声明区块的判据都改掉 ⇒ 这一笔匹配不到任何区块，走兜底。
  const settings = { ...resolvePendingDealPushConfig({}), enabled: true };
  settings.blocks = settings.blocks.map((block) => ({ ...block, criterion: `unknown_${block.key}` }));
  const { service, creates } = newService({ orders: [order], locator, settings });
  const result = await service.sendDailyPush({ now: DAY });
  const text = visibleOf(creates[0]);
  assert.equal(result.pushedOrderCount, 1);
  assert.match(text, /：1 笔\n【其他】1 笔\n/);
  assert.match(text, /6A637-7 43码 · 待收 ¥228\.00/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、配置先行：顺序 / 标题 / 行格式 / 分隔符都可配；写错当场抛错
// ─────────────────────────────────────────────────────────────────────────────

test('配置可配：换个 env 就换一套顺序、标题、行格式与分隔符（逻辑里没写死）', async () => {
  const settings = resolvePendingDealPushConfig({
    PENDING_DEAL_PUSH_ENABLED: 'true',
    PENDING_DEAL_PUSH_BLOCK_ORDER: 'cash_pending,prepaid',
    PENDING_DEAL_PUSH_PREPAID_TITLE: '【定金】',
    PENDING_DEAL_PUSH_CASH_PENDING_TITLE: '【赊账】',
    PENDING_DEAL_PUSH_LINE_SEPARATOR: ' | ',
    // ⚠️ 2026-10-08：`{amount}` 给的是**整段**（`待收 ¥…` / `已付清`；读不出来整段没有），
    //    所以自定义行模板里不要再写「待收」。
    // 🔴 2026-10-14 改（「必须有链接」⇒「**必须没有**」）：
    //   改前逐字：`'{index}) {orderNo} {tag}|{item}|{amount}|{link}'`
    //   改后逐字：`'{index}) {orderNo} {tag}|{item}|{amount}'`
    //   （`{link}` 现在**是会抛错的未知占位符** —— 见下面"配置写错"那条用例钉住它）
    //   依据：她「现在深链已经没有了，把之前的清除掉」。
    PENDING_DEAL_PUSH_LINE_PARTS: '{index}) {orderNo} {tag}|{item}|{amount}',
    PENDING_DEAL_PUSH_ITEM_SEPARATOR: ' + ',
    PENDING_DEAL_PUSH_SIZE_TEMPLATE: '{size} 号',
    PENDING_DEAL_PUSH_SECTION_TEMPLATE: '{title} {count} 条\n{lines}',
    PENDING_DEAL_PUSH_HEADER_TEMPLATE: '🕘 {day} 共 {total} 条{blockCounts}',
  });
  assert.deepEqual(settings.blocks.map((block) => block.key), ['cash_pending', 'prepaid'], '顺序可配');
  assert.equal(settings.blocks[0].title, '【赊账】');

  const locator = await withLinks([RESERVED, CASH_PENDING]);
  // ⚠️ 2026-10-08：下面这批键（行模板 / 分隔符 / 尺码后缀 / 区块模板）是**降级纯文本**的旋钮
  //    —— 默认形态是卡片，所以这一条显式走 `messageFormat: 'text'`。
  //    卡片那套标记骨架可配性见 pendingDealPushCard.test.js。
  const { service, creates } = newService({
    orders: [RESERVED, CASH_PENDING], locator, settings: { ...settings, messageFormat: 'text' },
  });
  await service.sendDailyPush({ now: DAY });
  const text = textOf(creates[0]);
  // ⚠️ 环境变量的值会被 `config/envValue` 去掉首尾空白（全仓同一套），
  //    所以分隔符写 ` | ` 取到的是 `|`；要带空格就把空格写进 `lineParts` 的模板里。
  assert.equal(settings.lineSeparator, '|');
  // ⚠️ 2026-10-08（第一步）：行上**没有 `orderNo`**（她明确说不需要单号），
  //    所以即使行模板里写着 `{orderNo}`，那一段也是空的、被收掉。
  // 🔴 2026-10-14 改：末段 `|查看话题 <URL>` 整段删除（`{link}` 已从模板里去掉）。
  //   改前逐字：`'1) 【赊账】|6A637-7 43 号|待收 ¥228.00|查看话题 https://applink.feishu.cn/client/message/link?message_id=om_sale_cash_pending'`
  //   改后逐字：`'1) 【赊账】|6A637-7 43 号|待收 ¥228.00'`（【定金】那条同理）
  assert.equal(text, [
    '🕘 2026-10-07 共 2 条（【赊账】1 笔 / 【定金】1 笔）',
    '【赊账】 1 条',
    '1) 【赊账】|6A637-7 43 号|待收 ¥228.00',
    '【定金】 1 条',
    '1) 【定金】|B26002-52 37 号|待收 ¥128.00',
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
  // 🔴 2026-10-14 新增的**回归锁**：`{link}` 现在是不认识的占位符（深链已退场）——
  //    谁要是把链接段加回来，**启动时**就会在这里抛错，而不是悄悄渲染。
  //    依据：她「现在深链已经没有了，把之前的清除掉」。
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_LINE_PARTS: '{index}. {item}|{link}' }),
    /无法识别的占位符 \{link\}/,
  );
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS: '{batchNo}|{link}' }),
    /无法识别的占位符 \{link\}/,
  );
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_BLOCK_ORDER: 'prepaid,refund' }),
    /没声明的区块「refund」/,
  );
  // ⚠️ 旧值 `unpaid`（"未付"那个区块）同样按"没声明的区块"处理 —— **故意的**：
  //    宁可启动时吵一声，也不要静默按旧的三个区块推。
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_BLOCK_ORDER: 'prepaid,unpaid' }),
    /没声明的区块「unpaid」/,
  );
  // 顺序里只写了一半：另一块**不消失**，补在后面（配置写漏不该让一类单静默少推）。
  const partial = resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_BLOCK_ORDER: 'cash_pending' });
  assert.deepEqual(partial.blocks.map((block) => block.key), ['cash_pending', 'prepaid']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 六、保留的那几件事：按天去重、置顶、主聊天
// ─────────────────────────────────────────────────────────────────────────────

test('分区改动不影响按天去重与置顶：同一天只发一条、置顶的就是那条，第二天照推', async () => {
  const orders = [RESERVED, CASH_PENDING];
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
