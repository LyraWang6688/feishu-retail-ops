'use strict';

/**
 * 工作台「人员管理 / 考勤」路由（2026-11-26）。
 *
 * 权限：actor 由父 router 的 loadWorkbenchActor 注入；写操作走 requirePermission。
 * 口径：管理员可读写全员；店员只读本人（服务端强制，不信任前端传的 staffRecordId）。
 */
const express = require('express');
const { V1BitableGateway, textValue } = require('../../services/v1BitableGateway');
const { relation } = require('../../services/v1ReferenceResolver');
const { StaffDirectoryService } = require('../../services/staffDirectoryService');
const { requirePermission } = require('../../services/authorizationService');
const { ROLES, can, permissionsOf } = require('../../config/permissions');
const { STAFF_TEXTS } = require('../../config/workbenchStaff');
const { logInfo, logError } = require('../../utils/logger');

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const firstCell = (value) => (Array.isArray(value) ? value[0] : value);
const linkedIdOf = (value) => {
  const cell = firstCell(value);
  if (!cell) return '';
  const ids = cell.record_ids || cell.link_record_ids || (cell.record_id ? [cell.record_id] : []);
  return String((Array.isArray(ids) ? ids[0] : ids) || '').trim();
};
const shanghaiDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offsetDays * 86400000));
const epochOf = (date, time) => {
  const ms = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isFinite(ms) ? ms : null;
};
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const { loadWorkbenchActor } = require('../../services/authorizationService');

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
      staffOpenId: String(user.id || '').trim(),
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
      const readAll = can(actor.role, 'attendance.read.all');
      const readSelf = can(actor.role, 'attendance.read.self');
      if (!readAll && !readSelf) {
        return res.status(403).json({ success: false, error: STAFF_TEXTS.roleForbidden });
      }
      const attending = all.filter((item) => item.attend);
      const staff = readAll ? attending : attending.filter((item) => item.recordId === actor.recordId);
      const roles = readAll ? await directory.listRoles() : [];
      return res.json({ success: true, staff, roles });
    } catch (error) {
      logError('workbench.staff.list.failed', { error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  router.get('/attendance', async (req, res) => {
    try {
      const actor = req.workbenchActor;
      const from = isDay(req.query.from) ? req.query.from : shanghaiDay(-13);
      const to = isDay(req.query.to) ? req.query.to : shanghaiDay(0);
      if (from > to) throw badRequest(STAFF_TEXTS.badRange);
      const rows = await gateway.listAll('attendance');
      const attendingIds = new Set((await directory.listStaff())
        .filter((item) => item.attend).map((item) => item.recordId));
      const fromAt = epochOf(from, '00:00');
      const toAt = epochOf(to, '23:59');
      const readAll = can(actor.role, 'attendance.read.all');
      const readSelf = can(actor.role, 'attendance.read.self');
      if (!readAll && !readSelf) {
        return res.status(403).json({ success: false, error: STAFF_TEXTS.roleForbidden });
      }
      let list = (rows || []).map(mapAttendance)
        .filter((row) => row.date >= fromAt && row.date <= toAt && attendingIds.has(row.staffRecordId));
      if (!readAll) {
        list = list.filter((row) => row.staffRecordId === actor.recordId || row.staffOpenId === actor.openId);
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

  const readPayload = (body = {}) => {
    const date = String(body.date || '').trim();
    const start = String(body.start || '').trim();
    const end = String(body.end || '').trim();
    if (!isDay(date)) throw badRequest(STAFF_TEXTS.badRange);
    if (!/^\d{2}:\d{2}$/.test(start)) throw badRequest(STAFF_TEXTS.badTime);
    const dateAt = epochOf(date, '00:00');
    const startAt = epochOf(date, start);
    if (dateAt == null || startAt == null) throw badRequest(STAFF_TEXTS.badTime);
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
    const id = actor.role === ROLES.ADMIN ? String(staffRecordId || actor.recordId) : actor.recordId;
    const staff = (await directory.listStaff()).find((item) => item.recordId === id);
    if (!staff) throw badRequest(STAFF_TEXTS.staffMissing);
    if (!staff.active) throw badRequest(STAFF_TEXTS.staffInactive);
    if (!staff.attend) throw badRequest(STAFF_TEXTS.staffNotAttending);
    return staff;
  };

  const unfinishedOf = async (staffRecordId) => {
    const rows = await gateway.listAll('attendance');
    return (rows || []).map(mapAttendance)
      .filter((row) => row.staffRecordId === staffRecordId && !row.endAt)
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
      if (await unfinishedOf(staff.recordId)) throw badRequest(STAFF_TEXTS.alreadyClockedIn);
      const now = Date.now();
      const created = await gateway.create('attendance', {
        staff: relation(staff.recordId),
        staffUser: [{ id: staff.openId }],
        date: epochOf(shanghaiDay(0), '00:00'),
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
      const open = await unfinishedOf(staff.recordId);
      if (!open) throw badRequest(STAFF_TEXTS.noOpenAttendance);
      const now = Date.now();
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
      const created = await gateway.create('attendance', {
        staff: relation(staff.recordId),
        staffUser: [{ id: staff.openId }],
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
      await gateway.update('attendance', recordId, {
        date: payload.dateAt, startAt: payload.startAt,
        ...(payload.endAt ? { endAt: payload.endAt, hours: payload.hours } : {}),
      });
      logInfo('workbench.staff.attendance.updated', {
        record_id: recordId, date: payload.date, hours: payload.hours,
      });
      return res.json({ success: true, recordId, hours: payload.hours });
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

  router.patch('/:recordId', requirePermission('staff.write'), async (req, res) => {
    try {
      const recordId = String(req.params.recordId || '');
      const existing = await gateway.get('staff', recordId);
      if (!existing) throw badRequest(STAFF_TEXTS.staffMissing);
      const fields = {};
      if (req.body?.roleRecordId !== undefined) {
        const role = await directory.findRole(req.body.roleRecordId);
        if (!role) throw badRequest(STAFF_TEXTS.badRole);
        // 2026-11-27：角色表可新增，但权限矩阵里没登记的角色会让人“登录后什么都不能做”；
        // 分配时明确拒绝，避免悄悄锁死（完整配置化见 Issue #1605）。
        if (!permissionsOf(role.name).length) throw badRequest(STAFF_TEXTS.roleWithoutPermissions);
        fields.role = relation(role.recordId);
      }
      if (req.body?.active !== undefined) fields.active = req.body.active === true;
      if (!Object.keys(fields).length) throw badRequest(STAFF_TEXTS.roleForbidden);
      await gateway.update('staff', recordId, fields);
      logInfo('workbench.staff.updated', { record_id: recordId, fields: Object.keys(fields) });
      return res.json({ success: true });
    } catch (error) {
      logError('workbench.staff.update.failed', { error: error.message });
      return res.status(error.statusCode || 502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createWorkbenchStaffRoutes };
