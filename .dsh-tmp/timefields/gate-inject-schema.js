'use strict';
/**
 * 一次性只读脚本（放服务器 /tmp 跑）：
 * 把**分支上的新 schema** 注入 V1BitableGateway，然后在生产 Base 上跑
 * 与部署闸门 `v1:schema-check:all` **完全相同**的那套校验
 *（字段存在性 + 尺码关联 + 幂等键字段 + 库存行为注册表）。
 *
 * 为什么要在服务器上跑：本地 .env 指向测试 Base，而判据是"生产真表 + 新映射"。
 * 为什么注入 schema：服务器上的代码是旧的（还带着 reportedAt / inboundAt 映射），
 * 直接 `node scripts/validate_v1_schema.js all` 跑的是旧映射，不是这次要验的东西。
 *
 * 只读：只用 appTableField.list / appTableRecord.list（listFields / validateTables）。
 * 不写、不改服务器代码、不重启、不动服务器 .env；不打印任何 token / secret 值。
 */
const fs = require('node:fs');
const SERVER = '/opt/box2bitable/server';

const dotenv = require(`${SERVER}/node_modules/dotenv`);
const ENV_PATH = ['/opt/box2bitable/.env', `${SERVER}/.env`].find((p) => fs.existsSync(p));
if (!ENV_PATH) throw new Error('找不到生产 .env');
dotenv.config({ path: ENV_PATH, quiet: true });

const lark = require(`${SERVER}/node_modules/@larksuiteoapi/node-sdk`);
const { V1BitableGateway } = require(`${SERVER}/src/services/v1BitableGateway`);
const { getLarkAgentCredentials } = require(`${SERVER}/src/config/larkAgent`);
const { validateV1SchemaScope } = require(`${SERVER}/scripts/validate_v1_schema.js`);
// 分支上的新 schema（scp 上来的那一份），与服务器上的旧 schema 是两个模块实例。
const { V1_BITABLE_SCHEMA: NEW_SCHEMA } = require('/tmp/new-v1BitableSchema.js');
const { V1_BITABLE_SCHEMA: OLD_SCHEMA } = require(`${SERVER}/src/config/v1BitableSchema`);

const KEYS = ['purchaseReport', 'purchaseInbound', 'inventoryLedger', 'customerCredit'];

(async () => {
  console.log(`凭证就位（只报有没有）: LARK_AGENT_APP_ID=${Boolean(process.env.LARK_AGENT_APP_ID)} LARK_AGENT_APP_SECRET=${Boolean(process.env.LARK_AGENT_APP_SECRET)} FEISHU_V1_BITABLE_APP_TOKEN=${Boolean(process.env.FEISHU_V1_BITABLE_APP_TOKEN)}`);

  console.log('\n注入证明（旧 = 服务器上那份 schema；新 = /tmp/new-v1BitableSchema.js）：');
  for (const key of KEYS) {
    const o = OLD_SCHEMA.tables[key];
    const n = NEW_SCHEMA.tables[key];
    const show = (t) => `reportedAt=${t.fields.reportedAt || '-'} inboundAt=${t.fields.inboundAt || '-'} occurredAt=${t.fields.occurredAt || '-'}`;
    console.log(
      `  ${key} ${n.tableName} tableId 旧=${o.tableId} 新=${n.tableId} | 映射条数 旧${Object.keys(o.fields).length} 新${Object.keys(n.fields).length}\n` +
      `      旧: ${show(o)}\n      新: ${show(n)}`,
    );
  }

  const { appId, appSecret } = getLarkAgentCredentials();
  const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const gateway = new V1BitableGateway({
    schema: NEW_SCHEMA,
    client: new lark.Client({ appId, appSecret, logger: silent }),
  });

  console.log('\n开始跑闸门（scope=all，注入新 schema）...');
  const { scope, result } = await validateV1SchemaScope({ gateway, scope: 'all' });
  console.log(`Schema scope: ${scope}`);
  result.forEach((item) => console.log(`OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`));
  console.log('\nGATE_RESULT=GREEN');
})().catch((error) => {
  console.log('\nGATE_RESULT=RED');
  console.log(`原因: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
