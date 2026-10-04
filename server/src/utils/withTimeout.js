/**
 * 给「对外调用」加一层超时。
 *
 * 为什么必须有这个（2026-10-05 线上故障的直接原因）：
 * 采购到货记录被写成「识别中」之后就再也没有任何输出——进程没崩（PM2 没重启）、
 * 健康检查还能秒回，说明事件循环没被堵住，是某个 `await` 永远不返回：
 *   · 飞书 SDK 的 HTTP 客户端是 `axios.create()`，**没设 timeout**（axios 默认 0 = 永不超时），
 *     下载附件、读写多维表格都可能一直挂着；
 *   · 模型客户端用 OpenAI SDK，默认 `timeout` 600s 且失败重试 2 次，最坏能挂半小时。
 * 没有超时就不会抛错；不抛错就永远走不到「写失败态 + 告诉用户」的分支，
 * 记录就会一直停在「识别中」——这正是最难查的静默失效。
 *
 * ⚠️ 这只能让**调用方不再无限等待**，并不能取消底层请求。所以：
 *   · 只读调用用它绝对安全（图片下载、读取记录、匹配货品）；
 *   · 写入用它必须保证该写有幂等保护（幂等键或「先查再写」）。飞书的结构化拒绝会带
 *     `bitableRejected`，超时**不带**该标记，因此 createOnceByKey 仍会把超时当成
 *     「结果未知」去按幂等键回查，而不会重复 create。
 */

const formatSeconds = (ms) => {
  if (ms < 1000) return `${ms}毫秒`; // 测试里会用很小的超时，别打成「0.0秒」
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}秒`;
};

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label}超时（${formatSeconds(ms)}）`);
    this.name = 'TimeoutError';
    // 复用 ETIMEDOUT：Node 生态里的超时都是这个码，日志和上层判断都能认。
    this.code = 'ETIMEDOUT';
    this.timeout_label = label;
    this.timeout_ms = ms;
  }
}

/** 超时时间 <= 0 / 非数字时不做任何包装（等价于原来的行为）。 */
const normalizeTimeout = (ms) => {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const withTimeout = (promise, ms, label = '外部调用') => {
  const timeout = normalizeTimeout(ms);
  if (!timeout) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeout)), timeout);
    // 定时器不能拖住进程退出（否则测试跑完还在等这些超时）。
    if (typeof timer.unref === 'function') timer.unref();
  });
  // Promise.race 会给两边都挂上处理函数：底层请求在超时之后才 reject 也不会变成
  // unhandledRejection——超时是「我们不等了」，不是「对面一定失败了」。
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
};

/**
 * 会翻页的读取：一次调用要发好几个请求，给更宽的预算。
 * 否则表一大，正常的分页读取会被误判成超时。
 */
const PAGED_METHODS = new Set(['listAll', 'listFields']);
const PAGED_TIMEOUT_FACTOR = 3;

/**
 * 把一个对象（gateway / references）上的所有方法都套上超时。
 *
 * 用 Proxy 而不是逐个包：这类对象的方法很多，漏包一个就等于留了一条永不返回的路径，
 * 而「漏包」在 code review 里很难看出来。
 *
 * ⚠️ 只对**返回 Promise 的方法**套超时：`gateway.table('purchaseArrival')` 这类是同步的，
 * 把它变成 Promise 会让 `gateway.table('x').fields.y` 全变成 undefined——这个坑踩过一次。
 * 同步方法（含同步抛错）保持原样。非函数属性原样透传。
 */
const withTimeoutProxy = (target, { timeoutMs, prefix = '' } = {}) => {
  const base = normalizeTimeout(timeoutMs);
  if (!target || !base) return target;
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      const budget = PAGED_METHODS.has(String(prop)) ? base * PAGED_TIMEOUT_FACTOR : base;
      const label = `${prefix}${String(prop)}`;
      return (...args) => {
        const result = value.apply(obj, args);
        if (!result || typeof result.then !== 'function') return result;
        return withTimeout(result, budget, label);
      };
    },
  });
};

module.exports = { withTimeout, withTimeoutProxy, TimeoutError };
