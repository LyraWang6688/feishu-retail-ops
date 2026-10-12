/**
 * ⭐⭐ 2026-10-12（业务负责人，逐字）：
 *   「**采购明细的话，也是说我在同一个报货批次号里面，这是我的第几双鞋，也是需要明细 ID 的**」
 *   ⇒ **采购明细ID** = `{报货批次号}-{两位序号}`（`CGD-…-01` = 同一批次第 1 双、第 2 双…）。
 *   「**明细 ID 都是写在明细表里面的**」「主表存的是**报货批次号**」。
 *
 * 口径（Lead 定的，本文件是**唯一**实现处）：
 *   · 号**写在采购明细行**上（语义键 `purchaseRequest.detailId` → 「采购明细ID」）；
 *   · 序号 = **同一个报货批次号内、按明细创建顺序** 01/02…；
 *   · ⚠️ **不重排已有行**：新号只看**既有行的最大号**（有缺口也取最大值 +1，绝不重号）；
 *   · ⚠️ **后补的行接着排**：老行没有号（迁移前数据）时，按**该批次已有行数**接着排；
 *   · ⚠️ **幂等重放不重复占号**：号由"这一次**真的要创建**的行"依次取；
 *     重放时既有行会被 `createOnceByKey` 命中 ⇒ 不会走到取号那一步（调用方逐条 `next()`）。
 *
 * ⚠️ 并发口径：批次号是**一次提交一个**（`PurchaseBatchNoGenerator`），同一个批次的行由
 *    同一次提交（同一条串行队列 + 同一批幂等键）创建 ⇒ 不存在两个进程同时给同一批次排号；
 *    重放/续跑靠上面那条"最大号 +1"天然安全（不会重号）。
 *
 * 🔴 **取号时机 = "写库之前"，这是刻意的（宁可留空档，绝不重号）**：
 *    调用方在 `values` 里就 `next()`，也就是**这一步真正要建行时**才取号。
 *    如果那次 create 最终失败（含"远端其实写成功、响应丢了"的 `unknown_outcome`）：
 *      · 当前做法 ⇒ 号被消耗掉 ⇒ 同一批后面几条之间**可能出现空档**（例：01 缺号、02 存在），
 *        但**绝不会重号**；重试时按既有行重算 ⇒ 拿到下一个更大的号；
 *      · 反过来"先 peek、建成功后再前进"⇒ 一旦"远端成功但抛错"，下一条会**重复**拿到同一个号
 *        —— 那才是真正危险的（两行同一个「采购明细ID」）。
 *    ⇒ 取舍写在这里：**空档可以接受，重号不可以**。
 */
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');

/** 序号补零位数（两位：`01`…`99`；第 100 条是 `100`，**不截断**）。 */
const DETAIL_ID_PAD = 2;

const formatPurchaseDetailId = (batchNo, sequence) =>
  `${String(batchNo ?? '').trim()}-${String(sequence).padStart(DETAIL_ID_PAD, '0')}`;

/** 从一条 `采购明细ID` 里解出序号；**不是这个批次**的 / 后缀不是数字的 ⇒ null（不参与排号）。 */
const sequenceOfDetailId = (batchNo, detailId) => {
  const prefix = `${String(batchNo ?? '').trim()}-`;
  const text = String(detailId ?? '').trim();
  if (!text.startsWith(prefix)) return null;
  const suffix = text.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
};

/**
 * 下一个可用序号：
 *   `max(既有最大号, 该批次已有行数) + 1`
 *   —— 取行数是为了"老行没有号"那种数据也能接着排（否则新号会与老行数撞上）。
 */
const nextPurchaseDetailSequence = (batchNo, { existingIds = [], rowCount = 0 } = {}) => {
  let max = 0;
  for (const detailId of existingIds) {
    const sequence = sequenceOfDetailId(batchNo, detailId);
    if (sequence !== null) max = Math.max(max, sequence);
  }
  return Math.max(max, Number(rowCount) || 0) + 1;
};

/**
 * 分配器：`open({ batchRecordId, batchNo })` 读一次该批次的既有明细行，返回一个游标；
 * 调用方**每真的创建一条**才 `next()`（重放时不会走到这里 ⇒ 不重复占号）。
 */
const createPurchaseDetailIdAllocator = ({ gateway } = {}) => {
  if (!gateway) throw new Error('采购明细ID 分配器需要 gateway');
  return {
    async open({ batchRecordId, batchNo } = {}) {
      const fields = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
      const rows = await gateway.listAll('purchaseRequest');
      const inBatch = rows.filter((record) => linkedRecordIds(record.fields?.[fields.batchNo])
        .includes(batchRecordId));
      let next = nextPurchaseDetailSequence(batchNo, {
        existingIds: inBatch.map((record) => textValue(record.fields?.[fields.detailId])),
        rowCount: inBatch.length,
      });
      return {
        next: () => formatPurchaseDetailId(batchNo, next++),
        peek: () => next,
      };
    },
  };
};

module.exports = {
  DETAIL_ID_PAD,
  formatPurchaseDetailId,
  sequenceOfDetailId,
  nextPurchaseDetailSequence,
  createPurchaseDetailIdAllocator,
};
