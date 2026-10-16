'use strict';

/**
 * ⭐⭐ task-62【货 / 钱分离】**接线**的判据（设计文档 `docs/sale-money-split-recon-and-design-2026-10-16.md` §5 改动 A）。
 *
 * 本刀**只接线** ✗ 不改冻结件 ✓（`deferFunds` 是阶段二 #763 已在冻结件里就位的能力 ✓）。
 *
 * 判据：
 *   **AC-MSW1**：⭐⭐ **没有开关了 ⇒ 货/钱分离永远开** —— 配置里不许再有开关名/那个变量名/`readFlag` ✗
 *     且路由那段**不再有闸门**（老分支删净 ⇒ 那段永远跑 ✓）
 *   **AC-MSW2**：⭐ **货那一跑的参数口径**：`payments: []`（**不许带收款** ✓）· `deferFunds: true` ✓ ·
 *     `lineAmounts`（与今天同一取值口径 ✓）· 且**不带** `paymentStatus` / `paidAmount`（那是钱那半的事 ✓）
 *   **AC-MSW3**：⭐ **反向哨兵**：配置里没有 `enabled` 键 ✓ ＋ `.env.example` 里那一行**已删** ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const ROUTES = path.join(SERVER, 'src', 'routes', 'scanPage', 'index.js');
const CFG = path.join(SERVER, 'src', 'config', 'saleMoneySplit.js');
const ENV_EXAMPLE = path.join(SERVER, '..', '.env.example');

const routesSrc = () => fs.readFileSync(ROUTES, 'utf8');

/**
 * 取出"接线那一段" —— ⚠️ **成对迁移**：改前锚在闸门那行（`…enabled === true`）✗ 闸门删掉后不能再用它
 * ⇒ 改后锚在**货那一跑自己的参数**上（`deferFunds: true`）＋ 前后各取几行 ✓
 */
const wireBlock = () => {
  const lines = routesSrc().split('\n');
  const at = lines.findIndex((l) => l.includes('deferFunds: true'));
  assert.ok(at >= 0, '接线那一段不见了 ✗（`deferFunds: true`）');
  return lines.slice(Math.max(0, at - 3), at + 26).join('\n');
};

test('AC-MSW1 ⭐⭐ 反向哨兵：**没有开关了**（货/钱分离永远开 · 老分支删净 ✓）', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`AC-MSW1 ⭐ 开关关着 ⇒ 一个字节都不走新路`（钉 `readFlag(env, ENABLED_ENV_KEY, false)` ＋ 闸门 `=== true`）
  //   改后逐字：本用例 —— 开关退场 ⇒ 钉"**配置里没有它**"＋"**路由里没有闸门**" ✓
  //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**把新功能都上了，不需要开关。**」✓
  const SWITCH_NAME = ['SCAN', 'MONEY', 'SPLIT', 'ENABLED'].join('_');
  const cfgCode = fs.readFileSync(CFG, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.equal(cfgCode.includes(SWITCH_NAME), false, '🔴 开关名不许回来 ✗');
  assert.equal(cfgCode.includes('ENABLED_ENV_KEY'), false, '🔴 那个变量名也不许回来 ✗');
  assert.equal(/readFlag\(/.test(cfgCode), false, '🔴 这里不再有开关 ⇒ 也不该再有 `readFlag` ✗');
  const { resolveSaleMoneySplitConfig } = require('../src/config/saleMoneySplit');
  assert.equal('enabled' in resolveSaleMoneySplitConfig(), false, '配置里不许再有 `enabled`（开关退了 ✗）');
  // ⚠️ 判**原始文本**（不去注释）—— 路由里那条"改前逐字"的留痕**已经拆开写**（`…().` ＋ `enabled === true`）
  //   ⇒ 原件里现在**一个** `resolveSaleMoneySplitConfig` 都不该有：既没有闸门、也没有那个配置入口 ✓
  //   🔴 为什么不去注释：那个正则会被文件里字符串中的 `/*` / `//` 带偏（实测：会把真代码当注释吞掉 ✗）
  assert.equal(routesSrc().includes('resolveSaleMoneySplitConfig'), false,
    '🔴 路由里那条闸门（以及那个配置入口）不许回来 ✗');
  assert.ok(/deferFunds:\s*true/.test(wireBlock()), '货那一跑照旧要走（永远跑 ✓）');
});

test('AC-MSW2 ⭐ 货那一跑的参数口径：`payments: []` ＋ `deferFunds: true` ＋ `lineAmounts`（不带钱那半的键）', () => {
  const block = wireBlock();
  assert.ok(/deferFunds:\s*true/.test(block), '货那一跑必须显式 `deferFunds: true` ✗');
  assert.ok(/payments:\s*\[\]/.test(block), '货那一跑必须 `payments: []`（**不许带收款** ✗）');
  assert.ok(/lineAmounts,/.test(block), '货那一跑必须带 `lineAmounts`（与今天同一取值口径 ✓）');
  assert.equal(/paymentStatus\s*:/.test(block), false, '货那一跑**不许**带 `paymentStatus` ✗（那是钱那半的键 ✓）');
  assert.equal(/paidAmount\s*:/.test(block), false, '货那一跑**不许**带 `paidAmount` ✗');
  // 🔴 失败必须如实（不许带着空单号当成功 ✗）
  assert.ok(/goods\.ok !== true\)\s*return respondWriteFailure/.test(block.replace(/\s+/g, ' ')),
    '货那一跑失败必须 `respondWriteFailure` 如实回报 ✗');
});

test('AC-MSW3 ⭐⭐ 反向哨兵：`.env.example` 里那一行**已删**（代码删净后没人读 ✓）', () => {
  // ⚠️ 成对迁移：改前逐字 `assert.ok(/^SCAN_MONEY_SPLIT_ENABLED=false$/m.test(env), …)`
  //   ⇒ 改后逐字本用例；依据 = 她 2026-10-16 22:5x「把新功能都上了，不需要开关」✓
  //   ＋ ⭐ 线上 `.env` 那几行**不动**（她/Lead 的令 ✓ —— 那是部署之外的事 ✗）
  const SWITCH_NAME = ['SCAN', 'MONEY', 'SPLIT', 'ENABLED'].join('_');
  const env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  assert.equal(new RegExp('^' + SWITCH_NAME + '=', 'm').test(env), false,
    '🔴 `.env.example` 里那一行必须已删（留着 = 又给了一个没人读的开关 ✗）');
});
