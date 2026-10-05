const test = require('node:test');
const assert = require('node:assert/strict');
const { ProductCreationService } = require('../src/services/productCreationService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 记录链接要用 Base token 拼（和到货链路同一个拼法），本地/CI 没有真配置时给个测试值。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

// 最小 gateway：只实现 productCreationService 真正用到的那几个方法。
// 语义字段名 → 飞书列名的映射照 V1_BITABLE_SCHEMA 走，和真实 gateway 一致。
const makeGateway = (records = {}) => {
  const store = new Map(Object.entries(records).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
  let seq = 0;
  const list = (key) => store.get(key) || [];
  return {
    records: store,
    table,
    listAll: async (key) => list(key),
    get: async (key, recordId) => list(key).find((row) => row.record_id === recordId) || null,
    create: async (key, semanticValues) => {
      const schema = table(key);
      const fields = {};
      for (const [name, value] of Object.entries(semanticValues || {})) {
        if (value === undefined) continue;
        const fieldName = schema?.fields?.[name];
        if (!fieldName) throw new Error(`未配置语义字段: ${key}.${name}`);
        fields[fieldName] = value;
      }
      const recordId = `${key}_${++seq}`;
      list(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, recordId, semanticValues) => {
      const schema = table(key);
      const record = list(key).find((row) => row.record_id === recordId);
      for (const [name, value] of Object.entries(semanticValues || {})) {
        record.fields[schema.fields[name]] = value;
      }
      return record;
    },
  };
};

// 「进度存在哪里」在真实链路里是任务存储；这里用一块内存就够——
// 这本身就是本 service 的契约：它不认识任务、也不认识图片。
const makeJournal = ({ items, costItems = [], progress = null, scope = 'scope_1', writeBack = null } = {}) => {
  const state = progress || { products: [], colors: [], costWritten: [] };
  const journal = {
    scope,
    reads: [],
    saves: [],
    read: async () => {
      journal.reads.push(JSON.parse(JSON.stringify(state)));
      return { items, costItems, progress: state };
    },
    save: async (next) => {
      journal.saves.push(JSON.parse(JSON.stringify(next)));
      state.products = next.products;
      state.colors = next.colors;
      state.costWritten = next.costWritten;
    },
  };
  if (writeBack) {
    journal.writeBack = async (creation) => {
      journal.writtenBack = creation;
      await writeBack(creation);
    };
  }
  return journal;
};

const referencesFor = (suppliers = {}) => ({
  resolveSupplier: async (name) => {
    if (!Object.hasOwn(suppliers, name)) throw new Error(`供应商未找到：${name}`);
    return { recordId: suppliers[name] };
  },
});

const makeService = (gateway, references) => new ProductCreationService({ gateway, references });

test('结构化明细就能建档：不依赖任务、不依赖识别结果', async () => {
  const gateway = makeGateway({ product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }] });
  const service = makeService(gateway, referencesFor({ 供应商A: 'sup_A' }));
  const created = [];
  const journal = makeJournal({
    items: [{ itemNo: '1366-31', color: '棕色', gender: '女鞋', supplier: '供应商A', cost: 199 }],
    writeBack: async (creation) => { created.push(creation); },
  });

  const result = await service.ensureProducts({ journal, reason: 'unit' });

  assert.equal(result.state, 'done');
  assert.equal(result.created, 1);
  assert.equal(result.cost_written_count, 1);
  assert.deepEqual(result.failures, []);
  const product = gateway.records.get('product')[0];
  assert.equal(product.fields['货号'], '1366-31');
  assert.deepEqual(product.fields['颜色'], ['color_brown'], '颜色要关联到颜色管理记录');
  assert.deepEqual(product.fields['供应商'], ['sup_A']);
  assert.equal(product.fields['类别'], 'B', '女鞋 → B（认不出就留空，不猜）');
  assert.equal(product.fields['成本'], 199, '可信成本在建档时一起写');
  // 「编号」「缺失信息说明」是飞书公式字段：建档绝不能写它们。
  assert.equal('编号' in product.fields, false);
  assert.equal('缺失信息说明' in product.fields, false);
  // 链接回填：她点确认后的结果卡片要用。
  assert.equal(created.length, 1);
  assert.match(created[0].createdProducts[0].url, /record=product_1/);
});

test('幂等：同一个「货号+颜色」重跑只建一条（靠落盘进度恢复，不是靠再查一遍）', async () => {
  const gateway = makeGateway({ product: [], color: [] });
  const service = makeService(gateway, referencesFor({}));
  const items = [{ itemNo: '1366-31', color: '棕色' }, { itemNo: '1366-31', color: '棕色' }];
  const journal = makeJournal({ items });

  const first = await service.ensureProducts({ journal });
  assert.equal(first.created, 1);
  assert.equal(gateway.records.get('product').length, 1, '同一个货号+颜色两个尺码只建一条');
  assert.equal(gateway.records.get('color').length, 1, '同名颜色只建一条');

  const savesAfterFirst = journal.saves.length;
  const second = await service.ensureProducts({ journal });
  assert.equal(second.created, 1);
  assert.equal(second.state, 'done');
  assert.equal(gateway.records.get('product').length, 1, '重跑不得建出第二条');
  assert.equal(journal.saves.length, savesAfterFirst, '命中缓存的重跑不再重新落盘');
});

test('建档失败：单条失败不抛、其余继续建；重试只补失败的那条', async () => {
  const gateway = makeGateway({ product: [], color: [] });
  let createCalls = 0;
  const innerCreate = gateway.create;
  gateway.create = async (key, values) => {
    if (key === 'product') {
      createCalls += 1;
      if (createCalls === 2) throw new Error('模拟第二条建档失败');
    }
    return innerCreate(key, values);
  };
  const service = makeService(gateway, referencesFor({}));
  const items = [{ itemNo: '3602', color: '黑色' }, { itemNo: '3603', color: '黑色' }];
  const journal = makeJournal({ items });

  const first = await service.ensureProducts({ journal });
  assert.equal(first.state, 'failed');
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].item_no, '3603');
  assert.match(first.failures[0].error, /模拟第二条建档失败/);
  assert.equal(gateway.records.get('product').length, 1, '第一条已经建好了');

  const retry = await service.ensureProducts({ journal });
  assert.equal(retry.state, 'done', '重试补齐剩下那条');
  assert.equal(gateway.records.get('product').length, 2);
  assert.equal(createCalls, 3, '第一次 2 次（1 成功 1 失败）+ 重试 1 次');
});

