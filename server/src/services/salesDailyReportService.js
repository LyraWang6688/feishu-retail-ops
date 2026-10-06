const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { asDate, shanghaiDayKey } = require('./saleLookupService');
const { resolveSalesDailyReportPushConfig } = require('../config/salesDailyReportPush');
const { salesDailyReportCard, salesDailyReportCardText } = require('../utils/salesDailyReportCard');
const { shanghaiHour } = require('../utils/shanghaiDailyScheduler');
const { logInfo, logWarn } = require('../utils/logger');

// 「销售战报」定时推送（业务负责人 2026-10-06 逐字确认的口径，**以那份 docs 为准**：
// docs/sales-daily-report-push-2026-10-06.md）。
//
// 一句话：北京时间 **9 / 12 / 15 / 18 / 21 点**（每 3 小时）＋ **22 点（当日收官）**，
// 把**一条消息卡片**发到**收采购图 / 退货单那个群的主聊天**（不进话题），卡上两个数字：
//   · **销售的单数** = 「销售明细」里「履约状态 = 已履约」的**条数**
//     （她：一条明细 = 一双鞋 = 一个销售单子；明细**没有**"数量"字段，所以就是数条数）；
//   · **销售的金额** = 「收款明细」里「已收款」、且**收款时间是今天、截至推送那一刻**的金额合计
//     （她逐字：「就是按照收款时间。就是今天的，在你推送之前，今天收到的所有的钱啊」）。
//
// ── 这个 service 的边界（模块化）────────────────────────────────────────────
//   · 它**只做战报**：不写任何业务表（纯读 + 发消息）；不在别处被调用。
//   · "哪些单 / 哪些钱"的口径就在 `collectStats` 一处，卡片渲染在 utils/salesDailyReportCard。
//   · 时间点 / 群列表 / 开关 / 两个筛选值全在 config/salesDailyReportPush（改口径不改代码）。
//
// ── 认领与"过期不补"（定时推送最容易出的两类错）─────────────────────────────
//   · **按时段认领**：同一天同一个整点只推一次（`sales_daily_report_<日>_<时>`），
//     所以重启 / 多 tick / 重复触发都不会发第二遍；
//   · 🔴 **过期的时段不补推**：12 点的战报 13 点才发出去是**错的数字被当成当时的快照**，
//     比"少发一条"更糟。过掉且没推成的时段只记一条 `slot_missed`（可排查），不补发。
//     ⚠️ 这与「未付/预付」那条每日提醒**故意不同**：那条"晚一点也要发"，战报不行。

