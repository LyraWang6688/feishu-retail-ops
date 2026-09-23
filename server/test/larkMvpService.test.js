const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService, aggregateRecognizedItems } = require('../src/services/larkMvpService');

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mvp-test-')), idField: 'task_id' });

const makeService = () => {
  const sent = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {},
    references: {},
    posting: {},
    recognizer: {},
    store: makeStore(),
  });
  service.sendText = async (openId, message) => sent.push({ openId, message });
  service.processSalesTask = async () => undefined;
  return { service, sent };
};

test('private text is accepted as sales input and repeated message id is deduplicated', async () => {
  const { service } = makeService();
  const event = {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1000',
      content: JSON.stringify({ text: 'A100 38码一双，100元微信' }),
    },
  };
  const first = await service.acceptMessage(event);
  const second = await service.acceptMessage(event);
  assert.equal(first.accepted, true);
  assert.equal(first.type, 'sale');
  assert.equal(second.reason, 'duplicate');
});

test('group messages are ignored even when message content is valid', async () => {
  const { service } = makeService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'A100 38码一双' }),
    },
  });
  assert.deepEqual(result, { accepted: false, reason: 'not_p2p' });
});

test('purchase images are isolated by private-chat sender and wait for explicit completion', async () => {
  const { service, sent } = makeService();
  const imageEvent = (messageId, openId) => ({
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: messageId,
      chat_type: 'p2p',
      message_type: 'image',
      create_time: '1000',
      content: JSON.stringify({ image_key: `img_${messageId}` }),
    },
  });
  await service.acceptMessage(imageEvent('om_1', 'ou_1'));
  await service.acceptMessage(imageEvent('om_2', 'ou_1'));
  await service.acceptMessage(imageEvent('om_3', 'ou_2'));
  assert.match(sent[1].message, /第 2 张/);
  const user1 = await service.store.get(require('../src/services/larkMvpService').idFor('purchase_open', 'ou_1'));
  const user2 = await service.store.get(require('../src/services/larkMvpService').idFor('purchase_open', 'ou_2'));
  assert.equal(user1.images.length, 2);
  assert.equal(user2.images.length, 1);
});

test('recognized purchase items with same SKU and size are aggregated', () => {
  assert.deepEqual(
    aggregateRecognizedItems([
      { item_no: 'A100', color: '黑', size: 38, quantity: 1 },
      { item_no: 'A100', color: '黑', size: 38, quantity: 2 },
    ]),
    [{ item_no: 'A100', color: '黑', size: 38, quantity: 3 }]
  );
});
