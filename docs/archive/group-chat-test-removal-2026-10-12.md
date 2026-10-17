# 群聊入口清除 · 测试移除对照表（2026-10-12）

> 背景：业务负责人 2026-10-12 拍板 **彻底删掉**「群聊自然语言录入」那条已不可达的链路
> （10 个方法 + 6 个群卡片导出）。清理前先做**可达性分析**，再按**硬判据**逐条决定测试去向：
>
> - **判据 (a)**：用例验证的实现在删除清单里（随能力一起消失）⇒ **可以删**（测试与能力同生共死）
> - **判据 (b)**：用例验证的实现**还活着**（共享层/保留件，扫码页或工作台在用）⇒ 🔴 **不许删，必须迁移**
>
> 本文档是第一轮（判据 (a)）的**逐条对照表**：用例名 · 验的能力 · 现状 · 判据。
> ⚠️ 条数下降是**诚实的**：能力退场 ⇒ 覆盖随之退场（不是"悄悄丢验证"）。

## 判据 (a)：随能力退场而删除（99 条）

### larkMvpService.test.js: 删 69 条（原 78 → 9）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `sales intake writes only intake metadata and retains actual amount before confirmation`
- `two products and two payments stay in one sales draft and confirmation card`
- `voucher sale card and posting retain separate settled and platform-pending receipts`
- `quoted actual sale amount may differ from Bitable list price`
- `unsupported text is parsed but does not create a sales entry record`
- `failed card posting returns the draft to a retryable state`
- `sale card shows processing immediately and becomes action-free after posting`
- `two clicks on the same sale draft post once and repair the already processed card`
- `sale final-card patch failure sends a new result card without reversing a posted sale`
- `delivered confirmation writes sale first then delegates stock to delivery owner`
- `stock failure after sale posting is not presented as sale posting failure`
- `partial delivery reports the failed shoe while preserving later successful deliveries`
- `failed sale posting restores action buttons for retry`
- `sale card persists written record IDs and distinguishes pending sync from failed creation`
- `a multi-color SKU without a spoken color still reaches the confirmation card`
- `confirming is refused until every item has a chosen color, and choosing one settles it`
- `an accessory name is matched to the accessory table by exact name`
- `an accessory name that is not in the table is asked for instead of guessed`
- `分类下唯一时直接用它，实收金额以用户说的为准（不是名称里的价）`
- `分类下有多档时，用用户说的金额对到正确那一档`
- `腰带：她说的 119 只用来对档位，实收金额记实收 100（她的真实一单）`
- `分类下有多档但金额对不上时不猜，提示有哪几档`
- `分类里没有这个词时，退回按名称精确匹配（向后兼容）`
- `分类和名称都匹配不到时，仍然报「没有这一件」`
- `分类唯一时即使用户没给金额也能定位到配品（金额另按原有规则追问）`
- `配品改按分类匹配后，鞋仍然按「货号+尺码」走实时库存（回归）`
- `真机错法（鞋 400 + 腰带 140 ⇒ 合计 540 ≠ 总额 400）：只回一句"对不上"的追问，绝不出发确认卡片`
- `库存里没有这个尺码 → 记**预定**、照出确认卡片（不再是"请核实"那句拦截）`
- `真机原话「定金微信交了 100 元，下次欠 128 元」（没库存）→ 无缺项、出确认卡片、记**预定**`
- `她没说定金收了多少（也没库存）→ 仍然要求补充定金金额（这一条不放宽）`
- `没库存（原「预付」单）：解析 B **照样跑** —— 它就是类型判据；颜色仍由 A 定`
- `没库存 + 货品信息里有多个颜色 → 仍然让她在卡片上选（销售明细要写全）`
- `现货单：A 定下的单色就是这一单的颜色与货品，B 只拿它去查库存（不再用 B 覆盖 A）`
- `现货单：A 说「黑」、实时库存 37 码只有「白」→ 查「黑」查不到 ⇒ 记**预定**（不再是拦截）`
- `现货原话但库存里没有 → 记**预定**（不交付、不扣库存；不再拦单）`
- `她说「未付」但库存里没有 → 类型仍是**预定**（「未付」不再是类型，它只说钱）`
- `① 现货 + 多颜色未选颜色 → B 一次都没跑；卡片给候选（按钮只有颜色名）`
- `①b 未付 + 多颜色：与现货一致 —— 先让她选，B 一次都不跑`
- `③ 现货候选「全都无货」的边界：候选照旧摆出来，按钮仍然只有颜色名`
- `③b 颜色写法不一致（A 说「棕」、库存键写「棕色」）→ 仍然认得出来，不许假缺货`
- `② 她选定颜色之后才跑 B：用她选中那条候选的记录 id，库存分布来自 B`
- `②b 选到无货的颜色 → **记成预定**（不再是"缺货提示"；候选收起、卡片更新）`
- `②c 选完颜色但「实时库存」读不到 → 不下"现货/预定"的结论，回一句让她再点一次（候选保留）`
- `④ 单颜色货号不问她（未付）：A 直接定下来，B 拿这个颜色去查`
- `⑤ 她嘴上说「定金」的单：多颜色先让她选；**选完照样跑 B** 定类型`
- `没问题能独立成句时，用完整的补充说明（缺货已不再是缺项）`
- `非群任务（遗留 JSON）走确认卡片路径 → **不发** + 记 `send_skipped` + 不留 `card_message_id``
- `两种交易类型：货号压根没建档 → 都拦、都不出卡片、都回那句可配文案（B 照跑）`
- `一单多双、只缺其中一双 → 只报那一双的货号，整单仍被拦`
- `同一个货号的两条明细（两个尺码）都没建档 → 只报一次，不重复两遍`
- `货号在货品信息里、只是齐备公式说缺字段 → 仍然不拦、正常出确认卡片（「缺资料不拦」）`
- `配品不走「货号建档」判据：不去货品信息里找它、也不因此多一条缺项`
- `现货单：货号已建档 + 有货 → 照旧正常出确认卡片（既有链路不破，也不记拦截事件）`
- `拦截时那条正向证据日志在：lark.sales.product_missing.blocked 带 task_id / item_no / size`
- `开关关掉（SALES_PRODUCT_REGISTRATION_GUARD_ENABLED=false）→ 不拦，但仍留一条"本可以拦"的痕迹`
- `文案可配：SALES_PRODUCT_REGISTRATION_MISSING_TEXT 里 {item_no} 换成这一条的货号`
- `读不到「货品信息」（索引没建出来）→ 不下"没建档"的结论、不拦单，但记一条 undetermined 警告`
- `一单多双只读一次实时库存，不按双数重复全表读`
- `现货单（库里有）：卡片三段显示「类型：现货 / 履约状态：已交付」，确认后扣库存`
- `预定单（库里没有）：卡片三段显示「类型：预定 / 履约状态：未交付」，确认后不扣库存`
- `旧卡片上的交付按钮仍然可用：动作名映射到同一条路，不再让交付取决于按钮`
- `卖的是样品时：卡片上就让她选补哪个门盒，选完确认，不再另发一张补选卡`
- `门盒够的时候卡片不出现补偿区：不需要她为"补样品"多做一件事`
- `货品资料不齐时，缺口与记录链接算得出来；但确认卡片上不再挂这一段（已挪到点确认之后的卡片）`
- `货品齐备而且有样例图时，卡片上不出现这一区`
- `齐备但缺样例图 → 依然算缺口，且这段文字挂在已入账终态卡上`
- `读货品信息表失败时当作没有缺口，照常出确认卡片`
- `一单两件商品时，货品信息只读一次全表（不按件数重复读）`
- `同一个货号有多个颜色时，把该货号下所有资料不全的颜色都列出来`

