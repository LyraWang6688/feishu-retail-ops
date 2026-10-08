// 「维度 1：每天 9 点把**最近 7 天还没收齐**的销售单推到群里」的配置
// （配置先行——群 id / 时间点 / 开关 / 深链策略 / **分区与文案** / **卡片标记** / **失败重试**
//   都是**会改的口径**，改的时候只动这一个文件，不去翻 pendingDealPushService）。
//
// 🔴 2026-10-07 口径大改：交易类型 = 库存有没有（现货 / 预定），「未付」不再是类型。
//   ⇒ 候选源从"未付 / 预付两个**交易类型编码**"改成
//     「**预定（还没交付）** ＋ **现货但钱没结清**」= **尚未完成履约**（见下方分区判据）。
//   ⇒ 分区标题从 `预付 / 未付` 改成 `预定 / 现货待收`（文案仍可配）。
//
// ⭐ 2026-10-08 口径（业务负责人逐字）：
//   「甲 **改成消息卡片**（interactive）—— · 单号**加粗**、类型用彩色标签、【待收金额】突出显示 ·
//    长链接改成「**查看原话**」这样的**文字链接**（URL 藏起来，不再占一行）· 分区块加分割线、
//    采购区单独一块 · 客户端不支持时降级成纯文本（可用飞书的 fallback）」
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……然后销售按照**预定和现货待收**分区，
//    **不需要退货和换货的**」
//   「② **推送失败自动重试**：失败后隔 **5/15 分钟**各重试一次，别一次失败就整天不发」
//   ⇒ 默认发**卡片**（`PENDING_DEAL_PUSH_MESSAGE_FORMAT=card`）；
//     下面这套**文本模板保留改造**成**降级**（客户端/租户不支持卡片、或卡片发不出去时用它）；
//     行内容去掉单号、补「查看原话」文字链接；待收为 0 写「已付清」；金额拿不到**整段不渲染**。
//
// ⚠️ 取值规则（"空串算不算关"那一套）在 `config/envValue`，本文件与销售卡片那几处共用同一套，
//   规则只有一处实现，不会两处慢慢走歪。
//
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。
//
// ── 2026-10-07：按【预定 / 现货待收】分区 + 每条补「货号+尺码」 ──────────────────
// 业务负责人口径（逐字）：最初是「**只需要这些信息，按照预付和未付分区**」；
// 同一天口径大改（交易类型 = 库存有没有，「未付」不再是类型）⇒ 分区判据跟着换：
// 新目标形状（`{title}` 由配置给）：
//   ⏰ 2026-10-07 最近 7 天待处理的销售单（预定 / 现货待收）：2 笔
//      1. ·【预定】B26002-52 37码 · 待收 ¥128 · [深链]
//      2. ·【现货待收】6A637-7 43码 · 待收 ¥228 · [深链]
// ⇒ 她只要「【预定/现货待收】 + 货号+尺码 + 待收金额 + 深链」，**不要售出时间**、**不要单号**。
// ⚠️ 她给的那张形状里"分区"与"行内标签"是**并存**的（她两处都写了），所以这里也是两处都有：
//    区块标题用 `sectionTemplate`，每行里的 `{tag}` 还是同一个区块标题。
// ⚠️ 下面这些**全是显示文案**（改文案不碰逻辑）：本文件之外的 service 里
//    **一行中文都不写**，所以换说法 / 换顺序 / 换分隔符只改这里或环境变量。

const { readString, readFlag, readInt, readList } = require('./envValue');
// ⭐ 2026-10-08（P0）：失败重试的**间隔与上限**、瞬时错误的小退避、失败告警的开关与文案
//    都在 `config/pushRetry`（两条推送共用一处实现）。本文件只接**这一个**值：
//    按天重试的偏移表（它同时还是 `PENDING_DEAL_PUSH_RETRY_DELAYS_MS` 的兜底默认值）。
//    ⚠️ service 里那两层重试分别拿：`settings.retryDelaysMs`（按天层）+
//      `config/pushRetry` 的 `transient` / `alert`（瞬时层与告警）。
const { resolveDailyRetryConfig } = require('./pushRetry');
// ⭐ 2026-10-08（第二步）：【团购券待结算】那一块的口径（配置先行，真源在那一份文件里）——
//   这里只挂进整份配置（`settings.voucher`），service 拿它时不必再读第二遍环境变量。
const { resolveVoucherSettlementConfig } = require('./voucherSettlement');

const PENDING_DEAL_PUSH_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_ENABLED';
const PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY = 'PENDING_DEAL_PUSH_CHAT_ID';
const PENDING_DEAL_PUSH_HOUR_ENV_KEY = 'PENDING_DEAL_PUSH_HOUR';
const PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY = 'PENDING_DEAL_PUSH_INTERVAL_MS';
const PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED';
const PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_REQUIRED';
// 发完之后**把那条消息置顶（飞书 Pin）**。业务负责人 2026-10-07 单独提的那个动作。
const PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_PIN_ENABLED';

// ── 分区与文案的旋钮（2026-10-07）─────────────────────────────────────────────
const PENDING_DEAL_PUSH_BLOCK_ORDER_ENV_KEY = 'PENDING_DEAL_PUSH_BLOCK_ORDER';
const PENDING_DEAL_PUSH_PREPAID_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_PREPAID_TITLE';
const PENDING_DEAL_PUSH_CASH_PENDING_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_CASH_PENDING_TITLE';
const PENDING_DEAL_PUSH_OTHER_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_OTHER_TITLE';
const PENDING_DEAL_PUSH_HEADER_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_HEADER_TEMPLATE';
const PENDING_DEAL_PUSH_SECTION_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_SECTION_TEMPLATE';
const PENDING_DEAL_PUSH_LINE_PARTS_ENV_KEY = 'PENDING_DEAL_PUSH_LINE_PARTS';
const PENDING_DEAL_PUSH_LINE_SEPARATOR_ENV_KEY = 'PENDING_DEAL_PUSH_LINE_SEPARATOR';
const PENDING_DEAL_PUSH_ITEM_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_ITEM_TEMPLATE';
const PENDING_DEAL_PUSH_ITEM_SEPARATOR_ENV_KEY = 'PENDING_DEAL_PUSH_ITEM_SEPARATOR';
const PENDING_DEAL_PUSH_SIZE_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_SIZE_TEMPLATE';
const PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_FOOTER_TEMPLATE';

