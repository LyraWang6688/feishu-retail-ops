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
 * 「说明和勾选对不上」的机器可读分类。
 *
 * 业务负责人 2026-10-06 的口径：这种对不上**不是**整批失败、也不是静默——要**在采购群
 * 给她一句看得懂的话**（「这条报货的说明里写了没勾选的尺码（39 码），请核对后再提交」）。
 * 所以这里把"对不上"的几种情形编码出来，由调用方（purchaseWebhookService）决定
 * 发什么文案、发一次；policy 层只负责**判定**，不碰 IM（模块化/解耦）。
 */
const PURCHASE_QUANTITY_MISMATCH = Object.freeze({
  NO_SELECTED_SIZE: 'no_selected_size',
  NO_QUANTITY_PARSED: 'no_quantity_parsed',
  UNSELECTED_SIZE: 'unselected_size',
  CONFLICTING_QUANTITY: 'conflicting_quantity',
});

class PurchaseQuantityMismatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PurchaseQuantityMismatchError';
    this.code = code;
    // 相关尺码（没有就是 null）：文案里要写「（39 码）」。
    this.size = details.size ?? null;
  }
}

/** 只认这一类错误：其它异常照旧按"可重试的失败"处理，绝不顺手吞掉。 */
const isPurchaseQuantityMismatch = (error) => error?.name === 'PurchaseQuantityMismatchError';

/**
 * 把分类翻译成**她看得懂**的一句群提示（纯函数，便于单测钉住文案）。
 * 带上货号/明细ID 是为了在群里能对上"是哪一条"。
 */
const buildPurchaseQuantityMismatchNotice = (error, context = {}) => {
  const where = [
    context.itemNo ? `货号 ${context.itemNo}` : '',
    context.detailId ? `明细ID ${context.detailId}` : '',
  ].filter(Boolean).join(' · ');
  const suffix = where ? `（${where}）` : '';
  switch (error?.code) {
    case PURCHASE_QUANTITY_MISMATCH.UNSELECTED_SIZE:
      return `这条报货的说明里写了没勾选的尺码（${error.size} 码），请核对后再提交${suffix}`;
    case PURCHASE_QUANTITY_MISMATCH.CONFLICTING_QUANTITY:
      return `这条报货的说明对 ${error.size} 码给了两个不同的数量，请核对后再提交${suffix}`;
    case PURCHASE_QUANTITY_MISMATCH.NO_QUANTITY_PARSED:
      return `这条报货的说明没能识别出明确的尺码数量，请核对后再提交${suffix}`;
    case PURCHASE_QUANTITY_MISMATCH.NO_SELECTED_SIZE:
      return `这条报货没勾选尺码，请核对后再提交${suffix}`;
    default:
      return `这条报货的说明和勾选的尺码对不上（${error?.message || '未知原因'}），请核对后再提交${suffix}`;
  }
};


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
    throw new PurchaseQuantityMismatchError(
      PURCHASE_QUANTITY_MISMATCH.NO_SELECTED_SIZE, '供应商报单至少选择一个尺码',
    );
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
    throw new PurchaseQuantityMismatchError(
      PURCHASE_QUANTITY_MISMATCH.NO_QUANTITY_PARSED, '数量说明中没有识别出明确的尺码数量',
    );
  }

  const overrides = new Map();
  for (const item of parsed) {
    const size = normalizedSize(item?.size, '数量说明中的尺码');
    const key = sizeKey(size);
    if (!selectedByKey.has(key)) {
      throw new PurchaseQuantityMismatchError(
        PURCHASE_QUANTITY_MISMATCH.UNSELECTED_SIZE,
        `数量说明提到了未勾选的 ${size} 码`,
        { size },
      );
    }
    const quantity = normalizedQuantity(item?.quantity);
    if (overrides.has(key) && overrides.get(key) !== quantity) {
      throw new PurchaseQuantityMismatchError(
        PURCHASE_QUANTITY_MISMATCH.CONFLICTING_QUANTITY,
        `数量说明对 ${size} 码给出了不同数量`,
        { size },
      );
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
  PURCHASE_QUANTITY_MISMATCH,
  PurchaseQuantityMismatchError,
  isPurchaseQuantityMismatch,
  buildPurchaseQuantityMismatchNotice,
};
