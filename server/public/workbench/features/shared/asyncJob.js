import { api } from '../../core/api-client.js';

/**
 * 轮询统一异步任务（#948）。
 * 只读；成功返回 job，失败/超时抛错。业务页面自己决定刷新哪份列表。
 */
export async function waitForAsyncJob(jobId, { timeoutMs = 120000, intervalMs = 1500 } = {}) {
  const id = String(jobId || '').trim();
  if (!id) throw new Error('缺少异步任务 ID');
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 120000);
  while (Date.now() < deadline) {
    const payload = await api.get(`/api/workbench/async-jobs/${encodeURIComponent(id)}`);
    const job = payload?.job || payload;
    if (job?.status === 'succeeded') return job;
    if (job?.status === 'failed' || job?.status === 'partial_failed') {
      throw new Error(job.last_error || '异步任务失败');
    }
    await new Promise((resolve) => { setTimeout(resolve, Math.max(200, Number(intervalMs) || 1500)); });
  }
  throw new Error('异步任务超时');
}
