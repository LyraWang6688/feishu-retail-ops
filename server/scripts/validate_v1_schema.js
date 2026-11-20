const path = require('node:path');
// quiet：dotenv >=17 默认会往 stdout 打一行 "injected env (N) from .env"，
// 会混进这个脚本自己的输出。dotenv 16 会忽略该选项。
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { SizeReferenceService } = require('../src/services/sizeReferenceService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const { getV1SchemaScope, getV1SizeLinkTables, getV1IdempotencyKeyTables } = require('../src/config/v1SchemaScopes');
const { validateIdempotencyKeyFields } = require('../src/infrastructure/idempotencyKey');

const validateV1SchemaScope = async ({ gateway, scope = 'sales' }) => {
  const { key, tables: tableKeys } = getV1SchemaScope(scope);
  const sizeLinkTables = getV1SizeLinkTables(key);
  if (sizeLinkTables.length) {
    await new SizeReferenceService({ gateway }).validateSchema(sizeLinkTables);
  }
  // 尺码关联先校验：它决定读到的业务含义，幂等键只决定重试是否安全。
  // 两者都失败时，先报出的应该是更根本的那个。
  await validateIdempotencyKeyFields({ gateway, tables: getV1IdempotencyKeyTables(key) });
  const result = await gateway.validateTables(tableKeys);
  if (key === 'inventory' || key === 'all') {
    await new InventoryService({ gateway, store: {} }).validateStockBehaviors();
  }
  return { scope: key, result };
};

if (require.main === module) {
  const requiredCredentials = ['LARK_AGENT_APP_ID', 'LARK_AGENT_APP_SECRET'];
  const missing = requiredCredentials.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Missing V1 Feishu config: ${missing.join(', ')}`);
    process.exit(1);
  }
  // The SDK's default error logger can print request config, including the
  // app secret. Schema checks only surface sanitized error messages below.
  const { appId, appSecret } = getLarkAgentCredentials();
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger }) });
  validateV1SchemaScope({ gateway, scope: process.argv[2] || 'sales' })
    .then(({ scope, result }) => {
      console.log(`Schema scope: ${scope}`);
      result.forEach((item) => console.log(`OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`));
    }).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { validateV1SchemaScope };
