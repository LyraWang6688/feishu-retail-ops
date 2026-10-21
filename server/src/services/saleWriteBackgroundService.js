'use strict';

/**
 * ⭐⭐ 2026-10-15（⑤ 模块化 · 外部评审建议 · 业务负责人定的「重中之重」）：
 *   **销售提交的「后台那一半」** —— 从 `services/scanWriteService.js` 里**只挪不改**剥出来的一件。
 *
 * 为什么剥：`scanWriteService` 一度 **1757 行**，同时管"提交/校验 ＋ **异步后台调度** ＋
 *   **失败标记** ＋ 恢复续写"⇒ 正是"什么都管的大类"✗（评审原文点名的就是这两处：
 *   `scheduleSaleRest` / `markSaleWriteFailed`）。
 *   ⇒ 剥出来之后：**主提交路径回到"只管提交"** ✓，**以后改后台调度不碰主链路** ✓。
 *
 * 🔴 本刀**零行为变化**（评审与 Lead 的共同硬要求）：
 *   · 日志**事件名与字段**、`submitKey`/幂等键、状态值域、`_confirm`（**仍然绝不许直调**）**逐字未动** ✗
 *   · 本文件**不 require** `scanWriteService`（**不造成循环依赖** ✓）：它要的东西**全部从参数进来** ✓
 *   · 对外接口**一模一样**：`scanWriteService` 继续 re-export `waitForPendingSaleBackgrounds` ✓
 *
 * 依赖（注入 ⇒ 本件不认识"销售提交"的任何细节）：
 *   · `submitSale` —— 主提交函数（**延迟**调用：拿**同一把 `submitKey`** 再跑一次 ⇒ 走既有续写路径 ✓）
 *   · `saleAsync`  —— 异步配置（开关 / 看门狗超时；来源 `config.sale.asyncWrite`）
 *   · `config`     —— 事件名与配置取值的唯一来源（`config.events.*` / `config.timing.phase.*`）
 *   · `status`     —— **延迟构造**的状态写入器（`SalesStatusWriter`）
 */
const { logInfo, logWarn } = require('../utils/logger');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');

/**
 * ⭐⭐ 2026-10-15（⑨b-2）：**"等后台那一跑跑完"的登记簿**（从 `scanWriteService` 原样挪来）。
 *
 * 为什么必须有它：`scanSaleE2E` 那条 E2E 是**打真实路由**的（`postForm`）⇒ 页面上
 *   拿不到 `result.background` 句柄（那是**服务调用方**才看得到的东西）
 *   ⇒ 用例"提交完就读表"会读到**后台还没写完**的那一刻 ⇒ 端状态断言假红。
 * 🔴 **不是**"为测试放宽判据"：判据一个字没改，只是**先等它跑完**再读 ✓
 *   （等价于"同步那一次"的时序 ⇒ 端状态断言与改前**逐字同形**）。
 * ⚠️ **不用轮询**：轮询靠真实计时器，本机降速时会 flake（实测过）✗ ⇒ 这里等的是**真 Promise** ✓。
 * ⚠️ 它只是**登记簿**（加入/移除各一行），不影响任何写入语义、幂等或返回值 ✓。
 */
const pendingSaleBackgrounds = new Set();
const trackSaleBackground = (promise) => {
  pendingSaleBackgrounds.add(promise);
  const done = () => pendingSaleBackgrounds.delete(promise);
  promise.then(done, done);
  return promise;
};

/** 等到**当前所有在飞的后台那一跑**都跑完（空则立即返回）。用例专用入口 ✓ */
const waitForPendingSaleBackgrounds = async () => {
  // 反复取快照：后台那一跑自己也可能再排一个 ⇒ 循环到空为止（不会漏、也不会死循环）
  while (pendingSaleBackgrounds.size) {
    await Promise.allSettled([...pendingSaleBackgrounds]);
  }
};