### salesColorCandidatesAllColors.test.js: 删 8 条（原 9 → 1）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `① 一个在售 + 一个下架 → **两个颜色都出候选**（不再按在售过滤）；按钮只有颜色名`
- `①b 「货品状态」读不到（空串）→ 候选照旧全部保留（空 ≠ 下架）`
- `①c 多颜色（黑色 / 绿色）→ 候选按钮**逐字**只有颜色名，库存状况不同的两个候选也不带后缀`
- `② 全部颜色都没货 → 全部候选（按钮只有颜色名）；她选了其中一个 → 记**预定**（不交付、不拦单）`
- `②b 判据是库存：**同样输入**、库里只有「黑色」→ 选黑色 = 现货，选巧克力 = 预定`
- `②c 类型结论来自库存（正向证据日志 `lark.sales.trade_type.decided`）`
- `③ 全部颜色都是「下架」→ 仍然出全部候选、**不再拦**、不再有"都下架了"那句话`
- `④ 候选给全部颜色没有多读任何一张表（货品信息 2 次、实时库存 1 次，与原来一致）`

### productInfoGapsCardPlacement.test.js: 删 6 条（原 19 → 13）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `链路 ①：点确认后两张卡（处理中 + 已入账）都带这一段，确认卡片不再是它的家`
- `链路 ②：无缺口时，处理中卡与终态卡都不带这一段（确认卡见本文件第 1、5 条）`
- `链路 ③：终态卡带着这一段长期留着（posted 分支）`
- `链路 ④：已入账但交付没跑完（部分交付 / 交付失败）也带这一段 —— 同样是"已入账"的单据`
- `链路 ⑤：老卡片再点一次（duplicate_terminal）——已入账带、已取消不带`
- `链路 ⑥：取消 / 待修正**不带**这一段（原草稿不会入账，没有单据需要补资料）`

