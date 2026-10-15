# 补货 / 退货 接异步（先回成功页 ⇒ 后台写库）—— 接线落地记录

> **性质**：**实现落地**（代码 + 判据）。base = `main 4096332`（开工前 `git fetch` 核过 ✓）。
> 共用后台件与判据**上一刀已合进 main**：`services/purchaseWriteBackgroundService.js`（#664）·
> `test/purchaseAsyncAcceptance.test.js`（#677）—— 本刀**只做接线**（判据**一个字没改** ✓）。
> 写作用域：`server/src/routes/scanPage.js` · `server/src/config/scanWrite.js` · 三个受影响的既有用例。

---

## 1. 她的口径（业务负责人 2026-10-16 **逐字**）

> 「**补货、退货还有验收，它都是异步的**……用户提交之后**都是一个成功页**，
>  说『**已提交成功，数据会更新**』类似这类的话就行了。**都是一个异步的提醒**」
>
> 「**不需要做任何跳转，也不需要做任何链接**」

---

## 2. 三条链路 · 接线状态（**如实**）

| 链路 | 写入口 | 这一刀 |
| --- | --- | --- |
| **补货** | `routes/scanPage.js` → `writeService.submitReplenish` | ✅ **已接**：先回成功页（200）⇒ 后台那一跑写库 |
| **退货** | `routes/scanPage.js` → `writeService.submitPurchaseReturn` | ✅ **已接**：同上（金额闸门仍在同步路径 ✓） |
| **验收** | ~~扫码侧 `acceptFinish`~~ **已于 #544 整体退场**；能力在**工作台** `/purchase/arrivals/accept`（`scanArrivalService`） | ⚠️ **未接线**（本刀**没碰工作台那条**）：扫码侧已无写入口 ⇒ 判据 `AC-ASY1b` 走的是它的**"如实不给成功页 + 零写入"**那一支（今天就是这样 ✓ **不是假成功** ✗）。工作台那半"异步哪一半"**仍是待定项**（设计稿 `docs/async-and-success-page-plan-2026-10-16.md` §3.1 就点过它）⇒ **留给 Lead 决策** |

---

## 3. 改了什么（逐条：改前逐字 → 改后逐字 → 依据）

### 3.1 `routes/scanPage.js` · 补货分支

* **改前逐字**：
  ```js
  const result = await writeService.submitReplenish({ openId, requestId, submitKey: body[fields.submitKey], productRecordId: view.product_record_id, number: view.number, entries });
  if (!result.ok) return respondWriteFailure(res, result, requestId);
  … return sendHuman(res, 200, { …successReturnFields(…), title: result.reused ? texts.replenishAgainTitle : texts.replenishDoneTitle, body: …, details: [批次号, 条数], retryHint: … });
  ```
* **改后逐字**：`schedulePurchaseWrite({ chain: 'replenish', requestId, submitKey, context, restInput: { openId, productRecordId, number, entries } })`
  ⇒（失效快照 / 记领域照旧）⇒ `return sendSuccess(res, 200, { …successReturnFields(…), requestId })`
  —— 成功页 = `config/scanPage.js` 的 **`saleSuccess`**（`title` + `message: '已提交成功，数据会更新'` ✓
  **复用既有键、不新造一句** ✗）。
* **依据**：她 2026-10-16 逐字（§1）＋ `test/purchaseAsyncAcceptance.test.js` 的 **AC-ASY1**
  （先回成功页 ⇒ `await waitForPendingPurchaseBackgrounds()` ⇒ 写入口确实进过 ✓）。

### 3.2 `routes/scanPage.js` · 退货分支

* 与补货**同形**；**金额闸门（空 / 非数字）与"这一款认不出"仍在同步路径** ✗（改前的位置没动）。
* 顺手**去掉**的只有：成功页上那几行"后台才知道"的事实（批次号 / 条数 / **超库存差额**）——
  它们的来源是写层的返回值，而返回值这一刻**还不存在** ⇒ 页面**不许**承诺 ✗（**已知取舍**见 §4）。

### 3.3 `routes/scanPage.js` · 后台那一跑的接线（新增，一处在册）

