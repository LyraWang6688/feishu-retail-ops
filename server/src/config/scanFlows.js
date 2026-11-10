'use strict';

/**
 * 扫码页「流程」配置（2026-10-29，业务负责人确认的方向：**用配置而不是 if-else**）。
 *
 * 目的：把「扫完码之后怎么走」抽成数据 —— 哪几步、每步显示条件、能不能"加一双"、
 * 提交到哪个 handler、要带哪些上下文。页面渲染器/提交器只解释这份配置。
 *
 * ⚠️ 这是**新增的一层**：`sales` 这条 flow 的目的是**描述现状**（行为一字不变），
 *    现有扫码页路由暂时照旧跑；`afterSalesExchange`（售后换款式）是本轮要接的新 flow。
 * ⚠️ `scanWriteService.js` 是**冻结件**：售后换款式的提交不走它，走 `afterSalesExchange` 的
 *    `afterSalesSubmit` handler（售后异步接口）。
 */

const STEP_TYPES = Object.freeze({
  GOODS: 'goods', // 选货品/尺码
  FUNDS: 'funds', // 资金页（实收金额 / 收款方式）
  DIFF: 'diff', // 售后换款式专用：有差价才出现的「价差方式」一步
  SUBMIT: 'submit', // 提交
});

const SUBMIT_HANDLERS = Object.freeze({
  SALES_WRITE: 'salesWrite',
  AFTER_SALES_EXCHANGE: 'afterSalesExchange',
});

/** 声明式显示条件：{ field, op, value } —— 解释器统一处理，不在页面里写 if。 */
const whenDiffNonZero = Object.freeze({ field: 'diffAmount', op: '!=', value: 0 });

const SCAN_FLOWS = Object.freeze({
  // ① 销售建单：现有流程（货品 → 资金 → 提交），行为一字不变。
  sales: Object.freeze({
    id: 'sales',
    label: '销售',
    realm: 'sales',
    steps: Object.freeze([
      Object.freeze({ type: STEP_TYPES.GOODS }),
      Object.freeze({ type: STEP_TYPES.FUNDS }),
      Object.freeze({ type: STEP_TYPES.SUBMIT, handler: SUBMIT_HANDLERS.SALES_WRITE }),
    ]),
    allowAddLine: true,
    // 扫到新货品时回到哪（现有销售流程不变）
    entry: '/r/{number}?from=sales',
    context: Object.freeze([]),
  }),
  // ② 售后·换款式：货品页选 1 双 →（有差价才出「价差方式」）→ 提交售后。
  //    没有 funds 步骤 ⇒ 天然不跳资金页；allowAddLine=false ⇒ 不出现"加一双"。
  afterSalesExchange: Object.freeze({
    id: 'afterSalesExchange',
    label: '售后换款式',
    realm: 'sales',
    steps: Object.freeze([
      Object.freeze({
        type: STEP_TYPES.GOODS,
        allowAddLine: false,
        // ⭐ 2026-11-11（业务负责人）：换款式要**显示「这一双的实收金额」输入框**
        //   （她填金额，系统按「她填的金额 − 原明细金额」算差价；旧口径「货品单价」作废）
        hideAmountInput: false,
        submitLabel: '提交换货',
        banner: '售后换款式：选 1 双，提交后按差价处理',
      }),
      Object.freeze({ type: STEP_TYPES.DIFF, when: whenDiffNonZero, optionsFrom: 'paymentMethodConfig' }),
      Object.freeze({
        type: STEP_TYPES.SUBMIT,
        handler: SUBMIT_HANDLERS.AFTER_SALES_EXCHANGE,
        endpoint: '/api/workbench/sales/after-sales/exchange/submit',
        payload: Object.freeze([
          'requestId', 'salesEntryRecordId', 'detailRecordId',
          'newProductRecordId', 'newSize', 'newAmount', 'diffPaymentMethod',
        ]),
      }),
    ]),
    allowAddLine: false,
    entry: '/r/{number}?flow=afterSalesExchange',
    // 本步（货品页 → 下一步差价/提交）还没接线时的人话（配置先行；渲染/路由不写中文）
    // 换款式价格差弹窗（前台 JS 读这段 JSON；脚本里不写中文）
    exchange: Object.freeze({
      submitEndpoint: '/api/workbench/sales/after-sales/exchange/submit',
      paymentMethodsPath: '/api/workbench/sales/after-sales/payment-methods',
      texts: Object.freeze({
        needAmount: '请先填这一双的实收金额',
        needSize: '请先选新鞋的尺码',
        needMethod: '有差价时要选差价方式',
        collectTitle: '补差价',
        refundTitle: '退差价',
        collectHint: '新鞋比原来贵，差额要收回来',
        refundHint: '新鞋比原来便宜，差额要退给她',
        methodLabel: '差价方式',
        confirm: '确认提交',
        cancel: '取消',
      }),
    }),
    // 售后上下文：从售后页带进来（原单 / 原明细 / 原金额 / 请求标识）
    context: Object.freeze([
      'requestId', 'salesEntryRecordId', 'detailRecordId', 'originalAmount', 'productRecordId',
    ]),
  }),
});

const DEFAULT_SCAN_FLOW = 'sales';

module.exports = {
  STEP_TYPES,
  SUBMIT_HANDLERS,
  SCAN_FLOWS,
  DEFAULT_SCAN_FLOW,
};
