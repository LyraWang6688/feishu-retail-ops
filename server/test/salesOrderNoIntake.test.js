// 端到端：新建销售主表记录时**写入**了销售单号。
//
// 为什么这个测试必须存在：单号原来是飞书「自动编号」字段生成的，产品负责人把该字段
// 改成文本字段后飞书不再生成。只测纯函数（salesOrderNo.test.js）证明不了
// "号真的落到了销售主表上" —— 这件事要走完整建单链路。
//
// ⚠️⚠️ 2026-10-12（清群聊入口 C4·"先迁移覆盖"）改写：
//   原先这两条是**经 `LarkMvpService.processSalesTask`**（群聊自然语言录入）走完整链路的；
//   群入口退场后那条管线已删除。但**单号写入的实现本身还在、还活着** ——
//   它早在 C0 就被剥到 **`services/salesEntryService.createSalesEntryWithOrderNo`**，
//   而且**扫码页正在用它**（`scanWriteService.js:71-77`）。
//   ⇒ 按"实现还活着就必须迁移、不许删"的判据，这里改成**直接驱动那份实现**
//     （与扫码页走的是同一个函数、同一份单号规则），**断言语义逐字保留**：
//     ① 建单时就写号（不是入账才补）② 日期段按东八区 ③ 历史号不参与计算 ④ 第二单 +1。
//   ⚠️ 原用例里还有"消息卡片上显示的单号"（④）——那条验的是**已退场的销售卡片**，
//     卡片路径随群入口一起删除 ⇒ 该断言并入"随能力退场"清单（本文件不再覆盖）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSalesEntryWithOrderNo } = require('../src/services/salesEntryService');
const { shanghaiDateStamp } = require('../src/services/salesOrderNo');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 内存假 Base：语义字段名 → 真实字段名的映射与线上 schema 完全一致，
// 所以"写进去的到底是哪个字段"是被真正验证的，而不是被假实现糊过去。
const fakeGateway = () => {
  let seq = 0;
  const records = new Map([
    // 改字段类型之前的历史单：旧日期 + 旧全局号，本用例断言它一个字都不动。
    ['salesEntry', [{ record_id: 'legacy_1', fields: { 销售单号: 'XSD-20261004-0168', 确认状态: '已入账' } }]],
  ]);
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = {};
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
        if (!field) throw new Error(`${key}: unknown field ${name}`);
        fields[field] = value;
      }
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      for (const [name, value] of Object.entries(values)) {
        const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
        if (!field) throw new Error(`${key}: unknown field ${name}`);
        record.fields[field] = value;
      }
      return record;
    },
  };
  return gateway;
};

test('端到端：创建销售主表时写入单号（扫码建单走的就是这一个函数）', async () => {
  const gateway = fakeGateway();
  const created = await createSalesEntryWithOrderNo({ gateway }, {
    task_id: 'sale_order_no', sender_open_id: 'ou_1',
  });
  const row = gateway.records.get('salesEntry').find((item) => item.record_id === created.recordId);
  const writtenNo = row?.fields['销售单号'];

  // ① 创建记录时就写进去了（不是等到入账才补），字段名必须是「销售单号」
  assert.match(String(writtenNo), /^XSD-\d{8}-\d{4}$/, '创建销售主表记录时必须写入销售单号');
  // ② 日期段按东八区当天算
  assert.equal(writtenNo, `XSD-${shanghaiDateStamp(new Date())}-0001`);
  // ③ 历史单号不参与计算：昨天那单是 0168，今天第一条仍是 0001（不是 0169）
  assert.equal(gateway.records.get('salesEntry')[0].fields['销售单号'], 'XSD-20261004-0168',
    '已有记录一个字不动');
  assert.notEqual(writtenNo, 'XSD-20261004-0168');
});

test('第二单接在当天已有单号之后（最大值 + 1），不会重发 0001', async () => {
  const gateway = fakeGateway();
  // 今天已经有一单（0001）——第二单必须是 0002
  gateway.records.get('salesEntry').push({
    record_id: 'today_1',
    fields: { 销售单号: `XSD-${shanghaiDateStamp(new Date())}-0001`, 确认状态: '已入账' },
  });

  const created = await createSalesEntryWithOrderNo({ gateway }, {
    task_id: 'sale_second', sender_open_id: 'ou_1',
  });
  const row = gateway.records.get('salesEntry').find((item) => item.record_id === created.recordId);
  assert.equal(row.fields['销售单号'], `XSD-${shanghaiDateStamp(new Date())}-0002`);
});
