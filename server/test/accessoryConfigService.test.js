'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listAccessories, createAccessory, updateAccessory, deleteAccessory,
} = require('../src/services/accessoryConfigService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const fields = V1_BITABLE_SCHEMA.tables.accessory.fields;
const physical = (patch) => Object.fromEntries(Object.entries(patch).map(([key, value]) => [fields[key] || key, value]));
const make = () => {
  const tables = [{
    record_id: 'a1',
    fields: { [fields.name]: '39元腰带', [fields.category]: '腰带', [fields.price]: 39, [fields.cost]: null, [fields.stockQuantity]: 4, [fields.isAccessory]: true },
  }, {
    record_id: 'a2',
    fields: { [fields.name]: '鞋油', [fields.category]: '鞋油', [fields.price]: 15, [fields.cost]: 8, [fields.stockQuantity]: 12, [fields.isAccessory]: true },
  }];
  let seq = 0;
  let categoryOptions = ['腰带', '鞋油', '鞋垫'].map((name) => ({ name, color: 1 }));
  const gateway = {
    async listAll() { return tables; },
    async listFields() {
      return [{ field_id: 'fld_category', field_name: fields.category, type: 3, property: { options: categoryOptions } }];
    },
    async updateFieldDefinition(_table, _field, definition) {
      categoryOptions = definition.property.options;
      return definition;
    },
    async get(_table, id) { return tables.find((row) => row.record_id === id) || null; },
    async create(_table, patch) { seq += 1; const row = { record_id: `a_new_${seq}`, fields: physical(patch) }; tables.push(row); return row; },
    async update(_table, id, patch) { const row = tables.find((item) => item.record_id === id); Object.assign(row.fields, physical(patch)); return row; },
    async delete(_table, id) { const index = tables.findIndex((row) => row.record_id === id); if (index >= 0) tables.splice(index, 1); },
  };
  return { gateway, tables };
};

test('配品列表按种类分组数据可读', async () => {
  const { gateway } = make();
  const rows = await listAccessories(gateway);
  assert.equal(rows.length, 2);
  const belt = rows.find((row) => row.name === '39元腰带');
  assert.equal(belt.stockQuantity, 4);
});

test('同一种类重名拒绝；不同种类允许同名', async () => {
  const { gateway } = make();
  await assert.rejects(
    () => createAccessory(gateway, { name: '39元腰带', category: '腰带', price: 49 }),
    /同一种类下已经有同名配品/,
  );
  const created = await createAccessory(gateway, { name: '39元腰带', category: '鞋垫', price: 49 });
  assert.ok(created.recordId, 'create 返回真实 recordId，不能是空结果');
  assert.equal(created.category, '鞋垫');
  assert.equal(created.isAccessory, false, '新建默认不勾选赠品');
  const gift = await createAccessory(gateway, { name: '赠品鞋垫', category: '鞋垫', price: 1, isAccessory: true });
  assert.equal(gift.isAccessory, true);
});

test('新增种类：追加到飞书单选字段 options，保留已有选项', async () => {
  const { gateway } = make();
  const created = await createAccessory(gateway, { name: '新配品', category: '新种类', price: 10 });
  assert.equal(created.category, '新种类');
  const fields = await gateway.listFields();
  const names = fields[0].property.options.map((item) => item.name);
  assert.ok(names.includes('新种类'));
  assert.ok(names.includes('腰带'));
  assert.ok(names.includes('鞋油'));
});

test('新增种类服务：重复不重复追加', async () => {
  const { addAccessoryCategory, listAccessoryCategories } = require('../src/services/accessoryCategoryService');
  const { gateway } = make();
  const first = await addAccessoryCategory(gateway, '新种类');
  assert.equal(first.added, true);
  const second = await addAccessoryCategory(gateway, '新种类');
  assert.equal(second.added, false);
  assert.deepEqual(await listAccessoryCategories(gateway), ['腰带', '鞋油', '鞋垫', '新种类']);
});

test('编辑排除当前记录；删除走 gateway', async () => {
  const { gateway } = make();
  const updated = await updateAccessory(gateway, 'a1', { name: '39元腰带', category: '腰带', price: 42, stockQuantity: 7 });
  assert.equal(updated.price, 42);
  assert.equal(updated.stockQuantity, 7);
  assert.equal(updated.isAccessory, true, '没传赠品时不覆盖原值');
  const unchecked = await updateAccessory(gateway, 'a1', { name: '39元腰带', category: '腰带', price: 42, stockQuantity: 7, isAccessory: false });
  assert.equal(unchecked.isAccessory, false);
  await deleteAccessory(gateway, 'a1');
  const rows = await listAccessories(gateway);
  assert.equal(rows.some((row) => row.recordId === 'a1'), false);
});
