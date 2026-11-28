'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { todayKey, todayStart, yesterdayStart, makeGateway, makeApp, withServer } = require('./support/staffFixtures');

const post = (base, path, openId, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'x-test-openid': openId, 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

test('纯考勤人可代打卡：写被考勤人的记录，考勤人字段写操作人', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const created = await post(base, '/staff/attendance/clock-in', 'ou_att_only', { staffRecordId: 'staff_emp' });
    assert.equal(created.status, 201);
    assert.equal(gateway.calls.create.length, 1);
    assert.equal(gateway.calls.create[0].fields.staff[0], 'staff_emp');
    assert.equal(gateway.calls.create[0].fields.staffUser[0].id, 'ou_att_only', '代打卡写操作人');
    assert.equal(gateway.calls.create[0].fields.date, todayStart());
  });
});

test('纯考勤人没有 attendance.write：不能手工新增考勤', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const denied = await post(base, '/staff/attendance', 'ou_att_only', {
      staffRecordId: 'staff_emp', date: '2026-11-25', start: '09:00', end: '18:00',
    });
    assert.equal(denied.status, 403);
    assert.equal(gateway.calls.create.length, 0);
  });
});

test('自定义新增：结束留空 => 只记上班（进行中），不写默认下班时间', async () => {
  const gateway = makeGateway();
  await withServer(makeApp(gateway), async (base) => {
    const created = await post(base, '/staff/attendance', 'ou_admin', {
      staffRecordId: 'staff_emp', date: todayKey(), start: '09:00', end: '',
    });
    assert.equal(created.status, 201);
    assert.equal(gateway.calls.create[0].fields.endAt, undefined);
    assert.equal(gateway.calls.create[0].fields.hours, undefined);
  });
});

test('编辑清空结束时间 => 真正改回进行中（endAt/hours 置空）', async () => {
  const gateway = makeGateway();
  gateway.attendance.push({
    record_id: 'att_closed',
    fields: {
      姓名: [{ record_ids: ['staff_emp'] }],
      考勤人: [{ id: 'ou_emp' }],
      出勤日: todayStart(),
      开始时间: todayStart() + 9 * 3600000,
      结束时间: todayStart() + 18 * 3600000,
      工时: 9,
    },
  });
  await withServer(makeApp(gateway), async (base) => {
    const res = await fetch(base + '/staff/attendance/att_closed', {
      method: 'PATCH',
      headers: { 'x-test-openid': 'ou_admin', 'content-type': 'application/json' },
      body: JSON.stringify({ staffRecordId: 'staff_emp', date: todayKey(), start: '09:00', end: '' }),
    });
    assert.equal(res.status, 200);
    const update = gateway.calls.update.find((item) => item.key === 'attendance' && item.id === 'att_closed');
    assert.ok(update);
    assert.equal(update.fields.endAt, null, '结束时间要真正清空');
    assert.equal(update.fields.hours, null, '工时也要清空');
  });
});

test('昨天有未下班记录不挡今天上班；下班只收今天', async () => {
  const gateway = makeGateway();
  gateway.attendance.push({
    record_id: 'att_old',
    fields: {
      姓名: [{ record_ids: ['staff_emp'] }],
      考勤人: [{ id: 'ou_emp' }],
      出勤日: yesterdayStart(),
      开始时间: yesterdayStart() + 9 * 3600000,
    },
  });
  await withServer(makeApp(gateway), async (base) => {
    const created = await post(base, '/staff/attendance/clock-in', 'ou_emp', {});
    assert.equal(created.status, 201, '昨天未下班不再挡住今天上班');
    assert.equal(gateway.calls.create[0].fields.date, todayStart());

    const done = await post(base, '/staff/attendance/clock-out', 'ou_emp', {});
    assert.equal(done.status, 400, '没有今天的上班记录，不能拿昨天的记录算工时');
    assert.match((await done.json()).error, /更早的未下班记录/);
    assert.equal(gateway.calls.update.length, 0);
  });
});
