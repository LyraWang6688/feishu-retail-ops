'use strict';

/**
 * 「其他配品.种类」是单选字段：新增种类必须先更新字段 options。
 * 本文件只做字段读写；记录写入仍在 accessoryConfigService。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');

const fieldsOf = () => V1_BITABLE_SCHEMA.tables.accessory.fields;
const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const nameKey = (value) => normalizeName(value).toLocaleLowerCase('zh-CN');
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const categoryFieldOf = async (gateway) => {
  if (typeof gateway.listFields !== 'function') throw new Error('网关不支持读取字段结构');
  const fields = await gateway.listFields('accessory', { refresh: true });
  const field = (fields || []).find((item) => item.field_name === fieldsOf().category);
  if (!field) throw new Error('“其他配品”找不到“种类”字段');
  if (Number(field.type) !== 3) throw new Error('“其他配品.种类”不是单选字段，无法追加选项');
  return { field, options: Array.isArray(field.property?.options) ? field.property.options : [] };
};

const categoryNamesOf = (options = []) => options
  .map((item) => normalizeName(item?.name))
  .filter(Boolean);

const listAccessoryCategories = async (gateway) => {
  const { options } = await categoryFieldOf(gateway);
  return categoryNamesOf(options);
};

const ensureAccessoryCategory = async (gateway, category) => {
  const name = normalizeName(category);
  if (!name) return { added: false, category: '' };
  const { field, options } = await categoryFieldOf(gateway);
  if (options.some((item) => nameKey(item?.name) === nameKey(name))) {
    return { added: false, category: name };
  }
  const nextOptions = [...options, { name }];
  await gateway.updateFieldDefinition('accessory', field.field_name, {
    field_name: field.field_name,
    type: field.type,
    property: { ...(field.property || {}), options: nextOptions },
  });
  return { added: true, category: name };
};

const addAccessoryCategory = async (gateway, category) => {
  const name = normalizeName(category);
  if (!name) throw userError('种类名称不能为空');
  if (name.length > 50) throw userError('种类名称不能超过 50 个字');
  const result = await ensureAccessoryCategory(gateway, name);
  return { category: name, added: result.added, categories: await listAccessoryCategories(gateway) };
};

module.exports = { listAccessoryCategories, ensureAccessoryCategory, addAccessoryCategory, nameKey };
