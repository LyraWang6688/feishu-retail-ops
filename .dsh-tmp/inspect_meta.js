/** 只读：打印 Base 指纹（sha256 前 12 位）、表清单。绝不打印 token 原文。 */
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const SERVER_DIR = process.env.SRV_DIR || '/opt/box2bitable/server';
const envCandidates = [path.join(SERVER_DIR, '.env'), path.join(SERVER_DIR, '..', '.env')];
const envPath = envCandidates.find((p) => fs.existsSync(p));
require(path.join(SERVER_DIR, 'node_modules/dotenv')).config({ path: envPath, quiet: true });
const lark = require(path.join(SERVER_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER_DIR, 'src/config/larkAgent'));

const fp = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12) : '(empty)');

(async () => {
  console.log('envFile:', envPath);
  console.log('fp(FEISHU_V1_BITABLE_APP_TOKEN) =', fp(process.env.FEISHU_V1_BITABLE_APP_TOKEN));
  console.log('fp(FEISHU_V1_E2E_TEST_APP_TOKEN) =', fp(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN));
  console.log('same:', String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '') === String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || ''));
  console.log('FEISHU_TARGET_ENV =', process.env.FEISHU_TARGET_ENV || '(unset)');
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
  const res = await client.bitable.appTable.list({ path: { app_token: process.env.FEISHU_V1_BITABLE_APP_TOKEN }, params: { page_size: 100 } });
  const items = res.data?.items || [];
  console.log('tableCount:', items.length);
  items.forEach((t) => console.log(' -', t.table_id, t.name));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
