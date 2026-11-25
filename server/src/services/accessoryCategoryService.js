'use strict';

/**
 * 「其他配品种类」字典表（2026-11-25 起）。
 *
 * 生产已把「其他配品明细.种类」从单选字段改成关联字段（SingleLink），
 * 指向本表 ⇒ 种类不再写字段 options；「管理种类」直接读写这张表。
 * 读走统一 configTableCache（record_changed 会失效），写仍走 gateway。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { getConfigRows, invalidateConfigTable } = require('./configTableCache');
const { textValue } = require('./v1BitableGateway');

const fieldsOf = () => V1_BITABLE_SCHEMA.tables.accessoryCategory.fields;
const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const nameKey = (value) => normalizeName(value).toLocaleLowerCase('zh-CN');
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const categoryRows = async (gateway) => {
  const rows = await getConfigRows({ gateway, tableKey: 'accessoryCategory' });
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      recordId: String(row?.record_id || ''),
      name: normalizeName(textValue(row?.fields?.[fieldsOf().name])),
    }))
    .filter((item) => item.recordId && item.name);
};

const listAccessoryCategories = async (gateway) => (await categoryRows(gateway)).map((item) => item.name);

const ensureAccessoryCategory = async (gateway, category) => {
  const name = normalizeName(category);
  if (!name) return { added: false, category: '', recordId: '' };
  const existing = (await categoryRows(gateway)).find((item) => nameKey(item.name) === nameKey(name));
  if (existing) return { added: false, category: existing.name, recordId: existing.recordId };
  const created = await gateway.create('accessoryCategory', { name });
  invalidateConfigTable('accessoryCategory');
  const recordId = String(created?.recordId || created?.record?.record_id || '').trim();
  if (!recordId) throw new Error('新增「其他配品种类」后拿不到 record_id');
  return { added: true, category: name, recordId };
};

const addAccessoryCategory = async (gateway, category) => {
  const name = normalizeName(category);
  if (!name) throw userError('种类名称不能为空');
  if (name.length > 50) throw userError('种类名称不能超过 50 个字');
  const result = await ensureAccessoryCategory(gateway, name);
  return { category: name, added: result.added, categories: await listAccessoryCategories(gateway) };
};

module.exports = { listAccessoryCategories, ensureAccessoryCategory, addAccessoryCategory, nameKey };
