# 工作台现状清单（飞书网页工作台 · 2026-10-12）

> **这是什么**：`GET /workbench`（`server/public/workbench/`）**当前**的地图 —— 每个大 tab / 子 tab 的
> **名称 · 干什么 · 前端文件 · 后端接口 · 关键 service · 是否只读 · 已知限制**。
> 依据是**代码事实**（配置 + 路由 + service 逐处核对过），不是印象。
>
> ⚠️ **工作台的定位**（业务负责人锁定）：**只做查询 / 后续补充 / 售后**，**不承担数据录入** ——
> 录入走**扫码页**（`GET /s/{编号}`）。所以 2026-10-12 她把三个"录入式入口"从工作台撤掉了
> （销售建单 / 单款查询 / 验收到货），见下面第 1 节。
>
> 相关留档：工作台结构口径 `docs/workbench-two-tabs-and-external-query-2026-10-08.md` ·
> 订单三态 `server/test/orderThreeStates2026_10_11.test.js` · 本文档只描述**现状**。

---

## 1. 子 tab 一览表（她要的：性质 / 现在的行为 / 改后行为）

**图例** · `性质`：**外部链接**（飞书表单 / 多维表格网页 / 外链卡）· **自建页面**（工作台自己的页 /
复用既有模块）· **占位**（待建设）。
`行为`：**点一次直跳**（一次点击就到目标，不渲染中间卡片）· **先出卡片再点一次** · **直接打开**（点子 tab 就换一屏）。

| 大 tab | 子 tab | 性质 | **改动前**的行为 | **改后（当前）**的行为 |
| --- | --- | --- | --- | --- |
| **销售** | ❌ 销售建单 | （原：自建入口 → 扫码页） | 先出卡片（填编号 → 打开扫码页） | **已删**（她：工作台不需要销售建单；录入走扫码页） |
| 销售 | 订单列表 | 自建页面（复用既有订单模块） | 直接打开 | 直接打开（**不变**） |
| 销售 | 销售查询 | 外部链接（多维表格网页） | **先出卡片再点一次** | ⭐ **点一次直跳**（飞书端内 AppLink） |
| 销售 | 客户往来款 | 占位 | 直接打开（「待建设」） | 直接打开（**不变**） |
| **库存** | ❌ 单款查询 | （原：自建入口 → 扫码页） | 先出卡片（填编号 → 打开扫码页） | **已删**（她：单款查询直接扫一扫就行） |
| 库存 | 全仓查询 | 外部链接（多维表格网页） | **先出卡片再点一次** | ⭐ **点一次直跳**（飞书端内 AppLink） |
| 库存 | 手工调整 | 自建页面（库存手工调整模块） | 直接打开 | 直接打开（**不变**） |
| **采购** | ❌ 验收到货 | （原：自建页面 → 既有订单模块的采购模式） | 直接打开（一批一批点验收） | **已删**（她：验收在扫码页做了） |
| 采购 | 订单列表（**原名「采购订单列表」**） | 占位 | 直接打开（「待建设」） | 直接打开（**只改显示名**，见下） |
| 采购 | 供应商往来款 | 占位 | 直接打开（「待建设」） | 直接打开（**不变**） |
| **货品** | 货品上新 | 外部链接（飞书表单） | **先出卡片再点一次** | ⭐ **点一次直跳**（飞书端内 AppLink） |
| 货品 | 标签打印 | 自建页面（标签打印；含"填编号 → 单款"入口） | 直接打开 | 直接打开（**不变**） |

**⭐ 结论：截至 2026-10-12，「先出卡片再点一次」这条**已经没有一处**了** —— 三个外链子页
（销售查询 / 全仓查询 / 货品上新）全部改成**点一次就到**。其余子页要么是自建页面（直接就位），
要么是占位页（只有「待建设」小标记）。

**改名（逐字）**：`采购订单列表` → **`订单列表`**（她的原话：「把『采购订单列表』这个子 tab 页
**改为『订单列表』**，把『**采购**』**两个字去掉**」）。⚠️ **只改显示名**：`id`（`purchase-orders`）/
`kind` / 结构 / 接口一律没动 —— 见 `config/domains.js`。

