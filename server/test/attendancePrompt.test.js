'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAttendancePrompt } = require('../src/services/attendancePromptService');

const AT = (value) => Date.parse(value + '+08:00');
const CONFIG = { enabled: true, hour: 9 };
const SUBJECT = { recordId: 'staff_peng', name: '赵瑞鹏', active: true, attend: true, roleNames: ['店员'] };
const MANAGER = { recordId: 'staff_zhao', name: '赵瑞玲', active: true, attend: false, roleNames: ['管理员', '考勤人'] };
const ADMIN = { recordId: 'staff_ying', name: '王颖', active: true, attend: false, roleNames: ['管理员'] };
const ROSTER = [
  SUBJECT,
  MANAGER,
  ADMIN,
  { recordId: 'staff_wang', name: '王奥', active: true, attend: false, roleNames: ['店员'] },
];

const run = (overrides = {}) => evaluateAttendancePrompt({
  actor: SUBJECT,
  staff: ROSTER,
  clockedInIds: new Set(),
  now: AT('2026-11-27T09:10:00'),
  date: '2026-11-27',
  config: CONFIG,
  ...overrides,
});

test('9 点前不弹', () => {
  const result = run({ now: AT('2026-11-27T08:59:00') });
  assert.equal(result.afterHour, false);
  assert.equal(result.self.shouldPrompt, false);
  assert.deepEqual(result.managed, []);
});

test('9 点后本人未打卡 => 弹自己', () => {
  const result = run();
  assert.equal(result.afterHour, true);
  assert.deepEqual(result.self, {
    recordId: 'staff_peng', name: '赵瑞鹏', clockedIn: false, shouldPrompt: true,
  });
  assert.deepEqual(result.managed, []);
});

test('本人已打卡 => 不弹', () => {
  const result = run({ clockedInIds: new Set(['staff_peng']) });
  assert.equal(result.self.clockedIn, true);
  assert.equal(result.self.shouldPrompt, false);
});

test('没勾「是否考勤」=> 不弹自己', () => {
  const result = run({ actor: { ...SUBJECT, attend: false } });
  assert.equal(result.self.shouldPrompt, false);
});

test('考勤人 => 列出未打卡对象，不含自己/未勾考勤', () => {
  const result = run({ actor: MANAGER });
  assert.equal(result.self.shouldPrompt, false);
  assert.deepEqual(result.managed, [{ recordId: 'staff_peng', name: '赵瑞鹏' }]);
});

test('考勤人：对象已打卡 => 列表为空', () => {
  const result = run({ actor: MANAGER, clockedInIds: new Set(['staff_peng']) });
  assert.deepEqual(result.managed, []);
});

test('管理员但不是考勤人 => 不列管理者名单', () => {
  const result = run({ actor: ADMIN });
  assert.equal(result.self.shouldPrompt, false);
  assert.deepEqual(result.managed, []);
});

test('考勤人自己也是被考勤人：self 与 managed 不重复', () => {
  const result = run({ actor: { ...MANAGER, attend: true } });
  assert.equal(result.self.shouldPrompt, true);
  assert.deepEqual(result.managed, [{ recordId: 'staff_peng', name: '赵瑞鹏' }]);
});

test('功能关闭 => 都不弹', () => {
  const result = run({ config: { enabled: false, hour: 9 } });
  assert.equal(result.self.shouldPrompt, false);
  assert.deepEqual(result.managed, []);
});
