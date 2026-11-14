'use strict';

/**
 * 统一通知配置（2026-11-08 定稿）。
 *
 * 只有两个固定目标（业务负责人口径：目前私聊、群聊各一个）：
 *   · private → open_id（本人）
 *   · group   → chat_id（运营/采购群）
 *
 * 事件只声明“发到哪个目标 / 什么格式”，不各自读 process.env。
 * 🔴 2026-11-11（业务负责人）：「事件不需要开关，把开关去掉，因为就是要通知」
 *    ⇒ **单事件开关已全部移除**：事件被触发就发（不再有 `NOTIFY_<EVENT>_ENABLED`、也没有事件级默认开关）；
 *      真正的功能级总开关仍留在各自入口（例如观测告警总开关、心跳自检总开关、异步通知总开关）。
 * 所有通知统一发 interactive 消息卡片（Card JSON 2.0 + CardKit v1）。
 *
 * 取值规则沿用 config/envValue：
 *   · 没设 → 默认值；
 *   · 设了（含空串）→ 显式取值；
 *   · 认不出来 → 当场抛错。
 */
const { readString } = require('./envValue');

const NOTIFICATION_TARGETS = Object.freeze({
  private: Object.freeze({
    receiveIdType: 'open_id',
    env: 'NOTIFY_PRIVATE_OPEN_ID',
    fallbackEnv: 'OBSERVABILITY_ALERTS_OPEN_ID',
    label: '私聊',
  }),
  group: Object.freeze({
    receiveIdType: 'chat_id',
    env: 'NOTIFY_GROUP_CHAT_ID',
    fallbackEnv: 'PURCHASE_CHAT_ID',
    label: '群聊',
  }),
});

/**
 * 事件注册表。
 * ⚠️ 这里**没有** `enabled` / `masterEnv` —— 事件被触发就发（2026-11-11 业务负责人口径）；
 * 功能级总开关（是否启用整块能力）在各自入口判断，不在这里。
 * `card` 是 notificationCard 使用的标题/字段渲染键（文案真源仍在各自 config）。
 */
const NOTIFICATION_EVENTS = Object.freeze({
  async_job_failed: Object.freeze({
    target: 'group', format: 'card', card: 'async_job_failed', title: '【异步写入失败】',
  }),
  observability_alert: Object.freeze({
    target: 'private',
    format: 'card', card: 'observability_alert', title: '【观测告警】',
  }),
  lark_event_heartbeat: Object.freeze({
    target: 'private',
    format: 'card', card: 'lark_event_heartbeat', title: '【飞书事件心跳】',
  }),
  purchase_request_created: Object.freeze({
    target: 'group', format: 'text', card: 'purchase_request_created', title: '【采购申请】',
  }),
  purchase_return_created: Object.freeze({
    target: 'group', format: 'text', card: 'purchase_return_created', title: '【采购退货】',
  }),
  voucher_settlement: Object.freeze({
    target: 'group', format: 'card', card: 'voucher_settlement', title: '【团购券结算】',
  }),
  // ⭐ 2026-11-10（业务负责人）：采购单写成功后的「销售明细.采购明细」回填失败/部分失败
  //   （写关联失败、销售记录数量不足）→ 发运营群；上新/无可关联记录不会触发（见回填口径）。
  procurement_sales_link_backfill_failed: Object.freeze({
    target: 'group', format: 'card', card: 'procurement_sales_link_backfill_failed',
    title: '【采购明细回填失败】',
  }),
  // ⭐ 2026-11-09（业务负责人定）：「批量打印」表单自动打印时**失败 / 跳过**的汇总通知
  //   （同一条表单记录汇总成**一条**，发运营群；文本格式，不建卡片）。
  label_print_failed: Object.freeze({
    target: 'group', format: 'text', card: 'label_print_failed', title: '【标签打印】',
  }),
});


// 用户可见文案（service 层不许写中文；错误文案也在这里）。
const NOTIFICATION_TEXTS = Object.freeze({
  defaultTitle: '通知',
  cardUnsupported: '飞书客户端不支持 CardKit 创建卡片',
  cardCreateFailed: '创建卡片实体',
  cardMissingId: '创建卡片实体未返回 card_id',
  messageUnsupported: '飞书客户端不支持发送消息',
  textSendFailed: '发送文本失败',
  textMissingId: '发送文本未返回 message_id',
  messageSendFailed: '发送通知卡片',
  messageMissingId: '发送通知卡片未返回 message_id',
  targetMissing: '通知目标缺少 receiveId / receiveIdType',
  updateUnsupported: '飞书客户端不支持 CardKit 更新卡片',
  updateMissingId: '更新通知卡片缺少 card_id',
  cardUpdateFailed: '更新通知卡片',
});
const targetOf = (name) => NOTIFICATION_TARGETS[String(name || '')] || null;
const eventOf = (name) => NOTIFICATION_EVENTS[String(name || '')] || null;

/** 目标主变量优先，未配置时用 fallback；空串按“没配”处理（避免空串把 fallback 顶掉）。 */
const resolveReceiveId = (target, env) => {
  if (!target) return { receiveId: '', sourceEnv: '' };
  const primary = readString(env, target.env, '') || '';
  if (primary) return { receiveId: primary, sourceEnv: target.env };
  const fallback = readString(env, target.fallbackEnv, '') || '';
  if (fallback) return { receiveId: fallback, sourceEnv: target.fallbackEnv };
  return { receiveId: '', sourceEnv: target.env };
};

/**
 * 解析一个通知事件。
 * @returns {{event:string, enabled:boolean, target:string, receiveIdType:string,
 *   receiveId:string, chatId:string, openId:string, sourceEnv:string, reason:string}}
 */
const resolveNotification = (event, env = process.env) => {
  const definition = eventOf(event);
  if (!definition) {
    return { event: String(event || ''), enabled: false, target: '', receiveIdType: '',
      receiveId: '', chatId: '', openId: '', sourceEnv: '', reason: 'unknown_event' };
  }
  const targetName = definition.target;
  const target = targetOf(targetName);
  if (!target) {
    return { event, enabled: false, target: targetName || '', receiveIdType: '',
      receiveId: '', chatId: '', openId: '', sourceEnv: '', reason: 'unknown_target' };
  }
  // 🔴 2026-11-11：单事件开关已移除 —— 事件被触发就发，只有“目标没配”会跳过。
  const { receiveId, sourceEnv } = resolveReceiveId(target, env);
  const base = {
    event,
    enabled: true,
    target: targetName,
    receiveIdType: target.receiveIdType,
    receiveId,
    chatId: target.receiveIdType === 'chat_id' ? receiveId : '',
    openId: target.receiveIdType === 'open_id' ? receiveId : '',
    sourceEnv,
    reason: '',
  };
  if (!receiveId) return { ...base, reason: 'target_missing' };
  return { ...base, reason: 'ok' };
};

module.exports = {
  NOTIFICATION_TARGETS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_TEXTS,
  resolveNotification
};
