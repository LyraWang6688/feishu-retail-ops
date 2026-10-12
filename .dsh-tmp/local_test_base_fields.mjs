/** 只读：读本机 .env 指向的 Base（AGENTS.md 记为测试 Base）的销售主表字段。 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SERVER = path.resolve('server');
require(path.join(SERVER, 'node_modules/dotenv')).config({ path: path.resolve('.env'), quiet: true });
if (!process.env.LARK_AGENT_APP_ID && process.env.LARK_TEST_APP_ID) {
  process.env.LARK_AGENT_APP_ID = process.env.LARK_TEST_APP_ID;
  process.env.LARK_AGENT_APP_SECRET = process.env.LARK_TEST_APP_SECRET;
}
const lark = require(path.join(SERVER, 'node_modules/@larksuiteoapi/node-sdk'));
const { V1BitableGateway } = require(path.join(SERVER, 'src/services/v1BitableGateway'));
const { getLarkAgentCredentials } = require(path.join(SERVER, 'src/config/larkAgent'));
const fp = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12) : '(empty)');
const TYPES = { 1:'文本',2:'数字',3:'单选',4:'多选',5:'日期',7:'复选框',18:'单向关联',19:'查找引用',20:'公式',1001:'创建时间',1002:'修改时间',1005:'自动编号' };
const { appId, appSecret } = getLarkAgentCredentials();
const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
console.log('baseFingerprint:', fp(process.env.FEISHU_V1_BITABLE_APP_TOKEN));
const res = await client.bitable.appTable.list({ path: { app_token: process.env.FEISHU_V1_BITABLE_APP_TOKEN }, params: { page_size: 200 } });
console.log('tableCount:', (res.data?.items || []).length);
const gateway = new V1BitableGateway({ client });
for (const key of ['salesEntry', 'salesDetail', 'paymentRecord', 'inventoryLedger', 'liveInventory']) {
  try {
    const fields = await gateway.listFields(key, { refresh: true });
    console.log(`\n## ${key} (${fields.length})`);
    fields.forEach((f) => {
      const opts = (f.property?.options || []).map((o) => o.name);
      console.log(` - ${f.field_name} [${TYPES[f.type] || f.type}] ${opts.length ? 'opts=' + opts.join('/') : ''}`);
    });
  } catch (e) { console.log(`## ${key} ERROR ${e.message}`); }
}
