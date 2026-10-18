const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService, MOVEMENT_SALE_DECREASE } = require('./inventoryService');
// ⭐ 2026-10-11（B）：配品行要**显式识别并跳过**（它没有鞋 ⇒ 不参与交付 / 库存扣减）。
//    判据是**可售品属性**（`tracksInventory`），不是"配品"这两个字。
const { SELLABLE_KINDS } = require('../config/sellableKinds');
const { itemLinkOfDetail } = require('./salesDetailItemFacts');
const { SalesProgressService } = require('./salesProgressService');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { postedOf, isPosted, SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { mergeCorrelation } = require('../utils/correlationFields');

class SalesDeliveryService {
  constructor({ gateway, inventory, progress, sizeReferences, status } = {}) {
    if (!gateway) throw new Error('SalesDeliveryService requires gateway');
    this.gateway = gateway;
    // 「库存状态」的写入口（名字与取值都在 config/salesStatusDimensions）。
    this.status = status || new SalesStatusWriter({ gateway });
    // 「尺码」是关联字段：走共享服务解析，不靠关联单元格自带的显示文本。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences });
    /**
     * ⭐ 2026-10-16（性能）：**库存引擎共用同一份「尺码」解析**（同一份缓存）。
     *
     * 改前：`InventoryService` 没拿到 `sizeReferences` ⇒ 它**自己 new 一个**
     *   `SizeReferenceService` ⇒ 与上面那份**各读一次**「尺码管理」小表
     *   （订单列表实测：`sizeManagement` 一次请求读两遍）。
     * 改后：把**同一个访问器**交给它 ⇒ 同一个尺码快照，读表次数去重，
     *   解析出来的取值**必然一致**（本来就是同一张表、同一列）。
     * 🔴 **不改判据**：`SizeReferenceService` 的 TTL / single-flight / 抛错口径一个字没动。
     * ⚠️ 只在**没有显式注入** `inventory` 时接线（用例自己给的那份自己负责）。
     */
    this.inventory = inventory || new InventoryService({ gateway, sizeReferences: this.getSizeReferences() });
    this.progress = progress || new SalesProgressService({ gateway });
    this.queue = Promise.resolve();
  }

  // 关联键走**尾部可选参数**（`options.correlation`），不塞进 `input`（同 SalesOrderService）。
  deliver(input, options = {}) {
    const next = this.queue.then(() => this._deliver(input, options), () => this._deliver(input, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _deliver({ salesEntryRecordId, detailRecordIds, paymentRecordIds = [], occurredAt,
    // ⭐⭐ 2026-10-16（业务负责人 22:0x 逐字：「**啥叫钱没入账就不许出库存？不用呀。**」）：
    //    **只给"货那一跑（货品页建单）"开这道口子** ✓ —— 显式布尔 · **缺省 false** ✓
    //    ⇒ 其它调用方（资金页 / 工作台 / 二次交付）**行为一字不变** ✗。
    allowUnposted = false } = {},
    options = {}) {
    if (!salesEntryRecordId) throw new Error('交付缺少销售主表 record_id');
    if (!Array.isArray(detailRecordIds) || !detailRecordIds.length) throw new Error('请选择交付的销售明细');
    if (new Set(detailRecordIds).size !== detailRecordIds.length) throw new Error('交付明细不能重复');
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'behavior', 'inventoryLedger', 'liveInventory']);
    // ⭐ 关联键：交付这一段写的正是「销售明细.履约状态 / 库存流水 / 实时库存 / 库存状态」——
    //    "一条销售被劈成两半"里看不见的那半（2026-10-07 业务负责人拍板「日志改下吧！」）。
    //    它**只进日志**，不改任何写入内容、不改顺序。
    let correlation = mergeCorrelation(options.correlation, { sales_entry_record_id: salesEntryRecordId });
    const entry = await withSalesReadRetry(
      () => this.gateway.get('salesEntry', salesEntryRecordId), 'delivery_sale_entry',
    );
    if (!entry) throw new Error('销售主表记录不存在');
    const entryFields = this.gateway.table('salesEntry').fields;
    // 单号就在这条**已经读到的**主表记录上 ⇒ 零额外请求地补进关联键。
    correlation = mergeCorrelation(correlation, { order_no: textValue(entry?.fields?.[entryFields.orderNo]) });
    // 「已入账」的取值来源走配置：**只读「资金状态」**
    // （旧「确认状态（旧）」已被业务负责人整列删除，没有回退可言）。
    // ⭐ 判据 = 「账做完了没有」：**两代字面量都算**（她手工填的「已入账」/ 代码写的「已写入」），
    // 配置在 config/salesStatusDimensions（POSTED_VALUES），不在这里散落字符串。
    // ⭐ 2026-10-16：**货与钱是两条独立的线**（她：「货就是货，资金就是资金，它俩是独立的呀」）
    //    ⇒ 货那一跑（`allowUnposted: true`，**只在 `fundsDeferred === true` 时由冻结件传** ✓）
    //      允许在资金状态尚未写入时交付 ✓；**其它调用方照旧** ✓。
    if (!allowUnposted && !isPosted(postedOf(entry, entryFields))) throw new Error('销售订单尚未确认入账');
    const fields = this.gateway.table('salesDetail').fields;
    const listedDetails = (await withSalesReadRetry(
      () => this.gateway.listAll('salesDetail'), 'delivery_detail_list',
    )).filter((record) =>
      linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId));
    const byId = new Map(listedDetails.map((record) => [record.record_id, record]));
    for (const id of detailRecordIds) {
      // The caller has exact IDs from creation. Do not depend on a freshly
      // created relation already appearing in Bitable's list response.
      const detail = await withSalesReadRetry(
        () => readSaleLinkedRecord(this.gateway, 'salesDetail', id,
          fields.salesEntry, salesEntryRecordId), 'delivery_detail_by_id',
      );
      byId.set(id, detail);
    }
    const results = [];
    const failures = [];
    // ⭐ 2026-10-18（提速 · 第 4 步）：**库存扣减一次性批量**（`InventoryService.applySaleBatch`）。
    //   改前逐字：每一条明细一次 `inventory.applySale` ⇒ 每条要敲一次整表读 ＋ `create`（流水）
    //     ＋ 一次 `get`（删之前确认）＋ 一次 `delete`（扣那一双）⇒ N 条 = 4N 次以上飞书请求。
    //   改后：整批 1 次整表读 ＋ 1 次 `createBatch`（流水）＋ 1 次 `getBatch` ＋ 1 次 `deleteBatch`。
    //   🔴 **逐条的部分失败语义一个字不动**：
    //     · 前置校验（跳过配品 / 重复交付 / 尺码解不出 / 货品关联不唯一）仍**逐行**判定；
    //     · 库存那一段的逐行失败（库存不足…）由批量口**按行**返回（`{ ok: false, error }`）；
    //     · 最后仍按**明细原顺序**汇总进 `results` / `failures` ⇒ `stockStatus` /
    //       `sampleReplacements` / `sales.inventory.applied` 的判据与日志字段全部不变。
    //   ⚠️ 库存服务**没有**批量口（既有单测里的替身就是 `{ applySale }`）⇒ 逐条，行为不变。
    const decisions = new Array(detailRecordIds.length).fill(null);
    const pendingLines = [];
    for (const [index, id] of detailRecordIds.entries()) {
      const detail = byId.get(id);
      const quantity = 1;
      const productIds = linkedRecordIds(detail.fields?.[fields.product]);
      // 放在 try 外面：失败分支要把它记进 failures，解析失败时它是 null。
      let size = null;
      try {
        const status = textValue(detail.fields?.[fields.fulfillmentStatus]) || '未交付';
        if (!['未交付', '已交付'].includes(status)) throw new Error(`销售明细 ${id} 履约状态无效：${status}`);
        // ⭐ 2026-10-11（B）：**配品行显式跳过** —— 它没有鞋，不参与交付、更不参与库存扣减
        //    （业务负责人 2026-10-09：「这类"配品行"不参与待交付 / 库存扣减」）。
        //    ⚠️ 判据是**可售品属性**（`config/sellableKinds` 的 `tracksInventory`），
        //       不是"因为它碰巧是已交付" ⇒ 所以**先判**这一支，并**如实**标成 skipped 返回。
        //       （放在「已交付」那一支之后的话，配品行会被当成"重复交付"混过去 ——
        //        一旦有人把它写成未交付，它就会掉进货品校验里报错，而不是被认出来"本来就不该交付"。）
        const link = itemLinkOfDetail(detail.fields, fields);
        const kind = link ? SELLABLE_KINDS[link.kindKey] : null;
        if (kind && !kind.tracksInventory) {
          decisions[index] = { kind: 'skipped' };
          continue;
        }
        if (status === '已交付') {
          decisions[index] = { kind: 'duplicate', inventoryResult: await this.inventory.getSaleResult?.(id) };
          continue;
        }
        size = (await this.getSizeReferences().resolveLinkedCell(detail.fields?.[fields.size])).size;
        if (productIds.length !== 1) throw new Error(`销售明细 ${id} 必须关联一个货品`);
        const line = { index, lineNumber: index + 1, detailRecordId: id, productRecordId: productIds[0],
          size, quantity, salesEntryRecordId, occurredAt: Number(occurredAt || Date.now()) };
        decisions[index] = { kind: 'pending', line };
        pendingLines.push(line);
      } catch (error) {
        decisions[index] = { kind: 'failed',
          entry: { detailRecordId: id, lineNumber: index + 1, productRecordId: productIds[0] || '',
            size, quantity, error: error.message } };
      }
    }
    // 库存扣减：一次批量（没有批量口 / 批量写失败 ⇒ 逐条回落，见 `_applySalesInventory`）。
    const outcomes = await this._applySalesInventory(pendingLines, correlation);
    const outcomeByDetail = new Map(pendingLines.map((line, position) => [line.detailRecordId, outcomes[position]]));
    const recordFailure = (entry) => {
      failures.push(entry);
      logError('sales.delivery.line.failed', { sales_entry_record_id: salesEntryRecordId,
        detail_record_id: entry.detailRecordId, line_number: entry.lineNumber,
        product_record_id: entry.productRecordId, size: entry.size, quantity: entry.quantity,
        error: entry.error, ...correlation });
    };
    // 按**明细原顺序**汇总 ⇒ results / failures 的次序与改动前逐条路径一致。
    for (const [index, id] of detailRecordIds.entries()) {
      const detail = byId.get(id);
      const decision = decisions[index];
      if (decision.kind === 'skipped') {
        results.push({ detailRecordId: id, skipped: true, reason: 'not_tracked_kind' });
        continue;
      }
      if (decision.kind === 'duplicate') {
        results.push({ detailRecordId: id, duplicate: true, inventoryResult: decision.inventoryResult });
        continue;
      }
      if (decision.kind === 'failed') {
        recordFailure(decision.entry);
        continue;
      }
      const { line } = decision;
      const outcome = outcomeByDetail.get(line.detailRecordId);
      if (!outcome || !outcome.ok) {
        // 库存那一段这一条没成（库存不足 / 内容与首次提交不一致 / 批量写失败后逐条也没救回来…）：
        // 如实记进 failures（**带上 reason**），其余明细照旧 —— 部分失败语义不变。
        // ⚠️ 兜底那一句用**英文键**：这是"库存服务没按约定返回 ok/error"的内部错误（正常不可达），
        //    不引入新的硬编码中文（`test/noHardcodedChinese`）。
        recordFailure({ detailRecordId: id, lineNumber: line.lineNumber,
          productRecordId: line.productRecordId, size: line.size, quantity: line.quantity,
          error: String(outcome?.error?.message || outcome?.error || 'inventory_deduction_failed') });
        continue;
      }
      try {
        await this.gateway.update('salesDetail', id, { fulfillmentStatus: '已交付' }, { correlation });
        detail.fields[fields.fulfillmentStatus] = '已交付';
        results.push({ detailRecordId: id, inventoryResult: outcome.result });
      } catch (error) {
        recordFailure({ detailRecordId: id, lineNumber: line.lineNumber,
          productRecordId: line.productRecordId, size: line.size, quantity: line.quantity,
          error: error.message });
      }
    }
    // 「库存状态」：扣减这一步的结果（**逐条**看，不是看"整单成功/失败"）。
    //   · 全成 → 已写入   · 有的成有的败 → 部分写入   · 一条都没成 → 写入失败
    // ⚠️ 取值就是 `config/salesStatusDimensions.SALES_STATUS_WRITE_VALUES.stock` 里那四个
    //    （**不是**"已扣减 / 部分扣减 / 扣减失败" —— 那串说法只是描述这件事，别照着写值）。
    // ⚠️ `results` 里包含"这条明细本来就是已交付"的重复项：那一步的库存**已经扣过了**，
    //    算成功；否则重试一次正常的交付会把状态写成"部分写入"。
    // ⚠️ 配品行（skipped）既不算成功也不算失败：它本来就不该扣库存（见上面那一支）。
    const stockStatus = failures.length === 0 ? WRITE.stock.done
      : results.length > 0 ? WRITE.stock.partial : WRITE.stock.failed;
    // 补样品候选：与下面那条「正向证据」用**同一个筛选口径**，所以只在这里算一次。
    // ⚠️ 只是把纯计算往前挪了一格，**没有改任何写入顺序**。
    const sampleReplacements = results.filter((item) => item.inventoryResult?.sampleConsumedQuantity > 0)
      .map((item) => ({ salesDetailRecordId: item.detailRecordId,
        productRecordId: item.inventoryResult.productRecordId,
        sampleConsumedQuantity: item.inventoryResult.sampleConsumedQuantity,
        consumedLiveRecordIds: item.inventoryResult.consumedLiveRecordIds || [],
        remainingSizes: item.inventoryResult.remainingSizes || [] }));
    await this.status.write(salesEntryRecordId, { stock: stockStatus }, correlation);
    // ⭐ 正向证据：**这一单的库存真的动完了** —— 回答"到底扣没扣库存"该看的就是这一条。
    // 与逐条的 `inventory.change.applied`（库存引擎在说"这一条流水写了"）互补：
    // 这条是**销售交付这一步**在说"该扣的都扣完了 ＋ 扣的是哪几条流水"。
    // ⚠️ 覆盖范围：**只覆盖销售出库（销售减少）这一条库存路径** —— 也就是本函数
    //    "逐条写库存流水 + 写「库存状态」"这一段。卖了样品而触发的**补样品（门盒转样品）**
    //    由 `SampleReplacementService` → `InventoryService.promoteToSample` 在**之后**执行
    //    （同一次确认里紧接着补掉，或之后由补选卡片补），它的证据是
    //    `inventory.sample.promoted`（带 ledger_record_id），**不在本事件里**；
    //    本事件用 `sample_consumed_detail_ids` 指出"这一单还有哪几条要补样品"。
    // ⚠️⚠️ 读法（正是这条日志要防的那种误读）：`ledger_ids` 为空**不等于**"没扣库存"——
    //    再看 `already_delivered_detail_count`（这几条**之前就交付过、库存早扣了**，
    //    这次没产生新流水）；真的没扣成的看 `failed_detail_count`。
    const ledgerIds = results.map((item) => item.inventoryResult?.ledgerRecordId).filter(Boolean);
    logInfo('sales.inventory.applied', {
      sales_entry_record_id: salesEntryRecordId,
      ledger_ids: ledgerIds,
      // 行为写**编码**（不是中文名）：中文名在「行为管理」表里维护，代码里再抄一份会漂移；
      // 编码是契约（见 InventoryService 的 STOCK_MOVEMENTS）。
      behaviors: ledgerIds.length ? [MOVEMENT_SALE_DECREASE] : [],
      // 本次真的写了库存流水的明细条数（= ledger_ids 的条数）。
      applied_detail_count: ledgerIds.length,
      // 这次跳过、但「履约状态」本来就是已交付的明细 —— 那些库存**早就扣过了**。
      already_delivered_detail_count: results.filter((item) => item.duplicate).length,
      // ⭐ 配品行（不跟踪库存的可售品）：**识别并跳过**的条数（它们本来就不该扣库存）。
      skipped_detail_count: results.filter((item) => item.skipped).length,
      failed_detail_count: failures.length,
      live_record_ids: results.flatMap((item) => item.inventoryResult?.liveRecordIds || []),
      sample_consumed_detail_ids: sampleReplacements.map((item) => item.salesDetailRecordId),
      stock_status: stockStatus,
      ...correlation,
    });
    const details = [...byId.values()];
    const deliveredTotal = details.filter((detail) =>
      textValue(detail.fields?.[fields.fulfillmentStatus]) === '已交付').length;
    const total = details.length;
    const progress = await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
    logInfo('sales.delivery.completed', { sales_entry_record_id: salesEntryRecordId,
      detail_count: results.length, failed_count: failures.length,
      delivered_quantity: deliveredTotal, fulfillment_status: progress.fulfillmentStatus,
      ...correlation });
    return { salesEntryRecordId, results, failures, deliveredQuantity: deliveredTotal,
      totalQuantity: total, fulfillmentStatus: progress.fulfillmentStatus, sampleReplacements };
  }

  /**
   * ⭐ 2026-10-18（提速 · 第 4 步）：把"这几条明细的库存扣减"交给库存引擎的**批量口**。
   *
   * 为什么单独抽一个方法：`_deliver` 里那段已经够长，而"批量 / 回落"这条分叉只该有一个实现。
   * 回落口径与 `purchaseWebhookService`（验收）／`purchaseReturnService`（退货）**同一手法**：
   *   · 库存服务**没有** `applySaleBatch`（既有单测里的替身就是 `{ applySale }`）⇒ **逐条**，
   *     与改动前**逐字节同形**（顺序、入参、失败粒度都相同）；
   *   · 批量口**抛**（批量写整批失败，例：`createBatch` / `deleteBatch` 抛）⇒ **退回逐条**：
   *     那几次已经落了本地 journal（`prepared` / `ledger_created`）⇒ 逐条那次按**同一把键续跑**，
   *     **不重复扣**；某一条真的不行就只让那一条失败 —— 部分失败语义因此不打折、
   *     也不静默（每条失败都带着库存引擎自己那句 reason 返回）。
   *
   * ⚠️ 返回**与入参同序**：`[{ ok: true, result } | { ok: false, error }]`。
   * @param {Array<{detailRecordId:string, salesEntryRecordId:string, productRecordId:string,
   *   size:number, quantity:number, occurredAt:number}>} lines
   * @returns {Promise<Array<{ok:boolean, result?:object, error?:Error}>>}
   */
  async _applySalesInventory(lines, correlation) {
    if (!Array.isArray(lines) || !lines.length) return [];
    const payloads = lines.map((line) => ({
      salesDetailRecordId: line.detailRecordId,
      salesEntryRecordId: line.salesEntryRecordId,
      productRecordId: line.productRecordId,
      size: line.size,
      quantity: line.quantity,
      occurredAt: line.occurredAt,
    }));
    const perLine = async () => {
      const outcomes = [];
      for (const payload of payloads) {
        try {
          outcomes.push({ ok: true, result: await this.inventory.applySale(payload, { correlation }) });
        } catch (error) {
          outcomes.push({ ok: false, error });
        }
      }
      return outcomes;
    };
    // 没有批量口（替身 / 未接线）或没有逐条口（不该发生）⇒ 逐条，行为与改动前逐字相同。
    if (typeof this.inventory.applySaleBatch !== 'function'
      || typeof this.inventory.applySale !== 'function') return perLine();
    try {
      return await this.inventory.applySaleBatch(payloads, { correlation });
    } catch (error) {
      // ⚠️ 如实记一条：整批没能一次写完 ⇒ 退回逐条（不是"重试"，是"换回改动前那条路"）。
      logWarn('sales.delivery.inventory_batch_fallback', {
        sales_entry_record_id: correlation?.sales_entry_record_id,
        detail_count: payloads.length,
        error: error?.message || String(error),
        ...correlation,
      });
      return perLine();
    }
  }
}

module.exports = { SalesDeliveryService };
