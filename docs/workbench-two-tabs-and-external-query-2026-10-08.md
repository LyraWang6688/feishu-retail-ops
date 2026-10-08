# 工作台：3 个 tab → 2 个 tab ＋「信息查询」两个板块 = 飞书多维表格**外链**（2026-10-08）

> 业务负责人（逐字，2026-10-08）：
> 「目前我们分了**三个 tab 页**：销售查询、库存查询还有常用功能。现在需要你**整合成两个 tab 页**：
>  **1. 信息录入**：实际上就是"常用功能"，把那个 tab 页的名字改一下就行
>  **2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
>
> 「目前我采用的并不是我们自己搭建的页面，而是**多维表格里的页面**。我希望就像我们的**报货和退货**一样，
>  点开之后是**一个表单**，**销售查询和库存查询点开也是多维表格上的一个网页**。
>  ⇒ 在这个维度上我们**不用自己搭建接口**」
>
> 「现有的**我们自己搭的**销售查询/库存查询页面与接口（`/api/workbench/*`），**顺手删掉**～」

---

## 〇、改之前的 tab / 页面结构（**只读核清，不凭转述**）

**一级 tab 的定义机制有两处**（分工不同，不是二选一）：

| 在哪 | 管什么 |
| --- | --- |
| `server/public/workbench/index.html` 的 `<nav id="main-tabs">` | **3 个按钮**的**文案与顺序**（硬编码在 HTML 里）：销售查询 / 实时库存 / 常用功能 |
| `server/public/workbench/main.js` 的 `modules` Map | `data-module` → 模块工厂：`common` / `sales` / `inventory`（+ 隐去的 `purchase`/`finance`/`douyin`/`platform`） |

- ⭐ tab **文案不在** `config/home.js`、也**不在** `features/common/index.js` ——
  `config/home.js` 管的是**「常用功能」页里的入口卡片**（`COMMON_ENTRIES`），
  不是一级 tab。（这正是本轮要"先核清"的那件事。）
- 每个 tab 另有一个**独立页面**（`standalone.js` 按 `<body data-view>` 注册）：
  `common.html` / `sales-query.html` / `inventory.html`。

**改动前的一级 tab（逐字）**：

| 顺序 | `data-module` | 文案 | 面板内容 |
| --- | --- | --- | --- |
| ①（默认打开） | `sales` | 销售查询 | 子 tab：销售查询 / 交付·收款管理 / 退换货管理（规划中）/ 抖音团购券（规划中） |
| ② | `inventory` | 实时库存 | 子 tab：实时库存查询 / 盘点记录 / 库存调整记录 |
| ③ | `common` | 常用功能 | 两张卡：报货与退货（飞书表单外链）+ 库存手工调整（内页） |

**改动前自建的销售/库存查询面（前后端）**：

| 层 | 文件 / 路由 |
| --- | --- |
| 页面 | `sales-query.html` · `sales-today.html`（跳转页）· `inventory.html` |
| 前端模块 | `features/sales/index.js`（+ `sales.css`）· `features/inventory/index.js` |
| 路由 | `GET /api/workbench/sales/today` · `GET /api/workbench/sales/query` · `GET /api/workbench/inventory` |
| 控制器 | `workbenchController.js` 的 `queryTodaySales` · `querySales` · `queryInventory` |
| 追加发现 | `features/inventory/adjustment.js`（**库存手工调整**页）**也调** `GET /api/workbench/inventory`（第 284 行，换季调整按品类列鞋）⇒ 这个接口是**共用**的 |

---

## 一、改完之后应该是什么样（验收标准 · **先写后做**）

