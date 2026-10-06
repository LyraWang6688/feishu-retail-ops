// 「确认状态（旧）」→ 四个新状态字段的**一次性回填口径**（纯配置 + 纯函数，零依赖）。
//
// 为什么单独一层：
//   · 回填是**一次性**的事，口径必须与她当面定的那几句话逐字对应；
//   · 把它做成**纯函数**，就能在单测里穷举"哪条会改、改成什么"，
//     而不是把判断埋在一个只能对着真表跑的脚本里；
//   · 脚本（scripts/backfill-sales-status.mjs）只负责 IO，不负责口径。
//
// 业务负责人 2026-10-06 逐字定的映射（**只回填「确认状态」「资金状态」两列**）：
//   · 已入账   → 资金状态 = 已写入
//   · 入账失败 → 资金状态 = 写入失败
//   · 入账中   → 资金状态 = 未写入（**为什么不是留空见下面**）
//   · 待确认   → 确认状态 = 未确认（资金状态留空）
//   · 已取消   → 确认状态 = 已取消
//   · 待修改   → 确认状态 = 待修改
//
// ⚠️ 「销售状态」「库存状态」**不回填**：它们没有直接来源
//    （销售状态的家是销售明细、库存状态的家是库存流水），另行处理。
//
// ⚠️ 「入账中」为什么写「未写入」而不是留空：
//    留空会让读那一侧（新字段优先、空则退回旧字段）退回「确认状态（旧）」——
//    结果**看起来一样**（闸门都关着），但表里那一列会一直空着，
//    她按新字段筛"这单到哪一步了"时看不到任何东西。写「未写入」= 诚实地说
//    "钱还没写进去"，且与值域（未写入/已写入/写入失败）逐字对得上。
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('./salesStatusDimensions');

// 旧值（「确认状态（旧）」里的选项）→ 新字段的目标值。
// ⚠️ 键是**归一化后**的旧值（去空白、去内部空格），见 normalizeLegacy。
const SALES_STATUS_BACKFILL_MAP = Object.freeze({
  已入账: Object.freeze({ funds: WRITE.funds.done }),
  入账失败: Object.freeze({ funds: WRITE.funds.failed }),
  入账中: Object.freeze({ funds: WRITE.funds.none }),
  待确认: Object.freeze({ userAction: WRITE.userAction.pending }),
  已取消: Object.freeze({ userAction: WRITE.userAction.cancelled }),
  待修改: Object.freeze({ userAction: WRITE.userAction.toModify }),
});

const normalizeLegacy = (value) => String(value ?? '').trim().replace(/\s+/g, '');

// 回填能动的语义键（白名单：写错键名当场报错，不会写到别处）。
const BACKFILL_KEYS = Object.freeze(['userAction', 'funds']);

/**
 * 一条记录的**回填计划**（纯函数，不碰网络）。
 *
 * @param {object} input
 * @param {string} input.legacyConfirm 「确认状态（旧）」的当前值
 * @param {string} [input.userAction] 新「确认状态」的当前值
 * @param {string} [input.funds]      新「资金状态」的当前值
 * @returns {{action: string, patch: object, target?: object}}
 *   action:
 *     · `write`              要写（patch 里是要写的列；**只写空列，不覆盖已有值**）
 *     · `already_up_to_date` 老值有映射，但新列已经是目标值 → 不用改
 *     · `skip_has_value`     老值有映射，但目标新列**已有别的值** → 不动（交给人看）
 *     · `skip_unmapped`      老值不在映射表里（含她将来新增的选项）→ 不动
 *     · `skip_empty_legacy`  老值是空的 → 不动
 */
const planSalesStatusBackfill = ({ legacyConfirm = '', userAction = '', funds = '' } = {}) => {
  const normalized = normalizeLegacy(legacyConfirm);
  if (!normalized) return { action: 'skip_empty_legacy', patch: {} };
  const target = SALES_STATUS_BACKFILL_MAP[normalized];
  if (!target) return { action: 'skip_unmapped', patch: {} };

  const current = { userAction: String(userAction ?? '').trim(), funds: String(funds ?? '').trim() };
  const patch = {};
  const blocked = [];
  for (const key of BACKFILL_KEYS) {
    const wanted = target[key];
    if (!wanted || current[key] === wanted) continue;
    // 🔴 **只填空列**：新列已经有值就绝不覆盖 —— 回填脚本没有资格推翻
    //    销售链路/售后链路刚写进去的事实（那会让"回填"变成"改账"）。
    if (current[key]) { blocked.push(key); continue; }
    patch[key] = wanted;
  }
  if (Object.keys(patch).length) return { action: 'write', patch, target };
  if (blocked.length) return { action: 'skip_has_value', patch: {}, target, blocked };
  return { action: 'already_up_to_date', patch: {}, target };
};

module.exports = {
  SALES_STATUS_BACKFILL_MAP,
  BACKFILL_KEYS,
  normalizeLegacy,
  planSalesStatusBackfill,
};
