'use strict';

const { readInt, readString } = require('./envValue');

/**
 * ⭐⭐ **「提交成功」统一回执 = toast**（业务负责人 2026-10-29 定稿）。
 *
 * 她的口径（逐字）：
 *   「**数据提交成功，后台自动写入**，统一都是这个」
 *   ＋「以后就没有成功页了」
 *
 * 为什么做成**一份配置 + 一个共用件**（`utils/submitToast.js`）：
 *   · 扫码页有 4 条提交链（销售 / 补货 / 采购退货 / 采购多货），以前各写一段
 *     （销售回工作台 toast、其余回一张整页"成功页"）⇒ 同一个事实两种长相 ✗；
 *   · 工作台那边（以及以后任何提交入口）也要能**直接复用**这套回执 ⇒ 只认这一份配置 ✓
 *     （调用方不写中文、不拼 URL、不关心 303/编码/缓存头 ✗）。
 *
 * 🔴 **文案唯一真源就在本文件**：`数据提交成功，后台自动写入`。
 *   ⚠️ 它**不带单号**（这是她的明确口径）——单号在订单列表里看，不在 toast 里。
 *   ⚠️ 它是**文案不是开关**：清空 env 会回到缺省那一句（文案的"清空"没有"关掉"的语义）；
 *      要换一句话改 `SUBMIT_TOAST_TEXT` 即可，**不用改代码** ✓。
 *   ⚠️ 与 `config/scanSuccessPage.js`（已随成功页一起退场）**不是**同一件事：
 *      那一句是成功页正文（`已提交成功，数据会更新`）；现在是 toast，用本文件这一句。
 *
 * ⚠️ 落点默认 = 工作台首页（`/workbench/`）：她提交完**直接回工作台**看列表/继续干活
 *   （销售 2026-10-27 起就是这么走的 ✓；本轮把其余三条链一起统一过来）。
 *   前端**不用改**：`public/workbench/shared/toast.js` 本来就读 `?toast=` 并显示 5 秒 ✓。
 */

/** 缺省那一句（她的原话；别处不许再抄一份 ✗）。 */
const DEFAULT_SUBMIT_TOAST_TEXT = '数据提交成功，后台自动写入';

/** 承诺范围：只允许本系统自己的工作台（站内相对路径）——落点写在配置里，也不许写成外站。 */
const DEFAULT_SUBMIT_TOAST_PATH = '/workbench/';

const SUBMIT_TOAST = Object.freeze({
  /** 统一文案（唯一真源）。 */
  text: readString(process.env, 'SUBMIT_TOAST_TEXT', DEFAULT_SUBMIT_TOAST_TEXT),
  /** 提交成功后回哪个页面（站内相对路径；非 `/` 开头 / 跨站 / 带反斜杠 ⇒ 共用件回落到缺省）。 */
  path: readString(process.env, 'SUBMIT_TOAST_PATH', DEFAULT_SUBMIT_TOAST_PATH),
  /** toast 的 URL 参数名 —— 与 `public/workbench/shared/toast.js` 逐字一致（改这里前端要同步）。 */
  param: readString(process.env, 'SUBMIT_TOAST_PARAM', 'toast'),
  /** 单号那个 URL 参数名（沿用既有 `done`；只作排查/漏斗关联，**不在页面上显示**）。 */
  noticeKey: readString(process.env, 'SUBMIT_TOAST_NOTICE_KEY', 'done'),
  /** 文案上限（防 URL 过长 / 手滑塞进一大段）：超出**截断**，不报错（回执不该拦她）。 */
  maxTextLength: readInt(process.env, 'SUBMIT_TOAST_MAX_LENGTH', 120, { min: 8, max: 300 }),
});

module.exports = { SUBMIT_TOAST, DEFAULT_SUBMIT_TOAST_TEXT, DEFAULT_SUBMIT_TOAST_PATH };
