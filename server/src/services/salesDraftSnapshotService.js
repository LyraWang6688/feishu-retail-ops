'use strict';

/**
 * 销售草稿快照的纯函数：把“页面现场”与“已加入本单的明细”分开。
 * 保存与打开都只调这里，避免路由各写一套字段映射。
 */
const { SALES_DRAFT } = require('../config/salesDraft');
const { SCAN_WRITE } = require('../config/scanWrite');
const { SAMPLE_PROMOTION } = require('../config/samplePromotion');

const text = (value) => String(value ?? '').trim();

const formValueOf = (body, key) => {
  const fields = SCAN_WRITE.fields || {};
  if (key === 'samplePromotionSize') return text(body?.[SAMPLE_PROMOTION.field]);
  return text(body?.[fields[key]]);
};

const captureCurrentForm = ({ body = {}, productRecordId = '' } = {}) => {
  const hidden = SALES_DRAFT.hiddenFields || {};
  const form = {
    product_record_id: text(productRecordId || body?.[hidden.productRecordId]),
    number: text(body?.[hidden.number]),
    item_no: text(body?.[hidden.itemNo]),
    color: text(body?.[hidden.color]),
  };
  for (const key of SALES_DRAFT.formFields) form[key] = formValueOf(body, key);
  return form;
};

const hasCurrentFormContent = (form = {}) => SALES_DRAFT.formFields.some((key) => text(form?.[key]));

const hasContent = ({ lines = [], currentForm = null } = {}) => (
  (Array.isArray(lines) && lines.length > 0) || hasCurrentFormContent(currentForm || {})
);

const summaryOf = (draft = {}) => ({
  currentPair: hasCurrentFormContent(draft.currentForm || {}),
});

module.exports = {
  captureCurrentForm,
  hasCurrentFormContent,
  hasContent,
  summaryOf,
};
