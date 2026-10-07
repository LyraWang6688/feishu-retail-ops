// 「维度 1：每天 9 点把**最近 7 天还没收齐**的销售单推到群里」的配置
// （配置先行——群 id / 时间点 / 开关 / 深链策略 / **分区与文案**都是**会改的口径**，
//   改的时候只动这一个文件，不去翻 pendingDealPushService）。
//
// 🔴 2026-10-07 口径大改：交易类型 = 库存有没有（现货 / 预定），「未付」不再是类型。
//   ⇒ 候选源从"未付 / 预付两个**交易类型编码**"改成
//     「**预定（还没交付）** ＋ **现货但钱没结清**」= **尚未完成履约**（见下方分区判据）。
//   ⇒ 分区标题从 `预付 / 未付` 改成 `预定 / 现货待收`（文案仍可配）。
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
// ⇒ 她只要「单号 + 【预定/现货待收】 + 货号+尺码 + 待收金额 + 深链」，**不要售出时间**。
// ⚠️ 她给的那张形状里"分区"与"行内标签"是**并存**的（她两处都写了），所以这里也是两处都有：
//    区块标题用 `sectionTemplate`，每行里的 `{tag}` 还是同一个区块标题。
// ⚠️ 下面这些**全是显示文案**（改文案不碰逻辑）：本文件之外的 service 里
//    **一行中文都不写**，所以换说法 / 换顺序 / 换分隔符只改这里或环境变量。

const { readString, readFlag, readInt, readList } = require('./envValue');

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

// 默认 9 点（北京时间，业务负责人说的）。
const DEFAULT_PUSH_HOUR = 9;
// 默认 10 分钟一 tick：与「第二次交付」提醒同一个节奏。判断"今天该不该跑"不靠定时精度，
// 而靠**按天认领**（见 pendingDealPushService.sendDailyPush），所以 tick 落在哪一刻无所谓。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

// 两个区块的**身份**（业务事实，不是文案）：
//   · key       = 内部键（`blockOrder` 里写的是它）；
//   · criterion = 分区**判据**（`PENDING_DEAL_PUSH_BLOCK_CRITERIA` 之一）——
//                 ⚠️ **不是**交易类型编码：新口径下类型 = 库存有没有，
//                 "未付" 不再是一种类型，"哪一笔该推" 由**履约 / 资金进展**决定。
//   · title     = 区块标题（也是行内那个 `【预定】` 标签）——文案，可配。
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
  }),
  Object.freeze({
    key: 'cash_pending',
    criterion: PENDING_DEAL_PUSH_BLOCK_CRITERIA.deliveredUnpaid,
    titleEnvKey: PENDING_DEAL_PUSH_CASH_PENDING_TITLE_ENV_KEY,
    defaultTitle: '【现货待收】',
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
  // 表头：`{total}` 仍是"总共几笔"（口径不变），`{blockCounts}` 后面补一句分区计数，
  // 免得她看到"共 2 笔"却数不出两块各几笔。
  headerTemplate: '⏰ {day} 最近 7 天待处理的销售单（预定 / 现货待收）：{total} 笔{blockCounts}',
  blockCountsTemplate: '（{counts}）',
  blockCountTemplate: '{title}{count} 笔',
  blockCountSeparator: ' / ',
  // 区块 = 标题行 + 该区块每单一行。
  sectionTemplate: '{title}{count} 笔\n{lines}',
  // 行 = 逐段拼，**空的那一段整段不要**（缺深链时不会留下 ` · ` 或空壳）。
  lineParts: ['{index}. {orderNo} {tag}', '{item}', '待收 {amount}', '{link}'],
  lineSeparator: ' · ',
  // 一件商品：`货号 尺码码`；配品没有尺码 → `{size}` 为空 → 拼完只剩名称（**不会出现「 码」**）。
  itemTemplate: '{itemNo} {size}',
  // 一单多件时**逐件列出**，件与件之间用这个分隔符（默认顿号）。
  itemSeparator: '、',
  sizeTemplate: '{size}码',
  footerTemplate: '（{count} 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）',
});

// 每个模板认得的占位符。写错名字（`{itemNO}` 这种）**启动时**就抛错——
// 不认识的占位符会被渲染成空串，那等于悄悄少给她一段信息，属于最难查的一类。
const TEMPLATE_PLACEHOLDERS = Object.freeze({
  headerTemplate: Object.freeze(['day', 'total', 'blockCounts']),
  blockCountsTemplate: Object.freeze(['counts']),
  blockCountTemplate: Object.freeze(['title', 'count']),
  sectionTemplate: Object.freeze(['title', 'count', 'lines']),
  linePart: Object.freeze(['index', 'orderNo', 'tag', 'item', 'amount', 'link']),
  itemTemplate: Object.freeze(['itemNo', 'size']),
  sizeTemplate: Object.freeze(['size']),
  footerTemplate: Object.freeze(['count']),
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

/** 区块（**已按配置排好序**）：`[{ key, tradeTypeCode, title }]`。 */
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
  // 拿不到深链时要不要**干脆不推**。默认 false = 照推单号 + 金额（深链是增强，不是前提）。
  linkRequired: readFlag(env, PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY, false),
  // 发出后要不要**把那条消息置顶**（飞书 im/v1/pins）。**默认 false**，理由：
  //   · 置顶是**群里每个人都看得见**的副作用，而且飞书那边有额外门槛——
  //     应用要有 `im:message.pins:write_only`（或 `im:message`）权限、机器人必须在群里、
  //     群若设成"仅群主/群管理员可 Pin"就直接失败（错误码 230046）；
  //   · 本仓既有纪律：对外可见的动作一律**显式开关、默认关**（本推送的总开关自己也默认 false）；
  //   · 打开时**必须显式写 true**，不会因为"只想试推送"就顺手把消息钉在群顶上。
  // ⚠️ 置顶失败绝不影响推送本身（只记 warn，见 services/larkMessagePinService）。
  pinEnabled: readFlag(env, PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY, false),

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
  footerTemplate: assertTemplate(PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY,
    readString(env, PENDING_DEAL_PUSH_FOOTER_TEMPLATE_ENV_KEY, PENDING_DEAL_PUSH_DEFAULTS.footerTemplate),
    TEMPLATE_PLACEHOLDERS.footerTemplate),
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
  PENDING_DEAL_PUSH_BLOCK_DEFS,
  PENDING_DEAL_PUSH_BLOCK_CRITERIA,
  PENDING_DEAL_PUSH_DELIVERED_STATUS,
  PENDING_DEAL_PUSH_DEFAULTS,
  DEFAULT_PUSH_HOUR,
  DEFAULT_INTERVAL_MS,
  resolvePendingDealPushConfig,
  pendingDealPushCriterionFor,
  // 显式布尔那条规矩的实现在 config/envValue；这里转发一下，单测仍然可以盯住它。
  readFlag,
};
