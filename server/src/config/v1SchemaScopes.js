const V1_SCHEMA_SCOPES = {
  // accessory（其他配品）也纳入销售范围：销售明细的「配品」字段指向它，缺配置会在运行时才炸。
  // customerCredit（客户往来货款）同样落在销售范围：退换货 prepaid 走这张表，
  // 不纳入范围的话它改名/缺列只能在用户确认售后时才炸（今天已经因字段不同步踩过两次）。
  sales: ['product', 'accessory', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord', 'customerCredit'],
  purchase: [
    'product',
    'supplier',
    'purchaseReport',
    'purchaseRequest',
    'purchaseOrderBatch',
    // ⚠️ `purchaseArrival`（「到货验收」）已从 schema 与这里**一并删除**（2026-10-07 晚）：
    //    业务负责人把那张表整个删了，到货落点搬到「报货批次」。
    //    留着它 = 部署闸门 `v1:schema-check:purchase` 去问一张不存在的表，直接判红。
    // ⚠️ `purchaseInbound`（「采购入库」）同理，**2026-10-07 深夜被她整表删除**：
    //    到货链路只保留「更新报货批次 + 加库存」⇒ 不再有入库明细行。
    //    留着它同样是"闸门去问一张不存在的表"，而且代码里也不该再有任何读写点。
  ],
  inventory: ['product', 'behavior', 'sizeManagement', 'salesDetail', 'inventoryLedger', 'liveInventory'],
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
  // 「采购入库」表已删（2026-10-07 深夜）⇒ 它的尺码关联不用再核；报货信息照旧。
  purchase: ['purchaseRequest'],
  inventory: ['salesDetail', 'inventoryLedger', 'liveInventory'],
};
V1_SIZE_LINK_TABLES.all = [...new Set(Object.values(V1_SIZE_LINK_TABLES).flat())];

const getV1SizeLinkTables = (scope = 'sales') => V1_SIZE_LINK_TABLES[getV1SchemaScope(scope).key] || [];

// 幂等键字段同样必须真实存在，且是文本字段（见 infrastructure/idempotencyKey.js）。
// 采购批次 / 采购申请 / 实时库存的写入都靠它做「先回查再创建」，字段缺失时
// 宁可部署门槛拦下来，也不能等到用户确认采购时才报错。
// 「客户往来货款」的「业务事件ID」是售后 prepaid 的幂等键：同一批明细重复调用时靠它认出
// 「这一笔已经写过了」，所以它也在闸门里校验（缺列 = 售后写入会重复，必须拦在部署前）。
const V1_IDEMPOTENCY_KEY_TABLES = {
  sales: [{ tableKey: 'customerCredit', keyField: 'businessEventId' }],
  purchase: [
    { tableKey: 'purchaseOrderBatch', keyField: 'idempotencyKey' },
    { tableKey: 'purchaseRequest', keyField: 'idempotencyKey' },
  ],
  inventory: [{ tableKey: 'liveInventory', keyField: 'operationItemKey' }],
};
V1_IDEMPOTENCY_KEY_TABLES.all = [...new Map(Object.values(V1_IDEMPOTENCY_KEY_TABLES).flat()
  .map((entry) => [`${entry.tableKey}.${entry.keyField}`, entry])).values()];

const getV1IdempotencyKeyTables = (scope = 'sales') =>
  V1_IDEMPOTENCY_KEY_TABLES[getV1SchemaScope(scope).key] || [];

// 「单选取值契约」：真表这一列必须是单选、且**已经存在**代码要写的那些选项名。
// 字段名闸门看不出取值，而往单选里写一个不存在的取值 → 飞书**自动新建选项** →
// 表被悄悄污染、按该取值查询静默查不到（2026-10-07 加，起因见 purchaseArrivalStatus.js）。
// ⚠️ 取值本身在各自那份配置里（配置先行），这里只负责**汇总"哪些列要校验"**：
//    · 「报货批次.到货状态」（未到货 / 已到货）—— 2026-10-07 加；
//    · 「报货批次.确认状态」—— 2026-10-07 深夜她把这列从**文本改成单选**之后加进来的
//      （配置值当前是「已确认」，**取值不改**，只把它纳入闸门；不一致 → 闸门红、停下报告）。
const V1_SELECT_OPTION_CONTRACT_SCOPES = Object.freeze(['purchase', 'all']);

const getV1SelectOptionContracts = (scope = 'purchase', env = process.env) => {
  const key = getV1SchemaScope(scope).key;
  if (!V1_SELECT_OPTION_CONTRACT_SCOPES.includes(key)) return [];
  // 延迟 require：只在真要校验的范围内才去读那两份配置（它们自己会在取值不合法时抛错）。
  const { purchaseArrivalStatusOptionContract } = require('./purchaseArrivalStatus');
  const { purchaseAcceptanceOptionContract } = require('./purchaseAcceptance');
  return [...purchaseArrivalStatusOptionContract(env), ...purchaseAcceptanceOptionContract(env)];
};

module.exports = {
  V1_SCHEMA_SCOPES,
  V1_SIZE_LINK_TABLES,
  V1_IDEMPOTENCY_KEY_TABLES,
  V1_SELECT_OPTION_CONTRACT_SCOPES,
  getV1SchemaScope,
  getV1SizeLinkTables,
  getV1IdempotencyKeyTables,
  getV1SelectOptionContracts,
};