**三个入口为什么改"直跳"**（她的原话，逐字）：
> 「点击了『销售查询』这个按钮之后，**系统可以直接自动跳转到我们的多维表格页面**，而**不需要让我再去点一下那个消息查询的卡片**」
> 「**库存的全仓查询**也是」「我们『**货品**』的 tab 页里面……点击『**货品上新**』之后，**它能直接跳转到我的表单链接**」

---

## 2. 每个子 tab 的实现（前端文件 / 后端接口 / 关键 service / 只读）

⚠️ 所有工作台接口都在**同一道飞书身份闸门**后面（`src/routes/workbench.js` 的
`requireWorkbenchAccess` + `GET /api/auth/feishu/me`），没有第二套鉴权。

| 大 tab · 子 tab | 前端文件（`server/public/workbench/`） | 后端接口 | 关键 service | 只读 |
| --- | --- | --- | --- | --- |
| 销售 · 订单列表 | `features/domains/index.js`（按 `kind:'orders'` 挂）→ `features/orders/index.js`（`mode:'sales'`）+ `config/orders.js` | `GET /api/workbench/sales/orders`；动作类：`POST /sales/payments` · `/sales/deliveries` · `/sales/detail-amounts` · `/sales/sample-fill` · `/sales/after-sales` · `/sales/second-delivery`；货品选择：`GET /inventory/products` · `/inventory/stock` · `/inventory/categories` | `SalesFollowupService`（读取，见第 4 节）· `InventoryService`（交付扣库存）· `SamplePendingService`（补样品）· `AfterSalesService` · `SecondDeliveryService` | **否**（含六条写入路径：补收款 / 补金额 / 交付 / 售后 / 二次交付 / 补样品） |
| 销售 · 销售查询 | `config/domains.js`（`kind:'query'` + `directJump:true`）· `config/query.js` · `features/query/index.js` · `features/domains/nav.js` | **无自建接口** —— 直跳她配的**飞书多维表格网页**（`SALES_QUERY_PAGE_URL`） | 无（不在本地重算任何业务事实） | **只读**（外链） |
| 销售 · 客户往来款 | `features/domains/pages.js` 的 `placeholderPageHtml` | 无 | 无 | **只读**（占位） |
| 库存 · 全仓查询 | 同「销售查询」（`INVENTORY_QUERY_PAGE_URL`） | **无自建接口**（外链） | 无 | **只读**（外链） |
| 库存 · 手工调整 | `features/domains/index.js`（按 `kind:'inventory-adjustment'` 挂）→ `features/inventory/adjustment.js` | `POST /api/workbench/inventory/adjustments`（盘点 / 换季）；只读：`GET /inventory` · `/inventory/products` · `/inventory/stock` · `/inventory/categories` | `InventoryAdjustmentService` → `InventoryService` | **否**（写「实时库存」+「库存流水」） |
| 采购 · 订单列表 | `features/domains/pages.js` 的 `placeholderPageHtml` | 无 | 无 | **只读**（占位） |
| 采购 · 供应商往来款 | 同上 | 无 | 无 | **只读**（占位） |
| 货品 · 货品上新 | `config/domains.js`（`kind:'links'` + `directJump:true`）· `features/query/index.js`（跳转装配） | **无自建接口** —— 直跳飞书表单（`PRODUCT_NEW_FORM_URL`） | 无 | **只读**（外链表单） |
| 货品 · 标签打印 | `features/domains/pages.js`（`kind:'entry'`，`targetTemplate = /workbench/label-print.html?keyword={itemNo}`）+ 独立页 `label-print.html` · `features/labels/**` | `GET /api/workbench/labels` | `LabelPrintService` / `labelPrintArtifactService` | **只读**（只读「实时库存」+「货品信息」，**不写表**） |
| 两个独立子页 | `inventory-adjustment.html` · `label-print.html`（`standalone.js` 注册，各自 `data-view`） | 同上两条 | 同上 | 视页面（手工调整写、标签打印只读） |

