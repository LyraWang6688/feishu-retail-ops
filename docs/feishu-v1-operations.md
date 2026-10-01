# 飞书进销存 V1：代码边界与线上排查

> **文档状态（2026-10-01）**
> 本文描述的运行边界与排查方式对应当前实现。
> 网页工作台**已经落地**（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），用于销售订单的后续收款、交付与查询，不再是「后续能力」；第 1 节已按此更新。
> 与本文冲突时，以根目录 `AGENTS.md` 和当前代码为准。

## 1. 当前产品边界

飞书私聊机器人是 V1 唯一继续开发的业务入口：

- 销售：用户发送自然语言，系统解析后发确认卡片；确认后写销售明细。启用销售库存开关后，再新增负数库存流水并扣减实时库存。
- 采购：用户连续发送到货图片并回复“采购完成”；系统识别、补充信息并确认后写采购入库。启用采购库存开关后，再新增正数库存流水并增加实时库存。
- 资金：当前不使用独立资金流水和供应商往来表，金额和支付方式保存在销售、采购业务表中。
- 库存联动默认关闭；库存 Schema 验证通过后，分别用 `ENABLE_SALES_INVENTORY=true` 和 `ENABLE_PURCHASE_INVENTORY=true` 启用。
- 网页工作台：已实现（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），复用同一套业务服务和数据访问层，不复制入账逻辑；承载销售订单的后续收款、交付与查询，不承担数据录入。
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

机器人销售文字用于创建一笔销售主表、一双鞋一条销售明细（初始履约状态「未交付」），并为已收到的款写「已收款」、未付余额写「未收款」、团购券预计结算款写「待平台结算」收款明细。确认未交付不会扣库存；确认已交付才会执行库存扣减。主表公式由多维表格维护，后端不写。

员工在飞书工作台的“后续收款/交付”页选择已有销售单：

- 补尾款：填写金额和支付方式；新单一次收清时更新原「未收款」记录为「已收款」，旧单无占位记录时新增实际收款；库存不变。
- 交付：选择待交付明细，后端按每条明细扣一双库存，成功后把该明细履约状态改为「已交付」。只扣门盒、样品，不自动扣仓库；每条实时库存记录也代表一双鞋。
- 一单多双可逐双交付；某双库存不足时不妨碍其他明细交付。退货和冲销留待后续增加独立业务事件。

相同交付明细重复提交不会重复扣库存。付款表单使用请求 ID 防止重复提交；如果飞书写入结果不确定，会停止自动重试并提示人工核对。

本版销售机器人可从一条消息解析多双鞋、多种收款；同一销售主表关联多条明细和收款明细。成交金额可与货品标价不同，但必须逐双说明；同一条文本只报多双合价而无法确定逐双价格时，系统要求补充，不猜测拆分。上线前分别执行 `pnpm run v1:schema-check:sales` 和 `pnpm run v1:schema-check:inventory`，然后用测试订单做一次完整的飞书读写回验。

库存流水使用当前字段“变动数量”“库存行为”“关联销售”“关联采购”。“变动数量”始终写正整数；销售交付关联行为“销售减少”并扣除对应状态的实时库存，采购入库关联“采购增加”并逐双新增实时库存。库存键是多维表格公式，实时库存“更新时间”为自动字段，后端不写它们。批量换季状态转换不在本次销售 MVP 范围内。

执行库存校验前，须在“行为管理”中确认两条配置：

- “销售减少”：库存方向为“减少”，是否启用为勾选。
- “采购增加”：库存方向为“增加”，是否启用为勾选。

`v1:schema-check:inventory` 会同时检查库存表字段和这两条行为配置；配置不完整时停止测试，不能通过修改流水正负号绕过。销售确认本身不扣库存；只有在工作台执行交付、看到库存流水回读为正数且关联了“销售减少”、相应实时库存少一双之后，才算销售库存链路验证完成。

## 部署门槛：先校验线上表结构

`server/scripts/deploy_build.sh` 在安装依赖之后会执行一次 `v1:schema-check:all`，
拿**即将上线的代码**去核对**线上多维表格的真实结构**。校验失败即中止部署，
旧进程继续运行，不会出现"新代码已启动、表结构却对不上"的中间状态。

这一步不是可选项。表结构在飞书侧改动、而服务器还没跟上时，错误不会在启动时
暴露，而是等到用户录单才报 `FieldNameNotFound`——线上真实发生过一次。

校验只读，不改任何飞书数据。它覆盖三类问题：

- 每张表的字段名是否与 `v1BitableSchema` 的映射一致；
- 「尺码」字段是否为单选关联「尺码管理」；
- 「行为管理」内销售减少 / 采购增加 / 门盒转样品三条行为的编码、方向与启用状态。

需要 .env 里配置好目标 Base 与机器人凭证。手工执行：

```bash
cd /opt/box2bitable/server
pnpm run v1:schema-check:all      # 全部范围
pnpm run v1:schema-check:sales    # 只查销售
```

表结构改动之后，先跑通校验再恢复服务。

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
