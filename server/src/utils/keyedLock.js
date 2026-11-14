'use strict';

/**
 * 按 key 的**进程内串行锁**（2026-11-14，#50 inventory-manual-audit 并发风险）。
 *
 * 用途：`库存手工调整`是「先 listAll 再写」的 read-modify-write；两个 job 同时跑同一款
 * 会重复增减。用同一把 key（`product:<record_id>`）串行化即可，不引入跨进程锁
 * （服务本身就是 PM2 单实例；多实例是已知边界）。
 *
 * 注意：**只保证同 key 串行**，不同 key 并行；返回的 Promise 沿用 fn 的成败。
 */
const createKeyedLock = () => {
  const tails = new Map();
  return (key, fn) => {
    const k = String(key || '');
    const previous = tails.get(k) || Promise.resolve();
    const run = previous.then(() => fn(), () => fn());
    const tail = run.then(() => undefined, () => undefined);
    tails.set(k, tail);
    tail.then(() => {
      if (tails.get(k) === tail) tails.delete(k);
    });
    return run;
  };
};

module.exports = { createKeyedLock };
