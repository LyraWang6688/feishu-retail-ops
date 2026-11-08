const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { getConfigRows, invalidateConfigTable } = require('./configTableCache');

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
  constructor({ gateway, now = Date.now } = {}) {
    if (!gateway) throw new Error('SizeReferenceService requires gateway');
    this.gateway = gateway;
    this.now = now;
  }

  clearCache() {
    // TTL / 快照只归 configTableCache 管；这里只作废它，不再维护第二份 cache。
    invalidateConfigTable('sizeManagement');
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
    if (refresh) invalidateConfigTable('sizeManagement');
    const field = this.gateway.table('sizeManagement').fields.size;
    const byNumber = new Map();
    const byRecordId = new Map();
    // 唯一快照归 configTableCache 管（TTL + 事件失效 + lastGood 告警）。
    const records = await getConfigRows({
      gateway: this.gateway, tableKey: 'sizeManagement',
      now: this.now,
    });
    for (const record of records) {
      const size = normalizeSize(textValue(record.fields?.[field]));
      if (!record.record_id) throw new Error(`尺码管理 ${size} 码缺少 record_id`);
      if (byNumber.has(size)) throw new Error(`尺码管理中 ${size} 码存在重复记录`);
      const entry = { recordId: record.record_id, size };
      byNumber.set(size, entry);
      byRecordId.set(record.record_id, entry);
    }
    return { byNumber, byRecordId };
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

// 取用尺码服务的统一入口：允许调用方注入实现（测试用桩），否则按需创建。
// 放在共享层而不是让每个服务各写一遍懒加载，新增模块时不必再复制同样的代码。
const createSizeReferenceAccess = ({ gateway, sizeReferences } = {}) => {
  let instance = sizeReferences || null;
  return () => {
    if (!instance) instance = new SizeReferenceService({ gateway });
    return instance;
  };
};

module.exports = { SizeReferenceService, createSizeReferenceAccess, normalizeSize };
