'use strict';

/**
 * 点击人 user token 内存缓存（2026-11-10 业务负责人：「所有者，可以是谁点击属于谁吗？
 * 不能算来财的」）—— 只放内存、过期即丢、退出登录清掉、**不进日志**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  saveUserAccessToken, getUserAccessToken, clearUserAccessToken,
  resetUserAccessTokenStoreForTests, setNowForTests,
} = require('../src/services/workbenchUserTokenStore');

test.afterEach(() => resetUserAccessTokenStoreForTests());

test('AC-OT1 存/取：按 open_id 取回，拿不到就是空串', () => {
  assert.equal(saveUserAccessToken('ou_a', 'ut_a', 7200), true);
  assert.equal(getUserAccessToken('ou_a'), 'ut_a');
  assert.equal(getUserAccessToken('ou_b'), '', '没有 token 的 open_id ⇒ 空串（回落 tenant）');
  assert.equal(getUserAccessToken(''), '');
  assert.equal(saveUserAccessToken('', 'ut_x', 7200), false);
  assert.equal(saveUserAccessToken('ou_c', '', 7200), false);
});

test('AC-OT2 过期即丢：按 expires_in 提前 60 秒作废（过期后取到空串）', () => {
  let now = 1_000_000;
  setNowForTests(() => now);
  // expires_in = 120 秒 ⇒ 安全 60 秒 ⇒ 实际 60 秒后过期
  assert.equal(saveUserAccessToken('ou_a', 'ut_a', 120), true);
  assert.equal(getUserAccessToken('ou_a'), 'ut_a');
  now += 60_000; // 到点（提前 60 秒的边界）
  assert.equal(getUserAccessToken('ou_a'), '', '过期后不许再把旧 token 传出去');
  assert.equal(getUserAccessToken('ou_a'), '', '再取一次仍然是空（已删除）');
});

test('AC-OT3 退出登录清掉；清掉后取不到', () => {
  saveUserAccessToken('ou_a', 'ut_a', 7200);
  assert.equal(clearUserAccessToken('ou_a'), true);
  assert.equal(getUserAccessToken('ou_a'), '');
  assert.equal(clearUserAccessToken('ou_a'), false, '已不存在 ⇒ false（不抛）');
});