// ── 2026-10-08 新增的旋钮 ─────────────────────────────────────────────────────
// 发送形态：`card`（默认，消息卡片）/ `text`（纯文本，客户端不支持卡片时的降级出口）。
const PENDING_DEAL_PUSH_MESSAGE_FORMAT_ENV_KEY = 'PENDING_DEAL_PUSH_MESSAGE_FORMAT';
// 失败重试的时刻（**相对首次失败**的毫秒偏移，逗号分隔）；空串 = 不重试。
const PENDING_DEAL_PUSH_RETRY_DELAYS_MS_ENV_KEY = 'PENDING_DEAL_PUSH_RETRY_DELAYS_MS';
// 文字链接的可见文案（URL 藏在它后面）、纯文本降级里的金额段、待收为 0 时的文案。
const PENDING_DEAL_PUSH_LINK_TEXT_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_TEXT';
const PENDING_DEAL_PUSH_AMOUNT_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_AMOUNT_TEMPLATE';
const PENDING_DEAL_PUSH_PAID_UP_TEXT_ENV_KEY = 'PENDING_DEAL_PUSH_PAID_UP_TEXT';
// 卡片的配色（标题 / 金额高亮 / 两个区块的类型标签）。
const PENDING_DEAL_PUSH_CARD_HEADER_COLOR_ENV_KEY = 'PENDING_DEAL_PUSH_CARD_HEADER_COLOR';
const PENDING_DEAL_PUSH_CARD_AMOUNT_COLOR_ENV_KEY = 'PENDING_DEAL_PUSH_CARD_AMOUNT_COLOR';
const PENDING_DEAL_PUSH_PREPAID_TAG_COLOR_ENV_KEY = 'PENDING_DEAL_PUSH_PREPAID_TAG_COLOR';
const PENDING_DEAL_PUSH_CASH_PENDING_TAG_COLOR_ENV_KEY = 'PENDING_DEAL_PUSH_CASH_PENDING_TAG_COLOR';

// ── 2026-10-07：同一条推送里加【采购】区（销售区在前、采购区在后，顺序可配）────────
// 业务负责人的口径（逐字）：
//   「你每天 9 点发通知的时候，看未到货的情况就**直接去那个表里查**，然后再把消息**深链**发到用户群里」
const PENDING_DEAL_PUSH_AREA_ORDER_ENV_KEY = 'PENDING_DEAL_PUSH_AREA_ORDER';
const PENDING_DEAL_PUSH_SALES_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_SALES_TITLE';
const PENDING_DEAL_PUSH_PURCHASE_TITLE_ENV_KEY = 'PENDING_DEAL_PUSH_PURCHASE_TITLE';
const PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS_ENV_KEY = 'PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS';
const PENDING_DEAL_PUSH_PURCHASE_LINE_SEPARATOR_ENV_KEY = 'PENDING_DEAL_PUSH_PURCHASE_LINE_SEPARATOR';
const PENDING_DEAL_PUSH_PURCHASE_SUPPLIER_SEPARATOR_ENV_KEY = 'PENDING_DEAL_PUSH_PURCHASE_SUPPLIER_SEPARATOR';
const PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE';

// 三个**大区**的身份（内部键；顺序由 `PENDING_DEAL_PUSH_AREA_ORDER` 决定）。
// ⭐ 2026-10-08（第二步）：加 `voucher` = 【团购券待结算】块 + 「确认到账」按钮。
//    她的口径是「放在**销售两块之后、采购之前**」⇒ 默认顺序就是
//    `sales`（里面两块：预定 / 现货待收）→ `voucher` → `purchase`。
//    ⚠️ 这一块的口径（天数 / 状态 / 金额 / 文案 / 按钮动作）**全在 `config/voucherSettlement`**，
//       这里只声明"它在整条消息里的位置"。
const PENDING_DEAL_PUSH_AREA_KEYS = Object.freeze(['sales', 'voucher', 'purchase']);
// 默认顺序 = 她定的「**销售在前、团购券待结算居中、采购在后**」。
const DEFAULT_AREA_ORDER = Object.freeze(['sales', 'voucher', 'purchase']);

// 默认 9 点（北京时间，业务负责人说的）。
const DEFAULT_PUSH_HOUR = 9;
// 默认 10 分钟一 tick：与「第二次交付」提醒同一个节奏。判断"今天该不该跑"不靠定时精度，
// 而靠**按天认领 + 失败重试**（见 pendingDealPushService.sendDailyPush），
// 所以 tick 落在哪一刻无所谓。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

// 发消息的形态（**显式**取值，认不出来就抛 —— 静默按某一种处理是最坏的一种）。
const MESSAGE_FORMAT_CARD = 'card';
const MESSAGE_FORMAT_TEXT = 'text';
const PENDING_DEAL_PUSH_MESSAGE_FORMATS = Object.freeze([MESSAGE_FORMAT_CARD, MESSAGE_FORMAT_TEXT]);

// 失败重试的默认节奏：**每 10 分钟一次、最多 6 次重试**（= 一天最多 7 次尝试），
// 由共享的按天策略派生（`config/pushRetry` 的 `PUSH_DAILY_RETRY_*`）。
// 🔴 2026-10-08（P0）**改掉了上午那版**（相对首次失败 5 分钟 / 15 分钟各一次 = 只有 2 次重试）：
//    上午的口径挡不住真机那一次"09:05 失败 ⇒ 一整天不发"（两次都在 20 分钟内用完）。
//    现在的口径是「直到当天成功一次，上限 6 次」；**成功一次即停、绝不重发**。
// ⚠️ 想回到老节奏（或换成任意节奏）**不用改代码**：`PENDING_DEAL_PUSH_RETRY_DELAYS_MS`
//    仍然是**显式覆盖**（相对首次失败的毫秒偏移，逗号分隔；空串 = 不重试）。
const DEFAULT_RETRY_DELAYS_MS = Object.freeze(resolveDailyRetryConfig({}).retryDelaysMs);

