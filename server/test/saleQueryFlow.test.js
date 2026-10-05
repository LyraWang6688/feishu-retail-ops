const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { afterSalesContextId } = require('../src/config/afterSalesFlow');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY_9AM = Date.parse('2026-10-05T09:00:00+08:00');
const daysAgo = (n) => TODAY_9AM - n * DAY_MS;

// 这一组测的是「消息 → 意图 → 只读查询 → 卡片」的接线：
// 关键是**本期一次业务写都没有**（gateway.create/update/delete 全部记下来断言为空）。

const details = [
  { record_id: 'd_new', fields: {
    编号: [{ record_ids: ['p1'], text: '' }],
    销售单号: [{ record_ids: ['e2'], text: '' }],
    销售日: daysAgo(1),
    尺码: [{ record_ids: ['size_39'], text: '' }],
    成交金额: 230,
  } },
  { record_id: 'd_back', fields: {
    编号: [{ record_ids: ['p1'], text: '' }],
    销售单号: [{ record_ids: ['e_back'], text: '' }],
    销售日: daysAgo(2),
    尺码: [{ record_ids: ['size_38'], text: '' }],
    成交金额: 230,
  } },
];
const entries = [
  { record_id: 'e2', fields: { 销售单号: 'XSD-20261004-0001', 录单日: daysAgo(1), 订单状态: '已完成' } },
  { record_id: 'e_back', fields: { 销售单号: 'XSD-20261003-0001', 录单日: daysAgo(2), 订单状态: '已退货' } },
];
const products = [{ record_id: 'p1', fields: { 货号: '6035', 颜色: '黑', 编号: '6035|黑|A' } }];
// 「尺码管理」的两条记录：尺码在销售明细里是关联，真实链路会读这张表。
const sizes = [
  { record_id: 'size_38', fields: { 尺码: 38 } },
  { record_id: 'size_39', fields: { 尺码: 39 } },
];

const makeService = (recognizerResult, options = {}) => {
  const writes = [];
  const cards = [];
  const sent = [];
  const gateway = {
    table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
    listAll: async (tableKey) => ({
      salesDetail: details, salesEntry: entries, product: products, sizeManagement: sizes,
    }[tableKey] || []),
    create: async (...args) => { writes.push(['create', ...args]); throw new Error('本期不允许写业务表'); },
    update: async (...args) => { writes.push(['update', ...args]); throw new Error('本期不允许写业务表'); },
    delete: async (...args) => { writes.push(['delete', ...args]); throw new Error('本期不允许写业务表'); },
  };
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-query-flow-')),
    idField: 'task_id',
  });
  const service = new LarkMvpService({
    client: {},
    gateway,
    references: {},
    posting: {},
    recognizer: { parseSalesText: async () => recognizerResult },
    store,
    // 执行器用端口注入：这些用例只验证"接线与出卡"，真实写入由 afterSalesService 自己的测试覆盖；
    // 注入也顺便保证用例不会碰到仓库里的 data/after_sales_operations。
    ...(options.afterSales ? { afterSales: options.afterSales } : {}),
  });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'om_card'; };
  service.sendCard = async (_openId, card) => { cards.push(card); return 'om_card_fallback'; };
  service.sendText = async (openId, message) => sent.push({ openId, message });
  service.acknowledgeMessage = async () => undefined;
  return { service, store, writes, cards, sent };
};

const collectTags = (node, tags = []) => {
  if (Array.isArray(node)) { for (const item of node) collectTags(item, tags); return tags; }
  if (node && typeof node === 'object') {
    if (typeof node.tag === 'string') tags.push(node.tag);
    for (const value of Object.values(node)) collectTags(value, tags);
  }
  return tags;
};

test('sale_query：查销售记录走只读链路，出无按钮卡片并写入候选上下文，零业务写', async () => {
  const { service, store, writes, cards, sent } = makeService({
    // 故意给中文别名：证明意图会经 config/saleIntents 收敛，而不是靠字符串恰好相等。
    intent: '查销售记录', item_no: '6035', color: '黑',
  });
  await store.create({ task_id: 'query_task', type: 'sale', status: 'received', message_id: 'om_q',
    sender_open_id: 'ou_1', original_text: '帮我查 6035 黑' });

  await service.processSalesTask('query_task');

  assert.deepEqual(writes, [], '查销售记录不允许写任何业务表');
  assert.equal(cards.length, 1);
  const tags = collectTags(cards[0]);
  assert.equal(tags.includes('button'), false);
  assert.equal(tags.includes('action'), false);
  assert.equal(JSON.stringify(cards[0]).includes('"action"'), false);
  assert.match(JSON.stringify(cards[0]), /6035黑/);

  const task = await store.get('query_task');
  assert.equal(task.status, 'query_answered');
  // 已退货的单被排除，只剩「第 1 笔」。
  assert.deepEqual(task.pending_candidates.map((row) => row.record_id), ['d_new']);
  assert.equal(task.pending_candidates[0].size, 39);
  assert.deepEqual(sent, []);
  // 退换货第二期接线：查询之后把候选按**人**记了一份（跨消息、10 分钟有效），
  // 她下一句「第 2 笔，退货」才定位得到（每条消息都是一个新任务）。
  const context = await store.get(afterSalesContextId('ou_1'));
  assert.ok(context, '查询后应留下按人的候选上下文');
  assert.deepEqual(context.pending_candidates.map((row) => row.record_id), ['d_new']);
  assert.ok(Date.parse(context.pending_candidates_expires_at) > Date.now());
});

