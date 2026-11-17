'use strict';

/** 扫码页的金额解析 / 文案（2026-11-17 从 `scanPageService` 原样搬出，行为不变）。
 *  该文件是存量超限件；搬出后 `scanPageService` 只 re-export `formatPrice`（用例照旧从那里取）。 */
const { SCAN_PAGE } = require('../config/scanPage');
const { textValue } = require('./v1BitableGateway');

const asAmount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = textValue(value).replace(/[¥,\s]/g, '');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 金额文案：整数不补零（`¥399`），带角分才显示小数（`¥399.50`）。 */
const formatPrice = (value, config = SCAN_PAGE) => {
  if (value === null || value === undefined) return config.texts.missingValue;
  const decimals = Number.isInteger(config.price.decimals) && config.price.decimals >= 0 ? config.price.decimals : 2;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(decimals);
  return `${config.price.prefix}${text}`;
};

module.exports = { asAmount, formatPrice };
