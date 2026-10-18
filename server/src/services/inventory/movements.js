// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 65-344 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 库存动作注册表（引擎语义层，配置先行）：行为编码 → 方向 / 消耗状态 / 状态流转 / 来源列。
// 「行为管理」表负责业务侧（哪条启用、库存方向、资金方向），这里只声明引擎语义。

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
//   · 状态类（转冻结 / 转释放门盒 / 样品转门盒 / 门盒转样品）：**方向=不影响**，
//     只改「实时库存」的「所属状态」，数量不变。它们**不许**走 `applyChange`
//     （走进去会被当成"增加"凭空建鞋），必须走状态变更通路——
//     下面 `requireQuantityMovement` 就是拦这个的闸门。
const ADJUSTMENT_BEHAVIORS = Object.freeze({
  MANUAL_INCREASE: 'STOCK_MANUAL_INCREASE',
  MANUAL_DECREASE: 'STOCK_MANUAL_DECREASE',
  FREEZE: 'STOCK_FREEZE',
  // ⚠️ 2026-10-08：业务负责人在生产「行为管理」表里把这条行为**改了编码**——
  //    原来的「转释放」`STOCK_UNFREEZE` 已被她改成「转释放门盒」`STOCK_RELEASE_TO_DOOR_BOX`
  //    （表里**不再有** `STOCK_UNFREEZE`）⇒ 代码跟着表走，这里同步成新编码。
  //    ⚠️ 待确认：新名字/新编码字面指向「仓库 → 门盒」，但 `UNFREEZE_STATE_TRANSITION`
  //    目前仍允许回「门盒 / 样品」两种（工作台也仍让她选）。若她确实要收窄成只回门盒，
  //    要一并改 `UNFREEZE_STATE_TRANSITION` 与工作台入口——**确认前不动配置**。
  UNFREEZE: 'STOCK_RELEASE_TO_DOOR_BOX',
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
//    **转冻结 = 门盒/样品 → 仓库；转释放门盒 = 仓库 → 门盒/样品**（换季收鞋 / 拿鞋）。
//    ⚠️ 待确认（2026-10-08）：她把这条行为的名字改成「转释放门盒」、编码改成
//      `STOCK_RELEASE_TO_DOOR_BOX`（见 ADJUSTMENT_BEHAVIORS.UNFREEZE），字面指向
//      **「仓库 → 门盒」**；但下面 `UNFREEZE_STATE_TRANSITION` 目前仍是**门盒/样品二选一**。
//      若她确实要收窄，改这一处常量 + 工作台入口（现在仍让她选）——**确认前不动**。
//    即采用方案 B 的形状——只改「所属状态」这一列，**不新增「冻结状态」列**。
//    ⚠️ 方案 B 的已知代价：记录进了「仓库」以后**原来在门盒还是样品就查不到了**
//      （「库存流水」没有操作人列、也没有指向单据的来源列，翻不回来）。
//      所以**转释放门盒（当前口径：仓库 → 门盒/样品）必须由她在界面上选"回门盒还是回样品"**——
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
    // ⚠️ 2026-10-18（业务负责人改表）：生产「库存流水.关联销售」指向**销售主表** ⇒
    //   来源列仍叫 salesDetail（幂等回查/local operation 用明细 id），但远端写入值用
    //   `ledgerLink`（销售主表 record id）覆盖它 —— 见下面 ledgerLink。
    ledgerSource: 'salesDetail',
    // 按顺序消耗这些状态的实时库存；null 表示不消耗既有记录。
    consumes: ['门盒', '样品'],
    // ⭐ 2026-10-18：远端「关联销售」= 销售主表 id（只写不查）；本地幂等仍用明细 id。
    ledgerLink: {
      field: 'salesDetail',
      inputKey: 'salesEntryRecordId',
      operationKey: 'sales_entry_record_id',
    },
    // 扣到样品时要不要触发补样品提醒。
    triggerSampleReplacement: true,
  },
  [MOVEMENT_PURCHASE_INCREASE]: {
    direction: '增加',
    // ⚠️ `ledgerSource` **仍为 `null`**（2026-10-07 深夜定的，2026-10-08 补刀**没动它**）：
    //    它是**参与幂等/恢复**的"按来源回查流水"字段（`findLedger` / `audit…` 都用它），
    //    值取本地 `source_record_id`。而采购加库存的 `source_record_id` 是**三元组**
    //    （`purchase_increase:<批次身份>|<货品>|<尺码>`）—— 一个批次对应**多条**流水，
    //    拿它当来源回查会判成「存在重复库存流水」⇒ 只能继续为 null。
    ledgerSource: null,
    // ⭐ 2026-10-08 补刀：业务负责人把「库存流水.关联采购」从"指向已删除的「采购入库」"
    //    **改成了指向「报货批次」** ⇒ 这条流水**多写一个**「关联采购」= 报货批次那一行的
    //    record id（走 `input.purchaseBatchRecordId`，**真实值；拿不到就不写、绝不编**）。
    //    ⚠️ `ledgerLink` 与 `ledgerSource` 的分工（**两个都别混**）：
    //      · `ledgerSource` = **查得到才写得对**的幂等来源列（值 = `source_record_id`）；
    //      · `ledgerLink`   = **只写不查**的关联列，值**不一定等于** `source_record_id`。
    //    取空时 `executeOperation` 整列不写（不是写空串、也不是回退成批次号 / 任务 id）。
    //    它不改变任何幂等判据 —— 幂等仍是 `source_record_id` + `operationId`。
    ledgerLink: {
      field: 'purchaseBatch',
      inputKey: 'purchaseBatchRecordId',
      operationKey: 'purchase_batch_record_id',
    },
    consumes: null,
    triggerSampleReplacement: false,
  },
  // 采购退货：方向=减少，且**状态无关**——样品、门盒、仓库都要退（见上面的注释）。
  //
  // ⚠️ ledgerSource 为 null：「库存流水」的两个来源字段是「关联销售」→销售明细、
  // 「关联采购」→采购入库（⚠️ 后者随「采购入库」表一起被删，见上一条），
  // 而采购退货既不产生销售明细、也不产生采购入库（业务负责人明确退货不走采购到货/入库），
  // 表里没有能关联「报货信息」的字段。
  // 所以这条流水**不带来源关联**，而不是往错表的字段里写一个 id（那会被飞书拒绝或
  // 写出一条指错来源的流水）。
  // 👉 **此处等「关联单据」列**：父代理已去确认她要不要在「库存流水」加一个指向
  //    「报货信息」的「关联单据」列；加好之后只改这一行（ledgerSource: 'supplierReturnOrder'
  //    + v1BitableSchema 里补一条字段映射）就能让退货流水和销售一样带远端幂等键。
  //    在那之前，重试保护是：任务终态 + 「报货信息」行幂等键 + 落盘的核对计划
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

module.exports = {
  BEHAVIOR_SAMPLE_PROMOTION,
  ADJUSTMENT_BEHAVIORS,
  FREEZE_STATE_TRANSITION,
  UNFREEZE_STATE_TRANSITION,
  LIVE_STATES,
  QUANTITY_DIRECTIONS,
  STOCK_MOVEMENTS,
  SALE_LEDGER_SOURCE,
  MOVEMENT_SALE_DECREASE,
  MOVEMENT_PURCHASE_INCREASE,
  MOVEMENT_PURCHASE_DECREASE,
  MOVEMENT_SALE_RETURN,
  MOVEMENT_SALE_COMPENSATION,
  MOVEMENT_SALE_CASH,
  requireMovement,
  requireQuantityMovement,
  requireStateMovement,
  resolveTargetState,
};
