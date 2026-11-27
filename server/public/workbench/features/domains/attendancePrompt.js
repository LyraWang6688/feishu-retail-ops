import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { STAFF_PAGE as T } from '../../config/staffPage.js';
import { showToast } from '../shared/toast.js';

const MODAL_ID = 'staff-attendance-prompt';
const DISMISS_PREFIX = 'attendancePrompt.dismissed.';

const dismissKey = (date, kind, recordId) => DISMISS_PREFIX + date + '.' + kind + '.' + recordId;
const isDismissed = (key) => {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
};
const markDismissed = (key) => {
  try { window.localStorage.setItem(key, '1'); } catch { /* 隐私模式忽略 */ }
};

const rowHtml = (person) => '<div class="staff-prompt-row" data-prompt-staff="' + escapeHtml(person.recordId) + '">'
  + '<b>' + escapeHtml(person.name || '-') + '</b>'
  + '<button type="button" class="btn small primary" data-prompt-clock="' + escapeHtml(person.recordId) + '">' + escapeHtml(T.promptProxyClockIn) + '</button>'
  + '<button type="button" class="btn small" data-prompt-off="' + escapeHtml(person.recordId) + '">' + escapeHtml(T.promptNotWorking) + '</button>'
  + '</div>';

const selfHtml = (self) => '<section class="staff-prompt-section" data-prompt-self>'
  + '<h3>' + escapeHtml(T.promptTitle) + '</h3>'
  + '<p>' + (self.name ? escapeHtml(self.name) + '，' : '') + escapeHtml(T.promptSelfBody) + '</p>'
  + '<div class="staff-prompt-actions">'
  + '<button type="button" class="btn small" data-prompt-self-off>' + escapeHtml(T.promptNotWorking) + '</button>'
  + '<button type="button" class="btn small primary" data-prompt-self-clock>' + escapeHtml(T.promptClockIn) + '</button>'
  + '</div>'
  + '</section>';

const managedHtml = (managed) => '<section class="staff-prompt-section" data-prompt-managed>'
  + '<h3>' + escapeHtml(T.promptManagedTitle) + '</h3>'
  + '<p>' + escapeHtml(T.promptManagedBody) + '</p>'
  + managed.map(rowHtml).join('')
  + '</section>';

const bodyHtml = (state) => {
  const parts = [];
  if (state.self) parts.push(selfHtml(state.self));
  if (state.managed.length) parts.push(managedHtml(state.managed));
  return parts.join('');
};

function mount({ date, self, managed }) {
  const state = { date, self, managed: managed.slice(), busy: false };
  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.className = 'staff-prompt';
  root.innerHTML = '<div class="staff-prompt-card" role="dialog" aria-modal="true" aria-label="' + escapeHtml(T.promptTitle) + '">'
    + '<div data-prompt-body></div>'
    + '<p class="staff-prompt-error" data-prompt-error hidden></p>'
    + '<div class="staff-prompt-footer">'
    + '<button type="button" class="btn small" data-prompt-later>' + escapeHtml(T.promptLater) + '</button>'
    + '</div>'
    + '</div>';
  document.body.append(root);
  const body = root.querySelector('[data-prompt-body]');
  const error = root.querySelector('[data-prompt-error]');

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    root.remove();
  };
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeydown);

  const showError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
  };
  const setBusy = (busy) => {
    state.busy = busy;
    root.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  };
  const render = () => {
    if (!state.self && !state.managed.length) { close(); return; }
    body.innerHTML = bodyHtml(state);
    const primary = root.querySelector('.btn.primary:not([disabled])');
    const first = primary || root.querySelector('button:not([disabled])');
    if (first) first.focus();
  };
  const clockIn = async (staffRecordId) => {
    if (state.busy) return false;
    setBusy(true);
    showError('');
    try {
      await api.post(T.api.clockIn, staffRecordId ? { staffRecordId } : {});
      return true;
    } catch (error) {
      showError(error?.message || T.promptFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-prompt-later]')) { close(); return; }
    if (event.target.closest('[data-prompt-self-clock]')) {
      const ok = await clockIn('');
      if (ok) {
        showToast(T.promptClockedIn);
        state.self = null;
        render();
      }
      return;
    }
    if (event.target.closest('[data-prompt-self-off]')) {
      const recordId = state.self?.recordId;
      if (recordId) markDismissed(dismissKey(state.date, 'self', recordId));
      state.self = null;
      render();
      return;
    }
    const clock = event.target.closest('[data-prompt-clock]');
    if (clock) {
      const recordId = clock.dataset.promptClock;
      const ok = await clockIn(recordId);
      if (ok) {
        showToast(T.promptProxyClockedIn);
        state.managed = state.managed.filter((person) => person.recordId !== recordId);
        render();
      }
      return;
    }
    const off = event.target.closest('[data-prompt-off]');
    if (off) {
      const recordId = off.dataset.promptOff;
      markDismissed(dismissKey(state.date, 'staff', recordId));
      state.managed = state.managed.filter((person) => person.recordId !== recordId);
      render();
    }
  });

  render();
}

export async function maybeShowAttendancePrompt() {
  try {
    if (document.getElementById(MODAL_ID)) return;
    const data = await api.get(T.api.prompt);
    if (!data?.success) return;
    const date = String(data.date || '');
    if (!date) return;
    const self = data.self?.shouldPrompt && data.self.recordId
      && !isDismissed(dismissKey(date, 'self', data.self.recordId)) ? data.self : null;
    const managed = (Array.isArray(data.managed) ? data.managed : [])
      .filter((person) => person?.recordId && !isDismissed(dismissKey(date, 'staff', person.recordId)));
    if (!self && !managed.length) return;
    mount({ date, self, managed });
  } catch (error) {
    // 弹窗失败绝不影响工作台使用。
  }
}
