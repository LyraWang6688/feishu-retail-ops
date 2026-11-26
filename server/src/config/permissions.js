'use strict';

/**
 * 全工作台统一的角色权限矩阵（2026-11-26）。
 *
 * 角色来自「角色管理」表（可扩展）；这里只回答「某个角色能不能做某个动作」。
 * 新增板块时加一行，不要在路由里写 if (role === '管理员')。
 */
const ROLES = Object.freeze({ ADMIN: '管理员', STAFF: '店员' });

const PERMISSIONS = Object.freeze({
  'attendance.read.all': Object.freeze([ROLES.ADMIN]),
  'attendance.read.self': Object.freeze([ROLES.ADMIN, ROLES.STAFF]),
  'attendance.write': Object.freeze([ROLES.ADMIN]),
  'staff.write': Object.freeze([ROLES.ADMIN]),
});

const can = (role, permission) => (PERMISSIONS[permission] || []).includes(String(role || '').trim());
const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((key) => can(role, key));

module.exports = { ROLES, PERMISSIONS, can, permissionsOf };
