/**
 * ⭐ 2026-10-11（业务负责人定）：「扫码页采购领域加【退货】——**和"报货"逻辑一样，也走扫码**」。
 *
 * 这个 service 是**采购退货**那条链路的落点：它是"用**既有构件重新组合**"，
 * **不是**新写一套写库逻辑 —— 每一步都调仓库里已经存在的东西：
 *
 *   | 这一步 | 走哪个既有件 |
 *   | --- | --- |
 *   | 「采购主表」建一行（批次号 + 幂等键 + **采购行为**；**不写到达状态**） | `PurchaseOrderBatchService.createForReturnBatch` |
 *   | 「报货信息」写退货明细（采购行为 = 退货行为） | `createOnceByKey`（远端幂等键回查，与报货同一套） |
 *   | 扣库存 | `InventoryService.applyPurchaseReturn`（内部就是既有的 `applyChange`） |
 *   | 出「采购退货单」PNG → 发群 → 回填「报货批次.单据」 | `PurchaseWebhookService.deliverSupplierImages`（只换标题/文件名后缀） |
 *   | 批次号 | 既有 `PurchaseBatchNoGenerator`（`CGD-YYYYMMDD-NNNN`） |
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
 */
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { createOnceByKey, IDEMPOTENCY_KEY_FIELD } = require('../infrastructure/idempotencyKey');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
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
   */
  const ensurePlan = async (taskId, task) => {
    if (task?.plan?.version === 1) return task.plan;
    const draft = task?.draft || {};
    const items = Array.isArray(draft.items) ? draft.items : [];
    if (!items.length) throw new Error('采购退货草稿没有任何明细');
    const liveTable = gateway.table('liveInventory');
    const allLive = await gateway.listAll('liveInventory');
    const states = purchaseReturnStates();
    const planned = [];
    for (const item of items) {
      const sizeRef = await resolveSize(item.size);
      // 「这一款这一码现在能退几双」= 实时库存里（门盒 + 样品 + 仓库）那些"一双一条"的记录数。
      // ⚠️ 只按关联 record_id 比对，不从库存行反推尺码（坏行不会把整条退货链路拖挂）。
      const available = (allLive || []).filter((record) => (
        linkedRecordIds(record?.fields?.[liveTable.fields.product]).includes(draft.product_record_id)
        && linkedRecordIds(record?.fields?.[liveTable.fields.size]).includes(sizeRef.recordId)
        && states.includes(textValue(record?.fields?.[liveTable.fields.state]))
      )).length;
      const declared = Number(item.quantity);
      const taken = Math.min(declared, available);
      planned.push({
        size: Number(item.size), declared, available, taken, shortfall: declared - taken,
      });
    }
    const plan = { version: 1, batch_no: draft.batch_no || (await nextBatchNo()), items: planned };
    await store.update(taskId, { plan, posting_stage: 'plan_frozen' });
    logInfo(events.returnPlanFrozen, {
      task_id: taskId, batch_no: plan.batch_no,
      declared_count: sumOf(planned, 'declared'),
      taken_count: sumOf(planned, 'taken'),
      shortfall: sumOf(planned, 'shortfall'),
      sizes: planned.map((item) => `${item.size}码:${item.taken}/${item.declared}`).join(','),
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
      { correlation, behaviorRecordId: draft.behavior_record_id, quantity: takenCount });
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

    // ⭐⭐ 2026-10-12：采购明细ID = `{报货批次号}-{两位序号}`（退货这条链路同样要写；
    //    与报货那条**同一个分配器** ⇒ 同一批次内 01/02… 不重排、不重号、重放不重复占号）。
    const detailIdCursor = await detailIds.open({ batchRecordId, batchNo: plan.batch_no });

    // ② 逐尺码：写一条退货明细（采购行为 = 退货行为）→ 扣库存（走 InventoryService）
    const requestIds = [];
    const drawItems = [];
    for (const item of plan.items) {
      if (item.taken <= 0) continue;
      const sizeRef = await resolveSize(item.size);
      // 幂等键由「这个任务 + 这个尺码」推出 ⇒ 重放命中同一条远端记录，不写第二条。
      const docKey = `purchase_return_doc:${taskId}:${item.size}`;
      const doc = await createOnceByKey({
        gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: docKey,
        label: `采购退货明细 ${taskId} ${item.size}码`,
        correlation,
        values: {
          batchNo: relation(batchRecordId),
          // 🔴 2026-10-12 热修（同一个 Lookup 列）：**不许再写「采购行为」** ——
          //    「采购明细.采购行为」已被她改成 **Lookup（只读，按「报货批次号」关联采购主表）**，
          //    写它轻则被忽略、重则整条退货明细 create 失败。
          //    ⚠️ 与报货那条同一个待定项：主表的「采购行为」没有写入点（她 2026-10-07 说过不用管）
          //    ⇒ 退货明细的这一列也会是空的，分流判据读不到就按现状=采购申请分流。
          product: relation(draft.product_record_id),
          size: relation(sizeRef.recordId),
          quantity: item.taken,
          // ⭐ 采购明细ID（`{报货批次号}-01`、`-02`…）
          detailId: detailIdCursor.next(),
          idempotencyKey: docKey,
        },
      });
      requestIds.push(doc.recordId);
      const change = await inventory.applyPurchaseReturn({
        productRecordId: draft.product_record_id,
        size: item.size,
        quantity: item.taken,
        // `state` 只用于本地串行队列的键；真正扣哪些状态由注册表（门盒 + 样品 + 仓库）决定。
        state: '门盒',
        purchaseBatchRecordId: batchRecordId,
        purchaseBatchNo: plan.batch_no,
        returnTaskId: taskId,
      }, { correlation });
      logInfo(events.returnStockApplied, {
        task_id: taskId, batch_no: plan.batch_no, size: item.size, quantity: item.taken,
        doc_id: doc.recordId, reused_doc: doc.reused === true,
        ledger_record_id: change?.ledgerRecordId || '',
        live_record_ids: change?.liveRecordIds || [],
        ...correlation,
      });
      drawItems.push({
        product_record_id: draft.product_record_id,
        product_number: draft.product_number,
        item_no: draft.item_no,
        color: draft.color,
        size: item.size,
        quantity: item.taken,
        supplier_record_id: draft.supplier_record_id,
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
