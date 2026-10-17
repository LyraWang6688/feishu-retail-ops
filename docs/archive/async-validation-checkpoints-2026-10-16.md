# 补货 / 退货 / 验收 —— 【校验点清单】：哪些**必须当场同步拦**（异步改造的前置准备）

> **性质：只读盘点。** 本文件是本次唯一新增的东西 —— `server/src/**` 一个字节都没改 ✗
> **base = 今天 main 的 `f13e998`**（开工前 `git fetch origin --prune` 核过 ✓：
> `git rev-list --count HEAD..origin/main` = **0** ✓）。
> 🔴 **行号都按 `f13e998` 这一个提交** ✓ —— **后续任何 rebase / 合并都要重新核一遍** ✗
> （本文件是从旧分支 `.local/val-cp` 的 `6d18aa4` 搬过来的；**那份 base 是旧 main `7ec5d6b`，
> 行号已全部过期** ✗ —— 本次逐条按今天 main 重核，**旧行号一个都没照抄** ✓，见 §6 更正台账）
>
> 🔴 **没碰**（都有主）：`routes/scanPage.js` · `views/scanPageRenderer.js` · `config/scanWrite.js` · `services/scanWriteService.js`（余量 0）—— **只读引用** ✓
> 配套设计：`docs/async-and-success-page-plan-2026-10-16.md`（异步 + 成功页那条线）
> 配套落地：`docs/purchase-async-wiring-2026-10-16.md`（补货 / 退货 接异步的接线记录）

---

## 0. 铁律（她最恨"假成功" ⇒ 这条不能破）

```
✅ 校验仍【当场同步拦】：金额非法 · 尺码不存在 · 超库存 · 必填缺失 · 单号认不出
   ⇒ 当场 400 + 人话 + 【零写入】 ✓（她照着改一下就能再提交 ✓）
❌ 只有【校验通过之后的写库】才异步 ✓
```

她的原话（2026-10-16 逐字）：**「异步只针对"写库"；校验必须当场同步拦」** ✓

🔴 **为什么这条要单独盘一遍**：异步改造时最容易顺手把"校验"也搬进后台 ⇒
**"她填错了"会变成"看起来成功、其实没写"** ✗ —— 这正是 2026-10-16 那次 26 次 `amount_mismatch` 的教训形状
（后端按设计拦住了、**零写入** ✓，但页面没告诉她 ✗ ⇒ 她以为"点了没反应"）。

### 0.1 ⚠️ 今天 main 的**新事实**（旧版文档没有 —— 这是搬运时按今天 main 重核出来的）

**补货 / 退货的"写库那一步"今天已经是异步的了** ✓ —— 但**校验仍然全部同步** ✓，
而且**位置有硬要求**：

```
校验闸门（金额 / 尺码 / 数量 / 空单 / 单号认不出 / 写开关）
  ⇒ 必须全部落在 `schedulePurchaseWrite(…)`【之前】✗ 顺序不能反
  ⇒ 通过之后才排后台那一跑，然后当场给「已提交成功，数据会更新」成功页 ✓
```

- 真源：`routes/scanPage.js:1133` 的注释（**「拦在 `schedulePurchaseWrite(…)` 之前 —— 顺序不能反」**）✓
- 补货：四道闸门 `:3030 / :3031 / :3039-3041 / :3048-3049` ⇒ 才 `:3065 schedulePurchaseWrite` ✓
- 退货：四道闸门 `:3115 / :3116 / :3122-3124 / :3139-3140` ⇒ 才 `:3162 schedulePurchaseWrite` ✓
- 多货品那条岔路（N>1）：`routes/scanPage.js:1925`（加货）/ `:3057` 与 `:3151`（提交）
  ⇒ 校验同样在排后台之前 ✓（`multiItemOrderService.js:410` `validateDraft` 在 `:418` 冻结计划之前）✓
- ⭐ **"尺码 / 数量 / 空单"这三类的判据只有一份真源**：
  `config/scanPurchaseEntryRules.js` 的 `purchaseEntryViolation`（`:134`），
  与写层 `services/scanWriteService.js:1397-1426`（补货）/ `:1556-1585`（退货）**逐字同源** ✓
  ⇒ 路由**不手抄 if-else** ✗（改了写层而忘了改路由 ⇒ **不可能** ✓）

