// 「补货品信息」这一段的**显示配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 拍板，逐字）：
//   「我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了。
//    所以我们在销售信息确认卡片里不需要放这个信息；等用户点击确认之后，卡片不是会更新吗？
//    更新时再补这个信息。」
//   ⇒ 这一段从**销售确认卡片**挪到**点确认之后更新的卡片**（处理中卡 + 已入账终态卡）。
//   位置变了，**文案与行格式一个字不改** —— 所以下面每个默认值都照抄原来的字面量。
//
// ⚠️ 这里**只有显示**：缺口从哪来（卖单解析时读一次「货品信息」表 → `productInfoGapsFromIndex`
//   → `draft.product_info_gaps`）与这一段**无关**，本文件一行都不碰判定。
// ⚠️ **取值规则走 `config/envValue`**（**没设** → 默认值；**设了**（含空串）→ 就是显式取值），
//   与 `salesProcessingCard` / `privateChatNotice` / `salesDailyReportPush` 共用同一套，
//   避免"空串算不算关"各处走歪。
// ⚠️ **调用时才解析**（`resolveProductInfoGapsConfig(process.env)`），不在模块加载时求值 ——
//   2026-10-06 的 dotenv 加载顺序事故就是这么来的。
// ⚠️ 空串的语义 = **那一项渲染成空**（例如 `..._MISSING_LABEL=''` → 「66356米 成本」），
//   **不回退默认值**；但**段落标题**留空时整段退化为"只有行" —— 那是她要的"别留空壳"之外的
//   另一种显式选择，不是 bug（真正"不要这一段"的办法是缺口为空，或把上限配成 0）。

const { readRaw, readString, readInt } = require('./envValue');

const TITLE_KEY = 'PRODUCT_INFO_GAPS_TITLE';
const MISSING_LABEL_KEY = 'PRODUCT_INFO_GAPS_MISSING_LABEL';
const SAMPLE_IMAGE_LABEL_KEY = 'PRODUCT_INFO_GAPS_SAMPLE_IMAGE_LABEL';
const LINK_LABEL_KEY = 'PRODUCT_INFO_GAPS_LINK_LABEL';
const OVERFLOW_TEXT_KEY = 'PRODUCT_INFO_GAPS_OVERFLOW_TEXT';
const MAX_LINES_KEY = 'PRODUCT_INFO_GAPS_MAX_LINES';

// 每行「缺哪些项」里，「样例图」是附件字段、不在飞书那条公式里，所以由代码单独补上它的名字。
const MAX_LINES_LIMIT = 40;

// 默认值（= 挪位置**之前**那张确认卡片上的逐字文案，一个字都不能变）。
const DEFAULTS = Object.freeze({
  // 段落标题。原来是 `补货品信息\n${lines.join('\n')}` 里的第一行。
  title: '补货品信息',
  // 每行 `<货号+颜色> ` 与缺项之间的那三个字。
  missingLabel: '还差：',
  // 缺项里「样例图」这一项的显示名（公式列里没有它，代码单独判、单独给名字）。
  sampleImageLabel: '样例图',
  // 缺项后面那个飞书链接的可见文字。
  linkLabel: '去补全这条记录',
  // 超过上限时那最后一行。`{count}` 会被替换成"还有几个"。
  overflowText: '还有 {count} 个颜色也缺资料，可在「货品信息」里筛选「信息是否齐备」查看。',
  // 飞书卡片有高度上限，太长会被截断。实测门店的货号最多 3 个颜色，
  // 这里留一道安全阀：超过就只列这么多条并注明还有多少（正常营业永远碰不到）。
  maxLines: 6,
});

/**
 * 读一份「补货品信息」段落的显示配置。任何一项：
 *   · 环境变量**没设** → 默认值；
 *   · **设了**（含空串）→ 用设的值（`maxLines` 例外：空串 = 用默认值，见 envValue.readInt）。
 */
const resolveProductInfoGapsConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  return {
    title: read(TITLE_KEY, DEFAULTS.title),
    missingLabel: read(MISSING_LABEL_KEY, DEFAULTS.missingLabel),
    sampleImageLabel: read(SAMPLE_IMAGE_LABEL_KEY, DEFAULTS.sampleImageLabel),
    linkLabel: read(LINK_LABEL_KEY, DEFAULTS.linkLabel),
    overflowText: read(OVERFLOW_TEXT_KEY, DEFAULTS.overflowText),
    maxLines: readInt(env, MAX_LINES_KEY, DEFAULTS.maxLines, { min: 0, max: MAX_LINES_LIMIT }),
  };
};

module.exports = {
  TITLE_KEY,
  MISSING_LABEL_KEY,
  SAMPLE_IMAGE_LABEL_KEY,
  LINK_LABEL_KEY,
  OVERFLOW_TEXT_KEY,
  MAX_LINES_KEY,
  PRODUCT_INFO_GAPS_DEFAULTS: DEFAULTS,
  resolveProductInfoGapsConfig,
};
