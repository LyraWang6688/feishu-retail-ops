const normalizedSize = (value, label = '尺码') => {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${label}必须是正整数`);
  return size;
};

const normalizedQuantity = (value) => {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('采购数量必须是正整数');
  return quantity;
};

const sizeKey = (value) => String(normalizedSize(value));

/**
 * 供应商报货数量规则：
 * - 表单勾选的尺码默认各一双；
 * - 数量说明只描述数量不为一的例外；
 * - AI 只负责从非空说明中提取例外，规则层负责合并和强校验。
 */
const buildPurchaseQuantities = async ({
  selectedSizes,
  quantityDescription,
  parseOverrides,
} = {}) => {
  if (!Array.isArray(selectedSizes) || selectedSizes.length === 0) {
    throw new Error('供应商报单至少选择一个尺码');
  }

  const orderedSizes = [];
  const selectedByKey = new Map();
  for (const raw of selectedSizes) {
    const size = normalizedSize(raw, '已选尺码');
    const key = sizeKey(size);
    if (selectedByKey.has(key)) continue;
    selectedByKey.set(key, size);
    orderedSizes.push(size);
  }

  const description = String(quantityDescription || '').trim();
  if (!description) return orderedSizes.map((size) => ({ size, quantity: 1 }));
  if (typeof parseOverrides !== 'function') throw new Error('数量说明解析器未配置');

  const parsed = await parseOverrides(description, { selectedSizes: orderedSizes.slice() });
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('数量说明中没有识别出明确的尺码数量');
  }

  const overrides = new Map();
  for (const item of parsed) {
    const size = normalizedSize(item?.size, '数量说明中的尺码');
    const key = sizeKey(size);
    if (!selectedByKey.has(key)) {
      throw new Error(`数量说明提到了未勾选的 ${size} 码`);
    }
    const quantity = normalizedQuantity(item?.quantity);
    if (overrides.has(key) && overrides.get(key) !== quantity) {
      throw new Error(`数量说明对 ${size} 码给出了不同数量`);
    }
    overrides.set(key, quantity);
  }

  return orderedSizes.map((size) => ({
    size,
    quantity: overrides.get(sizeKey(size)) || 1,
  }));
};

module.exports = {
  buildPurchaseQuantities,
};