---

## 1. 三条链路 · 逐条校验点（`文件:行` · 校验什么 · 现在同步/异步 · 判据在哪）

> 「现在」那一列今天**全部是同步** ✓ —— 因为**写库**那一步才是异步的（见 §0.1）。

### 1.1 补货（`action === actions.replenish`，`routes/scanPage.js:2993`）

| # | 校验什么 | 位置（**今天 main `f13e998`**） | 现在 | 判据在哪 |
| --- | --- | --- | --- | --- |
| R-1 | 这一款**认不认得出**（编号 → 货品记录） | `routes/scanPage.js:2996` → `notFoundPage`（定义 `:909`）⇒ **404** | **同步** | `test/scanPageWrite.test.js`「认不出 ⇒ 404 + 人话」 |
| R-2 | 🔴 **写开关关着**（`SCAN_REPLENISH_WRITE_ENABLED=false`） | `routes/scanPage.js:3048-3049` `purchaseWriteDisabledError`（定义 `:3347`）⇒ **400** | **同步** | 既有 `disabled` 用例（`scanWriteService.js:1517` 兜底） |
| R-3 | 🔴 **金额必填 / 金额非法**（按链路分档；**补货这一档今天 = `false`** ⇒ 实际不拦 ✓） | `routes/scanPage.js:3030 / :3031` → `purchaseAmountMissingPage`（定义 `:1018`）/ `purchaseAmountInvalidPage`（定义 `:1106`）⇒ **400** | **同步** | `test/purchaseAmountRealmWiring.test.js`（`AC-PAWIRE2` · 逐字钉档位键）· `purchaseAmountRealmTiers.test.js` |
| R-4 | 🔴 **尺码不存在 / 数量非法 / 本单空**（尺码 + 数量 + 空单三类） | `routes/scanPage.js:3039-3041` `purchaseEntryViolation({chain:'replenish'})` → `purchaseEntryInvalidPage`（定义 `:1142`）⇒ **400** | **同步** | `config/scanPurchaseEntryRules.js:134`（真源）· 写层同源 `scanWriteService.js:1404`(`size_unknown`) / `:1412`(`quantity_invalid`) / `:1419`(`replenish_empty`) |
| R-5 | 🔴 **写库失败本身**（后台那一跑） | 后台 ⇒ `scanWriteService.js` 的 `replenish_write_failed` ⇒ `respondWriteFailure`（定义 `:1164`）**500** 归属表在 `:1172-1173` | **异步**（★ 与旧版不同） | `test/scanPageWrite.test.js` 的 400/500 归属 |

⚠️ **R-5 是今天唯一"异步"的那一条** ✓ —— 它**不是校验**，是**写库**。
她提交时拿到的是统一成功页（`sendSuccess`，定义 `:877`），**页面不承诺批次号 / 明细数** ✗
（那两个数这一刻还没有）；真失败仍有出口：后台 `warn` + 会话 `last_error`（可查、可重试）✓

### 1.2 退货（`action === actions.purchaseReturn`，`routes/scanPage.js:3096`）

