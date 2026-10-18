'use strict';

/**
 * 采购「到货确认」（写「报货批次」实际数量/金额 ＋ 加库存）—— 2026-10-18 从
 * `services/purchaseWebhookService.js` **原样搬出**（文件大小门禁，见 task-6）。
 * 幂等（本地草稿 `inventory_applied` ＋ 库存三元组）、顺序（先写批次行、再加库存）、
 * 批量/逐条回落口径**全部逐字保留**。
 *
 * ⚠️ mixin：`this` = `PurchaseWebhookService` 实例（facade 保留同名薄委托方法）。
 */
const { arrivalToast, inventoryToast } = require('../../config/purchaseWebhookTexts');
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { invalidatePendingBatchesCache } = require('../purchasePendingBatchService');
const { logInfo, logWarn } = require('../../utils/logger');
const { purchaseCorrelation } = require('./correlation');

const aggregateArrivalItems = (items) => {
  const byKey = new Map();
  for (const item of items) {
    const size = Number(item.size);
    const quantity = Number(item.quantity);
    // ⚠️ 新品在建档之前还没有 product_record_id（建档排在确认之后/新流程的编排里），
    // 所以这一步身份要退回「货号+颜色」——**不能**退回空串：
    // 两个不同新品都会落到空 key 上，被错当成同一条明细合并（尺码一样时数量翻倍，
    // 入库会跟着错）。老货品仍然用 product_record_id 聚合，行为不变。
    const identity = item.product_record_id || `pending:${textValue(item.item_no)}|${textValue(item.color)}`;
    if (identity === 'pending:|' || !Number.isInteger(size) || size <= 0 ||
      !Number.isInteger(quantity) || quantity <= 0) throw new Error('到货明细的货品、尺码或数量无效');
    const key = `${identity}|${size}`;
    if (byKey.has(key)) byKey.get(key).quantity += quantity;
    else byKey.set(key, { ...item, size, quantity });
  }
  return [...byKey.values()];
};

