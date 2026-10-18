'use strict';

/**
 * 扫码路由「响应 / 人话页面」helpers（深拆 P3b：从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 * 调用方注入配置/渲染/日志/回跳依赖；函数体逐字搬移。
 */

const createResponses = ({
  config, writeConfig, service, renderMessage, renderMinimalPage, sendHtml,
  logError, logWarn, isDataNotReady, DEFAULT_REALM, ENTRY_RULE_TEXTS, markTapCode,
  resolveRealm, scanTargetOf, backTargetFor, postActionFor,
}) => {
    const sendHuman = (res, status, payload) => {
      try {
        return sendHtml(res, status, renderMessage(payload, config));
      } catch (error) {
        logError(config.events.failed, {
          request_id: payload?.requestId, reason: 'message_render_failed', error: error.message,
        });
        return sendHtml(res, status, renderMinimalPage({
          title: payload?.title || config.texts.errorTitle,
          body: payload?.body || config.texts.errorBody,
          requestId: payload?.requestId,
        }));
      }
    };

    const badNumberPage = (res, status, requestId, number = '') => sendHuman(res, status, {
      title: config.texts.badNumberTitle,
      body: config.texts.badNumberBody,
      number,
      requestId,
    });

    const notFoundPage = (res, requestId, { number = '', fallback = null, realm = DEFAULT_REALM, target = null } = {}) => sendHuman(res, 404, {
      title: config.texts.notFoundTitle,
      body: config.texts.notFoundBody,
      number,
      requestId,
      retryHint: fallback?.tried
        ? (fallback.ambiguous ? config.texts.notFoundAmbiguousHint : config.texts.notFoundFallbackMissHint)
        : '',
      // ⭐ 只有"确实按兜底找过、还是没找到"时才给【再扫一次】那条回跳；
      //   `/r` 底下回跳要带**记录 ID**（不是编号）。
      backPath: fallback?.tried ? postActionFor(target || { mode: 'number', value: number }, realm) : '',
      backLabel: fallback?.tried ? config.texts.notFoundBackLabel : '',
    });

    const respondFailure = (res, error, requestId, timing = null) => {
      // ⭐⭐ 2026-10-12：**第三条出口**也要留痕 —— 她真机那次 400"周围一条日志都没有" ✗，
      //   所以**任何**没预料到的失败都带一份"这次提交带了哪些字段名 / action 是什么形态"（**只字段名** ✗）。
      //   ⚠️ 与 `unknownActionFailure` 同一套字段（便于一起 grep）✓
      logWarn(writeConfig.events.unknownWriteAction, {
        request_id: requestId,
        where: 'respondFailure',
        error: String(error?.message || error || '').slice(0, 200),
        method: 'n/a',
      });
      // ⭐ 失败也要看得出卡在哪一步（她：「一查日志就知道卡在哪一步」）——
      //    在发页面之前把已经量到的那几段打出去（`total_ms` 由 service 写、`render_ms` 为 0）。
      service.logTiming?.(timing, { requestId, found: false });
      if (error?.scanLimitExceeded) {
        // service 已经记过 limitExceeded；这里只负责给她一张人话页面（**不显示半张库存表**）。
        return sendHuman(res, 503, {
          title: config.texts.limitTitle, body: config.texts.limitBody, requestId,
        });
      }
      if (isDataNotReady(error)) {
        res.set('Retry-After', '5');
        return sendHuman(res, 503, {
          title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
        });
      }
      logError(config.events.failed, { request_id: requestId, error: error.message });
      return sendHuman(res, 500, {
        title: config.texts.errorTitle,
        body: config.texts.errorBody,
        requestId,
        retryHint: config.texts.retryHint,
      });
    };

    const unknownActionFailure = (req, res, requestId, actionRaw) => {
      const body = req.body || {};
      const raw = body[writeConfig.fields.action];
      const kind = raw === undefined ? 'missing' : (String(raw).trim() === '' ? 'blank' : 'unrecognized');
      logWarn(writeConfig.events.unknownWriteAction, {
        request_id: requestId,
        path: String(req.originalUrl || req.path || '').split('?')[0],
        method: req.method,
        action_kind: kind,
        action_received: String(actionRaw ?? '').slice(0, 64),
        body_keys: Object.keys(body),
        content_type: String(req.headers['content-type'] || ''),
        realm: resolveRealm(req.query?.from),
        // ⭐ 2026-10-12：她点的是**哪一版页面**渲染出来的（缺失 ⇒ 旧页面 / 手改表单）
        page_build: String(body[config.pageBuildField || 'page_build'] || '').trim() || 'missing',
        page_build_stale: Boolean(String(body[config.pageBuildField || 'page_build'] || '').trim())
          && String(body[config.pageBuildField || 'page_build'] || '').trim() !== String(config.pageBuild || ''),
        target: String(scanTargetOf(req).value || '').slice(0, 120),
      });
      return respondWriteFailure(res, {
        code: 'unknown_action',
        message: kind === 'unrecognized'
          ? writeConfig.texts.unknownActionBody
          : writeConfig.texts.unknownActionMissingBody,
      }, requestId);
    };

    const purchaseAmountMissingPage = (req, res, requestId, realm) => {
      logWarn(writeConfig.events.purchaseAmountRequired, {
        request_id: requestId,
        realm,
        reason: 'amount_empty',
        target: String(scanTargetOf(req).value || '').slice(0, 120),
      });
      // ⭐ 埋点 P0 ②：这次点击的结果原因码（`ui.tap.result` 用它 ⇒ 一眼看出"她填漏了"）
      markTapCode(res, 'purchase_amount_required');
      return sendHuman(res, 400, {
        title: writeConfig.texts.purchaseAmountMissingTitle,
        body: writeConfig.texts.purchaseAmountMissingBody,
        requestId,
        retryHint: writeConfig.texts.failedRetryHint,
        // 回"她刚才那一块"（编号 + 同一个领域）—— 不然她只能靠浏览器的返回键。
        backPath: postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ),
        backLabel: writeConfig.texts.purchaseAmountBackLabel,
      });
    };

    const purchaseAmountInvalidPage = (req, res, requestId, realm) => {
      logWarn(writeConfig.events.purchaseAmountRequired, {
        request_id: requestId,
        realm,
        reason: 'amount_invalid',
        target: String(scanTargetOf(req).value || '').slice(0, 120),
      });
      markTapCode(res, 'purchase_amount_invalid');
      return sendHuman(res, 400, {
        title: writeConfig.texts.purchaseAmountInvalidTitle,
        body: writeConfig.texts.purchaseAmountInvalidBody,
        requestId,
        retryHint: writeConfig.texts.failedRetryHint,
        backPath: postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ),
        backLabel: writeConfig.texts.purchaseAmountBackLabel,
      });
    };

    const purchaseEntryInvalidPage = (req, res, requestId, realm, violation) => {
      logWarn(writeConfig.events.entryInvalid, {
        request_id: requestId,
        realm,
        reason: String(violation?.code || 'entry_invalid'),
        target: String(scanTargetOf(req).value || '').slice(0, 120),
      });
      markTapCode(res, String(violation?.code || 'entry_invalid'));
      return sendHuman(res, 400, {
        title: ENTRY_RULE_TEXTS.entryInvalidTitle,
        // 🔴 **写层那一句原样**（同一句人话 ✓）：`sizeUnknownBody` /
        //    `quantityInvalidBody{max}` / `replenishNoneBody` / `returnNoneBody`。
        body: String(violation?.message || writeConfig.texts.internalFailedBody),
        requestId,
        retryHint: writeConfig.texts.failedRetryHint,
        backPath: postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ),
        backLabel: writeConfig.texts.purchaseAmountBackLabel,
      });
    };

    const respondWriteFailure = (res, result, requestId) => {
      // 2026-10-14 (real gap): a write failure used to log NOTHING. Only-add, existing event name.
      logError(writeConfig.events.failed, {
        request_id: requestId, reason: 'write_failed', code: String(result?.code || ''),
        where: 'respondWriteFailure',
      });
      // 500 = 系统那边没处理成（写库失败）；400 = 她填错了 / 数据不满足业务（一个字节都没写）。
      // ⭐ `sale_partial_failed` 也归 500：单子记上了、后面某步没写完 —— 不是她填错。
      const status = ['sale_write_failed', 'sale_partial_failed', 'replenish_write_failed', 'return_write_failed'].includes(result.code)
        ? 500 : 400;
      // ⭐ 2026-10-12：**钱算不对那几类**（差额 / 付款情况 / 实付多少 / 全付零元…）⇒
      //    把那句**人话差额**放到**最上面那一行（H1）**：她第一眼看到的就是"差在哪、差多少"，
      //    而不是一句泛泛的「没提交成功」。
      const moneyCodes = ['amount_mismatch', 'payment_amount_invalid', 'payment_status_invalid',
        'payment_amount_missing', 'partial_amount_missing', 'full_without_money'];
      const human = String(result.error?.scanUserMessage || result.message || '').trim();
      const moneyFailure = Boolean(human) && moneyCodes.includes(result.code);
      // ⭐ 埋点 P0 ②：把**业务原因码**留给结果事件（`ui.tap.result.code`）——
      //   与 ③ 那条「失败日志带人话原因码」同一个口径（`scan.write.settlement_blocked` 那类）。
      markTapCode(res, result.code || `http_${status}`);
      return sendHuman(res, status, {
        title: moneyFailure ? human : writeConfig.texts.failedTitle,
        body: moneyFailure ? writeConfig.texts.failedTitle
          : (result.message || writeConfig.texts.internalFailedBody),
        requestId,
        retryHint: writeConfig.texts.failedRetryHint,
      });
    };
  return { sendHuman, badNumberPage, notFoundPage, respondFailure, unknownActionFailure, purchaseAmountMissingPage, purchaseAmountInvalidPage, purchaseEntryInvalidPage, respondWriteFailure };
};

module.exports = { createResponses };
