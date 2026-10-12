/**
 * 标签二维码「兜底巡检」的调度壳。
 *
 * 为什么要有它（2026-10-12 真机事故）：
 *   · 事件路径曾长期"判成编号没变就跳过、连表都不读" ⇒ 生产日志里
 *     **292 次 `skipped_number_unchanged` / 0 次写回**；
 *   · 而 `sweepStaleTagQrCodes`（"文件名/编号 ≠ 当前编号就重生成"这道**最后一道网**）
 *     **全仓没有任何调用方** —— 写了、有单测、但**从来没在线上跑过**。
 *
 * 这个壳只干一件事：**按最短间隔去重**（默认 1 小时一次），别的交给 service。
 *   · 为什么必须自己节流：`startShanghaiDailyScheduler` 过了起点之后**每个 tick 都调 `run`**
 *     （间隔默认 10 分钟），不节流就会一天扫几十遍全表；
 *   · ⭐ 2026-10-12 改：原来是"**每个上海日只跑一次**"；真机又发现"公式列延迟"那类漏判
 *     最坏要等到第二天凌晨 4 点 ⇒ 改成**每小时一次**（562 条只读，成本极低）。
 *     想退回"每天一次"就把 `minIntervalMs` 设成 24 小时（配置项 `TAG_QR_SWEEP_MIN_INTERVAL_MS`）。
 *   · 这一层是**兜底**，不是主路径：主路径是事件 + 延迟复核（`utils/tagQrRecheckQueue.js`）。
 */
const { shanghaiHour } = require('./shanghaiDailyScheduler');

/** 上海日（`YYYY-MM-DD`）—— 只用于日志/排查，不参与判据。 */
const shanghaiDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

/**
 * @param {object} options
 * @param {{sweepStaleTagQrCodes: Function}} options.service 「标签二维码」service（只要这一个方法）
 * @param {boolean} [options.dryRun] 干跑（只报不改）—— 上线首日建议先干跑看一眼
 * @param {number}  [options.limit]  最多处理多少条（0 / 空 = 全表）
 * @param {number}  [options.minIntervalMs] 两次巡检之间的最短间隔（默认 1 小时）
 * @param {() => Date} [options.now]
 */
const createTagQrSweepRunner = ({
  service, dryRun = false, limit = 0, minIntervalMs = 60 * 60 * 1000, now = () => new Date(),
} = {}) => {
  if (!service || typeof service.sweepStaleTagQrCodes !== 'function') {
    throw new Error('标签二维码巡检缺少 service（或它没有 sweepStaleTagQrCodes）');
  }
  const gap = Math.max(0, Number(minIntervalMs) || 0);
  let lastRunAt = 0;
  let lastResult = null;
  let running = null;
  const toMs = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

  return {
    minIntervalMs: gap,
    lastRunAt: () => lastRunAt,
    reset: () => { lastRunAt = 0; lastResult = null; },
    /**
     * 跑一次（**距上次不足 `minIntervalMs` 就跳过**；并发调用合并成同一个 promise）。
     * 失败**抛出去**（由调度器记 `product.tag_qr.sweep.tick_failed`）—— 不吞；
     * 并且**清掉节流**（下一次 tick 还能再来，不白等一小时）。
     */
    run: async ({ now: at = now() } = {}) => {
      const atMs = toMs(at);
      if (lastRunAt && atMs - lastRunAt < gap) {
        return {
          skipped: true,
          reason: 'too_soon',
          day: shanghaiDay(new Date(atMs)),
          next_in_ms: gap - (atMs - lastRunAt),
        };
      }
      if (running) return running;
      running = (async () => {
        const summary = await service.sweepStaleTagQrCodes({ dryRun, limit });
        lastRunAt = atMs;
        lastResult = {
          skipped: false,
          day: shanghaiDay(new Date(atMs)),
          shanghai_hour: shanghaiHour(new Date(atMs)),
          scanned: summary?.scanned ?? null,
          rewritten: summary?.rewritten ?? null,
          dry_run: Boolean(summary?.dry_run),
        };
        return lastResult;
      })().finally(() => { running = null; });
      try {
        return await running;
      } catch (error) {
        lastRunAt = 0; // 失败不节流：下一个 tick 立刻重试
        throw error;
      }
    },
    lastSummary: () => lastResult,
  };
};

module.exports = { createTagQrSweepRunner, shanghaiDay };
