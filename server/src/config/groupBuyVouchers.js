// 团购券的结算金额不再写死在代码里，改为读「团购券管理」表。
//
// 为什么：券种由抖音侧上架，门店每改一次券就要改一次代码、发一次版本。
// 现在运营在飞书表里加一行（售价 / 面值 / 平台结算款 / 销售状态），
// 代码一行都不用动——这就是配置先行。
//
// 那张表里的三个数各自是什么：
//   售价       客户在抖音买券实际付的钱（89.9）
//   面值       券能抵扣的钱（100）
//   平台结算款  抖音抽佣后结算给商家的钱（85.4 = 89.9 × 95%）
// 收款明细里记的是**平台结算款**，既不是售价也不是面值。

// 用分比较，避免 89.9 这类小数在浮点上比不相等。
const toCents = (value) => Math.round(Number(value) * 100);

const voucherKey = (voucher) => `${toCents(voucher?.purchasePrice)}|${toCents(voucher?.faceValue)}`;

/**
 * 在券目录里按「售价 + 面值」找一张券。
 *
 * 找不到就返回 undefined，由调用方给出"未配置"的追问——不猜、也不拿别的券顶替。
 * 只看面值不行：两档券的面值都是 100，会把 49.9 和 89.9 混成一张。
 */
const findVoucher = (catalog, { purchasePrice, faceValue } = {}) => {
  const wanted = voucherKey({ purchasePrice, faceValue });
  return (catalog || []).find((voucher) => voucherKey(voucher) === wanted);
};

module.exports = { findVoucher, toCents, voucherKey };
