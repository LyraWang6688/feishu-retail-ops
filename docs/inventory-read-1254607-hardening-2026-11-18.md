# 库存读 1254607 加固（2026-11-18）

> 近期连续出现飞书 `1254607 Data not ready`：库存调整读 `liveInventory`、销售扣库存读 `inventoryLedger` 失败，造成操作部分写入或误报失败。

## 1. 重试

新增 `config/inventoryReadRetry.js`：

```js
{ maxRetries: 5, baseDelayMs: 1000, factor: 2, maxDelayMs: 15000 }
```

用于库存关键读，不再使用网关默认的 2 次 / 300ms。

## 2. 精确读

- `liveInventory`：按货品 `readLiveInventoryForProduct`；
- `inventoryLedger`：按来源字段 `listByFilter`；
- 不支持 filter 或条件读失败时回退整表；
- 重复流水 / 重复库存判据不放宽。

## 3. 覆盖

- `inventory/liveStock.js`
- `inventory/ledger.js`
- `inventory/saleBatch.js`
- `inventory/purchaseBatch.js`
- `inventory/purchaseReturnBatch.js`
- `inventoryPairAdjustmentService.js`
- `purchaseReturnService.js`
- `purchaseAcceptanceSampleService.js`

## 4. 测试

- `inventoryReadRetry.test.js`
- 更新 `inventorySaleBatchWrite.test.js` / `inventoryReturnBatchWrite.test.js` 的精确读哨兵

## 5. 边界

这次只改读层；历史部分失败单（如 35730 / 0015）仍需单独恢复，不能直接整单重做。
