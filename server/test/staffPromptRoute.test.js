'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGateway, makeApp, withServer } = require('./support/staffFixtures');

test('考勤弹窗接口：本人/考勤人/无关管理员都能取到自己的判定', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const emp = await fetch(base + '/staff/attendance/prompt', { headers: { 'x-test-openid': 'ou_emp' } });
    const empBody = await emp.json();
    assert.equal(emp.status, 200);
    assert.equal(empBody.success, true);
    assert.equal(empBody.self.recordId, 'staff_emp');
    assert.ok(Array.isArray(empBody.managed));

    const att = await fetch(base + '/staff/attendance/prompt', { headers: { 'x-test-openid': 'ou_att' } });
    const attBody = await att.json();
    assert.equal(att.status, 200);
    assert.equal(attBody.self.recordId, 'staff_att');
    assert.ok(Array.isArray(attBody.managed));

    const admin = await fetch(base + '/staff/attendance/prompt', { headers: { 'x-test-openid': 'ou_admin' } });
    const adminBody = await admin.json();
    assert.equal(admin.status, 200);
    assert.equal(adminBody.self.recordId, 'staff_admin');
    assert.ok(Array.isArray(adminBody.managed));
  });
});

test('不在花名册/离职 ⇒ 弹窗接口 403', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const missing = await fetch(base + '/staff/attendance/prompt', { headers: { 'x-test-openid': 'ou_missing' } });
    assert.equal(missing.status, 403);
    const off = await fetch(base + '/staff/attendance/prompt', { headers: { 'x-test-openid': 'ou_off' } });
    assert.equal(off.status, 403);
  });
});
