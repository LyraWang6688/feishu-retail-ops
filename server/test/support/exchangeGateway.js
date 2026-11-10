'use strict';

/**
 * 换货写库用例的假网关（只实现新 service 用到的读/写/列表语义）。
 * 与真实网关同一契约：写入用**语义键**，这里按 schema 映射成飞书列名。
 */
const { AFTER_SALES_EXCHANGE } = require('../../src/config/afterSalesExchange');

const TABLES = {
  salesEntry: { fields: { orderNo: '销售单号', afterSalesType: '售后类型', afterSalesCount: '售后次数', totalAmount: '总金额' } },
  salesDetail: {
    fields: {
      detailId: '销售明细ID', salesEntry: '销售单号', product: '编号', size: '尺码',
      fulfillmentStatus: '履约状态', actualAmount: '实收金额', soldAt: '销售日', tradeType: '交易类型',
    },
  },
  sizeManagement: { fields: { size: '尺码' } },
  paymentRecord: {
    fields: {
      salesEntry: '关联销售单', method: '支付方式', tradeDirection: '收支方向',
      amount: '交易金额', status: '钱款状态', receiptId: '交易明细ID', receivedAt: '收付日',
    },
  },
  behavior: { fields: { code: '行为编码' } },
  product: { fields: {} },
};

const makeExchangeGateway = (overrides = {}) => {
  const state = {
    entry: {
      record_id: 'entry_1',
      fields: {
        销售单号: 'XSD-20261111-0001',
        售后类型: [],
        售后次数: 1,
        总金额: 180,
      },
    },
    detail: {
      record_id: 'detail_1',
      fields: {
        销售明细ID: 'XSD-20261111-0001-01',
        销售单号: [{ record_ids: ['entry_1'] }],
        编号: [{ record_ids: ['product_old'] }],
        尺码: [{ record_ids: ['size_40'] }],
        履约状态: '已交付',
        实收金额: 180,
      },
    },
    sizes: [
      { record_id: 'size_40', fields: { 尺码: 40 } },
      { record_id: 'size_41', fields: { 尺码: 41 } },
      { record_id: 'size_42', fields: { 尺码: 42 } },
    ],
    products: [
      { record_id: 'product_old', fields: {} },
      { record_id: 'product_new', fields: {} },
    ],
    behaviors: [{ record_id: 'behavior_exchange', fields: { 行为编码: 'SALE_EXCHANGE' } }],
    details: [],
    payments: [
      { record_id: 'pay_1', fields: { 关联销售单: [{ record_ids: ['entry_1'] }], 交易明细ID: 'XSD-20261111-0001-收款-01', 交易金额: 180, 钱款状态: '已收款' } },
    ],
    calls: { create: [], update: [] },
  };
  // 原明细本身也要能被 listAll 读到（排号用）
  state.details.push({ record_id: 'detail_1', fields: state.detail.fields });

  const toFeishu = (key, fields = {}) => Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [TABLES[key]?.fields?.[name] || name, value]),
  );

  const gateway = {
    table: (key) => TABLES[key],
    get: async (key, id) => {
      if (key === 'salesEntry' && id === 'entry_1') return state.entry;
      if (key === 'salesDetail' && id === 'detail_1') return state.detail;
      if (key === 'sizeManagement') return state.sizes.find((row) => row.record_id === id) || null;
      if (key === 'product') return state.products.find((row) => row.record_id === id) || null;
      return null;
    },
    listAll: async (key) => {
      if (key === 'salesDetail') return state.details;
      if (key === 'paymentRecord') return state.payments;
      if (key === 'sizeManagement') return state.sizes;
      if (key === 'behavior') return state.behaviors;
      return [];
    },
    create: async (key, fields) => {
      const mapped = toFeishu(key, fields);
      state.calls.create.push({ key, fields: mapped });
      const recordId = `new_${key}_${state.calls.create.length}`;
      if (key === 'salesDetail') state.details.push({ record_id: recordId, fields: mapped });
      if (key === 'paymentRecord') state.payments.push({ record_id: recordId, fields: mapped });
      return { recordId };
    },
    update: async (key, recordId, fields) => {
      const mapped = toFeishu(key, fields);
      state.calls.update.push({ key, recordId, fields: mapped });
      if (key === 'salesDetail') Object.assign(state.detail.fields, mapped);
      if (key === 'salesEntry') Object.assign(state.entry.fields, mapped);
      return { record_id: recordId };
    },
  };

  const paymentMethods = {
    listWithVouchers: async () => ({
      ok: true,
      detailed: [
        { name: '现金', recordId: 'pm_cash', refundable: true },
        { name: '微信转账', recordId: 'pm_wechat', refundable: false },
      ],
    }),
  };

  return { gateway, state, paymentMethods };
};

module.exports = { EXCHANGE: AFTER_SALES_EXCHANGE, makeExchangeGateway, TABLES };
