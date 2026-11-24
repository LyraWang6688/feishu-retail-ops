'use strict';

/**
 * 采购报货草稿配置（2026-11-25）。
 * 只存本地 JSON 快照：不写采购表、不建批次、不扣库存。
 * 一个用户只有一份草稿，重复保存 = 更新。
 */
const path = require('node:path');
const { readString } = require('./envValue');

const readInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

const PROCUREMENT_DRAFT = Object.freeze({
  enabled: process.env.PROCUREMENT_DRAFT_ENABLED !== 'false',
  dir: readString(process.env, 'PROCUREMENT_DRAFT_DIR', '')
    || path.join(__dirname, '../../data/procurement_drafts'),
  ttlDays: readInt(process.env.PROCUREMENT_DRAFT_TTL_DAYS, 30, 1, 365),
  texts: Object.freeze({
    empty: '还没有可保存的草稿',
    saved: '草稿已保存',
    saveFailed: '草稿保存失败，请稍后重试',
  }),
});

module.exports = { PROCUREMENT_DRAFT };
