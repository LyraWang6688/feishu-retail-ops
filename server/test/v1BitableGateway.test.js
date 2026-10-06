const test = require('node:test');
const assert = require('node:assert/strict');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const schema = {
  appToken: 'app_v1',
  tables: {
    sample: {
      tableName: '测试表',
      tableId: 'tbl_sample',
      fields: { name: '名称', quantity: '数量' },
    },
  },
};

test('V1 gateway maps semantic keys to current Chinese field names', () => {
  const gateway = new V1BitableGateway({ schema, client: {} });
  assert.deepEqual(gateway.fields('sample', { name: 'A', quantity: 2 }), { 名称: 'A', 数量: 2 });
  assert.throws(() => gateway.fields('sample', { missing: 'x' }), /未配置语义字段/);
});

test('V1 gateway schema validation reports renamed or missing fields', async () => {
  const client = {
    bitable: {
      appTableField: {
        list: async () => ({ code: 0, data: { items: [{ field_name: '名称' }], has_more: false } }),
      },
    },
  };
  const gateway = new V1BitableGateway({ schema, client });
  await assert.rejects(() => gateway.validateTable('sample'), /缺少 V1 字段: 数量/);
});

test('sales schema matches the live three-table field snapshot', () => {
  // ⚠️ 快照 = 生产「销售主表」在 2026-10-06（业务负责人新建四个状态维度、并**删掉
  // 「确认状态（旧）」与「订单状态」两列之后**）的字段名。映射指到快照里没有的名字 = 静默失效；
  // 而映射**指回已删除的旧列** = 生产上闸门当场报「缺少 V1 字段」。
  const fields = {
    // ⚠️ 2026-10-06 晚她又在生产「销售主表」加了**「消息链接」**一列
    //（她的原话：「我在多维表格的销售主表里加了一列叫做**消息链接**，可以写入这里～」）
    // —— 快照随手同步（`salesEntry.messageLink` 指的就是它，发销售卡片时写深链）。
    salesEntry: ['收款状态', '录单日', '确认状态', '销售单号', '解析状态', '失败原因',
      '销售状态', '资金状态', '库存状态',
      '录单人', '解析结果摘要', '原话', '待交付数量', '交付数量', '交易类型', '消息链接'],
    salesDetail: ['销售单价', '履约状态', '销售明细ID', '销售单号', '销售日', '赠品', '尺码', '成交金额', '编号', '配品', '交易类型'],
    // 「支付方式」已被产品负责人改名为「交易方式」，并新增了「交易方向」。
    paymentRecord: ['交易方式', '关联销售单', '收款金额', '收款时间', '收款状态', '交易方向'],
  };
  for (const [tableKey, actual] of Object.entries(fields)) {
    for (const name of Object.values(V1_BITABLE_SCHEMA.tables[tableKey].fields)) {
      assert.ok(actual.includes(name), `${tableKey} still maps deleted field ${name}`);
    }
  }
  assert.equal(V1_BITABLE_SCHEMA.tables.paymentRecord.tableName, '收款明细');
});

test('relation and display helpers support Feishu record field shapes', () => {
  assert.deepEqual(linkedRecordIds(['rec_1', { record_id: 'rec_2' }, { id: 'rec_3' }]), [
    'rec_1',
    'rec_2',
    'rec_3',
  ]);
  assert.deepEqual(linkedRecordIds({ link_record_ids: ['rec_4'] }), ['rec_4']);
  assert.deepEqual(linkedRecordIds([{ record_ids: ['rec_5'], table_id: 'tbl_order',
    text: 'XSD-20260925-0062', type: 'text' }]), ['rec_5']);
  assert.deepEqual(linkedRecordIds({ record_ids: ['rec_6', 'rec_7'] }), ['rec_6', 'rec_7']);
  assert.equal(textValue([{ text: 'A' }, { name: 'B' }]), 'A,B');
});

// 2026-10-06 线上事故：没有硬编码兜底的表（「尺码管理」「其他配品」）在 .env 之前
// 被 require，tableId 被冻结成空串，于是请求打到 `.../tables//records`，
// 飞书回 404 `404 page not found`——报错里看不出是哪张表没配。
// 现在每个真正要访问多维表格的方法都必须当场抛错，并且**一个请求都不发出去**。
// （加固前只有 listFields 有这层守卫，create / update / get / delete / listAll 会带着空 ID 发请求。）
test('空 table_id 必须在发请求之前就被拦下，并指名是哪张表', async () => {
  const unconfigured = {
    appToken: 'app_v1',
    tables: {
      // 模拟「其他配品 / 尺码管理」这类没有硬编码兜底的表：未配置就是空串。
      accessory: { tableName: '其他配品', tableId: '', fields: { name: '名称' } },
    },
  };
  let calls = 0;
  const spy = async () => { calls += 1; return { code: 0, data: {} }; };
  const client = {
    bitable: {
      appTableRecord: { create: spy, update: spy, get: spy, delete: spy, list: spy },
      appTableField: { list: spy },
    },
  };
  const gateway = new V1BitableGateway({ schema: unconfigured, client });

  await assert.rejects(() => gateway.create('accessory', { name: '腰带' }), /“其他配品”未配置 table_id/);
  await assert.rejects(() => gateway.update('accessory', 'rec_1', { name: '腰带' }), /“其他配品”未配置 table_id/);
  await assert.rejects(() => gateway.get('accessory', 'rec_1'), /“其他配品”未配置 table_id/);
  await assert.rejects(() => gateway.delete('accessory', 'rec_1'), /“其他配品”未配置 table_id/);
  await assert.rejects(() => gateway.listAll('accessory'), /“其他配品”未配置 table_id/);
  await assert.rejects(() => gateway.listFields('accessory'), /“其他配品”未配置 table_id/);

  assert.equal(calls, 0, '空 table_id 时不得向多维表格发出任何请求');
});
