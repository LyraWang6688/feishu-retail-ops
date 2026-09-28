const { linkedRecordIds, textValue } = require('./v1BitableGateway');

const normalizeSize = (value) => {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw == null || !['number', 'string'].includes(typeof raw)) {
    throw new Error('尺码必须是正整数');
  }
  if (typeof raw === 'string' && !/^[1-9]\d*$/.test(raw)) throw new Error('尺码必须是正整数');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('尺码必须是正整数');
  return size;
};

class SizeReferenceService {
  constructor({ gateway, cacheTtlMs = 30_000, now = Date.now } = {}) {
    if (!gateway) throw new Error('SizeReferenceService requires gateway');
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error('尺码缓存时长无效');
    this.gateway = gateway;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = null;
    this.cacheExpiresAt = 0;
    this.loadPromise = null;
    this.cacheVersion = 0;
  }

  clearCache() {
    this.cache = null;
    this.cacheExpiresAt = 0;
    this.loadPromise = null;
    this.cacheVersion += 1;
  }

  async validateSchema(tableKeys = []) {
    if (typeof this.gateway.listFields !== 'function') return;
    const sizeTable = this.gateway.table('sizeManagement');
    if (!sizeTable.tableId) throw new Error('尺码管理未配置 table_id');
    const sizeFields = await this.gateway.listFields('sizeManagement');
    const source = sizeFields.find((field) => field.field_name === sizeTable.fields.size);
    if (source?.type !== 2) throw new Error('尺码管理的“尺码”必须是数字字段');
    for (const key of tableKeys) {
      const table = this.gateway.table(key);
      const fields = await this.gateway.listFields(key);
      const field = fields.find((item) => item.field_name === table.fields.size);
      if (field?.type !== 18 || field.property?.table_id !== sizeTable.tableId ||
        field.property?.multiple !== false) {
        throw new Error(`“${table.tableName}”的尺码必须是单选关联“尺码管理”字段`);
      }
    }
  }

  async load({ refresh = false } = {}) {
    if (!refresh && this.cache && this.now() < this.cacheExpiresAt) return this.cache;
    if (!this.loadPromise) {
      const version = this.cacheVersion;
      const loading = (async () => {
        const field = this.gateway.table('sizeManagement').fields.size;
        const byNumber = new Map();
        const byRecordId = new Map();
        for (const record of await this.gateway.listAll('sizeManagement')) {
          const size = normalizeSize(textValue(record.fields?.[field]));
          if (!record.record_id) throw new Error(`尺码管理 ${size} 码缺少 record_id`);
          if (byNumber.has(size)) throw new Error(`尺码管理中 ${size} 码存在重复记录`);
          const entry = { recordId: record.record_id, size };
          byNumber.set(size, entry);
          byRecordId.set(record.record_id, entry);
        }
        return { byNumber, byRecordId };
      })().then((snapshot) => {
        if (version === this.cacheVersion) {
          this.cache = snapshot;
          this.cacheExpiresAt = this.now() + this.cacheTtlMs;
        }
        return snapshot;
      });
      this.loadPromise = loading;
      try {
        return await loading;
      } finally {
        if (this.loadPromise === loading) this.loadPromise = null;
      }
    }
    return this.loadPromise;
  }

  async resolveByNumber(value) {
    const size = normalizeSize(value);
    let entry = (await this.load()).byNumber.get(size);
    if (!entry) entry = (await this.load({ refresh: true })).byNumber.get(size);
    if (!entry) throw new Error(`尺码管理中找不到 ${size} 码，请先核对关联记录`);
    return entry;
  }

  async resolveLinkedCells(cellValue) {
    const ids = [...new Set(linkedRecordIds(cellValue))];
    if (!ids.length) throw new Error('尺码关联字段为空或格式无效');
    let { byRecordId } = await this.load();
    if (ids.some((recordId) => !byRecordId.has(recordId))) {
      ({ byRecordId } = await this.load({ refresh: true }));
    }
    return ids.map((recordId) => {
      const entry = byRecordId.get(recordId);
      if (!entry) throw new Error(`尺码关联记录 ${recordId} 不在尺码管理中`);
      return entry;
    });
  }

  async resolveLinkedCell(cellValue) {
    const entries = await this.resolveLinkedCells(cellValue);
    if (entries.length !== 1) throw new Error('尺码关联字段必须且只能关联一个尺码');
    return entries[0];
  }
}

module.exports = { SizeReferenceService, normalizeSize };
