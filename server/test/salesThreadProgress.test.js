/**
 * ②「话题里的二次处理识别」的验收测试（业务负责人 2026-10-06 的口径）。
 *
 * 现象（要修的 bug）：
 *   她在**销售话题**里说「收到微信 500」——那是**那笔的收款进展**。
 *   改动前它会被当成【新的销售原话】送进 AI，可能回"销售信息还缺…"。
 *
 * 验收标准（逐条对应）：
 *   □ 话题里说「收到微信 500」→ **更新那笔**（记一条收款明细），**不新建销售主表记录**
 *   □ 判据全部在 config/salesProgressIntake（本文件也钉住"改词表不动代码"）
 *   □ 判断不了时**回一句问她**，不回退去当新原话解析
 *   □ ⭐ 私聊行为**一个字都不变**：同样的句子在私聊仍然走销售解析（不是进展）
 *   □ 回复回到**同一个话题**（reply_in_thread）
 *
 * ⭐⭐ 2026-10-08「触发入口只留卡片按钮」（业务负责人拍板的**乙**）：
 *   默认已经改成**说话不再触发写库**（只回提示，见 `salesTextTriggerOff.test.js`）。
 *   本文件钉的是**开关打开时**的旧行为 ⇒ 在进程内**显式把开关打开**
 *   （`SALES_PROGRESS_TEXT_TRIGGER_ENABLED=true`），这样"将来要恢复只翻开关"这句话
 *   有回归保护：开关一开，下面每一条逐字与改动前一致。
 *   ⚠️ node --test 每个测试文件一个子进程，这里改 process.env 不会影响别的文件。
 */