test('sale_query 0 条：卡片告诉她在窗口里没查到，并问大概是哪天买的', async () => {
  const { service, store, writes, cards } = makeService({ intent: 'sale_query', item_no: '9999', color: '黑' });
  await store.create({ task_id: 'query_empty', type: 'sale', status: 'received', message_id: 'om_q2',
    sender_open_id: 'ou_1', original_text: '帮我查 9999 黑' });

  await service.processSalesTask('query_empty');

  assert.deepEqual(writes, []);
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /没查到/);
  assert.match(JSON.stringify(cards[0]), /哪天买的/);
  assert.deepEqual((await store.get('query_empty')).pending_candidates, []);
});

test('return：接线后走售后编排（出确认卡片），确认之前不调执行器、不写任何业务表', async () => {
  const taskId = 'after_sales_return';
  const executed = [];
  const { service, store, writes, cards, sent } = makeService(
    { intent: '退货', action: 'return', item_no: '6035', color: '黑' },
    { afterSales: { execute: async (request) => { executed.push(request); return {}; } } },
  );
  await store.create({ task_id: taskId, type: 'sale', status: 'received', message_id: 'om_r',
    sender_open_id: 'ou_1', original_text: '退那双 6035 黑' });

  await service.processSalesTask(taskId);

  // 入口 B：她自己按货号定位（这一笔没先查过），命中 1 条 → 直接出确认卡片。
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /请确认售后/);
  assert.match(JSON.stringify(cards[0]), /6035黑/);
  // 卡片必须有按钮（这一期要动账），而且动作名是售后那三个之一。
  assert.equal(JSON.stringify(cards[0]).includes('confirm_after_sales'), true);
  const task = await store.get(taskId);
  assert.equal(task.status, 'after_sales_confirming');
  assert.equal(task.after_sales_plan.action, 'return');
  assert.deepEqual(task.after_sales_plan.original_sales_detail_record_ids, ['d_new']);
  // 出卡片 ≠ 执行：还没点确认，一个字节都没写。
  assert.deepEqual(executed, []);
  assert.deepEqual(writes, [], '售后在确认之前不允许写任何业务表');
  assert.deepEqual(sent, []);
});

test('原有销售链路不受影响：sale 意图照旧建销售主表并出确认卡片', async () => {
  const cards = [];
  const writes = [];
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-query-flow-sale-')),
    idField: 'task_id',
  });
  const gateway = {
    table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
    listAll: async (tableKey) => {
      if (tableKey === 'liveInventory') {
        return [{ record_id: 'live_1', fields: {
          库存键: '6035|黑|女鞋|38',
          所属状态: '门盒',
          编号: [{ record_ids: ['p1'], text: '' }],
          尺码: [{ record_ids: ['size_38'], text: '' }],
        } }];
      }
      if (tableKey === 'product') return products;
      return [];
    },
    validateTables: async () => [],
    create: async (tableKey) => { writes.push(['create', tableKey]); return { recordId: 'entry_x' }; },
    update: async (tableKey) => { writes.push(['update', tableKey]); },
  };
  const service = new LarkMvpService({ client: {}, gateway, references: {}, posting: {},
    recognizer: { parseSalesText: async () => ({
      intent: 'sale', trade_type: '现货', item_no: '6035', color: '黑', size: 38, quantity: 1,
      actual_amount: 230, items: [{ item_no: '6035', color: '黑', size: 38, quantity: 1, actual_amount: 230 }],
      payments: [{ amount: 230, method: '微信' }], agreed_total: 230, missing_fields: [],
    }) }, store });
  service.replyCard = async (_messageId, card) => { cards.push(card); return 'om_sale_card'; };
  await store.create({ task_id: 'normal_sale', type: 'sale', status: 'received', message_id: 'om_s',
    sender_open_id: 'ou_1', original_text: '6035黑38码230元微信' });

  await service.processSalesTask('normal_sale');

  assert.equal((await store.get('normal_sale')).status, 'ready_to_confirm');
  assert.ok(writes.some(([operation, tableKey]) => operation === 'create' && tableKey === 'salesEntry'));
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /请确认销售订单/);
});
