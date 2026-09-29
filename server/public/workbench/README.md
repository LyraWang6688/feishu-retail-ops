# 工作台前端结构

工作台采用浏览器原生 ES Modules，不需要单独构建。页面只调用同域名的 `/api/workbench/*`，不直接访问飞书 OpenAPI，也不在浏览器中重算销售、收款、交付或库存事实。

## 页面入口

- `/workbench/`：完整经营工作台。
- `/workbench/sales-today.html`：移动端常用的今日销售独立入口。
- `/workbench/inventory.html`：移动端常用的实时库存独立入口。

## 目录边界

- `core/`：登录、HTTP 请求、格式化和通用交互。
- `features/<domain>/`：销售、采购、库存等业务模块；模块不得查询其他模块的 DOM。
- `features/shared/`：无业务状态的共享视图。
- `styles/`：设计变量和全局布局；业务模块样式与模块放在一起。
- `main.js`：模块注册和一级导航，不承载业务规则。
- `standalone.js`：独立入口的共享启动器。

## 新增模块

1. 在 `features/<module>/` 中实现 `createXxxModule()`，返回包含 `mount(container)` 的对象。
2. 在 `main.js` 注册模块。
3. 模块通过 `core/api-client.js` 调用已约定的后端接口。
4. 新接口或响应字段先更新 `docs/workbench-query-contract.md` 和后端测试。
5. 无后端能力的功能必须明确显示“规划中”，不能放演示数据或无效按钮。

移动端查询表格使用 `.mobile-card-table` 和单元格 `data-label`，桌面端保持表格，窄屏自动切换为卡片。
