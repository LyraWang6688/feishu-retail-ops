// 「这一单交给了多少 / 扣了多少库存」这句**结果话**的文案来源。
//
// 为什么单独一个配置（业务负责人 2026-10-07）：
//   「如果我们的交易类型可以多选的话，实际上这一笔是不是**既属于现货，又属于预定**呀？」
//   ⇒ 一张单里可以**有的行交付、有的行不交付**（现货件交付并扣库存，预定件不交付）。
//     改动前只有一个「整单交不交付」的布尔，话只有两句；现在多出**中间那一档**，
//     这三句话就属于"用户可见文案"，按《配置先行》放进 config，不散在逻辑里。
//
// ⚠️ `all` / `none` 两句是**逐字沿用**改动前写死在 `larkMvpService` 里的那两句 ——
//    单类型单（纯现货 / 纯预定）读到的仍然是同一串字，行为逐字不变。
const SALES_DELIVERY_SUMMARY = Object.freeze({
  // 这一单要交付的行**全都**交付了。
  all: Object.freeze({
    card: '已交付并扣库存。',
    toast: '销售已确认并交付，库存已更新',
  }),
  // 这一单**没有**任何一行要交付（纯预定单）。
  none: Object.freeze({
    card: '尚未交付，库存未扣减。',
    toast: '销售已确认；预定单尚未交付，库存未扣减',
  }),
  // ⭐ 新增的一档：一张单里有的行交付了、有的行（预定）没有。
  partial: Object.freeze({
    card: '部分明细已交付并扣库存，预定明细尚未交付。',
    toast: '销售已确认；部分明细已交付，其余尚未交付',
  }),
});

// 取值：`all` / `none` / `partial`（三档，见上）。
//   · `deliverableCount` = 这一单里**要交付**的明细条数；`totalCount` = 明细总条数。
//   · 判据只看这两个数 —— "要交付"由 `config/salesMovements.deliversForTradeType` 逐行推出来，
//     本文件不认识「预付」这个词。
const salesDeliverySummaryKey = (deliverableCount, totalCount) => {
  const deliverable = Number(deliverableCount) || 0;
  const total = Number(totalCount) || 0;
  if (deliverable <= 0) return 'none';
  if (total > 0 && deliverable < total) return 'partial';
  return 'all';
};

const salesDeliverySummaryFor = (deliverableCount, totalCount) =>
  SALES_DELIVERY_SUMMARY[salesDeliverySummaryKey(deliverableCount, totalCount)];

module.exports = {
  SALES_DELIVERY_SUMMARY,
  salesDeliverySummaryKey,
  salesDeliverySummaryFor,
};
