const test = require('node:test');
const assert = require('node:assert/strict');
const { createLarkEventHandlers } = require('../src/routes/larkEvents');

test('authenticated card payload without a top-level token reaches the card service', async () => {
  let received;
  const service = {
    handleCardAction: async (event) => {
      received = event;
      return {};
    },
    sendText: async () => undefined,
  };
  const handlers = createLarkEventHandlers(service);
  const event = {
    operator: { operator_id: { open_id: 'ou_test' } },
    action: { value: { action: 'modify_sale', draft_id: 'rec_test' } },
  };

  const response = handlers['card.action.trigger'](event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，正在处理' } });
  assert.equal(received, event);
});

test('failed result-text delivery does not relabel a successful card action as posting failure', async () => {
  const messages = [];
  const handlers = createLarkEventHandlers({
    handleCardAction: async () => ({ toast: { type: 'success', content: '销售已确认' } }),
    sendText: async (_openId, message) => {
      messages.push(message);
      throw new Error('message delivery failed');
    },
  });
  handlers['card.action.trigger']({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_1' } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages, ['销售已确认']);
});
