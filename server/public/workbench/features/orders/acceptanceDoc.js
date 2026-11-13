/**
 * ⭐ 2026-11-12（业务负责人）：验收单（拍照/选图）→ 主表「对方单据」。
 * 本模块只负责：渲染上传行、提示已选文件、上传拿 file_token（业务文案全由调用方传入）。
 */

export const arrivalDocFieldHtml = ({ escapeHtml, label, hint }) => `
            <!-- ⭐ 2026-11-12（业务负责人）：验收单 = 拍照/选图上传 ⇒ 主表「对方单据」 -->
            <label class="form-field action-form__doc">${escapeHtml(label)}
              <input data-field="arrival-doc" type="file" accept="image/*" multiple>
              <span class="action-form__doc-hint" data-view="arrival-doc-hint">${escapeHtml(hint)}</span>
            </label>`;

export const updateArrivalDocHint = (input, texts) => {
  const hint = input.closest('details')?.querySelector('[data-view="arrival-doc-hint"]');
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
