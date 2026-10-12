/**
 * `real-paths.mjs` 的**依赖装载器**（单独一个 CJS 文件的原因只有一个）：
 * `config/v1BitableSchema.js` 的表 ID 是**模块级求值** ⇒ `dotenv` 必须**先**加载完。
 * `.mjs` 里先 `require('dotenv').config(...)`，再 require 本文件 —— 顺序就锁在这里。
 */
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SalesProgressService } = require('../src/services/salesProgressService');
const { PaymentService } = require('../src/services/paymentService');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { InventoryService } = require('../src/services/inventoryService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

module.exports = {
  V1_BITABLE_SCHEMA, V1BitableGateway, linkedRecordIds, textValue,
  createScanPageService, createScanWriteService, createScanSessionService,
  SalesDeliveryService, SalesFollowupService, SalesProgressService, PaymentService,
  AfterSalesService, InventoryService, PurchaseOrderBatchService, JsonTaskStore,
  SCAN_PAGE, SCAN_WRITE,
};
