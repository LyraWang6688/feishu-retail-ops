// 端到端：新建销售主表记录时**写入**了销售单号，并且确认后的消息里显示的就是它。
//
// 为什么这个测试必须存在：单号原来是飞书「自动编号」字段生成的，产品负责人把该字段
// 改成文本字段后飞书不再生成。只测纯函数（salesOrderNo.test.js）证明不了
// "号真的落到了销售主表上、并且消息里显示的不是空" —— 这两件事都要走完整链路。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { V1PostingService } = require('../src/services/v1PostingService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { shanghaiDateStamp } = require('../src/services/salesOrderNo');
const { normalizeSalesResult } = require('../src/services/doubaoService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 群聊链路要读 LARK_BOT_OPEN_ID 判 @（config/groupPurchase）。这些用例都不碰群聊，
// 但服务构造时会解析一次配置；给个测试值，免得每个用例都打一条
// lark.group.bot_open_id_missing 警告把真正的失败淹掉。
process.env.LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || 'ou_test_bot_open_id';
// 实时库存里的一双（与 larkMvpService.test.js 的 liveRow 同形）：
// 单号生成需要走完"解析 → 有货 → 出确认卡片 → 确认入账"整条链路，缺一行库存就到不了入账。
const liveRow = ({ itemNo, color = '黑', size, productRecordId }) => ({
  record_id: `live_${itemNo}_${color}_${size}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: '门盒',
    编号: [{ id: productRecordId }],
    尺码: [{ id: `size_${size}` }],
  },
});

// 内存假 Base：语义字段名 → 真实字段名的映射与线上 schema 完全一致，
// 所以"写进去的到底是哪个字段"是被真正验证的，而不是被假实现糊过去。
const fakeGateway = () => {
  let seq = 0;
  const records = new Map([
    // 改字段类型之前的历史单：旧日期 + 旧全局号，本用例断言它一个字都不动。
    ['salesEntry', [{ record_id: 'legacy_1', fields: { 销售单号: 'XSD-20261004-0168', 资金状态: '已写入' } }]],
    ['sizeManagement', [{ record_id: 'size_38', fields: { 尺码: 38 } }]],
    ['liveInventory', [liveRow({ itemNo: '8088-26', color: '棕', size: 38, productRecordId: 'prod_1' })]],
  ]);
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
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

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-no-')), idField: 'task_id' });

const parsedSale = () => normalizeSalesResult({
  intent: 'sale',
  behavior_code: 'SALE_CASH',
  sales_behavior: '现货销售',
  trade_type: '现货',
  items: [{ item_no: '8088-26', color: '棕', size: 38, quantity: 1, actual_amount: 230 }],
  payments: [{ amount: 230, method: '微信', status: '已收款' }],
  agreed_total: 230,
});

test('端到端：创建销售主表时写入单号，消息里的「销售单号」就是它', async () => {
  const gateway = fakeGateway();
  const store = makeStore();
  const openId = 'ou_1';
  const cards = [];
  // 真实入账链路：LarkMvpService → V1PostingService → SalesOrderService（含真实收款/进度写入）。
  const service = new LarkMvpService({
    client: {},
    gateway,
    references: { resolveSalesTradeType: async (code) => ({ recordId: `behavior_${code}` }) },
    posting: new V1PostingService({
      gateway,
      references: {
        resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
        resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }),
      },
    }),
    // 交付/库存不是本用例的对象，桩掉；这里只关心单号。
    delivery: { deliver: async () => ({ failures: [], deliveredQuantity: 1, totalQuantity: 1 }) },
    recognizer: { parseSalesText: async () => parsedSale() },
    store,
  });
  service.replyCard = async () => 'card_1';
  service.sendText = async () => undefined;
  service.updateSalesActionCard = async () => true;
  service.publishSalesResultCard = async (_task, _event, card) => { cards.push(card); return true; };

  await store.create({ task_id: 'sale_order_no', type: 'sale', status: 'received', message_id: 'om_1',
    sender_open_id: openId, sent_at: Date.now(), original_text: '8088-26棕38，230元微信' });

  await service.processSalesTask('sale_order_no');

  const task = await store.get('sale_order_no');
  const created = gateway.records.get('salesEntry').find((row) => row.record_id === task.sales_entry_record_id);
  const writtenNo = created?.fields['销售单号'];
  // ① 创建记录时就写进去了（不是等到入账才补），字段名必须是「销售单号」
  assert.match(String(writtenNo), /^XSD-\d{8}-\d{4}$/, '创建销售主表记录时必须写入销售单号');
  // ② 日期段按东八区当天算
  assert.equal(writtenNo, `XSD-${shanghaiDateStamp(new Date())}-0001`);
  // ③ 历史单号不参与计算：昨天那单是 0168，今天第一条仍是 0001（不是 0169）
  assert.equal(gateway.records.get('salesEntry')[0].fields['销售单号'], 'XSD-20261004-0168',
    '已有记录一个字不动');
  assert.notEqual(writtenNo, 'XSD-20261004-0168');

  // ④ 确认入账：sourceNo 由 SalesOrderService 从销售主表读回，必须是刚写的那个号
  await service.handleCardAction({
    operator: { operator_id: { open_id: openId } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_order_no' } },
  });

  const posted = await store.get('sale_order_no');
  assert.equal(posted.status, 'posted');
  assert.equal(posted.posting_result.sourceNo, writtenNo, 'result.sourceNo 必须是真实单号，不能回退成 record_id');
  const finalCard = JSON.stringify(cards.at(-1));
  assert.match(finalCard, new RegExp(`销售单号：${writtenNo}`), '消息里显示的必须是刚写入的单号');
  assert.doesNotMatch(finalCard, /销售单号：；/, '销售单号不能是空的');
  assert.doesNotMatch(finalCard, /请在销售主表核对/);
});

test('第二单接在当天已有单号之后（最大值 + 1），不会重发 0001', async () => {
  const gateway = fakeGateway();
  const store = makeStore();
  const openId = 'ou_1';
  const service = new LarkMvpService({
    client: {}, gateway,
    references: { resolveSalesTradeType: async () => ({ recordId: 'behavior_1' }) },
    posting: { postSale: async () => ({ sourceNo: 'unused', detailRecordIds: [], paymentRecordIds: [] }) },
    recognizer: { parseSalesText: async () => parsedSale() },
    store,
  });
  service.replyCard = async () => 'card_1';
  service.sendText = async () => undefined;
  // 今天已经有一单（0001）——第二单必须是 0002
  gateway.records.get('salesEntry').push({ record_id: 'today_1',
    fields: { 销售单号: `XSD-${shanghaiDateStamp(new Date())}-0001`, 资金状态: '已写入' } });

  await store.create({ task_id: 'sale_second', type: 'sale', status: 'received', message_id: 'om_2',
    sender_open_id: openId, sent_at: Date.now(), original_text: '8088-26棕38，230元微信' });
  await service.processSalesTask('sale_second');

  const task = await store.get('sale_second');
  const created = gateway.records.get('salesEntry').find((row) => row.record_id === task.sales_entry_record_id);
  assert.equal(created.fields['销售单号'], `XSD-${shanghaiDateStamp(new Date())}-0002`);
});
