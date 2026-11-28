import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { STAFF_PAGE as T } from '../../config/staffPage.js';
import { showToast, showErrorToast } from '../shared/toast.js';

const dayOf = (offsetDays) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offsetDays * 86400000));
const timeText = (ms) => (ms ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms)) : '');
const dayText = (ms) => (ms ? new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms)) : '');
const hoursText = (value) => Number(value || 0).toFixed(1) + ' ' + T.hoursUnit;

const recordHtml = (record, canWrite) => {
  const actions = canWrite
    ? '<button class="staff-mini" type="button" data-staff-edit="' + escapeHtml(record.recordId) + '">' + escapeHtml(T.edit) + '</button>'
      + '<button class="staff-mini danger" type="button" data-staff-delete="' + escapeHtml(record.recordId) + '">' + escapeHtml(T.remove) + '</button>'
    : '';
  const range = timeText(record.startAt) + ' - ' + (record.endAt ? timeText(record.endAt) : T.ongoing);
  const hours = record.endAt ? '<span class="staff-hours">' + escapeHtml(hoursText(record.hours)) + '</span>' : '';
  return '<div class="staff-row">'
    + '<span class="staff-day">' + escapeHtml(dayText(record.date)) + '</span>'
    + '<span class="staff-range">' + escapeHtml(range) + '</span>'
    + hours + actions + '</div>';
};

const formHtml = (editing) => '<form class="staff-form" data-staff-form data-staff-id="' + escapeHtml(editing.staffRecordId) + '" data-record-id="' + escapeHtml(editing.recordId || '') + '">'
  + '<input type="date" name="date" value="' + escapeHtml(editing.date) + '" required>'
  + '<input type="time" name="start" value="' + escapeHtml(editing.start) + '" required>'
  + '<input type="time" name="end" value="' + escapeHtml(editing.end) + '">'
  + '<button class="btn small primary" type="submit">' + escapeHtml(T.save) + '</button>'
  + '<button class="btn small" type="button" data-staff-cancel>' + escapeHtml(T.cancel) + '</button>'
  + '</form>';

const staffCardHtml = (member, records, canWrite, canClock, editing) => {
  // 只把【今天】的未结束记录算作可下班；昨天的旧记录由管理员补卡，
  // 否则按钮会显示「下班」，点了却被后端拒绝。
  const openRecord = records.find((record) => !record.endAt && dayText(record.date) === dayOf(0));
  const clockButton = canClock && member.active
    ? (openRecord
      ? '<button class="btn small primary" type="button" data-staff-clock-out="' + escapeHtml(member.recordId) + '">' + escapeHtml(T.clockOut) + '</button>'
      : '<button class="btn small primary" type="button" data-staff-clock-in="' + escapeHtml(member.recordId) + '">' + escapeHtml(T.clockIn) + '</button>')
    : '';
  const addButton = canWrite && member.active
    ? '<button class="btn small" type="button" data-staff-add="' + escapeHtml(member.recordId) + '">' + escapeHtml(T.custom) + '</button>'
    : '';
  const rows = records.length
    ? records.map((record) => recordHtml(record, canWrite)).join('')
    : '<p class="staff-empty">' + escapeHtml(T.emptyAttendance) + '</p>';
  const form = editing && editing.staffRecordId === member.recordId ? formHtml(editing) : '';
  return '<section class="staff-card" data-staff-card="' + escapeHtml(member.recordId) + '">'
    + '<div class="staff-card-head"><b>' + escapeHtml(member.name || '-') + '</b>' + clockButton + addButton + '</div>'
    + '<div class="staff-records">' + rows + '</div>'
    + form
    + '</section>';
};

const panelHtml = (state) => {
  const permissions = state.actor.permissions || [];
  const canWrite = permissions.includes('attendance.write');
  // 考勤人只给「看全员 + 代打卡」，没有 write；clock.any 也能让所有人的上下班按钮出现。
  const canClock = permissions.includes('attendance.clock.self') || permissions.includes('attendance.clock.any');
  const cards = state.staff.length
    ? state.staff.map((member) => staffCardHtml(
      member,
      state.attendance.filter((item) => item.staffRecordId === member.recordId),
      canWrite,
      canClock,
      state.editing,
    )).join('')
    : '<p class="staff-empty">' + escapeHtml(T.emptyStaff) + '</p>';
  return '<div class="staff-head"><h2>' + escapeHtml(T.title) + '</h2></div>'
    + '<div class="staff-filters">'
    + '<label>' + escapeHtml(T.from) + '<input type="date" data-staff-from value="' + escapeHtml(state.from) + '"></label>'
    + '<label>' + escapeHtml(T.to) + '<input type="date" data-staff-to value="' + escapeHtml(state.to) + '"></label>'
    + '<button class="btn small" type="button" data-staff-refresh>' + escapeHtml(T.refresh) + '</button>'
    + '</div>'
    + '<div class="staff-list">' + cards + '</div>';
};

