/**
 * ①「消息深链」的验收：**发消息那一刻**存下来，存到**两处**。
 *
 * 业务负责人 2026-10-06 逐字确认的口径：
 *   「我们现在不需要历史消息的补拉了。我们只要后续的消息能够取回来就行」
 *   「我在多维表格的销售主表里加了一列叫做**消息链接**，可以写入这里～」
 *
 * 这份用例盯的就是这几条（不是实现细节）：
 *   □ 链接来源只有一处 —— 发送响应 `data.message_app_link`（poster 实测：历史消息取不回来）；
 *   □ 存两处：本地路由映射 `data/sales_group_threads` ＋ 销售主表「消息链接」列；
 *   □ 存的是**我们回复的那条（卡片）消息**的链接（话题根是她发的，我们拿不到它的链接）；
 *   □ 老单 / 拿不到链接 → **留空**，绝不自己拼一条 URL；
 *   □ 写表失败 / 字段没同步 → 只告警，**绝不让已经发出去的卡片判失败**；
 *   □ 私聊那条路一个字节都不变（不写映射、不写表）。
 */
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SalesGroupThreadLocator, messageKey } = require('../src/services/salesGroupThreadLocator');
const {
  SalesMessageLinkService, MESSAGE_LINK_FIELD_KEY, BITABLE_URL_FIELD_TYPE,
} = require('../src/services/salesMessageLinkService');

const APP_LINK = 'https://applink.feishu.cn/client/message/link?openChatId=oc_1&message_id=om_reply_1';

const tempStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

/** 假网关：只实现本链路要用的三个面（表配置 / 更新记录 / 读字段元数据）。 */
const fakeGateway = ({ fieldType = 1, hasField = true, updateError = null, fieldsError = null } = {}) => {
  const updates = [];
  const fields = hasField ? { messageLink: '消息链接' } : {};
  return {
    updates,
    table: (key) => (key === 'salesEntry' ? { tableName: '销售主表', fields } : {}),
    listFields: async () => {
      if (fieldsError) throw fieldsError;
      return hasField
        ? [{ field_name: '消息链接', type: fieldType, field_id: 'fld_link' }]
        : [{ field_name: '销售单号', type: 1, field_id: 'fld_no' }];
    },
    update: async (tableKey, recordId, semanticValues) => {
      if (updateError) throw updateError;
      updates.push({ tableKey, recordId, semanticValues });
      return { record_id: recordId };
    },
  };
};

const newLinkService = (gateway, locator) => new SalesMessageLinkService({
  locator: locator || new SalesGroupThreadLocator({ store: tempStore('sales-link-map-') }),
  gateway,
});

// ─────────────────────────────────────────────────────────────────────────────
// 一、发给谁：发送响应里才有链接
// ─────────────────────────────────────────────────────────────────────────────

test('replyMessage 把发送响应里的 message_app_link 一起交回来（历史消息取不回来）', async () => {
  const client = {
    im: {
      message: {
        reply: async () => ({
          code: 0,
          data: { message_id: 'om_reply_1', thread_id: 'omt_1', message_app_link: APP_LINK },
        }),
      },
    },
  };
  const service = new LarkMvpService({
    client,
    gateway: { table: () => ({}), listAll: async () => [], validateTables: async () => [] },
    posting: {}, recognizer: {},
    store: tempStore('sales-link-reply-'),
    botOpenId: 'ou_test',
    salesGroupThreads: new SalesGroupThreadLocator({ store: tempStore('sales-link-reply-map-') }),
  });

  const sent = await service.replyCardInThread('om_her_message', { header: {} });
  assert.equal(sent.messageId, 'om_reply_1');
  assert.equal(sent.threadId, 'omt_1');
  assert.equal(sent.appLink, APP_LINK, '链接只能在发送响应里拿到，必须原样带回给调用方');
});

