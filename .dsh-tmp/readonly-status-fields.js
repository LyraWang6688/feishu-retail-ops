#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: dump every 状态-class field of the target Base,
 * together with its single/multi-select option values (原文).
 *
 * Rules honoured:
 *  - goes through the PROJECT's own gateway (V1BitableGateway.listFields →
 *    lark SDK bitable.appTableField.list), not a hand-rolled call and no CLI;
 *  - every write method is hard-blocked below, so this process physically cannot
 *    create / update / delete anything;
 *  - never prints env values, tokens or secrets.
 *
 * Run ON THE SERVER, from the deployed checkout, so the production .env applies.
 */
const path = require('path');

const ROOT = process.env.DIAG_ROOT || '/opt/box2bitable/server';
// Resolved from the project, because this script itself lives outside the repo.
const dotenv = require(path.join(ROOT, 'node_modules/dotenv'));
// Same path/shape the app itself uses (src/app.js: ../../.env from src/).
dotenv.config({ path: path.join(ROOT, '..', '.env'), quiet: true });

const { V1BitableGateway } = require(path.join(ROOT, 'src/services/v1BitableGateway'));
const { V1_BITABLE_SCHEMA } = require(path.join(ROOT, 'src/config/v1BitableSchema'));

const TYPES = {
  1: '多行文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框',
  11: '人员', 13: '电话', 15: '超链接', 17: '附件', 18: '单向关联',
  19: '查找引用', 20: '公式', 21: '双向关联', 22: '地理位置', 23: '群组',
  1001: '创建时间', 1002: '最后更新时间', 1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

const STATUS_RE = /状态/;
const optionNames = (field) => {
  const opts = field?.property?.options;
  if (!Array.isArray(opts)) return null;
  return opts.map((o) => (o && typeof o === 'object' ? o.name ?? String(o) : String(o)));
};

// --- write guard: this script must not be able to mutate anything -----------
const gw = new V1BitableGateway();
for (const method of ['create', 'update', 'delete', 'uploadAttachment']) {
  gw[method] = () => {
    throw new Error(`WRITE BLOCKED by read-only diagnostic: ${method}`);
  };
}

const GATE = process.argv[2] || 'fields';

(async () => {
  if (GATE === 'fields') {
    const report = { readOnly: true, gate: 'fields', tables: [] };
    for (const key of Object.keys(V1_BITABLE_SCHEMA.tables)) {
      const table = V1_BITABLE_SCHEMA.tables[key];
      try {
        const fields = await gw.listFields(key, { refresh: true });
        report.tables.push({
          key,
          tableName: table.tableName,
          tableId: table.tableId,
          schemaStatusMappings: Object.entries(table.fields || {})
            .filter(([, v]) => STATUS_RE.test(v))
            .map(([k, v]) => `${k}=${v}`),
          statusFieldsOnRealTable: fields
            .filter((f) => STATUS_RE.test(f.field_name || ''))
            .map((f) => ({
              field_name: f.field_name,
              type: f.type,
              typeName: TYPES[f.type] || String(f.type),
              optionCount: optionNames(f) ? optionNames(f).length : null,
              options: optionNames(f),
            })),
          totalFieldCount: fields.length,
        });
      } catch (error) {
        report.tables.push({ key, tableName: table.tableName, error: error.message });
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (GATE === 'usage') {
    // Aggregate-only: how many records currently sit on each option value.
    // No other column, no record id, no text is printed.
    const targets = (process.argv[3] || 'salesEntry,salesDetail,paymentRecord,purchaseArrival,purchaseReport,purchaseRequest').split(',');
    const report = { readOnly: true, gate: 'usage', tables: [] };
    for (const key of targets) {
      const table = V1_BITABLE_SCHEMA.tables[key];
      try {
        const records = await gw.listAll(key);
        const statusNames = Object.entries(table.fields || {})
          .filter(([, v]) => STATUS_RE.test(v))
          .map(([, v]) => v);
        const counts = {};
        for (const name of statusNames) {
          counts[name] = {};
          for (const record of records) {
            const raw = record.fields?.[name];
            const value = Array.isArray(raw)
              ? raw.map((r) => (r && typeof r === 'object' ? r.text ?? r.name ?? '' : r)).join('|')
              : raw == null ? '(空)' : typeof raw === 'object' ? String(raw.text ?? raw.name ?? '') || '(对象)' : String(raw);
            const bucket = value === '' ? '(空)' : value;
            counts[name][bucket] = (counts[name][bucket] || 0) + 1;
          }
        }
        report.tables.push({ key, tableName: table.tableName, recordCount: records.length, valueCounts: counts });
      } catch (error) {
        report.tables.push({ key, tableName: table.tableName, error: error.message });
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (GATE === 'raw') {
    const targets = (process.argv[3] || 'salesEntry').split(',');
    const report = { readOnly: true, gate: 'raw', tables: [] };
    for (const key of targets) {
      const table = V1_BITABLE_SCHEMA.tables[key];
      try {
        const fields = await gw.listFields(key, { refresh: true });
        report.tables.push({
          key,
          tableName: table.tableName,
          tableId: table.tableId,
          schemaMappedNames: Object.values(table.fields || {}),
          fields: fields.map((f) => ({
            field_name: f.field_name,
            typeName: TYPES[f.type] || String(f.type),
            options: optionNames(f),
          })),
        });
      } catch (error) {
        report.tables.push({ key, error: error.message });
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  throw new Error(`unknown gate: ${GATE}`);
})().catch((error) => {
  console.error(`DIAG FAILED: ${error.message}`);
  process.exit(1);
});
