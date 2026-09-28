const V1_SCHEMA_SCOPES = {
  sales: ['product', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord'],
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

module.exports = { V1_SCHEMA_SCOPES, V1_SIZE_LINK_TABLES, getV1SchemaScope, getV1SizeLinkTables };