| # | 验收标准 |
| --- | --- |
| **AC1** | 一级 tab **只有 2 个**，文案**逐字** = `['信息录入', '信息查询']`（顺序也是这个）；模块 id = `['common', 'query']`。文案的**单一来源** = `config/tabs.js` 的 `MAIN_TABS`（配置先行），`index.html` 里**不再硬编码** `main-tab` 按钮 |
| **AC2** | 「信息录入」= 原「常用功能」**只改名，里面入口不动**：`COMMON_ENTRIES` 仍**逐字**是 `['报货与退货', '库存手工调整']`，两张卡的 `href` / `desc` / `arrow` / `wide` **一个字节不变**（哨兵） |
| **AC3** | 「信息查询」是**一个 tab、两个板块**：「**销售查询**」「**库存查询**」，各一张卡（`QUERY_SECTIONS`，顺序就是这个） |
| **AC4** | 两张卡的 `href` **来自 `config/links.js`**（`SALES_QUERY_PAGE_URL` / `INVENTORY_QUERY_PAGE_URL`，与 `PURCHASE_REQUEST_FORM_URL` 同一套写法）；`config/query.js` 只 `import`、**不复制 URL 字面量**；`features/query/index.js`（渲染层）**不写死 URL** |
| **AC5** | ⭐ **空值时的行为明确**：两个 URL 现在**故意留空串 + TODO**；空值时卡面显示「**链接待配置**」，并且**不生成 `<a>` 元素**（⇒ **不产生空 `href`**、**点了不跳空链接、不报错**）。给了非空值时，同一渲染函数的 `href` **逐字**等于配置值、`rel="noopener"`、**同窗口**（无 `target`） |
| **AC6** | 「信息查询」**不新增任何接口 / 页面** —— 渲染层一次 `fetch` 都没有（她：「这个维度上我们不用自己搭建接口」） |
| **AC7** | **删干净**（自建销售查询 / 库存查询面）：`sales-query.html` · `sales-today.html` · `inventory.html` · `features/sales/**` · `features/inventory/index.js` 全部**不存在**；`routes/workbench.js` 里**没有** `/sales/query`、`/sales/today`；`workbenchController.js` **不再导出** `querySales` / `queryTodaySales` |
| **AC8** | **零引用守门**：`server/public/workbench/**`（`.js`/`.html`）里搜不到 `sales-query.html` / `inventory.html` / `sales-today.html` / `features/sales`；`src/routes/**` 与 `src/controllers/**` 里搜不到 `/sales/query`、`/sales/today` |
| **AC9** | ⭐ **看着像但没删**（逐条核过引用，全部**保留并说明**）：`GET /api/workbench/inventory`（库存手工调整页第 284 行在用）· `/inventory/products` · `/inventory/stock` · `/inventory/categories`（同一页在用）· `GET /sales/orders` · `POST /sales/payments` · `POST /sales/deliveries`（**写入类**，见下节"没有删的与原因"） |
| **AC10** | **哨兵：不回退** —— 工作台 auth 闸门（`requireWorkbenchAccess` + `feishuWebAuth`）与写入类接口（`/sales/payments`、`/sales/deliveries`、`/inventory/adjustments/*`）**仍在**；`workbenchAuth401.test.js` 仍绿 |
| **AC11** | **边界**：`server/src/services/**` 一行不动 · `app.js` 一行不动 · `v1BitableSchema` 一行不动 · 推送卡片那件（另一个代理的 worktree）**不碰**；**不写任何表** |
| **AC12** | **测试**：新用例改动前**红**（贴输出）、改动后绿；全量 `node --test --test-concurrency=1` 连跑 **2 次** `fail=0`（在**独立 worktree** 里跑，不在主工作区） |
| **AC13** | **CI**：`gh pr checks` 三项（`test` / `CodeQL` / `Analyze`）**pass**、`mergeStateStatus = CLEAN`；**禁止 `--admin`**；**开 PR ✗ 不合并 ✗ 不部署** |

---

## 二、改完之后的实际结构（逐字）

### 2.1 一级 tab（`config/tabs.js`，单一来源）

```js
export const MAIN_TABS = [
  { module: 'common', label: '信息录入' },
  { module: 'query', label: '信息查询' },
];
```

- `index.html` 的 `<nav id="main-tabs">` **留空**，由 `main.js` 用 `core/tabs.js` 的 `mainTabsHtml()` 渲染。
- ⚠️ 渲染与事件绑定**都排在 `requireFeishuAuth` 之前** —— 保住 2026-10-06 那条修复
  （「鉴权 401 时 tab 点了没反应」）。
- 默认打开的 tab = 第一个 = **信息录入**（她的编号 ①）。

### 2.2 信息录入（原「常用功能」只改名）

面板标题 `常用功能` → **信息录入**；`COMMON_ENTRIES` **一个字不动**：

```js
[
  { id: 'purchase',             title: '报货与退货',   href: PURCHASE_REQUEST_FORM_URL },
  { id: 'inventory-adjustment', title: '库存手工调整', href: '/workbench/inventory-adjustment.html' },
]
```

### 2.3 信息查询（新）

```js
// config/query.js
export const QUERY_SECTIONS = [
  { id: 'sales-query',     icon: '📈', title: '销售查询', desc: '…', href: SALES_QUERY_PAGE_URL },
  { id: 'inventory-query', icon: '📦', title: '库存查询', desc: '…', href: INVENTORY_QUERY_PAGE_URL },
];
```

