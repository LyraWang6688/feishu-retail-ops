'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchStaffRoutes } = require('../src/routes/workbench/staff');
const { resolveActor, requirePermission } = require('../src/services/authorizationService');

const DAY = (value) => Date.parse(value + 'T00:00:00+08:00');
const AT = (value) => Date.parse(value + '+08:00');

const makeGateway = () => {
  const calls = { create: [], update: [], delete: [] };
  const staffRows = [
    { record_id: 'staff_admin', fields: { 姓名: [{ id: 'ou_admin', name: '管理员甲' }], 角色: [{ record_ids: ['role_admin'], text: '管理员' }], 在职: true } },
    { record_id: 'staff_emp', fields: { 姓名: [{ id: 'ou_emp', name: '店员乙' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: true } },
    { record_id: 'staff_off', fields: { 姓名: [{ id: 'ou_off', name: '离职丙' }], 角色: [{ record_ids: ['role_emp'], text: '店员' }], 在职: false } },
  ];
  const roleRows = [
    { record_id: 'role_admin', fields: { 角色: '管理员', 权限说明: '' } },
    { record_id: 'role_emp', fields: { 角色: '店员', 权限说明: '' } },
  ];
  const attendance = [
    { record_id: 'att_admin', fields: { 姓名: [{ record_ids: ['staff_admin'] }], 考勤人: [{ id: 'ou_admin' }], 出勤日: DAY('2026-11-25'), 开始时间: AT('2026-11-25T09:00:00'), 结束时间: AT('2026-11-25T18:00:00'), 工时: 9 } },
    { record_id: 'att_emp', fields: { 姓名: [{ record_ids: ['staff_emp'] }], 考勤人: [{ id: 'ou_emp' }], 出勤日: DAY('2026-11-25'), 开始时间: AT('2026-11-25T10:00:00'), 结束时间: AT('2026-11-25T16:00:00'), 工时: 6 } },
  ];
  const tables = {
    staff: { fields: { name: '姓名', role: '角色', active: '在职' } },
    staffRole: { fields: { name: '角色', note: '权限说明' } },
    attendance: { fields: { date: '出勤日', hours: '工时', startAt: '开始时间', endAt: '结束时间', staff: '姓名', staffUser: '考勤人' } },
  };
  return {
    calls,
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

test('人员目录：管理员/店员/离职/不在花名册', async () => {
  const gateway = makeGateway();
  assert.equal((await resolveActor({ gateway, openId: 'ou_admin' })).role, '管理员');
  assert.equal((await resolveActor({ gateway, openId: 'ou_emp' })).role, '店员');
  assert.equal(await resolveActor({ gateway, openId: 'ou_off' }), null, '离职拒绝');
  assert.equal(await resolveActor({ gateway, openId: 'ou_missing' }), null, '不在花名册拒绝');
});

test('权限矩阵：店员不能写考勤', () => {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let called = false;
  requirePermission('attendance.write')({ workbenchActor: { role: '店员' } }, res, () => { called = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});

test('店员只能看本人考勤；管理员看全员', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const emp = await fetch(base + '/staff/attendance?from=2026-11-01&to=2026-11-30', { headers: { 'x-test-openid': 'ou_emp' } });
    const empBody = await emp.json();
    assert.equal(emp.status, 200);
    assert.deepEqual(empBody.attendance.map((row) => row.recordId), ['att_emp']);

    const admin = await fetch(base + '/staff/attendance?from=2026-11-01&to=2026-11-30', { headers: { 'x-test-openid': 'ou_admin' } });
    const adminBody = await admin.json();
    assert.deepEqual(adminBody.attendance.map((row) => row.recordId).sort(), ['att_admin', 'att_emp']);
  });
});

test('不在花名册/离职 ⇒ 403', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const missing = await fetch(base + '/staff/me', { headers: { 'x-test-openid': 'ou_missing' } });
    assert.equal(missing.status, 403);
    const off = await fetch(base + '/staff/me', { headers: { 'x-test-openid': 'ou_off' } });
    assert.equal(off.status, 403);
  });
});

test('店员写考勤 403；管理员写考勤 201 且工时自动算', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const body = JSON.stringify({ staffRecordId: 'staff_emp', date: '2026-11-25', start: '09:00', end: '18:00' });
    const denied = await fetch(base + '/staff/attendance', { method: 'POST', headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' }, body });
    assert.equal(denied.status, 403);

    const created = await fetch(base + '/staff/attendance', { method: 'POST', headers: { 'x-test-openid': 'ou_admin', 'content-type': 'application/json' }, body });
    assert.equal(created.status, 201);
    assert.equal(gateway.calls.create.length, 1);
    assert.equal(gateway.calls.create[0].fields.staff[0], 'staff_emp');
    assert.equal(gateway.calls.create[0].fields.staffUser[0].id, 'ou_emp');
    assert.equal(gateway.calls.create[0].fields.hours, 9);
  });
});

test('管理员改角色走 staff.write；店员 403', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const payload = JSON.stringify({ roleRecordId: 'role_admin' });
    const denied = await fetch(base + '/staff/staff_emp', { method: 'PATCH', headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' }, body: payload });
    assert.equal(denied.status, 403);
    const ok = await fetch(base + '/staff/staff_emp', { method: 'PATCH', headers: { 'x-test-openid': 'ou_admin', 'content-type': 'application/json' }, body: payload });
    assert.equal(ok.status, 200);
    assert.equal(gateway.calls.update.length, 1);
    assert.equal(gateway.calls.update[0].fields.role[0], 'role_admin');
  });
});
