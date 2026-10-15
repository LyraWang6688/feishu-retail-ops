# task-53 改动计划 + 判据草案 —— P0 第二刀「跳转前置判定」＋ 恢复 `⑨` 期望 400

> **本文件是【只读准备】的产物**：没有改任何源码 ✗（`routes/scanPage.js` / `views/**` / `scanWriteService.js` 一个字没碰）。
> 落点行号全部在**本 worktree 的 base `ea3bf0c`**（= 写这份计划时的 `origin/main`）上**只读核出** ——
> 核法：`grep -n` + `sed -n` 读原文；`scanPage.js` 在 `7ec5d6b → ea3bf0c` 之间**没有变化**（#663 只动
> `config/saleSettlement.js` / 测试 / `.env.example` ✓ 见 `git show --stat ea3bf0c`）。

---

## 0. 依据（她逐字 + 任务书里 15 次尝试换来的硬事实）

她的原话（task-53 任务书，逐字，不许改写 ✗）：

> 「我们能够**跳转到资金页面**的前提，是用户在**点击提交的那一刻**，系统能不能获取到关于这个**会话的尺码信息**以及**货品单价信息**。
>  **单价信息可能来自用户的手动输入，也可能来自货品信息里的数据**。如果**这两个都取不到，用户就无法跳转到资金页**」

`⑨` 的「改前逐字」（**原文抄录在 PR #659 的描述里**，本刀要逐字改回 ✓）：

> `assert.equal(response.status, 400, '两个都取不到 ⇒ 拦住（不跳资金页）')`
> ＋「必须有那句『**这一款没录单价，请填金额**』的人话」＋「零写入」

🔴 已知真因（别重走 ✗）：判定曾经被**老那层** `if (lineAmountRequired && lineAmounts.some(空))`（`:1771`）**包住** ⇒
`lineAmounts` 是**空数组**时 `.some(...)` 恒 `false` ⇒ **整段不执行**；而往前挪到更早的出口会罩住
**幂等连点 / 重复提交 / 刷新 / 资金页动作**（当晚被误拦出 6～13 条红 ✗）。

---

## 1. 落点（`server/src/routes/scanPage.js`，base `ea3bf0c`）

| 行 | 是什么 | 与判定的关系 |
|---|---|---|
| `:1695` | `if (action === actions.submitOrder) {` | 提交分支入口（`submitOrder` 与资金页动作**天然分开** ✓） |
| `:1708-1710` | `submitSession` / `pendingDraftLines`（会话草稿行） | 判定的"会话"来源 |
| `:1711-1718` | `lineAmounts` 三档回落（body `line_amount` → 草稿行 `amount` → 单行 `amount`） | **单价①「她填的」** 的真源 |
| `:1730-1766` | `saveDraftLines({ lines, paymentStep:'pending', status:draft, submitPending:{ lineAmounts, … } })` | 会话标记（①刀特意**上移到闸门之前** ⇒ 拦住也不会让她卡死 ✓）**不许动它** |
| `:1771-1783` | 老那层 `lineAmountRequired && lineAmounts.some(空)` ⇒ 400 资金页 | 既有行为**一字不改** ✓（判定**不许写进这个 if 里** ✗） |
| `:1793-1797` | `submitView = body[size] ? await service.lookup(...) : null` ＋ `saleTiming.lookup_ms` | **本次带 size 才会 lookup** ⇒ 「货品信息单价」的第一来源 |
| **`:1808-1812`** | **`return sendPaymentStep(res, req, { realm, submitKey, count })`** | ⭐ **"点提交要跳资金页"的那一个出口** —— **判定就插在 `:1797` 之后、`:1808` 之前** ✓ |
| `:1813-1834` | `writeService.submitSale(...)`（`// eslint-disable-next-line no-unreachable`） | **不可达残留**（点提交不建单 ✓）—— 判定**不要**放到它后面 ✗ |

**为什么正好是这个位置**（三条都实测过）：
1. **贴住出口**：一跳资金页就必须先过它 ⇒ 不会"跳了又拦"✗；
2. **不往前挪**：`:1695` 到 `:1797` 之间那些"更早的出口"会连带罩住幂等/重复提交/刷新/资金页动作 ✗（①刀那 6～13 条红就是挪早了）；
3. **在 `submitView` 之后**：单价②（货品信息单价）那一读就在 `:1794`，判定放它前面就拿不到 —— 也**不必**多打一次飞书请求 ✓。

### 1.1 `⑨` 判据现在在哪一行

