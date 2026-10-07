# 文档索引

本目录是 `feishu-retail-ops` 的知识库入口。根目录 `README.md` 面向人，`AGENTS.md` 面向智能代理；这里说明每一份文档现在是什么状态，避免把历史资料当成当前架构。

> **命名说明**：`box2bitable`（以及 `Box2Bitable`、`box2base`、`box to base` 等写法）是本项目**旧名称**；当前仓库名与项目名为 `feishu-retail-ops`，产品名「零售数智经营助手」，邯美部署名称「邯美数智经营工作台」。历史文档中的旧名按当时事实保留，不做替换；PM2 进程名 `box2bitable-server` 与服务器目录 `/opt/box2bitable` 属于运行兼容名称，一并保留，迁移方式见 `feishu-v1-operations.md`。

## 1. 现行事实（Current）

描述已经实现并正在运行的行为，以及**业务负责人已定、作为当前权威口径的业务规则**（后者会在文档顶部标注实现状态：口径已定 ≠ 代码已实现）。表内 `arrival-conversation-reconcile-2026-10-06.md` 是 2026-10-06 当天实现并已落测试的业务规格；它的前一版 `arrival-conversation-flow.md` 同日作废。

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
| [arrival-conversation-reconcile-2026-10-06.md](arrival-conversation-reconcile-2026-10-06.md) | 采购到货「群话题对话式核对」：业务负责人 2026-10-06 当天口述的**权威口径**与验收标准（**已实现**） |
| [private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md) | 🔴 **私聊链路已移除**（业务负责人 2026-10-07：「以后私聊这条链路我们就没有了」）：入口统一到【群聊 + 话题】。含**验收标准**（A 入口 / B 群聊回归 / C 发送出口 / D 配置 / E 门禁）、四条开关的取值规则、以及"怎么临时恢复私聊"。承接 2026-10-06 的切除盘清 [private-chat-excision-todo.md](private-chat-excision-todo.md) |
| [purchase-intake-batch-spec.md](purchase-intake-batch-spec.md) | ⭐ **采购提交的归批口径（业务口径 · 权威 · 已定）**：一次提交 = 一个行为（采购申请 或 采购退货）+ N 个编号（**= N 个不同货品**）→ **只出一张图**；⭐ **一个货品的多个尺码勾在同一条记录上，记录之间不合并数量**。⚠️ **口径已定，但代码尚未按此实现**（仍在用时间窗归批）；改造方案见第 3 节 |
| [arrival-conversation-flow.md](arrival-conversation-flow.md) | ⚠️ **已作废**（同日被上一份取代）：早一版规格；正文按当时事实保留，**不要再按它实施** |

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
| [purchase-intake-batch-plan-2026-10-06.md](purchase-intake-batch-plan-2026-10-06.md) | ⚠️ **方案（未实施）**：把归批判据从「猜时间窗」改成「**这一包进了链路的条目，处理动作都跑完就发图**」（**到齐就发 · 两层划分**）＋**读不到就重试 3 次（1 秒 → 2 秒）**＋配置先行；❌ **不设超时兜底、不考虑拆包**（她 2026-10-06 明确）。**给业务负责人看的那一版**。配套口径见第 1 节 `purchase-intake-batch-spec.md` |

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
| [handoff-notes-2026-10-06/README.md](handoff-notes-2026-10-06/README.md) | 交接笔记归档（2026-10-06 清理）：原 7 个 worktree 根目录下的 18 份未跟踪 `.HANDOFF-*.md`，全是 **2026-10-05** 多代理并行期间父代理写给子代理的裁决/纠正/叫停便条；**历史记录，不是当前口径** |
| [branch-salvage-2026-10-06.md](branch-salvage-2026-10-06.md) | 分支清仓留档（2026-10-06 清理）：除 `main` 外 14 条远端分支**逐条的删除判据与取代证据**（含 tip SHA）；⭐ 以及唯一一条"真有价值但没进 main"的 `refactor/decouple-creation-and-stock` 的**原件留档**（`branch-salvage-2026-10-06/`：剥出来的 `productCreationService.js` 原文 + 全量 patch） |

当前仓库级 Agent 入口以根目录 [AGENTS.md](../AGENTS.md) 为准；`agent.md` 已不再是第二套入口。

## 5. 设计资产

| 资产 | 说明 |
|---|---|
| [prototypes/工作台页面架构原型.html](prototypes/工作台页面架构原型.html) | 工作台页面架构原型（静态 HTML，直接浏览器打开） |