* `createPurchaseWriteBackgroundService({ runRest, markFailed, purchaseAsync, config })`：
  * `runRest` = **既有写入口**（`writeService.submitReplenish` / `submitPurchaseReturn`，**不新开写库路径** ✗）；
    实参形状与改前**逐字同形**（`RT2-static` 那张参数清单的护栏**没放宽** ✗）。
  * `markFailed` = 落**会话 `last_error`**（`markReplenishFailed` / `markPurchaseReturnFailed`）
    ⇒ **可查**；幂等键**不轮换** ⇒ 她再点一次 = **同一把 `submitKey`** 重试 ✓。
  * `config.events` = 新增三个事件名（`config/scanWrite.js`：`purchaseBackgroundTiming` /
    `purchaseBackgroundFailed` / `purchaseBackgroundMarkFailed`）—— **配置先行** ✓ 不散写字符串 ✗。

### 3.4 写入口关着 ⇒ 仍当场拦（`purchaseWriteDisabledError`）

* `SCAN_REPLENISH_WRITE_ENABLED` / `SCAN_RETURN_WRITE_ENABLED` 为 `false` ⇒ 排后台**之前**回
  **400 + 既有那句人话 + 零写入**（与改前那张页**逐字同形** ✓）。
* 依据：关着还收单 = **骗她** ✗（"运维开关"不是她的输入 ⇒ 不许被异步顺手放过）。

---

## 4. 🔴 校验边界（这一刀最重要的一条）＋ **已知取舍**

| 校验 | 在哪 | 状态 |
| --- | --- | --- |
| **这一款认不出**（编号 → 货品） | 路由 `notFoundPage`（404） | ✅ **同步**（一个字没动） |
| **退货整单金额空 / 非数字**（补货不问金额） | 路由 `purchaseAmount*Page`（400 + 人话 + 零写入） | ✅ **同步**（**判据 AC-ASY2 / AC-PA3 / AC-PA4 全绿** ✓） |
| **写入口关着** | 路由 `purchaseWriteDisabledError`（400） | ✅ **同步**（本刀新增，见 §3.4） |
| **尺码 / 数量 / 空单** | **写层** `services/scanWriteService.js`（`size_unknown` / `quantity_invalid` / `*_empty`） | ⚠️ **跟着写库那一步进了后台**（**取舍**，见下） |

> ⚠️ **为什么这条取舍没法在本刀内解决**：那些校验与写库在 `scanWriteService.js` 里**是同一个函数**
> （`submitReplenish` / `submitPurchaseReturn`）。要"先受理 + 后台续写"就得**拆那个函数** ——
> 而本刀的硬红线是**那个文件一个字都不许改** ✗（余量 0）⇒ 本刀**没有动它**。
>
> ⚠️ **现象**（如实）：她若真填错了尺码 / 数量 / 一张空单，**会先看到成功页**，
> 而失败在后台**如实留痕**：`purchase.write.background.failed` warn ＋ 会话 `last_error`
> （**不静默** ✗，`AC-R9` 的迁移就钉着这条 ✓）。页面**绝不承诺**"已写完 / 批次号" ✗。
>
> ⭐ **要挪回同步**：把写层那两个函数拆成"先校验受理 ⇒ 后台续写"两半（= **动 `scanWriteService.js`**）
> ⇒ **超出本刀授权**，**留给 Lead 决策**。

**另一条已知取舍**：退货的**超库存差额**（"一共几双没退成、哪些尺码不够"）原来印在成功页上，
现在**只在后台**（`shortfall` 在写层返回值里、日志/会话里可见）—— 因为那一刻还没跑写库。
（页面上那句"退了几双"的语义键 `returnShortfallLine` 仍然在配置里，**没有删** ✗。）

---

## 5. 判据迁移（每条都写「改前逐字 → 改后逐字 → 依据」；**没有删 / skip / 放宽** ✗）

