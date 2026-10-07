/**
 * ⭐ 「触发入口只留卡片按钮：说话不再触发」（2026-10-08）的验收测试。
 *
 * 业务负责人的口径（逐字，见 docs/todo-trigger-only-by-card-button.md）：
 *   「二选一时她选：**「乙 只留按钮：说话不再触发了」**」
 *   「针对我们有**二次的**（比方说**现货待收**的，还有我们**预付**的），**都需要切换到消息卡片里面**。
 *    在消息卡片里面**一点击，货和钱都按照这个逻辑处理**。」
 *
 * 验收标准（AC-1…AC-8，逐条对应见 docs/sales-text-trigger-off-card-only-2026-10-08.md 第 2 节）：
 *   □ AC-1 说话命中 payment / delivery / complete 词 → **零写库**（不交付、不扣库存、不记收款、不改状态）
 *   □ AC-2 改成回一句**配置里的提示**，不静默；回话仍回到那条话题（reply_in_thread）
 *   □ AC-3 幂等友好：**同一话题短时间内只说一次**（不刷屏），抑制也留可排查日志
 *   □ AC-4 显式开关 `SALES_PROGRESS_TEXT_TRIGGER_ENABLED`（默认 false）；=true 时**旧行为逐字恢复**
 *   □ AC-5 `ambiguous` / 认不出的既有回话**一个字节不变**
 *   □ AC-6 点【确认成交】卡片按钮 → **照常**走完整链路（钱 + 货），开关一个字不影响它
 *   □ AC-7 配置先行：词表与判据代码保留；文案 / 窗口 / 开关都在 config；`.env.example` 与默认值一致
 *   □ AC-8 状态如实：只回一句提示的任务**不是** `progress_applied`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  PROGRESS_KINDS,
  PROGRESS_TASK_STATUS,
  SALES_PROGRESS_INTAKE_DEFAULTS,
  resolveSalesProgressIntakeConfig,
} = require('../src/config/salesProgressIntake');
const { SALES_CONFIRM_DEAL_ACTIONS } = require('../src/config/salesConfirmDeal');

const CHAT_ID = 'oc_test_group';
const SALE_ID = 'entry_thread';
const NOTICE_DEFAULT = '这单请在卡片上的【确认成交】点一下～';

const tempStore = (prefix = 'text-trigger-off-') =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

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
      v1: { message: { patch: async () => ({ code: 0, data: {} }) } },
    },
  };
  return { client, replies };
};

/** 假 Base：语义键 → 中文字段名（与真 gateway 落库口径一致）；每一次写都记账。 */
const makeGateway = ({ entry, details = [], payments = [], methods = [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }] } = {}) => {
  const records = { salesEntry: entry ? [entry] : [], salesDetail: details, paymentRecord: payments, paymentMethod: methods };
  const created = [];
  const updated = [];
  const gateway = {
    records, created, updated,
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
  fields: { 销售单号: 'XSD-20261008-0001', 资金状态: '已写入', 确认状态: '已确认' },
});
const threadDetail = () => ({
  record_id: 'detail_1',
  fields: { 销售单号: [SALE_ID], 成交金额: 800, 履约状态: '已交付' },
});

