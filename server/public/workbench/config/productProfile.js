/** 「货品资料」页（配置 tab）：搜索货品 / 按缺失信息分组 / 同步样例图。 */
import { PRODUCT_NEW_FORM_URL, ACCESSORY_TABLE_URL } from './links.js';

export const PRODUCT_PROFILE_API = Object.freeze({
  search: '/api/workbench/products/search',
  incomplete: '/api/workbench/products/incomplete',
});

export const PRODUCT_PROFILE_TEXTS = Object.freeze({
  title: '货品资料',
  newTitle: '货品上新',
  completeTitle: '货品完善',
  sampleTitle: '同步样例图',
  accessoryTitle: '配品配置',

  searchPlaceholder: '录入货号进行重复校验',
  searchingToast: '正在查询中…',
  noImage: '无样例图',
  searchEmpty: '录入货号后显示搜索结果。',
  searchNone: '没有匹配的货品，可以直接点「去上新」。',
  searchFound: '找到 {count} 条',
  newAction: '去上新',
  completeHint: '共 {count} 条待完善；按缺失信息选择查看。',
  completeLoading: '正在读取缺失信息…',
  completeEmpty: '当前没有待完善的货品。',
  completeSelectPlaceholder: '请选择缺失信息',
  completeSelectLoading: '正在读取…',
  completeField: '缺失信息',
  completeAction: '去完善',
  back: '‹ 返回',
  searchFailed: '搜索失败，请稍后重试',
  incompleteFailed: '货品完善读取失败，请稍后重试',
  formUrl: PRODUCT_NEW_FORM_URL,
  accessoryTableUrl: ACCESSORY_TABLE_URL,
});
