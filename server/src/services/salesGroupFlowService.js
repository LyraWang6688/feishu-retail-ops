const { logInfo, logWarn } = require('../utils/logger');

/**
 * 群里进来的消息「是不是销售、是哪一笔销售」的分派（C 链路的使用方）。
 * 准入由调用方判定（话题免 @ / 主群 @，见 LarkMvpService.acceptMessage）。
 *
 * 它自己做两件事，都只跟"路由"有关：
 *   · 把「这条群消息 / 这个话题对应哪一笔销售」**定位**出来；
 *   · 定位成功 → 把「那一笔 + 她说的这句话」**转交**给销售入口（可注入）；
 *     定位到的话题里那句话是**售后**（退/换/赔，判据在 config/afterSalesFlow）时，
 *     转交给售后的入口（`afterSalesInThread`）——**同一条处理链，只是不过销售闸门**；
 *     定位不到 → 返回 handled:false，**让采购那条原样走它自己的路**。
 *
 * ⚠️ 销售的**业务规则一个字都不在这里**：本类不解析原话、不发卡片、不写业务表、
 *    不判断"该不该入账"。它只回答"这条群消息归谁、是哪一笔"。
 *    这样销售链路怎么演进都不会动到采购的定位，采购怎么演进也不会动到销售。
 *
 * ⚠️ 三条纪律（与采购定位同一套，业务负责人 2026-10-06 确认的口径）：
 *   ① 话题本身就是上下文 —— 定位只认 `thread_id` / `parent_id` 的本地映射；
 *   ② **绝不**退化成"最近一笔销售"；
 *   ③ 认不出就交给采购那条原样回"认不出"，不在这里编一句兜底话。
 */
class SalesGroupFlowService {
  constructor({ locator, isSalesText, isAfterSalesText, extractPurchaseBatchNos, salesIntake } = {}) {
    if (!locator) throw new Error('SalesGroupFlowService 需要 salesGroupThreadLocator');
    if (typeof isSalesText !== 'function') throw new Error('SalesGroupFlowService 需要 isSalesText');
    this.locator = locator;
    // 入口闸门（含数字 / 含业务关键词）。注入而不是自己写：词表在 config/messageGate，
    // 私聊与群聊必须用**同一把尺子**，否则两边的"这算不算销售"会慢慢走歪。
    this.isSalesText = isSalesText;
    // 「这句话是不是售后（退 / 换 / 赔）」：词表在 config/afterSalesFlow。
    // ⚠️ 只在**已经定位到某笔销售的话题里**用它分流（见 ① ）：
    //    售后和销售走的是同一条处理链，区别只有一个——售后**不过"像不像销售"那把尺子**
    //    （"这笔退了""售后处理一下"可能一个数字都没有，用私聊闸门会被静默丢掉）。
    //    不传时退化成"全按销售"，与改动前行为一致。
    this.isAfterSalesText = typeof isAfterSalesText === 'function' ? isAfterSalesText : () => false;
    // 「正文里有没有采购批次号 BH-YYYYMMDD-NNNN」：有就是采购那条路的事，
    // 即便它同时含数字（"BH-20261005-0009 这批的到货单你看下"不能被当成销售）。
    this.extractPurchaseBatchNos = extractPurchaseBatchNos || (() => []);
    // 销售入口（由 LarkMvpService 注入）：本类不认识销售业务，只负责"转交"。
    this.salesIntake = salesIntake || {};
  }

  /**
   * @param {{ message: object, text: string, parentId?: string, threadId?: string,
   *   senderOpenId?: string, chatId?: string }} input
   * @returns {Promise<{handled: boolean, mode?: 'thread'|'new', source?: string,
   *   sale?: object, reason?: string, sales?: object}>}
   */
  async handleGroupSalesMessage({
    message, text = '', parentId = '', threadId = '', senderOpenId = '', chatId = '',
  } = {}) {
    const messageId = message?.message_id || '';
    const thread = String(threadId || '').trim();

    // ① 话题里（或引用着某条消息）→ 按本地映射反查是哪一笔销售。
    //    话题里后续的消息不一定还引用着机器人那条，所以 thread_id 优先（定位器内部保证）。
    const located = await this.locator.resolve({ threadId: thread, parentId });
    if (located.status === 'matched') {
      // 已经认出是哪一笔销售了 → 再看这句话是**售后**（退/换/赔）还是**销售进展**。
      // ⚠️ 只有这一支分流：主群那条路（③④）一个字都不动，采购那条路更不会被抢——
      //    能走到这里的，都是本地映射里**明确属于某笔销售**的话题。
      const afterSales = this.isAfterSalesText(text);
      logInfo('sales.group.sale.dispatched', {
        message_id: messageId, source: located.source, thread_id: thread,
        sales_entry_record_id: located.sale?.sales_entry_record_id || '',
        after_sales: afterSales,
      });
      const sales = await this.dispatch(afterSales ? 'afterSalesInThread' : 'continueInThread', {
        sale: located.sale, message, text, threadId: thread, senderOpenId, chatId,
      });
      return { handled: true, mode: 'thread', source: located.source,
        afterSales, sale: located.sale, sales };
    }

    // ② 在话题里但这条话题没记过销售映射 → 不归销售管（可能是采购到货核对那条话题）。
    //    原样交给采购那条路：它会按自己的规矩回"认不出"，绝不在这里抢答。
    if (thread) return { handled: false, reason: 'unmapped_thread' };

    // ③ 主群消息（@ 进来的）。先排除采购：正文里有批次号就是采购的。
    if (this.extractPurchaseBatchNos(text).length) {
      return { handled: false, reason: 'purchase_batch_no' };
    }
    // ④ 主群里 @ 机器人说一笔销售 → 新开一笔（建记录 + 在那条消息下开话题 + 回卡片）。
    //    闸门用的是**和私聊同一把尺子**：不像销售的消息绝不在这里建单，交回采购那条路。
    if (!this.isSalesText(text)) return { handled: false, reason: 'not_sales_text' };
    const sales = await this.dispatch('startFromGroup', {
      message, text, threadId: '', senderOpenId, chatId,
    });
    return { handled: true, mode: 'new', source: 'mention', sales };
  }

  /**
   * 转交给销售入口。
   *
   * ⚠️ 这里**不做任何业务判断**：只转交 + 失败不牵连（销售那条路的问题不能把
   *    采购的定位结论搞脏，也不能让整条群消息判失败）。
   */
  async dispatch(method, payload) {
    const handler = this.salesIntake?.[method];
    if (typeof handler !== 'function') return null;
    try {
      return await handler(payload);
    } catch (error) {
      logWarn('sales.group.dispatch_failed', {
        method, message_id: payload?.message?.message_id, error: error.message,
      });
      return null;
    }
  }
}

module.exports = { SalesGroupFlowService };
