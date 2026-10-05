# feishu-retail-ops 项目规范

## 项目概述

`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。它以飞书机器人、飞书网页应用和飞书多维表格为基础，为线下零售与小型企业提供销售、采购、库存和资金联动能力。

当前 V1 的销售录入入口是飞书私聊机器人（自然语言文字）；采购有**两条**由飞书多维表格记录变更事件触发的链路：**供应商报单**新增 → 解析「数量说明」文字**直接生成采购申请（免确认）**，再按供应商渲染 PNG 发给报单人、并把图写回「采购申请单」附件；**采购到货**新增 → 识别记录里的鞋盒图片并与该批次的采购申请比对，**经用户确认后**入库。机器人**不接收**采购图片，收到非文字消息会明确回绝并提示使用采购表单。销售与采购到货都经用户确认后由后端统一入账；**采购申请是唯一的例外**——报单记录本身就是产品负责人的输入，产品负责人明确要求免确认（理由与红线边界见 `PurchaseWebhookService.publishPurchaseRequest` 的注释）。飞书网页工作台已经实现并存于本仓库（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），用于销售订单的后续收款、交付与工作台查询，不承担数据录入。原微信小程序链路已于 2026-10-01 正式退役并从代码库整体移除，不是当前入口，也没有开关可以重新启用它。

> **采购链路的历史**：曾存在一条"机器人收采购图片 → 写「采购批次」表 → `PurchasePostingService`"
> 的旧链路（`acceptPurchaseImage` / `finishPurchaseImages` / `processPurchaseTask` /
> `purchaseDraftBuilder` / `purchasePostingService` / schema 里的 `purchaseBatch`）。
> 它在 2026-10-04 已**整体删除**——这些方法此前已无任何调用方。采购只走上面两条表变更链路。

## 技术栈

- **当前入口**：
  - 飞书机器人私聊：销售自然语言录入
  - 飞书多维表格记录变更事件：供应商报单（文字）与采购到货（鞋盒图片）两条链路
  - 飞书网页工作台（已实现）：销售订单后续收款、交付与工作台查询
- **后端**：Node.js + Express (>=20)
- **部署方式**：腾讯云轻量应用服务器 + Nginx + PM2
- **AI 模型**：DeepSeek。拆成**两组独立配置**——文字解析（销售录单、采购数量说明）与图片识别（鞋盒），
  因为两者的选型理由不同；两组都不配置就直接报错，**不跨供应商兜底**
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
| `POST /api/lark/events`                                                                                               | 飞书事件回调（私聊消息、卡片动作）               |
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
- `VISION_LLM_API_KEY` / `VISION_LLM_BASE_URL` / `VISION_LLM_MODEL` - **图片**模型（鞋盒识别），必须支持视觉
- `API_KEY` - 非飞书 `/api` 接口的 `x-api-key` 鉴权

> 两组模型**都没有默认值、也不跨供应商兜底**（原先缺省会回退到 `ARK_*` 豆包，已取消）：
> 哪一组缺配置，就那一组在调用时报错，不静默改用另一家——否则会造成「以为在用 A、实际在用 B」。
> 两组可分别指向不同供应商（想换回火山方舟就把该组三个值填成方舟地址 + 推理接入点 ID）。
> 取值由 `src/config/llmModels.js` 解析；`ARK_API_KEY` / `ARK_MODEL_ENDPOINT` / `ARK_API_BASE_URL`
> **已无任何读取点**，不要据此排查模型问题。

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
