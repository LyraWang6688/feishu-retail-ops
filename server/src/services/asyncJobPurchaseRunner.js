'use strict';

/**
 * 采购三条链路（补货 / 退货 / 验收）→ **统一异步任务层**的薄适配器（#948）。
 *
 * 职责只有一个：把"跑一次写库"的闭包交给 `asyncJobService.run(...)` 的**统一重试循环**，
 * 并保证：① `job_id` 由 `submitKey`（没有才用 `requestId`）稳定派生 ⇒ 重试/并发是**同一条任务**；
 * ② 重试仍拿**同一把幂等键**（业务闭包由调用方给，本件不改写它）；
 * ③ 统一层不可用（没注入 / 存储写不进去）时**如实回落**到"直接跑一次"，绝不把业务写库吞掉。
 *
 * ⭐ 时序（真实判据，不能破坏）：`runFn()` 会**立刻**被调用（在回执返回之前就进写入口）——
 *   与改前"后台那一跑已排下去"完全一致（`purchaseAsyncTiming` 的 AC-ASY-T1/T3 钉的就是这个）。
 *   统一 job 的落盘（异步文件写）**与这次写库并行**，不拖慢请求，也不改变"先回她"的语义。
 *
 * 🔴 本件**不写任何业务表**、不 require 业务配置（链路 → 类型映射也在这里，是纯标签）。
 */
const { ASYNC_JOB_TYPES, ASYNC_JOB_STATUS } = require('../config/asyncJobs');

/** 链路 id → 统一任务类型。`return` 是「多货品退货」链的 id，`purchase_return` 是老扫码退货链的 id。 */
const CHAIN_JOB_TYPES = Object.freeze({
  replenish: ASYNC_JOB_TYPES.PURCHASE_REPLENISH,
  return: ASYNC_JOB_TYPES.PURCHASE_RETURN,
  purchase_return: ASYNC_JOB_TYPES.PURCHASE_RETURN,
  accept: ASYNC_JOB_TYPES.PURCHASE_ACCEPTANCE,
});

const jobTypeOfChain = (chain) => CHAIN_JOB_TYPES[String(chain || '').trim()] || '';

/**
 * @param {object} deps
 * @param {object} deps.asyncJob  统一异步任务服务（`asyncJobService` 实例；null = 适配器不启用）
 * @param {object} [deps.jobTypeOf] 链路 → 类型（默认取上表，用例可注入）
 */
const createAsyncJobPurchaseRunner = ({ asyncJob = null, jobTypeOf = jobTypeOfChain } = {}) => {
  const ready = Boolean(asyncJob
    && typeof asyncJob.enqueue === 'function'
    && typeof asyncJob.run === 'function'
    && typeof asyncJob.jobIdFor === 'function');

  /**
   * 跑一次"后台那一跑"（带统一重试 + 最终失败通知）。
   *
   * @returns {{handled: boolean, adopted: boolean, ok: boolean, result: object|null, error: Error|null, jobId: string, job: object|null}}
   *   · `handled:false` ⇒ 本件没接（调用方按既有"单次"路径自己跑）；
   *   · `handled:true`  ⇒ **这一次写库已经由本件跑过了**（调用方不许再跑一遍）；
   *     `adopted:true` = 用的是统一 job（有重试/通知），`false` = 统一层不可用、单次跑完。
   */
  const run = async ({
    chain = '', requestId = '', submitKey = '', jobMeta = {}, runFn,
  } = {}) => {
    const notHandled = {
      handled: false, adopted: false, ok: false, result: null, error: null, jobId: '', job: null,
    };
    if (!ready || typeof runFn !== 'function') return notHandled;
    const type = jobTypeOf(chain);
    // 没有稳定键 ⇒ **不建统一任务**（拿随机键建 job 会让重试变成"新任务"，违背 #948 的幂等要求），
    // 但这一次仍要跑 ⇒ 走"单次跑完"分支。
    const key = String(submitKey || requestId || '').trim();
    if (!type || !key) {
      try {
        const result = await runFn({ attempt: 1 });
        return { ...notHandled, handled: true, ok: result?.ok === true, result };
      } catch (error) {
        return { ...notHandled, handled: true, error };
      }
    }

    const jobId = asyncJob.jobIdFor(type, key);
    // ⭐ 先把写入口跑起来（回执前就进写入口 —— 与改前逐字一致）；它和 job 落盘并行。
    const firstRun = runFn({ attempt: 1 });
    firstRun.catch(() => undefined); // 先挂一个空 catch：避免"还没 await 就被判 unhandled rejection"
    let lastResult = null;
    let lastError = null;

    const enqueued = await asyncJob.enqueue({
      jobId,
      type,
      payload: {
        chain: String(chain || ''),
        request_id: String(requestId || ''),
        submit_key: String(submitKey || ''),
      },
      ownerOpenId: String(jobMeta.ownerOpenId || ''),
      operatorName: String(jobMeta.operatorName || ''),
      meta: {
        order_no: String(jobMeta.orderNo || ''),
        batch_no: String(jobMeta.batchNo || ''),
        // 失败步骤由调用方按**各自链路**给（配置在 `config/asyncJobs.texts.stepLabels`）；
        // 没给就不写（通知里省掉那一行，绝不编）。
        step: String(jobMeta.step || ''),
        chain: String(chain || ''),
        request_id: String(requestId || ''),
        submit_key: String(submitKey || ''),
      },
    });

    const settleFirst = async () => {
      try {
        lastResult = await firstRun;
      } catch (error) {
        lastError = error;
      }
    };

    if (!enqueued?.job) {
      // 统一层不可用（存储写失败等）⇒ 这一次就是本件跑的那一次（**不重跑** ✗）
      await settleFirst();
      return {
        handled: true,
        adopted: false,
        ok: lastResult?.ok === true,
        result: lastResult,
        error: lastError,
        jobId: '',
        job: null,
      };
    }

    const job = await asyncJob.run({
      jobId,
      run: async ({ attempt }) => {
        try {
          lastResult = await (attempt === 1 ? firstRun : runFn({ attempt }));
          return lastResult;
        } catch (error) {
          lastError = error;
          throw error;
        }
      },
    });

    if (!job) {
      // job 读不到（存储异常）⇒ 第一次已经跑了，如实报它的结果（不重跑）
      await settleFirst();
      return {
        handled: true,
        adopted: false,
        ok: lastResult?.ok === true,
        result: lastResult,
        error: lastError,
        jobId,
        job: null,
      };
    }

    return {
      handled: true,
      adopted: true,
      ok: job.status === ASYNC_JOB_STATUS.SUCCEEDED,
      result: lastResult,
      error: lastError,
      jobId,
      job,
    };
  };

  return { ready, run, jobTypeOf };
};

module.exports = { createAsyncJobPurchaseRunner, CHAIN_JOB_TYPES, jobTypeOfChain };
