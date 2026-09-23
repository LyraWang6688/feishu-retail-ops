const fs = require('node:fs');
const path = require('node:path');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

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
  }

  _filePath(recordId) {
    return path.join(this.dir, `${sanitizeRecordId(recordId)}.json`);
  }

  async create(task) {
    const recordId = task?.[this.idField];
    if (!recordId) throw new Error(`Task is missing ${this.idField}`);
    const now = new Date().toISOString();
    const record = { ...task, created_at: task.created_at || now, updated_at: task.updated_at || now };
    await fs.promises.writeFile(this._filePath(recordId), JSON.stringify(record, null, 2), 'utf8');
    return record;
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
    const current = await this.get(recordId);
    if (!current) throw new Error(`任务不存在: ${recordId}`);
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    await fs.promises.writeFile(this._filePath(recordId), JSON.stringify(next, null, 2), 'utf8');
    return next;
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
