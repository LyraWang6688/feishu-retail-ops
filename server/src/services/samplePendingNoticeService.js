/**
 * ⭐⭐ 2026-10-11（业务负责人 20:30 逐条确认）：**待办汇总 → 发采购群**。
 *
 * 她的话（要点）：**一天 5 次**（9/12/15/18/21，可配）· **完全单独一条消息**
 * （**不并进**现有 9 点推送那条）· 发给**采购群**（`PURCHASE_CHAT_ID`）·
 * 文案：`待办还有 N 条：待补充 X 条 · 其中待补样品 Y 条 · 待交割 Z 条 → 去工作台处理`。
 *   🔴 **2026-10-12 现场事故修正**：原先 `total` 数的是"**全部已入账单**"（含已两清），
 *      现场那条成了 `supplement 10 · sample 8 · pending 5 · total 76` ⇒ 与文案自相矛盾。
 *      现在 **`total = supplement + pending`**（三段待办之和；`sample` 是 `supplement` 的子集、
 *      **不重复加**；已两清不是待办），文案里加「其中」把子集关系说清 —— 见
 *      `services/workbenchOrderSections.js` 的 `workbenchCountsOf` 与 AC-PN5。
 *
 * 落点：
 *   · 计数 = **工作台订单列表的同一份取数**（`SalesFollowupService.listOrders`）＋
 *     同一份判据（`services/workbenchOrderSections.js`，与前端 `salesSectionOf` 逐条对齐，
 *     由 AC-PN4 用同一组 fixture 钉住）；
 *   · 发送 = **复用** `PurchaseWebhookService.sendPurchaseGroupNotice`
 *     （`purchaseWebhookService.js:518-541`）——它读 `config/groupPurchase.resolvePurchaseChatId()`，
 *     ⚠️ **没配采购群 ⇒ 大声 warn 跳过、绝不回落私聊**（那条口径它自己已经实现，本文件不重做）。
 *
 * ⚠️ **必须自己判"这个时点发过没有"**：`utils/shanghaiDailyScheduler` 的 `hours` 语义是
 *    "过了其中任何一个整点之后**每个 tick 都调一次** `run`"（见该文件第 6 行）⇒
 *    去重按**「上海日 + 整点」**落一条标记（`data/sample_pending_notice/<YYYY-MM-DD-HH>.json`），
 *    重启/多 tick 都不会重复发。
 */
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { resolveSamplePendingNoticeConfig } = require('../config/samplePendingNotice');
const { workbenchCountsOf } = require('./workbenchOrderSections');
const { logInfo, logWarn } = require('../utils/logger');

const fillText = (template, values = {}) => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? match : String(values[key])));

/** 上海时间的 `YYYY-MM-DD` 与整点（**汇报与去重都用上海时间**）。 */
const shanghaiParts = (now) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { dayKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

const createSamplePendingNoticeService = (options = {}) => {
  const settings = options.settings || resolveSamplePendingNoticeConfig();
  const store = options.store || new JsonTaskStore({
    dir: settings.storeDir, idField: 'task_id',
  });
  // 取数：工作台订单列表那份（只读）。用例可注入一个假的。
  let listOrders = options.listOrders || null;
  const resolveListOrders = () => {
    if (!listOrders) {
      // eslint-disable-next-line global-require
      const { SalesFollowupService } = require('./salesFollowupService');
      // eslint-disable-next-line global-require
      const { V1BitableGateway } = require('./v1BitableGateway');
      const followup = new SalesFollowupService({ gateway: new V1BitableGateway() });
      listOrders = () => followup.listOrders();
    }
    return listOrders;
  };
  // 发送：复用采购群那条既有出口（默认）；用例可注入。
  let send = options.send || null;
  const resolveSend = () => {
    if (!send) {
      // eslint-disable-next-line global-require
      const { PurchaseWebhookService } = require('./purchaseWebhookService');
      const webhooks = options.webhooks || new PurchaseWebhookService({});
      send = (text, correlation) => webhooks.sendPurchaseGroupNotice(text, { correlation });
    }
    return send;
  };

  const counts = async () => {
    const { orders = [] } = await resolveListOrders()();
    return workbenchCountsOf(orders);
  };

  const textOf = (values) => fillText(settings.text, values);

  /**
   * 到点执行一次：`{ sent, reason?, slot, counts?, text? }`。
   * ⚠️ 同一个「上海日 + 整点」只发一次（`already_sent`）；共 0 条默认不发（`empty`，可配）。
   */
  const send_ = async ({ now = new Date() } = {}) => {
    if (!settings.enabled) return { sent: false, reason: 'disabled' };
    const { dayKey, hour } = shanghaiParts(now);
    // ⚠️⚠️ 去重的槽位 = **最近一个已经过去的【配置时点】**，不是"当前整点"。
    //    为什么：`startShanghaiDailyScheduler` 的 `hours` 语义是"过了其中**任何一个**整点之后
    //    **每个 tick 都会调一次** `run`"（该文件第 6 行）⇒ 用"当前整点"当槽位的话，
    //    18:00 发过一次之后，20:33 那次 tick 会算出一个**新槽位**（`…-20`）⇒ **一天多发一条**。
    //    （这条正是 2026-10-11 真启动核对时抓到的：日志里 `slot: 2026-10-11-20`。）
    const slotHour = [...settings.hours].filter((item) => item <= hour).pop();
    if (slotHour === undefined) return { sent: false, reason: 'before_first_hour', slot: `${dayKey}-none` };
    const slot = `${dayKey}-${String(slotHour).padStart(2, '0')}`;
    if (await store.get(slot)) return { sent: false, reason: 'already_sent', slot };
    let values;
    try {
      values = await counts();
    } catch (error) {
      logWarn('workbench.sample_pending_notice.counts_failed', {
        slot, error: error.message, hint: '这一次不推；下一个时点会再算一次',
      });
      return { sent: false, reason: 'counts_failed', slot, error: error.message };
    }
    if (values.total === 0 && !settings.sendWhenEmpty) {
      logInfo('workbench.sample_pending_notice.skipped_empty', { slot, counts: values });
      return { sent: false, reason: 'empty', slot, counts: values };
    }
    const text = textOf(values);
    let ok = false;
    try {
      ok = await resolveSend()(text, { settle_day: slot });
    } catch (error) {
      // 发送失败**不标记** ⇒ 下个 tick 还会试（采购群出口自己已记大声的日志）
      logWarn('workbench.sample_pending_notice.send_failed', { slot, error: error.message, text });
      return { sent: false, reason: 'send_failed', slot, counts: values, text };
    }
    if (!ok) {
      // 没配群 / 出口明确说没发出去 ⇒ **不标记**（配好群之后还能补发这个时点）
      logWarn('workbench.sample_pending_notice.not_sent', {
        slot, counts: values, hint: '出口说没发出去（多半是没配 PURCHASE_CHAT_ID），这一次不标记',
      });
      return { sent: false, reason: 'not_sent', slot, counts: values, text };
    }
    await store.create({ task_id: slot, type: 'sample_pending_notice', status: 'completed', counts: values, text });
    logInfo('workbench.sample_pending_notice.sent', { slot, counts: values, text });
    return { sent: true, slot, counts: values, text };
  };

  return { send: send_, counts, textOf, settings, store };
};

module.exports = { createSamplePendingNoticeService, shanghaiParts, fillText };
