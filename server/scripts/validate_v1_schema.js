const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { getV1SchemaScope } = require('../src/config/v1SchemaScopes');

const requiredCredentials = ['LARK_AGENT_APP_ID', 'LARK_AGENT_APP_SECRET'];
const missing = requiredCredentials.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing V1 Feishu config: ${missing.join(', ')}`);
  process.exit(1);
}

const { key: scope, tables: tableKeys } = getV1SchemaScope(process.argv[2] || 'sales');

(async () => {
  const gateway = new V1BitableGateway();
  const result = await gateway.validateTables(tableKeys);
  console.log(`Schema scope: ${scope}`);
  result.forEach((item) => console.log(`OK ${item.tableKey} ${item.tableId} fields=${item.fieldCount}`));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