| # | 校验什么 | 位置（**今天 main `f13e998`**） | 现在 | 判据在哪 |
| --- | --- | --- | --- | --- |
| T-1 | 这一款认不认得出 | `routes/scanPage.js:3099` → `notFoundPage`（`:909`）⇒ **404** | **同步** | 同 R-1 |
| T-2 | 🔴 **整单金额必填**（空 ⇒ 拒） | `routes/scanPage.js:3115` → `purchaseAmountMissingPage`（`:1018`）⇒ **400 + 人话 + 零写入** | **同步** | `test/scanPurchaseAmountRequired.test.js`（`AC-PA*`） |
| T-3 | 🔴 **金额不是数字**（要落数字列） | `routes/scanPage.js:3116` → `purchaseAmountInvalidPage`（`:1106`）⇒ **400 + 人话 + 零写入** | **同步** | `test/scanPurchaseAmountWrite.test.js`（`AC-PAW*`）＋ `test/scanPurchaseReturn.test.js` |
| T-4 | 勾选尺码 / 数量合法 / 本单空 | `routes/scanPage.js:3122-3124` → `purchaseEntryInvalidPage`（`:1142`）⇒ **400** | **同步** | `test/scanReturnSizeList.test.js`（`AC-RT2`/`RT2b`）· 写层同源 `scanWriteService.js:1563` / `:1571` / `:1578`(`return_empty`) |
| T-5 | 🔴 **写开关关着** | `routes/scanPage.js:3139-3140`（定义 `:3347`）⇒ **400** | **同步** | `scanWriteService.js:1348` 兜底 `disabled` |
| T-6 | 🔴 **超库存** ⇒ 如实少退（`cap + report`） | 计划冻结算 `taken / shortfall`：`services/purchaseReturnService.js:76-106`（`:97` 每个码一行）· 返回 `:287-304` | **同步**（在写库那一跑里**如实回报**，不静默少扣 ✓） | `test/scanPurchaseReturn.test.js`（"超库存 ⇒ 如实少退、差额可见"） |
| T-7 | 写库失败本身 | 后台 ⇒ `return_write_failed` ⇒ `respondWriteFailure`（`:1164`）**500** | **异步**（★ 与旧版不同） | 同上 |

⚠️ **T-6 的已知取舍（今天）**：差额（`shortfall`）**只在写入件的返回值 / 后台日志里**，
**不在成功页上** ✗ —— 因为成功页在她提交那一刻就发出去了，差额那一刻还没算出来 ✓
（`routes/scanPage.js:3184` 那一句注释逐字写着这是**已知取舍**）。
⭐ 这条**不是**"挪走了校验"，是"**算差额**这件写库期内的事挪到了后台" ⇒ 与铁律不冲突 ✓；
但**她看不到差额**这件事本身仍是一条**欠账**（见 §5 未做项）。

### 1.3 验收（两条路 ✗ **出口仍然不一样**）

#### ① 扫码侧 `/s/accept`（`services/scanArrivalService.js`）

| # | 校验什么 | 位置（reason 码）**今天 main** | 现在 | 判据在哪 |
| --- | --- | --- | --- | --- |
| A-1 | **批次号缺失** | `scanArrivalService.js:148` `no_batch_no` | **同步** ⇒ 人话、零写入 | `test/acceptLandingFeedback.test.js` |
| A-2 | **批次明细读不出来**（依赖没接 / 读表失败） | `:154` `not_wired` · `:161` `request_rows_unreadable` | **同步** ⇒ 如实报"读不到" ✗ 不猜 | 同族（"不撒谎"判据） |
| A-3 | **这一批没有采购明细行** | `:171` `no_request_rows` | **同步** | `test/acceptancePrefill.test.js` |
| A-4 | **重复的明细行**（同一货品两行） | `:180` `duplicate_request_rows` | **同步** ⇒ 拒、不猜 | `test/acceptanceArrivalStatus.test.js` |
| A-5 | **没有会话**（没走过 start） | `:221` / `:295` / `:377` `no_session` | **同步** | `test/acceptLandingSelfServe.test.js` |
| A-6 | 🔴 **已经提交过**（幂等） | `:225` / `:298` `already_posted` | **同步** ⇒ 不许重复入库 ✗ | `test/acceptanceIdempotency.test.js` |
| A-7 | 扫到的尺码**不在这一批** | `:233` `size_unknown` · `:250` `not_in_batch` | **同步** ⇒ 人话 | `test/acceptLandingSelfServe.test.js` |
| A-8 | **数量非法** | `:238` / `:304` `quantity_invalid` | **同步** | 同族 |
| A-9 | **扫太多次**（上限） | `:262` / `:345` `too_many_scans` | **同步** ⇒ 拦住 | 同族 |
| A-10 | 写库失败本身（入库 / 加库存） | `purchaseWebhookService.confirmArrival:1941`（实现在 `:1950 confirmArrivalLocked`）抛错 ⇒ 路由 400/502/503 | **同步** | `routes/workbench.js:215` 的失败口径 |

#### ② 工作台侧 `POST /api/workbench/purchase/arrivals/confirm`（`routes/workbench.js:200`）

