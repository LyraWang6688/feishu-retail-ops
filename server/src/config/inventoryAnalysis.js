'use strict';

/**
 * 库存总览（只读）口径配置（2026-11-25 业务负责人确认）。
 *
 * 页面分两段：
 *   · B 段「库存变动」：按「库存流水.创建时间」的日期区间聚合（默认今天）；
 *   · A 段「库存现状」：实时库存当前快照，不受日期影响。
 *
 * 口径（她 2026-11-25 的原话）：
 *   「增加就相当于入库，减少就相当于出库」；
 *   库存方向 = 不影响 的是状态调整（变动数量恒 0），不计入进出，只记笔数。
 *
 * ⚠️ 分类一律按「行为管理.库存方向」判断，不按行为名称/编码写死：
 *   行为表新增一条库存行为，这里不用改代码。
 * ⚠️ 只有「库存流水」里的行参与 B 段；行为管理里采购/销售/资金环节的行为
 *   虽然也填了库存方向，但不写库存流水，不会出现在这里。
 */
const INVENTORY_ANALYSIS = Object.freeze({
  directions: Object.freeze({
    increase: '增加',
    decrease: '减少',
    none: '不影响',
  }),
  // 分组顺序 = 页面展示顺序；区间内没有记录的分组前端不显示（未分类 0 笔也不显示）。
  groups: Object.freeze([
    Object.freeze({ key: 'inbound', direction: '增加', label: '入库' }),
    Object.freeze({ key: 'outbound', direction: '减少', label: '出库' }),
    Object.freeze({ key: 'state', direction: '不影响', label: '状态调整' }),
    Object.freeze({ key: 'unknown', direction: '', label: '未分类' }),
  ]),
  // 实时库存「所属状态」分桶。空状态按门盒算（与 config/inventoryStatePolicy 的
  // 「空状态按门盒算」同一口径，业务负责人 2026-11-12 定过）。
  stateBuckets: Object.freeze([
    Object.freeze({ key: 'doorbox', label: '门盒', values: Object.freeze(['门盒', '']) }),
    Object.freeze({ key: 'sample', label: '样品', values: Object.freeze(['样品']) }),
  ]),
  // 出现配置外的状态（例：仓库）时单独一桶，绝不悄悄并进「门盒」。
  otherStateLabel: '其他状态',
  unknownLabel: '未分类',
  seasonLabels: Object.freeze({ current: '当季', off: '非当季' }),
  invalidRangeMessage: '日期范围不合法',
  // 防御：区间太大/流水太多时直接拒绝或截断，不把页面拖死。
  maxRangeDays: 366,
  maxLedgerRecords: 20000,
});

module.exports = { INVENTORY_ANALYSIS };
