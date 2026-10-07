// 销售录单：**交易类型的判据**（= 实时库存里有没有这一双）+ 逐明细的类型取法。
//
// 🔴 2026-10-07 口径大改（业务负责人拍板，逐字）：
//   「【类型 = 只看库存】（行为表里就两条：现货 SALE_CASH / 预定 SALE_PREPAID）
//     库存里有这双 → 现货（当场交付 + 扣库存）
//     库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）
//     ⭐ 所以：**每次都必须查库存**（这就是判据本身）→ '预定跳过库存检查'那条配置要删」
//
// 她的三步流程（逐字）：
//   「1. 货品信息还是要先查这个货品有没有、信息全不全
//     2. 这里要给到**全色**，让用户去选
//     3. 用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」
//   ⇒ 第 3 步查的是**实时库存**（不是货品信息）。
//
// 于是本文件有两件事，各一处实现：
//   ⓐ **类型的判据**：`salesTradeTypeForStock({ inStock })` —— 唯一的"有货 → 现货 /
//      没货 → 预定"映射。调用点**不许**再写 `'SALE_CASH'` / `'SALE_PREPAID'` 字面量。
//   ⓑ **逐明细的类型取法**：`itemTradeTypeCode` / `orderTradeTypeCodes`
//      （一行自己的编码 → 一行的中文标签 → 整单编码）。
//
// 🔴 **A 与 B 对两种类型都跑** —— 这不是"配出来的"，是本模型的**硬前提**：
//    类型 = 查完实时库存之后的结论，所以不可能再拿类型决定"要不要查"（循环论证）。
//    ⇒ 原来那张 `SALES_TRADE_TYPE_PARSE_POLICY`（每行声明 `productInfo` / `stock`
//      跑不跑、其中"预定"那行写着 `stock:false`）**已整体删除** ——
//      留一张"两行都是 true"的表只会让人以为"这里可以关掉库存检查"，
//      而关掉它等于把类型判据本身关掉。录单时两步各读一张表、各管一件事：
//      · A 读「**货品信息**」：这个货号的**颜色 / 商品记录 id**（全部颜色都给候选）。
//      · B 读「**实时库存**」：门盒 / 样品 / 仓库的数量 + "**这个尺码有没有这一双**"。
//    （配品没有货号 / 尺码，两步都不跑，沿用她嘴上说的性质 —— 那是唯一例外。）
//
// ⚠️ 这里**只**管"类型怎么定" + "录单时跑哪些解析"，**不动交付 / 扣库存**：
//    交付与否仍由 `config/salesMovements.js` 的 `delivery` 从类型推出来
//    （现货 → 已交付，预定 → 未交付）。
// ⚠️ 本文件是这条规则的**唯一**判据来源：
//    业务逻辑里**不许**再出现 `trade_type === '预定'` 之类的散落判断。
//
// ⚠️ 2026-10-07 **撤销**上一刀加的"颜色候选范围"（`colorOptionsScope`）：
//    候选一律给**全部颜色**（见 `docs/sales-type-by-stock-2026-10-07.md` AC-2）——
//    预定 = 没货，若候选只推在售，她永远选不到没货的颜色 ⇒ 预定走不通。
//    「有货 / 无货」标注**保留**（现在它 = 这双会记成现货 / 预定的预告）。
const { tradeTypeCodeFromLabel } = require('./salesMovements');

// ── ⓐ 类型判据：实时库存里有没有这一双 ────────────────────────────────────────
//
// 取值是**显式的两个字面量键**（`inStock` / `outOfStock`），不做"布尔 + 中文注释"那种
// 要靠注释才看得懂的形状。
const SALES_TRADE_TYPE_BY_STOCK = Object.freeze({
  // 库存里有这双 → 现货：当场交付 + 扣库存。
  inStock: 'SALE_CASH',
  // 库存里没有 → 预定：不交付；等货到了再交付、那时才扣库存。
  outOfStock: 'SALE_PREPAID',
});

/**
 * **类型的唯一判据**：查完实时库存之后再定。
 * @param {{ inStock?: boolean }} facts `inStock` = 这次查到的实时库存里有没有她选的那一双。
 *        ⚠️ 拿不到 / 没查（例如配品没有货号尺码）时**不要**调用它 ——
 *           调用点应沿用"她嘴上说的性质"（`itemTradeTypeCode` 的兜底）。
 */