// 两个区块的**身份**（业务事实，不是文案）：
//   · key       = 内部键（`blockOrder` 里写的是它）；
//   · criterion = 分区**判据**（`PENDING_DEAL_PUSH_BLOCK_CRITERIA` 之一）——
//                 ⚠️ **不是**交易类型编码：新口径下类型 = 库存有没有，
//                 "未付" 不再是一种类型，"哪一笔该推" 由**履约 / 资金进展**决定。
//   · title     = 区块标题（也是行内那个 `【预定】` 标签）——文案，可配。
//   · tagColor  = 卡片上那个**彩色标签**的颜色（`text_tag` 的 color 枚举）——也是文案，可配。
const PENDING_DEAL_PUSH_BLOCK_CRITERIA = Object.freeze({
  // 还没交付（类型 = 预定，或一张单里还有预定行没交）——货还在店里 / 还没到。
  undelivered: 'undelivered',
  // 货已经交付、钱还没结清（现货 + 钱没结清的那一类）。
  deliveredUnpaid: 'delivered_unpaid',
});

// 「已交付」是**销售明细.履约状态**里的取值（不是文案）：判据要拿它比。
// ⚠️ 逻辑里**不许**再写这个中文字面量（见 pendingDealPushService）。
const PENDING_DEAL_PUSH_DELIVERED_STATUS = '已交付';

// 顺序 = 数组顺序，也是 `blockOrder` 的默认值。
// ⭐ 顺序选了「**预定在前、现货待收在后**」，理由见 service 里的注释与 docs（不是随手排的）。
const PENDING_DEAL_PUSH_BLOCK_DEFS = Object.freeze([
  Object.freeze({
    key: 'prepaid',
    criterion: PENDING_DEAL_PUSH_BLOCK_CRITERIA.undelivered,
    titleEnvKey: PENDING_DEAL_PUSH_PREPAID_TITLE_ENV_KEY,
    defaultTitle: '【预定】',
    tagColorEnvKey: PENDING_DEAL_PUSH_PREPAID_TAG_COLOR_ENV_KEY,
    defaultTagColor: 'blue',
  }),
  Object.freeze({
    key: 'cash_pending',
    criterion: PENDING_DEAL_PUSH_BLOCK_CRITERIA.deliveredUnpaid,
    titleEnvKey: PENDING_DEAL_PUSH_CASH_PENDING_TITLE_ENV_KEY,
    defaultTitle: '【现货待收】',
    tagColorEnvKey: PENDING_DEAL_PUSH_CASH_PENDING_TAG_COLOR_ENV_KEY,
    defaultTagColor: 'orange',
  }),
]);

/**
 * 一笔候选单该落进哪个分区 —— **唯一的判据**（调用点只认它的返回值）。
 *   · 履约状态 = 已交付          → `deliveredUnpaid`（货交出去了，钱还没收齐）
 *   · 其余（未交付 / 部分交付）    → `undelivered`（还有货没交）
 * ⚠️ 候选本身已经保证"尚未完成履约"（`SecondDeliveryService.listPendingDeliveries`），
 *    所以"已交付"必然意味着"钱还没结清"，不必再判钱。
 */
const pendingDealPushCriterionFor = (order = {}) =>
  (String(order.fulfillmentStatus || '').trim() === PENDING_DEAL_PUSH_DELIVERED_STATUS
    ? PENDING_DEAL_PUSH_BLOCK_CRITERIA.deliveredUnpaid
    : PENDING_DEAL_PUSH_BLOCK_CRITERIA.undelivered);

// 「两个判据之外的」兜底区块的标题。⚠️ 它存在的意义是**绝不静默丢单**：
// 万一将来多出一种履约形态（`pendingDealPushCriterionFor` 返回了没声明的判据），
// 那笔单会落在这一块里被看见，而不是因为它不匹配任何已声明区块就从清单里消失。
const DEFAULT_OTHER_TITLE = '【其他】';

