'use strict';

/** 扫码页装配上下文（阶段 5c-2 从 index.js 搬出）。 */
const createScanPageSetup = ({ options, deps }) => {
  const {
    COOKIE_NAME, DEFAULT_REALM, ENTRY_RULE_TEXTS, FUNNEL, PURCHASE_RETURN_REALM, REALM_SCAN, SCAN_AUTH_REDIRECT, SCAN_PAGE, SCAN_WRITE, SalesFollowupService, TICKET, V1BitableGateway, asList, buildLoginStartUrl, buildPaymentRows, createFirstVisitKeyAdopter, createLarkJsapiService, createLegacySessionProbe, createMultiItemOrderService, createMultiItemPendingOf, createPageContext, createPageTokenMiddleware, createPaymentMethodsService, createPurchaseSchedulerOf, createPurchaseWriteBackgroundService, createSalesAsyncRuntime, createScanPageRouter, createScanPageService, createScanWriteService, createVoucherPaymentService, encodeSession, express, feishuAuthEnabled, fillWriteText, getSessionUser, handleAddLineOf, handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit, handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, handleUiTap, installScanPageRoutes, invalidateLiveInventorySnapshot, isDataNotReady, logError, logInfo, logWarn, markRealmUsedOf, markTapCode, mergeFirstItemEntries, mountedPathOf, orderWithPreferred, pageSessionKey, pageSessionKeyOfRequest, parseMultiItemGroups, parseNumberSegments, parsePaymentRows, parseReplenishEntries, parseReturnEntries, pathWithoutTicket, purchaseAmountInvalidOf, purchaseAmountMissingOf, purchaseAmountRequiredForOf, purchaseEntryViolation, purchaseWriteDisabledError, realmEntryParams, realmOfActionOf, redeemSessionTicket, renderFlowOf, renderMinimalPage, renderSalePaymentStepPage, renderSalesHome, renderScanMessagePage, renderScanPage, renderScanSkeleton, requireWorkbenchAccess, resolveMultiItemOrderConfig, resolvePurchaseReturnImageOptions, resolveRealm, resolveScanNext, roleOf, sellableSizeTexts, sendHtml, setTraceFields, sizesForCategory, uiTapResultMiddleware, withPageSession,
  } = deps;

  // #948：统一异步任务（重试 / 失败发运营群）—— 适配器与单例都在这里 require（不塞进 index.js 的巨型 deps 列表）
  const { createAsyncJobPurchaseRunner } = require('../../services/asyncJobPurchaseRunner');
  const { getAsyncJobService } = require('../../services/asyncJobRuntime');

  const config = options.config || SCAN_PAGE;
  const {
    openIdOf, sessionIdOf, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor,
  } = createPageContext({
    config, DEFAULT_REALM, getSessionUser, roleOf, setTraceFields, pageSessionKeyOfRequest,
  });
  // 拆分第 2 刀：渲染日志/漏斗的实现搬到 `./renderContext.js`；这里只创建一次。
  // ⚠️ 2026-10-29：成功页回跳（`successReturnFields`）随成功页退场 ⇒ 不再注入 `postActionFor`。
  const renderContext = require('./renderContext').createRenderContext({ config });
  const { logFunnelPage, logRendered } = renderContext;
  // ⭐⭐ 2026-10-29：提交成功回执 = 统一 toast（`done` 参数名/文案的家都在那一份配置里）。
  const { SUBMIT_TOAST } = require('../../config/submitToast');
  const writeConfig = options.writeConfig === undefined ? SCAN_WRITE : options.writeConfig;
  const gateway = options.gateway || new V1BitableGateway();
  // ⚠️ 只读那一半的 service：`options.service` 供用例注入一个假的（既有用例就是这么做的，注入后不建内存快照）。
  const service = options.service || createScanPageService(gateway, {
    config,
    snapshot: options.snapshot,
    // ⭐ 生产接线（`app.js` 挂这个 router）默认**开着**后台快照；
    //    用例可以传 `startSnapshot: false`（不然会多出一次整表读 + 一个进程级定时器）。
    startSnapshot: options.startSnapshot !== false,
  });
  // 渲染器也留一个注入点：**只为验证"渲染抛错也必须回人话页"**（见用例 AC-W5）。
  const renderScan = options.render?.scan || renderScanPage;
  const renderMessage = options.render?.message || renderScanMessagePage;
  // ⭐ 2026-10-12：提交成功页（逐字「您的提交已成功」+「再录一单」回扫码页）——
  //    单独一个注入点，用例可以钉"成功页长什么样"而不用碰别的页。
  // 深拆 P3b：响应/人话页面 helpers 搬进 ./responses.js（显式注入依赖；函数体逐字）
  const responses = require('./responses').createResponses({
    config, writeConfig, service, renderMessage, renderMinimalPage, sendHtml,
    logError, logWarn, isDataNotReady, DEFAULT_REALM, ENTRY_RULE_TEXTS, markTapCode,
    resolveRealm, scanTargetOf: (r) => scanTargetOf(r),
    backTargetFor: (r, f) => backTargetFor(r, f),
    postActionFor: (t, r) => postActionFor(t, r),
  });
  const { sendHuman, badNumberPage, notFoundPage, respondFailure, unknownActionFailure, purchaseAmountMissingPage, purchaseAmountInvalidPage, purchaseEntryInvalidPage, respondWriteFailure } = responses;
  /**
   * ⭐⭐ 2026-10-16 A2a ③：**候选收款方式 = 读「收款方式管理」那张表**（只读 + TTL 缓存那一份 service）。
   *
   *   她 2026-10-14 逐字：「**付款方式用交易方式管理，可选择**」⇒ 页面上的候选不再只吃
   *   `config/scanWrite.js` 里那几个名字，而是**表里真实的那几条**（她点名要过「抖音团购券」）。
   *   🔴 **读不到表**（或读出来是空的）⇒ **大声 `logWarn` + 退回配置里的方式**：
   *      · **不许静默**（静默 ⇒ 表坏了没人知道 ✗）；
   *      · **不许留白**（这一页是**展示** —— 候选为空 ⇒ 她"点不出来"，收款这一步就走不下去 ✗）。
   *   ⚠️ 与 `listAccessories`（`:181`）**口径不同**：配品读不到给**空清单**（少一个下拉项不挡卖鞋 ✓），
   *      收款方式读不到**必须退回配置**（挡的是"她能不能记账"✗）—— 这里刻意**不照抄**那一条。
   *   ⚠️ 默认方式照旧**排在第一位**（`defaultPaymentMethod`，她 2026-10-08：「默认微信」）——
   *      表里没有它时也保留：与改前那句 `[...new Set([default, ...config])]` 同口径 ✓。
   */
  const paymentMethodsService = options.paymentMethodsService
    || createPaymentMethodsService(gateway, options.paymentMethodsServiceOptions);
  /**
   * ⭐⭐ 2026-10-16（task-57 · 抖音团购券）：**券行**的解析器（只读 ✓ 与上面那份收款方式 service
   *   **共用同一趟读与同一份缓存** ⇒ 不为券多打一次飞书 ✓）。
   *   它只干一件事：把资金页那几行认成"券行"，并把一张券的**两个数各归各位**（面值→差额 / 结算款→明细）。
   */
  const voucherPayments = options.voucherPaymentService
    || createVoucherPaymentService({
      gateway,
      paymentMethods: paymentMethodsService,
      config: options.voucherPaymentConfig,
    });
  // 仅用于「表读不到」日志里的诊断信息；页面候选只认表。
  const configuredPaymentMethods = () => [writeConfig.sale.defaultPaymentMethod].filter(Boolean);
  const candidatePaymentMethods = async (req) => {
    const fallback = configuredPaymentMethods();
    const listed = await paymentMethodsService.list().catch((error) => ({
      ok: false, items: [], reason: 'payment_methods_unreadable', error: error?.message || 'unknown',
    }));
    if (listed?.ok === true && Array.isArray(listed.items) && listed.items.length) {
      // ⭐ 2026-10-18：表是唯一真源；配置默认方式只在表里存在时排第一（详见 orderWithPreferred）。
      return [...new Set(orderWithPreferred(listed.items, writeConfig.sale.defaultPaymentMethod))];
    }
    // ⭐ 2026-10-26：不再退回配置里的「微信/现金/支付宝/银行卡」——
    //   那份 fallback 与表里的真实值不一致（表里是「微信扫码 / 微信转账…」），
    //   页面能选、写库又按表校验 ⇒ 必然失败（线上 XSD-20261026-0007）。
    //   服务端只认表 / 最后一次成功快照；从未读成功过 ⇒ 宁可不给选项，也不给假选项。
    logWarn('scan.sale.payment_methods_unreadable', {
      request_id: req?.requestId,
      reason: String(listed?.reason || 'payment_methods_empty'),
      error: listed?.error ? String(listed.error) : undefined,
      message: '收款方式表读不到，且没有历史快照；不提供假选项',
      fallback,
    });
    return [];
  };
  /**
   * ⭐⭐ 2026-10-14（业务负责人口径：**点「提交这一单」只到资金页、点资金页按钮才建单**）：
   *   资金页的渲染**只留这一处**（GET 刷新认标记 / 点提交 / 点按钮 三处共用 ✓ 一份实现 ✗ 不复制）；
   *   原来它写在 `submitSale` 之后 ⇒ 只有"提交成功"用得到 ✗；且一度写在 POST 处理器里
   *   ⇒ ⭐ GET 看不到它（真机 `ReferenceError` ✗）⇒ 现在放在**工厂作用域** ✓
   *   ⚠️ **逐字**：`step2Write` 的字段与渲染入参一个都没改 ✗（不许顺手改口径 ✓）
   */
  const step2WriteOf = (opts = {}) => ({
    texts: writeConfig.texts, fields: writeConfig.fields, actions: writeConfig.actions,
    // ⭐⭐ 2026-10-16 A2a ③：候选清单**由调用方传进来**（= 上面读表那一份 ✓ 一份真源 ✗ 不在这儿再拼一份）——
    //   拿不到（用例直接调这一页 / 还没接线的老路径）⇒ 退回配置里的方式（与改前同一个退路 ✓）。
    // ⭐ 2026-10-26：不再回落到配置里的旧方式（与表/写库校验不一致 ⇒ 会写出 400）。
    //   调用方拿不到候选 ⇒ 就是空清单；宁可不给选项，也不给假选项。
    paymentMethods: Array.isArray(opts.paymentMethods) ? opts.paymentMethods : [],
    // 券方式：金额可空（后端解析后按平台结算款写）；普通方式仍 required。
    voucherMethods: Array.isArray(opts.voucherMethods) ? opts.voucherMethods : [],
    voucherDetails: Array.isArray(opts.voucherDetails) ? opts.voucherDetails : [],
    defaultPaymentMethod: writeConfig.sale.defaultPaymentMethod,
    paymentRowCount: writeConfig.sale.paymentRowCount,
    // ⭐ 她刚填的那一档 / 实付多少 / 收款行 ⇒ **原样带回**（她不用重打 ✓ 她明确要过这条 ✓）
    paymentStatus: String(opts.paymentStatus || writeConfig.sale.paymentStatus.default),
    defaultPaymentStatus: writeConfig.sale.paymentStatus.default,
    paidAmount: String(opts.paidAmount || ''),
    ...(Array.isArray(opts.paymentRows) ? { paymentRows: opts.paymentRows } : {}),
    draft: { lines: [] },
  });
  /**
   * ⭐⭐ 2026-10-16（task-58 · 业务负责人真机 05:34，逐字）：
   *   「静态感觉很好，扫描了几个货品二维码，**但是有一个货品点击了之后出现的是这个资金页** ✗」
   *
   * 🔴 **为什么非要有这条**：她拉的线上日志里**每一次都打了 `scan.page.viewed`** —— 因为
   *   "资金页接管"那条路（本文件下面）**也**要先 `service.lookup()`，而 `viewed` 就在 lookup 里打
   *   （`services/scanPageService.js:1356` / 命中缓存 `:1070`）⇒ **日志长得一模一样**，
   *   分不出"渲染的是货品页还是资金页" ✗✗ ⇒ 真机再来一次还是只能猜。
   *
   * 这条只记**事实**（哪个落点 + 哪条条件命中 + 这次带了哪些查询字段 + 扫的是哪个编号）：
   *   · **不读表、不判定、不改任何返回** ✗ —— 判定那几行一个字都没动 ✓
   *   · `query_keys` **只字段名**（与 `app.js:80` 同一口径 ✗ 不记值）
   *   · `number` = 这次扫的编号 / 记录 ID（与 `scan.page.viewed` 同口径 ✓）
   *   · 事件名落 `config/scanPage.js` 的 `EVENTS.rendered`（配置先行 ✓）
   */
  /**
   * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
   *   改前逐字：这段「被挡 ⇒ 渲染资金页（`status: 400`）＋ 把她刚填的钱原样带回」**只长在 `payment_pay` 那一支里** ✗
   *   改后逐字：抽成本地 `async` 函数 `respondSettlementBlock(res, req, ctx)` ⇒ ⭐ **两处共用** ✓
   *     （`payment_pay` 那一支 ＋ `submit_order` 里「货那一跑」之前的**预判** ✓ —— 预判下一轮接）
   *   依据 = 写服务契约逐字「拦住、**一个字都不写**」＋ 业务负责人 2026-10-16 23:5x「**那我肯定能看到这个单号呀**」✓
   *   🔴 **只搬不改**：文案 / 字段 / 中文 / `status: 400` 一个字不动 ✓
   *     （唯一新增：`toCents` 那 1 行同式搬进来 —— 它原本声明在 `payment_pay` 支内，抽出来会跑出作用域 ✓）
   */
  const respondSettlementBlock = async (res, req, ctx) => {
    const { settlement, effectiveLineAmounts, paidPayments, realm, body, fields, pendingLines,
      effectivePaymentStatus, pendingPaidAmount } = ctx;
    const toCents = (value) => Math.round(Number(value || 0) * 100);
            const blockText = (() => {
              const t = writeConfig.texts || {};
              const money = (cents) => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
              // ⚠️ 用**解析后**那两个数（与上面 `settlement` / 与真正要落库的金额**同一份** ✓ 不两套算法）
              const itemsCents = effectiveLineAmounts.reduce((sum, value) => sum + toCents(value), 0);
              const paymentsCents = paidPayments.reduce((sum, row) => sum + toCents(row.amount), 0);
              if (settlement.code === 'amount_mismatch' && t.amountMismatchBody) {
                const diff = Math.abs(paymentsCents - itemsCents);
                const side = itemsCents === 0
                  ? fillWriteText(t.amountMismatchNoItems, { diff: money(diff) })
                  : fillWriteText(
                    paymentsCents > itemsCents ? t.amountMismatchOver : t.amountMismatchShort,
                    { diff: money(diff) },
                  );
                return fillWriteText(t.amountMismatchBody, {
                  items: money(itemsCents), payments: money(paymentsCents), side,
                });
              }
              // 🔴🔴 2026-10-14 修（真 bug）：`settlement.code` 是 **snake_case**
              //    （`full_without_money` / `partial_amount_missing` / `partial_amount_mismatch`），
              //    而 `config/scanWrite.js` 的文案 key 是 **camelCase**（`fullWithoutMoneyBody` …）
              //    ⇒ 原来直接拼 `${settlement.code}Body` **永远查不到** ⇒ 那三条 block 的人话
              //    渲染成**空串**（页面只剩一个干巴巴的 400 + 满页表单）。
              //    ⚠️ 这就是她 2026-10-14 真机"点了 6 次「提交整单付款」都只看到 400"的现场之一：
              //      日志里当时**连原因都没有**（那条 `scan.write.settlement_blocked` 是后来才补的），
              //      页面上也没有一句话 —— 两处都静默。
              //    ⇒ 按 snake_case → camelCase 取真源文案（**不新编中文** ✓ 仍只用既有模板 ✓）。
              const codeCamel = String(settlement.code || '')
                .replace(/_([a-z])/g, (_, char) => char.toUpperCase());
              return t[`${codeCamel}Body`] || t[settlement.code] || '';
            })();
            return sendPaymentStep(res, req, {
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: body[fields.submitKey],
              count: pendingLines.length,
              notice: blockText,
              // ⭐ 她刚填的钱**原样带回**（她改一下就能再点 ✓ 这就是旧流程那条"值还在"的要求 ✓）
              // ⭐ 2026-10-16 A2a（接线）：档位改用**自动定出来的那一档**（`effectivePaymentStatus`）——
              //   旧档位（请求体那个）**不再是判据**，这里也不该再把它带回去（带回去只会误导下一屏）。
              paymentStatus: effectivePaymentStatus,
              paidAmount: pendingPaidAmount,
              // ⭐ 券那一刀：带回去的是**解析后**那一份（券行她本来就没填金额 ⇒ 只是把这一行的
              //    **真实金额（平台结算款）**显示出来 ✓ 既不是替她改数、也不是藏起来 ✗）。
              paymentRows: paidPayments,
              // ⭐ 400 = "她能改"的那一类（与既有口径一致 ✓ 旧流程这条也是 400 ✓ 不放宽 ✗）
              status: 400,
            });
  };

  const sendPaymentStep = async (res, req, opts = {}) => {
    // ⭐ 她看到的这一页 = 这条日志记的（**在发页面之前**打 ⇒ 两件事不会分家 ✓）
    logRendered(req, {
      page: 'pay',
      trigger: String(opts.renderedTrigger || 'payment_step'),
      number: String(scanTargetOf(req)?.value || ''),
    });
    const target = backTargetFor(req, decodeURIComponent(String(req.params.recordId || '')));
    // ⚠️ 默认 200 ✓；⭐ 结算没过那一次要 **400**（"她能改"的那一类 ⇒ 与既有口径一致 ✓ 旧行为也是 400 ✓）
    const status = Number(opts.status) === 400 ? 400 : 200;
    // 资金页要知道哪些收款方式是券 ⇒ 券行金额不 required（后端仍按平台结算款覆盖）。
    const voucherDetails = await voucherPayments.voucherMethodDetails().catch(() => []);
    const voucherMethods = voucherDetails.map((item) => item.name);
    return sendHtml(res, status, renderSalePaymentStepPage({
      write: step2WriteOf({ ...opts, voucherMethods, voucherDetails }),
      // ⚠️ **不编**：还没建单时它是空串 ✓（她在资金页阶段本来就没有单号 ✓）
      orderNo: String(opts.orderNo || ''),
      config,
      basePath: req.baseUrl,
      postAction: postActionFor(target, opts.realm || 'sales'),
      submitKey: String(opts.submitKey || ''),
      count: Number(opts.count) || 0,
      reused: Boolean(opts.reused),
      salesEntryRecordId: String(opts.salesEntryRecordId || ''),
      // ⭐ 结算没过时那一句人话（原地重渲染资金页 ✓）
      notice: String(opts.notice || ''),
      // ⭐ 2026-10-17 E：**总金额**（她逐字要的）——调用方给；拿不到就不渲染那一行（不编 ✓）
      totalAmountText: String(opts.totalAmountText || ''),
    }));
  };
  // ⚠️ 写服务**只为 POST 与"本单还有几双"服务**；`GET` 的库存表一个字都不依赖它。
  //    用例可以注入一个假的（`options.writeService`），`false` = 这一版不挂写入口。
  // ⭐⭐ 2026-10-16（退货「出图发群」接线 · 本卡）：把**采购退货的出图链路**装配上 ——
  //   原来这里是 `{ gateway, config }`，**没有人传** `purchaseReturnOptions`
  //   ⇒ 写链路的 `webhooks` 恒为空 ⇒ 退货**永远** `no_image_pipeline`（线上真缺陷，见
  //   `services/purchaseReturnImageWiring.js` 的文件头：改前逐字 → 改后逐字 → 依据）。
  //   ⚠️ **它惰性构造**（真正提交退货时才 `new`）⇒ 启动 / 建 router 这一层零副作用 ✓；
  //   ⚠️ 用例想注入假出图 / 假 IM ⇒ `options.purchaseReturnImage`（与 `options.writeService` /
  //     `options.multiItemWire` 同一种注入法 ✓）。
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({
      gateway,
      config: writeConfig,
      purchaseReturnOptions: resolvePurchaseReturnImageOptions({
        gateway,
        config: writeConfig.purchaseReturn && writeConfig.purchaseReturn.imageDelivery,
        overrides: options.purchaseReturnImage || {},
      }),
    }))
    : null;
  const salesRuntime = createSalesAsyncRuntime({ gateway, writeService, config: writeConfig, options, logError });
  const salesAsync = salesRuntime.worker;
  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 「一单多货品」**路由半**（task-59）
  //     与渲染半那份（模块级 `MULTI_ITEM_ORDER`）**同一个 env 源**，两边不会漂 ✓。
  // ══════════════════════════════════════════════════════════════════════════
  const multiItemOrderConfig = resolveMultiItemOrderConfig();
  // 拆分第 3 刀：多货品暂存的读/写/清搬到 `./sessionFlow.js`（容器仍是引擎同一份会话）。
  const { multiItemPendingKey, readMultiItemPending, writeMultiItemPending, clearMultiItemPending } =
    createMultiItemPendingOf({ writeService, multiItemOrderConfig });
  // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：加货 / 删除那两颗 submit 的**字段名 / 动作名**。
  //   🔴 **缺省 = `null` ⇒ 渲染层照旧是今天那颗 `<a href="?add=1">`** ⇒ **一个字都不变** ✓
  //     （既有判据 `multiItemOrderRender.test.js:73` / `multiItemOrderReturnTrim.test.js:166` 原样绿 ✓）。
  //   ⚠️ 只有**本文件真的把那个 POST 接住之后**才把它交给渲染层 —— 否则她点一下按钮会把这一单
  //     直接提交走 ✗（比现在"点了没反应"**更糟**）⇒ 门是**显式**的，不是"渲染层自己猜" ✓。
  //   🔴 **默认关**（`config/multiItemOrder.js` 的 `addWireEnabled`，缺省 `false`）⇒ 页面上仍是
  //     今天那颗 `<a href="?add=1">` ⇒ 既有一切逐字不变 ✓（她真机验证过再把那个开关打开 ✓）。
  //   ⚠️ 用例可以注入一份假的（`options.multiItemWire`）—— 与 `options.writeService` 同一种注入法 ✓。
  const multiItemWire = options.multiItemWire !== undefined
    ? options.multiItemWire
    : (multiItemOrderConfig.addWireEnabled === true ? multiItemOrderConfig.wire : null);
  /** 会话暂存那一条链的名字（`replenish` / `return`；认不出的领域 ⇒ `''` 不猜 ✗）。 */
  const multiItemChainOf = (realm) => {
    const safe = resolveRealm(realm);
    if (safe === 'replenish' || safe === PURCHASE_RETURN_REALM) return safe;
    return '';
  };

  // ⭐⭐ 2026-10-16（task-61 · ②「领域内扫一扫」）
  //   · **开关缺省关**（`config/realmScan.js`）⇒ 关着时：不发脚本、不发配置块、
  //     签名端点也不回可用的签名 ⇒ **页面与今天逐字节一致** ✓（`AC-ML5`）；
  //   · 开着时：加货成功 303 回本页会带 `?scan=1` ⇒ 本页内联那一段（**复用既有那一段脚本** ✓
  //     不新增第二段 ✗）去调**飞书原生扫一扫** ⇒ 扫到的那件带 `?from=<本领域>` 落回来 ✓。
  //   ⚠️ 用例可以注入一份假配置 / 假签名服务（`options.realmScan` / `options.larkJsapi` ✓
  //     —— 与 `options.multiItemWire` 同一种注入法）。
  // ══════════════════════════════════════════════════════════════════════════
  const realmScanConfig = options.realmScan !== undefined ? options.realmScan : REALM_SCAN;
  let larkJsapi = options.larkJsapi || null;
  const resolveLarkJsapi = () => {
    if (!larkJsapi) larkJsapi = createLarkJsapiService();
    return larkJsapi;
  };
  /**
   * 这一页的领域**现在**该不该接着扫（`AC-ML3` / `AC-ML5` 的判据就在这一个函数里）。
   * 三条都要满足：① 开关开着 ② 这个领域配了链 ③ URL 上**明确**带了那个触发参数。
   * ③ 是刻意的：**页面一加载就弹相机**（她没点过、或刷新一下又弹）是最糟的那种"乱跳" ✗。
   */
  const realmScanActive = (realm) => realmScanConfig?.enabled === true
    && Boolean(realmScanConfig.realms && realmScanConfig.realms[realm]);
  const realmScanTriggered = (req, realm) => realmScanActive(realm)
    && String(req.query?.[realmScanConfig.triggerQueryKey] || '') === String(realmScanConfig.triggerQueryValue);
  /**
   * 这一页要给"扫完那件落回**本领域**"的那几样（**落点由客户端按扫到的那一串现算** ✓
   *   —— 「扫到的是哪一件」只有扫完那一刻才知道，服务端在这里**不可能**先算出来 ✗）。
   *
   * 🔴 只给**参数**、不给结果：`realmQueryKey`（`from` ✓ 与 `resolveRealm` 同一个键）、
   *   `recordBasePath`（扫到 id 时拼路径 ✓ 同一个真源）、`origin`（拼同源地址 ✓）＋ 文案与超时。
   */
  const realmScanPageConfig = (req, realm) => {
    if (!realmScanTriggered(req, realm)) return null;
    const origin = `${req.protocol}://${req.get('host') || ''}`;
    const signaturePath = mountedPathOf(req, realmScanConfig.signaturePath);
    return {
      realm,
      origin,
      // ⭐ 2026-10-17（假配置接线）：A 套真正读登记表的两个行为参数
      //   · returnsToRealm=false ⇒ 扫完不追加/回跳不带 `from=<领域>`
      //   · keepDraft=false     ⇒ 扫完回来先清旧草稿（"不带之前的数据"）
      returnsToRealm: realmEntryParams(realm, realmScanConfig).returnsToRealm !== false,
      keepDraft: realmEntryParams(realm, realmScanConfig).keepDraft !== false,
      appendRealm: realmEntryParams(realm, realmScanConfig).returnsToRealm !== false,
      realmQueryKey: realmScanConfig.realmQueryKey,
      recordBasePath: realmScanConfig.recordBasePath,
      maxScannedLength: realmScanConfig.maxScannedLength,
      scanNow: true,
      texts: realmScanConfig.texts,
      signaturePath,
      sdkTimeoutMs: realmScanConfig.sdkTimeoutMs,
      scanTimeoutMs: realmScanConfig.scanTimeoutMs,
      // 只读上报也挂在本 router 下（复用同一道身份闸门 ✓ 不新开一个入口 ✗）
      reportPath: signaturePath.replace(/[^/]+$/, 'scan-report'),
    };
  };
  /**
   * ⭐⭐ 2026-10-16 21:1x（本卡 ·「**销售也弹扫码框**」）：
   *   **加货成功之后**那一发 303 回跳要不要**带上触发参数**（`?scan=1` ✓）。
   *
   * 🔴 **只有这一处实现**（两个调用点共用同一份 ✓ 不写第二套 ✗）：
   *   · **补货 / 退货** —— 多货品那一支里那颗「＋ 再加一个货品」（`isMultiItemAdd` ⇒ 见下面 `addBackPathFor`）；
   *   · **销售** —— 同一张表单里那颗 `action=add_line`（草稿非空时它的文案就是「＋ 再加一个货品」✓）。
   *
   * 判据（与改动前**一字不差**）：① 开关开着 ② **这一页的领域**配了链 ③ 有触发键 ——
   *   缺任何一条 ⇒ **原样返回**（`page` 一个字不动）⇒ 开关关着 / 领域没配链时，回跳与今天**逐字节相同** ✓。
   *   🔴 ③ 是刻意的：回来的那一页**只有**看见这个参数才去调扫一扫
   *     ⇒ 「页面一加载就弹相机」那种坑从这里堵死 ✗（`AC-SR4` / `AC-ML5`）。
   *
   * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
   *   改前逐字：这个函数**长在多货品那一支里面**、签名是 `addBackPath(realmId)`
   *     （它自己调 `backPathOf(realmId)` 现算页路径）⇒ **只有补货 / 退货够得着它** ✗；
   *   改后逐字：**提到工厂这一层**、签名改成 `addBackPath(page, realmId)`
   *     （页路径由调用方按**它自己那条链**的既有口径拼好再传进来 ⇒ 拼法与改前**逐字节相同** ✓）；
   *   依据 = 业务负责人 2026-10-16 21:1x 弹窗拍板「**要，销售也弹扫码框**」✓。
   *   ⚠️ **不是新行为、不是放宽**：两个调用点拼出来的 Location 与改前逐字节相同（`AC-SR6` 逐字钉着 ✓）。
   *
   * @param {string} page 已经拼好的回跳地址（含领域与既有查询串）
   * @param {string} realmId 这一页的领域 id（判据②要它）
   * @returns {string} 需要接着扫时 = `page` ＋ 触发参数；否则 = `page`（原样 ✓）
   */
  /** 去掉回跳地址里的领域键（`from=<realm>`）—— `returnsToRealm:false` 时用。 */
  const withoutRealmQuery = (page, key) => {
    const text = String(page || '');
    const wanted = String(key || '').trim();
    if (!text || !wanted) return text;
    const hashAt = text.indexOf('#');
    const head = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const hash = hashAt >= 0 ? text.slice(hashAt) : '';
    const queryAt = head.indexOf('?');
    if (queryAt < 0) return text;
    const base = head.slice(0, queryAt);
    const pairs = head.slice(queryAt + 1).split('&')
      .filter((part) => part && part.split('=')[0] !== wanted);
    return pairs.length ? `${base}?${pairs.join('&')}${hash}` : `${base}${hash}`;
  };
  const addBackPath = (page, realmId) => {
    if (!realmScanActive(realmId)) return page;
    const key = String(realmScanConfig.triggerQueryKey || '');
    if (!key) return page;
    const entry = realmEntryParams(realmId, realmScanConfig);
    const target0 = entry.returnsToRealm === false
      ? withoutRealmQuery(page, realmScanConfig.realmQueryKey || 'from')
      : page;
    const target = /(?:[?&])added=/.test(target0) ? target0 : `${target0}${target0.includes('?') ? '&' : '?'}added=1`;
    return `${target}${target.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(String(realmScanConfig.triggerQueryValue || ''))}`;
  };
  // 用例可以注入一个假引擎（`options.multiItemOrder`）—— 与 `options.writeService` 同一种注入法 ✓
  let multiItemOrderEngine = options.multiItemOrder || null;
  /**
   * 懒建引擎（**只有真的要提交多货品单时才建** ✗ N=1 那条路一次都不建 ✓）。
   * @returns {object|null} `null` = 这条路现在走不了 ⇒ 调用方**给人话 + 零写入**（绝不静默只写第一件 ✗）
   */
  const multiItemOrder = () => {
    if (multiItemOrderEngine) return multiItemOrderEngine;
    if (!writeService || typeof writeService.multiItemWriters !== 'function') return null;
    // 🔴 2026-10-29：**没有开关**了（她：「就应该支持一单多货，不应该有配置按钮」）⇒ 不再有这道门 ✓
    // 🔴 写入件**只经** `writeService.multiItemWriters()`（同一批既有写入件的引用相等 ✓）——
    //   本文件里**不出现任何写链路服务名**（既有源码哨兵 `RT5` 钉着，不放宽 ✗）。
    multiItemOrderEngine = createMultiItemOrderService({
      sessions: writeService.sessions,
      config: multiItemOrderConfig,
      writers: writeService.multiItemWriters(),
    });
    return multiItemOrderEngine;
  };

  /**
   * ⭐ 退货那条链的**整单金额**进草稿（形状 = 设计 §4.3 的 `order_amount`）。
   *
   * ⚠️ 为什么走 `sessions.store`：引擎的公开 API 里**没有"设金额"这一口**
   *   （只有 `openDraft` / `addItem` / `setEntries` / `removeItem` / `submitDraft`），
   *   而 `services/multiItemOrderService.js` **不在本刀写作用域** ⇒ 这里按**设计里那份草稿形状**、
   *   经**同一个会话 store** 写这一个字段（容器名取自 `config/multiItemOrder.js` ✓ **不写死** ✗）。
   *   `store.update` 是**同 id 串行**的读-改-写 ⇒ 不会把引擎刚写进去的 `items` 覆盖掉 ✓。
   */
  const setDraftOrderAmount = async (openId, orderKey, amount) => {
    if (!writeService || !writeService.sessions) return;
    const { store, idOf } = writeService.sessions;
    if (!store || typeof store.update !== 'function' || typeof idOf !== 'function') return;
    const ordersField = multiItemOrderConfig.session.ordersField;
    await store.update(idOf(openId), (session) => {
      const orders = { ...((session || {})[ordersField] || {}) };
      const draft = orders[orderKey];
      if (draft) orders[orderKey] = { ...draft, order_amount: String(amount || '').trim() };
      return { salesAsync, [ordersField]: orders };
    });
  };

  /**
   * ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：草稿里"**已经加进来的那几个货品**"的读写。
   *
   * 为什么需要它（前一位执行者验证过的结论 ②③）：
   *   · 她点「＋ 再加一个货品」时必须走 **POST**（GET 链接带不走她刚填的尺码/数量 ✗）
   *     ⇒ 那个 POST 要**存下当前这一件**，再 **303 回本页**（PRG ⇒ 刷新不重复加 ✓）；
   *   · 回来渲染时，**已加的那几件**要回到页面上 ⇒ 只有**服务端**记得住（页面零 JS ⇒ 浏览器里没处放 ✗）。
   *
   * 落点：**引擎那同一份会话**（`config.session.ordersField` 下、按链分段的一个小块 ✓）——
   *   **不新建存储** ✗、也不碰业务表 ✗；⚠️ 它是"**还没开放提交的**这一单"的暂存，
   *   与引擎那份"已提交的草稿"**同一个容器、不同的键**（`:*:pending`）⇒ 两者不会互相覆盖 ✓。
   *
   * 🔴 **必须排除当前这一件**：`view.multi_items`（喂给渲染层、进 hidden 字段的那一份）
   *   只放**已加的** —— 当前这一件是表单里那个**首件** ✓。否则提交时 `addItem` 会拿草稿里
   *   那份旧 `entries` 覆盖她**刚填的** = **静默丢值** ✗（她最恨的那种假成功）。
   */
  /**
   * ⭐ 2026-10-17（假配置接线）：扫完回来若 `keepDraft=false` ⇒ **先清掉这一领域的旧草稿**
   *   （她定义的"不带之前的数据"）。默认 `true`（三处都带草稿）⇒ 线上行为与改前逐字节相同 ✓。
   *   🔴 失败**不影响页面渲染**（只记 warn）—— 清草稿是"体验修正"，不是业务写入。
   */

  /**
   * ⭐⭐ 「一单多货品」**提交**（**只有分组 > 1 才会进来**）—— 拒单 ⇒ 人话 + **零写入** ✓。
   *
   * 🔴 **成功页复用今天那条形状与文案**（`sendSuccess` + `successReturnFields` ✓）——
   *   本文件**不发明新文案** ✗，也**不承诺**这一刻还没有的东西（批次号 / 明细数由后台写出）✗。
   */

  /**
   * ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线 · 业务负责人**逐字**）：
   *   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
   *   ⇒ 补货 / 退货：**先把成功页回给她**（200）⇒ 「**后台那一跑**」再写库 ✓
   *
   * 🔴 三条红线都在这一处落地（判据见 `test/purchaseAsyncAcceptance.test.js` 的 AC-ASY1..4）：
   *   ① **校验仍当场同步拦** ✗ —— **金额（空 / 非数字）** 与 **"这一款认不出"** 都在**排后台之前**
   *      （本文件上面的 `purchaseAmount*Page` / `notFoundPage` ✓ AC-ASY2 判的就是这两道）。
   *      ⚠️ **已知取舍**（如实写在这里，别当它不存在 ✗）：写层自己的**输入校验**
   *      （尺码 / 数量 / 空单 —— `services/scanWriteService.js` 里那几条）**跟着写库那一步进了后台**
   *      —— 因为本刀**一个字都不许改那个 service**（余量 0 硬红线 ✗），而校验与写库在它里面
   *      是同一个函数。⇒ 真发生"她填错了"时：她**已拿到成功页**，而失败会以
   *      `config/scanWrite.js` 的 `purchaseBackgroundFailed` 那条 warn ＋ 会话 `last_error`
   *      **如实留痕**（**不静默** ✗）。
   *      要把它挪回同步 ⇒ **必须**把那个函数拆成"先受理 / 后台续写"两半（= 动 `scanWriteService.js`）
   *      ⇒ **超出本刀授权**，留给 Lead 决策（见 PR 说明）。
   *   ② **后台失败绝不假装成功** ✗ —— 共用件记一条 warn ＋ 调 `markFailed`（落会话 `last_error`
   *      ⇒ **可查**；幂等键**不轮换** ⇒ 她再点一次 = 同一把键**重试** ✓）。
   *   ③ **`submitKey` 原样透传** ✗ —— 幂等责任在写层（本文件一个字不拼、不加后缀 ✓）。
   */
  // 首访那把旧键的采纳（补货 / 退货第一次带 token 提交时用；实现见 `./pageToken`）
  const adoptFirstVisitSubmitKey = createFirstVisitKeyAdopter({ getSessions: () => writeService?.sessions });

  const purchaseBackground = options.purchaseBackground || createPurchaseWriteBackgroundService({
    // #948：统一异步任务（重试 / 失败发运营群）走**注入**的适配器；用例注入 null ⇒ 逐字回落到单次
    jobRunner: options.purchaseJobRunner !== undefined
      ? options.purchaseJobRunner
      : createAsyncJobPurchaseRunner({
        asyncJob: options.asyncJobs !== undefined ? options.asyncJobs : getAsyncJobService(),
      }),
    // 🔴 `runRest` = **既有写入口**（不新开写库路径 ✗）：补货 / 退货各自的写服务方法。
    //    ⚠️ **实参形状与改前那次 `await writeService.…(…)` 逐字同形**（键名一个不改 ✗）——
    //      判据 `test/multiItemOrderRoute.test.js` 的 **RT2-static** 逐字钉着这张参数清单
    //      （task-46「N=1 与老路径逐字等价」的护栏 ✓ 本刀**不放宽它** ✗）。
    runRest: async ({ chain, requestId, submitKey, restInput = {}, context = {} }) => {
      // ⭐⭐ 2026-10-18（task-2）：会话键从 `context` 来（旧页面没有这个键 ⇒ '' ⇒ 写服务回落 openId ✓）。
      const sessionKey = String(context.sessionKey || '').trim();
      await adoptFirstVisitSubmitKey({
        chain, openId: restInput.openId, sessionKey, submitKey,
      });
      if (!writeService) {
        return { ok: false, code: 'write_disabled', message: writeConfig.texts.writeDisabledBody };
      }
      if (chain === 'replenish') {
        return writeService.submitReplenish({
          openId: restInput.openId,
          requestId,
          submitKey,
          productRecordId: restInput.productRecordId,
          number: restInput.number,
          entries: restInput.entries,
          // ⚠️ 只在有 token 时出现这个键：旧页面的入参形状**逐字不变**（RT2-static 也钉着这一点 ✓）
          ...(sessionKey ? { sessionKey } : {}),
        });
      }
      if (chain === 'purchase_return') {
        return writeService.submitPurchaseReturn({
          openId: restInput.openId,
          requestId,
          submitKey,
          productRecordId: restInput.productRecordId,
          number: restInput.number,
          orderAmount: restInput.orderAmount,
          entries: restInput.entries,
          // ⚠️ 同上：旧页面不带这个键（入参形状逐字不变 ✓）
          ...(sessionKey ? { sessionKey } : {}),
        });
      }
      return { ok: false, code: 'unknown_chain', message: String(chain || '') };
    },
    markFailed: async ({ chain, context = {}, result, error }) => {
      // ⭐⭐ 2026-10-18（task-2）：有 per-page token 时失败要落到**这一页自己的**会话；
      //   旧页面（没有 sessionKey）⇒ 仍是 openId，逐字不变 ✓
      const openId = String(context.sessionKey || context.openId || '');
      const message = String(result?.message || error?.message || '').trim();
      try {
        const sessions = writeService && writeService.sessions;
        if (chain === 'replenish' && typeof sessions?.markReplenishFailed === 'function') {
          await sessions.markReplenishFailed(openId, message);
        } else if (chain === 'purchase_return' && typeof sessions?.markPurchaseReturnFailed === 'function') {
          await sessions.markPurchaseReturnFailed(openId, message);
        }
      } catch (markError) {
        logWarn(writeConfig.events.purchaseBackgroundMarkFailed, {
          request_id: context.requestId, chain,
          error: String(markError?.message || markError).slice(0, 200),
        });
      }
    },
    purchaseAsync: writeConfig.purchaseAsync || {},
    config: {
      events: {
        restTiming: writeConfig.events.purchaseBackgroundTiming,
        restFailed: writeConfig.events.purchaseBackgroundFailed,
        markFailedError: writeConfig.events.purchaseBackgroundMarkFailed,
      },
      // ⚠️ 这里**刻意不注入** `timing`：后台件的默认阶段名就是 `background`（与
      //   `SCAN_SALE_TIMING_PHASE_BACKGROUND` 的缺省一致 ✓）—— 而本文件有一条**既有哨兵**
      //   （`test/salesAsyncWrite.test.js` 的 AC-AS11b：「路由不许把后台句柄当数据读」，
      //   它按"点 + background"这种属性访问扫源码）⇒ **不放宽那条哨兵** ✗、也不写那种写法 ✓。
    },
  });
  // 拆分第 3 刀：排程也搬进 `./sessionFlow.js`（同一份 purchaseBackground 注入；幂等键原样透传）。
  const { schedulePurchaseWrite } = createPurchaseSchedulerOf({ purchaseBackground });
  /**
   * ⭐⭐ 2026-10-12：**未到货批次**（要列出来的那几条）—— **全仓只有这一处**读它。
   *
   * 两个调用方：① **有编号的领域页**（`?from=accept`，她扫开某款那一页）；
   *              ② **落地页** `GET /accept`（无 batch，她点【验收】进来的第一屏）。
   * ⚠️ **同一个 catch**：读表失败 ⇒ 只记一条 warn + 返回 `{ok:false, batches:[]}`
   *    ⇒ 页面照旧 **200**、走手输兜底（她的"别卡住她"）。
   */

  /**
   * ⭐⭐ 2026-10-13 **口径变更**（她的原话，逐字）：
   *   「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，**应该就跟这一单没关系了**，
   *     除非我是选"**再加一双**"呀」
   *  ⇒ `/s`（**不带编号**）= **销售领域入口页**（= 她说的"销售首页" ✓）：
   *    · 提交成功后回跳这里（回跳 URL 带 `?done=<单号>` ⇒ 顶部"上一单已提交（单号）" ✓ 无状态）
   *    · 手输编号 ⇒ **302 到 `/s/<编号>`**（兜底 ✓）
   *  ⚠️ 改前这里是"缺编号 ⇒ 400 这个链接不对" ✗；**改后 `GET /s` 是有意义的入口** ✓
   *     （**认不出的编号**仍走原来的 400 人话页 ✓ 那条没动 ✗）
   */

  return { salesAsync, openIdOf, sessionIdOf, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, SUBMIT_TOAST, addBackPath, adoptFirstVisitSubmitKey, badNumberPage, candidatePaymentMethods, clearMultiItemPending, config, configuredPaymentMethods, gateway, larkJsapi, logFunnelPage, logRendered, multiItemChainOf, multiItemOrder, multiItemOrderConfig, multiItemOrderEngine, multiItemPendingKey, multiItemWire, notFoundPage, paymentMethodsService, purchaseAmountInvalidPage, purchaseAmountMissingPage, purchaseBackground, purchaseEntryInvalidPage, readMultiItemPending, realmScanActive, realmScanConfig, realmScanPageConfig, realmScanTriggered, renderContext, renderMessage, renderScan, resolveLarkJsapi, respondFailure, respondSettlementBlock, respondWriteFailure, responses, salesRuntime, schedulePurchaseWrite, sendHuman, sendPaymentStep, service, setDraftOrderAmount, step2WriteOf, unknownActionFailure, voucherPayments, withoutRealmQuery, writeConfig, writeMultiItemPending, writeService };
};

module.exports = { createScanPageSetup };