const makeHarness = ({ gateway, secondDelivery, config } = {}) => {
  const { client, replies } = makeClient();
  const threads = new SalesGroupThreadLocator({ store: tempStore('text-trigger-off-threads-') });
  const noticeStore = tempStore('text-trigger-off-notices-');
  const service = new LarkMvpService({
    client,
    gateway: gateway || makeGateway({ entry: threadSale(), details: [threadDetail()] }),
    posting: {},
    recognizer: { parseSalesText: async () => { throw new Error('进展消息不该送进 AI'); } },
    store: tempStore('text-trigger-off-tasks-'),
    botOpenId: 'ou_test_bot',
    salesGroupThreads: threads,
    salesProgressNoticeStore: noticeStore,
    secondDelivery,
    // ⚠️ 显式给"没配任何环境变量"的默认配置：本次的默认就是**说话不再触发**。
    //    这样也钉住"默认值"本身，不受跑测试的进程环境干扰。
    threadProgressConfig: config || resolveSalesProgressIntakeConfig({ env: {} }),
    groupPurchaseFlow: { handleGroupPurchaseMessage: async () => ({ resolved: false, reason: 'stub' }) },
  });
  service.acknowledgeMessage = async () => undefined;
  return { service, replies, threads, noticeStore };
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

const textReplies = (replies) => replies.filter((item) => item.data.msg_type === 'text')
  .map((item) => ({ text: JSON.parse(item.data.content).text, reply: item }));

/** 抓结构化日志（info → stdout、warn → stderr），只旁听、照样转发。 */
const captureLogs = async (fn) => {
  const lines = [];
  const patch = (stream) => {
    const original = stream.write;
    stream.write = function write(chunk, ...rest) {
      const text = String(chunk);
      if (text.includes('"event"')) lines.push(text);
      return original.apply(stream, [chunk, ...rest]);
    };
    return () => { stream.write = original; };
  };
  const restoreOut = patch(process.stdout);
  const restoreErr = patch(process.stderr);
  try { return { value: await fn(), logs: lines.join('') }; } finally { restoreOut(); restoreErr(); }
};
const logEvents = (logs, event) => String(logs || '').split('\n')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((line) => line && line.event === event);

const zeroBusinessWrites = (gateway) => {
  assert.deepEqual(gateway.created, [], '说话不许写业务表（create）');
  assert.deepEqual(gateway.updated, [], '说话不许写业务表（update）');
};

// ═══════════════════════════════════════════════════════════════════════════
// 一、默认（开关关）：说话零写库 + 只回配置里那句提示
// ═══════════════════════════════════════════════════════════════════════════

test('AC-1/AC-2/AC-8：说「那双拿走了」→ 不交付、不扣库存、只回提示，状态是 progress_notice', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 成交金额: 800, 履约状态: '未交付' } }],
  });
  const { service, replies, threads } = makeHarness({ gateway });
  service.delivery.deliver = async () => { throw new Error('说话不该走交付（扣库存）'); };
  await bindThread(threads, 'omt_off_delivery');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_off_delivery', threadId: 'omt_off_delivery', text: '那双拿走了',
  }));
  assert.equal(accepted.handled, true, '仍然归"二次处理"（不回退去当新原话）');
  await flushSalesTasks(service);

  zeroBusinessWrites(gateway);
  const texts = textReplies(replies);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, NOTICE_DEFAULT, '回的就是配置里那句提示（逐字）');
  assert.equal(texts[0].reply.data.reply_in_thread, true, '提示回到那条销售话题');

  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, PROGRESS_TASK_STATUS.NOTICE, '状态如实：不是 progress_applied');
  assert.equal(task.progress_kind, PROGRESS_KINDS.DELIVERY);
});

test('AC-1/AC-2：说「收到微信 500」→ 不记收款（连那条「未收款」都不动），只回提示', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()],
    payments: [{ record_id: 'pay_pending', fields: { 关联销售单: [SALE_ID], 收款金额: 500, 收款状态: '未收款' } }],
  });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_off_payment');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_off_payment', threadId: 'omt_off_payment', text: '收到微信 500',
  }));
  await flushSalesTasks(service);

  zeroBusinessWrites(gateway);
  assert.equal(gateway.records.paymentRecord[0].fields['收款状态'], '未收款', '说话不许翻收款状态');
  assert.equal(textReplies(replies).map((item) => item.text).join('|'), NOTICE_DEFAULT);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, PROGRESS_TASK_STATUS.NOTICE);
  assert.equal(task.progress_kind, PROGRESS_KINDS.PAYMENT);
});

