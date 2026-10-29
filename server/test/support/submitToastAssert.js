'use strict';

/**
 * ⭐⭐ 2026-10-29（业务负责人：「数据提交成功，后台自动写入，统一都是这个」＋「以后就没有成功页了」）：
 * **提交成功回执**的判据共用件 —— 全仓只有这一处断言"回执长什么样"。
 *
 * 她要的回执（四条提交链统一）：**303 回工作台** ＋ `?toast=<那一句>`（`shared/toast.js` 显示 5 秒）。
 * ⚠️ 以前各用例自己写 `res.status === 200` + 读成功页 HTML ⇒ 现在统一改成调本函数
 *   （文案 / 落点 / 参数名全部从**配置**读 ⇒ 改一句话不用改测试 ✓）。
 */

const assert = require('node:assert/strict');
const { SUBMIT_TOAST } = require('../../src/config/submitToast');

/** 断言"这一发是一次提交成功回执"：303 + 落点 = 配置里的工作台 + toast = 统一那一句。 */
const assertSubmitToast = (res, message = '') => {
  const where = message ? `${message}｜` : '';
  assert.equal(res.status, 303, `${where}提交成功 ⇒ 303 回工作台（PRG · 刷新不重复提交 ✓ 实得 ${res.status}）`);
  const location = String(res.headers.get('location') || '');
  assert.ok(location.startsWith(SUBMIT_TOAST.path),
    `${where}落点必须是配置里的工作台（${SUBMIT_TOAST.path}），实得 ${location || '(空)'}`);
  const url = new URL(location, 'http://local.invalid');
  assert.equal(url.searchParams.get(SUBMIT_TOAST.param), SUBMIT_TOAST.text,
    `${where}toast 文案必须是统一那一句（${SUBMIT_TOAST.text}）`);
  return url;
};

module.exports = { assertSubmitToast };
