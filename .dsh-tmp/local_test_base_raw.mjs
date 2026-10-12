/** 只读：测试 Base 销售主表四个新状态字段的原始定义 + 该表记录量与最近记录。 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SERVER = path.resolve('server');
require(path.join(SERVER, 'node_modules/dotenv')).config({ path: path.resolve('.env'), quiet: true });
if (!process.env.LARK_AGENT_APP_ID && process.env.LARK_TEST_APP_ID) {
  process.env.LARK_AGENT_APP_ID = process.env.LARK_TEST_APP_ID;
  process.env.LARK_AGENT_APP_SECRET = process.env.LARK_TEST_APP_SECRET;
}
const lark = require(path.join(SERVER, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER, 'src/config/larkAgent'));
const { appId, appSecret } = getLarkAgentCredentials();
const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
const tableId = process.env.FEISHU_V1_SALES_ENTRY_TABLE_ID;
console.log('salesEntry tableId:', tableId);
const fr = await client.bitable.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200 } });
const want = new Set(['确认状态', '销售状态', '资金状态', '库存状态', '解析状态', '收款状态']);
(fr.data?.items || []).forEach((f) => { if (want.has(f.field_name)) console.log(f.field_name, '=>', JSON.stringify(f.property)); });
let pageToken; let total = 0; const recs = [];
do {
  const r = await client.bitable.appTableRecord.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200, page_token: pageToken } });
  const items = r.data?.items || [];
  total += items.length; recs.push(...items);
  pageToken = r.data?.has_more ? r.data?.page_token : undefined;
} while (pageToken);
const flat = (v) => (v == null ? '' : Array.isArray(v) ? v.map(flat).join(',') : typeof v === 'object' ? String(v.text ?? v.name ?? v.value ?? '') : String(v));
console.log('records:', total);
const times = recs.map((r) => r.fields?.['录单日']).filter(Boolean).sort();
if (times.length) console.log('录单日范围:', new Date(Number(times[0])).toISOString(), '->', new Date(Number(times[times.length - 1])).toISOString());
const dist = {};
recs.forEach((r) => { const k = flat(r.fields?.['确认状态']) || '(空)'; dist[k] = (dist[k] || 0) + 1; });
console.log('测试 Base 确认状态分布:', JSON.stringify(dist));
recs.slice(-3).forEach((r) => console.log(' 样例:', JSON.stringify({ 单号: flat(r.fields?.['销售单号']), 解析状态: flat(r.fields?.['解析状态']), 确认状态: flat(r.fields?.['确认状态']), 销售状态: flat(r.fields?.['销售状态']), 资金状态: flat(r.fields?.['资金状态']), 库存状态: flat(r.fields?.['库存状态']) })));
