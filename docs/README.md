# 文档索引

本目录是 `feishu-retail-ops` 的知识库入口。根目录 `README.md` 面向人，`AGENTS.md` 面向智能代理；这里说明每一份文档现在是什么状态，避免把历史资料当成当前架构。

## 1. 现行事实（Current）

描述已经实现并正在运行的行为。

| 文档 | 内容 |
|---|---|
| [project-progress.md](project-progress.md) | 项目进展、已确认决策与后续路线 |
| [feishu-v1-operations.md](feishu-v1-operations.md) | 飞书 V1 的运行与运维手册（部署、日志、排查） |
| [module-boundaries.md](module-boundaries.md) | 模块边界与职责划分 |
| [idempotency-contract.md](idempotency-contract.md) | 采购与库存的远端幂等契约 |
| [inventory-size-reference-contract.md](inventory-size-reference-contract.md) | 库存与尺码关联字段契约 |
| [workbench-query-contract.md](workbench-query-contract.md) | 工作台查询接口契约 |
| [sales-line-plan.md](sales-line-plan.md) | 销售线的推进计划与判据 |

## 2. 现行设计参考（Design Baseline + 状态说明）

方案推演与当前实现混在同一份文档里，正文不能整体当作现状。**引用前先读文档顶部的状态说明**。

| 文档 | 性质 |
|---|---|
| [lark-agent-technical-design.md](lark-agent-technical-design.md) | 飞书 V1 原始设计基线；顶部标注了 Current implementation / Original design baseline / Future plan 的分区 |

## 3. 历史文档（Historical）

以下文档记录的是当时的真实情况，正文保持原样，只加了状态说明。它们**不代表当前架构**。

| 文档 | 时期 |
|---|---|
| [prd.md](prd.md) | 原 `box2bitable` 微信小程序 PRD（冻结） |
| [tech-arch.md](tech-arch.md) | 微信小程序时期的技术架构（服务端视角） |
| [technical.md](technical.md) | 微信小程序时期的接口与页面规划 |
| [archive/legacy-agent-guide.md](archive/legacy-agent-guide.md) | 原根目录 `agent.md`，微信小程序时期的 Agent 指南 |
| [archive/legacy-trae/](archive/legacy-trae/) | 原 `.trae/documents/`，Trae 时期的 PRD / 技术架构草稿 |

当前仓库级 Agent 入口以根目录 [AGENTS.md](../AGENTS.md) 为准；`agent.md` 已不再是第二套入口。

## 4. 设计资产

| 资产 | 说明 |
|---|---|
| [prototypes/工作台页面架构原型.html](prototypes/工作台页面架构原型.html) | 工作台页面架构原型（静态 HTML，直接浏览器打开） |
