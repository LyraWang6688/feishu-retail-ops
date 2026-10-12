/**
 * 只读：读生产 Base 的真实字段（字段名 / 类型 / 选项）。
 * 走项目代码 V1BitableGateway.listFields。绝不写表、绝不打印任何 secret。
 */
const path = require('node:path');
const SERVER_DIR = process.env.SRV_DIR || '/opt/box2bitable/server';
const fs = require('node:fs');
const envCandidates = [path.join(SERVER_DIR, '.env'), path.join(SERVER_DIR, '..', '.env')];
const envPath = envCandidates.find((p) => fs.existsSync(p));
require(path.join(SERVER_DIR, 'node_modules/dotenv')).config({ path: envPath, quiet: true });
const lark = require(path.join(SERVER_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
const { V1BitableGateway } = require(path.join(SERVER_DIR, 'src/services/v1BitableGateway'));
const { V1_BITABLE_SCHEMA } = require(path.join(SERVER_DIR, 'src/config/v1BitableSchema'));
const { getLarkAgentCredentials } = require(path.join(SERVER_DIR, 'src/config/larkAgent'));

const TYPE_NAMES = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框',
  11: '人员', 13: '电话', 15: '超链接', 17: '附件', 18: '单向关联',
  19: '查找引用(lookup)', 20: '公式', 21: '双向关联', 22: '地理位置',
  23: '群组', 1001: '创建时间', 1002: '修改时间', 1003: '创建人',
  1004: '修改人', 1005: '自动编号',
};

const describeField = (f) => {
  const prop = f.property || {};
  const options = (prop.options || []).map((o) => o.name);
  const out = {
    name: f.field_name,
    field_id: f.field_id,
    type: f.type,
    typeName: TYPE_NAMES[f.type] || `未知(${f.type})`,
    isPrimary: !!f.is_primary,
  };
  if (options.length) out.options = options;
  if (prop.formatter) out.formatter = prop.formatter;
  if (prop.table_id) out.linkedTableId = prop.table_id;
  if (prop.field_id) out.lookupFieldId = prop.field_id;
  if (prop.filter_info) out.filter = prop.filter_info;
  if (prop.auto_fill != null) out.autoFill = prop.auto_fill;
  if (f.type === 20 || f.type === 19) out.rawProperty = JSON.stringify(prop);
  return out;
};

(async () => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger }) });

  const keysArg = process.argv[2];
  const keys = keysArg ? keysArg.split(',') : Object.keys(V1_BITABLE_SCHEMA.tables);
  const report = {};
  for (const key of keys) {
    const table = V1_BITABLE_SCHEMA.tables[key];
    if (!table) { report[key] = { error: 'unknown table key' }; continue; }
    try {
      const fields = await gateway.listFields(key, { refresh: true });
      report[key] = {
        tableName: table.tableName,
        tableId: table.tableId,
        fieldCount: fields.length,
        fieldNames: fields.map((f) => f.field_name),
        fields: fields.map(describeField),
      };
    } catch (e) {
      report[key] = { tableName: table.tableName, tableId: table.tableId, error: e.message };
    }
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
