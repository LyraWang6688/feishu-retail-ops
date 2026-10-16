// 「货 / 钱分离」（task-62）的**唯一一个开关** + 这一刀用到的那几个会话标记。
//
// ⭐ 业务负责人的口径（2026-10-16，逐字）：
//   「我们实际上**货和资金是可以分开的**，但用的是**一个销售单号把它们绑定在一块**。
//    我们的**销售主表和销售明细，只要货品信息那一页填完，里面的金额就是定了的**。
//    但金额定了之后，**什么时候付款、分几次付、付款方式是什么，是在资金页里面去确定的**：
//    · 如果资金页里写了，收款明细就能写 · 如果资金页里没写，那就是待补充状态」
//   ⇒ 她随后明确选：「**按你说的：货品页填完就建单**」。
//
// 今天（main）与要改成什么：
//   【今天】点**资金页**那颗按钮才建单（货 + 钱一起写）⇒ 走到资金页时表里一个字都没有；
//   【要改成】① 提交货品信息（进资金页那一刻）⇒ **就建单**（单号 + 主表总金额/现货预订 + 明细逐件），
//            🔴 **不写收款明细**；② 资金页 ⇒ **用同一个销售单号**，只决定钱。
//
// 🔴 本模块**只是那个开关**（配置先行）：它**不做任何业务判断**，
//    也不 import 任何 service（config 层保持纯函数、零依赖）。
//
// 🔴 开关纪律（本仓被这条坑过）：
//   · **必须是显式布尔**（走 `config/envValue` 的 `readFlag`）——
//     **不许**写 `process.env.X || 默认`：`||` 会把"清空变量"当"没配"⇒ **关不掉** ✗；
//   · **缺省 = `false`（关）** ⇒ 关着时**与今天逐字一致**（硬红线：页面 HTML 逐字节、
//     写入点/顺序/参数 `deepEqual` 一个都不许变）；
//   · **取值时机**：`resolveSaleMoneySplitConfig()` 是**调用时**读 `process.env` 的
//     （**不是模块加载时**）—— 本仓 2026-10-06 出过"模块级求值早于 `dotenv.config()`"
//     的静默失效事故（见 AGENTS.md《改动 app.js 顶部的 require 顺序》那条）；
//     调用时读没有这个坑，而且用例可以直接注入 `env` 验"换配置即换行为"。
const { readFlag } = require('./envValue');

const ENABLED_ENV_KEY = 'SCAN_MONEY_SPLIT_ENABLED';

/**
 * 会话里用来记「货那一半已经落库」的标记取值（走 `scanSessionService` 的既有 `saveDraftLines`）。
 *
 * ⚠️ 与**今天**那两个既有标记（`pending` = 到资金页、`created` = 这一单已经建过）
 *    是**三个不同的状态**，不许混用（混了之后"她点过没有"就分不清）：
 *      · `pending`        —— 今天就有：她点过「提交这一单」、还没建单；
 *      · `goods_created`  —— 本卡新增：**货已经落库**（主表 + 明细），钱还没写；
 *      · `created`        —— 今天就有：**这一单的收款也写过了**（或跳过时按"一分没收到"结掉）。
 */
const SESSION_MARKERS = Object.freeze({
  goodsCreated: 'goods_created',
});

/**
 * 读这一刀的配置。
 *
 * @param {object} [env] 环境变量（**可注入** ⇒ 用例能验"换配置即换行为"，不碰全局）
 * @returns {{ enabled: boolean, markers: {goodsCreated: string}, envKey: string }}
 */
const resolveSaleMoneySplitConfig = (env = process.env) => ({
  // ⚠️ 缺省 `false`：显式布尔（设成空串 / `false` / `0` ⇒ 关；认不出的值当场抛）。
  enabled: readFlag(env, ENABLED_ENV_KEY, false),
  markers: SESSION_MARKERS,
  envKey: ENABLED_ENV_KEY,
});

module.exports = {
  ENABLED_ENV_KEY,
  SESSION_MARKERS,
  resolveSaleMoneySplitConfig,
};
