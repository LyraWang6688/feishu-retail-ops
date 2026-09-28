// One-shot real-Feishu inventory verification. Writes records only to the
// dedicated test Base supplied by the user; never changes table/field schema.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { relation } = require('../src/services/v1ReferenceResolver');

const TEST_APP_TOKEN = process.env.FEISHU_V1_E2E_TEST_APP_TOKEN;
const PRODUCT_ID = process.env.FEISHU_V1_E2E_PRODUCT_RECORD_ID;
const SIZE = Number(process.env.FEISHU_V1_E2E_SIZE);
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isDataNotReady = (error) => [error?.code, error?.response?.data?.code,
  error?.cause?.response?.data?.code].some((code) => Number(code) === 1254607) ||
  /\b1254607\b/.test(String(error?.message || ''));

async function until(check, label, { attempts = 12, pause = wait } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (!isDataNotReady(error)) throw error;
    }
    if (attempt + 1 < attempts) await pause(1000);
  }
  throw new Error(`${label} 在 ${attempts} 次尝试后未能读回；保留已创建记录以便人工核对`);
}

async function main() {
  assert.ok(TEST_APP_TOKEN, '必须显式配置测试 Base 标识');
  assert.equal(String(process.env.FEISHU_TARGET_ENV || '').trim().toLowerCase(), 'test',
    '端到端测试必须显式声明 FEISHU_TARGET_ENV=test');
  assert.equal(V1_BITABLE_SCHEMA.appToken, TEST_APP_TOKEN, '拒绝连接非指定测试 Base');
  assert.ok(PRODUCT_ID && process.env.FEISHU_V1_E2E_ITEM_NO, '必须指定测试货品');
  assert.ok(Number.isSafeInteger(SIZE) && SIZE > 0, '测试尺码必须是正整数');
  const requiredTables = {
    product: 'FEISHU_V1_PRODUCT_TABLE_ID', behavior: 'FEISHU_V1_BEHAVIOR_TABLE_ID',
    sizeManagement: 'FEISHU_V1_SIZE_TABLE_ID', salesEntry: 'FEISHU_V1_SALES_ENTRY_TABLE_ID',
    salesDetail: 'FEISHU_V1_SALES_DETAIL_TABLE_ID', purchaseInbound: 'FEISHU_V1_PURCHASE_INBOUND_TABLE_ID',
    inventoryLedger: 'FEISHU_V1_INVENTORY_LEDGER_TABLE_ID', liveInventory: 'FEISHU_V1_LIVE_INVENTORY_TABLE_ID',
  };
  for (const [key, envName] of Object.entries(requiredTables)) {
    assert.ok(process.env[envName], `测试表缺少显式配置：${envName}`);
    assert.equal(V1_BITABLE_SCHEMA.tables[key].tableId, process.env[envName],
      `测试表配置不一致：${key}`);
  }
  const client = new lark.Client({ appId: process.env.LARK_AGENT_APP_ID,
    appSecret: process.env.LARK_AGENT_APP_SECRET, logger: silentLogger });
  const gateway = new V1BitableGateway({ client });
  const store = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-e2e-')),
    idField: 'operation_id' });
  const inventory = new InventoryService({ gateway, store });
  await gateway.validateTables(Object.keys(requiredTables));
  await inventory.ensureSchema();
  await inventory.sizeReferences.validateSchema(['salesDetail', 'purchaseInbound']);
  await inventory.validateStockBehaviors();
  const product = await gateway.get('product', PRODUCT_ID);
  assert.equal(textValue(product.fields?.['货号']), process.env.FEISHU_V1_E2E_ITEM_NO);
  const size = await inventory.sizeReferences.resolveByNumber(SIZE);
  assert.equal((await inventory.findLiveInventory(PRODUCT_ID, SIZE, '门盒')).length, 0,
    '所选测试货品已有 34 码门盒库存，停止以避免误扣');
  assert.equal((await inventory.findLiveInventory(PRODUCT_ID, SIZE, '样品')).length, 0,
    '所选测试货品已有 34 码样品库存，停止以避免误扣');
  const inboundBehavior = (await gateway.listAll('behavior')).find((record) =>
    textValue(record.fields?.['行为名称']) === '采购入库');
  assert.ok(inboundBehavior, '测试 Base 缺少采购入库行为');

  const marker = `CODEX-INV-E2E-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const inbound = await gateway.create('purchaseInbound', {
    product: relation(PRODUCT_ID), size: relation(size.recordId), quantity: 1,
    behavior: relation(inboundBehavior.record_id),
  });
  console.log('test_marker', marker, 'purchase_inbound', inbound.recordId);
  const purchase = await inventory.applyPurchase({ purchaseInboundRecordId: inbound.recordId,
    productRecordId: PRODUCT_ID, size: SIZE, quantity: 1, state: '门盒' });
  assert.equal((await inventory.applyPurchase({ purchaseInboundRecordId: inbound.recordId,
    productRecordId: PRODUCT_ID, size: SIZE, quantity: 1, state: '门盒' })).ledgerRecordId,
  purchase.ledgerRecordId);
  const purchasedLive = await until(async () => {
    const record = await gateway.get('liveInventory', purchase.liveRecordIds[0]);
    return linkedRecordIds(record.fields?.['尺码']).includes(size.recordId) ? record : null;
  }, '采购入库后的实时库存');
  assert.ok(linkedRecordIds(purchasedLive.fields?.['编号']).includes(PRODUCT_ID));
  const purchaseLedger = await until(async () => {
    const record = await gateway.get('inventoryLedger', purchase.ledgerRecordId);
    return linkedRecordIds(record?.fields?.['尺码']).includes(size.recordId) &&
      linkedRecordIds(record?.fields?.['关联采购']).includes(inbound.recordId) ? record : null;
  }, '采购库存流水');
  assert.ok(linkedRecordIds(purchaseLedger.fields?.['尺码']).includes(size.recordId));
  assert.ok(linkedRecordIds(purchaseLedger.fields?.['关联采购']).includes(inbound.recordId));

  await until(async () => (await inventory.findLiveInventory(PRODUCT_ID, SIZE, '门盒'))
    .some((record) => record.record_id === purchasedLive.record_id), '采购库存列表同步');
  const order = await gateway.create('salesEntry', {
    originalText: `${marker} 库存端到端测试，非真实交易`,
  });
  console.log('sales_entry', order.recordId);
  const detail = await gateway.create('salesDetail', {
    salesEntry: relation(order.recordId), product: relation(PRODUCT_ID),
    size: relation(size.recordId), actualAmount: 1, fulfillmentStatus: '未交付',
  });
  console.log('sales_detail', detail.recordId);
  const sale = await inventory.applySale({ salesDetailRecordId: detail.recordId,
    productRecordId: PRODUCT_ID, size: SIZE, quantity: 1 });
  assert.equal((await inventory.applySale({ salesDetailRecordId: detail.recordId,
    productRecordId: PRODUCT_ID, size: SIZE, quantity: 1 })).ledgerRecordId,
  sale.ledgerRecordId);
  assert.deepEqual(sale.liveRecordIds, [purchasedLive.record_id]);
  const saleLedger = await until(async () => {
    const record = await gateway.get('inventoryLedger', sale.ledgerRecordId);
    return linkedRecordIds(record?.fields?.['尺码']).includes(size.recordId) &&
      linkedRecordIds(record?.fields?.['关联销售']).includes(detail.recordId) ? record : null;
  }, '销售库存流水');
  assert.ok(linkedRecordIds(saleLedger.fields?.['尺码']).includes(size.recordId));
  assert.ok(linkedRecordIds(saleLedger.fields?.['关联销售']).includes(detail.recordId));
  await until(async () => (await inventory.findLiveInventory(PRODUCT_ID, SIZE, '门盒')).length === 0,
    '销售扣库后的实时库存');
  await gateway.update('salesDetail', detail.recordId, { fulfillmentStatus: '已交付' });
  console.log(JSON.stringify({ result: 'passed', marker, purchaseInboundRecordId: inbound.recordId,
    purchaseLedgerRecordId: purchase.ledgerRecordId, salesEntryRecordId: order.recordId,
    salesDetailRecordId: detail.recordId, salesLedgerRecordId: sale.ledgerRecordId,
    consumedLiveRecordId: purchasedLive.record_id }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('inventory_e2e_failed', error.message);
    process.exitCode = 1;
  });
}

module.exports = { until, isDataNotReady };
