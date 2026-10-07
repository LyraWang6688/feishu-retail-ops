// 「第二次交付（成交）」提醒卡片上的**用户可见文案**（配置先行）。
//
// 为什么单独一个文件：
//   · 这张卡片以前把候选写成「未付 / 预付」——那两种**交易类型**的说法已经作废
//     （2026-10-07：类型 = 库存有没有，只有现货 / 预定；「未付」不再是类型）。
//     卡片上不能再出现"未付"这个类型词，但"还没收的钱"仍然要照实写。
//   · 候选口径也变了：从"未付 / 预付两个编码"改成**尚未完成履约**
//     （预定还没交付 ＋ 现货但钱没结清），表头与兜底标签跟着换。
//
// ⚠️ 取值规则走 `config/envValue`（没设 → 默认值；设了（含空串）→ 显式取值）。
//    **调用时才解析**（避免 dotenv 加载顺序事故）。
// ⚠️ 本文件只管**文案**：候选怎么筛、点「成交」写什么，都在
//    `services/secondDeliveryService.js`。

const { readRaw, readString } = require('./envValue');

const HEADER_KEY = 'SECOND_DELIVERY_CARD_HEADER';
const TYPE_FALLBACK_KEY = 'SECOND_DELIVERY_CARD_TYPE_FALLBACK';

const DEFAULTS = Object.freeze({
  // 卡片标题：不再说"未付 / 预付"（那不是类型了）。
  header: '待成交 / 待收款',
  // 主表「交易类型」关联读不出来时（老数据 / 她删过行为记录）那一行的兜底说法。
  // ⚠️ **不写**「未付」这类类型词 —— 它要么有类型（现货/预定），要么就是"待处理"。
  typeFallback: '待处理',
  // 一单两行事实（金额 / 交付数量）。
  pendingAmountFact: '未收 {amount}',
  pendingDeliveryFact: '未交付 {count}/{total} 双',
  // 钱货看着都齐了却还在候选里（进度没到「已完成」）：如实写"待核对"。
  reviewText: '待核对',
  // 空卡（今天没有候选单）。
  emptyText: '今天没有待成交的单',
  // 点过「成交」之后那一行灰字。
  settledText: '✅ 已成交{clock}',
  settledClock: '（{clock} 点击）',
});

const resolveSecondDeliveryCardConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  const header = read(HEADER_KEY, DEFAULTS.header);
  const typeFallback = read(TYPE_FALLBACK_KEY, DEFAULTS.typeFallback);
  return {
    ...DEFAULTS,
    // 空串 = 用默认：这两句是那一刻唯一可见的说明，留空只会让她看不懂这张卡。
    header: header.trim() ? header : DEFAULTS.header,
    typeFallback: typeFallback.trim() ? typeFallback : DEFAULTS.typeFallback,
  };
};

const fill = (template, values) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

module.exports = {
  HEADER_KEY,
  TYPE_FALLBACK_KEY,
  SECOND_DELIVERY_CARD_DEFAULTS: DEFAULTS,
  resolveSecondDeliveryCardConfig,
  fill,
};
