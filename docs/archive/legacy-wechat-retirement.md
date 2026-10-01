# Legacy WeChat Retirement（2026-10-01）

## 1. 退役时间

2026-10-01

## 2. 原用途

微信小程序是项目早期为了面试演示而做的可视化入口：拍照/选图 → 豆包识别 →
人工复核 → 写入飞书多维表格。它服务的是「看得见界面」的演示诉求，不是当前
正式业务入口。

## 3. 退役原因

1. 当前产品已经迁移到两个正式入口：飞书机器人（录入）与飞书网页工作台（后续收款、交付与查询）。
2. Legacy 路由链路已经断裂：`server/src/routes/legacyWechat.js` 仍然 `require`
   早已被删除的 `recognition` / `sync` / `query` / `analytics` / `salesTasks`，
   一旦挂载就抛 `MODULE_NOT_FOUND`，无法可靠启动。
3. 因此它也无法作为可靠的 E2E 链路：既不能稳定启动，也就无法回归验证。
4. 继续保留只会增加维护成本与 Agent Context 噪声——文档里到处是「冻结」「可通过开关停用」
   的说法，误导后续判断。

决定：不再以「Frozen Legacy」方式保留，而是**正式退役并整体删除**。

## 4. 本次删除的内容

入口与前端：

- `miniprogram/`（整个目录，含页面、工具与本地配置）
- `server/src/routes/legacyWechat.js`
- `server/src/app.js` 中的 Legacy Router 挂载与 `ENABLE_LEGACY_WECHAT` 判断

仅被旧 recognition / sync / query / analytics / salesTasks 链路引用的后端代码：

- services: `feishuService.js`、`salesTaskService.js`、`salesTaskStore.js`、`salesOrderFeishuWriter.js`
- utils: `formatter.js`、`recognitionFormatter.js`、`syncAggregation.js`、`salesAnalytics.js`、`salesOrderBuilder.js`、`discountAllocation.js`
- config: `salesActions.js`、`salesTables.js`、`salesTableFields.js`
- scripts: `write_sales_sample.js`
- 对应的 7 个测试文件（共 27 个测试）

环境变量：

- `ENABLE_LEGACY_WECHAT`、`WX_APP_ID`、`WX_APP_SECRET`（从 `.env.example` 移除，代码中已无读取点）

## 5. 历史源码

旧源码不再保留在仓库工作树中，可通过 Git History 获取（退役前最后一个包含
`miniprogram/` 与旧路由的提交是 `5c9d8e643a3782c6d687c11c105fe56a5a240434`）。

本目录**不复制**旧源码。

## 6. 当前替代入口

| 入口 | 承担的工作 |
|---|---|
| 飞书机器人（私聊） | 销售自然语言录入、采购到货图片录入 |
| 飞书网页工作台（`GET /workbench`、`/api/workbench/*`） | 销售订单后续收款、交付与工作台查询 |

## 7. 不要做的事

- 不要重建 `miniprogram/` 或微信小程序。
- 不要重建 `recognition` / `sync` / `query` / `analytics` / `salesTasks` 路由。
- 不要把 `ENABLE_LEGACY_WECHAT` 加回来：代码里已经没有任何读取点。
