# 工作台前端结构

工作台采用浏览器原生 ES Modules，不需要单独构建。页面只调用同域名的 `/api/workbench/*`，不直接访问飞书 OpenAPI，也不在浏览器中重算销售、收款、交付或库存事实。

## 页面入口

一级 tab = **四个业务领域**（业务负责人 **2026-10-09** 定的**最终结构**，逐字：
「我们就按照**四个 tab 页**来规划：**销售、采购、库存和货品**……
Tab 页的顺序从左往右是：**销售、库存、采购和货品**」）：

| 一级 tab | `data-module` | 子页面 | 落到哪 |
| --- | --- | --- | --- |
| **销售** | `sales` | ① 销售建单 ② 订单列表（补充信息单 ｜ 待交割单 ｜ 售后列表）③ 销售查询 | 扫码页的**销售领域**（`/s/{编号}?from=sales`）· 既有订单模块（`mode: 'sales'`）· 多维表格外链 |
| **库存** | `inventory` | ① 单款查询 ② 全仓查询 ③ 手工调整 | 扫码页的**库存领域**（`?from=inventory`）· 多维表格外链 · 既有「库存手工调整」模块（内嵌） |
| **采购** | `purchase` | ① 报货 / 验收 / 退货 ② 采购订单列表 | 两个飞书表单 +「验收到货」跳子页 · 既有订单模块（`mode: 'purchase'`） |
| **货品** | `product` | ① 货品上新 ② 标签打印（单个 + 批量） | 飞书表单外链 · 既有标签打印页（单个带 `?keyword=<货号>`） |

> ⚠️ **子页面清单的唯一来源是 `config/domains.js`**（**配置先行**：加减子页 / 改文案 / 换链接只改它）；
> 渲染与切换在 `features/domains/`（`index.js` 挂模块、`nav.js` 画子 tab、`pages.js` 画三类静态子页）。
> ⚠️ **一级 tab 的文案 / 顺序 / `data-module` 的唯一来源是 `config/tabs.js` 的 `MAIN_TABS`**：
> `index.html` 里的 `<nav id="main-tabs">` 是**空的**，由 `main.js` 用 `core/tabs.js` 的
> `mainTabsHtml()` 渲染进来；`index.html` 里**不许**再硬编码 `main-tab` 按钮（有测试守着）。
> 渲染与事件绑定**都排在 `requireFeishuAuth` 之前** —— 保住 2026-10-06 那条修复
> （鉴权 401 时 tab 也要能点）。默认打开的是**第一个** = 销售。

### 旧入口：一个都没删（页脚 →「其它 / 历史功能」）

业务负责人 2026-10-09：「**其余旧功能不删**：集中到一个**不显眼的"其它/历史功能"入口**
（例如页脚一行，点开一个独立页列出它们）」。

- 首页页脚那一行 → `/workbench/others.html`（清单在 `config/others.js`，模块 `features/others/`）：
  - 📋 **信息录入**（原「常用功能」首页，**内容一个字没动**）→ `common.html`（`config/home.js` 的三张卡：
    报货与退货 / 库存手工调整 / 鞋盒标签打印）
  - 🚚 **采购管理**（原一级 tab：报货信息情况 / 到货验收情况两个查询面板）→ `purchase.html`
    （模块还是 `features/purchase/index.js`）
  - 🧮 库存手工调整 · 🛒 采购和退货 · 🏷️ 鞋盒标签打印 —— 三个独立页的老链接照旧能开
  - 一直只是占位的 **资金管理 / 抖音运营 / 平台管理**：模块代码仍在 `main.js` 的 `modules` 表里，
    「其它」页如实列出来（标着"规划中"）
- 原「信息查询」的**两个板块**没有被丢掉，而是各回各的领域：
  `sales-query` → 销售 · 销售查询；`inventory-query` → 库存 · **全仓查询**（清单仍在 `config/query.js`，
  URL 仍只在 `config/links.js`：`SALES_QUERY_PAGE_URL` / `INVENTORY_QUERY_PAGE_URL`）。
  ⚠️ 这一维**不新增任何接口 / 页面**（渲染层一次 `fetch` 都没有，有测试守着）。
- 原「订单列表」也是同一个模块（`features/orders/`）挂两处：销售 tab 只看销售、采购 tab 只看采购
  （`createOrdersModule({ mode })`，`mode` 由 `config/domains.js` 给）。

> 口径与逐条对照：`test/workbenchFourTabs.test.js`（AC1–AC7）+ `test/workbenchTwoTabsAndQueryEntries.test.js`
> + `test/workbenchOrders.test.js`。**本文件不改 `docs/`**。

### 扫码页的领域切换（一个二维码，四个领域）

`GET /s/:number` **一个字没改**（路由与 `config/scanPage.js` 都不动），顶部多了一排**领域切换**：
`?from=sales|inventory|purchase|product`（**缺省 = 销售**）。四个领域的操作块**全都渲染进 HTML**，
由 CSS 按 `<html data-realm="…">` 只显示当前领域；那一行属性由页面 `<head>` 里一小段内联脚本
在 body 解析前从 `location.search` 读出来（实现与取舍见 `src/views/scanPageRealm.js`）。
⇒ 既有扫码页用例断言的那些 HTML 片段（两个写入口、库存表、结果页）**一个都没少**。