test('AC-1/AC-2：说「成交」/「已完毕」→ 不交付、不收款、不扣库存，只回提示', async () => {
  for (const text of ['成交', '已完毕']) {
    const gateway = makeGateway({
      entry: threadSale(),
      details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 成交金额: 800, 履约状态: '未交付' } }],
      payments: [{ record_id: 'pay_pending', fields: { 关联销售单: [SALE_ID], 收款金额: 800, 收款状态: '未收款' } }],
    });
    const calls = [];
    const secondDelivery = {
      paymentMethodNames: async () => ['微信'],
      confirm: async (input) => { calls.push(input); return { alreadyCompleted: false }; },
    };
    const { service, replies, threads } = makeHarness({ gateway, secondDelivery });
    service.delivery.deliver = async () => { throw new Error('说话不该走交付（扣库存）'); };
    await bindThread(threads, `omt_off_complete_${text}`);

    const accepted = await service.acceptMessage(groupEvent({
      messageId: `om_off_complete_${text}`, threadId: `omt_off_complete_${text}`, text,
    }));
    await flushSalesTasks(service);

    assert.deepEqual(calls, [], `「${text}」不许走成交链路`);
    zeroBusinessWrites(gateway);
    assert.equal(textReplies(replies).map((item) => item.text).join('|'), NOTICE_DEFAULT);
    const task = await service.store.get(accepted.sales.taskId);
    assert.equal(task.status, PROGRESS_TASK_STATUS.NOTICE);
    assert.equal(task.progress_kind, PROGRESS_KINDS.COMPLETE);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、AC-3 不刷屏：同一话题短时间内只说一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-3：同一话题里重复说（语音输入重发）→ 提示只回一次，第二次只留抑制日志', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_no_spam');

  const { logs } = await captureLogs(async () => {
    for (const messageId of ['om_spam_1', 'om_spam_2']) {
      await service.acceptMessage(groupEvent({
        messageId, threadId: 'omt_no_spam', text: '收到微信 500',
      }));
      await flushSalesTasks(service);
    }
  });

  assert.equal(textReplies(replies).length, 1, '同一话题短时间内只回一次提示（不刷屏）');
  assert.equal(textReplies(replies)[0].text, NOTICE_DEFAULT);
  const suppressed = logEvents(logs, 'sales.thread_progress.notice_suppressed');
  assert.equal(suppressed.length, 1, '被抑制的那次也要留一条可排查日志');
  assert.equal(suppressed[0].sales_entry_record_id, SALE_ID);
  assert.equal(suppressed[0].progress_kind, 'payment');
  zeroBusinessWrites(gateway);
});

