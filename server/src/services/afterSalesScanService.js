// 售后**扫一扫落地页**的只读取数（一个字节都不写）。
//
// 边界：
//   · 只回答一个问题：「扫到的这款货品，近 N 天有哪几笔销售、每笔的销售日 / 尺码 / 该单总金额」；
//   · 不判断意图、不生成售后单、不碰库存 / 收款（那些是执行器的事，见 `afterSalesService`）；
//   · 不做业务取舍：排除「已经售后过」「没入账（写入失败 / 未完成）」两类行，
//     并把**排除了多少条**如实回给页面（不让页面自己猜"为什么少了一条"）。
//
// 判据来源（配置先行，本文件不写业务字面量）：
//   · 时间窗 / 取哪些列 / 后端人话 → `config/afterSalesScan.js`；
//   · 「售后过没有」→ `config/afterSales.js` 的 `isAfterSalesFulfillment`（唯一判据）；
//   · 「入账了没有」→ `config/salesStatusDimensions.js` 的 `postedOf` / `isPosted`（唯一判据）；
//   · 「扫到的是哪款货品」→ 销售明细的关联列（语义键来自 schema）。
//
// 为什么这块**不属于** `salesFollowupService`（订单列表读侧）：
//   订单列表要的是「钱货两清 / 待交付」那一套汇总；落地页只要**这几列事实**，
//   而且它要的是「销售日 + 总金额」这两个订单列表**没读**的列。
//   两边各读各的，互不影响（模块化；订单列表的按需取列清单不被这里放宽）。

const { isAfterSalesFulfillment } = require('../config/afterSales');
const {
  SCAN_FIELD_KEYS, SCAN_TEXTS, resolveScanWindowDays,
} = require('../config/afterSalesScan');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { withSalesReadRetry } = require('./salesReadRetry');

const DAY_MS = 24 * 60 * 60 * 1000;

const asText = (value) => String(value ?? '').trim();

