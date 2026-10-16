/**
 * ⭐ 2026-10-11（业务负责人定）：「扫码页采购领域加【退货】——**和"报货"逻辑一样，也走扫码**」。
 *
 * 这个 service 是**采购退货**那条链路的落点：它是"用**既有构件重新组合**"，
 * **不是**新写一套写库逻辑 —— 每一步都调仓库里已经存在的东西：
 *
 *   | 这一步 | 走哪个既有件 |
 *   | --- | --- |
 *   | 「采购主表」建一行（批次号 + 幂等键 + **采购行为**；**不写到达状态**） | `PurchaseOrderBatchService.createForReturnBatch` |
 *   | 「采购明细」写退货明细（**一次攒批**；幂等键一次认完 + 批量建行） | `createOnceByKeys`（`infrastructure/idempotencyKey`，与报货同一套语义） |
 *   | 扣库存 | `InventoryService.applyPurchaseReturnBatch`（⭐ task-65：一批一次；没有批量口时回落 `applyPurchaseReturn`） |
 *   | 出「采购退货单」PNG → 发群 → 回填「报货批次.单据」 | `PurchaseWebhookService.deliverSupplierImages`（只换标题/文件名后缀） |
 *   | 批次号 | 既有 `PurchaseBatchNoGenerator`（`CGD-YYYYMMDD-NNNN`） |
 *
 * ⭐ 2026-10-16（业务负责人逐字「**退货也需要批量提速**」）：**明细写入由逐条改攒批** ——
 *   改前：N 个尺码 ⇒ **N 次整表读**（逐条 `createOnceByKey` 的幂等回查，`listAll` 是翻页读）
 *   ＋ **N 次单条 create**；改后：**1 次整表读 ＋ 1 次 `createBatch`**。落表内容一字不差。
 *   ⚠️ **实时库存那一段（`ensurePlan`）本来就不慢**：整表读在**循环外只读一次**、
 *   循环里只剩内存 filter（`resolveSize` 走 30 秒缓存）⇒ **一个字都没改**。
 *   ⚠️ `inventoryService` 内部（逐尺码 `listAll('liveInventory')` ＋ 逐双 `get`/`delete`）
 *   **上一刀不许碰** ⇒ 那一半的调用次数如实留在测试里（见 `test/purchaseReturnBatchSpeedup.test.js`）。
 *
 * ⭐⭐ task-65（2026-10-16「**退货也需要批量提速**」· 上面那条残留的**收口**）：
 *   `inventoryService` 那一段**这一刀做了** —— 本 service 由「逐尺码调 `applyPurchaseReturn`」
 *   改成「一次调 `applyPurchaseReturnBatch`」（形态与 2026-10-13 验收那条 `applyPurchaseBatch` 同一档）。
 *   ⭐ **`delete` 那一半也做了**（Lead 当场授权）：网关**加了** `deleteBatch`
 *   （单独一个提交、形态逐行对齐 `createBatch`、官方 `appTableRecord.batchDelete`、≤500/片）
 *   ⇒ 退货扣库存那一段由「逐尺码整表读 ＋ 逐双 `get` ＋ 逐双 `delete`」收成
 *   **一次整表读 ＋ 一次 `getBatch` ＋ 一次 `createBatch`（流水）＋ 一次 `deleteBatch`**。
 *   🔴 **只加能力**：网关单条 `delete` 一行没动，既有调用方行为逐字不变。
 *   ⚠️ 注入的库存端口没有批量口 ⇒ **退回逐条**（`applyReturnStockOneByOne`），与改动前逐字节同形。
 *
 * 🔴 **本文件自己不写任何业务表**：没有一处 `gateway.create/update/delete`
 *    （写入全部经上面的既有件；有一条例行哨兵钉着这一点）。
 * 🔴 **超库存**（她认的历史业务行为）：**退能退的 + 把差额如实回报** ——
 *    `available` 在"冻结计划"那一步读一次，`taken = min(她填的, available)`；
 *    `applyChange` 自己还会兜一次底（不够就**当场抛、一双不动**，绝不退成负数）。
 * 🔴 **计划冻结**：批次号与每码的 `taken` 落进本地任务（`plan`），重试沿用同一份
 *    —— 不重新取号、不重算（否则重放重算会多扣/换号）。这与既有
 *    `ensurePostingPlan` / `ensureReturnPlan` 是同一个思路。
 * 🔴 **一双都退不成**（所有尺码的 available 都是 0）⇒ **一个字都不写**（连批次行都不建），
 *    把 `skipped: 'no_stock'` 交给调用方去说人话 —— 不建一条空退货批次。
 *
 * ⭐⭐ task-64（2026-10-16 · 业务负责人逐字：「**退货的多货品 + 供应商拆分要做**」＋
 *   「**同一批次号下按供应商分组**」）—— **退货也支持一单多货 ＋ 出单按供应商分组**。
 *
 * ── 改前逐字 → 改后逐字 → 依据 ────────────────────────────────────────────────
 * | | 逐字 |
 * | --- | --- |
 * | **改前**（只支持单货品） | ① `ensurePlan` 的可用量按**批次级** `draft.product_record_id` 查 ⇒ 多货品时那个值**是空串** ⇒ 每行 `available = 0` ⇒ **`skipped: 'no_stock'`、一个字都不写**（而引擎照样把草稿标成 submitted ⇒ 她看到成功页、账上啥也没有 ✗）；<br>② 每条明细的 `product` 与每条 `drawItems` 的 `supplier_record_id` 都取**批次级**那一个 ⇒ 混供应商的退货**整单落进「未标注供应商」那一张**（**错账级后果** ✗）；<br>③ 明细幂等键 = `purchase_return_doc:{taskId}:{size}` —— 两个货品**同尺码**会**撞同一把键**（第二行被当成重放吸收 ✗）；<br>④ 批次行的「采购行为」只认 `draft.behavior_record_id`（引擎的多货品载荷里**是空串** ⇒ 建出来的退货批次没有采购行为 ⇒ 工作台按"采购申请"分流 ✗） |
 * | **改后** | 逐行算**货品**（`plan.items[*].product_record_id`）· 逐行算**供应商**（`supplier_record_id`；行上没有才由代码读「货品信息.供应商」，再拿不到才回落批次级）；多货品时明细幂等键带**货品**（`…:{productRecordId}:{size}`）；批次行的「采购行为」**拿不到就按本链路的 `config.behaviorCode` 解析一次** |
 * | **依据** | 她 2026-10-16 15:12「退货的多货品 + 供应商拆分要做」＋ 2026-10-16 14:32「**同一批次号下按供应商分组**」（ⓐ）｜分组那一半**复用** `services/supplierSplitService.js`（纯函数 ✓）：本 service **只**保证"每条 `drawItems` 自带自己的供应商"，分桶仍由 `PurchaseWebhookService.deliverSupplierImages` 那一处做 ✓（**不另造第二套** ✗）｜「采购行为」那一条 = `test/scanPurchaseReturn.test.js` 的 AC-R2（主表要写退货那一档行为）＋ 该文件里就写明的"读不到行为记录时按现状=采购申请分流" |
 *
 * 🔴 **单货品 ⇒ 与今天逐字一致**（硬红线，判据 `test/purchaseReturnMultiItem.test.js` 的 AC-RS2）：
 *   · 计划里**不多**任何键（`plan.items` 仍是 `{size, declared, available, taken, shortfall}`）；
 *   · 明细幂等键仍是 `purchase_return_doc:{taskId}:{size}`；
 *   · `drawItems` 仍是那 7 个键、批次级 `supplier_record_id` 照旧；
 *   · 条件 = `needsRowIdentity(...)`：**批次级有货品 且 逐行只有一个货品** ⇒ 走老形状 ✓。
 *
 * 🔴 **每条明细的供应商从哪来**（只读核查结论，别再猜 ✗）：**代码读「货品信息.供应商」那条
 *   *既有*关联列**（`v1BitableSchema.tables.product.fields.supplier`）——与单货品那条路
 *   （`scanWriteService.submitPurchaseReturn` 的 `linkedRecordIds(product.fields[supplier])`）
 *   **同一个字段**，只是这里**逐行**读（多货品时每行的货品不同 ⇒ 供应商也可能不同）；
 *   🔴 **不新增列、不写「货品信息」、不写「采购明细.供应商」（公式列）** ✗。
 *   ⚠️ 为什么必须由代码读：扫码页那条多货品载荷里 `supplier_record_id` **是空的**
 *   （`views/scanPage/multiItemBlock.js` 从 `view.supplier_record_id` 取，而那个键**从来没有被赋过值**）
 *   ⇒ 只认载荷就会把混供应商的退货整单落进「未标注供应商」✗。
 */
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { createOnceByKeys, IDEMPOTENCY_KEY_FIELD } = require('../infrastructure/idempotencyKey');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { relation, V1ReferenceResolver } = require('./v1ReferenceResolver');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { PurchaseOrderBatchService } = require('./purchaseOrderBatchService');
const { PurchaseBatchNoGenerator } = require('./purchaseBatchNoGenerator');
const {
  InventoryService, MOVEMENT_PURCHASE_DECREASE, STOCK_MOVEMENTS,
} = require('./inventoryService');
const { SCAN_WRITE } = require('../config/scanWrite');
const { correlationFields } = require('../utils/correlationFields');
// ⭐ 2026-10-12 采购明细ID（`{报货批次号}-{两位序号}`）—— 与报货那条**同一个分配器**。
const { createPurchaseDetailIdAllocator } = require('./purchaseDetailId');
const { logInfo, logWarn } = require('../utils/logger');

