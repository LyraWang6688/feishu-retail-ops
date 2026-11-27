'use strict';

const express = require('express');
const { createWorkbenchStaffRoutes } = require('../../src/routes/workbench/staff');
const { shanghaiDayOf, shanghaiDayStart, addDays } = require('../../src/utils/shanghaiDay');

const DAY = (value) => Date.parse(value + 'T00:00:00+08:00');
const AT = (value) => Date.parse(value + '+08:00');
const todayKey = () => shanghaiDayOf(Date.now());
const todayStart = () => shanghaiDayStart(todayKey());
const yesterdayStart = () => shanghaiDayStart(addDays(todayKey(), -1));

const makeGateway = () => {
  const calls = { create: [], update: [], delete: [] };
  const staffRows = [
    { record_id: 'staff_admin', fields: { 姓名: [{ id: 'ou_admin', name: '管理员甲' }], 角色: [{ record_ids: ['role_admin'], text: '管理员' }], 在职: true, 是否考勤: true } },
    { record_id: 'staff_emp', fields: { 姓名: [{ id: 'ou_emp', name: '店员乙' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: true } },
    { record_id: 'staff_att', fields: { 姓名: [{ id: 'ou_att', name: '赵瑞玲' }], 角色: [{ record_ids: ['role_admin'], text: '管理员' }, { record_ids: ['role_att'], text: '考勤人' }], 在职: true, 是否考勤: false } },
    { record_id: 'staff_att_only', fields: { 姓名: [{ id: 'ou_att_only', name: '纯考勤人' }], 角色: [{ record_ids: ['role_att'], text: '考勤人' }], 在职: true, 是否考勤: false } },
    { record_id: 'staff_combo', fields: { 姓名: [{ id: 'ou_combo', name: '合并角色' }], 角色: [{ record_ids: ['role_admin', 'role_att'], text: '管理员,考勤人' }], 在职: true, 是否考勤: true } },
    { record_id: 'staff_noatt', fields: { 姓名: [{ id: 'ou_noatt', name: '不考勤丁' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true, 是否考勤: false } },
    { record_id: 'staff_off', fields: { 姓名: [{ id: 'ou_off', name: '离职丙' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: false, 是否考勤: false } },
  ];
  const roleRows = [
    { record_id: 'role_admin', fields: { 角色: '管理员', 权限说明: '' } },
    { record_id: 'role_emp', fields: { 角色: '店员', 权限说明: '' } },
    { record_id: 'role_att', fields: { 角色: '考勤人', 权限说明: '' } },
  ];
  const attendance = [
    { record_id: 'att_admin', fields: { 姓名: [{ record_ids: ['staff_admin'] }], 考勤人: [{ id: 'ou_admin' }], 出勤日: DAY('2026-11-25'), 开始时间: AT('2026-11-25T09:00:00'), 结束时间: AT('2026-11-25T18:00:00'), 工时: 9 } },
    { record_id: 'att_emp', fields: { 姓名: [{ record_ids: ['staff_emp'] }], 考勤人: [{ id: 'ou_emp' }], 出勤日: DAY('2026-11-25'), 开始时间: AT('2026-11-25T10:00:00'), 结束时间: AT('2026-11-25T16:00:00'), 工时: 6 } },
  ];
  const tables = {
    staff: { fields: { name: '姓名', role: '角色', active: '在职', attendance: '是否考勤' } },
    staffRole: { fields: { name: '角色', note: '权限说明' } },
    attendance: { fields: { date: '出勤日', hours: '工时', startAt: '开始时间', endAt: '结束时间', staff: '姓名', staffUser: '考勤人' } },
  };
  return {
    calls,
    attendance,
    staffRows,
    roleRows,
    table: (key) => tables[key],
    listAll: async (key) => {
      if (key === 'staff') return staffRows;
      if (key === 'staffRole') return roleRows;
      if (key === 'attendance') return attendance;
      return [];
    },
    get: async (key, id) => {
      if (key === 'staff') return staffRows.find((row) => row.record_id === id) || null;
      if (key === 'attendance') return attendance.find((row) => row.record_id === id) || null;
      return null;
    },
    create: async (key, fields) => { calls.create.push({ key, fields }); return { recordId: 'att_new' }; },
    update: async (key, id, fields) => { calls.update.push({ key, id, fields }); return { record_id: id }; },
    delete: async (key, id) => { calls.delete.push({ key, id }); return { record_id: id }; },
  };
};

const makeApp = (gateway) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: req.get('x-test-openid') || 'ou_emp' }; next(); });
  app.use('/staff', createWorkbenchStaffRoutes({ options: { gateway } }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  server.keepAliveTimeout = 1;
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

module.exports = { DAY, AT, todayKey, todayStart, yesterdayStart, makeGateway, makeApp, withServer };
