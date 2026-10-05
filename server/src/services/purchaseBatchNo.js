// 「这句话里说的是哪一批单」——批次号从自然语言里的识别规则（配置先行）。
//
// 报货批次号是目前唯一的**人可读、可复述**的批次标识（`BH-YYYYMMDD-0001`，
// 由 PurchaseWebhookService.nextBatchNo 生成）。业务负责人在群里说话时，
// 顺手打出来的就是它——所以定位链路②（没有引用、但说了批次号）靠它。
//
// 为什么把正则放在配置里：格式将来可能改（前缀、位数、换成纯数字），
// 改的时候只动这一个文件，不去改定位函数里的 if。

// ⚠️ 正则用**全局**匹配（带 g）：一句话里可能出现两个号（她改了主意、或引用了别的单），
// 那种情况定位函数会按「说不清」处理并反问，绝不挑其中一个。见 groupPurchaseBatchLocator。
const BATCH_NO_PATTERN = /\bBH-\d{8}-\d{4}\b/g;

/**
 * 从一段自然语言里抽出所有像「批次号」的字符串。
 *
 * 返回**全部**命中（已去重、按出现顺序），不是第一个：
 * 「说了两个号」和「一个号都没说」要能区分开——前者是歧义，后者才是没说。
 *
 * @param {string} text 用户原话（已剥掉 @ 占位符）
 * @param {RegExp} [pattern] 可注入，便于测试与将来换格式
 * @returns {string[]} 命中的批次号（可能为空）
 */
const extractBatchNos = (text, pattern = BATCH_NO_PATTERN) => {
  const value = String(text || '');
  if (!value) return [];
  // 每次调用重建正则：带 g 的正则有 lastIndex 状态，复用同一个实例会漏掉第二次之后的匹配。
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const found = [];
  for (const match of value.matchAll(matcher)) {
    const batchNo = String(match[0] || '').trim();
    if (batchNo && !found.includes(batchNo)) found.push(batchNo);
  }
  return found;
};

module.exports = { BATCH_NO_PATTERN, extractBatchNos };