const salesTradeTypeForStock = ({ inStock } = {}) =>
  (inStock ? SALES_TRADE_TYPE_BY_STOCK.inStock : SALES_TRADE_TYPE_BY_STOCK.outOfStock);

// ─── 粒度：从「整单一个」改成「逐明细一个 + 整单多选」（2026-10-07）──────────────────
//
// 业务负责人口径（逐字）：
//   「如果我们的交易类型可以多选的话，实际上这一笔是不是**既属于现货，又属于预定**呀？
//     **在销售明细里面分开，它是现货还是预定，不就可以了吗？**」
//
// ⇒ **每一条明细行**有自己的交易类型（单选），**整单**是这些类型的**去重集合**（多选）。
//   `salesTradeTypeForStock` 仍是**唯一**判据 —— 只是调用方
//   从「拿整单的编码调一次」变成「拿每一行的编码各调一次」。
//
// ⚠️ 这里**只做"这一行是哪种类型"的解析**，不碰交付 / 扣库存：
//    交付仍由 `config/salesMovements` 的 `delivery` 从编码推出来（`deliversForTradeType`）。

// **逐明细**的交易类型编码。优先级（与解析层同一套取值，避免两处结论不一致）：
//   ① 这一行自己的编码（解析层已经把中文 label 收敛成编码）；
//   ② 这一行自己的中文类型（老形状 / 模型只给了 label）；
//   ③ **整单**的编码（模型整单给了、没逐行给 —— 既有单类型单走的就是这一条）。
// ⚠️ **认不出来就返回空串，不许兜成 `SALE_CASH`** —— 空串在每一个消费点都
//    自然落到"还没定"的**既有默认档**（`deliversForTradeType('')` → 交付、
//    主表关联**不写**、卡片显示「待定」）。若在这里兜成现货，就等于替她
//    "认定这是一笔现货"，而类型本该由库存查完之后才有结论。
const itemTradeTypeCode = (item, orderTradeTypeCode = '') =>
  String(item?.trade_type_code || '').trim()
  || tradeTypeCodeFromLabel(item?.trade_type)
  || String(orderTradeTypeCode || '').trim();

// **整单**的交易类型编码集合：按明细行**出现顺序**去重。
// ⚠️ 顺序是有意的（不是排序）：写进主表多选关联时，人读到的顺序与她说货的顺序一致；
//    也让写入是**确定性**的（同一份草稿每次得到同一串 id，幂等重试不会写出不同形状）。
const orderTradeTypeCodes = (items = [], orderTradeTypeCode = '') => {
  const codes = [];
  for (const item of Array.isArray(items) ? items : []) {
    const code = itemTradeTypeCode(item, orderTradeTypeCode);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
};

// 「**预定性质**」的交易类型 —— 「定金 + 尾款」那套推导只可能落在它上面
// （定金 = 先付一部分、货还没拿走）。
// ⚠️ 这是**资金口径**的定位判据（"定金算在哪一件上"），**不是类型判据**：
//    类型的判据是 `salesTradeTypeForStock`（库存有没有）。
//    ⚠️ 它读的是**解析层给的提示**（她嘴上说"定金 / 以后来取"的那一件），
//    只在"多明细 + 定金、说不清定金属于哪一件"时用到；调用点不许再写 `=== 'SALE_PREPAID'`。
const SALES_PREPAID_TRADE_TYPE_CODES = Object.freeze(['SALE_PREPAID']);

const isPrepaidTradeType = (code) => SALES_PREPAID_TRADE_TYPE_CODES.includes(String(code || ''));

// 「多明细 + 定金」时，说不清定金属于哪一件的追问（**用户可见文案**，所以放配置）。
// ⚠️ 措辞**只说钱的事**（哪一件付了定金），**不把"预定"当类型问她** ——
//    类型是查完库存才有的结论，不该由她来选。
const SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS =
  '这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪一件付了定金、每双多少钱～';

module.exports = {
  SALES_TRADE_TYPE_BY_STOCK,
  SALES_PREPAID_TRADE_TYPE_CODES,
  SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS,
  salesTradeTypeForStock,
  itemTradeTypeCode,
  orderTradeTypeCodes,
  isPrepaidTradeType,
};
