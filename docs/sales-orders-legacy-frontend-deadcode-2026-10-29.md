# 销售订单列表：现行三条路径 ＋ 老订单列表前端残留盘点（只读，2026-10-29）

> 目的：把「销售 → 订单列表」现在**还活着的三条路径**、以及代码里**已经不可达的老前端**一次盘清。
> 本文件**只读盘点**，不改任何业务代码；清理建议见第五节（需 Lead 排期 + 文件所有权协调）。
>
> 依据：业务负责人 2026-10-29 确认 ——「销售订单列表路径只有这三个，没有其他链路了：
> 1. 交割单 2. 售后单 3. 草稿箱」，且「以前后端退货、换货的写入逻辑这块不用删掉，
> 但前端不用再保留之前的那个订单列表」。

## 一、现行路径（唯一三条，都有代码证据）

页面：工作台 → **销售 → 订单列表**（`config/domains.js` 的 `sales-orders`，`kind: 'orders'`、`mode: 'sales'`）
→ `features/orders/index.js` 的 `mount()` → `renderList()`（无 `activeSection` 时只画**三张入口卡**）。

| 卡片 | 点击后 | 代码 |
|---|---|---|
| **交割单** | 跳独立页 `/workbench/sales-delivery.html` | `features/orders/index.js` 的 click 分支（`data-orders-section="pending"`） |
| **售后单** | 调**飞书扫一扫** → 落 `/workbench/after-sales.html?productRecordId=…` | `scanAfterSales()`（`features/scan/launch.js`） |
| **草稿箱（草稿单）** | 占位「待建设」 | click 分支设置 `activeSection='draft'` → `renderList()` 的 placeholder 分支 |

三张卡只显示 `label + icon`（`ordersSectionCardsHtml`）；卡片上的 `tag`（含 `待交割` 字样）**目前不渲染**。

## 二、仍必须保留的「活代码」（不能整文件删）

| 件 | 为什么留着 |
|---|---|
| `features/orders/index.js` 的**三卡入口**（`ordersSectionCardsHtml` / `renderList` 的 `!activeSection` 分支） | 它就是现在的订单列表页 |
| `scanAfterSales()` | 售后单卡片 → 飞书扫一扫 |
| 交割单卡跳转分支 | 交割单入口 |
| 草稿卡 → 占位分支 | 草稿箱入口（占位） |
| `createFirstPaintLoader` / `readCachedOrders` / `writeCachedOrders` | 首屏先画三卡、后台再刷新（**活的**，被 `loadOrders` 使用） |
| `renderResult()` | 扫一扫失败时的人话（活的） |
| **后端**（业务负责人明确「不用删」） | `POST /api/workbench/sales/after-sales`、`WorkbenchOrderActionService.afterSales`、`services/afterSalesService.js`（退/换/赔执行器，43 条用例）、`config/afterSales.js`、`SecondDeliveryService` 等 —— **新售后页要复用的就是它们** |

## 三、死代码清单：销售半边（代码在、UI 不可达）

不可达的判据：`state.activeSection` **只能**被设成 `draft`（草稿占位）或 `afterSales`（旧 deep-link，见下）；
`pending` 分支在卡片点击时**直接 `window.location.href` 跳交割单独立页并 return** ⇒ 老列表/详情永远打不开。

