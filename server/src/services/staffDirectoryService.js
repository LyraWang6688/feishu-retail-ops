'use strict';

/**
 * 花名册目录（2026-11-26）：全工作台唯一的人员 → 角色来源。
 *
 * 数据走「花名册」配置表缓存（configTables.staff，24h + record_changed 失效）；
 * 「角色」是到「角色管理」的关联字段，**一个人可以挂多个角色**（2026-11-27）。
 * 角色名优先按 role record_id 映射「角色管理」表，映射不到再用关联 cell 的文本兜底。
 */
const { getConfigRows } = require('./configTableCache');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');

const ROLE_NAME_SEPARATORS = /[,，、;；\s]+/;
const firstCell = (value) => (Array.isArray(value) ? value[0] : value);
const plainText = (value) => textValue(value).trim();
/** 关联 cell → 全部 record_id（保留 #1074 的兼容，再兜一个单 record_id 形状）。 */
const roleIdsOf = (value) => {
  const ids = linkedRecordIds(value);
  if (ids.length) return [...new Set(ids)];
  const cell = firstCell(value);
  const single = cell?.record_id ? String(cell.record_id).trim() : '';
  return single ? [single] : [];
};
/** 关联 cell 的展示文本 → 角色名数组（多选关联可能是 '管理员,考勤人' 或 '管理员、考勤人'）。 */
const roleNamesOfText = (value) => [...new Set(
  String(textValue(value)).split(ROLE_NAME_SEPARATORS).map((name) => name.trim()).filter(Boolean),
)];

class StaffDirectoryService {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('StaffDirectoryService requires gateway');
    this.gateway = gateway;
  }

  /** role record_id → 角色名；角色表读不到时返回空 Map（调用方用文本兜底）。 */
  async roleNamesById() {
    try {
      const fields = this.gateway.table('staffRole').fields;
      const rows = await getConfigRows({ gateway: this.gateway, tableKey: 'staffRole' });
      return new Map((rows || []).map((row) => [row.record_id, plainText(row.fields?.[fields.name])]));
    } catch (error) {
      return new Map();
    }
  }

  async listStaff() {
    const fields = this.gateway.table('staff').fields;
    const [rows, namesById] = await Promise.all([
      getConfigRows({ gateway: this.gateway, tableKey: 'staff' }),
      this.roleNamesById(),
    ]);
    return (rows || []).map((row) => {
      const person = firstCell(row.fields?.[fields.name]) || {};
      const roleIds = roleIdsOf(row.fields?.[fields.role]);
      const byId = roleIds.map((id) => namesById.get(id)).filter(Boolean);
      // 角色表能映射全（byId 数量 = 关联数量）就只认映射结果，避免 cell 上残留旧文本；
      // 映射不全（角色表读不到 / 新角色还没进表）才用文本兜底补齐。
      const roleNames = roleIds.length > 0 && byId.length >= roleIds.length
        ? [...new Set(byId)]
        : [...new Set([...byId, ...roleNamesOfText(row.fields?.[fields.role])])];
      return {
        recordId: row.record_id,
        openId: plainText(person.id),
        name: plainText(person.name),
        roleRecordId: roleIds[0] || '',
        roleName: roleNames[0] || '',
        roleIds,
        roleNames,
        active: row.fields?.[fields.active] === true,
        attend: row.fields?.[fields.attendance] === true,
      };
    }).filter((staff) => staff.recordId);
  }

  async findActor(openId) {
    const id = plainText(openId);
    if (!id) return null;
    const staff = await this.listStaff();
    return staff.find((item) => item.openId === id) || null;
  }
}

module.exports = { StaffDirectoryService };