process.env.SALES_PROGRESS_TEXT_TRIGGER_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { SalesThreadProgressService } = require('../src/services/salesThreadProgressService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PROGRESS_KINDS, resolveSalesProgressIntakeConfig } = require('../src/config/salesProgressIntake');

const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const CHAT_ID = 'oc_test_group';
const SALE_ID = 'entry_thread';

const tempStore = (prefix = 'sales-progress-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

// ── 飞书 client 的假实现：记录**真的发出去了什么**（回复到哪条、带不带 reply_in_thread）
const makeClient = () => {
  const replies = [];
  const client = {
    im: {
      message: {
        reply: async ({ path: replyPath, data }) => {
          replies.push({ path: replyPath, data });
          return { code: 0, data: { message_id: `om_reply_${replies.length}`, thread_id: 'omt_thread' } };
        },
        create: async ({ data }) => {
          replies.push({ path: { message_id: '' }, data, direct: true });
          return { code: 0, data: { message_id: `om_direct_${replies.length}` } };
        },
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  return { client, replies };
};

/**
 * 语义键 → 中文字段名的假 Base（和真 gateway 的落库口径一致）。
 * 只要跑通"读那一笔 → 记一条收款明细"这一段，所以只放这几张表。
 */
const makeGateway = ({ entry, details = [], payments = [], methods = [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }] } = {}) => {
  const records = {
    salesEntry: entry ? [entry] : [],
    salesDetail: details,
    paymentRecord: payments,
    paymentMethod: methods,
  };
  const created = [];
  const updated = [];
  const gateway = {
    records,
    created,
    updated,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    get: async (key, id) => (records[key] || []).find((row) => row.record_id === id) || null,
    listAll: async (key) => records[key] || [],
    create: async (key, values) => {
      const fields = {};
      for (const [semantic, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const name = V1_BITABLE_SCHEMA.tables[key].fields[semantic];
        if (!name) throw new Error(`未配置语义字段: ${key}.${semantic}`);
        fields[name] = value;
      }
      const record = { record_id: `new_${key}_${(records[key] || []).length + 1}`, fields };
      records[key] = [...(records[key] || []), record];
      created.push({ key, recordId: record.record_id, fields });
      return { recordId: record.record_id };
    },
    update: async (key, id, values) => {
      updated.push({ key, id, values });
      const record = (records[key] || []).find((row) => row.record_id === id);
      if (record) {
        for (const [semantic, value] of Object.entries(values)) {
          record.fields[V1_BITABLE_SCHEMA.tables[key].fields[semantic]] = value;
        }
      }
      return record;
    },
  };
  return gateway;
};

const threadSale = () => ({
  record_id: SALE_ID,
  fields: { 销售单号: 'XSD-20261006-0001', 资金状态: '已写入', 确认状态: '已确认' },
});

const threadDetail = () => ({
  record_id: 'detail_1',
  fields: { 销售单号: [SALE_ID], 实收金额: 800, 履约状态: '已交付' },
});

const makeHarness = ({ gateway, recognizer, secondDelivery } = {}) => {
  const { client, replies } = makeClient();
  const threads = new SalesGroupThreadLocator({ store: tempStore('sales-progress-threads-') });
  const service = new LarkMvpService({
    client,
    gateway: gateway || makeGateway({ entry: threadSale(), details: [threadDetail()] }),
    posting: {},
    recognizer: recognizer || { parseSalesText: async () => { throw new Error('进展消息不该送进 AI'); } },
    store: tempStore('sales-progress-lark-'),
    botOpenId: TEST_BOT_OPEN_ID,
    salesGroupThreads: threads,
    // 整单完成（「已完毕 / 成交」）走 SecondDeliveryService：测试里可以换成一个记录型桩。
    secondDelivery,
    groupPurchaseFlow: { handleGroupPurchaseMessage: async () => ({ resolved: false, reason: 'stub' }) },
  });
  service.acknowledgeMessage = async () => undefined;
  return { service, replies, threads };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_progress_1',
    chat_id: CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    mentions: [],
    thread_id: overrides.threadId,
  },
});

const flushSalesTasks = async (service, openId = 'ou_sender') => {
  await new Promise((resolve) => setImmediate(resolve));
  await service.enqueueForSender(openId, async () => undefined);
};

const bindThread = async (threads, threadId = 'omt_sale_7') => {
  await threads.rememberSaleThread({
    salesEntryRecordId: SALE_ID, taskId: 'sale_orig', messageId: 'om_orig',
    threadId, chatId: CHAT_ID, senderOpenId: 'ou_sender',
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// 判据本身（纯函数）：配置驱动，改词表不用动代码
// ═══════════════════════════════════════════════════════════════════════════

test('判据：进展线索 / 新原话线索 / 金额，各自认得出来', () => {
  const service = new SalesThreadProgressService({ gateway: makeGateway({ entry: threadSale() }) });

  assert.deepEqual(service.classify('收到微信 500'),
    { kind: PROGRESS_KINDS.PAYMENT, reason: 'payment_cue:收到', amount: 500, method: '微信' });

  // 货号 / 尺码的数字**不是**金额（先遮掉再取数，取不到"一个数"就不猜）
  assert.deepEqual(service.classify('收到现金 1366-33 那双的钱 500'),
    { kind: PROGRESS_KINDS.PAYMENT, reason: 'payment_cue:收到', amount: 500, method: '现金' });

  assert.equal(service.classify('66356 黑 42 一双 230 微信').kind, PROGRESS_KINDS.NONE,
    '一笔新销售的原话：没有进展线索 → 不归二次处理');

  assert.equal(service.classify('收到微信 500，再记一双 66356 黑 42').kind, PROGRESS_KINDS.AMBIGUOUS,
    '进展 + 新原话线索同时出现 → 不猜，问她');

  assert.deepEqual(service.classify('那双 1366-33 拿走了'),
    { kind: PROGRESS_KINDS.DELIVERY, reason: 'delivery_cue:拿走' });

  assert.equal(service.classify('收到微信').kind, PROGRESS_KINDS.AMBIGUOUS,
    '只说"收到微信"没说多少钱 → 不猜，问她');
});

test('判据：词表可配 —— 换一份词表立刻改变判据（配置先行）', () => {
  const service = new SalesThreadProgressService({
    gateway: makeGateway({ entry: threadSale() }),
    config: resolveSalesProgressIntakeConfig({
      progressCues: { payment: ['到账'], delivery: [] }, newSaleCues: [],
    }),
  });
  assert.equal(service.classify('收到微信 500').kind, PROGRESS_KINDS.NONE, '旧词表下"收到"不再算线索');
  assert.equal(service.classify('到账 500').kind, PROGRESS_KINDS.PAYMENT);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 话题里说「收到微信 500」→ 更新那笔（不是新建）
// ═══════════════════════════════════════════════════════════════════════════

test('话题里说「收到微信 500」→ 记到那一笔上（收款明细），不新建销售主表记录', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads);

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_progress_500', threadId: 'omt_sale_7', text: '收到微信 500',
  }));
  assert.equal(accepted.handled, true);
  assert.equal(accepted.mode, 'thread');
  await flushSalesTasks(service);

  // ① **不新建**销售主表记录
  assert.deepEqual(gateway.created.filter((item) => item.key === 'salesEntry'), [],
    '这是那笔的进展，不能新建销售主表记录');

  // ② **记到那一笔上**：一条收款明细，金额 500、方式微信、关联那笔
  const payments = gateway.created.filter((item) => item.key === 'paymentRecord');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['收款金额'], 500);
  assert.equal(payments[0].fields['收款状态'], '已收款');
  assert.deepEqual(payments[0].fields['关联销售单'], [SALE_ID], '必须挂在她说的那一笔销售上');
  assert.deepEqual(payments[0].fields['收款方式'], ['method_wechat']);
  assert.equal(payments[0].fields['交易方向'], '收入');

  // ③ 回复回到**同一个话题**（不是私聊、不是主群光秃秃一条）
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.ok(textReply, '要有一条回执');
  assert.equal(textReply.path.message_id, 'om_progress_500');
  assert.equal(textReply.data.reply_in_thread, true);
  assert.match(JSON.parse(textReply.data.content).text, /500/);

  // ④ 这一笔的进展记在任务上（可排查）
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, 'progress_applied');
  assert.equal(task.progress_kind, 'payment');
});

test('话题里说「那双拿走了」→ 把还没交的明细记成已交付（交付进展）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 800, 履约状态: '未交付' } }],
  });
  const delivered = [];
  const { service, threads } = makeHarness({ gateway });
  service.delivery.deliver = async (input) => { delivered.push(input); return { ok: true }; };
  await bindThread(threads, 'omt_sale_8');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_pickup', threadId: 'omt_sale_8', text: '那双拿走了',
  }));
  await flushSalesTasks(service);

  assert.deepEqual(gateway.created.filter((item) => item.key === 'salesEntry'), []);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].salesEntryRecordId, SALE_ID);
  assert.deepEqual(delivered[0].detailRecordIds, ['detail_1']);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.progress_kind, 'delivery');
});

