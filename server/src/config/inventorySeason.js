'use strict';

/**
 * 入库继承「当季」（2026-11-27 业务负责人定稿）。
 *
 * 口径：
 *   · 货品信息「当季」= 是 ⇒ 新行 当季 = true；
 *   · = 否 且该货品还有实时库存 ⇒ **不写**（保持空 = 非当季）；
 *   · = 否 且该货品实时库存 0 行（首次入库 / 售罄回补）⇒ 当季 = true；
 *   · 出库（删行）与状态类（不影响方向）一个字都不碰。
 *
 * 读货品复用 `CRITICAL_READ_RETRY`（库存关键读同一份节奏）；重试耗尽 ⇒ 不写 + warn，
 * 不阻塞入库。全部取值可配，逻辑里不写死字段名 / 字面值。
 */
const { CRITICAL_READ_RETRY } = require('./gatewayReadRetry');

const INVENTORY_SEASON = Object.freeze({
  // schema 里「货品信息」的只读字段键（见 v1BitableSchema.tables.product.readOnlyFields）
  productFieldKey: 'season',
  // 公式列取什么值算「当季」
  currentLabel: '是',
  // 库存 0 行时入库 ⇒ 当季（首次入库 / 售罄回补）
  firstIntakeWhenNoLiveRows: true,
  // 货品读的重试：复用库存关键读那一份
  readRetry: CRITICAL_READ_RETRY,
});

module.exports = { INVENTORY_SEASON };
