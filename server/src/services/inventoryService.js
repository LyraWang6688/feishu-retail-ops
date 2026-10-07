const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { SizeReferenceService, normalizeSize } = require('./sizeReferenceService');
const { OPERATION_ITEM_KEY_FIELD, createOnceByKey, validateIdempotencyKeyFields } = require('../infrastructure/idempotencyKey');
const { logInfo, logWarn } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');

// ── 「库存键」的两种写法（业务负责人 2026-10-07 拍板：两种都给）──────────────────
//   · `stock_key`       = `商品record_id|尺码|所属状态` —— **内部键**。库存任务的串行队列
//     （runForStock）、本地任务记录、幂等判据都用它；**原值一个字符都不许动**。
//   · `stock_key_label` = `货号|颜色|类别|尺码` —— 飞书侧「库存键」公式算好的那串，
//     人读得懂，也能直接拿去多维表格里搜（她举的例子：`5801-38|灰色|B|38`）。
//
// ⚠️ 这里**故意不重新拼** `stock_key_label`：实时库存记录上本来就有飞书算好的「库存键」列，
//    而库存引擎在挑要扣的那几双时**已经**把这张表读进来了
//    （applyChange / transitionState / promoteToSample 都读过）
//    ⇒ 抄一下就有：**零额外请求、零漂移**（货号/颜色/类别的取值规则在飞书那一侧，
//      代码这边一个字都不抄）。
// ⚠️ 抄不到时（这一款在店里一双都没有 —— 例如采购入库第一双新品）**不猜**：
//    只留 `stock_key_label_source: 'unavailable'`。要拼那一串就得多读一次「货品信息」，
//    本方案选择不读：宁可少一个字段，也不在写库路径上多一次请求。
//    ⭐ 调用方**已经知道**那一串时（例如它自己刚读过那张表），可以走
//    `options.stockKeyLabel` 直接给 —— 那会记成 `stock_key_label_source: 'caller'`。
//
// ⚠️ 统一约定：**只进日志的东西一律走尾部可选参数 `options`**（`correlation` /
//    `stockKeyLabel`），绝不塞进 `input`。这样"库存引擎的业务入参形状一个字段都没变"
//    是可以被既有测试里那些逐字 deepEqual 当场证明的。
const STOCK_KEY_LABEL_SOURCE = Object.freeze({
  LIVE_INVENTORY: 'live_inventory',
  CALLER: 'caller',
  UNAVAILABLE: 'unavailable',
});

const stockKeyLabelFields = ({ record, fieldName, fallback } = {}) => {
  const fromRecord = textValue(record?.fields?.[fieldName]).trim();
  if (fromRecord) {
    return { stock_key_label: fromRecord, stock_key_label_source: STOCK_KEY_LABEL_SOURCE.LIVE_INVENTORY };
  }
  const given = String(fallback || '').trim();
  if (given) return { stock_key_label: given, stock_key_label_source: STOCK_KEY_LABEL_SOURCE.CALLER };
  return { stock_key_label_source: STOCK_KEY_LABEL_SOURCE.UNAVAILABLE };
};

// 关联键（task_id / order_no / sales_entry_record_id）：只进日志，不改任何业务判断。
// 空对象不落进本地任务记录，免得每个任务文件都多一个 `"correlation": {}` 噪声键。
const correlationPatch = (correlation) =>
  (Object.keys(correlation).length ? { correlation } : {});

// 已经落在本地任务记录上的那两种键（日志用）：`stock_key_label` 只有真的抄到了才出现，
// `stock_key_label_source` 永远有值 —— 这样"这条日志为什么没有 label"是能直接读出来的。
const stockKeyLabelOfOperation = (operation = {}) => ({
  ...(operation.stock_key_label ? { stock_key_label: operation.stock_key_label } : {}),
  stock_key_label_source: operation.stock_key_label_source || STOCK_KEY_LABEL_SOURCE.UNAVAILABLE,
});

// 库存动作注册表。键 = 飞书「行为管理」表里的「行为编码」。
//
// 分工：行为表负责业务侧（哪条启用、库存方向、资金方向），这里只声明引擎语义。
// 中文名可以随时改，改了代码不受影响；编码是契约，改名要表和代码同步。
// 新增动作 = 表里补一条行为 + 这里加一条声明，不需要再改任何分支逻辑。
const MOVEMENT_SALE_DECREASE = 'STOCK_SALE_DECREASE';
const MOVEMENT_PURCHASE_INCREASE = 'STOCK_PURCHASE_INCREASE';
// 采购退货：把货退给供应商，库存**减少**。
// 业务负责人 2026-10-05 明确：退货时「不看形态、不看所属状态」——样品 + 门盒 + 仓库
// （"仓库"是非当季在售那个状态）全部都要退，所以 consumes 把三个状态都列进去。
// 行为本身（名称「采购减少」、方向=减少、已启用）由她在「行为管理」里维护并已核实；
// 这里只声明引擎语义。
const MOVEMENT_PURCHASE_DECREASE = 'STOCK_PURCHASE_DECREASE';
const BEHAVIOR_SAMPLE_PROMOTION = 'STOCK_DOORBOX_TO_SAMPLE';

// 售后（退货 / 赔货 / 换货出货）用到的三个行为编码。
// 它们和销售、采购一样是「引擎语义」声明：方向、消耗哪些状态的实时库存、
// 要不要触发补样品提醒，全部写死在这里；「行为管理」表只负责启用与中文名，
// 两边靠「行为编码」对齐（编码改名必须同步这张注册表，中文名改了不受影响）。
const MOVEMENT_SALE_RETURN = 'SALE_RETURN';
const MOVEMENT_SALE_COMPENSATION = 'SALE_COMPENSATION';
const MOVEMENT_SALE_CASH = 'SALE_CASH';

// ── 人工库存行为（业务负责人 2026-10-06 已在「行为管理」表建好 6 条）──────────
// ⚠️ 这一步只做**注册**：把 6 个编码登记进 STOCK_MOVEMENTS，让
//    `validateStockBehaviors()`（＝部署闸门 `v1:schema-check:all` 的一部分）
//    开始核对它们。**不含任何入口**——没有 service、没有卡片、没有工作台按钮。
//    落地计划见 docs/inventory-adjustment-plan-2026-10-06.md。
//
// 两类语义截然不同，别混：
//   · 数量类（手工调增 / 手工调减）：改**数量**，一双一条地新建或消耗「实时库存」
//     ＋ 写一条带「变动数量」的流水。只有这两条能走 `applyChange`。
//   · 状态类（转冻结 / 转释放 / 样品转门盒 / 门盒转样品）：**方向=不影响**，
//     只改「实时库存」的「所属状态」，数量不变。它们**不许**走 `applyChange`
//     （走进去会被当成"增加"凭空建鞋），必须走状态变更通路——
//     下面 `requireQuantityMovement` 就是拦这个的闸门。
const ADJUSTMENT_BEHAVIORS = Object.freeze({
  MANUAL_INCREASE: 'STOCK_MANUAL_INCREASE',
  MANUAL_DECREASE: 'STOCK_MANUAL_DECREASE',
  FREEZE: 'STOCK_FREEZE',
  UNFREEZE: 'STOCK_UNFREEZE',
  SAMPLE_TO_DOORBOX: 'STOCK_SAMPLE_TO_DOORBOX',
  // 门盒转样品＝补样品链路已经在用的同一个编码（见 BEHAVIOR_SAMPLE_PROMOTION），
  // 这里登记的是**同一个行为**，不是新行为：一边是"卖出去一双样品后补回来"，
  // 一边是"人工把一双门盒挪成样品"，都改「所属状态」门盒→样品。
  DOORBOX_TO_SAMPLE: BEHAVIOR_SAMPLE_PROMOTION,
});