test('判断不了（像进展又像新原话）→ 回一句问她，**不**回退去当新原话解析', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  let parsed = 0;
  const { service, replies, threads } = makeHarness({
    gateway, recognizer: { parseSalesText: async () => { parsed += 1; throw new Error('不应该走到 AI'); } },
  });
  await bindThread(threads, 'omt_sale_9');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_ambiguous', threadId: 'omt_sale_9', text: '收到微信 500，再记一双 66356 黑 42',
  }));
  await flushSalesTasks(service);

  assert.equal(parsed, 0, '判不清也不许把它当新原话送进 AI');
  assert.deepEqual(gateway.created, [], '判不清时一个字都不写');
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.equal(textReply.data.reply_in_thread, true);
  assert.match(JSON.parse(textReply.data.content).text, /收款进展/);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.progress_kind, 'ambiguous');
});

test('超出待收金额 → 大声拒绝，不写收款（宁可多问一句，不能记错一笔钱）', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] }); // 待收 800
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_sale_10');

  await service.acceptMessage(groupEvent({
    messageId: 'om_overpay', threadId: 'omt_sale_10', text: '收到微信 900',
  }));
  await flushSalesTasks(service);

  assert.deepEqual(gateway.created.filter((item) => item.key === 'paymentRecord'), []);
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.match(JSON.parse(textReply.data.content).text, /超过待收金额/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 没有话题上下文 → 不走二次处理（原来是"私聊回归"，已按 ⓐ 迁到群入口）
//
// 🔴 2026-10-07「私聊链路移除」：私聊入口已整体删除，断言改成群入口那条
//    **没有话题上下文**的路 —— 它同样**没有绑定到某笔销售**，所以这句话不该被
//    当成"那笔的进展"，而应该照旧进 AI 当**新的销售原话**。
//    见 docs/private-chat-removal-decision-2026-10-07.md。
// ═══════════════════════════════════════════════════════════════════════════

test('群入口（主群、没有话题）：说「收到微信 500」**不走**二次处理 —— 仍然进 AI 当新的销售原话', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  let parsed = 0;
  const parsedResult = { intent: 'unsupported', items: [] };
  const { service } = makeHarness({
    gateway,
    recognizer: { parseSalesText: async () => { parsed += 1; return parsedResult; } },
  });

  // 主群（没有 thread_id）、不 @ 机器人：靠正文过闸门 —— 这条消息**没有**绑定到任何一笔销售。
  const accepted = await service.acceptMessage(groupEvent({ messageId: 'om_group_progressless', text: '收到微信 500' }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.mode, 'new');
  await flushSalesTasks(service);

  assert.equal(parsed, 1, '没有话题上下文 → 必须照旧进 AI（不受群聊的二次处理判据影响）');
  assert.deepEqual(gateway.created, [], '这条链路不会因为这句话写收款明细');
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.chat_type, 'group');
  assert.equal(task.sales_entry_record_id, '', '没有话题上下文 → 不绑定任何一笔销售');
  assert.equal(task.progress_kind, undefined, '没有定位到销售 → 不该记 progress_kind');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ BUG 修复：有「未收款」占位 → **翻它**（不新建）+ 写收款时间
// ═══════════════════════════════════════════════════════════════════════════

test('话题里说「收到微信 75」→ 把那条「未收款」翻成「已收款」（不新建、有收款时间、无残留）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 230, 履约状态: '已交付' } }],
    payments: [{ record_id: 'pay_pending', fields: { 关联销售单: [SALE_ID], 收款金额: 75, 收款状态: '未收款' } }],
  });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_sale_flip');

  await service.acceptMessage(groupEvent({
    messageId: 'om_flip', threadId: 'omt_sale_flip', text: '收到微信 75',
  }));
  await flushSalesTasks(service);

  // ① 不新建收款明细：她说的不是"又一笔钱"，而是那笔待收的钱到账了
  assert.deepEqual(gateway.created.filter((item) => item.key === 'paymentRecord'), [],
    '有待收款占位时必须翻它，不能另存一条已收款');

  // ② 原记录被翻成已收款，并写上收款时间 + 方式 + 方向
  const record = gateway.records.paymentRecord.find((row) => row.record_id === 'pay_pending');
  assert.equal(record.fields['收款状态'], '已收款');
  assert.equal(record.fields['收款金额'], 75);
  assert.deepEqual(record.fields['收款方式'], ['method_wechat']);
  assert.ok(record.fields['收款时间'], '必须写收款时间（她的口径：未收款变为已收款，并且有收款时间）');
  assert.equal(record.fields['交易方向'], '收入');

  // ③ 收款明细里不再有残留的「未收款」
  assert.equal(gateway.records.paymentRecord.filter((row) => row.fields['收款状态'] === '未收款').length, 0);

  // ④ 回复回到话题
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.equal(textReply.data.reply_in_thread, true);
});