- `server/test/scanPageWrite.test.js:864-910`（用例名 `⑨ 【迁移·甲】没填实收 ⇒ 拦住 + 必填人话（醒目）…`）
  - `:890-899` = ①刀写的「改前逐字 / 改后逐字 / 依据」注释（**原文留着**，本刀把两边对调并补依据 ✓）
  - **`:900` = 现在钉的现状**：`assert.equal(response.status, 200, '现状（判定未上线）⇒ 放行到资金页');`
  - `:901-907` = 现状那一组（成功页 / 单子真建出来 / 实收留空 / 跳过不写收款）
- **本刀的恢复** = 把 `:900` 改回 `assert.equal(response.status, 400, '两个都取不到 ⇒ 拦住（不跳资金页）')`
  ＋ 断言「人话『这一款没录单价，请填金额』」（落在货品页 HTML 里）
  ＋ 断言「零写入」（四张表全 0）；**`⑨` 这条用例不许删 / 不许 skip** ✗。

---

## 2. 哪些请求会进判定（真值表 · 按任务书那"能干净区分的那一列"）

判定的**入口条件**（三条同时成立才判）：
```
① action === writeConfig.actions.submitOrder            （资金页两颗是 payAction / skipAction ⇒ 天然分开 ✓）
② 这一发【不带收款字段】：SCAN_WRITE.fields.paymentMethod / paymentAmount / lineAmount 都不在 body ✓
③ 会话标记 paymentStep !== 'pending'                     （连点第二次 / 刷新 与 ⑨ 同形 ⇒ 只能靠它 ✓）
```
| 形状 | 例子（`file:line`） | 进判定？ | 期望 |
|---|---|---|---|
| ⑨ 该拦 | `test/scanPageWrite.test.js:882-889`（只带 `action`/`submit_key`/`payment_status`） | **进** ✓ | **400 + 人话 + 零写入**（本刀要恢复的） |
| 幂等连点 | `test/scanSaleE2E.test.js:652-653`（带 `payment_method`/`payment_amount`/`line_amount`） | 不进 ✓ | 200 资金页 |
| 重复提交文案 | `test/scanSaleE2E.test.js:1128-1131`（带 `line_amount:['280']`） | 不进 ✓ | 200 |
| **多行 + 本次不带 size** | `test/scanSaleE2E.test.js:1173-1177`（AC-E2E-16 step1：**不带**收款字段 ⇒ **进**；它在 `:1176-1177` 明写「200 + `data-view="payment-step"`」） | **进** ✓ | 200 资金页（草稿有尺码 ✓；**单价②必须能覆盖"本次不带 size"** ⇒ 见 §3） |
| 资金页收款/跳过 | `routes/scanPage.js:1250`（`payAction`）/ `:1533`（`skipAction`） | 不进 ✓ | 照旧 |
| 刷新 | `GET`（`:1249` 认标记那条路） | 不进（不是 POST）✓ | 照旧资金页 |

⚠️ **实现时必须逐个跑一遍**的文件（都是"POST `submitOrder` 且不带收款字段"的）：
`test/scanPageWrite.test.js`（⑨ 系列 + AC-P0*）· `test/scanSaleE2E.test.js`（AC-E2E-16）·
`test/scanPaymentStepStale.test.js:165-172`（`submitOrder` 带 `size:'41'`，不带收款 ⇒ 进判定）·
**`test/scanSalePayFront.test.js:130-167`**（**裸体** `{action: submitOrder}` ＋ **桩 sessions**：
`get` 返回 `{sale:{lines:[]}}` ⇒ 尺码/单价两个来源都可能取不到 ⇒ **这是最可能被误拦的文件，先跑它** ✗）。

---

## 3. 判定的三个输入从哪来（**全部只读** ✓，一行新的写都没有）

| 输入 | 真源 | 说明 |
|---|---|---|
| **尺码** | `body[fields.size]`（`config/scanWrite.js:147`）＋ 草稿行的 `size`（`scanWriteService.js:549` 写入） | 多行时本次 body **不带** size ⇒ 必须看草稿行；⚠️ **配品行没有尺码**（`config/sellableKinds` 的 `requiresSize=false`）⇒ 尺码这一项对配品**不适用**，不许因此拦住 ✗ |
| **单价①：她填的** | `lineAmounts`（`:1711-1718`）任一非空 | 与 `submitPending.lineAmounts` 同一份（**不许另算一份** ✗） |
| **单价②：货品信息单价** | 本次带 size ⇒ `submitView?.price_text`（`services/scanPageService.js:1297` 从「货品信息.单价」格式化）；**本次不带 size ⇒ 按草稿行的 `number` 走既有 `service.lookup({ number })`** | ⭐ 这一条是 **AC-E2E-16 的硬要求**（它就是"不带 size"的多行提交）⇒ **只判 `submitView` 会让它红** ✗ |
| **单价③：配品单价** | 「其他配品.单价」= `config/v1BitableSchema.js:84`（`accessory.fields.price`） | 路由侧**今天没有**这条读取：`salesEntryService.listAccessories` 只回 `record_id/name/category`（`:110-121`）⇒ 要用就 `gateway.get('accessory', line.accessory_record_id)`（只读一条，通常 0～1 次；`gateway` 在路由作用域里 ✓） |

