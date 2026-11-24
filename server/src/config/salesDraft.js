'use strict';

/**
 * 销售扫码草稿箱配置（2026-11-24）。
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
  steps: Object.freeze({ goods: 'goods', payment: 'payment' }),
  texts: Object.freeze({ save: '保存草稿', saved: '草稿已保存', failed: '保存失败，请稍后重试' }),
});

module.exports = { SALES_DRAFT };