- 失败口径：她填错 ⇒ **400**；业务拒绝 ⇒ **502**；依赖不可用 ⇒ **503**，**都把原因原样回页面** ✓
  —— **今天的确切位置是 `routes/workbench.js:215`**（旧版写 `:207-212` ✗）
- ⚠️ **还有第三条路也在这张表上**（旧版没写）：`POST /purchase/arrivals/accept` ——
  它是**变量路径**，不是字面量：`routes/workbench.js:317` 的 `router.post(arrivalTab.api.accept, …)`
  （常量在 `config/workbenchArrival.js:27`）✓
  ⭐ **2026-10-16（task-56）起这一条的 `finish`（写库那半）已经是异步的** ✓ ——
  `start` / `addScan`（= **校验那一半**）**仍同步** ✓（`routes/workbench.js:321` 起）；
  ⚠️ 失败口径的另外两处同形代码：`:396`（accept）· `:547` ✓
- ⚠️ **与扫码侧不是同一套出口**（一个 HTML 人话、一个 JSON）⇒ 异步改造时
  **要么统一、要么两套都保住**（**建议先问 Lead/她** ✓ 别自己拍）

---

## 2. 🔴 绝不能挪进后台的清单（逐条 + 为什么）

| # | 校验 | 位置（**今天 main `f13e998`**） | 为什么**绝不能**挪进后台 ✗ |
| --- | --- | --- | --- |
| **X-1** | **金额必填 / 金额非法**（退货 · 验收档） | `purchaseAmountMissingPage:1018` · `purchaseAmountInvalidPage:1106`；调用点 `scanPage.js:3115 / :3116`（退货）· 档位真源 `config/scanWrite.js:173-180 requiredByRealm` | 这是**她填错了** ⇒ 必须当场说"哪不对、差多少"；挪进后台 = 她会看着"成功页"以为记上了 ✗（`amount_mismatch` 26 次那次就是这么"看起来没反应"） |
| **X-2** | **尺码不存在 / 数量非法 / 本单空** | 真源 `config/scanPurchaseEntryRules.js:134`；调用点 `scanPage.js:3039-3041`（补货）· `:3122-3124`（退货）· `:1925`（多货品加货） | 同上：**输入错**必须当场 400 + 零写入；后台报错时页面早走了 ⇒ 假成功 ✗ |
| **X-3** | 🔴 **超库存**（退货 / 验收） | 退货：`purchaseReturnService.js:76-106` 冻结计划（`:97` `shortfall`）；库存兜底 `inventoryService.js:802-805`（`applyChange` 现有 < 要退 ⇒ **当场抛错、一双不动**）· 验收：`inventoryService.js:571 applyPurchase` | **业务事实**必须在**她眼前**说清"只能退 N 双"；挪进后台 ⇒ 她以为全退了 ✗（差额也来不及给她看） |
| **X-4** | **认不出这一款 / 批次** | `notFoundPage:909`（补货 `:2996` / 退货 `:3099`）· `no_batch_no` `scanArrivalService.js:148` | 认不出 = **没有目标** ⇒ 后台无从写起；当场 404/人话 才是对的 ✓ |
| **X-5** | 🔴 **幂等 / 已提交** | 验收 `already_posted` `scanArrivalService.js:225 / :298` · 三条链路各自的 `submitKey`（`scanPage.js:3060 / :3157` 原样透传 · 写层 `scanWriteService.js:1503` 组键） | 幂等键必须**在提交那一刻**核对；挪进后台 ⇒ 并发/重试会**写两次** ✗（这是她最在意的"账对不上"） |
| **X-6** | **写开关关**（`disabled`） | 路由同步闸门 `scanPage.js:3347`（调用 `:3048 / :3139`）；写层兜底 `scanWriteService.js:475 / :727 / :1348 / :1517` | 关着还收单 = 骗她 ✗ |
| **X-7** | **本单空**（没有可写内容） | 真源 `config/scanPurchaseEntryRules.js:134`（`replenish_empty` / `return_empty`）；写层同源 `scanWriteService.js:1419 / :1578` | 空单当场拒；挪进后台 ⇒ 她提交了、后台什么都不做 ⇒ **静默** ✗ |

