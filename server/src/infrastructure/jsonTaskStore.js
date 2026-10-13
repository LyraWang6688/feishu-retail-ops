const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

// writeFile 会先清空目标文件再写入，并发读取时可能读到半个文件，
// JSON.parse 直接抛 "Unexpected end of JSON input"（CI 上就这样失败过）。
// 改为先写同目录临时文件再 rename：同一文件系统上的 rename 是原子的，
// 读方要么看到完整的旧版本，要么看到完整的新版本。临时文件以 .tmp 结尾，
// list() 只读 .json，不会把它当记录读走。
const writeFileAtomic = async (filePath, contents) => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tempPath, contents, 'utf8');
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
};

const sanitizeRecordId = (recordId) => {
  const id = String(recordId || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid record id: ${recordId}`);
  return id;
};

class JsonTaskStore {
  constructor(options = {}) {
    if (!options.dir) throw new Error('JsonTaskStore requires dir');
    this.dir = options.dir;
    this.idField = options.idField || 'task_id';
    ensureDir(this.dir);
    // ⭐⭐ 2026-10-13：**按 recordId 的写互斥** —— `update()` 是**读-改-写**，三步之间必须串行 ✗
    //   起因（真机可见的丢写 ✗）：`JsonTaskStore.update()` 原来是裸的读-改-写 ⇒
    //     两个并发写都用**同一个旧快照** ⇒ 后落的那个覆盖先落的 ⇒ 改动**丢了** ✗
    //     （现场：提交成功后路由调 `setLastRealm`（**不在串行队列里** ✗）与 `addLine` 交错
    //       ⇒ 刚加的那一行被抹掉 ⇒ 会话快照 `sale_lines: 0` ✗）
    //   ⚠️ 只锁**同一个 id**（不是全局大锁 ✓ 不拖慢其他 id ✓）；`writeFileAtomic` 行为**一字不动** ✓。
    this._writeQueues = new Map();
  }

  _filePath(recordId) {
    return path.join(this.dir, `${sanitizeRecordId(recordId)}.json`);
  }

  /**
   * 同一个 `recordId` 上的**写**操作串行化（不同 id 互不影响 ✓）。
   * ⚠️ 队列尾巴只用于排队，异常由返回的 promise 抛给调用方（不吞错 ✗）；队尾清空后从 Map 删掉（不涨内存 ✓）。
   */
  _serializeWrite(recordId, run) {
    const id = sanitizeRecordId(recordId);
    const previous = this._writeQueues.get(id) || Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    this._writeQueues.set(id, tail);
    tail.then(() => {
      if (this._writeQueues.get(id) === tail) this._writeQueues.delete(id);
    });
    return next;
  }

  async create(task) {
    const recordId = task?.[this.idField];
    if (!recordId) throw new Error(`Task is missing ${this.idField}`);
    const now = new Date().toISOString();
    const record = { ...task, created_at: task.created_at || now, updated_at: task.updated_at || now };
    return this._serializeWrite(recordId, async () => {
      await writeFileAtomic(this._filePath(recordId), JSON.stringify(record, null, 2));
      return record;
    });
  }

  async get(recordId) {
    try {
      return JSON.parse(await fs.promises.readFile(this._filePath(recordId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async update(recordId, patch) {
    // ⭐⭐ 2026-10-13：「读 → 改 → 写」**整体**在同一个 id 的互斥里跑 ✗ 不许三步之间被插队 ✓
    return this._serializeWrite(recordId, async () => {
      const current = await this.get(recordId);
      if (!current) throw new Error(`任务不存在: ${recordId}`);
      const next = { ...current, ...patch, updated_at: new Date().toISOString() };
      await writeFileAtomic(this._filePath(recordId), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async list(filter = {}) {
    const records = [];
    for (const file of await fs.promises.readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      records.push(JSON.parse(await fs.promises.readFile(path.join(this.dir, file), 'utf8')));
    }
    const status = filter.status ? String(filter.status) : '';
    return records
      .filter((record) => !status || record.status === status)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }
}

module.exports = { JsonTaskStore, sanitizeRecordId };
