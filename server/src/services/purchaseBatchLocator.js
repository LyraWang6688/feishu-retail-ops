const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { extractBatchNos } = require('./purchaseBatchNo');
const { logInfo, logWarn } = require('../utils/logger');

// 消息 key 与真机无关，纯本地推导：同一个 message_id 在任何进程/任何表里都得到同一个 key，
// 所以「发消息时写映射」和「后续用 parent_id 查映射」不需要额外的索引表。
const messageKey = (messageId) =>
  `purchase_group_message_${crypto.createHash('sha256').update(String(messageId || '')).digest('hex').slice(0, 20)}`;

// 任务存储里的标识字段：沿用 JsonTaskStore 默认的 task_id，不另起一套存储机制。
const ID_FIELD = 'task_id';

/**
 * 「群消息 → 是哪一批采购单」的定位器（C）。
 *
 * 它同时负责两件必须在一起的事：
 *   ① 采购单发到群之后，把 **那条消息的 message_id / thread_id ↔ 批次** 写进
 *      **本地任务记录**（不是业务表：这是机器人的路由信息，不是经营事实，
 *      不该污染她的多维表格）；
 *   ② 话题里的消息、引用那条消息的消息（事件里带 `parent_id`）或直接说了批次号时，
 *      反查回批次。
 *
 * 为什么单独一个类、而不是塞进 PurchaseWebhookService：
 *   · 到货验收（D，等业务负责人口径）也要用同一条定位链路，
 *     把它做成可注入的独立依赖，D 不需要动采购申请的代码就能复用；
 *   · 定位这件事**只读业务表**：本类里没有任何写业务表的路径
 *     （写只写自己的本地路由记录）。
 *
 * ⚠️ 四条路（详见 resolve），**任何一条都不猜**：
 *   ① thread_id 有值且记过映射 → 就是它（业务负责人实测：话题里她引用/说话都带
 *      同一个 thread_id，比 parent_id 更稳——后续消息不一定还引用着机器人那条）；
 *   ② thread_id 没命中、但 parent_id 有值 → 查映射；查到就是它，查不到就明确说
 *      "认不出"，绝不退化成猜最近一笔；
 *   ③ 有 thread_id 但这条话题没记过、又没有 parent_id → 明确"认不出"，不拿正文号去猜；
 *   ④ 没有 thread_id/parent_id 时：正文里有批次号 → 按号找；找到多条算"说不清"；
 *      一个号都没有 → 返回 ambiguous，由调用方回一句问清楚。
 */
