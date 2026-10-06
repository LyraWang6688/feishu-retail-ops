const { logError, logInfo } = require('./logger');

// 「过了当天某个（或某几个）**北京时间**整点就调一次 run」的通用轮询器。
//
// 两种用法：
//   · `hour: 9` —— 一天一趟（未付/预付那一条推送用的是它）；
//   · `hours: [9,12,15,18,21,22]` —— 一天多趟（销售战报）。多趟时**只判断"到没到最早那个整点"**，
//     "这一趟是哪个时段、推过没有、过期的时段要不要补"**全由调用方按时段认领**
//     —— 定时器不认识"战报"这种业务语义（解耦）。
//
// 为什么用 setInterval 而不是 cron / node-cron：
//   · 仓库刻意不引新依赖，这类需求只要"每天跑一次"这么点；
//   · 判断"今天该不该跑"**不靠定时精度**，而靠**调用方自己的按天认领**——
//     所以 poll 间隔是否正好落在整点无所谓，落后的那一次 tick 会把当天该做的事补上。
//
// ⚠️ 与 `utils/secondDeliveryReminder` 的关系：那个是本文件的"前身"，只服务「第二次交付」，
// 逻辑几乎相同。这里把它抽成参数化的通用件，**故意没有去改 secondDeliveryReminder**
// ——那会动到另一条链路正在用的文件（多代理并行时是纯冲突面）；等两条链路归一个改动管时再收敛。
//
// 返回停止函数；定时器 unref，不阻止进程退出（与 utils/uploadCleanup 同款）。
// run 抛出的异常在这里吞掉并记日志：定时任务不该把异常变成 unhandledRejection。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 线上服务器是 UTC，用 Date 的本地方法取小时会算错 8 小时，
// 所以手动加东八区偏移、再按 UTC 读数。
const shanghaiHour = (now) => new Date(now.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();

/**
 * @param {object} options
 * @param {(input: {now: Date}) => any} options.run 到点后要跑的事（自己负责"今天跑过没有"）
 * @param {string} options.eventPrefix 日志事件前缀（例 `sales.pending_deal_push.reminder`）
 * @param {number} [options.hour] 北京时间整点（0–23）——单整点的用法，与 `hours` 二选一
 * @param {number[]} [options.hours] 多个整点（例销售战报的 9/12/15/18/21/22）——
 *   到其中**任何一个**整点之后每个 tick 都会调一次 `run`，
 *   ⚠️ "这个时段推过没有 / 过期的时段要不要补"**由调用方自己按时段认领**
 *   （本文件只负责"到点了就叫他"，不做任何时段语义）
 * @param {number} [options.intervalMs] 轮询间隔，默认 10 分钟
 * @param {() => number} [options.now] 取当前毫秒时间戳（测试注入）
 */
const startShanghaiDailyScheduler = ({
  run, eventPrefix, hour, hours, intervalMs = 10 * 60 * 1000, now = () => Date.now(),
} = {}) => {
  if (typeof run !== 'function') throw new Error(`${eventPrefix || '每日推送'}缺少 run 回调`);
  const resolvedIntervalMs = Number(intervalMs);
  if (!Number.isFinite(resolvedIntervalMs) || resolvedIntervalMs <= 0) {
    throw new Error(`${eventPrefix || '每日推送'}的 intervalMs 无效`);
  }
  const rawHours = Array.isArray(hours) && hours.length ? hours : [hour];
  const resolvedHours = [...new Set(rawHours.map((value) => Number(value)))].sort((left, right) => left - right);
  if (!resolvedHours.length || resolvedHours.some((value) => !Number.isInteger(value) || value < 0 || value > 23)) {
    throw new Error(`${eventPrefix || '每日推送'}的 hour / hours 必须是 0~23 的整数`);
  }
  // 最早的那个整点：没到它之前每个 tick 直接返回，省掉无意义的调用。
  const earliestHour = resolvedHours[0];

  logInfo(`${eventPrefix}.started`, {
    hours: resolvedHours, interval_ms: resolvedIntervalMs, timezone: 'Asia/Shanghai',
  });

  const tick = async () => {
    try {
      const startedAt = now();
      if (shanghaiHour(new Date(startedAt)) < earliestHour) return;
      await run({ now: new Date(startedAt) });
    } catch (error) {
      logError(`${eventPrefix}.tick_failed`, { error: error.message });
    }
  };

  // 启动立刻试一次：服务器 10 点才起来时，当天 9 点那趟不能就这么丢了。
  void tick();
  const timer = setInterval(tick, resolvedIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
};

module.exports = {
  startShanghaiDailyScheduler,
  // 导出只为让"东八区小时换算"这条能被单测直接盯住（时区算错就是少推一天）。
  shanghaiHour,
};