// ⚠️ TODO(inventory-adjustment) 待业务负责人定 ①：手工调减要消耗哪些「所属状态」的实时库存？
//    · null                     = 只消耗调用方明确指定的那一种状态（最保守；不会顺手吃掉样品）
//    · ['门盒', '样品']          = 按销售出库口径（先门盒、后样品）
//    · ['门盒', '样品', '仓库']  = 按采购退货口径（状态无关）
//    她定下来之前先按最保守的 null 走。**只改这个常量，逻辑一行都不用动。**
const MANUAL_DECREASE_CONSUMES = null;

// ✅ 待定 ② 已定（业务负责人 2026-10-06，工作台改造需求）：
//    **转冻结 = 门盒/样品 → 仓库；转释放 = 仓库 → 门盒/样品**（换季收鞋 / 拿鞋）。
//    即采用方案 B 的形状——只改「所属状态」这一列，**不新增「冻结状态」列**。
//    ⚠️ 方案 B 的已知代价：记录进了「仓库」以后**原来在门盒还是样品就查不到了**
//      （「库存流水」没有操作人列、也没有指向单据的来源列，翻不回来）。
//      所以**转释放必须由她在界面上选"回门盒还是回样品"**——
//      `to: null` + `targets` 就是把这个选择权留在入口，代码不替她猜。
const FREEZE_STATE_TRANSITION = Object.freeze({ from: ['门盒', '样品'], to: '仓库' });
const UNFREEZE_STATE_TRANSITION = Object.freeze({ from: ['仓库'], to: null, targets: ['门盒', '样品'] });

// 「实时库存」的「所属状态」选项。原先写死在 applyChange 的入参校验里；
// 抽成常量是因为状态类变更（人工调整）也要用同一份值域，两份会漂移。
const LIVE_STATES = Object.freeze(['门盒', '样品', '仓库']);

const STOCK_MOVEMENTS = Object.freeze({
  [MOVEMENT_SALE_DECREASE]: {
    direction: '减少',
    // 库存流水回指来源明细的字段（由 v1BitableSchema 映射成中文列名）。
    ledgerSource: 'salesDetail',
    // 按顺序消耗这些状态的实时库存；null 表示不消耗既有记录。
    consumes: ['门盒', '样品'],
    // 扣到样品时要不要触发补样品提醒。
    triggerSampleReplacement: true,
  },
  [MOVEMENT_PURCHASE_INCREASE]: {
    direction: '增加',
    ledgerSource: 'purchaseInbound',
    consumes: null,
    triggerSampleReplacement: false,
  },
  // 采购退货：方向=减少，且**状态无关**——样品、门盒、仓库都要退（见上面的注释）。
  //
  // ⚠️ ledgerSource 为 null：「库存流水」的两个来源字段是「关联销售」→销售明细、
  // 「关联采购」→采购入库，而采购退货既不产生销售明细、也不产生采购入库
  //（业务负责人明确退货不走采购到货/入库），表里没有能关联「单据信息」的字段。
  // 所以这条流水**不带来源关联**，而不是往错表的字段里写一个 id（那会被飞书拒绝或
  // 写出一条指错来源的流水）。
  // 👉 **此处等「关联单据」列**：父代理已去确认她要不要在「库存流水」加一个指向
  //    「单据信息」的「关联单据」列；加好之后只改这一行（ledgerSource: 'supplierReturnOrder'
  //    + v1BitableSchema 里补一条字段映射）就能让退货流水和销售/入库一样带远端幂等键。
  //    在那之前，重试保护是：任务终态 + 「单据信息」行幂等键 + 落盘的核对计划
  //    + 本地库存任务日志（见交付说明的待确认项）。
  [MOVEMENT_PURCHASE_DECREASE]: {
    direction: '减少',
    ledgerSource: null,
    consumes: ['门盒', '样品', '仓库'],
    triggerSampleReplacement: false,
  },
  // 退货：退回的鞋回库。consumes=null 表示「不消耗既有实时库存」，
  // 只在调用方指定的状态（门盒 / 样品）新增一行——退回的鞋在货上确实多了一双。
  [MOVEMENT_SALE_RETURN]: {
    direction: '增加',
    ledgerSource: 'salesDetail',
    consumes: null,
    triggerSampleReplacement: false,
  },
  // 赔货 / 换货出货：新鞋从门盒减一行。
  // consumes 固定 ['门盒']（不是销售出库的 ['门盒','样品']）：赔出去、换出去的必须是
  // 门盒里可卖的新鞋，不能拿陈列样品顶。触发补样品提醒的是销售交付链路，售后不触发。
  [MOVEMENT_SALE_COMPENSATION]: {
    direction: '减少',
    ledgerSource: 'salesDetail',
    consumes: ['门盒'],
    triggerSampleReplacement: false,
  },
  // 现货销售：换货时新鞋出库走它，方向=减少。它同时是「交易类型」和「库存行为」。
  [MOVEMENT_SALE_CASH]: {
    direction: '减少',
    ledgerSource: 'salesDetail',
    consumes: ['门盒'],
    triggerSampleReplacement: false,
  },

  // ── 以下 6 条＝人工库存行为的引擎语义声明（2026-10-06 注册，入口未做）──────
  // ledgerSource 一律 null：「库存流水」现在只有「关联销售」「关联采购」两个来源列，
  // 手工调整既没有销售明细也没有采购入库可挂；硬往别的列写一个 id 会写出指错来源的流水。
  // ⚠️ 等「关联单据」列落地后再补（与采购退货 MOVEMENT_PURCHASE_DECREASE 同一处待办）。
  // 手工调增：数量类，增加 N 双 → 新建 N 条「实时库存」＋ 一条 变动数量=N 的流水
  //（「变动数量」存的是**绝对值**，正负由「库存行为」的库存方向表达，见 executeOperation）。
  [ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE]: {
    direction: '增加',
    ledgerSource: null,
    consumes: null,
    triggerSampleReplacement: false,
  },
  // 手工调减：数量类，减少 N 双 → 消耗既有「实时库存」＋ 一条 变动数量=N 的流水。
  // ⚠️ 消耗哪些状态**待她定**，值在 MANUAL_DECREASE_CONSUMES（见上面的 TODO）。
  [ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE]: {
    direction: '减少',
    ledgerSource: null,
    consumes: MANUAL_DECREASE_CONSUMES,
    triggerSampleReplacement: false,
  },
  // 四个「转」：方向=不影响，只改「实时库存」的「所属状态」，数量一条不变。
  // 目标状态用 stateTransition 表达，**不写死在逻辑里**（改口径只改上面的常量）。
  [ADJUSTMENT_BEHAVIORS.FREEZE]: {
    direction: '不影响',
    ledgerSource: null,
    consumes: null,
    triggerSampleReplacement: false,
    stateTransition: FREEZE_STATE_TRANSITION, // 门盒/样品 → 仓库（换季收起）
  },
  [ADJUSTMENT_BEHAVIORS.UNFREEZE]: {
    direction: '不影响',
    ledgerSource: null,
    consumes: null,
    triggerSampleReplacement: false,
    // 仓库 → 门盒/样品；**回哪一个由入口选**（to: null + targets）。
    stateTransition: UNFREEZE_STATE_TRANSITION,
  },
  [ADJUSTMENT_BEHAVIORS.SAMPLE_TO_DOORBOX]: {
    direction: '不影响',
    ledgerSource: null,
    consumes: null,
    triggerSampleReplacement: false,
    // 规则明确：样品 → 门盒。
    stateTransition: Object.freeze({ from: '样品', to: '门盒' }),
  },
  [ADJUSTMENT_BEHAVIORS.DOORBOX_TO_SAMPLE]: {
    direction: '不影响',
    ledgerSource: null,
    consumes: null,
    triggerSampleReplacement: false,
    // 规则明确：门盒 → 样品（补样品链路已在用同一编码，见 ADJUSTMENT_BEHAVIORS 注释）。
    stateTransition: Object.freeze({ from: '门盒', to: '样品' }),
  },
});

