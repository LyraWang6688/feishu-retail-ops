# feishu-retail-ops 项目规范

## 项目概述

`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。它以飞书机器人、飞书网页应用和飞书多维表格为基础，为线下零售与小型企业提供销售、采购、库存和资金联动能力。

当前 V1 的销售录入入口是飞书私聊机器人（自然语言文字）；采购有**一条**由飞书多维表格记录变更事件触发的链路：**供应商报单**新增 → 解析「数量说明」文字**直接生成采购申请（免确认）**，再按供应商渲染 PNG **发到采购群**（`PURCHASE_CHAT_ID`，带 @所有人）并把图写回「采购申请单」附件。机器人**不接收**采购图片，收到非文字消息会明确回绝并提示使用采购表单。「采购到货」表仍然存在，但它现在**只是一张数据容器**（到货日 / 验收原话 / 确认状态 / 验收人 / 图片），往里面新增记录**不触发任何事**——原来那条「拍照 → 识别鞋盒/到货单 → 与采购申请比对 → 确认后入库」的链路已于 2026-10-05 整体退场（业务负责人删掉了「类型」「识别状态」「识别失败原因」三个字段，并决定改成**纯对话驱动**）。销售经用户确认后由后端统一入账；**采购申请是唯一的例外**——报单记录本身就是产品负责人的输入，产品负责人明确要求免确认（理由与红线边界见 `PurchaseWebhookService.publishPurchaseRequest` 的注释）。飞书网页工作台已经实现并存于本仓库（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），用于销售订单的后续收款、交付与工作台查询，不承担数据录入。原微信小程序链路已于 2026-10-01 正式退役并从代码库整体移除，不是当前入口，也没有开关可以重新启用它。

**群聊入口（2026-10-05 起）**：机器人也接收**群聊**消息，准入判据有**两条，且必须先判 `thread_id`**（判据位置：`server/src/services/larkMvpService.js` 的群聊分支，`origin/main` 第 372–402 行）：

- **消息在话题里（`thread_id` 有值）→ 一律处理，不要求 @ 机器人**（第 386–387 行；真机实测：她在话题里发「你好 小来财」时 `mentions` 为空，事件照样推给我们——话题本身就是"冲着机器人来的"的判据）。
- **主群消息（`thread_id` 为空）→ 才要求 `message.mentions` 里有机器人自己的 open_id**（`LARK_BOT_OPEN_ID`，第 390–401 行）。没配 `LARK_BOT_OPEN_ID` 时**一条主群消息都不处理**。

⚠️ 顺序不能反：先读 `mentions` 会把话题里没 @ 的消息当成"主群没 @"丢掉——这正是真机测出来的 bug。不处理 → **完全静默、零远端调用**（群里日常聊天绝不能被触发）；处理 → 加 `OneSecond` 表情确认（群里**不回**文字，避免刷屏），再走采购定位链路（`PurchaseBatchLocator.resolve`，`server/src/services/purchaseBatchLocator.js` 第 148 行起），**按顺序**：

1. **`thread_id`** → `findByThreadId`（第 98 行；最稳——她在话题里后续发的消息不一定还引用着机器人那条）
2. **`message.parent_id`**（引用采购单那条消息）→ `findByMessageId` 反查本地映射（第 88 行）
3. **正文里的批次号 `BH-YYYYMMDD-NNNN`** → `findByBatchNo`（第 134 行；**只有既没话题也没引用时**才走这条）
4. **都没有 → 回一句问清楚**（第 209 行），**绝不猜"最近一笔"**

⚠️ 两个"认不出"：话题里但这条话题没记过映射、又没引用 → 直接说认不出，**不拿正文号去猜**（第 183 行）；引用到的不是我们发的消息（或映射丢了）→ 同样认不出（第 177 行）。采购单与群里那条消息的 `message_id ↔ 批次`（以及 `thread_id`）映射写在本地任务记录 `server/data/purchase_group_messages/`，**不写业务表**。私聊的既有闸门与行为完全不变。

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
> （孤儿能力，等「对话到货」接）。未合并分支 `refactor/decouple-creation-and-stock`
> 正在把后者剥成 `services/productCreationService.js`。

## 技术栈

- **当前入口**：
  - 飞书机器人私聊：销售自然语言录入
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
| `POST /api/lark/events`                                                                                               | 飞书事件回调（私聊消息、**群聊 @ 机器人**、卡片动作）   |
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
- `LARK_BOT_OPEN_ID` - 机器人自己的 open_id（形如 `ou_xxx`），判「群里有没有 @ 机器人」的唯一依据。**没有默认值**：留空时群聊消息一律不处理（并打 `lark.group.bot_open_id_missing` 警告），私聊不受影响
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
   - 反例（已修）：**新品建档 + 写成本**曾绑在**拍照识别**链路上 →
     已剥离成 `ProductCreationService`（输入是**结构化明细**，不依赖 OCR）。
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

## 合并与部署的时机纪律（2026-10-05 加，**必须遵守**）

**合并前、部署前，都必须先问业务负责人一句：「你现在在做测试吗？」**
—— 拿到明确答复后才动手。

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

## 与业务负责人的协作纪律（2026-10-06 起）

> 本节的六条是 2026-10-06 与业务负责人当面定下的**协作与工程纪律**——
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
