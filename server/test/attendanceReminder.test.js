'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAttendanceReminderService } = require('../src/services/attendanceReminderService');

const makeGateway = () => {
  const tables = {
    staff: { fields: { name: '姓名', role: '角色', active: '在职', attendance: '是否考勤' } },
    staffRole: { fields: { name: '角色', note: '权限说明' } },
    attendance: { fields: { date: '出勤日', hours: '工时', startAt: '开始时间', endAt: '结束时间', staff: '姓名', staffUser: '考勤人' } },
  };
  const staff = [
    { record_id: 'staff_admin', fields: { 姓名: [{ id: 'ou_admin', name: '王颖' }], 角色: [{ record_ids: ['role_admin'], text: '管理员' }], 在职: true, 是否考勤: true } },
    { record_id: 'staff_peng', fields: { 姓名: [{ id: 'ou_peng', name: '赵瑞鹏' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: true } },
    { record_id: 'staff_wang', fields: { 姓名: [{ id: 'ou_wang', name: '王奥' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: false } },
  ];
  const roles = [
    { record_id: 'role_admin', fields: { 角色: '管理员' } },
    { record_id: 'role_emp', fields: { 角色: '店员' } },
  ];
  const attendance = [
    { record_id: 'att_open', fields: { 姓名: [{ record_ids: ['staff_peng'] }], 考勤人: [{ id: 'ou_peng' }], 出勤日: Date.parse('2026-11-27T00:00:00+08:00'), 开始时间: Date.parse('2026-11-27T09:00:00+08:00') } },
  ];
  return {
    table: (key) => tables[key],
    listAll: async (key) => {
      if (key === 'staff') return staff;
      if (key === 'staffRole') return roles;
      if (key === 'attendance') return attendance;
      return [];
    },
  };
};

const makeNotifier = () => {
  const sent = [];
  return {
    sent,
    send: async (event, data, options) => { sent.push({ event, data, options }); return { ok: true }; },
  };
};

test('18:00 后只提醒仍有进行中记录、且勾选考勤的人；当天不重复', async () => {
  const gateway = makeGateway();
  const notifier = makeNotifier();
  let now = Date.parse('2026-11-27T18:10:00+08:00');
  const service = createAttendanceReminderService({ gateway, notifications: notifier, now: () => now });

  assert.deepEqual(await service.run(), { sent: 1 });
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].options.target.receiveId, 'ou_peng');
  assert.match(notifier.sent[0].data.text, /赵瑞鹏/);

  assert.deepEqual(await service.run(), { sent: 0 }, '同一天不重复');
  now = Date.parse('2026-11-28T18:10:00+08:00');
  assert.deepEqual(await service.run(), { sent: 0 }, '昨天的未下班记录不再每天催');
});

test('已下班/未勾选考勤的人不提醒', async () => {
  const gateway = makeGateway();
  gateway.listAll = async (key) => {
    if (key === 'staff') return [
      { record_id: 'staff_admin', fields: { 姓名: [{ id: 'ou_admin', name: '王颖' }], 角色: [{ record_ids: ['role_admin'], text: '管理员' }], 在职: true, 是否考勤: true } },
      { record_id: 'staff_wang', fields: { 姓名: [{ id: 'ou_wang', name: '王奥' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: false } },
    ];
    if (key === 'staffRole') return [{ record_id: 'role_admin', fields: { 角色: '管理员' } }, { record_id: 'role_emp', fields: { 角色: '店员' } }];
    if (key === 'attendance') return [
      { record_id: 'att_done', fields: { 姓名: [{ record_ids: ['staff_admin'] }], 出勤日: Date.parse('2026-11-27T00:00:00+08:00'), 开始时间: Date.parse('2026-11-27T09:00:00+08:00'), 结束时间: Date.parse('2026-11-27T18:00:00+08:00'), 工时: 9 } },
      { record_id: 'att_wang', fields: { 姓名: [{ record_ids: ['staff_wang'] }], 出勤日: Date.parse('2026-11-27T00:00:00+08:00'), 开始时间: Date.parse('2026-11-27T09:00:00+08:00') } },
    ];
    return [];
  };
  const notifier = makeNotifier();
  const service = createAttendanceReminderService({
    gateway, notifications: notifier, now: () => Date.parse('2026-11-27T18:10:00+08:00'),
  });
  assert.deepEqual(await service.run(), { sent: 0 });
  assert.equal(notifier.sent.length, 0);
});

test('昨天有未结束记录：今天不再提醒', async () => {
  const gateway = makeGateway();
  gateway.listAll = async (key) => {
    if (key === 'staff') return [
      { record_id: 'staff_peng', fields: { 姓名: [{ id: 'ou_peng', name: '赵瑞鹏' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: true } },
    ];
    if (key === 'staffRole') return [
      { record_id: 'role_admin', fields: { 角色: '管理员' } },
      { record_id: 'role_emp', fields: { 角色: '店员' } },
    ];
    if (key === 'attendance') return [
      { record_id: 'att_old', fields: { 姓名: [{ record_ids: ['staff_peng'] }], 考勤人: [{ id: 'ou_peng' }], 出勤日: Date.parse('2026-11-26T00:00:00+08:00'), 开始时间: Date.parse('2026-11-26T09:00:00+08:00') } },
    ];
    return [];
  };
  const notifier = makeNotifier();
  const service = createAttendanceReminderService({
    gateway, notifications: notifier, now: () => Date.parse('2026-11-27T18:10:00+08:00'),
  });
  assert.deepEqual(await service.run(), { sent: 0 });
  assert.equal(notifier.sent.length, 0);
});
