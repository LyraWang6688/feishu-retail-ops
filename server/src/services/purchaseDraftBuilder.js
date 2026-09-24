const { textValue } = require('./v1BitableGateway');
const { logInfo } = require('../utils/logger');

/**
 * 按 货号+颜色+尺码 聚合多张图的 AI 识别结果，相同 SKU 累加数量。
 * 一张图可能有多个鞋盒标签，一个批次可能有多张图，都在这里合并。
 */
const aggregateRecognizedItems = (items) => {
  const map = new Map();
  for (const item of items) {
    const key = [item.item_no, item.color, item.size].map((value) => String(value || '').trim()).join('|');
    if (!map.has(key)) map.set(key, { ...item, quantity: 0 });
    map.get(key).quantity += Number(item.quantity || 1);
  }
  return [...map.values()];
};

/**
 * PurchaseDraftBuilder
 *
 * 职责：把多张鞋盒图的 AI 识别原始结果，构建成一张可直接发确认卡的采购草稿。
 * 内部四步：聚合 → 货品匹配 → 供应商匹配 → 缺失字段校验。
 *
 * 为什么独立成模块：
 * - 货品匹配必须在发确认卡前完成（用户要看到匹配到的完整编号，匹配失败要提前知道）
 * - 聚合、匹配、校验这些业务规则不应散落在消息处理层（larkMvpService）
 * - 可单独单元测试，不需要 mock 飞书消息
 * - 未来退换货、盘点等链路可以复用同样的"识别→草稿→确认→入账"模式
 */
class PurchaseDraftBuilder {
  constructor(options = {}) {
    if (!options.references) throw new Error('PurchaseDraftBuilder requires references (V1ReferenceResolver)');
    this.references = options.references;
  }

  /**
   * 构建采购草稿
   * @param {Array} recognizedItems - AI 识别原始结果（每张图的识别结果合并后的数组）
   * @param {Object} options - { payment: { amount, method } } 用户已补充的付款信息
   * @returns {Object} draft - 可直接用于确认卡渲染和入账的草稿
   */
  async buildDraft(recognizedItems, options = {}) {
    // Step 1: 聚合相同 SKU
    const aggregated = aggregateRecognizedItems(recognizedItems);

    // Step 2: 逐个匹配货品信息 + 供应商
    const items = [];
    const matchErrors = [];
    const supplierNames = new Set();

    for (const raw of aggregated) {
      const item = {
        item_no: String(raw.item_no || '').trim(),
        color: String(raw.color || '').trim(),
        size: raw.size,
        quantity: Number(raw.quantity || 1),
        unit_cost: raw.unit_cost,
        supplier: String(raw.supplier || '').trim(),
        product_record_id: '',
        product_number: '',
        supplier_record_id: '',
        match_error: '',
      };

      // 2a. 货品匹配：货号+颜色 → 货品信息表 record_id + 完整编号
      try {
        const product = await this.references.resolveProduct({ itemNo: item.item_no, color: item.color });
        item.product_record_id = product.recordId;
        item.product_number = this._extractProductNumber(product) || item.item_no;
      } catch (error) {
        item.match_error = error.message;
        const label = `${item.item_no}${item.color ? ' ' + item.color : ''}`;
        matchErrors.push(`${label}: ${error.message}`);
      }

      // 2b. 供应商匹配：供应商名称 → 供应商管理表 record_id
      if (item.supplier) {
        try {
          const supplier = await this.references.resolveSupplier(item.supplier);
          item.supplier_record_id = supplier.recordId;
          supplierNames.add(item.supplier);
        } catch (_error) {
          // 供应商匹配失败不阻断单条 item，统一在缺失字段校验里提示
        }
      }

      items.push(item);
    }

    // Step 3: 缺失字段校验
    const missingFields = this._validateMissingFields(items, matchErrors, options.payment);

    // Step 4: 汇总主供应商（取第一个匹配成功的，兼容批次表单供应商字段）
    const matchedSupplierItem = items.find((item) => item.supplier_record_id);
    const draft = {
      items,
      supplier: matchedSupplierItem?.supplier || '',
      supplier_record_id: matchedSupplierItem?.supplier_record_id || '',
      supplier_count: supplierNames.size,
      missing_fields: missingFields,
      payment: options.payment || null,
    };

    logInfo('purchase.draft.built', {
      item_count: items.length,
      matched_product_count: items.filter((i) => i.product_record_id).length,
      unmatched_product_count: items.filter((i) => i.match_error).length,
      supplier_count: supplierNames.size,
      missing_field_count: missingFields.length,
    });

    return draft;
  }

  /**
   * 从货品匹配结果中提取完整编号（货品信息表的"编号"字段）
   */
  _extractProductNumber(product) {
    try {
      const table = this.references.gateway?.table?.('product');
      if (!table) return '';
      return textValue(product.record?.fields?.[table.fields?.number]);
    } catch (_error) {
      return '';
    }
  }

  /**
   * 校验缺失字段，生成用户可读的提示列表
   */
  _validateMissingFields(items, matchErrors, payment) {
    const missingFields = [];

    // 供应商：所有 item 都没匹配到供应商时提示
    const hasAnySupplier = items.some((item) => item.supplier_record_id);
    if (!hasAnySupplier) {
      missingFields.push('供应商');
    }

    // 入库单价：有任意 item 缺单价时提示
    if (items.some((item) => !item.unit_cost)) {
      missingFields.push('入库单价');
    }

    // 货品匹配失败：逐条列出，让用户知道哪个货号没上架
    for (const error of matchErrors) {
      missingFields.push(`货品未匹配：${error}`);
    }

    // 已付款但缺付款方式
    if (payment?.amount && !payment.method) {
      missingFields.push('付款方式');
    }

    return missingFields;
  }
}

module.exports = {
  PurchaseDraftBuilder,
  aggregateRecognizedItems,
};
