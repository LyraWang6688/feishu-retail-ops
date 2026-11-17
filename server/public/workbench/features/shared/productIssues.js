/**
 * 货品搜索结果的「缺失信息」标签 —— 货品资料页与库存单双调整共用这一份。
 *
 * 数据来自既有接口 GET /api/workbench/products/search（同一份 item）：
 *   · hasSampleImage = false ⇒ 无样例图
 *   · missingProduct ≠ 齐备 ⇒ 商品信息缺失（具体缺哪些字段）
 *   · missingTag ≠ 齐备 ⇒ 标签信息缺失
 * ⚠️ 只做「文字数组」，HTML 转义由调用方负责（两页各自的转义函数不合并）。
 */

import { PRODUCT_PROFILE_TEXTS as T } from '../../config/productProfile.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (
  values[key] == null ? '' : String(values[key])
));

export function productIssueChipsOf(item) {
  // ⭐ 2026-11-17：服务端已经把「缺样例图 / 缺商品信息 / 缺标签」算好了（与扫码页同一份判定），
  //   有就直接用；老接口 / 假数据没有 `issues` 时走下面的兜底（行为与改前一致）。
  if (Array.isArray(item?.issues)) return item.issues;
  const issues = [];
  if (!item?.hasSampleImage) issues.push(T.issueSample);
  if (item?.missingProduct && item.missingProduct !== T.completeValue) {
    issues.push(fill(T.issueProduct, { value: item.missingProduct }));
  }
  if (item?.missingTag && item.missingTag !== T.completeValue) {
    issues.push(fill(T.issueTag, { value: item.missingTag }));
  }
  return issues;
}