test('多笔未收款占位 / 金额对不上 → 不猜、不写（与工作台补记收款同口径）', async () => {
  const twoPending = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 300, 履约状态: '已交付' } }],
    payments: [
      { record_id: 'pay_a', fields: { 关联销售单: [SALE_ID], 收款金额: 75, 收款状态: '未收款' } },
      { record_id: 'pay_b', fields: { 关联销售单: [SALE_ID], 收款金额: 75, 收款状态: '未收款' } },
    ],
  });
  const first = makeHarness({ gateway: twoPending });
  await bindThread(first.threads, 'omt_sale_multi');
  await first.service.acceptMessage(groupEvent({
    messageId: 'om_multi', threadId: 'omt_sale_multi', text: '收到微信 75',
  }));
  await flushSalesTasks(first.service);
  assert.deepEqual(twoPending.updated, [], '多条占位时一个字都不写，让她先人工核对');
  assert.match(JSON.parse(first.replies.find((i) => i.data.msg_type === 'text').data.content).text,
    /多条待收款/);

  const mismatch = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 300, 履约状态: '已交付' } }],
    payments: [{ record_id: 'pay_p', fields: { 关联销售单: [SALE_ID], 收款金额: 155, 收款状态: '未收款' } }],
  });
  const second = makeHarness({ gateway: mismatch });
  await bindThread(second.threads, 'omt_sale_mismatch');
  await second.service.acceptMessage(groupEvent({
    messageId: 'om_mismatch', threadId: 'omt_sale_mismatch', text: '收到微信 75',
  }));
  await flushSalesTasks(second.service);
  assert.deepEqual(mismatch.updated, [], '金额对不上占位记录时不写（一次收清口径）');
  assert.match(JSON.parse(second.replies.find((i) => i.data.msg_type === 'text').data.content).text,
    /一次收清/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ BUG 修复：「已完毕 / 成交」→ 不再静默，走成交（交付 + 收款）
// ═══════════════════════════════════════════════════════════════════════════

test('判据：「成交 / 已完毕 / 搞定 / 好了」是整单完成；带更具体线索时不降级', () => {
  const service = new SalesThreadProgressService({ gateway: makeGateway({ entry: threadSale() }) });
  assert.deepEqual(service.classify('成交'),
    { kind: PROGRESS_KINDS.COMPLETE, reason: 'complete_cue:成交' });
  assert.equal(service.classify('已完毕').kind, PROGRESS_KINDS.COMPLETE);
  assert.equal(service.classify('完毕').kind, PROGRESS_KINDS.COMPLETE);
  assert.equal(service.classify('搞定').kind, PROGRESS_KINDS.COMPLETE);
  assert.equal(service.classify('好了').kind, PROGRESS_KINDS.COMPLETE);
  // "好了"只是口头语：和收款 / 交付线索同现时仍按更具体的那件事处理
  assert.equal(service.classify('好了，收到微信 500').kind, PROGRESS_KINDS.PAYMENT);
  assert.equal(service.classify('好了，那双拿走了').kind, PROGRESS_KINDS.DELIVERY);
});

test('话题里说「成交」→ 放行 + 交给成交链路（同时交付+收款），不再静默', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 230, 履约状态: '未交付' } }],
    payments: [{ record_id: 'pay_pending', fields: { 关联销售单: [SALE_ID], 收款金额: 75, 收款状态: '未收款' } }],
  });
  const calls = [];
  const secondDelivery = {
    paymentMethodNames: async () => ['微信'],
    confirm: async (input) => {
      calls.push(input);
      return { alreadyCompleted: false, collectedAmount: 75, delivery: { deliveredQuantity: 1, failures: [] } };
    },
  };
  const { service, replies, threads } = makeHarness({ gateway, secondDelivery });
  await bindThread(threads, 'omt_sale_complete');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_complete', threadId: 'omt_sale_complete', text: '成交',
  }));
  assert.equal(accepted.handled, true, '「成交」必须被放行，不能再静默丢掉');
  await flushSalesTasks(service);

  // 成交只有一处实现：交给 SecondDeliveryService，本类不自己收钱 / 交货
  assert.equal(calls.length, 1);
  assert.equal(calls[0].salesEntryRecordId, SALE_ID);
  assert.equal(calls[0].method, '微信', '单一收款方式时用那一个（卡片单方式也只有这一个按钮）');
  assert.deepEqual(gateway.created.filter((item) => item.key === 'salesEntry'), [],
    '这是那笔的进展，不能新建销售主表记录');
  // 回复回到话题，并说清成交了什么
  const textReply = replies.find((item) => item.data.msg_type === 'text');
  assert.equal(textReply.data.reply_in_thread, true);
  assert.match(JSON.parse(textReply.data.content).text, /成交/);
  // 进展记在任务上（可排查）
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.progress_kind, 'complete');
});

