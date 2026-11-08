'use strict';

/**
 * ⭐⭐ 2026-10-29（F1/F2 · Lead 批；业务负责人批注驱动的验收修复）
 * **验收会话的"整单替换"入口**（`scanArrivalService.setScans` 的实现）。
 *
 * 为什么需要它（main 上的真 bug）：
 *   · 工作台【确认到货】原来逐行 `addScan`：只认"本批申请行里已有的 (款,尺码)"
 *     ⇒ 页面提交的整张清单无法逐行改数量（`not_in_batch`）✗；
 *   · 同一会话二次提交时 `addScan` 对已有行返回 `duplicate`（数字一个都不变）
 *     ⇒ 她改数量不生效、改成 0 也删不掉 ✗；
 *   · 页面提交的是"整张清单" ⇒ 只有**整体替换**才是它的真实语义 ✓。
 *
 * 判据（Lead 批的 AC）：
 *   · 空清单 ⇒ `no_scan_lines` 400，**不清旧会话**（她误点一次不丢已填的）✓；
 *   · 同一 (款,尺码) 重复 ⇒ `duplicate_lines` 400（不合并、不静默留一行）✓；
 *   · 款不在本批 ⇒ `not_in_batch` 400（不猜款 ✓）；
 *   · 提交行必须落在本批申请行里（款 + 尺码都匹配）⇒ 否则 `not_in_batch` 400；
 *   · 数量 0 / 空 ⇒ 这一行**不算到货**（她"没到的改成 0"/从清单里删掉同义 ✓）；非整数/超上限 ⇒ 400；
 *   · 清单**有变化** ⇒ `submit_round + 1`（新的幂等键 ⇒ 改完再提交是"新的一次" ✓）；
 *     清单**完全没变** ⇒ 轮次不动（连点两次同一份 = 同一把钥匙 ⇒ 幂等 ✓）；
 *   · 全部校验通过才落会话；任何一条不合法 ⇒ **会话一个字都不动** ✓。
 *
 * ⚠️ 拆成独立模块：`scanArrivalService.js` 是存量较大的文件（文件大小棘轮只允许变小 ✗）。
 *    本模块**不含业务表写入**：只碰会话存储 `store`（与 `addScan` 同一个 `scans`）。
 *
 * @param {object} deps
 * @param {Function} deps.get 读当前会话（过期/不存在返回 null）
 * @param {object} deps.store 会话存储（`update(id, patch)`）
 * @param {Function} deps.touch 会话过期时间补丁（`patch => patch`）
 * @param {object} deps.texts 文案真源（`SCAN_WRITE.texts` + 覆盖）
 * @param {object} deps.events 事件名真源
 * @param {object} deps.config 验收配置（`maxScans` / `maxQuantity`）
 * @param {Function} deps.logInfo 结构化日志
 * @param {Function} deps.positiveInteger 正整数字符串 → number|null
 * @param {Function} deps.nonNegativeInteger 非负整数字符串 → number|null
 * @param {Function} deps.resolve accessor（`() => value`）解引用
 * @returns {Function} `async ({ openId, lines }) => result`
 */
const { fillText } = require('../../config/scanWrite');

