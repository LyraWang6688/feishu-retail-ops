> **归档说明（2026-10-06 清理任务）**：本文件原为 worktree `/private/tmp/schema-fix` 根目录下的未跟踪交接笔记
> `.HANDOFF-裁决-到货退场与退货嫁接.md`。按业务负责人「把有价值的交接笔记收进 docs/、其余连同 worktree 一起清掉」的要求收录，
> **正文一字未改**（仅加本段归档说明）。
>
> ⚠️ 它是**当时的交接记录，不是当前口径**；当前口径以 [AGENTS.md](../../AGENTS.md) 与 [docs/README.md](../README.md) 第 1 节为准。

# 父代理裁决（**这三件都是产品口径，业务负责人早已定过** ✓）—— 继续解冲突 ✓

你停得对 ✓（发现 dry-run 之外的冲突就停 ✓ 这是我要的纪律 ✓）。三件的答案如下，**都来自业务负责人的原话**，不是我的技术偏好 ✓。

## ① `kind === 'arrival'` 现在该做什么？ → **什么都不做** ✓
业务负责人原话（今天 20:0x）：
> 「我们现在采购**就没有"到货"这个环节了**……**我们不再采用拍鞋盒或拍照片的形式**，
>  而是**直接核对我的采购申请，并在采购申请的基础上进行修改**」
→ ⇒ **#86 的做法是对的** ✓：**入口从 `larkEvents.js` 摘掉** ✓ ＋ **`processArrival` 等识别方法删掉** ✓
→ ⇒ ⚠️ **而 #83 的 `else → processArrival` 必须去掉** ✗
   （它会让 #86 的退场失效 ✓ 而且 `processArrival` 已经不存在了 ✓）
→ **正解** = 保留 #83 的**行为分流**，但把"非退货"交给 **#86 的归批分派**：
```
const behaviorKind = await this.readReportBehaviorKind(recordId);      // ← #83 的
if (behaviorKind === REPORT_BEHAVIOR.PURCHASE_RETURN) {
  result = await this.processSupplierReturn(recordId, taskId, task);   // ← #83 的退货独占链
} else {
  // ← #86 的分派：报货走归批；**没有 processArrival 这条路了** ✗
  const batchNo = await this.readReportBatchNo(recordId);
  result = batchNo ? await this.handleReportBatch(...) : await this.processSupplierReport(...);
}
```

## ② #83 的采购退货 → **必须保住** ✓
那是业务负责人今天要的功能 ✓（《业务规范·采购退货》已写 ✓）
→ **嫁接方式就是你说的** ✓：把 #83 的 `readReportBehaviorKind` + `processSupplierReturn`（+ `ensureReturnPlan` /
  `planPurchaseReturn` 等）嫁接到 #86 的归批分派上 ✓
→ ⚠️ **`MOVEMENT_PURCHASE_DECREASE` 必须留** ✗（退货扣库存要用 ✓ 见你指出的第 1792 行 ✓）
→ ⚠️ **imports 那处 hunk**：**去掉 `purchaseArrivalDetailCard`** ✓ ＋ **加上 `MOVEMENT_PURCHASE_DECREASE`** ✓
   （你自己发现的那个坑很关键 ✓ —— 盲取 theirs 会 `is not a function` ✗ 记你一功 ✓）

## ③ `test.js` / `index.js` 口径
- `test/purchaseWebhookService.test.js`：
  · ✅ **留 #85 的那 5 条群聊用例** ✓
  · ❌ **丢掉 11 条针对"到货识别/建档/成本"的用例** ✓（**它们测的行为已退场** ✓）
    → ⚠️ 若某条里混着**仍然有效的能力断言**（例如"建档幂等"✗）→ **改写保留那半** ✓ 别整条丢 ✓
  · ⚠️ **每一条你丢的/改的，在汇报里逐条说明** ✓
- `public/workbench/features/purchase/index.js`：
  · ✅ 取 **#83 的「供应商对接」** ✓
  · ✅ 取 **#86 的「登记到货与验收情况」/「到货登记」** ✓
  · ⚠️ **"到货识别"字样从副标题去掉** ✓ —— 因为**识别真的退场了** ✓（业务负责人已定 ✓）

## ⚠️ 执行纪律（重申）
- **同文件绝不能并行** ✓ —— `purchaseWebhookService.js` 现在就你一个人动 ✓
- **不合并不部署** ✓ · 不 force push ✗ · 不 stash ✗ · 只 `git add` 显式路径 ✓
- 🔴 **绝对禁止部署**（业务负责人正在录单，原话「**严禁你自主部署！**」）✗
- 解完 **`node --test --test-concurrency=1` 连跑 2 次，`fail` 必须 = 0** ✓
  ⚠️ 数字别拿 477 或 552 当标准 ✗（#86 删了一批 · #83/#85 加了一批 ✓ 只盯 fail=0 ✓）
  ⚠️ 尤其 `purchaseWebhookService.js` **现在是 delete-vs-modify** ✗ —— 全仓最高风险点 ✓
- **每个冲突 hunk 的解法国写进汇报** ✓（我要能复核 ✓）
- 若再冒出**超出这三件口径**的判断 ✗ → **停，报我** ✓（别自己拍 ✓）
