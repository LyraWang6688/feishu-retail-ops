const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { SalesGroupThreadLocator } = require('./salesGroupThreadLocator');
const { LarkMessageLinkResolver } = require('./larkMessageLinkResolver');
const { LarkMessagePinService } = require('./larkMessagePinService');
const { shanghaiDayKey } = require('./saleLookupService');
const { resolvePendingDealPushConfig } = require('../config/pendingDealPush');
const { logInfo, logWarn } = require('../utils/logger');

// 「维度 1」：每天 9 点（北京时间）把**最近 7 天未付 / 预付、尚未成交**的销售单
// 推到群里，**每笔一行**：单号 + 待收金额 + 那条群消息的深链。
//
// 三件事刻意**不复用第二遍**：
//   · 「哪些单要推」= **直接复用** `SecondDeliveryService.listPendingDeliveries`
//     （最近 7 天里未付 / 预付且尚未完成履约的已入账销售单）。口径只有一处实现，
//     这里一个字都不重写——将来口径变了（比如窗口从 7 天改成 10 天），改那一处即可。
//   · 「这笔单当初是哪条群消息」= `SalesGroupThreadLocator`（本地映射，不写业务表）。
//   · 「深链怎么来」= `LarkMessageLinkResolver`（**只认真链接**：本地存的 → 现查；
//     拿不到就返回空，**绝不自己拼 URL**——运营兜底模板那个口子 2026-10-06 已删）。
//     ⚠️ 深链今天**基本拿不到**，原因与后续方案见
//     `docs/reports/group-message-deep-link-2026-10-06.md`。
//
// 与「第二次交付」提醒（`secondDeliveryService.sendDailyReminder`）是**两条独立的推送**：
// 那一条发**群卡片**、带「成交」按钮、点了会写库；这一条只发**一条文字**、纯提醒、点进去
// 由她去话题里处理。两条各有各的按天认领记录，互不影响（一条挂了不牵连另一条）。

// 「同一天只推一次」的认领键。与第二次交付同一个思路：跨天照推（只要那笔单还在窗口里、
// 还没成交），防的只是"同一天因为重启 / 重复 tick 推两遍"。
const dayMarkerId = (dayKey) => `pending_deal_push_day_${dayKey}`;

// 金额只在**显示**这一层格式化；业务计算一律用 listPendingDeliveries 给的分。
// ⚠️ `null` = "这一单的成交金额读不出来"（progressFromRecords 的 amountKnown=false），
// 必须显示成占位符 —— 绝不能让它变成 `¥0.00`：那是在告诉她"这单不用收钱"。
const money = (value) => {
  if (value === null || value === undefined || value === '') return '¥—';
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '¥—';
};

