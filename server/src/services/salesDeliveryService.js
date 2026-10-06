const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService } = require('./inventoryService');
const { SalesProgressService } = require('./salesProgressService');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { SALES_STATUS_VALUES, fundsStatusOf } = require('../config/salesStatusDimensions');
const { SalesStatusService } = require('./salesStatusService');
const { logError, logInfo } = require('../utils/logger');

class SalesDeliveryService {
  constructor({ gateway, inventory, progress, sizeReferences, salesStatus } = {}) {
    if (!gateway) throw new Error('SalesDeliveryService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.progress = progress || new SalesProgressService({ gateway });
    // 四个状态维度的「达成情况」写入只有一处实现（见 services/salesStatusService）。
    this.salesStatus = salesStatus || new SalesStatusService({ gateway });
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
    // 闸门：钱写进「收款明细」了没有。取值走配置（**单读**「资金状态」），判据是配置里的常量。
    if (fundsStatusOf(entry, entryFields) !== SALES_STATUS_VALUES.funds.WRITTEN) {
      throw new Error('销售订单尚未确认入账');
    }
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
    const details = [...byId.values()];
    const deliveredTotal = details.filter((detail) =>
      textValue(detail.fields?.[fields.fulfillmentStatus]) === '已交付').length;
    const total = details.length;
    // ④ 库存状态：扣完库存（+ 实时库存）之后。
    //    全成功 → 已扣减 · 部分是 → 部分扣减 · 全失败 → 扣减失败。
    //    ⚠️ 「已交付」的重复行（duplicate）算成功：那一行的库存早就扣过了。
    //    ⚠️ 用 markQuietly：货已经扣了，写不进这一列不该把交付判失败（失败会留 warn 日志）。
    const stockValue = failures.length === 0
      ? SALES_STATUS_VALUES.stock.DONE
      : (failures.length < detailRecordIds.length ? SALES_STATUS_VALUES.stock.PARTIAL : SALES_STATUS_VALUES.stock.FAILED);
    await this.salesStatus.markQuietly(salesEntryRecordId, 'stock', stockValue, {
      delivered_quantity: deliveredTotal, total_quantity: total, failed_count: failures.length,
    });
    const progress = await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
    logInfo('sales.delivery.completed', { sales_entry_record_id: salesEntryRecordId,
      detail_count: results.length, failed_count: failures.length,
      delivered_quantity: deliveredTotal, fulfillment_status: progress.fulfillmentStatus });
    const sampleReplacements = results.filter((item) => item.inventoryResult?.sampleConsumedQuantity > 0)
      .map((item) => ({ salesDetailRecordId: item.detailRecordId,
        productRecordId: item.inventoryResult.productRecordId,
        sampleConsumedQuantity: item.inventoryResult.sampleConsumedQuantity,
        consumedLiveRecordIds: item.inventoryResult.consumedLiveRecordIds || [],
        remainingSizes: item.inventoryResult.remainingSizes || [] }));
    return { salesEntryRecordId, results, failures, deliveredQuantity: deliveredTotal,
      totalQuantity: total, fulfillmentStatus: progress.fulfillmentStatus, sampleReplacements };
  }
}

module.exports = { SalesDeliveryService };