test('成本规则：只在成本为空时写；已有成本不覆盖，且重试不重复写', async () => {
  const gateway = makeGateway({
    product: [
      { record_id: 'prod_blank', fields: { 货号: '1366-31' } },
      { record_id: 'prod_keep', fields: { 货号: '1366-32', 成本: 100 } },
    ],
  });
  const service = makeService(gateway, referencesFor({}));
  const costItems = [
    { itemNo: '1366-31', color: '棕色', productRecordId: 'prod_blank', cost: 199 },
    { itemNo: '1366-32', color: '棕色', productRecordId: 'prod_keep', cost: 199 },
  ];
  const journal = makeJournal({ items: [], costItems });

  const result = await service.ensureProducts({ journal });

  assert.equal(result.cost_written_count, 1);
  assert.equal(gateway.records.get('product')[0].fields['成本'], 199, '空成本要写');
  assert.equal(gateway.records.get('product')[1].fields['成本'], 100, '已有成本一律不覆盖');
  // 已有成本的货品也记账：重试直接跳过，不会再判一次、也不会再 warn 一次。
  assert.equal(journal.saves.length, 1);
  await service.ensureProducts({ journal });
  assert.equal(gateway.records.get('product')[0].fields['成本'], 199);
  assert.equal(gateway.records.get('product')[1].fields['成本'], 100);
});

test('成本规则：cost 为 null（没有可信价格 / 同货号价格冲突）时一个值都不写', async () => {
  const gateway = makeGateway({ product: [{ record_id: 'prod_conflict', fields: { 货号: '1366-31' } }] });
  const service = makeService(gateway, referencesFor({}));
  const journal = makeJournal({
    items: [],
    costItems: [{ itemNo: '1366-31', color: '棕色', productRecordId: 'prod_conflict', cost: null }],
  });

  const result = await service.ensureProducts({ journal });

  assert.equal(result.cost_written_count, 0);
  assert.equal('成本' in gateway.records.get('product')[0].fields, false);
});

test('颜色是共享主数据：normalizeColor 去重（「棕色」/「棕」只建一条）', async () => {
  const gateway = makeGateway({ product: [], color: [{ record_id: 'color_brown', fields: { 颜色: '棕色' } }] });
  const service = makeService(gateway, referencesFor({}));
  const journal = makeJournal({
    items: [{ itemNo: '1366-31', color: '棕色' }, { itemNo: '1366-32', color: '棕' }],
  });

  await service.ensureProducts({ journal });

  assert.equal(gateway.records.get('color').length, 1, '去空白/去末尾「色」之后同名，只保留一条');
  assert.deepEqual(gateway.records.get('product').map((row) => row.fields['颜色']), [['color_brown'], ['color_brown']]);
});

test('供应商找不到：只记 warn、不新建、不猜，建档照常（不因为供应商挡住建档）', async () => {
  const gateway = makeGateway({ product: [], color: [] });
  const service = makeService(gateway, referencesFor({}));
  const journal = makeJournal({ items: [{ itemNo: '1366-31', color: '棕色', supplier: '陌生供应商' }] });
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (line) => { try { warns.push(JSON.parse(line)); } catch { warns.push({ event: 'unparsed' }); } };

  let result;
  try {
    result = await service.ensureProducts({ journal });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.state, 'done');
  assert.equal('供应商' in gateway.records.get('product')[0].fields, false, '找不到就留空，不新建供应商');
  assert.ok(warns.some((line) => line.event === 'purchase.arrival.supplier_not_found'));
});

test('收尾 writeBack 在锁内拿到建档结果（到货链路用它并回草稿）', async () => {
  const gateway = makeGateway({ product: [], color: [] });
  const service = makeService(gateway, referencesFor({}));
  const seen = [];
  const journal = makeJournal({
    items: [{ itemNo: '1366-31', color: '棕色' }],
    writeBack: async (creation) => { seen.push(creation); },
  });

  await service.ensureProducts({ journal });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'done');
  assert.deepEqual(seen[0].createdProducts.map((row) => row.item_no), ['1366-31']);
  assert.deepEqual(seen[0].createdColors.map((row) => row.name), ['棕色'], '这次新建了一个颜色，结果里要带上');
});
