/**
 * ①「消息深链」的验收：**发消息那一刻**存下来。
 *
 * 业务负责人 2026-10-06 逐字确认的口径：
 *   「我们现在不需要历史消息的补拉了。我们只要后续的消息能够取回来就行」
 *   「我在多维表格的销售主表里加了一列叫做**消息链接**，可以写入这里～」
 *
 * 🔴 **2026-10-09 口径变更（业务负责人）**：「当前这个状态下，现有的一些字段已经不太适配
 *    我们当前的决定了，也就是我们要用**扫码**」⇒ 她把「消息链接」那一列**从生产表删掉了**，
 *    代码同步**删映射 + 删写入点**（`config/v1BitableSchema.salesEntry` 段有完整记录）。
 *    ⇒ 本文件原来的"存两处"验收改成了"**只存本地一处**"：
 *
 * 这份用例现在盯的是这几条（不是实现细节）：
 *   □ 链接来源只有一处 —— 发送响应 `data.message_app_link`（poster 实测：历史消息取不回来）；
 *   □ 存**本地**路由映射 `data/sales_group_threads`：
 *       既是"她后面在话题里说话能不能被认出来"的判据，也是「9 点推送」那句
 *       「**查看原话**」深链的来源（`pendingDealPushService`）—— 这条功能没死；
 *   □ 存的是**我们回复的那条（卡片）消息**的链接（话题根是她发的，我们拿不到它的链接）；
 *   □ 老单 / 拿不到链接 → **留空**，绝不自己拼一条 URL；
 *   □ 🔴 **业务表一个字段都不写**（「消息链接」列已删）：方法 / 常量 / 导出都不许留下；
 *   □ 没有群上下文的任务一个字节都不写（不写映射、也不写表）。
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
  buildSalesThreadLink, resolveSalesThreadLinkTemplate, DEFAULT_SALES_THREAD_LINK_TEMPLATE,
} = require('../src/config/salesThreadLink');
const {
  SalesMessageLinkService,
} = require('../src/services/salesMessageLinkService');

const APP_LINK = 'https://applink.feishu.cn/client/message/link?openChatId=oc_1&message_id=om_reply_1';

const tempStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

/** 记录所有写库动作的假网关：本文件里它**只用来证明"一个字段都没写"**（updates 恒为空）。 */
const recordingGateway = () => {
  const updates = [];
  return {
    updates,
    table: () => ({ tableName: '销售主表', fields: {} }),
    listAll: async () => [],
    validateTables: async () => [],
    listFields: async () => [],
    update: async (tableKey, recordId, semanticValues) => {
      updates.push({ tableKey, recordId, semanticValues });
      return { record_id: recordId };
    },
  };
};

const newLinkService = (locator) => new SalesMessageLinkService({
  locator: locator || new SalesGroupThreadLocator({ store: tempStore('sales-link-map-') }),
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
// 二、存哪儿：**只剩本地映射**（业务表「消息链接」列 2026-10-09 已删）
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 2026-10-09「消息链接」列已删：写表那半（方法 / 常量 / 导出）一点都不留', () => {
  const module = require('../src/services/salesMessageLinkService');
  // 写入点本体
  assert.equal(SalesMessageLinkService.prototype.writeToSalesEntry, undefined,
    '「消息链接」列已被她删除 ⇒ 写它的方法必须一起删');
  // 为了写它才需要的"运行时读字段类型"
  assert.equal(SalesMessageLinkService.prototype.resolveMessageLinkFieldType, undefined);
  // 语义键与飞书超链接字段类型常量
  assert.equal(module.MESSAGE_LINK_FIELD_KEY, undefined);
  assert.equal(module.BITABLE_URL_FIELD_TYPE, undefined);
  // 构造函数不再需要网关（它原来只为写表而存在）
  assert.doesNotThrow(() => new SalesMessageLinkService({
    locator: new SalesGroupThreadLocator({ store: tempStore('sales-link-ctor-') }),
  }));
});

test('存本地映射：app_link 与话题深链都记下来（旧接口的 storedInBitable 已随写入点一起删）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-both-') });
  const service = newLinkService(locator);

  const result = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', taskId: 'task_1', orderNo: 'XSD-1',
    messageId: 'om_her_message', threadId: 'omt_1', chatId: 'oc_1',
    replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });

  assert.equal(result.record.app_link, APP_LINK, '本地映射要留着它（机器人回查 / 9 点推送用）');
  assert.equal(result.record.thread_id, 'omt_1');
  assert.equal(result.link, APP_LINK);
  assert.equal(result.linkSource, 'send_response');
  assert.equal('storedInBitable' in result, false,
    '业务表那一列已删 ⇒ 这个"写没写表"的字段没有意义，必须一起删');
});

