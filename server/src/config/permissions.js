'use strict';

/**
 * 全工作台统一的角色权限矩阵（2026-11-26）。
 *
 * 角色来自「角色管理」表（可扩展）；这里只回答「某个角色能不能做某个动作」。
 * 新增板块时加一行，不要在路由里写 if (role === '管理员')。
 *
 * 2026-11-27：支持一人多角色。
 *   · 花名册「角色」是关联字段，可以挂多个角色（例：赵瑞玲 = 管理员 + 考勤人）；
 *   · 实际权限 = 所有角色权限的**并集**（permissionsOfRoles）；
 *   · 「考勤人」只负责看全员 + 代打卡，不给改/删（attendance.write 仍只给管理员）。
 */
const ROLES = Object.freeze({ ADMIN: '管理员', STAFF: '店员', ATTENDANCE: '考勤人' });

const PERMISSIONS = Object.freeze({
  'attendance.read.all': Object.freeze([ROLES.ADMIN, ROLES.ATTENDANCE]),
  'attendance.read.self': Object.freeze([ROLES.ADMIN, ROLES.STAFF]),
  'attendance.clock.self': Object.freeze([ROLES.ADMIN, ROLES.STAFF, ROLES.ATTENDANCE]),
  // 替别人上班/下班打卡（考勤人 + 管理员）；改/删仍走 attendance.write。
  'attendance.clock.any': Object.freeze([ROLES.ADMIN, ROLES.ATTENDANCE]),
  'attendance.write': Object.freeze([ROLES.ADMIN]),
  // 2026-11-27：库存裸扫页的成本只给管理员看；店员/考勤人/未知角色默认没有。
  'inventory.cost.read': Object.freeze([ROLES.ADMIN]),
  // 2026-11-28：销售「确认单」——本人改自己的单；管理员可改任意单。
  'sales.correction.self': Object.freeze([ROLES.ADMIN, ROLES.STAFF]),
  'sales.correction.any': Object.freeze([ROLES.ADMIN]),
});

const can = (role, permission) => (PERMISSIONS[permission] || []).includes(String(role || '').trim());
/** 多角色：任意一个角色有该权限即通过。 */
const canAny = (roles, permission) => (Array.isArray(roles) ? roles : [roles])
  .some((role) => can(role, permission));
const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((key) => can(role, key));
/** 多角色：把每个人的角色权限取并集（保持矩阵里的动作顺序）。 */
const permissionsOfRoles = (roles) => [...new Set(
  (Array.isArray(roles) ? roles : [roles]).flatMap((role) => permissionsOf(role)),
)];

module.exports = { ROLES, PERMISSIONS, can, canAny, permissionsOf, permissionsOfRoles };
