'use strict';

const STAFF_API = Object.freeze({
  me: '/api/workbench/staff/me',
  roster: '/api/workbench/staff',
  attendance: '/api/workbench/staff/attendance',
});

const STAFF_TEXTS = Object.freeze({
  forbidden: '当前账号没有工作台权限',
  roleForbidden: '当前角色没有这个操作权限',
  staffMissing: '花名册里没有这个人员',
  staffInactive: '该人员已离职',
  staffNotAttending: '该人员未开启考勤',
  alreadyClockedIn: '当前已有进行中的考勤，请先打下班卡',
  noOpenAttendance: '还没有上班记录，请先打上班卡',
  badRange: '日期范围不对',
  badTime: '开始/结束时间不对',
  needStaff: '请选择人员',
  recordNotFound: '考勤记录不存在',
});

module.exports = { STAFF_API, STAFF_TEXTS };
