# Architecture Decision Records（ADR）

> `feishu-retail-ops` 的架构决策记录。本目录只回答「为什么系统被设计成这样」，不回答「怎么使用」。

## 什么是 ADR

一条 ADR 记录一个**已经做出的、影响系统结构的决策**，连同它当时的上下文、候选方案、取舍和后果。

ADR 回答的是「为什么是这样」。它不是：

- 教程或 API 文档；
- 操作手册或排查指南；
- 完整项目历史；
- Roadmap。

同类信息请放到对应的地方：系统当前行为看 [项目进展与迭代路线](../project-progress.md) 与 [模块边界](../module-boundaries.md)；怎么部署和排查看 [飞书 V1 运行与排查](../feishu-v1-operations.md)；仓库级 Agent 入口看 [AGENTS.md](../../AGENTS.md)。每份文档的现行 / 历史状态见 [文档索引](../README.md)。

## 什么时候写 ADR

满足以下任一条件就考虑写：

- **核心技术路线选择**：在多个候选架构或技术路线中做出取舍。
- **Source of Truth 变化**：某个事实的权威来源发生迁移（例如从页面计算改为后端服务计算）。
- **模块边界 / 责任边界变化**：谁负责校验、谁负责写入发生变化。
- **数据一致性设计**：幂等、去重、并发串行、写入顺序。
- **安全 / 可靠性关键决策**：涉及资金、库存、权限、审计的约束。
- **长期影响多个模块**：后续功能会被这个决定约束。
- **未来 Agent 很可能重新质疑或逆转的决定**：需要一个可引用的结论来避免反复推翻。

以下情况不写 ADR：

- Bug 修复；
- UI / 文案调整；
- 小字段增删；
- 常规重构；
- 依赖升级。

## Status

只使用以下四个状态：

| Status | 含义 |
| --- | --- |
| `Proposed` | 已提出，尚未定稿或尚未实施 |
| `Accepted` | 已采纳，当前有效 |
| `Superseded` | 已被后续 ADR 取代 |
| `Deprecated` | 仍然存在但不再推荐，且暂无替代方案 |

## 历史原则

- Accepted 的 ADR **不因后来认知变化而直接删除或改写结论**。
- 如果新决策推翻旧决策：**新建一条 ADR**，同时把旧 ADR 的 Status 改为 `Superseded by ADR-XXX`。旧 ADR 正文保留原样，便于回溯当时的判断依据。
- 只在措辞、链接、错别字层面做维护性修正，不改动已记录的 Decision。

## Evidence 原则

ADR 里的每条事实主张都要能追溯到证据，并显式区分三类：

| 标注 | 含义 |
| --- | --- |
| `[Repo]` | Repository Fact：当前公开仓库的代码、文件、commit、PR 能独立证明 |
| `[Owner]` | Human Owner Context：由 Human Owner 提供的背景判断，GitHub 无法独立证明 |
| Uncertainty | 时间、顺序或「是否真的运行过」无法从仓库独立证明，必须写明边界 |

不允许为了让 ADR 看起来完整而补故事：无法证明的时间只写范围，无法证明曾经运行过的方案只写「设计过 / 拒绝过」，并注明证据来源。Evidence 只保留证明力最强的少数几条，不把整个仓库塞进来。

## Index

| ADR | 标题 | Status | Date |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-separate-ai-interpretation-from-deterministic-business-execution.md) | Separate AI Interpretation from Deterministic Business Execution | Accepted | 2026-09-24 |
