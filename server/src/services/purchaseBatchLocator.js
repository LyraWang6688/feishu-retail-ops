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
 *   ① 采购单发到群之后，把 **那条消息的 message_id ↔ 批次** 写进**本地任务记录**
 *      （不是业务表：这是机器人的路由信息，不是经营事实，不该污染她的多维表格）；
 *   ② 群里有人引用那条消息（事件里带 `parent_id`）或直接说了批次号时，反查回批次。
 *
 * 为什么单独一个类、而不是塞进 PurchaseWebhookService：
 *   · 到货验收（D，等业务负责人口径）也要用同一条定位链路，
 *     把它做成可注入的独立依赖，D 不需要动采购申请的代码就能复用；
 *   · 定位这件事**只读**：本类里没有任何写业务表的路径（写只写自己的本地任务记录）。
 *
 * ⚠️ 三条路（详见 resolve），**任何一条都不猜**：
 *   ① parent_id 有值 → 查映射；查到就是它，查不到就明确说"认不出"，绝不退化成猜最近一笔；
 *   ② 没 parent_id 但正文里有批次号 → 按号找；找到多条算"说不清"，也不会挑一个；
 *   ③ 都没有 → 返回 ambiguous，由调用方回一句问清楚。
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
   * 幂等：同一条消息重复记（重试、飞书重投）用同一个 key，覆盖成同一条记录。
   */
  async rememberGroupMessage({ batchNo, messageId, chatId = '', suppliers = [], requestIds = [], detailCount = 0 }) {
    const id = String(messageId || '').trim();
    if (!id) throw new Error('记采购群消息映射缺少 message_id');
    const record = await this.store.create({
      [ID_FIELD]: messageKey(id),
      kind: 'purchase_group_message',
      // ⚠️ mapping 里同时留 batch_no 和 message_id：前者是"人嘴里会说的号"，
      // 后者是"事件里会给的 id"，两条路都要能从这一条记录上走通。
      batch_no: String(batchNo || '').trim(),
      message_id: id,
      chat_id: String(chatId || '').trim(),
      suppliers: Array.isArray(suppliers) ? suppliers.filter(Boolean) : [],
      request_ids: Array.isArray(requestIds) ? requestIds.filter(Boolean) : [],
      detail_count: Number(detailCount) || 0,
      status: 'posted',
    });
    logInfo('purchase.group.message.remembered', {
      batch_no: record.batch_no, message_id: id, chat_id: record.chat_id,
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

  /** 按批次号查映射。同号多条（理论上不该有）时全量返回，让调用方判"说不清"。 */
  async findByBatchNo(batchNo) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return [];
    const all = await this.store.list();
    return all.filter((record) => String(record?.batch_no || '') === wanted);
  }

  /**
   * 主入口：回答「这条群消息说的是哪一批」。
   *
   * @param {{ text?: string, parentId?: string }} input
   * @returns {Promise<{status: 'matched'|'not_found'|'ambiguous', source?: string,
   *   batch?: object, batchNo?: string, batchNos?: string[]}>}
   */
  async resolve({ text = '', parentId = '' } = {}) {
    const parent = String(parentId || '').trim();
    // ① 引用某条消息：parent_id 是**最可靠**的信号（真机验证：她引用机器人消息时，
    //    事件里带的就是被引用那条的 message_id）。
    if (parent) {
      const record = await this.findByMessageId(parent);
      if (record) {
        logInfo('purchase.group.batch.located', {
          source: 'parent_id', parent_id: parent, batch_no: record.batch_no,
        });
        return { status: 'matched', source: 'parent_id', batch: record, batchNo: record.batch_no || '' };
      }
      // ⚠️ 引用的不是我们的采购单（或映射丢了）→ 明确"认不出"，**绝不**退回②去猜。
      // 她引用的可能是别人的消息、甚至另一家供应商的单子，猜错就是账目错。
      logInfo('purchase.group.batch.unmapped_parent', { parent_id: parent });
      return { status: 'not_found', source: 'parent_id' };
    }

    // ② 没引用，但正文里说了批次号。
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

    // ③ 既没引用也没说号 → 反问。这里**不能**看"最近一笔"：
    //    猜错一笔账，比多问一句的代价大得多。
    logInfo('purchase.group.batch.unresolved', { reason: 'no_parent_no_batch_no' });
    return { status: 'ambiguous', source: 'none', batchNos: [] };
  }
}

module.exports = { PurchaseBatchLocator, messageKey };
