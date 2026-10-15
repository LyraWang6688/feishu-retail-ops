/**
 * 「报货批次.录入数量」的写入口径（业务负责人 **2026-10-12** 测出来的缺口）。
 *
 * 她的原话（逐字）：
 *   「这**录入数量**里面应该是 5 啊，但是对于我们的这个数据表里面，它是记录为空呀」
 *   「**录入数量**：我们报单时候的数量；**实际数量**：我们到货的数量；
 *     **发生金额**：这一次供应商的金额」（2026-10-08 的口径）
 *
 * ⇒ 所以这一列**应该由报货自动填**（= 这一批的录入数量合计），不是"她在表上维护的"。
 *   两条报货入口（供应商报单 webhook / 扫码页补货）**都走同一个建行点**
 *   （`PurchaseWebhookService.confirmPurchaseRequest`），所以写入点只有一处。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ **真表列类型本机无法核实**（本机没有生产凭证、也没有 `.env` —— AGENTS 第 8 条：
 *   本机只放测试侧的东西）。按仓库既有先例（`v1BitableSchema.js` 里「报货批次」那一段的
 *   注释也是这么记的：*按仓库既有金额列的先例写 **Number***）⇒ **默认写数字**。
 *
 * 🔴 若真机实测出现 `*ConvFail`（或那一列写进去是空的）⇒ **停下来报告**，
 *   **不要**自己改成"写字符串"了事 —— 那会与数字列冲突（`v1BitableSchema` 的注释原话）。
 *   `PURCHASE_BATCH_QUANTITY_TYPE=text` 这个开关只在**确认过真表是文本列**之后才用。
 */
const { readString } = require('./envValue');

/** 缺省值类型（没核实真表之前，按仓库先例：数字）。 */
const DEFAULT_QUANTITY_VALUE_TYPE = 'number';

/**
 * 取值（可注入 `env`，用例不必碰 `process.env`）。
 * @returns {{ valueType: 'number'|'text', typeVerified: boolean }}
 */
const resolvePurchaseBatchQuantityConfig = (env = process.env) => {
  const raw = readString(env, 'PURCHASE_BATCH_QUANTITY_TYPE', DEFAULT_QUANTITY_VALUE_TYPE)
    .trim().toLowerCase();
  return {
    valueType: raw === 'text' ? 'text' : DEFAULT_QUANTITY_VALUE_TYPE,
    // ⭐ 一直为 `false`：这一列的类型**还没在真表上核过**（本机够不着生产表）。
    //    配上一条日志，部署后一眼能看出"这一列是按未核实的假设写的"。
    typeVerified: false,
  };
};

/**
 * 这一批要写进「录入数量」的值。
 *
 * 口径：
 *   · **值 = 这一批的录入数量合计**（报货 = 明细数量求和；退货 = 这一批退货数量求和）；
 *   · **拿不到 / 0 / 负数 ⇒ 返回 `undefined`**（网关会跳过该字段 ⇒ **不写空、也不写 0** ✗）；
 *   · `valueType === 'text'` ⇒ 写字符串（**只有确认真表是文本列时才用**）。
 */
const toBatchQuantityValue = (total, { valueType = DEFAULT_QUANTITY_VALUE_TYPE } = {}) => {
  const number = Number(total);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return valueType === 'text' ? String(number) : number;
};

/** 明细行的数量合计（`quantity` 认数字与数字串；认不出的行按 0 计，不猜）。 */
const totalQuantityOf = (items = []) => (Array.isArray(items) ? items : [])
  .reduce((sum, item) => {
    const number = Number(item?.quantity);
    return sum + (Number.isFinite(number) && number > 0 ? number : 0);
  }, 0);

/**
 * 建行时直接展开进 `values` 的字段（**空对象 = 不写这一列**）：
 *   `values: { batchNo, ...batchQuantityFields(plan.items) }`
 */
const batchQuantityFields = (items, config = resolvePurchaseBatchQuantityConfig()) => {
  const value = toBatchQuantityValue(totalQuantityOf(items), config);
  return value === undefined ? {} : { quantity: value };
};

module.exports = {
  DEFAULT_QUANTITY_VALUE_TYPE,
  batchQuantityFields,
  resolvePurchaseBatchQuantityConfig,
  toBatchQuantityValue,
  totalQuantityOf,
};