### salesMissingInfoText.test.js: 删 6 条（原 23 → 17）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `④ 判据没变：她的输入仍然 needs_info、仍然不回卡片、仍然不入账`
- `④ 判据没变：draft.missing_fields 与改动前**逐字相同**（机器契约一个字没动）`
- `④ 回她的那句话不漏代码标识符（原来表里那份「失败原因」已随列删除）`
- `AC-④ 走**真实的 processSalesTask**：只说了定金 → 回复里没有「已收比成交额多」`
- `AC-⑤ 哨兵：**真的**已收 > 成交额（成交额有值）→ 仍然报原来那句`
- `⑦ 「缺货」不再是缺项：没有实时库存 ⇒ 记**预定**、照出确认卡片（不再回"请核实"）`

### salesPrepaidColorResolution.test.js: 删 5 条（原 6 → 1）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `① 多颜色 + 库存里没有 → 出候选让她选；选完记**预定**（不交付、明细挂上货品）`
- `② 同样输入、库存里**有**那一个颜色 → 选完记**现货**（已交付 + 扣库存）`
- `③ 单颜色 + 库存里没有 → 录单即定**预定**；入账明细同样挂上货品、未交付`
- `③b 单颜色 + 库存里有 → 录单即定**现货**；已交付 + 扣库存`
- `④ 货号不存在 → 不编记录、不给她选；真实解析器仍然拒绝（不静默）`

### saleQueryFlow.test.js: 删 4 条（原 4 → 0）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `sale_query：查销售记录走只读链路，出无按钮卡片并写入候选上下文，零业务写`
- `sale_query 0 条：卡片告诉她在窗口里没查到，并问大概是哪天买的`
- `return：接线后走售后编排（出确认卡片），确认之前不调执行器、不写任何业务表`
- `原有销售链路不受影响：sale 意图照旧建销售主表并出确认卡片`

### salesProcessingCard.test.js: 删 1 条（原 6 → 5）

**验的能力现状**：该文件中的下列用例均由**已退场的群聊自然语言录入管线**驱动（`processSalesTask` / `handleSalesOrLegacyCardAction` / `saleLookupService` 入口层）；扫码页为结构化表单，无对应物 ⇒ **判据 (a)**。

- `点确认后的第一次卡片更新：标题=处理中、明细变灰、note 不变、无按钮、stage 仍是 processing`

## 判据 (b)：等价覆盖核对（第三轮，17 条）

⭐ 判据 (b) 的实现**还活着**（共享层/保留件）⇒ **不许删**。逐条核对"现成覆盖在哪"，
对不上的**新写**用例挂在**现行入口**上（扫码 `submitSale`——**不手拼 `postSale`+`deliver`**，
那是"自己拼链"，违反"测试必须走项目代码"的纪律）。

### 核对结论（17 条）

