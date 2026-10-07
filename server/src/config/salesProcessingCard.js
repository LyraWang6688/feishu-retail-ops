// 「销售确认：点了确认之后那张卡片长什么样」的**显示配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 拍板，逐字）：
//   「**我点击了确认后，卡片其实没变化，就会很让我迷惑，到底点击没点击**，
//    目前消息卡片更新是在什么时候呢？看着像是整个流程走完才变化」
//   她**只选了 ⓐ**：「只用A就可以了！」——
//   「点确认后立刻卡片刻变【明显不同】：标题『⏳ 正在写入…』＋ 把明细变灰/加"处理中"」。
//   ⇒ 本文件就是那一版卡片的**全部可见文案与颜色**；改文案不碰逻辑。
//
// ⚠️ 这份配置**只管**「点确认后那一次立即更新」（`stage: 'processing'`）。
//   · 已经入账的终态卡（`stage: 'posted'`）走 `salesStatusCard`，**一行不动**（她满意那张）；
//   · 取消 / 待修正 / 部分交付 / 重复终态等卡片同样走 `salesStatusCard`，**不受影响**。
//   ⇒ 这样「只改显示、只动这一条链路」是可从代码结构上自证的，不是靠记性。
//
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值）。
//   与 `privateChatNotice` / `salesDailyReportPush` 共用同一套，避免"空串算不算关"各处走歪。
// ⚠️ **调用时才解析**（`resolveSalesProcessingCardConfig(process.env)`），
//   不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString } = require('./envValue');

const TITLE_KEY = 'SALES_PROCESSING_CARD_TITLE';
const TEMPLATE_KEY = 'SALES_PROCESSING_CARD_TEMPLATE';
const ITEM_COLOR_KEY = 'SALES_PROCESSING_CARD_ITEM_COLOR';
const PROGRESS_LINE_KEY = 'SALES_PROCESSING_CARD_PROGRESS_LINE';
const NOTE_KEY = 'SALES_PROCESSING_CARD_NOTE';

// 默认值（= 改完之后她第一眼会看到的那张卡）。
const DEFAULTS = Object.freeze({
  // ⭐ 标题必须"一眼看出已经点上了、正在写入"。
  //   为什么默认里**同时有「处理中」和「正在写入」**：
  //   · 「处理中」是这条链路既有的用户可见口径（`lark.sales.card.update` 的 stage=processing，
  //     既有测试也钉着 `/处理中/`）—— 摆在这里顺带保证"随口叫她说的那种词"不会丢；
  //   · 「⏳ 正在写入…」是她 2026-10-07 给的原话示例。
  //   她若想只留「⏳ 正在写入…」，改环境变量即可（见 .env.example），不用动代码。
  title: '⏳ 销售订单处理中 · 正在写入…',
  // 卡片头颜色。默认仍是「处理中」用的蓝（与原实现一致），可配成 orange 之类更扎眼的。
  template: 'blue',
  // ⭐ 明细区整段变灰用的颜色名（飞书 `<font color='…'>` 支持 grey/red/orange/…）。
  //   她要求「不仔细看标题也能看出变了」→ 明细与确认卡片**肉眼必须不同**。
  itemColor: 'grey',
  // ⭐ 明细上方那行醒目的"正在写入"提示。
  progressLine: '⏳ 正在写入销售记录与收款…',
  // 原有那句 note（**逐字保留**，只是从逻辑里挪进配置）。
  note: '已收到确认，正在写入销售记录和收款；请勿重复点击。',
});

/**
 * 读一份显示配置。任何一项：
 *   · 环境变量**没设** → 默认值；
 *   · **设了**（含空串）→ 用设的值（空串 = 显示成空，不回退默认 —— 与 envValue 的规矩一致）。
 */
const resolveSalesProcessingCardConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  return {
    title: read(TITLE_KEY, DEFAULTS.title),
    template: read(TEMPLATE_KEY, DEFAULTS.template),
    itemColor: read(ITEM_COLOR_KEY, DEFAULTS.itemColor),
    progressLine: read(PROGRESS_LINE_KEY, DEFAULTS.progressLine),
    note: read(NOTE_KEY, DEFAULTS.note),
  };
};

module.exports = {
  TITLE_KEY,
  TEMPLATE_KEY,
  ITEM_COLOR_KEY,
  PROGRESS_LINE_KEY,
  NOTE_KEY,
  SALES_PROCESSING_CARD_DEFAULTS: DEFAULTS,
  resolveSalesProcessingCardConfig,
};
