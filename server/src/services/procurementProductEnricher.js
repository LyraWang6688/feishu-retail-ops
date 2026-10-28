'use strict';

/**
 * 采购页「货品信息」反查/归一化（读模型 + 提交共用一份，**避免第二套实现**）。
 *
 * 🔴 为什么需要它（2026-10-28 真测试 Base 集成验证发现的 Bug-2）：
 *   `V1BitableGateway.getBatch`（飞书 `records/batch_get`）返回的单元格形状与**列表接口不同**：
 *     · 公式 / 文本列：`{ type: 1, value: [{ text: '…' }] }`（**没有顶层 `text`**）；
 *     · 关联列：`{ link_record_ids: ['rec…'] }`（**没有显示文本**，列表接口才有 `text`）。
 *   ⇒ 直接 `String()` 会得到 `[object Object]`、颜色/显示名取不到（页面卡片颜色空、报货单图缺颜色）。
 *
 * 本模块只做两件事：
 *   ① 把 batch 形状归一化成文本（`{type,value:[{text}]}` → `'…'`）；
 *   ② 颜色是**关联列**（指向「颜色管理」），显示名要按 link id 再批量读一次颜色管理表。
 *
 * ⚠️ 只读：不写任何表；输入是 record_id 列表，输出是页面/载荷要用的纯字段。
 */

const { textOf, linkedIdsOf } = require('./procurementPageData');
const { logWarn } = require('../utils/logger');

/** batch_get 形状 → 纯文本（兼容 `{type,value:[…]}` / `[{text}]` / 字符串 / 数字）。 */
const batchTextOf = (value) => textOf(value);

/**
 * @param {object} deps
 * @param {object} deps.gateway  `V1BitableGateway`
 * @param {object} deps.schema   `V1_BITABLE_SCHEMA`
 * @param {object} [deps.logger] 可注入（用例断言 warn）
 */
const createProductEnricher = ({ gateway, schema, logger = { logWarn } } = {}) => {
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const productFields = () => (schema?.tables?.product?.fields) || {};
  const colorFields = () => (schema?.tables?.color?.fields) || {};

  /** 颜色 link id 列表 → 颜色名（一次 `getBatch('color')`；读不到 ⇒ 空串，不猜）。 */
  const colorNamesOf = async (colorIds) => {
    const unique = [...new Set((colorIds || []).filter(Boolean))];
    if (!unique.length) return new Map();
    try {
      const records = await gateway.getBatch('color', unique);
      const nameField = colorFields().name;
      return new Map((records || []).map((record) => [
        String(record.record_id), batchTextOf(record.fields?.[nameField]).trim(),
      ]));
    } catch (error) {
      // 颜色表读不到 ⇒ 颜色留空（页面标题只是少一段，不影响其他字段）；如实记一条 warn
      warn('procurement.page.color_lookup_failed', { error: String(error?.message || error) });
      return new Map();
    }
  };

  /** 一条「货品信息」记录（batch 形状）→ 归一化 DTO。 */
  const normalize = (record, colorNames = new Map()) => {
    const fields = record?.fields || {};
    const mapping = productFields();
    const colorIds = linkedIdsOf(fields[mapping.color]);
    return {
      productRecordId: String(record?.record_id || ''),
      number: batchTextOf(fields[mapping.number]).trim(),
      itemNo: batchTextOf(fields[mapping.itemNo]).trim(),
      color: colorNames.get(colorIds[0]) || '',
      colorRecordId: colorIds[0] || '',
      supplierRecordId: linkedIdsOf(fields[mapping.supplier])[0] || '',
      category: batchTextOf(fields[mapping.category]).trim().toUpperCase(),
      createdAt: Number(batchTextOf(fields[mapping.createdAt])) || null,
    };
  };

  /**
   * 按 record_id 批量反查并归一化（返回 `Map<recordId, dto>`）。
   * @param {string[]} recordIds
   */
  const enrich = async (recordIds = []) => {
    const ids = [...new Set((recordIds || []).filter(Boolean))];
    if (!ids.length) return new Map();
    const records = await gateway.getBatch('product', ids);
    const colorIds = (records || []).flatMap((record) => linkedIdsOf(record?.fields?.[productFields().color]));
    const colorNames = await colorNamesOf(colorIds);
    return new Map((records || []).map((record) => [String(record.record_id), normalize(record, colorNames)]));
  };

  return { enrich, normalize, colorNamesOf, batchTextOf };
};

module.exports = { createProductEnricher, batchTextOf };
