const test = require('node:test');
const assert = require('node:assert/strict');
const { validateV1SchemaScope } = require('../scripts/validate_v1_schema');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  V1_SCHEMA_SCOPES, getV1SchemaScope, getV1IdempotencyKeyTables, getV1SelectOptionContracts,
} = require('../src/config/v1SchemaScopes');

// ⚠️ 2026-10-07 深夜：「采购入库」表已被业务负责人整表删除 ⇒ 它的尺码关联不用再核
//    （见 server/test/purchaseInboundRemoval.test.js 的守门用例）。
const sizeLinkedTables = ['salesDetail', 'purchaseRequest', 'inventoryLedger', 'liveInventory'];
// 幂等键是文本字段：写的是 "purchase_request:<taskId>:<n>" 这类稳定键。
// ⚠️ 2026-10-08：「客户往来货款.业务事件ID」（售后 prepaid 的幂等键）随那张表**整表被删**一起下线，
//    sales 这一档因此**暂时没有幂等键要核**（见下面的哨兵用例）。
const idempotencyKeyFields = {
  purchaseOrderBatch: '幂等键', purchaseRequest: '幂等键', liveInventory: '库存操作键',
};
// 每张表的键字段语义名不同：采购用 idempotencyKey，实时库存用 operationItemKey。
const keyFieldOf = (tableKey) => {
  if (tableKey === 'liveInventory') return 'operationItemKey';
  return 'idempotencyKey';
};
const gatewayFor = (overrides = {}) => {
  const seen = [];
  const fields = Object.fromEntries(sizeLinkedTables.map((key) => [key, [
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } },
  ]]));
  for (const [key, fieldName] of Object.entries(idempotencyKeyFields)) {
    fields[key] = [...(fields[key] || []), { field_name: fieldName, type: 1 }];
  }
  fields.sizeManagement = [{ field_name: '尺码', type: 2 }];
  for (const [key, value] of Object.entries(overrides)) fields[key] = value;
  return {
    seen,
    table: (key) => key === 'sizeManagement'
      ? { tableName: '尺码管理', tableId: 'size_table', fields: { size: '尺码' } }
      : { tableName: key, fields: { size: '尺码', name: '行为名称',
        code: '行为编码', stockDirection: '库存方向', enabled: '是否启用',
        [keyFieldOf(key)]: idempotencyKeyFields[key] || '幂等键' } },
    validateTables: async (keys) => { seen.push(...keys); return keys.map((tableKey) => ({ tableKey })); },
    listFields: async (key) => fields[key] || [],
    listAll: async (key) => key === 'behavior' ? [
      { record_id: 'sale', fields: { 行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
      { record_id: 'purchase', fields: { 行为编码: 'STOCK_PURCHASE_INCREASE', 行为名称: '采购增加', 库存方向: '增加', 是否启用: true } },
      // 售后三条（与 inventoryService.STOCK_MOVEMENTS 的方向一致）：validateStockBehaviors 会全表核对。
      { record_id: 'return', fields: { 行为编码: 'SALE_RETURN', 行为名称: '销售退货', 库存方向: '增加', 是否启用: true } },
      { record_id: 'compensation', fields: { 行为编码: 'SALE_COMPENSATION', 行为名称: '销售赔货', 库存方向: '减少', 是否启用: true } },
      { record_id: 'cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货销售', 库存方向: '减少', 是否启用: true } },
      // 采购退货（采购减少）：同上，注册表里每多一条声明，这个假 Base 就要有对应行为。
      { record_id: 'purchase_decrease', fields: { 行为编码: 'STOCK_PURCHASE_DECREASE', 行为名称: '采购减少', 库存方向: '减少', 是否启用: true } },
      // 人工库存行为 6 条（2026-10-06 注册）：同上，注册表里每多一条声明，假 Base 就要有对应行为。
      { record_id: 'manual_increase', fields: { 行为编码: 'STOCK_MANUAL_INCREASE', 行为名称: '手工调增', 库存方向: '增加', 是否启用: true } },
      { record_id: 'manual_decrease', fields: { 行为编码: 'STOCK_MANUAL_DECREASE', 行为名称: '手工调减', 库存方向: '减少', 是否启用: true } },
      { record_id: 'freeze', fields: { 行为编码: 'STOCK_FREEZE', 行为名称: '转冻结', 库存方向: '不影响', 是否启用: true } },
      { record_id: 'release_to_doorbox', fields: { 行为编码: 'STOCK_RELEASE_TO_DOOR_BOX', 行为名称: '转释放门盒', 库存方向: '不影响', 是否启用: true } },
      { record_id: 'sample_to_doorbox', fields: { 行为编码: 'STOCK_SAMPLE_TO_DOORBOX', 行为名称: '样品转门盒', 库存方向: '不影响', 是否启用: true } },
      { record_id: 'doorbox_to_sample', fields: { 行为编码: 'STOCK_DOORBOX_TO_SAMPLE', 行为名称: '门盒转样品', 库存方向: '不影响', 是否启用: true } },
    ] : [],
  };
};

