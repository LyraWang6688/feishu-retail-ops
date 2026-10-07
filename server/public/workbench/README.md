# 工作台前端结构

工作台采用浏览器原生 ES Modules，不需要单独构建。页面只调用同域名的 `/api/workbench/*`，不直接访问飞书 OpenAPI，也不在浏览器中重算销售、收款、交付或库存事实。

## 页面入口

一级 tab 只有 **3 个**（业务负责人 2026-10-06 定的），每个 tab 都有一个独立页面：

| 一级 tab | 独立页面 |
| --- | --- |
| 常用功能 | `/workbench/common.html` |
| 销售查询 | `/workbench/sales-query.html` |
| 实时库存 | `/workbench/inventory.html` |

> ⚠️ **点一级 tab 就是【直接进查询界面】**（业务负责人 2026-10-06 的原话：
> 「当我点开 tab 页之后……不需要我再单独打开一个独立的 URL」）。
> 所以 tab 面板里**不许**再放「独立打开销售查询 / 独立打开实时库存」这类
> **入口卡片 + 按钮**；说明只留一行小字（`.page-hint`，见 `styles/base.css`）。
> 上面那些独立页面**仍然存在、仍然能开**（旧收藏 / 外链不会坏），
> 只是**不再是进查询的必经之路**。
> `focused: true`（独立页面）与 `focused: false`（一级 tab）是两条渲染分支：
> **改「tab 里看到什么」改后者，别把两者混起来。**

「常用功能」首页的入口卡片由 `config/home.js` 的 `COMMON_ENTRIES` 决定（名称 / 图标 / 目标 / 顺序）。
⭐ **只有两张卡：采购 + 库存手工调整**（业务负责人 2026-10-08：
「工作台需要修改一下，**采购和退货合并为一个入口**，**就用采购的链路**，即**退货的链接没有了**～」）——
所以首页**不再有「退货」那张独立卡**，【采购】那一张卡指向工作台内页
`/workbench/purchase-return.html`（报货 / 退货两个飞书表单都在那一页里）：
**退货从"首页一级入口"变成"采购页里的子入口"，功能没丢**。
口径与取舍（含"报货因此多点一次"这个已知代价）见
`docs/workbench-purchase-return-merge-2026-10-08.md`。

「常用功能」下面还有两个子页（**旧收藏仍然能开**）：

- `/workbench/inventory-adjustment.html`：库存手工调整（盘点调整 / 换季调整）
- `/workbench/purchase-return.html`：采购和退货（**两个飞书表单外链**，不做查询）——
  ⭐ 首页的【采购】卡就走它，**它一个字没改**：不带参数打开时，默认仍然把两张表单卡都显示出来。
  （2026-10-07 拆分那份留档见 `docs/workbench-purchase-return-split-2026-10-07.md`。）

其它入口：

- `/workbench/`：完整经营工作台（一级 tab + 各模块面板）。
- `/workbench/sales-today.html`：**已改名**为「销售查询」，这个文件只做跳转到 `sales-query.html`
  （旧链接/收藏不会 404）。

### 隐去的入口（代码保留）

「采购管理 / 资金管理 / 抖音运营 / 平台管理」四个一级 tab **只是把入口隐去**：
它们的模块仍注册在 `main.js` 的 `modules` 表里，只是 `index.html` 的 `#main-tabs`
里没有对应的按钮。恢复某个入口 = 加回一行
`<button class="main-tab" data-module="purchase">采购管理</button>`，逻辑不用改。

## 目录边界

- `core/`：登录、HTTP 请求、格式化和通用交互。
- `config/`：前端配置（`links.js`：飞书表单等外链；`home.js`：首页【常用功能】的入口清单）。
  **配置先行** —— 换链接 / 加减少一个首页入口只改这里，页面模块不写死 URL 与清单。
- `features/<domain>/`：销售、采购、库存等业务模块；模块不得查询其他模块的 DOM。
- `features/shared/`：无业务状态的共享视图。
- `styles/`：设计变量和全局布局；业务模块样式与模块放在一起。
- `main.js`：模块注册和一级导航，不承载业务规则。
- `standalone.js`：独立入口的共享启动器（页面用 `<body data-view="...">` 声明自己是谁）。

## 新增模块

1. 在 `features/<module>/` 中实现 `createXxxModule()`，返回包含 `mount(container)` 的对象。
2. 在 `main.js`（完整工作台）和/或 `standalone.js`（独立页面）注册模块。
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