// 「同一天同一时段只推一次」的认领键。
const slotMarkerId = (dayKey, hour) => `sales_daily_report_${dayKey}_${String(hour).padStart(2, '0')}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 金额单元格 → 数字（货币字段/文本都可能；读不出按 0，绝不让 NaN 混进合计）。 */
const amountOf = (value) => {
  const raw = textValue(value).replace(/,/g, '').replace(/¥/g, '').trim();
  if (!raw) return 0;
  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
};

class SalesDailyReportService {
  constructor(options = {}) {
    // 配置在这里**读一次**（启动时）：写错要在服务起来的那一刻就吵，而不是等到 9 点推送时。
    this.settings = options.settings || resolveSalesDailyReportPushConfig();
    this.gateway = options.gateway || new V1BitableGateway();
    // 发群消息用的飞书 client：网关本来就持有一个（app 凭证建的），默认复用它。
    this.client = options.client || this.gateway.client;
    // 群列表：显式传了就用它（测试注入）；`undefined` = 按配置。
    this.chatIds = options.chatIds;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/sales_daily_report'), idField: 'task_id',
    });
    // interval 可能在上一次还没跑完时又触发：串行化，免得同一个时段并发推两条。
    this.run = Promise.resolve();
  }

  slots() {
    return Array.isArray(this.settings.slots) && this.settings.slots.length
      ? this.settings.slots
      : [...(this.settings.hours || []), ...(this.settings.summaryHour === null ? [] : [this.settings.summaryHour])];
  }

  resolvedChatIds() {
    return this.chatIds === undefined ? (this.settings.chatIds || []) : this.chatIds;
  }

  isSummaryHour(hour) {
    return this.settings.summaryHour !== null && this.settings.summaryHour === Number(hour);
  }

  /**
   * 两个数字（**唯一的取数实现**）。
   *
   * ⚠️ 两个数字都按**上海自然日**算今天：线上服务器是 UTC，用本地时区会把凌晨的单/钱算到前一天
   * （与查单、第二次交付同一套口径，见 saleLookupService.shanghaiDayKey）。
   * ⚠️ 一笔都匹配不到时**不静默**：把当天真实出现的各个「履约状态」计数一起返回，
   * 调用方据此记一条可排查的警告（最可能的坏法是她把选项改了 / 测试表与生产不一致）。
   */
  async collectStats({ now = new Date() } = {}) {
    const dayKey = shanghaiDayKey(now);
    const dayStart = Date.parse(`${dayKey}T00:00:00+08:00`);
    const dayEnd = dayStart + DAY_MS;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const fulfilledStatuses = this.settings.fulfilledStatuses || [];
    const paymentStatus = this.settings.paymentStatus;

    const [details, payments] = await Promise.all([
      this.gateway.listAll('salesDetail'),
      this.gateway.listAll('paymentRecord'),
    ]);

    const statusHistogram = {};
    let salesCount = 0;
    details.forEach((record) => {
      const status = textValue(record.fields?.[detailFields.fulfillmentStatus]).trim();
      const soldAt = asDate(record.fields?.[detailFields.soldAt]);
      if (!soldAt || soldAt.getTime() < dayStart || soldAt.getTime() >= dayEnd) return;
      statusHistogram[status || '(空)'] = (statusHistogram[status || '(空)'] || 0) + 1;
      if (fulfilledStatuses.includes(status)) salesCount += 1;
    });

    let salesAmount = 0;
    let refundAmount = 0;
    let refundCount = 0;
    let paymentCount = 0;
    payments.forEach((record) => {
      if (textValue(record.fields?.[paymentFields.status]).trim() !== paymentStatus) return;
      const receivedAt = asDate(record.fields?.[paymentFields.receivedAt]);
      if (!receivedAt) return;
      // 「截止到推送那一刻」：晚于 now 的（理论上不存在）不算进来。
      if (receivedAt.getTime() < dayStart || receivedAt.getTime() > now.getTime()) return;
      const value = amountOf(record.fields?.[paymentFields.amount]);
      paymentCount += 1;
      salesAmount += value;
      // ⚠️ 退款在「收款明细」里也是「已收款」（见 config/afterSales 的钱方向说明）。
      //    按她的**字面口径**（只看状态 + 收款时间）它会被算进来——这里如实统计并在卡片上提示，
      //    **不擅自改口径**（要不要冲抵由她拍板）。
      const direction = textValue(record.fields?.[paymentFields.tradeDirection]).trim();
      if (direction === '退回') {
        refundAmount += value;
        refundCount += 1;
      }
    });

    return {
      dayKey,
      salesCount,
      salesAmount: Math.round(salesAmount * 100) / 100,
      refundAmount: Math.round(refundAmount * 100) / 100,
      refundCount,
      paymentCount,
      statusHistogram,
      today: { start: dayStart, end: dayEnd },
    };
  }

  /**
   * 卡片：**只有两个大数字块 + 标题**（她的样式要求：不写口径/公式，见 utils/salesDailyReportCard）。
   * 口径本身没变，只是不写在卡片上——口径在 docs/sales-daily-report-push-2026-10-06.md。
   */
  buildCard({ dayKey, hour, stats }) {
    return salesDailyReportCard({
      dayKey,
      hour,
      isSummary: this.isSummaryHour(hour),
      salesCount: stats.salesCount,
      salesAmount: stats.salesAmount,
    });
  }

  /** 发到群里（**主聊天**：走 create，不带 reply_in_thread、不引用任何消息）。 */
  async sendCardToChat(card, chatId) {
    if (!this.client?.im?.message?.create) throw new Error('销售战报推送缺少飞书 client，无法发送群消息');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`发送销售战报失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /** 每个 tick 都会调它；到底推不推由"这个时段该不该推"决定。 */
  sendReport({ now = new Date() } = {}) {
    const next = this.run.then(
      () => this._sendReport({ now }),
      () => this._sendReport({ now }),
    );
    this.run = next.catch(() => undefined);
    return next;
  }

  /** 过掉、且当天没有认领记录的时段：只记一条可排查的 missed，**不补发**（见文件头）。 */
  async markMissedSlots({ dayKey, hour }) {
    const missed = [];
    for (const slot of this.slots()) {
      if (slot >= hour) continue;
      const markerId = slotMarkerId(dayKey, slot);
      if (await this.store.get(markerId)) continue;
      await this.store.create({
        task_id: markerId, day: dayKey, hour: slot, status: 'missed',
        reason: 'slot_passed_before_push',
      });
      logWarn('sales.daily_report.slot_missed', {
        day: dayKey, hour: slot,
        hint: '这个时段过掉了（服务没跑 / 起晚了）——战报是当时的快照，**不补发**',
      });
      missed.push(slot);
    }
    return missed;
  }

  async _sendReport({ now }) {
    const { enabled } = this.settings;
    if (!enabled) {
      // 兜底闸门：app.js 不开定时器时其实走不到这里，但显式写出来，
      // 免得将来有人别的地方直接调它、把开关绕过。
      return { skipped: true, reason: 'disabled' };
    }
    const dayKey = shanghaiDayKey(now);
    const hour = shanghaiHour(now);
    const missedHours = await this.markMissedSlots({ dayKey, hour });
    if (!this.slots().includes(hour)) {
      return { day: dayKey, hour, sent: false, reason: 'not_a_slot_hour', missedHours };
    }

    const markerId = slotMarkerId(dayKey, hour);
    const existing = await this.store.get(markerId);
    // 'failed' 才重试（同一次 tick 间隔内自愈）；'running' 是"已经认领、正在发"，
    // 崩在这儿只会少发这一条，绝不能重发（与未付/预付推送同一条取舍）。
    if (existing && existing.status !== 'failed') {
      logInfo('sales.daily_report.skipped', {
        day: dayKey, hour, reason: 'already_ran_this_slot', status: existing.status,
      });
      return { day: dayKey, hour, sent: false, reason: 'already_ran_this_slot', missedHours };
    }
    await this.store.create({
      task_id: markerId, day: dayKey, hour, status: 'running',
      is_summary: this.isSummaryHour(hour),
    });

    const isSummary = this.isSummaryHour(hour);
    try {
      const stats = await this.collectStats({ now });
      if (stats.salesCount === 0 && Object.keys(stats.statusHistogram).length) {
        // 有明细、但没有一条是"已履约" → 大概率是**取值对不上**（选项改名），必须吵。
        logWarn('sales.daily_report.fulfilled_status_unmatched', {
          day: dayKey, hour, expected: this.settings.fulfilledStatuses,
          today_status_histogram: stats.statusHistogram,
          hint: '当天有销售明细但没有一条匹配"已履约"取值——核对她生产表里「履约状态」的选项，'
            + '改 SALES_DAILY_REPORT_FULFILLED_STATUSES 即可（不用改代码）',
        });
      }

      // 退款在「收款明细」里也是「已收款」，按她的字面口径会算进"今天收到的钱"。
      // ⚠️ 卡片上**不写**任何口径说明（她明确要求），所以这条只进日志，供排查/她问起时对账。
      if (stats.refundAmount > 0) {
        logWarn('sales.daily_report.refund_included', {
          day: dayKey, hour, refund_amount: stats.refundAmount, refund_count: stats.refundCount,
          hint: '今天「已收款」里有交易方向=退回的记录，按她的字面口径（只看收款状态+收款时间）**未冲抵**',
        });
      }

      const card = this.buildCard({ dayKey, hour, stats });
      const text = salesDailyReportCardText(card);
      const chatIds = this.resolvedChatIds();
      if (!chatIds.length) {
        // 没配群 = 不知道发哪儿。绝不回落到发给某个人（与采购 / 成交提醒同一条纪律）。
        await this.store.update(markerId, {
          status: 'completed', reason: 'no_chat', text,
          sales_count: stats.salesCount, sales_amount: stats.salesAmount,
        });
        logWarn('sales.daily_report.chat_missing', {
          env: 'SALES_DAILY_REPORT_PUSH_CHAT_IDS',
          hint: '没配群（PURCHASE_CHAT_ID 也空）——本次战报不推送',
        });
        return { day: dayKey, hour, sent: false, reason: 'no_chat', stats, missedHours };
      }

      const sentTo = [];
      const failed = [];
      for (const chatId of chatIds) {
        try {
          const messageId = await this.sendCardToChat(card, chatId);
          sentTo.push({ chatId, messageId });
        } catch (error) {
          failed.push({ chatId, error: error.message });
          logWarn('sales.daily_report.send_failed', { day: dayKey, hour, chat_id: chatId, error: error.message });
        }
      }
      const status = failed.length ? (sentTo.length ? 'partial' : 'failed') : 'completed';
      await this.store.update(markerId, {
        status, reason: failed.length ? 'send_failed' : '',
        sent_to: sentTo, failed: failed,
        sales_count: stats.salesCount, sales_amount: stats.salesAmount,
        refund_amount: stats.refundAmount, text,
      });
      logInfo('sales.daily_report.sent', {
        day: dayKey, hour, is_summary: isSummary, status,
        chat_count: chatIds.length, sent_count: sentTo.length, failed_count: failed.length,
        sales_count: stats.salesCount, sales_amount: stats.salesAmount,
        refund_amount: stats.refundAmount,
        message_ids: sentTo.map((item) => item.messageId),
      });
      return {
        day: dayKey, hour, isSummary, sent: sentTo.length > 0, status,
        stats, text, missedHours, sentTo, failed,
      };
    } catch (error) {
      // 这一次没成：记下原因（同一个小时内下一 tick 会重试；过了点就不再补，见文件头）。
      await this.store.update(markerId, { status: 'failed', error: error.message }).catch(() => undefined);
      logWarn('sales.daily_report.failed', { day: dayKey, hour, error: error.message });
      throw error;
    }
  }
}

module.exports = { SalesDailyReportService, slotMarkerId, amountOf };
