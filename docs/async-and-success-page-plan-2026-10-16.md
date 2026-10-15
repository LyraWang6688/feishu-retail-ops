# 补货 / 退货 / 验收 接异步 ＋ 成功页统一极简 —— **只读设计 + 改动清单 + 判据草案**

> **性质：只读设计。本文件是本次唯一新增的东西 —— `server/src/**`、`config/**`、`server/test/**` 一个字节都没改** ✗
> base = `main 8782da9`（先 `git fetch` 核过 ✓）；复核命令见 §8。
> 对应任务：`task-52`（**实现**任务，写作用域是 `server/src/**` ⇒ 本文件**只出设计**，不代做实现）
>
> 🔴 **本文件没碰四个热点文件**：`routes/scanPage.js` · `views/scanPageRenderer.js` · `config/scanPage.js` · `config/scanWrite.js`
> （P0 那刀 `fix/scan-payment-amounts-and-buttons` 正在改）+ `services/scanWriteService.js`（余量 0 行 ✗）—— **只读引用它们** ✓

---

## 1. 她的口径（逐字，2026-10-16）

> 「核心就是**销售、补货、退货、验收都支持异步**，以及**成功页**，**补货不需要金额**，**退货和验收需要金额**，**都有成功页**，然后**销售、补货、退货支持一单多货**」
>
> 「用户提交之后**都是一个成功页**，说"**已提交成功，数据会更新**"类似这类的话就行了。**都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」
>
> 「**不需要做任何跳转，也不需要做任何链接**」

## 2. 范围（本设计只覆盖 A + B）

| 部分 | 内容 | 本设计 |
| --- | --- | --- |
| **A 异步** | 销售 **已 ✓**；**补货 · 退货 · 验收 要做** ✗ | ✅ 本文件 |
| **B 成功页** | 四条链路**同一句**「已提交成功，数据会更新」· **不放任何链接/按钮/跳转** | ✅ 本文件 |
| 金额 | 补货不问金额 · 退货/验收要金额 | ⛔ `task-50 P1-⑤`（别重复做 ✗） |
| 一单多货 | 销售已支持 · 补货/退货 = `task-46`（引擎已合、差**路由接线**） | ⛔ 别重复做 ✗；🔴 与本任务**严格串行**（同一片区域） |

---

## 3. 现状（逐条 `文件:行`）

### 3.1 四条链路对照（今日实测的代码事实）

| 链路 | 提交入口 | 落库调用链 | 现在同步/异步 | 失败怎么落地 |
| --- | --- | --- | --- | --- |
| **销售**（含配品） | 扫码页 POST → 同一条 `scanPage.js` 动作分支 | `scanWriteService.submitSale:693`（主表**先建号**）→ 余下几步交后台 | **异步 ✓**（`scanWriteService.js:1187` `const background = scheduleSaleRest({...})`） | 主表落「**写入失败**」＋工作台「**未完成，可点重试**」；重试走**同一把 `submitKey`** ✓ |
| **补货** | `routes/scanPage.js:1924` `action === actions.replenish` | `scanWriteService.submitReplenish:1346` → `purchaseWebhookService.publishPurchaseRequest` | **同步 ✗**（`await` 写完才回） | `respondWriteFailure`（`scanPage.js:645`）→ 400/500 + 人话；**没有后台、没有重试入口** |
| **退货** | `routes/scanPage.js:1993` `action === actions.purchaseReturn` | `scanWriteService.submitPurchaseReturn:1513` → `purchaseReturnService` →（金额）`purchaseOrderBatchService.writeOrderAmount` | **同步 ✗** | 同上（`respondWriteFailure`） |
| **验收** | ① 扫码侧 `/s/accept?batch=…`（批次清单 → 进批次）② **工作台** `POST /api/workbench/purchase/arrivals/confirm`（`routes/workbench.js:193`）＋ `/purchase/arrivals/accept`（`routes/workbench.js` 内，走**既有** `scanArrivalService` start→addScan→finish） | `scanArrivalService`（会话/幂等键 `accept:<session_id>:<轮次>`，`services/scanArrivalService.js:130`）→ 写「报货批次」＋ 库存；工作台那条 → `purchaseWebhookService.confirmArrival` | **同步 ✗** | 扫码侧同 `respondWriteFailure`；**工作台侧是 JSON**（`res.json({success:false,error})`，`routes/workbench.js:207-212`，页面自己显示）⇒ **两条路的失败口径现在不一样** ✗ |

