'use strict';

/**
 * 标签「尺码行」的纯规划逻辑（从 labelPrintService 拆出，避免单文件继续变胖）。
 *
 * 口径（2026-11-15 业务负责人）：
 *   · 普通码全量印：女 36–41 / 男 38–44；
 *   · 特殊码只在该尺码有库存时印；
 *   · 类别缺失 ⇒ 退回旧行为：只印有库存的码；
 *   · 没库存的码 qty 用空字符串（渲染层不画角标，绝不印 0）。
 */

const { SIZE_SEGMENTS, expandRange } = require('../config/scanPage');

const normalSizesOf = (category, sizeSegments = SIZE_SEGMENTS) => {
  const key = String(category ?? '').trim();
  const range = sizeSegments?.ranges?.[key];
  if (!range || !Array.isArray(range.normal)) return null;
  return expandRange(range.normal);
};

const buildSizeLines = (sizes, sizesConfig = {}) => {
  const perLine = Number.isInteger(sizesConfig.perLine) && sizesConfig.perLine > 0 ? sizesConfig.perLine : 3;
  const maxLines = Number.isInteger(sizesConfig.maxLines) && sizesConfig.maxLines > 0 ? sizesConfig.maxLines : 6;
  const visible = sizes.slice(0, perLine * maxLines);
  const lines = [];
  for (let index = 0; index < visible.length; index += perLine) {
    lines.push(visible.slice(index, index + perLine));
  }
  return { lines, overflow: sizes.length > visible.length };
};

/**
 * 库存聚合 → 标签尺码 token。
 * @param {{stockSizes: Map, category: string, compare: Function}} input
 */
const planSizeTokens = ({ stockSizes, category, compare } = {}) => {
  const normalSizes = normalSizesOf(category);
  const stockQtyBySize = new Map([...(stockSizes?.entries?.() || [])].map(([size, quantity]) => [String(size), quantity]));
  const sizeKeys = new Set();
  if (normalSizes) normalSizes.forEach((sizeValue) => sizeKeys.add(String(sizeValue)));
  for (const [sizeValue, quantity] of stockSizes || []) {
    if (Number(quantity) > 0) sizeKeys.add(String(sizeValue));
  }
  return [...sizeKeys]
    .map((sizeValue) => {
      const quantity = Number(stockQtyBySize.get(sizeValue) || 0);
      const numericSize = Number(sizeValue);
      return {
        size: Number.isFinite(numericSize) ? numericSize : sizeValue,
        qty: quantity > 0 ? quantity : '',
      };
    })
    .sort(compare);
};

module.exports = { normalSizesOf, buildSizeLines, planSizeTokens };