/** 飞书日期列是毫秒时间戳；取不到 / 非法 ⇒ null（不猜一个"今天"）。 */
const epochOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/** 数字列（总金额 / 实收金额）：空 ⇒ null（**空与 0 是两件事**，不许拿 0 顶）。 */
const numberOf = (value) => {
  const text = asText(value).replace(/,/g, '').replace(/¥/g, '');
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * 语义键 → 飞书列名。一个都映射不到 ⇒ 返回 `undefined`（调用方**不传** `fieldNames`
 * ⇒ 退回整表读：宁可慢，不许因为配置改名而少一列）。
 */
const fieldNamesOf = (gateway, tableKey) => {
  const fields = gateway.table?.(tableKey)?.fields || {};
  const names = (SCAN_FIELD_KEYS[tableKey] || [])
    .map((key) => fields[key])
    .filter(Boolean);
  return names.length ? names : undefined;
};

class AfterSalesScanService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('AfterSalesScanService requires gateway');
    this.gateway = options.gateway;
    this.now = options.now || (() => Date.now());
  }

  readOptions(tableKey) {
    const fieldNames = fieldNamesOf(this.gateway, tableKey);
    return fieldNames ? { fieldNames } : {};
  }

  /**
   * @param {{ productRecordId?: string, days?: number|string }} input
   * @returns {Promise<{ product: object, days: number, cutoff: number, candidates: object[], excluded: object }>}
   */
  async listCandidates({ productRecordId, days } = {}) {
    const productId = asText(productRecordId);
    if (!productId) throw badRequest(SCAN_TEXTS.missingProduct);
    const windowDays = resolveScanWindowDays(days);
    const cutoff = this.now() - windowDays * DAY_MS;

    const [product, entries, details] = await Promise.all([
      withSalesReadRetry(() => this.gateway.get('product', productId), 'after_sales_scan_product'),
      withSalesReadRetry(() => this.gateway.listAll('salesEntry', this.readOptions('salesEntry')),
        'after_sales_scan_entries'),
      withSalesReadRetry(() => this.gateway.listAll('salesDetail', this.readOptions('salesDetail')),
        'after_sales_scan_details'),
    ]);
    if (!product) throw badRequest(SCAN_TEXTS.productNotFound);

    const productFields = this.gateway.table('product').fields;
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const entryById = new Map(entries.map((entry) => [entry.record_id, entry]));

    // 排除了多少条、为什么排除 —— 如实回给页面（页面据此说一句人话，不静默吞数据）。
    const excluded = { alreadyAfterSales: 0, notPosted: 0, outOfWindow: 0 };
    const candidates = [];
    for (const detail of details) {
      const fields = detail.fields || {};
      // 归属判据：这条明细卖的是不是扫到的那款货品（关联列里含它）。
      if (!linkedRecordIds(fields[detailFields.product]).includes(productId)) continue;
      const entry = entryById.get(linkedRecordIds(fields[detailFields.salesEntry])[0]);
      // 找不到主表 = 数据不完整（写入中途失败等）⇒ 不在落地页给候选（也不能拿来做售后）。
      if (!entry) { excluded.notPosted += 1; continue; }
      if (isAfterSalesFulfillment(textValue(fields[detailFields.fulfillmentStatus]))) {
        excluded.alreadyAfterSales += 1;
        continue;
      }
      const soldAt = epochOf(fields[detailFields.soldAt]);
      const recordedAt = epochOf(entry.fields?.[entryFields.recordedAt]);
      // 「销售日」优先取明细上的「销售日」；没有（历史数据）才退回主表「录单日」——
      // 页面照实把来源带上（`sales_date_source`），不假装两者一样。
      const salesDate = soldAt || recordedAt;
      if (!salesDate || salesDate < cutoff) { excluded.outOfWindow += 1; continue; }
      if (!isPosted(postedOf(entry, entryFields))) { excluded.notPosted += 1; continue; }
      const sizeCell = fields[detailFields.size];
      const sizeNumber = Number(asText(textValue(sizeCell)));
      candidates.push({
        sales_entry_record_id: entry.record_id,
        order_no: asText(entry.fields?.[entryFields.orderNo]) || entry.record_id,
        sales_detail_record_id: detail.record_id,
        sales_date: salesDate,
        sales_date_source: soldAt ? 'sold_at' : 'recorded_at',
        size: Number.isFinite(sizeNumber) && sizeNumber > 0 ? sizeNumber : null,
        // 关联 record_id 一起带上：以后换货/赔货要按尺码写库时直接用，不用再反查一次。
        size_record_id: linkedRecordIds(sizeCell)[0] || '',
        total_amount: numberOf(entry.fields?.[entryFields.totalAmount]),
        actual_amount: numberOf(fields[detailFields.actualAmount]),
        fulfillment_status: asText(textValue(fields[detailFields.fulfillmentStatus])),
      });
    }

    // 排序确定：销售日新→旧；同一天按单号新→旧，再按尺码小→大、明细 id（避免同输入两次顺序不同）。
    candidates.sort((left, right) => (
      right.sales_date - left.sales_date
      || String(right.order_no).localeCompare(String(left.order_no))
      || Number(left.size ?? 0) - Number(right.size ?? 0)
      || String(left.sales_detail_record_id).localeCompare(String(right.sales_detail_record_id))
    ));

    return {
      product: {
        record_id: product.record_id,
        // 「编号」是「货号|颜色|类别」拼起来的那一列，「货号」是单独一列 —— 两个都带上，页面按需显示。
        number: asText(textValue(product.fields?.[productFields.number])),
        item_no: asText(textValue(product.fields?.[productFields.itemNo])),
        color: asText(textValue(product.fields?.[productFields.color])),
      },
      days: windowDays,
      cutoff,
      candidates,
      excluded,
    };
  }
}

module.exports = { AfterSalesScanService };