test('存的是【我们回复的那条】消息（卡片消息）—— 链接指向它，它就在同一个话题里', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-which-') });
  const service = newLinkService(locator);

  const { record } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', threadId: 'omt_1',
    replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });

  // 话题根（她发的那条）只作为路由 key 留着；**链接**挂在机器人那条回复上。
  assert.equal(record.message_id, 'om_her_message');
  assert.equal(record.reply_message_id, 'om_reply_1');
  assert.equal(record.app_link, APP_LINK);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、拿不到链接：留空（绝不伪造）
// ─────────────────────────────────────────────────────────────────────────────

test('拿不到链接：本地映射照旧记，深链留空（老单/飞书不回带时都是这条）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-empty-') });
  const service = newLinkService(locator);

  const result = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_old', messageId: 'om_her_message', threadId: 'omt_1',
    replyMessageId: 'om_reply_1', appLink: '',
  });

  assert.equal(result.record.app_link, '');
  assert.equal(result.record.thread_link, '', 'chat_id 缺一个就不拼（两个 id 都在才拼）');
  assert.equal(result.link, '');
  assert.equal(result.linkSource, '');
});

test('后面那次发送没有链接时，不把先存下来的 app_link 覆盖成空（深链只补不清）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-merge-') });
  const service = newLinkService(locator);

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

// ─────────────────────────────────────────────────────────────────────────────
// 三点五、她给的话题深链格式（2026-10-06 真实样例）—— 今天真正管用的那条
// ─────────────────────────────────────────────────────────────────────────────

test('按她给的格式拼话题深链：两个 id 都在才拼，格式逐字对齐她的样例', () => {
  const url = buildSalesThreadLink({ chatId: 'oc_9f2cb1ff23ee442a5facbb1fc24ae1f9', threadId: 'omt_19a1212a17cf5cb7' });
  assert.equal(url,
    'https://applink.feishu.cn/client/thread/open'
    + '?open_chat_id=oc_9f2cb1ff23ee442a5facbb1fc24ae1f9&open_thread_id=omt_19a1212a17cf5cb7'
    + '&openchatid=oc_9f2cb1ff23ee442a5facbb1fc24ae1f9&openthreadid=omt_19a1212a17cf5cb7'
    + '&thread_position=-1');
  assert.match(url, /^https:\/\/applink\.feishu\.cn\/client\/thread\/open\?/);
});

test('缺任意一个 id → 空串（不猜、不用空值拼一条点开是别处的链接）', () => {
  assert.equal(buildSalesThreadLink({ chatId: '', threadId: 'omt_1' }), '');
  assert.equal(buildSalesThreadLink({ chatId: 'oc_1', threadId: '' }), '');
  assert.equal(buildSalesThreadLink({}), '');
});

test('格式可配：模板从环境变量读，没配就用她给的那条；空串 = 不要拼', () => {
  assert.equal(resolveSalesThreadLinkTemplate({}), DEFAULT_SALES_THREAD_LINK_TEMPLATE);
  assert.equal(resolveSalesThreadLinkTemplate({ SALES_THREAD_LINK_TEMPLATE: '' }), '');
  assert.equal(
    buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1', template: 'feishu://thread/{thread_id}?chat={chat_id}' }),
    'feishu://thread/omt_1?chat=oc_1',
  );
  // 不传 template = 用她给的默认格式（含 thread_position=-1）；显式空串 = 不要拼。
  const fallback = buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1' });
  assert.match(fallback, /\?open_chat_id=oc_1&open_thread_id=omt_1/);
  assert.match(fallback, /&thread_position=-1$/);
  assert.equal(buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1', template: '' }), '');
});

test('飞书给了发送响应链接就用飞书的（她给的格式当第二来源）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-priority-') });
  const service = newLinkService(locator);
  const { record, linkSource } = await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her', chatId: 'oc_1', threadId: 'omt_1',
    replyMessageId: 'om_reply', appLink: APP_LINK,
  });
  assert.equal(linkSource, 'send_response');
  assert.equal(record.app_link, APP_LINK);
  assert.ok(record.thread_link, '话题格式那条也留着（排查时能看到两条来源）');
});

