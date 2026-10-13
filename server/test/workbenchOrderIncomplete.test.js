'use strict';

/**
 * ⭐⭐ 2026-10-14：工作台「**未完成，可点重试**」的**判据**（业务负责人裁定 2）。
 *
 *   incomplete = 销售状态 ∈ {未写入, 部分写入, 写入失败}
 *            或 库存状态 ∈ {未写入, 部分写入, 写入失败}
 *            或 资金状态 === 写入失败        ← ⚠️ **资金"待补"不算未完成**，只有真的"写入失败"才算
 *
 * 由来（她的口径）：「失败 ⇒ 工作台显示【未完成，可点重试】」；后台要写完的是"**明细与库存**" ✓
 * 钱可以后补 ✓（工作台本来就有"补记收款"✓）。
 *
 * 🔴 状态值**只用已拍板值域**（`config/salesStatusDimensions.js`）⇒ 本文件与实现里**不写死中文** ✗
 * 🔴 不许新造"未完成"这个**表选项** ✗ ——「未完成，可点重试」只是**界面上的话** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dims = require('../src/config/salesStatusDimensions');
const { isOrderIncomplete } = require('../src/services/v1WorkbenchService');

const WRITE = dims.SALES_STATUS_WRITE_VALUES || {};
const pick = (dimension, key) => (WRITE[dimension] && WRITE[dimension][key]) || WRITE[key];
const DONE = pick('sales', 'done');
const FAILED = pick('sales', 'failed');
const NONE = pick('sales', 'none');
const PARTIAL = pick('sales', 'partial');
const FUNDS_FAILED = pick('funds', 'failed');
const read = { done: pick('funds', 'done') };
assert.ok(DONE && FAILED && NONE && FUNDS_FAILED, '值域里必须有 none/done/failed 语义键（哨兵）');

test('AC-WR-1 ⭐⭐ 只有状态不齐才为 true；全齐 ⇒ false', () => {
  const ok = { salesStatus: DONE, stockStatus: DONE, fundsStatus: DONE };
  assert.equal(isOrderIncomplete(ok), false, '三处都"已写入" ⇒ 完成');
  for (const key of ['salesStatus', 'stockStatus']) {
    for (const value of [NONE, PARTIAL, FAILED]) {
      const row = { ...ok, [key]: value };
      assert.equal(isOrderIncomplete(row), true, `${key}=${value} ⇒ 未完成`);
    }
  }
});

test('AC-WR-2 ⭐⭐ 资金：**只有"写入失败"算未完成**（"待补"不算）', () => {
  const base = { salesStatus: DONE, stockStatus: DONE };
  assert.equal(isOrderIncomplete({ ...base, fundsStatus: FUNDS_FAILED }), true, '资金写入失败 ⇒ 未完成（那是真失败）');
  assert.equal(isOrderIncomplete({ ...base, fundsStatus: NONE }), false, '资金未写入 = 正常待补 ⇒ **不算**未完成');
  assert.equal(isOrderIncomplete({ ...base, fundsStatus: read.done }), false, '资金已写入 ⇒ 不算');
  assert.equal(isOrderIncomplete({ ...base, fundsStatus: undefined }), false, '拿不到资金状态 ⇒ 不因此判未完成');
});

test('AC-WR-3 ⭐ 拿不到的状态 ⇒ **不猜**（不因缺字段就报"未完成"）', () => {
  assert.equal(isOrderIncomplete({}), false, '整行没状态 ⇒ 不判未完成（宁可漏报也不误报 ✗）');
  assert.equal(isOrderIncomplete(null), false);
  assert.equal(isOrderIncomplete({ salesStatus: '不存在的值' }), false, '值域外的值 ⇒ 不判（不猜）');
});

test('AC-WR-4 ⭐⭐ 源码哨兵：重试路径**不许**直接调 `_confirm(` / `sales().confirm(`', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/v1WorkbenchService.js'), 'utf8');
  assert.ok(!/_confirm\(/.test(source), '重试不许直接调 `_confirm(`（它开头没有跳过判据 ⇒ 会重复写）✗');
  assert.ok(!/sales\(\)\.confirm\(/.test(source), '同样不许调 `sales().confirm(` ✗（要走 submitSale + 同一把 submitKey）');
});
