'use strict';

/**
 * ⭐⭐ task-62【货 / 钱分离】**接线**的判据（设计文档 `docs/sale-money-split-recon-and-design-2026-10-16.md` §5 改动 A）。
 *
 * 本刀**只接线** ✗ 不改冻结件 ✓（`deferFunds` 是阶段二 #763 已在冻结件里就位的能力 ✓）。
 *
 * 判据：
 *   **AC-MSW1**：⭐ **开关关着 ⇒ 一个字节都不走新路** —— `config/saleMoneySplit.js` 缺省 `false` ✓
 *     且路由那段的闸门是 **`=== true`**（不是真值判断 ✗ —— `'false'` 字符串这类会被真值判断放过 ✗）
 *   **AC-MSW2**：⭐ **货那一跑的参数口径**：`payments: []`（**不许带收款** ✓）· `deferFunds: true` ✓ ·
 *     `lineAmounts`（与今天同一取值口径 ✓）· 且**不带** `paymentStatus` / `paidAmount`（那是钱那半的事 ✓）
 *   **AC-MSW3**：⭐ **账实相符**：`resolveSaleMoneySplitConfig({})` ⇒ `enabled === false` ✓（环境变量没设时）
 *     且 `.env.example` **已登记**该键 ✓（文档 §4.2 说"接线一落就该登记" ✓）
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

/** 取出"接线那一段"（从闸门那行到它之后 20 行 ✓ 够覆盖那次 submitSale 调用 ✓）。 */
const wireBlock = () => {
  const lines = routesSrc().split('\n');
  const at = lines.findIndex((l) => l.includes('resolveSaleMoneySplitConfig().enabled === true'));
  assert.ok(at >= 0, '接线段的闸门不见了 ✗（`resolveSaleMoneySplitConfig().enabled === true`）');
  return lines.slice(at, at + 20).join('\n');
};

test('AC-MSW1 ⭐ 开关关着 ⇒ 一个字节都不走新路（缺省 false ＋ 闸门必须是 `=== true`）', () => {
  const cfg = fs.readFileSync(CFG, 'utf8');
  assert.ok(/readFlag\(env, ENABLED_ENV_KEY, false\)/.test(cfg), '缺省必须是 `false` ✗');
  assert.ok(/enabled === true/.test(wireBlock()), '闸门必须是**显式** `=== true` ✗（真值判断会放过 `\'false\'` 这类 ✗）');
  const { resolveSaleMoneySplitConfig } = require('../src/config/saleMoneySplit');
  assert.equal(resolveSaleMoneySplitConfig({}).enabled, false, '环境变量没设 ⇒ **关** ✓');
  assert.equal(resolveSaleMoneySplitConfig({ SCAN_MONEY_SPLIT_ENABLED: '' }).enabled, false, '空串 = 关 ✓');
  assert.equal(resolveSaleMoneySplitConfig({ SCAN_MONEY_SPLIT_ENABLED: 'false' }).enabled, false, '`false` = 关 ✓');
  assert.equal(resolveSaleMoneySplitConfig({ SCAN_MONEY_SPLIT_ENABLED: 'true' }).enabled, true, '`true` = 开 ✓');
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

test('AC-MSW3 ⭐ `.env.example` 已登记该键（接线一落就登记 ✓）', () => {
  const env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  assert.ok(/^SCAN_MONEY_SPLIT_ENABLED=false$/m.test(env), '`.env.example` 必须登记 `SCAN_MONEY_SPLIT_ENABLED=false` ✓');
});