✅ **可以（而且应该）挪进后台的**：**X-1…X-7 全部通过之后**的那些**写库动作本身** ——
`publishPurchaseRequest`（`purchaseWebhookService.js:604`，出单/出图/发群）·
`purchaseReturnService`（批次行 + 明细 + 扣库存 + 出退货单）·
`scanArrivalService` 的入库/加库存/必填回写 —— 以及它们的**失败标记与重试** ✓

### ⭐ 2.1 **验收提速成批量写** —— **至今没做** ✗（★ 本清单里标记出来的一条）

**今天只读核出来的事实（别写反 ✗）**：

- **验收 / 报货的写入现在仍是【逐条】** ✗ ——
  `services/purchaseWebhookService.js:1748 confirmPurchaseRequest` 里是
  **`for (const item of plan.items)`**（**`:1812`**）⇒ **一次一件** ✗
  （她走的两条入口——供应商报单 webhook / 扫码页补货——**都汇到这一处建行点** ✓）
- ⇒ **"验收提速成批量写"这件事至今没做** ✓ ⇒ 属于**"可以挪后台 / 可以批量"那一类** ✓
  （**不是**"必须当场同步拦"那一类 ✗ —— 它不拦任何东西，只是写得慢 ✓）
- ⚠️ **批量口已经现成躺在那里**（今天 main 上就有，只是**这条链路没用它** ✗）：
  `services/inventoryService.js:606 applyPurchaseBatch`（注释逐字：「一批一次写的采购加库存 —
  `applyPurchase` 的批量版」，2026-10-13「验收提速 ①」）✓
  ⇒ 真做这件事时**接线即可**，不用新造批量口 ✓（**但本文件只盘点、不动手** ✗）

---

## 3. 判据草案（每条"能真红"）

> 写法：**判据 → 怎么写成能真红 → 变异（塞回去必红）**。实现时**先写用例、再写代码** ✓

| AC | 判据 | 能真红的写法 | 变异 |
| --- | --- | --- | --- |
| **AC-VC1** 🔴 校验失败 ⇒ **当场 400 + 人话 + 零写入** | 三条链路各跑一遍"坏输入"（金额空/非数字、尺码不存在、数量 0、超库存、批次认不出、已提交）⇒ 断言 ①HTTP **400**（不是 200）②响应里有**那句人话**③**假网关写入次数 = 0** | 把任一校验移出请求路径（改成"后台再校验"）⇒ 状态码变 200 / 写入次数 > 0 ⇒ **红** |
| **AC-VC2** 🔴 后台写失败 ⇒ **不许停在成功页当没事** | 假网关让**后台那一跑**抛错 ⇒ 断言 ①主表/批次落「**写入失败**」②有 `*.failed` 日志 ③**可重试**（同一把 `submitKey` 再跑 ⇒ 只写一次） | 删掉失败标记 ⇒ **红**（= `AC-ASY2`，与设计稿同一条 ✓） |
| **AC-VC3** 🔴 **幂等不拆** | 重试/并发（串行 + 并发各两跑）⇒ 断言批次行/明细/库存流水**各只 1 份**；`submitKey` 逐字不变 | 换一把新键 ⇒ **红** |
| **AC-VC4** ⭐ **"校验在前、写库在后"的顺序**（防止被顺手调换） | 源码哨兵：三条链路各自的"`purchaseAmount*Page` / `purchaseEntryViolation` / `notFoundPage` / `already_posted`"分支**都在**调用写服务**之前**；且**后台那一件里没有任何校验**（例：新件里不许出现 `purchaseAmountMissing` / `purchaseEntryViolation` / `already_posted`） | 把校验挪到 `schedulePurchaseWrite` **之后** ⇒ **红**（⭐ 今天这条**已经成立** ✓ —— `scanPage.js:1133` 的注释就是这条判据的文字版 ✓） |
| **AC-VC5** 🔴 上游依赖读不到 ⇒ **如实报"读不到"**，不许猜、不许当空 | 验收：`request_rows_unreadable` / `not_wired` 注入 ⇒ 断言人话是"读不到"那一句，且**零写入** | 把它改成"当 0 行处理" ⇒ **红** |
| **AC-VC6** ⭐ 既有判据**一条不放宽** | `scanPurchaseAmountRequired` / `scanPurchaseAmountWrite` / `scanPurchaseReturn` / `scanReturnSizeList`（`AC-RT2`）/ `acceptLanding*` / `acceptanceIdempotency` / `purchaseAmountRealmWiring`（`AC-PAWIRE2`）**原样绿**；改判据写「改前逐字 → 改后逐字 → 依据」 | 删/skip 任一条 ⇒ **红**（用 `git diff` 数断言行） |

