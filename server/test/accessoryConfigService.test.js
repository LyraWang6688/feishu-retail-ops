'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listAccessories, createAccessory, updateAccessory, deleteAccessory,
} = require('../src/services/accessoryConfigService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const fields = V1_BITABLE_SCHEMA.tables.accessory.fields;
const categoryFields = V1_BITABLE_SCHEMA.tables.accessoryCategory.fields;
const physical = (patch) => Object.fromEntries(Object.entries(patch).map(([key, value]) => [fields[key] || key, value]));
const categoryCell = (recordId, name) => [{ record_ids: [recordId], text: name, text_arr: [name], type: 'text' }];
const make = () => {
  const tables = [{
    record_id: 'a1',
    fields: { [fields.name]: '39元腰带', [fields.category]: categoryCell('c1', '腰带'), [fields.price]: 39, [fields.cost]: null, [fields.stockQuantity]: 4, [fields.isGift]: true },
  }, {
    record_id: 'a2',
    fields: { [fields.name]: '鞋油', [fields.category]: categoryCell('c2', '鞋油'), [fields.price]: 15, [fields.cost]: 8, [fields.stockQuantity]: 12, [fields.isGift]: true },
  }];
  const categories = [
    { record_id: 'c1', fields: { [categoryFields.name]: '腰带' } },
    { record_id: 'c2', fields: { [categoryFields.name]: '鞋油' } },
    { record_id: 'c3', fields: { [categoryFields.name]: '鞋垫' } },
  ];
  let seq = 0;
  const categoryNameOf = (id) => categories.find((row) => row.record_id === id)?.fields?.[categoryFields.name] || '';
  const withCategoryCell = (row, patch) => {
    const id = Array.isArray(patch.category) ? patch.category[0] : '';
    if (id) row.fields[fields.category] = categoryCell(id, categoryNameOf(id));
    return row;
  };
  const gateway = {
    async listAll(tableKey) { return tableKey === 'accessoryCategory' ? categories : tables; },
    async get(_table, id) { return tables.find((row) => row.record_id === id) || null; },
    async create(tableKey, patch) {
      seq += 1;
      if (tableKey === 'accessoryCategory') {
        const row = { record_id: 'c_new_' + seq, fields: { [categoryFields.name]: patch.name } };
        categories.push(row);
        return { recordId: row.record_id, record: row };
      }
      const row = withCategoryCell({ record_id: 'a_new_' + seq, fields: physical(patch) }, patch);
      tables.push(row);
      return { recordId: row.record_id, record: row };
    },
    async update(_table, id, patch) {
      const row = tables.find((item) => item.record_id === id);
      Object.assign(row.fields, physical(patch));
      return withCategoryCell(row, patch);
    },
    async delete(_table, id) {
      const index = tables.findIndex((row) => row.record_id === id);
      if (index >= 0) tables.splice(index, 1);
    },
  };
  return { gateway, tables, categories };
};

test('配品列表按种类分组数据可读（种类来自关联表）', async () => {
  const { gateway } = make();
  const rows = await listAccessories(gateway);
  assert.equal(rows.length, 2);
  const belt = rows.find((row) => row.name === '39元腰带');
  assert.equal(belt.stockQuantity, 4);
  assert.equal(belt.category, '腰带');
  assert.equal(belt.categoryRecordId, 'c1');
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
  assert.equal(created.categoryRecordId, 'c3', '种类写成关联 record_id');
  assert.equal(created.isGift, false, '新建默认不勾选赠品');
  const gift = await createAccessory(gateway, { name: '赠品鞋垫', category: '鞋垫', price: 1, isGift: true });
  assert.equal(gift.isGift, true);
});

test('新增配品写「录入员」= 当前操作人', async () => {
  const { gateway, tables } = make();
  await createAccessory(gateway, { name: '新腰带', category: '腰带', price: 20, operatorOpenId: 'ou_1' });
  assert.deepEqual(tables.at(-1).fields[fields.enteredBy], [{ id: 'ou_1' }]);
});

test('新增种类：写入「其他配品种类」表，不再改字段 options', async () => {
  const { gateway, categories } = make();
  const created = await createAccessory(gateway, { name: '新配品', category: '新种类', price: 10 });
  assert.equal(created.category, '新种类');
  assert.ok(categories.some((row) => row.fields[categoryFields.name] === '新种类'), '种类记录落表');
  assert.equal(typeof gateway.updateFieldDefinition, 'undefined', '不再写字段 options');
});

test('新增种类服务：重复不重复建记录', async () => {
  const { addAccessoryCategory, listAccessoryCategories } = require('../src/services/accessoryCategoryService');
  const { gateway, categories } = make();
  const before = categories.length;
  const first = await addAccessoryCategory(gateway, '新种类');
  assert.equal(first.added, true);
  const second = await addAccessoryCategory(gateway, '新种类');
  assert.equal(second.added, false);
  assert.equal(categories.length, before + 1, '只落一条记录');
  assert.deepEqual(await listAccessoryCategories(gateway), ['腰带', '鞋油', '鞋垫', '新种类']);
});

test('编辑排除当前记录；删除走 gateway', async () => {
  const { gateway } = make();
  const updated = await updateAccessory(gateway, 'a1', { name: '39元腰带', category: '腰带', price: 42, stockQuantity: 7 });
  assert.equal(updated.price, 42);
  assert.equal(updated.stockQuantity, 7);
  assert.equal(updated.category, '腰带');
  assert.equal(updated.isGift, true, '没传赠品时不覆盖原值');
  const unchecked = await updateAccessory(gateway, 'a1', { name: '39元腰带', category: '腰带', price: 42, stockQuantity: 7, isGift: false });
  assert.equal(unchecked.isGift, false);
  await deleteAccessory(gateway, 'a1');
  const rows = await listAccessories(gateway);
  assert.equal(rows.some((row) => row.recordId === 'a1'), false);
});
