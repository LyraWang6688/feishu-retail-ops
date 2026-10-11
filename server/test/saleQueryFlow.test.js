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

// 群聊链路要读 LARK_BOT_OPEN_ID 判 @（config/groupPurchase）。这些用例都不碰群聊，
// 但服务构造时会解析一次配置；给个测试值，免得每个用例都打一条
// lark.group.bot_open_id_missing 警告把真正的失败淹掉。
process.env.LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || 'ou_test_bot_open_id';
const DAY_MS = 24 * 60 * 60 * 1000;
// ⚠️ 夹具的时间锚点必须**相对当前时间**算，不能写死某一天。
//    查询窗口是「今天 + 往前 4 个上海自然日」（`saleLookupService.lookupWindowStart`，
//    天数见 `config/saleLookup` 的默认 5 天）——写死锚点（原来是 2026-10-05T09:00+08:00）
//    之后窗口一往前滑，夹具的 daysAgo(1) 就掉出窗口，用例变成"日期腐烂"式的假红
//    （2026-10-09 实测：窗口起点 2026-10-05 00:00+08 > 夹具 2026-10-04 09:00+08）。
//    ⇒ 锚点改成「**今天**的上海日 09:00」，daysAgo(n) = 往前 n 个上海自然日；
//    这样它永远落在窗口内，且**不需要放宽/删除任何断言**。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const shanghaiDayStartOf = (date) =>
  Date.parse(`${new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00+08:00`);
const TODAY_9AM = shanghaiDayStartOf(new Date()) + 9 * 60 * 60 * 1000;
const daysAgo = (n) => TODAY_9AM - n * DAY_MS;

// 这一组测的是「消息 → 意图 → 只读查询 → 卡片」的接线：
// 关键是**本期一次业务写都没有**（gateway.create/update/delete 全部记下来断言为空）。

const details = [
  { record_id: 'd_new', fields: {
    编号: [{ record_ids: ['p1'], text: '' }],
    销售单号: [{ record_ids: ['e2'], text: '' }],
    销售日: daysAgo(1),
    尺码: [{ record_ids: ['size_39'], text: '' }],
    实收金额: 230,
  } },
  { record_id: 'd_back', fields: {
    编号: [{ record_ids: ['p1'], text: '' }],
    销售单号: [{ record_ids: ['e_back'], text: '' }],
    销售日: daysAgo(2),
    尺码: [{ record_ids: ['size_38'], text: '' }],
    实收金额: 230,
  } },
];
const entries = [
  { record_id: 'e2', fields: { 销售单号: 'XSD-20261004-0001', 录单日: daysAgo(1), 销售状态: '已写入' } },
  { record_id: 'e_back', fields: { 销售单号: 'XSD-20261003-0001', 录单日: daysAgo(2), 销售状态: '已退货' } },
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
  // 🔴 2026-10-07 二次收尾：`replyTaskCard`（售后那张确认卡片走的出口）的**非群分支**
  //    已改成"记 skip + 返 null"（没有群上下文 = 没有去处）。本文件的 task 是历史
  //    "没有渠道上下文"的形状，所以这里**显式**把售后编排的回复出口接到记账打桩上 ——
  //    与 `afterSalesFlow.test.js` 的 `build()` 显式注入出口同一理由（那边测的是编排，
  //    这边测的是接线与卡片内容/按钮/零写入）。⚠️ 不许改成"干脆不出卡片"：那是删覆盖。
  service.afterSalesFlow.replyCardToTask = async (_task, card) => { cards.push(card); return 'om_card'; };
  // 🔴 2026-10-07 收尾：这里原来还有一行 `service.sendCard = ...` ——
  //    `LarkMvpService.sendCard`（open_id 口径的卡片发送器）已随"缺省回落私聊"的清掉
  //    而整体删除。`sendText` **保留**：它还在（私聊 notice 那一句），这里的打桩继续钉住
  //    "查销售记录这条链路一次主动消息都不发"。
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

// 🔴 2026-10-07 三次收尾：`saleLookupService.replyCardByTask` 的**主回复**也按渠道分流了
//    （非群 → 记 skip + 返 null，不再"回她那条私聊消息"）。
//    「查销售记录」是**群里的动作** ⇒ 下面两条查询用例显式带群上下文；
//    销售确认卡片那条（`processSalesTask`）显式把出口接在 `sendTaskCard` 上。
const GROUP_TASK = { chat_type: 'group', chat_id: 'oc_sales_group' };

test('sale_query：查销售记录走只读链路，出无按钮卡片并写入候选上下文，零业务写', async () => {
  const { service, store, writes, cards, sent } = makeService({
    // 故意给中文别名：证明意图会经 config/saleIntents 收敛，而不是靠字符串恰好相等。
    intent: '查销售记录', item_no: '6035', color: '黑',
  });
  await store.create({ task_id: 'query_task', type: 'sale', status: 'received', message_id: 'om_q',
    sender_open_id: 'ou_1', original_text: '帮我查 6035 黑', ...GROUP_TASK });

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
    sender_open_id: 'ou_1', original_text: '帮我查 9999 黑', ...GROUP_TASK });

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
  // 钱怎么走她说清楚了（"退现金"）：钱没说定时接线层会先回一句文字问她、不出卡片，
  // 那条路在 afterSalesFlow.test.js 里单独覆盖。
  const { service, store, writes, cards, sent } = makeService(
    { intent: '退货', action: 'return', item_no: '6035', color: '黑', settlement: 'cash' },
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
  // 销售确认卡片走**渠道感知出口**（群里 = 回到那条销售话题）。
  service.sendTaskCard = async (_task, card) => { cards.push(card); return 'om_sale_card'; };
  // 🚨 哨兵：非群那条路（`replyCard(task.message_id, …)`）**一次都不许走** —— 它正是
  //    2026-10-07 三次收尾堵掉的那条"非群也会回一条"。真被走到就直接炸，而不是默默多发一张卡。
  service.replyCard = async () => { throw new Error('非群回复路径不该被走到：群任务必须走 sendTaskCard'); };
  await store.create({ task_id: 'normal_sale', type: 'sale', status: 'received', message_id: 'om_s',
    sender_open_id: 'ou_1', original_text: '6035黑38码230元微信', ...GROUP_TASK });

  await service.processSalesTask('normal_sale');

  assert.equal((await store.get('normal_sale')).status, 'ready_to_confirm');
  assert.ok(writes.some(([operation, tableKey]) => operation === 'create' && tableKey === 'salesEntry'));
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /请确认销售订单/);
});
