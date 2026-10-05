// 消息入口闸门（业务负责人拍板后的放宽版）。
//
// 闸门回答的问题只有一个：这条私聊文字**值不值得送进 AI**？
//   · 含数字          → 进（原有的录单形态，行为不变）
//   · 含业务关键词    → 进（"我要退货" / "查一下我买的鞋" / "库存还有多少"）
//   · 两者都没有      → 不进、也不回（"你好" / "在吗" / "今天天气" / "哈哈哈"）
//
// 为什么保留"不进"这一档：把无意义聊天送进模型既花钱又可能被模型硬套成"卖货"，
// 而且"回了反而更像聊天机器人"。所以无意义聊天保持静默是**有意的**，
// 不是漏掉的兜底 —— 后面加的"没学会"引导语只在**过了闸门**之后才可能发出。
//
// 关键词为什么放在配置里：业务负责人反复强调「配置先行」——以后加词只改这一个文件，
// 不去动 larkMvpService 里的判断逻辑。
//
// 这份清单照抄业务负责人给的原话（没有去重、没有做前缀合并）：
// 「查」与「查询」、「退」与「退货」、「换」与「换货」在包含关系上是冗余的，
// 但保留完整写法是因为这份清单同时是**业务词典**——她要在评审时一眼看懂有哪些词，
// 而不是去推理"写了查是不是就等于写了查询"。加词就往下加一条。
const SALES_KEYWORDS = Object.freeze([
  '查',
  '查询',
  '退',
  '退货',
  '换',
  '换货',
  '卖',
  '买',
  '记',
  '库存',
  '欠',
]);

// 过了闸门、AI 也认不出意图时回的话（业务负责人给的原文，标点照抄）。
// 放在配置里是为了改文案不用碰服务逻辑；注意它**只**服务于 unsupported 这一档。
const UNSUPPORTED_INTENT_REPLY =
  '这个我还没学会～你可以说"卖一双 6035黑 42码 199"，或者"帮我查 6035 黑"';

const asText = (value) => String(value ?? '');

// 含数字：录单的必要条件（货号、尺码、金额至少有一个数字）。
const hasDigits = (text) => /\d/.test(asText(text));

// 含业务关键词：退换货、查询、买卖、库存欠款这些**意图词**，
// 它们让"不带数字但明显是业务诉求"的消息也能进 AI。
const hasSalesKeyword = (text, keywords = SALES_KEYWORDS) => {
  const value = asText(text);
  if (!value) return false;
  return keywords.some((keyword) => value.includes(keyword));
};

/**
 * 闸门判断本身。keywords 可注入，便于测试与将来按门店配置不同词表。
 * ⚠️ 调用方（larkMvpService.acceptSalesText）只把 true 的消息送进 AI；
 * false 的消息**连回都不回**。
 */
const isSalesCandidate = (text, keywords = SALES_KEYWORDS) =>
  hasDigits(text) || hasSalesKeyword(text, keywords);

module.exports = {
  SALES_KEYWORDS,
  UNSUPPORTED_INTENT_REPLY,
  hasDigits,
  hasSalesKeyword,
  isSalesCandidate,
};
