'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOTIFICATION_TARGETS, NOTIFICATION_EVENTS, resolveNotification,
} = require('../src/config/notifications');
const { buildNotificationCard } = require('../src/services/notificationCard');
const { createNotificationService } = require('../src/services/notificationService');

test('通知目标只有 private/group；事件默认目标正确，且**没有单事件开关**', () => {
  assert.deepEqual(Object.keys(NOTIFICATION_TARGETS).sort(), ['group', 'private']);
  for (const [name, definition] of Object.entries(NOTIFICATION_EVENTS)) {
    assert.equal(definition.enabled, undefined, `${name} 不许有事件级 enabled 开关`);
    assert.equal(definition.masterEnv, undefined, `${name} 不许有事件级总开关字段`);
  }
  assert.equal(NOTIFICATION_EVENTS.async_job_failed.target, 'group');
  assert.equal(NOTIFICATION_EVENTS.observability_alert.target, 'private');
  assert.equal(NOTIFICATION_EVENTS.lark_event_heartbeat.target, 'private');
  assert.equal(NOTIFICATION_EVENTS.purchase_request_created.target, 'group');
  assert.equal(NOTIFICATION_EVENTS.voucher_settlement.target, 'group');
  assert.equal(NOTIFICATION_EVENTS.procurement_sales_link_backfill_failed.target, 'group');
});

test('resolveNotification：主 env / fallback / 缺失 / 未知事件（**单事件开关已移除**）', () => {
  const env = {
    NOTIFY_PRIVATE_OPEN_ID: 'ou_owner',
    NOTIFY_GROUP_CHAT_ID: '',
    PURCHASE_CHAT_ID: 'oc_group',
    // 旧开关即便被写成 false，也必须**不再生效**（事件被触发就发）
    NOTIFY_ASYNC_JOB_FAILED_ENABLED: 'false',
  };
  const group = resolveNotification('async_job_failed', env);
  assert.equal(group.reason, 'ok', '旧 NOTIFY_<EVENT>_ENABLED=false 不再关掉通知');
  assert.equal(group.receiveIdType, 'chat_id');
  assert.equal(group.receiveId, 'oc_group');
  assert.equal(group.sourceEnv, 'PURCHASE_CHAT_ID');

  // 观测告警不再有「事件默认关」：只要 private 目标配了就是 ok（功能级总开关在 alertMonitor 入口）。
  const privateTarget = resolveNotification('observability_alert', env);
  assert.equal(privateTarget.reason, 'ok');
  assert.equal(privateTarget.target, 'private');

  const missing = resolveNotification('async_job_failed', { ...env, PURCHASE_CHAT_ID: '' });
  assert.equal(missing.reason, 'target_missing');
  assert.equal(missing.enabled, true);

  const unknown = resolveNotification('nope', env);
  assert.equal(unknown.reason, 'unknown_event');
  assert.equal(unknown.enabled, false);
});

test('buildNotificationCard 是 Card JSON 2.0 + update_multi', () => {
  const card = buildNotificationCard('async_job_failed', { lines: ['第一行', '', '第二行'] });
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.body.elements[0].content, '**【异步写入失败】**');
  assert.deepEqual(card.body.elements.slice(1).map((item) => item.content), ['第一行', '第二行']);
});

const fakeClient = () => {
  const calls = [];
  return {
    calls,
    cardkit: { v1: { card: {
      create: async (payload) => { calls.push(['card.create', payload]); return { code: 0, data: { card_id: 'card_1' } }; },
      update: async (payload) => { calls.push(['card.update', payload]); return { code: 0 }; },
    } } },
    im: { v1: { message: {
      create: async (payload) => { calls.push(['message.create', payload]); return { code: 0, data: { message_id: 'msg_1' } }; },
    } } },
  };
};

test('send：CardKit 创建卡片实体 + interactive 消息引用 card_id', async () => {
  const client = fakeClient();
  const logs = [];
  const service = createNotificationService({
    client,
    resolve: () => ({ enabled: true, reason: 'ok', target: 'group', receiveIdType: 'chat_id',
      receiveId: 'oc_1', chatId: 'oc_1', openId: '', sourceEnv: 'PURCHASE_CHAT_ID' }),
    logger: { logInfo: (event, fields) => logs.push([event, fields]), logWarn: () => {} },
  });
  const result = await service.send('async_job_failed', { lines: ['x'] });
  assert.equal(result.ok, true);
  assert.equal(result.cardId, 'card_1');
  assert.equal(result.messageId, 'msg_1');
  const createPayload = client.calls.find(([kind]) => kind === 'card.create')[1];
  assert.equal(createPayload.data.type, 'card_json');
  assert.equal(JSON.parse(createPayload.data.data).schema, '2.0');
  const messagePayload = client.calls.find(([kind]) => kind === 'message.create')[1];
  assert.equal(messagePayload.params.receive_id_type, 'chat_id');
  assert.equal(messagePayload.data.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(messagePayload.data.content), { type: 'card', data: { card_id: 'card_1' } });
  assert.equal(logs.some(([event]) => event === 'notification.sent'), true);
});