// 数量类 / 状态类的分野：只有「增加 / 减少」才是数量变动。
// `applyChange` 只服务数量类——状态类进去会把 direction '不影响' 当成非"减少"，
// 按"增加 N 双"凭空建出实时库存（数量错、账面上还看不出来）。所以入口处直接拦死。
const QUANTITY_DIRECTIONS = Object.freeze(['增加', '减少']);

const requireMovement = (code) => {
  const movement = STOCK_MOVEMENTS[code];
  if (!movement) {
    throw new Error(`未在库存动作注册表中声明动作「${code}」：请先在行为管理表补齐该行为，再在注册表中声明其引擎语义`);
  }
  return movement;
};

const requireQuantityMovement = (code) => {
  const movement = requireMovement(code);
  if (!QUANTITY_DIRECTIONS.includes(movement.direction)) {
    throw new Error(`库存动作「${code}」的库存方向是“${movement.direction}”，属于状态类变更，`
      + '不能走 applyChange（数量通路）；请走状态变更通路');
  }
  return movement;
};

// 反向闸门：数量类行为不许走状态变更通路（只改「所属状态」不改数量的那条路）。
// 与 requireQuantityMovement 互为镜像，两侧都拦，避免"走错通路"变成静默的账实不符。
const requireStateMovement = (code) => {
  const movement = requireMovement(code);
  if (QUANTITY_DIRECTIONS.includes(movement.direction)) {
    throw new Error(`库存动作「${code}」的库存方向是“${movement.direction}”，属于数量类变更，`
      + '不能走状态变更通路（transitionState）；请走 applyChange');
  }
  if (!movement.stateTransition) {
    throw new Error(`库存动作「${code}」没有配置状态流转目标（stateTransition 为空），`
      + '无法执行状态变更：请先在注册表里补齐 from/to');
  }
  return movement;
};

// 状态流转的目标状态：固定目标直接用配置里的 to；「由入口选」的（to: null）
// 必须落进 targets 白名单，否则会写进一个「所属状态」里不存在的选项
//（飞书会自动新建选项，于是账面留下一批谁也读不懂的状态）。
const resolveTargetState = (code, transition, requested) => {
  if (transition.to) {
    if (requested && String(requested) !== transition.to) {
      throw new Error(`库存动作「${code}」的目标状态固定为「${transition.to}」，不接受「${requested}」`);
    }
    return transition.to;
  }
  const target = String(requested || '').trim();
  if (!LIVE_STATES.includes(target)) {
    throw new Error(`库存动作「${code}」必须选择目标状态：${(transition.targets || LIVE_STATES).join(' / ')}`);
  }
  if (transition.targets && !transition.targets.includes(target)) {
    throw new Error(`库存动作「${code}」的目标状态只能是：${transition.targets.join(' / ')}`);
  }
  return target;
};

// 补样品不算数量变动，但它的流水同样挂在销售明细上，用销售动作的来源字段查找。
const SALE_LEDGER_SOURCE = STOCK_MOVEMENTS[MOVEMENT_SALE_DECREASE].ledgerSource;

const positiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
};

