# 文档索引

本目录是 `feishu-retail-ops` 的知识库入口。根目录 `README.md` 面向人，`AGENTS.md` 面向智能代理；这里说明每一份文档现在是什么状态，避免把历史资料当成当前架构。

> **命名说明**：`box2bitable`（以及 `Box2Bitable`、`box2base`、`box to base` 等写法）是本项目**旧名称**；当前仓库名与项目名为 `feishu-retail-ops`，产品名「零售数智经营助手」，邯美部署名称「邯美数智经营工作台」。历史文档中的旧名按当时事实保留，不做替换；PM2 进程名 `box2bitable-server` 与服务器目录 `/opt/box2bitable` 属于运行兼容名称，一并保留，迁移方式见 `feishu-v1-operations.md`。

## 1. 现行事实（Current）

描述已经实现并正在运行的行为。

| 文档 | 内容 |
|---|---|
| [handoff.md](handoff.md) | 交接说明：当前状态、硬约束、幂等现状、待办、采购改造方案与下一步建议 |
| [handoff-douyin-content-co-creation.md](handoff-douyin-content-co-creation.md) | **抖音共创交接**（2026-10-04 新增协作线）：家族生意背景、既有飞书资产索引、能力边界与第一步请求 |
| [project-progress.md](project-progress.md) | 项目进展、已确认决策与后续路线 |
| [feishu-v1-operations.md](feishu-v1-operations.md) | 飞书 V1 的运行与运维手册（部署、日志、排查） |
| [module-boundaries.md](module-boundaries.md) | 模块边界与职责划分 |
| [idempotency-contract.md](idempotency-contract.md) | 采购与库存的远端幂等契约 |
| [inventory-size-reference-contract.md](inventory-size-reference-contract.md) | 库存与尺码关联字段契约 |
| [workbench-query-contract.md](workbench-query-contract.md) | 工作台查询接口契约 |
| [sales-line-plan.md](sales-line-plan.md) | 销售线的推进计划与判据 |

## 2. 架构决策记录（Architecture Decision Records）

现行架构决策记录，回答「为什么系统被设计成这样」，与第 1 节的现状描述互补，**不是历史文档**。治理规则（何时写 ADR、Status、Evidence 标注原则）见 [adr/README.md](adr/README.md)。

| 文档 | 内容 |
|---|---|
| [adr/README.md](adr/README.md) | ADR 治理规则与索引 |
| [adr/ADR-001-separate-ai-interpretation-from-deterministic-business-execution.md](adr/ADR-001-separate-ai-interpretation-from-deterministic-business-execution.md) | AI 负责理解与结构化，确定性后端负责正式业务执行 |
| [adr/ADR-002-robot-entry-triage-and-decoupling.md](adr/ADR-002-robot-entry-triage-and-decoupling.md) | 机器人入口三分与解耦；状态以表为准；不做自主智能体 |
| [adr/ADR-003-ai-role-and-future-host-boundary.md](adr/ADR-003-ai-role-and-future-host-boundary.md) | AI 的定位是「不确定性收口器」；未来宿主只能接管无副作用的域（决策三为未来方向 · 当前不实施） |

## 3. 现行设计参考（Design Baseline + 状态说明）

方案推演与当前实现混在同一份文档里，正文不能整体当作现状。**引用前先读文档顶部的状态说明**。

| 文档 | 性质 |
|---|---|
| [lark-agent-technical-design.md](lark-agent-technical-design.md) | 飞书 V1 原始设计基线；顶部标注了 Current implementation / Original design baseline / Future plan 的分区 |

## 4. 历史文档（Historical）

以下文档记录的是当时的真实情况，正文保持原样，只加了状态说明。它们**不代表当前架构**。

| 文档 | 时期 |
|---|---|
| [prd.md](prd.md) | 原 `box2bitable` 微信小程序 PRD（已退役） |
| [tech-arch.md](tech-arch.md) | 微信小程序时期的技术架构（服务端视角） |
| [technical.md](technical.md) | 微信小程序时期的接口与页面规划 |
| [archive/legacy-agent-guide.md](archive/legacy-agent-guide.md) | 原根目录 `agent.md`，微信小程序时期的 Agent 指南 |
| [archive/legacy-trae/](archive/legacy-trae/) | 原 `.trae/documents/`，Trae 时期的 PRD / 技术架构草稿 |
| [archive/legacy-wechat-retirement.md](archive/legacy-wechat-retirement.md) | Legacy WeChat 退役记录（2026-10-01） |

当前仓库级 Agent 入口以根目录 [AGENTS.md](../AGENTS.md) 为准；`agent.md` 已不再是第二套入口。

## 5. 设计资产

| 资产 | 说明 |
|---|---|
| [prototypes/工作台页面架构原型.html](prototypes/工作台页面架构原型.html) | 工作台页面架构原型（静态 HTML，直接浏览器打开） |
