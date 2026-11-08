'use strict';

/** 扫码页路由分组（P4-2c/d 从 routes.js 搬出）。 */
const installScanPageActionRoutes = ({ router, ctx }) => {
  const {
    invalidateInventorySnapshot, submitMultiItemOrder, buildWriteContext,
    salesAsync, DEFAULT_REALM, LABEL_PRINT_QUEUE, PURCHASE_RETURN_REALM, SalesFollowupService, addBackPath,
    asList, backTargetFor, badNumberPage, candidatePaymentMethods, config, fillWriteText, handleAddLineOf,
    handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit, handlePrintLabelOf,
    handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, isDataNotReady, isRecordBase, logError,
    logInfo, logWarn, lookupInputOf, markRealmUsed, markTapCode, mergeFirstItemEntries, multiItemOrderConfig,
    multiItemWire, notFoundPage, openIdOf, options, pageSessionKey, parseMultiItemGroups, parsePaymentRows,
    parseReplenishEntries, parseReturnEntries, postActionFor, purchaseAmountInvalid,
    purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage,
    purchaseEntryViolation, purchaseWriteDisabledError, readMultiItemPending, realmOfAction, renderScan,
    resolveLabelPrintQueue, resolveRealm, respondFailure, respondSettlementBlock, respondWriteFailure,
    salesRuntime, scanTargetOf, schedulePurchaseWrite, sellableSizeTexts, sendHuman, sendPaymentStep,
    service, uiTapResultMiddleware, unknownActionFailure, voucherPayments, withPageSession, writeConfig,
    writeMultiItemPending, writeService, ROUTE_PATTERNS,
  } = ctx;

  router.post(ROUTE_PATTERNS, uiTapResultMiddleware('scan'), async (req, res) => {
    const requestId = req.requestId;
    const body = req.body || {};
    const fields = writeConfig.fields;
    const actions = writeConfig.actions;
    let action = String(body[fields.action] || '');
    // ⭐⭐ 2026-10-16（task-59 · 加/删货那一半）：那两颗按钮**各自带自己的 name**（不是 `action` ✓）——
    //   所以下面那条"没 action 就猜成销售提交"的兜底**必须先把它们排除** ✗，
    //   否则她点「＋ 再加一个货品」会被当成**销售提交**（`submit_order`）✗✗。
    //   ⚠️ 字段名只从**工厂里那一份** `multiItemWire` 取（渲染与识别**同一个源** ⇒ 不会漂 ✓）。
    //   ⚠️ 只在**接线开着**时才认（缺省那两个字段名在页面上根本不存在 ⇒ 一个字都不影响既有逻辑 ✓）。
    const wireAddAction = String(multiItemWire?.addAction || '');
    const wireRemoveField = String(multiItemWire?.removeField || '');
    const isMultiItemAdd = Boolean(wireAddAction) && body[wireAddAction] !== undefined;
    const isMultiItemRemove = Boolean(wireRemoveField) && body[wireRemoveField] !== undefined;
    // ⭐⭐ 2026-10-12（她真机 400 / 1ms，`scan.write.unknown_action` 的 `action_kind=missing`、
    //   但 `body_keys` 里**该带的都带了**：submit_key / size / amount / gift / payment_* ✗）：
    //   ⇒ 那是"**没有提交者的提交**"（webview 里 JS/回车/隐式提交 ⇒ 浏览器**不送**按钮的 name/value ✗）。
    //   窄化兜底：**只有**在"没 action + 带幂等键 + 像销售提交"时，认作 `submitOrder`（并留痕 ✓）。
    //   ⚠️ 不碰标记（零哨兵风险 ✓）；只在这一页（编号页 POST）✓。
    if (!action && !isMultiItemAdd && !isMultiItemRemove
      && String(body[fields.submitKey] || '').trim()
      && (body[fields.size] !== undefined || body[fields.amount] !== undefined)) {
      action = actions.submitOrder;
      logWarn('scan.write.action_inferred', {
        request_id: requestId, reason: 'missing_action_default_submit',
        body_keys: Object.keys(body), path: String(req.originalUrl || '').split('?')[0],
      });
    }
    const openId = openIdOf(req);
    // 「回跳到哪一块」= 这一页的领域（认不出来一律回落缺省；两个入口同一条口径）。
    const realm = resolveRealm(req.query?.from);
    // ⭐ 2026-10-18（task-2）请求级包装（**不改 handler 源码**）：注入 sessionKey / context / 领域记忆。
    const pageToken = req?.scanPageTokenFromCookie === true ? String(req?.scanPageToken || '').trim() : '';
    const sessionId = pageSessionKey(openId, pageToken);
    const scopedWriteService = withPageSession(writeService, pageToken);
    const schedulePurchaseWriteForPage = (args) => (pageToken
      ? schedulePurchaseWrite({ ...args, context: { ...(args.context || {}), sessionKey: sessionId } })
      : schedulePurchaseWrite(args));
    const markRealmUsedForPage = (who, realmId) => markRealmUsed(pageSessionKey(who, pageToken), realmId);

    // ══════════════════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）
    //   · **加货** = 同一张表单里的第二颗 submit ⇒ 它**带着她刚填的尺码/数量**（`sizes` / `qty_*`
    //     或 `return_sizes` / `return_qty_*`）一起 POST 过来 ✓ —— 这正是"值不丢"的物理保证
    //     （改前那颗 `<a href="…?add=1">` 是 GET：**天生带不走**表单字段 ✗）。
    //   · 这里把它**存进草稿**（`readMultiItemPending` / `writeMultiItemPending`）再 **303 回本页**
    //     （PRG：刷新不重复加 ✓；回来那一页由 GET 把"已加的货品"渲出来 ✓）。
    //   · **删除** = 列表行里那颗 submit（`name=<删货字段> value=<该件 record_id>`）⇒ 从草稿里摘掉它 ✓。
    //   🔴 **只认草稿里的那一份**，**不查表、不写业务表**（这一半一个字节都不落业务表 ✓）。
    //   🔴 N=1 那条老路径**一个字都不变**：这里只吃「加货 / 删货」那两个动作，别的一个都不碰 ✓。
    //   ⚠️ `isMultiItemAdd` / `isMultiItemRemove` / 两个字段名**在上面那个兜底之前就取好了** ✓
    //     （不然她点"加"会被当成销售提交 ✗）。
    // ══════════════════════════════════════════════════════════════════════════
    if (isMultiItemAdd || isMultiItemRemove) {
      // ⚠️ 回跳口径与页面上的表单 `action` **同一处**（`:` 下面别的分支用的也是它 ✓ 不另拼一份 ✗）
      const backPathOf = (realmId) => postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.recordId || ''))), realmId,
      );
      // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**加货成功之后**，这一发回跳带上触发参数
      //   ⇒ 回来的那一页（**同一个领域** ✓）才去调飞书扫一扫 ⇒ 扫到的那件带 `?from=<领域>` 落回来 ✓。
      //   🔴 **只加在"加货"上，不加在"删除"上**（删完不该弹相机 ✗）；
      //   🔴 **只在这一页的领域配了链、且开关开着时加**（关着 ⇒ 回跳与今天逐字一致 ✓ `AC-ML5`）。
      //   ⭐⭐ 2026-10-16 21:1x（本卡）：实现**提到工厂那一层**（`addBackPath(page, realmId)` ✓）
      //     —— 因为**销售**那条 303 也要用**同一份**（不写第二套 ✗）。这里只负责按**既有口径**
      //     算出这一页的页路径（`backPathOf` ✓ 逐字没变 ✗），再交给它。
      const addBackPathFor = (realmId) => addBackPath(backPathOf(realmId), realmId);
      const backPath = () => backPathOf(realm);
      // 认不出是哪条链（不是补货 / 退货那两块）⇒ 与既有的"认不出的动作"同一条口径：给它一句人话 ✓
      const draftChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (!draftChain) {
        markTapCode(res, 'multi_item_chain_unknown');
        return respondWriteFailure(res, {
          code: 'multi_item_chain_unknown', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      if (!writeService) {
        markTapCode(res, 'write_disabled');
        return respondWriteFailure(res, {
          code: 'write_disabled', message: writeConfig.texts.writeDisabledBody,
        }, requestId);
      }
      const chainKind = draftChain === 'replenish' ? 'replenish' : 'purchase_return';
      // 「哪一件」的身份口径**与引擎的 `addItem` / `removeItem` 同一套**（`product_record_id` 优先，
      //   回落 `number` / `item_no` ✓）—— 两边不一致的话，删除会摘不掉那一件 ✗。
      const keyOfItem = (item) => String(
        (item && (item.product_record_id || item.productRecordId || item.number || item.item_no)) || '',
      ).trim();
      const pending = await readMultiItemPending(sessionId, draftChain);
      if (isMultiItemRemove) {
        const removed = String(body[wireRemoveField] || '').trim();
        const left = pending.items.filter((item) => keyOfItem(item) !== removed);
        await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items: left });
        return res.redirect(303, backPath());
      }
      // ── 加货：本次表单的尺码/数量（**与提交那条路同一个解析器、同一份校验** ✓ 不手抄 if-else ✗）
      const entries = draftChain === 'replenish'
        ? parseReplenishEntries(body, fields, writeConfig)
        : parseReturnEntries(body, fields, writeConfig);
      const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
      if (!groups.length) {
        // 表单里没有那个首件（手改表单 / 老页面）⇒ 不猜、不存空件 ⇒ 与人话页（400）✓
        markTapCode(res, 'multi_item_no_item');
        return respondWriteFailure(res, {
          code: 'multi_item_no_item', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      // 🔴 她填错了 ⇒ **当场同步拦**（400 + 写层那一句人话 + **零写入**）—— 与提交那条路同一条口径 ✓
      const violation = purchaseEntryViolation({ chain: chainKind, entries });
      if (violation) return purchaseEntryInvalidPage(req, res, requestId, realm, violation);
      // 把"已经加进来的"与"刚加的这件"接上（同一货品 ⇒ 覆盖那一件 ✓ 与引擎的 `addItem` 同口径）
      const added = groups[0];
      const at = pending.items.findIndex((item) => keyOfItem(item) === keyOfItem(added));
      const items = pending.items.slice();
      if (at >= 0) items[at] = added; else items.push(added);
      await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items });
      // ⭐⭐ 2026-10-16（task-61 · ①「补充日志和埋点」）：**加货那一刻**的那一条
      //   —— 她当时问的是「扫了 B 但页面上没看到 A」：是**没存进去**、还是**存了没读出来** ✗✓
      //   ⇒ 这一条说"存进去了几件、存的是哪一件"；渲染那一条（`scan.multi_item.render`）说"读出来几件"。
      //   🔴 **纯 additive**：一个判定都不动（写完才打 ✓ 打日志失败也绝不影响她 ✗）；
      //   🔴 键名**全从配置取**（`multiItemOrderConfig.logFields` ✓ 逻辑里不写死 ✗）；
      //   🔴 关联键按既有口径带（`request_id` / `open_id` / `order_key` ✓ **拿不到就不传** ✗）。
      {
        const log = multiItemOrderConfig.logFields || {};
        logInfo(log.addEvent || 'scan.multi_item.add', {
          request_id: requestId,
          open_id: openId,
          [log.chainKey || 'chain']: draftChain,
          [log.addedCountKey || 'added_count']: items.length,
          [log.productKey || 'product']: keyOfItem(added) || '',
          [log.entriesKey || 'entries']: (Array.isArray(added?.entries) ? added.entries : [])
            .map((entry) => ({ size: String(entry?.size || ''), quantity: String(entry?.quantity || '') })),
          [log.orderKeyKey || 'order_key']: String(pending.orderKey || ''),
        });
      }
      return res.redirect(303, addBackPathFor(realm));
    }

    // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】──────────────────────
    // 🔴 它**排在下面"扫码写入口关着 ⇒ 503"那道闸门之前**：打印这一款**不写任何业务表**
    //    （只把一条任务排进打印队列），所以与"销售/采购写入口开不开"是两件事。
    // ⚠️ 编号**只认 URL 里的那个**（表单里刻意不放编号字段）⇒ 手改表单也打不了别的款。
    // ⚠️ 页面上**零 JS**：这里就是一个原生表单的 POST，成功后 303 回本领域（PRG，
    //    刷新不会重复提交），状态由 GET 重新渲染。
      if (action === actions.printLabel) {
        return handlePrintLabelOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, sendHuman, notFoundPage, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, resolveLabelPrintQueue, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

    // ⭐ 2026-10-29：非销售 flow（售后换款式）的货品页提交到此为止（不跳资金页、零写入）
    if (handlePendingExchangeSubmit({ req, res, requestId, action, actions, realm, sendHuman, markTapCode, postActionFor, backTargetFor })) return;

    if (!writeService) {
      // ⭐ 埋点 P0 ②：原因码（写入口关着 —— 与"她填错了"分开，修法完全不同）
      markTapCode(res, 'write_disabled');
      return sendHuman(res, 503, {
        title: writeConfig.texts.writeDisabledTitle,
        body: writeConfig.texts.writeDisabledBody,
        requestId,
      });
    }
    try {
      // ── 加入本单 ────────────────────────────────────────────────────────────
      if (action === actions.addLine) {
        return handleAddLineOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, addBackPath, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        return handleClearDraftOf({
          req, res, requestId, body, fields, realm, action, openId, writeService: scopedWriteService, backTargetFor, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 第 2 步【提交整单付款】⇒ **走既有那条诚实钱路**（不做第二套账 ✗）─────────────
      //    `followup.addPayment(...)` = 工作台「补记收款」用的同一条链路（`routes/workbench.js:215` ✓）
      //    🔴 三条红线：① 只有**写成功**才说"已收" ✓ ② 没填 ⇒ 待补充（不是失败）✓
      //                ③ 幂等沿既有 `requestId`（**不自造** ✓）
      if (action === (config.paymentStep?.payAction || 'payment_pay')) {
        return handlePaymentPayOf({
          SalesFollowupService, asList, backTargetFor, body, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, realm, realmOfAction, req, requestId, res, respondSettlementBlock, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, service, voucherPayments, writeConfig, writeService: scopedWriteService, options, lookupInputOf, salesAsync,
        });
      }

      // ── 提交销售单 ──────────────────────────────────────────────────────────
      if (action === actions.submitOrder) {
        return handleSubmitOrderOf({
          asList, backTargetFor, body, buildWriteContext, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, lookupInputOf, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, postActionFor, realm, realmOfAction, renderScan, req, requestId, res, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, service, writeConfig, writeService: scopedWriteService, nextOrderNo: () => salesRuntime.orderNoCache.next(),
        });
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        return handleReplenishOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, parseReplenishEntries, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure,
        });
      }

      // ── ⭐ 采购退货（业务负责人 2026-10-11：「和"报货"逻辑一样，也走扫码」）────────
      //    与补货**同形**：同一个 POST 端点、同一套会话/幂等/失败口径；
      //    写库（批次行 + 退货明细 + 扣库存 + 出退货单图）全在既有构件里。
      if (action === actions.purchaseReturn) {
        return handlePurchaseReturnOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure, parseReturnEntries,
        });
      }

      // ⭐⭐ 2026-10-14：**所有动作分支都不匹配 ⇒ 照旧给人话**（`unknownActionFailure`）——
      //   ⚠️ 拆验收那几刀时，这个**通用兜底调用点**被连带摘掉过 ✗ ⇒ 症状：未知动作的 POST
      //      **永远没人应答** ⇒ 客户端 `fetch` 挂住 ≈301 秒 ✗（`test/scanPageWrite.test.js` 的 ⑨ 抓到 ✓）
      //   ⇒ 这里按 HEAD 的原样补回（**产品行为修复** ✓ 不是改测试绕开 ✗）
      return unknownActionFailure(req, res, requestId, action);
    } catch (error) {
      // 走到这里说明是**没预料到**的异常（写服务内部已把业务失败都收敛成人话结果）。
      if (isDataNotReady(error)) {
        res.set('Retry-After', '5');
        return sendHuman(res, 503, {
          title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
        });
      }
      return respondFailure(res, error, requestId);
    }
  });


};

module.exports = { installScanPageActionRoutes };
