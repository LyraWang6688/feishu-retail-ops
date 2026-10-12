/** 只读：看生产 Base 是否开了高级权限（角色/字段可见性），以及该应用能看到的云文档。 */
const path = require('node:path');
const fs = require('node:fs');
const SERVER_DIR = process.env.SRV_DIR || '/opt/box2bitable/server';
const envPath = [path.join(SERVER_DIR, '.env'), path.join(SERVER_DIR, '..', '.env')].find((p) => fs.existsSync(p));
require(path.join(SERVER_DIR, 'node_modules/dotenv')).config({ path: envPath, quiet: true });
const lark = require(path.join(SERVER_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
const { getLarkAgentCredentials } = require(path.join(SERVER_DIR, 'src/config/larkAgent'));
(async () => {
  const { appId, appSecret } = getLarkAgentCredentials();
  const client = new lark.Client({ appId, appSecret, logger: { error(){}, warn(){}, info(){}, debug(){}, trace(){} } });
  const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
  try {
    const roles = await client.bitable.appRole.list({ path: { app_token: appToken }, params: { page_size: 100 } });
    console.log('roles:', JSON.stringify((roles.data?.items || []).map((r) => ({ role_name: r.role_name, table_roles: (r.table_roles || []).length }))));
  } catch (e) { console.log('roles ERROR:', e.message); }
  try {
    const files = await client.drive.file.list({ params: { page_size: 50 } });
    console.log('drive files:', JSON.stringify((files.data?.files || []).map((f) => ({ name: f.name, type: f.type, token: f.token })).slice(0, 30)));
  } catch (e) { console.log('drive ERROR:', e.message); }
})();
