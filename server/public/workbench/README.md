# 工作台前端结构

工作台采用浏览器原生 ES Modules，不需要单独构建。页面只调用同域名的 `/api/workbench/*`，不直接访问飞书 OpenAPI，也不在浏览器中重算销售、收款、交付或库存事实。

## 页面入口

一级 tab 只有 **2 个**（业务负责人 2026-10-08 定的）：

| 一级 tab | `data-module` | 面板内容 | 独立页面 |
| --- | --- | --- | --- |
| **信息录入**（原「常用功能」**只改名**） | `common` | 两张入口卡（见下） | `common.html` |
| **信息查询**（新） | `query` | **两个板块**：销售查询 · 库存查询 —— 各一张**飞书多维表格网页外链卡** | 无（**不为查询自建页面**） |

> ⚠️ **一级 tab 的文案 / 顺序 / `data-module` 的唯一来源是 `config/tabs.js` 的 `MAIN_TABS`**
> （**配置先行**）：`index.html` 里的 `<nav id="main-tabs">` 是**空的**，由 `main.js` 用
> `core/tabs.js` 的 `mainTabsHtml()` 渲染进来；**改 tab 名字 / 加减 tab 只改配置**。
> `index.html` 里**不许**再硬编码 `main-tab` 按钮（有测试守着）。
> 渲染与事件绑定**都排在 `requireFeishuAuth` 之前** —— 保住 2026-10-06 那条修复
> （鉴权 401 时 tab 也要能点）。默认打开的是**第一个** = 信息录入。

### ① 信息录入（原「常用功能」）

入口卡片由 `config/home.js` 的 `COMMON_ENTRIES` 决定（名称 / 图标 / 目标 / 顺序）。
⭐ **只有两张卡：报货与退货 + 库存手工调整**（业务负责人 2026-10-08 拍板 **ⓐ**，逐字：
「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，只删退货那张卡……
现在就是按照原来一样，**采购和退货用的是一个表单**，所以你那个点击卡片上应该是"**报货与退货**"」）——
所以**不再有「退货」那张独立卡**，【报货与退货】那一张卡**直连报货飞书表单外链**
（`config/links.js` 的 `PURCHASE_REQUEST_FORM_URL`）：**点一次直达**，不再经过内页。
口径与取舍见 `docs/workbench-report-return-direct-form-2026-10-08.md`。

它下面还有两个子页（**旧收藏仍然能开**）：

- `/workbench/inventory-adjustment.html`：库存手工调整（盘点调整 / 换季调整）
- `/workbench/purchase-return.html`：采购和退货（**两个飞书表单外链**，不做查询）——
  ⚠️ 首页那张卡**不再走它**，但**它没删**：不带参数打开时，默认仍然把
  「报货」「退货」两张表单卡都显示出来（老链接继续可用）。
  （2026-10-07 拆分那份留档见 `docs/workbench-purchase-return-split-2026-10-07.md`；
   2026-10-08 合并那份留档见 `docs/workbench-purchase-return-merge-2026-10-08.md`。）

### ② 信息查询（2026-10-08 新增）

⭐ 业务负责人逐字：「**2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，
即"销售查询"和"库存查询"」·「目前我采用的并不是我们自己搭建的页面，而是**多维表格里的页面**……
**销售查询和库存查询点开也是多维表格上的一个网页**。⇒ 在这个维度上我们**不用自己搭建接口**」。

- 清单在 `config/query.js` 的 `QUERY_SECTIONS`（两个板块），**URL 只来自 `config/links.js`**：
  `SALES_QUERY_PAGE_URL` / `INVENTORY_QUERY_PAGE_URL`。
- ⚠️ **两个 URL 现在还是空串 + TODO**（等她给）。空值的**明确行为**：
  `features/query/index.js` 渲染成 `<div class="entry-card disabled-card">`（**不是 `<a>`**）、
  卡面 arrow = **「链接待配置」** ⇒ **不产生空 `href`、点了不跳空链接、不报错**。
  拿到 URL 后**只改 `config/links.js` 两行**。
- ⚠️ 这一维**不新增任何接口 / 页面**（渲染层一次 `fetch` 都没有，有测试守着）。

其它入口：

- `/workbench/`：完整经营工作台（一级 tab + 各模块面板）。

### 隐去的入口（代码保留）

`config/tabs.js` 的 `MAIN_TABS` 里**没有**「采购管理 / 资金管理 / 抖音运营 / 平台管理」四个 tab，
但它们的模块仍注册在 `main.js` 的 `modules` 表里。恢复某个入口 = 在 `MAIN_TABS` 里加回一行，逻辑不用改。

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
- `config/`：前端配置 —— `tabs.js`（一级 tab 文案 / 顺序）· `links.js`（飞书表单与查询页外链）·
  `home.js`（信息录入的入口清单）· `query.js`（信息查询的两个板块）。
  **配置先行** —— 换链接 / 改 tab 名 / 加减少一个入口只改这里，页面模块不写死 URL 与清单。
- `features/<domain>/`：录入、采购、库存、查询等业务模块；模块不得查询其他模块的 DOM。
- `features/shared/`：无业务状态的共享视图。
- `styles/`：设计变量和全局布局；业务模块样式与模块放在一起。
- `main.js`：模块注册和一级导航，不承载业务规则。
- `standalone.js`：独立入口的共享启动器（页面用 `<body data-view="...">` 声明自己是谁）。

## 新增模块

1. 在 `features/<module>/` 中实现 `createXxxModule()`，返回包含 `mount(container)` 的对象。
2. 在 `main.js`（完整工作台）和/或 `standalone.js`（独立页面）注册模块；
   要在**一级 tab** 露出来，再去 `config/tabs.js` 的 `MAIN_TABS` 加一条。
3. 模块通过 `core/api-client.js` 调用已约定的后端接口。
4. 新接口或响应字段先更新 `docs/workbench-query-contract.md` 和后端测试。
5. 无后端能力的功能必须明确显示“规划中”，不能放演示数据或无效按钮。

移动端查询表格使用 `.mobile-card-table` 和单元格 `data-label`，桌面端保持表格，窄屏自动切换为卡片。

## 库存手工调整的两个硬约束（改这一块之前先读）

1. **「变动数量」存的是绝对值**，增减由「库存行为」的库存方向表达 ——
   前端不要拼 `+N` / `−N` 去写流水。
2. **幂等靠界面侧的 `requestId`**：一次提交生成一个，**失败重试复用同一个**
   （`features/inventory/adjustment.js` 里的 `state.pendingRequest`：成功才清空）。
   后端把它拼成 `requestId:货号:尺码:状态` 作为库存操作来源，重试不会重复加/减。

换季调整（改状态）**绝不新建或删除「实时库存」记录**；转释放回门盒还是样品由她在页面上选，
代码不替她猜（记录进了「仓库」以后，原来在哪就查不到了）。
