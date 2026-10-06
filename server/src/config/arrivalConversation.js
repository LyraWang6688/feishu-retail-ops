/**
 * 「采购到货：群话题对话式核对」的**行为配置**（开关 / 阈值 / 文案 / 编码）。
 *
 * 为什么单独一个配置文件（而不是把常量塞进 service）：
 *   AGENTS.md《底层工程原则》要求「阈值 / 开关 / 字段映射 / 行为编码一律可配」，
 *   换一个值不该改代码。这里放的就是那些值。
 *
 * ⚠️ 本文件只放**配置**，不放业务逻辑；三段差异的解析提示词在
 *   `services/doubaoService.js`（和销售录单、采购数量说明一样，提示词属于模型那一层的实现）。
 *
 * ⚠️ 与已退场的「拍照识别到货」**没有任何耦合**：
 *   不复用 `PURCHASE_ARRIVAL_INTAKE_ENABLED`（那个模块现在没有读取点、语义是"图片入口"），
 *   本流程用自己的开关，那条链路明天再退场也影响不到这里。
 */

// 卡片上的两个动作名。
//
// ⚠️ **刻意不复用**被删掉的 `confirm_purchase_arrival` / `cancel_purchase_arrival`：
//   线上可能还有历史到货卡片没点过，它们的 draft_id 指向的是旧任务；沿用同名动作
//   会让那些老卡片的点击落到这条新链路上（点一下就按旧任务入库），这是"复活残骸"。
//   另起名字之后，老卡片点了只会找不到分派，什么都不会发生（保持退场状态）。
const ARRIVAL_CONVERSATION_ACTIONS = Object.freeze({
  CONFIRM: 'confirm_arrival_reconcile',
  REJECT: 'reject_arrival_reconcile',
});

// 「群消息映射」里的批次类型。定位器只回答"是哪一批"，
// 但**采购申请单和采购退货单共用同一个群话题**（都走 deliverSupplierImages），
// 所以到货核对必须先认出这批单子是哪一种，否则会把退货话题当成到货核对、
// 甚至给退货批次建一条「采购到货」记录。
const ARRIVAL_BATCH_KINDS = Object.freeze({
  PURCHASE_REQUEST: 'purchase-request',
  PURCHASE_RETURN: 'purchase-return',
});

// 三段差异（业务负责人 2026-10-06 定的口径，**只有这三类**：
// 完全一样 / 实际比申请多 / 实际比申请少）。
// ⚠️ 刻意**没有**「实际为 0」这一类——她明确说"实际到货不会为 0，因为肯定会到货"。
const ARRIVAL_DIFF_TYPES = Object.freeze({
  SAME: 'same',
  MORE: 'more',
  LESS: 'less',
});

const DEFAULTS = Object.freeze({
  enabled: true,
  // 交给模型的原话上限（字符）。超长只截断投喂，本地记录原样保留。
  maxTranscriptChars: 4000,
  // 一批最多核对多少条采购申请明细（防御性上限：异常数据不要打爆提示词）。
  maxRequestRows: 200,
  // 多句原话归集成一个「验收原话」时用的连接符（该字段是单值文本，飞书里没有多值容器）。
  acceptanceTextSeparator: '\n',
  // 卡片文案（用户可见文案一律可配，改文案不碰逻辑）。
  card: {
    title: '本次到货核对完毕，确认入库吗？',
    confirmLabel: '是',
    rejectLabel: '否',
    summaryHeading: '按你说的实际到货',
    hint: '点「是」我就按实际数量入库；点「否」我这次什么都不写。',
  },
  replies: {
    // 业务负责人原话：「只回一句"好，那先不入库"」——一个字不多写。
    rejected: '好，那先不入库',
    // 重复点「是」/ 重复投递时的回执（幂等，不重复入库）。
    alreadyPosted: '这一批已经入库了，我没有重复写。',
    // 点「是」但还没说完（理论上到不了这里，兜底避免她点了没反应）。
    notConfirmedYet: '我还没听你说「核对完了」，你补充完再说一声。',
    // 解析出来的差异对不上采购申请明细：明确说清，**不入库、不猜**。
    unmatched: '我没把你说的话对上这批采购申请的明细，先不入库。你说一下具体哪个尺码、多少双，我重算一遍。',
    // 核对期间没有任何可核对的明细（例如群里发的是别的单据）。
    noRows: '这批单子我没找到可以核对的采购申请明细，先不动。',
    // 已经入过库之后她又说话：不静默，明确告诉她这批已经处理过了。
    afterPosted: '这一批已经入过库了，我没有再动任何表。要改请告诉我该改哪一条。',
  },
});

// 「显式布尔」解析：**不用 `|| fallback`**。
// 用 `||` 的坑是"清空变量"会回退到默认值，于是 `PURCHASE_ARRIVAL_CONVERSATION_ENABLED=`
// 反而打不开/关不掉（AGENTS.md 专门点了这个坑）。这里把空串当成"没配"，其余按字面认。
const parseExplicitBoolean = (raw, fallback) => {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`PURCHASE_ARRIVAL_CONVERSATION_ENABLED 必须是 true/false，收到：${raw}`);
};

const positiveInteger = (value, fallback, label) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数，收到：${value}`);
  return parsed;
};

/**
 * 组装本次运行的配置。`options` 可覆盖任意一项（测试用；生产走环境变量）。
 * 环境变量在每次调用时读，不在模块加载时求值——避免 dotenv 顺序问题
 *（2026-10-06 线上事故的教训：模块级求值会在空环境里定稿）。
 */
const resolveArrivalConversationConfig = (options = {}) => {
  const env = options.env || process.env;
  const card = { ...DEFAULTS.card, ...(options.card || {}) };
  const replies = { ...DEFAULTS.replies, ...(options.replies || {}) };
  return {
    enabled: options.enabled ?? parseExplicitBoolean(env.PURCHASE_ARRIVAL_CONVERSATION_ENABLED, DEFAULTS.enabled),
    maxTranscriptChars: positiveInteger(
      options.maxTranscriptChars, DEFAULTS.maxTranscriptChars, 'maxTranscriptChars',
    ),
    maxRequestRows: positiveInteger(options.maxRequestRows, DEFAULTS.maxRequestRows, 'maxRequestRows'),
    acceptanceTextSeparator: options.acceptanceTextSeparator ?? DEFAULTS.acceptanceTextSeparator,
    card,
    replies,
  };
};

module.exports = {
  ARRIVAL_CONVERSATION_ACTIONS,
  ARRIVAL_BATCH_KINDS,
  ARRIVAL_DIFF_TYPES,
  ARRIVAL_CONVERSATION_DEFAULTS: DEFAULTS,
  resolveArrivalConversationConfig,
  parseExplicitBoolean,
};