test('inventory and all CLI scopes check the size-management link contract', async () => {
  for (const scope of ['inventory', 'all']) {
    const gateway = gatewayFor();
    const result = await validateV1SchemaScope({ gateway, scope });
    assert.equal(result.scope, scope);
    assert.ok(gateway.seen.includes('sizeManagement'));
  }
});

test('inventory and all CLI scopes reject numeric, multi-link and wrong-target size fields', async () => {
  const invalidFields = [
    { field_name: '尺码', type: 2 },
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: true } },
    { field_name: '尺码', type: 18, property: { table_id: 'other_table', multiple: false } },
  ];
  for (const scope of ['inventory', 'all']) {
    for (const invalid of invalidFields) {
      const gateway = gatewayFor({ inventoryLedger: [invalid] });
      await assert.rejects(validateV1SchemaScope({ gateway, scope }), /单选关联“尺码管理”/);
    }
  }
});

test('all CLI scope also checks the purchase-request size relation', async () => {
  const gateway = gatewayFor({ purchaseRequest: [{ field_name: '尺码', type: 2 }] });
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'all' }), /单选关联“尺码管理”/);
});

test('all checks size links even when an unrelated table has a missing field', async () => {
  const gateway = gatewayFor({ liveInventory: [{ field_name: '尺码', type: 2 }] });
  gateway.validateTables = async () => { throw new Error('其他表缺少字段'); };
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'all' }), /单选关联“尺码管理”/);
});

test('inventory CLI scope rejects a non-numeric size-management source', async () => {
  const gateway = gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] });
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'inventory' }), /必须是数字字段/);
});

// 销售和采购范围同样落在真实录入链路上：跑各自的 schema-check 时，
// 尺码字段是数字、多选或指错表都必须直接失败，而不是报成功。
test('sales CLI scope validates the sales-detail size relation', async () => {
  const invalidFields = [
    { field_name: '尺码', type: 2 },
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: true } },
    { field_name: '尺码', type: 18, property: { table_id: 'other_table', multiple: false } },
  ];
  for (const invalid of invalidFields) {
    await assert.rejects(validateV1SchemaScope({ gateway: gatewayFor({ salesDetail: [invalid] }), scope: 'sales' }),
      /单选关联“尺码管理”/);
  }
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] }), scope: 'sales' }),
    /必须是数字字段/,
  );
});

// 哨兵（2026-10-08）：业务负责人把「客户往来货款」**整表删除** ⇒ 契约与各范围里都不许再有它。
// 为什么要有这条：闸门只会说"某张表读不到"，而"她删了表 → 契约要跟着删"这件事必须**有人守着**；
// 将来要接回「已留存」的新落点，应该是有意识地加**新表**，而不是顺手把这段 revert 回来
//（revert 回来会让闸门立刻变红：TableIdNotFound 1254041）。
test('哨兵：「客户往来货款」已随表删除，契约与 sales 范围里都不该再有它', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables.customerCredit, undefined);
  assert.equal(V1_SCHEMA_SCOPES.sales.includes('customerCredit'), false);
  assert.equal(V1_SCHEMA_SCOPES.all.includes('customerCredit'), false);
  assert.deepEqual(getV1IdempotencyKeyTables('sales'), []);
  assert.equal(getV1SchemaScope('sales').tables.includes('customerCredit'), false);
});