⚠️ **验收的特殊性（实现时必须先定）**：它是**四条里唯一有"工作台那一半"**的（她 2026-10-14 明确「把老验收整块搬进工作台」）。
⇒ 异步要作用在**哪一半**（扫码侧 `/s/accept` 的确认入库？工作台 `/purchase/arrivals/confirm`？两条都要？）**必须先确认** ✗
—— 我按她"四条链路都有成功页"的口径推测是**两条都要**，但这条**建议 Lead 向她确认一句**（不确定就标出来，不猜 ✓）。

### 3.2 要"照抄"的那套形状：销售异步（`saleWriteBackgroundService`）

| 机制 | 位置 | 要点 |
| --- | --- | --- |
| 后台调度 | `services/saleWriteBackgroundService.js:65` `scheduleSaleRest(...)` | **回到主提交函数**（延迟调用 `submitSale`），**拿同一把 `submitKey`**，走既有"续写"路径 ⇒ **不新开写库路径** ✓ |
| 失败标记 | 同文件 `:136` `markSaleWriteFailed(...)` | 落「写入失败」＋日志，**绝不假装成功** ✓ |
| "等它跑完"的接缝 | 同文件 `:46` `waitForPendingSaleBackgrounds()`（`scanWriteService` 照旧 re-export） | 用例/路由可以**等后台那一跑**（`background` 句柄）✓ |
| 配置 | `config/scanWrite.js:327-342` `asyncWrite` | `enabled`（**显式布尔** `readFlag`，默认 `true`）· `doneBodyTemplate`（`'本单已创建成功（{orderNo}）'`）· `backgroundTimeoutMs`（看门狗**只记 warn**、不取消写入） |
| 语义边界（**必须逐字继承**） | 同上注释 | 幂等键/状态值域/日志事件名/**绝不直调 `_confirm`** —— 一个字不许改 ✗ |

⇒ **三条链路各自的接法**：把"先建号/先受理 ⇒ 立刻回成功页"与"余下几步"切开，
**把余下几步交给一个新件** `services/purchaseWriteBackgroundService.js`（**与 `saleWriteBackgroundService` 同形**，
三个函数：`schedulePurchaseRest` / `markPurchaseWriteFailed` / `waitForPendingPurchaseBackgrounds`）——
**只挪不改**：写入仍走既有 `publishPurchaseRequest` / `purchaseReturnService` / `scanArrivalService` ⇒ **不新开写库路径** ✓

### 3.3 成功页现状（四条**不统一** ✗）

| 链路 | 现在渲染什么 | 位置 |
| --- | --- | --- |
| **销售** | `renderSaleSuccessPage`（**专属**函数）：标题 + 单号 + **三入口** | `views/scanPageRenderer.js:1724`；三入口 HTML **`:1739-1743`** |
| **补货 / 退货** | 共用 `sendHuman` → `renderMessage` → **message 页**（`title/body/details`，**没有三入口**） | `routes/scanPage.js:344`（sendHuman）· `:100`（`renderMessage = renderScanMessagePage`）· `views/scanPageRenderer.js:1605`（`renderScanMessagePage`） |
| **验收** | 工作台那半是**前端自己渲染**（`public/workbench/features/orders/**` + `POST /purchase/arrivals/confirm` 的 JSON） | `routes/workbench.js:193-215` |

**"三个入口"（她要求**全删** ✗）**：`config/scanPage.js:686-688` 的三条文案 ＋ `renderer:1739-1743` 的三颗 `<a>`：

```
continueButton: '继续录下一单（去扫码）'   · workbenchButton: '去工作台看这一单' · fillPaymentButton: '补整单付款'
```

⚠️ 另有**一处相关但不同**的页面：`renderer:1711`（资金页"待补款"那一屏，也用了 `fillPaymentButton`）——
**它不是成功页**，本任务**不要顺手删它** ✗（她的"不要任何链接"说的是**提交成功页**；
那一屏是"她选择跳过付款"后的**待补款提示**，删了会失去出口 ⇒ **建议 Lead 一并确认**，我按"不删"记 ✓）。

---

## 4. 改动清单（给实现者；🔴 全部"不改既有语义"）

| # | 文件 | 改什么 | 边界 |
| --- | --- | --- | --- |
| **C-1** | **新建** `server/src/services/purchaseWriteBackgroundService.js` | 照 `saleWriteBackgroundService` 三件套：`schedulePurchaseRest`（后台跑"余下几步"）/ `markPurchaseWriteFailed`（失败如实落地）/ `waitForPendingPurchaseBackgrounds`（用例接缝） | **只挪不改**：仍调既有三个写入件；幂等键、状态值域、日志名**逐字不动** ✗ |
| **C-2** | `server/src/config/scanWrite.js` | 扩 `asyncWrite` 成**按链路**可配（例：`asyncWrite: { sales: {...}, replenish: {...}, purchaseReturn: {...}, acceptance: {...} }`，各含 `enabled` / `doneBodyTemplate` / `backgroundTimeoutMs`） | **显式布尔**（`readFlag`，空串 = 关）· 🔴 **禁 `process.env.X \|\| fallback`** ✗ |
| **C-3** | `server/src/config/scanPage.js` | 新增**成功页一处文案**：`submittedSuccess: { title: '已提交成功', body: '数据会更新' }`（四条链路共用 ✓）；**删**三入口文案 `continueButton/workbenchButton/fillPaymentButton` | 文案的家在 `config/**` ✓（`noHardcodedChinese` 闸门在） |
| **C-4** | `server/src/views/scanPageRenderer.js` | 新增**一个** `renderSubmittedSuccessPage`（四条链路共用：那句话 + 单号（有就显示、**没有不编** ✗），**零 `<a>` / 零按钮**）；`renderSaleSuccessPage` 保留为**薄包装**或直接改指向 | 🔴 **不删**资金页那屏（`renderer:1711`）✗ · 其余渲染 AC 必须原样绿 |
| **C-5** | `server/src/routes/scanPage.js` | 三条链路各改成：**先校验/先建号 ⇒ 立刻回成功页 ⇒ 把余下几步交后台**（照销售那一处 `scanWriteService.js:1187` 的形状） | 🔴 **`respondWriteFailure` 的 400/500 口径逐字不动** ✗（她填错仍要**当场拦**，见 §6 风险） |
| **C-6** | `server/src/services/scanWriteService.js` | 只在**必要**处接线（三条链路各自的"先受理 + 后台续写"）；⚠️ **该文件余量 0 行** ⇒ 能不改就不改（优先把新逻辑放 C-1） | 幂等/`_confirm` 哨兵原样 ✓ |
| **C-7** | 工作台侧（`routes/workbench.js` / `public/workbench/**`） | 验收那半：失败/未完成**复用**既有「未完成，可点重试」形状（与本仓既有的 `POST /api/workbench/sales/retry` 同款思路） | 🔴 只**复用**既有形状，**不新开鉴权/写库** ✗ |

**顺序（硬约束）**：🔴 本任务与 **`task-46`（补货/退货的路由接线）严格串行** ✗（同一片区域）
—— 建议 **先 `task-46`、再本任务**（先同步做对 N=1，再把余下几步放后台 ✓）。

---

## 5. 配置清单（全部走 `config/**`；显式布尔、禁 `||` 兜底 ✗）

| 键（示例） | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `SCAN_REPLENISH_ASYNC_WRITE_ENABLED` | 显式布尔 | `true` | 补货异步开关（**空串 = 关** ✓） |
| `SCAN_RETURN_ASYNC_WRITE_ENABLED` | 显式布尔 | `true` | 退货异步开关 |
| `SCAN_ACCEPTANCE_ASYNC_WRITE_ENABLED` | 显式布尔 | `true` | 验收异步开关（⚠️ 先定"哪一半"，见 §3.1） |
| `SCAN_*_ASYNC_DONE_BODY` | 字符串模版 | `'本单已创建成功（{orderNo}）'` | 受理那句话（**四条链路共用一处**优先 ✓；要分开就分开配） |
| `SCAN_*_ASYNC_TIMEOUT_MS` | 整数 | `180000` | 看门狗阈值（**只记 warn、不取消写入** ✗） |
| 成功页文案 | 字符串 | `'已提交成功'` / `'数据会更新'` | 一处定义（`config/scanPage.js` ✓） |

⚠️ **既有销售那三个键（`SCAN_SALE_ASYNC_WRITE_ENABLED` / `SCAN_SALE_ASYNC_DONE_BODY` / `SCAN_SALE_ASYNC_TIMEOUT_MS`，`config/scanWrite.js:336-341`）不许改名/不许改语义** ✗
⇒ 建议：**保留原名**，新的三条用 `SCAN_{REPLENISH,RETURN,ACCEPTANCE}_ASYNC_*`（**加键，不改键** ✓）。

---

## 6. 判据草案（每条都写成"能真红"）

> 写法：**判据 → 怎么写成能真红 → 变异（塞回去必红）**。实现时先写用例、再写代码 ✓

| AC | 判据 | 能真红的写法 | 变异 |
| --- | --- | --- | --- |
| **AC-ASY1** | 补货 / 退货 / 验收**各自**：提交 ⇒ **先回成功页**（后台还没写完也算"已收到"）⇒ 后台写完后数据**真的落库** | 假网关注入"写很慢"（延迟 N 秒）⇒ **断言响应在延迟结束前就回来**且带成功页那句话；随后 `await result.background`（或 `waitForPendingPurchaseBackgrounds()`）⇒ 断言表里真有行 | 把后台改回同步 ⇒ 响应变晚 ⇒ **红** |
| **AC-ASY2** | 🔴 **失败如实**：后台写失败 ⇒ **不许停在成功页当没事** ✗ | 假网关让后台那一跑抛错 ⇒ 断言 ①主表/批次行落「**写入失败**」②日志有 `*.failed` ③**可重试**（同一把 `submitKey` 再跑 ⇒ 只写一次） | 删掉失败标记 ⇒ **红** |
| **AC-ASY3** | **幂等不拆**：重试/并发 ⇒ **只写一次**（同一把 `submitKey`；既有那条判据**原样** ✓） | 串行 2 跑 + 并发 2 跑 ⇒ 断言批次行/明细行/库存流水**各只 1 份** | 换一把新键 ⇒ **红** |
| **AC-ASY4** | 既有判据**一条不放宽**（改判据写「改前逐字 → 改后逐字 → 依据」✗ 不许删/skip） | 逐条点名 §7 的文件**原样绿** | 删/放宽任一条 ⇒ **红**（用 `git diff` 数断言行数） |
| **AC-ASY5** | 两遍全量 EXIT=0 ×2 ＋ **CI 四件全绿** | 两遍之间源码 md5 不变 | —— |
| **AC-SP1** | 四条链路成功页**同一句话** ＋ **没有任何 `<a href>` / `<button>`** | 四条链路各跑一次 ⇒ 断言 HTML 里**同一句文案**出现、且 `success-actions`/`<a`/`<button>` **一个都没有** | 塞回任一个入口 ⇒ **红** |
| **AC-SP2** | **配置驱动**：改文案/改开关**不用改代码** | 注入不同 config ⇒ 页面文案/开关行为跟着变 | 把文案写死进 renderer ⇒ **红**（`noHardcodedChinese` 也会红） |

⚠️ **AC-ASY1 有一个必须写清的边界**：**"校验"仍要同步当场拦** ✗ ——
她填错（金额非法 / 尺码不存在 / 超库存）**必须当场 400 + 人话 + 零写入**（`respondWriteFailure` 的 400 口径）；
**只有"校验通过之后的写库"才异步** ✓。否则会把"她填错了"变成"看起来成功、其实没写"——正是她最恨的假成功 ✗。

---

## 7. 会受影响的既有判据清单（要**逐条改指向**，一条不许删/skip ✗）

| 文件 | 为什么会被影响 | 迁移方向（改指向，不放宽 ✗） |
| --- | --- | --- |
| `server/test/scanSaleTwoStepPage.test.js` | **唯一**钉着 `renderSaleSuccessPage` 源码与三入口的用例 | 「三入口必须在」⇒ 改成「**三入口必须不在**」＋「同一句话在」 |
| `server/test/scanPageWrite.test.js` · `scanSaleE2E.test.js` · `scanRecordIdRoute.test.js` · `scanPageDraftBar.test.js` | 现在都假设**提交返回时后台已写完**（同步） | 本地提交助手加一行 `await result.background`（**照 ⑨b-2 的既有做法** ✓）＋ 响应/时序判据改指向 |
| `server/test/salesAsyncWrite.test.js` · `saleWriteBackgroundExtract.test.js` | 销售异步的既有判据（**一个字不放宽** ✗） | **不动**；只把新三条链路的用例**照它的形状**新增 ✓ |
| `server/test/acceptLandingFeedback.test.js` · `acceptLandingSelfServe.test.js` · `acceptanceIdempotency.test.js` · `acceptanceArrivalStatus.test.js` | 验收的落地/幂等/状态（异步后"提交即回"会改变时序） | 加 `await` 接缝；**幂等与状态值域判据逐字不动** ✓ |
| `server/test/scanPurchaseAmountRequired.test.js` · `scanPurchaseAmountWrite.test.js` | 金额闸门（补货不问金额属 `task-50`） | 本任务**不动**；但**先同步拦、再异步写**的顺序要钉一条 ✓ |
| `server/test/noHardcodedChinese.test.js` | 新文案不许硬编码 | 新文案一律进 `config/**` ✓ |
| `server/test/scanPageDraftBar.test.js`（同 ⑨b-2 那套 67 条） | 翻异步开关后会"读得太早" | 照既有诊断：**加 `await` 接缝**，**不是判据错** ✓ |

---

## 8. 风险 / 不做的事 / 复核命令

**风险**
1. 🔴 **假成功**：成功页只说"**系统已收到**" ✓；**真写失败必须有人话出口 + 可重试** ✗（AC-ASY2）。
2. 🔴 **同步→异步会把"她填错"变成"看起来成功"** ⇒ §6 那条边界（**校验仍同步当场拦**）。
3. 🔴 **幂等不许拆**：三条链路各自的 `submitKey`（含验收的 `accept:<session_id>:<轮次>`）**一个字不改** ✗。
4. ⚠️ **验收"哪一半"未定**（§3.1）⇒ 建议 Lead 向她确认一句再开工。
5. ⚠️ **`renderer:1711`（待补款那屏）不要顺手删**（§3.3）。
6. ⚠️ **热点冲突**：与 `task-46` 严格串行；P0 那刀在改 `scanPage.js`/`scanWrite.js`/`renderer` ⇒ 开工前先 `git fetch` 看谁在动。

**不做（本任务范围外）**
- 金额口径（`task-50`）· 一单多货路由接线（`task-46`）· 工作台订单列表/资金页版式 · 任何"跳转/链接"（她要**零跳转** ✗）。

**复核命令（改前改后各跑一次，留证据）**
```bash
git -C . rev-parse --short HEAD && git -C . rev-list --count HEAD..origin/main   # 必须 0
cd server && node --test --test-concurrency=1 --test-force-exit \
  test/scanSaleTwoStepPage.test.js test/scanPageWrite.test.js test/salesAsyncWrite.test.js \
  test/acceptLandingFeedback.test.js test/acceptanceIdempotency.test.js          # 受影响的先绿
# 两遍全量
cd server && rm -rf data && node --test --test-concurrency=1 --test-force-exit \
  $(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)
```

**本次只读自证**：`git status --porcelain` 只有**这一个新文件** ✓（见 PR）。
