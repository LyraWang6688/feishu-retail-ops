// 回填口径（config/salesStatusBackfill）：一次性回填的**纯函数**验收。
//
// 口径是业务负责人 2026-10-06 逐字定的：
//   已入账 → 资金状态=已写入 · 入账失败 → 写入失败 · 入账中 → 未写入
//   待确认 → 确认状态=未确认 · 已取消 → 已取消 · 待修改 → 待修改
//   「销售状态」「库存状态」不回填；新列已有值不覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_STATUS_BACKFILL_MAP,
  planSalesStatusBackfill,
} = require('../src/config/salesStatusBackfill');
const {
  SALES_STATUS_VALUE_DOMAINS,
  SALES_STATUS_WRITE_VALUES,
} = require('../src/config/salesStatusDimensions');

test('口径逐字钉死：六个旧值 → 六条目标（其余一律不动）', () => {
  assert.deepEqual(Object.keys(SALES_STATUS_BACKFILL_MAP).sort(),
    ['入账中', '入账失败', '已入账', '已取消', '待修改', '待确认'].sort());
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '已入账' }).patch, { funds: '已写入' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '入账失败' }).patch, { funds: '写入失败' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '入账中' }).patch, { funds: '未写入' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '待确认' }).patch, { userAction: '未确认' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '已取消' }).patch, { userAction: '已取消' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '待修改' }).patch, { userAction: '待修改' });
});

test('口径里写出去的值必须落在值域里（改值域忘改口径，这里当场红）', () => {
  for (const target of Object.values(SALES_STATUS_BACKFILL_MAP)) {
    for (const [dimension, value] of Object.entries(target)) {
      assert.ok(SALES_STATUS_VALUE_DOMAINS[dimension].includes(value),
        `${dimension}='${value}' 不在值域里`);
      assert.ok(Object.values(SALES_STATUS_WRITE_VALUES[dimension]).includes(value),
        `${dimension}='${value}' 不是代码登记过的写入值`);
    }
  }
});

test('不该动的四种情况：空旧值 / 未知旧值 / 已是目标值 / 新列已有别的值', () => {
  // 她的表里「待确认」之外的旧值可能还有别的（她自己加的选项）：不认识的**不猜**。
  assert.equal(planSalesStatusBackfill({ legacyConfirm: '' }).action, 'skip_empty_legacy');
  assert.equal(planSalesStatusBackfill({ legacyConfirm: '   ' }).action, 'skip_empty_legacy');
  assert.equal(planSalesStatusBackfill({ legacyConfirm: '已作废' }).action, 'skip_unmapped');
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '已作废' }).patch, {});

  const done = planSalesStatusBackfill({ legacyConfirm: '已入账', funds: '已写入' });
  assert.equal(done.action, 'already_up_to_date');
  assert.deepEqual(done.patch, {});

  // 🔴 新列已经有**别的**值 → **绝不覆盖**：回填没有资格推翻销售/售后刚写进去的事实。
  const conflict = planSalesStatusBackfill({ legacyConfirm: '已入账', funds: '写入失败' });
  assert.equal(conflict.action, 'skip_has_value');
  assert.deepEqual(conflict.patch, {});
  assert.deepEqual(conflict.blocked, ['funds']);
});

test('归一化：多写空格/换行不影响识别（表里存的就是"已入账"这三个字）', () => {
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: ' 已入账 ' }).patch, { funds: '已写入' });
  assert.deepEqual(planSalesStatusBackfill({ legacyConfirm: '已 入 账' }).patch, { funds: '已写入' });
});

test('幂等：按计划写完之后再算一次，应该一条都不用改', () => {
  for (const [legacy, target] of Object.entries(SALES_STATUS_BACKFILL_MAP)) {
    const second = planSalesStatusBackfill({
      legacyConfirm: legacy,
      userAction: target.userAction || '',
      funds: target.funds || '',
    });
    assert.equal(second.action, 'already_up_to_date', legacy);
  }
});

test('「销售状态」「库存状态」不在回填范围内（没有直接来源，另行处理）', () => {
  for (const legacy of Object.keys(SALES_STATUS_BACKFILL_MAP)) {
    const patch = planSalesStatusBackfill({ legacyConfirm: legacy }).patch;
    assert.equal(patch.sales, undefined, `${legacy} 不该回填销售状态`);
    assert.equal(patch.stock, undefined, `${legacy} 不该回填库存状态`);
  }
});
