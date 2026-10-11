const OpenAI = require('openai');
const { logError, logInfo } = require('../utils/logger');
const { applyGroupBuyVoucherPolicy } = require('./groupBuyVoucherPolicy');
const { resolveLlm, assertLlmConfigured } = require('../config/llmModels');
// ⭐ 「全到」说法的兜底词表（配置先行）：改清单不改代码，见 config 里的长注释。
const { ARRIVAL_ALL_PRESENT_PHRASES } = require('../config/arrivalConversation');
const {
  normalizeMessageIntent,
  isAfterSalesIntent,
} = require('../config/saleIntents');
const {
  resolveAfterSalesAction,
  resolveAfterSalesSettlement,
  resolveAfterSalesRestockState,
} = require('../config/afterSalesFlow');
// 飞书单元格 → 文字的唯一实现（文本/单选/多选/`{text}`/`[{text}]` 都认）。
// ⚠️ 刻意 require 既有的那一份，**不新造 helper**。2026-10-07 线上真事：
//    本文件里调了一个**没有定义**的名字 `text` → `ReferenceError: text is not defined`
//    → 业务负责人在话题里回复到货情况后「解析失败、没有卡片、没有下文」
//    （`purchase.arrival.reconcile.parse_failed`）。回归用例见
//    test/doubaoArrivalReconcileParse.test.js（源码级断言也钉住"不许再用那个名字"）。
//    依赖方向核过：`v1BitableGateway` 不会（直接或间接）require 回本文件，不构成循环依赖。
const { textValue } = require('./v1BitableGateway');
// 中文交易类型 → 行为编码（`SALE_CASH` / `SALE_PREPAID`）的**唯一**对照表，
// 以及"定金 / 尾款落在哪一件"（资金口径）的配置判据。
// ⚠️ 两个都从 `config/` 拿，本文件不许自己写 `'SALE_PREPAID' === ...` 这种散落判断。
const { tradeTypeCodeFromLabel, tradeTypeLabel } = require('../config/salesMovements');
const { isPrepaidTradeType, orderTradeTypeCodes, SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS } =
  require('../config/salesTradeTypePolicy');
// 「定金 / 尾款」这套**资金说法**的词表与文案（配置先行）：换一种说法只改 config，不碰代码。
// ⚠️ 真机 2026-10-07 22:59 那句话——「定金交了 100 元，微信，**下次收**120元」——
//    就是下面 `TAIL_PATTERNS` 里的动词漏了 `收`（旧正则只认「欠 / 付 / 给 / 交 / 补」）。
//    ⭐ 方向词**不改变性质**：她说的是"下次**收**"，那笔钱**还没到手** ⇒ 它是 `owed`（尾款），
//    不是本次已收款。
const {
  TAIL_PATTERNS,
  FUTURE_MARKER_PATTERN,
  CLAUSE_BOUNDARY_PATTERN,
  MONEY_NOT_SETTLED_PATTERN,
  SALES_DEPOSIT_TOTAL_UNKNOWN,
} = require('../config/salesDepositTerms');
// 中文交易类型只认这两个（与 config/salesMovements 的对照表同源）。
// 🔴 2026-10-07：这里的 `trade_type` 只是**她嘴上说的性质**（提示），**不是类型判据** ——
//    类型由 `services/larkMvpService` **查完实时库存**再定（有货 → 现货，没货 → 预定）。
//    它只在这两处还有用：① 配品（没有货号/尺码，无从查库存）沿用她说的性质；
//    ② 多明细 + 定金时，定位"定金 / 尾款落在哪一件"（资金口径，见 `depositTargetIndex`）。
//    ⚠️ 「未付」**不在**表里 —— 它不再是交易类型（那只是"现货 + 钱没结清"）。
const SALES_TRADE_TYPE_LABELS = Object.freeze(['现货', '预定', '预付']);

// ── 到货核对：「全到」说法的**兜底判定**（业务负责人 2026-10-07 批准，真机漏判）──────────
//
// 【这一层是干什么的】真机 2026-10-07 21:52：她在两个话题里各发一句 ——
//   · 「都到了」  → 模型 `same:true` → 出卡片 → 确认后入库 12 行 ✅
//   · 「都到货了」→ 模型 `same:false` / `differences:[]` → 判据 `hasArrivalContent` 不成立
//     → `purchase.arrival.reconcile.no_arrival_content` → **不出卡片** ❌
//   两句意思完全一样，只多了「货」两个字 ⇒ **模型漏判**。
// ⇒ 提示词里已把这些说法列成等价（模型层）；这里再加一层**代码侧兜底**
//   —— 真机那次就是模型没认出来，模型不是确定性的，只改提示词挡不住第二次。
//
// 🔴 边界（**绝不放宽"有具体内容"的情形**）：这一层只在**模型什么都没给出来**
//    （`same !== true` 且 `differences` 为空）时补一句"这是全到"；
//    **整句**能被清单词完整切分、且不含数字 / 数量字 / 单位 / 否定 / 疑问，才算"裸的全到说法"。
//    词表在 `config/arrivalConversation.js` 的 `ARRIVAL_ALL_PRESENT_PHRASES`（配置先行）。
const ARRIVAL_ALL_PRESENT_VOCABULARY = new WeakMap();

/** 词表 = 三类词的并集，**按长度倒序**（贪心最长匹配：`到齐` 不会被拆成 `到` + `齐`）。 */
const arrivalAllPresentVocabulary = (phrases) => {
  const cached = ARRIVAL_ALL_PRESENT_VOCABULARY.get(phrases);
  if (cached) return cached;
  const vocabulary = [...new Set([
    ...phrases.completeWords, ...phrases.arrivalWords, ...phrases.fillerWords,
  ])].sort((left, right) => right.length - left.length);
  ARRIVAL_ALL_PRESENT_VOCABULARY.set(phrases, vocabulary);
  return vocabulary;
};

/** 去空白与标点（`，。！` / 全角空格 / 换行）—— 断句与语气不参与判定。 */
const stripArrivalPunctuation = (raw) => String(raw ?? '')
  .replace(/[\s\u3000]/g, '')
  .replace(/\p{P}/gu, '');

/** 「有具体内容」= 数字 / 货号字母 / 中文数量字 / 数量单位（有它就不许兜底）。 */
const hasConcreteArrivalContent = (raw, phrases) => {
  const text = stripArrivalPunctuation(raw);
  if (!text) return false;
  if (new RegExp(phrases.concreteContentPattern).test(text)) return true;
  return [...phrases.numberWords, ...phrases.quantityUnitWords].some((word) => text.includes(word));
};

/**
 * 一句话是不是"裸的全到说法"（保守判定，**不做业务判断**）。
 *
 * @param {string} raw 她说的原话
 * @param {object} [phrases] 词表（默认取 config；可注入 = 换清单不改代码）
 * @returns {{matched:boolean, reason:string, tokens?:string[]}}
 *   `reason` 是排查口径：为什么算（`bare_all_arrived`）/ 为什么不算
 *   （`question` / `negation` / `concrete_content` / `out_of_vocabulary` /
 *    `no_complete_word` / `no_arrival_word` / `empty`）。
 */
const detectBareAllArrivedStatement = (raw, phrases = ARRIVAL_ALL_PRESENT_PHRASES) => {
  const source = String(raw ?? '');
  if (!source.trim()) return { matched: false, reason: 'empty' };
  // 问句不是"到货反馈"（`？` 会在下面被当标点去掉，所以先看原文）。
  if (phrases.questionMarkers.some((marker) => source.includes(marker))) {
    return { matched: false, reason: 'question' };
  }
  const text = stripArrivalPunctuation(source);
  if (!text) return { matched: false, reason: 'empty' };
  if (phrases.negationWords.some((word) => text.includes(word))) {
    return { matched: false, reason: 'negation' };
  }
  if (hasConcreteArrivalContent(source, phrases)) {
    return { matched: false, reason: 'concrete_content' };
  }
  const vocabulary = arrivalAllPresentVocabulary(phrases);
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const token = vocabulary.find((word) => text.startsWith(word, index));
    if (!token) return { matched: false, reason: 'out_of_vocabulary' };
    tokens.push(token);
    index += token.length;
  }
  // 至少要有一个"全到"的标记（全/都/齐）＋ 一个到货动词，才算"整批全到"。
  if (!tokens.some((token) => phrases.completeWords.includes(token))) {
    return { matched: false, reason: 'no_complete_word', tokens };
  }
  if (!tokens.some((token) => phrases.arrivalWords.includes(token))) {
    return { matched: false, reason: 'no_arrival_word', tokens };
  }
  return { matched: true, reason: 'bare_all_arrived', tokens };
};

