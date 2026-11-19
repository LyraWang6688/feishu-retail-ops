/**
 * ⭐ 2026-11-12（业务负责人）：验收单（拍照/选图）→ 主表「对方单据」。
 * 本模块只负责：渲染上传行、提示已选文件、上传拿 file_token（业务文案全由调用方传入）。
 */

export const arrivalDocFieldHtml = ({ escapeHtml, label, hint }) => `
            <!-- ⭐ 2026-11-12（业务负责人）：验收单 = 拍照/选图上传 ⇒ 主表「对方单据」 -->
            <label class="form-field action-form__doc">${escapeHtml(label)}
              <input data-field="arrival-doc" type="file" accept="image/*" multiple required aria-required="true">
              <span class="action-form__doc-hint" data-view="arrival-doc-hint">${escapeHtml(hint)}</span>
            </label>`;

export const updateArrivalDocHint = (input, texts) => {
  const hint = input.closest('details, form')?.querySelector('[data-view="arrival-doc-hint"]');
  const files = [...(input.files || [])];
  if (!hint) return;
  hint.textContent = files.length
    ? `已选 ${files.length} 张：${files.map((file) => file.name).join('、')}`
    : texts.acceptanceDocHint;
};

/**
 * 上传选中的验收单图片，返回 [{fileToken, fileName}]。
 * @returns {Promise<{ok:boolean, documents?:Array, error?:string}>}
 */
export const uploadArrivalDocuments = async ({ api, endpoint, files = [], texts }) => {
  if (files.length > 5) return { ok: false, error: texts.acceptanceDocTooMany };
  const documents = [];
  for (const file of files) {
    if (!String(file.type || '').startsWith('image/')) {
      return { ok: false, error: texts.acceptanceDocInvalid };
    }
    if (file.size > 10 * 1024 * 1024) {
      return { ok: false, error: texts.acceptanceDocTooLarge };
    }
    let uploaded = null;
    try {
      uploaded = await api.postRaw(endpoint, file);
    } catch {
      return { ok: false, error: texts.acceptanceDocUploadFailed };
    }
    const fileToken = String(uploaded?.file?.file_token || '').trim();
    if (!fileToken) return { ok: false, error: texts.acceptanceDocUploadFailed };
    documents.push({
      fileToken,
      fileName: String(uploaded.file.file_name || file.name || '').trim(),
    });
  }
  return { ok: true, documents };
};

/** 验收单也必填：未选图时聚焦 + 原生校验 + 字段旁人话，调用方直接 return。 */
export const validateArrivalDocuments = (form, texts) => {
  const input = form?.querySelector('[data-field="arrival-doc"]') || null;
  const hint = form?.querySelector('[data-view="arrival-doc-hint"]') || null;
  const files = input?.files ? [...input.files] : [];
  if (files.length) return { ok: true, files };
  if (hint) {
    hint.textContent = texts.acceptanceDocRequired;
    hint.hidden = false;
  }
  input?.focus();
  if (typeof input?.reportValidity === 'function') input.reportValidity();
  return { ok: false, files, error: texts.acceptanceDocRequired };
};

/**
 * ⭐⭐ 2026-10-15（task-27 · 她逐字）：「点进去之后才是对应的采购明细情况，然后**可以自行补充**这个货号下的
 *   其余尺码和数量」＋「**实际到多少就是到多少**」
 *
 * 独立验收明细页（`features/acceptance-detail`）使用同一份 `arrivalSubmitLines` / 样品选择逻辑。
 *   · 默认值 = 该行的**申请数量**（她要"改"，不是"从空开始填" ✓）；
 *   · 行的身份挂在 `data-*` 上（`product_record_id` / `size` / `declared`）⇒ 提交时**不用猜** ✓。
 */
export const arrivalLineKey = (row = {}) => `${String(row.product_record_id || '').trim()}|${String(row.size ?? '').trim()}`;

/**
 * 🔴 **她填的实际到货数量** ⇒ 提交用的 `lines`（**唯一来源** ✓ 绝不按申请数补齐 ✗）：
 *   · 某个尺码**填 0** ⇒ **不提交那一行**（没到就是没到 ✓）；
 *   · **没填**（清空）⇒ **不猜**（`ok:false` + 人话，页面上拦住 ✓）—— 「没填」与「填 0」是两件事 ✗；
 *   · 没碰过的行 ⇒ 用页面**预填值**（= 申请数量 ✓ 这与"按申请数补齐"不是一回事：
 *     预填是**页面给她看的默认**，她改了就按她的值，提交的永远是**她确认过的那个值** ✓）。
 */
export function arrivalSubmitLines({ rows = [], actuals = {} } = {}) {
  const lines = [];
  for (const row of rows || []) {
    const key = arrivalLineKey(row);
    const has = Object.prototype.hasOwnProperty.call(actuals || {}, key);
    const raw = String((has ? actuals[key] : row.quantity) ?? '').trim();
    if (raw === '') return { ok: false, reason: 'actual_missing', lines: [] };
    if (!/^\d+$/.test(raw)) return { ok: false, reason: 'actual_invalid', lines: [] };
    const quantity = Number(raw);
    if (quantity === 0) continue;
    lines.push({ productRecordId: String(row.product_record_id || ''), size: Number(row.size), quantity });
  }
  return { ok: true, reason: '', lines };
}

/**
 * 2026-11-18：本次验收里，哪些编号需要她选「哪个入库尺码做样品」。
 *
 * 输入：
 *   · rows  = 验收明细原始行（后端已带 needs_sample_choice / has_stock / has_sample）
 *   · lines = arrivalSubmitLines() 的结果（已排除数量 0）
 *
 * 返回：每个需要选的产品一段，候选只来自本次实际到货数量 > 0 的尺码。
 */
export function sampleChoiceProducts({ rows = [], lines = [] } = {}) {
  const rowsByProduct = new Map();
  for (const row of rows || []) {
    const productId = String(row?.product_record_id || '').trim();
    if (!productId || rowsByProduct.has(productId)) continue;
    rowsByProduct.set(productId, row);
  }
  const products = new Map();
  for (const line of lines || []) {
    const productId = String(line?.productRecordId || line?.product_record_id || '').trim();
    const row = rowsByProduct.get(productId);
    // 兼容后端原始 snake_case 与验收明细页转换后的 camelCase。
    const needsChoice = row?.needs_sample_choice === true || row?.needsSampleChoice === true;
    if (!row || !needsChoice) continue;
    if (!products.has(productId)) {
      products.set(productId, {
        productRecordId: productId,
        itemNo: String(row.item_no || '').trim(),
        color: String(row.color || '').trim(),
        number: String(row.number || '').trim(),
        hasStock: row.has_stock === true || row.hasStock === true,
        candidates: [],
      });
    }
    products.get(productId).candidates.push({
      size: Number(line.size),
      quantity: Number(line.quantity),
    });
  }
  for (const product of products.values()) {
    product.candidates.sort((left, right) => left.size - right.size);
  }
  return [...products.values()];
}