**成本护栏（建议写进注释）**：`lineAmounts` 非空 ⇒ **根本不用**去 lookup（她填了就算有单价 ✓）；
只有 `lineAmounts` 全空时才逐行 lookup，且**命中第一个非空价就停**（她要的是"任一有值"）。

---

## 4. ⚠️ 必须你裁的一处歧义：「这两个都取不到」指哪两个

| 读法 | 拦住条件 | 与 `⑨` 的兼容性 | 与 AC-E2E-16 的兼容性 |
|---|---|---|---|
| **A（我推荐）** | 「两个」= **单价的两个来源**（她填的 ‖ 货品信息/其他配品单价）都取不到 ⇒ 拦 | ✅ `⑨` 的夹具**尺码是有的**（草稿行 `size:40`，`:869-871`）而 PR #659 抄录的人话是**「这一款没录单价，请填金额」**（纯单价）⇒ 拦住的原因**只能**是单价 ⇒ A 自洽 ✓ | ✅ 产品有单价 ⇒ 放行 ✓ |
| B | 「两个」= **尺码 ＋ 单价**，尺码也取不到 ⇒ 拦 | ❌ `⑨` 尺码有 ⇒ **拦不住** ⇒ 与"恢复 400"冲突 ✗ | ❌ 若把"本次不带 size"当尺码取不到 ⇒ 直接误拦 ✗ |

**建议**：以 **A** 为准；尺码只做**可选兜底**（"确实要尺码却一条都没有"时给一句尺码人话），**不进挡住条件**。
⚠️ 请回 **A / B**（或你的第三种口径）—— 我不猜 ✗。**其余部分不受这个选择影响**，可以先动。

---

## 5. 判据草案（每条**能真红** ✓；变异法写在括号里）

- **AC-J1 ⭐ `⑨` 恢复**：第一次点提交、**单价两个来源都取不到** ⇒ **400 ＋ 停在货品页 ＋ 人话「这一款没录单价，请填金额」＋ 零写入**。
  （变异：删掉判定块 ⇒ 红。落点 = `test/scanPageWrite.test.js` 原 `⑨` 位置，`:900` 逐字改回。）
- **AC-J2**：她填了金额（body `line_amount`）⇒ 200 资金页。
  （变异：把判定写成"恒拦" ⇒ 红。）
- **AC-J3**：本次带 size 且货品有单价 ⇒ 200 资金页（`submitView.price_text` 非空；**不改** lookup mock）。
- **AC-J4 ⭐ 多行 · 本次不带 size**：草稿行有货号、货品有单价 ⇒ 200 资金页。
  （变异：只判 `submitView` ⇒ 红 —— 这正是 AC-E2E-16 会抓的那条。）
- **AC-J5**：被拦那一下 **零写入**：`salesEntry / salesDetail / paymentRecord / inventoryLedger` 全 0。
- **AC-J6**：被拦的 HTML **不含** `data-view="payment-step"`（= 真的"停在她原来的货品页"，不是"跳到资金页再报错"）。
- **AC-J7 ⭐ 反向哨兵**：幂等连点（AC-E2E-6）/ 重复提交（AC-E2E-15）/ 刷新（AC-SM8/9）/ 资金页动作（`payAction`/`skipAction`）⇒ **一律不许 400**。
  （变异：把入口条件里的"不带收款字段"或 `paymentStep` 去掉 ⇒ 红。）
- **AC-J8**：配品行 ⇒ 单价取「其他配品.单价」；有 ⇒ 放行；没有且她没填 ⇒ 拦。
- **AC-J9（可选，若你选 B）**：确实要尺码却一条都没有 ⇒ 单独一句尺码人话。
- **两侧不回归**（任务书点名）：**提交支** = 钱真落库（实收/收款有值、240 不丢）＋ 状态**不是**「待补充」；**跳过支** = 状态**是**「待补充」＋ 三处文案（跳过按钮 / `workbenchHint` / `payPendingNote`）**都在** ✗ 不许删。