const createSaleWriteBackgroundService = ({ submitSale, saleAsync = {}, config = {}, status }) => {
  /**
   * ⭐⭐ 2026-10-15（⑰ 异步）：**后台那一跑**（明细/收款/库存）。
   *
   * 做法：**拿同一把 `submitKey` 再调一次 `submitSale`**（`noDefer: true`）——
   *   主表已在会话里 ⇒ 它走**既有续写路径**（`knownRecordIds` + `onRecordPersisted` 那套）
   *   ⇒ 写入语义 / 幂等 / 状态维度 **一个字都没变** ✗（她的硬要求：不许拆幂等）。
   * 失败 ⇒ **不报错给她**（她那次请求早已回了 ✓），但必须：① 记一条 warn；
   *   ② 把主表那一列落成「**写入失败**」（既有状态维度的值 + 既有写入器 ✓）
   *   ⇒ 工作台那一单会显示「**未完成，可点重试**」（`isOrderIncomplete` 判的就是这个值 ✓）。
   * ⚠️ **fire-and-forget**：不 `await`（否则又把她拖住了 ✗）；任何异常都被 `catch` 吞掉并记录 ✓。
   */
  const scheduleSaleRest = ({ openId, requestId, salesEntryRecordId, orderNo, correlation, restInput }) => {
    const startedAt = Date.now();
    const timeoutMs = Number(saleAsync.backgroundTimeoutMs) || 0;
    // ⭐⭐ 2026-10-15（⑨b-2）：**后台那一跑也要打 timing**（观测不缩水）——
    //   与她那次请求打的是**同一个事件名** `scan.sale.timing`，只多一个 `phase` 标记
    //   （取值走 `config.timing.phase.background` ✓ 不散写字符串 ✗）。
    //   ⇒ 「明细 / 收款 / 库存」每段耗时**照旧看得见**（转后台不等于日志断档 ✗）。
    const timing = {};
    const logTiming = (result, durationMs) => {
      logInfo(config.events.saleTiming, {
        ...correlation,
        request_id: requestId,
        phase: config.timing?.phase?.background || 'background',
        ok: result?.ok === true,
        code: result?.code || '',
        order_no: result?.order_no || orderNo,
        reused: result?.reused === true,
        partial: result?.code === 'sale_partial_failed',
        sales_entry_record_id: salesEntryRecordId,
        // 后台这一跑自己的墙钟（含排队等前面那次写 ✓ 与 request 段同一套读法）
        submit_ms: durationMs,
        queue_wait_ms: Number(timing.queue_wait_ms) || 0,
        lookup_ms: Number(timing.lookup_ms) || 0,
        prepare_ms: Number(timing.prepare_ms) || 0,
        master_ms: Number(timing.master_ms) || 0,
        status_ms: Number(timing.status_ms) || 0,
        detail_ms: Number(timing.detail_ms) || 0,
        stock_ms: Number(timing.stock_ms) || 0,
      });
    };
    // ⭐⭐ 2026-10-15（⑰b-1）：这一跑的句柄**当作返回值交出去**（见下面 `background`）——
    //   它的用途只有一个：**让调用方"等后台那一跑跑完"** ✓（用例回读端状态前先 await 它）；
    //   ⚠️ 它**不是页面字段** ✗：路由渲染只取它本来就认识的那几个（`paidPayload` 里那一批），
    //     所以句柄**不会**进 HTML（有用例钉住 ✓）。
    return trackSaleBackground(Promise.resolve()
      .then(() => submitSale({ ...restInput, noDefer: true, requestId, timing }, { correlation }))
      .then(async (result) => {
        const durationMs = Date.now() - startedAt;
        if (result?.ok) {
          logInfo(config.events.saleBackgroundDone, {
            sales_entry_record_id: salesEntryRecordId, order_no: orderNo,
            detail_count: result.detail_count, payment_count: result.payment_count,
            duration_ms: durationMs, request_id: requestId,
            ...(timeoutMs && durationMs > timeoutMs ? { over_timeout_ms: timeoutMs } : {}),
          });
          logTiming(result, durationMs);
          // ⭐ 2026-10-15（⑰b-2）：**把后台那一跑的结果作为句柄的解析值** ⇒
          //   "等它跑完"的人拿到的就是**端状态齐了之后的那一份** ✓（用例回读时不必改断言 ✓）
          return result;
        }
        logWarn(config.events.saleBackgroundFailed, {
          sales_entry_record_id: salesEntryRecordId, order_no: orderNo,
          code: result?.code || '', reason: result?.message || '',
          duration_ms: durationMs, request_id: requestId,
        });
        // 🔴 失败那条也打 timing：**卡在哪一段**正是这条日志最有用的时候（不许只在成功时打 ✗）
        logTiming(result, durationMs);
        await markSaleWriteFailed({ salesEntryRecordId, correlation, requestId });
        return result;
      })
      .catch(async (error) => {
        logWarn(config.events.saleBackgroundFailed, {
          sales_entry_record_id: salesEntryRecordId, order_no: orderNo,
          error: String(error?.message || error), duration_ms: Date.now() - startedAt, request_id: requestId,
        });
        logTiming({ ok: false, code: 'sale_background_threw', order_no: orderNo },
          Date.now() - startedAt);
        await markSaleWriteFailed({ salesEntryRecordId, correlation, requestId });
      }));
  };

  /** 后台那一跑没写成 ⇒ 主表那一列如实落「写入失败」（**不许假成功** ✗）。 */
  const markSaleWriteFailed = async ({ salesEntryRecordId, correlation, requestId }) => {
    if (!salesEntryRecordId) return;
    try {
      // ⭐ 2026-10-18：旧「销售状态」列已删除 ⇒ 后台失败收口为「部分失败」（主表/部分数据通常已落）。
      await status().writeFinal(salesEntryRecordId, WRITE.writeStatus.partial, correlation);
    } catch (error) {
      logWarn(config.events.failed, {
        request_id: requestId, reason: 'sale_background_mark_failed',
        sales_entry_record_id: salesEntryRecordId, error: String(error?.message || error),
      });
    }
  };

  return { scheduleSaleRest, markSaleWriteFailed };
};

module.exports = {
  createSaleWriteBackgroundService,
  // ⚠️ 这两个**只由本件持有**（登记簿只此一份 ⇒ 等的人与登记的人必须同源 ✓）
  trackSaleBackground,
  waitForPendingSaleBackgrounds,
};
