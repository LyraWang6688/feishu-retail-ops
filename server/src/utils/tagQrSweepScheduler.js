/**
 * 标签二维码「兜底巡检」的**每日一次**调度壳。
 *
 * 为什么要有它（2026-10-12 真机事故）：
 *   · 事件路径曾经长期"判成编号没变就跳过、连表都不读" ⇒ 生产日志里
 *     **292 次 `skipped_number_unchanged` / 0 次写回**；她那 5 条记录的附件名里
 *     还带着旧货号前缀（`tag-qr-QPL8809_黑_A.png`）却一直没被修；
 *   · 而 `sweepStaleTagQrCodes`（"文件名/编号 ≠ 当前编号就重生成"这道**最后一道网**）
 *     **全仓没有任何调用方** —— 写了、有单测、但**从来没在线上跑过**。
 *
 * ⇒ 这个壳只干一件事：**按上海日去重**，每天让巡检跑一次（别的交给 service）。
 *    · 为什么必须自己按"上海日"去重：`startShanghaiDailyScheduler` 过了整点之后
 *      **每个 tick 都会调 `run`**（间隔默认 10 分钟），不去重就会一天扫几十遍全表。
 *    · 时区一律走东八区（服务器是 UTC —— 按 UTC 去重会在她下午的时候换天）。
 */
const { shanghaiHour } = require('./shanghaiDailyScheduler');

/** 上海日（`YYYY-MM-DD`）—— 只用来做"今天跑过没有"的去重，不做业务判断。 */
const shanghaiDay = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return parts;
};

/**
 * @param {object} options
 * @param {{sweepStaleTagQrCodes: Function}} options.service 「标签二维码」service（只要这一个方法）
 * @param {boolean} [options.dryRun] 干跑（只报不改）—— 上线首日建议先干跑看一眼
 * @param {number}  [options.limit]  最多处理多少条（0 / 空 = 全表）
 * @param {() => Date} [options.now]
 * @returns {{run: Function, lastDay: () => string, reset: () => void}}
 */
const createTagQrSweepRunner = ({ service, dryRun = false, limit = 0, now = () => new Date() } = {}) => {
  if (!service || typeof service.sweepStaleTagQrCodes !== 'function') {
    throw new Error('标签二维码巡检缺少 service（或它没有 sweepStaleTagQrCodes）');
  }
  let lastDay = '';
  let running = null;
  return {
    lastDay: () => lastDay,
    reset: () => { lastDay = ''; },
    /**
     * 跑一次（**同一个上海日只跑一次**；并发调用合并成同一个 promise）。
     * 失败**抛出去**（由调度器记 `product.tag_qr.sweep.tick_failed`）—— 不吞。
     */
    run: async ({ now: at = now() } = {}) => {
      const day = shanghaiDay(at);
      if (day === lastDay) {
        return { skipped: true, reason: 'already_ran_today', day, shanghai_hour: shanghaiHour(at) };
      }
      if (running) return running;
      lastDay = day;
      running = (async () => {
        const summary = await service.sweepStaleTagQrCodes({ dryRun, limit });
        return {
          skipped: false,
          day,
          shanghai_hour: shanghaiHour(at),
          scanned: summary?.scanned ?? null,
          rewritten: summary?.rewritten ?? null,
          dry_run: Boolean(summary?.dry_run),
        };
      })().finally(() => { running = null; });
      try {
        return await running;
      } catch (error) {
        // 这一次失败 ⇒ 允许同一天稍后重试（不然一次网络抖动就白等 24 小时）
        lastDay = '';
        throw error;
      }
    },
  };
};

module.exports = { createTagQrSweepRunner, shanghaiDay };
