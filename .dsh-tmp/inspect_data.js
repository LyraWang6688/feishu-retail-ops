/** 只读：看销售主表记录量与该表最近记录的状态值，判断这个 Base 是不是真在用的生产 Base。 */
const path = require('node:path');
const fs = require('node:fs');
const SERVER_DIR = process.env.SRV_DIR || '/opt/box2bitable/server';
const envPath = [path.join(SERVER_DIR, '.env'), path.join(SERVER_DIR, '..', '.env')].find((p) => fs.existsSync(p));
require(path.join(SERVER_DIR, 'node_modules/dotenv')).config({ path: envPath, quiet: true });
const lark = require(path.join(SERVER_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER_DIR, 'src/config/larkAgent'));

const flat = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(',');
  if (typeof v === 'object') return String(v.text ?? v.name ?? v.value ?? '');
  return String(v);
};

(async () => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
  const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
  const tableId = 'tblLjFe3NjU61xKB';
  let pageToken; let total = 0; const records = [];
  do {
    const r = await client.bitable.appTableRecord.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200, page_token: pageToken } });
    const items = r.data?.items || [];
    total += items.length;
    records.push(...items);
    pageToken = r.data?.has_more ? r.data?.page_token : undefined;
  } while (pageToken && total < 2000);
  console.log('recordsFetched:', total, 'hasMore:', !!pageToken);
  const times = records.map((r) => r.fields?.['录单日']).filter(Boolean).sort();
  if (times.length) console.log('录单日 range:', new Date(Number(times[0])).toISOString(), '->', new Date(Number(times[times.length - 1])).toISOString());
  const byConfirm = {}; const byOrder = {};
  records.forEach((r) => {
    const c = flat(r.fields?.['确认状态']) || '(空)'; byConfirm[c] = (byConfirm[c] || 0) + 1;
    const o = flat(r.fields?.['订单状态']) || '(空)'; byOrder[o] = (byOrder[o] || 0) + 1;
  });
  console.log('确认状态分布:', JSON.stringify(byConfirm));
  console.log('订单状态分布:', JSON.stringify(byOrder));
  console.log('最近 3 条样例:');
  records.slice(-3).forEach((r) => {
    const f = r.fields || {};
    console.log(' -', JSON.stringify({ 销售单号: flat(f['销售单号']), 解析状态: flat(f['解析状态']), 确认状态: flat(f['确认状态']), 订单状态: flat(f['订单状态']), 收款状态: flat(f['收款状态']), 交易类型: flat(f['交易类型']) }));
  });
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
