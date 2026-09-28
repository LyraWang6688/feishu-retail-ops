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