test('AC-3：过了去重窗口后再说 → 再提示一次（窗口可配）', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  let clock = 1_000_000;
  const { service, replies, threads } = makeHarness({
    gateway,
    config: resolveSalesProgressIntakeConfig({ env: {}, textNoticeWindowMs: 60_000 }),
  });
  service.threadProgress.now = () => new Date(clock);
  await bindThread(threads, 'omt_window');

  await service.acceptMessage(groupEvent({ messageId: 'om_win_1', threadId: 'omt_window', text: '收到微信 500' }));
  await flushSalesTasks(service);
  clock += 61_000;
  await service.acceptMessage(groupEvent({ messageId: 'om_win_2', threadId: 'omt_window', text: '收到微信 500' }));
  await flushSalesTasks(service);

  assert.equal(textReplies(replies).length, 2, '过了窗口就不算刷屏，该提醒要再提醒');
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、AC-4 开关：显式布尔；打开 = 旧行为逐字恢复
// ═══════════════════════════════════════════════════════════════════════════

test('AC-4：开关解析是显式布尔（空串 = 没配 = 默认 false；非法值当场抛）', () => {
  assert.equal(SALES_PROGRESS_INTAKE_DEFAULTS.textTrigger, false, '默认 = 说话不再触发（只留按钮）');
  assert.equal(resolveSalesProgressIntakeConfig({ env: {} }).textTrigger, false);
  assert.equal(resolveSalesProgressIntakeConfig({ env: { SALES_PROGRESS_TEXT_TRIGGER_ENABLED: '' } }).textTrigger, false);
  assert.equal(resolveSalesProgressIntakeConfig({ env: { SALES_PROGRESS_TEXT_TRIGGER_ENABLED: 'true' } }).textTrigger, true);
  assert.equal(resolveSalesProgressIntakeConfig({ env: { SALES_PROGRESS_TEXT_TRIGGER_ENABLED: 'off' } }).textTrigger, false);
  assert.throws(() => resolveSalesProgressIntakeConfig({ env: { SALES_PROGRESS_TEXT_TRIGGER_ENABLED: 'maybe' } }),
    /SALES_PROGRESS_TEXT_TRIGGER_ENABLED/);
  // 提示文案与去重窗口也在配置里（可配，逻辑里不写死）
  assert.equal(resolveSalesProgressIntakeConfig({ env: {} }).replies.textNotice, NOTICE_DEFAULT);
  assert.equal(resolveSalesProgressIntakeConfig({ env: { SALES_PROGRESS_TEXT_NOTICE: '点卡片' } }).replies.textNotice, '点卡片');
  assert.equal(resolveSalesProgressIntakeConfig({ env: {} }).textNoticeWindowMs, 300_000);
});

test('AC-4：开关打开（textTrigger=true）→ 旧行为逐字恢复：说话照样记收款', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [threadDetail()],
    payments: [{ record_id: 'pay_pending', fields: { 关联销售单: [SALE_ID], 收款金额: 500, 收款状态: '未收款' } }],
  });
  const { service, replies, threads } = makeHarness({
    gateway, config: resolveSalesProgressIntakeConfig({ env: {}, textTrigger: true }),
  });
  await bindThread(threads, 'omt_on_payment');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_on_payment', threadId: 'omt_on_payment', text: '收到微信 500',
  }));
  await flushSalesTasks(service);

  const record = gateway.records.paymentRecord.find((row) => row.record_id === 'pay_pending');
  assert.equal(record.fields['收款状态'], '已收款', '开关打开 = 旧行为：未收款 → 已收款');
  assert.ok(record.fields['收款时间'], '并且写收款时间');
  assert.equal(gateway.updated.filter((item) => item.key === 'paymentRecord').length, 1);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.status, PROGRESS_TASK_STATUS.APPLIED, '旧行为：真的写库 → progress_applied');
  assert.ok(!textReplies(replies).some((item) => item.text === NOTICE_DEFAULT), '打开时不该再回提示');
});

test('AC-4：开关打开 → 说「成交」照样走成交链路（不是新造一套）', async () => {
  const gateway = makeGateway({
    entry: threadSale(),
    details: [{ record_id: 'detail_1', fields: { 销售单号: [SALE_ID], 成交金额: 800, 履约状态: '未交付' } }],
  });
  const calls = [];
  const secondDelivery = {
    paymentMethodNames: async () => ['微信'],
    confirm: async (input) => { calls.push(input); return { alreadyCompleted: false, collectedAmount: 0, delivery: { deliveredQuantity: 1, failures: [] } }; },
  };
  const { service, threads } = makeHarness({
    gateway, secondDelivery, config: resolveSalesProgressIntakeConfig({ env: {}, textTrigger: true }),
  });
  await bindThread(threads, 'omt_on_complete');

  await service.acceptMessage(groupEvent({ messageId: 'om_on_complete', threadId: 'omt_on_complete', text: '成交' }));
  await flushSalesTasks(service);

  assert.equal(calls.length, 1, '开关打开 = 旧行为：交给 SecondDeliveryService 成交');
  assert.equal(calls[0].salesEntryRecordId, SALE_ID);
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、AC-5 判不清 / 认不出：既有回话一个字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-5：判不清（像进展又像新原话）→ 仍然回既有那句问话，**不**换成提示、零写库', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  let parsed = 0;
  const { service, replies, threads } = makeHarness({ gateway });
  service.recognizer = { parseSalesText: async () => { parsed += 1; throw new Error('判不清也不许送 AI'); } };
  await bindThread(threads, 'omt_ambiguous_off');

  const accepted = await service.acceptMessage(groupEvent({
    messageId: 'om_ambiguous_off', threadId: 'omt_ambiguous_off', text: '收到微信 500，再记一双 66356 黑 42',
  }));
  await flushSalesTasks(service);

  assert.equal(parsed, 0);
  zeroBusinessWrites(gateway);
  const texts = textReplies(replies);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, SALES_PROGRESS_INTAKE_DEFAULTS.replies.ambiguous, '还是原来那句"问清楚"');
  assert.notEqual(texts[0].text, NOTICE_DEFAULT);
  const task = await service.store.get(accepted.sales.taskId);
  assert.equal(task.progress_kind, PROGRESS_KINDS.AMBIGUOUS);
  assert.equal(task.status, PROGRESS_TASK_STATUS.ASKED_UNKNOWN);
});

