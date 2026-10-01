export function showPageError(message = '') {
  const element = document.getElementById('page-error');
  element.textContent = message;
  element.classList.toggle('hidden', !message);
}

export function describeError(error) {
  return error.requestId ? `${error.message}（请求编号：${error.requestId}）` : error.message;
}

export function setBusy(button, busy, busyText = '处理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
  button.disabled = busy;
}

export function bindSubTabs(container, onActivate = () => {}) {
  container.querySelectorAll('.sub-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const group = tab.closest('.sub-tabs');
      const panel = tab.closest('.panel');
      group.querySelectorAll('.sub-tab').forEach((item) => item.classList.toggle('active', item === tab));
      panel.querySelectorAll(':scope > .sub-panel').forEach((item) => {
        item.classList.toggle('hidden', item.id !== `${tab.dataset.subtab}-subpanel`);
      });
      onActivate(tab.dataset.subtab);
    });
  });
}
