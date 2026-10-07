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
| [arrival-conversation-reconcile-2026-10-06.md](arrival-conversation-reconcile-2026-10-06.md) | 采购到货「群话题对话式核对」：业务负责人 2026-10-06 当天口述的**权威口径**与验收标准（**已实现**）。⚠️ 其中「实际到货不会为 0 / 不为实际为 0 写规则」一条已被 2026-10-07 的口径**收窄**（见下一行） |
| [arrival-zero-arrived-rule-2026-10-07.md](arrival-zero-arrived-rule-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：「某个尺码实际到 0 双」是**正常情况** —— 该行不入库、**不阻断整单**；「真对不上明细」仍走原路径。**已实现**，验收标准与逐条对照见 [reports/arrival-zero-actual-2026-10-07.md](reports/arrival-zero-actual-2026-10-07.md) |
| [private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md) | 🔴 **私聊链路已移除**（业务负责人 2026-10-07：「以后私聊这条链路我们就没有了」）：入口统一到【群聊 + 话题】；方式是她拍板的 **ⓐ：代码里一行私聊都不留、测试全部迁到群聊入口**（**没有开关**）。含**验收标准**（A 入口 / B 群聊回归 / C 发送出口 / D 历史用例迁移 / E 门禁）、逐条实现对照、以及"怎么恢复私聊"。配套拍板见 [private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)；承接 2026-10-06 的切除盘清 [private-chat-excision-todo.md](private-chat-excision-todo.md) |
| [product-info-gaps-card-move-2026-10-07.md](product-info-gaps-card-move-2026-10-07.md) | 🔴 **口径（权威 · 2026-10-07，⚠️ 当天她的口径改过两次，本文件是【最新版】）**：「补货品信息」段落**从确认卡片挪到【点确认之后的卡片】= ①「销售订单处理中」卡 ＋ ② 绿色「销售订单已入账」终态卡**（先"两边都放"(#220) → 她纠正「**不是，是只放在2上！**」(#221) → 她再改口「**中间态也应该有提示**」⇒ 处理中卡加回来）。**确认卡片（点之前）与取消 / 待修正始终不带**。起因（她的原话）：「我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了」。含**两次口径变更的时间线（每句原话）**、验收标准、终态卡分支覆盖表、配置键（`PRODUCT_INFO_GAPS_*`）与"不多读一次表"的边界 |
| [sales-confirm-processing-card-visible-2026-10-07.md](sales-confirm-processing-card-visible-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：点「确认」后**那一次立即更新**的卡片必须一眼看出"已经点上了、正在写入"（业务负责人拍板的 **ⓐ**：醒目标题 ＋ 明细区变灰/加"处理中"提示；**不要**分阶段进度）。含验收标准、配置键（`SALES_PROCESSING_CARD_*`）与"只改显示"的边界 |
| [pending-deal-push-sections-2026-10-07.md](pending-deal-push-sections-2026-10-07.md) | ⚠️ **分区标题与判据已被 [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) 取代**（现为【预定】/【现货待收】、按**履约状态**分区，不再按交易类型编码）。其余（行格式 / 深链 / 按天去重 / 置顶）仍然有效。原文：⭐ **口径（权威 · 2026-10-07）**：每天 9 点的「待处理单推送」**按【预付 / 未付】分区**（业务负责人逐字：「只需要这些信息，按照预付和未付分区」），每条 = 单号 + 【预付/未付】 + **货号+尺码** + 待收金额 + 深链；**不加售出时间**。分区顺序/标题/行格式全在 `config/pendingDealPush`（`PENDING_DEAL_PUSH_BLOCK_ORDER` / `*_TEMPLATE` 等）。含验收标准、逐条对照、改后的推送样例与"额外读表"的代价 |

| [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) | 🔴🔴 **口径（权威 · 2026-10-07；取代同日更早的「按类型跳过库存解析」「候选只推在售」两刀）**：**交易类型 = 实时库存里有没有这一双**（有货 → `SALE_CASH` 现货；没货 → `SALE_PREPAID` **预定**）—— 她逐字：「库存里有这双 → 现货（当场交付 + 扣库存）；库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）」「⭐ 所以：**每次都必须查库存**（这就是判据本身）」；**资金与类型彻底解耦**（她逐字：「【资金 = 只听你怎么说】（与类型完全无关）」）—— 全款 / 部分 / 没付 / 定金四种资金形态 × 现货 / 预定两种类型都能配；**「未付」不再是一种交易类型**（她从「行为管理」删掉了那条记录）⇒ 候选源改成「**预定（未交付）** ＋ **现货但钱没结清**」、分区标题改成【预定】/【现货待收】；**候选给全部颜色**（撤掉“只推在售”，保留「有货 / 无货」标注 —— 它现在 = 现货 / 预定的预告）；卡片**三段分开说**（类型 · 履约状态 · 收款情况）。含验收标准 AC-1～AC-9、六处关键 diff、`SALE_UNPAID`/「未付」处置清单、**先红后绿证据**（含一次“把判据改成恒现货”的变异验证）、历史影响面的**只读核查**结果与未核到的部分 |
| [sales-missing-info-wording-2026-10-07.md](sales-missing-info-wording-2026-10-07.md) | 🔴 **文案（2026-10-07 真机）**：销售「销售信息还缺…」那句追问**不再漏代码标识符**（`items[0].actual_amount` / `payments[0].method`）、**一次只说一件事**（一件事一行，不再用「；」串成一段）、**每条都给具体动作**（如「带定金的单一次只能记一双，请把这两双分开发送～」）；起因是业务负责人收到那条后只问了一句「**这个提醒是什么意思？**」。⚠️ **判据一个字没动**（`missing_fields` 逐字不变、仍 `needs_info`、仍不发卡片、仍不入账）；文案全部进 `config/salesMissingInfoText`（`SALES_MISSING_INFO_*`）。含**逐句溯源**（哪一句出自哪个文件哪一行）、验收标准 AC-1～AC-8 与逐条对照。⚠️ **同日稍后已按【上游已变】同步过一次**（PR #234 合入 `2d852c3` 之后：那句「定金单暂只支持一条明细…」的生产者被**删除**、换成了 #234 **新增**的「哪一件是付了定金的那件…」，且缺项 index 从 `payments[0]` 变 `payments[1]`）—— ⭐ **当前有效事实见该文档第 14 节**（冲突逐行解法、新句子→新文案**逐字**对照表、映射表 ⇄ 形状守卫一致性证据、AC-S1～AC-S10 逐条对照） |
| [behavior-code-lookup-and-arrival-failure-feedback-2026-10-07.md](behavior-code-lookup-and-arrival-failure-feedback-2026-10-07.md) | ⭐ **修复（2026-10-07）**：①「行为管理」查找改为**按行为编码**（她把中文名「采购入库」改成了「入库」，按名找就永远抛错 ⇒ 点「是」永远入不了库）；②点到货卡片**失败必须有可见反馈**（把那张卡 patch 成红色终态 ＋ 回一句到话题；改前失败只弹 toast、卡片一动不动）。含验收标准 A1–A8 / B1–B11、同类排查逐条结论、与任务书口径的一处**不一致**（`PURCHASE_IN` ≠ 注册表里的 `STOCK_PURCHASE_INCREASE`） |
| [sales-product-registration-guard-2026-10-07.md](sales-product-registration-guard-2026-10-07.md) | 🔴 **判据（权威 · 2026-10-07）**：**A（读「货品信息」）之后**加一道「**这个货号到底有没有建档**」的判据 —— **三种交易类型都走**（她逐字：「三种交易类型，在看完货品信息之后，如果在货架上没有找到，都应该给到这个提示，而不是说等到 B」）。**没建档就拦**（`needs_info` / 不发卡片 / 回一句可配文案）与「**缺资料不拦**」（齐备公式说缺字段 → 只进终态卡那段「补货品信息」）**判据分开**。含验收标准 AC-1～AC-8、判据的**正证据**口径（读不到「货品信息」就不下结论）、配置键（`SALES_PRODUCT_REGISTRATION_*`）与正向证据日志 |
| [purchase-intake-batch-spec.md](purchase-intake-batch-spec.md) | ⭐ **采购提交的归批口径（业务口径 · 权威 · 已定）**：一次提交 = 一个行为（采购申请 或 采购退货）+ N 个编号（**= N 个不同货品**）→ **只出一张图**；⭐ **一个货品的多个尺码勾在同一条记录上，记录之间不合并数量**。⚠️ **口径已定，但代码尚未按此实现**（仍在用时间窗归批）；改造方案见第 3 节 |
| [sales-multi-line-trade-type-2026-10-07.md](sales-multi-line-trade-type-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：放开「**定金单只支持一条明细**」—— 一张单**允许多明细、不拆单**（她逐字：「**这就是一个人买的呀**」）；「交易类型」**按明细行定**（每行单选；⚠️ 取值已被 [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) 收成**现货 / 预定**两种、且**由库存决定**），**销售主表多选**（去重后的多个，例：现货+预付）。「跑不跑 B（实时库存）/ 颜色候选范围 / 交不交付」的判据**取值从"整单"改成"逐明细"**，来源仍是 `config/salesTradeTypePolicy` / `config/salesMovements`。含**判据位置**（`doubaoService.normalizeSalesResult` 那条整单护栏）、验收标准 AC-1～AC-14、真机原话的逐字段解析结果、**先红后绿证据**、单类型单"逐字不变"哨兵，以及已知的下游缺口（待处理单推送的分区仍取整单第一个类型） |
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
| [archive/sales-daily-report-retirement.md](archive/sales-daily-report-retirement.md) | ⚠️ **销售战报退役记录（2026-10-07）**：业务负责人逐字「连代码一起删」⇒ 服务 / 卡片 / 配置 / `app.js` 接线 / 用例 / `SALES_DAILY_REPORT_*` 整体删除；含**共用件（`shanghaiDailyScheduler` 等）为什么没跟着删**与**验收标准 + 逐条对照** |
| [sales-daily-report-push-2026-10-06.md](sales-daily-report-push-2026-10-06.md) | ⚠️ **已退役（2026-10-07）**：当初的战报口径（两个数字怎么算、9/12/15/18/21 ＋ 22 点、过期不补推）；**正文按当时事实保留，不要再按它实施** |
| [sales-report-card-design-2026-10-06.md](sales-report-card-design-2026-10-06.md) | ⚠️ **已退役（2026-10-07）**：当初战报卡片的样式口径（两个大数字块、不写计算逻辑）；卡片本身已删 |
| [handoff-notes-2026-10-06/README.md](handoff-notes-2026-10-06/README.md) | 交接笔记归档（2026-10-06 清理）：原 7 个 worktree 根目录下的 18 份未跟踪 `.HANDOFF-*.md`，全是 **2026-10-05** 多代理并行期间父代理写给子代理的裁决/纠正/叫停便条；**历史记录，不是当前口径** |
| [branch-salvage-2026-10-06.md](branch-salvage-2026-10-06.md) | 分支清仓留档（2026-10-06 清理）：除 `main` 外 14 条远端分支**逐条的删除判据与取代证据**（含 tip SHA）；⭐ 以及唯一一条"真有价值但没进 main"的 `refactor/decouple-creation-and-stock` 的**原件留档**（`branch-salvage-2026-10-06/`：剥出来的 `productCreationService.js` 原文 + 全量 patch） |

当前仓库级 Agent 入口以根目录 [AGENTS.md](../AGENTS.md) 为准；`agent.md` 已不再是第二套入口。

## 5. 设计资产

| 资产 | 说明 |
|---|---|
| [prototypes/工作台页面架构原型.html](prototypes/工作台页面架构原型.html) | 工作台页面架构原型（静态 HTML，直接浏览器打开） |
| [reports/purchase-image-layout-and-group-thread-2026-10-07.md](reports/purchase-image-layout-and-group-thread-2026-10-07.md) | ⭐ **采购单 / 退货单出图排版 + 图与文字落在同一个话题**（业务负责人 2026-10-07 真机测试后当面提）：① 底部「合计 N 条 / M 双」整条删掉，改成**副标题** `供应商 · 报货日期 · 合计 M 双`（只留双数）、**不显示报货批次**、退货单同样改；② 采购群的 `im.message.reply` 补上 `reply_in_thread: true`，@经办人那条进**图所在的那个话题**。含**验收标准**、`表事件触发能否建话题` 的官方文档查证、逐条对照与定位回归证据 |
| [prototypes/purchase-order-2026-10-07.png](prototypes/purchase-order-2026-10-07.png) · [prototypes/purchase-return-2026-10-07.png](prototypes/purchase-return-2026-10-07.png) | 上面那次改动的**示例图**（采购单 / 退货单），由**项目自己的渲染器**生成（`server/scripts/render-purchase-image-prototype.js`）⇒ 示例图 = 她实际会收到的图 |
| [reports/arrival-zero-actual-2026-10-07.md](reports/arrival-zero-actual-2026-10-07.md) | ⭐ **到货核对「某尺码实际到 0 双」放行**（2026-10-07 真机误报的修复）：0 双的行**不入库、不阻断整单**；真「对不上明细」与「算出来是负数」各自有自己的提示与日志事件。含**动手前先写的验收标准**、实现落点、逐条对照、两个判断（负数 / 全 0）的理由与两次全量测试证据 |
