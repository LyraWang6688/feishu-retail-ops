// 「报货批次」表上的**确认状态**取值配置（业务负责人 2026-10-07 拍板）。
//
// 她的口径（逐字）：
//   「**1. 验收原话：改写到报货批次  2. 验收人：改写到报货批次  3. 确认状态：改到报货批次**」
//   ⇒ 到货核对的落点从已被删除的「到货验收」表搬到**「报货批次」那一行**。
//
// 这一列在真表上是**文本**（不是单选），所以往它写一个"新取值"不会被飞书自动建选项、
// 也就不会污染表 —— 但**取值仍然属于业务口径**（她哪天想改成「已验收」就改这里/环境变量），
// 所以照「配置先行」放在配置文件里，不在 service 里写中文字面量。
//
// ⚠️ 与 `config/purchaseArrivalStatus.js`（**到货状态**：未到货 / 已到货，**单选**）
//    是**两列两件事**：那一列的取值要对着真表 `property.options` 做闸门校验，这一列不需要。
// ⚠️ 与它同样**不是**「具体信息」上那一列（那一列已被她删除，代码里已无映射）。

const { readString } = require('./envValue');

const PURCHASE_ACCEPTANCE_CONFIRMED_ENV_KEY = 'PURCHASE_ACCEPTANCE_CONFIRMED_STATUS';

// 到货核对**入库成功之后**写进「报货批次.确认状态」的那个取值。
// 改动前它写的是「到货验收」那一段自己的「确认状态」，值就是这个字面量（原样搬过来）。
const DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED = '已确认';

// schema 里的**语义键**（`V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.confirmStatus`）。
// 「验收原话」的语义键同族：`acceptanceText`。
const PURCHASE_ACCEPTANCE_STATUS_FIELD_KEY = 'confirmStatus';
const PURCHASE_ACCEPTANCE_TEXT_FIELD_KEY = 'acceptanceText';

/**
 * @returns {{confirmed: string}} 冻结的配置对象。
 * 取值**不能是空串**：空串写进「确认状态」等于"什么都没写"，而她要看的就是
 * "这一批已经核对确认过了"这个事实（与到货状态同理，见 purchaseArrivalStatus.js）。
 */
const resolvePurchaseAcceptanceConfig = (env = process.env) => {
  const confirmed = readString(
    env, PURCHASE_ACCEPTANCE_CONFIRMED_ENV_KEY, DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED,
  );
  if (!String(confirmed || '').trim()) {
    throw new Error(`${PURCHASE_ACCEPTANCE_CONFIRMED_ENV_KEY} 不能是空串（到货核对确认成功后要显式写它）`);
  }
  return Object.freeze({ confirmed: String(confirmed) });
};

module.exports = {
  PURCHASE_ACCEPTANCE_CONFIRMED_ENV_KEY,
  DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED,
  PURCHASE_ACCEPTANCE_STATUS_FIELD_KEY,
  PURCHASE_ACCEPTANCE_TEXT_FIELD_KEY,
  resolvePurchaseAcceptanceConfig,
};
