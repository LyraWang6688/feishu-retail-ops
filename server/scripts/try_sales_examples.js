const path = require('node:path');
require('dotenv').config({ path: process.env.ARK_ENV_FILE || path.join(__dirname, '../../.env') });
const parser = require('../src/services/doubaoService');

const examples = [
  {
    text: '628-6米紫361一双，赠袜子一双，220元微信',
    items: [['628-6', '米紫', 36, 1]], payments: [['微信', 220]], agreedTotal: 220, gift: '袜子',
  },
  {
    text: '93827黑43码、2115米37一双，总共两双250元现金',
    items: [['93827', '黑', 43, 1], ['2115', '米', 37, 1]], payments: [['现金', 250]], agreedTotal: 250,
  },
  {
    text: '6V637-7黑41码一双，赠鞋垫一双，150元微信，100元现金',
    items: [['6V637-7', '黑', 41, 1]], payments: [['微信', 150], ['现金', 100]], agreedTotal: 250, gift: '鞋垫',
  },
  {
    text: '815195B-6黑39码260元未付',
    items: [['815195B-6', '黑', 39, 1]], payments: [], agreedTotal: 260,
  },
  {
    text: '定金50元，9A207-0黑43码一双',
    items: [['9A207-0', '黑', 43, 1]], payments: [['', 50]], agreedTotal: '',
  },
];

const actualItems = (result) => result.items.map((item) =>
  [item.item_no, item.color, item.size, item.quantity]);
const actualPayments = (result) => result.payments.map((payment) =>
  [payment.method, payment.amount]);

(async () => {
  let failures = 0;
  for (const [index, example] of examples.entries()) {
    if (process.env.EXAMPLE_NUMBERS && !process.env.EXAMPLE_NUMBERS.split(',').includes(String(index + 1))) continue;
    try {
      const result = await parser.parseSalesText(example.text);
      const checks = {
        items: JSON.stringify(actualItems(result)) === JSON.stringify(example.items),
        payments: JSON.stringify(actualPayments(result)) === JSON.stringify(example.payments),
        agreed_total: result.agreed_total === example.agreedTotal,
        intent: result.intent === 'sale',
        gift: !example.gift || (result.items.some((item) => item.gift && item.gift_description.includes(example.gift))),
      };
      const passed = Object.values(checks).every(Boolean);
      if (!passed) failures += 1;
      process.stdout.write(`${index + 1}. ${passed ? 'PASS' : 'FAIL'} ${JSON.stringify({ checks, items: actualItems(result), gifts: result.items.map((item) => [item.gift, item.gift_description]), payments: actualPayments(result), agreed_total: result.agreed_total, missing_fields: result.missing_fields })}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`${index + 1}. ERROR ${error.message}\n`);
    }
  }
  process.exitCode = failures ? 1 : 0;
})();