/**
 * 整段原话里找"裸的全到说法"（多条消息的形状，**保守**）：
 *   ① 整段拼起来就是一个裸说法；或
 *   ② **最新一句**是裸说法，且**其它消息里没有任何具体内容**（数量 / 单位 / 货号）——
 *      否则她可能正在说具体差异、只是模型没解析出来，那时**绝不兜底**。
 */
const detectBareAllArrivedTranscript = (messages, phrases = ARRIVAL_ALL_PRESENT_PHRASES) => {
  const texts = (Array.isArray(messages) ? messages : [])
    .map((line) => String(line ?? '').trim()).filter(Boolean);
  if (!texts.length) return { matched: false, reason: 'empty_transcript' };
  const whole = detectBareAllArrivedStatement(texts.join('\n'), phrases);
  if (whole.matched) return { ...whole, scope: 'whole_transcript' };
  if (texts.length === 1) return whole;
  const latest = detectBareAllArrivedStatement(texts[texts.length - 1], phrases);
  if (!latest.matched) return latest;
  if (texts.slice(0, -1).some((line) => hasConcreteArrivalContent(line, phrases))) {
    return { matched: false, reason: 'other_message_has_concrete_content' };
  }
  return { ...latest, scope: 'latest_message' };
};

// Log only the sale fields needed to compare AI extraction with deterministic
// normalization. Never log the complete user message, prompt or raw model JSON.
const salesParseSnapshot = (result = {}) => ({
  intent: result.intent,
  trade_type: result.trade_type,
  items: (Array.isArray(result.items) && result.items.length ? result.items : [result]).map((item) => ({
    item_no: String(item.item_no || '').slice(0, 80),
    color: String(item.color || '').slice(0, 40),
    size: item.size,
    quantity: item.quantity,
    actual_amount: item.actual_amount,
    // 配品的档位价位（只用于对记录，不落库）：出问题时能看出"她说的 119 是档位还是实收金额"。
    tier_price: item.tier_price,
    gift: item.gift,
    gift_description: String(item.gift_description || '').slice(0, 100),
  })),
  payments: (Array.isArray(result.payments) ? result.payments : []).map((payment) => ({
    method: String(payment.method || '').slice(0, 40), amount: payment.amount, status: payment.status,
  })),
  agreed_total: result.agreed_total,
  // 她明说的欠款：这是"要不要挂未收款"的唯一依据，必须看得见。
  owed: result.owed,
  total_paid: result.total_paid,
  payment_method: result.payment_method,
  // 售后的几个字段同样记进快照：出问题时能回答"模型到底听成了退货还是换货、
  // 钱是怎么走的"，而不是只知道 intent=return。
  action: result.action,
  ordinal: result.ordinal,
  settlement: result.settlement,
  diff_amount: result.diff_amount,
  restock_state: result.restock_state,
  new_item_no: String(result.new_item_no || '').slice(0, 80),
  // ⭐ 2026-10-07：换货"新的一双"的另外三个字段也要看得见 —— 真机那次
  // 「6C98012-15L 换成41码」出问题时，日志里**只有 new_item_no**（为空），
  // `new_size` 到底空没空只能靠猜；"同款换码"这条路一开，new_size 就是关键判据。
  new_color: String(result.new_color || '').slice(0, 40),
  new_size: result.new_size,
  new_amount: result.new_amount,
  missing_fields: (Array.isArray(result.missing_fields) ? result.missing_fields : [])
    .map((field) => String(field).slice(0, 100)),
});

const explicitSingleShoeGifts = (sourceText) => [...String(sourceText || '')
  .matchAll(/(?:赠送?|送)(?:了)?\s*([^，,。；;、]+?)(?=[，,。；;、]|$)/g)]
  .map((match) => match[1].trim().replace(/^双(?=鞋垫|袜子|鞋带)/, '一双')).filter(Boolean);

// 「定金」附近的金额（业务负责人 2026-10-07 真机 BUG#1）。
//
// 现场（逐字）：「26002-52 37 码，定金微信交了 100 元，下次欠 128 元」
// 解析层给出的 payments / agreed_total / owed **全对**，可缺项判定仍然回了一句
// 「请明确已经收到的定金金额」—— 她已经说了。根因就在旧正则里：它只认
//   · 「定金」紧贴数字（`定金100`），或
//   · 「100元定金」这种把收款方式省掉的写法，
// 一旦中间夹了收款方式/动词（「定金**微信交了**100元」）就整个匹配不上，
// 于是走到下面无条件报"没说定金金额"那一支 —— 这是**无中生有**，不是保守。
//
// 做法：以「定金」为锚点，**先看它后面那一小句、再看它前面那一小句**：
//   · 不跨标点、也不跨余额词（`下次`/`欠`/`尾款`…）—— 否则会把尾款或别的数字当定金；
//   · 后面先认「像钱」的数（`100元` / `¥100`），认不出再退回"离定金最近、
//     且不是紧跟着码/号的那个数"（`定金100微信` 这种把「元」省掉的写法）；
//   · 前面**只认「像钱」的数**（有 `元`/`块`/`¥`）—— 这一条是必须的：
//     写「26002-52 37码 定金微信交的」时，前面那串 26002 / 52 / 37 **都不是钱**，
//     放宽就会把货号里的 52 当定金，于是明明没说金额却"认"出一个来。
//   · 前面的钱**从后往前取**（离「定金」最近的那个）：写「26002-52 37码 100元定金」时，
//     答案该是 100。
// 找不到就返回 null —— 仍然报「请明确已经收到的定金金额」，**这一条不放宽**。
// ⚠️ 边界词表在 `config/salesDepositTerms.CLAUSE_BOUNDARY_PATTERN`（配置先行）。
const DEPOSIT_CLAUSE_BOUNDARY = CLAUSE_BOUNDARY_PATTERN;
// 「像钱」：`100元` / `100 块` / `¥100`。
const DEPOSIT_MONEY = /[¥￥]\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:元|块)/g;
// 任意数，但**不许紧跟着「码」「号」**（那是尺码或货号，不是钱）。
const DEPOSIT_NUMBER = /(\d+(?:\.\d{1,2})?)(?!\d)(?!\s*[码号])/g;

const depositNumbers = (text, pattern) => (String(text).match(pattern) || [])
  .map((hit) => Number(String(hit).replace(/[¥￥\s元块]/g, '')))
  .filter((value) => Number.isFinite(value));

const depositAmountNear = (source) => {
  const anchor = source.search(/定金/);
  if (anchor < 0) return null;
  const cutAtBoundary = (text) => {
    const match = text.match(DEPOSIT_CLAUSE_BOUNDARY);
    return match ? text.slice(0, match.index) : text;
  };
  // ① 「定金」后面：定金微信交了 100 元 / 定金100元 / 定金100微信
  const after = cutAtBoundary(source.slice(anchor + '定金'.length));
  const afterMoney = depositNumbers(after, DEPOSIT_MONEY);
  if (afterMoney.length) return afterMoney[0];
  const afterAny = depositNumbers(after, DEPOSIT_NUMBER);
  if (afterAny.length) return afterAny[0];
  // ② 「定金」前面**同一小句**里最后一个「像钱」的数：100元微信定金
  const prefix = source.slice(0, anchor);
  const clauseStart = Math.max(...[...'，,。；;、！!？?\n'].map((mark) => prefix.lastIndexOf(mark)));
  const beforeMoney = depositNumbers(cutAtBoundary(prefix.slice(clauseStart + 1)), DEPOSIT_MONEY);
  return beforeMoney.length ? beforeMoney[beforeMoney.length - 1] : null;
};

