/**
 * 到货单价格 → 货品「成本」的判定规则（纯函数，便于单测）。
 *
 * 产品负责人的口径（2026-10-05）：
 *   「如果有的到货单上有价格的，那就是成本。」
 * 也就是：供应商出库单/送货单上的「销售价 / 单价 / 金额」列，对**我们**来说是进货成本，
 * 识别出来要写进「货品信息」的「成本」字段。
 *
 * ⚠️ 这里所有判断都按「保守、宁可不写」：
 *   - 只有能转成正数的价格才算可信；
 *   - 同一货号出现多个不同价格时不写（怕写错，交给人核对）；
 *   - 已有成本一律不覆盖。
 * 写错成本的代价（整条销售链路的利润/参考价都跟着错）远大于少写一次。
 */

/**
 * 把模型给的价格解析成「单件正数价格」。
 *
 * 模型在单据照片上看到的可能是 `199`、`"￥199.00"`、`"199元/双"`、`"1,299"`。
 * 能认出来的就取数字，认不出来（`""`、`"—"`、`"面议"`、`0`、负数）一律返回 null：
 * 宁可这次不写成本，也不能凭一个读不准的数字把成本写死。
 *
 * 刻意**不认区间写法**：`"199-299"` 里带 `-`，直接判为不可信，
 * 避免把区间的一端当成真实单价。
 *
 * 也刻意**不认「金额」**：整行金额是这一行所有尺码的合计，不是单件价格。
 * 提示词里已经要求模型只回单件价，这里再用一次规则兜底（见 modules.js）。
 */
const parseUnitCost = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'boolean' || typeof value === 'object') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // 负号 / 区间 / 破折号：一律不认（见文件头注释）。
  if (raw.includes('-')) return null;
  // 去掉货币符号、千分位、单位（元 / 双 / ￥ / ¥）、空格，只留下数字与小数点。
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * 货品「成本」是不是空的。
 *
 * 只有 null / undefined / 空串 / 空数组（或元素全为空）算空。**数字 0 也算「已有成本」**：
 * 她可能就是特意填了 0（赠品、样品），代码不许替她改成别的数。
 */
const isBlankCost = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0 || value.every((item) => isBlankCost(item));
  if (typeof value === 'object') {
    const inner = value.text ?? value.value;
    // 认不出来的对象一律当成「已有成本」：读不懂就不要覆盖，比乱改安全。
    return inner === undefined ? false : isBlankCost(inner);
  }
  return false;
};

/**
 * 把已有成本抽成一个数字，用来和识别到的价格比「是不是同一个值」。
 * 读不懂（文本、空）就返回 null —— 调用方据此走「不覆盖 + warn」。
 */
const costValueOf = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = costValueOf(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (value && typeof value === 'object') return costValueOf(value.text ?? value.value ?? null);
  return parseUnitCost(value);
};

/**
 * 从识别到的到货明细里按「货号」汇总可信单价。
 *
 * 同一货号在单据上通常占一行、价格只有一个；如果同一个货号读出了**多个不同价格**
 * （明显是 OCR 抖动或看错了列），整个货号都不写，只记一条 warn 让人去核对——
 * 按产品负责人的原话，宁可少写也不能写错。
 *
 * @param {Array<{item_no?: string, unit_cost?: unknown}>} rows
 * @returns {Map<string, {item_no: string, cost: number|null, conflict: boolean, prices: number[]}>}
 */
const buildArrivalCostPlan = (rows) => {
  const plan = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const itemNo = String(row?.item_no ?? row?.itemNo ?? '').trim();
    if (!itemNo) continue;
    const cost = parseUnitCost(row?.unit_cost ?? row?.unitCost ?? row?.price);
    if (cost === null) continue;
    const entry = plan.get(itemNo) || { item_no: itemNo, cost: null, conflict: false, prices: [] };
    if (!entry.prices.includes(cost)) entry.prices.push(cost);
    plan.set(itemNo, entry);
  }
  for (const entry of plan.values()) {
    // 同一货号多行价格不一致 → 不写（conflict 由调用方记 warn）。
    entry.conflict = entry.prices.length > 1;
    entry.cost = entry.conflict ? null : entry.prices[0];
  }
  return plan;
};

module.exports = {
  parseUnitCost,
  isBlankCost,
  costValueOf,
  buildArrivalCostPlan,
};