const arrival = {
  /**
   * 决定采购入库的库存状态：
   * - 如果该编号（货号）下完全没有样品库存（不管哪个尺码），则先作为样品入库
   * - 如果该编号下已有任意尺码的样品库存，则作为门盒入库
   * 这和销售相反（销售先卖门盒，再卖样品）
   */
  async resolvePurchaseInboundState(productRecordId) {
    try {
      // 查询该编号下所有尺码的样品库存记录（不指定尺码）
      const allLiveRecords = await this.gateway.listAll('liveInventory');
      const table = this.gateway.table('liveInventory');
      const sampleRecords = allLiveRecords.filter((record) => {
        // 使用 linkedRecordIds 处理关联字段，兼容飞书API返回的多种格式
        const productIds = linkedRecordIds(record.fields?.[table.fields.product]);
        // 单选字段可能返回字符串或数组，统一处理
        const stateValue = record.fields?.[table.fields.state];
        const state = Array.isArray(stateValue) ? stateValue[0] : stateValue;
        return productIds.includes(productRecordId) && String(state) === '样品';
      });
      return sampleRecords.length === 0 ? '样品' : '门盒';
    } catch (error) {
      logWarn('purchase.inbound.state_check.failed', { product_record_id: productRecordId, error: error.message });
      return '门盒'; // 查询失败时默认入门盒
    }
  },

  /** 真正的入库实现：只由 confirmArrival 串行调用，不要直接调（会丢掉串行保证）。 */
  async confirmArrivalLocked(taskId, task, operatorOpenId, options = {}) {
    // ⚠️ 2026-10-07 晚：这句话原先写「到货验收已入库」，但那**张表已被业务负责人删除** ——
    //    改成按现在的落点说（批次行），她看到的就是"这一批已经入过库了"。
    if (task.status === 'posted') return { toast: { type: 'info', content: arrivalToast.m1 } };
    // 用**最新**草稿（其它步骤可能刚更新过它）。
    const latest = (await this.store.get(taskId)) || task;
    const draft = latest.draft || task.draft;
    // 关联键（只进日志）：到货核对任务自己的 task_id（`arrival_reconcile_…`，
    // **是另一套 task，如实照传真名**）＋ 批次号 ＋ **「报货批次」记录 id**。
    // ⚠️ 这条链路**拿不到**「信息填写」报单记录 id（到货任务里只存 request_ids）
    //    —— 拿不到就不传，不编。
    // ⚠️ 2026-10-07 晚：原来的 `purchase_arrival_record_id`（「到货验收」那条记录）
    //    随表一起没了来源 ⇒ 换成 `purchase_batch_record_id`（到货信息现在的落点）。
    const batchRecordId = String(draft.batch_record_id || '').trim();
    const batchNo = String(draft.batch_no || '').trim();
    const correlation = purchaseCorrelation({
      taskId, batchNo, batchRecordId,
    });
    const arrival = { ...draft, actual: draft.actual || [] };
    const unresolved = arrival.actual.filter((item) => !item.product_record_id);
    if (unresolved.length > 0) {
      // 走到这里说明明细对不上货品（数据异常；代码已不再自动建档）。
      // 宁可停下来告诉她，也不能把这几条静默丢掉、只入一部分库。
      throw new Error(`有 ${unresolved.length} 条到货明细没有对应货品（${unresolved
        .map((item) => `${item.item_no || ''}${item.color || ''}`).join('、')}）。`
        + '请先在工作台「货品上新」建好货品（或修正明细）后再确认入库');
    }
    // ⭐ 2026-10-07 晚：**先把结构化验收（实际数量 / 发生金额）落到「报货批次」那一行**，再逐条加库存。
    //    顺序与改动前一致（原来是在「到货验收」建行），只是落点换成了批次行；
    //    失败就**当场停下来**（一个字都不写库存）—— 到货信息没有落点，等于她这次确认没被记下来。
    // ⭐⭐ 2026-10-08：「实际数量」「发生金额」**搭同一次 update 一起写**（业务负责人批准的口径），
    //    两者都在草稿上、由到货核对那一步算好/校验好（本方法只"照草稿写，不重算"）：
    //      · `draft.actual_quantity` = 代码算出的实际到货数合计（与库存口径一致）；
    //      · `draft.actual_amount`   = 她在卡片表单里填的整批金额（提交时已校验必填/数字/非负）。
    await this.writeArrivalAcceptance({ taskId, batchNo, batchRecordId, draft, correlation });
    //    放在这里（而不是只在扫码页那一层）是因为**任何**确认路径都经过这个方法
    //    （扫码验收 / 工作台 / 群话题核对）—— 否则她会看到"刚验收完还在列表里"。
    //    ⚠️ 纯内存失效，不写任何表；失败也不许影响入库（所以吞掉异常只记 warn）。
    try {
      invalidatePendingBatchesCache();
    } catch (error) {
      logWarn('scan.accept.pending_cache.invalidate_failed', { task_id: taskId, error: error.message });
    }
    // ⭐ 2026-10-07 深夜：这里原本是"查「采购行为」→ `listAll('purchaseInbound')` 回查已写过的
    //    入库行 → 逐条 `create('purchaseInbound')`"，**整段随那张表一起删除**（她整表删了它）。
    //    现在这个循环只做一件事：把**实际数**逐条交给库存（`inventory.applyPurchase`），
    //    并把"这一条加过了"落进本地草稿 —— 那张表一个字段都不再有写入点。
    if (!this.inflightInventory.has(taskId)) this.inflightInventory.set(taskId, new Map());
    const inflightMap = this.inflightInventory.get(taskId);
    // 进度落盘的键改叫 `inventory_applied`（不再有"入库行"这回事）。
    // ⚠️ **同时读旧的 `inbound_created`**：改动前那一版把 `{recordId, inventoryApplied}` 写在这个键里，
    //    部署那一刻正卡在半路的任务（状态 posting）不会因为改名而把已经加过的库存**再加一遍**。
    const normalizeEntry = (value) => (typeof value === 'string' ? { inventoryApplied: false } : (value || {}));
    const persistedApplied = {};
    const legacyApplied = { ...(draft.inbound_created || {}), ...(draft.inventory_applied || {}) };
    for (const [key, value] of Object.entries(legacyApplied)) {
      persistedApplied[key] = normalizeEntry(value);
    }
    const appliedByKey = new Map();
    for (const [key, value] of inflightMap) appliedByKey.set(key, value);
    for (const [key, value] of Object.entries(persistedApplied)) {
      if (!appliedByKey.has(key)) appliedByKey.set(key, value);
    }
    // 落盘基线跟着最新草稿走：用旧对象整份覆盖会把别的步骤刚写进去的字段冲掉。
    let draftNow = { ...draft };
    const persistEntry = async (key, entry) => {
      inflightMap.set(key, entry);
      persistedApplied[key] = entry;
      try {
        draftNow = { ...draftNow, inventory_applied: persistedApplied };
        const updated = await this.store.update(taskId, { draft: draftNow });
        draftNow = updated?.draft || draftNow;
      } catch (error) {
        logWarn('purchase.arrival.inventory_applied.persist_failed', { task_id: taskId, key, error: error.message });
      }
    };
    // 她点确认的这批里，哪些（货品+尺码）真的动过库存 —— 落进任务终态，也是日志里的正向证据。
    const inventoryAppliedKeys = [];
    // 来源标识（= 库存那一层的本地幂等键）= **真实三元组**：批次身份 | 货品 | 尺码。
    // ⚠️ 三样都是真值（批次记录 id / 批次号 / 到货核对任务 id ＋ 货品 record_id ＋ 尺码），
    //    **一个都不是编的**。
    // ⭐ 2026-10-08：`purchaseBatchRecordId` 现在有**两个去处** —— ① 参与上面这个本地三元组；
    //    ② 作为**远端关联值**写进「库存流水.关联采购」（该列已被她改成指向「报货批次」）。
    //    两者互不替代：拿不到批次 record id 时①会退回批次号/任务 id，而②**整列不写**。
    const batchIdentity = {
      purchaseBatchRecordId: batchRecordId,
      purchaseBatchNo: batchNo,
      arrivalTaskId: taskId,
    };
    // ⭐⭐ 2026-10-13（验收提速 ①）：这一段从"**逐条**读状态 + 逐条 `applyPurchase`"改成
    //   "**先把这一批算清**（状态每款只算一次）⇒ `applyPurchaseBatch` **一批一次写**"。
    //   真账：逐条 5 码 = **31 次**飞书（≈119.5 秒，占整批 83%）⇒ 批量后 = **1 次整表读 + 2 次批量写**。
    //   🔴 **语义一行不改**：
    //     · 幂等仍由 `appliedByKey`（本地草稿 `inventory_applied`）+ InventoryService 那两把键负责；
    //     · 顺序仍是"「报货批次」先写实（上面的 `writeArrivalAcceptance`）⇒ 再加库存"；
    //     · 库存串行队列改由 `applyPurchaseBatch` 内部的 `runForStocks` 按 `stock_key` 占住
    //       （跨任务同 key 不会被绕过，语义与逐条路径一致）。
    //   ⚠️ 注入的库存端口只有 `applyPurchase`（既有用例的替身）时**回落逐条** —— 真实用的
    //      `InventoryService` 一定有批量口；回落的唯一目的就是不让既有替身用例失真。
    const inboundEntries = [];
    for (const item of aggregateArrivalItems(arrival.actual || [])) {
      const key = `${item.product_record_id}|${item.size}`;
      const existing = appliedByKey.get(key);
      if (existing?.inventoryApplied) {
        inventoryAppliedKeys.push(key);
        continue;
      }
      if (!this.enablePurchaseInventory) {
        // 库存写入被显式关掉时（`enablePurchaseInventory: false`）：一个字都不写，只记进度。
        await persistEntry(key, { ...(existing || {}), inventoryApplied: false });
        continue;
      }
      inboundEntries.push({ item, key });
    }
    if (inboundEntries.length) {
      // 决定入库状态：没有样品则入样品库，有样品则入门盒库（口径与改动前逐字一致）。
      // ⚠️ 原来这条整表读在循环里**每条一次**（5 码 = 5 次）；同一款只算一次。
      // ⚠️ 口径与逐条路径**逐字一致**：`resolvePurchaseInboundState` = "这一款已有「样品」行 ⇒ 门盒，
      //    否则 ⇒ 样品"。逐条路径是**边写边判** ⇒ 同一款的第一双入样品之后，**后面几双看到那条样品行
      //    就都入门盒**。批量把写入挪到了后面 ⇒ 必须**本地推演**出同一串状态，否则同一款的第 2 双会被
      //    错判成样品（既有用例「每个货号第一双先入样品」抓到的就是这个）。
      //    ⇒ 每款仍只读一次（原来每码一次），第 2 双起按"已经有一双样品"推。
      const sampleSeenOf = new Map();
      const stateOfEntry = new Map();
      for (const entry of inboundEntries) {
        const productRecordId = entry.item.product_record_id;
        if (!sampleSeenOf.has(productRecordId)) {
          // eslint-disable-next-line no-await-in-loop
          const first = await this.resolvePurchaseInboundState(productRecordId);
          sampleSeenOf.set(productRecordId, first === '门盒');
        }
        const state = sampleSeenOf.get(productRecordId) ? '门盒' : '样品';
        stateOfEntry.set(entry, state);
        // 这一双落库之后，这一款就有「样品」行了 ⇒ 后面的都走门盒（与逐条路径的读写顺序等价）。
        sampleSeenOf.set(productRecordId, true);
      }
      const inboundPayload = inboundEntries.map((entry) => ({
        ...batchIdentity,
        productRecordId: entry.item.product_record_id,
        size: entry.item.size,
        quantity: entry.item.quantity,
        // ⚠️ 2026-10-06：不再传 occurredAt（只进本地任务记录、无人读）；
        // 时间交给飞书自动的「创建时间」。
        state: stateOfEntry.get(entry),
      }));
      if (typeof this.inventory.applyPurchaseBatch === 'function') {
        // ⭐ 批量路径：**整批一次写**（失败粒度 A）⇒ 这一批写成功后，才逐条落进度。
        await this.inventory.applyPurchaseBatch(inboundPayload, {
          correlation,
          // ⭐ 验收那一段自造的 timing（`finish()` 传下来）⇒ 由库存层填 `inventory_ms`。
          ...(options.timing ? { timing: options.timing } : {}),
        });
        for (const entry of inboundEntries) {
          // eslint-disable-next-line no-await-in-loop
          await persistEntry(entry.key, { ...(appliedByKey.get(entry.key) || {}), inventoryApplied: true });
          inventoryAppliedKeys.push(entry.key);
        }
      } else {
        // ⚠️ 回落路径（注入的替身只有 `applyPurchase`）：**每条写成功后立刻落进度** ——
        //    与改动前逐字一致（第 2 条失败时，第 1 条"已加过"必须已经落盘，重试才不重复加）。
        for (const [index, payload] of inboundPayload.entries()) {
          // eslint-disable-next-line no-await-in-loop
          await this.inventory.applyPurchase(payload, { correlation });
          const entry = inboundEntries[index];
          // eslint-disable-next-line no-await-in-loop
          await persistEntry(entry.key, { ...(appliedByKey.get(entry.key) || {}), inventoryApplied: true });
          inventoryAppliedKeys.push(entry.key);
        }
      }
    }
    // ⚠️ 2026-10-06：这里原先有一段**回写「报货信息」（采购申请表）**的代码——
    //   for (const request of arrival.requests) { … gateway.update('purchaseRequest', request.record_id,
    //     { arrivalStatus: status }) }   // 未到货 / 部分到货 / 全部到货 / 超额到货
    // 业务负责人当天的口径是：「**既然它就是采购申请，那个表就不要动**」
    //「我们要做的就是**基于采购申请表，再加上用户说的差异来进行实际入库**」。
    // 所以她删掉了这段回写：**采购申请表一个字都不改**（到货差异只体现在
    //「库存流水」/「实时库存」上）。
    // 这条口径由 `server/test/arrivalConversation.test.js` 的断言钉住：入库全过程
    // 对 `purchaseRequest` 表**零写入**（不是"看起来没写"，而是拿记录型 gateway 断言）。
    //
    // ⚠️ 也刻意**不再**把差异算成「超额到货 / 部分到货」这种状态：新口径下
    // 那个状态无处可写，算出来只会变成一个没人用的中间变量。
    //
    // 到这为止，一次到货确认只写两张表：**「报货批次」那一行**（实际数量 / 发生金额）
    // ＋ **「库存流水」「实时库存」**（由 InventoryService 写）。
    //
    // ⭐ 2026-10-07 晚：这一步原来是
    //   `gateway.update('purchaseArrival', arrival.arrival_record_id, { confirmStatus: '已确认' })`
    //   ——那张表已被她删除。现在写的是**「报货批次」那一行**的「确认状态」，
    //   取值来自 `config/purchaseAcceptance.js`（不写死中文字面量；该列现在是单选，
    //   取值由部署闸门的单选取值契约盯住）。
    // ⛔ 2026-10-09：这里原有「入库之后把这一批的『确认状态』改成『已确认』」那一段
    //   （`orderBatches.markConfirmed`）——**整段删除**：那一列在真表上已经没有了
    //   （业务负责人 2026-10-09 的只读核对：报货批次 12 列里没有「确认状态」）。
    //   ⚠️ 「到货状态 = 已到货」不在这里写（由对话链路的 `notifyBatchArrived` 负责），
    //      所以这一段的删除**没有**影响"这一批到货了没有"这个事实。
    // ⚠️ 终态里**不再有** `inbound_record_ids`（入库明细行不存在了）；改记"加过库存的（货品+尺码）"。
    await this.store.update(taskId, {
      status: 'posted', inventory_applied_keys: inventoryAppliedKeys,
    });
    this.inflightInventory.delete(taskId);
    logInfo('purchase.arrival.posted', {
      task_id: taskId, batch_record_id: batchRecordId, batch_no: batchNo,
      // 正向证据：这次确认到底给几条（货品+尺码）加了库存，以及**没有**写任何入库明细行。
      inventory_applied_count: inventoryAppliedKeys.length,
      inbound_rows_written: 0,
      inventory_applied: this.enablePurchaseInventory, ...correlation,
    });
    return { toast: { type: 'success', content: this.enablePurchaseInventory ? inventoryToast.m1 : inventoryToast.m2 } };
  },

  /**
   * ⭐ **结构化验收结果**→「报货批次」那一行（2026-10-07 晚的到货落点）。
   *
   * ⭐⭐ 2026-10-08：**同一次 update** 里写「实际数量」「发生金额」两列（业务负责人批准）——
   *   值来自草稿（`draft.actual_quantity` / `draft.actual_amount`），本方法**不重算**：
   *   算/校验是到货核对那一步的职责（`PurchaseArrivalConversationService.confirmLocked`）。
   *   ⚠️ 拿不到（`undefined`）时**那一列不写**（不写空值）—— 由 `writeAcceptance` 判，
   *      这样既有的"孤儿草稿"路径行为逐字不变。
   *   ⛔ **2026-10-09**：原先还写「到货文字说明（该列已从真表退场）」——那一列在真表上已经没有了，**写入点删除**
   *      （`draft.acceptance_text` 仍留在本地草稿里，它是解析实际到货情况的输入）。
   *
   * 三条边界（都在测试里钉住）：
   *   · **没有批次身份**（`batchNo` 与 `batchRecordId` 都空）→ 只记 warn、**不阻塞**：
   *     这是"孤儿调用"（历史草稿 / 手工种的测试任务）的形状，入库能力本身不该被它挡住。
   *   · 有批次身份但**批次行找不到** → **抛错**：她这次确认的到货信息没有落点，
   *     宁可当场告诉她，也不入库了却没有记录。
   *   · **绝对不写**「到货日」「验收人」：它们在真表上是飞书自动字段
   *     （更新时间 / 创建人），写了会被自动覆盖或直接报错。
   */
  async writeArrivalAcceptance({ taskId, batchNo, batchRecordId, draft, correlation }) {
    if (!batchNo && !batchRecordId) {
      logWarn('purchase.arrival.acceptance.skipped', {
        task_id: taskId, reason: 'no_batch_identity',
        hint: '草稿上没有批次号也没有批次记录 id（孤儿调用）→ 不写到货信息，也不阻塞入库',
      });
      return { updated: false, reason: 'no_batch_identity' };
    }
    const result = await this.orderBatches.writeAcceptance({
      batchNo,
      batchRecordId,
      // ⭐⭐ 2026-10-08：草稿上那两个值原样传下去（`undefined` = 这一列不写）。
      actualQuantity: draft?.actual_quantity,
      actualAmount: draft?.actual_amount,
      correlation,
    });
    if (!result.updated) {
      throw new Error(`这一批在采购单里找不到（${batchNo || batchRecordId}），到货信息没地方落，先不入库`);
    }
    return result;
  },
};

module.exports = arrival;
