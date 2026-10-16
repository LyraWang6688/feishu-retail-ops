'use strict';

/**
 * ⭐⭐ 2026-10-16（业务负责人当天点名「**补货和验收两个都需要**」）——
 * **补货（报货）那条链的「明细攒批」** 的开关（配置先行）。
 *
 * 为什么单独一个模块：这个开关决定的是「**同一批次的多条明细，一次批量写还是逐条写**」——
 * 是**行为粒度**，不是文案也不是阈值。放进 `v1BitableSchema`（字段映射）或
 * `scanWrite`（扫码链路）都会把"一件跟表结构无关的事"塞到别处去 ✗。
 *
 * 口径（与 `config/purchasePendingCache` / `envValue.readFlag` **同一套规则**）：
 *   · **没设** ⇒ 默认 **开**（攒批）—— 她的原话是"两个都需要"，默认要快的那一档 ✓
 *   · **设成 `false` / `0` / `off` / `no` / 空串** ⇒ **关**（退回逐条；排查/回归用 ✓）
 *   · 设成认不出来的值 ⇒ **当场抛错**，不猜
 *     （静默按 true/false 处理是最坏的一种：她说"我明明配了关"，实际还在批量跑 ✗）
 *
 * ⚠️ **空串 = 关**（不是"没配"）：这正是 `envValue.readFlag` 与 `||` 的分水岭 ——
 *    写成 `process.env.X || fallback` 的话，清空变量想关掉时会**静默回退默认值**，
 *    于是**关不掉**（仓库里 `getEnv` 那个形状踩过的坑，AGENTS.md 写死了这条纪律）。
 *
 * ⚠️ 网关**没有** `createBatch`（既有用例里的替身）时同样退回逐条 ——
 *    那道判断在 `confirmPurchaseRequest` 里（能力探测），本开关只管"业务上允不允许攒批" ✓。
 */
const { readFlag } = require('./envValue');

const BATCH_WRITE_ENV_KEY = 'PURCHASE_DETAIL_BATCH_WRITE_ENABLED';

/**
 * @param {Record<string,string|undefined>} env 取值来源（用例直接传对象，不碰全局 `process.env`）
 * @returns {{ enabled: boolean }}
 */
const resolvePurchaseDetailBatchWriteConfig = (env = process.env) => ({
  enabled: readFlag(env, BATCH_WRITE_ENV_KEY, true),
});

module.exports = { resolvePurchaseDetailBatchWriteConfig, BATCH_WRITE_ENV_KEY };
