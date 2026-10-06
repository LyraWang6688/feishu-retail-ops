// 售后做完之后，往**原销售主表**的「销售状态」里写什么（配置先行）。
//
// 为什么单独成文件：
//   · 这是**业务口径**（"退过的单"长什么样），不是逻辑。改口径只改这里；
//   · 它与 `config/salesStatusDimensions.js` 是**两件事**：
//       - dimensions 管的是**那一笔售后自己的**四个状态维度（销售/资金/库存/确认）；
//       - 本文件管的是**被退的那张原单**上的「销售状态」——
//         取值正是查单链路用来"排除已经退过的单"的那两个字面量
//         （`config/saleLookup.RETURNED_SALES_STATUSES` = 已退货 / 部分退货）。
//     ⚠️ 刻意**不去改** `config/salesStatus*`：那一层的值域是"写入进度"
//        （未写入/部分写入/已写入/写入失败），是另一维度的事，不要混在一起。
//
// 为什么只有「退货」写、换货/赔货不写：
//   · 查单判据只认「已退货 / 部分退货」，换货/赔货写这两个值是把业务事实说错；
//   · 换货/赔货要不要禁止再次退那一双，是业务负责人还没定的口径
//     （原明细的「履约状态」已经改成 已换货/已赔货，但查单判据今天不读它）。
//     在没定之前**不猜**：不做映射 = 不写（调用点 `originalSalesStatusFor` 返回 null）。
//
// ⚠️ 值必须落在 `config/saleLookup.RETURNED_SALES_STATUSES` 里，否则"写进去"和
//    "读出来排除"就对不上（写了一个查单不认识的词＝等于没写）。
//    `afterSalesOriginalSalesStatus.test.js` 钉住这条。
const { AFTER_SALES_ACTIONS } = require('./afterSales');

const AFTER_SALES_ORIGINAL_SALES_STATUS = Object.freeze({
  [AFTER_SALES_ACTIONS.RETURN]: Object.freeze({
    // 整单的原明细都退完了（含这一次）
    returned: '已退货',
    // 原单上还有没退的明细（部分退货）——查单判据对这两个值一视同仁，
    // 所以这一单**整单**都不会再被当成"可退的销售"拿出来重退一次。
    partial: '部分退货',
  }),
});

/** 这一次动作要不要回写原单的「销售状态」；不要就返回 null（调用点不写）。 */
const originalSalesStatusFor = (action) =>
  AFTER_SALES_ORIGINAL_SALES_STATUS[String(action ?? '').trim()] || null;

module.exports = {
  AFTER_SALES_ORIGINAL_SALES_STATUS,
  originalSalesStatusFor,
};