| # | 残留 | 位置（`features/orders/index.js`） | 为什么不可达 | 删了会影响什么 |
|---|---|---|---|---|
| 1 | 老订单列表行（查看/操作） | `ordersListHtml`（`~166`）、`lineHtml`/`detailsBlock`（`~126`/`~149`） | 只有 `activeSection==='pending'` 才渲染，而 pending 卡是跳转分支 | 无 UI 影响；多个测试引用这些导出 |
| 2 | 老分组列表（待交割三类细分：货未交付 / 资金未收 / 两者都有） | `ordersSectionsHtml`（`~286`） | 同上 | 无 UI 影响；测试引用 |
| 3 | 钱货两清 / 待交割 分类函数 | `salesCategoryOf`（`~220`）、`salesInfoOf`（`~249`）、`salesSectionOf`（`~268`） | 结果只喂给 #1/#2；`renderList` 里只剩草稿占位分支还会调到 `salesSectionOf` | `renderList` 可顺手简化；测试引用 |
| 4 | 订单详情页（含四个动作折叠区） | `orderDetailHtml`（`~680`）、`paymentBlock`（`~105`） | 只有老列表的「查看/操作」按钮能进（#1） | 无 UI 影响；测试引用 |
| 5 | 补收款 / 补实收 / 补样品 / 交付 / 二次交付 表单与提交 | `paymentFormBlock`（`~523`）、`detailAmountBlock`（`~547`）、`sampleFillBlock`（`~573`）、`deliveryBlock`（`~504`）、`secondDeliveryBlock`（`~602`）、`submitPayment`/`submitDetailAmount`/`submitSampleFill`/`submitDelivery`/`submitSecondDelivery`/`submitRetryWrite`（`~1125`–`~1229`）、`runAction`（`~1105`） | 都在 #4 详情页里 | 无 UI 影响；**后端接口不动**；测试引用 |
| 6 | 老售后折叠区（退/换/赔表单 + 同款/换货品选择 + 差价建议 + 幂等 requestId） | `afterSalesBlock`（`~614`）、`afterSalesInput`（`~1240`）、`submitAfterSales`（`~1267`）、`searchProduct`（`~1284`）、`toggleAfterSalesBlocks`（`~1304`）、`renderSettlementOptions`（`~1320`）、`checkedAfterSalesLines`（`~1331`）、`suggestDiffAmount`（`~1343`） | 在 #4 详情页里 | 无 UI 影响；**后端执行器/接口保留**（新售后页复用） |
| 7 | 老售后 deep-link（`?after_sales_order=…` 跳回订单详情） | `openAfterSalesDeepLink`（`~1444`，`mount` 里调用） | 新售后页已改为扫一扫落地页，不再产生这个参数 | 可连调用一起删；注意保留 `mount` 其它行为 |
| 8 | 内部子 tab（销售/采购切换）与采购面板 | `subTabsHtml`/`resolveSubTab`/`switchSubTab`/`renderSubTabs`、`purchasePanel`、`loadPurchaseOrders`/`renderPurchaseList` | `mode:'sales'` 是**单领域模式**（不画子 tab）；采购验收页 `hidden:true`（导航里没有） | 采购那一批函数/测试要一起处理（见第四节） |

## 四、死代码清单：采购半边（同一个文件里的「验收」页）

- 采购验收页在 `config/domains.js` 里是 `{ id:'purchase-acceptance', kind:'orders', mode:'purchase', hidden:true }` ⇒ **导航里没有入口**；
  采购的「订单列表」是另一个独立占位页（`purchase-orders`，`kind: 'placeholder'`）。
- 对应残留：`groupPurchaseOrders`（`~342`）、`purchaseOrdersHtml`（`~426`）、`arrivalStatusOf`/`isArrivedBatch`（`~358`/`~369`）、`purchaseBatchCardHtml`（`~377`）、`arrivalDetailHtml`（`~451`）、`arrivalSubmitLines`（`~479`）、`loadArrivalDetail`（`~993`）、`resolveItemNo`（`~1010`）、`submitArrival`（`~1027`）、`NO_BATCH_KEY`、以及 `config/orders.js` 里的 `ARRIVAL_*` 常量。
- ⚠️ **采购验收现在是否另有活入口、以及这些函数是否真有别的调用方，需要单独确认**（本次只读盘点，不下删除结论）。

## 五、清理建议（只建议，不在本次做）

1. **先补判据**（不改行为）：加一条源码哨兵 —— 「订单列表页只有三条路径」：
   - `pending` 卡必须走独立页跳转；`afterSales` 卡必须走扫一扫；
   - 源码里**不许再出现** `data-action="open-order"` 的渲染分支（老列表入口不可回）；
   - 该判据先绿在现值上，再允许删代码（防"删完才发现还有入口"）。
2. **再删销售半边**（第三节 #1–#7），并同步更新测试（约 20 个文件引用这些导出，例如
   `workbenchOrdersCompact.test.js` / `workbenchOrdersReadPath.test.js` / `orderThreeStates2026_10_11.test.js` /
   `workbenchPaymentSplits.test.js` / `workbenchDetailAmounts.test.js` / `workbenchSampleFill.test.js` /
   `workbenchSubmitFeedback.test.js` / `workbenchRetryUiWiring.test.js` / `salesRetryUiFlag.test.js` 等）。
3. **采购半边**（第四节）**单独处理**：先确认验收是否已完全搬家（扫码页），再删；不要和销售半边混在一个 PR。
4. **后端一律保留**（她 2026-10-29 明确：退货/换货写入逻辑不删；新售后页复用同一执行器/接口）。
5. ⚠️ **文件所有权**：`features/orders/index.js` 当前有并行任务（草稿箱）在改 ⇒ 清理要由 **Lead 排期并指定写作用域**，
   不能两个分支同时改这个文件（AGENTS《多代理并行时的写作用域纪律》）。

## 六、备注：仍在使用「钱货两清」口径的地方（不是死代码）

- **交割单独立页**：`features/sales-delivery/filter.js`（货没清 = 履约状态≠已交付；钱没清 = 收款状态=未收款；并集展示、已两清不展示）；
- **后端**：`services/secondDeliveryService.js`（二次交付 = 补收款 + 交付）、`services/salesDeliveryPaymentService.js`（一次性付清 = 改原未收款记录）。
  ⇒ 「钱货两清 / 一次性付清」这一**业务概念**还活着，只是老的**前端列表**不再用它分类。
