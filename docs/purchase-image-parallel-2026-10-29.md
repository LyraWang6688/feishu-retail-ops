# 采购出图与写表「安全并行」· 2026-10-29

> 业务负责人 2026-10-29 批准 **A 方案（安全并行）**：
> 「把『生成 PNG』提到写表同时开始；写表成功后立刻『上传/发群/回填附件』。」

## 1. 改前 / 改后

**改前（串行）**：`ensurePostingPlan` → 建采购主表 → 建采购明细 → 逐组**渲染 PNG**（`images.render`）→ 发群 → 回填附件。

**改后（A 方案）**：
```
ensurePostingPlan（批次号/供应商分组/明细已在计划里冻结）
  ├─ 并行：prepareSupplierImages（只渲染 PNG，不发送/不回填/不写表）
  └─ 同时：建采购主表 → 建采购明细
写表成功后 → deliverSupplierImages（发群 → 回填附件；优先用已渲染好的 PNG）
```
- **只把"渲染"提前**：发送/回填仍严格在写表成功之后 ⇒ 不会出现「群里先看到、表里没有」；
- 渲染失败 ⇒ `prepare_failed` + 返回 null ⇒ deliver **现场再渲染一次**（逐字退化为今天的行为）；
- **重放不重复渲染**：本地任务已建过批次（`batch_record_id` / status=posted）⇒ 跳过准备阶段，
  由 deliver 既有的「按单据附件跳过」判据处理 ⇒ 保住 AC-SS4「重放 0 张图」的既有判据 ✓。

## 2. 落点

- `server/src/services/purchase/documentImages.js`：新增 `prepareSupplierImages`（按 plan 的供应商分组并行渲染）；`deliverSupplierImagesInner` 支持 `options.preparedImages`（按 `group_key` 取图，取不到才现场渲染）。
- `server/src/services/purchaseWebhookService.js`：`confirmPurchaseRequest` 在计划冻结后启动并行渲染；写表成功后 `await` 结果交给 deliver；新增 facade 委托 `prepareSupplierImages`。
- 新事件：`purchase.request.image.prepared`（含 `group_count` / `generate_ms`）、`purchase.request.image.prepare_failed`。
- 共享件未动：`scanWriteService.js`（冻结件 sha 未变）、出图渲染器/发群/回填附件实现、幂等键与写表逻辑。

## 3. 判据

`server/test/purchaseImageParallel.test.js`：
- **AC-IP1** `prepareSupplierImages` 每组渲染一份、**多组并行**（两组各 60ms，实测 <110ms）、**不发送/不回填/不写表**；
- **AC-IP2** deliver 收到 `preparedImages` ⇒ **不再渲染**，仍按顺序发群 + 回填附件；
- **AC-IP3** 没有 `preparedImages` ⇒ **逐字退化为现场渲染**（今天的行为）。

既有判据全部保留并通过：`purchaseAttachmentTwoSuppliers`（重放不重复上传/附件）、`supplierSplitAtGeneration`（AC-SS4 重放 0 张图）、`purchaseRequestImageService` 等。

## 4. 测试 Base 实测（2026-10-29）

同一脚本（两件不同供应商的货品，走 `procurementPageSubmitService` → 引擎 → 既有写入件）：

| 版本 | 后台总耗时 | 说明 |
| --- | --- | --- |
| 旧（main） | **42.4s** | 写完表后再逐组渲染/发送 |
| 新（本 PR） | **40.6s / 40.9s（两轮）** | 渲染与写表重叠；`image.prepared` generate_ms≈839ms |

新代码时间线（同一单）：`batch_no.generated 00:49:22` → **`image.prepared 00:49:23`（渲染已完成）** → `purchaseOrderBatch created 00:49:26` →
`purchase.request.created 00:49:34` → `group_sent 00:49:39` / `attachment_written 00:49:47` → 第二组发送/回填 00:49:52–00:49:58。
⇒ 渲染确实在写表**期间**完成，且发送/回填仍在写表成功之后（顺序未变）。
测试 Base 写的是既有测试数据（采购主表 `CGD-20261029-0009` 旧版 / `CGD-20261029-0010` 新版），不写生产。

## 5. 边界 / 未做

- 不合并、不部署（等业务负责人指令）；
- 本 PR 只改采购「出图/写表」时序，不碰扫一扫（仍排最低优先级）、不碰销售/退货/验收链路；
- 若以后想把「发群」也提前（B 方案），仍不建议：写表失败会「群里有单、系统无记录」。
