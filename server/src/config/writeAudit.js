'use strict';

const path = require('node:path');
const { readFlag, readInt, readString } = require('./envValue');

/**
 * 飞书写入审计配置。
 * 按「业务域」开关：销售先开；采购/验收/退货/手工调整后续独立打开。
 * 审计只记录字段名和值，不记录飞书 token / 密钥；值会截断。
 */
const DOMAIN_ENV_KEYS = Object.freeze({
  sales: 'WRITE_AUDIT_SALES',
  purchase: 'WRITE_AUDIT_PURCHASE',
  acceptance: 'WRITE_AUDIT_ACCEPTANCE',
  return: 'WRITE_AUDIT_RETURN',
  inventoryManual: 'WRITE_AUDIT_INVENTORY_MANUAL',
});

const DEFAULT_DOMAINS = Object.freeze({
  sales: process.env.NODE_ENV !== 'test',
  purchase: false,
  acceptance: false,
  return: false,
  inventoryManual: process.env.NODE_ENV !== 'test',
});

const domains = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_DOMAINS).map(([domain, fallback]) => [
    domain,
    readFlag(process.env, DOMAIN_ENV_KEYS[domain], fallback),
  ]),
));

const WRITE_AUDIT = Object.freeze({
  enabled: readFlag(process.env, 'WRITE_AUDIT_ENABLED', true),
  domains,
  dir: readString(process.env, 'WRITE_AUDIT_DIR', path.join(__dirname, '..', '..', 'data', 'write_audit')).trim()
    || path.join(__dirname, '..', '..', 'data', 'write_audit'),
  maxValueLength: readInt(process.env, 'WRITE_AUDIT_MAX_VALUE_LENGTH', 300, { min: 20, max: 5000 }),
  maxFieldCount: readInt(process.env, 'WRITE_AUDIT_MAX_FIELD_COUNT', 40, { min: 1, max: 200 }),
  // 查询/页面口径（2026-11-14 #49：原来写死在 service / route 里）
  recentWindowHours: readInt(process.env, 'WRITE_AUDIT_RECENT_HOURS', 24, { min: 1, max: 720 }),
  recentMaxFiles: readInt(process.env, 'WRITE_AUDIT_RECENT_MAX_FILES', 3, { min: 1, max: 30 }),
  queryLimit: readInt(process.env, 'WRITE_AUDIT_QUERY_LIMIT', 500, { min: 1, max: 5000 }),
  queryDefaultLimit: readInt(process.env, 'WRITE_AUDIT_QUERY_DEFAULT_LIMIT', 1000, { min: 1, max: 10000 }),
  queryMaxLimit: readInt(process.env, 'WRITE_AUDIT_QUERY_MAX_LIMIT', 2000, { min: 1, max: 20000 }),
});

const auditDomainEnabled = (domain) => Boolean(
  WRITE_AUDIT.enabled && domain && WRITE_AUDIT.domains[String(domain)] === true,
);

/** 没有显式 audit.domain 时，按关联键推断业务域（只推断已开启的域）。 */
const auditDomainForCorrelation = (correlation = {}) => {
  if (correlation?.audit_domain && auditDomainEnabled(correlation.audit_domain)) return String(correlation.audit_domain);
  if (correlation?.order_no && auditDomainEnabled('sales')) return 'sales';
  if (correlation?.batch_no && auditDomainEnabled('purchase')) return 'purchase';
  return '';
};

module.exports = { WRITE_AUDIT, DOMAIN_ENV_KEYS, auditDomainEnabled, auditDomainForCorrelation };
