# feishu-retail-ops 项目规范

## 项目概述
`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。它以飞书机器人、飞书网页应用和飞书多维表格为基础，为线下零售与小型企业提供销售、采购、库存和资金联动能力。

当前 V1 以飞书私聊机器人为唯一继续开发的录入入口：销售使用自然语言，采购到货使用图片，经确认后由后端统一入账。微信小程序属于冻结的遗留链路，暂时保留但不再新增功能，也不能成为飞书 V1 的依赖。

## 技术栈
- **当前入口**：飞书机器人私聊；后续增加飞书网页工作台
- **遗留前端**：微信小程序原生开发（冻结）
- **后端**：Node.js + Express (>=20)
- **部署方式**：腾讯云轻量应用服务器 + Nginx + PM2
- **AI 模型**：豆包 (Doubao) 大模型 API
- **表格服务**：飞书多维表格 (Feishu Bitable) API

## 目录结构
```
.
├── docs/               # 项目文档 (PRD, 技术方案, 接口说明)
├── server/             # 后端 Express 代码
│   ├── src/
│   │   ├── controllers/ # 控制器
│   │   ├── routes/      # 路由
│   │   ├── services/    # 业务逻辑 (AI, 飞书)
│   │   └── utils/       # 工具类
│   ├── scripts/         # 部署脚本
│   └── package.json
├── miniprogram/        # 微信小程序前端代码
│   ├── pages/          # 页面
│   ├── utils/          # 工具函数
│   └── app.json
├── uploads/            # 服务端临时上传目录（运行时自动创建）
├── .env.example        # 环境变量模板
└── README.md
```

## 关键入口 / 核心模块

### 后端服务 (server/)
- **入口文件**：`src/app.js`
- **运行命令**：`npm start` (生产) / `npm run dev` (开发)
- **主要 API**：
  - `/api/recognition` - 图片识别
  - `/api/sync` - 数据同步到飞书
  - `/api/query` - 库存查询
- **部署脚本**：`server/scripts/deploy_build.sh` / `server/scripts/deploy_run.sh`

### 微信小程序 (miniprogram/)
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
参考 `.env.example`，需要配置：
- `ARK_*` - 豆包大模型配置
- `FEISHU_*` - 飞书多维表格配置
- `WX_*` - 微信小程序配置

### 小程序开发
使用微信开发者工具打开 `miniprogram/` 目录，并勾选"不校验合法域名、web-view（业务域名）、TLS版本以及HTTPS证书"。

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
- 飞书图片写入排查：设置 `FEISHU_DEBUG=true` 输出调试日志
- 确保 `.env` 文件正确配置再启动服务
