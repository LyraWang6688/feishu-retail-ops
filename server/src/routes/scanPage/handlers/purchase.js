'use strict';
// ⭐⭐ 2026-10-29：提交成功 = 统一 toast 共用件（与销售/多货同一份实现）。
const { redirectWithSubmitToast } = require('../../../utils/submitToast');

/**
 * 扫码路由核心深拆 P0：补货 / 退货两个提交分支（从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 * 调用方只传显式 ctx（不再读路由闭包）；分支体逐字搬移，调用顺序/日志/文案/状态一个未动。
 */

async function handleReplenish(ctx) {
  const { action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, parseReplenishEntries, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure } = ctx;
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const entries = parseReplenishEntries(body, fields, writeConfig);
        // ⭐⭐ 2026-10-14 晚：**整单金额必填**（补货 / 退货**同一个**闸门 —— 见
        //   `purchaseAmountMissingPage`）。空 ⇒ 400 + 人话 + **一个字都不写** ✓；
        //   非空 ⇒ 照旧往下走 ✓。
        // ⭐⭐ 2026-10-15（③ 写入）：**不是数字**也当场拦（见 `purchaseAmountInvalidPage`）——
        //   那个数要落**数字列**，放过去就是"页面填了、表里没有" = 假成功 ✗。
        // ⭐⭐ 2026-10-15 **她当次裁决（已不再"待裁"）**：**补货这一条不写金额** ——
        //   她原话：「退货批次的整单金额 ⇒ 写进「发生金额」，**补货不会写金额**，
        //           **只有到货的时候才会写金额**，也是写进发生金额里」
        //   ⇒ 这一列（「发生金额」）在本条链路上的**写入者只有"到货核对"那一个** ——
        //     她 2026-10-08 的口径也印证：「发生金额 = **这一次供应商的金额**」✓
        //     ⇒ **补货（报货）不许插一脚** ✗（否则同一格两个写入者会互相静默覆盖）。
        //   为什么（2026-10-15 只读核出来的事实，留在这里，下一个接棒的人不必再核一遍）：
        //   · 补货（报货）的批次行由**报货那条链路**的 `confirmPurchaseRequest`（建「报货批次」行那一处；
        //     那里的注释逐字：「她走的两条入口（供应商报单 webhook / 扫码页补货）都汇到这一处建行点」）
        //     （`origin/main` 的 `:1603`）建，**显式写 `arrivalStatus = 未到货`** ⇒ 这条批次**会**进到货验收清单
        //     （`purchasePendingBatchService` 按 `到货状态 = 未到货` 过滤）；
        //   · ⇒ 她之后**到货核对**填的「发生金额」会经 `purchaseOrderBatchService.writeAcceptance`
        //     （那里的 `:331` 起）**写同一行的同一列**，而且**没有"已有值不覆盖"的保护**；
        //   · ⇒ 所以**补货这一侧一个字都不写** ✓（她的裁决 + 上面这条技术事实**指向同一个结论**）。
        //   ⚠️ **退货那条不打架、已经写了**（退货批次建行时不写「到货状态」⇒ 不进到货清单 ⇒ 独占该列）：
        //     见下面的退货分支 + `purchaseReturnService` 的 `writeOrderAmount` 调用点。
        //   ⚠️ 这段注释**刻意不写**那个 service 的名字 —— `routes/*` 有一条既有哨兵
        //     （`test/scanPage.test.js` ④「路由里不许出现写链路的服务」）会扫源码；按它的判据走，
        //     **不放宽它** ✓（只改我这句注释的措辞）。
        // ⭐⭐ 2026-10-16（A2/A3 接线）：**把"当前是哪条链路"传进闸门** ⇒ 按 `requiredByRealm.replenish`
        //   取档 —— 她 2026-10-16 逐字「**补货不问金额**」⇒ 那一档是 `false` ⇒ **补货这条不再要求金额** ✓
        //   （**改前逐字**：`if (purchaseAmountMissing(body)) …` ＝ 与退货共用"一个开关" ⇒ 补货也被拦 ✗）。
        //   ⚠️ 这里**逐字传档位键 `'replenish'`**（＝ `PURCHASE_AMOUNT.requiredByRealm` 的键名 ✓），
        //     **不是**页面领域 id（那个恰好同名，但**别指望**它是同一个概念 —— 见下面退货那处）。
        if (purchaseAmountMissing(body, 'replenish')) return purchaseAmountMissingPage(req, res, requestId, realm);
        if (purchaseAmountInvalid(body, 'replenish')) return purchaseAmountInvalidPage(req, res, requestId, realm);
        // ⭐⭐ 2026-10-16（口子收尾 · 她**逐字**：「**异步只针对"写库"**；校验必须**当场同步拦**」）：
        //   **尺码 / 数量 / 空单**这三类**也留在同步路径**（与上面两道金额闸门**同形** ✓）——
        //   命中 ⇒ **400 + 写层那一句人话 + 零写入 + 一次后台都不排** ✓（见 `purchaseEntryInvalidPage`）。
        //   🔴 判据**只有一份真源**：`config/scanPurchaseEntryRules.js`（== 写层
        //     `services/scanWriteService.js:1397-1426` 那一段，**逐字同源**）⇒ 本文件**不手抄 if-else** ✗。
        //   🔴 位置**必须在 `schedulePurchaseWrite(…)` 之前**：先排后台再校验 = 把"她填错了"
        //     变成"看起来成功" ✗（她最恨的那条；也是 AC-ASY2 的精神 ✓）。
        const replenishViolation = purchaseEntryViolation({ chain: 'replenish', entries });
        if (replenishViolation) {
          return purchaseEntryInvalidPage(req, res, requestId, realm, replenishViolation);
        }
        // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线 · 她 2026-10-16 逐字）：
        //   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」
        //   ⇒ **金额 / 单号认不出**仍留在**同步路径**（上面两道闸门 + 上面的 `notFoundPage`），
        //     **写库那一步**丢给后台那一跑 ⇒ 她**先拿到成功页** ✓
        //   🔴 顺序不能反：先排后台再校验 = 把"她填错了"变成"看起来成功" ✗（她最恨的那条）。
        const disabledError = purchaseWriteDisabledError(writeConfig.replenish, writeConfig.texts);
        if (disabledError) return respondWriteFailure(res, disabledError, requestId);
        // ⭐⭐ 2026-10-16（task-59 · 路由半）：**一单多货品**（补货）。
        //   · 隐藏字段 `multi_items` 渲的是【**首件**（= 当前这一款）+ `entries: []`】——
        //     渲染半逐字注明「`entries` 由路由在提交时合并」⇒ 这里把**本次表单**的尺码/数量
        //     **合并进首件**（`mergeFirstItemEntries`：**赋值**语义 ⇒ 只生效一次，数量**不会翻倍** ✓）；
        //   · 🔴 **`≤1` 组 ⇒ 一个字都不变**：不碰引擎、不碰参数，照旧走下面那条老路径 ✓
        //     （「N=1 与旧路径逐字等价」靠**代码路径同一条**成立，不是在引擎里凑形状 ✗）。
        const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
        if (groups.length > 1) {
          return submitMultiItemOrder({
            req, res, requestId, chain: 'replenish', groups,
            // ⚠️ 原值 `actions.submitReplenish` 在配置里不存在（恒 undefined）⇒ realmOfAction 永远拿不到；
            //    搬移时按真实动作名修正（`submitMultiItemOrder` 用它记"最近领域"）。
            action: writeConfig.actions.replenish,
          });
        }
        // 🔴 **同一把 `submitKey` 原样透传**（幂等责任在写层：本文件不拼、不加后缀 ✗）
        const replenishSubmitKey = body[fields.submitKey];
        schedulePurchaseWrite({
          chain: 'replenish',
          requestId,
          submitKey: replenishSubmitKey,
          context: { openId, requestId, number: view.number },
          // ⚠️ 只给**写层要的那几个实参**（`requestId` / `submitKey` 由 `runRest` 原样带上 ✓）
          restInput: {
            openId,
            productRecordId: view.product_record_id,
            number: view.number,
            entries,
          },
        });
        // ⭐ 补货报单**已经收下**（后台接着写）⇒ 同样失效快照（她点名了「补货」也要；这一步不动库存，
        //    但"写完就失效"永远比"猜它动没动库存"安全）。
        invalidateInventorySnapshot(requestId, 'scan_replenish_submitted');
        markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.replenish));
        // ⭐⭐ 2026-10-29（业务负责人：「数据提交成功，后台自动写入，统一都是这个」＋「以后就没有成功页了」）：
        //   提交收下 ⇒ **303 回工作台 + 统一 toast**（共用件 `utils/submitToast.js`；
        //   文案唯一真源 = `config/submitToast.js`）。本文件不写中文、不拼 URL ✗。
        //   ⚠️ 批次号 / 明细数这一刻还没有（后台那一跑才取号）⇒ 回执**不许**承诺它们 ✗
        //     （真失败仍有出口：后台件的 warn ＋ 会话 `last_error` ⇒ 可查、可重试 ✓）。
        return redirectWithSubmitToast(res, {});
}

