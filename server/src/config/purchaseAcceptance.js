// 「报货批次」表上的**确认状态**取值配置（业务负责人 2026-10-07 拍板）。
//
// 她的口径（逐字）：
//   「**1. 验收原话：改写到报货批次  2. 验收人：改写到报货批次  3. 确认状态：改到报货批次**」
//   ⇒ 到货核对的落点从已被删除的「到货验收」表搬到**「报货批次」那一行**。
//
// ⚠️ **2026-10-07 深夜更新：这一列在真表上已经从【文本】改成【单选】**（她在生产表里改的）。
//    ⇒ 与「到货状态」同一条风险：往单选里写一个**不存在的取值**，飞书不会报错，而是
//    **自动新建一个选项** —— 表被悄悄污染（AGENTS.md 第 11 条① 的事故形态）。
//    ⇒ 取值因此**不能只放在配置里**：必须对着真表 `property.options` 做**部署闸门**校验
//      （`purchaseAcceptanceOptionContract`，由 `v1:schema-check:*` 调用，**只读**）。
//    ⚠️ 校验失败 = 真表里没有这个选项名 ⇒ **闸门判红、停下报告**；
//      **绝不**由代码去改选项名，更不硬写进去让飞书替我们建一个新选项。
//
// ⚠️ 与 `config/purchaseArrivalStatus.js`（**到货状态**：未到货 / 已到货，**单选**）
//    是**两列两件事**：两列各有自己的取值契约，都在闸门里。
// ⚠️ 与它同样**不是**「报货信息」（原「具体信息」）上那一列（那一列已被她删除，代码里已无映射）。

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

/**
 * 部署闸门用的「单选取值契约」：`[{ tableKey, fieldKey, requiredOptions }]`。
 * 只回答「真表这一列是单选、且含这个取值」——**只读**，不写任何东西。
 *
 * ⭐ 她 2026-10-07 深夜把这一列从文本改成单选之后，这条契约就是**唯一的守门人**：
 *    服务器上跑 `pnpm run v1:schema-check:purchase` 会在部署前对着**生产真表**核对选项名
 *    （本机的测试 Base 落后于生产，在本机跑红了是**预期**的，别据此改代码或改选项名）。
 */
const purchaseAcceptanceOptionContract = (env = process.env) => {
  const { confirmed } = resolvePurchaseAcceptanceConfig(env);
  return [{
    tableKey: 'purchaseOrderBatch',
    fieldKey: PURCHASE_ACCEPTANCE_STATUS_FIELD_KEY,
    requiredOptions: [confirmed],
  }];
};

module.exports = {
  PURCHASE_ACCEPTANCE_CONFIRMED_ENV_KEY,
  DEFAULT_PURCHASE_ACCEPTANCE_CONFIRMED,
  PURCHASE_ACCEPTANCE_STATUS_FIELD_KEY,
  PURCHASE_ACCEPTANCE_TEXT_FIELD_KEY,
  resolvePurchaseAcceptanceConfig,
  purchaseAcceptanceOptionContract,
};
