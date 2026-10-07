const OpenAI = require('openai');
const { logError, logInfo } = require('../utils/logger');
const { applyGroupBuyVoucherPolicy } = require('./groupBuyVoucherPolicy');
const { resolveLlm, assertLlmConfigured } = require('../config/llmModels');
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
    // 配品的档位价位（只用于对记录，不落库）：出问题时能看出"她说的 119 是档位还是成交金额"。
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
const DEPOSIT_CLAUSE_BOUNDARY = /[，,。；;、！!？?\n]|尾款|余款|下次|欠|剩余|剩下的|还差|再付/;
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
  const tail = source.match(/尾款\s*(?:以后|之后|下次|到货后|取货时)?\s*(?:还要|再)?\s*(?:付|给|是|为)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/)
    // 不带「尾款」两个字的余额说法也算余额 —— 她的原话就是「**下次欠 128 元**」。
    // ⚠️ 只在「定金」**之后**找：定金前面的数字属于上一句，
    //    把「上次还欠 200」当成本单尾款会把成交金额算错。
    || afterDeposit.match(/(?:下次|以后|之后|到货后|取货时|来拿时)\s*(?:还|还要|再|要|需要|需|得)?\s*(?:欠|差|付|给|交|补)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/)
    || afterDeposit.match(/(?:还欠|还差|还需要再付|还要再付|还需再付)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/);
  const depositAmount = depositAmountNear(source);
  if (depositAmount == null) return { issues: ['请明确已经收到的定金金额'] };
  if (!tail) return { depositAmount, issues: [] };
  if (!/下次|以后|之后|到货后|取货时|来拿时|还要|待付|未付|再付/.test(source)) {
    return { issues: ['请说明尾款是否已支付；若尚未支付，请写“尾款以后付”'] };
  }
  return { depositAmount, tailAmount: Number(tail[1]), issues: [] };
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
  const rawItems = Array.isArray(result.items) && result.items.length ? result.items : [result];
  const items = [];
  for (const item of rawItems) {
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
        // 模型把它放在 tier_price 或 actual_amount 里都认；成交金额下面会按第 9 条重算，
        // 所以 tier_price 不落库、也不当成交金额（业务负责人口径）。
        tier_price: moneyOrEmpty(item.tier_price ?? item.tierPrice) || spokenAmount,
        actual_amount: spokenAmount,
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
  // 交易类型由 AI 从原话判断，但只认三种；说不清时按现货处理——
  // 门店绝大多数是"当场收钱当场交货"，不说不给钱就是现货（不是猜，是业务前提）。
  // 交付状态不在这里定：它由 SALES_MOVEMENTS 从交易类型推出来。
  // 这个值在下面「成交金额」的口径里要用，所以提前到这里算。
  const tradeType = ['现货', '未付', '预付'].includes(result.trade_type) ? result.trade_type : '现货';
  // 她**明说**的欠款金额（owed）。它是"要不要挂未收款"的唯一依据：
  // ⚠️ 本系统**没有「打折」这个概念**（业务负责人明确说过）：真实现象只有一种——
  // 她说收到多少钱，那就是这一单的成交金额；没收到的那部分，只在她说了"欠"时才是未收款。
  // 所以这里绝不能用「成交 − 已收」的差额去推欠款。
  let owed = moneyOrEmpty(result.owed ?? result.unpaid);
  if (items.length === 1 && !items[0].actual_amount && agreedTotal) items[0].actual_amount = agreedTotal;
  if (!agreedTotal && items.length && items.every((item) => item.actual_amount)) {
    agreedTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) * 100) / 100;
  }
  const deposit = depositTerms(sourceText);
  if (deposit && !deposit.issues.length) {
    const matching = payments.filter((payment) => Number(payment.amount) === deposit.depositAmount);
    if (matching.length === 1) {
      const spokenMethod = sourceText.match(/(微信|现金|支付宝)\s*(?:支付|付|交|收)?\s*定金/)?.[1] ||
        sourceText.match(/定金\s*[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?\s*(微信|现金|支付宝)/)?.[1];
      payments = [{ ...matching[0], method: spokenMethod || matching[0].method }];
    }
    else deposit.issues.push('请明确本次定金的支付方式');
    if (deposit.tailAmount && items.length !== 1) {
      // 定金 + 尾款的推导只对「整单一条明细」成立：多行时无法判断尾款属于哪一件。
      // 以前是整块跳过，应收金额被静默算丢（不报错、金额却不对），所以改成明确拒绝。
      deposit.issues.push('定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额');
    } else if (deposit.tailAmount) {
      const expectedTotal = Math.round((deposit.depositAmount + deposit.tailAmount) * 100) / 100;
      const statedPrice = sourceText.match(/(?:成交价|成交金额|总价)\s*(?:是|为)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
      if (statedPrice && Number(statedPrice[1]) !== expectedTotal) {
        deposit.issues.push('成交价与定金加尾款不一致，请核对');
      }
      agreedTotal = expectedTotal;
      items[0].actual_amount = agreedTotal;
      // 「尾款以后付」= 她明说欠这笔尾款 → 后端据此补一条未收款（见 salesOrderService）。
      owed = deposit.tailAmount;
    }
  }
  // ── 「成交金额」的确定性口径（业务负责人口径，对应提示词规则 9）────────────────────
  //   她说了「收到多少钱」、又没说欠款 → 成交金额 = 实收（客户还价：119 的腰带收 100，这单就是 100）；
  //   她明说「还欠 X」              → 成交金额 = 实收 + 欠款（两个数都是她说的，不做减法猜测）；
  //   她只说了价格、没说收多少      → 成交金额 = 她说的那个价格（原逻辑，不掺和）。
  // 只对「整单一条明细」生效：多行时整单收款额没法确定属于哪一行，拆开就变成猜测。
  // 原话里出现"钱还没给清"的说法时一律不套用上面的还价口径——这时"收到的那笔钱"只是
  // 定金/首付，把它当成交金额会把应收金额算丢（这条是保守的护栏，不是判断欠款）。
  const moneyNotSettled = /定金|预付|尾款|余款|剩下的|未付|欠款|还欠|欠着|赊账|下次给|下次再给|先给|先付|先交/
    .test(String(sourceText || ''));
  if (items.length === 1) {
    const coveredCents = Math.round(payments
      .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0) * 100);
    const covered = coveredCents / 100;
    if (owed) {
      // 定金单在上面已经按「定金 + 尾款」定过成交金额，这里不覆盖它。
      const named = Math.round((coveredCents + Math.round(owed * 100))) / 100;
      if (!items[0].actual_amount || items[0].actual_amount === covered) {
        items[0].actual_amount = named;
        agreedTotal = named;
      }
    } else if (tradeType === '现货' && !moneyNotSettled && coveredCents > 0) {
      items[0].actual_amount = covered;
      agreedTotal = covered;
    }
  }
  const voucherPolicy = applyGroupBuyVoucherPolicy({ sourceText, items, payments, vouchers });
  if (voucherPolicy?.items) {
    items.splice(0, items.length, ...voucherPolicy.items);
    payments = voucherPolicy.payments;
    agreedTotal = voucherPolicy.agreedTotal;
    // 券后成交金额由后端按券种确定性算好（实收 + 平台结算额），没有"她说的欠款"这回事；
    // 清掉 owed，避免在券单上再挂一条未收款（券 + 未付的组合上面已被明确拒绝）。
    owed = '';
  }
  const first = items[0] || {};
  const normalized = {
    // 意图值统一走注册表收敛（见 config/saleIntents）：模型输出「退货」还是 "return"
    // 都落到同一个规范值；认不出来一律 unsupported，绝不猜成 sale 去写单。
    // 本期真正会执行的非 sale 意图只有 sale_query（只读查询）；
    // return / exchange 只识别、不执行。
    intent: normalizeMessageIntent(result.intent),
    trade_type: tradeType,
    ...first,
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
    if (item.quantity !== 1) missing.add(`第${index + 1}件请逐双列出成交金额；每条销售明细只能记录一双`);
  }
  if (items.length && items.every((item) => item.actual_amount) && agreedTotal &&
    Math.abs(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) - agreedTotal) > 0.005) {
    missing.add('逐双成交金额合计与整单成交金额不一致');
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
// 只会让人以为"还有一条图片识别的路可走"。文字解析（parseSalesText /
// parsePurchaseReportText）完全没动，下面这个 class 只剩文字一组。

/**
 * Doubao 文字解析服务：销售录单（parseSalesText）与采购报单数量说明
 * （parsePurchaseReportText）。视觉识别已随到货识别链路退场，不再有 vision 这一组。
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
  "items": [{"item_no":"8088-26","color":"棕","size":38,"quantity":1,"actual_amount":230,"gift":false,"gift_description":""}],
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
2. trade_type 是这笔交易的**性质**，只能填「现货」「未付」「预付」三者之一：
   · 提到定金 / 先付 / 预定 → \"预付\"（货没拿走，之后来取）
   · 明确说未付 / 欠着 / 下次再给 → \"未付\"（鞋拿走，钱还没给）
   · 其余一律 \"现货\"（当场收款当场交货——门店绝大多数是这一种，不说不给钱就是现货）
   团购券只是一种**支付方式**（钱延期结算），不影响 trade_type；用券买走一双鞋仍然是现货。
   不要输出交付状态，后端会按 trade_type 决定是否交付。
3. item_no 只填写用户原话中的货号，不要把颜色、尺码或品类拼进货号。用户可能用任意顺序和标点表达，但货号中的数字和字母必须原样保留。
4. color 单独填写颜色；“棕色”规范为“棕”、“黑色”规范为“黑”。没有提到颜色时留空，不得猜测。
5. “628-6米紫361一双”是货号 628-6、颜色米紫、36码、数量1；末尾的 1 是数量，不是 361 码。
6. 多双鞋必须从原话分别提取每件成交金额，actual_amount 是该明细数量对应的成交总额。只给整单金额而未给各件金额时，各件 actual_amount 留空，要求补充；严禁按标价分摊或猜测。
7. “150元微信，100元现金”必须输出两笔 payments；“260元未付”是 agreed_total=260、payments=[]，不得输出已收款；“定金50元”但未说支付方式时，payments 包含 amount=50、method=""，供用户补充。
8. “一双”数量为 1；没写数量但语义明确为单件商品时，quantity=1。“赠”“送”后的物品是赠品，不是销售商品数量。赠品必须写进前一件销售商品的 gift=true、gift_description，不得作为新 item。例如“赠袜子一双”写 gift_description="袜子一双"；“赠鞋垫一双”写 gift_description="鞋垫一双"。
9. 钱只按她说的数记，**绝不自己算差额**：
   · 成交金额（actual_amount / agreed_total）：
     - 她说了「收到 / 收了 / 给了」多少钱（微信、现金、支付宝等都算）且**没说欠** → 成交金额 = 她说收到的那笔钱。
       例：「119 的腰带，是收到了 100 元微信」→ 成交金额 100（客户还价，差额不是欠款，不要输出欠款）。
     - 她明确说「还欠 / 欠 / 未付 / 尾款以后付」 → 成交金额 = 她说的那个价。
       例：「卖了 119，先给 100，还欠 19」→ 成交金额 119、payments 只有 100、owed 19。
     - 她只说了价格、没说收到多少钱 → 成交金额 = 她说的那个价格（原逻辑不变）。
     - 仅有“定金”不能作为成交金额。多件逐件金额已知时可求和为 agreed_total。标价与自动公式不参与成交金额判断。
9.1 owed（欠款金额）只在**她明说欠**时才填：
   她说「还欠 19 / 欠 19 / 未付 260 / 尾款以后付 140」→ owed 填她说的那个欠款金额；
   整单一分钱没给、只说「未付」时 → owed 填整单金额。
   她只说「收了 100」而**没有**说欠 → owed 留空，**绝不要**拿「成交金额 − 已收」的差额去填 owed。
10. 遇到“89.9/89块9抵100”的团购券，只把实际付给门店的微信/现金等放入 payments；券的购买价 89.9 元和抵扣面额 100 元都不是门店已收现金，不要把它们当成 payments。不要猜测平台结算金额，后端会按已配置券种确定性换算。单鞋券后成交金额无法从原话直接确定时可留空，由后端结合实际支付和券种换算。
11. 配品（不是鞋，没有尺码）：${accessoryNames.length ? accessoryNames.join('、') : '（本租户未配置配品）'}。
    如果某件是上面列出的配品，输出 {"kind":"accessory","accessory_name":"名称","quantity":1,"actual_amount":成交金额}，
    不要填 item_no、color、size。accessory_name 必须与上面列表里的写法**完全一致**，不许改写、简写或自造名称；
    原话里的说法与列表对不上时，accessory_name 照抄原话，由后端判断。
    配品是**分很多价位**的（如「腰带」有 39/49/79/99/119/128/139/159/189 档），她用价位来说明是哪一档：
    她说出的那个价位填进 tier_price（如「119 的腰带」→ tier_price=119），它**只用来对档位，不是成交金额**；
    成交金额仍按第 9 条（她说收了 100 就是 100）。她没说价位时 tier_price 留空。
13. intent="return" 或 "exchange" 时，除 intent 外只填这些字段（没有的留空，**不要猜、不要自己算**）：
    {"intent":"return","action":"return","ordinal":2,"item_no":"6035","color":"黑","size":39,
     "new_item_no":"","new_color":"","new_size":"","new_amount":"",
     "settlement":"prepaid","diff_amount":-230,"restock_state":"门盒"}
    · action 只能填三个值之一："return"（退货）/ "exchange"（换货）/ "compensation"（赔货）。
    · ordinal 是她说的「第 2 笔」「第 1 笔」里的序号（数字）；没说到就留空。
    · item_no / color / size 是**要退/要换的那一双**（她原话里说的），不知道就留空。
    · new_item_no / new_color / new_size / new_amount 是**换给/赔给她的那一双**的货号、颜色、尺码、成交金额
      （只有换货、赔货才有）；不知道就留空。
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

  async parsePurchaseReportText(text, { selectedSizes = [] } = {}) {
    const llm = this.resolveModel('text');
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('采购报单说明不能为空');
    const allowedSizes = selectedSizes.map(Number);
    if (!allowedSizes.length || allowedSizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
      throw new Error('采购报单已选尺码必须是正整数');
    }
    const prompt = `
你是鞋店采购数量说明解析助手。表单已经明确勾选尺码：${allowedSizes.join('、')}。
请只从数量说明中识别“数量不是默认一双”的例外，不要补充未勾选尺码，也不要输出没有特别说明的尺码。
输出格式：{"items":[{"size":39,"quantity":1}]}
规则：
1. 数量说明没有提到的已选尺码由后端保持默认一双，不需要输出。
   ⚠️ 但“她明确说了数量”时必须输出，哪怕数量就是 1，也不许当成“没提到”：
   例如“1 双”“一双”都是**明确说了数量**，必须输出这一条；
   只有“完全没提数量”（例如只说“38 码”）才算没提到。
   ⚠️ 前提是那个数量确实是**正整数**：0 双、2.5 双这类不是正整数，按规则 5 处理。
2. 如果说明是在确认“全部按默认一双”（例如“各一双”“每个码一双”“都是一双”“1 双”“一双”“按默认来”），
   必须输出全部已选尺码且数量都是 1，不能返回空数组——这种情况数量是明确的，不是语义不明确。
3. “40两双”只输出40码数量2；“每个码两双”输出全部已选尺码数量2。
   ⚠️ 两位数要**看全**：“10 双”= 10、“12 双”= 12、“20 双”= 20；
   数字里有 0 **不等于**数量是 0，也不许看漏 0 当成 1。
4. 只能输出已选尺码列表中的正整数尺码；禁止输出42.5等小数尺码。
5. 数量必须是正整数。**只有**说明里那个数量本身就是 0 或小数时（例如“0 双”“2.5 双”“一双半”），
   **不要四舍五入、也不要替她猜一个整数**，返回空数组 {"items":[]}——由后端拒绝整条报单；
   “10 双”“20 双”是正常的两位数，**必须正常输出**，不要当成 0。
   只有在完全无法判断数量时才返回空数组，不得猜测。
6. 只输出 JSON，不输出 Markdown 或说明。
数量说明：${originalText}`.trim();
    const response = await this.getClient('text').chat.completions.create({
      model: llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items) || !items.length) throw new Error('未识别出有效尺码数量');
      return items.map((item) => {
        const size = Number(item.size);
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(size) || size <= 0 || !allowedSizes.includes(size)) {
          throw new Error(`数量说明包含未勾选或无效的尺码：${item.size}`);
        }
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('采购数量必须是正整数');
        return { size, quantity };
      });
    } catch (error) {
      throw new Error(`采购报单解析失败: ${error.message}`);
    }
  }

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
1. 完全一样（例如「都到了」「一件不差」「跟单子一样」）
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
2. same：她说「完全一样 / 都到了 / 一件不差 / 没有差异」时填 true，此时 differences 留空数组。
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
    const result = {
      complete: parsed?.complete === true,
      same: parsed?.same === true,
      differences,
    };
    logInfo('purchase.arrival.reconcile.parsed', {
      task_id: taskId,
      complete: result.complete,
      same: result.same,
      difference_count: differences.length,
      diff_types: [...new Set(differences.map((item) => item.type))],
      request_row_count: rows.length,
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