---

## 4. 怎么用它（给实现者的三步）

1. **先按 §2 把 X-1…X-7 标成"留在请求路径里"** —— 改造时**只允许**把 §2 末尾那批写库动作挪后台 ✓
   （⚠️ 补货 / 退货**今天已经这么做了** ✓ ⇒ 这一条对本文件是"**保持**"，不是"新做" ✓）
2. **再按 §3 的 AC-VC1…VC6 先写用例**（先红），再动代码 ✓
3. **落地顺序**：与 `task-46`（补货/退货路由接线）**严格串行** ✗（同一片区域）；
   验收那半先定"哪一半异步"（见设计稿 §3.1 的待确认项）✓

**复核命令**（⚠️ 这一段**必须**按今天的文件名跑 —— 旧版的清单里少了今天新增的两个）
```bash
git -C . rev-parse --short HEAD && git -C . rev-list --count HEAD..origin/main      # 必须 0
cd server && node --test --test-concurrency=1 --test-force-exit \
  test/scanPurchaseAmountRequired.test.js test/scanPurchaseAmountWrite.test.js \
  test/scanPurchaseReturn.test.js test/scanReturnSizeList.test.js \
  test/purchaseAmountRealmWiring.test.js test/purchaseAmountRealmTiers.test.js \
  test/acceptanceIdempotency.test.js test/acceptLandingSelfServe.test.js            # 受影响的先绿
```

**本次只读自证**：`git status --porcelain` 只有**两个文件**
（本文件 + `docs/README.md` 的索引一行）✓ —— **`server/src/**` 零改动** ✓（见 PR 的 `git diff --name-only`）

---

## 5. 未做项（如实标注 ✗）

| # | 未做项 | 今天的状态 |
| --- | --- | --- |
| U-1 | ⭐ **验收 / 报货提速成批量写** | 🔴 **至今没做** ✗ —— 仍是 `purchaseWebhookService.js:1812` 的 `for (const item of plan.items)` **一次一件** ✓（详见 §2.1；批量口 `inventoryService.js:606` 已现成 ✓） |
| U-2 | **退货"超库存差额"给到她眼前** | 🔴 **没做** ✗ —— 差额目前只在写入件返回值 / 后台日志（`scanPage.js:3184` 自认"已知取舍"）✓ |
| U-3 | **验收两条路的失败出口统一**（HTML 人话 vs JSON） | 🔴 **没做** ✗ —— 两条路仍在（扫码侧 / 工作台侧），**待 Lead / 她拍** ✓ |
| U-4 | 本清单的 **AC-VC1…VC6 判据** | 🔴 **只有草案** ✗ —— 今天**还没落成能真红的用例** ✓（`config/scanPurchaseEntryRules.js` 那类"逐字同源"已是**部分**落地 ✓） |

---

## 6. 更正台账（旧分支 `6d18aa4` → 今天 main `f13e998`）

⚠️ 旧 base = `7ec5d6b`，行号**全部过期** ✗ —— 下表是本次**逐条重核**的结果
（**列出的每一条都改过**；"旧"那一列是旧文档里写的字面值 ✓）。

