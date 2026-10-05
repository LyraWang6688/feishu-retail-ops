/**
 * 采购到货「等待与提示」的纯策略：时间阈值解析 + 给她看的提示文案。
 *
 * 为什么单独抽出来：这三个时间点（每 1 分钟补发 / 2 分钟放弃等待 / 3 分钟判失败）
 * 是产品负责人 2026-10-05 看完一次真实的到货识别（**82 秒**）后定的——她原来把超时
 * 设成 60 秒，那条完好的数据被误判成失败。但"到底该设多少"要用真实数据继续校准，
 * 所以阈值**必须可配**（构造入参 > 环境变量 > 默认值）。
 *
 * 纯函数留在这一层，服务层只负责编排定时器和写库，便于单测直接钉住环境变量名与默认值。
 */

const DEFAULT_ARRIVAL_NOTICE_INTERVAL_MS = 60_000; // 每 1 分钟补发一条「还在识别中」
const DEFAULT_ARRIVAL_ABANDON_WAIT_MS = 120_000; // 2 分钟放弃等待（**不是**失败）
const DEFAULT_ARRIVAL_FAIL_AFTER_MS = 180_000; // 3 分钟判失败
const DEFAULT_ARRIVAL_NOTICE_MAX_COUNT = 5; // 补发次数上限（兜底）

/**
 * 只接受正数。写 0 / 负数 / 非数字一律当"没写"：
 * 一个 0 会让 interval 变成死循环刷屏，也会让 fail-after 把所有到货立刻判失败。
 */
const positiveNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const resolveArrivalWaitConfig = (options = {}, env = process.env) => ({
  noticeIntervalMs: positiveNumber(options.arrivalNoticeIntervalMs)
    ?? positiveNumber(env.ARRIVAL_NOTICE_INTERVAL_MS)
    ?? DEFAULT_ARRIVAL_NOTICE_INTERVAL_MS,
  abandonWaitMs: positiveNumber(options.arrivalAbandonWaitMs)
    ?? positiveNumber(env.ARRIVAL_ABANDON_WAIT_MS)
    ?? DEFAULT_ARRIVAL_ABANDON_WAIT_MS,
  failAfterMs: positiveNumber(options.arrivalFailAfterMs)
    ?? positiveNumber(env.ARRIVAL_FAIL_AFTER_MS)
    ?? DEFAULT_ARRIVAL_FAIL_AFTER_MS,
  noticeMaxCount: Math.floor(
    positiveNumber(options.arrivalNoticeMaxCount)
    ?? positiveNumber(env.ARRIVAL_NOTICE_MAX_COUNT)
    ?? DEFAULT_ARRIVAL_NOTICE_MAX_COUNT,
  ),
});

// ①「收到」之后，② 每隔一分钟补一条，直到处理完成 / 判失败 / 到达补发上限。
const ARRIVAL_WAITING_NOTICE = '还在识别中，请稍等～';

// 时长说人话：3 分 20 秒 / 45 秒。给她看的文案里不能出现毫秒数。
const formatDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
};

/**
 * ⑤ 判失败之后结果才到时的说明。
 *
 * 必须先承认"刚才那条后来好了"：她前脚刚看到失败提示、后脚又收到确认卡片，
 * 不说清楚会以为系统错乱。文案里带上真实耗时，方便她判断识别到底慢在哪。
 */
const arrivalRescuedNotice = (elapsedMs) =>
  `刚才那条到货单后来识别出来了（用了 ${formatDuration(elapsedMs)}），已经按识别结果处理好，你可以直接确认入库～`;

module.exports = {
  DEFAULT_ARRIVAL_NOTICE_INTERVAL_MS,
  DEFAULT_ARRIVAL_ABANDON_WAIT_MS,
  DEFAULT_ARRIVAL_FAIL_AFTER_MS,
  DEFAULT_ARRIVAL_NOTICE_MAX_COUNT,
  ARRIVAL_WAITING_NOTICE,
  resolveArrivalWaitConfig,
  formatDuration,
  arrivalRescuedNotice,
};
