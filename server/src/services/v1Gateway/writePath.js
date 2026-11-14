'use strict';

/**
 * 写路径的「调度 + 应答断言」（2026-11-14 #48 第 3 步，从 `v1BitableGateway.js` 拆出）。
 *
 * 为什么单独一层：
 *   · **所有写**都必须过同一个全局调度器（并发上限 / 同表串行 / 1254607 与瞬时 400 退避重试）；
 *   · **所有应答**都走同一套"明确拒绝 vs 结果未知"的标记（幂等写入靠它区分要不要重试）；
 *   · 这两件事是**写路径的公共骨架**，与具体是哪张表、哪次请求无关。
 *
 * ⚠️ 逐字搬走，不要在搬家的同时改语义：
 *   - `runScheduledWrite`：没有 scheduler / 没有 run 方法 ⇒ 直接执行（仅测试注入 `null` 时）；
 *   - `assertResponseSuccess`：把飞书 `code !== 0` 变成带 `bitableRejected` / `bitableCode` /
 *     `larkData` 的 Error（**网络超时这类没有该标记 = 可能已写入**，由幂等层处理）。
 */

/** 写请求进全局调度器（没注入 scheduler 时直接跑）。 */
const runScheduledWrite = ({ scheduler, tableKey, operation, work, options = {} }) => {
  if (!scheduler || typeof scheduler.run !== 'function') return work();
  return scheduler.run({
    tableKey,
    operation,
    work,
    correlation: options.correlation,
    groupKey: options.groupKey,
  });
};

/** 飞书应答断言：`code !== 0` ⇒ 抛"明确被拒"的 Error（可安全判定没写入）。 */
const assertResponseSuccess = (response, operation) => {
  if (!response || response.code !== 0) {
    const error = new Error(`${operation}失败: ${response?.msg || 'unknown'} (Code: ${response?.code ?? 'unknown'})`);
    // response.code 是飞书对请求的结构化应答：请求被处理并明确拒绝，可以确定没有写入。
    // 幂等写入靠这个标记区分「明确失败」和「结果未知」——网络超时、连接重置这类
    // 异常没有该标记，一律按可能已经写入处理。
    error.bitableRejected = true;
    error.bitableCode = response?.code;
    error.larkData = {
      code: response?.code,
      msg: response?.msg,
      log_id: response?.log_id,
      method_id: response?.method_id,
    };
    throw error;
  }
};

module.exports = { runScheduledWrite, assertResponseSuccess };
