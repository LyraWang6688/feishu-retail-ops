'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActor, requirePermission } = require('../src/services/authorizationService');
const { StaffDirectoryService } = require('../src/services/staffDirectoryService');
const { permissionsOfRoles, canAny } = require('../src/config/permissions');
const { makeGateway, makeApp, withServer } = require('./support/staffFixtures');

test('多角色：两个 cell 与合并文本都能读全，权限取并集', async () => {
  const gateway = makeGateway();
  const att = await resolveActor({ gateway, openId: 'ou_att' });
  assert.deepEqual(att.roleNames, ['管理员', '考勤人'], '两个角色都要读到');
  assert.equal(att.role, '管理员', 'role 保留第一个兼容旧代码');
  assert.ok(att.permissions.includes('attendance.write'), '管理员权限保留');
  assert.ok(att.permissions.includes('attendance.clock.any'), '考勤人可以代打卡');
  assert.ok(att.permissions.includes('attendance.read.all'), '考勤人可以看全员');

  const combo = await resolveActor({ gateway, openId: 'ou_combo' });
  assert.deepEqual(combo.roleNames, ['管理员', '考勤人'], '合并文本也要拆开');

  const staff = await new StaffDirectoryService({ gateway }).listStaff();
  const comboStaff = staff.find((item) => item.recordId === 'staff_combo');
  assert.deepEqual(comboStaff.roleIds, ['role_admin', 'role_att']);
  assert.equal(comboStaff.roleName, '管理员');
});

test('权限矩阵：多角色并集；考勤人只加看全员 + 代打卡', () => {
  const attOnly = permissionsOfRoles(['考勤人']);
  assert.ok(attOnly.includes('attendance.read.all'));
  assert.ok(attOnly.includes('attendance.clock.self'));
  assert.ok(attOnly.includes('attendance.clock.any'));
  assert.equal(attOnly.includes('attendance.write'), false, '考勤人不能改/删');
  assert.equal(canAny(['考勤人'], 'attendance.write'), false);
  assert.ok(permissionsOfRoles(['管理员', '考勤人']).includes('attendance.write'), '管理员 + 考勤人仍是管理员权限');

  const denied = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let called = false;
  requirePermission('attendance.write')({ workbenchActor: { role: '考勤人', roleNames: ['考勤人'] } }, denied, () => { called = true; });
  assert.equal(denied.statusCode, 403);
  assert.equal(called, false);

  const allowed = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let next = false;
  requirePermission('attendance.write')({ workbenchActor: { role: '管理员', roleNames: ['管理员', '考勤人'] } }, allowed, () => { next = true; });
  assert.equal(next, true, '管理员角色应放行');
});

test('考勤人看全员考勤和花名册', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const list = await fetch(base + '/staff/attendance?from=2026-11-01&to=2026-11-30', { headers: { 'x-test-openid': 'ou_att' } });
    const body = await list.json();
    assert.equal(list.status, 200);
    assert.deepEqual(body.attendance.map((row) => row.recordId).sort(), ['att_admin', 'att_emp']);

    const roster = await fetch(base + '/staff', { headers: { 'x-test-openid': 'ou_att' } });
    const rosterBody = await roster.json();
    assert.equal(roster.status, 200);
    const ids = rosterBody.staff.map((item) => item.recordId);
    assert.ok(ids.includes('staff_admin') && ids.includes('staff_emp'));
    assert.equal(ids.includes('staff_att'), false, '考勤人自己没勾是否考勤，不进入人员卡');
  });
});
