const path = require('node:path');
// quiet：dotenv >=17 默认会往 stdout 打一行 "injected env (N) from .env"，
// 会混进这个脚本自己的输出。dotenv 16 会忽略该选项。
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { SizeReferenceService } = require('../src/services/sizeReferenceService');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const { getV1SchemaScope, getV1SizeLinkTables, getV1IdempotencyKeyTables, getV1SelectOptionContracts } = require('../src/config/v1SchemaScopes');
const { validateIdempotencyKeyFields } = require('../src/infrastructure/idempotencyKey');

/**
 * 「单选取值契约」校验（**只读**）：真表这一列必须是单选，且**已经存在**代码要写的那些选项名。
 *
 * 为什么必须有这一条（2026-10-07，随「报货批次.到货状态」一起加的）：
 *   往飞书的单选字段里写一个**不存在的取值**，飞书不会报错，而是**自动新建一个选项**
 *   —— 表被悄悄污染，而 9 点推送按「未到货」查会**静默查不到**
 *   （与 AGENTS.md 第 11 条①「已扣减 vs 已写入」是同一个事故形态）。
 *   字段名闸门（`validateTables`）看不出取值，所以取值必须单独做契约。
 *
 * ⚠️ 字段**不存在**时不在这里报错 —— 存在性由 `validateTables` 负责（它先跑，
 *    报出来的话更根本）。这里只回答"这一列的取值域对不对"。
 */
const validateSelectOptionContracts = async ({ gateway, contracts = [] }) => {
  for (const contract of contracts) {
    const table = gateway.table(contract.tableKey);
    const fieldName = table?.fields?.[contract.fieldKey];
    if (!fieldName) continue;
    const fields = await gateway.listFields(contract.tableKey, { refresh: true });
    const field = (fields || []).find((item) => item.field_name === fieldName);
    if (!field) continue;
    if (field.type !== 3) {
      throw new Error(`「${table.tableName}」的「${fieldName}」必须是单选字段`
        + `（当前 type=${field.type}），代码要往里写「${contract.requiredOptions.join(' / ')}」`);
    }
    const names = (field.property?.options || []).map((option) => String(option?.name ?? ''));
    const missing = contract.requiredOptions.filter((value) => !names.includes(value));
    if (missing.length) {
      throw new Error(`「${table.tableName}」的「${fieldName}」缺少选项: ${missing.join('、')}`
        + `（真表现有：${names.join(' / ') || '（没有选项）'}）`
        + ' —— 写一个不存在的取值，飞书会自动新建选项、把表污染掉，必须先在表里加上它');
    }
  }
};

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
  // 字段名绿了才看取值域（字段都不在时，报"取值不对"会把人带偏）。
  await validateSelectOptionContracts({ gateway, contracts: getV1SelectOptionContracts(key) });
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
