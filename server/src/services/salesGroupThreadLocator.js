const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { logInfo, logWarn } = require('../utils/logger');

// 消息 key 与真机无关，纯本地推导：同一个 message_id 在任何进程里都得到同一个 key，
// 所以「开话题时写映射」和「后续用 parent_id / thread_id 查映射」不需要额外的索引表。
const messageKey = (messageId) =>
  `sales_group_thread_${crypto.createHash('sha256').update(String(messageId || '')).digest('hex').slice(0, 20)}`;

// 任务存储里的标识字段：沿用 JsonTaskStore 默认的 task_id，不另起一套存储机制。
const ID_FIELD = 'task_id';

/**
 * 「群话题 → 是哪一笔销售」的定位器（C）。
 *
 * ⚠️ **业务负责人明确说过「这个话题不用存」** —— 那说的是**不要建业务表、不要给业务表加列**
 * （见 docs/sales-purchase-group-thread-2026-10-06.md 第 1.3 节）。
 * 机器人**仍然需要一份本地路由映射**才能从话题反查回销售记录，所以这里把
 * `thread_id / parent_id ↔ 销售主表 record_id` 写进**本地任务记录**
 * （`data/sales_group_threads/`），与采购那侧的 `data/purchase_group_messages/` 同一个模式：
 *   · 它是**机器人的路由信息**，不是经营事实，不该污染她的多维表格；
 *   · 本类里**没有任何写业务表的路径**（只写自己的本地路由记录）。
 *
 * 它与 PurchaseBatchLocator 是**两个独立的实例、两个独立的目录**：
 * 销售和采购是两件事，混在一个目录里将来按任务翻盘时会互相干扰。
 *
 * 两条路，**任何一条都不猜**：
 *   ① `thread_id` 命中 → 就是它（话题里后续消息不一定还引用着机器人那条，thread 最稳）；
 *   ② `thread_id` 没命中、但 `parent_id` 命中 → 就是它，并顺手把 thread_id 补记下来；
 *   ③ 都没有 / 查不到 → `not_found`，**绝不退化成"最近一笔销售"**。
 */
