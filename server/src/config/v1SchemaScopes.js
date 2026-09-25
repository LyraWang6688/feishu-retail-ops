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
  inventory: ['product', 'behavior', 'salesDetail', 'purchaseInbound', 'inventoryLedger', 'liveInventory'],
};

V1_SCHEMA_SCOPES.all = [...new Set(Object.values(V1_SCHEMA_SCOPES).flat())];

const getV1SchemaScope = (scope = 'sales') => {
  const key = String(scope || 'sales').trim().toLowerCase();
  const tables = V1_SCHEMA_SCOPES[key];
  if (!tables) throw new Error(`未知 Schema 范围: ${scope}`);
  return { key, tables };
};

module.exports = { V1_SCHEMA_SCOPES, getV1SchemaScope };
