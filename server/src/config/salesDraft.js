'use strict';

/**
 * 销售扫码草稿箱配置（2026-11-24；2026-11-26 增加 currentForm）。
 * 只存本地快照，不写飞书销售表；只有用户点「保存」才落盘。
 */
const path = require('node:path');

const readInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

const SALES_DRAFT = Object.freeze({
  enabled: process.env.SCAN_SALES_DRAFT_ENABLED !== 'false',
  dir: String(process.env.SCAN_SALES_DRAFT_DIR || '').trim()
    || path.join(__dirname, '../../data/sales_drafts'),
  maxDrafts: readInt(process.env.SCAN_SALES_DRAFT_MAX, 20, 1, 200),
  ttlDays: readInt(process.env.SCAN_SALES_DRAFT_TTL_DAYS, 30, 1, 365),
  schemaVersion: 1,
  steps: Object.freeze({ goods: 'goods', payment: 'payment' }),
  // 页面隐藏字段：让“第一双还没加入本单”也能记住它是什么货。
  hiddenFields: Object.freeze({
    number: 'draft_number',
    itemNo: 'draft_item_no',
    color: 'draft_color',
    productRecordId: 'draft_product_record_id',
  }),
  // 当前页面表单里要快照的语义字段（实际字段名从 SCAN_WRITE.fields / SAMPLE_PROMOTION.field 取）。
  formFields: Object.freeze(['size', 'amount', 'gift', 'samplePromotionSize']),
  texts: Object.freeze({
    save: '保存草稿',
    saved: '草稿已保存',
    failed: '保存失败，请稍后重试',
    empty: '本单还没有可保存的内容',
    currentPair: '当前待提交 1 双',
  }),
});

module.exports = { SALES_DRAFT };
