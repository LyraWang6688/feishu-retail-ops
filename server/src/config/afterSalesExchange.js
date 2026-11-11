'use strict';

/**
 * 售后（衍生单）· **换货** 写入配置（2026-10-29 定稿 + 2026-11-11 业务负责人补充）。
 *
 * 换货 = 一次退货（货流）+ 一次新的购买（货流）+（换款式时）差价（钱）。
 *   · 原销售明细 → 已退货；
 *   · **新增一条销售明细**（履约为已交付、交易类型=换货、销售日=点击当天、金额=她填的实收金额）；
 *   · 库存两条：旧鞋回门盒（销售增加）、新鞋出门盒（现货销售减少）；
 *   · 差价：新明细金额 − 原明细金额；
 *       补差价 ⇒ 新建 `{单号}-收款-NN`（收入/已收款）；
 *       退差价 ⇒ 新建 `{单号}-退款-NN`（退回/已退款）；
 *       差价 0 ⇒ 不建交易明细；
 *   · 原销售主表：售后类型累加「换货」+ 售后次数 +1 + **总金额按差价回填**；
 *   · 主表三块关联（销售明细 / 库存流水 / 收款明细）靠子记录写回原主表自动回显。
 *
 * 人话 / 编码全部在本文件（逻辑里不写中文、不写业务字面量）。
 */

const AFTER_SALES_EXCHANGE = Object.freeze({
  action: 'exchange',
  scenarios: Object.freeze({ SAME_ITEM: 'same', NEW_ITEM: 'new' }),

  // 原明细：只有「已交付」能换；换完写「已退货」（2026-10-29 定稿）。
  original: Object.freeze({
    returnableStatuses: Object.freeze(['已交付']),
    fulfillmentStatus: '已退货',
  }),

  // 新明细（新换出去的那双）。
  newLine: Object.freeze({
    fulfillmentStatus: '已交付',
    // 交易类型（关联「行为管理」的 SALE_EXCHANGE）。
    tradeTypeCode: 'SALE_EXCHANGE',
    // 销售日 = 后台执行当天（= 她点击当天；重试不会改成重试日）。
    salesDate: 'now',
  }),

  // 库存两条腿：旧鞋回库（增加，状态由内核按编号库存自动判定）/ 新鞋出库（减少，按门盒→样品优先级选行）。
  stock: Object.freeze({
    restockState: '门盒',
    returnedBehaviorCode: 'STOCK_SALE_INCREASE', // 销售增加（旧鞋回库）
    newBehaviorCode: 'SALE_CASH', // 现货销售（新鞋出库，方向=减少）
    quantity: 1,
  }),

  // 钱：只看差价；补=收款，退=退款。
  money: Object.freeze({
    collect: 'collect',
    refund: 'refund',
    // 收支方向（生产「S交易明细」选项：收入 / 退回）
    directionByMode: Object.freeze({ collect: '收入', refund: '退回' }),
    // 钱款状态（生产选项）
    statusByMode: Object.freeze({ collect: '已收款', refund: '已退款' }),
    // 交易明细 ID 中缀（`salesRecordIds` 的 kind）
    kindByMode: Object.freeze({ collect: 'receipt', refund: 'refund' }),
  }),

  // 原销售主表字段落点。
  master: Object.freeze({
    typeField: 'afterSalesType',
    typeValue: '换货',
    countField: 'afterSalesCount',
    countDelta: 1,
    totalField: 'totalAmount',
  }),

  // 异步任务存储目录（与退货分开，排查一眼能看出是哪条链路）。
  jobsDir: process.env.AFTER_SALES_EXCHANGE_JOBS_DIR || '',

  texts: Object.freeze({
    needRequestId: '缺少请求标识（request_id）',
    needEntry: '缺少销售单记录',
    needDetail: '请选择要换的那一条销售明细',
    needScenario: '请选择换尺码还是换款式',
    invalidScenario: '换货方式只能是 same（换尺码）或 new（换款式）',
    needNewProduct: '换款式要先扫新鞋的货品码',
    needNewSize: '请选择新鞋的尺码',
    needNewAmount: '请填写这一双的实收金额',
    amountInvalid: '实收金额无效（要大于 0）',
    needDiffMethod: '有差价时要选差价方式',
    diffMethodNotAllowed: '这个支付方式不能用于退款（「支付方式管理」里没勾「可用于退款」）',
    unknownPaymentMethod: '支付方式管理里找不到这个方式',
    entryNotFound: '找不到这张销售单',
    detailNotFound: '找不到这条销售明细',
    detailNotInEntry: '这条销售明细不属于这张销售单',
    detailNotExchangeable: '这条明细当前状态不能换货（只有「已交付」可以换）',
    alreadyReturned: '这条明细已经退过货了',
    originalAmountMissing: '原明细没有「实收金额」，无法算差价',
    originalAmountInvalid: '原明细金额无效，无法算差价',
    missingOriginalProduct: '原明细没有关联货品',
    missingOriginalSize: '原明细没有关联尺码',
    originalSizeUnreadable: '原明细的尺码读不到',
    newProductNotFound: '扫到的新货品在「货品信息」里找不到',
    newSizeNotFound: '新鞋的尺码在「尺码管理」里找不到',
    totalNotReadable: '原销售主表「总金额」读不到，未回填总金额（其余已写入）',
    submitFailed: '换货提交失败，请稍后重试',
  }),
});

module.exports = { AFTER_SALES_EXCHANGE };