| # | 原用例 | 核心断言（逐字） | 等价覆盖在哪（文件:用例名:断言） | 处置 | 理由 |
|---|---|---|---|---|---|
| 1 | AC-12 单类型单（库里有）→ SALE_CASH | `item.trade_type_code === "SALE_CASH"` | `test/scanPageWrite.test.js:837`「⑩ 现货/预订：所选尺码在（样品+门盒）有货 ⇒ SALE_CASH，没货 ⇒ SALE_PREPAID」 | **等价覆盖** | 判据逐字同源 `salesTradeTypeForStock`；扫码侧已按"有货/没货"两态各断言一次 |
| 2 | AC-12 单类型单（库里没有）→ SALE_PREPAID | `item.trade_type_code === "SALE_PREPAID"` | 同上（同一条用例的第二态） | **等价覆盖** | 同上 |
| 3 | AC-14 一张混合单里两件都查库存 | 两件各自按实时库存定类型 | `test/scanSaleE2E.test.js:461`「AC-E2E-5 ⭐ 现货行已交付+库存真的少 1；预订行未交付、库存不动」 | **等价覆盖** | 该用例的输入**就是现货行+预订行的混合单**，逐行验类型/交付/库存 ⇒ 覆盖更强 |
| 4 | AC-8/AC-9 现货件交付并扣库存、预付件不交付（逐条） | 现货：`履约状态=已交付`+`inventoryLedger`≥1；预定：`未交付`+`inventoryLedger` 不存在 | 同上（`scanSaleE2E.test.js:461`） | **等价覆盖** | 逐行断言与这里逐字同形 |
| 5 | AC-1~AC-10 她那条原话：一张单·2 明细·3 收款·主表交易类型多选 | 一单多明细 + 多收款 + 主表「交易类型」多选 | ⚠️ **部分**：一单多明细 = `scanPageWrite.test.js:239`「① 连续扫三双 → 一张单+三条明细」；**多收款/多选类型** = 无 | **随能力退场（部分）** | 该断言验的是**自然语言里"卖了两件、收了三次钱"被解析成一张多明细单**；扫码页是**逐双扫码 + 资金区按行填**，没有"一句原话→多明细"这个能力 ⇒ 该语义不存在 |
| 6 | ③ 全款（现货 / 预定）2 条 | `receipts === [[228,"已收款"]]`+`pendingAmount=0` | 无（扫码侧只覆盖"未付不写未收款"） | **新写** | 扫码侧"全款"路径未被断言过 |
| 7 | ③ 部分：先给 100、还欠 128（现货 / 预定）2 条 | `receipts === [[100,"已收款"],[128,"未收款"]]`+`pendingAmount=128` | 无 | **新写** | ⚠️ 扫码侧**没有**"部分收款 ⇒ 两条收款行"的断言（`scanPageWrite.test.js:318` 只覆盖"未付 ⇒ 一条都不写"，语义不同） |
| 8 | ③ 没付：整单未付（现货 / 预定）2 条 | `receipts === [[228,"未收款"]]`+`pendingAmount=228` | ⚠️ **不同语义**：`scanPageWrite.test.js:318`「实收留空+未付 → 差额 0 ⇒ 一条未收款都不写」 | **新写** | 群聊口径是"她**说了**未付 ⇒ 写一条未收款"；扫码口径是"**没填**就留空 ⇒ 不写" ⇒ **不是等价覆盖**（这条最容易被误判成"已有覆盖"，特意标出） |
| 9 | ③ 定金 100 + 尾款 128（现货 / 预定）2 条 | `receipts === [[100,"已收款"],[128,"未收款"]]` | 无 | **新写** | 同上 |
| 10 | ③ 定金 100 + **下次收** 120（现货 / 预定）2 条 | 同上（成交额由后端推） | 无 | **新写** | ⚠️ 这条还在**解析层**（"下次收"=尾款）——解析层已退场；扫码页直接填两笔金额 ⇒ 只保留"两笔 ⇒ 已收+未收"这一条通用语义（并入上一条新用例） |
| 11 | ③ 预定+全款 / 预定+没付都能入账 | 预定也能全款收清 / 一分没付 | `scanSaleE2E.test.js:604`「AC-E2E-8 只填实收（或什么都不填）⇒ 一定能提交成单」 | **等价覆盖** | "预定单不被钱卡住"这条边界在扫码侧已断言 |
| 12 | ③ 同一份资金原话：库里有/没有 → 收款**逐字相同** | `deepEqual(withStock.receipts, withoutStock.receipts)` + `notEqual(trade_type_code)` | **无** | **新写 ⭐** | ⭐ 这正是 Lead 预判的"**跨两态对照**强断言"——扫码侧是两条独立用例，**没有"同一输入跑两态再做逐字对照"** |

### 新写用例的落点（设计已定，供第三轮实施）

