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
  return '<div class="staff-row">'
    + '<span class="staff-day">' + escapeHtml(dayText(record.date)) + '</span>'
    + '<span class="staff-range">' + escapeHtml(timeText(record.startAt)) + ' - ' + escapeHtml(timeText(record.endAt)) + '</span>'
    + '<span class="staff-hours">' + escapeHtml(hoursText(record.hours)) + '</span>'
    + actions + '</div>';
};

const formHtml = (editing) => '<form class="staff-form" data-staff-form data-staff-id="' + escapeHtml(editing.staffRecordId) + '" data-record-id="' + escapeHtml(editing.recordId || '') + '">'
  + '<input type="date" name="date" value="' + escapeHtml(editing.date) + '" required>'
  + '<input type="time" name="start" value="' + escapeHtml(editing.start) + '" required>'
  + '<input type="time" name="end" value="' + escapeHtml(editing.end) + '" required>'
  + '<button class="btn small primary" type="submit">' + escapeHtml(T.save) + '</button>'
  + '<button class="btn small" type="button" data-staff-cancel>' + escapeHtml(T.cancel) + '</button>'
  + '</form>';

const staffCardHtml = (member, records, canWrite, canManage, roles, editing) => {
  const roleOptions = roles.map((role) => '<option value="' + escapeHtml(role.recordId) + '"' + (role.name === member.roleName ? ' selected' : '') + '>' + escapeHtml(role.name) + '</option>').join('');
  const roleField = canManage
    ? '<select class="staff-role-select" data-staff-role data-record-id="' + escapeHtml(member.recordId) + '">' + roleOptions + '</select>'
      + '<label class="staff-active"><input type="checkbox" data-staff-active data-record-id="' + escapeHtml(member.recordId) + '"' + (member.active ? ' checked' : '') + '> ' + escapeHtml(T.active) + '</label>'
    : '<span class="staff-badge">' + escapeHtml(member.roleName || '-') + '</span>'
      + '<span class="staff-badge' + (member.active ? '' : ' muted') + '">' + escapeHtml(member.active ? T.active : T.inactive) + '</span>';
  const addButton = canWrite && member.active
    ? '<button class="btn small primary" type="button" data-staff-add="' + escapeHtml(member.recordId) + '">' + escapeHtml(T.add) + '</button>'
    : '';
  const rows = records.length
    ? records.map((record) => recordHtml(record, canWrite)).join('')
    : '<p class="staff-empty">' + escapeHtml(T.emptyAttendance) + '</p>';
  const form = editing && editing.staffRecordId === member.recordId ? formHtml(editing) : '';
  return '<section class="staff-card" data-staff-card="' + escapeHtml(member.recordId) + '">'
    + '<div class="staff-card-head"><b>' + escapeHtml(member.name || '-') + '</b>' + roleField + addButton + '</div>'
    + '<div class="staff-records">' + rows + '</div>'
    + form
    + '</section>';
};

const panelHtml = (state) => {
  const canWrite = (state.actor.permissions || []).includes('attendance.write');
  const canManage = (state.actor.permissions || []).includes('staff.write');
  const cards = state.staff.length
    ? state.staff.map((member) => staffCardHtml(
      member,
      state.attendance.filter((item) => item.staffRecordId === member.recordId),
      canWrite,
      canManage,
      state.roles,
      state.editing,
    )).join('')
    : '<p class="staff-empty">' + escapeHtml(T.emptyStaff) + '</p>';
  return '<div class="staff-head"><h2>' + escapeHtml(T.title) + '</h2><span class="staff-badge">' + escapeHtml(state.actor.role || '') + '</span></div>'
    + '<p class="staff-note">' + escapeHtml(T.subtitle) + '</p>'
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
    actor: { role: '', permissions: [] }, staff: [], roles: [], attendance: [],
    from: dayOf(-13), to: dayOf(0), editing: null,
  };
  const render = () => { panel.innerHTML = panelHtml(state); };
  const load = async () => {
    try {
      const me = await api.get(T.api.me);
      state.actor = me?.actor || state.actor;
      const roster = await api.get(T.api.roster);
      state.staff = Array.isArray(roster?.staff) ? roster.staff : [];
      state.roles = Array.isArray(roster?.roles) ? roster.roles : [];
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
      showErrorToast(T.saveFailed);
    }
  };

  panel.addEventListener('click', async (event) => {
    const add = event.target.closest?.('[data-staff-add]');
    if (add) {
      state.editing = { staffRecordId: add.dataset.staffAdd, recordId: '', date: state.to, start: '09:00', end: '18:00' };
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
    if (toInput) { state.to = String(toInput.value || state.to); await load(); return; }
    const roleSelect = event.target.closest?.('[data-staff-role]');
    if (roleSelect) {
      try {
        await api.patch(T.api.roster + '/' + encodeURIComponent(roleSelect.dataset.recordId), { roleRecordId: roleSelect.value });
        showToast(T.roleSaved);
        await load();
      } catch (error) {
        showErrorToast(T.saveFailed);
      }
      return;
    }
    const activeBox = event.target.closest?.('[data-staff-active]');
    if (activeBox) {
      try {
        await api.patch(T.api.roster + '/' + encodeURIComponent(activeBox.dataset.recordId), { active: activeBox.checked });
        showToast(T.activeSaved);
        await load();
      } catch (error) {
        showErrorToast(T.saveFailed);
      }
    }
  });

  void load();
}
