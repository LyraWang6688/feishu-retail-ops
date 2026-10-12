import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SERVER = path.resolve('server');
require(path.join(SERVER, 'node_modules/dotenv')).config({ path: path.resolve('.env'), quiet: true });
if (!process.env.LARK_AGENT_APP_ID && process.env.LARK_TEST_APP_ID) { process.env.LARK_AGENT_APP_ID = process.env.LARK_TEST_APP_ID; process.env.LARK_AGENT_APP_SECRET = process.env.LARK_TEST_APP_SECRET; }
const lark = require(path.join(SERVER, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER, 'src/config/larkAgent'));
const { appId, appSecret } = getLarkAgentCredentials();
const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
const tr = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 200 } });
const tables = tr.data?.items || [];
console.log('表数:', tables.length);
console.log(tables.map((t) => `${t.name}(${t.table_id})`).join(', '));
console.log('\n--- 含「状态」字段的表 ---');
for (const t of tables) {
  const r = await client.bitable.appTableField.list({ path: { app_token: appToken, table_id: t.table_id }, params: { page_size: 200 } });
  const hits = (r.data?.items || []).filter((f) => /状态/.test(f.field_name));
  hits.forEach((f) => console.log(`${t.name} | ${f.field_name} | type=${f.type} | ${JSON.stringify((f.property?.options || []).map((o) => o.name))}`));
}