async function handlePurchaseReturn(ctx) {
  const { action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite, service, submitMultiItemOrder, writeConfig, parseReturnEntries, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure } = ctx;
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const entries = parseReturnEntries(body, fields, writeConfig);
        // ⭐⭐ 2026-10-14 晚（她逐字）：「**退货整单金额（必填），与补货同一套配置**」
        //   ⇒ 与补货**同一个**闸门（一套配置 ✓ 不写两套 ✗）：空 ⇒ 400 + 人话 + **零写入** ✓；
        //     ⭐ 2026-10-15：**不是数字**也拦（要落数字列 ⇒ 不许假成功 ✗）。
        // ⭐⭐ 2026-10-16（A2/A3 接线）：**传链路** ⇒ 按 `requiredByRealm.return` 取档 —— 她 2026-10-14
        //   「退货整单金额（必填）」＋ 2026-10-16「补货不问金额」⇒ **退货这一档仍是 `true`** ⇒
        //   空 / 非数字**照旧 400 + 人话 + 零写入** ✓（**她的口径：退货不受影响** ✓ 判据一个字没放宽 ✗）。
        //   ⚠️ **逐字传档位键 `'return'`** —— ⚠️ **不是** `'purchase_return'`（那是页面的领域 id，
        //     `views/scanPageRealm.js` 的 `PURCHASE_RETURN_REALM`）★ 两者**故意不同名**：
        //     档位键由 `config/scanWrite.js` 的三个 `readFlag`（`…_REPLENISH` / `…_RETURN` / `…_ACCEPT`）决定。
        //     传错 = 拿错档位（`requiredByRealm['purchase_return']` 是 `undefined` ⇒ 会退化成"要金额"）
        //     ⇒ 判据 `test/purchaseAmountRealmWiring.test.js` 的 AC-PAWIRE2 **逐字**钉住这两处 ✓。
        if (purchaseAmountMissing(body, 'return')) return purchaseAmountMissingPage(req, res, requestId, realm);
        if (purchaseAmountInvalid(body, 'return')) return purchaseAmountInvalidPage(req, res, requestId, realm);
        // ⭐⭐ 2026-10-16（口子收尾）：与补货那条**同形** —— **尺码 / 数量 / 空单**也在这里当场拦
        //   （判据同一份真源 `config/scanPurchaseEntryRules.js` == 写层
        //    `services/scanWriteService.js:1556-1585`，逐字同源 ✓）。
        //   🔴 同样**必须在 `schedulePurchaseWrite(…)` 之前**：命中 ⇒ 400 + 写层那一句人话
        //     ＋ **零写入** ＋ **一次后台都不排** ✓。
        const returnViolation = purchaseEntryViolation({ chain: 'purchase_return', entries });
        if (returnViolation) {
          return purchaseEntryInvalidPage(req, res, requestId, realm, returnViolation);
        }
        // ⭐⭐ 2026-10-15 **③ 写入已落地**（她裁决 ⓐ「复用「发生金额」」）——
        //   改前逐字：`// TODO(purchase-amount): 金额**还没落表** —— 落哪一列**待她裁决**（同上，
        //             采购明细没有金额列、「发生金额」已被"到货核对"占用）⇒ 不自己挑列写 ✗。`
        //   改后逐字：**TODO 删掉**，改成下面这一句 + 把金额透传给既有写服务：
        //     `orderAmount: String(body[fields.purchaseAmount] ?? '').trim(),`
        //   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
        //     （落点 = `purchaseOrderBatch.actualAmount`）；⚠️ **退货这条独占该列**（只读核过：
        //     退货批次建行时不写「到货状态」⇒ 不进到货清单 ⇒ 不会被到货核对覆盖）✓
        //   ⚠️ 写库仍在**既有**构件里：`scanWriteService.submitPurchaseReturn` → `purchaseReturnService`
        //     → `purchaseOrderBatchService.writeOrderAmount`（**不新开写库路径** ✗）；
        //     同一把 `submitKey` 幂等（批次行只建一条、金额是同一个值 ⇒ 不累加）✓
        // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）：与补货那条**同形** —— **金额 / 单号认出与否**
        //   留在这里（同步 ✗）、**写库丢给后台那一跑**（她先拿到统一成功页 ✓）。
        const disabledError = purchaseWriteDisabledError(writeConfig.purchaseReturn, writeConfig.texts);
        if (disabledError) return respondWriteFailure(res, disabledError, requestId);
        // ⭐⭐ 2026-10-16（task-59 · 路由半）：**一单多货品**（退货）—— 与补货那条**同形** ✓
        //   · 首件 = 当前这一款，`entries` 由这里合并进去（**只合并一次** ✓ 见 `mergeFirstItemEntries`）；
        //   · 🔴 **整单金额**（退货必填）由 `submitMultiItemOrder` 写进草稿 `order_amount`
        //     —— 空 / 非数字**上面已经同步拦过**（400 + 人话 + 零写入 ✓），这里不重复判 ✗；
        //   · 🔴 **超库存**：本刀**不传**引擎的 `stockView` ⇒ 逐行"退能退的"仍由**既有写入件**
        //     落地（与今天 N=1 同一条通路 ✓）；差额照旧只在写入件返回值 / 日志里（**已知取舍**，
        //     与今天 N=1 那条路一致 —— 见下面那句"差额这一刻还没有"✓），**本刀不把它搬到页面上**
        //     （那要新文案 ⇒ 越界 ✗）。
        //   · 🔴 **`≤1` 组一个字都不变** ⇒ 照旧走下面那条老路径 ✓。
        const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
        if (groups.length > 1) {
          return submitMultiItemOrder({
            req, res, requestId, chain: 'return', groups,
            // 同上：按真实动作名修正（原来恒 undefined）。
            action: writeConfig.actions.purchaseReturn,
          });
        }
        // 🔴 **同一把 `submitKey` 原样透传**（幂等责任在写层：本文件不拼、不加后缀 ✗）
        const returnSubmitKey = body[fields.submitKey];
        //   ⚠️ 金额入参**逐字不带**：金额闸门在**上面**已经判过（空 / 非数字当场 400 + 零写入 ✓），
        //      这里仍按改前的形状把金额透传给写层（它要落「发生金额」✓）。
        const returnOrderAmount = String(body[fields.purchaseAmount] ?? '').trim();
        schedulePurchaseWrite({
          chain: 'purchase_return',
          requestId,
          submitKey: returnSubmitKey,
          context: { openId, requestId, number: view.number },
          // ⚠️ 只给**写层要的那几个实参**（`requestId` / `submitKey` 由 `runRest` 原样带上 ✓）
          restInput: {
            openId,
            productRecordId: view.product_record_id,
            number: view.number,
            orderAmount: returnOrderAmount,
            entries,
          },
        });
        // ⭐ 退货**真的动了库存** ⇒ 立刻作废「实时库存」内存快照（她：库存必须准确）。
        invalidateInventorySnapshot(requestId, 'scan_purchase_return_submitted');
        markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.purchaseReturn));
        // ⭐⭐ 2026-10-29：同补货 —— 提交收下 ⇒ **303 回工作台 + 统一 toast**（共用件）。
        //   ⚠️ 批次号 / 明细数 / **超库存差额**这一刻都还没有（后台那一跑才知道）⇒ 回执**不许**承诺 ✗
        //     —— 差额那件事仍在后台日志与会话 `last_error` 里（**已知取舍，见 PR 说明** ✓）。
        return redirectWithSubmitToast(res, {});
}

module.exports = { handleReplenish, handlePurchaseReturn };