const depositTerms = (sourceText) => {
  const source = String(sourceText || '');
  if (!/定金/.test(source)) return null;
  const afterDeposit = source.slice(source.search(/定金/) + '定金'.length);
  // ⭐ 尾款的三种说法（词表在 `config/salesDepositTerms.TAIL_PATTERNS`，配置先行）：
  //   ① 名词说法（尾款 / 余款 / 剩下…）—— 在**整句**上找；
  //   ② 时间词开头（下次收 / 下次付 / 以后给…）；
  //   ③ 没有时间词（还欠 / 还差 / 还要收 / 再付 / 补收…）。
  // ⚠️ ②③ 只在「定金」**之后**找：定金前面的数字属于上一句，
  //    把「上次还欠 200」当成本单尾款会把实收金额算错。
  // ⭐ 「**下次收** 120」正是 ② 那一支——`收` 与 `付` 方向**同义**：都是"还没到手的钱"。
  const tail = source.match(TAIL_PATTERNS[0])
    || afterDeposit.match(TAIL_PATTERNS[1])
    || afterDeposit.match(TAIL_PATTERNS[2]);
  const depositAmount = depositAmountNear(source);
  if (depositAmount == null) return { issues: ['请明确已经收到的定金金额'] };
  if (!tail) return { depositAmount, issues: [] };
  if (!FUTURE_MARKER_PATTERN.test(source)) {
    return { issues: ['请说明尾款是否已支付；若尚未支付，请写“尾款以后付”'] };
  }
  return { depositAmount, tailAmount: Number(tail[1]), issues: [] };
};

/**
 * 「定金 / 尾款」属于**哪一条明细**？（业务负责人 2026-10-07：一张单可以多明细，不拆单）
 *
 *   ① 单明细 → 就是它（**逐字沿用**旧行为，单类型单不受这次改动影响）；
 *   ② 多明细 → **唯一一件**「预付性质」的明细（判据在 `config/salesTradeTypePolicy`，
 *      本文件不认识「预付」这个词；真机上模型会把付了定金的那一件标成预付）；
 *   ③ 一件都没标成预付时退一步：**只有一件"带尺码的鞋"** → 就是那双鞋
 *      （定金/定制说的都是那双鞋；配品没有尺码，鞋才有）；
 *   ④ 其余（0 件或多件说得通）→ -1，**说不清就绝不猜**，调用方报缺项。
 */
const depositTargetIndex = (items = [], singleLine = false) => {
  if (!items.length) return -1;
  if (singleLine) return 0;
  const prepaid = items
    .map((item, index) => (isPrepaidTradeType(item.trade_type_code) ? index : -1))
    .filter((index) => index >= 0);
  if (prepaid.length === 1) return prepaid[0];
  if (prepaid.length === 0) {
    const shoes = items
      .map((item, index) => (item.kind !== 'accessory' && item.size ? index : -1))
      .filter((index) => index >= 0);
    if (shoes.length === 1) return shoes[0];
  }
  return -1;
};

const positiveOrEmpty = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : '';
};
const moneyOrEmpty = (value) => {
  const number = positiveOrEmpty(value);
  return number && Math.abs(number * 100 - Math.round(number * 100)) < 1e-6 ? number : '';
};

// 「第 2 笔」里的序号。模型应该给 ordinal，但它偶尔漏字段；序号错了会指到另一笔，
// 所以再用一次确定性文本兜底（这一段是纯文本，不会认错语义）。
const ordinalFromText = (sourceText) => {
  const match = String(sourceText || '').match(/第\s*(\d+)\s*笔/);
  if (!match) return '';
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : '';
};

