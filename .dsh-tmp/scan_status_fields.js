/** 只读：扫描整个 Base 所有表里名字含「状态」的字段，定位她新建的 4 个状态字段在哪张表。 */
const path = require('node:path');
const fs = require('node:fs');
const SERVER_DIR = process.env.SRV_DIR || '/opt/box2bitable/server';
const envPath = [path.join(SERVER_DIR, '.env'), path.join(SERVER_DIR, '..', '.env')].find((p) => fs.existsSync(p));
require(path.join(SERVER_DIR, 'node_modules/dotenv')).config({ path: envPath, quiet: true });
const lark = require(path.join(SERVER_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER_DIR, 'src/config/larkAgent'));
const TYPES = { 1:'文本',2:'数字',3:'单选',4:'多选',5:'日期',7:'复选框',11:'人员',13:'电话',15:'超链接',17:'附件',18:'单向关联',19:'查找引用',20:'公式',21:'双向关联',1001:'创建时间',1002:'修改时间',1003:'创建人',1004:'修改人',1005:'自动编号' };

(async () => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
  const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
  const tablesRes = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 200 } });
  const tables = tablesRes.data?.items || [];
  const hits = [];
  for (const t of tables) {
    let pageToken; const fields = [];
    do {
      const r = await client.bitable.appTableField.list({ path: { app_token: appToken, table_id: t.table_id }, params: { page_size: 200, page_token: pageToken } });
      fields.push(...(r.data?.items || []));
      pageToken = r.data?.has_more ? r.data?.page_token : undefined;
    } while (pageToken);
    fields.forEach((f) => {
      if (/状态|销售状态|资金状态|库存状态/.test(f.field_name)) {
        hits.push({ table: t.name, tableId: t.table_id, field: f.field_name, fieldId: f.field_id, type: TYPES[f.type] || f.type,
          options: (f.property?.options || []).map((o) => o.name) });
      }
    });
  }
  console.log(JSON.stringify(hits, null, 1));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