- **文件**：`test/scanPageWrite.test.js`（**复用其现成 `createHarness`**，不另搭 harness ⇒ 仍走项目代码）
- **入口**：`createHarness({ tables: … })` → `addSaleLine(...)` → `submitSale({ openId, submitKey, payments: [{ method, amount }], paymentStatus })`
  （范式照抄 `scanPageWrite.test.js:230/254/364`；API 已核实：`payments` 为 `[{method, amount}]`，`PAYMENT_STATUS = { full:"全付", partial:"部分付", unpaid:"未付" }`）
- **断言（逐字保留）**：
  1. `deepEqual(receipts(withStock), receipts(withoutStock))`、`equal(pendingAmount, …)` ⇒ **钱与类型无关**
  2. `receipts` 四态矩阵：全付 → `[[228,"已收款"]]`；部分 → `[[100,"已收款"],[128,"未收款"]]`；未付 → `[[228,"未收款"]]`
  3. 类型：`assert.notEqual(tradeTypeCode(withStock), tradeTypeCode(withoutStock))`（**从建出来的记录回读**，不读解析产物）
  4. 交付：现货 → `履约状态=已交付` + `inventoryLedger`≥1；预定 → `未交付` + 无流水
- **⚠️ 未完成**：本条**尚未写出/未跑**（本轮余量用尽）。**处置=新写（待第三轮）**。

### 条数账（防"变相删覆盖"）
| 处置 | 条数 |
|---|---|
| **等价覆盖（删）** | **5**（#1 单类型单现货 · #2 单类型单预定 · #3 混合单逐行 · #4 逐条交付/库存 · #11 预定不被钱卡住） |
| **随能力退场（删）** | **1**（#5「一句原话 → 一张多明细多收款单」） |
| **新写** | **11**（#6 全款×2 · #7 部分×2 · #8 未付×2 · #9 定金+尾款×2 · #10「下次收」并入×2 · #12 跨两态逐字对照×1） |
| **合计** | **17** ✓ |
⚠️ **净减少 6 条**（17 → 11：等价覆盖 5 条删、随能力退场 1 条删、11 条新写替换掉 11 条原用例）（#5 的"多收款/多选类型"部分）；理由：**"一句原话→多明细多收款"是已退场的自然语言能力**，扫码页是逐双录入 ⇒ 该语义不存在。**请 Lead 逐条核。**

## 五条"等价覆盖"抽查结论（Lead 指定）

| 原用例 | 验的行为现在还在不在 | 证据 |
|---|---|---|
| `quoted actual sale amount may differ from Bitable list price` | **在**（口径层） | 解析层 `doubaoSalesParser.test.js`；实收金额写入口径在 `PaymentService`/`salesOrderService`（扫码侧有覆盖） |
| `真机原话「定金微信交了 100 元，下次欠 128 元」` | **在** | ✅ `test/salesTailPayment.test.js` + `test/doubaoSalesParser.test.js` |
| `分类下唯一时直接用它，实收金额以用户说的为准` | **在** | ✅ `test/accessoryMatchPolicy.test.js`（配品匹配判据的专属测试） |
| `卖的是样品时：卡片上就让她选补哪个门盒` | **不在**（卡片退场） | 补样品能力本身在 `sampleReplacementService`（工作台在用，`larkCards`/`inventoryMvp` 有覆盖）；"在卡片上选门盒"随销售卡片一起退场 ⇒ 判据 (a) |
| `voucher sale card and posting retain separate settled and platform-pending receipts` | **在** | ✅ `test/groupBuyVouchers.test.js` |

## 数字

- 清理前：**tests 1942 / pass 1942 / fail 0**（main `93a6b90`）
- 第一轮后：**tests 1843 / pass 1843 / fail 0**（-99，全为判据 (a)）
- 生产代码：**本轮零改动**（纯测试改动，零线上风险）

## 第三轮（3a）：删不可达代码时连带退场的 3 条（判据 (a)）

**背景**：3a 删了 10 个不可达方法 + 改了 `handleCardAction` 的分派（带 `draft_id` 的未知动作改走 `unknownCardAction` 兜底）。
下列 3 条**不是**"能迁就迁"的活行为 —— 它们验的是**已整体退场的"销售草稿确认"路径**（`handleSalesOrLegacyCardAction` / `confirm_sale`）产出的那张卡，
⇒ 按判据 (a) **随能力退场**。（当时先试过迁移，**失败并回退**，不硬凑断言 —— 见各条"为什么不能迁"。）

