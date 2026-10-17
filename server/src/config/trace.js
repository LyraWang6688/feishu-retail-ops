'use strict';

/**
 * 请求追踪（埋点收尾刀）：`trace_id` ＋ **入口 / 角色** 两个维度。
 *
 * - `trace_id`：优先取 `x-trace-id`，其次 `x-request-id`，都没有就新生成；
 *   由 `utils/traceMiddleware.js` 放进 AsyncLocalStorage，`logger` **只在有上下文时**附加
 *   `trace_id/entry/role`（没有上下文 ⇒ 字段不出现 ⇒ 不破坏既有日志断言）。
 * - `entry`：按路径判定（`scan` / `workbench` / `lark` / `api`）——只记**入口名**，不记 URL 值。
 * - `role`：身份确定后由 `setTraceFields` 补（owner/operator）；**不记 open_id**（隐私）。
 */
const { readFlag } = require('./envValue');

const ENTRY_RULES = Object.freeze([
  Object.freeze({ prefix: '/s', entry: 'scan' }),
  Object.freeze({ prefix: '/r', entry: 'scan' }),
  Object.freeze({ prefix: '/api/workbench', entry: 'workbench' }),
  Object.freeze({ prefix: '/workbench', entry: 'workbench' }),
  Object.freeze({ prefix: '/api/lark', entry: 'lark' }),
  Object.freeze({ prefix: '/api', entry: 'api' }),
]);

const TRACE = Object.freeze({
  enabled: readFlag(process.env, 'TRACE_ENABLED', true),
  header: 'x-trace-id',
  entryRules: ENTRY_RULES,
});

/** 路径 → 入口名（认不出 ⇒ `api`；只返回枚举，不回显 URL）。 */
const entryOfPath = (path) => {
  const url = String(path || '');
  for (const rule of ENTRY_RULES) if (url === rule.prefix || url.startsWith(`${rule.prefix}/`)) return rule.entry;
  return 'api';
};

/** 业务负责人/操作人的 open_id 清单（只用于判角色，**不进日志**）。 */
const ownerOpenIds = () => new Set(String(
  process.env.LARK_OWNER_OPEN_IDS || process.env.WORKBENCH_ALLOWED_OPEN_IDS || '',
).split(',').map((value) => value.trim()).filter(Boolean));

/** open_id → role（拿不到 ⇒ 空串，不编）。 */
const roleOf = (openId) => {
  const id = String(openId || '').trim();
  if (!id) return '';
  return ownerOpenIds().has(id) ? 'owner' : 'operator';
};

module.exports = { TRACE, ENTRY_RULES, entryOfPath, ownerOpenIds, roleOf };
