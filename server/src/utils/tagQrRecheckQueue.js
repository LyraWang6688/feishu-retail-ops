/**
 * 「标签二维码」的**延迟复核**队列（2026-10-12 真机根因修复）。
 *
 * 现场（业务负责人 12:13 改了货号 `832-372-6`，二维码没更新）：
 *   编辑那一刻记录里的「编号」还是**旧值**（`832-372-6H`）—— 「编号」是**公式列**，
 *   飞书要过一会儿才把新货号算进去。于是事件路径**如实**判成"编号没变"（它没判错！），
 *   而**那一次编辑之后再没有第二次事件** ⇒ 没有人再复核 ⇒ 旧码一直挂着 ✗。
 *
 * ⇒ 这个队列只干一件事：**判成"没变/判不了"的时候，过一会儿再核一次**。
 *    · 幂等：同一条记录重复 `schedule` 只排一次（Map 去重）；复核走的还是 `syncRecord`，
 *      它自己会按编号/文件名判"到底过期没有"，已同步就跳过 ⇒ **不会重复写**；
 *    · 失败**只记日志**（`product.tag_qr.recheck.failed`），绝不抛给调用方（不能影响事件响应）；
 *    · 定时器可注入（`setTimer` / `clearTimer`）⇒ 单测用**假时钟**，不真等；
 *    · 兜底：即使这一层漏了，还有每小时一次的巡检（`sweepStaleTagQrCodes`）最后兜住。
 */
const { logInfo, logWarn } = require('./logger');

const createTagQrRecheckQueue = ({
  service,
  delayMs = 60 * 1000,
  enabled = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!service || typeof service.syncRecord !== 'function') {
    throw new Error('延迟复核队列缺少 service（或它没有 syncRecord）');
  }
  const pending = new Map();
  const delay = Math.max(1000, Number(delayMs) || 60 * 1000);

  const run = async (recordId) => {
    try {
      const result = await service.syncRecord(recordId, { reason: 'delayed_recheck' });
      logInfo('product.tag_qr.recheck.done', {
        record_id: recordId, status: result?.status, reason: result?.reason,
      });
      return result;
    } catch (error) {
      // 复核失败**不抛**（它是一次后台补救，不能反过来影响事件响应）；巡检还会兜一次。
      logWarn('product.tag_qr.recheck.failed', { record_id: recordId, error: error.message });
      return null;
    }
  };

  return {
    enabled,
    delayMs: delay,
    /** 排一次延迟复核（同一条记录已有待跑的 ⇒ 只记一次，返回 `already_scheduled`）。 */
    schedule(recordId) {
      const id = String(recordId || '').trim();
      if (!enabled) return { scheduled: false, reason: 'disabled' };
      if (!id) return { scheduled: false, reason: 'record_id_missing' };
      if (pending.has(id)) return { scheduled: false, reason: 'already_scheduled', delayMs: delay };
      const timer = setTimer(() => {
        pending.delete(id);
        void run(id);
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pending.set(id, timer);
      return { scheduled: true, delayMs: delay };
    },
    /** 立刻复核（测试 / 手动补核用）；会把这一条从待跑里摘掉。 */
    async runNow(recordId) {
      const id = String(recordId || '').trim();
      const timer = pending.get(id);
      if (timer) { clearTimer(timer); pending.delete(id); }
      if (!id) return null;
      return run(id);
    },
    pendingCount: () => pending.size,
    pendingIds: () => [...pending.keys()],
    stop() {
      for (const timer of pending.values()) clearTimer(timer);
      pending.clear();
    },
  };
};

module.exports = { createTagQrRecheckQueue };
