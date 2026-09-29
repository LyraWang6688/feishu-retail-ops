/**
 * 可售品：一笔销售里能卖的东西。
 *
 * 鞋和配品的差别只有三个属性——要规格（尺码）、要跟踪库存、要履约。
 * 这里按属性声明，代码问的是「这个属性是什么」，而不是「这是不是配品」，
 * 所以新增第三种可售品（比如以后卖服务或充值卡）是加一条配置，不是加一条分支。
 */
const SELLABLE_KINDS = Object.freeze({
  shoe: Object.freeze({
    label: '鞋',
    // 销售明细里指向这种可售品的字段（语义键，交给 v1BitableSchema 映射成中文列名）。
    detailLinkField: 'product',
    requiresSize: true,
    tracksInventory: true,
    requiresFulfillment: true,
  }),
  accessory: Object.freeze({
    label: '配品',
    detailLinkField: 'accessory',
    requiresSize: false,
    tracksInventory: false,
    // 配品当场结清，不参与交付跟踪；明细直接写成已交付，不会进待交付列表。
    requiresFulfillment: false,
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