/** 退货要扣哪些状态 —— **不在这里写死**，从库存注册表读（现存 = 门盒 + 样品 + 仓库）。 */
const purchaseReturnStates = () => STOCK_MOVEMENTS[MOVEMENT_PURCHASE_DECREASE].consumes || [];

const sumOf = (items, key) => items.reduce((sum, item) => sum + Number(item[key] || 0), 0);

/**
 * 一行退货明细的**货品 record_id**（逐行 ✓）。
 * 老草稿 / 老计划里逐行没有它 ⇒ 退回**批次级**那一个（= 单货品那条路今天的形状 ✓ 不猜 ✗）。
 */
const rowProductIdOf = (item, draft) => String(
  (item && (item.product_record_id || item.productRecordId)) || (draft && draft.product_record_id) || '',
).trim();

/** 一行退货明细的**供应商 record_id**（逐行 ✓；行上没有 ⇒ 退回批次级那一个）。 */
const rowSupplierIdOf = (item, draft) => String(
  (item && (item.supplier_record_id || item.supplierRecordId)) || (draft && draft.supplier_record_id) || '',
).trim();

/**
 * ⭐ 这一次要不要**逐行**带身份（货品 + 供应商）——
 *   · **批次级没有货品**（= 引擎的多货品载荷 `planSubmission` 在 `single === false` 时留空 ✓）⇒ 要；
 *   · 或逐行真的是**多个货品** ⇒ 要；
 *   · 单货品那条老路（`scanWriteService.submitPurchaseReturn`）两个都不满足 ⇒ **不要**
 *     ⇒ 计划 / 明细 / 图 / 幂等键**逐字与今天一致**（硬红线 AC-RS2 ✓）。
 */