const createSetScans = ({
  get, store, touch, texts, events, config, logInfo,
  positiveInteger, nonNegativeInteger,
}) => async ({ openId, lines } = {}) => {
  const session = await get(openId);
  if (!session) return { ok: false, reason: 'no_session', message: texts.acceptNoSessionBody };
  if (session.status !== 'open') {
    return {
      ok: false,
      reason: 'already_posted',
      message: fillText(texts.acceptAgainBody, { batchNo: session.batch_no }),
    };
  }
  const submitted = Array.isArray(lines) ? lines : [];
  if (!submitted.length) {
    // ⚠️ 空清单**不许清空**旧会话（她误点一次不该把已经填好的全丢 ✗）
    return { ok: false, reason: 'no_scan_lines', message: texts.acceptNoScansBody };
  }
  if (submitted.length > config.maxScans) {
    return { ok: false, reason: 'too_many_scans', message: texts.acceptTooManyScansBody };
  }
  // 本批的款：`session.products`（正常都有；老会话兜底从 rows 取）
  const knownProducts = new Set(
    [...(session.products || []), ...(session.rows || [])]
      .map((item) => String(item?.product_record_id || '').trim())
      .filter(Boolean),
  );
  const reported = new Map((session.rows || []).map((row) => [
    `${row.product_record_id}|${Number(row.size)}`, row,
  ]));
  const quantityInvalid = () => ({
    ok: false,
    reason: 'quantity_invalid',
    message: fillText(texts.acceptQuantityInvalidBody, { max: config.maxQuantity }),
  });
  const normalized = [];
  const seen = new Set();
  for (const line of submitted) {
    const productRecordId = String(
      line?.product_record_id ?? line?.productRecordId ?? '',
    ).trim();
    const size = positiveInteger(line?.size);
    const quantityText = String(line?.quantity ?? '').trim();
    // 空 / 0 = 这一行**不算到货**（她「没到的改成 0」/ 从清单里删掉同义 ✓）
    if (quantityText === '' || quantityText === '0') continue;
    if (!productRecordId) {
      return { ok: false, reason: 'line_invalid', message: texts.acceptNotInBatchBody };
    }
    const quantity = nonNegativeInteger(quantityText);
    if (size === null || quantity === null || quantity > config.maxQuantity) return quantityInvalid();
    if (!knownProducts.has(productRecordId)) {
      logInfo(events.acceptNotInBatch, {
        session_id: session.session_id, batch_no: session.batch_no,
        product_record_id: productRecordId, size,
      });
      return { ok: false, reason: 'not_in_batch', message: texts.acceptNotInBatchBody };
    }
    const key = `${productRecordId}|${size}`;
    if (seen.has(key)) {
      // 重复行**拒**（不合并）：合并会让她看不出自己填重了、数量静默变成最后一行的值 ✗
      return {
        ok: false,
        reason: 'duplicate_lines',
        message: texts.acceptDuplicateLinesBody || texts.acceptNotInBatchBody,
      };
    }
    seen.add(key);
    // ⭐ 2026-11-09（业务负责人：前端/后端都不需要自定义尺码、货号逻辑）：
    //   提交行必须与本批申请行逐字匹配（款 + 尺码）；不在本批 ⇒ 400 + 人话 + 会话不动。
    if (!reported.has(key)) {
      logInfo(events.acceptNotInBatch, {
        session_id: session.session_id, batch_no: session.batch_no,
        product_record_id: productRecordId, size,
      });
      return { ok: false, reason: 'not_in_batch', message: texts.acceptNotInBatchBody };
    }
    normalized.push({ product_record_id: productRecordId, size, quantity });
  }
  if (!normalized.length) {
    return { ok: false, reason: 'no_scan_lines', message: texts.acceptNoScansBody };
  }
  const keyOf = (list) => list
    .map((item) => `${item.product_record_id}|${Number(item.size)}|${Number(item.quantity)}`)
    .sort()
    .join(';');
  const changed = keyOf(session.scans || []) !== keyOf(normalized);
  const scanned = normalized.reduce((sum, item) => sum + item.quantity, 0);
  const updated = await store.update(session.session_id, touch({
    scans: normalized,
    scanned,
    // ⭐ 清单变了 ⇒ 新一轮（新的幂等键）；没变 ⇒ 轮次不动（连点两次同一份 = 同一把钥匙 ✓）
    submit_round: Number(session.submit_round || 0) + (changed ? 1 : 0),
    last_error: '',
  }));
  logInfo(events.acceptRowsSet, {
    session_id: updated.session_id, batch_no: updated.batch_no,
    line_count: normalized.length, scanned, expected: Number(updated.expected || 0),
    request_rows: reported.size, changed,
  });
  return {
    ok: true,
    changed,
    session: updated,
    scanned,
    expected: Number(updated.expected || 0),
    scans: normalized,
  };
};

module.exports = { createSetScans };
