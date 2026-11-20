'use strict';

/**
 * 验收差异分析：与前端「应到 / 实到 / 多到」同一口径。
 *
 * - expected = 非自定义尺码行的申请数量合计；
 * - actual   = 非自定义行 min(实际到货, 申请数量) 合计；
 * - extra    = 非自定义行超过申请的数量 + 自定义尺码的实际到货数量。
 */
const summarizeArrivalDifference = (rows = []) => {
  let expected = 0;
  let actual = 0;
  let extra = 0;
  for (const row of rows || []) {
    const declared = Math.max(0, Number(row?.quantity) || 0);
    const arrived = Math.max(0, Number(row?.actual) || 0);
    if (row?.custom === true) {
      extra += arrived;
      continue;
    }
    expected += declared;
    actual += Math.min(arrived, declared);
    extra += Math.max(0, arrived - declared);
  }
  return { expected, actual, extra };
};

const fillTemplate = (template, values = {}) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const formatArrivalDifference = (totals = {}, template = '') => fillTemplate(template, totals);

module.exports = { summarizeArrivalDifference, formatArrivalDifference };