const optionalSignedMoney = (value) => {
  if (value == null || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : '';
};

/**
 * 退换货的规范化（第二期·第二步）。
 *
 * 为什么单独一个函数、并且在 normalizeSalesResult 的**最前面分流**：
 *   销售字段（items / payments / agreed_total）和售后字段（要退哪一双 / 钱怎么走 /
 *   回库状态）是两套契约。混在一个对象里迟早出现"sale 的 items 被当成要退的鞋"，
 *   所以按意图分流，各自只装自己的字段。
 *
 * 这里只做**收敛**，不做业务判断：
 *   · action / settlement / restock_state 都走 config/afterSalesFlow 的别名表，
 *     模型写中文、英文、简写都落到同一个值；
 *   · 她说"第 2 笔"时模型给 ordinal，漏了就按原话文本兜底（见 ordinalFromText）；
 *   · 差价只认她说的数（模型不许自己算），没说到就留空由接线层给建议值。
 */
const normalizeAfterSalesResult = (result = {}, sourceText = '') => {
  const intent = normalizeMessageIntent(result.intent);
  const first = (Array.isArray(result.items) && result.items[0]) || {};
  const size = Number(result.size || first.size);
  const newSize = Number(result.new_size || result.newSize);
  return {
    intent,
    action: resolveAfterSalesAction({
      action: result.action || result.after_sales_action,
      intent,
      // 兜底关键词用原话：模型漏了 action 时，"赔/换/退"仍然能分清动作。
      text: sourceText,
    }),
    ordinal: Number.isSafeInteger(Number(result.ordinal)) && Number(result.ordinal) > 0
      ? Number(result.ordinal)
      : ordinalFromText(sourceText),
    item_no: String(result.item_no || first.item_no || '').trim(),
    color: String(result.color || first.color || '').trim(),
    size: Number.isSafeInteger(size) && size > 0 ? size : '',
    new_item_no: String(result.new_item_no || result.newItemNo || '').trim(),
    new_color: String(result.new_color || result.newColor || '').trim(),
    new_size: Number.isSafeInteger(newSize) && newSize > 0 ? newSize : '',
    new_amount: moneyOrEmpty(result.new_amount ?? result.newAmount),
    settlement: resolveAfterSalesSettlement(result.settlement),
    diff_amount: optionalSignedMoney(result.diff_amount ?? result.diffAmount),
    restock_state: resolveAfterSalesRestockState(result.restock_state ?? result.restockState),
    // 售后这条链路不需要"缺哪些字段"清单：信息不够时由接线层直接问她
    // （缺哪一双 / 缺尺码 / 缺金额），问法比字段名清单更像人话。
    missing_fields: [],
  };
};

const normalizeSalesResult = (result = {}, sourceText = '', { vouchers = [] } = {}) => {
  // 退换货走自己的字段契约（第二期）：销售字段与售后字段不混装。
  // 这一分流必须在最前面——否则下面的 items/payments 规范化会把"要退的那一双"
  // 当成"卖出去的一双"，而这一期的售后**还没有**任何销售字段。
  if (isAfterSalesIntent(normalizeMessageIntent(result.intent))) {
    return normalizeAfterSalesResult(result, sourceText);
  }
  // 交易类型只是**她嘴上说的性质**（提示）：说不清时按现货处理（门店绝大多数是
  // "当场收钱当场交货"，不说不给钱就是现货 —— 这不是猜，是业务前提）。
  // 🔴 **它不是类型判据**：真正的类型由接线层**查完实时库存**再定
  //    （有货 → 现货，没货 → 预定；见 `config/salesTradeTypePolicy.salesTradeTypeForStock`）。
  // 交付状态也不在这里定：它由 SALES_MOVEMENTS 从**最终**的交易类型推出来。
  // ⚠️ 统一成**规范标签**（`预付` → `预定`；认不出的 → 空串）。
  //    模型偶尔还按旧说法输出「预付」，落到草稿 / 卡片 / 日志上只许出现规范标签。
  const tradeType = tradeTypeLabel(tradeTypeCodeFromLabel(
    SALES_TRADE_TYPE_LABELS.includes(result.trade_type) ? result.trade_type : '现货',
  )) || '现货';
  const rawItems = Array.isArray(result.items) && result.items.length ? result.items : [result];
  const items = [];
  for (const item of rawItems) {
    // ── 逐明细的交易类型（业务负责人 2026-10-07 拍板）──────────────────────────────
    //   「**在销售明细里面分开，它是现货还是预付款**，不就可以了吗？」
    // 取法：这一行自己说的优先（模型现在按 `items[].trade_type` 输出）；
    //       这一行没说 → 退回整单的类型（既有单类型单走的就是这一条路，逐字不变）。
    const itemTradeType = SALES_TRADE_TYPE_LABELS.includes(item.trade_type) ? item.trade_type : tradeType;
    const itemTradeTypeCode = tradeTypeCodeFromLabel(itemTradeType);
    // 规范标签：认得出编码就用注册表的标签（`预付` → `预定`），认不出（例如「未付」）留空串 ——
    // 那表示"这一行没有可用的类型提示"，最终类型由实时库存定（见 larkMvpService）。
    const itemTradeTypeLabel = tradeTypeLabel(itemTradeTypeCode);
    const giftDescription = String(item.gift_description || '').trim();
    const gift = item.gift === true || Boolean(giftDescription);
    // 配品（腰带、鞋油、袜子、包等）：没有货号、颜色、尺码，只有名字和金额。
    // 必须在「赠品归并」之前判断，否则一件配品会被当成上一件鞋的赠品。
    if (item.kind === 'accessory' || (!item.item_no && item.accessory_name)) {
      const spokenAmount = moneyOrEmpty(item.actual_amount);
      items.push({
        kind: 'accessory',
        accessory_name: String(item.accessory_name || item.name || '').trim(),
        quantity: positiveOrEmpty(item.quantity) || 1,
        // 配品分很多价位（腰带 9 档），她用价位说明是哪一档：这个价位**只用来对记录**。
        // 模型把它放在 tier_price 或 actual_amount 里都认；实收金额下面会按第 9 条重算，
        // 所以 tier_price 不落库、也不当实收金额（业务负责人口径）。
        tier_price: moneyOrEmpty(item.tier_price ?? item.tierPrice) || spokenAmount,
        actual_amount: spokenAmount,
        trade_type: itemTradeTypeLabel,
        trade_type_code: itemTradeTypeCode,
        gift,
        gift_description: giftDescription,
      });
      continue;
    }
    // Some model responses turn a free gift into a separate shoe item. It is
    // not a sold SKU; attach it to the preceding sold item instead.
    if (gift && !positiveOrEmpty(item.size) && items.length) {
      items[items.length - 1].gift = true;
      items[items.length - 1].gift_description = giftDescription || String(item.item_no || '').trim();
      continue;
    }
    items.push({
      item_no: String(item.item_no || '').trim(),
      color: String(item.color || '').trim(),
      size: positiveOrEmpty(item.size),
      quantity: positiveOrEmpty(item.quantity) || 1,
      actual_amount: moneyOrEmpty(item.actual_amount),
      trade_type: itemTradeTypeLabel,
      trade_type_code: itemTradeTypeCode,
      gift,
      gift_description: giftDescription,
    });
  }
  const rawPayments = Array.isArray(result.payments)
    ? result.payments
    : result.total_paid || result.payment_method
      ? [{ amount: result.total_paid, method: result.payment_method }]
      : [];
  let payments = rawPayments.map((payment) => ({
    amount: moneyOrEmpty(payment.amount), method: String(payment.method || '').trim(),
  }));
  let agreedTotal = moneyOrEmpty(result.agreed_total);
  // 她**明说**的欠款金额（owed）。它是"要不要挂未收款"的唯一依据：
  // ⚠️ 本系统**没有「打折」这个概念**（业务负责人明确说过）：真实现象只有一种——
  // 她说收到多少钱，那就是这一单的实收金额；没收到的那部分，只在她说了"欠"时才是未收款。
  // 所以这里绝不能用「成交 − 已收」的差额去推欠款。
  let owed = moneyOrEmpty(result.owed ?? result.unpaid);
  if (items.length === 1 && !items[0].actual_amount && agreedTotal) items[0].actual_amount = agreedTotal;
  if (!agreedTotal && items.length && items.every((item) => item.actual_amount)) {
    agreedTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) * 100) / 100;
  }
  const deposit = depositTerms(sourceText);
  if (deposit && !deposit.issues.length) {
    // ⭐ 一条单里可以既有现货明细、又有预付明细（业务负责人 2026-10-07）：
    //   「**这就是一个人买的呀**」——不拆单，定金/尾款落到**那一件预付明细**上。
    const singleLine = items.length === 1;
    const matching = payments.filter((payment) => Number(payment.amount) === deposit.depositAmount);
    if (matching.length === 1) {
      const spokenMethod = sourceText.match(/(微信|现金|支付宝)\s*(?:支付|付|交|收)?\s*定金/)?.[1] ||
        sourceText.match(/定金\s*[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?\s*(微信|现金|支付宝)/)?.[1];
      if (singleLine) {
        // 单明细：**逐字沿用**旧行为（只留定金那一笔 —— 尾款还没付，不是已收款）。
        payments = [{ ...matching[0], method: spokenMethod || matching[0].method }];
      } else {
        // 多明细：**别的收款都要留着**（真机那单里现货那笔 119 不能被定金这段丢掉）；
        // 只做两件事：① 修正定金那笔的收款方式（她说了就用她说的）；
        //              ② 去掉"还没付的尾款"那笔（模型偶尔会把它当成一笔收款）。
        const kept = payments.filter((payment) =>
          !(deposit.tailAmount && Number(payment.amount) === deposit.tailAmount));
        payments = kept.map((payment) => (payment === matching[0]
          ? { ...payment, method: spokenMethod || payment.method } : payment));
      }
    }
    else deposit.issues.push('请明确本次定金的支付方式');
    if (deposit.tailAmount) {
      const targetIndex = depositTargetIndex(items, singleLine);
      if (targetIndex < 0) {
        // 说不清定金属于哪一件 ⇒ 绝不猜（宁可问一句，也不把尾款挂到错的鞋上）。
        // ⚠️ 这是**新的**判据/文案（进 config），不是原来那条整单护栏的翻版：
        //    真机上模型按 `items[].trade_type` 给出「哪一件是预付」时，这里根本不会走到。
        deposit.issues.push(SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS);
      } else {
        const expectedTotal = Math.round((deposit.depositAmount + deposit.tailAmount) * 100) / 100;
        const statedPrice = sourceText.match(/(?:成交价|实收金额|总价)\s*(?:是|为)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
        if (statedPrice && Number(statedPrice[1]) !== expectedTotal) {
          deposit.issues.push('成交价与定金加尾款不一致，请核对');
        }
        items[targetIndex].actual_amount = expectedTotal;
        // 单明细：整单成交额就是「定金 + 尾款」（逐字沿用旧行为）。
        if (singleLine) agreedTotal = expectedTotal;
        // 「尾款以后付」= 她明说欠这笔尾款 → 后端据此补一条未收款（见 salesOrderService）。
        owed = deposit.tailAmount;
      }
    }
    // 多明细：整单成交额按「**各分项之和**」（#231 的口径）重算 —— 定金那段**不再**直接
    // 决定整单金额（否则一件预付的定金+尾款会盖住整单里别的行）。
    if (!singleLine && !deposit.issues.length && items.length &&
      items.every((item) => item.actual_amount)) {
      agreedTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) * 100) / 100;
    }
  }
  // ⭐ 她**只说了定金、没说尾款** ⇒ 成交额还没定（「**只有定金不能当实收金额**」这条既有规则
  //    **一个字没动**：`agreedTotal` 照样是空的，照样报缺项、照样不入账）。
  //    变的只是**提示**：这时**绝不许**报"已收的钱比实收金额还多"——成交额压根是空的，
  //    那句话在她那儿就是误导。改成问她一句「这单实收金额（或定金+尾款分别是多少）」。
  //    ⚠️ 生产者原话在 `config/salesDepositTerms`，她看到的那一层由
  //       `config/salesMissingInfoText` 翻成人话（并把"哪一双"带上，同一件事只留一行）。
  if (deposit && !deposit.issues.length && !deposit.tailAmount && !agreedTotal
    && items.some((item) => !item.actual_amount)) {
    deposit.issues.push(SALES_DEPOSIT_TOTAL_UNKNOWN);
  }
  // ── 「实收金额」的确定性口径（业务负责人口径，对应提示词规则 9）────────────────────
  //   她说了「收到多少钱」、又没说欠款 → 实收金额 = 实收（客户还价：119 的腰带收 100，这单就是 100）；
  //   她明说「还欠 X」              → 实收金额 = 实收 + 欠款（两个数都是她说的，不做减法猜测）；
  //   她只说了价格、没说收多少      → 实收金额 = 她说的那个价格（原逻辑，不掺和）。
  // 只对「整单一条明细」生效：多行时整单收款额没法确定属于哪一行，拆开就变成猜测。
  // 原话里出现"钱还没给清"的说法时一律不套用上面的还价口径——这时"收到的那笔钱"只是
  // 定金/首付，把它当实收金额会把应收金额算丢（这条是保守的护栏，不是判断欠款）。
  // 🔴 2026-10-07：这条护栏**只看"钱"的词**，与交易类型**无关**（资金与类型解耦）。
  //    「未付」在这里是**她说的话**（"钱没结清"），不是一种交易类型。
  // ⭐ 2026-10-07 晚：词表搬进 `config/salesDepositTerms.MONEY_NOT_SETTLED_WORDS`，
  //    并补上「下次收 / 还要收 / 还差…」这些尾款说法 —— 她说"下次收"同样是"钱还没结清"，
  //    不补的话「收了 100，下次收 120」会被静默算成"这单就值 100"（把 120 算丢）。
  const moneyNotSettled = MONEY_NOT_SETTLED_PATTERN.test(String(sourceText || ''));
  // ⭐ 有尺码的鞋**多于一件**时，"整单实收"是**整单**的钱，不属于任何单独一件：
  //    这时若还拿它去覆盖第一件的实收金额，就会造成真机那次的错位
  //    （鞋 400 + 腰带 140 ⇒ 各件之和 540 ≠ 总额 400）。
  //    ⇒ 只有"这一单确实只有一件鞋"时，第 9 条的"实收金额 = 实收"才等于这一件的金额。
  //    ⚠️ 不数配品：卖**单独一件配品**时它也会被"实收"覆盖（那是第 9 条想要的还价口径，
  //       见既有用例「119 的腰带，是收到了 100 元微信」）。
  const hasMultipleShoes = items.filter((item) => item.kind !== 'accessory').length > 1;
  if (items.length === 1 || !hasMultipleShoes) {
    const coveredCents = Math.round(payments
      .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0) * 100);
    const covered = coveredCents / 100;
    if (owed) {
      // 定金单在上面已经按「定金 + 尾款」定过实收金额，这里不覆盖它。
      const named = Math.round((coveredCents + Math.round(owed * 100))) / 100;
      if (!items[0].actual_amount || items[0].actual_amount === covered) {
        items[0].actual_amount = named;
        agreedTotal = named;
      }
    } else if (items.length === 1 && !moneyNotSettled && coveredCents > 0) {
      // ⚠️ 这里**不再看交易类型**（原来写的是 `tradeType === '现货'`）：
      //    "实收金额 = 实收"这条还价口径本来就只跟**钱**有关 —— 她说收到多少、
      //    又没说欠/定金/尾款，成交就是那笔钱。而类型现在由库存决定，
      //    拿它来管钱就是**又把两件事绑回去**（业务负责人明说：资金与类型完全无关）。
      // 覆盖第 9 条只在**真的只有一件**时成立（多件走上面 hasMultipleShoes 的注释）。
      items[0].actual_amount = covered;
      agreedTotal = covered;
    }
  }
  const voucherPolicy = applyGroupBuyVoucherPolicy({ sourceText, items, payments, vouchers });
  if (voucherPolicy?.items) {
    items.splice(0, items.length, ...voucherPolicy.items);
    payments = voucherPolicy.payments;
    agreedTotal = voucherPolicy.agreedTotal;
    // 券后实收金额由后端按券种确定性算好（实收 + 平台结算额），没有"她说的欠款"这回事；
    // 清掉 owed，避免在券单上再挂一条未收款（券 + 未付的组合上面已被明确拒绝）。
    owed = '';
  }
  const first = items[0] || {};
  const tradeTypeCode = tradeTypeCodeFromLabel(tradeType);
  const normalized = {
    // 意图值统一走注册表收敛（见 config/saleIntents）：模型输出「退货」还是 "return"
    // 都落到同一个规范值；认不出来一律 unsupported，绝不猜成 sale 去写单。
    // 本期真正会执行的非 sale 意图只有 sale_query（只读查询）；
    // return / exchange 只识别、不执行。
    intent: normalizeMessageIntent(result.intent),
    // ⚠️ `...first` 必须在 `trade_type` **之前**：`first` 是 items[0]，它现在自己带着
    //    `trade_type` / `trade_type_code`（逐明细的类型）。顺序反了会让"整单的类型"
    //    被第一行的类型静默覆盖 —— 而这两个是不同的东西（整单可以是"现货+预付"两选）。
    ...first,
    // **整单**的交易类型（兼容字段 / 兜底）：模型整单给的值。
    trade_type: tradeType,
    trade_type_code: tradeTypeCode,
    // **整单**去重后的多个编码（业务负责人 2026-10-07：「多种交易类型，你多选就行了」）。
    // 主表「交易类型」写的就是它们；每一件明细的**单选**类型在 `items[].trade_type_code`。
    trade_type_codes: orderTradeTypeCodes(items, tradeTypeCode),
    items,
    payments,
    agreed_total: agreedTotal,
    // 她明说的欠款（没有就是空）。接线层把它传给入账服务，只有它存在才补未收款。
    owed,
    total_paid: payments.filter((payment) => payment.status !== '待平台结算')
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || '',
    total_covered: payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || '',
    payment_method: payments.map((payment) => payment.method).filter(Boolean).join('＋'),
  };
  if (voucherPolicy?.voucher) normalized.voucher = voucherPolicy.voucher;
  normalized.voucher_policy_blocked = Boolean(voucherPolicy?.issues?.length);
  const missing = new Set([...(voucherPolicy?.issues || []), ...(deposit?.issues || [])]);
  if (normalized.intent !== 'sale') missing.add('当前只支持商品销售录单');
  for (const [index, item] of items.entries()) {
    // 配品没有货号、颜色和尺码，只要求名字、数量和金额。
    const requiredKeys = item.kind === 'accessory'
      ? ['accessory_name', 'quantity', ...(normalized.voucher_policy_blocked ? [] : ['actual_amount'])]
      : ['item_no', 'size', 'quantity', ...(normalized.voucher_policy_blocked ? [] : ['actual_amount'])];
    for (const key of requiredKeys) {
      if (!item[key]) missing.add(`items[${index}].${key}`);
    }
    if (item.quantity !== 1) missing.add(`第${index + 1}件请逐双列出实收金额；每条销售明细只能记录一双`);
  }
  // 各件实收金额之和：下面那条"和她说的总额对不对得上"的校验要用它，
  // 而且追问文案里有具体数字她才知道差在哪（真机那次的教训：只说"不一致"没法核对）。
  const itemsAmountCents = items.reduce((sum, item) => sum + Math.round(Number(item.actual_amount || 0) * 100), 0);
  const itemsAmountSum = itemsAmountCents / 100;
  if (items.length && items.every((item) => item.actual_amount) && agreedTotal &&
    Math.abs(itemsAmountSum - Number(agreedTotal)) > 0.005) {
    // ⚠️ 这里**只报缺项**（接线层据此问她、不出确认卡片、不入账），
    //    **绝不**改任何一件的金额去凑总额 —— "按标价/总额分摊"是她明令禁止的。
    missing.add(`你说的总额 ${agreedTotal} 与各件金额之和 ${itemsAmountSum} 对不上，请确认每件多少钱～`);
  }
  for (const [index, payment] of payments.entries()) {
    if (!payment.amount) missing.add(`payments[${index}].amount`);
    if (!payment.method) missing.add(`payments[${index}].method`);
  }
  normalized.missing_fields = [...missing];
  return normalized;
};

