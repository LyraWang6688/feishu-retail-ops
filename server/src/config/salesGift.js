// 销售赠品的落点与归一（业务负责人 2026-10-08 口径，逐字）：
//   「好的，写入的落点放在销售主表里的赠品，销售明细没有赠品了」
//
// 为什么放进 config：**落点本身会变**（2026-10-08 从「销售明细」搬到「销售主表」），
// 而**合并规则的字面量**（分隔符 / 占位文案）不该散落在 service 里。
// ⚠️ 这里只管**落库口径**：解析层（doubaoService）的 `items[].gift` /
//    `items[].gift_description` 一个字都不动；卡片话术（larkCards 的「赠品：…」）也不在这儿。

const SALES_GIFT = Object.freeze({
  // 多个赠品之间的连接符。与解析层"单双鞋"归并用的是同一个符号
  //（`doubaoService`：`[...new Set(gifts)].join('、')`）—— 所以逐件算完之后，
  // 还能按它把一串重新拆成**单个赠品**再去重（合并规则见 mergeGiftTexts）。
  separator: '、',
  // `gift=true` 但**没有描述**时的占位文案。
  //（2026-10-08 之前这是 `salesOrderService` 里一个写死的字面量，本次挪进配置。）
  placeholder: '有赠品',
});

const giftText = (value) => String(value ?? '').trim();

// 一件明细自己的赠品文本：有描述用描述；`gift=true` 但没描述用占位；否则空串。
const giftTextOfItem = (item = {}) => {
  const description = giftText(item.giftDescription);
  if (description) return description;
  return item.gift ? SALES_GIFT.placeholder : '';
};

// ⭐ 一单一条：把逐件的赠品文本合并成**销售主表那一列**的值。
// 规则（逐字，与解析层同一套归一）：
//   ① 按明细顺序处理；② 每件先按分隔符拆成**单个赠品**（一件里可能说了好几个）；
//   ③ 按出现顺序**去重**；④ 用分隔符连起来。
// 一件赠品都没有 ⇒ 空串（与既有语义一致：**写空**，不是"不写这一列"）。
const mergeGiftTexts = (itemTexts = []) => {
  const seen = new Set();
  const merged = [];
  for (const text of itemTexts) {
    for (const part of giftText(text).split(SALES_GIFT.separator)) {
      const gift = part.trim();
      if (!gift || seen.has(gift)) continue;
      seen.add(gift);
      merged.push(gift);
    }
  }
  return merged.join(SALES_GIFT.separator);
};

module.exports = { SALES_GIFT, giftText, giftTextOfItem, mergeGiftTexts };
