'use strict';

/**
 * 货品组库存读取：只读组、成员货品、成员实时库存。
 * 组只做展示与汇总；所有库存变更仍由具体 productRecordId 承担。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
const { equalsFormula } = require('./bitableFilterFormula');
const { GROUP_SCAN_PAGE } = require('../config/groupScanPage');

const createProductGroupStockService = ({ gateway }) => {
  if (!gateway) throw new Error('ProductGroupStockService requires gateway');
  const groupFields = () => V1_BITABLE_SCHEMA.tables.productGroup?.fields || {};
  const productFields = () => V1_BITABLE_SCHEMA.tables.product?.fields || {};
  const liveFields = () => V1_BITABLE_SCHEMA.tables.liveInventory?.fields || {};

  const readGroup = async (groupId) => {
    const fields = groupFields();
    if (!fields.products) throw new Error('「货品组」缺少「关联货品」字段映射');
    const record = await gateway.get('productGroup', groupId);
    if (!record) return null;
    return {
      recordId: record.record_id,
      name: textValue(record.fields?.[fields.name]).trim(),
      color: textValue(record.fields?.[fields.color]).trim(),
      price: Number(textValue(record.fields?.[fields.price])) || null,
      productIds: linkedRecordIds(record.fields?.[fields.products]),
    };
  };

  const readMembers = async (productIds) => {
    if (!productIds.length) return [];
    const fields = productFields();
    const records = typeof gateway.getBatch === 'function'
      ? await gateway.getBatch('product', productIds)
      : [];
    const byId = new Map((records || []).map((record) => [record.record_id, record]));
    return productIds.map((recordId) => {
      const record = byId.get(recordId);
      const f = record?.fields || {};
      return {
        recordId,
        number: textValue(f[fields.number]).trim(),
        itemNo: textValue(f[fields.itemNo]).trim(),
        color: textValue(f[fields.color]).trim(),
        category: textValue(f[fields.category]).trim(),
        delisted: f[fields.delisted] === true,
        missing: !record,
      };
    });
  };

  const readStock = async (member) => {
    const fields = liveFields();
    const recordIdField = String(fields.recordId || '').trim();
    if (!recordIdField) throw new Error('「实时库存」缺少 recordID 字段映射');
    const filter = equalsFormula(recordIdField, member.recordId);
    if (!filter) return { rows: [], sizes: [], total: 0 };
    const rows = typeof gateway.listByFilter === 'function'
      ? await gateway.listByFilter('liveInventory', filter)
      : [];
    const sizeMap = new Map();
    for (const row of rows || []) {
      const f = row?.fields || {};
      const parsed = fields.stockKey ? parseStockKey(textValue(f[fields.stockKey])) : null;
      const size = textValue(f[fields.size]).trim() || String(parsed?.size || '').trim();
      if (!size) continue;
      const state = textValue(f[fields.state]).trim() || GROUP_SCAN_PAGE.texts.unknownState;
      const hit = sizeMap.get(size) || { size, states: {}, total: 0 };
      hit.states[state] = (hit.states[state] || 0) + 1;
      hit.total += 1;
      sizeMap.set(size, hit);
    }
    const sizes = [...sizeMap.values()].sort((a, b) => {
      const an = Number(a.size); const bn = Number(b.size);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a.size).localeCompare(String(b.size), 'zh-CN');
    });
    return { rows: rows || [], sizes, total: (rows || []).length };
  };

  const get = async (groupId) => {
    const group = await readGroup(groupId);
    if (!group) return null;
    const members = await readMembers(group.productIds);
    const withStock = await Promise.all(members.map(async (member) => ({
      ...member,
      ...(await readStock(member)),
    })));
    withStock.sort((a, b) => String(a.number || a.itemNo).localeCompare(String(b.number || b.itemNo), 'zh-CN'));
    return {
      ...group,
      members: withStock,
      total: withStock.reduce((sum, member) => sum + member.total, 0),
    };
  };

  return { get, readGroup, readMembers, readStock };
};

module.exports = { createProductGroupStockService };
