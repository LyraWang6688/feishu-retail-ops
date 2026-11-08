'use strict';

/** 扫码页页面/打印/验收助手（阶段 5c-2 从 index.js 搬出）。 */
const createScanPageHelpers = ({ options, ctx, deps, router }) => {
  const {
    COOKIE_NAME, DEFAULT_REALM, ENTRY_RULE_TEXTS, FUNNEL, LABEL_PRINT_QUEUE, PURCHASE_RETURN_REALM, REALM_SCAN, SCAN_AUTH_REDIRECT, SCAN_PAGE, SCAN_WRITE, SalesFollowupService, TICKET, V1BitableGateway, asList, buildLoginStartUrl, buildPaymentRows, createFirstVisitKeyAdopter, createLarkJsapiService, createLegacySessionProbe, createMultiItemOrderService, createMultiItemPendingOf, createPageContext, createPageTokenMiddleware, createPaymentMethodsService, createPurchaseSchedulerOf, createPurchaseWriteBackgroundService, createSalesAsyncRuntime, createScanPageRouter, createScanPageService, createScanWriteService, createVoucherPaymentService, encodeSession, express, feishuAuthEnabled, fillWriteText, getLabelPrintQueue, getSessionUser, handleAddLineOf, handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit, handlePrintLabelOf, handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, handleUiTap, installScanPageRoutes, invalidateLiveInventorySnapshot, isDataNotReady, logError, logInfo, logWarn, markRealmUsedOf, markTapCode, mergeFirstItemEntries, mountedPathOf, orderWithPreferred, pageSessionKey, pageSessionKeyOfRequest, parseMultiItemGroups, parseNumberSegments, parsePaymentRows, parseReplenishEntries, parseReturnEntries, pathWithoutTicket, purchaseAmountInvalidOf, purchaseAmountMissingOf, purchaseAmountRequiredForOf, purchaseEntryViolation, purchaseWriteDisabledError, realmEntryParams, realmOfActionOf, redeemSessionTicket, renderFlowOf, renderMinimalPage, renderSalePaymentStepPage, renderSalesHome, renderScanMessagePage, renderScanPage, renderScanSkeleton, requireWorkbenchAccess, resolveMultiItemOrderConfig, resolvePurchaseReturnImageOptions, resolveRealm, resolveScanNext, roleOf, sellableSizeTexts, sendHtml, setTraceFields, sizesForCategory, uiTapResultMiddleware, withPageSession,
  } = deps;
  const {
    SUBMIT_TOAST, addBackPath, adoptFirstVisitSubmitKey, badNumberPage, candidatePaymentMethods, clearMultiItemPending, config, configuredPaymentMethods, gateway, larkJsapi, logFunnelPage, logRendered, multiItemChainOf, multiItemOrder, multiItemOrderConfig, multiItemOrderEngine, multiItemPendingKey, multiItemWire, notFoundPage, paymentMethodsService, purchaseAmountInvalidPage, purchaseAmountMissingPage, purchaseBackground, purchaseEntryInvalidPage, readMultiItemPending, realmScanActive, realmScanConfig, realmScanPageConfig, realmScanTriggered, renderContext, renderMessage, renderScan, resolveLarkJsapi, respondFailure, respondSettlementBlock, respondWriteFailure, responses, salesRuntime, schedulePurchaseWrite, sendHuman, sendPaymentStep, service, setDraftOrderAmount, step2WriteOf, unknownActionFailure, voucherPayments, withoutRealmQuery, writeConfig, writeMultiItemPending, writeService,
    openIdOf, sessionIdOf, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor,
  } = ctx;

  let arrivalInstance = options.arrivalService || null;
  const arrival = () => {
    if (arrivalInstance === null && options.arrivalService !== false) {
      // eslint-disable-next-line global-require
      const { createScanArrivalService } = require('../../services/scanArrivalService');
      arrivalInstance = createScanArrivalService({
        gateway,
        config: writeConfig.acceptance,
        store: options.arrivalSessionStore,
      });
    }
    return arrivalInstance;
  };


  /**
   * 🔴 **绝不空白**：所有"人话页"都从这里发出去 —— 连渲染本身抛错都还有最后一道兜底
   *（`renderMinimalPage` 不依赖任何配置，只有字符串拼接 + 转义，几乎不可能再抛）。
   *
   * 业务负责人 2026-10-09 真机反馈「手机扫码一片空白」之后定的口径：
   * **页面上无论如何都要有看得见的东西** —— 宁可给她一句"暂时打不开"，也不给一张白纸。
   */


  /**
   * ⭐⭐ **提交成功页**（`POST submit_order` 写成功之后直接渲染它，不回原页）。
   *
   * 业务负责人真机口径（逐字）：「点击提交之后直接提示"**您的提交已成功**"就行，
   * **页面跳转到提交成功页**。在这个页面上可以提示"**再录一单**"类似的信息，
   * 给一个链接让我能回到扫码页。」
   * ⇒ 与 `sendHuman` 同一套"**绝不空白**"兜底（成功页渲染抛错也还有最后一张人话页），
   *    只是渲染器换成成功页那一个。
   */
  /**
   * ⭐⭐ 2026-10-12（她拍板 · 方案 A，逐字）：「**提交完 ⇒ 自动回首页，而首页 = 销售页** ✓」
   *
   * 成功页要的三件事**只在这里算一次**（三路共用 ✓）：
   *   · `returnPath` = **服务端渲染出来的确定 URL**（她扫的那个编号 + **销售领域**）；
   *   · `autoReturnUrl` = **同一个 URL**（自动跳转与按钮**不可能不一致** ✓ 唯一来源 ✓）；
   *   · `returnDelaySeconds` = 先让她看到结果，再跳（配置里定 ✓）。
   * 配置：`SCAN_PAGE.successReturn`（`homeRealm` 改成别的领域即可回别处 ✓）。
   */
  /**
   * ⭐⭐ 2026-10-12：**写成功之后**记住"这个领域她刚用过"（她："继续扫 ⇒ 自动还是补货"）。
   * ⚠️ 只在**写成功**那几条路上调（看一眼 / 打开页面不算 ✗）；
   *    失败一律吞掉（记不住领域不该影响她这一单 ✓）。
   */
  /** 动作 → 领域（"她刚在哪个领域干过活"）——**一处映射**，别在各 handler 里各写一遍。 */
  // 动作分派第 1 刀：实现搬到 `./actions.js`（纯函数可单测）；这里只保留**薄包装**，
  // 调用点一个字都没动。
  const realmOfAction = (action) => realmOfActionOf(action, writeConfig);
  const markRealmUsed = (openId, realm) => markRealmUsedOf({
    writeService, openId, realm, event: config.events.failed, logWarn,
  });

  // ⚠️ `req` 是**第 4 个可选参数**（task-58 加，只为那条 `scan.page.rendered` 日志 —— 成功页 =
  //    扫码这条链路的第三个落点 ✓）。不传照样能用（老调用点 / 用例不会炸 ✓），只是日志里
  //    `query_keys` 为空、`number` 为空 —— **判定与页面一个字都不受它影响** ✗。
  //    ⭐ task-60：**9 个调用点一个不落全传了 `req`**（含"一单多货品"那条成功页 ✓）——
  //      她点名要的"字段齐"（AC-LR4）就是这条：每一发 `page:'success'` 都说得出来"是哪一件" ✓。

  /**
   * ⭐⭐ 2026-10-12：**404「没找到这个编号」** 统一从这一处出 —— **人话 + 指得出下一步**。
   *
   * 她真机那次（二维码里编号缺「类别」⇒ 查不到 ⇒ 回 400 / 原始错误页）之后定的口径：
   * **不许再给原始错误页**。这里三种情况各一句人话：
   *   · 普通找不到（没试过兜底）⇒ 与改前**逐字相同**（`notFoundBody`，一个字都不多加）；
   *   · 编号缺段、按（货号 + 颜色）**也没找到** ⇒ 说清"缺了什么、该核对什么"；
   *   · 编号缺段、**匹配到多款** ⇒ 说清"没法确定是哪一双"（**不猜**）。
   * 后两种都给【再扫一次】的回跳（= 这一页的地址，重新扫标签即可）。
   */


  /**
   * 写入口失败 → **在页面上**说清楚（业务负责人：失败要人话，不许静默、不许只写日志）。
   * ⚠️ 内部错误（飞书错误码 / 表名字段名）**不回显**：`scanWriteService` 已经把它们
   *    换成了配置里的通用人话，原文只进日志。
   */
  /**
   * ⭐⭐ 2026-10-12（她真机 `POST /MK31-1|咖色|B` ⇒ **400 / 1ms**、周围**零日志** ✗）：
   * **"按钮认不出来"必须留痕**，而且三种原因**分开**（修法完全不同 ✓）：
   *   · `missing`      —— 表单里**根本没带** `action`（她点了某颗按钮 ⇒ 可能是**真 bug**）
   *   · `blank`        —— 带了但是空的（老页面 / 手改表单）
   *   · `unrecognized` —— 带了个我们认不出的值
   * ⚠️ 只打**字段名**（`body_keys`），**不打值** ✗；`action` 是**我们的动作名**（不是她的数据）⇒ 截断后打出 ✓。
   */

  /**
   * ⭐⭐ 2026-10-14 晚（业务负责人**逐字**）：「**退货整单金额（必填），与补货同一套配置**」
   *   ＋同一晚另一句：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」。
   *
   * ⇒ **补货 / 退货共用这一个闸门**（一套配置 ✓ 不写两套 ✗）：整单金额**空** ⇒
   *   **400 + 人话 + 一个字都不写**（不建批次 / 不写明细 / 不动库存）——
   *   校验发生在**任何写之前** ⇒「零写入」是**结构性**的，不靠写服务配合 ✓；
   *   **非空 ⇒ 照旧提交** ✓。
   *
   * ⚠️ 与销售那条「每件实收必填」**同一形状**（判据只在**页面这条路由**上；服务层一行不动）——
   *    差别只有出口：销售那条回**资金页**（她还得在那一页点按钮），采购这两条回
   *    **一张人话页 + 一颗「回上一页」的链接**（那一页的表单还在，她补一个数字再提交 ✓）。
   * ⚠️ 这张页面**不写任何业务表**（`sendHuman` 只把 HTML 发出去 ✓）。
   * ⭐⭐ 2026-10-15（③ 写入 · 她裁决 ⓐ「复用「发生金额」」）**改指向**：
   *   改前逐字：`🔴 本版**只判"填没填"**（她的原话就是「必填」）：数字格式不做额外校验、金额也**不落表**`
   *   改后逐字：**两件事都变了** —— ① 那个数现在**要落表**（退货批次行的「发生金额」）；
   *     ② ⇒ 多一道「**必须是数字**」的闸门（`purchaseAmountInvalidPage`，见下面）——
   *     放一个非数字过去 = "页面填了、表里没有" = **假成功** ✗（她最在意的一条）。
   *   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
   *     ＋ 那一列是**数字列**（`v1BitableSchema` 的 `purchaseOrderBatch.actualAmount`）。
   */

  /**
   * ⭐⭐ 2026-10-16（A2/A3 接线 · 业务负责人**逐字**）：**当前这条链路**要不要「整单金额」。
   *
   * 依据（她**逐字**）：
   *   · 2026-10-16：「**补货不问金额**」（＋「不用做那个为空去单价的功能了」）；
   *   · 2026-10-14 晚：「**退货整单金额（必填），与补货同一套配置**」
   * ⇒ **补货不问金额** ✓；**退货 / 验收不受影响** ✓（`requiredByRealm.return / .accept` 仍是显式 `true`）。
   *
   * ⭐ 实现 = **按链路分档**：取 `PURCHASE_AMOUNT.requiredByRealm[realm]`（一个链路一个**显式布尔** ✓）。
   *   · **改前逐字**（两个闸门各自一行）：`if (writeConfig.purchaseAmount?.required === false) return false;`
   *     —— 那是"**一个开关管两条链路**"：一关就把退货也放开 ✗（#667 查实的事实）。
   *   · **改后逐字**：`if (purchaseAmountRequiredFor(realm) === false) return false;`
   *   · 依据：她 2026-10-16「补货不问金额」＋ 2026-10-14「退货整单金额（必填），与补货同一套配置」。
   *
   * ⚠️ **只认显式布尔，不写 `||` 兜底** ✗ —— `requiredByRealm[realm] || 默认值` 那种形状会让
   *   "清空变量"回退成默认值 ⇒ **关不掉**（见 `AGENTS.md`《配置先行》那条）。
   * ⚠️ 老键 `required` **不改名、仍然先读**（兼容面：老 `.env` 里写 `false` / 空串 ⇒ **整套闸门关掉**，
   *   **一个字节的老行为都没变** ✓）。它只会把闸门**关小**（更严），**不会**把退货那道必填**放开** ✗
   *   ⇒ 所以「退货 / 验收不受影响」在**任何** `.env` 取值下都成立 ✓。
   * ⚠️ `realm` 认不出来（**不该发生**：两个调用点都传**字面量**，见下面两处）⇒ 按"**要金额**"判（宁严不宽 ✓）。
   * ⚠️ 调用点传的是**档位键**（`'replenish'` / `'return'`）——⚠️ 与页面的**领域 id**（`'purchase_return'`）
   *   **故意不同名**：档位键由 `config/scanWrite.js` 的三个 `readFlag` 决定（`replenish` / `return` / `accept`），
   *   所以退货那一处**逐字传 `'return'`** ✗ 不是 `'purchase_return'`（传错 = 拿错档位 ⇒ 判据会红 ✓）。
   */
  // 整单金额三道闸门同样搬到 `./actions.js`（补货/退货共用；按链路配置在那边读）。
  const purchaseAmountRequiredFor = (realm) => purchaseAmountRequiredForOf(realm, writeConfig);
  const purchaseAmountMissing = (body, realm) => purchaseAmountMissingOf(body, realm, writeConfig);
  const purchaseAmountInvalid = (body, realm) => purchaseAmountInvalidOf(body, realm, writeConfig);

  /** 「要填数字」那张人话页（与"还没填"同一形状：H1 + 怎么填 + 回上一页 + 埋点原因码）。 */

  /**
   * ⭐⭐ 2026-10-16（口子收尾 · 业务负责人**逐字**口径）：
   *   「**异步只针对"写库"**；**校验必须当场同步拦**」——**尺码 / 数量 / 空单**这三类
   *   （判据与写层同源：`config/scanPurchaseEntryRules.js` ⇒
   *    `services/scanWriteService.js:1397-1426`（补货）/ `:1556-1585`（退货））。
   *
   * 🔴 命中 ⇒ **400 + 同一句人话 + 零写入 + 一次后台都不排** ✓
   *   （拦在 `schedulePurchaseWrite(…)` **之前** —— 顺序不能反 ✗）；
   *   通过 ⇒ 才排后台（异步那半**一个字不改** ✗）。
   *
   * ⚠️ 与"金额那两张页"**同形**（H1 + 人话 + 回上一页 + 埋点原因码 ✓）：
   *   · 正文**就是写层那一句**（`violation.message` —— 配置里的 `TEXTS.*Body` ✓ 不新造第二句 ✗）；
   *   · `code` 走 `markTapCode`（埋点能按它分辨是哪一类 ✓）；
   *   · 日志走 `writeConfig.events.entryInvalid`（**与写失败 `failed` 分开**：原因不同、修法不同 ✓）。
   * ⚠️ 这张页面**不写任何业务表**（`sendHuman` 只把 HTML 发出去 ✓）⇒「零写入」是**结构性**的 ✓。
   */


  /**
   * ⭐ 写成功之后**立刻作废**「实时库存」内存快照（她的硬要求：**库存准确**，
   * 不能等 30 秒那一拍）。
   *
   * 🔴 为什么调用点在**路由**（而不是写服务）：本任务的写作用域只覆盖到扫码这条链路的
   *    `routes/scanPage.js`；`services/scanWriteService.js` 刻意一行都没动。
   *    其余写入口（销售入账 / 到货 / 手工库存调整 / 交付扣减）**不在本任务作用域内**，
   *    它们各自在写成功后加一行同样的调用即可（跨模块、零注入，谁都不认识扫码页）：
   *    `require('../../services/liveInventorySnapshot').invalidateLiveInventorySnapshot('原因')`
   *    —— 详见 `services/liveInventorySnapshot.js` 的注释。
   */

  // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】（送到店里那台电脑）────────
  /**
   * 打印队列（**延迟构建**，用例可注入 `options.labelPrintQueue`）。
   * ⚠️ 与电脑侧路由共用 `labelPrintQueueRuntime` 的单例 —— 那条长连接才收得到推送。
   */
  let labelPrintQueue = options.labelPrintQueue || null;
  const resolveLabelPrintQueue = () => {
    if (!labelPrintQueue) labelPrintQueue = getLabelPrintQueue();
    return labelPrintQueue;
  };

  /**
   * 渲染「货品」领域要的**打印上下文**（只放事实：在线与否 + 本次/最近一次任务 + 文案 + 回跳）。
   *
   * ⭐⭐ 2026-10-11 真机反馈（「点完没有反馈 ⇒ 她以为没点上、连点几次 ⇒ 多打了好几张」）之后：
   *    · `submitted`（`?printed=1&job=<id>`）⇒ 渲染层出**显眼横幅**：
   *      「✅ 已发送给打印电脑：本次 N 张」+ 在线/未连接 + 「已提交，不用重复点」；
   *      N 与状态**从那条任务上读**（`jobId`）—— 不是页面上猜的。
   *    · `duplicated`（`?dup=1&job=<id>`，= 去重窗口内又点了一次）⇒ 横幅改成
   *      「刚刚已经发过一次：本次 N 张（没有重复提交）」+ 一句"确实要再打一张"+
   *      **【再打一张】** 按钮（带 `again=1`，绕过窗口）。
   *
   * ⚠️ **绝不让这一页因为打印链路坏掉而空白**：队列不可用 ⇒ `enabled: false`，
   *    渲染层如实说一句"打印服务暂时不可用" + 保留原来那两条链接（人话，不是白屏）。
   */

  // ── ⭐⭐ 2026-10-11（方案A）：扫码验收 ──────────────────────────────────────
  /** 验收表单的 POST 目标：落地页（没有编号那一刻）与逐码页（有编号）各一个。 */

  return { openIdOf, sessionIdOf, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, arrival, arrivalInstance, backTargetFor, isRecordBase, labelPrintQueue, lookupInputOf, markRealmUsed, openIdOf, postActionFor, purchaseAmountInvalid, purchaseAmountMissing, purchaseAmountRequiredFor, realmOfAction, resolveLabelPrintQueue, scanTargetOf, sessionIdOf };
};

module.exports = { createScanPageHelpers };
