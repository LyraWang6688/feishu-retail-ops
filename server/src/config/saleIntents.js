// 消息意图注册表（退换货第一期）。
//
// 为什么单独放一个配置模块：意图值是「AI 输出」与「后端分支」之间的契约。
// 契约只在这里定义一处，模型换了措辞（"查销售记录" / "sale_query"）也只需要在这里
// 加一条别名，而不是在 doubaoService 和 larkMvpService 里各写一串 if-else。
//
// ⚠️ 当前：sale_query 走只读查询（SaleLookupService）；return / exchange 从第二期第二步起
// **真执行**（AfterSalesFlowService 出确认卡片 → 她点确认 → afterSalesService 写账）。
// 意图层只判"是哪一类诉求"，具体动作（退货/换货/赔货）由模型输出的 action 字段表达，
// 收敛规则在 config/afterSalesFlow.js。
const MESSAGE_INTENTS = Object.freeze({
  SALE: 'sale',
  SALE_QUERY: 'sale_query',
  RETURN: 'return',
  EXCHANGE: 'exchange',
  UNSUPPORTED: 'unsupported',
});

// 模型可能给出的各种写法 → 规范值。键统一按小写比较（中文不受影响）。
const INTENT_ALIASES = Object.freeze({
  sale: MESSAGE_INTENTS.SALE,
  销售: MESSAGE_INTENTS.SALE,
  录单: MESSAGE_INTENTS.SALE,
  sale_query: MESSAGE_INTENTS.SALE_QUERY,
  salequery: MESSAGE_INTENTS.SALE_QUERY,
  查销售记录: MESSAGE_INTENTS.SALE_QUERY,
  查询销售记录: MESSAGE_INTENTS.SALE_QUERY,
  查销售明细: MESSAGE_INTENTS.SALE_QUERY,
  return: MESSAGE_INTENTS.RETURN,
  退货: MESSAGE_INTENTS.RETURN,
  exchange: MESSAGE_INTENTS.EXCHANGE,
  换货: MESSAGE_INTENTS.EXCHANGE,
  赔货: MESSAGE_INTENTS.EXCHANGE,
});

/**
 * 把模型给的任意意图值收敛成注册表里的规范值。
 * 认不出来（含模型返回空、返回胡说）一律按 unsupported —— 交给上层回「未识别」，
 * 绝不猜成 sale 去写单。
 */
const normalizeMessageIntent = (raw) => {
  const key = String(raw ?? '').trim().toLowerCase();
  return INTENT_ALIASES[key] || MESSAGE_INTENTS.UNSUPPORTED;
};

const isLookupIntent = (intent) => intent === MESSAGE_INTENTS.SALE_QUERY;
const isAfterSalesIntent = (intent) =>
  intent === MESSAGE_INTENTS.RETURN || intent === MESSAGE_INTENTS.EXCHANGE;

module.exports = {
  MESSAGE_INTENTS,
  INTENT_ALIASES,
  normalizeMessageIntent,
  isLookupIntent,
  isAfterSalesIntent,
};
