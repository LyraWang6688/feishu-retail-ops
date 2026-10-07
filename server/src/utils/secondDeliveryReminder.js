const { logError, logInfo } = require('./logger');

// 「第二次交付」的每日提醒：每天 9 点（**北京时间**，业务负责人说的）把没成交的
// 尚未完成履约（预定 / 现货待收）的单推成群卡片。
//
// 为什么用 setInterval 而不是 cron / node-cron：
//   · 仓库刻意不引新依赖，这条链路只要"每天跑一次"这么点需求；
//   · 判断"今天该不该跑"不靠定时精度，而靠**按天认领**（见 SecondDeliveryService
//     的 sendDailyReminder）——所以 poll 间隔是否正好落在 9:00 无所谓，
//     落后的那一次 tick 会把当天该做的事补上。
// 这也是唯一一个"业务定时任务"：仓库里另外两个 setInterval（上传清理、到货提醒）
// 都不是业务日程，口径不同，不要照抄它们的写法来改这里。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const REMINDER_HOUR = 9;
// 10 分钟一 tick：一天最多 144 次空转，每次只是"今天跑过没有"的一次读，
// 相对于 9 点这个分钟级精度要求足够，也不会把日志刷满。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

// 线上服务器是 UTC，用 Date 的本地方法取小时会算错 8 小时，
// 所以手动加东八区偏移、再按 UTC 读数。
const shanghaiHour = (now) => new Date(now.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();

/**
 * 起一个轮询定时器：过了当天 9 点就调一次 run（一天只会真正推一次，见服务里的按天认领）。
 *
 * 返回停止函数；定时器 unref，不阻止进程退出（与 utils/uploadCleanup 同款）。
 * run 抛出的异常在这里吞掉并记日志：定时任务不该把异常变成 unhandledRejection。
 */
const startSecondDeliveryReminder = ({ run, intervalMs = DEFAULT_INTERVAL_MS, hour = REMINDER_HOUR, now = () => Date.now() } = {}) => {
  if (typeof run !== 'function') throw new Error('成交提醒缺少 run 回调');
  const resolvedIntervalMs = Number(intervalMs);
  if (!Number.isFinite(resolvedIntervalMs) || resolvedIntervalMs <= 0) {
    throw new Error('成交提醒的 intervalMs 无效');
  }

  logInfo('sales.second_delivery.reminder.started', {
    hour, interval_ms: resolvedIntervalMs, timezone: 'Asia/Shanghai',
  });

  const tick = async () => {
    try {
      const startedAt = now();
      const currentHour = shanghaiHour(new Date(startedAt));
      if (currentHour < hour) return;
      await run({ now: new Date(startedAt) });
    } catch (error) {
      logError('sales.second_delivery.reminder.tick_failed', { error: error.message });
    }
  };

  // 启动立刻试一次：服务器 10 点才起来时，当天 9 点那趟不能就这么丢了。
  void tick();
  const timer = setInterval(tick, resolvedIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
};

module.exports = {
  startSecondDeliveryReminder,
  // 导出只为让"东八区小时换算"这一条能被单测直接盯住（时区算错就是少推一天）。
  shanghaiHour,
};
