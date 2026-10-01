const V1_SCHEMA_SCOPES = {
  // accessory（其他配品）也纳入销售范围：销售明细的「配品」字段指向它，缺配置会在运行时才炸。
  sales: ['product', 'accessory', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord'],
  purchase: [
    'product',
    'supplier',
    'purchaseReport',
    'purchaseRequest',
    'purchaseOrderBatch',
    'purchaseArrival',
    'purchaseInbound',
  ],
  inventory: ['product', 'behavior', 'sizeManagement', 'salesDetail', 'purchaseInbound', 'inventoryLedger', 'liveInventory'],
};

V1_SCHEMA_SCOPES.all = [...new Set(Object.values(V1_SCHEMA_SCOPES).flat())];

const getV1SchemaScope = (scope = 'sales') => {
  const key = String(scope || 'sales').trim().toLowerCase();
  const tables = V1_SCHEMA_SCOPES[key];
  if (!tables) throw new Error(`未知 Schema 范围: ${scope}`);
  return { key, tables };
};

// 「尺码」已从数字字段改为单选关联「尺码管理」。validateTables 只核对字段名，
// 看不出数字、多选或指错表，所以每个范围都要显式声明需要核对关联的表，
// 而不是让运维记住只有 inventory/all 覆盖这件事。
const V1_SIZE_LINK_TABLES = {
  sales: ['salesDetail'],
  purchase: ['purchaseRequest', 'purchaseInbound'],
  inventory: ['salesDetail', 'purchaseInbound', 'inventoryLedger', 'liveInventory'],
};
V1_SIZE_LINK_TABLES.all = [...new Set(Object.values(V1_SIZE_LINK_TABLES).flat())];

const getV1SizeLinkTables = (scope = 'sales') => V1_SIZE_LINK_TABLES[getV1SchemaScope(scope).key] || [];

// 幂等键字段同样必须真实存在，且是文本字段（见 infrastructure/idempotencyKey.js）。
// 采购批次 / 采购申请 / 实时库存的写入都靠它做「先回查再创建」，字段缺失时
// 宁可部署门槛拦下来，也不能等到用户确认采购时才报错。
const V1_IDEMPOTENCY_KEY_TABLES = {
  purchase: ['purchaseOrderBatch', 'purchaseRequest'],
  inventory: ['liveInventory'],
};
V1_IDEMPOTENCY_KEY_TABLES.all = [...new Set(Object.values(V1_IDEMPOTENCY_KEY_TABLES).flat())];

const getV1IdempotencyKeyTables = (scope = 'sales') =>
  V1_IDEMPOTENCY_KEY_TABLES[getV1SchemaScope(scope).key] || [];

module.exports = {
  V1_SCHEMA_SCOPES,
  V1_SIZE_LINK_TABLES,
  V1_IDEMPOTENCY_KEY_TABLES,
  getV1SchemaScope,
  getV1SizeLinkTables,
  getV1IdempotencyKeyTables,
};