test('send：目标缺失 / 不可发（未知事件等）只记 skipped，不创建卡片', async () => {
  const client = fakeClient();
  for (const resolution of [
    { enabled: false, reason: 'disabled', target: 'group' },
    { enabled: true, reason: 'target_missing', target: 'group' },
  ]) {
    const service = createNotificationService({
      client, resolve: () => resolution, logger: { logInfo: () => {}, logWarn: () => {} },
    });
    const result = await service.send('async_job_failed', { lines: ['x'] });
    assert.equal(result.ok, false);
  }
  assert.equal(client.calls.length, 0);
});

test('target 覆盖只换收件人，不能绕过 resolveNotification 的不可发判定', async () => {
  const client = fakeClient();
  const service = createNotificationService({
    client,
    resolve: () => ({ enabled: false, reason: 'disabled', target: 'group' }),
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  const result = await service.send('voucher_settlement', { lines: ['x'] }, {
    target: { receiveIdType: 'chat_id', receiveId: 'oc_override' },
  });
  assert.equal(result.ok, false, 'resolveNotification 判定不可发时，target 不能强行发');
  assert.equal(client.calls.length, 0);
});

test('update：用 CardKit card.update 编辑同一张卡', async () => {
  const client = fakeClient();
  const service = createNotificationService({
    client, resolve: () => ({ enabled: true, reason: 'ok', target: 'group' }),
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  const result = await service.update('async_job_failed', 'card_1', { lines: ['更新'] });
  assert.equal(result.ok, true);
  const payload = client.calls.find(([kind]) => kind === 'card.update')[1];
  assert.equal(payload.path.card_id, 'card_1');
  assert.equal(JSON.parse(payload.data.data).body.elements[1].content, '更新');
});


test('卡片可回复指定消息并进入话题（卡片格式）', async () => {
  const client = fakeClient();
  client.im.v1.message.reply = async (payload) => {
    client.calls.push(['message.reply', payload]);
    return { code: 0, data: { message_id: 'msg_reply' } };
  };
  const service = createNotificationService({
    client,
    resolve: () => ({ enabled: true, reason: 'ok', target: 'group', receiveIdType: 'chat_id', receiveId: 'oc_1' }),
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  const result = await service.send('async_job_failed', { lines: ['x'] }, {
    target: { receiveIdType: 'chat_id', receiveId: 'oc_1' },
    replyToMessageId: 'om_root', inThread: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'msg_reply');
  const reply = client.calls.find(([kind]) => kind === 'message.reply')[1];
  assert.equal(reply.path.message_id, 'om_root');
  assert.equal(reply.data.reply_in_thread, true);
  assert.equal(reply.data.msg_type, 'interactive');
  assert.equal(client.calls.some(([kind]) => kind === 'message.create'), false, '回复时不再另发顶层消息');
});


test('普通文本格式：purchase_request_created 发 text，并可回复进话题', async () => {
  const client = fakeClient();
  client.im.v1.message.reply = async (payload) => {
    client.calls.push(['message.reply', payload]);
    return { code: 0, data: { message_id: 'msg_text' } };
  };
  const service = createNotificationService({
    client,
    resolve: () => ({ enabled: true, reason: 'ok', target: 'group', receiveIdType: 'chat_id', receiveId: 'oc_1' }),
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  const result = await service.send('purchase_request_created', { text: '<at id=ou_1></at> 三星 这批 2 双' }, {
    target: { receiveIdType: 'chat_id', receiveId: 'oc_1' },
    replyToMessageId: 'om_root', inThread: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'text');
  const reply = client.calls.find(([kind]) => kind === 'message.reply')[1];
  assert.equal(reply.data.msg_type, 'text');
  assert.equal(reply.data.reply_in_thread, true);
  assert.equal(JSON.parse(reply.data.content).text.includes('三星'), true);
  assert.equal(client.calls.some(([kind]) => kind === 'message.create'), false);
});
