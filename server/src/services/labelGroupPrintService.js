'use strict';

/**
 * 货品组标签数据解析器。
 * 只读货品组公式（颜色/单价）与成员实时库存；共用 labelPrintService 的布局/打印时间。
 */
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SCAN_URL } = require('../config/tagQrCode');
const { buildSizeLines, planSizeTokens } = require('./labelSizePlan');
const { buildGroupIdScanUrl } = require('./tagQrCodeService');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
const { equalsFormula } = require('./bitableFilterFormula');
const { logInfo } = require('../utils/logger');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const createGroupLabel = ({ gateway, config, now, retry, helpers = {} }) => {
  const formatPrice = helpers.formatPrice;
  const compareSizes = helpers.compareSizes;
  const resolveGrid = helpers.resolveGrid;
  return async (groupId) => {
    const id = String(groupId || '').trim();
    if (!id) throw userError('缺少货品组记录 ID');
    const groupFields = V1_BITABLE_SCHEMA.tables.productGroup?.fields || {};
    if (!groupFields.products || !groupFields.name) {
      throw new Error('「货品组」缺少必要的字段映射（货品组 / 关联货品）');
    }
    const record = await gateway.get('productGroup', id, { retry });
    if (!record) throw userError('没有找到这个货品组');
    const name = textValue(record?.fields?.[groupFields.name]).trim();
    if (!name) throw userError('这个货品组没有名称，不能打印标签');
    const color = textValue(record?.fields?.[groupFields.color]).trim();
    const rawPrice = record?.fields?.[groupFields.price];
    const priceTextValue = textValue(rawPrice).trim();
    const price = priceTextValue ? Number(priceTextValue) : NaN;
    const productIds = linkedRecordIds(record?.fields?.[groupFields.products]);
    if (!productIds.length) throw userError('这个货品组还没有关联货品，不能打印标签');
    const recordIdField = String(V1_BITABLE_SCHEMA.tables.liveInventory?.fields?.recordId || '').trim();
    const stockKeyField = String(V1_BITABLE_SCHEMA.tables.liveInventory?.fields?.stockKey || '').trim();
    const sizeField = String(V1_BITABLE_SCHEMA.tables.liveInventory?.fields?.size || '').trim();
    if (!recordIdField || typeof gateway.listByFilter !== 'function') {
      throw new Error('「实时库存」缺少 recordID 字段映射，无法按货品组汇总库存');
    }
    const sizes = new Map();
    let stockRows = 0;
    for (const productId of productIds) {
      const filter = equalsFormula(recordIdField, productId);
      if (!filter) throw new Error('货品组里有不合法的货品记录 ID');
      const rows = await gateway.listByFilter('liveInventory', filter, { retry });
      for (const row of rows || []) {
        stockRows += 1;
        const parsed = stockKeyField ? parseStockKey(textValue(row?.fields?.[stockKeyField])) : null;
        const size = textValue(row?.fields?.[sizeField]).trim() || String(parsed?.size || '').trim();
        if (size) sizes.set(size, (sizes.get(size) || 0) + 1);
      }
    }
    const planned = planSizeTokens({
      stockSizes: sizes,
      category: '',
      compare: (left, right) => compareSizes(left.size, right.size, config.sizes),
    });
    const { lines, overflow } = buildSizeLines(planned, config.sizes);
    const totalQty = planned.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const priceValue = Number.isFinite(price) ? price : null;
    const priceText = config.fields?.price ? formatPrice(priceValue, config.price) : '';
    const scanUrl = buildGroupIdScanUrl(id, { scanUrl: SCAN_URL });
    const label = {
      key: `group:${id}`,
      number: name,
      item_no: name,
      color,
      category: '',
      category_code: '',
      sizes: planned,
      size_lines: lines,
      size_overflow: overflow,
      total_qty: totalQty,
      states: [],
      state_text: '',
      price: priceValue,
      price_text: priceText,
      brand_text: config.fields?.brand ? String(config.brand?.text ?? '') : '',
      record_ids: productIds,
      record_count: productIds.length,
      has_stock: stockRows > 0,
      created_at: '',
      scan_url: scanUrl,
      footer_text: '',
      qr_svg: config.fields?.qr ? await QRCode.toString(scanUrl, {
        type: 'svg',
        errorCorrectionLevel: config.qr.errorCorrectionLevel,
        margin: config.qr.marginModules,
        color: { dark: config.qr.darkColor, light: config.qr.lightColor },
      }) : '',
    };
    const grid = resolveGrid(config);
    logInfo('workbench.labels.group_resolved', {
      group_id: id,
      members: productIds.length,
      stock_rows: stockRows,
      sizes: planned.length,
      total_qty: totalQty,
    });
    return {
      generated_at: new Date(now()).toISOString(),
      total_matched: 1,
      total_returned: 1,
      total_pairs: stockRows,
      total_with_stock: stockRows > 0 ? 1 : 0,
      total_without_stock: stockRows > 0 ? 0 : 1,
      truncated: false,
      max_labels: config.limits.maxLabels,
      skipped_records: { stock_key: 0, total: 0 },
      missing_price: priceValue === null && config.fields?.price ? 1 : 0,
      missing_price_no_product: 0,
      missing_qr_record_id: 0,
      filters: { groupId: id },
      layout: {
        label: config.label,
        page: config.page,
        grid: { ...grid, gapXMm: config.grid.gapXMm, gapYMm: config.grid.gapYMm },
        typography: config.typography,
        sizes: config.sizes,
        body: config.body,
        fields: config.fields,
        texts: config.texts,
        printTime: config.printTime,
      },
      qr: { url_template: SCAN_URL.groupIdTemplate, source: 'config/tagQrCode.js#SCAN_URL' },
      labels: [label],
    };
  };
};

module.exports = { createGroupLabel };
