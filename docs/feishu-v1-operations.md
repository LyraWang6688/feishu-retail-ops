# 飞书进销存 V1：代码边界与线上排查

## 1. 当前产品边界

飞书私聊机器人是 V1 唯一继续开发的业务入口：

- 销售：用户发送自然语言，系统解析后发确认卡片；确认后写销售明细。启用销售库存开关后，再新增负数库存流水并扣减实时库存。
- 采购：用户连续发送到货图片并回复“采购完成”；系统识别、补充信息并确认后写采购入库。启用采购库存开关后，再新增正数库存流水并增加实时库存。
- 资金：当前不使用独立资金流水和供应商往来表，金额和支付方式保存在销售、采购业务表中。
- 库存联动默认关闭；库存 Schema 验证通过后，分别用 `ENABLE_SALES_INVENTORY=true` 和 `ENABLE_PURCHASE_INVENTORY=true` 启用。
- 网页工作台：后续复用同一套业务服务和数据访问层，不复制入账逻辑。
- 微信小程序：冻结，不新增功能；当前保留，仅用于平稳退役。

## 2. 可删除的代码边界

```text
飞书入口（长期保留）
server/src/routes/larkEvents.js
        ↓
server/src/services/larkMvpService.js
        ↓
server/src/services/v1PostingService.js
server/src/services/v1ReferenceResolver.js
server/src/services/v1BitableGateway.js
        ↓
飞书 V1 多维表格

微信入口（冻结、以后整块删除）
miniprogram/
server/src/routes/legacyWechat.js
        ↓
recognition / sync / query / analytics / salesTasks
```

共享的 AI、日志和基础设施不属于微信代码。飞书模块禁止引用
`legacyWechat.js`、旧 controller 或 `SalesTaskStore`。

退役分两步：

1. 服务器设置 `ENABLE_LEGACY_WECHAT=false` 并重载，观察至少 7 天；飞书回归测试必须通过。
2. 再删除 `miniprogram/`、`legacyWechat.js` 以及仅被旧路由引用的 controller/service。

## 3. 日志设计

程序输出单行 JSON，重要字段如下：

| 字段 | 用途 |
|---|---|
| `request_id` | 一次 HTTP 请求，由服务器生成并在响应头返回 |
| `message_id` | 飞书消息唯一 ID，用于判断事件是否重复 |
| `task_id` | 一次销售草稿或采购批次在本地的跟踪 ID |
| `source_no` | 确认入账后的人类可读销售单号或入库单号 |
| `table_key` | 程序中的数据表语义名 |
| `table_id` / `record_id` | 飞书 Open API 的真实定位 ID |
| `event` | 当前阶段，例如接收、解析、确认、写表或失败 |
| `duration_ms` | 本阶段耗时 |
| `result` | 阶段结果 |

日志可以记录原文字数、商品条数、图片张数，但禁止记录销售原文、图片内容、
App Secret、Token 或完整 `open_id`。人员 ID 会自动脱敏。

一条销售的主要事件顺序应为：

```text
lark.event.received
lark.sales.accepted
lark.sales.processing.started
bitable.record.created / bitable.record.updated
lark.sales.processing.completed
lark.card.received
lark.sales.posting.completed
```

## 4. PM2 服务器排查

以下命令都在服务器的 `server/` 目录执行：

```bash
pm2 status
pm2 show box2bitable-server
pm2 logs box2bitable-server --lines 200
curl -sS http://127.0.0.1:5000/health
curl -sS http://127.0.0.1:5000/api/lark/events/health
pnpm run v1:schema-check:sales
pnpm run v1:schema-check:purchase
pnpm run v1:schema-check:inventory
```

按一条业务排查时，优先用 `message_id`、`task_id`、`source_no` 或
`record_id` 搜索 PM2 日志，而不是翻看所有输出。示例：

```bash
pm2 logs box2bitable-server --nostream --lines 2000 | grep 'sale_'
pm2 logs box2bitable-server --nostream --lines 2000 | grep 'bitable.record.*failed'
```

排查顺序固定为：

1. `/health` 是否正常；
2. 是否收到 `lark.event.received`；
3. 是否生成 `task_id`；
4. AI 解析是否完成；
5. 用户是否点击确认卡片；
6. 每一张表是否返回 `record_id`；
7. 最后回读销售主表/采购批次；发生交付或采购入库后，再核对库存流水和实时库存。

“事件已收到”不等于“已入账”；只有出现 `posting.completed`，且相关飞书记录回读一致，才算完成。

## 销售 MVP：首单与后续动作

机器人销售文字用于创建一笔销售主表、一条或多条销售明细，并在用户已收钱时创建一笔或多笔收款记录。确认销售不会扣库存。销售明细的金额及主表汇总留给多维表格公式/汇总字段，后端只写商品、尺码、数量、赠品与实际收款事实。

员工在飞书工作台的“后续收款/交付”页选择已有销售单：

- 补尾款：填写金额和支付方式，新增一条收款记录；销售主表与销售明细不会重建，库存不变。
- 交付：勾选待交付明细及库存状态（门盒、样品、仓库），后端先按明细写库存流水并移除相应数量的实时库存记录，再更新销售明细交付数量及主表履约状态。每条实时库存记录代表一双鞋。
- 当前交付表单只支持“一条销售明细一次性交付全部数量”。部分交付、退货和冲销留待后续增加独立业务事件；已有部分交付数据会被拒绝并提示核对。

相同交付明细重复提交不会重复扣库存。付款表单使用请求 ID 防止重复提交；如果飞书写入结果不确定，会停止自动重试并提示人工核对。

本版销售机器人可从一条消息解析多双鞋、多种收款；同一销售主表关联多条明细和收款记录。若原话成交总额与货品单价公式计算值不同，当前字段无法保存成交差价，系统会要求修正而不入账。上线前分别执行 `pnpm run v1:schema-check:sales` 和 `pnpm run v1:schema-check:inventory`，然后用测试订单做一次完整的飞书读写回验。

## 5. 新租户迁移约束

新飞书应用、新租户和新多维表格必须使用独立配置：

- `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET`
- `LARK_AGENT_VERIFICATION_TOKEN` / `LARK_AGENT_ENCRYPT_KEY`
- `FEISHU_V1_BITABLE_APP_TOKEN`
- 各 V1 `TABLE_ID`

旧的 `FEISHU_*` 和 `WX_*` 只服务遗留链路。代码已经禁止飞书 V1 回退到旧租户凭证；新凭证缺失时应拒绝启动，而不是尝试写入旧表。

## 6. 项目命名与兼容名称

通用产品名：**零售数智经营助手**。

邯美部署名称：**邯美数智经营工作台**。

GitHub 仓库：`LyraWang6688/feishu-retail-ops`。该名称覆盖飞书机器人、网页工作台、
进销存和资金联动，也便于其他线下零售企业 Fork 后替换自身配置。

暂时保留以下运行兼容名称，等飞书 V1 上线稳定后再单独迁移：

- PM2 进程：`box2bitable-server`
- 服务器目录：`/opt/box2bitable`

服务器目录和 PM2 名称不属于用户可见产品名。保留它们可以避免仓库改名影响当前部署；后续迁移时必须单独修改部署脚本、PM2 配置和运维命令，并完成回归测试。
