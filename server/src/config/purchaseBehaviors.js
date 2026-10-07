/**
 * 「行为管理」表里【采购环节】的行为编码（单一来源）。
 *
 * 为什么单独一个配置模块（而不是把字面量撒在 service 里）：
 *   AGENTS.md《底层工程原则》要求「行为编码一律可配」，改一个编码不该去 service 里翻字符串；
 *   更要紧的是**只留一处字面量**——她 2026-10-07 改的是中文名，编码不动，
 *   查找一律按编码，中文名改了代码不受影响。
 *
 * ⚠️ 与【库存环节】的编码是**两套**，别混（AGENTS.md / docs/todo-behavior-lexicon-sale-cash.md 第 1 节，
 *    2026-10-07 实读生产「行为管理」表 20 条）：
 *
 *   | 所属环节 | 编码                        | 用在哪 |
 *   | 采购     | `PURCHASE_ORDER` 报货       | 「供应商对接」的「采购行为」 |
 *   | 采购     | **`PURCHASE_IN` 入库**      | **「采购入库」的「采购行为」← 本文件负责这一个** |
 *   | 采购     | `PURCHASE_RETURN` 退货      | 「供应商对接」的「采购行为」 |
 *   | 库存     | `STOCK_PURCHASE_INCREASE` 采购增加 | 「库存流水」的「库存行为」（`inventoryService.STOCK_MOVEMENTS`） |
 *   | …        | 其余库存 / 销售 / 资金编码   | 各自的链路 |
 *
 *   ⇒ 「采购入库」行的「采购行为」挂的是**采购环节**的 `PURCHASE_IN`；
 *     库存流水那一条由 `InventoryService.applyPurchase` 按
 *     `MOVEMENT_PURCHASE_INCREASE`（= `STOCK_PURCHASE_INCREASE`）自己解析。
 *     **两者都表达"增加"，但不是同一条行为记录，不能互相替代。**
 *     ⚠️ 这是 2026-10-07 修 bug 时核清的一处口径：任务书里曾说「注册表里 采购入库 对应的编码是
 *        `PURCHASE_IN`」，实际注册表里没有 `PURCHASE_IN`（只有 `STOCK_PURCHASE_INCREASE`，
 *        它是库存环节的另一条记录）—— 所以这里**不能**复用 `STOCK_MOVEMENTS`，
 *        否则等于把入库行挂到另一条行为上（行为变化，不是"换个查找方式"）。
 */
const PURCHASE_BEHAVIORS = Object.freeze({
  // 「采购入库」表「采购行为」字段要挂的那条 —— 采购环节的「入库」。
  INBOUND: 'PURCHASE_IN',
});

module.exports = { PURCHASE_BEHAVIORS };
