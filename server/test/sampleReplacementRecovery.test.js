// ⭐ 2026-10-07 ⓐ「私聊链路移除」：原来这里有一条「没注入端口时回落私聊」的用例。
//    私聊**发送出口已整体删除** —— 缺省出口现在**不发任何消息**，那条用例已改成
//    「缺省出口不发」+「任务感知端口照旧把卡片发出去」（见下面 ② 的两条）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SampleReplacementService } = require('../src/services/sampleReplacementService');

test('sample reminder remains refreshable when candidate lookup fails after stock deduction', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-recovery-')),
    idField: 'task_id' });
  let lookups = 0;
  const inventory = { sampleReplacementCandidates: async () => {
    lookups += 1;
    if (lookups === 1) throw new Error('尺码关联异常');
    return [{ size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }];
  } };
  const sentCards = [];
  const updatedCards = [];
  const service = new SampleReplacementService({
    gateway: { get: async () => ({ fields: { 货号: 'TEST-1' } }),
      table: () => ({ fields: { number: '货号' } }) },
    inventory, store: taskStore,
    sendCard: async (_openId, card) => { sentCards.push(card); return 'message_1'; },
    sendText: async () => {},
    // ⚠️ 私聊出口已随 2026-10-07 ⓐ 删除：缺省出口**不发**，所以这里必须注入
    //    **任务感知的出口**（生产上 `larkMvpService` 就是这么注入的）。
    //    本用例只关心"候选读取失败后还能刷新重试"，与发到哪个渠道无关。
    sendCardToTask: async (_task, card) => { sentCards.push(card); return 'message_1'; },
    updateCard: async (_task, _event, card) => { updatedCards.push(card); return true; },
  });
  const replacement = { salesDetailRecordId: 'detail_1', productRecordId: 'product_1',
    consumedLiveRecordIds: ['sold_sample'] };
  await service.notifySampleReplacements({ sampleReplacements: [replacement] }, 'operator_1');
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0].elements[0].content, /可选尺码暂时无法读取.*刷新重试/);
  const taskId = sentCards[0].elements.at(-1).actions[0].value.draft_id;
  assert.equal((await taskStore.get(taskId)).status, 'pending');
  assert.equal((await taskStore.get(taskId)).notice_sent, true);

  const response = await service.handleCardAction({ action: 'refresh_sample_replacement', draft_id: taskId },
    {}, 'operator_1');
  assert.equal(response.toast.content, '可选尺码已刷新');
  assert.match(updatedCards.at(-1).elements[0].content, /40码：门盒 1/);
  assert.equal(lookups, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 「把私聊专属的切出来」：补样品这条路的**发送出口**变成"任务感知的端口"
//
// 目标形态（业务负责人 2026-10-06：「后续就不走私聊了，你私聊的要切除出来」）：
//   service 只交"这是哪个任务"，**去哪发**由注入方（`larkMvpService` 的适配器）决定；
//   没有群上下文时回落私聊 —— 与改动前的 `sendCard(task.sender_open_id)` 逐字相同。
//
// ⚠️ 今天没有任何调用方注入这两个端口，所以下面第二条用例钉的就是**当前生产行为**：
//    默认回落分支必须还是"发给 task.sender_open_id"，一个字节都不能变。
// ─────────────────────────────────────────────────────────────────────────────

const seedCompletedTask = (taskStore, taskId, senderOpenId) => taskStore.create({
  task_id: taskId, type: 'sample_replacement', status: 'completed',
  sender_open_id: senderOpenId, product_number: 'TEST-1', result: { size: 40 },
});

const sampleGateway = { get: async () => ({ fields: {} }), table: () => ({ fields: {} }) };

test('② 卡片更新失败的兜底走**任务感知**出口：注入 sendCardToTask 时不再直接发给 open_id', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-port-')),
    idField: 'task_id' });
  await seedCompletedTask(taskStore, 'sample_port_1', 'ou_seller');

  const taskAware = [];
  const direct = [];
  const service = new SampleReplacementService({
    gateway: sampleGateway, store: taskStore,
    sendCard: async (openId, card) => { direct.push({ openId, card }); return 'om_direct'; },
    sendText: async () => {},
    updateCard: async () => false, // 卡片改不动 → 走兜底补发
    sendCardToTask: async (task, card) => { taskAware.push({ task, card }); return 'om_task_aware'; },
  });

  const response = await service.handleCardAction(
    { action: 'choose_sample_replacement', draft_id: 'sample_port_1', size: 40 },
    { context: { open_message_id: 'om_card_1' } },
    'ou_seller',
  );

  assert.equal(response.toast.content, '该样品已补选');
  assert.equal(taskAware.length, 1, '兜底必须走任务感知端口');
  assert.equal(taskAware[0].task.task_id, 'sample_port_1', '端口拿到的必须是**任务**，不是裸 open_id');
  assert.deepEqual(direct, [], '注入之后不许再绕过端口直接发给 open_id');
  assert.equal((await taskStore.get('sample_port_1')).card_message_id, 'om_task_aware');
});

test('② 缺省出口（没注入任务感知端口）**不发任何消息** —— 私聊出口已删除', async () => {
  const taskStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-port-default-')),
    idField: 'task_id' });
  await seedCompletedTask(taskStore, 'sample_port_2', 'ou_seller');

  const direct = [];
  const service = new SampleReplacementService({
    gateway: sampleGateway, store: taskStore,
    sendCard: async (openId, card) => { direct.push({ openId, card }); return 'om_direct'; },
    sendText: async () => {},
    updateCard: async () => false,
  });

  await service.handleCardAction(
    { action: 'choose_sample_replacement', draft_id: 'sample_port_2', size: 40 },
    { context: { open_message_id: 'om_card_2' } },
    'ou_seller',
  );

  // 2026-10-07 ⓐ：全仓**再也没有**"缺省回落发私聊"这条兜底。
  assert.deepEqual(direct, [], '缺省出口一条消息都不许发（私聊落点已删除）');
  assert.equal((await taskStore.get('sample_port_2')).status, 'completed',
    '补选本身照旧生效（发不发得出去是另一件事）');
});