class PurchaseBatchLocator {
  constructor(options = {}) {
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/purchase_group_messages'),
      idField: ID_FIELD,
    });
  }

  /**
   * 记下「这条群消息是哪一批」。发单流程拿到 message_id 之后立刻调它。
   *
   * `threadId` 是发消息时飞书回给我们的**话题 id**（话题群里每条消息都带；
   * 普通群里第一条消息还没有，等她回复时事件才带——那种情况由下面的
   * `bindThreadToRecord` 在她第一次回复时补记一次）。
   *
   * 幂等：同一条消息重复记（重试、飞书重投）用同一个 key，覆盖成同一条记录。
   */
  async rememberGroupMessage({ batchNo, messageId, threadId = '', chatId = '', suppliers = [], requestIds = [], detailCount = 0, kind = '' }) {
    const id = String(messageId || '').trim();
    if (!id) throw new Error('记采购群消息映射缺少 message_id');
    const record = await this.store.create({
      [ID_FIELD]: messageKey(id),
      kind: 'purchase_group_message',
      // ⚠️ mapping 里同时留 batch_no / message_id / thread_id：
      // 批次号是"人嘴里会说的号"，message_id 是"引用时事件给的 id"，
      // thread_id 是"话题里所有消息共用的那个 id"，三条路都要能从这一条记录上走通。
      batch_no: String(batchNo || '').trim(),
      // ⚠️ batch_kind：这批发到群里的是**采购申请单**还是**采购退货单**。
      // 两者共用同一个群、同一个话题机制（都走 deliverSupplierImages），
      // 下游（到货核对）必须能分清，否则会把退货话题当成到货核对。
      // 留空时由使用方按"采购申请"处理（旧记录没有这个字段）。
      batch_kind: String(kind || '').trim(),
      message_id: id,
      thread_id: String(threadId || '').trim(),
      chat_id: String(chatId || '').trim(),
      suppliers: Array.isArray(suppliers) ? suppliers.filter(Boolean) : [],
      request_ids: Array.isArray(requestIds) ? requestIds.filter(Boolean) : [],
      detail_count: Number(detailCount) || 0,
      status: 'posted',
    });
    logInfo('purchase.group.message.remembered', {
      batch_no: record.batch_no, message_id: id, thread_id: record.thread_id,
      chat_id: record.chat_id, batch_kind: record.batch_kind,
      supplier_count: record.suppliers.length, request_count: record.request_ids.length,
    });
    return record;
  }

  /**
   * 按 message_id 查映射。① 先按确定性 key 直取（覆盖"就是它发的"这条主路），
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

  /** 按话题 id 查映射。同一条话题下我们可能发过图+文字两条，批次相同，取第一条即可。 */
  async findByThreadId(threadId) {
    const wanted = String(threadId || '').trim();
    if (!wanted) return null;
    const all = await this.store.list();
    return all.find((record) => String(record?.thread_id || '') === wanted) || null;
  }

  /**
   * 把话题 id 补记到一个已经存在的映射记录上。
   *
   * 为什么需要它：普通群（不是话题群）里，机器人发消息时飞书**还没有** thread_id，
   * 话题是她回复的那一刻才产生的。所以 thread_id 唯一能拿到的时机就是"她第一次
   * 在话题里说话"——那时事件里同时有 thread_id 和 parent_id，parent_id 能定位到批次，
   * 顺手把这个 thread_id 记到同一条记录上。此后这条话题下的**所有**消息都能只靠
   * thread_id 命中（它们不一定还引用着机器人那条），① 那条路才不会形同虚设。
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
      logInfo('purchase.group.thread.bound', {
        message_id: id, thread_id: thread, batch_no: updated?.batch_no || record.batch_no || '',
      });
      return updated;
    } catch (error) {
      logWarn('purchase.group.thread.bind_failed', { message_id: id, thread_id: thread, error: error.message });
      return record;
    }
  }

  /** 按批次号查映射。同号多条（理论上不该有）时全量返回，让调用方判"说不清"。 */
  async findByBatchNo(batchNo) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return [];
    const all = await this.store.list();
    return all.filter((record) => String(record?.batch_no || '') === wanted);
  }

  /**
   * 全部映射（只读）。
   *
   * 给"一次要查很多批次"的调用方用：9 点推送的【采购】区要按**每条候选**取深链，
   * 逐条 `findByBatchNo` 会把同一份目录读 N 遍。这里读一次、由调用方自己建索引
   *（底层就是 `store.list()`："读一遍目录"，没有额外语义）。
   */
  async listGroupMessages() {
    return this.store.list();
  }

  /**
   * 主入口：回答「这条群消息说的是哪一批」。
   *
   * @param {{ text?: string, parentId?: string, threadId?: string }} input
   * @returns {Promise<{status: 'matched'|'not_found'|'ambiguous', source?: string,
   *   batch?: object, batchNo?: string, batchNos?: string[]}>}
   */
  async resolve({ text = '', parentId = '', threadId = '' } = {}) {
    const thread = String(threadId || '').trim();
    const parent = String(parentId || '').trim();

    // ① 话题：thread_id 是**最稳**的信号。业务负责人实测：她在话题里发的消息
    //    带同一个 thread_id，而 parent_id 只是话题根消息（= 机器人发的那条）——
    //    一旦她回复自己/别人的消息，parent_id 就不是机器人那条了，只有 thread_id 不变。
    if (thread) {
      const record = await this.findByThreadId(thread);
      if (record) {
        logInfo('purchase.group.batch.located', {
          source: 'thread_id', thread_id: thread, batch_no: record.batch_no,
        });
        return { status: 'matched', source: 'thread_id', batch: record, batchNo: record.batch_no || '' };
      }
    }

    // ② 引用某条消息：parent_id 是次稳的信号（真机验证：她引用机器人消息时，
    //    事件里带的就是被引用那条的 message_id）。
    if (parent) {
      const record = await this.findByMessageId(parent);
      if (record) {
        // 话题没记过映射、但引用能定位：顺手补记（普通群里 thread_id 只有这一刻拿得到）。
        const bound = thread ? await this.bindThreadToRecord(record, thread) : record;
        logInfo('purchase.group.batch.located', {
          source: 'parent_id', parent_id: parent, thread_id: thread, batch_no: record.batch_no,
        });
        return { status: 'matched', source: 'parent_id', batch: bound, batchNo: bound.batch_no || '' };
      }
      // ⚠️ 引用的不是我们的采购单（或映射丢了）→ 明确"认不出"，**绝不**退回③去猜。
      // 她引用的可能是别人的消息、甚至另一家供应商的单子，猜错就是账目错。
      logInfo('purchase.group.batch.unmapped_parent', { parent_id: parent, thread_id: thread });
      return { status: 'not_found', source: 'parent_id' };
    }

    // ③ 在话题里、但这条话题我们没记过，也没有引用：这是"看起来该认识、实际不认识"。
    //    明确回"认不出"，**不拿正文里的批次号去猜**——话题里的号可能是别的意思。
    if (thread) {
      logInfo('purchase.group.batch.unmapped_thread', { thread_id: thread });
      return { status: 'not_found', source: 'thread_id' };
    }

    // ④ 没话题也没引用，但正文里说了批次号。
    const batchNos = extractBatchNos(text);
    if (batchNos.length) {
      const matches = [];
      for (const batchNo of batchNos) {
        const records = await this.findByBatchNo(batchNo);
        for (const record of records) matches.push({ batchNo, record });
      }
      const distinct = new Set(matches.map((item) => item.batchNo));
      if (matches.length === 1 && distinct.size === 1) {
        const [{ batchNo, record }] = matches;
        logInfo('purchase.group.batch.located', { source: 'batch_no', batch_no: batchNo });
        return { status: 'matched', source: 'batch_no', batch: record, batchNo };
      }
      // 说了两个号、或者同一个号命中多条 → 说不清，交给调用方反问。
      logWarn('purchase.group.batch.ambiguous', { batch_nos: batchNos, match_count: matches.length });
      return { status: 'ambiguous', source: 'batch_no', batchNos };
    }

    // ⑤ 既没话题也没引用也没说号 → 反问。这里**不能**看"最近一笔"：
    //    猜错一笔账，比多问一句的代价大得多。
    logInfo('purchase.group.batch.unresolved', { reason: 'no_thread_no_parent_no_batch_no' });
    return { status: 'ambiguous', source: 'none', batchNos: [] };
  }
}

module.exports = { PurchaseBatchLocator, messageKey };