// 整条消息的形状。占位符 = 大括号里的名字，未知占位符在**启动时**抛错（见 assertTemplate）。
const PENDING_DEAL_PUSH_DEFAULTS = Object.freeze({
  // 表头：`{total}` 仍是"总共几笔"（口径不变），`{blockCounts}` 后面补一句分区计数。
  // ⚠️ 2026-10-08 文案 nit：**只有一个区块时不再补分区计数** ——
  //    她真机看到的成品是「…（预定 / 现货待收）：5 笔（【预定】5 笔）」，同一件事说了两遍。
  //    判据在 service（`sections.length > 1` 才补），不需要新配置项。
  headerTemplate: '⏰ {day} 最近 7 天待处理的销售单（预定 / 现货待收）：{total} 笔{blockCounts}',
  blockCountsTemplate: '（{counts}）',
  blockCountTemplate: '{title}{count} 笔',
  blockCountSeparator: ' / ',
  // 区块 = 标题行 + 该区块每单一行。
  sectionTemplate: '{title}{count} 笔\n{lines}',
  // 行 = 逐段拼，**空的那一段整段不要**（缺深链 / 金额读不出来时不会留下 ` · ` 或空壳）。
  // ⚠️ 2026-10-08：**去掉 `{orderNo}`**（她明确说不需要单号），把类型标签提到最前，
  //    金额与链接段各自可整段消失。
  // ⚠️ `{amount}` 给的是**整段**（按下面的 `amountTemplate` 渲染好，或者「已付清」）——
  //    所以自定义行模板时**不要再写「待收」**，写 `{amount}` 就够了。
  // ⚠️ 段序与卡片那条**保持一致**（货号尺码在前、类型标签在后）——
  //    这样"降级纯文本"读起来就是卡片上那套字样（只差 URL 藏不藏得住）。
  lineParts: ['{index}. {item}', '{tag}', '{amount}', '{link}'],
  lineSeparator: ' · ',
  // 一件商品：`货号 [颜色] 尺码码`。
  // ⭐ 2026-10-08 晚她加的口径：「**还需要在货号和尺码中间加上颜色**」⇒ 默认模板里加 `{color}`
  //    （颜色取自「货品信息.颜色」，见 `services/salesDetailItemFacts`；取不到就留空、空格自动收掉）。
  // 配品没有尺码 → `{size}` 为空 → 拼完只剩名称（**不会出现「 码」**）。
  itemTemplate: '{itemNo} {color} {size}',
  // 一单多件时**逐件列出**，件与件之间用这个分隔符（默认顿号）。
  itemSeparator: '、',
  sizeTemplate: '{size}码',
  // 金额段：`待收 ¥128.00`。⚠️ 待收为 0 → 换成 `paidUpText`；**读不出来**就整段不要
  //（**绝不**渲染 `¥—`，更不会变成 `¥0.00` —— 那是在说"这单不用收钱"）。
  amountTemplate: '待收 {amount}',
  paidUpText: '已付清',
  // 文字链接：卡片上是 `[查看原话](url)`，纯文本降级里是 `查看原话 https://…`
  //（纯文本藏不住 URL，但至少不再是一行裸链接）。
  // ⭐ 2026-10-08 晚她的口径：「**应该都是查看话题**」⇒ 统一成「查看话题」
  //（卡片上那颗按钮的文案也是它，见 `card.buttonText`）。
  linkText: '查看话题',
  linkTextTemplate: '{text} {url}',
  footerTemplate: '（{count} 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）',
  // ── 大区（2026-10-07）：销售区 + 采购区 ────────────────────────────────────
  // ⚠️ 销售区标题**默认空串** = 不渲染那一行。
  salesAreaTitle: '',
  // ⭐ 采购区的大区标题（`{count}` = 这一区几批）。
  purchaseAreaTitle: '【采购】未到货的报货批次：{count} 批',
  // 采购区一行 = 逐段拼（与销售区同一套"空的段整段不要"的规矩）。
  //   `{batchNo}` 批次号 · `{supplier}` 供应商（取不到就没有这一段，**不编**）
  //   ⭐ 2026-10-08 晚（业务负责人逐字）：「这里的文字说明，包括**供应商和创建时间以及报货数量**」，
  //      同日的补充口径把两个名字钉死：「采购数量用**「录入数量」**」、
  //      时间那一列的真表名是**「报货日」**（飞书自动字段，schema 语义键 `createdAt`）。
  //   ⇒ 行里加 `{reportedAt}`（报货日，上海自然日 `YYYY-MM-DD`）与 `{quantity}`（录入数量）。
  //      ⚠️ **整段（含"报货日/录入数量"这两个标签）都写在模板里**：她哪天要换个说法
  //         （例：`报货时间：{reportedAt}`）只改配置，不去翻代码。
  //      ⚠️ 两个段各自**取不到就整段不要**（不编 `—`），要占位就填下面卡片配置里的
  //         `missingReportedAtText` / `missingQuantityText`。
  //   · `{link}` 深链
  purchaseLineParts: [
    '{index}. {batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}', '{link}',
  ],
  purchaseLineSeparator: ' · ',
  // 一批多供应商时的连接符。
  purchaseSupplierSeparator: '、',
  purchaseFooterTemplate: '（{count} 批的深链暂不可用，见日志 sales.pending_deal_push.purchase_link.missing）',

  // ── 卡片（2026-10-08）──────────────────────────────────────────────────────
  // 卡片上每一处的**标记骨架**（与 `blockCountsTemplate` 同一档：改文案 / 改标记只动这里）。
  // ⚠️ 卡片元素里**没有** `{"tag":"a"}` 这种独立超链接组件（飞书 1.0 / 2.0 组件总览里都没有），
  //    官方支持的等价物是富文本里的文字链接 `[查看原话](url)` —— URL 一样藏在文字后面。
  card: Object.freeze({
    headerColor: 'blue',
    sectionTitleTemplate: '**{title}**',
    lineParts: ['{index}. {item}', '{tag}', '{amount}', '{link}'],
    lineSeparator: ' · ',
    // 她最看重的两样：**货号 + 尺码**（加粗）与类型彩色标签。
    itemTemplate: '**{item}**',
    tagTemplate: "<text_tag color='{color}'>{text}</text_tag>",
    // 金额突出显示（配色可配）。
    amountTemplate: "<font color='{color}'>待收 {amount}</font>",
    amountColor: 'red',
    linkTemplate: '[{text}]({url})',

    // ── ⭐ 2026-10-08 晚：每行**两栏**（她拍板，替换掉先前"三列含分类列"的方案）─────────
    // 她的原话：「可以按照**预定、现货待收和采购分为 3 个区域**，并且按照区域进行分块，
    //            **每块有两栏**，第一栏是**文字说明**，第二栏是**查看话题的点击按钮**」
    // ⇒ 区域 = 各块标题（【预定】/【现货待收】/【采购…】，配置给的 title）；
    //    每行 = 一个 `column_set`：第 1 栏文字说明、第 2 栏按钮。
    // ⚠️ 先前那版"第 1 列再放一个分类名（销售-预定）"**已按她这次的口径去掉**。
    rowTextParts: ['{item}', '{amount}'],
    rowTextSeparator: ' · ',
    // 货号/尺码读不出来时的占位（**绝不静默丢这一行**）。
    missingItemText: '（未读到货号/尺码）',
    // 采购区一行（两栏版的第 1 栏）：批次号 + 供应商 + 报货日 + 录入数量（取不到就整段不要）。
    // ⚠️ 与文本降级那份**同一套段**（含"报货日/录入数量"这两个标签）。
    purchaseRowTextParts: ['{batchNo}', '{supplier}', '报货日 {reportedAt}', '录入数量 {quantity}'],
    // ⭐ 2026-10-08 晚：采购那两个新字段**读不出来时的占位**（与 `missingItemText` 同一档）。
    //   为什么要占位而不是留空：她点名过"缺字段**照推**、绝不静默丢单"——
    //   留空会让那一行看起来"这一批本来就没有报货日 / 数量"，占位才看得出来是**读不到**。
    //   ⚠️ 占位**只填值的位置**：`报货日`/`录入数量` 这两个标签写在段模板里
    //     （所以这里不再重复写一遍标签，否则会出现「报货日 （未读到报货日）」）。
    //   ⚠️ 想要"读不到就什么都不显示"（与金额同一形状）就把这两个键设成空串。
    missingReportedAtText: '（未读到）',
    missingQuantityText: '（未读到）',
    // 按钮文案（两栏里的第 2 栏）；没有深链时**整栏不出现**（不留空壳）。
    buttonText: '查看话题',
    // 两栏宽度权重（文字 : 按钮）。
    columnWeights: Object.freeze([4, 1]),
    // ── ⭐ 2026-10-08（第二步）：【团购券待结算】块的两栏 ─────────────────────────
    // 与上面那行**同一形状**（第 1 栏文字说明、第 2 栏按钮），只是：
    //   · 第 2 栏是**回调按钮**（不是 open_url）——`rowColumnSet` 按 `action` 分支渲染；
    //   · 第 1 栏那句 = `config/voucherSettlement.rowTemplate`（`{settleDay} 应结算 ¥{amount}`）
    //     +（结算日 < 今天时）`overdueTemplate`；两个模板都在那份配置里，改文案只动它。
    // ⚠️ 缺这一栏的按钮文案 / 配色时，渲染层从 `config/voucherSettlement` 取（同一个 settings）。
    voucherButtonType: 'primary',
  }),
});