const positiveInteger = (value, label) => {
  const number = positiveNumber(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label}必须是正整数`);
  return number;
};

const operationId = (kind, sourceRecordId) =>
  `inventory_${kind}_${crypto.createHash('sha256').update(String(sourceRecordId)).digest('hex').slice(0, 20)}`;
const samplePromotionId = (salesDetailRecordId) => operationId('sample', salesDetailRecordId);

// 一次库存操作里「第 N 双」的远端标识。实时库存是一双一条记录，
// 本地日志丢失时只能靠这个键回答「这一双是不是已经建过了」。
const operationItemKey = (inventoryOperationId, sequence) => `${inventoryOperationId}:${sequence}`;

class InventoryService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('InventoryService requires gateway');
    this.gateway = options.gateway;
    this.sizeReferences = options.sizeReferences || new SizeReferenceService({ gateway: this.gateway });
    this.store =
      options.store ||
      new JsonTaskStore({
        dir: path.join(__dirname, '../../data/inventory_operations'),
        idField: 'operation_id',
      });
    this.queues = new Map();
    this.schemaValidation = null;
  }

  async ensureSchema() {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.schemaValidation) {
      this.schemaValidation = (async () => {
        const result = await this.gateway.validateTables(['behavior', 'sizeManagement', 'inventoryLedger', 'liveInventory']);
        await this.sizeReferences.validateSchema(['inventoryLedger', 'liveInventory']);
        // 增加库存必须能按「库存操作键」回查，否则 create 结果未知时只能盲重建。
        await validateIdempotencyKeyFields({
          gateway: this.gateway,
          tables: [{ tableKey: 'liveInventory', keyField: OPERATION_ITEM_KEY_FIELD }],
        });
        return result;
      })().catch((error) => {
        this.schemaValidation = null;
        throw error;
      });
    }
    return this.schemaValidation;
  }

  async resolveStockBehavior(kind) {
    const movement = requireMovement(kind);
    const fields = this.gateway.table('behavior').fields;
    // 按「行为编码」匹配：编码是稳定标识，飞书里改中文名不影响代码。
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === kind);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${kind}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || kind;
    const direction = textValue(behavior.fields?.[fields.stockDirection]).trim();
    if (direction !== movement.direction) {
      throw new Error(`请将行为管理「${name}」(${kind}) 的库存方向设置为“${movement.direction}”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${kind})`);
    }
    return { recordId: behavior.record_id, direction };
  }

  async resolveSamplePromotionBehavior() {
    const fields = this.gateway.table('behavior').fields;
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === BEHAVIOR_SAMPLE_PROMOTION);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${BEHAVIOR_SAMPLE_PROMOTION}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || BEHAVIOR_SAMPLE_PROMOTION;
    if (textValue(behavior.fields?.[fields.stockDirection]).trim() !== '不影响') {
      throw new Error(`请将行为管理「${name}」(${BEHAVIOR_SAMPLE_PROMOTION}) 的库存方向设置为“不影响”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${BEHAVIOR_SAMPLE_PROMOTION})`);
    }
    return { recordId: behavior.record_id };
  }

  async validateStockBehaviors() {
    for (const kind of Object.keys(STOCK_MOVEMENTS)) await this.resolveStockBehavior(kind);
  }

  runForStock(stockKey, work) {
    const previous = this.queues.get(stockKey) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(stockKey, next);
    const cleanup = () => {
      if (this.queues.get(stockKey) === next) this.queues.delete(stockKey);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  // ⚠️ 关联键走**尾部可选参数**（`options.correlation`），**不塞进 `input`**：
  //    库存引擎的业务入参形状因此一个字段都没变（既有测试对它是逐字 deepEqual 的，
  //    那条断言就是这条边界的证明）。关联键只进日志。
  applySale(input, options = {}) {
    return this.applyChange({
      ...input,
      kind: MOVEMENT_SALE_DECREASE,
      // A sale always consumes door-box stock first, then a sample. Callers
      // must not bypass that policy by choosing a source state themselves.
      state: '门盒',
      sourceRecordId: input.salesDetailRecordId,
      quantity: positiveInteger(input.quantity, '销售数量'),
    }, options);
  }

  async getSaleResult(salesDetailRecordId) {
    const operation = await this.store.get(operationId(MOVEMENT_SALE_DECREASE, salesDetailRecordId));
    return operation?.status === 'completed' ? operation.result : null;
  }

  applyPurchase(input, options = {}) {
    return this.applyChange({
      ...input,
      kind: MOVEMENT_PURCHASE_INCREASE,
      state: input.state || '门盒',
      sourceRecordId: input.purchaseInboundRecordId,
      quantity: positiveInteger(input.quantity, '采购入库数量'),
    }, options);
  }

  async applyChange(input, options = {}) {
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
    const size = normalizeSize(input.size);
    const quantity = positiveInteger(input.quantity, '变动数量');
    const state = String(input.state || '门盒');
    if (!LIVE_STATES.includes(state)) throw new Error('库存所属状态无效');
    const stockKey = `${input.productRecordId}|${size}|${state}`;
    // 配置驱动的闸门：状态类行为（方向=不影响，含转冻结/转释放/两个"转"）不许走数量通路。
    // 放在任何远端读写之前，且不改变上面几条入参校验的报错顺序。
    requireQuantityMovement(input.kind);
    // 关联键：落进本地任务记录，**重放/续跑时用它自己的那一份**（不是当前请求的）——
    // 这正是为什么不走 AsyncLocalStorage：resumePending 会把上一笔单的操作放到这次请求里跑。
    const correlation = correlationFields(options.correlation);
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(size);
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if ([2, 3].includes(operation.schema_version) && (
          operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.state !== state || operation.quantity !== quantity
        )) throw new Error(`来源明细 ${input.sourceRecordId} 的库存操作内容与首次提交不一致`);
      } else {
        const movement = requireMovement(input.kind);
        const behavior = await this.resolveStockBehavior(input.kind);
        // 没有来源字段的动作（例如采购退货）拿不到"远端已经写过这条流水"的证明，
        // 只能靠本地任务日志恢复；见 STOCK_MOVEMENTS 里那条注释。
        const existingLedger = movement.ledgerSource
          ? await this.findLedger(movement.ledgerSource, input.sourceRecordId, behavior.recordId)
          : null;
        if (existingLedger) {
          throw new Error(`来源明细 ${input.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
        }
        const delta = behavior.direction === '减少' ? -quantity : quantity;
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        // 消耗哪些状态由注册表声明；增加方向不消耗既有记录，只看目标状态本身。
        const states = movement.consumes || [state];
        const liveRecords = states.flatMap((candidateState) =>
          this.findLiveInventoryIn(allLiveRecords, input.productRecordId, sizeReference.recordId, candidateState)
            .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id))));
        const currentQuantity = liveRecords.length;
        if (delta < 0 && currentQuantity < quantity) {
          // 文案里的状态来自注册表（销售是"门盒和样品"，采购退货是"门盒、样品和仓库"），
          // 不再写死——写死的文案会在退货时告诉她"门盒和样品不足"，而仓库里其实有货。
          throw new Error(`${states.join('和')}库存不足：${input.productRecordId} ${size}码，需 ${quantity} 双，现有 ${currentQuantity} 双`);
        }
        const selected = delta < 0 ? liveRecords.slice(0, quantity) : [];
        const stateField = this.gateway.table('liveInventory').fields.state;
        const sampleConsumed = selected.filter((record) =>
          textValue(record.fields?.[stateField]) === '样品').length;
        const targetQuantity = currentQuantity + delta;
        operation = await this.store.create({
          operation_id: id,
          type: 'inventory_change',
          schema_version: 3,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          // 人类可读那串：抄**这次已经读到的**实时库存记录上的「库存键」（零额外请求）。
          // 减少方向抄的是**要扣掉的那一双**；增加方向（采购入库）抄同款同码已有的那一双。
          ...stockKeyLabelFields({
            // 增加、且这一款店里一双都没有（第一双新品）→ 两个都是 undefined → unavailable。
            record: selected[0] || liveRecords[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          product_record_id: input.productRecordId,
          size,
          size_record_id: sizeReference.recordId,
          state,
          quantity,
          direction: behavior.direction,
          behavior_record_id: behavior.recordId,
          source_record_id: input.sourceRecordId,
          occurred_at: Number(input.occurredAt || Date.now()),
          // 谁做的这次调整（人工调整时由工作台传入飞书 open_id）。
          // ⚠️ 「库存流水」目前**没有「操作人」列**（2026-10-06 只读核过测试 Base：
          // 库存键/库存流水号/库存行为/编号/尺码/变动数量/关联销售/关联采购/创建时间/更新时间），
          // 所以只落**本地任务日志 + 结构化日志**，不往远端写；那两处已经能回答"谁调的"。
          // 等「库存流水」加了「操作人」列，在这里补一个 ledgerSource 同级的映射即可。
          operator_open_id: input.operatorOpenId || '',
          live_record_ids: selected.map((record) => record.record_id),
          sample_consumed_quantity: sampleConsumed,
          removed_live_record_ids: [],
          created_live_record_ids: [],
          current_quantity: currentQuantity,
          target_quantity: targetQuantity,
        });
      }
      return this.executeOperation(operation);
    });
  }

  // ── 状态变更通路（人工「换季调整」：转冻结 / 转释放，以及样品 ↔ 门盒）────────
  // 与 applyChange 的分工：
  //   · applyChange   = 数量类（增加 / 减少）——新建或删除「实时库存」记录；
  //   · transitionState = 状态类（方向=不影响）——**只改「所属状态」，一条记录都不增删**。
  // 两条通路共用 runForStock 串行队列，避免和销售/采购同时改同一双鞋。
  //
  // 幂等：`sourceRecordId` 由入口提供（工作台侧 = requestId + 目标身份，
  // 同一次提交重试复用同一个 requestId，见 InventoryAdjustmentService）。
  //
  // ⚠️ 为什么人工调整还需要 `findOperationBySource`：`operationId(kind, source)` 里带 kind，
  // 而「按实际盘点数」的 kind（调增还是调减）**要先算出差额才知道**——重试时账面已经变了，
  // 差额会算成 0，于是拿不到原来那条任务、反而报"不需要调整"。所以入口先用来源回查一次，
  // 命中已完成任务就直接返回它（同一次提交重试的唯一正确语义）。
  async findOperationBySource(sourceRecordId) {
    const matches = (await this.store.list()).filter((record) => record.source_record_id === sourceRecordId);
    if (matches.length > 1) {
      throw new Error(`来源 ${sourceRecordId} 存在多条库存任务，请人工核对`);
    }
    return matches[0] || null;
  }

  async transitionState(input = {}, options = {}) {
    if (!input.productRecordId) throw new Error('库存状态变更缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存状态变更缺少来源标识（requestId）');
    const movement = requireStateMovement(input.kind);
    const transition = movement.stateTransition;
    const fromStates = [].concat(transition.from);
    const size = normalizeSize(input.size);
    const quantity = positiveInteger(input.quantity, '变更数量');
    const toState = resolveTargetState(input.kind, transition, input.toState);
    // 单一起点（转释放：仓库）可以由配置决定；多起点（转冻结：门盒/样品）必须由入口指明，
    // 否则"这一双原来在哪"就靠猜了。
    const fromState = fromStates.length === 1 ? fromStates[0] : String(input.fromState || '').trim();
    if (!fromStates.includes(fromState)) {
      throw new Error(`库存动作「${input.kind}」只能从「${fromStates.join('、')}」转出，`
        + `不能从「${fromState || '空'}」转出`);
    }
    if (fromState === toState) throw new Error(`库存动作「${input.kind}」的起点和终点都是「${toState}」，无需调整`);
    const stockKey = `${input.productRecordId}|${size}|${fromState}`;
    const correlation = correlationFields(options.correlation);
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(size);
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.from_state !== fromState ||
          operation.to_state !== toState || operation.quantity !== quantity) {
          throw new Error(`来源 ${input.sourceRecordId} 的库存状态变更内容与首次提交不一致`);
        }
      } else {
        // 行为表的「库存方向=不影响」+ 是否启用在这里校验（resolveStockBehavior）。
        const behavior = await this.resolveStockBehavior(input.kind);
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        const candidates = this
          .findLiveInventoryIn(allLiveRecords, input.productRecordId, sizeReference.recordId, fromState)
          .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        if (candidates.length < quantity) {
          throw new Error(`${fromState}库存不足：${input.productRecordId} ${size}码，`
            + `需 ${quantity} 双，现有 ${candidates.length} 双`);
        }
        operation = await this.store.create({
          operation_id: id,
          type: 'state_transition',
          schema_version: 3,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          // 同 applyChange：抄这次已经读到的实时库存记录上的「库存键」，零额外请求。
          ...stockKeyLabelFields({
            record: candidates[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          product_record_id: input.productRecordId,
          size,
          size_record_id: sizeReference.recordId,
          from_state: fromState,
          to_state: toState,
          quantity,
          direction: behavior.direction,
          behavior_record_id: behavior.recordId,
          source_record_id: input.sourceRecordId,
          occurred_at: Number(input.occurredAt || Date.now()),
          // 同上：人工调整的操作人只落本地任务 + 日志（「库存流水」还没有「操作人」列）。
          operator_open_id: input.operatorOpenId || '',
          live_record_ids: candidates.slice(0, quantity).map((record) => record.record_id),
          moved_live_record_ids: [],
          current_quantity: candidates.length,
        });
      }
      return this.executeStateTransition(operation);
    });
  }

  // 状态变更的执行体。顺序与 executeOperation 一致：先确认流水，再动实时库存；
  // 每一步都把已完成的进度写回本地任务，中途失败（或响应丢失）后按同一任务续跑。
  async executeStateTransition(operation) {
    if (operation.status === 'completed') return operation.result;
    if (![2, 3].includes(operation.schema_version)) {
      throw new Error(`库存状态变更 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    const movement = requireStateMovement(operation.kind);
    // 同 executeOperation：关联键取这条本地任务记录自己的（重放时不会挂到当前请求上）。
    const correlation = correlationFields(operation.correlation);
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    if (operation.size_record_id && operation.size_record_id !== sizeReference.recordId) {
      throw new Error(`库存状态变更 ${operation.operation_id} 的尺码关联已改变，请人工核对`);
    }
    // 流水先写：数量类动作的第三层幂等靠「按来源回查流水」，人工调整没有来源列
    //（ledgerSource = null），只能靠本地任务上的 ledger_record_id，所以先把 id 落盘。
    let ledger = await this.findOperationLedger(operation);
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId: sizeReference.recordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: null,
      sourceRecordId: null,
      // 状态变更不改变数量：流水「变动数量」必须是 0
      //（与补样品 promoteToSample 同一个形状；「变动数量」存绝对值，增减靠方向表达）。
      quantityChange: 0,
    })) {
      throw new Error(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为或数量不一致，请人工核对，不能自动恢复`);
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: relation(sizeReference.recordId),
        quantityChange: 0,
        behavior: relation(operation.behavior_record_id),
      }, { correlation });
      ledger = { record_id: created.recordId };
      operation = await this.store.update(operation.operation_id, {
        status: 'ledger_created', ledger_record_id: ledger.record_id,
      });
    }
    const liveFields = this.gateway.table('liveInventory').fields;
    const moved = [...(operation.moved_live_record_ids || [])];
    for (const recordId of operation.live_record_ids || []) {
      if (moved.includes(recordId)) continue;
      const record = await this.gateway.get('liveInventory', recordId);
      if (!record) throw new Error(`待变更状态的实时库存 ${recordId} 不存在，请人工核对`);
      if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(operation.product_record_id) ||
        !linkedRecordIds(record.fields?.[liveFields.size]).includes(sizeReference.recordId)) {
        throw new Error(`待变更状态的实时库存 ${recordId} 的货品或尺码已改变，请人工核对`);
      }
      const current = textValue(record.fields?.[liveFields.state]);
      // 已经是目标状态 = 上一步写成功但本地没落盘，视为已完成（幂等）；
      // 既不是起点也不是终点 = 别人动过这一双，停下转人工，绝不硬改。
      if (current !== operation.to_state && current !== operation.from_state) {
        throw new Error(`待变更状态的实时库存 ${recordId} 的所属状态是「${current}」，`
          + `既不是「${operation.from_state}」也不是「${operation.to_state}」，请人工核对`);
      }
      if (current !== operation.to_state) {
        await this.gateway.update('liveInventory', recordId, { state: operation.to_state }, { correlation });
      }
      moved.push(recordId);
      operation = await this.store.update(operation.operation_id, { moved_live_record_ids: moved });
    }
    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordIds: moved,
      movementQuantity: 0,
      direction: movement.direction,
      productRecordId: operation.product_record_id,
      size: operation.size,
      fromState: operation.from_state,
      toState: operation.to_state,
      quantity: operation.quantity,
    };
    await this.store.update(operation.operation_id, { status: 'completed', result });
    logInfo('inventory.state.transitioned', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      from_state: operation.from_state,
      to_state: operation.to_state,
      quantity: operation.quantity,
      live_record_ids: moved,
      ledger_record_id: ledger.record_id,
      operator_open_id: operation.operator_open_id || undefined,
      ...correlation,
    });
    return result;
  }

  async resumePending(stockKey) {
    const pending = (await this.store.list()).filter(
      (record) => ['inventory_change', 'sample_promotion', 'state_transition'].includes(record.type) &&
        record.stock_key === stockKey && record.status !== 'completed'
    );
    for (const operation of pending.reverse()) {
      if (operation.type === 'sample_promotion') await this.executeSamplePromotion(operation);
      else if (operation.type === 'state_transition') await this.executeStateTransition(operation);
      else await this.executeOperation(operation);
    }
  }

  async promoteToSample(input = {}, options = {}) {
    const { salesDetailRecordId, productRecordId, size } = input;
    if (!salesDetailRecordId || !productRecordId) throw new Error('补样品缺少销售明细或货品');
    const normalizedSize = normalizeSize(size);
    const stockKey = `${productRecordId}|${normalizedSize}|门盒`;
    const correlation = correlationFields(options.correlation);
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(normalizedSize);
      await this.resumePending(stockKey);
      const id = samplePromotionId(salesDetailRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.product_record_id !== productRecordId || operation.size !== normalizedSize) {
          throw new Error('同一销售明细已选择其他补样品尺码，不能重复选择');
        }
      } else {
        const behavior = await this.resolveSamplePromotionBehavior();
        if (await this.findLedger(SALE_LEDGER_SOURCE, salesDetailRecordId, behavior.recordId)) {
          throw new Error('补样品流水已存在但缺少可恢复任务，请人工核对');
        }
        const liveRecords = await this.findLiveInventory(productRecordId, normalizedSize, '门盒');
        liveRecords.sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        if (!liveRecords.length) throw new Error(`${normalizedSize}码已没有门盒库存，请重新选择`);
        operation = await this.store.create({
          operation_id: id, type: 'sample_promotion', status: 'prepared', stock_key: stockKey,
          // 同 applyChange：抄这次已经读到的门盒记录上的「库存键」，零额外请求。
          ...stockKeyLabelFields({
            record: liveRecords[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          source_record_id: salesDetailRecordId, product_record_id: productRecordId,
          size: normalizedSize, size_record_id: sizeReference.recordId,
          live_record_id: liveRecords[0].record_id,
          behavior_record_id: behavior.recordId,
        });
      }
      return this.executeSamplePromotion(operation);
    });
  }

  async executeSamplePromotion(operation) {
    if (operation.status === 'completed') return operation.result;
    const correlation = correlationFields(operation.correlation);
    let ledger = await this.findLedger(SALE_LEDGER_SOURCE, operation.source_record_id, operation.behavior_record_id);
    const record = await this.gateway.get('liveInventory', operation.live_record_id);
    if (!record) throw new Error('待补样品的门盒库存记录不存在，请人工核对');
    const fields = this.gateway.table('liveInventory').fields;
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    // Tasks written before the size field became a relation carry no
    // size_record_id, and a later link change cannot be told apart from a
    // stale one. Both stop here instead of resuming against the wrong 尺码.
    if (operation.size_record_id !== sizeReference.recordId) {
      throw new Error('补样品任务缺少可核对的尺码关联或关联已改变，请人工核对，不能自动恢复');
    }
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId: sizeReference.recordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: 'salesDetail',
      sourceRecordId: operation.source_record_id,
      // 补样品只改状态，不改变数量，流水变动数量必须为 0。
      quantityChange: 0,
    })) {
      throw new Error(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为、来源或数量不一致，请人工核对，不能自动恢复`);
    }
    if (!linkedRecordIds(record.fields?.[fields.product]).includes(operation.product_record_id) ||
      !linkedRecordIds(record.fields?.[fields.size]).includes(sizeReference.recordId)) {
      throw new Error('待补样品的库存记录与货品或尺码不一致');
    }
    const state = textValue(record.fields?.[fields.state]);
    if (state !== '门盒' && !(ledger && state === '样品')) {
      throw new Error('待补样品的库存已不属于门盒，请人工核对');
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id), size: relation(sizeReference.recordId),
        quantityChange: 0, behavior: relation(operation.behavior_record_id),
        salesDetail: relation(operation.source_record_id),
      }, { correlation });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created', ledger_record_id: ledger.record_id,
    });
    if (state === '门盒') {
      await this.gateway.update('liveInventory', operation.live_record_id, { state: '样品' }, { correlation });
    }
    const result = { liveRecordId: operation.live_record_id, ledgerRecordId: ledger.record_id,
      productRecordId: operation.product_record_id, size: operation.size };
    await this.store.update(operation.operation_id, { status: 'completed', result });
    // 「相关库存日志」也两种键都给（stock_key + stock_key_label），见文件顶部注释。
    logInfo('inventory.sample.promoted', { operation_id: operation.operation_id,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      live_record_id: operation.live_record_id, ledger_record_id: ledger.record_id, size: operation.size,
      ...correlation });
    return result;
  }

  async executeOperation(operation) {
    if (operation.status === 'completed') return operation.result;
    if (![2, 3].includes(operation.schema_version)) {
      throw new Error(`库存操作 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    const movement = requireMovement(operation.kind);
    // 关联键取自**这条本地任务记录自己**（不是当前请求）：resumePending 会把上一笔单
    // 尚未完成的操作放到这次请求里续跑，用当前请求的键会把日志指向错的任务。
    const correlation = correlationFields(operation.correlation);
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    if (operation.size_record_id && operation.size_record_id !== sizeReference.recordId) {
      throw new Error(`库存操作 ${operation.operation_id} 的尺码关联已改变，请人工核对`);
    }
    let ledger = await this.findOperationLedger(operation);
    await this.auditExistingOperationRecords(operation, ledger, sizeReference.recordId);
    if (operation.schema_version === 2 && !ledger) {
      throw new Error(`旧版库存操作 ${operation.operation_id} 未能确认已有流水，请人工核对，不能自动恢复`);
    }
    if (operation.direction === '增加') {
      // 先确认远端没有「同一个键出现两条」这种已经重复的事实，再写流水：
      // 已经重复时应该停下来让人核对，而不是再补一条流水把差异藏起来。
      await this.assertNoDuplicateOperationItems(operation, (operation.created_live_record_ids || []).length + 1,
        operation.quantity);
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: relation(sizeReference.recordId),
        quantityChange: operation.quantity,
        behavior: relation(operation.behavior_record_id),
        // 来源字段由注册表声明：新增动作不必再改这里。
        // ledgerSource 为 null 的动作（采购退货）没有可关联的来源表，整列不写。
        ...(movement.ledgerSource
          ? { [movement.ledgerSource]: relation(operation.source_record_id) }
          : {}),
      }, { correlation });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created',
      ledger_record_id: ledger.record_id,
    });

    const liveRecordIds = operation.live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const createdIds = operation.created_live_record_ids || [];
    // 可扣减的状态 = 注册表声明的消耗清单（销售是 门盒+样品，采购退货还要加 仓库）。
    // 以前这里写死成 ['门盒','样品']：写死会让"仓库里的退货"永远报"状态已改变"。
    const consumableStates = movement.consumes || [operation.state];
    if (operation.direction === '减少') {
      for (const recordId of liveRecordIds) {
        if (removedIds.includes(recordId)) continue;
        // A list response may lag behind the selected record. Confirm the
        // exact record before deleting; never report a deduction based only
        // on its absence from a possibly stale list.
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
        const liveFields = this.gateway.table('liveInventory').fields;
        if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(operation.product_record_id) ||
          !linkedRecordIds(record.fields?.[liveFields.size]).includes(sizeReference.recordId) ||
          !consumableStates.includes(textValue(record.fields?.[liveFields.state]))) {
          throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
        }
        await this.gateway.delete('liveInventory', recordId);
        removedIds.push(recordId);
        operation = await this.store.update(operation.operation_id, { removed_live_record_ids: removedIds });
      }
    } else {
      const expectedCreates = operation.quantity;
      while (createdIds.length < expectedCreates) {
        // 第 N 双先按「库存操作键」回查远端，再决定是否创建：
        // 飞书创建成功但本地 journal 没写下去（崩溃 / 磁盘失败 / 响应丢失）时，
        // 直接重发 create 会把库存 +1 变成 +2，而 +2 在业务上是看不出来的。
        const itemKey = operationItemKey(operation.operation_id, createdIds.length + 1);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'liveInventory',
          keyField: OPERATION_ITEM_KEY_FIELD,
          keyValue: itemKey,
          label: `实时库存 ${itemKey}`,
          correlation,
          values: {
            product: relation(operation.product_record_id),
            size: relation(sizeReference.recordId),
            state: operation.state || '门盒',
            operationItemKey: itemKey,
          },
        });
        createdIds.push(created.recordId);
        operation = await this.store.update(operation.operation_id, { created_live_record_ids: createdIds });
      }
    }

    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordIds: operation.direction === '减少' ? removedIds : createdIds,
      movementQuantity: operation.quantity,
      direction: operation.direction,
      quantity: operation.target_quantity,
      sampleConsumedQuantity: operation.sample_consumed_quantity || 0,
      productRecordId: operation.product_record_id,
      consumedLiveRecordIds: movement.direction === '减少' ? removedIds : [],
    };
    if (movement.triggerSampleReplacement && result.sampleConsumedQuantity) {
      try {
        result.remainingSizes = await this.sampleReplacementCandidates(operation.product_record_id,
          { excludeRecordIds: removedIds });
      } catch (error) {
        // The stock movement is already durable. A malformed or temporarily
        // unreadable remaining row must not turn a successful delivery into a
        // failed one; the replacement card can retry this separate lookup.
        result.remainingSizes = [];
        result.replacementCandidatesUnavailable = true;
        logWarn('inventory.sample_candidates.failed', {
          operation_id: operation.operation_id,
          source_record_id: operation.source_record_id,
          error: error.message,
          ...correlation,
        });
      }
    }
    await this.store.update(operation.operation_id, {
      status: 'completed',
      result,
    });
    // ⭐ 「库存键」两种写法并列（业务负责人 2026-10-07 拍板）：
    //    `stock_key` = 内部 `rec…|尺码|状态`（**原值不动**，既有排查脚本/断言依赖它）；
    //    `stock_key_label` = 飞书算好的 `货号|颜色|类别|尺码`（人读得懂、表里搜得到）。
    //    再叠上关联键 ⇒ 按 `task_id` / `order_no` / `sales_entry_record_id` 任一键
    //    都能把这一条和它那笔业务串起来（这正是这次事故里"看不到库存"的那半）。
    logInfo('inventory.change.applied', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      movement_quantity: operation.quantity,
      direction: operation.direction,
      target_quantity: operation.target_quantity,
      ledger_record_id: ledger.record_id,
      live_record_ids: result.liveRecordIds,
      operator_open_id: operation.operator_open_id || undefined,
      ...correlation,
    });
    return result;
  }

  // 同一个键出现两条实时库存，说明这一双已经被写过两次：真实库存已经错了。
  // 这时不能继续补写，也不能挑一条继续，只能停下让人核对。
  async assertNoDuplicateOperationItems(operation, fromSequence, toSequence) {
    if (fromSequence > toSequence) return;
    const fieldName = this.gateway.table('liveInventory').fields?.[OPERATION_ITEM_KEY_FIELD];
    if (!fieldName) return;
    const expected = new Set();
    for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
      expected.add(operationItemKey(operation.operation_id, sequence));
    }
    const counts = new Map();
    for (const record of await this.gateway.listAll('liveInventory')) {
      const key = textValue(record.fields?.[fieldName]).trim();
      if (expected.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        throw new Error(`实时库存中已存在 ${count} 条库存操作键为 ${key} 的记录，库存事实重复，请人工核对后再入库`);
      }
    }
  }

  async findOperationLedger(operation) {
    const movement = requireMovement(operation.kind);
    // 没有来源字段的动作（采购退货）无法按来源回查流水，只能靠 operation.ledger_record_id
    // 这条本地记录；这也是为什么它的重试保护弱于销售（见 STOCK_MOVEMENTS 的注释）。
    const listed = movement.ledgerSource
      ? await this.findLedger(movement.ledgerSource, operation.source_record_id, operation.behavior_record_id)
      : null;
    if (!operation.ledger_record_id) {
      if (operation.status === 'ledger_created' && !listed) {
        throw new Error(`库存操作 ${operation.operation_id} 的已创建流水无法确认，请人工核对`);
      }
      return listed;
    }
    const direct = await this.gateway.get('inventoryLedger', operation.ledger_record_id);
    if (!direct || (listed && listed.record_id !== direct.record_id)) {
      throw new Error(`库存操作 ${operation.operation_id} 的已创建流水不存在或不一致，请人工核对`);
    }
    return direct;
  }

  // A resumed task may only reuse a ledger row we can prove belongs to it.
  // Rows written before the 尺码 field became a relation still hold a numeric
  // value (or an empty link after migration), so every existing caller audits
  // the same five facts before continuing.
  // 没有来源字段的动作（采购退货）只核对四项：那张表里根本没有能放下这张来源的列，
  // 硬核对会把"字段名 undefined"当成不匹配，把可恢复的任务判成人工介入。
  ledgerMatchesOperation(ledger, { productRecordId, sizeRecordId, behaviorRecordId,
    sourceField, sourceRecordId, quantityChange }) {
    const fields = this.gateway.table('inventoryLedger').fields;
    return singleLinked(ledger.fields?.[fields.product], productRecordId) &&
      singleLinked(ledger.fields?.[fields.size], sizeRecordId) &&
      singleLinked(ledger.fields?.[fields.behavior], behaviorRecordId) &&
      (!sourceField || singleLinked(ledger.fields?.[fields[sourceField]], sourceRecordId)) &&
      Number(ledger.fields?.[fields.quantityChange]) === quantityChange;
  }

  async auditExistingOperationRecords(operation, ledger, sizeRecordId) {
    const manual = (reason) => {
      throw new Error(`库存操作 ${operation.operation_id} ${reason}，请人工核对，不能自动恢复`);
    };
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: requireMovement(operation.kind).ledgerSource,
      sourceRecordId: operation.source_record_id,
      quantityChange: operation.quantity,
    })) {
      manual(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为、来源或数量不一致`);
    }
    const createdIds = operation.created_live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const selectedIds = operation.live_record_ids || [];
    if (new Set(createdIds).size !== createdIds.length || createdIds.length > operation.quantity ||
      new Set(removedIds).size !== removedIds.length ||
      removedIds.some((recordId) => !selectedIds.includes(recordId))) {
      manual('已记录的实时库存 ID 不一致');
    }
    if (operation.schema_version === 2 && removedIds.length) {
      manual('旧版销售任务已有库存删除，已删除记录的尺码关联无法再核实');
    }
    const liveFields = this.gateway.table('liveInventory').fields;
    if (operation.direction === '增加') {
      for (const [index, recordId] of createdIds.entries()) {
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          textValue(record.fields?.[liveFields.state]) !== operation.state) {
          manual(`已有实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
        // 库存操作键是「这一双属于本次操作第几条」的证明。老记录可能没有这个值
        // （字段是后加的），但一旦写了就必须和本地清单对得上，否则无法区分
        // 「这就是我要的那一双」和「别的操作写进来的同一货品尺码」。
        const recordedKey = textValue(record.fields?.[liveFields[OPERATION_ITEM_KEY_FIELD]]).trim();
        if (recordedKey && recordedKey !== operationItemKey(operation.operation_id, index + 1)) {
          manual(`已有实时库存 ${recordId} 的库存操作键与本地记录不一致`);
        }
      }
    } else if (operation.direction === '减少') {
      if (selectedIds.length !== operation.quantity) manual('待扣减实时库存数量不一致');
      // 同 executeOperation：可扣状态来自注册表的 consumes（销售 门盒+样品、采购退货还要加 仓库）。
      const consumableStates = requireMovement(operation.kind).consumes || [operation.state];
      for (const recordId of selectedIds) {
        if (removedIds.includes(recordId)) continue;
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          !consumableStates.includes(textValue(record.fields?.[liveFields.state]))) {
          manual(`待扣减实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
      }
    } else {
      manual('库存方向无效');
    }
  }

  // ledgerSource 是库存流水里回指来源明细的语义字段名（见 v1BitableSchema）。
  async findLedger(ledgerSource, sourceRecordId, behaviorRecordId) {
    const table = this.gateway.table('inventoryLedger');
    const fieldName = table.fields[ledgerSource];
    const records = await this.gateway.listAll('inventoryLedger');
    const matches = records.filter((record) =>
      linkedRecordIds(record.fields?.[fieldName]).includes(sourceRecordId) &&
      (!behaviorRecordId || linkedRecordIds(record.fields?.[table.fields.behavior]).includes(behaviorRecordId)));
    if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
    return matches[0] || null;
  }

  findLiveInventoryIn(records, productRecordId, sizeRecordId, state = '门盒') {
    const table = this.gateway.table('liveInventory');
    return records.filter(
      (record) =>
        linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId) &&
        linkedRecordIds(record.fields?.[table.fields.size]).includes(sizeRecordId) &&
        textValue(record.fields?.[table.fields.state]) === state
    );
  }

  async findLiveInventory(productRecordId, size, state = '门盒') {
    const sizeReference = await this.sizeReferences.resolveByNumber(size);
    return this.findLiveInventoryIn(await this.gateway.listAll('liveInventory'), productRecordId,
      sizeReference.recordId, state);
  }

  async sampleReplacementCandidates(productRecordId, { excludeRecordIds = [] } = {}) {
    const table = this.gateway.table('liveInventory');
    const bySize = new Map();
    const excluded = new Set(excludeRecordIds);
    for (const record of await this.gateway.listAll('liveInventory')) {
      if (excluded.has(record.record_id)) continue;
      if (!linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId)) continue;
      const size = (await this.sizeReferences.resolveLinkedCell(record.fields?.[table.fields.size])).size;
      const state = textValue(record.fields?.[table.fields.state]);
      if (!['门盒', '样品', '仓库'].includes(state)) continue;
      if (!bySize.has(size)) bySize.set(size, { size, doorBoxCount: 0, sampleCount: 0, warehouseCount: 0 });
      const counts = bySize.get(size);
      if (state === '门盒') counts.doorBoxCount += 1;
      if (state === '样品') counts.sampleCount += 1;
      if (state === '仓库') counts.warehouseCount += 1;
    }
    return [...bySize.values()].sort((left, right) => left.size - right.size);
  }
}

module.exports = {
  InventoryService,
  operationId,
  STOCK_MOVEMENTS,
  ADJUSTMENT_BEHAVIORS,
  // 状态值域从这里导出，避免「实时库存」的状态清单在别处再抄一份（抄了就会漂移）。
  LIVE_STATES,
  MOVEMENT_PURCHASE_DECREASE,
  // 销售出库的行为编码。导出它只为让「库存真的动了」那条正向日志
  //（`sales.inventory.applied`）写**编码**，而不是在别的文件里再抄一份字面量。
  MOVEMENT_SALE_DECREASE,
  MOVEMENT_SALE_RETURN,
  MOVEMENT_SALE_COMPENSATION,
  MOVEMENT_SALE_CASH,
};