// ── 已删除：到货单 / 鞋盒的图片识别辅助与两个识别方法 ──────────────────────
// normalizeDocumentSize / normalizeDocumentRows / DEFAULT_VISION_TIMEOUT_MS /
// visionTimeoutMs / recognizeLabels / recognizePurchaseDocument 全部随
// 「采购到货 → 拍照识别」链路退场删除（2026-10-05）。
//
// 为什么删：这条链路整段不存在了（入口、卡片、字段都撤了），留在 service 里
// 只会让人以为"还有一条图片识别的路可走"。
//
// ⚠️ 2026-10-09 再收窄一次：**采购那一半（`parsePurchaseReportText`）也退场了**
//    （「信息填写」整表被删 ⇒ 「自然语言 ＋ AI 录入」整套退场）。
//    ⇒ 下面这个 class 现在**只剩销售一组文字解析**（`parseSalesText` 与到货核对解析）。

/**
 * Doubao 文字解析服务：销售录单（`parseSalesText`）、到货核对解析、
 * 9 点推送/待处理候选的口径（都属于**销售/到货**那两条现役链路）。
 * 视觉识别（2026-10-05）与采购报单数量说明解析（2026-10-09）都已退场。
 */
class DoubaoService {
  constructor() {
    this.clients = Object.create(null);
  }

  /**
   * 取模型配置。2026-10-05 起只剩文字一组（视觉那组随到货识别退场删掉了）；
   * kind 参数保留是为了不改动调用方签名（调用方一律传 'text'）。
   */
  resolveModel(kind = 'text') {
    return assertLlmConfigured(resolveLlm(kind, process.env));
  }