// 每个模板认得的占位符。写错名字（`{itemNO}` 这种）**启动时**就抛错——
// 不认识的占位符会被渲染成空串，那等于悄悄少给她一段信息，属于最难查的一类。
const TEMPLATE_PLACEHOLDERS = Object.freeze({
  headerTemplate: Object.freeze(['day', 'total', 'blockCounts']),
  blockCountsTemplate: Object.freeze(['counts']),
  blockCountTemplate: Object.freeze(['title', 'count']),
  sectionTemplate: Object.freeze(['title', 'count', 'lines']),
  linePart: Object.freeze(['index', 'orderNo', 'tag', 'item', 'amount', 'link']),
  itemTemplate: Object.freeze(['itemNo', 'color', 'size']),
  sizeTemplate: Object.freeze(['size']),
  footerTemplate: Object.freeze(['count']),
  amountTemplate: Object.freeze(['amount']),
  paidUpText: Object.freeze([]),
  linkTextTemplate: Object.freeze(['text', 'url']),
  // ── 卡片 ──────────────────────────────────────────────────────────────────
  cardSectionTitleTemplate: Object.freeze(['title']),
  cardLinePart: Object.freeze(['index', 'tag', 'item', 'amount', 'link']),
  cardItemTemplate: Object.freeze(['item']),
  cardTagTemplate: Object.freeze(['color', 'text']),
  cardAmountTemplate: Object.freeze(['color', 'amount']),
  cardLinkTemplate: Object.freeze(['text', 'url']),
  cardRowTextPart: Object.freeze(['index', 'tag', 'item', 'amount']),
  cardPurchaseRowTextPart: Object.freeze(['index', 'batchNo', 'supplier', 'reportedAt', 'quantity']),
  // ── 大区 ──────────────────────────────────────────────────────────────────
  salesAreaTitle: Object.freeze(['count']),
  purchaseAreaTitle: Object.freeze(['count']),
  purchaseLinePart: Object.freeze(['index', 'batchNo', 'supplier', 'reportedAt', 'quantity', 'link']),
  purchaseFooterTemplate: Object.freeze(['count']),
});

const assertTemplate = (label, template, allowed) => {
  const text = String(template ?? '');
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.includes(match[1])) {
      throw new Error(`${label} 里有无法识别的占位符 {${match[1]}}`
        + `（可用：${allowed.map((name) => `{${name}}`).join(' ')}）`);
    }
  }
  // 没闭合的大括号同样是写错了：`{item` 会原样出现在群里。
  if (text.replace(/\{[^{}]*\}/g, '').includes('{') || text.replace(/\{[^{}]*\}/g, '').includes('}')) {
    throw new Error(`${label} 里的占位符没有闭合（大括号必须成对，形如 {itemNo}）`);
  }
  return text;
};

/** 区块（**已按配置排好序**）：`[{ key, criterion, title, tagColor }]`。 */
const resolveBlocks = (env) => {
  const requested = readList(env, PENDING_DEAL_PUSH_BLOCK_ORDER_ENV_KEY);
  const order = requested === null ? PENDING_DEAL_PUSH_BLOCK_DEFS.map((def) => def.key) : requested;
  const defsByKey = new Map(PENDING_DEAL_PUSH_BLOCK_DEFS.map((def) => [def.key, def]));
  const unknown = order.filter((key) => !defsByKey.has(key));
  if (unknown.length) {
    throw new Error(`${PENDING_DEAL_PUSH_BLOCK_ORDER_ENV_KEY} 里有没声明的区块「${unknown[0]}」`
      + `（可用：${PENDING_DEAL_PUSH_BLOCK_DEFS.map((def) => def.key).join('、')}）`);
  }
  // ⚠️ `blockOrder` 里**漏写**的区块**不丢**：按声明顺序补在后面。
  //    宁可多显示一块，也不能因为一次配置写漏就静默少推一类单。
  const keys = [...order, ...PENDING_DEAL_PUSH_BLOCK_DEFS.map((def) => def.key)
    .filter((key) => !order.includes(key))];
  return keys.map((key) => {
    const def = defsByKey.get(key);
    return {
      key,
      criterion: def.criterion,
      title: readString(env, def.titleEnvKey, def.defaultTitle),
      tagColor: readString(env, def.tagColorEnvKey, def.defaultTagColor),
    };
  });
};

