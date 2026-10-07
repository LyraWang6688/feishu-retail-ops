# feishu-retail-ops 项目规范

## 项目概述

`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。它以飞书机器人、飞书网页应用和飞书多维表格为基础，为线下零售与小型企业提供销售、采购、库存和资金联动能力。

当前 V1 的销售录入入口是飞书**群聊**机器人（**群 / 群话题**里的自然语言文字，2026-10-07 起；私聊入口已移除，见下方「私聊链路已移除」）；采购有**一条**由飞书多维表格记录变更事件触发的链路：**供应商报单**新增 → 解析「数量说明」文字**直接生成采购申请（免确认）**，再按供应商渲染 PNG **发到采购群**（`PURCHASE_CHAT_ID`）**@经办人**（🔴 **不再 @所有人** —— 业务负责人 2026-10-07 确认：「@经办人」是对的）并把图写回「采购申请单」附件。机器人**不接收**采购图片，收到非文字消息会明确回绝并提示使用采购表单。「采购到货」表仍然存在，但它现在**只是一张数据容器**（到货日 / 验收原话 / 确认状态 / 验收人 / 图片），往里面新增记录**不触发任何事**——原来那条「拍照 → 识别鞋盒/到货单 → 与采购申请比对 → 确认后入库」的链路已于 2026-10-05 整体退场（业务负责人删掉了「类型」「识别状态」「识别失败原因」三个字段，并决定改成**纯对话驱动**）。销售经用户确认后由后端统一入账；**采购申请是唯一的例外**——报单记录本身就是产品负责人的输入，产品负责人明确要求免确认（理由与红线边界见 `PurchaseWebhookService.publishPurchaseRequest` 的注释）。飞书网页工作台已经实现并存于本仓库（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），用于销售订单的后续收款、交付与工作台查询，不承担数据录入。原微信小程序链路已于 2026-10-01 正式退役并从代码库整体移除，不是当前入口，也没有开关可以重新启用它。

**群聊入口（2026-10-05 起）**：机器人也接收**群聊**消息，准入判据有**两条，且必须先判 `thread_id`**（判据位置：`server/src/services/larkMvpService.js` 的群聊分支，`origin/main` 第 372–402 行）：

- **消息在话题里（`thread_id` 有值）→ 一律处理，不要求 @ 机器人**（第 386–387 行；真机实测：她在话题里发「你好 小来财」时 `mentions` 为空，事件照样推给我们——话题本身就是"冲着机器人来的"的判据）。
- **主群消息（`thread_id` 为空）→ 才要求 `message.mentions` 里有机器人自己的 open_id**（`LARK_BOT_OPEN_ID`，第 390–401 行）。没配 `LARK_BOT_OPEN_ID` 时**一条主群消息都不处理**。

⚠️ 顺序不能反：先读 `mentions` 会把话题里没 @ 的消息当成"主群没 @"丢掉——这正是真机测出来的 bug。不处理 → **完全静默、零远端调用**（群里日常聊天绝不能被触发）；处理 → 加 `OneSecond` 表情确认（群里**不回**文字，避免刷屏），再走采购定位链路（`PurchaseBatchLocator.resolve`，`server/src/services/purchaseBatchLocator.js` 第 148 行起），**按顺序**：

1. **`thread_id`** → `findByThreadId`（第 98 行；最稳——她在话题里后续发的消息不一定还引用着机器人那条）
2. **`message.parent_id`**（引用采购单那条消息）→ `findByMessageId` 反查本地映射（第 88 行）
3. **正文里的批次号 `BH-YYYYMMDD-NNNN`** → `findByBatchNo`（第 134 行；**只有既没话题也没引用时**才走这条）
4. **都没有 → 回一句问清楚**（第 209 行），**绝不猜"最近一笔"**

⚠️ 两个"认不出"：话题里但这条话题没记过映射、又没引用 → 直接说认不出，**不拿正文号去猜**（第 183 行）；引用到的不是我们发的消息（或映射丢了）→ 同样认不出（第 177 行）。采购单与群里那条消息的 `message_id ↔ 批次`（以及 `thread_id`）映射写在本地任务记录 `server/data/purchase_group_messages/`，**不写业务表**。

**🔴 私聊链路已移除（2026-10-07 起）**：业务负责人口径（逐字）「**以后私聊这条链路我们就没有了**」；
她拍板的方式是 **ⓐ：代码里一行私聊都不留，测试全部迁到群聊入口**
（见 `docs/private-chat-removal-decision-2026-10-07.md`）。
入口统一到【群聊 + 话题】—— 私聊（以及一切非群聊）消息**只记一条
`lark.private_chat.disabled` 日志**：不建任务、不进 AI、不读表、不写表。
⭐ **唯一保留的动作是回一句固定文案**（`PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` 默认 `true` /
`PRIVATE_CHAT_DISABLED_NOTICE_TEXT`，见 `config/privateChatNotice.js`）；**空串 = 关掉那句话**；
🔴 **仍然没有**恢复私聊入口 / 发送的开关 —— `PRIVATE_CHAT_INTAKE_ENABLED` 之类的变量**刻意不存在**；
要恢复私聊是**重新实现那条链路**，不是翻一个开关（留开关的方案 ⓑ 已被否掉）。
⚠️ 顺带删掉的私聊专属件：`larkMvpService.sendTodaySales` / `handleBotMenu` / `shanghaiDay`、
路由的 `application.bot.menu_v6` 分支、`utils/larkCards.todaySalesCard`、
`purchaseWebhookService.sendCard`、
`larkMvpService.sendCard`（open_id 口径的卡片发送器，2026-10-07 收尾时成孤儿）、
`SampleReplacementService` 的 `sendCard` / `sendText` 两个 open_id 发送器。
⚠️ **没有群上下文的任务 = 没有去处**：`sendTaskCard` / `sendTaskText` 只记
`lark.private_chat.send_skipped` 并返 `null`。
⭐ 2026-10-07 收尾把剩下 5 处**缺省回落发私聊**也清了
（`saleLookupService` ×2 / `afterSalesFlowService` ×2 / `salesThreadProgressService` ×1）：
现在缺省出口一律"记 skip + 返 `null`"，日志只有一处定义
（`utils/privateChatSend.js` 的 `skipNoGroupContext`）。
⭐ 同日**二次收尾**又补了最后 2 处**同形状**的（都只在非群分支）：
`larkMvpService.replyTaskCard`（不再 `replyCard(task.message_id, …)`）与
`afterSalesFlowService.replyCardToTask` 的缺省（非群 → skip + `null`，**群那一条逐字不变**）。
⭐ 同日**三次收尾**把最后 2 处**主回复路径**也堵了 ——
`larkMvpService` 的销售确认卡片非群分支（不再 `replyCard(task.message_id, …)`）与
`saleLookupService.replyCardByTask` 的主回复（非群在函数入口 skip + 返 `null`）；
两处都**只在非群分支**，**群那一条逐字不变**；没发出去时**也不记**「已发出」日志
（`lark.sales.card.sent` / `sale_lookup.card.sent`）。
⚠️ `replyCard` **不是孤儿**（`LarkMvpService` 里仍有 **3** 个调用方：
`:138` 销售查单群路径 / `:158` 售后接线 / `:442` 采购卡片无话题回落）→ 保留。
⭐ 详见 `docs/private-chat-removal-2026-10-07.md` 第七节（验收标准 + 逐条对照）。
**有意的行为变化**：
`SampleReplacementService.notifySampleReplacements` 在**工作台触发**（
`routes/workbench.js`，没有群上下文）时**不再静默发私聊**；
群销售那条则回到**那条销售话题**（`reply_in_thread`）。
⭐ 验收标准、实现与测试证据见 `docs/private-chat-removal-2026-10-07.md`。

> **采购链路的历史**：曾存在一条"机器人收采购图片 → 写「采购批次」表 → `PurchasePostingService`"
> 的旧链路（`acceptPurchaseImage` / `finishPurchaseImages` / `processPurchaseTask` /
> `purchaseDraftBuilder` / `purchasePostingService` / schema 里的 `purchaseBatch`）。
> 它在 2026-10-04 已**整体删除**——这些方法此前已无任何调用方。
>
> 2026-10-05 又退场了一条：**「采购到货 → 拍照识别 → 确认入库」**（`processArrival` /
> `resolveArrivalProduct` / 到货等待与超时策略 `arrivalWaitPolicy` / 到货详情卡片
> `purchaseArrivalDetailCard` / 卡片动作 `confirm_purchase_arrival` / 视觉模型配置
> `VISION_LLM_*` / 鞋盒与到货单两个识别方法）。理由：她删掉了那张表上的三个识别字段，
> 并明确「不再用拍照识别，改成纯对话驱动」。
> ⚠️ **保留**的是入库与建档这两项能力（`confirmArrival` 写「采购入库」+ 调库存
> `inventory.applyPurchase`；`ensureArrivalProducts` 建档 + 成本）——它们现在**没有生产调用方**
> （孤儿能力，等「对话到货」接）。⭐ **「把后者剥成 `services/productCreationService.js`」这件事
> 还没进 main**——原分支 `refactor/decouple-creation-and-stock`（PR #80 CLOSED）已于 2026-10-06
> 清理时删除，但**剥出来的 service 原文与全量 patch 已留档在**
> `docs/branch-salvage-2026-10-06/`（索引见 `docs/branch-salvage-2026-10-06.md` 第 4 节）。
> 真要做这件事时以那份留档为起点，别重新发明。

## 技术栈

- **当前入口**：
  - 飞书机器人**群聊 / 群话题**：销售自然语言录入（2026-10-07 起；**私聊入口已移除**）
  - 飞书多维表格记录变更事件：供应商报单（文字）一条链路
    （「采购到货」表已退化为数据容器，新增记录不触发任何事）
  - 飞书网页工作台（已实现）：销售订单后续收款、交付与工作台查询
- **后端**：Node.js + Express (>=20)
- **部署方式**：腾讯云轻量应用服务器 + Nginx + PM2
- **AI 模型**：DeepSeek。当前**只有一组**配置——文字解析（销售录单、采购数量说明）。
  原先还有一组图片识别（鞋盒 / 供应商到货单照片），已随「采购到货 → 拍照识别」链路退场删除；
  缺配置就直接报错，**不跨供应商兜底**
- **表格服务**：飞书多维表格 (Feishu Bitable) API

## 目录结构

```
.
├── AGENTS.md           # 仓库级 Agent 入口（本文件）
├── README.md           # 人的入口
├── docs/               # 项目文档
│   ├── README.md       # 文档索引（现行 / 历史）
│   ├── adr/            # 架构决策记录（为什么这样设计，不记录怎么使用）
│   ├── archive/        # 历史文档归档（原 agent.md、原 .trae 文档）
│   └── prototypes/     # 设计原型
├── server/             # 后端 Express 代码
│   ├── src/
│   │   ├── config/       # 表格、模块与行为配置
│   │   ├── controllers/  # 控制器（工作台）
│   │   ├── infrastructure/ # 任务存储、串行队列、幂等
│   │   ├── routes/       # 路由（飞书事件、工作台）
│   │   ├── services/     # 业务逻辑（AI、飞书、销售、采购、库存）
│   │   └── utils/        # 工具类
│   ├── public/workbench/ # 网页工作台静态资源
│   ├── scripts/         # 部署、运维与校验脚本
│   └── package.json
├── supabase/           # 历史数据库迁移脚本
├── server/uploads/     # 服务端临时上传目录（运行时自动创建）
├── .env.example        # 环境变量模板
└── Dockerfile          # 容器构建与部署入口
```

## 关键入口 / 核心模块

### 后端服务 (server/)

- **入口文件**：`src/app.js`
- **运行命令**：`pnpm start` (生产) / `pnpm run dev` (开发)
- **当前 HTTP 入口**（按 `src/app.js` 与各 route 文件的实际挂载整理）：

| 入口                                                                                                                    | 说明                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `POST /api/lark/events`                                                                                               | 飞书事件回调（**群聊 / 群话题**消息、卡片动作；私聊消息到达但**默认不处理**）   |
| `GET /api/lark/events/health`                                                                                         | 事件回调健康检查                        |
| `GET /api/auth/feishu/me`、`GET /api/auth/feishu/start`、`GET /api/auth/feishu/callback`、`POST /api/auth/feishu/logout` | 工作台飞书身份认证                       |
| `GET /api/workbench/sales/today`                                                                                      | 今日销售                            |
| `GET /api/workbench/sales/orders`                                                                                     | 订单列表                            |
| `POST /api/workbench/sales/payments`                                                                                  | 补记收款                            |
| `POST /api/workbench/sales/deliveries`                                                                                | 交付并扣减库存                         |
| `GET /api/workbench/inventory`                                                                                        | 库存查询                            |
| `GET /api/workbench/purchase/requests`、`GET /api/workbench/purchase/arrivals`                                         | 采购申请与到货查询                       |
| `GET /workbench`                                                                                                      | 网页工作台静态页面（`GET /` 同样回落到工作台首页）   |
| `GET /health`                                                                                                         | 健康检查（含版本与 commit）               |
| 其余 `/api/*`                                                                                                           | 由 `API_KEY`（`x-api-key` 头）中间件保护 |

- **Legacy / Removed from current V1**：`/api/recognition`、`/api/sync`、`/api/query`。对应 route 文件已在 V1 删除，只剩遗留微信链路中的痕迹，**不是**当前 V1 的主要 API，不要据此排查线上问题。
- **部署脚本**：`server/scripts/deploy_build.sh` / `server/scripts/deploy_run.sh`

### 微信小程序（已退役）

> RETIRED：原 `miniprogram/` 及其对应的 `/api/recognition`、`/api/sync`、`/api/query`、`/api/analytics`、`/api/sales/tasks` 已于 2026-10-01 正式退役并整体删除。历史源码见 Git History，退役记录见 `docs/archive/legacy-wechat-retirement.md`。不要重建、不要用开关重新启用。

## 运行与预览

### 后端启动

```bash
cd server
pnpm install
pnpm run dev
```

### 环境变量

参考 `.env.example`。按当前代码实际读取范围分三类：

**当前 V1 核心（缺一不可）**

- `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` - 飞书机器人应用凭证（`src/config/larkAgent.js`，缺失直接报错，不回退旧凭证）
- `LARK_AGENT_VERIFICATION_TOKEN` / `LARK_AGENT_ENCRYPT_KEY` - 飞书事件回调校验与解密
- `FEISHU_V1_BITABLE_APP_TOKEN` - V1 目标多维表格（无默认值，缺失直接报错）
- `FEISHU_V1_*_TABLE_ID` - V1 各业务表 ID（货品、销售、采购、库存等）
- `TEXT_LLM_API_KEY` / `TEXT_LLM_BASE_URL` / `TEXT_LLM_MODEL` - **文字**模型（销售录单、采购数量说明）
- `PURCHASE_ARRIVAL_INTAKE_ENABLED` - 「采购到货 → 拍照识别」链路的显式开关（**已退场，无读取点**）
- `API_KEY` - 非飞书 `/api` 接口的 `x-api-key` 鉴权

**群聊采购链路（缺了不会报错，但会"安静地不工作"，所以必须显式配）** — 取值都在 `src/config/groupPurchase.js`

- `PURCHASE_CHAT_ID` - 采购单发到哪个群（chat_id，形如 `oc_xxx`）。**没有默认值**：留空时采购申请照常写成，但图与说明不发，并打 `purchase.request.image.skipped` 警告（**不会**回落到经办人私聊）
- `LARK_BOT_OPEN_ID` - 机器人自己的 open_id（形如 `ou_xxx`），判「群里有没有 @ 机器人」的唯一依据。**没有默认值**：留空时群聊消息一律不处理（并打 `lark.group.bot_open_id_missing` 警告）

> **私聊链路（已移除，2026-10-07）**：**没有恢复私聊入口 / 发送的开关** ——
> 她拍板的是「代码里一行私聊都不留」（ⓐ）。
> ⭐ **只有两个可见的变量，都是"那一句 notice"的旋钮**
>（取值在 `src/config/privateChatNotice.js`）：
> `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED`（默认 `true`）、
> `PRIVATE_CHAT_DISABLED_NOTICE_TEXT`（默认「这个机器人现在只在群里工作，请到群里说～」；
> **空串 = 关掉那句话**）。
> 私聊消息只记一条 `lark.private_chat.disabled`；没有群上下文的任务只记一条
> `lark.private_chat.send_skipped`（全仓只有 `src/utils/privateChatSend.js` 一处定义）。
> 见 `docs/private-chat-removal-2026-10-07.md`。
- `LARK_ACK_REACTION` - 「收到」表情的 emoji_type，默认 `OneSecond`（真机验证有效）

> 模型配置**没有默认值、也不跨供应商兜底**（原先缺省会回退到 `ARK_*` 豆包，已取消）：
> 缺配置就在调用时报错，不静默改用别家——否则会造成「以为在用 A、实际在用 B」。
> 取值由 `src/config/llmModels.js` 解析。
> `VISION_LLM_API_KEY` / `VISION_LLM_BASE_URL` / `VISION_LLM_MODEL` / `VISION_LLM_TIMEOUT_MS`
> 与 `ARRIVAL_*`（等待与提示的四个阈值）**都已随识别链路退场删除，没有任何读取点**，不要再加回来。
> `ARK_API_KEY` / `ARK_MODEL_ENDPOINT` / `ARK_API_BASE_URL` 同样**已无任何读取点**。
>
> `PURCHASE_ARRIVAL_INTAKE_ENABLED` 是唯一的例外：**模块刻意保留、但已无读取点**
>（`src/config/purchaseArrivalIntake.js`）。将来恢复「对话到货」时它是一个现成的、
> 语义明确的开关（已钉住"空字符串不等于关闭"那个坑）；现在改它不会有任何效果。

**网页工作台身份认证（Workbench Auth）**

- `LARK_WEB_AUTH_ENABLED` / `LARK_WEB_REDIRECT_URI` / `LARK_WEB_SESSION_SECRET` / `WORKBENCH_ALLOWED_OPEN_IDS`

**迁移脚本与 E2E 专用**

- `FEISHU_TARGET_ENV` / `FEISHU_ALLOW_PRODUCTION_WRITE` - 写库脚本的环境闸门
- `FEISHU_V1_E2E_TEST_APP_TOKEN` / `FEISHU_V1_E2E_PRODUCT_RECORD_ID` / `FEISHU_V1_E2E_ITEM_NO` / `FEISHU_V1_E2E_SIZE`

**运行开关**

- `ENABLE_CORS` / `NODE_ENV` / `PORT` / `UPLOAD_*` / `APP_*`

> 以下变量已随 Legacy WeChat Retirement 从代码与 `.env.example` 一并删除，不再有任何读取点，不要再加回来：  
> `ENABLE_LEGACY_WECHAT`、`WX_APP_ID`、`WX_APP_SECRET`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、  
> `FEISHU_BITABLE_APP_TOKEN`、`FEISHU_BITABLE_*_TABLE_ID`。

## 测试与安全边界

### 本地自动化测试

```bash
cd server
pnpm test
```

### Schema 校验（只读结构校验）

```bash
cd server
pnpm run v1:schema-check:all
pnpm run v1:schema-check:sales
pnpm run v1:schema-check:purchase
pnpm run v1:schema-check:inventory
```

Schema Check 只回答「目标 Base 的字段与关联结构是否满足契约」，**不会写入或修改**多维表格。

### 真实写入与 E2E 边界

- 真实 E2E **禁止**把生产 Base 当测试环境。
- 真实写入测试必须使用明确隔离的 Test Base / Test Data（`FEISHU_TARGET_ENV=test` 配合 `FEISHU_V1_E2E_*`）。
- 写库脚本默认拒绝写生产；确需写生产必须显式开闸（`FEISHU_ALLOW_PRODUCTION_WRITE=true`）。
- 普通 Agent 不得自行对生产数据执行 E2E 写操作。

## 用户偏好与长期约束

- Node.js 版本要求 >=20
- 使用 pnpm 作为包管理器
- 后端服务默认端口 3000（部署时使用 5000）
- 不校验合法域名仅限本地开发调试

## 协作角色与工程原则

在本项目中，Codex 的角色不只是“写代码的人”，而是同时承担三层职责：

1. **程序员**：把具体功能实现出来，保证代码能跑、接口能通、测试能过。
2. **软件工程师**：关注可维护性、测试、日志、错误处理、部署、性能、排查路径，避免功能越做越乱。
3. **架构师**：在新增功能时提前考虑系统边界、模块拆分、配置驱动、状态流转、未来扩展、多用户产品化、数据结构演进，而不是只解决眼前需求。

长期工程原则：

- 先做 MVP，但不能牺牲后续可维护性。
- 少写散落的 `if-else`，优先使用配置规则和状态驱动。
- 每个关键流程节点都要有日志和可排查路径。
- 用户体验上要给出明确反馈，不能让用户觉得系统卡住。
- 新功能要考虑未来产品化、多用户配置、业务链变长后的排查成本。

## 底层工程原则：解耦 · 模块化 · 配置先行（**业务负责人定的"重中之重"**）

业务负责人 2026-10-05 明确要求：

> 「你一定要把**业务模块解耦**，一定要**模块化**，一定要**配置先行**，**这个是你的重中之重**。
>  不管你是在**改写代码**，还是在**重构代码**的时候，都必须做到这一点。」

**为什么**：本项目的**链路与表结构会持续演进**——例如
「供应商报货」→「供应商对接」、「采购申请」→「单据信息」（同日改名）；
「鞋盒/报货单 → 采购到货 → 采购入库」这条链路**本身是临时的、随时可能被拿掉**；
未来架构是「报货 → 采购申请单 → 到货（**在采购申请上修正**）」。
→ 功能若绑死在会变的链路或字段上，每次演进都要重写；解耦之后，**换掉一条链路不影响别的**。

### 三条可检查的标准（改代码 / 重构时逐条自问）

1. **解耦**：这个功能**绑在"随时会换的东西"上了吗**？
   - 反例（**已剥离、但还没进 main**）：**新品建档 + 写成本**曾绑在**拍照识别**链路上 →
     剥离件 `ProductCreationService`（输入是**结构化明细**，不依赖 OCR）只存在于已删除的
     `refactor/decouple-creation-and-stock` 上，**留档在 `docs/branch-salvage-2026-10-06/`**。
   - 检查法：**"如果这条链路明天被拿掉，这个功能还活着吗？"**
2. **模块化**：**一个 service 只干一件事**。
   - 反例（已收敛）：`PurchaseWebhookService` 曾同时管报货 + 到货 + 建档 + 成本 + 库存 →
     建档/成本已拆出；库存写入**只经 `InventoryService`**。
   - 检查法：**"这段新逻辑属于哪个已有 service？"** —— 不要往"什么都管"的大类里继续加。
3. **配置先行**：阈值 / 开关 / 字段映射 / 行为编码**一律可配**，不写死在逻辑里。
   - 正例：`arrivalWaitPolicy`（等待阈值）· `reportBatchWindow`（归批窗口）·
     `PURCHASE_ARRIVAL_INTAKE_ENABLED`（入口开关）· `v1BitableSchema`（字段映射）·
     `STOCK_MOVEMENTS`（行为注册表）。
   - ⚠️ 开关**必须是显式布尔**：**不要**写 `process.env.X || fallback` —— `||` 会让"清空变量"
     回退到默认值，于是**关不掉**（`getEnv` 的表 ID 默认值就是这个形状）。
   - 检查法：**"这个数字/名字/开关，换一个值需要改代码吗？"** —— 需要改就是没做到。

### 生产表里的任何更改都要同步到代码（业务负责人 2026-10-05 明确）

> 「我这边在**生产表里面做的任何更改**，**你都要改**啊」

表改名 · 加字段 · 改选项 · 改行为编码 —— 都要同步 `v1BitableSchema`、相关映射与**用户可见文案**。
其中**字段映射最容易静默失效**：`v1:schema-check:*` 是唯一能提前拦住它的闸门，
所以**部署前必须跑闸门**。⚠️ 闸门按 **tableId** 校验字段名，**不校验表名** ——
所以**表改名闸门拦不住**，必须自己同步（代码里的 `tableName` 与出图/消息文案）。

### 时间字段：一律交给飞书自动生成（业务负责人 2026-10-06 明确）

> 她的原话：「**改完只有收款是代码的事情，其他都应该是飞书的自动字段！**」

- ⭐ **代码只允许写一个时间字段**：**`receivedAt`（「收款时间」）**
  —— 因为"**她点击确认的那一刻**"只有程序知道。
- 🔴 **其余时间字段，代码一行都不许写** ✗ —— 它们在生产表里是**飞书自动生成的字段**
  （「创建时间」/「更新时间」这类），由飞书在记录落库时自动填。
- ⚠️ **实现方式**：**删掉映射 ＋ 删掉写入点**（两个都要删，只删一个会留坑）：
  · 只删写入、留映射 → 那一列**永远空着**；
  · 只删映射、留写入 → 写库时抛「**未配置语义字段**」。
- ⭐ **例外只在真表上判断**：动手前**读生产真表**确认该列**在不在**、
  **是不是自动字段**（`type` 1001/1002 = 自动；普通 `DateTime` = 需要人工/代码填）。
  ⚠️ **别凭"她说都改成自动字段了"就一刀切**——
  2026-10-06 就有一列（「客户往来货款.发生时间」）她以为已改、实际还是普通日期列。
- ⚠️ **核查手段**：用**项目代码 / 官方 SDK 调只读接口**（`appTableField.list`），
  **不许用飞书 CLI**（见第 7 条）。

### ⚠️ 上面这条的【准确边界】（业务负责人 2026-10-06 明确纠正过）

> 她的原话：「**我说的是时间，时间字段维护上，除了收款时间，其他时间不用写，
> 我没说其他的字段**」

- 🔴 **这条规矩【只管「时间字段」】** ——
  **不要**推广成"所有飞书自动字段 / 所有非人工字段都不能映射"。
  - **管内**：`DateTime` / `创建时间` / `更新时间` 这类**时间**列。
  - **不管**：**自动编号**（如「库存流水号」`type=1005`）、公式、自动编号、人员等**其他类型**。
- ⚠️ **为什么要把边界写死**：2026-10-06 父代理把这条**扩大化**，
  据此判断"「库存流水号」（自动编号，`type=1005`）的映射违反规矩"——
  **那是错的**：它不在本条范围内，而且核过代码**从来没写过它**（只留了一个没人用的映射）。
- ⭐ **判断某一列该不该写，先看【类型】**：
  · `1001/1002`（创建/更新时间）→ **时间，不许写**；
  · `1005`（自动编号）→ **不是时间字段，本条不适用**（写不写是另一件事）；
  · `11`（人员）→ 由业务决定（例：库存流水的「操作人」**只由人工调整写**）。

## 合并与部署的时机纪律（2026-10-05 加，**必须遵守**）

> 🔴 **2026-10-07 追加（业务负责人口径，逐字）**：
> 「**我现在在做测试，所以禁止你和子代理自行部署，可以开 PR，
>  但是禁止你们自行部署，必须得到我的命令**」
>
> ⇒ **她在测试期间（以及任何时刻），本仓库的 Lead 与**所有子代理**一律不得自行部署**：
>    - 🔴 **不许** `deploy_run.sh` / `deploy_build.sh` / `pm2 restart` / 改线上 `.env` / 回滚；
>    - ⭐ **可以**改代码、跑 CI、开 PR（照常）；
>    - ⭐ **部署必须拿到她【当次】的明确命令**（沿用下面那条"授权一次性"的规则）；
>    - ⚠️ **派活时必须在 brief 里写明"严禁部署"** —— 子代理不会自动知道她在测试。

**合并可以自主，部署必须先问业务负责人一句：「现在能部署吗？」**
—— 拿到明确答复后才动手。

> 业务负责人 2026-10-06 明确：「**你可以合并，但是部署一定要来问问我**」。
> ⚠️ **这条是对上面更早说法（"合并前也要问"）的收窄**——**合并放开了，部署没有**。
> ⚠️ **授权是一次性的、不能复用**：她说"可以部署"只对**那一次**有效；
> 下一次部署**必须重新问**（2026-10-06 我拿她早前的一句"合并部署"当持续授权，在她的测试期间擅自动手，是错的）。

**为什么立这条规矩**：2026-10-05 出现了两次真实事故，都是**在她正在操作时重启了服务**：

- 一次打断了「供应商报单 → 解析 → 生成采购申请」的处理；
- 一次打断了「采购到货确认 → 逐条写入库存」的处理（31 条只完成 10 条）。

重启会**中断正在跑的业务写入**。虽然有幂等兜底（不会写重），但**她白等了一次** ——
而在"需要担责"的公司场景里，这类中断就是事故。所以现在就立规矩，不靠"我记得"。

### 配套的两条（同样必须遵守）

1. **部署前检查「最近几分钟有没有业务写入」**。
   ⚠️ **只看 `server/data/lark_mvp_tasks/*.json` 的 status 是不够的** ——
   「已经点了确认、正在逐条写入」这个阶段**不在那些状态里**，会漏判成"没有在跑"。
   判据应包含最近的：`inventory.change.applied` · `bitable.record.created` ·
   `bitable.record.updated` · `purchase.webhook.accepted` · `purchase.arrival.card.sent`。
2. **部署顺序不变**：**先跑部署闸门（`deploy_build.sh`），闸门绿了才重启**。
   闸门失败**绝不重启** —— 它会挡住"字段改名没同步"这类静默失效。

## 多代理并行时的写作用域纪律

同一个工作区里可能同时有多个代理干活（Lead + 子代理）。**并行之前必须先判断「要改的文件是否有交集」，判断人是派活的 Lead** —— 子代理彼此看不见对方在改什么，只有派活的人知道每个任务会碰哪些文件，所以这个判断**只能由派活者在派活之前做**，不能等撞了再补救。

规则：

1. **要改的文件没有交集** → 可以并行，但用 `git worktree add` 给每个代理**独立目录**，并明确各自的写作用域。
2. **会碰同一个文件** → **串行**（一个做完再开下一个）。宁可慢，不要打架。
3. 子代理只 `git add` **自己改的文件的显式路径**；不得 `stash`、`checkout .`、`reset --hard`，不得动别人的未提交改动。

为什么这三条都要：

- **worktree 只隔离目录，不隔离语义**：两个代理改同一个文件，仍会在合并时冲突，只是把"悄悄覆盖"变成"合并时爆炸"，问题还在。
- **实测教训（2026-10-05）**：两个子代理既没隔离目录、又都改 `purchaseWebhookService.js` —— 一个 `checkout` 分支把另一个**未提交的改动一起带走**；两批合并后测试挂 1 条，根因是**两条链路各加了一个同名方法**（`sendText`），JS 类体里后定义的**静默覆盖**先定义的，git 合并**不报冲突**。又花一轮才追到。
- **同名方法静默覆盖是同类隐患**：合并两个分支、或多人在同一个类里加方法时，**重复的方法名不会报错**。合并后跑一次全量测试，是唯一能拦住它的便宜手段。

## 常见问题和预防

- 后端日志是结构化 JSON（`src/utils/logger.js`）；飞书写入事件为 `bitable.record.*` / `inventory.change.*`，可据此过滤 PM2 日志。
- 确保 `.env` 正确配置再启动服务：缺 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` 或 `FEISHU_V1_BITABLE_APP_TOKEN` 会直接报错，不会回退到默认 Base。
- **采购入口的表 ID 从 schema 读**（`src/routes/larkEvents.js` 按 `V1_BITABLE_SCHEMA.tables.purchaseReport`
  / `.purchaseArrival` 的 `tableId` 分派），换 Base 时跟着环境变量走。**不要再写死表 ID**：
  写死的后果是"新增记录不触发任何事、也不报错"，现象只是"采购没反应"，属于最难查的静默失效。

### ⭐ 写入类日志必须带「关联键」（2026-10-07 业务负责人拍板「日志改下吧！」）

**起因**：一条销售在日志里被**劈成两半** —— `lark.sales.*` / `lark.card.*` 那半带 `task_id`，
而**真正写库**的那半（`sales.status.written` / `bitable.record.created` / `bitable.record.updated` /
`v1.sale.posted` / `inventory.change.applied`）**一个键都没有**。按 `task_id` grep 只看得见卡片，
看不到明细 / 收款 / 库存 —— 差点据此误判。

- ⭐ **做法**：写入类日志带 **`task_id` / `order_no`（`XSD-…`）/ `sales_entry_record_id`**
  里拿得到的那些。取用口只有一个：`src/utils/correlationFields.js`（**白名单**，
  非白名单键与空值一律不进日志）。详见
  `docs/log-correlation-and-stock-key-label-2026-10-07.md`。
- ⭐ **传递方式**：**尾部可选参数** `options.correlation`，从入口（`larkMvpService` /
  `salesThreadProgressService` / `secondDeliveryService`）逐层传到
  `V1BitableGateway.create/update`。网关层只**不透明地**把它合进日志，
  **不做任何业务查表/推导** —— 它连"销售"这个词都不认识。
- 🔴 **不塞进业务 `input`**：既有 `input` 形状一个字段都不许变（既有测试里那些逐字
  `deepEqual` 就是这条边界的哨兵）。
- 🔴 **不用 `AsyncLocalStorage`**（评估过，否决）：库存引擎有**跨请求重放**
  （`runForStock` / `resumePending`）与共享串行队列，从上下文读到的键会把**上一笔单**
  挂到**当前请求**的任务上 —— 那是"指向错的那一笔"，比"没有键"更坏。
  显式传参没有这个问题，而且测试直接可注入。
- ⭐ **采购链路同一天下半场已接**（2026-10-07）：键是 **`task_id`**（报货/退货
  `purchase_supplier-report_…`、到货核对 `arrival_reconcile_…`）· **`batch_no`**
  （表单填的 `202610071` / 自动的 `BH-YYYYMMDD-NNNN`）· **`purchase_report_record_id`**
  （「供应商对接」那条记录）· **`purchase_arrival_record_id`**（「采购到货」那条记录）。
  **拿不到就不传、不许编**（批次级动作只给 `task_id` ＋ `batch_no`；到货链路没有报单记录 id）。
  改动落在 `purchaseWebhookService` ＋ `purchaseArrivalConversationService.createArrivalRecord`
  （「采购到货」那一行的新增写在后者），下游一行没改。
  键清单 / 写库动作清单 / 验收标准 / 真实日志样例见
  `docs/log-correlation-and-stock-key-label-2026-10-07.md` **第六、七节**。

### ⭐ 「库存键」两种写法并列（同一天）

- `stock_key` = `商品record_id|尺码|所属状态`（**内部键，原值不许动**：串行队列、本地任务、
  幂等判据都用它）；`stock_key_label` = `货号|颜色|类别|尺码`（飞书「库存键」公式算好的那串）。
- `stock_key_label` **抄**自**这次已经读到的**「实时库存」记录上的「库存键」列 ⇒
  **零额外请求、零漂移**；抄不到时只给 `stock_key_label_source: 'unavailable'`，**不猜**。

## 与业务负责人的协作纪律（2026-10-06 起）

> 本节的十条是 2026-10-06 与业务负责人当面定下的**协作与工程纪律**——
> 讲的是「怎么协作、怎么写代码、怎么测试、怎么汇报」。
> 它**不是业务口径**：销售 / 采购 / 退货怎么算账属于《业务规范》（另一份飞书文档），
> **不要写进本文件**。

### 1. ⭐ 测试 Base 与生产 Base 的边界（**最重要的一条，她反复强调过**）

- **测试 Base —— `FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个（见 `.env.example`）：可以随便写，不用问她。**
  它就是为测试准备的——**测试数据不用删**；已按生产对齐（**表名一致，`table_id` 不同**）。
- **生产 Base —— `FEISHU_V1_BITABLE_APP_TOKEN` 指向的那个（见 `.env.example`）：🔴 只读，一个字都不许写。**
- ⚠️ **两个 Base 的 token 一律只从 `.env` 读，不在本文件写明文**；⚠️ **本地 `.env` 可能把
  `FEISHU_V1_BITABLE_APP_TOKEN` 也指向测试 Base 以避免误写生产**——
  **判断"哪张是生产"要认线上取值，不要只凭本地这个变量的当前值反推。**
- ⇒ **凡需要写表来验证的，一律走测试 Base**——**不要问她「测试表能不能写」**
  （这条问过两次，她纠正过）。
- **为什么**：她对**生产数据的正确性零容忍**；而测试表本来就是拿来造的。

### 2. ⭐ 测试的流程（她定的）

- **先写「按我们的链路应该实现的效果」（= 验收标准）** → 再跑 → **逐条对照**。
- 达不到 → **如实说「未达标」+ 差在哪 + 建议怎么改**。
- **为什么**：不先写预期，就跑不出「对不对」。

### 3. ⭐⭐ 约定必须落文件

> 2026-10-06 她的原话：「咱们定好的事情，我会提醒你要写入的，然后**你自己也要有意识**。
> 不然……**跟一个失忆的人一样**。」

- 凡「**我们定好的事**」→ **立刻写进 `AGENTS.md` 或 `docs/`**，**不靠记忆**。
- **先写再做别的**（顺序反过来就会忘）；写完**告诉她「我记在哪了」**。
- 她也会提醒——**但自己要有意识**。
- **为什么**：上下文会被压缩，对话里的约定会丢；**文件不会**。

### 4. 🔴 部署前必须先问她

> 原话：「**严禁你自主部署**」。

- 部署 / 重启 / 改线上 `.env` / 回滚——**都算**；**她明确授权才能动**。
- 部署前还要检查「**最近有没有在跑的业务写入**」——⚠️ **不只查任务状态**，
  判据见上面「合并与部署的时机纪律」的配套第 1 条。
- **为什么**：这是对线上真实系统的副作用，打断她正在跑的业务写入就是事故。

### 5. ⚠️ 改动 `app.js` 顶部的 require 顺序 → 必须「真启动一次」验证

- **2026-10-06 真实事故**：`dotenv.config()` 被放到业务 require **之后** →
  `config/v1BitableSchema.js` 的 `tableId` 在 `process.env` 还空着时**模块级求值** →
  「尺码管理」「其他配品」两张**没有硬编码兜底**的表 `tableId = ''` →
  请求打到 `.../tables//records` → 飞书回 **404 纯文本** → 退货 / 销售**静默失败**。
- **教训**：单测与 `v1:schema-check` 都是**独立进程**（自己按正确顺序读 dotenv），
  **天然抓不到这个进程内加载顺序 bug** → **必须真启动一次**。
- 相关加固已在：`v1BitableGateway` 空 `tableId` **当场抛错** ＋ 顺序回归用例
  （`server/test/appDotenvLoadOrder.test.js`）。
- **为什么**：顺序约束的失败方式不是报错，是**静默失效**；只有真启动一次才看得见。

### 6. 向她汇报时间一律用上海时间（+8）

- 服务器日志与 JSON 是 **UTC**——**直接念数字会让她对不上**（2026-10-06 发生过）。
- 汇报 / 复述时间前**先换算成 +8**，或**两个都给**。
- **为什么**：她按上海时间安排现场，时间对不上就没法一起排查。

### 7. 🔴 自测链路的四条硬纪律（她 2026-10-06 明确）

> 2026-10-06 她的原话：「**你需要确保你走的是项目代码，直接加载项目源码**，
> **严禁你使用飞书 CLI**，**只能在测试表里做测试**，**严禁用生产表**」

- ⭐ **测试必须走「项目代码」——直接加载项目源码**
  - 意思是：**调项目自己的入口函数**（例：`PurchaseWebhookService.accept('supplier-report')`
    —— **这就是生产上"表变更事件"走的同一条路**），**让项目的真实链路跑**
    （解析 → 出单 → 库存 → 发群）。
  - ⚠️ **不是**"用 CLI 手工拼出一样的结果" —— 那**测不到项目代码**，
    项目链路的 bug 会被完全掩盖。
  - ⭐ **可自证**：跑完看**日志事件**（`purchase.return.posted` / `inventory.change.applied` /
    `v1.sale.posted`）—— **这些是项目代码打出来的，CLI 打不出来**。
- 🔴 **严禁使用飞书 CLI**（**包括"读表验证结果"**）
  - ⚠️ 她 2026-10-06 明确说「**严禁你使用飞书 CLI**」——**按字面遵守**。
  - ⇒ **验证也要用项目代码**：用自测脚本自己的**只读子命令**
    （`server/scripts/e2e-run.mjs inspect`）或**让脚本把结果打印出来**。
  - **为什么**：CLI 能"绕过项目代码直接改表"，一旦用它，就分不清
    "**项目代码跑通了**"和"**CLI 帮我把表改了**"——这正是她担心的。
- 🔴 **测试只能在「测试 Base」里做 —— 严禁用生产 Base**
  - 测试 Base = `FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个（见 `.env.example`）
  - 生产 Base = `FEISHU_V1_BITABLE_APP_TOKEN` 指向的那个：🔴 **只读，一个字都不许写**
  - **测试记录不用删**
  - ⭐ **代码级兜底已存在**：`server/scripts/e2e-run.mjs` 里写死了
    "**app_token 等于生产 → 直接拒绝运行**"（核过它还在）。
- ⭐ **测试应用的凭证由业务负责人自己配到环境变量**
  - **代码一律从环境变量读**（`.env` 里的 `FEISHU_V1_E2E_*` / `LARK_*` 等）
  - 🔴 **不许把任何 token / secret 硬编码进源码**
    （⚠️ **已知违规**：`server/scripts/e2e-run.mjs` / `ws-poke-event.cjs` / `ws-subscribe.cjs`
      里硬编码了生产 token **当闸门** —— **待改**：应改成**从 `.env` 读**或**指纹比对**，
      **不是删掉闸门**。已列入待办）

### 8. 🔴 本机禁止配置生产凭证与生产多维表格（**第 1 条的"物理层"加固**）

> 2026-10-06 她的原话：「所以，**禁止在本机上配置与生产环境有关的凭证或者多维表格**，
> 这样的话**你就不会误操作了**」

- ⭐ **本机（开发 / 自测环境）的 `.env` 只放「测试侧」的东西**
  - **放**：**测试应用的凭证**（`LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`）
    ＋ **测试 Base**（`FEISHU_V1_E2E_TEST_APP_TOKEN`，以及指向测试 Base 的各 `FEISHU_V1_*_TABLE_ID`）。
  - 🔴 **不放**：**生产应用的凭证**（`LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET`）·
    **生产 Base 的 token**。
- 🔴 **为什么**：**「物理上够不着」比「靠记住」可靠** ——
  本机没有生产凭证 → **误操作在生产上是不可能发生的**，
  而不是「靠 agent 记得不要去写生产」。
- ⚠️ **现状（2026-10-06 父代理核实过，写进来当基线）**：
  - ⚠️ **本机 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` 现在指向【测试应用】**
    （`cli_aa3341b397389cd4`），**不是生产应用** ——
    因为项目代码**只读 `LARK_AGENT_*` 这两个变量名**，本地要跑自测
    （`server/scripts/e2e-run.mjs` 等）**就必须这样填**。
    ⇒ **这不违反第 8 条**：第 8 条禁的是**生产**凭证，**测试应用的凭证属于"测试侧"**。
    ⚠️ **看到 `LARK_AGENT_*` 非空时，先确认它的值是不是测试应用**，
    **不要直接推断"本机配了生产凭证"**（2026-10-06 就有人据此误判过）。
  - ⚠️ 本机 `FEISHU_V1_BITABLE_APP_TOKEN` **当前指向的是测试 Base**
    （与 `FEISHU_V1_E2E_TEST_APP_TOKEN` 同值）。
  - ⇒ ⚠️ **因此「哪一个才是生产」必须认【线上服务器的取值】**，
    **不能凭本机这个变量名反推**（`FEISHU_V1_BITABLE_APP_TOKEN` 在本机不代表生产）。
- ⭐ **配套（双保险）**：测试脚本里的「**app_token 等于生产 → 拒绝运行**」闸门**继续保留**
  —— 物理够不着（本机没有生产凭证）＋ 代码级闸门（脚本自己拦），**两道**。
- ⚠️ **这条也适用于「临时 / 一次性的脚本」**：临时脚本**不许**为了图快把生产凭证写进本机
  （要跑生产侧的事，一律**在服务器上**做，不在本机）。

### 9. 🔴 跑任何自测 / 验证之前 → 必须先把主工作区对齐到最新 main

> 2026-10-06 真实事故：我的工作流是**在【独立 worktree】里改代码** → push 分支 → 开 PR →
> 合并到 `origin/main` → 部署，所以**「线上」一直是最新的**；
> 但**我的【主工作区】一直没 `git pull`**，停在旧提交、**落后 `origin/main` 17 个提交**。

- ⭐ **动手之前先对齐**：`git fetch origin --prune && git pull --ff-only origin main`。
- ⭐ **判据**：`git rev-list --count HEAD..origin/main` **必须为 0**。
  ⚠️ **不为 0 就先把上面的 pull 跑完再看** —— **不许带着旧代码直接跑测试**。
- 🔴 **为什么**：**自测脚本要在【主工作区】跑**——例：`server/scripts/e2e-run.mjs` 要读 `.env`，
  而 `.env` 是 **gitignored** 的、**只在主工作区**（独立 worktree 里没有）。
  于是**代码（worktree 里最新的）与测试（主工作区里的旧代码）会分家**，
  **用旧代码跑出来的结论是【假的】**，而且**误导方向恰好是最坏的那个**：
  - 我看到的图是「四列平铺」，就以为**「按货号分组」功能坏了**；
  - 实际是**本机代码根本没有那个改动** —— `git pull` 之后图就对了。
  ⇒ **差点把「功能没问题」误报成 bug**。
- ⚠️ **配套**：**改代码在 worktree，跑测试在主工作区，两边必须显式同步**
  —— **worktree 隔离的是目录，不隔离「代码版本」**。
- ⭐ **建议的自检**：跑测试前先打印一次 `git rev-parse --short HEAD`
  ＋ `git rev-list --count HEAD..origin/main` —— **0 才对**。

### 10. ⭐ 测试的输入数据从哪来（她 2026-10-06 明确，说了两轮）

> 第一轮她的原话：「**你不要自己编造假数据，就用我真实的数据去写就行了**，
> 其实你如果要用假数据的话，**你要跟我说一下**。
> 因为有时候你编的那个假数据是**不合理的** —— **一双鞋哪有 2.5 双呀**？」
>
> 第二轮补充：「我刚才说了，你用**我今天在供应商数据表里的一些数据**就行，
> **不管是采购申请还是采购退货的**。
> **你可以自己编数据，但前提是你要跟我说一声**，
> 我**需要验证一下你这些数据的合理性**哈。」

- ⭐ **首选：用【她真实的数据】** —— **她今天（或近期）在「供应商数据表」里写的数据**；
  **采购申请**与**采购退货**都算。
  - ⭐ **怎么拿**：从**生产表【只读】取**「**数量说明**」原文
    ＋ 对应的**货品 / 尺码 / 供应商**。
  - ⚠️ **在服务器上跑、走项目代码、一个字都不写** —— 见第 8 条
    （本机不配生产凭证，所以**要生产数据就在服务器上取**）。
- 🔴 **要【自己编】数据时 → 必须先跟她说一声**
  - **说明「依据什么编的」** → **让她验证合理性** → **她点头才能用**。
  - ⚠️ **不许「编完了直接拿去跑、再拿结果给她看」** —— 那样**她只能在结果上挑错，
    没法在输入上把关**。
- ⚠️ **不许编【不合业务常理】的数据** —— **她亲口举的例子**：
  **「一双鞋哪有 2.5 双呀」**。
  - **同理**：**报货不会报 0 双**；**「实际到货不会为 0」**（**她 2026-10-06 说过的**）。
- ⚠️ **为什么**：**编的数据不符合业务 → 测出来的「通过」是【假通过】**，
  还会**把她带偏**、**白费她的时间**。
- ⚠️ **附带**：取真实数据时**若含客户姓名 / 电话之类的 → 要脱敏**。

### 11. 🔴 三个"我踩过"的坑（2026-10-06 加，**都真实发生过**）

#### ① 🔴 口径不要靠口头转述 → 要落成文件

- **事故**：我给业务负责人的"建议选项"里写了「未扣减 / 部分扣减 / 已扣减 / 扣减失败」；
  她后来明确纠正「**就按我写入的**」（表里其实是 未写入 / 部分写入 / 已写入 / 写入失败）；
  **但我派给子代理的指令里还是那个错版本** → 子代理按错的做 →
  代码差点往表里写「已扣减」这个**不存在的选项** →
  **飞书会自动新建选项** → 表里一半"写入"一半"扣减"，且"扣减"那组永远没人写。
- ⭐ **做法**：**值域 / 字段名 / 选项清单这类口径，一律先落进 `docs/` 或配置文件，再引用** ——
  **不靠对话记忆转述**。
- ⭐ **自检**：「这条口径**在文件里**吗，还是只在我的记忆里？」

#### ② 🔴 不要在【别人正在用的 worktree】里 commit

- **事故**：我在一个子代理正在工作的 worktree 里 `git add -A && git commit` →
  **把它未提交的改动一起打包进去了**。（这次侥幸没丢，但 commit message 完全没提它的改动，
  事后要靠 diff 才确认"我的改动在里面"。）
- ⭐ **做法**：
  - **commit 前先 `git status`，确认"这些改动都是我做的"**；
  - **同一 worktree 里【只能有一个写入者】** —— 这是**派活的人**要在派活前保证的。
- ⚠️ 与本文件「多代理并行时的写作用域纪律」同源：**worktree 只隔离目录，不隔离语义。**

#### ③ 🔴 她删/改表字段 → 闸门不一定红，但代码里的映射一定红

- **事实**：她把「确认状态（旧）」「订单状态」**整列删掉**（飞书删字段 = 删值，不可恢复）；
  而 `v1BitableSchema` 里还指着它们 → `v1:schema-check` **会报「缺少 V1 字段」**。
  ⚠️ **但【测试 Base 还带着那两列】→ 在测试 Base 上跑闸门是【绿的】。**
- ⇒ ⭐ **测试 Base 绿 ≠ 生产绿**：闸门只做「schema 里的名字 ⊆ 表里的名字」，
  **多出来的列它看不见**。所以**测试 Base 与生产形状不一致时，闸门结论只在"缺字段"方向可信**。
- ⭐ **做法**：
  - **她在生产表删/改字段后，立刻【只读核生产真表】，再同步 `v1BitableSchema`**；
  - **部署前必须在服务器上跑 `v1:schema-check:all`**（那才对着生产）。

### 12. 🔴 又三个"我踩过"的坑（2026-10-06 晚加，**都是同一天内重复犯的**）

#### ① 🔴 派活前必须列【文件清单】并检查与在跑任务的重叠

- **事故**：我先后派了两个任务做**重叠**的事（"售后回话题" 与 "三处一起做"），
  它们各自建了 worktree、**在 7 个文件上重叠**（`afterSalesService` / `saleLookupService` /
  `larkMvpService` / `afterSalesFlowService` / 配置 / 测试）。
- ⭐ **做法**：**派活前把「本任务会碰哪些文件」写下来，与"当前所有在跑任务"的清单比对**；
  **有交集 → 串行**（这是 `AGENTS.md`《多代理并行时的写作用域纪律》的落地动作）。
- ⭐ **自检**：「这个任务和**现在在跑的**任何一个，会不会碰同一个文件？」

#### ② 🔴 代理回报"偏离口径"后 → **立刻检查所有在跑任务的 brief 里有没有同一条错**

- **事故**：我把值域口径传错（"扣减" vs "写入"），她纠正我、我也认了错；
  但**下一条派活模板里那条错还在** → 同一个错又被传给了新的代理。
  同一天第二次：她说"售后不影响原单"，我认了错，**但另一份 brief 里
  "顺手补上写原销售状态"仍在** → 代理照做，改了业务逻辑。
- ⭐ **做法**：**一发现自己传错了口径，第一件事不是改代码，而是
  「把所有在跑/待跑任务的 brief 里那条错找出来、改掉或撤回」**。
- ⭐ **自检**：「我认的这个错，**还在别的任务书里活着**吗？」

#### ③ 🔴 查代理进度要看【全部 worktree 目录】，别只看一个地方

- **事故**：我连续多轮说"代理还没建工作目录 / 没干活"，实际它们**在
  `仓库/.local/<name>` 里干活**（沙箱不允许在仓库外建目录时会放这里），
  而我只看了 `/private/tmp/*` 和 `.local` 的前几个条目 → **误报"没干活"**，
  还据此重复派活。
- ⭐ **做法**：`git worktree list` **是唯一可信的来源**（它列全部 worktree）；
  查进度用它，**别靠 `ls` 某个目录**。
- ⭐ **自检**：**「我用 `git worktree list` 看的吗？」**

### 13. ⭐ 查飞书文档：用 `curl`，**不要 `web_search`**（业务负责人 2026-10-06 明确）

> 她的原话：「**做飞书的时候你就别搜了，你就用那个 curl 就行了**」

- ⭐ **飞书相关的事，一律 `curl` 拉官方文档** —— **不用 `web_search`**（二手、可能过期）。
- ⭐ **拿纯文本的办法：URL 末尾加 `.md?lang=zh-CN`**
  ```bash
  curl -sS -L "https://open.feishu.cn/document/<路径>.md?lang=zh-CN"
  ```
  - 返回 `Content-Type: text/markdown`，**正文完整**（实测 200 / 4KB 左右）。
  - ⚠️ **不带 `.md` 的页面是 JS 渲染的** —— curl 只能拿到 ~7KB 框架与标题，**拿不到正文**。
  - ⚠️ 所以「curl 拿不到内容」**不是网络问题，是路径/后缀不对**；路径猜不中会 404（**26 字节空回复**）。
  - `curl` 在本机**能访问 open.feishu.cn**（`web_fetch` 曾报"非公网 IP"，**curl 没这个问题**）。

- ⭐ **已实查过、以后要用的两条**（2026-10-06）：

  **① 网页应用配置**（`/document/home/integrating-web-apps-in-5-minutes/step-4-configure-the-home-page-address.md`）
  1. 开发者后台 → **添加应用能力** → 选 **网页应用** → 添加能力；
  2. **网页配置**里填 **桌面端主页 / 移动端主页**（示例是内网地址，⚠️ **正式上线要公网地址**）；
  3. **安全设置 → H5 可信域名** 里加 `域名:端口号`（**这一步极易漏，漏了打不开**）。

  **② AppLink：打开端内 web-view**（`/document/common-capabilities/applink-protocol/supported-protocol/open-the-web-view-in-feishu-to-access-the-specified-url.md`）
  ```
  https://applink.feishu.cn/client/web_url/open?mode=<mode>&url=<encodeURIComponent 后的网址>
  ```
  - `mode`（必填）：`sidebar-semi` 侧边栏 · `window` 独立窗口 · `appCenter` 标签页（需飞书 7.5+）；
  - `url`（必填）：**必须 encodeURIComponent**（含特殊字符则先百分号编码再 Encode）；
  - ⭐ **飞书官方「AppLink 生成和诊断工具」**：`https://webview.feishu.cn/applinktool?enter_from=weburl`
    —— **别再手写 AppLink，用这个工具生成 + 诊断**。
  - ⚠️ 「聊天框 + 菜单」的**桌面端跳转链接要 AppLink 格式**；填普通网址会报
    「**请确认所填写的链接格式与指向的应用是否正确**」。

### 14. 🔴 任务收尾流程（业务负责人 2026-10-06 定，**每一步都不能省**）

> 她的原话：
> 「**如果你合了 PR 之后，你的那个分支就应该是删除，然后你相关的 worktree 应该也是要删除，
>  并且那个 worktree 的代码修改应该是同步到我们本地的主工作区的。**」

**她在 2026-10-06 晚再次追问「这些你是不是都校验过了」—— 当时我只写了纪律、没有执行。**
⇒ **这三步是【每次收尾必做】，不是"有空再做"。**

**完整链路（六步，按顺序）**：
1. 在【独立 worktree】里改代码（**不在主工作区改**）
2. push 分支 → 开 PR
3. 合并 PR
4. **删分支**
   - 远端：GitHub 已开「自动删除已合并分支」（`delete_branch_on_merge=true`，2026-10-06 设置）
     ⚠️ **只在【合并成功那一刻】生效** —— 卡住的 PR 不会删，要自己确认
   - 本地：`git branch -d <branch>`
5. **删 worktree** —— `git worktree remove <path>`（⚠️ **不用 `--force`**；失败就跳过并记录）
6. **主工作区 `git pull` 同步** —— `git fetch origin --prune && git pull --ff-only origin main`
   - 判据：`git rev-list --count HEAD..origin/main` **必须为 0**

**⭐ 顺序很重要**：**被 worktree 占着的分支删不掉** → **先清 worktree，再删分支**。

**为什么第 6 步不能省**：
- 自测要跑在【主工作区】（`.env` 只在那儿），**代码不同步 → 用旧代码跑出的结论是【假的】**（见第 9 条）
- 2026-10-06 实测：主工作区曾落后 `origin/main` **2 个提交**，是**自查**发现的

**为什么第 4/5 步不能省**（2026-10-06 的教训）：
- 远端曾堆到 **106 个分支**、本地 **105 个 worktree**、本地分支 **116 个**
- 根因：**工作流只加不减** —— 每个任务建 worktree + 建分支，但**合并后从不清理**；
  GitHub 默认不删已合并分支；worktree 占着分支 → 分支删不掉 → 越攒越多
- 一次清理的结果：**远端 107 → 22**、**worktree 105 → 30**、**本地分支 116 → 31**

**🔴 清理时的安全底线**：
- 🔴 **有【未提交改动】的 worktree 不清**
- 🔴 **占着【未合并分支】的 worktree / branch 不清**
- ⭐ 删前逐个验证：`git merge-base --is-ancestor origin/<b> origin/main` 必须通过
- ⭐ `git cherry origin/main <b>` 出现 `-`（有独立提交）→ **不删**
- ⭐ 全程**不用 `--force`、不 `reset`、不 `stash`**
- ⭐ 主工作区清完 `git status --porcelain` 应与开始时**完全一致**

**⭐ 收尾后的自检（三问）**：
1. `git ls-remote --heads origin | grep <我的分支>` → **应为空**（远端分支删了）
2. `git worktree list` → **我建的那个目录不应再出现**
3. `git rev-list --count HEAD..origin/main` → **应为 0**（主工作区同步了）

### 15. 🔴 必须走 CI，不许 `--admin` 绕过（业务负责人 2026-10-06 明确）

> 她的原话：「**你今天犯了一个严重的错误：你没有进 CI，以后要进 CI**」

- ⭐ **本仓库有必须的 CI**：GitHub Actions 工作流 **「server tests」**（job 名 `test`）＋ **CodeQL**。
  **CI 不绿 → PR 合不了**（报错：`Required status check "test" is failing`）。
- 🔴 **合并前必须看 CI**：`gh pr checks <PR号>` / `gh pr view <PR号> --json mergeStateStatus`
  → **只有 `CLEAN` 才能合**。
- 🔴 **禁止 `gh pr merge --admin`**（除非业务负责人当次明确同意）——
  它等于**绕过 CI 闸门**。
- ⚠️ **「BLOCKED」多半不是 GitHub 抽风，是 CI 在拦** —— 先看 `gh pr checks`，别猜。
- ⭐ **本地测试通过 ≠ CI 通过**（2026-10-06 实测）：代理在**主工作区（旧代码）**跑全绿，
  而在**它自己的分支**上跑是红的。⇒ 跑测试前先确认**代码版本**（`git rev-parse --short HEAD`）。
- ⚠️ 本机 `gh` 看 CI 日志需要可写缓存：
  `export XDG_CACHE_HOME=/tmp/ghcache GH_CACHE_DIR=/tmp/ghcache`（否则报 operation not permitted）。

### 16. ⭐ 两条业务口径已拍板（业务负责人 2026-10-06）

**(1) 收款方式：用户【会主动说】—— 系统不猜、也不设默认。**

她的原话（**这是对我先前理解错的纠正，务必按这个**）：
> 「**不会，用户会说到交易方式的！**」
> 「如果涉及到收钱的话，**用户会直接告诉收款方式的**。比方说，
>  **定金通过微信收到，然后尾款通过微信收到，或者尾款通过现金收到**」

⇒ **规则**：
- ⭐ **用户说了方式 → 就用他说的**（可能一单里**每一笔方式不同**：定金微信、尾款现金）。
- 🔴 **不要"按默认方式收口"** —— 那是我理解错的版本，**别实现它**。
- ⚠️ **但仍要修那个真 bug**：现在光说「已完毕」时
  `salesThreadProgressService.applyComplete` 只回问一句就 `return`，
  **钱货都不动**，上层却记成 `progress_applied`（**看起来成功了**）。两处都要改：
  ① **状态如实**：什么都没写就不要记 `progress_applied`（用 `progress_asking` 之类）；
  ② **先把"货那一半"做掉**（未交付→已交付 + 扣库存），再就"钱"回问一句——
     这是安全网（她说这个场景不会发生，但发生了也不能既不做又报成功）。

**(2) 退款方式：写【她实际说的方式】，不沿用原单。**
她确认：「钱退现金」→ 记录里的「交易方式」就写**现金**（`afterSalesService.settleCash`
现在有意"方式取原单"、会写成微信，**要改**）。若她没说方式，再按现有逻辑处理并注释说明。

### 17. 🔴 结论是「没发生 / 没写 / 没扣」→ 必须去【事实表或流水】核过再说（业务负责人 2026-10-07 拍板）

> **凡是结论是「某件事没发生 / 没写 / 没扣」—— 必须去【事实表或流水】核过再说；
>  只凭一行日志或一个字段，只能说「我还没查到这一步」，不许下结论。**

- **起因（真实误判）**：2026-10-07 有人看到 `v1.sale.posted` 里的 `inventory_applied: false`，
  读成了「**整单没扣库存**」，并据此向她汇报"库存没扣"——**错了**。
  那个字段的**真实含义**只是「**落表这一步**不动库存」；库存在**交付那一步**
  （`SalesDeliveryService`）才扣。事后核**库存流水**才发现早就扣了
  （14:33:35「销售减少 40码×1」，14:33:53 才写「库存状态 = 已写入」）。
- ⭐ **做法**（同一件事的两半）：
  ① **证据**：负向结论只能来自**事实表或流水**（「库存流水」/「实时库存」/「销售明细」…），
     以及**正向证据日志**（例：`sales.inventory.applied`）；看日志时**先看它的范围**——
     这条说的是**哪一步**、有没有 `step` 之类的限定词。
  ② **措辞**：还没核过时只能说「**我还没查到这一步**」，**不许**说"没发生 / 没写 / 没扣"。
- ⭐ **配套的代码侧改法（同日已落地，见 `fix/sale-stock-log-clarity`）**：
  日志字段名一律**带范围**（`step: 'posting'` ＋ `inventory_applied_by_this_step: false`
  ＋ `inventory_planned: true` ＋ `inventory_step: 'after_delivery'`），
  并在库存**真的动完**时补一条**正向证据** `sales.inventory.applied`
  （含 `ledger_ids` / `behaviors`）——"没扣"这个结论从此有地方可核。