test('purchase CLI scope validates the purchase-request size relation', async () => {
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ purchaseRequest: [{ field_name: '尺码', type: 2 }] }), scope: 'purchase' }),
    /单选关联“尺码管理”/,
  );
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] }), scope: 'purchase' }),
    /必须是数字字段/,
  );
});

// 幂等依赖的字段必须真实存在且是文本：列名对了但类型是数字/单选，
// 幂等键会写成空值，重试照旧会重复创建采购事实。
test('幂等键字段缺失时 schema-check 直接失败，而不是等到确认采购才报错', async () => {
  const cases = {
    purchaseOrderBatch: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
    purchaseRequest: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
    liveInventory: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
  };
  for (const [tableKey, fields] of Object.entries(cases)) {
    const scope = tableKey === 'liveInventory' ? 'inventory' : 'purchase';
    await assert.rejects(validateV1SchemaScope({ gateway: gatewayFor({ [tableKey]: fields }), scope }),
      /缺少「(幂等键|库存操作键)」字段/);
  }
});

test('幂等键字段类型不是文本时 schema-check 直接失败', async () => {
  const asNumber = (fieldName) => [
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } },
    { field_name: fieldName, type: 2 },
  ];
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ purchaseRequest: asNumber('幂等键') }), scope: 'purchase' }),
    /「幂等键」必须是文本字段/,
  );
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ liveInventory: asNumber('库存操作键') }), scope: 'inventory' }),
    /「库存操作键」必须是文本字段/,
  );
});

// ⭐ 单选取值契约（2026-10-07 起）：「报货批次」的**到货状态**是单选，代码要往里写固定取值
//    ⇒ 真表必须**已经存在**那些选项。写一个不存在的取值，飞书会**自动新建选项**（表被污染），
//    而按该取值查询会静默查不到（AGENTS.md 第 11 条① 的事故形态）。
//    ⛔ 2026-10-09：原先还有第二条（「确认状态」）—— 那一列在真表上**已经被删掉**，
//       契约与 `config/purchaseAcceptance.js` 一起退场。下面只留「到货状态」那条，
//       并补一条守门：**契约里不许再有 confirmStatus**（留着 = 闸门去问一列不存在的字段、直接判红）。
test('单选取值契约：到货状态不是单选 / 缺「未到货」选项 → schema-check 直接失败；确认状态已退场', async () => {
  // 契约按**语义键**找列（`arrivalStatus` → 「到货状态」）。假 gateway 的 `table()` 默认只给
  // 幂等键/行为那几个键，这里把「到货状态」这个语义键补上（其余契约列不暴露 ⇒ 自动跳过）。
  const selectGateway = (field) => {
    const gateway = gatewayFor({ purchaseOrderBatch: [{ field_name: '幂等键', type: 1 }, field] });
    const base = gateway.table;
    gateway.table = (key) => {
      const table = base(key);
      if (key !== 'purchaseOrderBatch') return table;
      return { ...table, fields: { ...table.fields, arrivalStatus: '到货状态' } };
    };
    return gateway;
  };
  // ① 不是单选。
  await assert.rejects(
    validateV1SchemaScope({ gateway: selectGateway({ field_name: '到货状态', type: 1 }), scope: 'purchase' }),
    /「到货状态」必须是单选字段/,
  );
  // ② 是单选，但选项里没有「未到货」⇒ 必须判红（绝不放行、也绝不替她建选项）。
  await assert.rejects(
    validateV1SchemaScope({
      gateway: selectGateway({
        field_name: '到货状态', type: 3, property: { options: [{ name: '已到货' }] },
      }),
      scope: 'purchase',
    }),
    /「到货状态」缺少选项: 未到货/,
  );
  // ③ 选项齐了才放行。
  await validateV1SchemaScope({
    gateway: selectGateway({
      field_name: '到货状态', type: 3,
      property: { options: [{ name: '未到货' }, { name: '已到货' }] },
    }),
    scope: 'purchase',
  });
  // ④ 守门：「确认状态」那一列与它的契约都不许回来。
  const contracts = getV1SelectOptionContracts('purchase');
  assert.equal(contracts.some((item) => item.fieldKey === 'confirmStatus'), false,
    '确认状态那一列已从真表删除 ⇒ 契约里不许再有它');
});