test('发送响应里没有 message_app_link 时交回空串（不抛、不编）', async () => {
  const client = {
    im: { message: { reply: async () => ({ code: 0, data: { message_id: 'om_reply_2', thread_id: 'omt_2' } }) } },
  };
  const service = new LarkMvpService({
    client,
    gateway: { table: () => ({}), listAll: async () => [], validateTables: async () => [] },
    posting: {}, recognizer: {},
    store: tempStore('sales-link-nolink-'),
    botOpenId: 'ou_test',
    salesGroupThreads: new SalesGroupThreadLocator({ store: tempStore('sales-link-nolink-map-') }),
  });

  const sent = await service.replyCardInThread('om_her_message', { header: {} });
  assert.equal(sent.appLink, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、存哪儿：本地映射 + 销售主表「消息链接」
// ─────────────────────────────────────────────────────────────────────────────

test('存两处：本地映射写 app_link，销售主表「消息链接」写同一条链接', async () => {
  const gateway = fakeGateway({ fieldType: 1 });
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-both-') });
  const service = newLinkService(gateway, locator);

  const { record, storedInBitable } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', taskId: 'task_1', orderNo: 'XSD-1',
    messageId: 'om_her_message', threadId: 'omt_1', chatId: 'oc_1',
    replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });

  assert.equal(record.app_link, APP_LINK, '本地映射要留着它（机器人回查用）');
  assert.equal(record.thread_id, 'omt_1');
  assert.equal(storedInBitable, true);
  assert.deepEqual(gateway.updates, [{
    tableKey: 'salesEntry', recordId: 'sale_rec_1', semanticValues: { [MESSAGE_LINK_FIELD_KEY]: APP_LINK },
  }]);
});

test('存的是【我们回复的那条】消息（卡片消息）—— 链接指向它，它就在同一个话题里', async () => {
  const gateway = fakeGateway({ fieldType: 1 });
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-which-') });
  const service = newLinkService(gateway, locator);

  const { record } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', threadId: 'omt_1',
    replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });

  // 话题根（她发的那条）只作为路由 key 留着；**链接**挂在机器人那条回复上。
  assert.equal(record.message_id, 'om_her_message');
  assert.equal(record.reply_message_id, 'om_reply_1');
  assert.equal(record.app_link, APP_LINK);
});

test('「消息链接」是超链接列（type=15）时，写 {text, link}；文本列写字符串', async () => {
  const urlGateway = fakeGateway({ fieldType: BITABLE_URL_FIELD_TYPE });
  await newLinkService(urlGateway).writeToSalesEntry({
    salesEntryRecordId: 'sale_rec_url', url: APP_LINK, messageId: 'om_reply_1',
  });
  assert.deepEqual(urlGateway.updates[0].semanticValues[MESSAGE_LINK_FIELD_KEY], { text: APP_LINK, link: APP_LINK });

  const textGateway = fakeGateway({ fieldType: 1 });
  await newLinkService(textGateway).writeToSalesEntry({
    salesEntryRecordId: 'sale_rec_text', url: APP_LINK, messageId: 'om_reply_1',
  });
  assert.equal(textGateway.updates[0].semanticValues[MESSAGE_LINK_FIELD_KEY], APP_LINK);
});

test('字段元数据读不到时按字符串写（宁可写进去让她看见，也不因为读类型失败整条不写）', async () => {
  const gateway = fakeGateway({ fieldType: 1, fieldsError: new Error('appTableField.list 挂了') });
  await newLinkService(gateway).writeToSalesEntry({ salesEntryRecordId: 'sale_rec_x', url: APP_LINK });
  assert.equal(gateway.updates[0].semanticValues[MESSAGE_LINK_FIELD_KEY], APP_LINK);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、拿不到 / 写不进：留空 + 只告警（绝不伪造、绝不连累卡片）
// ─────────────────────────────────────────────────────────────────────────────

test('拿不到链接：本地映射照旧记，销售主表一个字段都不写（老单/飞书不回带时都是这条）', async () => {
  const gateway = fakeGateway();
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-empty-') });
  const service = newLinkService(gateway, locator);

  const { record, storedInBitable } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_old', messageId: 'om_her_message', threadId: 'omt_1',
    replyMessageId: 'om_reply_1', appLink: '',
  });

  assert.equal(record.app_link, '');
  assert.equal(storedInBitable, false);
  assert.equal(gateway.updates.length, 0, '拿不到就留空——绝不自己拼一条 URL');
});

test('后面那次发送没有链接时，不把先存下来的 app_link 覆盖成空（深链只补不清）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-merge-') });
  const service = newLinkService(fakeGateway(), locator);

  await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', threadId: 'omt_1',
    replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });
  // 同一笔销售的话题里又发了一条（回复正文），那次的响应没带链接 / 也没带话题 id
  const { record } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', replyMessageId: 'om_reply_2',
  });

  assert.equal(record.app_link, APP_LINK, '先存下来的链接不能被清掉');
  assert.equal(record.thread_id, 'omt_1', '话题 id 同理：只补不清');
});

