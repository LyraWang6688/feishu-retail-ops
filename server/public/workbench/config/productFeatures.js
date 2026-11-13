export const PRODUCT_FEATURES_API = Object.freeze({
  list: '/api/workbench/products/features',
  add: (key) => `/api/workbench/products/features/${encodeURIComponent(key)}/tags`,
});

export const PRODUCT_FEATURES_TEXTS = Object.freeze({
  title: '产品特点配置',
  back: '‹ 返回',
  loading: '正在读取已有标签…',
  loadFailed: '标签读取失败，请稍后重试',
  addPlaceholder: '输入新标签',
  add: '添加',
  adding: '正在添加…',
  empty: '这个维度还没有标签',
  duplicate: '这个标签已经存在，不要重复添加',
  addFailed: '添加失败，请稍后重试',
  count: '{count} 条',
});