/** 行模板：`|` 分隔的若干段（段是"可整段不要"的最小单位）。 */
const resolveLineParts = (env) => {
  const raw = readString(env, PENDING_DEAL_PUSH_LINE_PARTS_ENV_KEY, null);
  const parts = raw === null
    ? [...PENDING_DEAL_PUSH_DEFAULTS.lineParts]
    : String(raw).split('|').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    throw new Error(`${PENDING_DEAL_PUSH_LINE_PARTS_ENV_KEY} 至少要有一段（多段用 | 分隔），不能是空的`);
  }
  parts.forEach((part) => assertTemplate(PENDING_DEAL_PUSH_LINE_PARTS_ENV_KEY, part, TEMPLATE_PLACEHOLDERS.linePart));
  return parts;
};

/** 采购区的行模板（同一套规矩；段名不同 —— 见 TEMPLATE_PLACEHOLDERS.purchaseLinePart）。 */
const resolvePurchaseLineParts = (env) => {
  const raw = readString(env, PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS_ENV_KEY, null);
  const parts = raw === null
    ? [...PENDING_DEAL_PUSH_DEFAULTS.purchaseLineParts]
    : String(raw).split('|').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    throw new Error(`${PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS_ENV_KEY} 至少要有一段（多段用 | 分隔），不能是空的`);
  }
  parts.forEach((part) => assertTemplate(
    PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS_ENV_KEY, part, TEMPLATE_PLACEHOLDERS.purchaseLinePart,
  ));
  return parts;
};

/**
 * 大区顺序（`sales` / `purchase`）。
 *
 * ⚠️ 与区块顺序同一条纪律：**漏写的区不丢**（按声明顺序补在后面）。
 *    少推一整个区比顺序不对严重得多，不能让一次配置写漏把它静默吃掉。
 */
const resolveAreas = (env) => {
  const requested = readList(env, PENDING_DEAL_PUSH_AREA_ORDER_ENV_KEY);
  const order = requested === null ? [...DEFAULT_AREA_ORDER] : requested;
  const unknown = order.filter((key) => !PENDING_DEAL_PUSH_AREA_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`${PENDING_DEAL_PUSH_AREA_ORDER_ENV_KEY} 里有没声明的大区「${unknown[0]}」`
      + `（可用：${PENDING_DEAL_PUSH_AREA_KEYS.join('、')}）`);
  }
  return [...order, ...PENDING_DEAL_PUSH_AREA_KEYS.filter((key) => !order.includes(key))];
};

/** 发送形态：`card` / `text`。**认不出来就抛**（含空串 —— 空串不是一种形态）。 */
const resolveMessageFormat = (env) => {
  const raw = readString(env, PENDING_DEAL_PUSH_MESSAGE_FORMAT_ENV_KEY, MESSAGE_FORMAT_CARD);
  const value = String(raw).trim().toLowerCase();
  if (!PENDING_DEAL_PUSH_MESSAGE_FORMATS.includes(value)) {
    throw new Error(`${PENDING_DEAL_PUSH_MESSAGE_FORMAT_ENV_KEY} 只能是 `
      + `${PENDING_DEAL_PUSH_MESSAGE_FORMATS.join(' / ')}，当前值无法识别`);
  }
  return value;
};

/**
 * 失败重试的时刻（**相对首次失败**的毫秒偏移）。
 *   · 没设 → 共享按天策略派生的默认值（`PUSH_DAILY_RETRY_INTERVAL_MS` × 1..N，
 *     默认 = 每 10 分钟一次、共 6 次）；
 *   · 设成空串 → `[]`（显式"不重试"，按 envValue 的统一规矩：空串 = 一个都不要）；
 *   · 非法值（非正整数 / 超过一天）→ 启动时抛错。
 */
const resolveRetryDelaysMs = (env) => {
  const list = readList(env, PENDING_DEAL_PUSH_RETRY_DELAYS_MS_ENV_KEY);
  if (list === null) return [...resolveDailyRetryConfig(env).retryDelaysMs];
  return list.map((item) => {
    const value = Number(item);
    const max = 24 * 60 * 60 * 1000;
    if (!Number.isInteger(value) || value <= 0 || value > max) {
      throw new Error(`${PENDING_DEAL_PUSH_RETRY_DELAYS_MS_ENV_KEY} 必须是 1~${max} 之间的整数毫秒`
        + `（多个用逗号分隔；留空表示不重试），当前值无法识别`);
    }
    return value;
  });
};

/** 卡片标记骨架（**已按配置填好颜色**）。 */
const resolveCardConfig = (env) => {
  const defaults = PENDING_DEAL_PUSH_DEFAULTS.card;
  return {
    headerColor: readString(env, PENDING_DEAL_PUSH_CARD_HEADER_COLOR_ENV_KEY, defaults.headerColor),
    sectionTitleTemplate: assertTemplate('card.sectionTitleTemplate', defaults.sectionTitleTemplate,
      TEMPLATE_PLACEHOLDERS.cardSectionTitleTemplate),
    lineParts: [...defaults.lineParts].map((part) => assertTemplate(
      'card.lineParts', part, TEMPLATE_PLACEHOLDERS.cardLinePart,
    )),
    lineSeparator: defaults.lineSeparator,
    itemTemplate: assertTemplate('card.itemTemplate', defaults.itemTemplate,
      TEMPLATE_PLACEHOLDERS.cardItemTemplate),
    tagTemplate: assertTemplate('card.tagTemplate', defaults.tagTemplate,
      TEMPLATE_PLACEHOLDERS.cardTagTemplate),
    amountTemplate: assertTemplate('card.amountTemplate', defaults.amountTemplate,
      TEMPLATE_PLACEHOLDERS.cardAmountTemplate),
    amountColor: readString(env, PENDING_DEAL_PUSH_CARD_AMOUNT_COLOR_ENV_KEY, defaults.amountColor),
    linkTemplate: assertTemplate('card.linkTemplate', defaults.linkTemplate,
      TEMPLATE_PLACEHOLDERS.cardLinkTemplate),
    // ⭐ 两栏那一版（2026-10-08 晚）
    rowTextParts: [...defaults.rowTextParts].map((part) => assertTemplate(
      'card.rowTextParts', part, TEMPLATE_PLACEHOLDERS.cardRowTextPart,
    )),
    rowTextSeparator: defaults.rowTextSeparator,
    missingItemText: defaults.missingItemText,
    purchaseRowTextParts: [...defaults.purchaseRowTextParts].map((part) => assertTemplate(
      'card.purchaseRowTextParts', part, TEMPLATE_PLACEHOLDERS.cardPurchaseRowTextPart,
    )),
    // ⚠️ 这两个占位是**新加的键**（默认非空）。既有用例里那份 `card` 的严格全等断言
    //    要一起补上它们；不想要占位就在那里把它们设成空串。
    missingReportedAtText: defaults.missingReportedAtText,
    missingQuantityText: defaults.missingQuantityText,
    buttonText: defaults.buttonText,
    columnWeights: [...defaults.columnWeights],
    // 【团购券待结算】的「确认到账」按钮类型（回调按钮；配色可配）。
    voucherButtonType: readString(env, 'PENDING_DEAL_PUSH_VOUCHER_BUTTON_TYPE', defaults.voucherButtonType),
  };
};

