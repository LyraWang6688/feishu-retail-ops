'use strict';

/**
 * 「销售 · 确认单」配置（2026-11-28 业务负责人定稿）。
 *
 * 只服务**事后更正**：最近 5 天、写入成功、没有售后的销售单，
 * 允许原地修改尺码 / 实收金额 / 支付方式 / 收款金额 / 赠品 / 配品。
 *
 * ⚠️ 这里只放窗口、可改字段、权限键与用户可见文案；
 *    怎么改库、库存四象限怎么走，全部在 services/salesCorrectionService.js
 *    与 InventoryService.correctSaleDetailSize 里（配置不写业务分支）。
 */
const { readInt } = require('./envValue');

const SALES_CORRECTION = Object.freeze({
  // 今天 + 前 4 个自然日（上海时区）。
  windowDays: readInt(process.env, 'SALES_CORRECTION_WINDOW_DAYS', 5, { min: 1, max: 31 }),
  timeZone: 'Asia/Shanghai',
  // listOrders 已经只返回已入账单；这里再钉一次业务口径。
  allowedWriteStatuses: Object.freeze(['成功']),
  // 有售后次数 / 售后类型的单只读。
  blockedAfterSalesTypes: Object.freeze(['退货', '换货', '赔货']),
  editable: Object.freeze({
    size: true,
    detailAmount: true,
    paymentMethod: true,
    paymentAmount: true,
    gift: true,
    accessory: true,
  }),
  permissions: Object.freeze({
    self: 'sales.correction.self',
    any: 'sales.correction.any',
  }),
  roles: Object.freeze({ admin: '管理员' }),
  labels: Object.freeze({ detailAmount: '实收金额', paymentAmount: '收款金额', accessoryAmount: '配品总额' }),
  paymentStatus: Object.freeze({ unpaid: '未收款', refunded: '已退款', retained: '已留存' }),
  tradeDirection: Object.freeze({ income: '收入' }),
  texts: Object.freeze({
    cardLabel: '确认单',
    pageTitle: '确认单 · 最近 5 天',
    pageEmpty: '最近 5 天没有可确认的销售单',
    readFailed: '确认单读取失败，请稍后刷新',
    notEditable: '这张单不能修改',
    outsideWindow: '已经超过 5 天，不能修改',
    afterSalesBlocked: '这张单已经发生过售后，不能修改',
    statusBlocked: '这张单还没有写入成功，不能修改',
    forbidden: '只能修改自己录的单，或联系管理员',
    sizeLabel: '尺码',
    detailAmountLabel: '实收金额',
    paymentMethodLabel: '支付方式',
    paymentAmountLabel: '收款金额',
    giftLabel: '赠品',
    accessoryLabel: '配品',
    accessoryAmountLabel: '配品总额',
    totalLabel: '合计',
    paidLabel: '已收',
    pendingLabel: '未收',
    save: '确认修改',
    cancel: '取消',
    saving: '正在保存…',
    saved: '修改已保存',
    failed: '修改没有保存，请核对后重试',
    sizeRequired: '请选择尺码',
    sizeMissing: '新尺码没有可扣库存，请先核对库存',
    amountInvalid: '金额要填 0 或正数（最多两位小数）',
    paymentInvalid: '收款金额要填数字',
    overpaid: '改完实收合计比已经收到的钱还少，请先核对收款',
    duplicate: '这次修改已经提交过，不会重复修改',
    submitKeyMissing: '这次修改缺少提交键，请刷新页面后重试',
    detailNotFound: '要修改的销售明细不属于这张单',
    paymentNotFound: '要修改的收款记录不属于这张单',
    noChanges: '没有需要修改的内容',
  }),
});

module.exports = { SALES_CORRECTION };
