'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryStep } = require('../src/services/sales/deliveryStep');

test('AC-SAMPLE-DELIVERY1 交付结果带上这一行选的补样品尺码', async () => {
  const step = createDeliveryStep({
    delivery: () => ({
      async deliver() {
        return {
          failures: [],
          sampleReplacements: [{
            salesDetailRecordId: 'd1', productRecordId: 'p1',
            sampleConsumedQuantity: 1, remainingSizes: [],
          }],
        };
      },
    }),
    now: () => 1,
    events: {},
    logError() {},
  });
  const out = await step.deliverStockLines({
    items: [{ kind: 'shoe', tradeTypeCode: 'SALE_CASH', samplePromotionSize: '41' }],
    detailRecordIds: ['d1'],
    salesEntryRecordId: 'e1',
    correlation: {},
  });
  assert.equal(out.sampleReplacements.length, 1);
  assert.equal(out.sampleReplacements[0].samplePromotionSize, '41');
});
