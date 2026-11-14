'use strict';

/**
 * #61：金额解析 / 上海日 helper 的**唯一实现**（2026-11-14 收口）。
 *
 *   AC-U1 `toCents` 不可解析 ⇒ null；`toCentsOrZero` ⇒ 0（语义写在名字里）
 *   AC-U2 带货币符号/千分位/空格也认；四舍五入到分
 *   AC-U3 上海日：epoch / 日期串 / Date / 秒级时间戳；非法 ⇒ ''
 *   AC-U4 addDays / shanghaiDayStart / shanghaiDateTimeText
 *   AC-U5 旧的 6 份 helper 已改成 import 同一实现（源码哨兵，不再各写一份）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toCents, toCentsOrZero } = require('../src/utils/money');
const {
  shanghaiDayOf, shanghaiDayKeyOf, shanghaiDayKeyOfDate, addDays, shanghaiDayStart, shanghaiDateTimeText,
} = require('../src/utils/shanghaiDay');

test('AC-U1 toCents 非法 ⇒ null；toCentsOrZero ⇒ 0', () => {
  assert.equal(toCents(''), null);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents(Number.NaN), null);
  assert.equal(toCentsOrZero(''), 0);
  assert.equal(toCentsOrZero('abc'), 0);
  assert.equal(toCents(85.4), 8540);
  assert.equal(toCents('47.4'), 4740);
});

test('AC-U2 货币符号 / 千分位 / 空格 / 四舍五入', () => {
  assert.equal(toCents('¥1,234.56'), 123456);
  assert.equal(toCents(' 85.4 '), 8540);
  assert.equal(toCents('0.005'), 1);
  assert.equal(toCents('85.4', { clean: false }), 8540);
});

test('AC-U3 上海日：多种输入', () => {
  assert.equal(shanghaiDayOf(Date.UTC(2026, 9, 31, 16, 30)), '2026-11-01');
  assert.equal(shanghaiDayKeyOf('2026-11-01'), '2026-11-01');
  assert.equal(shanghaiDayKeyOf('2026-11-01T16:30:00Z'), '2026-11-02');
  assert.equal(shanghaiDayKeyOf(1793462400000), '2026-11-01');
  assert.equal(shanghaiDayKeyOf('1793462400'), '2026-11-01', '10 位秒级时间戳也要认');
  assert.equal(shanghaiDayKeyOf(new Date(Date.UTC(2026, 10, 1, 0, 0))), '2026-11-01');
  assert.equal(shanghaiDayKeyOfDate(new Date('bad')), '');
  assert.equal(shanghaiDayKeyOf(''), '');
});

test('AC-U4 addDays / dayStart / 时间文案', () => {
  assert.equal(addDays('2026-11-01', 5), '2026-11-06');
  assert.equal(addDays('bad', 1), '');
  assert.equal(shanghaiDayStart('2026-11-01'), Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(shanghaiDateTimeText(Date.UTC(2026, 10, 1, 6, 5)), '2026-11-01 14:05');
  assert.equal(shanghaiDateTimeText(''), '');
});

test('AC-U5 旧 helper 已改为 import 同一实现（源码哨兵）', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [
    'config/dataSince.js',
    'utils/salesDateWindows.js',
    'services/scanPageService.js',
    'services/voucherSettlementService.js',
    'services/douyin/voucherCatalogSync.js',
    'services/writeAuditService.js',
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(source, /require\('[^']*shanghaiDay'\)/, `${rel} 必须 import utils/shanghaiDay`);
  }
  for (const rel of [
    'config/groupBuyVouchers.js',
    'routes/scanPage/setup.js',
    'routes/scanPage/handlers/payment.js',
    'services/scanWrite/helpers.js',
    'services/voucherPaymentService.js',
    'services/douyin/voucherCatalogSync.js',
    'services/voucherSettlementService.js',
  ]) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(source, /require\('[^']*money'\)/, `${rel} 必须 import utils/money`);
  }
});
