# 扫码销售：尺码库存状态 + 仅样品尺码补样品（2026-11-18）

> 业务负责人口径：货品页显示每个尺码的库存状态；**只有这个尺码的库存记录全是「样品」** 时，点击它弹窗，选同编号下另一个尺码做新样品。销售写库成功后，再把选中的尺码的一双改成样品。

## 1. 页面

- 尺码卡显示：**门盒 / 样品 / 空状态**，不带数量；多状态多个标签。
- 空状态 = 「实时库存.所属状态」为空的记录（不是“没有库存”）。
- 只有 `sample > 0 && 门盒 = 0 && 空状态 = 0` 的尺码带 `data-sample-only="1"`。
- 点击带 `data-sample-only="1"` 的尺码 ⇒ 弹窗；其他状态不弹。
- 候选尺码 = `view.rows.filter(total > 0)`（实时库存表里有记录的尺码）去重，**包含当前尺码**，不看状态。
- 没有候选不弹。
- 多货品单：每个货品页/每一行各自弹；选择写进该行的 `sample_promotion_size`。

## 2. 写库顺序

1. 货品页/资金页把 `sample_promotion_size` 存进会话草稿；
2. 异步销售 worker 写主表/明细/收款/库存；
3. 销售库存扣减成功（`stock.failed = 0`）后，worker 读 `stock.sampleReplacements`；
4. 只对真的扣了样品的行（`sampleConsumedQuantity > 0`）执行补样品；
5. `SamplePromotionService`：
   - 读该货品/该尺码的实时库存；
   - 该尺码已有样品 ⇒ 跳过（幂等）；
   - 否则找一条门盒/空状态记录，改成样品；
   - 写 `STOCK_TO_SAMPLE` 库存流水（变动数量 0）；
   - 作废库存快照；
6. 补样品失败只记 warn / 不影响已成功的销售。

## 3. 复用

- 状态数据来自 `scanPageService` 已有的 `view.rows[].cells`，**零新增飞书读**；
- 补样品复用「库存单双状态调整」的 `gateway.update` + `writeManualLedger`；
- 销售链路沿用既有 payload / worker / delivery，不另写写库路径。

## 4. 文件

- `server/src/config/samplePromotion.js`
- `server/src/views/scanPage/samplePromotion.js`
- `server/src/views/scanPage/paymentBlock.js`
- `server/src/views/scanPageRealm.js`
- `server/src/services/samplePromotionService.js`
- `server/src/services/salesAsyncWorker.js`
- `server/src/services/sales/deliveryStep.js`
- `server/src/services/salesPayload.js`
- `server/src/services/scanWrite/session.js`
- `server/src/services/scanWrite/submitDraft.js`
- `server/src/services/scanWrite/sales.js`

## 5. 测试

- `test/scanSamplePromotionRender.test.js`：标签、仅样品标记、候选 JSON、弹窗脚本语法；
- `test/samplePromotionService.test.js`：门盒/空状态/已有样品/无库存；
- `test/samplePromotionDelivery.test.js`：交付结果带选择；
- `test/salesAsyncWorker.test.js`：销售成功后补样品、失败不影响销售；
- `test/scanSaleZeroAmountFree.test.js`：0 元单 payload 带 `samplePromotionSize`。

## 6. 已知边界

- 按业务口径，**一个尺码正常只有一双样品**；多双样品的例外暂不单独处理（已有样品时补样品会跳过）。
- 当前库存状态只有门盒/样品/空状态；不再有仓库候选。
- 若她选的候选在销售后已无库存，补样品返回 `no_stock`，只记 warn，销售仍成功。
