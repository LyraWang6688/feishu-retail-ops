const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService, MOVEMENT_SALE_DECREASE } = require('./inventoryService');
const { SalesProgressService } = require('./salesProgressService');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { postedOf, isPosted, SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { logError, logInfo } = require('../utils/logger');

class SalesDeliveryService {
  constructor({ gateway, inventory, progress, sizeReferences, status } = {}) {
    if (!gateway) throw new Error('SalesDeliveryService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.progress = progress || new SalesProgressService({ gateway });
    // 「库存状态」的写入口（名字与取值都在 config/salesStatusDimensions）。
    this.status = status || new SalesStatusWriter({ gateway });
    // 「尺码」是关联字段：走共享服务解析，不靠关联单元格自带的显示文本。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences });
    this.queue = Promise.resolve();
  }

  deliver(input) {
    const next = this.queue.then(() => this._deliver(input), () => this._deliver(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _deliver({ salesEntryRecordId, detailRecordIds, paymentRecordIds = [], occurredAt } = {}) {
    if (!salesEntryRecordId) throw new Error('交付缺少销售主表 record_id');
    if (!Array.isArray(detailRecordIds) || !detailRecordIds.length) throw new Error('请选择交付的销售明细');
    if (new Set(detailRecordIds).size !== detailRecordIds.length) throw new Error('交付明细不能重复');
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'behavior', 'inventoryLedger', 'liveInventory']);
    const entry = await withSalesReadRetry(
      () => this.gateway.get('salesEntry', salesEntryRecordId), 'delivery_sale_entry',
    );
    if (!entry) throw new Error('销售主表记录不存在');
    const entryFields = this.gateway.table('salesEntry').fields;
    // 「已入账」的取值来源走配置：**只读「资金状态」**
    // （旧「确认状态（旧）」已被业务负责人整列删除，没有回退可言）。
    // ⭐ 判据 = 「账做完了没有」：**两代字面量都算**（她手工填的「已入账」/ 代码写的「已写入」），
    // 配置在 config/salesStatusDimensions（POSTED_VALUES），不在这里散落字符串。
    if (!isPosted(postedOf(entry, entryFields))) throw new Error('销售订单尚未确认入账');
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
    for (const [index, id] of detailRecordIds.entries()) {
      const detail = byId.get(id);
      const quantity = 1;
      const productIds = linkedRecordIds(detail.fields?.[fields.product]);
      // 放在 try 外面：失败分支要把它记进 failures，解析失败时它是 null。
      let size = null;
      try {
        const status = textValue(detail.fields?.[fields.fulfillmentStatus]) || '未交付';
        if (!['未交付', '已交付'].includes(status)) throw new Error(`销售明细 ${id} 履约状态无效：${status}`);
        if (status === '已交付') {
          const inventoryResult = await this.inventory.getSaleResult?.(id);
          results.push({ detailRecordId: id, duplicate: true, inventoryResult });
          continue;
        }
        // 先判交付状态再解析尺码：配品不参与交付（写单时就是已交付），
        // 也不会走到这里；万一走到，下面的货品校验会把它拦下来。
        size = (await this.getSizeReferences().resolveLinkedCell(detail.fields?.[fields.size])).size;
        if (productIds.length !== 1) throw new Error(`销售明细 ${id} 必须关联一个货品`);
        const inventoryResult = await this.inventory.applySale({
          salesDetailRecordId: id, productRecordId: productIds[0],
          size, quantity, occurredAt: Number(occurredAt || Date.now()),
        });
        await this.gateway.update('salesDetail', id, { fulfillmentStatus: '已交付' });
        detail.fields[fields.fulfillmentStatus] = '已交付';
        results.push({ detailRecordId: id, inventoryResult });
      } catch (error) {
        failures.push({ detailRecordId: id, lineNumber: index + 1,
          productRecordId: productIds[0] || '', size, quantity, error: error.message });
        logError('sales.delivery.line.failed', { sales_entry_record_id: salesEntryRecordId,
          detail_record_id: id, line_number: index + 1, product_record_id: productIds[0],
          size, quantity, error: error.message });
      }
    }
    // 「库存状态」：扣减这一步的结果（**逐条**看，不是看"整单成功/失败"）。
    //   · 全成 → 已扣减   · 有的成有的败 → 部分扣减   · 一条都没成 → 扣减失败
    // ⚠️ `results` 里包含"这条明细本来就是已交付"的重复项：那一步的库存**已经扣过了**，
    //    算成功；否则重试一次正常的交付会把状态写成"部分扣减"。
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
    await this.status.write(salesEntryRecordId, { stock: stockStatus });
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
      failed_detail_count: failures.length,
      live_record_ids: results.flatMap((item) => item.inventoryResult?.liveRecordIds || []),
      sample_consumed_detail_ids: sampleReplacements.map((item) => item.salesDetailRecordId),
      stock_status: stockStatus,
    });
    const details = [...byId.values()];
    const deliveredTotal = details.filter((detail) =>
      textValue(detail.fields?.[fields.fulfillmentStatus]) === '已交付').length;
    const total = details.length;
    const progress = await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
    logInfo('sales.delivery.completed', { sales_entry_record_id: salesEntryRecordId,
      detail_count: results.length, failed_count: failures.length,
      delivered_quantity: deliveredTotal, fulfillment_status: progress.fulfillmentStatus });
    return { salesEntryRecordId, results, failures, deliveredQuantity: deliveredTotal,
      totalQuantity: total, fulfillmentStatus: progress.fulfillmentStatus, sampleReplacements };
  }
}

module.exports = { SalesDeliveryService };
