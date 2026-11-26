'use strict';

/**
 * 花名册目录（2026-11-26）：全工作台唯一的人员 → 角色来源。
 *
 * 数据走「花名册」配置表缓存（configTables.staff，24h + record_changed 失效）；
 * 「角色」是到「角色管理」的单向关联，角色名以关联 cell 的 text 为准。
 */
const { getConfigRows } = require('./configTableCache');
const { textValue } = require('./v1BitableGateway');

const firstCell = (value) => (Array.isArray(value) ? value[0] : value);
const plainText = (value) => textValue(value).trim();
const linkedIds = (value) => {
  const cell = firstCell(value);
  if (!cell) return [];
  const ids = cell.record_ids || cell.link_record_ids || (cell.record_id ? [cell.record_id] : []);
  return (Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean);
};
const linkedText = (value) => plainText(firstCell(value));

class StaffDirectoryService {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('StaffDirectoryService requires gateway');
    this.gateway = gateway;
  }

  async listStaff() {
    const fields = this.gateway.table('staff').fields;
    const rows = await getConfigRows({ gateway: this.gateway, tableKey: 'staff' });
    return (rows || []).map((row) => {
      const person = firstCell(row.fields?.[fields.name]) || {};
      return {
        recordId: row.record_id,
        openId: plainText(person.id),
        name: plainText(person.name),
        roleRecordId: linkedIds(row.fields?.[fields.role])[0] || '',
        roleName: linkedText(row.fields?.[fields.role]),
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

  async listRoles() {
    const fields = this.gateway.table('staffRole').fields;
    const rows = await getConfigRows({ gateway: this.gateway, tableKey: 'staffRole' });
    return (rows || []).map((row) => ({
      recordId: row.record_id,
      name: plainText(row.fields?.[fields.name]),
      note: plainText(row.fields?.[fields.note]),
    })).filter((role) => role.recordId);
  }

  async findRole(recordId) {
    const id = plainText(recordId);
    if (!id) return null;
    const roles = await this.listRoles();
    return roles.find((role) => role.recordId === id) || null;
  }
}

module.exports = { StaffDirectoryService };
