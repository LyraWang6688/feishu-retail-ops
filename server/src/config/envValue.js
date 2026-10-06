// 「从环境变量读一个配置值」的**唯一一套**取值规则（配置先行的那条纪律的落地件）。
//
// 为什么单独一个文件：`pendingDealPush` 与 `salesDailyReportPush` 两处都要读开关 / 时间点 /
// 群列表，规则必须是**同一套**——否则"空串算关还是不关"这类最容易静默坏掉的地方，
// 两处会慢慢走歪（一处 `||`、一处显式，谁也说不清）。
//
// ⚠️ 规则（踩过坑之后定死的）：
//   · **变量没设**（undefined / null）→ 用默认值；
//   · **变量设了**（哪怕是空串）→ 就是显式取值，空串 = false / 空列表（**关掉**）；
//   · 设成了认不出来的值 → **当场抛错**，不猜（静默按 true/false 处理是最坏的一种）。
//
// 为什么不写 `process.env.X || fallback`：`||` 把空串当"没配"，于是她清空变量想关掉时
// 会静默回退到默认值，**关不掉**——这正是仓库里 `getEnv` 那个形状踩过的坑。
//
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

const readRaw = (env, key) => {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null) return null;
  return String(raw).trim();
};

/** 显式字符串：没设 → 默认值；设了（含空串）→ 原样返回。 */
const readString = (env, key, fallback) => {
  const raw = readRaw(env, key);
  return raw === null ? fallback : raw;
};

/** 显式布尔。空串 = false（"设成空 = 关掉"），认不出来的值抛错。 */
const readFlag = (env, key, fallback) => {
  const raw = readRaw(env, key);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (value === '' || ['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${key} 必须是显式布尔（true/false/1/0/yes/no/on/off），当前值无法识别`);
};

/** 显式整数（设成空串 = 用默认值，与历史行为一致）。越界 / 非整数抛错。 */
const readInt = (env, key, fallback, { min, max }) => {
  const raw = readRaw(env, key);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}~${max} 之间的整数，当前值无法识别`);
  }
  return value;
};

/** 可选整数：**没设 / 设成空串** → null（"这一项就不要"），其余同 readInt。 */
const readOptionalInt = (env, key, { min, max }) => {
  const raw = readRaw(env, key);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}~${max} 之间的整数（或留空表示不要），当前值无法识别`);
  }
  return value;
};

/**
 * 显式列表：中英文逗号 / 分号 / 空白都算分隔符，去重且保序。
 * ⚠️ 与 readString 同一套语义：**没设** → 返回 null（调用方自己决定回退到哪儿）；
 * **设成空串** → 返回 `[]`（显式的"一个都不要"，不回退）。
 */
const readList = (env, key) => {
  const raw = readRaw(env, key);
  if (raw === null) return null;
  const items = raw.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
  return [...new Set(items)];
};

module.exports = { readRaw, readString, readFlag, readInt, readOptionalInt, readList };