test('话题里说「已完毕」→ 同样走成交链路（已成交时不重复写）', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  const calls = [];
  const secondDelivery = {
    paymentMethodNames: async () => ['微信'],
    confirm: async (input) => { calls.push(input); return { alreadyCompleted: true }; },
  };
  const { service, replies, threads } = makeHarness({ gateway, secondDelivery });
  await bindThread(threads, 'omt_sale_done');
  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_done', threadId: 'omt_sale_done', text: '已完毕',
  }));
  assert.equal(accepted.handled, true);
  await flushSalesTasks(service);
  assert.equal(calls.length, 1);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.progress_kind, 'complete');
  assert.match(JSON.parse(replies.find((i) => i.data.msg_type === 'text').data.content).text, /成交/);
});

test('话题里说「成交」但交付只成了一半 → 如实说，不报成功', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  const secondDelivery = {
    paymentMethodNames: async () => ['微信'],
    confirm: async () => ({
      alreadyCompleted: false, collectedAmount: 0,
      delivery: { deliveredQuantity: 1, failures: [{ detailRecordId: 'd_fail', error: '库存不足' }] },
    }),
  };
  const { service, replies, threads } = makeHarness({ gateway, secondDelivery });
  await bindThread(threads, 'omt_sale_partial');
  await service.acceptMessage(groupEvent({
    messageId: 'om_partial', threadId: 'omt_sale_partial', text: '成交',
  }));
  await flushSalesTasks(service);
  assert.match(JSON.parse(replies.find((i) => i.data.msg_type === 'text').data.content).text, /未完成/,
    '钱收下了、货没交齐不能报成"全好了"');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 业务负责人 2026-10-06 拍板（AGENTS.md 第 16 条）：问不出收款方式时
//    **不猜、也不设默认方式** —— 但「货那一半」要做掉，状态要如实。
// ═══════════════════════════════════════════════════════════════════════════
//
// 改动前的 bug：她说「已完毕」而系统问不出收款方式时，applyComplete 只回一句
// 「这笔钱是怎么收的？微信还是现金？」就 return —— **钱货都没动**，
// 而 handle 把它记成 `progress_applied`（看起来成功了，其实什么都没做）。

const multipleMethods = () => ({
  // 库里**有多个**收款方式 → "只有一个"那条不成立，也没有配任何默认方式。
  paymentMethodNames: async () => ['微信', '现金'],
  confirm: async () => { throw new Error('问不出方式时不该走进成交链路'); },
});

test('⭐ 「已完毕」问不出收款方式 → 先把货做掉、再回问一句钱，状态是 progress_asking（不是 applied）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    // 货还没交（预付单的样子）+ 有一笔待收款：钱货两件都有活。
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 实收金额: 800, 履约状态: '未交付' } }],
    payments: [{ record_id: 'pay_pending', fields: {
      关联销售单: [SALE_ID], 收款金额: 800, 收款状态: '未收款',
    } }],
  });
  const { service, replies, threads } = makeHarness({ gateway, secondDelivery: multipleMethods() });
  const delivered = [];
  service.delivery.deliver = async (input) => { delivered.push(input); return { ok: true }; };
  await bindThread(threads, 'omt_sale_ask');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_ask', threadId: 'omt_sale_ask', text: '已完毕',
  }));
  await flushSalesTasks(service);

  // ① 货那一半**做了**：未交付明细交给交付服务（它写「已交付」+ 扣库存）。
  assert.equal(delivered.length, 1, '不能"什么都不做"——货要先做掉');
  assert.equal(delivered[0].salesEntryRecordId, SALE_ID);
  assert.deepEqual(delivered[0].detailRecordIds, ['detail_1']);

  // ② 钱那一半**只回问一句**：不替她挑方式、不设默认方式、一个字节都不写。
  const text = JSON.parse(replies.find((i) => i.data.msg_type === 'text').data.content).text;
  assert.match(text, /这笔钱是怎么收的/, '要问她钱怎么收');
  assert.match(text, /已交付/, '要如实说货已经做掉了，不能让她以为啥也没干');
  assert.deepEqual(
    gateway.updated.filter((item) => item.key === 'paymentRecord'), [],
    '没说方式就不许动收款明细（不猜、也不设默认方式）',
  );
  assert.deepEqual(gateway.created.filter((item) => item.key === 'paymentRecord'), []);

  // ③ 🔴 **状态如实**：什么都没写钱 → 绝不能记成 progress_applied。
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, 'progress_asking', '只回问一句 → progress_asking，不是 progress_applied');
  assert.equal(task.progress_kind, 'complete');
  assert.equal(task.progress_reason, 'payment_method_missing');
});