  getClient(kind = 'text') {
    if (this.clients[kind]) return this.clients[kind];
    const { apiKey, baseURL } = this.resolveModel(kind);
    // 只走 SDK 默认值：文字解析一直是这个口径，视觉那组的「硬超时 + 不重试」
    // 是识别链路专用的，随识别退场一起删了。
    this.clients[kind] = new OpenAI({ apiKey, baseURL });
    return this.clients[kind];
  }

  async parseSalesText(text, { taskId, accessoryNames = [], vouchers = [] } = {}) {
    const llm = this.resolveModel('text');
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('销售原文不能为空');

    const prompt = `
你是鞋店机器人助手。请把用户的一条原话解析为严格 JSON，不得猜测缺失信息。

先按规则 1 判断意图（录销售 / 查销售记录 / 退货 / 换货）；一条销售消息可以包含多双鞋和多种付款方式。只解析事实，不计算售价。

输出结构：
{
  "intent": "sale",
  "trade_type": "现货",
  "items": [{"item_no":"8088-26","color":"棕","size":38,"quantity":1,"actual_amount":230,"trade_type":"现货","gift":false,"gift_description":""}],
  "payments": [{"amount":230,"method":"微信"}],
  "agreed_total": 230,
  "owed": ""
}

规则：
1. 先判断这条消息的意图，intent 只能填四个值之一：
   · "sale"       —— 录入一笔商品销售（含当场收款、预付、先交货后付款）
   · "sale_query" —— 只想**查**历史销售记录，例如「帮我查 6035 黑」「我最近买了一双 6035 黑的鞋，帮我调销售记录」「查一下 6035 黑的销售记录」
   · "return"     —— 要退货（把已卖出的货退回来、退钱）
   · "exchange"   —— 要换货、赔货
   都不是、或判断不了时填 "unsupported"。
   intent="sale_query" 时**只填 item_no（货号）和 color（颜色）**，不要填 size、金额、payments，
   也不要输出销售行为字段；sale_query 的输出结构示例：{"intent":"sale_query","item_no":"6035","color":"黑"}。
   intent="return" 或 "exchange" 时**不输出任何销售字段**（不要 items / payments / agreed_total），
   只按下面第 13 条的售后结构输出：她退哪一双、要退要换还是赔、钱怎么走、退回的鞋放哪。
   intent="sale" 时按下面的规则输出完整销售字段，不输出售后字段。
2. trade_type 只填她**嘴上说的性质**，只能填「现货」「预定」两者之一（**不是判据**）：
   🔴 **最终的交易类型由后端的实时库存决定**（有货 = 现货，没货 = 预定），你**不要**去猜有没有货。
   · 提到定金 / 先付 / 预定 / 定制（以后来取） → \"预定\"
   · 其余一律 \"现货\"（当场收款当场交货——门店绝大多数是这一种，不说不给钱就是现货）
   · ⚠️ 她说「未付 / 欠着 / 下次再给 / 还欠」时**仍然是「现货」** ——
     那只是"鞋 already 拿走了、钱还没结清"，**不是一种交易类型**；
     钱的事按第 9 条的 payments / owed 记，不要因为她说"未付"就改 trade_type。
   团购券只是一种**支付方式**（钱延期结算），不影响 trade_type；用券买走一双鞋仍然是现货。
   不要输出交付状态，后端会按**最终的**交易类型决定是否交付。
   ⭐ **一张单里的每一件都要填自己的 items[].trade_type** —— 一笔生意可以**既卖现货又卖预定**：
     当场拿走的鞋填「现货」，付了定金、以后来取的那双填「预定」。
     整单的 trade_type：所有件一样就填那一个；不一样时填**第一件**的。
     例：「119元微信。卖了31678，40码。定制一双6681-1，42码，定金50元，下次付39元」
     ⇒ items = [{31678 现货 actual_amount=119}, {6681-1 预定}]，trade_type 填「现货」。
   ⚠️ **定金 / 尾款只属于它紧挨着的那一件**（上面例子里是 6681-1），不要摊到别的件上。
3. item_no 只填写用户原话中的货号，不要把颜色、尺码或品类拼进货号。用户可能用任意顺序和标点表达，但货号中的数字和字母必须原样保留。
4. color 单独填写颜色；“棕色”规范为“棕”、“黑色”规范为“黑”。没有提到颜色时留空，不得猜测。
5. “628-6米紫361一双”是货号 628-6、颜色米紫、36码、数量1；末尾的 1 是数量，不是 361 码。
6. 多双鞋必须从原话分别提取每件实收金额，actual_amount 是该明细数量对应的成交总额。
   · **只给整单金额而未给各件金额**时，各件 actual_amount 留空、agreed_total 填整单金额，要求补充；
     **严禁按标价分摊或猜测**。
   · **她同时给了整单总额和各件金额**（例：「一共成交 400，鞋 260，腰带 140」）⇒
     **每个件用它自己的分项金额**（鞋 actual_amount=260、腰带=140），
     agreed_total = **各分项金额之和**（260 + 140 = 400）。
     ⚠️ 若她说的总额与各分项之和**对不上**：**不许自己猜、也不许按标价分摊** ——
     照原话把每件自己的分项金额填进 actual_amount，agreed_total 填**她说的那个总额**，
     由后端判"对不上"并回头问她。
   · 「赠了一双袜子，260 元」里的 260 是**鞋**的实收金额；赠品不参与金额，
     只写进前一件的 gift / gift_description（见第 8 条）。
7. “150元微信，100元现金”必须输出两笔 payments；“260元未付”是 agreed_total=260、payments=[]，不得输出已收款；“定金50元”但未说支付方式时，payments 包含 amount=50、method=""，供用户补充。
   ⚠️ payments 的**笔数 = 她说收款的次数**，不是商品件数：她说「一共 400 元微信」→ **只有一笔** payments（微信 400），
   哪怕这一笔同时付了鞋和配品；**绝不要**把某一件自己的价（如「140 的腰带」）另记成一笔收款。
8. “一双”数量为 1；没写数量但语义明确为单件商品时，quantity=1。“赠”“送”后的物品是赠品，不是销售商品数量。赠品必须写进前一件销售商品的 gift=true、gift_description，不得作为新 item。例如“赠袜子一双”写 gift_description="袜子一双"；“赠鞋垫一双”写 gift_description="鞋垫一双"。
9. 钱只按她说的数记，**绝不自己算差额**：
   · 实收金额（actual_amount / agreed_total）：
     - 她说了「收到 / 收了 / 给了」多少钱（微信、现金、支付宝等都算）且**没说欠** → 实收金额 = 她说收到的那笔钱。
       例：「119 的腰带，是收到了 100 元微信」→ 实收金额 100（客户还价，差额不是欠款，不要输出欠款）。
     - 她明确说「还欠 / 欠 / 未付 / 尾款以后付」 → 实收金额 = 她说的那个价。
       例：「卖了 119，先给 100，还欠 19」→ 实收金额 119、payments 只有 100、owed 19。
     - 她只说了价格、没说收到多少钱 → 实收金额 = 她说的那个价格（原逻辑不变）。
     - 仅有“定金”不能作为实收金额。多件逐件金额已知时可求和为 agreed_total。标价与自动公式不参与实收金额判断。
     - ⭐ **定金 + 尾款 ⇒ 实收金额 = 定金 + 尾款**（"两次收款"之和，与第 6 条"各分项之和 = 总额"
       是同一类推理，**不是新口径**）。例：「定金交了 100 元，下次收 120 元」→ agreed_total = 220、
       actual_amount = 220、payments 只有定金那 100、owed = 120。
     - **一单多件时**（含"鞋 + 配品"），她说的整单实收是**整单**的钱，**不是**某一件的实收金额：
       每件仍填它自己的分项金额（第 6 条），agreed_total 按第 6 条算；**绝不**把整单实收填进某一件。
     - 收款笔数按她说的收款**次数**：她说了一次「400 元微信」就是**一笔** payments，
       不要把各件的金额各记成一笔收款。
9.1 owed（欠款金额）只在**她明说还没收 / 还没付**时才填：
   她说「还欠 19 / 欠 19 / 未付 260 / 尾款以后付 140 / **下次欠 128**」→ owed 填她说的那个欠款金额；
   整单一分钱没给（她说「没付 / 未付 / 先欠着」等）→ owed 填整单金额。
   ⭐⭐ **尾款的同义说法一律算 owed（未收的尾款）** ——「下次收 / 下次付 / 还要收 / 还要付 / 再收 / 再付 /
   尾款 / 余款 / 剩下 / 剩下的 / 还差 / 补收」**都填进 owed**，并把这笔金额**排除在 payments 之外**。
   🔴 **方向词不改变性质**：她说的是「下次**收** 120 元」——「收」在这里指**这笔钱还没到手、下次收**，
   **不是**这次已经收到的钱。**绝不要**把「下次收 / 还要收 / 再收 / 补收」的那笔金额写进 payments。
   例（照这个判断）：「定制一双 37 码的 26632，定金交了 100 元，微信，下次收120元」
   ⇒ items=[{item_no:"26632",size:37,quantity:1,actual_amount:220}]、payments=[{amount:100,method:"微信"}]、
      agreed_total=220、owed=120。
   她只说「收了 100」而**没有**说欠 → owed 留空，**绝不要**拿「实收金额 − 已收」的差额去填 owed。
10. 遇到“89.9/89块9抵100”的团购券，只把实际付给门店的微信/现金等放入 payments；券的购买价 89.9 元和抵扣面额 100 元都不是门店已收现金，不要把它们当成 payments。不要猜测平台结算金额，后端会按已配置券种确定性换算。单鞋券后实收金额无法从原话直接确定时可留空，由后端结合实际支付和券种换算。
11. 配品（不是鞋，没有尺码）：${accessoryNames.length ? accessoryNames.join('、') : '（本租户未配置配品）'}。
    如果某件是上面列出的配品，输出 {"kind":"accessory","accessory_name":"名称","quantity":1,"actual_amount":实收金额}，
    不要填 item_no、color、size。accessory_name 必须与上面列表里的写法**完全一致**，不许改写、简写或自造名称；
    原话里的说法与列表对不上时，accessory_name 照抄原话，由后端判断。
    配品是**分很多价位**的（如「腰带」有 39/49/79/99/119/128/139/159/189 档），她用价位来说明是哪一档：
    她说出的那个价位填进 tier_price（如「119 的腰带」→ tier_price=119），它**只用来对档位，不是实收金额**；
    实收金额仍按第 9 条（她说收了 100 就是 100）。她没说价位时 tier_price 留空。
13. intent="return" 或 "exchange" 时，除 intent 外只填这些字段（没有的留空，**不要猜、不要自己算**）：
    {"intent":"return","action":"return","ordinal":2,"item_no":"6035","color":"黑","size":39,
     "new_item_no":"","new_color":"","new_size":"","new_amount":"",
     "settlement":"prepaid","diff_amount":-230,"restock_state":"门盒"}
    · action 只能填三个值之一："return"（退货）/ "exchange"（换货）/ "compensation"（赔货）。
    · ordinal 是她说的「第 2 笔」「第 1 笔」里的序号（数字）；没说到就留空。
    · item_no / color / size 是**要退/要换的那一双**（她原话里说的），不知道就留空。
    · new_item_no / new_color / new_size / new_amount 是**换给/赔给她的那一双**的货号、颜色、尺码、实收金额
      （只有换货、赔货才有）；不知道就留空。
    ⭐ 换货（action="exchange"）有**两种**，先分清是哪一种，再填上面两组字段：
      · **换尺码（同款换码）**——尺码不合适，还是**同一双鞋**、只换一个码：
        item_no / color 填**原来那双**；new_item_no **可以留空**（也可以等于原货号）；
        **必须填 new_size = 新尺码**（她说的那个新码）。
        ⚠️ 她说「换成 41 码」**就是换尺码**，**不是**"没说要换哪双" ——
           这种话里 new_size 必须填出来，不许留空、也不许把 41 当成原那双的 size。
        例：「6C98012-15L 换成41码」⇒
          {"intent":"exchange","action":"exchange","item_no":"6C98012-15L","color":"","size":"",
           "new_item_no":"","new_color":"","new_size":41,"new_amount":"","settlement":"","diff_amount":""}
      · **换另一双**——这双不喜欢了，换**另一双鞋**：new_item_no = 新货号；
        她说得出新颜色 / 新尺码 / 新金额就一起填进 new_color / new_size / new_amount。
        例：「把 6035 黑 38 换成 1366-33 黑 40」⇒
          {"intent":"exchange","action":"exchange","item_no":"6035","color":"黑","size":38,
           "new_item_no":"1366-33","new_color":"黑","new_size":40,"new_amount":""}
        ⚠️ 换另一双时，她没说的那一项留空，**不要拿原那双的颜色/尺码去补**、也不要猜。
    🔴 intent="return" 或 "exchange" 时**不许把货号填进 items**（items / payments / agreed_total
      都是**销售字段**，售后结果里一个都不许出现）——上面两个例子里从来没有 items。
    · settlement 只能填 "cash"（退现金/收现金/退微信）/ "prepaid"（钱先存着/存预存）；没说到就留空。
    · diff_amount 是**她说的**差价：要退给她的钱填负数（如 -230），她要补的钱填正数（如 50）；
      她没说就留空，**禁止**用原价或标价推算。
    · restock_state 只能填 "门盒" / "样品"（退回来的鞋放哪儿）；没说到就留空。

12. 只输出 JSON，不输出 Markdown 或说明。

用户原话：${originalText}
    `.trim();

    const response = await this.getClient('text').chat.completions.create({
      model: llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    try {
      const result = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
      logInfo('sales.ai.parsed', { task_id: taskId, ...salesParseSnapshot(result) });
      const normalized = normalizeSalesResult(result, originalText, { vouchers });
      // For one shoe, the original words are authoritative for every gift,
      // even when the model recognizes only the first one.
      //
      // ⚠️ 赠品归并**只对销售成立**：售后意图（return / exchange）的规范化结果里
      //    **根本没有 items**（两套字段契约刻意不混装，见 normalizeAfterSalesResult）。
      //    改动前这里直接读 normalized.items.length → TypeError → 被包成
      //    「销售文字解析失败」→ 退货/换货任务永远 failed、出不了确认卡片。
      //    所以判据是「意图 + 结构」两者都要：意图是语义（归并只属于销售），
      //    Array.isArray 是结构兜底（any 规范化结果变了也不会再抛）。
      if (normalized.intent === 'sale' && Array.isArray(normalized.items) && normalized.items.length === 1) {
        const gifts = explicitSingleShoeGifts(originalText);
        if (gifts.length) {
          normalized.items[0].gift = true;
          normalized.items[0].gift_description = [...new Set(gifts)].join('、');
          normalized.gift = true;
          normalized.gift_description = normalized.items[0].gift_description;
        }
      }
      logInfo('sales.ai.normalized', { task_id: taskId, ...salesParseSnapshot(normalized),
        voucher: normalized.voucher });
      return normalized;
    } catch (error) {
      throw new Error(`销售文字解析失败: ${error.message}`);
    }
  }

  // ⛔ `parsePurchaseReportText`（采购「数量说明」→ 尺码/数量）**已删除（2026-10-09）**。
  //
  // 它唯一的调用方是 `PurchaseWebhookService.parseReportQuantities`（供应商文字报单
  // → AI 解析那一段）—— 业务负责人把「信息填写」表整个删掉、口径是
  // **「自然语言 ＋ AI 录入」整套退场** ⇒ 这条提示词与它的解析路径一并删除。
  // ⚠️ **销售那一半（`parseSalesText`）一行没动**：它走的是群聊自然语言录入那条现役链路。
  // ⚠️ 恢复 = 重新实现（从 git 历史取回；`git log -S 'parsePurchaseReportText'`）。


  /**
   * 「采购到货核对」解析：把她在群话题里说的自然语言，解析成
   * ① 这次核对是不是**说完了**（她说了「完毕」之类的话）② 差异是哪一类、具体多少。
   *
   * ⭐ 2026-10-07：`complete`（①）**只作诊断**，**不再是"要不要处理"的闸门** ——
   *   业务负责人口径：「用户一般一句话就能够说清楚这个事情，所以收到用户关于到货情况的
   *   反馈时，直接处理就可以」。真正决定要不要出卡片的是**②有没有内容**
   *   （`differences` 非空，或 `same === true`），见 `purchaseArrivalConversationService`。
   *   ⚠️ 提示词里的 `complete` 定义也跟着改成"**她给的信息够不够算**"（不再是"说没说完"），
   *   并补上「某行『一双都没到』→ 必须按 `less` + 申请数量输出」那条（漏了会按申请数量入库）。
   *   口径见 `docs/arrival-trigger-and-prompt-2026-10-07.md`。
   *
   * 口径（业务负责人 2026-10-06 逐字定的）：
   *   · 差异**只有三类**：完全一样 / 实际比申请多 / 实际比申请少；
   *     ⚠️ 刻意**没有**「实际为 0」这一类——她说"实际到货不会为 0，因为肯定会到货"。
   *   · 她的**字眼不固定**（「多两双 39」「39 到了 4 双」「少一双 38」…），
   *     所以这里靠模型理解，**不做关键词匹配**。
   *   · 她说「完毕」之类的话才发卡片；**这一条也是模型判的**，不是匹配"完毕"两个字。
   *
   * 输入是**累积的原话**（可以一次说完，也可以分多次说完），不是单条消息——
   * 分多次说的时候，只看最后一条会把前面说的话丢掉。
   *
   * @param {{ rows?: Array<{item_no:string,color:string,size:number,quantity:number}>,
   *   messages?: string[], taskId?: string }} input
   * @returns {Promise<{complete:boolean, same:boolean,
   *   differences:Array<{item_no:string,color:string,size:number,type:string,quantity:number}>}>}
   */
  async parseArrivalReconciliation({ rows = [], messages = [], taskId = '' } = {}) {
    const llm = this.resolveModel('text');
    const transcript = (messages || []).map((line) => String(line ?? '').trim()).filter(Boolean).join('\n');
    if (!transcript) throw new Error('到货核对原话不能为空');
    if (!Array.isArray(rows) || !rows.length) throw new Error('到货核对缺少采购申请明细');
    const requestLines = rows
      .map((row) => `${textValue(row.item_no) || '（未知货号）'} / ${textValue(row.color) || '（无颜色）'} / ${Number(row.size)} 码 / 申请 ${Number(row.quantity)} 双`)
      .join('\n');
    const prompt = `
你是鞋店「采购到货核对」助手。这批采购申请单的明细（货号 / 颜色 / 尺码 / 申请数量）是：
${requestLines}

业务负责人会在会话群里用自然语言说明「这次实际到货和采购申请的差异」，她的字眼完全不固定，你要自己理解意思。
差异只有三类：
1. 完全一样（例如「都到了」「都到货了」「全部到货」「都到齐了」「都齐了」「全到了」「都收到了」「全部到齐」「齐了」「一件不差」「跟单子一样」）
2. 实际比申请多（例如「多了两双 39」「39 码到了 4 双」）
3. 实际比申请少（例如「少了两双 38」「38 码只到了一双」）
她会分多次说，也可能一次说完。**不需要**她说「完毕 / 核对完了」这类话才处理 ——
只要她的信息足以算清差异（能对到上面某一行），就照实输出。

只输出 JSON，格式：
{"complete":true,"same":false,"differences":[{"item_no":"XHB8095","color":"黑","size":39,"type":"more","quantity":2}]}

规则：
1. complete：**只表示"她给的信息够不够算"** —— 信息足以算清差异（能对到上面某一行）填 true；
   信息不足以算（她只说了半句、还要再补、或你判断不出是哪一行）填 false。
   ⚠️ 这**不是**"要不要处理"的开关：**不要**因为她没说「完毕」就填 false，
   也**不要**因为"内容看起来齐了"就强行填 true。
2. same：她说「完全一样 / 都到了 / 都到货了 / 全部到货 / 都到齐了 / 都齐了 / 全到了 / 都收到了 / 全部到齐 / 齐了 / 一件不差 / 没有差异」时填 true，此时 differences 留空数组。
   ⚠️ 这些说法是**同一个意思（整批全到）**，只是她的字眼不同：只要她**没有说出具体货号、尺码或双数**，
   多了「到货 / 齐 / 收到」这样的字眼**不算差异** —— 一律 same=true、differences=[]。
   ⚠️ 反过来，只要她给的是**具体内容**（例：「39 码到了 4 双」「少了两双 38」「8230 到了 1 双」
   「还有一双没到」），就必须按第 2 / 3 类算具体差异，**不许**当成"整批全到"。
3. differences 每一项是一条**具体差异**：
   · item_no / color / size 必须对应上面明细里的某一行，**照抄上面的写法**，不要改写、不要编造；
   · type 只能是 "more"（比申请多）/ "less"（比申请少）/ "same"（她说这一行就是一样的）；
   · quantity 是**差异的双数**（type="same" 时填 0）。
     她说的是"实际数量"时要换算成差异：实际 4 双 − 申请 2 双 = 多 2 双 → type="more", quantity=2。
     ⚠️ **她说某一行「一双都没到 / 没到 / 没来 / 一双没来」→ 这一行必须输出**：
        type="less"、quantity = **该行的申请数量**（这样算出来的实际 = 0 双）。
        漏掉这一行，那一行就会被按申请数量入库 —— 明明没到却入库，就是写错账。
     判断不出她说的是差异还是实际数量时，**不要输出这一行**（宁可让她再说一遍，也不要写错账）。
4. 她说的话对不上上面任何一行（货号、尺码都不在单子上）→ **不要输出那一行，也不要猜**。
5. 只输出 JSON，不要 Markdown、不要解释。

她在话题里说过的话（按时间顺序）：
${transcript}
    `.trim();
    const response = await this.getClient('text').chat.completions.create({
      model: llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch (error) {
      throw new Error(`到货核对解析失败: ${error.message}`);
    }
    const allowedTypes = new Set(['more', 'less', 'same']);
    const differences = (Array.isArray(parsed?.differences) ? parsed.differences : [])
      .map((item) => ({
        item_no: textValue(item?.item_no),
        color: textValue(item?.color),
        size: Number(item?.size),
        type: textValue(item?.type).toLowerCase(),
        quantity: Number(item?.quantity),
      }))
      .filter((item) => {
        if (!allowedTypes.has(item.type)) return false;
        if (!Number.isSafeInteger(item.size) || item.size <= 0) return false;
        if (item.type === 'same') return item.quantity === 0 || Number.isNaN(item.quantity);
        return Number.isSafeInteger(item.quantity) && item.quantity > 0;
      })
      .map((item) => ({ ...item, quantity: item.type === 'same' ? 0 : item.quantity }));
    const modelSaidSame = parsed?.same === true;
    // ⭐ 代码侧兜底（配置在 `config/arrivalConversation.js`，判定在本文件上方）：
    //    **只在模型什么都没给出来时**生效 —— 模型给出了具体差异（或自己说了 same）时，
    //    这里一个字都不动（不覆盖模型的结论）。真机那次就是模型把「都到货了」漏成了
    //    `same:false` + `differences:[]`，于是被判成"这句话里没有可核对的到货信息"。
    const bareAllArrived = (modelSaidSame || differences.length > 0)
      ? { matched: false, reason: 'model_already_gave_content' }
      : detectBareAllArrivedTranscript(messages, ARRIVAL_ALL_PRESENT_PHRASES);
    const result = {
      complete: parsed?.complete === true || bareAllArrived.matched,
      same: modelSaidSame || bareAllArrived.matched,
      differences,
    };
    logInfo('purchase.arrival.reconcile.parsed', {
      task_id: taskId,
      complete: result.complete,
      same: result.same,
      difference_count: differences.length,
      diff_types: [...new Set(differences.map((item) => item.type))],
      request_row_count: rows.length,
      // ⭐ 兜底层是否生效 / **为什么没生效**（她再发一次同样的说法时，日志里一眼看出是哪一步）。
      bare_all_arrived: bareAllArrived.matched,
      bare_all_arrived_reason: bareAllArrived.reason,
    });
    return result;
  }

  // ── 已删除：recognizeLabels / recognizePurchaseDocument ──────────────────
  // 这两个方法（鞋盒标签识别、供应商到货单识别）只被 purchaseWebhookService
  // 的 processArrival 调用；那条链路 2026-10-05 整体退场，方法随之删除。
  // 它们的提示词（modules.js 的 recognition.document）与视觉模型配置
  // （llmModels.js 的 vision 组）也一并删掉了——现在没有任何地方会调视觉模型。
}

module.exports = new DoubaoService();
module.exports.normalizeSalesResult = normalizeSalesResult;
module.exports.normalizeAfterSalesResult = normalizeAfterSalesResult;
// 「全到」说法的兜底判定（纯函数）：导出是为了让回归用例能**直接钉住判定口径**
//（哪种说法算、哪种不算、以及"为什么不算"），不必绕模型。
module.exports.detectBareAllArrivedStatement = detectBareAllArrivedStatement;
module.exports.detectBareAllArrivedTranscript = detectBareAllArrivedTranscript;