/**
 * 一次把整份配置读出来。**只读一次、集中在启动时**：配置写错要在服务起来的那一刻就吵，
 * 而不是等到第二天 9 点推送时才失败（那时没人看着日志）。
 */
const resolvePendingDealPushConfig = (env = process.env) => ({
  enabled: readFlag(env, PENDING_DEAL_PUSH_ENABLED_ENV_KEY, false),
  // 群 id 没有默认值：没配 → 本次不推、只记一条警告，**绝不回落到发给某个人**。
  chatId: readString(env, PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY, ''),
  hour: readInt(env, PENDING_DEAL_PUSH_HOUR_ENV_KEY, DEFAULT_PUSH_HOUR, { min: 0, max: 23 }),
  intervalMs: readInt(env, PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY, DEFAULT_INTERVAL_MS, { min: 1000, max: 24 * 60 * 60 * 1000 }),
  // 深链**现查**开关：拿不到本地存的 `message_app_link` 时，要不要每次去问一次飞书。
  // 默认开——那是官方声明过的字段，将来飞书开始返回就自动生效，不用改代码。
  // 实测（2026-10-06）当前**不返回**，见 services/larkMessageLinkResolver 的注释。
  linkLookupEnabled: readFlag(env, PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY, true),
  // 拿不到深链时要不要**干脆不推**。默认 false = 照推货号 + 尺码 + 金额（深链是增强，不是前提）。
  linkRequired: readFlag(env, PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY, false),
  // 发出后要不要**把那条消息置顶**（飞书 im/v1/pins）。**默认 false**，理由：
  //   · 置顶是**群里每个人都看得见**的副作用，而且飞书那边有额外门槛——
  //     应用要有 `im:message.pins:write_only`（或 `im:message`）权限、机器人必须在群里、
  //     群若设成"仅群主/群管理员可 Pin"就直接失败（错误码 230046）；
  //   · 本仓既有纪律：对外可见的动作一律**显式开关、默认关**（本推送的总开关自己也默认 false）；
  //   · 打开时**必须显式写 true**，不会因为"只想试推送"就顺手把消息钉在群顶上。
  // ⚠️ 置顶失败绝不影响推送本身（只记 warn，见 services/larkMessagePinService）。
  pinEnabled: readFlag(env, PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY, false),
  // 发送形态：卡片（默认）/ 纯文本（降级）。
  messageFormat: resolveMessageFormat(env),
  // 失败重试的时刻（相对首次失败的 ms 偏移）；`[]` = 不重试。
  retryDelaysMs: resolveRetryDelaysMs(env),

  // ── 分区与文案（2026-10-07）────────────────────────────────────────────────
  // 区块**已按配置排好序**；渲染只认这个数组，服务里没有第二处顺序。
  blocks: resolveBlocks(env),
  otherTitle: readString(env, PENDING_DEAL_PUSH_OTHER_TITLE_ENV_KEY, DEFAULT_OTHER_TITLE),
  headerTemplate: assertTemplate(PENDING_DEAL_PUSH_HEADER_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_HEADER_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.headerTemplate),
    TEMPLATE_PLACEHOLDERS.headerTemplate),
  blockCountsTemplate: PENDING_DEAL_PUSH_DEFAULTS.blockCountsTemplate,
  blockCountTemplate: PENDING_DEAL_PUSH_DEFAULTS.blockCountTemplate,
  blockCountSeparator: PENDING_DEAL_PUSH_DEFAULTS.blockCountSeparator,
  sectionTemplate: assertTemplate(PENDING_DEAL_PUSH_SECTION_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_SECTION_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.sectionTemplate),
    TEMPLATE_PLACEHOLDERS.sectionTemplate),
  lineParts: resolveLineParts(env),
  lineSeparator: readString(env, PENDING_DEAL_PUSH_LINE_SEPARATOR_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.lineSeparator),
  itemTemplate: assertTemplate(PENDING_DEAL_PUSH_ITEM_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_ITEM_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.itemTemplate),
    TEMPLATE_PLACEHOLDERS.itemTemplate),
  itemSeparator: readString(env, PENDING_DEAL_PUSH_ITEM_SEPARATOR_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.itemSeparator),
  sizeTemplate: assertTemplate(PENDING_DEAL_PUSH_SIZE_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_SIZE_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.sizeTemplate),
    TEMPLATE_PLACEHOLDERS.sizeTemplate),
  // ── 金额 / 链接（2026-10-08）──────────────────────────────────────────────
  amountTemplate: assertTemplate(PENDING_DEAL_PUSH_AMOUNT_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_AMOUNT_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.amountTemplate),
    TEMPLATE_PLACEHOLDERS.amountTemplate),
  paidUpText: assertTemplate(PENDING_DEAL_PUSH_PAID_UP_TEXT_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_PAID_UP_TEXT_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.paidUpText),
    TEMPLATE_PLACEHOLDERS.paidUpText),
  linkText: readString(env, PENDING_DEAL_PUSH_LINK_TEXT_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.linkText),
  linkTextTemplate: assertTemplate('linkTextTemplate', PENDING_DEAL_PUSH_DEFAULTS.linkTextTemplate,
    TEMPLATE_PLACEHOLDERS.linkTextTemplate),
  footerTemplate: assertTemplate(PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.footerTemplate),
    TEMPLATE_PLACEHOLDERS.footerTemplate),

  // ── 大区：销售区 + 采购区（2026-10-07）───────────────────────────────────────
  // `areas` 已按配置排好序（默认 销售 → 采购）；渲染只认这个数组，服务里没有第二处顺序。
  areas: resolveAreas(env),
  // 销售区标题：**默认空串**（不渲染那一行）。
  salesAreaTitle: readString(env, PENDING_DEAL_PUSH_SALES_TITLE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.salesAreaTitle),
  purchaseAreaTitle: assertTemplate(PENDING_DEAL_PUSH_PURCHASE_TITLE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_PURCHASE_TITLE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.purchaseAreaTitle),
    TEMPLATE_PLACEHOLDERS.purchaseAreaTitle),
  purchaseLineParts: resolvePurchaseLineParts(env),
  purchaseLineSeparator: readString(env, PENDING_DEAL_PUSH_PURCHASE_LINE_SEPARATOR_ENV_KEY,
    PENDING_DEAL_PUSH_DEFAULTS.purchaseLineSeparator),
  purchaseSupplierSeparator: readString(env, PENDING_DEAL_PUSH_PURCHASE_SUPPLIER_SEPARATOR_ENV_KEY,
    PENDING_DEAL_PUSH_DEFAULTS.purchaseSupplierSeparator),
  purchaseFooterTemplate: assertTemplate(PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.purchaseFooterTemplate),
    TEMPLATE_PLACEHOLDERS.purchaseFooterTemplate),
  // ── 卡片标记骨架（2026-10-08）──────────────────────────────────────────────
  card: resolveCardConfig(env),
  // ── ⭐ 2026-10-08（第二步）：【团购券待结算】块 ────────────────────────────────
  // 这一块的口径（5 个自然日 / 「待平台结算」/ 「确认到账」/ 金额取券的「平台结算款」/
  // 逾期说法 / 按钮动作名）**全在 `config/voucherSettlement`** —— 配置只有一处真源，
  // 这里只是把它**挂进整条推送的配置**，一次解析完（写错在服务起来的那一刻就吵）。
  voucher: resolveVoucherSettlementConfig(env),
});