| 文档里的位置 | 旧（`6d18aa4` 写的） | **今天 main `f13e998`** | 差多少 |
| --- | --- | --- | --- |
| 补货 · 认不出 | `routes/scanPage.js:~1989` | **`:2996`**（定义 `:909`） | **+1007** |
| 补货 · 尺码/数量 | `scanPage.js:~1990` + `scanWriteService.js:814` `size_missing` | **`scanPage.js:3039-3041`** + 真源 `config/scanPurchaseEntryRules.js:134`；写层 `:1404 / :1412 / :1419` | **+1049**（且**换了个闸门**） |
| 补货 · 写开关 | `scanWriteService.js:475` | **`scanPage.js:3048-3049`**（定义 `:3347`）；写层兜底 `scanWriteService.js:1517` | 路由侧**新加**了闸门 |
| 补货 · 本单空 | `scanWriteService.js:845` `session_empty` | **`scanPage.js:3039-3041`** → `scanPurchaseEntryRules.js:134`；写层 `:1419` `replenish_empty` | **换了码**（`session_empty` → `replenish_empty`） |
| 补货 · 写库失败 | `scanPage.js:~2025` | **`:1164 respondWriteFailure`**（定义）+ `:1172-1173` 归属表；**且今天是异步** | **-861** |
| 退货 · 认不出 | `~2055` | **`:3099`**（定义 `:909`） | **+1044** |
| 退货 · 金额必填 | `~2063` → `:572` | **`:3115`** → **`:1018`** | **+1946** |
| 退货 · 金额非法 | `~2064` → `:625` | **`:3116`** → **`:1106`** | **+1932** |
| 退货 · 尺码/数量 | `scanWriteService.js:814` | **`scanPage.js:3122-3124`**；写层 `:1563 / :1571 / :1578` | **换了闸门** |
| 退货 · 写库失败 | `scanPage.js:~2085` | **`:1164`**；**且今天是异步** | **-921** |
| 验收 · 全部 reason 码 | `:148/:154/:161/:171/:180/:221/:225/:233/:250/:238/:262/:295` | **逐条核过，今天**全部**原位命中** ✓（多出 `:298 / :304 / :345 / :377` 三处同码） | **0**（唯一**没变**的一组 ✓） |
| 验收 · 写库失败 | `purchaseWebhookService.confirmArrival` | **`:1941`**（实现 `:1950 confirmArrivalLocked`） | 补上真行号 |
| 工作台 · 确认端点 | `routes/workbench.js:193` | **`:200`** | **+7** |
| 工作台 · 失败口径 | `routes/workbench.js:207-212` | **`:215`**（另两处同形 `:396 / :547`） | **+3** |
| ⭐ 工作台 · accept 端点 | 旧版**根本没写** ✗ | **`:317`**（**变量路径** `arrivalTab.api.accept`，常量 `config/workbenchArrival.js:27`） | **新增一行** |
| ⭐ 补货 / 退货 · 异步接线 | 旧版**根本没有**（当时还全是同步）✗ | **`:3065 / :3162 schedulePurchaseWrite`**；闸门全在它**之前** | **新增 §0.1** |
| ⭐ 金额档位配置 | 旧版**没有** | **`config/scanWrite.js:173-180 requiredByRealm`**（`replenish:false` / `return:true` / `accept:true`） | **新增一行** |
| ⭐ 验收批量口 | 旧版**没有** | **`inventoryService.js:606 applyPurchaseBatch`**（今天**没被验收链路用** ✗） | **新增 §2.1** |

**合计更正：18 处**（含 3 处**旧版完全没有、今天必须补**的：工作台 accept 变量路径 · 补货/退货异步接线 · 金额档位配置）。
⭐ **举两个最典型的**：

1. **金额必填页**：旧 `routes/scanPage.js:~2063` → `purchaseAmountMissingPage` 在 `:572`；
   **今天**调用点是 **`routes/scanPage.js:3115`**，页面函数定义在 **`:1018`**
   （旧版那个 `:572` 差了 **446** 行 ✗）。
2. **验收/报货逐条写**（§2.1 那条事实）：旧版**只在正文里说"逐条"、没给行号**；
   **今天**的真行号是 **`services/purchaseWebhookService.js:1748 confirmPurchaseRequest`**
   里的 **`:1812` `for (const item of plan.items)`** ✓ —— 一次一件 ✗。

---

**本次只读自证（再写一遍）**：`server/src/**` **零改动** ✗
（`git diff --name-only` 只应出现 `docs/async-validation-checkpoints-2026-10-16.md` 与 `docs/README.md`）✓；
CI 四件全绿 ✓
