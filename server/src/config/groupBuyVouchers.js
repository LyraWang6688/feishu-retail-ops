// Store-side settlement amounts for one 100-yuan Douyin voucher.
// Keep voucher economics in one place; the receipt amount is never the
// customer's voucher purchase price or the voucher face value.
const GROUP_BUY_VOUCHERS = Object.freeze({
  '89.9|100': Object.freeze({ purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4 }),
  '49.9|100': Object.freeze({ purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4 }),
});

module.exports = { GROUP_BUY_VOUCHERS };
