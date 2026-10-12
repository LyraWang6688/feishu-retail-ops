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

## 判据 (b)：迁移（不删）

| 文件 | 条数 | 验的"活实现" | 迁移目标 |
|---|---|---|---|
| `salesOrderNoIntake.test.js` | 2 | 单号分配 —— `services/salesEntryService.createSalesEntryWithOrderNo`（扫码页在用） | ✅ **已迁移**：直驱该函数，断言逐字保留 |
| `salesFundTypeDecoupling.test.js` | 12 | 收款行/欠款与交易类型无关 —— `PaymentService` 仍活 | 扫码提交的收款行 |
| `salesMultiLineTradeType.test.js` | 5 | 逐行"库存定类型" —— `config/salesTradeTypePolicy.salesTradeTypeForStock` 仍活（扫码侧在用） | 扫码提交的逐行类型 |
| `terminalCardConfirmDeal.test.js` | 2 | 【确认成交】按钮 —— `handleConfirmDealAction`/`completeDealFromCard` 是保留件 | 直驱保留件（**需与第三轮 `handleCardAction` 分派改动同批**） |
| `cardUpdateMulti.test.js` | 1 | 卡片 patch payload 带 `update_multi` | 同上；另有等价覆盖（同文件 test ①/②） |
| `arrivalConversation.test.js` | 1 | 卡片动作分派不抢走 | 同上（**需分派改动**） |

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
