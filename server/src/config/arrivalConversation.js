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
// ⚠️ 刻意**没有**「实际为 0」这一类 —— 但那是"差异**类型**只有三类"，
//    **不等于**"算出来的**实际数量**不能是 0"。
// ⭐ 2026-10-07 她纠正（逐字）：「**如果这个尺码算下来为 0，那么就不用入库啊！**」
//    ⇒ `实际 = 0` 是**由「少」这条差异算出来的正常结果**（例：申请 1 双、她说少 1 双），
//      该行**不入库、但不阻断整单**；差异**类型**仍然只有下面这三个。
//    口径见 `docs/arrival-zero-arrived-rule-2026-10-07.md`。
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
    // ⭐ 2026-10-07：算出来 `实际 = 0` 的行**不是错误**（供应商漏发了一整双），
    //    卡片上要让它看得出来是"这双没到"。这两个旋钮就是那两句可见文案。
    zeroActualNote: '这双没到，不入库',
    zeroRowsNote: '标「这双没到」的行我不会入库，也不会写库存流水。',
    // ⭐ 2026-10-07：失败时把那张卡片改成终态时的**标题**（红色 header）。
    //    她连着两次说「卡片点击后没有任何反应」——只弹 toast 不算反馈，
    //    失败必须在**她点的那张卡片上**看得出来。
    failedTitle: '采购到货核对没成功',
  },
  // 点「是」之后回群里那句结果的**模板**（`{key}` 由 service 填；模板可配 = 改文案不碰逻辑）。
  summary: {
    // 全部行都到货（没有 0 行）时用这句 —— 与改动前的逐字相同。
    posted: '已按实际到货入库：{rowCount} 条明细 / 共 {total} 双（报货批次号 {batchNo}）。',
    // 有一部分行 `实际 = 0`：那些行不入库，必须在回话里说清楚。
    postedWithZero: '已按实际到货入库：{rowCount} 条明细 / 共 {total} 双；另有 {zeroCount} 条实际 0 双（没到），这 {zeroCount} 条我没有入库（报货批次号 {batchNo}）。',
    // 边界：这一批**每一行**都是 0 双（一件都没到）。不能写成"已入库 0 条"含糊过去。
    postedNothingArrived: '这批单子你说下来一件都没到（{zeroCount} 条明细全是 0 双），我没有入库、也没有写库存流水（报货批次号 {batchNo}）。',
  },
  replies: {
    // 业务负责人原话：「只回一句"好，那先不入库"」——一个字不多写。
    rejected: '好，那先不入库',
    // 重复点「是」/ 重复投递时的回执（幂等，不重复入库）。
    alreadyPosted: '这一批已经入库了，我没有重复写。',
    // 点「是」但任务里还没有算好的计划（读明细失败 / 卡片没发出去这种兜底）。
    // ⚠️ 2026-10-07 改文案：**不许**再让她"先说一句核对完了" —— 那条口令已经废掉
    //    （业务负责人：「用户一般一句话就能够说清楚这个事情」）。这里只说明"我还没算出来"。
    notConfirmedYet: '我这边还没算出这一批的核对结果，你再说一句实际到货，我重算一遍。',
    // ⭐ 2026-10-07 新增：她说了一句，但**这句话里没有可核对的到货信息**
    //    （半句话，或话题里的闲聊）。这时**绝不能**当成"全部到货"发卡片
    //    （那会让她一点「是」就按申请数整单入库），而是教她怎么说。
    //    只在模型认为"信息够了"（`complete === true`）却什么都没给出来时才回 ——
    //    否则静默，避免刷屏。（提示词里 `complete` 已改成"她给的信息够不够算"。）
    noArrivalContent: '这句里我没听出到货的变化。跟单子一样就说一句「都到了」；有多的少的，说一下货号、尺码和双数。',
    // ⭐ 2026-10-07 新增：她已经有一张待确认卡片，又补充/修正了一句 ——
    //    我们**重算并更新那一张卡**（不发第二张），回一句让她知道卡片已经变了。
    //    置空字符串 = 不回这句（卡片本身会原地刷新）。
    updatedCard: '我按你刚说的重算了一遍，上面那张卡片已经更新 —— 你看一眼，点「是」我就按新的数量入库。',
    // 解析出来的差异对不上采购申请明细：明确说清，**不入库、不猜**。
    unmatched: '我没把你说的话对上这批采购申请的明细，先不入库。你说一下具体哪个尺码、多少双，我重算一遍。',
    // ⭐ 2026-10-07：算出来是**负数**（她说少的双数比这行申请数还多）。
    //    货号/尺码其实对上了，是**数字**对不上 —— 所以**不能**复用上面那句"对不上明细"
    //    （那句话会让她去改货号/尺码）。也**不静默当成 0 双**（那是替她编一行"没到"）。
    negative: '这个尺码你说少的双数比申请数还多，我算出来是负数，先不入库。你说一下这个尺码实际到了几双，我重算一遍。',
    // 核对期间没有任何可核对的明细（例如群里发的是别的单据）。
    noRows: '这批单子我没找到可以核对的采购申请明细，先不动。',
    // 已经入过库之后她又说话：不静默，明确告诉她这批已经处理过了。
    // ⭐ 2026-10-07 明确这是**有意选的"安全默认"**：**不自动重开、不自动改账** ——
    //    自动重开等于自动反向写库存，是这里最危险的做法（她最在意的就是"写错账"）。
    //    所以：一个字都不写 + 如实告诉她 + 让她给指令。
    // ⚠️ 已知缺口（未做）：这句里的"要改请告诉我该改哪一条"目前**没有配套的自动入口**，
    //    真要改得走人工库存调整（工作台盘点调整）。要做自动改账路径时，从这里起。
    afterPosted: '这一批已经入过库了，我没有再动任何表。要改请告诉我该改哪一条。',
    // ⭐ 2026-10-07 新增（她连着两次「卡片点击后没有任何反应」）：
    //    **失败必须在话题里留下一条看得见的东西**。下面四句就是那四个失败口子的文案，
    //    全部带 `{error}` 占位（`formatCopy` 填）—— **错误原文一个字都不许吞**。
    //    用法：卡片会被 patch 成红色终态（标题 = `card.failedTitle`），同时把同一句回到话题里。
    //
    // ① 点「是」之后入库那一步抛错（到货行已建、后面断了）：可以从断点重试。
    inboundFailed: '入库没成功：{error}。请再点一次「是」，我会从断点接着写，不会重复入库。',
    // ② 「采购到货」这一行都没建成（连入库都没开始）——以前这里**只弹 toast**，群里啥也没有。
    arrivalCreateFailed: '「采购到货」这一行没建成：{error}。请再点一次「是」我重试。',
    // ③ 任务丢了（本地记录被清 / 卡片是别处的）——以前也**只弹 toast**。
    taskMissing: '这条到货核对记录我已经找不到了，没法入库。你把「都到了」或差异再说一句，我重新核一遍。',
    // ④ 点「是」但任务里还没有算好的计划（她说的话我们没算出结果 / 卡片没发出去）——
    //    复用既有那句 `notConfirmedYet`（上面），这里不另写一份。
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
  const summary = { ...DEFAULTS.summary, ...(options.summary || {}) };
  return {
    enabled: options.enabled ?? parseExplicitBoolean(env.PURCHASE_ARRIVAL_CONVERSATION_ENABLED, DEFAULTS.enabled),
    maxTranscriptChars: positiveInteger(
      options.maxTranscriptChars, DEFAULTS.maxTranscriptChars, 'maxTranscriptChars',
    ),
    maxRequestRows: positiveInteger(options.maxRequestRows, DEFAULTS.maxRequestRows, 'maxRequestRows'),
    acceptanceTextSeparator: options.acceptanceTextSeparator ?? DEFAULTS.acceptanceTextSeparator,
    card,
    replies,
    summary,
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
