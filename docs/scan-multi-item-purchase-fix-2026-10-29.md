# 扫码页「一单多货」补货假成功（P0）修复 · 2026-10-29

> 业务负责人 2026-10-29 逐字授权：「**授权解冻 scanWriteService.js，修扫码页一单多货假成功**」。
> 范围（Lead 钉死）：**只改 `multiItemWriters().purchase`**；不改 `purchaseReturn`；不改单货品补货路径；不顺手改别的链路。

## 1. 现象（线上 P0）

扫码页 → 补货 → **一次扫多个货品** → 页面显示「提交成功」，但**采购主表 / 采购明细零写入**。
日志里后台报 `Cannot read properties of undefined (reading 'is_batch')`。

## 2. 根因

```text
multiItemOrderService.submitDraft
  → writer(plan.taskId, plan.payload, { supplierGroups })     // payload 是【扁平】的
  → scanWriteService.multiItemWriters().purchase = (taskId, task) => publishPurchaseRequest(taskId, task)
  → PurchaseWebhookService.confirmPurchaseRequest: `const draft = task.draft`  // ⇒ undefined
  ⇒ 崩溃（HTTP 已先回成功 ⇒ 假成功）
```

单货品补货（`submitReplenish`）没这个问题：它**自己先建/更新本地 task**（`{task_id, kind:'scan_replenish',
status:'posting', draft}`）再调 `publishPurchaseRequest(taskId, task)` —— 所以修法就是让多货品写入件与它同形。

## 3. 改法（只动一个写入件）

`server/src/services/scanWriteService.js` · `multiItemWriters().purchase`：

```js
purchase: async (taskId, payload, options = {}) => {
  const draft = payload && typeof payload === 'object' ? payload : {};
  const existing = await purchaseStore.get(taskId).catch(() => null);
  const task = existing
    ? await purchaseStore.update(taskId, (current) => ({ ...current, draft }))
    : await purchaseStore.create({ task_id: taskId, kind: 'scan_replenish', status: 'posting', draft });
  return purchase().publishPurchaseRequest(taskId, task, {
    supplierGroups: Array.isArray(options.supplierGroups) ? options.supplierGroups : null,
  });
},
```

- `purchaseReturn`（原样收 draft）**一个字没动**；单货品补货路径没动；没有新开写库路径（写表仍在 `purchaseWebhookService`）。
- 冻结台账已更新（见 §5）。

## 4. 判据与证据

**回归测试**（能真红）：`server/test/scanMultiItemPurchaseWriter.test.js`
- `AC-SMF1` 写入件交给 publisher 的**必须是 `task.draft`**（本地 task 真的建了；`supplierGroups` 原样透传）；
- `AC-SMF2` 同 task 重放 ⇒ 复用/更新同一条本地任务（不新建）；
- `AC-SMF3` 反向探针：扁平 payload 直接当 task ⇒ **必须**抛 `is_batch`（改回旧形状 ⇒ SMF1 立刻红）；
- `AC-SMF4` 引擎真跑（≥2 货品）：publisher 收到 `task.draft.is_batch === true`、明细行数对；同键重放 `reused` 且不重复写；
- `AC-SMF5` `purchaseReturn` 未改（仍原样收 draft）。

**测试 Base 真写验证**（可跳过，CI 无凭证）：`server/test/realbase/scanMultiItemReplenishWrite.test.js`
- 2026-10-29 实跑结果：提交成功 → **采购主表 +1（`CGD-20261029-0003`，record `reczz28T1BcxkmB4`）**、
  **采购明细 +2**（`TB1326082|米色|B` 尺码 34 × 1；`TB1326081|黑色|A` 尺码 41 × 2）、同键重放 `reused` 且数量不变；
- 入口：`FEISHU_TARGET_ENV=test node --test --test-concurrency=1 test/realbase/scanMultiItemReplenishWrite.test.js`
  （缺测试 Base 凭证 ⇒ 明确 skip，不算通过）。

## 5. 冻结台账（`test/scanWriteServiceFrozen.test.js`）

- 改前逐字：sha `561d1fe9ea37822a6046268fcb1a6ae2609bfe0c4979f67414d2c50e04be3e12`（1728 行）
- 改后逐字：sha `efaf1b17aa1d082548892249883a1d8a9f1f7afe539f5f9f72a213063526a219`（1732 行）
- 依据 = 业务负责人 2026-10-29「授权解冻 scanWriteService.js，修扫码页一单多货假成功」
- 同时更新 `FROZEN_SHA256` / `FROZEN_LINES`，以及 `test/saleWriteBackgroundExtract.test.js` 的**登记行数**（1728 → 1732）。

## 6. 未做 / 边界

- 未合并、未部署（等业务负责人指令）；
- 只修「扫码页 → 补货 → 一单多货」这一条；退货 / 单货品 / 验收 / 销售**均未改**；
- 线上是否有人这样用（一次扫多个货品补货）未在真机复验 —— 本条是**逻辑级**修复 + 测试 Base 真写证据。