渲染（`features/query/index.js`）：**有 URL** → `<a class="entry-card" href="…" rel="noopener">`（同窗口）；
**空值** → `<div class="entry-card disabled-card" aria-disabled="true">`，`arrow` 文案 = `链接待配置`。

### 2.4 `config/links.js` 新增两个键（**空值 + TODO**）

```js
export const SALES_QUERY_PAGE_URL = '';      // TODO(业务负责人): 销售查询多维表格网页 URL
export const INVENTORY_QUERY_PAGE_URL = '';  // TODO(业务负责人): 库存查询多维表格网页 URL
```

---

## 二·五、删了哪些文件 / 路由 / 函数（**逐条**）

### 2.5.1 删除的文件（`git rm`，6 个）

| 文件 | 是什么 |
| --- | --- |
| `server/public/workbench/sales-query.html` | 自建「销售查询」独立页 |
| `server/public/workbench/sales-today.html` | 自建「今日销售」→「销售查询」的旧跳转页（目标页已删 ⇒ 它只会 404，跟着删） |
| `server/public/workbench/inventory.html` | 自建「实时库存」独立页 |
| `server/public/workbench/features/sales/index.js` | 自建销售查询前端模块（**343 行**：销售查询 / 交付·收款管理 / 退换货占位 / 团购券占位） |
| `server/public/workbench/features/sales/sales.css` | 上面那个模块的样式（**只有它和 `sales-query.html` 在用**） |
| `server/public/workbench/features/inventory/index.js` | 自建「实时库存」查询前端模块（**100 行**） |

> ⚠️ `features/inventory/` **目录没删** —— 里面还留着「库存手工调整」页要用的
> `adjustment.js` 与 `inventory.css`（那是「信息录入」的入口，**必须留**）。

### 2.5.2 删除的路由（`src/routes/workbench.js`，2 条）

| 路由 | 原来的控制器 |
| --- | --- |
| `GET /api/workbench/sales/today` | `controller.queryTodaySales` |
| `GET /api/workbench/sales/query` | `controller.querySales` |

### 2.5.3 删除的控制器函数（`src/controllers/workbenchController.js`，2 个 + 2 条 export）

`queryTodaySales` · `querySales`（连同 `module.exports` 里那两行）—— 删完控制器只剩
`queryInventory` · `queryInventoryProducts` · `queryInventoryStock` · `queryInventoryCategories`。

### 2.5.4 其它"入口层"清理（改文件，不删文件）

| 文件 | 改动 |
| --- | --- |
| `index.html` | nav 里 3 个硬编码按钮 → **留空**（改由 `config/tabs.js` 渲染 2 个）；摘掉 `features/sales/sales.css` 与 `features/inventory/inventory.css` 两个 `<link>`（`features/purchase/purchase.css` **保留** —— 隐去的采购模块恢复时要它） |
| `main.js` | `modules` 表删 `sales` / `inventory` 两项 + 两个 import；新增 `query`（`createQueryModule`）；tab 改由 `mainTabsHtml()` 渲染 |
| `standalone.js` | 删 `'sales-query'` / `inventory` 两个独立页注册 + 两个 import |
| `common.html` | 标题/h1 常用功能 → **信息录入**；导航里 `销售查询` / `实时库存` 两个**死链接摘掉** |
| `features/common/index.js` | 面板 `<h2>常用功能</h2>` → **`<h2>信息录入</h2>`**（"只改名"，入口渲染逻辑一行不改） |
| `purchase-return.html` · `inventory-adjustment.html` | 导航里 `实时库存` 那条**死链接摘掉**；`返回常用功能` → `返回信息录入` |
| `README.md`（workbench）· `docs/workbench-query-contract.md` · `docs/module-boundaries.md` · `AGENTS.md` | 同步结构 / 接口表（删掉的接口不再列，`/inventory` 标成"共用"） |

---

## 三、没有删的与原因（⭐ 逐条核过引用）

