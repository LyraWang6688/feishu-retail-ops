/**
 * 「批量打印」飞书表单 → 自动打印 这条链路的**配置**（唯一真源；service 里不写死数字/文案）。
 *
 * 业务口径（业务负责人 2026-11-09，逐字/确认）：
 *   · 「点「批量打印」进的是飞书表单链接，后续就只用这个了」⇒ 表单是唯一的批量入口；
 *   · 一条表单记录可勾**多个**「打印货号」⇒ **每个货号各打各的**（一个失败不拖累其他）；
 *   · 选到**没编号 / 没库存**的货号 ⇒ **跳过**（其他照打）；
 *   · 失败 / 跳过 ⇒ **同一条表单记录汇总一条**通知，发运营群；
 *   · 临时错误（网络 / 飞书 5xx）**重试 3 次**（首次失败后再试 3 次 ⇒ 最多 4 次尝试）；
 *     永久错误（没编号 / 没库存 / 参数不对）**不重试**；
 *   · 店里电脑离线 ⇒ 任务排队、上线自动补打（**现有队列机制**，本链路不判失败）；
 *   · 「打印日」是飞书自动字段，**代码一行都不写**。
 */
const readInt = (raw, fallback, { min, max }) => {
  const value = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
};

const LABEL_FORM_INTAKE = Object.freeze({
  // 通知走统一通知配置（`config/notifications.js` 注册的 event key）。
  notificationEvent: 'label_print_failed',
  // 幂等键前缀：`label_form:<表单记录ID>:<货品记录ID>`（同一条记录/同一货品只打一次）。
  submitKeyPrefix: 'label_form',
  // 队列来源（`config/labelPrintQueue.js` 的 SOURCES.form）。
  queueSource: 'form',
  // 只认「新增」动作（表单提交 = 新增一条记录）；删除 / 编辑不触发打印。
  triggerActions: Object.freeze(['record_added']),
  // 临时错误的重试次数（0 = 不重试）。业务负责人 2026-11-09：「3 次」。
  retries: readInt(process.env.LABEL_FORM_INTAKE_RETRIES, 3, { min: 0, max: 5 }),
  // 通知里每条最多列多少个货号（一次勾太多时防止消息刷屏；剩余用「…等 N 个」）。
  notifyMaxItems: readInt(process.env.LABEL_FORM_INTAKE_NOTIFY_MAX_ITEMS, 20, { min: 1, max: 100 }),
  // 同一条表单记录的**本地去重窗口**（飞书事件可能重投；窗口内重复投递不再处理/不再通知）。
  dedupeTtlMs: readInt(process.env.LABEL_FORM_INTAKE_DEDUPE_TTL_MS, 10 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 }),
  // 用户可见文案（service 层不写中文；占位符由 service 填）。
  texts: Object.freeze({
    title: '【标签打印】',
    header: '表单记录 {recordId}：本次勾选 {total} 个货号',
    emptySelection: '表单记录 {recordId}：没有勾选「打印货号」，没有可打印的东西',
    queued: '已排队打印 {count} 个：{items}',
    skipped: '跳过 {count} 个（没编号 / 没库存）：{items}',
    failed: '失败 {count} 个：{items}',
    retriedNote: '（其中 {count} 个已重试 {retries} 次仍失败）',
    time: '时间：{time}',
    listSeparator: '、',
    itemSeparator: '；',
    reasonSeparator: ' — ',
    moreItems: '…等 {count} 个',
  }),
});

module.exports = { LABEL_FORM_INTAKE };
