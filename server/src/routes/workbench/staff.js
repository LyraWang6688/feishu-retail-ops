'use strict';

/**
 * 工作台「人员管理 / 考勤」路由（2026-11-26）。
 *
 * 权限：actor 由父 router 的 loadWorkbenchActor 注入；写操作走 requirePermission。
 * 口径：
 *   · 管理员：读写全员；
 *   · 考勤人：看全员 + 替别人上班/下班打卡（不给改/删）；
 *   · 店员：只读本人、只打本人的卡（服务端强制，不信任前端传的 staffRecordId）。
 *
 * 2026-11-27：
 *   · 一人多角色 ⇒ 用 canAny(actor.roleNames, …) 判断，不再看 actor.role 单值；
 *   · 考勤记录的「考勤人」= 实际操作人（代打卡写考勤人，不写被考勤人）；
 *   · 上班/下班/下班提醒只看今天，旧记录不再把工时算成几十小时。
 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { relation } = require('../../services/v1ReferenceResolver');
const { StaffDirectoryService } = require('../../services/staffDirectoryService');
const { loadWorkbenchActor, requirePermission } = require('../../services/authorizationService');
const { canAny, ROLES } = require('../../config/permissions');
const { ATTENDANCE_PROMPT } = require('../../config/attendancePrompt');
const { evaluateAttendancePrompt, shanghaiHour } = require('../../services/attendancePromptService');
const { STAFF_TEXTS } = require('../../config/workbenchStaff');
const { shanghaiDayOf, shanghaiDayStart, addDays } = require('../../utils/shanghaiDay');
const { logInfo, logError } = require('../../utils/logger');

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const firstCell = (value) => (Array.isArray(value) ? value[0] : value);
const linkedIdOf = (value) => {
  const cell = firstCell(value);
  if (!cell) return '';
  const ids = cell.record_ids || cell.link_record_ids || (cell.record_id ? [cell.record_id] : []);
  return String((Array.isArray(ids) ? ids[0] : ids) || '').trim();
};
const epochOf = (date, time) => {
  const ms = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isFinite(ms) ? ms : null;
};
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const createWorkbenchStaffRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  const gateway = options.gateway || new V1BitableGateway();
  const directory = new StaffDirectoryService({ gateway });
  // staff 路由自身也保证有 actor（独立挂载/测试时可用）。
  router.use(loadWorkbenchActor({ gateway }));

  const attendanceFields = () => gateway.table('attendance').fields;
  const mapAttendance = (row) => {
    const fields = attendanceFields();
    const user = firstCell(row.fields?.[fields.staffUser]) || {};
    return {
      recordId: row.record_id,
      staffRecordId: linkedIdOf(row.fields?.[fields.staff]),
      // 「考勤人」= 实际操作人（谁点的就写谁），不是被考勤对象。
      operatorOpenId: String(user.id || '').trim(),
      date: Number(row.fields?.[fields.date]) || 0,
      startAt: Number(row.fields?.[fields.startAt]) || 0,
      endAt: Number(row.fields?.[fields.endAt]) || 0,
      hours: Number(row.fields?.[fields.hours]) || 0,
    };
  };

  router.get('/me', (req, res) => res.json({ success: true, actor: req.workbenchActor }));

  router.get('/', async (req, res) => {
    try {
      const all = await directory.listStaff();
      const actor = req.workbenchActor;
      const readAll = canAny(actor.roleNames, 'attendance.read.all');
      const readSelf = canAny(actor.roleNames, 'attendance.read.self');
      if (!readAll && !readSelf) {
        return res.status(403).json({ success: false, error: STAFF_TEXTS.roleForbidden });
      }
      const attending = all.filter((item) => item.attend);
      const staff = readAll ? attending : attending.filter((item) => item.recordId === actor.recordId);
      return res.json({ success: true, staff });
    } catch (error) {
      logError('workbench.staff.list.failed', { error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  router.get('/attendance', async (req, res) => {
    try {
      const actor = req.workbenchActor;
      const today = shanghaiDayOf(Date.now());
      const from = isDay(req.query.from) ? req.query.from : addDays(today, -13);
      const to = isDay(req.query.to) ? req.query.to : today;
      if (from > to) throw badRequest(STAFF_TEXTS.badRange);
      const rows = await gateway.listAll('attendance');
      const attendingIds = new Set((await directory.listStaff())
        .filter((item) => item.attend).map((item) => item.recordId));
      const fromAt = shanghaiDayStart(from);
      const toAt = shanghaiDayStart(to) + 86400000 - 1;
      const readAll = canAny(actor.roleNames, 'attendance.read.all');
      const readSelf = canAny(actor.roleNames, 'attendance.read.self');
      if (!readAll && !readSelf) {
        return res.status(403).json({ success: false, error: STAFF_TEXTS.roleForbidden });
      }
      let list = (rows || []).map(mapAttendance)
        .filter((row) => row.date >= fromAt && row.date <= toAt && attendingIds.has(row.staffRecordId));
      if (!readAll) {
        // 本人：按被考勤对象；旧数据里考勤人=本人，也一并兼容。
        list = list.filter((row) => row.staffRecordId === actor.recordId || row.operatorOpenId === actor.openId);
      } else if (req.query.staffRecordId) {
        list = list.filter((row) => row.staffRecordId === String(req.query.staffRecordId));
      }
      list.sort((left, right) => left.date - right.date || left.startAt - right.startAt);
      return res.json({ success: true, from, to, attendance: list });
    } catch (error) {
      logError('workbench.staff.attendance.list.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  // 9 点考勤弹窗：只读；前端拿到 shouldPrompt / managed 后自己弹。
  router.get('/attendance/prompt', async (req, res) => {
    try {
      const actor = req.workbenchActor;
      const now = Date.now();
      const today = shanghaiDayOf(now);
      const todayStart = shanghaiDayStart(today);
      const roleNames = Array.isArray(actor.roleNames) ? actor.roleNames : [];
      const mustRead = ATTENDANCE_PROMPT.enabled
        && shanghaiHour(now) >= ATTENDANCE_PROMPT.hour
        && (actor.attend || roleNames.includes(ROLES.ATTENDANCE));
      // 9 点前 / 功能关闭 / 既不是被考勤人也不是考勤人：不读整张考勤表。
      if (!mustRead) {
        return res.json({ success: true, ...evaluateAttendancePrompt({
          actor, staff: [], clockedInIds: new Set(), now, date: today, config: ATTENDANCE_PROMPT,
        }) });
      }
      const rows = await gateway.listAll('attendance');
      const clockedInIds = new Set((rows || []).map(mapAttendance)
        .filter((row) => row.date === todayStart && row.startAt > 0)
        .map((row) => row.staffRecordId));
      const staff = await directory.listStaff();
      const data = evaluateAttendancePrompt({
        actor, staff, clockedInIds, now, date: today, config: ATTENDANCE_PROMPT,
      });
      return res.json({ success: true, ...data });
    } catch (error) {
      logError('workbench.staff.prompt.failed', { error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  const readPayload = (body = {}) => {
    const date = String(body.date || '').trim();
    const start = String(body.start || '').trim();
    const end = String(body.end || '').trim();
    if (!isDay(date)) throw badRequest(STAFF_TEXTS.badRange);
    if (!/^\d{2}:\d{2}$/.test(start)) throw badRequest(STAFF_TEXTS.badTime);
    const dateAt = shanghaiDayStart(date);
    const startAt = epochOf(date, start);
    if (!Number.isFinite(dateAt) || startAt == null) throw badRequest(STAFF_TEXTS.badTime);
    let endAt = 0;
    let hours = 0;
    if (end) {
      if (!/^\d{2}:\d{2}$/.test(end)) throw badRequest(STAFF_TEXTS.badTime);
      endAt = epochOf(date, end);
      if (endAt == null || endAt <= startAt) throw badRequest(STAFF_TEXTS.badTime);
      hours = Math.round(((endAt - startAt) / 3600000) * 10) / 10;
    }
    return { date, dateAt, startAt, endAt, hours };
  };

  const targetStaffOf = async (req, staffRecordId) => {
    const actor = req.workbenchActor;
    const roles = Array.isArray(actor.roleNames) && actor.roleNames.length ? actor.roleNames : actor.role;
    const anyStaff = canAny(roles, 'attendance.clock.any');
    const id = anyStaff ? String(staffRecordId || actor.recordId) : actor.recordId;
    const staff = (await directory.listStaff()).find((item) => item.recordId === id);
    if (!staff) throw badRequest(STAFF_TEXTS.staffMissing);
    if (!staff.active) throw badRequest(STAFF_TEXTS.staffInactive);
    if (!staff.attend) throw badRequest(STAFF_TEXTS.staffNotAttending);
    return staff;
  };

  const unfinishedOf = async (staffRecordId, dayStart) => {
    const rows = await gateway.listAll('attendance');
    return (rows || []).map(mapAttendance)
      .filter((row) => row.staffRecordId === staffRecordId && !row.endAt
        && (dayStart == null || row.date === dayStart))
      .sort((left, right) => right.startAt - left.startAt)[0] || null;
  };

  const activeStaffOf = async (recordId) => {
    const staff = (await directory.listStaff()).find((item) => item.recordId === String(recordId || ''));
    if (!staff) throw badRequest(STAFF_TEXTS.staffMissing);
    if (!staff.active) throw badRequest(STAFF_TEXTS.staffInactive);
    if (!staff.attend) throw badRequest(STAFF_TEXTS.staffNotAttending);
    return staff;
  };

  router.post('/attendance/clock-in', requirePermission('attendance.clock.self'), async (req, res) => {
    try {
      const staff = await targetStaffOf(req, req.body?.staffRecordId);
      const now = Date.now();
      const todayStart = shanghaiDayStart(shanghaiDayOf(now));
      if (await unfinishedOf(staff.recordId, todayStart)) throw badRequest(STAFF_TEXTS.alreadyClockedIn);
      const actor = req.workbenchActor;
      const created = await gateway.create('attendance', {
        staff: relation(staff.recordId),
        // 谁点的就写谁：本人点=本人；考勤人代打卡=考勤人。
        staffUser: [{ id: actor.openId }],
        date: todayStart,
        startAt: now,
      });
      logInfo('workbench.staff.clock.in', { record_id: created.recordId, staff_record_id: staff.recordId });
      return res.status(201).json({ success: true, recordId: created.recordId, startAt: now });
    } catch (error) {
      logError('workbench.staff.clock.in.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  router.post('/attendance/clock-out', requirePermission('attendance.clock.self'), async (req, res) => {
    try {
      const staff = await targetStaffOf(req, req.body?.staffRecordId);
      const now = Date.now();
      const todayStart = shanghaiDayStart(shanghaiDayOf(now));
      const open = await unfinishedOf(staff.recordId, todayStart);
      if (!open) {
        const older = await unfinishedOf(staff.recordId, null);
        if (older) throw badRequest(STAFF_TEXTS.oldOpenAttendance);
        throw badRequest(STAFF_TEXTS.noOpenAttendance);
      }
      if (now <= open.startAt) throw badRequest(STAFF_TEXTS.badTime);
      const hours = Math.round(((now - open.startAt) / 3600000) * 10) / 10;
      await gateway.update('attendance', open.recordId, { endAt: now, hours });
      logInfo('workbench.staff.clock.out', { record_id: open.recordId, staff_record_id: staff.recordId, hours });
      return res.json({ success: true, recordId: open.recordId, endAt: now, hours });
    } catch (error) {
      logError('workbench.staff.clock.out.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  router.post('/attendance', requirePermission('attendance.write'), async (req, res) => {
    try {
      const staff = await activeStaffOf(req.body?.staffRecordId);
      const payload = readPayload(req.body);
      const actor = req.workbenchActor;
      const created = await gateway.create('attendance', {
        staff: relation(staff.recordId),
        staffUser: [{ id: actor.openId }],
        date: payload.dateAt,
        startAt: payload.startAt,
        ...(payload.endAt ? { endAt: payload.endAt, hours: payload.hours } : {}),
      });
      logInfo('workbench.staff.attendance.created', {
        record_id: created.recordId, staff_record_id: staff.recordId, date: payload.date, hours: payload.hours,
      });
      return res.status(201).json({ success: true, recordId: created.recordId, hours: payload.hours });
    } catch (error) {
      logError('workbench.staff.attendance.create.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  router.patch('/attendance/:recordId', requirePermission('attendance.write'), async (req, res) => {
    try {
      const recordId = String(req.params.recordId || '');
      const existing = await gateway.get('attendance', recordId);
      if (!existing) throw badRequest(STAFF_TEXTS.recordNotFound);
      const payload = readPayload(req.body);
      const hasEndField = Object.prototype.hasOwnProperty.call(req.body || {}, 'end');
      const patch = { date: payload.dateAt, startAt: payload.startAt };
      if (payload.endAt) {
        patch.endAt = payload.endAt;
        patch.hours = payload.hours;
      } else if (hasEndField) {
        // 编辑时把结束时间清空 ⇒ 真正改回“进行中”，不能沿用旧的 endAt/hours。
        // 飞书「更新记录」把字段设为 null 即清空（日期/数字都适用）。
        patch.endAt = null;
        patch.hours = null;
      }
      await gateway.update('attendance', recordId, patch);
      logInfo('workbench.staff.attendance.updated', {
        record_id: recordId, date: payload.date, hours: patch.hours,
      });
      return res.json({ success: true, recordId, hours: patch.hours });
    } catch (error) {
      logError('workbench.staff.attendance.update.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  router.delete('/attendance/:recordId', requirePermission('attendance.write'), async (req, res) => {
    try {
      const recordId = String(req.params.recordId || '');
      await gateway.delete('attendance', recordId);
      logInfo('workbench.staff.attendance.deleted', { record_id: recordId });
      return res.json({ success: true });
    } catch (error) {
      logError('workbench.staff.attendance.delete.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createWorkbenchStaffRoutes };