module.exports = {
  PENDING_DEAL_PUSH_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY,
  PENDING_DEAL_PUSH_HOUR_ENV_KEY,
  PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY,
  PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_BLOCK_ORDER_ENV_KEY,
  PENDING_DEAL_PUSH_PREPAID_TITLE_ENV_KEY,
  PENDING_DEAL_PUSH_CASH_PENDING_TITLE_ENV_KEY,
  PENDING_DEAL_PUSH_OTHER_TITLE_ENV_KEY,
  PENDING_DEAL_PUSH_HEADER_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_SECTION_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_LINE_PARTS_ENV_KEY,
  PENDING_DEAL_PUSH_LINE_SEPARATOR_ENV_KEY,
  PENDING_DEAL_PUSH_ITEM_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_ITEM_SEPARATOR_ENV_KEY,
  PENDING_DEAL_PUSH_SIZE_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_MESSAGE_FORMAT_ENV_KEY,
  PENDING_DEAL_PUSH_RETRY_DELAYS_MS_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_TEXT_ENV_KEY,
  PENDING_DEAL_PUSH_AMOUNT_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_PAID_UP_TEXT_ENV_KEY,
  PENDING_DEAL_PUSH_CARD_HEADER_COLOR_ENV_KEY,
  PENDING_DEAL_PUSH_CARD_AMOUNT_COLOR_ENV_KEY,
  PENDING_DEAL_PUSH_PREPAID_TAG_COLOR_ENV_KEY,
  PENDING_DEAL_PUSH_CASH_PENDING_TAG_COLOR_ENV_KEY,
  PENDING_DEAL_PUSH_AREA_ORDER_ENV_KEY,
  PENDING_DEAL_PUSH_SALES_TITLE_ENV_KEY,
  PENDING_DEAL_PUSH_PURCHASE_TITLE_ENV_KEY,
  PENDING_DEAL_PUSH_PURCHASE_LINE_PARTS_ENV_KEY,
  PENDING_DEAL_PUSH_PURCHASE_LINE_SEPARATOR_ENV_KEY,
  PENDING_DEAL_PUSH_PURCHASE_SUPPLIER_SEPARATOR_ENV_KEY,
  PENDING_DEAL_PUSH_PURCHASE_FOOTER_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_AREA_KEYS,
  DEFAULT_AREA_ORDER,
  DEFAULT_RETRY_DELAYS_MS,
  MESSAGE_FORMAT_CARD,
  MESSAGE_FORMAT_TEXT,
  PENDING_DEAL_PUSH_MESSAGE_FORMATS,
  PENDING_DEAL_PUSH_BLOCK_DEFS,
  PENDING_DEAL_PUSH_BLOCK_CRITERIA,
  PENDING_DEAL_PUSH_DELIVERED_STATUS,
  PENDING_DEAL_PUSH_DEFAULTS,
  DEFAULT_PUSH_HOUR,
  DEFAULT_INTERVAL_MS,
  resolvePendingDealPushConfig,
  resolveRetryDelaysMs,
  pendingDealPushCriterionFor,
  // 显式布尔那条规矩的实现在 config/envValue；这里转发一下，单测仍然可以盯住它。
  readFlag,
};
