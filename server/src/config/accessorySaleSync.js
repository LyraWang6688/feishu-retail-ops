'use strict';

/**
 * 「配品销售 → S交易明细」同步（2026-11-17，业务负责人把飞书工作流搬进代码）。
 *
 * 原工作流：配品销售新增记录 → 在 S交易明细新增一条
 *   · 支付方式 ← 配品销售.收款方式
 *   · 收支方向 = 收入
 *   · 交易金额 ← 配品销售.金额
 *   · 钱款状态 = 已收款
 *   · 收付日 ← 触发记录的创建时间
 *
 * 代码版在原工作流上补了两件**防错账**的事：
 *   ① 幂等：交易明细ID = PX-<配品销售 record_id>；写入前按它回查，已有就跳过
 *      （工作流没有这一列，重复触发/重投会重复记账）；
 *   ② 金额必须 > 0（工作流只要求名称/数量非空，空金额也会记一笔 0 元）。
 *
 * 🔴 上线顺序：**先停飞书工作流，再开 ACCESSORY_SALE_SYNC_ENABLED=true**；
 *    两者同时开会给同一条配品销售写两条 S交易明细。
 */
const { readString } = require('./envValue');

const ACCESSORY_SALE_SYNC = Object.freeze({
  // 不设开关：只要配了源表 ID，代码就一直同步（业务负责人 2026-11-17：「不需要配置这个开关，就一直是开着的」）。
  // 上线前先停飞书工作流，避免双写。
  // 飞书「配品销售」表 ID（不在 v1 schema 的业务表里，用独立 env；空 ⇒ 不处理）。
  sourceTableId: readString(process.env, 'FEISHU_V1_ACCESSORY_SALE_TABLE_ID', '') || '',
  sourceFields: Object.freeze({
    name: '名称',
    quantity: '数量',
    amount: '金额',
    method: '收款方式',
    // 收付日优先取它（业务负责人 2026-11-17：源表销售日比处理时刻准确）。
    saleDate: '销售日',
  }),
  targetTableKey: 'paymentRecord',
  // S交易明细的固定值 / ID 规则
  direction: '收入',
  status: '已收款',
  receiptPrefix: 'PX',
  // 只认新增（与飞书工作流一致；编辑/删除不补记）。
  triggerActions: Object.freeze(['record_added']),
  // 财务记录不写 0 元：金额缺失/<=0 跳过并告警。
  requirePositiveAmount: true,
  minQuantity: 1,
});

module.exports = { ACCESSORY_SALE_SYNC };
