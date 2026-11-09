'use strict';

/**
 * 抖音团购券 · **券目录只读同步**的配置。
 *
 * 业务负责人 2026-11-09：按「团购券管理」实际字段逐个对齐接口后，「就按这个吧」。
 *
 * 本文件只做「配置先行」那一层：账号、文案、字段映射。
 * 🔴 **只读**：把抖音商品接口拉到的目录字段与飞书表逐行比对、返回差异，
 *    **不写飞书**（写回留到业务负责人点头后的下一步）。
 */

const { readString } = require('./envValue');

const TEXTS = Object.freeze({
  accountMissing: '券目录同步未执行：没配置 DOUYIN_LAIKE_ACCOUNT_ID',
  notConfigured: '抖音来客应用未配置：需要 DOUYIN_LAIKE_CLIENT_KEY / DOUYIN_LAIKE_CLIENT_SECRET',
});

// 抖音商品 `online_status` → 飞书「销售状态」选项。
// 业务负责人 2026-11-10 确认：**1 = 在售、2 = 下架**（选项真值见生产表：在售 / 下架）。
const ONLINE_STATUS_TO_SALES_STATUS = Object.freeze({ 1: '在售', 2: '下架' });

const createVoucherCatalogSyncConfig = (env = process.env) => ({
  accountId: readString(env, 'DOUYIN_LAIKE_ACCOUNT_ID', '').trim(),
  statusMap: ONLINE_STATUS_TO_SALES_STATUS,
  texts: TEXTS,
});

module.exports = { createVoucherCatalogSyncConfig, ONLINE_STATUS_TO_SALES_STATUS, TEXTS };
