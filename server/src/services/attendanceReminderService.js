'use strict';

const { StaffDirectoryService } = require('./staffDirectoryService');
const { linkedRecordIds } = require('./v1BitableGateway');
const { ATTENDANCE_REMINDER } = require('../config/attendanceReminder');
const { logInfo, logWarn } = require('../utils/logger');

const shanghaiDay = (epoch) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(epoch));

const createAttendanceReminderService = ({
  gateway, notifications, config = ATTENDANCE_REMINDER, now = () => Date.now(),
} = {}) => {
  if (!gateway) throw new Error('AttendanceReminderService requires gateway');
  if (!notifications || typeof notifications.send !== 'function') {
    throw new Error('AttendanceReminderService requires notifications');
  }
  // open_id → 已提醒的上海日期；进程重启会重新提醒一次，可接受。
  const reminded = new Map();

  const run = async () => {
    if (!config.enabled) return { skipped: true, reason: 'disabled' };
    const directory = new StaffDirectoryService({ gateway });
    const staff = (await directory.listStaff())
      .filter((item) => item.active && item.attend && item.openId);
    const fields = gateway.table('attendance').fields;
    const rows = await gateway.listAll('attendance');
    const openStaffIds = new Set();
    for (const row of rows || []) {
      if ((Number(row.fields?.[fields.endAt]) || 0) > 0) continue;
      const staffId = linkedRecordIds(row.fields?.[fields.staff])[0] || '';
      if (staffId) openStaffIds.add(staffId);
    }
    const today = shanghaiDay(now());
    let sent = 0;
    for (const person of staff) {
      if (!openStaffIds.has(person.recordId)) continue;
      if (reminded.get(person.openId) === today) continue;
      try {
        const result = await notifications.send('attendance_clock_out_reminder', {
          text: String(config.text || '').replace('{name}', person.name || ''),
        }, { target: { receiveId: person.openId, receiveIdType: 'open_id' } });
        if (result?.ok) {
          reminded.set(person.openId, today);
          sent += 1;
        }
      } catch (error) {
        logWarn('attendance.clock_out_reminder.failed', {
          staff_record_id: person.recordId, error: String(error?.message || error),
        });
      }
    }
    if (sent) logInfo('attendance.clock_out_reminder.sent', { date: today, sent });
    return { sent };
  };

  return { run };
};

module.exports = { createAttendanceReminderService };
