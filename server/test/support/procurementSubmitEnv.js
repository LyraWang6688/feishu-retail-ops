/**
 * 采购页提交用例的**共用夹具**（从 `procurementPageSubmit.test.js` 按职责拆出）：
 * 内存版 scan_sessions store + 假写入件（purchase / behavior）+ 假后台 + 假货品网关。
 * ⚠️ 假 `purchase` 就是「既有 publishPurchaseRequest」的替身：用例据此证明"只调既有写入件一次"。
 */
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../../src/config/v1BitableSchema');
const { buildProcurementPageConfig } = require('../../src/config/procurementPage');
const { createProcurementPageSubmitService } = require('../../src/services/procurementPageSubmitService');

const config = buildProcurementPageConfig({});
const PF = V1_BITABLE_SCHEMA.tables.product.fields;
const NOW = Date.parse('2026-10-28T09:00:00+08:00');
const SUBMIT_KEY = 'procurement_test_key_0001';

const productRecord = (id) => ({
  record_id: id,
  fields: {
    [PF.number]: `no_${id}`, [PF.itemNo]: `item_${id}`, [PF.color]: '黑色',
    [PF.supplier]: [{ record_ids: ['recSupplier'], text: '供应商A' }],
  },
});

// 内存版 sessions store（与 JsonTaskStore 同形状：get / update / ensure）
const makeEnv = ({ products, behavior, purchase } = {}) => {
  const data = new Map();
  const store = {
    async get(id) { return data.get(id) || null; },
    async update(id, mutate) {
      const base = data.get(id) || {};
      const patch = mutate(base) || {};
      const next = { ...base, ...patch };
      data.set(id, next);
      return next;
    },
  };
  const sessions = {
    idOf: (openId) => `session_${openId}`,
    async ensure(openId) {
      const id = `session_${openId}`;
      if (!data.has(id)) data.set(id, {});
      return data.get(id);
    },
    store,
  };
  const purchaseCalls = [];
  const behaviorCalls = [];
  const writers = {
    purchase: async (taskId, payload, opts) => {
      purchaseCalls.push({ taskId, payload, opts });
      if (purchase) await purchase(taskId, payload);
    },
    behavior: async (chain) => {
      behaviorCalls.push(chain);
      if (behavior) return behavior(chain);
      return { recordId: 'recBehavior' };
    },
  };
  const scheduled = [];
  const background = {
    scheduleCustomRest: (args) => { scheduled.push(args); return Promise.resolve({ ok: true }); },
  };
  const gateway = {
    async getBatch(tableKey, ids) {
      assert.equal(tableKey, 'product');
      const list = products || ids.map(productRecord);
      return (ids || []).map((id) => list.find((one) => one.record_id === id)).filter(Boolean);
    },
  };
  const service = createProcurementPageSubmitService({
    gateway,
    writeService: { sessions, multiItemWriters: () => writers },
    background,
    config,
    now: () => NOW,
    logger: {},
  });
  const openId = 'ou_procurement';
  const draftOf = (key = SUBMIT_KEY) => (data.get(`session_${openId}`) || {})[config.draft.ordersField]?.[
    `${config.draft.orderKeyPrefix}:${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  ];
  return { service, data, draftOf, scheduled, purchaseCalls, behaviorCalls, openId };
};
const itemsOf = (ids = ['recA']) => ids.map((id) => ({
  productRecordId: id, entries: [{ size: 39, quantity: 1 }, { size: 40, quantity: 2 }],
}));


module.exports = {
  V1_BITABLE_SCHEMA, buildProcurementPageConfig, PF, NOW, SUBMIT_KEY, config, productRecord, makeEnv, itemsOf,
};

module.exports = {
  V1_BITABLE_SCHEMA, buildProcurementPageConfig, PF, NOW, SUBMIT_KEY, config, productRecord, makeEnv, itemsOf,
};