| 看着像"查询"，但**没删** | 为什么 |
| --- | --- |
| `GET /api/workbench/inventory` | ⚠️ **不是孤儿**：`features/inventory/adjustment.js:284`（**库存手工调整** → 换季调整按品类列鞋）在调它。删了会打断她**要保留的「信息录入」入口**。**保留**（路由 + `queryInventory` 控制器 + service 方法） |
| `GET /api/workbench/inventory/products`、`/stock`、`/categories` | 同上 —— 都是 `adjustment.js`（第 145 / 199 / 267 / 408 行）在用 |
| `GET /api/workbench/sales/orders` | 服务于**交付 / 收款管理**（写入工作台），不是"销售查询"；见下 |
| `POST /api/workbench/sales/payments`、`POST /api/workbench/sales/deliveries` | **写入类**（补记收款 / 交付并扣库存），**不是查询**。她这次只点名删"**查询**页面与接口"；`docs/module-boundaries.md` 也明确「`/sales/payments`、`/sales/deliveries` 是**写入入口**，不能为了做查询页而更改其请求或重试语义」⇒ **不确定的保留并说明**（⚠️ 删除它们会摘掉一项她没让删的业务能力，代价远大于留三条死路由） |
| `server/src/services/v1WorkbenchService.js` | 🔴 **边界**：她/派活书写明「**不碰 `server/src/services/**`**」。⇒ 删除路由后，`getSalesReport` / `getTodaySales` 变成"只在测试里被调用"，**按边界保留**（见"不确定处"） |
| `server/src/services/salesFollowupService.js` 等 | 同上；`payments` / `deliveries` 路由保留着，它们**仍在生产调用链上** |

---

## 四、不确定处（明确留给她 / 派活人定）

1. **删除后 `getSalesReport` / `getTodaySales`（`v1WorkbenchService.js`）没有任何生产调用方**（只剩 `workbenchSalesRange.test.js` / `v1WorkbenchService.test.js` / `salesStatusDimensionGates.test.js` 闸门 6）。
   我**没有**删这两个方法、也没删那三个测试文件 —— 因为它们在 `server/src/services/**`（边界：不碰），而且同一个文件里还测着**要保留**的 `findProducts` / `getInventoryStockLevels` / `listInventoryCategories` / `getLiveInventory`。
   ⚠️ 同文件里两处注释已随路由删除而**过期**（`v1WorkbenchService.js:33` / `:249` 提到 `/sales/today`）——按边界**没动**。
2. **`/sales/orders` + `/sales/payments` + `/sales/deliveries` 现在没有工作台 UI 调用方**（原调用方 `features/sales/index.js` 已删）。
   三条路由 + `SalesFollowupService` 都**保留**（理由见上表）。若她要一并退场，是**另一轮**（要动 services）。
3. 「信息查询」两个 URL **她还没给** ⇒ 卡片现在显示「链接待配置」。拿到后**只改 `config/links.js` 两行**。
4. `common.html` 文件名**保留**（老收藏不坏），只把可见文案改成「信息录入」，并摘掉指向已删页面的导航链接。

---

## 五、先红后绿

见 `server/test/workbenchTwoTabsAndQueryEntries.test.js`：把前端 ES 模块复制成 `.mjs` 真跑一遍
（与 `workbenchHomeEntries.test.js` 同一个做法），**只改 import 的文件名，逻辑一个字不改**。

**改动前（红，11 失败 / 1 通过）**：

```
✖ AC1 一级 tab 只有 2 个：逐字「信息录入」「信息查询」，文案单一来源 config/tabs.js
✖ AC1b index.html：nav 留空（文案不在 HTML 里再写一遍）、不再加载已删的销售/库存样式
✖ AC3 信息查询 = 两个板块：销售查询 / 库存查询，各一张卡
✖ AC4 href 单一来源 config/links.js：config/query.js 只 import、渲染层不写死 URL
✖ AC5 空 URL（当前配置）：卡面「链接待配置」、不生成 <a>、不产生空 href
✖ AC5b 非空 URL（她给了之后）：href 逐字 = 配置值、rel="noopener"、同窗口
✖ AC6 信息查询不新增任何接口：渲染层一次网络调用都没有
✖ AC7 自建的销售/库存查询页面与模块已删
✖ AC8 零引用守门：工作台静态资源 + 路由 + 控制器都不再提已删的自建查询
✖ AC2 哨兵：信息录入（原「常用功能」只改名）里的两个入口逐字不变
✔ AC9/AC10 哨兵：工作台 auth 闸门与写入类接口不回退；共用的库存接口保留   ← 改动前本来就该绿的哨兵
✖ AC10b 独立页面启动器：删了 sales-query / inventory 两个视图，保留信息录入与两个子页
```

（典型报错：`ENOENT …/public/workbench/config/tabs.js`、`README.md 仍然引用已删的 sales-query.html`、
`控制器不许再导出 querySales`。）

**改动后（绿，12/12）**：AC1 · AC1b · AC3 · AC4 · AC5 · AC5b · AC6 · AC7 · AC8 · AC2 · AC9/AC10 · AC10b 全 ✔。

