const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { classifyReportBehavior, REPORT_BEHAVIOR } = require('./purchaseReportBehaviorPolicy');

const asText = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? textValue(record?.fields?.[fieldName]).trim() : '';
};

const asLinks = (tableKey, record, semanticKey) => {
  const fieldName = V1_BITABLE_SCHEMA.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? linkedRecordIds(record?.fields?.[fieldName]) : [];
};

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(textValue(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

// （原先这里有个 `asDate`，只被 `listPurchaseArrivals` 用来把「到货验收.到货日」转成 ISO。
//  2026-10-07 晚：那张表已被业务负责人删除、面板改读「报货批次」，而批次行上**没有**可投影的
//  到货时刻（「到货日」在真表上是自动的「更新时间」）⇒ 这个转换没有调用方了，随之删除，
//  不留死代码。）

const indexByRecordId = (records) => new Map(records.map((r) => [r.record_id, r]));

const createPurchaseQueryService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PurchaseQueryService requires gateway');
  // 查询结果里的尺码要还原成整数，仍走共享的尺码服务。
  const getSizeReferences = createSizeReferenceAccess({
    gateway, sizeReferences: options.sizeReferences,
  });

  const listPurchaseRequests = async (filters = {}) => {
    const [requests, products, batches, behaviors] = await Promise.all([
      gateway.listAll('purchaseRequest'),
      gateway.listAll('product'),
      gateway.listAll('purchaseOrderBatch'),
      // 「具体信息」的「采购行为」是关联「行为管理」：采购申请与采购退货写在同一张表里，
      // 靠这一列分流。分流口径复用采购链路的同一份策略（purchaseReportBehaviorPolicy），
      // 不在查询里另写一套判断——两套判断迟早在"什么算退货"上分家。
      gateway.listAll('behavior'),
    ]);
    const productMap = indexByRecordId(products);
    const batchMap = indexByRecordId(batches);
    const behaviorMap = indexByRecordId(behaviors);

    const rows = await Promise.all(requests.map(async (record) => {
      const productIds = asLinks('purchaseRequest', record, 'product');
      const product = productIds.length ? productMap.get(productIds[0]) : null;
      const batchIds = asLinks('purchaseRequest', record, 'batchNo');
      const batch = batchIds.length ? batchMap.get(batchIds[0]) : null;
      const batchNo = batch ? asText('purchaseOrderBatch', batch, 'batchNo') : '';
      const supplierIds = product ? asLinks('product', product, 'supplier') : [];
      const behaviorIds = asLinks('purchaseRequest', record, 'behavior');
      const behavior = behaviorIds.length ? behaviorMap.get(behaviorIds[0]) : null;
      const size = await getSizeReferences().resolveLinkedCell(
        record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.size]
      );
      return {
        record_id: record.record_id,
        batch_no: batchNo,
        product_number: product ? asText('product', product, 'number') : '',
        product_record_id: productIds[0] || '',
        size: size.size,
        quantity: asNumber(record?.fields?.[V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.quantity]),
        // ⚠️ 2026-10-07：到货状态**不再读「具体信息」**（那一列业务负责人已从生产表删掉），
        // 改读**「报货批次」**那一行上的同名语义键 —— 她的口径是
        // 「采购批次这个数据表主要控制的是该批次的到货情况」。
        // 批次行本来就已经解析出来了（`batch`），所以这是零额外请求的一次投影。
        arrival_status: batch ? asText('purchaseOrderBatch', batch, 'arrivalStatus') : '',
        supplier_record_id: supplierIds[0] || '',
        // 'purchase_request' | 'purchase_return'（读不到行为记录时按现状=采购申请）
        report_behavior: classifyReportBehavior({
          name: behavior ? asText('behavior', behavior, 'name') : '',
          code: behavior ? asText('behavior', behavior, 'code') : '',
        }),
        report_behavior_name: behavior ? asText('behavior', behavior, 'name') : '',
      };
    }));

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.arrivalStatus && row.arrival_status !== filters.arrivalStatus) return false;
      if (filters.reportBehavior && row.report_behavior !== filters.reportBehavior) return false;
      return true;
    }).sort((a, b) => String(b.batch_no).localeCompare(String(a.batch_no)) || a.size - b.size);
  };

  /**
   * 工作台「到货验收情况」面板的数据源。
   *
   * ⭐ 2026-10-07 晚（到货落点大改）：**改读「报货批次」**，不再读「到货验收」——
   *    那张表已被业务负责人**整个删除**（Base 里没有任何名字含「到货」/「验收」的表）。
   *    为什么是"改读"而不是"摘掉面板"：
   *      · 她要看的「这一批到货了没有、核对确认了没有、验收说的什么」正好就是
   *        「报货批次」那一行的三列，改读之后面板仍有信息量；
   *      · 摘掉面板等于把一个能用的视图删掉（而且工作台其它子页与它共享筛选/渲染代码）。
   *    投影口径：一行 = 「报货批次」的一条记录（原来是「到货验收」的一条记录）。
   *    字段名保持兼容（`batch_no` / `confirm_status` 等），前端只需换列。
   *
   * ⚠️ **不投影「到货日」「验收人」**：它们在真表上是飞书**自动字段**
   *   （到货日=更新时间、验收人=创建人），schema 里刻意没有映射；
   *   而且批次行的「更新时间」会被写附件等动作刷新，把它当"到货日"展示会误导。
   *   （同一条口径也钉在 `v1BitableSchema` 的注释里。）
   *
   * ⚠️ 过滤掉"没有任何到货信息"的行：**退货批次**只写 批次号 + 幂等键
   *   （业务负责人 2026-10-07 晚口径：退货**不写**「到货状态」），它既不进 9 点推送的
   *   「未到货」候选，也不该出现在"到货验收情况"里（否则一行空白，看着像数据丢了）。
   */
  const listPurchaseArrivals = async (filters = {}) => {
    const batches = await gateway.listAll('purchaseOrderBatch');

    const rows = (batches || []).map((record) => ({
      // `record_id` / `batch_record_id` 都是**批次记录 id**（到货信息的落点）。
      record_id: record.record_id,
      batch_record_id: record.record_id,
      batch_no: asText('purchaseOrderBatch', record, 'batchNo'),
      arrival_status: asText('purchaseOrderBatch', record, 'arrivalStatus'),
      confirm_status: asText('purchaseOrderBatch', record, 'confirmStatus'),
      acceptance_text: asText('purchaseOrderBatch', record, 'acceptanceText'),
      // 兼容字段（前端与既有调用方原先读它）：到货落点搬到批次行之后**没有**可投影的日期
      // —— 批次行上那个「到货日」是自动的「更新时间」，不是真的到货时刻（见方法注释）。
      arrival_at: null,
      supplier_record_id: '',
    })).filter((row) => row.arrival_status || row.confirm_status || row.acceptance_text);

    return rows.filter((row) => {
      if (filters.batchNo && row.batch_no !== filters.batchNo) return false;
      if (filters.confirmStatus && row.confirm_status !== filters.confirmStatus) return false;
      if (filters.arrivalStatus && row.arrival_status !== filters.arrivalStatus) return false;
      return true;
    }).sort((a, b) => String(b.batch_no).localeCompare(String(a.batch_no)));
  };

  return { listPurchaseRequests, listPurchaseArrivals };
};

module.exports = { createPurchaseQueryService, REPORT_BEHAVIOR };
