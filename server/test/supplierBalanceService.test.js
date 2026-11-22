'use strict';

/** 「供应 → 往来款」只读聚合：显示规则 / 余额来源 / 交易标签与金额。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSupplierBalanceService } = require('../src/services/supplierBalanceService');
const { SUPPLIER_BALANCE } = require('../src/config/supplierBalance');

const F = V1_BITABLE_SCHEMA.tables;
const PF = {
  ...F.paymentTransaction.fields,
  ...SUPPLIER_BALANCE.transactionFields,
};
const supplier = (id, name) => ({ record_id: id, fields: { [F.supplier.fields.name]: name } });
const init = (name, amount) => ({ record_id: `init_${name}`, fields: { [F.supplierBalanceInit.fields.supplierName]: name, [F.supplierBalanceInit.fields.initialBalance]: amount } });
const tx = (id, name, date, extra = {}) => ({
  record_id: id,
  fields: {
    [PF.supplierName]: name,
    [PF.tradeDate]: date,
    ...extra,
  },
});
const gatewayOf = ({ suppliers = [], inits = [], txs = [] } = {}) => ({
  table: (key) => F[key],
  listAll: async (key) => ({ supplier: suppliers, supplierBalanceInit: inits, paymentTransaction: txs }[key] || []),
});
const serviceOf = (data) => createSupplierBalanceService({
  gateway: gatewayOf(data),
  now: () => Date.parse('2026-11-20T22:00:00+08:00'),
});

const baseSuppliers = [
  supplier('s1', '七匹狼/吉祥鸟'),
  supplier('s2', '一代千金'),
  supplier('s3', '三星'),
  supplier('s4', '恒安利'),
  supplier('s5', '舒美特'),
  supplier('s6', '贵帝'),
];
const baseInits = [
  init('七匹狼/吉祥鸟', 27698), init('一代千金', 9450), init('三星', 0),
  init('恒安利', -60), init('舒美特', 1230), init('贵帝', 0),
];
const baseTxs = [
  tx('p1', '七匹狼/吉祥鸟', '2026-11-20T12:56:47+08:00', {
    [PF.tradeDirection]: '付',
    [PF.transactionAmount]: 20000,
    [PF.latestBalance]: 10430,
  }),
  tx('p2', '七匹狼/吉祥鸟', '2026-11-20T00:00:00+08:00', {
    [PF.behavior]: '入库',
    [PF.goodsAmount]: 2732,
    [PF.latestBalance]: 30430,
  }),
  tx('p3', '一代千金', '2026-11-20T12:57:14+08:00', {
    [PF.tradeDirection]: '付',
    [PF.transactionAmount]: 9450,
    [PF.latestBalance]: 0,
  }),
  tx('p4', '信踏', '2026-11-20T16:58:56+08:00', {
    [PF.behavior]: '入库',
    [PF.goodsAmount]: 790,
    [PF.latestBalance]: 12372,
  }),
  tx('old', '七匹狼/吉祥鸟', '2026-10-01T00:00:00+08:00', {
    [PF.behavior]: '入库',
    [PF.goodsAmount]: 100,
    [PF.latestBalance]: 5000,
  }),
];

test('供应商显示：余额非 0 或最近窗口内有交易', async () => {
  const result = await serviceOf({ suppliers: baseSuppliers, inits: baseInits, txs: baseTxs }).list();
  assert.deepEqual(result.suppliers.map((item) => item.name).sort(), [
    '七匹狼/吉祥鸟', '一代千金', '信踏', '恒安利', '舒美特',
  ].sort());
  assert.equal(result.suppliers.some((item) => item.name === '贵帝'), false, '余额 0 且无交易 ⇒ 不显示');
  assert.equal(result.suppliers.some((item) => item.name === '三星'), false, '余额 0 且无交易 ⇒ 不显示');
  const yidai = result.suppliers.find((item) => item.name === '一代千金');
  assert.equal(yidai.balance, 0);
  assert.equal(yidai.transactions.length, 1, '余额 0 但有最近交易 ⇒ 交易流水仍显示');
});

test('余额来源：有交易取最新交易日最新余额；没有交易取初始化', async () => {
  const result = await serviceOf({ suppliers: baseSuppliers, inits: baseInits, txs: baseTxs }).list();
  const qpl = result.suppliers.find((item) => item.name === '七匹狼/吉祥鸟');
  assert.equal(qpl.balance, 10430, '取 12:56 付款那条，不是 00:00 报货的 30430');
  assert.equal(qpl.transactions[0].type, '付款');
  assert.equal(qpl.transactions[1].type, '报货');
  const xt = result.suppliers.find((item) => item.name === '信踏');
  assert.equal(xt.balance, 12372);
  assert.equal(xt.transactions[0].amount, 790, '报货取货单金额，即使交易额为空');
  const smt = result.suppliers.find((item) => item.name === '舒美特');
  assert.equal(smt.balance, 1230);
});

test('最近 30 天：旧交易不展示，但仍参与最新余额判断', async () => {
  const result = await serviceOf({ suppliers: baseSuppliers, inits: baseInits, txs: baseTxs }).list();
  const qpl = result.suppliers.find((item) => item.name === '七匹狼/吉祥鸟');
  assert.equal(qpl.transactions.length, 2, '10-01 的旧交易不展示');
  assert.equal(qpl.transactions.some((item) => item.recordId === 'old'), false);
});

test('余额 0：最近有交易显示；只有窗口外旧交易不显示', async () => {
  const result = await serviceOf({
    suppliers: [...baseSuppliers, supplier('s7', '最近零余额'), supplier('s8', '旧零余额')],
    inits: [...baseInits],
    txs: [...baseTxs,
      tx('zero', '最近零余额', '2026-11-20T18:00:00+08:00', {
        [PF.behavior]: '入库', [PF.goodsAmount]: 100, [PF.latestBalance]: 0,
      }),
      tx('oldzero', '旧零余额', '2026-09-01T18:00:00+08:00', {
        [PF.behavior]: '入库', [PF.goodsAmount]: 100, [PF.latestBalance]: 0,
      }),
    ],
  }).list();
  assert.equal(result.suppliers.some((item) => item.name === '最近零余额'), true);
  assert.equal(result.suppliers.some((item) => item.name === '旧零余额'), false);
});

test('交易标签：报货/退货看货单金额，付款/收款看交易额', async () => {
  const result = await serviceOf({
    suppliers: baseSuppliers,
    inits: baseInits,
    txs: [...baseTxs,
      tx('ret', '七匹狼/吉祥鸟', '2026-11-18T00:00:00+08:00', {
        [PF.behavior]: '退货',
        [PF.goodsAmount]: 50,
        [PF.latestBalance]: 30380,
      })],
  }).list();
  const qpl = result.suppliers.find((item) => item.name === '七匹狼/吉祥鸟');
  const ret = qpl.transactions.find((item) => item.recordId === 'ret');
  assert.equal(ret.type, '退货');
  assert.equal(ret.amount, 50);
});
