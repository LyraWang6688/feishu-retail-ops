/**
 * 供应商报货「到齐」判据（纯函数）。
 *
 * 产品负责人拍板的判据：
 *
 *   到齐 = Σ(每条明细解析出的「双数」) >= 「合计数量」
 *
 * 「合计数量」是她在报货表单里自己填的一批总双数（number 字段）。
 * 注意判据用的是**双数之和**，不是明细条数：一条明细可能是 3 双，
 * 所以「3 双 + 2 双 = 5 双」在只有 2 条明细时也算到齐。
 *
 * 为什么用 `>=` 而不是 `==`：多报（收到的比申报的多）不该把批次卡死，
 * 到齐就该继续走；只有少报才算「还没到齐」。
 *
 * 调用方是 `PurchaseWebhookService.handleReportBatch`：到齐才写采购申请、才出图，
 * 未到齐什么都不做（只挂一条 5 分钟告警）。原来那个 30 秒合并窗口已经整体删除——
 * 判据本身就能**确定**这一批齐没齐，不需要再靠时间猜。
 *
 * 设计约束：纯函数、无副作用、不抛异常（输入再脏也只返回 complete:false + reason）。
 */

// 「合计数量」是 number 字段，但取回来可能是 null / 空串 / 字符串数字，
// 也可能是 0、负数（她没填或填错）。这些都算「没有可用的合计数量」，
// 返回 reason 让调用方自己决定，而不是抛异常把报货链路带崩。
const normalizeDeclaredTotal = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
};

// declaredTotal 允许传「这一批多条记录的合计数量」数组（用来发现同批不一致），
// 也允许直接传一个已选好的数字。
const collectDeclaredTotals = (input) => {
  const raw = Array.isArray(input) ? input : [input];
  const values = [];
  for (const entry of raw) {
    const value = normalizeDeclaredTotal(entry);
    if (value !== null) values.push(value);
  }
  return values;
};

// details 里每条代表「一条明细解析出的双数」：既接受 { quantity } 对象，也接受裸数字。
// 非法/缺失数量按 0 计，宁可少算也不用异常打断观察。
const quantityOf = (detail) => {
  if (detail === null || detail === undefined) return 0;
  const raw = typeof detail === 'object' ? detail.quantity : detail;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num;
};

/**
 * @param {object} input
 * @param {number|number[]|null} [input.declaredTotal]
 *   「合计数量」。传数组时按记录顺序取**第一个有合法值**的作为本批声明值；
 *   同时比对不同合法值来标记 inconsistent。
 * @param {Array<{quantity?: number}|number>} [input.details]
 *   这一批每条明细解析出的双数。
 * @returns {{
 *   declaredTotal: number|null,
 *   receivedQuantity: number,
 *   complete: boolean,
 *   missingQuantity: number,
 *   recordCount: number,
 *   inconsistent: boolean,
 *   declaredTotals: number[],
 *   reason: string|null,
 * }}
 */
const evaluateReportCompleteness = ({ declaredTotal, details } = {}) => {
  const list = Array.isArray(details) ? details : [];
  const recordCount = list.length;
  const receivedQuantity = list.reduce((sum, detail) => sum + quantityOf(detail), 0);

  const declaredValues = collectDeclaredTotals(declaredTotal);
  const distinctDeclared = [...new Set(declaredValues)];
  // 同一批的「合计数量」正常应该每条都一样；不一样要能报出来，
  // 但也只标记——本判据仍按取值继续算，绝不因此抛错。
  const inconsistent = distinctDeclared.length > 1;
  const declared = declaredValues.length > 0 ? declaredValues[0] : null;

  if (declared === null) {
    return {
      declaredTotal: null,
      receivedQuantity,
      // 没有可用的「合计数量」就谈不上到齐：保持 false，让调用方（第 3 步的窗口替代逻辑）
      // 不会误判成「已到齐」而在数据缺失时提前处理。
      complete: false,
      missingQuantity: 0,
      recordCount,
      inconsistent,
      declaredTotals: distinctDeclared,
      reason: 'no_declared_total',
    };
  }

  const complete = receivedQuantity >= declared;
  return {
    declaredTotal: declared,
    receivedQuantity,
    complete,
    // 到齐时没有缺口；没到齐才是还差多少。
    missingQuantity: complete ? 0 : declared - receivedQuantity,
    recordCount,
    inconsistent,
    declaredTotals: distinctDeclared,
    // reason 只表达「为什么算不出来」，不表达「为什么没到齐」——后者看 complete 即可。
    reason: null,
  };
};

module.exports = {
  evaluateReportCompleteness,
};