**跳转装配（三个直跳页共用一处）**：`config/links.js` 的
`LINK_DIRECT_JUMP_ENABLED`（显式布尔，点一次就到）· `LINK_APPLINK_ENABLED`（显式布尔，**飞书端内 AppLink**）
· `LINK_APPLINK_MODE`（`sidebar-semi`）· `FEISHU_APPLINK_WEB_URL_OPEN`（AppLink 基址，URL 只写一次）
⇒ 由 `features/query/index.js` 的 `buildDirectJumpUrl()` 组装，`features/domains/nav.js` 的
`directJumpUrlForPage()` / `resolveTabClick()` 决定"跳 or 切页"，`features/domains/index.js` 一次
`window.location.assign()` 执行。**空 href ⇒ 不产生目标**，回落成"不可点的卡 + 「链接待配置」"，**绝不死链**。

---

## 3. 后端"共用链路"保留关系（**删入口不删链路** · 逐条核过）

| 撤掉的入口 | 后端链路（**一行没删**） | 谁在共用 | 核到的证据 |
| --- | --- | --- | --- |
| 销售 · 销售建单 | 扫码页销售领域 `GET/POST /s/{编号}?from=sales` → `scanWriteService` → `SalesEntryService.createSalesEntryWithOrderNo` | **扫码建单**（群聊入口与扫码入口共用同一份建单 / 单号逻辑） | `src/services/scanWriteService.js:71-89`（`createEntry = options.createSalesEntry \|\| createSalesEntryWithOrderNo`） |
| 库存 · 单款查询 | 扫码页库存领域 `GET /s/{编号}?from=inventory`（只读看库存） | **扫一扫**（她用手机扫码看单款） | `src/routes/scanPage.js`（`from=inventory` 领域仍在） |
| 采购 · 验收到货 | ① 服务端 HTTP：`POST /api/workbench/purchase/arrivals/confirm` → `WorkbenchPurchaseArrivalService.confirmArrival`；② 底层链路：`PurchaseArrivalConversationService.confirmBatchArrival` → `buildPlan` → `confirmLocked` → `PurchaseWebhookService.confirmArrival` → 逐条 `InventoryService.applyPurchase` + `PurchaseOrderBatchService.markArrived` | **扫码验收**（`/s/{编号}` 的验收模式）与**群话题对话式核对**共用**同一条**会话 / 入库链路 | `src/services/scanArrivalService.js:9-10`（文件头就写明调 `confirmBatchArrival`）、同文件 `:270` 调 `conversation.confirmBatchArrival(...)`；`src/routes/workbench.js:64-95` |
| （顺带）「验收到货」的**独有价值** | 工作台那一下 = **「按采购申请数全额到货」的一键确认**（`ARRIVAL_CONFIRM.defaultAcceptanceText = '工作台 · 验收到货：按采购申请数全部到货'`，由她确认 / 可改） | 扫码验收 = **逐个扫码 + 填实际数量**（实际到货与申请数不一致时用它） | `public/workbench/config/orders.js:137` |

⚠️ **如实说清**：`POST /api/workbench/purchase/arrivals/confirm` 这条 **HTTP 接口当前没有 UI 调用方了**
（唯一的调用方是工作台「验收到货」那个界面，`features/orders/index.js:738`）——
但**它下面的链路、`features/orders` 的采购模式、《config/orders.js》里的验收文案都原样保留**
（既没删也没改）：将来若要把「一键按申请数全额到货」加回来，**加回一条配置入口即可**，不用重写。

---

## 4. 订单列表：数据从哪来、怎么分成三份单子（大白话版）

**一句话**：她点开「订单列表」，后台会去飞书表里把 **6 张表整表读一遍**，只留**"账已经做完"**的销售单，
在内存里把明细和收款拼起来，再**分成三份单子**给她看。

### 4.1 一张流水表（从哪张表读什么 → 怎么筛 → 怎么分）

| 步骤 | 从哪张表读？读什么？ | 怎么筛？ | 怎么分？ |
| --- | --- | --- | --- |
| ① 读 6 张表（**并行**） | 销售主表(188 条) · 销售明细(173) · 收款方式管理(6) · 收款明细(158) · 货品信息(562) · 其他配品(21) | 每张表**整表读**（一页 500 条，翻完为止） | — |
| ② 只留「已入账」 | 销售主表的**「资金状态」** | = 已写入 / 已入账 ⇒ 留下；其余不看 | — |
| ③ 内存里拼 | 明细按「关联销售单」挂到这单；收款明细同理；**货号 / 颜色**从货品信息取；**收款方式名**从收款方式管理取 | — | — |
| ④ 算状态 | 履约状态 · 收款状态 · 应收 · 已收 · 还差 · 待交付 | — | — |
| ⑤ 分三份单子 | — | 判据见 4.2 | **三段顺序 = 优先级** |

