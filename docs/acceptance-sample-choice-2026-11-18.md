# 采购验收：本次入库尺码选样品（2026-11-18）

> 业务负责人：点击「确认到货并入库」后，按本次实际到货数量弹窗；**编号无库存，或已有库存但没有样品时，必须为每个编号选一个本次入库尺码做样品**。已有样品不弹，全部门盒。

## 1. 触发

- 点击「确认到货并入库」；
- 前端先做既有金额 / 数量 / 明细校验；
- 用 `arrivalSubmitLines()` 的结果（**数量 0 不提交**）判断候选；
- 只对 `needs_sample_choice = true` 的编号弹；
- 没有需要选的编号 ⇒ 直接提交。

## 2. 弹窗

- **一个弹窗分产品**，不是每产品各弹一次；
- 每个产品列出**本次到货数量 > 0** 的尺码；
- 每个产品必须选一个尺码；
- 全部选完才能点「确认入库」；
- 取消 = 回验收页，不提交。

## 3. 判断口径

后端在验收明细接口一次读实时库存，按编号返回：

- `has_stock`：有没有任何实时库存记录；
- `has_sample`：有没有「样品」记录；
- `needs_sample_choice = !has_sample`。

所以：

- 无库存 ⇒ 需要选；
- 有库存但无样品 ⇒ 需要选；
- 已有样品 ⇒ 不需要选。

## 4. 入库状态

- 选中尺码：第一双「样品」，其余「门盒」；
- 其他入库尺码：全部「门盒」；
- 该编号已有样品：忽略选择，全部门盒；
- 复用 `inboundStatesFor` / `applyPurchaseBatch`，不新写状态机。

## 5. 幂等与校验

- 选择存进既有验收会话 `sample_choices`；
- 选择变化 ⇒ `submit_round` 增加 ⇒ 新 submitKey；
- 后端复核：需要选但缺失 / 选了不在本次入库尺码 ⇒ 400 + 人话 + 零写入 + 不排后台；
- 旧页面不带 `sampleChoices` 字段 ⇒ 后端沿用原有自动规则（兼容）。

## 6. 文件

- `server/public/workbench/features/orders/sampleChoice.js`
- `server/public/workbench/features/orders/acceptanceDoc.js`
- `server/public/workbench/features/orders/index.js`
- `server/src/services/purchaseAcceptanceSampleService.js`
- `server/src/services/scanArrival/setScans.js`
- `server/src/services/purchaseArrivalConversationService.js`
- `server/src/services/inventory/purchaseBatch.js`
- `server/src/services/inventoryService.js`
- `server/src/routes/workbench/purchase.js`

## 7. 测试

- `test/purchaseAcceptanceSampleState.test.js`
- `test/sampleChoiceFrontend.test.js`
- `test/workbenchArrivalSetScans.test.js`（明细标志 / 缺选择 400 / 选了才排后台）
- `test/acceptInventoryBatchWrite.test.js`（指定尺码的状态分配）
