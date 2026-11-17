'use strict';

/**
 * 「货品资料齐不齐」的**唯一判定**（2026-11-17 收口）：商品信息缺失 / 标签信息缺失 / 样例图。
 *
 * 三处消费者共用这一份，避免各写一套：
 *   · `routes/workbench/products.js` 的货品资料页（搜索 / 货品完善 / 样例图）
 *   · `services/larkMvpService.js` 的销售卡片缺口索引
 *   · `services/scanPageProductActions.js` 的扫码页「资料不齐」链接
 *
 * 口径（都是既有事实，不新造）：
 *   · 两个「缺失信息」是飞书**公式字段**：齐备时返回「齐备」，否则返回缺的字段名（`、` 分隔）；
 *   · 样例图不在公式里，单独看附件数组有没有内容；
 *   · 公式字段没配 / 读不到 ⇒ 不据此报缺口（不猜）。
 */
const { PRODUCT_PROFILE } = require('../config/productProfile');
const { textValue } = require('./v1BitableGateway');

const splitMissing = (text) => String(text || '').split('、').map((item) => item.trim()).filter(Boolean);

const productGapsOf = ({ fields = {}, fieldNames = {} } = {}) => {
  const completeValue = PRODUCT_PROFILE.completeValue;
  const productText = fieldNames.completeness ? textValue(fields[fieldNames.completeness]).trim() : '';
  const tagText = fieldNames.tagCompleteness ? textValue(fields[fieldNames.tagCompleteness]).trim() : '';
  const missingProductText = productText && productText !== completeValue ? productText : '';
  const missingTagText = tagText && tagText !== completeValue ? tagText : '';
  const images = fields[fieldNames.sampleImage];
  const hasSampleImage = Array.isArray(images) && images.length > 0;
  return {
    productText,
    tagText,
    missingProductText,
    missingTagText,
    missingProductList: splitMissing(missingProductText),
    missingTagList: splitMissing(missingTagText),
    hasSampleImage,
    missingSampleImage: !hasSampleImage,
  };
};

/** 把「缺什么」按货品资料页的 chips 口径拆成数组（样例图 / 商品信息 / 标签信息）。 */
const gapItemsOf = (gaps, {
  sampleLabel = PRODUCT_PROFILE.issueSample,
  productTemplate = PRODUCT_PROFILE.issueProduct,
  tagTemplate = PRODUCT_PROFILE.issueTag,
} = {}) => {
  const fill = (text, values) => String(text || '').replace(/\{(\w+)\}/g, (match, key) => (
    values[key] == null ? '' : String(values[key])
  ));
  const items = [];
  if (gaps.missingSampleImage && sampleLabel) items.push(sampleLabel);
  if (gaps.missingProductText) items.push(fill(productTemplate, { value: gaps.missingProductText }));
  if (gaps.missingTagText) items.push(fill(tagTemplate, { value: gaps.missingTagText }));
  return items;
};

/** 把 chips 拼成一句话（扫码页那条「资料不齐：…」）。 */
const gapTextOf = (gaps, { separator = PRODUCT_PROFILE.issueSeparator, ...options } = {}) => (
  gapItemsOf(gaps, options).join(separator)
);

module.exports = { productGapsOf, gapItemsOf, gapTextOf, splitMissing };