| 文件 · 用例 | 改前逐字 | 改后逐字 | 依据 |
| --- | --- | --- | --- |
| `test/scanPageWrite.test.js` **⑧**（用例名 + 断言） | `→ 采购申请结果页（批次号 + 条数）` ＋ `assert.match(doneHtml, /采购申请已生成/)` / `/CGD-20261008-0001/` / `/采购申请：1 条/` | `→ 先回统一成功页；“后台那一跑”再把采购申请写上` ＋ `assert.ok(doneHtml.includes(SCAN_PAGE.saleSuccess.message))` ＋ `assert.equal(doneHtml.includes('采购申请已生成'), false)` ＋ `await waitForPendingPurchaseBackgrounds()` ＋ 再读表（数量 = 3） | 她 2026-10-16 逐字（§1）：成功页只有那一句；批次号由后台取 ⇒ **判据变强**（先回她 **且** 真落库 ✓） |
| `test/scanPurchaseAmountRequired.test.js` **AC-PA4** | cases 第三列 `'采购退货已生成'` / `'采购申请已生成'` ＋ `assert.ok(html.includes(doneTitle))` | cases 两列 ＋ `assert.ok(html.includes(SCAN_PAGE.saleSuccess.message))` | 同上；**写入口恰进一次 + 入参形状两条断言逐字未动** ✗ |
| `test/scanPurchaseReturn.test.js` **AC-R5**（页面那一段） | `/采购退货已生成/` ＋ `/CGD-20261011-0002/` ＋ `/采购退货：1 条/` | `includes(saleSuccess.message)` ＋ `includes('采购退货已生成') === false` ＋ `await waitForPendingPurchaseBackgrounds()` ＋ 批次 2 行 / 明细 2 行 | 同上；**服务级**那几条（差额 = 2 / 库存按实退扣）**一个字没动** ✓ |
| `test/scanPurchaseReturn.test.js` **AC-R9** | `response.status === 500` ＋ `/这一步没成功/` ＋ 内部细节不回显 | `status === 200`（统一成功页）＋ 内部细节**照样不回显** ＋ 等后台 ⇒ 会话 `last_error` **非空且仍是人话** ＋ 明细**零写入** | 同上 ＋ `AC-ASY3`（后台失败 ⇒ `markFailed` + `ok:false`，**绝不假装成功** ✗）—— 失败仍须**可查**、且不许写成功任何一条 ✗ |

**一个字没改的判据**：`test/purchaseAsyncAcceptance.test.js`（**AC-ASY1 / 1b / 2 / 2b / 3 / 3b / 4 全绿** ✓）·
`test/purchaseWriteBackground.test.js` · `test/multiItemOrderRoute.test.js`（`RT2-static` 参数清单 ✓）·
`test/saleSuccessHintRemoval.test.js` · `test/successPageAcceptance.test.js` · `test/skipPathsMinimal.test.js`。

---

## 6. 证据

* **两遍全量**（`rm -rf data && node --test --test-concurrency=1 --test-force-exit …`）：
  **EXIT=0 ×2** · `tests 2812 / pass 2808 / fail 0 / skipped 4` ×2（改前基线同数字 ✓）。
* **两遍之间 `git diff | shasum -a 256` 逐字相同**：`564392adb10dc499d632a6ada655f20e97481be4b96f2c7deae77f3eaf7b5dca` ✓
* **变异 3 组（都真红，之后逐字节还原）**：
  1. 关掉退货金额闸门（整行改成 `if (false)`）⇒ `AC-ASY2` / `AC-PA3` / `AC-PA5` **3 条真红** ✓
  2. 补货成功页改回"承诺批次号"的旧形状 ⇒ **⑧ 真红** ✓（证明迁移真的钉住了"不许承诺"）
  3. `replenishSubmitKey` 拼接一个后缀 ⇒ **⑧ 真红** ✓（幂等键必须原样透传）
  ⇒ 还原后 `git diff | shasum -a 256` 与变异前**逐字相同** ✓
* **`services/scanWriteService.js`：一个字没加 / 没删 / 没改**（`git diff --name-only` 里没有它 ✓）。
* **未部署**（业务负责人在测试期：本刀只开 PR ✗ 不部署 ✓）。

---

## 7. 未做 / 留给 Lead

1. **验收那条链路的异步**（见她 2026-10-16「**补货、退货还有验收**」都点名了）——
   扫码侧已无写入口（#544），工作台那半**没碰** ⇒ **未完成**，且"异步哪一半"仍待定（§2）。
2. **尺码 / 数量 / 空单**这三类校验回到同步路径 ⇒ **必须**动 `scanWriteService.js`（§4）⇒ 本刀**停手**。
3. **退货超库存差额**回到她眼前（§4 第二条）⇒ 同上，需要写层给出"受理时就能算出的差额"。
