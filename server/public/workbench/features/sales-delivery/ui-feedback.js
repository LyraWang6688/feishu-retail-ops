/** 交割单页反馈工具：toast + 客户端 request_id（不写死文案）。
 *  ⭐ 2026-11-10：toast 收口到 `features/shared/toast.js`（数据配置页的按钮卡也用同一个）——
 *     这里只做 re-export，行为/视觉与改前逐字一致（不再保留第二份实现）。 */
export { showToast } from '../shared/toast.js';

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
