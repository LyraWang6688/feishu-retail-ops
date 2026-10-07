// 「报货批次号」的**格式**配置（业务负责人 2026-10-07 拍板：不再手填、后端代码生成）。
//
// 她的口径（逐字）：
//   「我们之前的**报货批次号是用手工填写的，后续要改为由后端代码来填写**」
//   「**就不会让用户自己填了，自动生成就可以了**」
// 补的格式样例：**`CGD-20261007-0003`**（前缀 `CGD-` + 上海日期 + 4 位补零序号，每天归零）。
//
// ⚠️ 为什么单独一个配置文件（AGENTS.md《底层工程原则》的「配置先行」）：
//   前缀 / 日期格式 / 位数 / 时区 / 认哪些号 —— **都是会改的口径**。
//   改的时候只动这里（或环境变量），**逻辑里一行都不写死 `CGD-`、也不写死日期格式**。
//
// ⚠️ 两套前缀刻意分开（不要合成一个）：
//   · `prefix`           —— **生成**用的前缀（今天只有 `CGD-`）；
//   · `recognizedPrefixes` —— 群里**识别**用的前缀（`CGD-` **加** `BH-`）。
//   理由：`BH-YYYYMMDD-NNNN` 是**历史格式**，生产表里已经有这样的号、
//   她此前的群消息也可能还引用着它们 —— **历史号必须继续认得出**（不然她一说
//   `BH-…` 机器人就"认不出"了）。但**新生成的号不能再用 `BH-`**。

const { readString, readInt, readList } = require('./envValue');

// 生成前缀（含分隔符）。默认 `CGD-`（她的样例）。
const PURCHASE_BATCH_NO_PREFIX_ENV_KEY = 'PURCHASE_BATCH_NO_PREFIX';
const DEFAULT_PURCHASE_BATCH_NO_PREFIX = 'CGD-';

// 日期部分的格式。只认三个占位符：`YYYY` / `MM` / `DD`（顺序随便，分隔符随便）。
const PURCHASE_BATCH_NO_DATE_FORMAT_ENV_KEY = 'PURCHASE_BATCH_NO_DATE_FORMAT';
const DEFAULT_PURCHASE_BATCH_NO_DATE_FORMAT = 'YYYYMMDD';

// 序号位数（补零到几位）。她的样例是 4 位。
const PURCHASE_BATCH_NO_DIGITS_ENV_KEY = 'PURCHASE_BATCH_NO_DIGITS';
const DEFAULT_PURCHASE_BATCH_NO_DIGITS = 4;

// 用哪个时区判"今天"。上海（+8）—— 她按上海时间安排现场，跨天归零必须跟着上海。
const PURCHASE_BATCH_NO_TIMEZONE_ENV_KEY = 'PURCHASE_BATCH_NO_TIMEZONE';
const DEFAULT_PURCHASE_BATCH_NO_TIMEZONE = 'Asia/Shanghai';

// 群里**识别**批次号时认哪些前缀（生成前缀之外的都算"历史格式"）。
const PURCHASE_BATCH_NO_PREFIXES_ENV_KEY = 'PURCHASE_BATCH_NO_PREFIXES';
const DEFAULT_RECOGNIZED_PREFIXES = Object.freeze(['CGD-', 'BH-']);

const DATE_TOKENS = Object.freeze(['YYYY', 'MM', 'DD']);

/** 正则里要把前缀当**字面量**（`CGD-` 本身没有元字符，但换成别的就必须转义）。 */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `{ YYYY, MM, DD }` —— 按给定时区取"那一天"。**不用本地时区**：
 * 服务器是 UTC，直接 `new Date().getMonth()` 会在 16:00 UTC 之后跨错天。
 */
const datePartsInTimeZone = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date instanceof Date ? date : new Date(date))) {
    if (part.type && part.type !== 'literal') parts[part.type] = part.value;
  }
  return { YYYY: parts.year || '', MM: parts.month || '', DD: parts.day || '' };
};

/** 把日期格式串渲染成日期字符串；剩下没被替换的 `Y`/`M`/`D` 说明格式写错了 → 当场抛。 */
const formatBatchDate = (date, { dateFormat, timeZone }) => {
  const parts = datePartsInTimeZone(date, timeZone);
  const rendered = DATE_TOKENS.reduce(
    (text, token) => text.split(token).join(parts[token]),
    String(dateFormat),
  );
  if (/[YMD]/.test(rendered)) {
    throw new Error(
      `${PURCHASE_BATCH_NO_DATE_FORMAT_ENV_KEY} 里有认不出的日期占位符（只认 ${DATE_TOKENS.join(' / ')} 三个），`
      + `当前取值：${dateFormat}`,
    );
  }
  return rendered;
};