test('⭐ 「已完毕」问不出方式且货早就交完了 → 只回问一句钱（不重复交付），状态仍是 progress_asking', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()], // 已交付
    payments: [{ record_id: 'pay_pending', fields: {
      关联销售单: [SALE_ID], 收款金额: 800, 收款状态: '未收款',
    } }],
  });
  const { service, replies, threads } = makeHarness({ gateway, secondDelivery: multipleMethods() });
  const delivered = [];
  service.delivery.deliver = async (input) => { delivered.push(input); return { ok: true }; };
  await bindThread(threads, 'omt_sale_ask2');

  await service.acceptMessage(groupEvent({
    messageId: 'om_ask2', threadId: 'omt_sale_ask2', text: '成交',
  }));
  await flushSalesTasks(service);

  assert.deepEqual(delivered, [], '没有未交付明细就不调交付（不能空跑一次扣库存）');
  assert.match(JSON.parse(replies.find((i) => i.data.msg_type === 'text').data.content).text,
    /这笔钱是怎么收的/);
});

test('⭐ 她说「成交 微信」→ 照她说的走成交链路（用户会主动说方式，这一条不变）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()],
    payments: [{ record_id: 'pay_pending', fields: {
      关联销售单: [SALE_ID], 收款金额: 800, 收款状态: '未收款',
    } }],
  });
  const calls = [];
  const secondDelivery = {
    paymentMethodNames: async () => ['微信', '现金'],
    confirm: async (input) => { calls.push(input); return { alreadyCompleted: false }; },
  };
  const { service, threads } = makeHarness({ gateway, secondDelivery });
  await bindThread(threads, 'omt_sale_spoken');

  await service.acceptMessage(groupEvent({
    messageId: 'om_spoken', threadId: 'omt_sale_spoken', text: '成交 微信',
  }));
  await flushSalesTasks(service);

  assert.equal(calls.length, 1, '她说了方式 → 走与点卡片「成交」同一个实现');
  assert.equal(calls[0].method, '微信', '用她说的那一个，不用库里排第一的那个');
});

