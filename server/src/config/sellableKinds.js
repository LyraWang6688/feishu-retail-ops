/**
 * 可售品：一笔销售里能卖的东西。
 *
 * 可售品按属性声明（要规格 / 要跟踪库存 / 要履约）。
 * 当前只有鞋；新增可售品时加一条配置，而不是加一条分支。
 */
const SELLABLE_KINDS = Object.freeze({
  shoe: Object.freeze({
    label: '鞋',
    // 销售明细里指向这种可售品的字段（语义键，交给 v1BitableSchema 映射成中文列名）。
    detailLinkField: 'product',
    // 「这一件叫什么」——给**只读展示**用的表与字段（同样是语义键，见 v1BitableSchema）：
    // 鞋的货号在「货品信息.货号」。
    // 2026-10-07 加：待处理单推送要按「货号 + 尺码」显示每一条，
    // 展示侧因此不该自己写死「product / itemNo」这种映射（换一种可售品就得改展示代码）。
    detailTableKey: 'product',
    detailLabelField: 'itemNo',
    requiresSize: true,
    tracksInventory: true,
    requiresFulfillment: true,
  }),

});

const DEFAULT_KIND = 'shoe';

const sellableKindOf = (item = {}) => {
  const key = item.kind ? String(item.kind).trim().toLowerCase() : DEFAULT_KIND;
  const config = SELLABLE_KINDS[key];
  if (!config) {
    throw new Error(`未声明的可售品类型「${item.kind}」：请先在 sellableKinds 中声明它的属性`);
  }
  return { key, ...config };
};

module.exports = { SELLABLE_KINDS, sellableKindOf };
