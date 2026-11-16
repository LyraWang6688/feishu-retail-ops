'use strict';

/**
 * 扫码页货品卡的两个入口（2026-11-17）：把「资料缺什么 / 记录链接 / 库存调整链接」
 * 从 `scanPageService` 里拆出来（那个文件是存量超限件，只许变小）。
 *
 * 纯计算：不读表、不写表；数据来源是调用方已经读到的 `product` 与同一份 schema/config。
 */
const { recordUrl } = require('../utils/feishuLinks');
const { fillText } = require('../config/scanPage');
const { productGapsOf, gapTextOf } = require('./productGaps');

const resolveProductActions = ({ schema, product, productId, config } = {}) => {
  const productTable = (schema && schema.tables && schema.tables.product) || {};
  const actionsConfig = (config && config.productActions) || {};
  // ⭐ 资料齐不齐走**唯一判定** `productGapsOf`（与货品资料页、销售卡片同一份）——
  //   商品信息缺失 / 标签信息缺失 / 样例图，三样都算。
  const gaps = productGapsOf({ fields: (product && product.fields) || {}, fieldNames: productTable.fields || {} });
  const missingText = gapTextOf(gaps, { separator: actionsConfig.gapIssueSeparator || '；' });
  let productRecordUrl = '';
  if (productId) {
    try {
      productRecordUrl = recordUrl({
        appToken: schema.appToken,
        tableId: productTable.tableId,
        viewId: productTable.viewId,
        recordId: productId,
      });
    } catch (error) {
      // 缺 `FEISHU_V1_BITABLE_APP_TOKEN` ⇒ 这条链接给不出来（不影响页面其它部分）。
      productRecordUrl = '';
    }
  }
  const template = String(actionsConfig.adjustHrefTemplate || '');
  const productAdjustUrl = productId && template
    ? fillText(template, { recordId: encodeURIComponent(productId) })
    : '';
  return { product_missing_text: missingText, product_record_url: productRecordUrl, product_adjust_url: productAdjustUrl };
};

module.exports = { resolveProductActions };