---

## 6. 动手时的护栏（我核到的，都会让 CI 真红）

1. 🔴 **新文案不许出现「成交金额」/「交易方式」**：`test/scanSaleTwoLayerMoney.test.js:300`（页面 HTML 不许有「成交金额」）＋ `:1275`（旧列名字面量清单）。
   ⚠️ #659 就是**栽在这**（`jumpNeedsAmountBody` 里写了「成交金额」⇒ CI 红 ✗ 见 `docs/ci-two-real-findings-2026-10-16.md` ①）⇒ 新文案写成「**这一款没录单价，请填金额**」这类**不含旧列名**的话 ✓，且**走 `config/scanWrite.js`**（配置先行 ✓）。
2. 🔴 **`services/scanWriteService.js` 一个字不加**（余量 0 行 ✗）—— 所有新逻辑落在路由 + 配置 + 测试。
3. 🔴 **不新开鉴权 / 不新开写入口**：判定只读（`sessions.get` / `service.lookup` / 可选 `gateway.get('accessory')`）。
4. 🔴 **老那层 400（`:1771-1783`）行为逐字不变**；新判定**独立成一块**（不塞进那个 `if` 里 ✗）。
5. 🔴 **修复清单纪律**（任务书）：动手前写 3 行清单（① 插判定 ② 恢复 ⑨ ③ 新增 AC-J 文件），**每次 `git checkout --` 之后先核清单还在不在**。

### 修复清单（3 行，照抄）
```
1) routes/scanPage.js：:1797 之后、:1808 之前插入「跳转前置判定」（只读；不通过 ⇒ 人话页 + 零写入）
2) test/scanPageWrite.test.js：:900 起把「钉现状」逐字改回 400 + 人话 + 零写入（注释两边对调 + 补依据）
3) 新增 test/scanJumpGate.test.js：AC-J1…AC-J8（每条能真红）＋ 反向哨兵 AC-J7
```

---

## 7. 夹具核查（只读结论，回答任务书那条"夹具疑点"）

- ✅ `test/scanPageWrite.test.js:244` 用的是**真的** `createScanSessionService`（`services/scanSessionService.js:103` 有 `get`）
  ⇒ **`sessions.get` 存在**，任务书里"夹具可能只实现 `saveDraftLines`、没实现 `get`"这条**在本文件不成立** ✓
  ⇒ 所以 `⑨` 恢复 400 时，守卫看到的是**真实会话**（草稿行 `size:40`、`amount:''`）—— 这也是 §4 选 A 的证据之一。
- ⚠️ 用 `sessions` **桩**、且可能进判定的文件（实现时逐个核）：`test/scanSalePayFront.test.js:44`（`get` 返回 `{sale:{lines:[]}}`）·
  `test/scanPaymentStepStale.test.js`（`fakeWriteService`）· `test/scanNumberFallback.test.js:141` ·
  `test/scanPageDraftBar.test.js:397` · `test/scanPrintFeedback.test.js:240` · `test/scanPurchaseAmountRequired.test.js:115` ·
  `test/scanRecordIdRoute.test.js:133` · `test/scanReturnSizeList.test.js:93` · `test/scanReturnStockFilter.test.js:71`
  （后几个是补货/退货/领域用例 ⇒ 多半不 POST `submitOrder`，但**别假设**，逐个 grep 一次 `actions.submitOrder` 更便宜）。

---

## 8. 验收与收尾（task-53）

```
cd server
node --test --test-concurrency=1 --test-force-exit $(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)
```
- **两遍 EXIT=0 ×2**（两遍之间**一个字都不改**；那条真表 E2E 按既有口径排除 —— 它缺 `FEISHU_V1_E2E_TEST_APP_TOKEN` 时本来就 skip ⇒ 与 CI 一致 ✓）
- 关键四文件先单跑：`scanPageWrite` · `scanSaleE2E` · `scanSaleTwoLayerMoney` · `scanPaymentStepStale`（＋ **`scanSalePayFront`** ✗ 最可能被误拦）
- **变异真红**：AC-J1（删判定）/ AC-J4（只判 `submitView`）/ AC-J7（去掉入口条件）各做一次"能真红"演示，还原后**字节一致**
- 新 worktree（base = 动手时的 `origin/main`）· push → PR（PR 里写"⑨ 逐字改回"＋"新判定落点 `:1797→:1808`"＋两遍数字）· **回报 Lead，不合并** ✓
- 🔴 严禁部署 · 生产 Base 只读 · 严禁飞书 CLI · 不许 `--admin` · 汇报用上海时间