test('字段还没同步（schema 里没有 messageLink）：不写表、只告警', async () => {
  const gateway = fakeGateway({ hasField: false });
  const service = newLinkService(gateway);
  const stored = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });
  assert.equal(stored.storedInBitable, false);
  assert.equal(gateway.updates.length, 0);
});

test('写表失败：不抛（卡片已经发出去了，绝不能因为写链接失败判失败）', async () => {
  const gateway = fakeGateway({ updateError: new Error('FieldNameNotFound') });
  const service = newLinkService(gateway);
  const result = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });
  assert.equal(result.storedInBitable, false);
  assert.equal(result.record.app_link, APP_LINK, '本地映射仍然记下了（本地那处是可靠的）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、接线：群里发卡片 → 两处都存；私聊一个字节都不变
// ─────────────────────────────────────────────────────────────────────────────

const wiredService = ({ chatType = 'group', appLink = APP_LINK } = {}) => {
  const updates = [];
  const gateway = {
    table: (key) => (key === 'salesEntry' ? { tableName: '销售主表', fields: { messageLink: '消息链接' } } : {}),
    listAll: async () => [],
    validateTables: async () => [],
    listFields: async () => [{ field_name: '消息链接', type: 1, field_id: 'fld_link' }],
    update: async (tableKey, recordId, semanticValues) => {
      updates.push({ tableKey, recordId, semanticValues });
      return { record_id: recordId };
    },
  };
  const client = {
    im: {
      message: {
        reply: async () => ({
          code: 0,
          data: { message_id: 'om_reply_1', thread_id: 'omt_1', ...(appLink ? { message_app_link: appLink } : {}) },
        }),
        create: async () => ({ code: 0, data: { message_id: 'om_private_1' } }),
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-wired-map-') });
  const service = new LarkMvpService({
    client, gateway, posting: {}, recognizer: {},
    store: tempStore('sales-link-wired-'),
    botOpenId: 'ou_test_bot',
    salesGroupThreads: locator,
    salesMessageLinks: new SalesMessageLinkService({ locator, gateway }),
  });
  return {
    service, updates, locator,
    task: {
      task_id: 'task_1', chat_type: chatType, chat_id: 'oc_1', message_id: 'om_her_message',
      sender_open_id: 'ou_her', sales_entry_record_id: 'sale_rec_1',
      posting_result: { sourceNo: 'XSD-1' },
    },
  };
};

test('群里发卡片：本地映射有 app_link，销售主表「消息链接」同步写上', async () => {
  const { service, updates, locator, task } = wiredService();
  await service.sendTaskCard(task, { header: {} });

  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.app_link, APP_LINK);
  assert.equal(record.sales_entry_record_id, 'sale_rec_1');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].tableKey, 'salesEntry');
  assert.equal(updates[0].recordId, 'sale_rec_1');
  assert.equal(updates[0].semanticValues[MESSAGE_LINK_FIELD_KEY], APP_LINK);
});

test('群里发卡片但飞书没回带链接：映射记下路由，销售主表不写', async () => {
  const { service, updates, locator, task } = wiredService({ appLink: '' });
  await service.sendTaskCard(task, { header: {} });
  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.app_link, '');
  assert.equal(updates.length, 0);
});

test('私聊任务：既不写本地映射、也不写销售主表（私聊这条路由不通它）', async () => {
  const { service, updates, locator, task } = wiredService({ chatType: 'private' });
  const messageId = await service.sendTaskCard(task, { header: {} });
  assert.equal(messageId, 'om_private_1');
  assert.equal(updates.length, 0);
  const all = await locator.store.list();
  assert.equal(all.length, 0, '私聊不该产生任何「话题 ↔ 销售」记录');
});

test('本地映射的 key 是「她那句话」的 message_id（后续引用/话题反查都靠它）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-key-') });
  const service = newLinkService(fakeGateway(), locator);
  await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });
  assert.ok(await locator.store.get(messageKey('om_her_message')));
  const found = await locator.findBySalesEntryRecordId('sale_rec_1');
  assert.equal(found.app_link, APP_LINK);
});
