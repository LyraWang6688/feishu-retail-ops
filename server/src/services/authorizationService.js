'use strict';

/**
 * 统一授权（2026-11-26）：登录 open_id → 花名册 actor → 权限矩阵。
 *
 * 口径（业务负责人确认）：
 *   · 不在花名册 / 在职=false ⇒ 拒绝进入与操作；
 *   · 角色来自花名册 →「角色管理」；权限矩阵在 config/permissions.js；
 *   · 不加管理员兜底 env。
 */
const { StaffDirectoryService } = require('./staffDirectoryService');
const { V1BitableGateway } = require('./v1BitableGateway');
const { canAny, permissionsOfRoles } = require('../config/permissions');
const { STAFF_TEXTS } = require('../config/workbenchStaff');

const resolveActor = async ({ gateway, openId }) => {
  const directory = new StaffDirectoryService({ gateway });
  const staff = await directory.findActor(openId);
  if (!staff || !staff.active) return null;
  const roleNames = Array.isArray(staff.roleNames) && staff.roleNames.length
    ? staff.roleNames
    : [staff.roleName].filter(Boolean);
  return {
    ...staff,
    // role 保留第一个角色名，兼容只看单角色的旧代码；权限按全部角色取并集。
    role: roleNames[0] || '',
    roleNames,
    permissions: permissionsOfRoles(roleNames),
  };
};

const loadWorkbenchActor = ({ gateway } = {}) => async (req, res, next) => {
  try {
    const gw = gateway || new V1BitableGateway();
    const actor = await resolveActor({ gateway: gw, openId: req.workbenchUser?.open_id });
    if (!actor) return res.status(403).json({ success: false, error: STAFF_TEXTS.forbidden });
    req.workbenchActor = actor;
    return next();
  } catch (error) {
    return next(error);
  }
};

const requirePermission = (permission) => (req, res, next) => {
  const actor = req.workbenchActor;
  if (!actor) return res.status(403).json({ success: false, error: STAFF_TEXTS.forbidden });
  const roles = Array.isArray(actor.roleNames) && actor.roleNames.length ? actor.roleNames : actor.role;
  if (!canAny(roles, permission)) {
    return res.status(403).json({ success: false, error: STAFF_TEXTS.roleForbidden });
  }
  return next();
};

module.exports = { resolveActor, loadWorkbenchActor, requirePermission };
