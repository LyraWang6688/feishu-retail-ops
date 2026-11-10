'use strict';

/**
 * 测试用：把 **fake gateway 写入的 link 值**（飞书写入格式 = 字符串数组）
 * 归一成**飞书读取格式**（`[{ record_ids: [...] }]`），模拟真实网关"写进去→读回来"。
 *
 * 背景（issue #1074）：`linkedRecordIds()` 已收窄为只认真实读形状；测试里的 fake gateway
 * 原来把写 payload 原样存、原样读，导致读回来的 link 仍是字符串数组。
 * 真实飞书读接口会把它变成 `record_ids` 对象（listAll/get），search/getBatch 是 `link_record_ids`。
 *
 * ⚠️ 只按**关联字段名**转，不是所有数组都转：
 *    `所属状态` / `履约状态` / `交易状态` / `写���状态` 等是 select（数组是选项值），**不许转**。
 */
const LINK_FIELD_NAMES = new Set([
  '销售单号', '关联销售单', '编号', '尺码', '库存行为', '关联销售', '关联采购',
  '支付方式', '团购券管理', '销售明细', '收款明细', '库存流水', '采购明细',
  '父记录', '供应商', '报货批次', '关联货品', '交易类型',
]);

/** 写格式（['rec…'] / [{id}] / [{record_ids}]）→ 读格式 `[{ record_ids: [...] }]`。 */
const toReadShape = (value) => {
  if (!Array.isArray(value)) return value;
  const ids = value.flatMap((item) => {
    if (typeof item === 'string') return item ? [item] : [];
    if (!item || typeof item !== 'object') return [];
    if (Array.isArray(item.record_ids)) return item.record_ids;
    if (Array.isArray(item.link_record_ids)) return item.link_record_ids;
    const id = item.record_id || item.recordId || item.id;
    return id ? [id] : [];
  });
  return ids.length ? [{ record_ids: ids }] : [];
};

/** 记录 fields（飞书列名）→ 把关联列的值归一成读格式。 */
const normalizeLinkFields = (fields = {}) => Object.fromEntries(
  Object.entries(fields).map(([name, value]) => [name,
    LINK_FIELD_NAMES.has(name) ? toReadShape(value) : value]),
);

module.exports = { LINK_FIELD_NAMES, toReadShape, normalizeLinkFields };
