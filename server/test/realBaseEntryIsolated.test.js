'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人实测反馈）：「真实测试 Base 的资金页验证」三条红——
 *   根因 = **默认 `pnpm test` 会把真实 Base 用例和单测混在同一次运行**：
 *   单测预加载先塞 `tbl_test_*`，真实 Base 用例的 `.env` 不覆盖已有值 ⇒ `TableIdNotFound (1254041)`。
 *   ⇒ 本用例钉住"两个入口必须分开"：
 *     · 默认 `pnpm test` **只收 `test/*.test.js`**（不含 `test/realbase/`）；
 *     · 真实 Base 用例只能从 `pnpm run test:realbase` 进（且它自带"目标 ≠ 测试 Base ⇒ 拒绝跑"的闸门）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));

test('默认 test 入口不含真实 Base 用例（`tbl_test_*` 预加载不会污染它）', () => {
  assert.ok(pkg.scripts.test, '必须有 test 脚本');
  assert.equal(/realbase/i.test(pkg.scripts.test), false,
    '默认 `pnpm test` **不许**收真实 Base 用例（会与 tbl_test_* 预加载冲突 ⇒ TableIdNotFound）');
  assert.ok(pkg.scripts.test.includes('test/*.test.js'), '默认入口仍是 `test/*.test.js`（与既有 CI 一致）');
  assert.equal(fs.existsSync(path.join(SERVER, 'test', 'scanMoneyPageTwoStepVerify.test.js')), false,
    '真实 Base 用例不许再留在 test/ 顶层');
});

test('真实 Base 用例走独立入口，且仍带「目标 Base = 测试 Base」安全闸门', () => {
  assert.ok(pkg.scripts['test:realbase'], '必须有 test:realbase 入口');
  assert.ok(pkg.scripts['test:realbase'].includes('test/realbase/*.test.js'),
    'test:realbase 只跑 test/realbase/ 下的用例');
  const source = fs.readFileSync(path.join(SERVER, 'test', 'realbase', 'scanMoneyPageTwoStepVerify.test.js'), 'utf8');
  assert.match(source, /FEISHU_V1_E2E_TEST_APP_TOKEN/, '必须要求授权测试 Base');
  assert.match(source, /目标 Base ≠ 授权测试 Base/, '必须有"目标 ≠ 测试 Base ⇒ 拒绝跑"的安全闸门');
  assert.match(source, /SKIP/, '缺凭证时必须可跳过（CI 不跑真实 Base）');
});
