'use strict';

/** 验收「样品尺码」选择的纯归一化：只收 产品 record_id → 正整数尺码。 */
const normalizeSampleChoices = (input) => {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [productId, rawSize] of Object.entries(input)) {
    const product = String(productId || '').trim();
    const size = Number(rawSize);
    if (product && Number.isSafeInteger(size) && size > 0) out[product] = size;
  }
  return out;
};

module.exports = { normalizeSampleChoices };
