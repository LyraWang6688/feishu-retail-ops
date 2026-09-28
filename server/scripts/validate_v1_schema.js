const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { SizeReferenceService } = require('../src/services/sizeReferenceService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const { getV1SchemaScope } = require('../src/config/v1SchemaScopes');

const validateV1SchemaScope = async ({ gateway, scope = 'sales' }) => {
  const { key, tables: tableKeys } = getV1SchemaScope(scope);
  if (key === 'inventory' || key === 'all') {
    const sizeLinkTables = ['salesDetail', 'purchaseInbound', 'inventoryLedger', 'liveInventory'];
    if (key === 'all') sizeLinkTables.push('purchaseRequest');
    await new SizeReferenceService({ gateway }).validateSchema(sizeLinkTables);
  }
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