test('⭐ 「收到 500」没说方式 → 只回问一句，状态同样是 progress_asking（同一类假成功）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()],
    payments: [{ record_id: 'pay_pending', fields: {
      关联销售单: [SALE_ID], 收款金额: 500, 收款状态: '未收款',
    } }],
  });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_sale_pay_ask');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_pay_ask', threadId: 'omt_sale_pay_ask', text: '收到 500',
  }));
  await flushSalesTasks(service);

  assert.match(JSON.parse(replies.find((i) => i.data.msg_type === 'text').data.content).text,
    /这笔钱是怎么收的/);
  assert.deepEqual(gateway.updated.filter((item) => item.key === 'paymentRecord'), []);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, 'progress_asking');
  assert.equal(task.progress_reason, 'payment_method_missing');
});

test('⭐ 她说的方式表里没有 → 只回问一句，状态 progress_asking（不记一笔没有方式的收款）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()],
    // 「收款方式管理」里只有现金：她说的是微信 → 核实不过。
    methods: [{ record_id: 'method_cash', fields: { 收款方式: '现金' } }],
    payments: [{ record_id: 'pay_pending', fields: {
      关联销售单: [SALE_ID], 收款金额: 500, 收款状态: '未收款',
    } }],
  });
  const { service, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_sale_pay_unknown');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_pay_unknown', threadId: 'omt_sale_pay_unknown', text: '收到微信 500',
  }));
  await flushSalesTasks(service);

  assert.deepEqual(gateway.created.filter((item) => item.key === 'paymentRecord'), []);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, 'progress_asking');
  assert.equal(task.progress_reason, 'payment_method_unknown');
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 2026-10-07「私聊链路移除」收尾：**没有群上下文 = 没有去处**
//
// 本类在群里回一句话走 `sendTextToTask`（生产由 `larkMvpService` 注入 → 回到那条销售话题）。
// 它的**缺省出口**原来的形状是 `options.sendText?.(task?.sender_open_id, message)`
// —— 也就是"偷偷发私聊"。收尾时**整体删除**（业务负责人拍板的 ⓐ：代码里一行私聊都不留）：
// 现在缺省 = 只记一条 `lark.private_chat.send_skipped`、返 `null`，一个远端调用都不做。
// ═══════════════════════════════════════════════════════════════════════════