### 4.2 三份单子：判定顺序 + 判据（**逐字**，`config/orders.js` 的 `SALES_SECTIONS` + 页面纯函数 `salesSectionOf`）

| 顺序 | 段（`key`） | 标签（逐字） | 小标签 / 色 | 判据（按这个顺序判，命中就停） |
| --- | --- | --- | --- | --- |
| ① | `supplement` | **补充信息单** | 待补充 / warning | ⭐ **卖了样品没指定门盒**（服务端只读事实 `sample_pending=true`）⇒ 待补充 |
| ② | `supplement` | 补充信息单 | 待补充 | **两个校验项缺任一**：**货品信息**（货号 / 颜色 / 尺码**缺一**）或 **资金信息**（收款里**至少一条带收款方式**）⇒ 待补充 |
| ③ | `afterSales` | **售后列表** | 已两清 / success | **钱货两清**（已交付 **且** 已收款） |
| ④ | `pending` | **待交割单** | 待交割 / info | 其余（校验项齐了，但**货没给完 / 钱没付完**）——内部再分三组：`有二次 · 货未交付` / `有二次 · 资金未收` / `有二次 · 两者都有` |

> ⚠️ **语义一个字都不许变**：三段分类、字段、状态取值全部保持（她 2026-10-11 定的三态）。

### 4.3 ⚠️ 性能：实测量到的数字 + 已经做的优化

- **她（业务负责人）2026-10-12 在服务器上量的**：接口真实耗时 `3.6s · 4.7s · 3.6s · 7.0s · 24.8s · 26.0s`；
  逐张表：`salesEntry 188 条 3243ms` · `salesDetail 173 条 2629ms` · `paymentMethod **6 条** 1851ms` ·
  `paymentRecord 158 条 5527ms` · `product 562 条 7805ms` · `accessory 21 条 1517ms`（合计 ≈22.6s）。
- ⇒ **瓶颈不是"数据多"，是飞书 API 每张表 1.5~7.8 秒的固定开销**（6 条的小表也要 1.9 秒）。
- ⭐ **已经做的优化**（2026-10-12，分支 `feat/workbench-orders-cache`）：
  1. **缓存 30 秒**（`WORKBENCH_ORDERS_CACHE_MS`，显式整数；`0` = 关掉）：连着点几下 / 来回切 tab
     ⇒ **0 毫秒**；⚠️ **六条写入路径**（补收款 / 补实收 / 交付 / 售后 / 二次交付 / 补样品）写成功之后
     **立刻作废缓存**（不许看到旧数据）；
  2. **只取页面用到的列**（飞书 `field_names`）：列数 **16 → 3**（实测），但**耗时基本不变** ⇒ 主要收益在缓存；
  3. **6 张表并行读、每张只读一次**（无重复读）；分页按飞书游标串行（一页 500 条）；
  4. 前端等待文案变成 **「正在读取订单…（已 N 秒）」** ⇒ 她知道系统还在动，不再像卡死。
- ⭐ **我（agent）在**测试 Base **上实测的优化前后**（只读，147 单）：
  **未命中缓存 10.9~12.0 秒 → 命中缓存 0 毫秒**；两次结果**逐字一致**。
  ⚠️ **生产真实耗时仍要在服务器上量**（本机没有生产凭证）。

### 4.4 移动端紧凑改版：三个方案（**等她挑**）

背景（她的原话）：「**整个数据都撑满了**，**一屏下来只能展示一个半订单**……**争取在一屏里呈现更多信息**」。