test('解析器：本地存着话题深链就直接用它（不需要任何远端调用）', async () => {
  const { LarkMessageLinkResolver } = require('../src/services/larkMessageLinkResolver');
  const url = buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1' });
  const resolver = new LarkMessageLinkResolver({
    client: { im: { message: { get: async () => { throw new Error('不该被调用'); } } } },
    lookupEnabled: true,
  });
  assert.deepEqual(await resolver.resolve({ storedThreadLink: url, messageId: 'om_1' }), { url, source: 'thread_link' });
  assert.deepEqual(await resolver.resolve({ messageId: 'om_1' }), { url: '', source: 'unavailable' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、接线：群里发卡片 → 记本地映射，**业务表一个字段都不写**
// ─────────────────────────────────────────────────────────────────────────────

const wiredService = ({ chatType = 'group', appLink = APP_LINK } = {}) => {
  const gateway = recordingGateway();
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
    salesMessageLinks: new SalesMessageLinkService({ locator }),
  });
  return {
    service, updates: gateway.updates, locator,
    task: {
      task_id: 'task_1', chat_type: chatType, chat_id: 'oc_1', message_id: 'om_her_message',
      sender_open_id: 'ou_her', sales_entry_record_id: 'sale_rec_1',
      posting_result: { sourceNo: 'XSD-1' },
    },
  };
};

test('🔴 群里发【文字】：记本地映射，销售主表一个字段都不写', async () => {
  // 回归：2026-10-06 CI 红。`sendTaskText` 也走 `bindGroupSaleThread`，于是"回她一句话"
  // 顺手写了销售主表 —— 而文字这条出口里混着【不猜、不写业务表】的路径（多笔未收款占位 /
  // 金额对不上时回「有多条待收款」）。那一列 2026-10-09 已被她删除 ⇒ 这条出口现在**结构上**
  // 就碰不到业务表（写入点整体删掉了），但这条用例继续守着它。
  const { service, updates, locator, task } = wiredService();
  await service.sendTaskText(task, '有多条待收款，请先人工核对');

  const record = await locator.findByMessageId('om_her_message');
  assert.ok(record, '本地路由映射仍然要记（她后面在话题里说话还得认得出来）');
  assert.equal(record.thread_link, buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1' }));
  assert.deepEqual(updates, [], '文字这条出口不碰业务表');
});

test('🔴 群里发【卡片】：同样**不再写**销售主表（「消息链接」列已被她删除）', async () => {
  const { service, updates, locator, task } = wiredService();
  await service.replyTaskCard(task, { header: {} });
  assert.deepEqual(updates, [], '售后/结果卡片这条出口也不再碰业务表');
  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.app_link, APP_LINK, '链接只落本地映射');
});

test('群里发卡片：本地映射有 app_link 与销售 record_id（业务表那列已删，链接不丢）', async () => {
  const { service, updates, locator, task } = wiredService();
  await service.sendTaskCard(task, { header: {} });

  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.app_link, APP_LINK);
  assert.equal(record.sales_entry_record_id, 'sale_rec_1');
  assert.equal(record.thread_link, buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1' }));
  assert.deepEqual(updates, [], '一个字段都不写');
});

test('飞书没回带链接时：按【她给的话题格式】拼一条，也只进本地映射', async () => {
  const { service, updates, locator, task } = wiredService({ appLink: '' });
  await service.sendTaskCard(task, { header: {} });
  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.app_link, '', '飞书没给就是空，不伪造');
  assert.equal(record.thread_link, buildSalesThreadLink({ chatId: 'oc_1', threadId: 'omt_1' }));
  assert.equal(updates.length, 0);
});

test('两个 id 缺一个就不拼：既没回带链接、又没有 chat_id/thread_id → 留空、不写表', async () => {
  const { service, updates, locator, task } = wiredService({ appLink: '' });
  await service.sendTaskCard({ ...task, chat_id: '' }, { header: {} });
  const record = await locator.findByMessageId('om_her_message');
  assert.equal(record.thread_link, '');
  assert.equal(updates.length, 0);
});

test('🔴 没有群上下文的任务：**一条消息都不发**，既不写本地映射、也不写销售主表', async () => {
  // 🔴 2026-10-07「私聊链路移除」：这条用例原来叫「私聊任务：既不写本地映射、也不写销售主表」。
  //    私聊入口已整体删除，所以"私聊任务"这个输入没有了；留下的是**同一条防御分支** ——
  //    任务没有群上下文 → `sendTaskCard` 直接记日志 + 返 `null`，**没有去处**。
  //    ⚠️ 保留它的价值：证明这条分支**绝不**碰「话题 ↔ 销售」映射、也**绝不**碰业务表
  //    （映射的 key 是她的 message_id，被一条无渠道的任务写脏就再也定位不回那笔销售了）。
  const { service, updates, locator, task } = wiredService({ chatType: 'private' });
  const messageId = await service.sendTaskCard(task, { header: {} });
  assert.equal(messageId, null, '没有群上下文 → 没有去处，明确返 null');
  assert.equal(updates.length, 0);
  const all = await locator.store.list();
  assert.equal(all.length, 0, '没有群上下文的任务不该产生任何「话题 ↔ 销售」记录');
});

test('本地映射的 key 是「她那句话」的 message_id（后续引用/话题反查都靠它）', async () => {
  const locator = new SalesGroupThreadLocator({ store: tempStore('sales-link-key-') });
  const service = newLinkService(locator);
  await service.rememberFromSend({
    salesEntryRecordId: 'sale_rec_1', messageId: 'om_her_message', replyMessageId: 'om_reply_1', appLink: APP_LINK,
  });
  assert.ok(await locator.store.get(messageKey('om_her_message')));
  const found = await locator.findBySalesEntryRecordId('sale_rec_1');
  assert.equal(found.app_link, APP_LINK);
});
