# feishu-retail-ops 项目规范

## 项目概述
`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。它以飞书机器人、飞书网页应用和飞书多维表格为基础，为线下零售与小型企业提供销售、采购、库存和资金联动能力。

当前 V1 以飞书私聊机器人为唯一继续开发的录入入口：销售使用自然语言，采购到货使用图片，经确认后由后端统一入账。飞书网页工作台已经实现并存于本仓库（`GET /workbench`、`/api/workbench/*`、`server/public/workbench/`），用于销售订单的后续收款、交付与工作台查询，不承担数据录入。微信小程序属于冻结的遗留链路，暂时保留但不再新增功能，也不能成为飞书 V1 的依赖。

## 技术栈
- **当前入口**：
  - 飞书机器人私聊：销售自然语言录入、采购到货图片录入
  - 飞书网页工作台（已实现）：销售订单后续收款、交付与工作台查询
- **遗留前端**：微信小程序原生开发（Frozen Legacy，不再新增功能，不是 Feishu V1 依赖）
- **后端**：Node.js + Express (>=20)
- **部署方式**：腾讯云轻量应用服务器 + Nginx + PM2
- **AI 模型**：豆包 (Doubao) 大模型 API
- **表格服务**：飞书多维表格 (Feishu Bitable) API

## 目录结构
```
.
├── AGENTS.md           # 仓库级 Agent 入口（本文件）
├── README.md           # 人的入口
├── docs/               # 项目文档
│   ├── README.md       # 文档索引（现行 / 历史）
│   ├── archive/        # 历史文档归档（原 agent.md、原 .trae 文档）
│   └── prototypes/     # 设计原型
├── server/             # 后端 Express 代码
│   ├── src/
│   │   ├── config/       # 表格、模块与行为配置
│   │   ├── controllers/  # 控制器（工作台）
│   │   ├── infrastructure/ # 任务存储、串行队列、幂等
│   │   ├── routes/       # 路由（飞书事件、工作台、遗留微信）
│   │   ├── services/     # 业务逻辑（AI、飞书、销售、采购、库存）
│   │   └── utils/        # 工具类
│   ├── public/workbench/ # 网页工作台静态资源
│   ├── scripts/         # 部署、运维与校验脚本
│   └── package.json
├── miniprogram/        # 微信小程序前端代码（Frozen Legacy）
│   ├── pages/          # 页面
│   ├── utils/          # 工具函数
│   └── app.json
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

| 入口 | 说明 |
|---|---|
| `POST /api/lark/events` | 飞书事件回调（私聊消息、卡片动作） |
| `GET /api/lark/events/health` | 事件回调健康检查 |
| `GET /api/auth/feishu/me`、`GET /api/auth/feishu/start`、`GET /api/auth/feishu/callback`、`POST /api/auth/feishu/logout` | 工作台飞书身份认证 |
| `GET /api/workbench/sales/today` | 今日销售 |
| `GET /api/workbench/sales/orders` | 订单列表 |
| `POST /api/workbench/sales/payments` | 补记收款 |
| `POST /api/workbench/sales/deliveries` | 交付并扣减库存 |
| `GET /api/workbench/inventory` | 库存查询 |
| `GET /api/workbench/purchase/requests`、`GET /api/workbench/purchase/arrivals` | 采购申请与到货查询 |
| `GET /workbench` | 网页工作台静态页面（`GET /` 同样回落到工作台首页） |
| `GET /health` | 健康检查（含版本与 commit） |
| 其余 `/api/*` | 由 `API_KEY`（`x-api-key` 头）中间件保护 |

- **Legacy / Removed from current V1**：`/api/recognition`、`/api/sync`、`/api/query`。对应 route 文件已在 V1 删除，只剩遗留微信链路中的痕迹，**不是**当前 V1 的主要 API，不要据此排查线上问题。
- **部署脚本**：`server/scripts/deploy_build.sh` / `server/scripts/deploy_run.sh`

### 微信小程序 (miniprogram/)
> Frozen Legacy：已冻结，不新增功能，也不是 Feishu V1 的依赖或开发入口。

- **入口配置**：`app.json`
- **主页面**：
  - `pages/home/home` - 首页
  - `pages/entry/entry` - 数据录入
  - `pages/review/review` - 复核
  - `pages/query/query` - 查询

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
- `ARK_API_KEY` / `ARK_MODEL_ENDPOINT` / `ARK_API_BASE_URL` - 豆包大模型
- `API_KEY` - 非飞书 `/api` 接口的 `x-api-key` 鉴权

**网页工作台身份认证（Workbench Auth）**
- `LARK_WEB_AUTH_ENABLED` / `LARK_WEB_REDIRECT_URI` / `LARK_WEB_SESSION_SECRET` / `WORKBENCH_ALLOWED_OPEN_IDS`

**迁移脚本与 E2E 专用**
- `FEISHU_TARGET_ENV` / `FEISHU_ALLOW_PRODUCTION_WRITE` - 写库脚本的环境闸门
- `FEISHU_V1_E2E_TEST_APP_TOKEN` / `FEISHU_V1_E2E_PRODUCT_RECORD_ID` / `FEISHU_V1_E2E_ITEM_NO` / `FEISHU_V1_E2E_SIZE`

**遗留 / 可选（当前 V1 链路不读取）**
- `WX_APP_ID` / `WX_APP_SECRET` - 仅存在于 `.env.example`，当前代码无任何引用，不是 Feishu V1 必需配置
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`、`FEISHU_BITABLE_APP_TOKEN`、`FEISHU_BITABLE_*_TABLE_ID`、`FEISHU_DEBUG` / `FEISHU_DEBUG_SHOW_TOKENS` - 只被遗留微信与旧销售写入链路读取
- `ENABLE_LEGACY_WECHAT` / `ENABLE_CORS` / `NODE_ENV` / `PORT` / `UPLOAD_*` / `APP_*` - 运行与遗留开关

### 小程序开发
> 以下仅适用于冻结的遗留小程序，不是 Feishu V1 的开发入口。

使用微信开发者工具打开 `miniprogram/` 目录，并勾选"不校验合法域名、web-view（业务域名）、TLS版本以及HTTPS证书"。

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

## 小程序样式规范

> 适用对象是冻结的 `miniprogram/`（Frozen Legacy）；飞书 V1 与网页工作台不使用这套样式变量。

### 设计系统变量 (`app.wxss`)
- 主色调：`#3370FF`（蓝）、`#34C759`（绿）、`#FF3B30`（红）
- 中性色：文字 `#1F2329`、次要 `#646A73`、占位 `#8F959E`
- 间距系统：`8rpx / 12rpx / 16rpx / 20rpx / 24rpx / 30rpx`
- 圆角：`8rpx / 12rpx / 16rpx / 20rpx / 24rpx`
- 阴影：`0 4rpx 16rpx rgba(0,0,0,0.06)`（卡片）、渐变阴影（按钮）

### 页面样式文件
| 页面 | 文件 |
|------|------|
| 首页 | `pages/home/home.wxss` |
| 录入选择 | `pages/entry/entry.wxss` |
| 复核 | `pages/review/review.wxss` |
| 查询 | `pages/query/query.wxss` |

## 常见问题和预防
- 后端日志是结构化 JSON（`src/utils/logger.js`）；飞书写入事件为 `bitable.record.*` / `inventory.change.*`，可据此过滤 PM2 日志。
- 确保 `.env` 正确配置再启动服务：缺 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` 或 `FEISHU_V1_BITABLE_APP_TOKEN` 会直接报错，不会回退到默认 Base。
