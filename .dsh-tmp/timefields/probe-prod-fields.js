'use strict';
/**
 * 一次性只读脚本（放在服务器 /tmp 跑，用项目自己的 gateway 读生产 Base 字段）。
 *
 * 目的：核实「发生时间 / 入库时间 / 报单时间」这三个时间字段在【生产真表】里到底还在不在。
 * 只读：只调 appTableField.list（gateway.listFields）。
 * 不写、不改、不重启、不动服务器代码与 .env；不打印任何 token / secret 值。
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
const { V1_BITABLE_SCHEMA } = require(`${SERVER}/src/config/v1BitableSchema`);

const TARGETS = ['发生时间', '入库时间', '报单时间', '创建时间', '更新时间'];
const TIME_KEYS = ['purchaseReport', 'purchaseInbound', 'inventoryLedger', 'customerCredit'];

const main = async () => {
  console.log(`凭证就位（只报有没有）: LARK_AGENT_APP_ID=${Boolean(process.env.LARK_AGENT_APP_ID)} LARK_AGENT_APP_SECRET=${Boolean(process.env.LARK_AGENT_APP_SECRET)} FEISHU_V1_BITABLE_APP_TOKEN=${Boolean(process.env.FEISHU_V1_BITABLE_APP_TOKEN)}`);
  const { appId, appSecret } = getLarkAgentCredentials();
  const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger: silent }) });

  console.log('\n########## A. 关键四张表：真表字段全量 ##########');
  for (const key of TIME_KEYS) {
    const table = gateway.table(key);
    let fields;
    try {
      fields = await gateway.listFields(key, { refresh: true });
    } catch (error) {
      console.log(`\n=== ${key} ${table.tableName} tableId=${table.tableId} === 读取失败: ${error.message}`);
      continue;
    }
    const names = fields.map((f) => f.field_name);
    console.log(`\n=== ${key} ${table.tableName} tableId=${table.tableId} 真表 ${fields.length} 列 ===`);
    fields.forEach((f) => console.log(`    - ${f.field_name}  (type=${f.type}${f.ui_type ? `/${f.ui_type}` : ''})`));
    TARGETS.forEach((t) => console.log(`    目标字段「${t}」: ${names.includes(t) ? '存在' : '不存在'}`));
  }

  console.log('\n########## B. schema 里映射的所有表：扫描目标字段 ##########');
  for (const key of Object.keys(V1_BITABLE_SCHEMA.tables)) {
    const table = gateway.table(key);
    if (!table.tableId) { console.log(`SKIP ${key} ${table.tableName}（tableId 为空）`); continue; }
    let fields;
    try {
      fields = await gateway.listFields(key, { refresh: true });
    } catch (error) {
      console.log(`❌ ${key} ${table.tableName} 读取失败: ${error.message}`);
      continue;
    }
    const names = fields.map((f) => f.field_name);
    const hit = TARGETS.filter((t) => names.includes(t));
    const mapped = Object.entries(table.fields).filter(([, name]) => TARGETS.includes(name));
    console.log(`${key} ${table.tableName}(tableId=${table.tableId}): 真表命中[${hit.join('、') || '无'}] | 代码映射[${mapped.map(([k, v]) => `${k}->${v}`).join('、') || '无'}]`);
  }

  console.log('\n########## C. 结论行 ##########');
  for (const key of TIME_KEYS) {
    const table = gateway.table(key);
    let names = [];
    try { names = (await gateway.listFields(key, { refresh: true })).map((f) => f.field_name); } catch { /* 上面已报 */ }
    console.log(`${table.tableName}: 发生时间=${names.includes('发生时间') ? '有' : '无'} 入库时间=${names.includes('入库时间') ? '有' : '无'} 报单时间=${names.includes('报单时间') ? '有' : '无'}`);
  }
  console.log('\nGATE_PROBE=DONE');
};

main().catch((error) => {
  console.log(`读取失败: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