export function openStaffPanel(host) {
  if (!host) return;
  const cards = host.querySelector('.domain-cards');
  const note = host.querySelector('.placeholder-note');
  const old = host.querySelector('[data-view="staff-attendance"]');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.dataset.view = 'staff-attendance';
  host.append(panel);
  if (cards) cards.classList.add('hidden');
  if (note) note.classList.add('hidden');
  panel.hidden = false;
  panel.innerHTML = '<p class="staff-empty">' + escapeHtml(T.loading) + '</p>';

  const state = {
    actor: { role: '', permissions: [] }, staff: [], attendance: [],
    from: dayOf(-13), to: dayOf(0), editing: null,
  };
  const render = () => { panel.innerHTML = panelHtml(state); };
  const load = async () => {
    try {
      const me = await api.get(T.api.me);
      state.actor = me?.actor || state.actor;
      const roster = await api.get(T.api.roster);
      state.staff = Array.isArray(roster?.staff) ? roster.staff : [];
      const list = await api.get(T.api.attendance + '?from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to));
      state.attendance = Array.isArray(list?.attendance) ? list.attendance : [];
      state.editing = null;
      render();
    } catch (error) {
      panel.innerHTML = '<div class="staff-head"><h2>' + escapeHtml(T.title) + '</h2></div><p class="staff-empty">' + escapeHtml(T.loadFailed) + '</p>';
    }
  };

  const save = async (form) => {
    const staffRecordId = form.dataset.staffId || '';
    const recordId = form.dataset.recordId || '';
    const body = {
      staffRecordId,
      date: String(form.elements.date?.value || ''),
      start: String(form.elements.start?.value || ''),
      end: String(form.elements.end?.value || ''),
    };
    try {
      await (recordId ? api.patch(T.api.attendance + '/' + encodeURIComponent(recordId), body) : api.post(T.api.attendance, body));
      showToast(T.saved);
      await load();
    } catch (error) {
      // 直接把服务端的人话带出来（例如“开始/结束时间不对”），不要只报“保存失败”。
      showErrorToast(error?.message || T.saveFailed);
    }
  };

  panel.addEventListener('click', async (event) => {
    const clockIn = event.target.closest?.('[data-staff-clock-in]');
    if (clockIn) {
      try {
        await api.post(T.api.clockIn, { staffRecordId: clockIn.dataset.staffClockIn });
        showToast(T.saved);
        await load();
      } catch (error) {
        showErrorToast(error?.message || T.saveFailed);
      }
      return;
    }
    const clockOut = event.target.closest?.('[data-staff-clock-out]');
    if (clockOut) {
      try {
        await api.post(T.api.clockOut, { staffRecordId: clockOut.dataset.staffClockOut });
        showToast(T.saved);
        await load();
      } catch (error) {
        showErrorToast(error?.message || T.saveFailed);
      }
      return;
    }
    const add = event.target.closest?.('[data-staff-add]');
    if (add) {
      // 自定义时间：上下班分开填，不预填任何时间（18:00 只是提醒阈值，不是默认下班时间）。
      state.editing = { staffRecordId: add.dataset.staffAdd, recordId: '', date: state.to, start: '', end: '' };
      render();
      return;
    }
    const edit = event.target.closest?.('[data-staff-edit]');
    if (edit) {
      const record = state.attendance.find((item) => item.recordId === edit.dataset.staffEdit);
      if (!record) return;
      state.editing = {
        staffRecordId: record.staffRecordId, recordId: record.recordId,
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(record.date)),
        start: timeText(record.startAt), end: timeText(record.endAt),
      };
      render();
      return;
    }
    const remove = event.target.closest?.('[data-staff-delete]');
    if (remove) {
      if (!globalThis.confirm(T.confirmDelete)) return;
      try {
        await api.delete(T.api.attendance + '/' + encodeURIComponent(remove.dataset.staffDelete));
        showToast(T.deleted);
        await load();
      } catch (error) {
        showErrorToast(T.deleteFailed);
      }
      return;
    }
    if (event.target.closest?.('[data-staff-cancel]')) {
      state.editing = null;
      render();
      return;
    }
    if (event.target.closest?.('[data-staff-refresh]')) {
      await load();
    }
  });

  panel.addEventListener('submit', async (event) => {
    const form = event.target.closest?.('[data-staff-form]');
    if (!form) return;
    event.preventDefault();
    await save(form);
  });

  panel.addEventListener('change', async (event) => {
    const fromInput = event.target.closest?.('[data-staff-from]');
    const toInput = event.target.closest?.('[data-staff-to]');
    if (fromInput) { state.from = String(fromInput.value || state.from); await load(); return; }
    if (toInput) { state.to = String(toInput.value || state.to); await load(); }
  });

  void load();
}
