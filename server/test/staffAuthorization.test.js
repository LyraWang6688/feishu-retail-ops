'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActor } = require('../src/services/authorizationService');
const { DAY, todayStart, makeGateway, makeApp, withServer } = require('./support/staffFixtures');

test('人员目录：管理员/店员/离职/不在花名册', async () => {
  const gateway = makeGateway();
  assert.equal((await resolveActor({ gateway, openId: 'ou_admin' })).role, '管理员');
  assert.equal((await resolveActor({ gateway, openId: 'ou_emp' })).role, '店员');
  assert.equal(await resolveActor({ gateway, openId: 'ou_off' }), null, '离职拒绝');
  assert.equal(await resolveActor({ gateway, openId: 'ou_missing' }), null, '不在花名册拒绝');
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

test('未勾选「是否考勤」⇒ 列表不返回、也不能加考勤', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const roster = await fetch(base + '/staff', { headers: { 'x-test-openid': 'ou_admin' } });
    const body = await roster.json();
    const ids = body.staff.map((item) => item.recordId);
    assert.ok(ids.includes('staff_admin') && ids.includes('staff_emp'));
    assert.equal(ids.includes('staff_noatt'), false, '未勾选考勤的人不返回');
    assert.equal(ids.includes('staff_off'), false, '离职的人不返回');

    const denied = await fetch(base + '/staff/attendance', {
      method: 'POST',
      headers: { 'x-test-openid': 'ou_admin', 'content-type': 'application/json' },
      body: JSON.stringify({ staffRecordId: 'staff_noatt', date: '2026-11-25', start: '09:00', end: '18:00' }),
    });
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /未开启考勤/);
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

test('店员写考勤 403；管理员写考勤 201，考勤人字段写实际操作人', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const body = JSON.stringify({ staffRecordId: 'staff_emp', date: '2026-11-25', start: '09:00', end: '18:00' });
    const denied = await fetch(base + '/staff/attendance', { method: 'POST', headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' }, body });
    assert.equal(denied.status, 403);

    const created = await fetch(base + '/staff/attendance', { method: 'POST', headers: { 'x-test-openid': 'ou_admin', 'content-type': 'application/json' }, body });
    assert.equal(created.status, 201);
    assert.equal(gateway.calls.create.length, 1);
    assert.equal(gateway.calls.create[0].fields.staff[0], 'staff_emp');
    assert.equal(gateway.calls.create[0].fields.staffUser[0].id, 'ou_admin', '谁点的就写谁');
    assert.equal(gateway.calls.create[0].fields.hours, 9);
  });
});

test('读接口走权限矩阵（源码哨兵：不许再写 actor.role === 管理员）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workbench', 'staff.js'), 'utf8');
  assert.match(src, /canAny\(actor\.roleNames, 'attendance\.read\.all'\)/);
  assert.match(src, /canAny\(actor\.roleNames, 'attendance\.read\.self'\)/);
  assert.match(src, /canAny\(roles, 'attendance\.clock\.any'\)/);
  assert.match(src, /Array\.isArray\(actor\.roleNames\) && actor\.roleNames\.length/);
  assert.equal((src.match(/actor\.role === ROLES\.ADMIN/g) || []).length, 0, '不再按单角色硬编码');
});

test('上班：开始-only 创建、已有今天进行中拒绝', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const created = await fetch(base + '/staff/attendance/clock-in', {
      method: 'POST',
      headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' },
      body: JSON.stringify({ staffRecordId: 'staff_noatt' }),
    });
    assert.equal(created.status, 201, '店员只能给自己上班，body 里的别人被忽略');
    assert.equal(gateway.calls.create.length, 1);
    assert.equal(gateway.calls.create[0].fields.staff[0], 'staff_emp');
    assert.equal(gateway.calls.create[0].fields.staffUser[0].id, 'ou_emp');
    assert.equal(gateway.calls.create[0].fields.date, todayStart());
    assert.equal(gateway.calls.create[0].fields.endAt, undefined, '开始-only 不写结束');
    assert.equal(gateway.calls.create[0].fields.hours, undefined, '进行中工时不写');

    gateway.attendance.push({
      record_id: 'att_open',
      fields: {
        姓名: [{ record_ids: ['staff_emp'] }],
        考勤人: [{ id: 'ou_emp' }],
        出勤日: todayStart(),
        开始时间: todayStart() + 60000,
      },
    });
    const again = await fetch(base + '/staff/attendance/clock-in', {
      method: 'POST',
      headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /进行中/);
  });
});

test('下班：只回填今天的记录并算工时', async () => {
  const gateway = makeGateway();
  gateway.attendance.push({
    record_id: 'att_open',
    fields: {
      姓名: [{ record_ids: ['staff_emp'] }],
      考勤人: [{ id: 'ou_emp' }],
      出勤日: todayStart(),
      开始时间: todayStart() + 60000,
    },
  });
  await withServer(makeApp(gateway), async (base) => {
    const done = await fetch(base + '/staff/attendance/clock-out', {
      method: 'POST',
      headers: { 'x-test-openid': 'ou_emp', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(done.status, 200);
    const update = gateway.calls.update.find((item) => item.key === 'attendance' && item.id === 'att_open');
    assert.ok(update, '要回填到今天的记录');
    assert.ok(update.fields.endAt > 0);
    assert.ok(update.fields.hours > 0);
    assert.equal(update.fields.staffUser, undefined, '下班不覆盖上班打卡的操作人');
  });
});