| # | 用例（逐字） | 验的能力（逐字） | 为什么随能力退场 | ⭐ 等价覆盖落点 |
|---|---|---|---|---|
| 1 | `终态卡：现货 + 有欠款 → 有按钮；现货 + 已交付 + 已结清 → **没有**按钮`（`terminalCardConfirmDeal.test.js`） | 「她点确认后那张**终态卡**上：现货+有欠款 ⇒ 1 个按钮；现货+已交付+已结清 ⇒ 0 个按钮、且卡面不含『确认成交』」 | 它驱动的是 `handleCardAction({action:'confirm_sale'})` —— **销售草稿确认**那条路径（`handleSalesOrLegacyCardAction`）已随群入口**整体删除**。⚠️ **试过迁移**：改成走保留件 `handleConfirmDealAction`（现存 helper `clickConfirmDeal`）⇒ **卡上 0 个按钮**（期望 1）——因为 `settleConfirmDealCard`(`larkMvpService.js:1528`) 是从 `task.draft` 渲染、且按钮由**未交付/欠款**判定决定，**"再渲染一张带按钮的终态卡"这条路对已点过成交的 `posted` 任务并不存在** ⇒ 迁法不成立，已回退 | `terminalCardConfirmDeal.test.js` **同文件其余 18 条全绿**（含 `clickConfirmDeal` 那族：直驱 `handleConfirmDealAction` 的按钮/幂等/状态断言）；"确认成交按钮"的渲染口径由 `settleConfirmDealCard` 的**既有** 18 条覆盖 |
| 2 | `终态卡：预订单的「已入账」卡上有且**只有**一个按钮，文案「确认成交」`（同上文件） | 「预定单『已入账』卡上**有且只有 1 个**按钮，文案 = 『确认成交』，`value.action = SALES_CONFIRM_DEAL_ACTIONS.CONFIRM`，且不含 取消/否/稍后/不成交」 | 同上（同一条被删路径出卡） | 同上文件 18 条（`clickConfirmDeal` 族已逐字断言按钮数/文案/`value.action`） |
| 3 | `现场复现：她点「确认」后两次真实 patch 的 payload 都带 update_multi`（`cardUpdateMulti.test.js`） | 「她点一次确认 ⇒ 两次真实 patch 的 payload 里 `config` 都 === `{wide_screen_mode:true, update_multi:true}`」 | ⚠️ **"两次 patch"本身就来自 `confirm_sale` 那两步**（先 patch「处理中」、入账后再 patch「已入账」）⇒ 那条路径已删，**两次**这个形状不存在了 | ⭐ **payload 带 `update_multi` 这条语义**由**同文件 test ①/②/③ 逐字覆盖，且全是活路径**：① `arrivalConversation.updateCard`（采购到货核对）② `updateInteractiveCard`（点确认后第一次更新那张卡）③ `PurchaseWebhookService.updatePurchaseActionCard` —— 三条都断言 `assert.deepEqual(JSON.parse(payload.data.content).config, PATCHABLE_CONFIG)` |

**条数账（第三轮 3a 全量）**
| 项 | 条数 |
|---|---|
| 3a 开工前实测基线 | **1925** |
| 按判据 (a) 删：17 条原用例（`salesFundTypeDecoupling` 12 整文件 + `salesMultiLineTradeType` 5） | −17 |
| 按判据 (a) 删：本节 3 条 | −3 |
| **3a 收口后** | **1905**（全绿 ✓） |
⇒ **差额 20 条全部按判据删除、逐条可查**（17 条见上文"判据 (a)"两节，3 条见本节）✓

## 稳定性待办（不在本轮处理，仅记录）

1. `deployRunAutoEnvRefresh.test.js` 的"正确版本号"哨兵（tag 名 + commit + **当下时间**）—— 单体跑绿，**full-suite 跨分钟边界偶发红**（2026-10-12 实测 1 次）。
2. **一次运行异常退出**：回退 `terminalCardConfirmDeal` 后的**首跑**出现 `tests 1857 / fail 8`（比正常少 51 条），**重跑立刻恢复 `1908 / 3`** ⇒ 疑似某测试文件在一次运行里异常退出（资源/时序）。
⇒ 两者**同一类**（"拿环境相关量/运行条件当不变量"），**单独立小任务**，**第一步先复现**（找出是哪个文件、什么条件），**不猜着改**。
