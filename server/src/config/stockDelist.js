'use strict';

/**
 * 库存清零后的货品下架规则（2026-11-24）。
 *
 * 只在这里定义"什么时候提示下架 / 怎么打印"；
 * 具体库存计算、库存写入、下架归档仍复用既有 InventoryService / ProductDelistService。
 */
const STOCK_DELIST = Object.freeze({
  enabled: true,
  // 下架前是否允许没有样例图（她确认下架 = 已知道这个后果）。
  allowNoSample: true,
  // 三个入口是否提示；销售/退货后续复用同一份配置。
  // ⭐ 2026-11-26：销售那一项从 `salePayment` 改名为 `saleSubmit` —— 提示时点已定在
  //   **货品页点【提交这一单】**（不再是资金页），名字必须跟着语义走。
  prompts: Object.freeze({
    inventoryClear: true,
    saleSubmit: true,
    purchaseReturn: true,
  }),
  // 确认层（服务端渲染）：一次最多列几款、默认是否全选（她：默认全选、可逐个取消）。
  confirm: Object.freeze({
    maxRows: 10,
    defaultSelected: true,
  }),
  // 打印资格：下架 / 无库存不打印；没有可打印货品则跳过打印页。
  print: Object.freeze({
    excludeDelisted: true,
    excludeZeroStock: true,
    skipPromptWhenNoPrintable: true,
  }),
});

module.exports = { STOCK_DELIST };
