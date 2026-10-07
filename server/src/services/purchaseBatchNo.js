// 「这句话里说的是哪一批单」——批次号从自然语言里的识别规则（配置先行）。
//
// 报货批次号是**人可读、可复述**的批次标识。业务负责人 2026-10-07 把它从
// 「她手填 + 后端出单时生成 `BH-YYYYMMDD-NNNN`」改成「**后端代码生成 `CGD-YYYYMMDD-NNNN`**」
//（格式与生成规则见 `config/purchaseBatchNo.js` 与 `services/purchaseBatchNoGenerator.js`）。
//
// ⚠️ 两件事**刻意分开**（别合并）：
//   · **生成**只认 `CGD-`（新号）；
//   · **识别**同时认 `CGD-` 与 `BH-` —— `BH-` 是历史格式，生产表里有这样的号、
//     她此前的群消息也可能还引用着它。历史号认不出 = 她在群里说的话机器人当没听见。
//
// 为什么把正则放在配置里：格式将来可能再改（前缀、位数、换纯数字），
// 改的时候只动 `config/purchaseBatchNo.js`，不去改定位函数里的 if。

const {
  resolvePurchaseBatchNoConfig,
  buildBatchNoPattern,
  DEFAULT_RECOGNIZED_PREFIXES,
  DEFAULT_PURCHASE_BATCH_NO_DIGITS,
} = require('../config/purchaseBatchNo');

// ⚠️ 正则用**全局**匹配（带 g）：一句话里可能出现两个号（她改了主意、或引用了别的单），
// 那种情况定位函数会按「说不清」处理并反问，绝不挑其中一个。见 purchaseBatchLocator。
//
// ⚠️ `BATCH_NO_PATTERN` 是**默认配置**下的那一把（不含环境变量覆盖）——它只是给
// 「没显式传 pattern」的调用方一个可读的镜像。真正生效的那把在 `extractBatchNos` 里
// **按调用时的配置**现建，所以改环境变量前缀/位数之后不必再动这里的代码。
const BATCH_NO_PATTERN = buildBatchNoPattern({
  recognizedPrefixes: DEFAULT_RECOGNIZED_PREFIXES,
  digits: DEFAULT_PURCHASE_BATCH_NO_DIGITS,
});

/**
 * 从一段自然语言里抽出所有像「批次号」的字符串。
 *
 * 返回**全部**命中（已去重、按出现顺序），不是第一个：
 * 「说了两个号」和「一个号都没说」要能区分开——前者是歧义，后者才是没说。
 *
 * @param {string} text 用户原话（已剥掉 @ 占位符）
 * @param {RegExp} [pattern] 可注入，便于测试与将来换格式；不传 = 按当前配置现建
 * @returns {string[]} 命中的批次号（可能为空）
 */
const extractBatchNos = (text, pattern) => {
  const value = String(text || '');
  if (!value) return [];
  const source = pattern || buildBatchNoPattern(resolvePurchaseBatchNoConfig());
  // 每次调用重建正则：带 g 的正则有 lastIndex 状态，复用同一个实例会漏掉第二次之后的匹配。
  const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`;
  const matcher = new RegExp(source.source, flags);
  const found = [];
  for (const match of value.matchAll(matcher)) {
    const batchNo = String(match[0] || '').trim();
    if (batchNo && !found.includes(batchNo)) found.push(batchNo);
  }
  return found;
};

module.exports = { BATCH_NO_PATTERN, extractBatchNos };