const needsRowIdentity = (items, draft) => {
  const batchProduct = String((draft && draft.product_record_id) || '').trim();
  const rowProducts = new Set(
    (Array.isArray(items) ? items : []).map((item) => rowProductIdOf(item, {})).filter(Boolean),
  );
  return !batchProduct || rowProducts.size > 1;
};

/**
 * ⭐ task-65 的**回落路径**：注入的库存端口没有批量口（= 既有替身用例 / 未接线）时逐条调
 * `applyPurchaseReturn` —— 与改动前**逐字同一条路**（顺序、返回值、异常都逐字相同）。
 */
const applyReturnStockOneByOne = async (inventory, payloads, options) => {
  const results = [];
  for (const payload of payloads) results.push(await inventory.applyPurchaseReturn(payload, options));
  return results;
};

const createPurchaseReturnService = (options = {}) => {
  if (!options.gateway) throw new Error('PurchaseReturnService 需要 gateway');
  const gateway = options.gateway;
  const config = options.config || SCAN_WRITE.purchaseReturn;
  const events = options.events || SCAN_WRITE.events;
  const store = options.store || new JsonTaskStore({ dir: config.taskDir, idField: 'task_id' });
  // ⚠️ `createSizeReferenceAccess` 返回的是**取用器**（与 purchaseWebhookService.getSizeReferences 同形）
  const getSizes = options.sizeReferences || createSizeReferenceAccess({ gateway });
  const resolveSize = (value) => getSizes().resolveByNumber(value);
  const inventory = options.inventory || new InventoryService({ gateway });
  const orderBatches = options.orderBatches || new PurchaseOrderBatchService({ gateway });
  // ⭐ 2026-10-12：采购明细ID 分配器（用例可注入替身）。
  const detailIds = options.detailIds || createPurchaseDetailIdAllocator({ gateway });
  // 只为"出退货单图"那一步（发群 / 回填附件都在它内部）；用例可以不注入（那就只记一条 warn）。
  const webhooks = options.webhooks || null;
  const batchNoGenerator = options.batchNoGenerator || new PurchaseBatchNoGenerator({ gateway });
  // ⭐ task-64：**采购行为**那条既有解析器（`scanWriteService` 也是用它解析同一个编码 ✓）——
  //   只在"草稿里没带行为"时用（引擎的多货品载荷正是这种形状 ✓）；懒建 ⇒ 单货品那条老路
  //   **一次都不碰它**（零额外读 ✓）。
  let references = options.references || null;
  const resolveBehaviorRecordId = async () => {
    if (!references) references = new V1ReferenceResolver(gateway);
    const behavior = await references.resolveBehavior(config.behaviorCode);
    return String((behavior && behavior.recordId) || '');
  };
  /**
   * ⭐ task-64：**这一行**的供应商 —— 由**代码**读「货品信息.供应商」那条**既有**关联列
   *   （与单货品那条路同一个字段 ✓；**不新增列、不写那张表** ✗）。
   *   同一个货品只读一次（一单里同货品多尺码很常见 ✓）。
   */
  const supplierCache = new Map();
  const resolveSupplierByProduct = async (productRecordId) => {
    const wanted = String(productRecordId || '').trim();
    if (!wanted) return '';
    if (supplierCache.has(wanted)) return supplierCache.get(wanted);
    const table = gateway.table('product');
    const field = table && table.fields ? table.fields.supplier : '';
    // 映射拿不到 ⇒ **不猜**（空供应商 ⇒ 出图那边照旧出"未标注供应商"那一张 ✓）
    const record = field ? await gateway.get('product', wanted).catch(() => null) : null;
    const supplierRecordId = linkedRecordIds(record && record.fields ? record.fields[field] : null)[0] || '';
    supplierCache.set(wanted, supplierRecordId);
    return supplierRecordId;
  };

  /** 取下一个批次号（与既有报货那条同一个生成器、同一把串行锁）。 */
  const nextBatchNo = async () => {
    const generated = await batchNoGenerator.runExclusive(
      async () => batchNoGenerator.next({ source: 'scan_return' }),
    );
    return generated.batchNo;
  };

  /**
   * 冻结计划（**只算一次**）：批次号 + 每码的 `declared / available / taken / shortfall`。
   * 重试沿用落盘的那一份 ⇒ 不重新取号、不重算（重算一定与第一次不同 —— 库存已经动过了）。
   *
   * ⭐ task-64：**多货品**时顺手把**逐行身份**也冻进计划（`product_record_id` / `supplier_record_id`）——
   *   重试时逐字复用 ⇒ 不重读货品、也不会把供应商重新算成另一个（幂等的物理基础 ✓）。
   *   🔴 单货品**不带**这两个键（计划逐字与今天一致 ✓ AC-RS2）。
   */
  const ensurePlan = async (taskId, task) => {
    if (task?.plan?.version === 1) return task.plan;
    const draft = task?.draft || {};
    const items = Array.isArray(draft.items) ? draft.items : [];
    if (!items.length) throw new Error('采购退货草稿没有任何明细');
    const liveTable = gateway.table('liveInventory');
    const allLive = await gateway.listAll('liveInventory');
    const states = purchaseReturnStates();
    // 这一次要不要逐行带身份（多货品 ⇒ 要；单货品 ⇒ 不要，逐字走今天那条 ✓）
    const withRowIdentity = needsRowIdentity(items, draft);
    const planned = [];
    for (const item of items) {
      const sizeRef = await resolveSize(item.size);
      const productRecordId = rowProductIdOf(item, draft);
      // 「这一款这一码现在能退几双」= 实时库存里（门盒 + 样品 + 仓库）那些"一双一条"的记录数。
      // ⚠️ 只按关联 record_id 比对，不从库存行反推尺码（坏行不会把整条退货链路拖挂）。
      // ⭐ task-64：比的是**这一行那个货品**（改前是批次级那一个 ⇒ 多货品时空串 ⇒ available 恒 0 ✗）。
      const available = (allLive || []).filter((record) => (
        linkedRecordIds(record?.fields?.[liveTable.fields.product]).includes(productRecordId)
        && linkedRecordIds(record?.fields?.[liveTable.fields.size]).includes(sizeRef.recordId)
        && states.includes(textValue(record?.fields?.[liveTable.fields.state]))
      )).length;
      const declared = Number(item.quantity);
      const taken = Math.min(declared, available);
      // 逐行供应商：**行上带的**优先（引擎 / 别的调用方 ✓）⇒ 没有才由**代码**读
      // 「货品信息.供应商」（扫码页那条载荷正是这一种 ✓）⇒ 再拿不到才回落批次级。
      const supplierRecordId = withRowIdentity
        ? (String(item?.supplier_record_id || '').trim()
          || await resolveSupplierByProduct(productRecordId)
          || String(draft.supplier_record_id || '').trim())
        : '';
      planned.push({
        ...(withRowIdentity ? {
          product_record_id: productRecordId,
          supplier_record_id: supplierRecordId,
          // ⚠️ 出图要用的那几个**展示字段**也冻进计划：重放时逐字复用（不回头读草稿 ——
          //    草稿在第一跑收尾时会被换成 `drawItems`，第二跑再读它就成了另一份形状 ✗）。
          product_number: String(item?.product_number || draft.product_number || ''),
          item_no: String(item?.item_no || draft.item_no || ''),
          color: String(item?.color || draft.color || ''),
        } : {}),
        size: Number(item.size), declared, available, taken, shortfall: declared - taken,
      });
    }
    const plan = { version: 1, batch_no: draft.batch_no || (await nextBatchNo()), items: planned };
    // ⭐ task-64：草稿里**没带**「采购行为」时（= 引擎那条多货品载荷的形状）按本链路的配置解析一次，
    //   并**冻进计划**（重试逐字复用 ✓）。单货品那条老路草稿里本来就带着 ⇒ 这里一行都不走 ✓。
    if (!String(draft.behavior_record_id || '').trim()) {
      plan.behavior_record_id = await resolveBehaviorRecordId();
    }
    await store.update(taskId, { plan, posting_stage: 'plan_frozen' });
    logInfo(events.returnPlanFrozen, {
      task_id: taskId, batch_no: plan.batch_no,
      declared_count: sumOf(planned, 'declared'),
      taken_count: sumOf(planned, 'taken'),
      shortfall: sumOf(planned, 'shortfall'),
      sizes: planned.map((item) => `${item.size}码:${item.taken}/${item.declared}`).join(','),
      // ⭐ task-64（只读诊断键）：这一次是不是多货品、有几家的供应商拿到了、几家没拿到（没拿到 ⇒ 出图落"未标注"桶）
      row_identity: withRowIdentity,
      supplier_count: new Set(planned.map((item) => item.supplier_record_id).filter(Boolean)).size,
      supplier_missing: planned.filter((item) => withRowIdentity && !item.supplier_record_id).length,
      behavior_source: draft.behavior_record_id ? 'draft' : (plan.behavior_record_id ? 'resolved' : 'none'),
    });
    return plan;
  };

  /**
   * 执行一次采购退货（幂等：同一 `taskId` + 已冻结的计划 ⇒ 重放只补没写完的部分）。
   *
   * @param {string} taskId 由**这一次提交的幂等键**推出（调用方算，与报货那条同一个思路）
   * @param {object} draft  这次要退什么（货品 / 供应商 / 采购行为 + items[{size, quantity}]）
   */
  const submit = async (taskId, draft) => {
    let task = await store.get(taskId);
    if (!task) {
      task = await store.create({
        task_id: taskId, kind: 'scan_purchase_return', status: 'posting', draft,
      });
    }
    const plan = await ensurePlan(taskId, task);
    const correlation = correlationFields({ task_id: taskId, batch_no: plan.batch_no });
    const declaredCount = sumOf(plan.items, 'declared');
    const takenCount = sumOf(plan.items, 'taken');
    const shortfall = sumOf(plan.items, 'shortfall');

    // 🔴 一双都退不成 ⇒ **一个字都不写**（连批次行都不建）—— 空批次行只会让她以为"退成功了"。
    if (takenCount <= 0) {
      logInfo(events.returnShortfall, {
        task_id: taskId, batch_no: plan.batch_no, declared_count: declaredCount,
        taken_count: 0, shortfall, reason: 'no_stock_at_all',
        note: '所有尺码的实时库存都是 0 ⇒ 不建批次行、不写明细、不扣库存',
      });
      return {
        batch_no: plan.batch_no,
        batch_record_id: '',
        request_ids: [],
        declared_count: declaredCount,
        taken_count: 0,
        shortfall,
        shortfalls: plan.items,
        skipped: 'no_stock',
      };
    }

    // ① 退货批次那一行（只写 批次号 + 幂等键；出退货单的图要用它当落点）
    // ⭐ 2026-10-12：把**采购退货那一档行为记录 id** 传下去 ⇒ 主表行写上「采购行为」
    //    （明细那一列是它的 Lookup，只读，明细侧不写）。
    // ⭐ 2026-10-12：把这一批的**录入数量合计**（= 每码 `taken` 之和，上面已经算好）传给建行，
    //    写上「报货批次.录入数量」—— 她报货时填的数量，就是这一列。
    const batch = await orderBatches.createForReturnBatch(plan.batch_no,
      {
        correlation,
        // ⭐ task-64：草稿里没带行为时用**计划里冻结**的那一个（多货品那条引擎载荷的形状 ✓）；
        //   单货品那条老路草稿里本来就带着 ⇒ 逐字不变（`undefined` ⇒ 网关跳过该列 ✓）。
        behaviorRecordId: draft.behavior_record_id || plan.behavior_record_id,
        quantity: takenCount,
      });
    if (!batch.recordId) {
      throw new Error('采购退货批次那一行没建成：退货明细就没有落点，这次不写');
    }
    const batchRecordId = batch.recordId;
    await store.update(taskId, {
      batch_record_id: batchRecordId, batch_no: plan.batch_no, posting_stage: 'batch_created',
    });
    logInfo(events.returnBatchCreated, {
      task_id: taskId, batch_no: plan.batch_no, batch_record_id: batchRecordId,
      created: batch.created === true, reused: batch.reused === true,
    });

    // ⭐⭐ task-64：**这一单是不是"多货品"** —— 判据只看**计划里那几行**（重放时计划已冻结 ⇒
    //   判据逐字一致 ✓）；单货品 ⇒ 下面每一处都退回**批次级**那一个（与今天逐字相同 ✓）。
    //   ⚠️ 老计划（改动前冻结的那一份）里没有 `product_record_id` ⇒ 全部回落批次级 ⇒ `false` ✓
    //     （与它第一次写入时用的形状**同一条** ⇒ 重放不会换幂等键 ✗）。
    const rowIdentity = needsRowIdentity(plan.items, draft);
    /**
     * 一行（明细 / 出图）的**身份**：逐行优先、拿不到退回批次级（**不猜** ✗）。
     * ⚠️ 单货品那条老路上，三个 `||` 的右边**全中**（逐行与批次级本来就是同一个值）⇒ 逐字不变 ✓。
     */
    const lineOf = (item) => ({
      product_record_id: rowProductIdOf(item, draft),
      supplier_record_id: rowSupplierIdOf(item, draft),
      product_number: String(item?.product_number || draft.product_number || ''),
      item_no: String(item?.item_no || draft.item_no || ''),
      color: String(item?.color || draft.color || ''),
    });

    // ⭐⭐ 2026-10-15（业务负责人裁决ⓐ）：**退货这一批的「整单金额」**
    //   写到这一行的「发生金额」（`purchaseOrderBatch.actualAmount`）。
    //   依据：她 2026-10-14 晚逐字「退货整单金额（必填），与补货同一套配置」
    //     （必填 + 配置已在 PR #561）＋她 **2026-10-15 裁决ⓐ**：列名 = 复用「发生金额」。
    //   🔴 **只有退货走这里**：补货（报货）那条的批次行带「到货状态 = 未到货」
    //     （`purchaseWebhookService` 的 `confirmPurchaseRequest`）⇒ 她之后的到货核对会写同一行同一列
    //     （本仓库已只读核实、Lead 已在问她）⇒ **先不写**（见 `routes/scanPage.js` 里保留的 TODO）。
    //   ⚠️ 位置：**批次行建好之后、明细/库存之前** —— 这样它失败时只留下一行
    //     可重试的批次行（`posting_stage: batch_created`），不会出现"明细写了、金额没写"的半截账。
    //   ⚠️ 空值 ⇒ **不写也不报错**（向后兼容：服务层的老调用方不带这个字段；
    //     页面那道闸门已保证从页面来的提交一定非空 ✓）。
    //   🔴 **不许假成功**：金额没落表 ⇒ 这一次不算成功（如实抛出 ⇒ 上层报「写入失败」；
    //     同一把 `submitKey` 重试会接着这一批写 ✓）。
    const orderAmount = draft.order_amount;
    if (orderAmount !== undefined && orderAmount !== null && String(orderAmount).trim() !== '') {
      const amountWrite = await orderBatches.writeOrderAmount({
        batchNo: plan.batch_no, batchRecordId, actualAmount: orderAmount, correlation,
      });
      if (!amountWrite.updated) {
        const error = new Error('purchase return order amount not written: '
          + String(amountWrite.reason || 'unknown'));
        error.scanUserMessage = SCAN_WRITE.texts.purchaseReturnAmountWriteFailedBody;
        throw error;
      }
      await store.update(taskId, { order_amount_written: amountWrite.actual_amount });
    }

    // ⭐⭐ 2026-10-12：采购明细ID = `{报货批次号}-{两位序号}`（退货这条链路同样要写；
    //    与报货那条**同一个分配器** ⇒ 同一批次内 01/02… 不重排、不重号、重放不重复占号）。
    const detailIdCursor = await detailIds.open({ batchRecordId, batchNo: plan.batch_no });

    // ② **一次攒批**：把这一批的退货明细一次写完（幂等键**一次认完** ＋ 批量建行）。
    //    ⚠️ 顺序仍是**计划顺序**：`detailIdCursor.next()` 只在 `taken > 0` 的尺码上按序取号
    //    （与逐条写法同一口径：跳过 `taken <= 0` 的尺码 ⇒ 它们**不占序号**）。
    //    `resolveSize` 走 30 秒内存缓存 ⇒ 这一步**不发额外请求**（见文件头"这里本来就不慢"）。
    const sizeRecordIdBySize = new Map();
    for (const item of plan.items) {
      if (item.taken <= 0) continue;
      sizeRecordIdBySize.set(item.size, (await resolveSize(item.size)).recordId);
    }
    const drawnItems = plan.items.filter((item) => item.taken > 0);
    const docs = await createOnceByKeys({
      gateway,
      tableKey: 'purchaseRequest',
      keyField: IDEMPOTENCY_KEY_FIELD,
      correlation,
      rows: drawnItems.map((item) => {
        const line = lineOf(item);
        // 幂等键由「这个任务 + 这个尺码」推出 ⇒ 重放命中同一条远端记录，不写第二条。
        // ⭐ task-64：**多货品**时再带上**这一行的货品** —— 两个货品同尺码时会撞同一把键
        //   （第二行被当成重放吸收 ⇒ 静默少一行 ✗）；单货品仍是那串**逐字**不变的键 ✓（AC-RS2）。
        const docKey = rowIdentity
          ? `purchase_return_doc:${taskId}:${line.product_record_id}:${item.size}`
          : `purchase_return_doc:${taskId}:${item.size}`;
        return {
          keyValue: docKey,
          label: `采购退货明细 ${taskId} ${item.size}码`,
          values: {
            batchNo: relation(batchRecordId),
            // 🔴 2026-10-12 热修（同一个 Lookup 列）：**不许再写「采购行为」** ——
            //    「采购明细.采购行为」已被她改成 **Lookup（只读，按「报货批次号」关联采购主表）**，
            //    写它轻则被忽略、重则整条退货明细 create 失败。
            //    ⚠️ 与报货那条同一个待定项：主表的「采购行为」没有写入点（她 2026-10-07 说过不用管）
            //    ⇒ 退货明细的这一列也会是空的，分流判据读不到就按现状=采购申请分流。
            // ⭐ task-64：`product` 取**这一行**那个货品（改前是批次级那一个 ⇒ 多货品时是空串 ✗）
            product: relation(line.product_record_id),
            size: relation(sizeRecordIdBySize.get(item.size)),
            quantity: item.taken,
            // ⭐ 采购明细ID（`{报货批次号}-01`、`-02`…）
            detailId: detailIdCursor.next(),
            idempotencyKey: docKey,
          },
        };
      }),
    });

    // ③ 逐尺码：扣库存（走 InventoryService；这一段**上一刀一个字没动**）＋ 准备出图入参。
    // ③ 扣库存（走 InventoryService；**本刀把它由"逐尺码"改成"一批一次"**）＋ 准备出图入参。
    //    ⭐ task-65（业务负责人 2026-10-16 逐字「退货也需要批量提速」）——
    //    **改前逐字**：`for (const item of drawnItems) { const change = await inventory.applyPurchaseReturn({...}) }`
    //      ⇒ 每个尺码各一次 `applyChange`（逐尺码整表读 `liveInventory` ＋ 逐双 `get` ＋ 逐双 `delete`）。
    //    **改后逐字**：一次 `inventory.applyPurchaseReturnBatch(payloads)` —— 形态与 2026-10-13
    //      验收那条 `applyPurchaseBatch` **同一档**（1 次整表读 ＋ 1 次 `createBatch` ＋ 1 次 `getBatch`
    //      ＋ 1 次 `deleteBatch`；`deleteBatch` 是 task-65 给网关新加的，≤500/片由网关分片）。
    //    **依据**：她 2026-10-16「退货也需要批量提速」（#749 明细那半之后剩下的库存这一段）。
    //    ⚠️ 注入的库存端口**没有**批量口（既有替身用例）⇒ **退回逐条**，与改动前**逐字节同形**。
    //    ⚠️ 顺序仍是"明细先写实、库存后扣"；失败粒度见 `applyPurchaseReturnBatch` 的注释。
    //    ⭐ task-64：`productRecordId` 取**这一行**那个货品（改前取批次级那一个 ⇒ 多货品时是空串 ⇒
    //      库存引擎当场报"缺少商品 record_id"；单货品时两者本就是同一个值 ⇒ 逐字不变 ✓）。
    const stockPayloads = drawnItems.map((item) => ({
      productRecordId: lineOf(item).product_record_id,
      size: item.size,
      quantity: item.taken,
      // `state` 只用于本地串行队列的键；真正扣哪些状态由注册表（门盒 + 样品 + 仓库）决定。
      state: '门盒',
      purchaseBatchRecordId: batchRecordId,
      purchaseBatchNo: plan.batch_no,
      returnTaskId: taskId,
    }));
    const changes = typeof inventory.applyPurchaseReturnBatch === 'function'
      ? await inventory.applyPurchaseReturnBatch(stockPayloads, { correlation })
      : await applyReturnStockOneByOne(inventory, stockPayloads, { correlation });

    const requestIds = [];
    const drawItems = [];
    for (let index = 0; index < drawnItems.length; index += 1) {
      const item = drawnItems[index];
      const doc = docs[index];
      const change = changes[index];
      // ⭐ task-64：这一行的**身份**逐行取（货品 / 货号 / 颜色 / 供应商）——
      //   单货品时三个 `||` 右边**全中** ⇒ 与今天**逐字同一份** `drawItems`（AC-RS2 的 deepEqual ✓）。
      const line = lineOf(item);
      requestIds.push(doc.recordId);
      logInfo(events.returnStockApplied, {
        task_id: taskId, batch_no: plan.batch_no, size: item.size, quantity: item.taken,
        product_record_id: line.product_record_id,
        doc_id: doc.recordId, reused_doc: doc.reused === true,
        ledger_record_id: change?.ledgerRecordId || '',
        live_record_ids: change?.liveRecordIds || [],
        ...correlation,
      });
      drawItems.push({
        product_record_id: line.product_record_id,
        product_number: line.product_number,
        item_no: line.item_no,
        color: line.color,
        size: item.size,
        quantity: item.taken,
        // ⭐ 每行**自带自己的供应商** ⇒ 既有出图链路（`deliverSupplierImages` →
        //   `supplierSplitService.groupItemsBySupplier`）据此按供应商分组 ✓（**不另造第二套** ✗）
        supplier_record_id: line.supplier_record_id,
      });
    }

    // 明细与库存都落地了 ⇒ 把这次要画的图（只有真的退掉的尺码）写进任务草稿，
    // 交给既有出图链路（它按供应商分组、按 `quantity` 求和画图）。
    const updated = await store.update(taskId, {
      status: 'posted',
      request_ids: requestIds,
      posting_stage: 'posted',
      draft: { ...draft, items: drawItems },
    });

    // ③ 出「采购退货单」PNG → 发采购群 → 回填「报货批次.单据」（**失败不阻塞主流程**）
    if (webhooks && typeof webhooks.deliverSupplierImages === 'function') {
      try {
        await webhooks.deliverSupplierImages(taskId, updated, {
          batch_no: plan.batch_no, batch_record_id: batchRecordId, request_ids: requestIds,
        }, { title: config.imageTitle, fileNameSuffix: config.fileNameSuffix });
      } catch (error) {
        logWarn(events.returnImageFailed, {
          task_id: taskId, batch_no: plan.batch_no, error: error.message,
          note: '退货事实与库存已经落地，图没发出去只记这一条（重试会按幂等键补）',
        });
      }
    } else {
      logWarn(events.returnImageFailed, {
        task_id: taskId, batch_no: plan.batch_no, reason: 'no_image_pipeline',
        note: '没有接出图链路（用例 / 未接线）：退货事实照样落地',
      });
    }

    if (shortfall > 0) {
      logInfo(events.returnShortfall, {
        task_id: taskId, batch_no: plan.batch_no, declared_count: declaredCount,
        taken_count: takenCount, shortfall,
        sizes: plan.items.filter((item) => item.shortfall > 0)
          .map((item) => `${item.size}码:${item.taken}/${item.declared}`).join(','),
        ...correlation,
      });
    }

    return {
      batch_no: plan.batch_no,
      batch_record_id: batchRecordId,
      request_ids: requestIds,
      declared_count: declaredCount,
      taken_count: takenCount,
      shortfall,
      shortfalls: plan.items,
      skipped: '',
    };
  };

  return { submit, ensurePlan, nextBatchNo, store };
};

module.exports = { createPurchaseReturnService };
