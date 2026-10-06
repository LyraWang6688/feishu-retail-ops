# 工作台前端结构

工作台采用浏览器原生 ES Modules，不需要单独构建。页面只调用同域名的 `/api/workbench/*`，不直接访问飞书 OpenAPI，也不在浏览器中重算销售、收款、交付或库存事实。

## 页面入口

一级 tab 只有 **3 个**（业务负责人 2026-10-06 定的），每个 tab 都有一个独立页面：

| 一级 tab | 独立页面 |
| --- | --- |
| 常用功能 | `/workbench/common.html` |
| 销售查询 | `/workbench/sales-query.html` |
| 实时库存 | `/workbench/inventory.html` |

「常用功能」下面还有两个子页：

- `/workbench/inventory-adjustment.html`：库存手工调整（盘点调整 / 换季调整）
- `/workbench/purchase-return.html`：采购退货（采购 / 退货）

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