### 主题（要改配色只改一个文件）

`styles/tokens.css` 是**唯一的主题真源**：配色 / 间距 / 圆角 / 字号 / 命中区（`--control-height: 44px`）。
其余工作台 CSS **只许用 `var(--…)`**（一个十六进制颜色都不许有，有测试守着）；
扫码页在渲染时**把同一份令牌内联进 `:root`** ⇒ 改那一个文件，工作台与扫码页一起变。

### 2026-10-08 删掉的（自建的销售 / 库存查询面）

业务负责人逐字：「现有的**我们自己搭的**销售查询/库存查询页面与接口（`/api/workbench/*`），**顺手删掉**～」

- 页面：原「销售查询」「实时库存」两个独立静态页（外加那个旧的跳转页）**整体删除**。
- 前端模块：原销售查询模块与「实时库存」的查询模块**整体删除**。
- 路由：`GET /api/workbench/sales/today`、`GET /api/workbench/sales/query` **整体删除**。
- ⚠️ **没删的**（逐条核过引用）：`GET /api/workbench/inventory` 等四条库存只读接口 ——
  「库存手工调整」页在用（换季调整按品类列鞋）；`/sales/orders`、`/sales/payments`、
  `/sales/deliveries` 是**写入类**（补记收款 / 交付扣库存），不属于"查询"。
  验收标准 / 逐条对照见 `docs/workbench-two-tabs-and-external-query-2026-10-08.md`。

## 目录边界

- `core/`：登录、HTTP 请求、格式化、一级 tab 渲染（`tabs.js`）和通用交互。
- `config/`：前端配置 —— `tabs.js`（一级 tab 文案 / 顺序）· **`domains.js`（四个领域的子页面清单）** ·
  `links.js`（飞书表单与查询页外链）· `home.js`（原「信息录入」首页的入口清单）·
  `query.js`（两个多维表格查询板块）· `others.js`（「其它 / 历史功能」的遗留入口）·
  `orders.js`（订单列表的分组 / 文案 / 接口路径）。
  **配置先行** —— 换链接 / 改 tab 名 / 加减一个入口只改这里，页面模块不写死 URL 与清单。
- `features/<domain>/`：录入、采购、库存、查询、标签等业务模块；模块不得查询其他模块的 DOM。
- `features/domains/`：**四个领域 tab 的骨架**（子 tab + 子页面；业务逻辑一行都没有）。
- `features/others/`：「其它 / 历史功能」页。
- `features/shared/`：无业务状态的共享视图。
- `styles/`：**主题变量（`tokens.css`）** 和全局布局；业务模块样式与模块放在一起。
- `main.js`：模块注册和一级导航，不承载业务规则。
- `standalone.js`：独立入口的共享启动器（页面用 `<body data-view="...">` 声明自己是谁）。

## 移动端优先（硬要求）

业务负责人 2026-10-09：「工作台**一定要对移动端友好**，而且我觉得现在这个**不太美观**」。

- **默认样式就是手机**：单列卡片、按钮 / 输入框 ≥ `--control-height`(44px)、不横向滚动、
  长文本 `overflow-wrap: anywhere`；桌面（`@media (min-width: 761px)`）才铺成多列。
- 领域页与订单列表**一律不用 `<table>`**（旧查询页那种表格只留在「其它」里，窄屏会折成卡片）。
- 静态哨兵：`test/workbenchFourTabs.test.js` 的 AC4。

## 新增模块

1. 在 `features/<module>/` 中实现 `createXxxModule()`，返回包含 `mount(container)` 的对象。
2. 在 `main.js`（完整工作台）和/或 `standalone.js`（独立页面）注册模块；
   要在**一级 tab** 露出来，再去 `config/tabs.js` 的 `MAIN_TABS` 加一条，
   **子页面**再加到 `config/domains.js` 对应领域里。
3. 模块通过 `core/api-client.js` 调用已约定的后端接口。
4. 新接口或响应字段先更新 `docs/workbench-query-contract.md` 和后端测试。
5. 无后端能力的功能必须明确显示“规划中”，不能放演示数据或无效按钮。

## 库存手工调整的两个硬约束（改这一块之前先读）

1. **「变动数量」存的是绝对值**，增减由「库存行为」的库存方向表达 ——
   前端不要拼 `+N` / `−N` 去写流水。
2. **幂等靠界面侧的 `requestId`**：一次提交生成一个，**失败重试复用同一个**
   （`features/inventory/adjustment.js` 里的 `state.pendingRequest`：成功才清空）。
   后端把它拼成 `requestId:货号:尺码:状态` 作为库存操作来源，重试不会重复加/减。

换季调整（改状态）**绝不新建或删除「实时库存」记录**；转释放回门盒还是样品由她在页面上选，
代码不替她猜（记录进了「仓库」以后，原来在哪就查不到了）。