---

## 六、验收标准 · 逐条对照（改动后）

| # | 对照结果 |
| --- | --- |
| **AC1** | ✅ `MAIN_TABS = [{module:'common',label:'信息录入'},{module:'query',label:'信息查询'}]`；渲染出**2 个**按钮（逐字、顺序一致，第一个带 `active`） |
| **AC2** | ✅ `COMMON_ENTRIES` 仍是 `['报货与退货','库存手工调整']`（逐字 deepEqual 掉「库存手工调整」那条含 `wide`）；「报货与退货」`href` 仍 = `PURCHASE_REQUEST_FORM_URL` |
| **AC3** | ✅ `QUERY_SECTIONS` = 销售查询 · 库存查询；渲染出的卡标题逐字一致；面板 h2 = 信息查询 |
| **AC4** | ✅ `config/query.js` 只 `import './links.js'`；`config/query.js` 与 `features/query/index.js` 里都搜不到 `feishu.cn` 字面量 |
| **AC5** | ✅ 空值渲染（真跑）：两张卡都是 `<div class="entry-card disabled-card" aria-disabled="true">`，arrow = `链接待配置`，**整块 HTML 里一个 `href` 都没有**（`href=""` 也不会有）。非空值时同一函数渲出 `<a … href="<逐字配置值>" rel="noopener">`、**无 `target`**（同窗口） |
| **AC6** | ✅ `features/query/index.js`（去注释后）没有 `fetch(`、没有 `api-client`、没有 `api.get/post` |
| **AC7** | ✅ 6 个文件/目录已删（见第四节）；要保留的 5 个 key 文件都在 |
| **AC8** | ✅ `server/public/workbench/**`（js/html/md）零引用四个 needle；`routes/workbench.js` 无 `/sales/query`、`/sales/today`；控制器不导出 `querySales` / `queryTodaySales` |
| **AC9** | ✅ `app.js` 全量加载 OK；路由器实测只剩：`GET /inventory/products` · `/inventory/stock` · `/inventory/categories` · `/inventory` · `GET /sales/orders` · `POST /sales/payments` · `POST /sales/deliveries`（+ `/purchase`、`/inventory/adjustments` 两个 sub-router） |
| **AC10** | ✅ `requireWorkbenchAccess` + `feishuWebAuth` 仍在；写入类接口仍在；`features/inventory/adjustment.js` 仍调 `/api/workbench/inventory`（证明它不是孤儿）。`workbenchAuth401.test.js` 全绿 |
| **AC11** | ✅ `server/src/services/**` 零改动；`app.js` 零改动；`v1BitableSchema` 零改动；未碰 `.local/pending-push-card`；未写任何表（本次只读核 + 本地测试，测试全部用假 gateway） |
| **AC12** | ✅ 改动前红 / 改动后绿（见第五节）；全量 `node --test --test-concurrency=1` 在**独立 worktree** 连跑 **2 次** = **1377 pass / 0 fail**（两次都是） |
| **AC13** | ✅ 见第七节（CI 三项 + `mergeStateStatus`） |

---

## 七、CI 三项（实测输出）

`export XDG_CACHE_HOME=/tmp/ghcache GH_CACHE_DIR=/tmp/ghcache` 之后：

```
$ gh pr checks 264
Analyze (javascript-typescript)  pass  1m1s  …/runs/37719458137/job/113123509953
CodeQL                           pass  2s    …/runs/113123748295
test                             pass  56s   …/runs/37719458843/job/113123508749

$ gh pr view 264 --json mergeStateStatus,state
OPEN / CLEAN
```

- **PR**：<https://github.com/LyraWang6688/feishu-retail-ops/pull/264>
  （分支 `feat/workbench-two-tabs-external-query`，base `main`，commit `a563cbd`）。
- 🔴 **没有** `gh pr merge --admin`；🔴 **没有合并**（合并由业务负责人 / 派活人来做）。
- **全量 2 次**（独立 worktree，`node --test --test-concurrency=1`）：
  ① `1377 pass / 0 fail`（`duration 25.3s`）· ② `1377 pass / 0 fail`（`duration 22.6s`）。
- ⚠️ 该 worktree 里 `server/node_modules` 与根 `.env` 都是**临时软链**（`node_modules` 指向主工作区、
  `.env` 指向主工作区的 `.env`），**验完即删** —— 所以那 2 次全量是"同一份依赖 + 同一份测试凭证"下跑的，
  **结论只对本次改动有效**（合并后按第 14 条在主工作区重新同步）。