test('AC-5：说「收到微信」（没说多少钱）→ 仍然是既有那句问话', async () => {
  const gateway = makeGateway({ entry: threadSale(), details: [threadDetail()] });
  const { service, replies, threads } = makeHarness({ gateway });
  await bindThread(threads, 'omt_amount_missing');

  await service.acceptMessage(groupEvent({
    messageId: 'om_amount_missing', threadId: 'omt_amount_missing', text: '收到微信',
  }));
  await flushSalesTasks(service);

  zeroBusinessWrites(gateway);
  assert.equal(textReplies(replies)[0].text, SALES_PROGRESS_INTAKE_DEFAULTS.replies.ambiguous);
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、AC-6 卡片按钮：默认（开关关）下照常走完整链路（不许回退）
// ═══════════════════════════════════════════════════════════════════════════

const ENTRY_ID = 'order_click';

const clickSeed = ({ owed = 260, fulfillmentStatus = '未交付' } = {}) => ({
  behavior: [{ record_id: 'behavior_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } }],
  paymentMethod: [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }],
  sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
  product: [{ record_id: 'product_1', fields: { 编号: 'P1', 货号: 'P1' } }],
  salesEntry: [{ record_id: ENTRY_ID, fields: {
    资金状态: '已写入', 销售单号: 'XSD-1', 交易类型: ['behavior_cash'],
  } }],
  salesDetail: [{ record_id: 'd_1', fields: {
    销售单号: [ENTRY_ID], 编号: ['product_1'], 尺码: ['size_40'],
    履约状态: fulfillmentStatus, 成交金额: 260,
  } }],
  paymentRecord: owed > 0
    ? [{ record_id: 'pay_pending', fields: { 关联销售单: [ENTRY_ID], 收款金额: owed, 收款状态: '未收款' } }]
    : [],
});

/** 按 `{ 语义表名: [记录] }` 的种子建假 Base（与上面 `makeGateway` 同口径，只是入参形状不同）。 */
const seedGateway = (seed = {}) => {
  const records = {};
  const created = [];
  const updated = [];
  const gateway = {
    records, created, updated,
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
      const recordId = `rec_${key}_${(records[key] || []).length + 1}`;
      if (!records[key]) records[key] = [];
      records[key].push({ record_id: recordId, fields });
      created.push({ key, recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      updated.push({ key, id, values });
      const record = (records[key] || []).find((row) => row.record_id === id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      for (const [semantic, value] of Object.entries(values)) {
        record.fields[V1_BITABLE_SCHEMA.tables[key].fields[semantic]] = value;
      }
      return record;
    },
  };
  for (const [key, rows] of Object.entries(seed)) {
    records[key] = rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }));
  }
  return gateway;
};

const clickHarness = () => {
  const seed = clickSeed();
  const gateway = seedGateway(seed);
  const inventory = {
    applySaleCalls: [],
    applySale: async (input) => { inventory.applySaleCalls.push(input); return { productRecordId: input.productRecordId, sampleConsumedQuantity: 0, consumedLiveRecordIds: [] }; },
    getSaleResult: async () => null,
  };
  const { client } = makeClient();
  const store = tempStore('text-trigger-off-click-');
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const secondDelivery = new SecondDeliveryService({ gateway, delivery, store: tempStore('text-trigger-off-2nd-'), chatId: '' });
  const service = new LarkMvpService({
    client, gateway, store,
    references: new V1ReferenceResolver(gateway),
    recognizer: {}, posting: {},
    delivery, secondDelivery,
    purchaseBatchLocatorStore: tempStore('text-trigger-off-locator-'),
    salesGroupThreadStore: tempStore('text-trigger-off-thread-'),
    salesProgressNoticeStore: tempStore('text-trigger-off-click-notices-'),
    salesMessageLinks: { rememberFromSend: async (input) => ({ record: input }) },
  });
  return { service, gateway, inventory, store };
};

test('AC-6：点【确认成交】（默认开关关）→ 照常 待收→已收 + 未交付→已交付 + 扣库存', async () => {
  const { service, gateway, inventory, store } = clickHarness();
  await store.create({
    task_id: 'sale_click', type: 'sale', status: 'posted',
    sender_open_id: 'ou_1', sales_entry_record_id: ENTRY_ID,
    chat_type: 'group', chat_id: CHAT_ID, message_id: 'om_trigger', card_message_id: 'om_card',
    draft: {
      items: [{ trade_type_code: 'SALE_CASH', trade_type: '现货', size: 40, quantity: 1,
        actual_amount: 260, product_record_id: 'product_1', item_no: 'P1' }],
      payments: [], agreed_total: 260, owed: 260,
    },
    posting_result: { sourceNo: 'XSD-1', detailRecordIds: ['d_1'] },
  });

  const before = Date.now();
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    context: { open_message_id: 'om_card' },
    action: { value: {
      action: SALES_CONFIRM_DEAL_ACTIONS.CONFIRM,
      draft_id: 'sale_click',
      sales_entry_record_id: ENTRY_ID,
    } },
  });

  const receipt = gateway.records.paymentRecord.find((row) => row.record_id === 'pay_pending');
  assert.equal(receipt.fields['收款状态'], '已收款', '卡片按钮照常补收款');
  assert.ok(Number(receipt.fields['收款时间']) >= before, '照常写收款时间');
  assert.equal(gateway.records.salesDetail[0].fields['履约状态'], '已交付', '卡片按钮照常交付');
  assert.equal(inventory.applySaleCalls.length, 1, '卡片按钮照常扣库存');
  assert.equal(result.toast.type, 'success');
  assert.match(result.toast.content, /成交/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、AC-7 配置先行：词表与判据代码保留 + `.env.example` 与默认值一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7：词表与判据代码保留 —— 开关关着也照样判得出钱 / 货 / 成交', async () => {
  const { service } = makeHarness({});
  assert.equal(service.threadProgress.classify('收到微信 500').kind, PROGRESS_KINDS.PAYMENT);
  assert.equal(service.threadProgress.classify('那双拿走了').kind, PROGRESS_KINDS.DELIVERY);
  assert.equal(service.threadProgress.classify('成交').kind, PROGRESS_KINDS.COMPLETE);
  assert.equal(SALES_PROGRESS_INTAKE_DEFAULTS.textTrigger, false, '默认关 —— 将来恢复只翻这一个开关');
});

test('AC-7：`.env.example` 里那三个键与配置默认值逐字一致（忘了写文档 → 红）', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const documented = new Map(envExample.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

  assert.equal(documented.get('SALES_PROGRESS_TEXT_TRIGGER_ENABLED'), 'false');
  assert.equal(documented.get('SALES_PROGRESS_TEXT_NOTICE'), NOTICE_DEFAULT);
  assert.equal(documented.get('SALES_PROGRESS_TEXT_NOTICE_WINDOW_MS'), '300000');
});