class SalesGroupThreadLocator {
  constructor(options = {}) {
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/sales_group_threads'),
      idField: ID_FIELD,
    });
  }

  /**
   * 记下「这条群消息 / 这个话题是哪一笔销售」。开话题（或首次回复）后立刻调它。
   *
   * `threadId` 是飞书回给我们的**话题 id**：`im.message.reply` 带
   * `reply_in_thread: true` 时响应里就有（主群第一条回复时飞书才创建这个话题）。
   *
   * 幂等：同一条消息重复记（重试、飞书重投）用同一个 key，覆盖成同一条记录。
   */
  async rememberSaleThread({
    salesEntryRecordId = '', taskId = '', orderNo = '', messageId = '', threadId = '',
    chatId = '', senderOpenId = '', replyMessageId = '',
  } = {}) {
    const id = String(messageId || '').trim();
    if (!id) throw new Error('记销售群话题映射缺少 message_id');
    const record = await this.store.create({
      [ID_FIELD]: messageKey(id),
      kind: 'sales_group_thread',
      // ⚠️ mapping 里同时留 message_id / thread_id：
      // message_id 是"她开这笔销售时说的那条消息"（引用回复时事件里给的就是它），
      // thread_id 是"这条话题下所有消息共用的 id"，两条路都要能从这一条记录上走通。
      sales_entry_record_id: String(salesEntryRecordId || '').trim(),
      sale_task_id: String(taskId || '').trim(),
      order_no: String(orderNo || '').trim(),
      message_id: id,
      thread_id: String(threadId || '').trim(),
      chat_id: String(chatId || '').trim(),
      sender_open_id: String(senderOpenId || '').trim(),
      // 机器人那张卡片自己的 message_id：排查时能一眼对上"哪条消息进了哪个话题"。
      reply_message_id: String(replyMessageId || '').trim(),
      status: 'bound',
    });
    logInfo('sales.group.thread.remembered', {
      sales_entry_record_id: record.sales_entry_record_id,
      message_id: id,
      thread_id: record.thread_id,
      chat_id: record.chat_id,
    });
    return record;
  }

  /**
   * 按 message_id 查映射：① 先按确定性 key 直取（覆盖"就是她开头说的那条"这条主路），
   * ② 取不到再扫一遍（本地记录被整理过、或历史数据用别的 key 落过盘）。
   * 两条都查不到 → null，**不是**"最近一笔"。
   */
  async findByMessageId(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    const direct = await this.store.get(messageKey(id));
    if (direct?.message_id === id) return direct;
    const all = await this.store.list();
    return all.find((record) => String(record?.message_id || '') === id) || null;
  }

  /** 按话题 id 查映射。 */
  async findByThreadId(threadId) {
    const wanted = String(threadId || '').trim();
    if (!wanted) return null;
    const all = await this.store.list();
    return all.find((record) => String(record?.thread_id || '') === wanted) || null;
  }

  /**
   * 把话题 id 补记到一个已经存在的映射记录上。
   *
   * 为什么需要它：普通群（不是话题群）里，`reply_in_thread` 之前没有可用的 thread_id；
   * 有些部署/场景下飞书给的话题 id 只在**她第一次在话题里说话**的事件里才拿得到——
   * 那时事件里同时有 thread_id 和 parent_id，parent_id 能定位到那笔销售，
   * 顺手把这个 thread_id 记到同一条记录上。此后这条话题下的**所有**消息都能只靠
   * thread_id 命中（它们不一定还引用着机器人那条）。
   *
   * ⚠️ 只写自己的本地路由记录；失败只告警，绝不影响这次定位的结果。
   */
  async bindThreadToRecord(record, threadId) {
    const thread = String(threadId || '').trim();
    const id = String(record?.message_id || '').trim();
    if (!thread || !id) return record;
    if (String(record?.thread_id || '').trim() === thread) return record;
    try {
      const updated = await this.store.update(messageKey(id), { thread_id: thread });
      logInfo('sales.group.thread.bound', {
        message_id: id, thread_id: thread,
        sales_entry_record_id: updated?.sales_entry_record_id || record.sales_entry_record_id || '',
      });
      return updated;
    } catch (error) {
      logWarn('sales.group.thread.bind_failed', { message_id: id, thread_id: thread, error: error.message });
      return record;
    }
  }

  /**
   * 主入口：回答「这条群消息说的是哪一笔销售」。
   *
   * @param {{ parentId?: string, threadId?: string }} input
   * @returns {Promise<{status: 'matched'|'not_found', source?: string, sale?: object}>}
   */
  async resolve({ parentId = '', threadId = '' } = {}) {
    const thread = String(threadId || '').trim();
    const parent = String(parentId || '').trim();

    // ① 话题：thread_id 是**最稳**的信号（话题里后续消息不一定还引用着机器人那条）。
    if (thread) {
      const record = await this.findByThreadId(thread);
      if (record) {
        logInfo('sales.group.sale.located', {
          source: 'thread_id', thread_id: thread,
          sales_entry_record_id: record.sales_entry_record_id,
        });
        return { status: 'matched', source: 'thread_id', sale: record };
      }
    }

    // ② 引用某条消息：parent_id 是次稳的信号（她引用机器人那条卡片/消息时事件里给的是它）。
    if (parent) {
      const record = await this.findByMessageId(parent);
      if (record) {
        const bound = thread ? await this.bindThreadToRecord(record, thread) : record;
        logInfo('sales.group.sale.located', {
          source: 'parent_id', parent_id: parent, thread_id: thread,
          sales_entry_record_id: record.sales_entry_record_id,
        });
        return { status: 'matched', source: 'parent_id', sale: bound };
      }
    }

    // ③ 都不是 → 认不出。⚠️ 这里**不看**"最近一笔销售"：猜错一笔账，
    //    比多问一句的代价大得多（与采购定位器同一条纪律）。
    logInfo('sales.group.sale.unresolved', {
      reason: thread || parent ? 'no_mapping' : 'no_thread_no_parent', thread_id: thread, parent_id: parent,
    });
    return { status: 'not_found', source: thread ? 'thread_id' : parent ? 'parent_id' : 'none' };
  }
}

module.exports = { SalesGroupThreadLocator, messageKey };
