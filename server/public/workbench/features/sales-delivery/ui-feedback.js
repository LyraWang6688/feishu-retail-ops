/** 交割单页反馈工具：toast + 客户端 request_id（不写死文案）。 */
export const showToast = (text) => {
  let toast = document.querySelector('.workbench-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'workbench-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.remove(); }, 3000);
};

export const requestId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    return (char === 'x' ? rand : ((rand & 0x3) | 0x8)).toString(16);
  });
};

/** 轮询异步 job：succeeded → onSuccess；failed → onFailure；超时按失败处理。 */
export const waitJob = async (api, jobId, { onSuccess, onFailure, onTimeout, intervalMs = 800, timeoutMs = 30000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    try {
      const payload = await api.get(`/api/workbench/async-jobs/${encodeURIComponent(jobId)}`);
      const job = payload?.job || payload;
      if (job.status === 'succeeded') { onSuccess?.(job); return; }
      if (job.status === 'partial_failed' || job.status === 'failed') {
        onFailure?.(job.last_error || job.error || '', job);
        return;
      }
    } catch (error) {
      onFailure?.(error?.message || '');
      return;
    }
  }
  if (typeof onTimeout === 'function') onTimeout();
  else onFailure?.('timeout');
};
