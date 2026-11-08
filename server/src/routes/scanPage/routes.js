'use strict';

/**
 * 扫码页路由注册（P4-2c/d）：public / GET 页面 / POST 动作 / 兜底错误，四组分别安装。
 */
const { installScanPagePublicRoutes } = require('./public');
const { installScanPageGetRoutes } = require('./pages');
const { installScanPageActionRoutes } = require('./actionRoutes');
const { installScanPageErrorRoutes } = require('./errors');

const installScanPageRoutes = ({ router, ctx }) => {
  const {
    DEFAULT_REALM, LABEL_PRINT_QUEUE, arrival, backTargetFor, buildPaymentRows, candidatePaymentMethods,
    clearMultiItemPending, config, fillWriteText, invalidateLiveInventorySnapshot, logError, logInfo,
    logRendered, logWarn, markRealmUsed, multiItemOrder, multiItemOrderConfig, multiItemWire, openIdOf,
    postActionFor, purchaseBackground, realmEntryParams, realmOfAction, realmScanConfig, renderMinimalPage,
    resolveLabelPrintQueue, respondWriteFailure, scanTargetOf, sendHtml, sessionIdOf, setDraftOrderAmount,
    writeConfig, writeService,
  } = ctx;

  const {
    submitMultiItemOrder, buildWriteContext, loadPendingBatches, invalidateInventorySnapshot: invalidateFlowSnapshot,
    clearDraftForScanIfNeeded, buildPrintContext,
  } = require('./flowHelpers').createFlowHelpers({
    DEFAULT_REALM, LABEL_PRINT_QUEUE, arrival, backTargetFor, buildPaymentRows, candidatePaymentMethods,
    clearMultiItemPending, config, fillWriteText, invalidateLiveInventorySnapshot, logError, logInfo,
    logRendered, logWarn, markRealmUsed, multiItemOrder, multiItemOrderConfig, multiItemWire,
    openIdOf: sessionIdOf, postActionFor, purchaseBackground, realmEntryParams, realmOfAction,
    realmScanConfig, renderMinimalPage, resolveLabelPrintQueue, respondWriteFailure, router,
    scanTargetOf, sendHtml, setDraftOrderAmount, writeConfig, writeService,
  });
  const routeCtx = {
    ...ctx, submitMultiItemOrder, buildWriteContext, loadPendingBatches,
    invalidateInventorySnapshot: invalidateFlowSnapshot, clearDraftForScanIfNeeded, buildPrintContext,
    ROUTE_PATTERNS: [config.route.recordPath].filter(Boolean),
  };

  installScanPagePublicRoutes({ router, ctx: routeCtx });
  installScanPageGetRoutes({ router, ctx: routeCtx });
  installScanPageActionRoutes({ router, ctx: routeCtx });
  installScanPageErrorRoutes({ router, ctx: routeCtx });
};

module.exports = { installScanPageRoutes };
