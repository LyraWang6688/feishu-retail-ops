/**
 * 打印任务的**落盘仓库** —— 一个任务一个 JSON 文件，外加拿走任务时的**原子认领**。
 *
 * 为什么单独一个文件（而不是塞进 `JsonTaskStore`）：
 *   · `JsonTaskStore` 是**通用**件（销售任务、采购任务都在用）—— 本链路要的是
 *     "**认领时不能有两个人同时拿走同一条**"这个**特定**语义，加进通用件会污染它；
 *   · 认领用 **`wx` 独占创建的锁文件**（不是内存标志）⇒ 即使将来 pm2 开成多实例、
 *     或者一次请求里并发来了两个 `claimNext`，也**只有一个**能拿到同一个任务。
 *
 * ⚠️ 为什么"认领过期后可重投"是**必须**的：业务负责人明确"**电脑不一定会常开着机**"——
 *    电脑在"已取走"状态下断电/崩溃/网断了，任务不能永远卡死在「已取走」；
 *    过了 `claimTimeoutMs` 就必须能被**重新领取**（否则她那边永远看不到"打完了"）。
 *    ⭐ 而"重投"**不等于"重打"**：小助手本地有"已打印 id"台账，重投时它只补回执、不重打。
 *    两道一起才既"不卡死"又"绝不重复打印"。
 *
 * ⚠️ 清理：`done` / `failed` 过期的任务连**产物**一起删；`queued` / `claimed` **永不清理**。
 */
const fs = require('node:fs');
const path = require('node:path');

const { JsonTaskStore, sanitizeRecordId } = require('./jsonTaskStore');
const { KeyedSerialQueue } = require('./keyedSerialQueue');
const { STATES } = require('../config/labelPrintQueue');

/** 认领锁文件后缀（⚠️ **不带 `.json`** —— `JsonTaskStore.list` 只读 `.json`，不会被它误读成任务）。 */
const CLAIM_LOCK_SUFFIX = '.claim';

class LabelPrintJobStore {
  constructor(options = {}) {
    if (!options.dir) throw new Error('LabelPrintJobStore requires dir');
    this.dir = options.dir;
    this.artifactsDir = options.artifactsDir || path.join(options.dir, 'artifacts');
    this.jobs = new JsonTaskStore({ dir: this.dir, idField: 'job_id' });
    // 同一个任务的**修改**串行化（进程内）：认领 / 回执 / 清理不会互相踩。
    // ⚠️ 它是"进程内"的保险；跨进程那一道是下面的 `wx` 锁文件。
    this.queue = new KeyedSerialQueue();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  _lockPath(jobId) {
    return path.join(this.dir, `${sanitizeRecordId(jobId)}${CLAIM_LOCK_SUFFIX}`);
  }

  artifactPath(fileName) {
    return path.join(this.artifactsDir, String(fileName));
  }

  create(job) {
    if (!job?.job_id) throw new Error('打印任务缺少 job_id');
    return this.jobs.create(job);
  }

  get(jobId) {
    return this.jobs.get(jobId);
  }

  /** 所有任务（按创建时间倒序）—— 调用方自己按状态 / 时间过滤。 */
  listAll() {
    return this.jobs.list();
  }

  /**
   * 一条任务现在能不能被（重新）领取。
   *   · `queued`                        → 能（新任务）；
   *   · `claimed` 且**认领已过期**      → 能（电脑崩了 / 断网 / 打印机关了）；
   *   · `claimed` 且未过期              → 不能（**正在被打**，别人不许抢）；
   *   · `done` / `failed`               → 不能（要重打走 `reprint`，生成**新任务**）。
   */
  static claimable(job, { now = Date.now(), claimTimeoutMs }) {
    if (!job) return false;
    if (job.status === STATES.queued.id) return true;
    if (job.status !== STATES.claimed.id) return false;
    const claimedAt = Number(job.claimed_at_ms || 0);
    if (!claimedAt) return true;
    return now - claimedAt >= claimTimeoutMs;
  }

  /** 现在可以领取的任务，**最老的排最前**（先进先出，她先点的那张先打）。 */
  async listClaimable({ now = Date.now(), claimTimeoutMs, status } = {}) {
    const records = await this.jobs.list(status ? { status } : {});
    return records
      .filter((job) => LabelPrintJobStore.claimable(job, { now, claimTimeoutMs }))
      // `created_at` 是 ISO 串（可比较）；同一毫秒内多个任务时按 job_id 兜底，保证顺序稳定。
      .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || ''))
        || String(left.job_id).localeCompare(String(right.job_id)));
  }

  /**
   * **原子认领**一个任务。返回 `{ claimed: true, job }` 或 `{ claimed: false, reason }`。
   *
   * 两道闸门：
   *   ① `wx` 独占创建锁文件 —— 跨进程/并发只有一个赢家；
   *   ② 进程内 `KeyedSerialQueue` 按 job_id 串行 —— 读-改-写不会交错。
   */
  async claim(jobId, { deviceId, now = Date.now(), claimTimeoutMs } = {}) {
    const lockPath = this._lockPath(jobId);
    let handle;
    try {
      handle = await fs.promises.open(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') return { claimed: false, reason: 'claim_in_progress' };
      throw error;
    }
    try {
      return await this.queue.run(`claim:${jobId}`, async () => {
        const job = await this.jobs.get(jobId);
        if (!job) return { claimed: false, reason: 'not_found' };
        if (!LabelPrintJobStore.claimable(job, { now, claimTimeoutMs })) {
          return { claimed: false, reason: `not_claimable:${job.status}` };
        }
        const next = await this.jobs.update(jobId, {
          status: STATES.claimed.id,
          claimed_at: new Date(now).toISOString(),
          claimed_at_ms: now,
          claimed_by: String(deviceId || '').trim() || null,
          // 上一次的失败原因属于上一次尝试：重新领取时清掉，免得页面上留着旧原因误导人。
          failure_reason: null,
          claim_count: Number(job.claim_count || 0) + 1,
        });
        return { claimed: true, job: next, redelivered: job.status === STATES.claimed.id };
      });
    } finally {
      await handle.close().catch(() => undefined);
      await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  /** 回执（`done` / `failed`）——同一个任务串行写，最后一个状态说了算。 */
  ack(jobId, patch) {
    return this.queue.run(`ack:${jobId}`, () => this.jobs.update(jobId, patch));
  }

  /** 删任务 + 删它的产物（**只给清理用**，且调用方保证不是 `queued` / `claimed`）。 */
  async remove(jobId, artifactFileNames = []) {
    await this.queue.run(`remove:${jobId}`, async () => {
      for (const name of artifactFileNames) {
        if (!name) continue;
        // ⚠️ 只允许删"产物目录里、文件名里没有路径分隔符"的东西 —— 防止把目录外的文件删掉。
        const base = path.basename(String(name));
        if (base !== String(name)) continue;
        await fs.promises.rm(this.artifactPath(base), { force: true }).catch(() => undefined);
      }
      await fs.promises.rm(path.join(this.dir, `${sanitizeRecordId(jobId)}.json`), { force: true });
    });
  }

  /** 磁盘上还剩多少产物字节（本地小页面 / 日志用）。 */
  async artifactsBytes() {
    const files = await fs.promises.readdir(this.artifactsDir).catch(() => []);
    let total = 0;
    for (const file of files) {
      const stat = await fs.promises.stat(this.artifactPath(file)).catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
    return total;
  }
}

module.exports = { LabelPrintJobStore, CLAIM_LOCK_SUFFIX };
