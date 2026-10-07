// 销售录单：按**交易类型**声明「这一步解析要不要跑」。
//
// 为什么要有这个文件（业务负责人 2026-10-07 真机 + 当面确认，逐字）：
//   「**预付的原因是因为库存里没有，所以需要调货。既然已经判断为预付，
//     系统实际上就不应该再去库存里面找了。**」
//   「**因为它实际上还是要写销售明细的，所以这个时候需要提供颜色信息，
//     也就是要以这个货号去找它的颜色，然后只不过是它就不需要再去实时库存里面
//     查有没有这个库存了。**」
//   「**如果是预付的话，其中一个链路它应该是要把它给解除掉的。**」
//   「**注意不要影响其他已经跑通的流程。**」
//
// 于是把销售录单里**本来就混在一起的两件事**拆成两步，各读一张表、各管一件事：
//
//   A `productInfo` —— 读「**货品信息**」：这个货号的**颜色 / 商品记录 id**。
//      **所有交易类型都要跑**：销售明细必须有商品与颜色才写得全。
//      预付单店里没货，颜色不可能从「实时库存」里读出来 —— 只能走这一步。
//      实现见 `larkMvpService.resolveProductInfoForSale`。
//
//   B `stock`       —— 读「**实时库存**」：门盒 / 样品 / 仓库的数量，
//      以及"**这个尺码到底有没有这一双**"（没货就拦单）。**按交易类型**。
//      实现见 `larkMvpService.resolveStockAvailabilityForSale`。
//
// ⚠️ 认不出来的交易类型（空编码）一律按「该跑的都跑」处理 —— 宁可多问一句，
//    也不放过一笔"鞋已经被拿走、却没这双鞋"的单。
// ⚠️ 这里**只**管"录单时跑哪些解析" + "颜色候选推哪些"，**不动交付 / 扣库存**：
//    交付与否仍由 `config/salesMovements.js` 的 `delivery` 从交易类型推出来
//    （预付 → 未交付，既有行为）。
// ⚠️ 本文件是这条规则的**唯一**判据来源：
//    业务逻辑里**不许**再出现 `trade_type === '预付'` 之类的散落判断。
//
// ⭐ 2026-10-07 第四刀：**颜色候选的范围**也按交易类型走（她的原话，逐字）：
//   「现货和未付是需要看在售的颜色，但是**预付是需要看这个货号的颜色**，
//     还是要配置先行，要模块化进行设置～」
//   范围取值是**显式的两个字面量**（`inStockOnly` / `allColors`）——**不**写成
//   "一个布尔 + 中文注释"那种要靠注释才看得懂的形状。
//   过滤实现在 `services/larkMvpService.colorOptionsInScope`；
//   「不在售」的取值域与"候选被清空"的文案在 `config/salesColorChoice`。
const SALES_COLOR_OPTIONS_SCOPE = Object.freeze({
  // 只推「在售」的颜色：货品状态明确标成不在售的，从候选里去掉。
  inStockOnly: 'inStockOnly',
  // 不过滤：这个货号的全部颜色都推给她（预付 —— 卖的就是没货、要调货的那一双）。
  allColors: 'allColors',
});

const SALES_TRADE_TYPE_PARSE_POLICY = Object.freeze({
  // 现货：当场收钱当场交货 —— 颜色从实时库存看（卖的是实物），没货就拦。
  //       候选只推在售的颜色。
  SALE_CASH: Object.freeze({
    productInfo: true, stock: true, colorOptionsScope: SALES_COLOR_OPTIONS_SCOPE.inStockOnly,
  }),
  // 未付：鞋**已经被拿走了**，那就必须确实有这双鞋 —— 仍然查。
  //       候选与现货同档：只推在售的颜色。
  SALE_UNPAID: Object.freeze({
    productInfo: true, stock: true, colorOptionsScope: SALES_COLOR_OPTIONS_SCOPE.inStockOnly,
  }),
  // 预付：货还没到、要调货 —— **不查库存**（没货是常态，不该据此拦单）；
  //       但**仍然要**从货品信息里拿颜色，否则销售明细写不全。
  //       ⭐ 候选**不按在售过滤**：预付卖的就是没货的那一双，按在售过滤会把候选清空
  //       （详见 `docs/sales-color-candidate-scope-2026-10-07.md`）。
  SALE_PREPAID: Object.freeze({
    productInfo: true, stock: false, colorOptionsScope: SALES_COLOR_OPTIONS_SCOPE.allColors,
  }),
});

// 兜底：认不出交易类型时，"该跑的都跑"。
// ⚠️ 候选范围跟着 `stock: true` 取 `inStockOnly` —— 认不出来时按**最保守**的那一档，
//    与现货 / 未付同档（宁可只推在售，也不要推一个卖不了的颜色）；
//    这与"该跑的都跑"是同一个取向，不是两套规则。
const SALES_PARSE_POLICY_DEFAULT = Object.freeze({
  productInfo: true, stock: true, colorOptionsScope: SALES_COLOR_OPTIONS_SCOPE.inStockOnly,
});

const salesParsePolicyFor = (tradeTypeCode) =>
  SALES_TRADE_TYPE_PARSE_POLICY[String(tradeTypeCode || '')] || SALES_PARSE_POLICY_DEFAULT;

// 这一步（'productInfo' | 'stock'）在这种交易类型下要不要跑。
const salesParseRuns = (tradeTypeCode, step) => Boolean(salesParsePolicyFor(tradeTypeCode)[step]);

// 这种交易类型下，A 出的颜色候选推哪些（`SALES_COLOR_OPTIONS_SCOPE` 两个取值之一）。
const salesColorOptionsScopeFor = (tradeTypeCode) => salesParsePolicyFor(tradeTypeCode).colorOptionsScope;

module.exports = {
  SALES_TRADE_TYPE_PARSE_POLICY,
  SALES_PARSE_POLICY_DEFAULT,
  SALES_COLOR_OPTIONS_SCOPE,
  salesParsePolicyFor,
  salesParseRuns,
  salesColorOptionsScopeFor,
};