// 与 saleLookupService.test.js 里那份同形：抓 warn 级结构化日志（logger warn → console.warn）。
const captureWarningLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
};

test('缺省出口：非群任务 → 不发、返 null、记 `send_skipped`；连 `options.sendText` 都不再被读取', async () => {
  // `options.sendText` 是改动前的 open_id 口径。故意把它传进来并记账：
  // 它**一次都不许被调**（"读不到才不发"和"根本没有这条代码"是两回事，这里钉的是后者）。
  const legacyOpenIdSends = [];
  const service = new SalesThreadProgressService({
    gateway: makeGateway({ entry: threadSale() }),
    sendText: (openId, message) => { legacyOpenIdSends.push({ openId, message }); },
  });
  const noChannelTask = { task_id: 't_no_channel', type: 'sale', sender_open_id: 'ou_sender' };

  const logs = captureWarningLogs();
  let returned;
  try {
    returned = await service.sendTextToTask(noChannelTask, '回你一句');
  } finally {
    logs.restore();
  }

  assert.equal(returned, null, '没有群上下文 → 明确返"没发出去"');
  assert.deepEqual(legacyOpenIdSends, [], 'ⓐ：open_id 口径的发送器已整体删除，不是"没配才不发"');
  const skipped = logs.events('lark.private_chat.send_skipped');
  assert.equal(skipped.length, 1, '可排查：不是静默失败');
  assert.match(skipped[0], /"kind":"text"/);
  assert.match(skipped[0], /"reason":"no_group_context"/);
});