class PendingDealPushService {
  constructor(options = {}) {
    // 配置在这里**读一次**（启动时）：写错要在服务起来的那一刻就吵，而不是等第二天 9 点。
    this.settings = options.settings || resolvePendingDealPushConfig();
    this.secondDelivery = options.secondDelivery || new SecondDeliveryService();
    this.locator = options.locator || new SalesGroupThreadLocator();
    this.client = options.client || this.secondDelivery.client;
    this.resolver = options.resolver || new LarkMessageLinkResolver({
      client: this.client,
      lookupEnabled: this.settings.linkLookupEnabled,
    });
    // 群 id：显式传了就用它（测试注入）；传 `undefined` = 按配置每次现读。
    this.chatId = options.chatId;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/pending_deal_push'), idField: 'task_id',
    });
    // 发完之后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
    // ⚠️ 复用**同一个 store**：置顶状态与按天认领记录同目录（data/pending_deal_push），
    //    排查时一个目录看全；也复用同一个飞书 client，不为置顶另建连接。
    // ⚠️ 它**只干置顶这一件事**，而且内部把所有失败都吞成 warn（见 larkMessagePinService）。
    this.pin = options.pin || new LarkMessagePinService({ client: this.client, store: this.store });
    // interval 可能在上一次还没跑完时又触发：串行化，免得同一天两次扫描并发跑，
    // 把"按天只推一次"判成都没推过（与第二次交付同款处理）。
    this.run = Promise.resolve();
  }

  /** 候选单：**复用**第二次交付那套筛选，不重写口径。 */
  listPendingOrders({ now }) {
    return this.secondDelivery.listPendingDeliveries({ now });
  }

  /**
   * 每笔单 → 它当初那条群消息 → 深链。
   *
   * 映射查不到 / 深链拿不到都**不抛**：这两种都不是致命错误（业务负责人要的是"单号 + 金额"
   * 先看得见），但要**留下可排查的计数**，见 `missingLinkCount` 与那两条日志。
   */
  async attachLinks(orders) {
    const linked = [];
    let missingLinkCount = 0;
    for (const order of orders) {
      const record = await this.locator.findBySalesEntryRecordId(order.salesEntryRecordId)
        .catch((error) => {
          logWarn('sales.pending_deal_push.mapping.lookup_failed', {
            sales_entry_record_id: order.salesEntryRecordId, error: error.message,
          });
          return null;
        });
      const { url, source } = await this.resolver.resolve({
        // 飞书深链优先；没有就用**按她给的话题格式拼的那条**（今天真正管用的一条）。
        storedAppLink: record?.app_link,
        storedThreadLink: record?.thread_link,
        messageId: record?.message_id,
        threadId: record?.thread_id,
        chatId: record?.chat_id,
      });
      if (!url) missingLinkCount += 1;
      linked.push({
        ...order,
        messageId: record?.message_id || '',
        threadId: record?.thread_id || '',
        url,
        linkSource: source,
      });
    }
    return { orders: linked, missingLinkCount };
  }

  /** 每笔一行：序号 + 单号 + 待收金额 + 深链（拿不到就不放链接，另起一行说明）。 */
  buildText({ orders, missingLinkCount = 0, dayKey = '' } = {}) {
    const header = `⏰ ${dayKey} 最近 7 天未付 / 预付、尚未成交的销售单：${orders.length} 笔`;
    const lines = orders.map((order, index) => {
      const parts = [`${index + 1}. ${order.orderNo}`, `待收 ${money(order.pendingAmount)}`];
      if (order.url) parts.push(order.url);
      return parts.join(' · ');
    });
    // 深链缺失是**已知的**（见 larkMessageLinkResolver 的实测结论），
    // 在消息里说一句，免得她以为是漏发了。
    const footer = missingLinkCount
      ? `（${missingLinkCount} 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）`
      : '';
    return [header, ...lines, footer].filter(Boolean).join('\n');
  }

  /**
   * 发到**群的主聊天**（不是话题）：话题是"每笔单一条讨论"，这条推送是"今日待办清单"，
   * 挂在主聊天里才看得见全貌。所以**不带** `reply_in_thread`、也不引用任何消息。
   */
  async sendTextToChat(text, chatId) {
    if (!chatId) {
      // 没配群 = 不知道发哪儿。绝不回落到发给某个人（与采购 / 成交提醒同一条纪律）。
      logWarn('sales.pending_deal_push.chat_missing', {
        env: 'PENDING_DEAL_PUSH_CHAT_ID', hint: '未配置未付/预付推送群 id，本次不推送',
      });
      return '';
    }
    if (!this.client?.im?.message?.create) throw new Error('未付/预付推送缺少飞书 client，无法发送群消息');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    if (response.code !== 0) throw new Error(`发送未付/预付推送失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /**
   * 发出后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
   *
   * 两道闸门：
   *   · `PENDING_DEAL_PUSH_PIN_ENABLED` 关着（默认）→ **一次远端调用都不发**；
   *   · 开着 → 交给 `LarkMessagePinService`（它保证"先取消上一条、再置顶这一条"）。
   *
   * 🔴 **本方法永不抛**：置顶只是增强，消息已经发出去了。万一 pinLatest 意外抛了，
   *    这里也必须吞掉并记 warn —— 绝不能让置顶把整轮推送判成失败。
   */
  async pinMessage({ messageId, chatId, dayKey }) {
    if (!this.settings.pinEnabled) return { pinned: false, reason: 'pin_disabled', previousMessageId: '' };
    try {
      return await this.pin.pinLatest({ messageId, chatId, day: dayKey });
    } catch (error) {
      logWarn('sales.pending_deal_push.pin.failed', {
        day: dayKey, message_id: messageId, error: error.message,
        hint: '置顶抛了异常（本不该发生）；已吞掉，推送本身不受影响',
      });
      return { pinned: false, reason: 'pin_failed', previousMessageId: '' };
    }
  }

  /** 每日推送。定时器每个 tick 都会调它，能不能真跑由"今天推过没有"决定。 */
  sendDailyPush({ now = new Date() } = {}) {
    const next = this.run.then(
      () => this._sendDailyPush({ now }),
      () => this._sendDailyPush({ now }),
    );
    this.run = next.catch(() => undefined);
    return next;
  }

  async _sendDailyPush({ now }) {
    const { enabled, linkRequired } = this.settings;
    if (!enabled) {
      // 兜底闸门：app.js 不开定时器时其实走不到这里，但显式写出来，
      // 免得将来有人别的地方直接调它、把开关绕过。
      return { skipped: true, reason: 'disabled', pushedOrderCount: 0 };
    }
    const dayKey = shanghaiDayKey(now);
    const dayTaskId = dayMarkerId(dayKey);
    // 先落记录再发（与第二次交付同一条理由）：崩在"已认领、还没发出去"之间只会**少推一天**，
    // 第二天照常进候选、可自愈；反过来会在同一个崩溃点产生**第二条**消息。
    if (await this.store.get(dayTaskId)) {
      logInfo('sales.pending_deal_push.skipped', { day: dayKey, reason: 'already_ran_today' });
      return { day: dayKey, skipped: true, reason: 'already_ran_today', pushedOrderCount: 0 };
    }
    await this.store.create({ task_id: dayTaskId, day: dayKey, status: 'running' });
    try {
      const candidates = await this.listPendingOrders({ now });
      if (!candidates.length) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_pending_order' });
        logInfo('sales.pending_deal_push.empty', { day: dayKey, candidate_count: 0 });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_pending_order' };
      }

      const { orders, missingLinkCount } = await this.attachLinks(candidates);
      if (missingLinkCount) {
        // 一次推送只记**一条**汇总（不是每笔一条），否则日志会被刷满。
        logWarn('sales.pending_deal_push.link.missing', {
          day: dayKey, order_count: orders.length, missing_link_count: missingLinkCount,
          hint: 'im.message.get 未返回 message_app_link；深链只能靠发消息时存进 sales_group_threads 的 app_link',
        });
      }
      // 「没有深链就不推」是配置项（默认**不**这样）：深链是增强，单号 + 金额本身就该看得见。
      if (linkRequired && missingLinkCount) {
        await this.store.update(dayTaskId, {
          status: 'completed', pushed: [], reason: 'link_unavailable',
          missing_link_count: missingLinkCount,
        });
        logWarn('sales.pending_deal_push.skipped', {
          day: dayKey, reason: 'link_unavailable', missing_link_count: missingLinkCount,
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'link_unavailable', missingLinkCount };
      }

      const chatId = this.chatId === undefined ? this.settings.chatId : this.chatId;
      const text = this.buildText({ orders, missingLinkCount, dayKey });
      const messageId = await this.sendTextToChat(text, chatId);
      if (!messageId) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_chat' });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_chat', missingLinkCount };
      }
      // ⭐ 发出去了 → 顺手把**这一条**置顶（业务负责人 2026-10-07）。
      // 🔴 置顶在**推送记录落盘之前**执行，但它永不抛、永不改推送结果（见 pinMessage）：
      //    置顶挂掉只留一条 warn，下面这段"今天推过了"的记账照常进行。
      const pin = await this.pinMessage({ messageId, chatId, dayKey });
      await this.store.update(dayTaskId, {
        status: 'completed', message_id: messageId, text,
        pushed: orders.map((order) => order.salesEntryRecordId),
        missing_link_count: missingLinkCount,
        link_sources: orders.map((order) => order.linkSource),
        pinned: pin.pinned,
        pin_reason: pin.reason,
      });
      logInfo('sales.pending_deal_push.sent', {
        day: dayKey, order_count: orders.length, missing_link_count: missingLinkCount,
        order_ids: orders.map((order) => order.salesEntryRecordId),
        message_id: messageId,
        pinned: pin.pinned, pin_reason: pin.reason,
      });
      return {
        day: dayKey, pushedOrderCount: orders.length, messageId, missingLinkCount, reason: '',
        pinned: pin.pinned, pinReason: pin.reason,
      };
    } catch (error) {
      // 这一天不再重试（按天认领已经落盘），但把失败写进记录里，排查时能看到是哪一天掉的；
      // 第二天会重新进候选、照常再推一次。
      await this.store.update(dayTaskId, { status: 'failed', error: error.message }).catch(() => undefined);
      logWarn('sales.pending_deal_push.failed', { day: dayKey, error: error.message });
      throw error;
    }
  }
}

module.exports = { PendingDealPushService, dayMarkerId, money };
