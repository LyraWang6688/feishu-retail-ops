# 采购明细读 1254607 加固（2026-11-18）

> 采购补货 job 在写明细前整表读 `purchaseRequest`，遇到 `1254607 Data not ready` 只重试 2 次即失败；当时批次头已创建、明细未写。

## 改动

- 新增 `config/purchaseRequestReadRetry.js`：6 次、1s 起、2 倍、封顶 15s；
- `readPurchaseRequestsForBatch`：按「报货批次号」条件读当前批次，失败才回退整表；
- `purchaseWebhookService`、`purchaseDetailId`、`purchasePendingBatchService`、`purchaseQueryService` 全部使用该配置；
- 写库幂等与明细 ID 取号判据不变。

## 测试

- `purchaseRequestReadRetry.test.js`
- 全量：`2582 tests / 2581 pass / 0 fail / 1 skip`

## 边界

修复只影响之后的采购补货；已产生的 `bb8a...` 半截批次仍需按任务续跑补齐明细，不能重新提交新批次。
