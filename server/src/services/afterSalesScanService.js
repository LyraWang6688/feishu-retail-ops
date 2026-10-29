// 售后**扫一扫落地页**的只读取数（一个字节都不写）。
//
// 边界：
//   · 只回答一个问题：「扫到的这款货品，近 N 天有哪几笔销售、每笔的销售日 / 尺码 / 该单总金额」；
//   · 不判断意图、不生成售后单、不碰库存 / 收款（那些是执行器的事，见 `afterSalesService`）；
//   · 不做业务取舍：排除「已经售后过」「没入账（写入失败 / 未完成）」两类行，
//     并把**排除了多少条**如实回给页面（不让页面自己猜"为什么少了一条"）。
//   · ⭐ 「近 N 天」= **上海自然日**：今天 + 往前 (N-1) 天、含今天共 N 个自然日
//     （共用 `utils/salesDateWindows.lookupWindowStart`，与项目其它"最近几天"同一口径；
//      **不是**"此刻往前滚 N×24 小时"）。
//   · 🔴 「销售日」**只认销售明细的 `销售日`**，**不做任何兜底**（业务负责人 2026-10-29 明确：
//     「不用你做兜底，它就是来自于销售明细里面的销售日」）⇒ 没有销售日的行**不列**、单独计数。
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
  SCAN_CACHE, SCAN_FIELD_KEYS, SCAN_TEXTS, SCAN_UNDELIVERED_FULFILLMENT, resolveScanWindowDays,
} = require('../config/afterSalesScan');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { withSalesReadRetry } = require('./salesReadRetry');
const { createScanPageCache } = require('./scanPageCache');
const { lookupWindowStart } = require('../utils/salesDateWindows');

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
    // ⭐ 读模型短 TTL 缓存：**复用扫码页那一份实现**（`scanPageCache`）。
    //   测试可注入（用例验"命中不再读表" / "关掉就真读"）。
    this.cache = options.cache || createScanPageCache({
      ttlMs: SCAN_CACHE.enabled ? SCAN_CACHE.ttlMs : 0,
      maxEntries: SCAN_CACHE.maxEntries,
    });
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
    // ⭐ 读模型缓存键：同一货品 + 同一窗口 ⇒ 同一份结果（短 TTL，见 config/afterSalesScan 的 SCAN_CACHE）。
    const cacheKey = `${productId}|${windowDays}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const result = await this.buildCandidates({ productId, windowDays });
    // ⚠️ 只缓存**有候选**的结果（空结果不缓存：她刚卖的一双要能立刻看到）。
    if (result.candidates.length) this.cache.set(cacheKey, result);
    return result;
  }

  /** 真读一次（3 处读：货品 1 条 + 销售明细 + 主表按 id 批量）—— 缓存 miss 时才会进来。 */
  async buildCandidates({ productId, windowDays }) {
    // ⭐ 「近 N 天」按**上海自然日**算：今天 + 往前 (N-1) 天（含今天共 N 天），不是滚动 24 小时。
    const now = this.now();
    const cutoff = lookupWindowStart({ now: new Date(now), days: windowDays });

    const [product, details] = await Promise.all([
      withSalesReadRetry(() => this.gateway.get('product', productId), 'after_sales_scan_product'),
      withSalesReadRetry(() => this.gateway.listAll('salesDetail', this.readOptions('salesDetail')),
        'after_sales_scan_details'),
    ]);
    if (!product) throw badRequest(SCAN_TEXTS.productNotFound);

    const productFields = this.gateway.table('product').fields;
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;

    // 排除了多少条、为什么排除 —— 如实回给页面（页面据此说一句人话，不静默吞数据）。
    const excluded = {
      notDelivered: 0, alreadyAfterSales: 0, notPosted: 0, outOfWindow: 0, missingSalesDate: 0,
    };
    const candidates = [];

    // ⭐ 主表**不再整表读**：先扫明细、把"只靠明细就能判断的条件"先筛掉
    //   （货品归属 / 未交付 / 已售后 / 销售日窗口），再把剩下那几单的 record_id 收集起来
    //   按 id **批量取**（`getBatch`）—— 一张 660 行的表只取真正要看的那几行。
    //   判据不变：主表那侧只剩「写入状态」一个条件（未入账不做售后）。
    const pending = [];
    for (const detail of details) {
      const fields = detail.fields || {};
      if (!linkedRecordIds(fields[detailFields.product]).includes(productId)) continue;
      // 🔴 「销售日」**只认销售明细的 `销售日`**（业务负责人 2026-10-29：「不用你做兜底」）——
      //   没有销售日的行**不进候选**（单独计数，如实回给页面），绝不拿「录单日」顶替。
      //   ⚠️ 窗口判断放在「未交付 / 已售后」之前：这样后面两个计数是**近 N 天窗口内**的
      //   （页面那句"另有 N 条已经售后过"说的是这 7 天里的事，不是开业以来）。
      const salesDate = epochOf(fields[detailFields.soldAt]);
      if (!salesDate) { excluded.missingSalesDate += 1; continue; }
      if (salesDate < cutoff) { excluded.outOfWindow += 1; continue; }
      const fulfillmentStatus = asText(textValue(fields[detailFields.fulfillmentStatus]));
      // ⭐ 「什么叫售后」= 除「未交付」之外的状态（她 2026-10-29）⇒ 未交付的不列。
      if (fulfillmentStatus === SCAN_UNDELIVERED_FULFILLMENT) {
        excluded.notDelivered += 1;
        continue;
      }
      // 已经售后过的（已退货 / 已换货 / 已赔货）也不列（同一双不做第二次售后）。
      if (isAfterSalesFulfillment(fulfillmentStatus)) {
        excluded.alreadyAfterSales += 1;
        continue;
      }
      const entryId = linkedRecordIds(fields[detailFields.salesEntry])[0];
      if (!entryId) { excluded.notPosted += 1; continue; }
      pending.push({ detail, fields, entryId, salesDate });
    }
    const entryIds = [...new Set(pending.map((item) => item.entryId))];
    const entries = entryIds.length
      ? await withSalesReadRetry(
        () => this.gateway.getBatch('salesEntry', entryIds, this.readOptions('salesEntry')),
        'after_sales_scan_entries',
      )
      : [];
    const entryById = new Map(entries.map((entry) => [entry.record_id, entry]));

    for (const item of pending) {
      const { detail, fields, salesDate } = item;
      const entry = entryById.get(item.entryId);
      // 找不到主表 = 数据不完整（写入中途失败等）⇒ 不在落地页给候选（也不能拿来做售后）。
      if (!entry) { excluded.notPosted += 1; continue; }
      if (!isPosted(postedOf(entry, entryFields))) { excluded.notPosted += 1; continue; }
      const sizeCell = fields[detailFields.size];
      const sizeNumber = Number(asText(textValue(sizeCell)));
      candidates.push({
        sales_entry_record_id: entry.record_id,
        order_no: asText(textValue(entry.fields?.[entryFields.orderNo])) || entry.record_id,
        sales_detail_record_id: detail.record_id,
        sales_date: salesDate,
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
