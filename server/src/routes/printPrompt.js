'use strict';

/**
 * 「是否打印」轻页的 HTTP 入口（2026-11-17）—— 销售资金页 / 验收提交后共用。
 *
 *   GET  /print-prompt?token=…   列出这次涉及的货品（默认全勾）
 *   POST /print-prompt?token=…   把勾中的货品各记一条打印意图
 *
 * 🔴 一次性令牌：提交/过期后不能再用；页面只拿令牌，不裸露货品列表。
 * 🔴 销售 / 验收**都是异步写库存** ⇒ 一律先记打印意图，等各自的 job 成功后再入队。
 *    （销售 job 由 salesAsyncWorker 成功收口时 flush；验收 job 由统一异步任务 flush。）
 * 🔴 销售/验收的打印任务来源分别写「销售录单打印 / 验收录单打印」，
 *    并走既有「打印请求记录」按「货品 + 来源」累计申请次数。
 */
const express = require('express');

const { SOURCES } = require('../config/labelPrintQueue');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { getPrintPromptService } = require('../services/printPromptRuntime');
const { getInventoryPrintIntentService } = require('../services/inventoryPrintIntentRuntime');
const { PRINT_PROMPT_TEXTS } = require('../config/printPrompt');
const { logError } = require('../utils/logger');
const {
  renderPrintPromptPage, renderPrintPromptInvalid,
} = require('../views/printPromptPage');

const selectedIdsOf = (value) => {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
};

/**
 * 点完「打印选中」直接回工作台（不再渲染结果页）。
 * 只有打印意图提交失败时，才把成功 toast 换成失败文案，让用户知道要重打。
 */
const redirectAfterPrint = (res, returnUrl, { failed = false } = {}) => {
  if (!failed) return res.redirect(303, returnUrl || '/workbench/');
  const url = new URL(returnUrl || '/workbench/', 'http://local');
  url.searchParams.set('toast', PRINT_PROMPT_TEXTS.printFailedRedirect);
  return res.redirect(303, url.pathname + url.search + url.hash);
};

const createPrintPromptRouter = (options = {}) => {
  const router = express.Router();
  const prompts = options.promptService || getPrintPromptService();
  const intentService = () => options.intentService || getInventoryPrintIntentService();

  router.get('/', (req, res) => {
    const prompt = prompts.get(req.query?.token);
    res.set('Cache-Control', 'no-store');
    if (!prompt) return res.status(410).type('html').send(renderPrintPromptInvalid());
    return res.type('html').send(renderPrintPromptPage({
      token: prompt.token,
      products: prompt.products,
      returnUrl: prompt.returnUrl,
    }));
  });

  router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const selectedIds = selectedIdsOf(req.body?.product);
    const consumed = prompts.consume(req.query?.token || req.body?.token, selectedIds);
    if (!consumed) return res.status(410).type('html').send(renderPrintPromptInvalid());
    const { prompt, selected } = consumed;
    if (!selected.length) return res.redirect(303, prompt.returnUrl);

    // ⭐ 2026-11-17：销售也是异步写库存（资金页只入队、后台 worker 才写）——
    //   只记打印意图，等销售 job 成功后再入队；不是"点一下就立刻打"。
    if (prompt.source === SOURCES.sale) {
      try {
        let outcome = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          outcome = await intentService().request({
            jobId: prompt.operationId,
            ownerOpenId: prompt.ownerOpenId,
            productRecordIds: selected.map((item) => item.recordId),
            source: SOURCES.sale,
            expectedType: ASYNC_JOB_TYPES.SALES,
            submitKeyPrefix: 'sale_print',
          });
          if (outcome?.ok || outcome?.reason !== 'not_found') break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 200 * attempt); });
        }
        if (!outcome?.ok) {
          logError('print_prompt.sale.intent_failed', {
            token: prompt.token, operation_id: prompt.operationId, reason: outcome?.reason || '',
          });
          return redirectAfterPrint(res, prompt.returnUrl, { failed: true });
        }
        return redirectAfterPrint(res, prompt.returnUrl);
      } catch (error) {
        logError('print_prompt.sale.intent_error', {
          token: prompt.token, operation_id: prompt.operationId, error: error.message,
        });
        return redirectAfterPrint(res, prompt.returnUrl, { failed: true });
      }
    }

    // 验收：同一个 intent 机制，只是 job 类型/前缀不同。
    if (prompt.source === SOURCES.acceptance) {
      try {
        // ⚠️ 验收路由是「先回执、后台建 job」：她点打印时 job 可能还没落盘
        //   ⇒ not_found 时短重试几次（不是把失败吞掉，超时仍如实报）。
        let outcome = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          outcome = await intentService().request({
            jobId: prompt.operationId,
            ownerOpenId: prompt.ownerOpenId,
            productRecordIds: selected.map((item) => item.recordId),
            source: SOURCES.acceptance,
            expectedType: ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE,
            submitKeyPrefix: 'acceptance_print',
          });
          if (outcome?.ok || outcome?.reason !== 'not_found') break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 200 * attempt); });
        }
        if (!outcome?.ok) {
          logError('print_prompt.acceptance.request_failed', {
            token: prompt.token, operation_id: prompt.operationId, reason: outcome?.reason || '',
          });
          return redirectAfterPrint(res, prompt.returnUrl, { failed: true });
        }
        return redirectAfterPrint(res, prompt.returnUrl);
      } catch (error) {
        logError('print_prompt.acceptance.failed', {
          token: prompt.token, operation_id: prompt.operationId, error: error.message,
        });
        return redirectAfterPrint(res, prompt.returnUrl, { failed: true });
      }
    }

    return res.status(400).type('html').send(renderPrintPromptInvalid());
  });

  return router;
};

module.exports = { createPrintPromptRouter };
