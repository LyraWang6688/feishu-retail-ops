'use strict';

/**
 * 配品配置（其他配品）的读写服务。
 *
 * 写入不是在这里直接做：HTTP 路由把 action 交给 PRODUCT_CONFIG_WRITE 异步任务，
 * 本文件只提供任务 worker 调用的纯业务函数。
 * 所有飞书写入仍走 gateway ⇒ feishuWriteScheduler。
 *
 * 2026-11-25：「赠品」的语义键由 isAccessory 改为 isGift，与物理列名对齐——
 *   所有记录都是配品，这个键实际表达的是「是否作为赠品候选」。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { person } = require('./v1ReferenceResolver');
const { textValue } = require('./v1BitableGateway');
const { getConfigRows, invalidateConfigTable } = require('./configTableCache');
const { ensureAccessoryCategory } = require('./accessoryCategoryService');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const fieldsOf = () => V1_BITABLE_SCHEMA.tables.accessory.fields;
const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const nameKey = (value) => normalizeName(value).toLocaleLowerCase('zh-CN');
const categoryOf = (value) => String(value || '').trim();
const numberOrNull = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number;
};

const categoryCellOf = (value) => (Array.isArray(value) ? value : []);
const categoryNameOf = (value) => {
  if (typeof value === 'string') return normalizeName(value);
  const first = categoryCellOf(value)[0];
  return normalizeName(first?.text || first?.name || textValue(first));
};
const categoryRecordIdOf = (value) => {
  const first = categoryCellOf(value)[0] || {};
  return String((Array.isArray(first.record_ids) ? first.record_ids[0] : '') || first.record_id || '').trim();
};

const mapAccessory = (record) => {
  const fields = fieldsOf();
  const row = record?.fields || {};
  const images = Array.isArray(row[fields.sampleImage]) ? row[fields.sampleImage] : [];
  return {
    recordId: String(record?.record_id || ''),
    name: normalizeName(row[fields.name]),
    category: categoryNameOf(row[fields.category]),
    categoryRecordId: categoryRecordIdOf(row[fields.category]),
    price: numberOrNull(row[fields.price]),
    cost: numberOrNull(row[fields.cost]),
    stockQuantity: numberOrNull(row[fields.stockQuantity]),
    isGift: row[fields.isGift] === true,
    hasSampleImage: images.some((item) => item?.file_token || item?.fileToken),
    sampleImageUrl: record?.record_id ? `/api/workbench/products/accessories/${encodeURIComponent(record.record_id)}/sample-image` : '',
  };
};

const listAccessories = async (gateway) => {
  const records = await getConfigRows({ gateway, tableKey: 'accessory' });
  return (Array.isArray(records) ? records : [])
    .map(mapAccessory)
    .filter((item) => item.recordId && item.name)
    .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
};

const findDuplicate = async (gateway, { name, category, exceptRecordId = '' } = {}) => {
  const records = await listAccessories(gateway);
  const key = nameKey(name);
  const cat = categoryOf(category);
  return records.find((item) => item.recordId !== exceptRecordId
    && item.category === cat
    && nameKey(item.name) === key) || null;
};

const normalizeInput = (input = {}) => {
  const name = normalizeName(input.name);
  const category = categoryOf(input.category);
  const price = numberOrNull(input.price);
  if (!name) throw userError('配品名称不能为空');
  if (price === null || price < 0) throw userError('单价必须是非负数字');
  const cost = input.cost === '' || input.cost === undefined ? null : numberOrNull(input.cost);
  if (input.cost !== '' && input.cost !== undefined && (cost === null || cost < 0)) throw userError('成本必须是非负数字');
  const stockQuantity = input.stockQuantity === '' || input.stockQuantity === undefined
    ? null : numberOrNull(input.stockQuantity);
  if (input.stockQuantity !== '' && input.stockQuantity !== undefined
    && (stockQuantity === null || stockQuantity < 0 || !Number.isInteger(stockQuantity))) {
    throw userError('库存数量必须是非负整数');
  }
  const hasGift = Object.prototype.hasOwnProperty.call(input, 'isGift');
  return { name, category, price, cost, stockQuantity, isGift: hasGift ? input.isGift === true : undefined };
};

const createAccessory = async (gateway, input = {}) => {
  const value = normalizeInput(input);
  const duplicate = await findDuplicate(gateway, value);
  if (duplicate) throw userError('同一种类下已经有同名配品');
  const category = value.category
    ? await ensureAccessoryCategory(gateway, value.category)
    : { category: '', recordId: '' };
  const patch = {
    // 写库只传网关语义键；物理列名只用于读结果。
    name: value.name,
    // 「种类」是关联字段：写 record_id 数组，不写中文名。
    category: category.recordId ? [category.recordId] : [],
    price: value.price,
    cost: value.cost,
    stockQuantity: value.stockQuantity,
    isGift: value.isGift === true,
  };
  if (input.sampleImageToken) patch.sampleImage = [{ file_token: String(input.sampleImageToken) }];
  if (input.operatorOpenId) patch.enteredBy = person(input.operatorOpenId);
  const created = await gateway.create('accessory', patch);
  invalidateConfigTable('accessory');
  invalidateConfigTable('giftAccessory');
  // 网关 create 返回 { recordId, record }；map 需要 record 本体。
  return mapAccessory(created?.record || created);
};

const updateAccessory = async (gateway, recordId, input = {}) => {
  const id = String(recordId || '').trim();
  if (!id) throw userError('缺少配品记录 ID');
  const existing = await gateway.get('accessory', id);
  if (!existing) throw userError('配品不存在，请刷新后重试');
  const value = normalizeInput(input);
  const duplicate = await findDuplicate(gateway, { ...value, exceptRecordId: id });
  if (duplicate) throw userError('同一种类下已经有同名配品');
  const category = value.category
    ? await ensureAccessoryCategory(gateway, value.category)
    : { category: '', recordId: '' };
  const patch = {
    // 写库只传网关语义键；物理列名只用于读结果。
    name: value.name,
    // 「种类」是关联字段：写 record_id 数组，不写中文名。
    category: category.recordId ? [category.recordId] : [],
    price: value.price,
    cost: value.cost,
    stockQuantity: value.stockQuantity,
  };
  if (value.isGift !== undefined) patch.isGift = value.isGift;
  if (input.sampleImageToken !== undefined) {
    patch.sampleImage = input.sampleImageToken
      ? [{ file_token: String(input.sampleImageToken) }] : [];
  }
  const updated = await gateway.update('accessory', id, patch);
  invalidateConfigTable('accessory');
  invalidateConfigTable('giftAccessory');
  return mapAccessory(updated);
};

const deleteAccessory = async (gateway, recordId) => {
  const id = String(recordId || '').trim();
  if (!id) throw userError('缺少配品记录 ID');
  await gateway.delete('accessory', id);
  invalidateConfigTable('accessory');
  invalidateConfigTable('giftAccessory');
  return { recordId: id };
};

module.exports = {
  listAccessories,
  createAccessory,
  updateAccessory,
  deleteAccessory,
  nameKey,
};