| 方案 | 做法 | 估算一屏单数（375×667） | 状态 |
| --- | --- | --- | --- |
| **甲（已实现）** | 一张卡压成**两行**：① 单号 + 状态 + 「打开 ›」 ② 金额摘要 + 展开；**明细与收款默认折叠**；「打开」不再独占一行 | **3~4 单**（卡高 118px） | ✅ 已做 |
| 乙 | 甲 + **三段分组默认折叠**：「售后列表」默认收起（「补充信息单」「待交割单」默认展开） | 售后多时更明显（通常 3~4 单） | 待她点头（改动小：一开始只有两段展开） |
| 丙 | 甲 + **再缩字号与行距**（不加折叠） | 4~5 单 | ⚠️ 可读性下降，**不推荐**（手机上字太小反而更慢） |

⚠️ **三个方案都不丢信息**：只是"折叠 / 收进详情"，点开（或用「打开 ›」进详情页）**全部字段都还在**
（`test/workbenchOrdersCompact.test.js` 的 AC4 逐字钉着：单号 / 两个状态 / 三项金额 / 待交付 /
每条明细的 货号·颜色·尺码·金额·状态）；可点区域仍 **≥44px**。

## 5. 已知限制 / 边界（写给后来人）

1. **工作台不承担录入**：所有录入动作在扫码页（`/s/{编号}`，六个领域）；工作台只做
   查询 / 后续补充 / 售后。任何"再给工作台加个录入表单"的想法都要先过业务负责人这一关。
2. **两个多维表格查询页的代码不在本仓库**：`SALES_QUERY_PAGE_URL` / `INVENTORY_QUERY_PAGE_URL` 是她
   在飞书里配的**分享链接**（`/share/base/webpage/<shareId>`）⇒ 不进 CI、不受 `v1:schema-check` 保护；
   她在生产表改结构之后，那两个页面**可能静默算错或变空，我们这边没有任何告警**
   （留档：`docs/todo-inventory-query-page-logic.md`、`docs/sales-query-page-and-system-caliber-2026-10-08.md`）。
3. **分享链接的权限提示**（她知情）：飞书页面上写着"通过分享链接访问的用户可查看当前页面展示的
   **全部数据，不受多维表格高级权限限制**"。
4. **AppLink 是"端内打开"**（乙，她 2026-10-12 拍板）：`mode` 按官方文档是 **PC 端**容器模式
   （手机端不生效）⇒ 手机上"点一次就到"没有差别；⚠️ **尚未在真机上验证"从已经在飞书 web-view 里的
   工作台再开一个端内 web-view"**（嵌套）—— 若某些机型 / 容器打不开：把 `config/links.js` 的
   `LINK_APPLINK_ENABLED` 改成 `false`（**一处**）即**一键回落**普通跳转。
5. **采购 tab 当前只有两个占位页**（订单列表 / 供应商往来款，都是「待建设」）—— 功能上"先保持这样"
   是她的口径；报货 / 退货 / 验收三个动作现在都在扫码页。
6. **`features/orders` 的采购模式**（`mode:'purchase'`）**代码保留、当前工作台无挂载点**
   （验收入口已删；模块本身仍被销售「订单列表」用）⇒ 属于"可配置但暂时没入口"的分支，
   **没有删**（她将来若要"一键全额到货"，它 + 那个接口就是现成的）。
7. ⭐ **验收：工作台上没有任何入口**（业务负责人 2026-10-12 澄清，**逐字**：
   「不是，我的意思是说，**我们的验收还是只在扫码页呀，我不需要在工作台呀**」）
   ⇒ 采购 tab 现在只有「订单列表」（占位）与「供应商往来款」（占位）两个子页；
   **验收动作与它的入口都在扫码页**（`/s/accept`，由扫码那条线负责）；
   后端验收接口 `POST /api/workbench/purchase/arrivals/confirm` 与既有验收台代码**保留**（见第 3 节），
   但**工作台不再提供任何通往它的按钮 / 表单**。
8. **`features/purchase/**`（老「采购管理」页）** 自 2026-10-09 起**没有任何页面挂载**
   （页面 `purchase.html` / `purchase-return.html` 已按她口令删除），模块先留着没删。
9. **工作台 HTML 里不再有品牌行 / 页面主标题**（2026-10-12）：`index.html` 的
   「邯美数智经营工作台 / 经营管理中心」整块删除、`<title>` 缩成「邯美工作台」；
   两个独立子页只收了品牌行、**保留各自的功能标题 h1**（库存手工调整 / 鞋盒标签打印）。