/**
 * 一次把整份配置读出来。**只读一次、集中在启动时**：写错要在服务起来的那一刻就吵，
 * 而不是等到她提交报单时才失败（那时没人看着日志）。
 */
const resolvePurchaseBatchNoConfig = (env = process.env) => {
  const prefix = readString(env, PURCHASE_BATCH_NO_PREFIX_ENV_KEY, DEFAULT_PURCHASE_BATCH_NO_PREFIX);
  if (!String(prefix || '').trim()) {
    throw new Error(`${PURCHASE_BATCH_NO_PREFIX_ENV_KEY} 不能是空串（它是报货批次号的开头，空串会拼出认不出的号）`);
  }
  const dateFormat = readString(
    env, PURCHASE_BATCH_NO_DATE_FORMAT_ENV_KEY, DEFAULT_PURCHASE_BATCH_NO_DATE_FORMAT,
  );
  if (!String(dateFormat || '').includes('YYYY')) {
    throw new Error(`${PURCHASE_BATCH_NO_DATE_FORMAT_ENV_KEY} 必须含 YYYY（否则不同年份的号会撞在一起），当前取值：${dateFormat}`);
  }
  // 提前把格式烤一遍：写错的话**启动就抛**，不留到生成时。
  formatBatchDate(new Date(), {
    dateFormat,
    timeZone: readString(env, PURCHASE_BATCH_NO_TIMEZONE_ENV_KEY, DEFAULT_PURCHASE_BATCH_NO_TIMEZONE),
  });
  const recognized = readList(env, PURCHASE_BATCH_NO_PREFIXES_ENV_KEY);
  const recognizedPrefixes = recognized === null
    ? [...DEFAULT_RECOGNIZED_PREFIXES]
    // ⚠️ **空串 = 显式清空**会被拦下：一个前缀都不认的话，她在群里说批次号机器人就永远"认不出"，
    //    而"认不出"是**静默**的（只回一句问清楚）。宁可启动时吵。
    : recognized;
  if (!recognizedPrefixes.length) {
    throw new Error(`${PURCHASE_BATCH_NO_PREFIXES_ENV_KEY} 至少要有一个前缀（空列表 = 群里一个批次号都认不出）`);
  }
  return Object.freeze({
    prefix: String(prefix),
    dateFormat: String(dateFormat),
    digits: readInt(env, PURCHASE_BATCH_NO_DIGITS_ENV_KEY, DEFAULT_PURCHASE_BATCH_NO_DIGITS, { min: 1, max: 10 }),
    timeZone: readString(env, PURCHASE_BATCH_NO_TIMEZONE_ENV_KEY, DEFAULT_PURCHASE_BATCH_NO_TIMEZONE),
    recognizedPrefixes: Object.freeze(recognizedPrefixes),
  });
};

/** 群里识别用的正则（全部前缀 + 日期 + **正好 N 位**数字）。每次调用新建，避免 `g` 的 lastIndex 状态。 */
const buildBatchNoPattern = (config, flags = 'g') => {
  const prefixes = (config?.recognizedPrefixes || DEFAULT_RECOGNIZED_PREFIXES).map(escapeRegExp).join('|');
  const digits = Number(config?.digits) || DEFAULT_PURCHASE_BATCH_NO_DIGITS;
  return new RegExp(`\\b(?:${prefixes})\\d{8}-\\d{${digits}}\\b`, flags);
};

module.exports = {
  PURCHASE_BATCH_NO_PREFIX_ENV_KEY,
  PURCHASE_BATCH_NO_DATE_FORMAT_ENV_KEY,
  PURCHASE_BATCH_NO_DIGITS_ENV_KEY,
  PURCHASE_BATCH_NO_TIMEZONE_ENV_KEY,
  PURCHASE_BATCH_NO_PREFIXES_ENV_KEY,
  DEFAULT_PURCHASE_BATCH_NO_PREFIX,
  DEFAULT_PURCHASE_BATCH_NO_DATE_FORMAT,
  DEFAULT_PURCHASE_BATCH_NO_DIGITS,
  DEFAULT_PURCHASE_BATCH_NO_TIMEZONE,
  DEFAULT_RECOGNIZED_PREFIXES,
  escapeRegExp,
  formatBatchDate,
  resolvePurchaseBatchNoConfig,
  buildBatchNoPattern,
};
