# ADR-001: Separate AI Interpretation from Deterministic Business Execution

Status: Accepted
Date: 2026-09-24

> **标注约定**
>
> - `[Repo]` = **Repository Fact**：当前公开仓库的代码、文件、commit、PR 可以独立证明。
> - `[Owner]` = **Human Owner Context**：由 Human Owner 提供、GitHub 无法独立证明的背景判断。
> - **Uncertainty** = 时间、顺序或「是否真的运行过」无法从仓库独立证明，显式标注边界，不做推测填补。
>
> **Date 说明** `[Repo]`：2026-09-24 是业务决策被写入 `docs/project-progress.md` 的日期（commit `ece5b32`，2026-09-24），同一天库存入账被独立成模块（commit `430533d`，2026-09-24）。同一责任划分最早见于 2026-09-23 的设计基线（commit `52f6786`）。整条 V1 代码在 2026-09-23 至 2026-09-30 之间开发，直到 2026-10-01 才通过 PR #13（`0d1fe8c`）合入 `main`。

## Context

项目面向线下鞋类零售与小型门店，事实来源原本散落在纸质记录、聊天记录和手工表格里。系统需要把两类**非结构化输入**变成可入账的业务数据 `[Repo]`（`README.md`、`docs/project-progress.md`）：

- 销售：店员用自然语言说出或打出「8088-26 灰色 36 码 1 双，收 245 元，微信」；
- 采购到货：到货鞋盒的图片，经模型识别成货号、颜色、尺码、供应商（当前的触发方式见 Uncertainty 2）。
  > ⚠️ 2026-10-05 补注（不改本 ADR 的结论）：这条**图片翻译**已随「采购到货 → 拍照识别」链路退场删除，
  > 采购到货改为纯对话驱动。上面这条输入形态保留为历史记录；ADR 的边界结论（AI 只做翻译、
  > 不拥有最终业务事实）不受影响，文字翻译那一路仍在跑。

低门槛交互是产品前提之一：录入者是门店一线的非专业用户（含年长用户），不应该被要求先学一套表单 `[Owner]`。

但同一套系统同时承担**高风险确定性事实** `[Repo]`（`docs/project-progress.md`、`docs/module-boundaries.md`）：销售主单与明细、收款记录、库存流水、实时库存、采购入库、供应商应付。其中：

- 销售确认后写入销售明细与收款记录，交付时扣减库存 `[Repo]`（`server/src/services/salesOrderService.js:121`、`server/src/services/salesDeliveryService.js:72`）；
- 采购到货确认后写入采购入库并增加库存 `[Repo]`（`server/src/services/purchaseWebhookService.js:823`）。

因此「**理解输入**」和「**改变业务事实**」是两个风险等级完全不同的问题。设计基线把这条边界写成了角色表 `[Repo]`（`docs/lark-agent-technical-design.md:71-78`）：

```text
| 层级                  | 负责内容                                       | 不负责内容                     |
| AI / Skill            | 理解用户表达、识别意图、抽取字段               | 不直接写表，不决定最终合法性   |
| Workflow / State Machine | 决定追问、确认、取消、写入、重试等下一步动作 | 不做自由发挥式推理             |
| Domain Rules          | 金额校验、字段必填、写入张数、业务合法性       | 不理解自然语言                 |
| User Confirmation     | 对关键数据和写入动作做最终确认                 | 不承担系统校验职责             |

一句话原则：需要语义理解的交给 AI，需要稳定执行的交给代码，需要关键决策的交给用户确认。
```

Human Owner 的核心判断是 `[Owner]`：

> AI 适合承担语义理解和非结构化输入解析；但真正改变库存、资金、订单状态的操作不能直接交给概率模型决定。

这条判断不仅针对当前销售自然语言输入，也针对采购图片识别以及未来其他 AI 输入入口 `[Owner]`。

## Options Considered

以下是项目真实出现、被讨论或被明确排除过的三条路线；不为凑结构虚构方案。

### Option A: AI Directly Executes Business Writes

模型解析后直接决定并写入销售、库存、资金。

**这条路线没有被采纳，并且被设计文档明确排除** `[Repo]`：

- `docs/lark-agent-technical-design.md:33`：「不让机器人直接自由修改多维表格，所有写入必须经过后端校验和确认。」
- `docs/lark-agent-technical-design.md:24`：「写入前必须可复核、可确认，避免 AI 误写业务数据。」
- `docs/lark-agent-technical-design.md:73`：AI / Skill「不直接写表，不决定最终合法性」。
- 更早的微信小程序时期（初始提交 `3946ab8`，2026-04-15）也不是「模型直接写表」：当时的链路是拍照识别 → `miniprogram/pages/review/` 人工复核 → 后端 `/api/sync` 按客户端提交的 `reviewed_data` 写入，中间始终有一次人工复核 `[Repo]`（`docs/archive/legacy-wechat-retirement.md`，Git History）。

它也直接违反 Owner 的判断 `[Owner]`：改变库存、资金、订单状态的操作不能交给概率模型。

**Uncertainty**：仓库能证明「AI 直写从未成为被采纳的设计」，但无法证明「从未有人本地试验过」。本选项作为**被拒绝的设计选择**记录，不作为历史正式方案。

### Option B: AI + Human Confirmation, But Business Rules Distributed Across Entry Points

保留人工确认，但机器人、网页工作台、飞书工作流或多维表格自动化各自实现一套库存 / 资金 / 订单状态规则。

这不是假想风险，项目历史上确实出现过它的结构痕迹 `[Repo]`：

- 已退役的微信入口有自己的写入实现和表配置：`server/src/services/salesOrderFeishuWriter.js`、`server/src/utils/salesOrderBuilder.js`、`server/src/config/salesTables.js`、`server/src/config/salesTableFields.js`（均随 PR #16 删除，历史路径见 Git History）。同一套模块与行为配置还被复制进客户端（`miniprogram/config/modules.js` 对照 `server/src/config/modules.js`；客户端已随 PR #16 整体删除，历史路径见 Git History）。
- 采购侧的表触发一度由**多维表格自动化工作流**承担，直到 `f976f26`（2026-09-26）用记录变更事件订阅替代；当前代码注释同样写明这是「替代自动化工作流，无运行次数限制」`[Repo]`（`server/src/routes/larkEvents.js:75`）。
- 因此现行文档反复把这条边界写成禁令 `[Repo]`：`docs/project-progress.md:27`（飞书工作流「不独立复制扣库存、加库存或记资金流水的核心规则」）、`:146`（「不要让网页工作台、飞书工作流或机器人分别维护不同的库存和资金规则」）、`docs/module-boundaries.md:3`（「而不是让模块改写另一个模块的内部字段或让页面直接计算业务结果」）。

**Uncertainty**：旧链路源码已随 PR #16 删除，仓库只能证明当时存在「第二套写入实现 + 第二套配置」，无法证明它是否真的独立计算过库存或资金规则，也无法证明是否因此产生过线上不一致。

### Option C: AI Interpretation + Human Confirmation + Deterministic Backend Execution

AI 负责：识别意图、抽取字段、生成结构化草稿、发现缺失信息（必要时追问）`[Repo]`（`server/src/services/doubaoService.js:195-262`、`:322-405`）。

后端负责：校验、幂等、状态管理、业务规则、正式写入、跨表联动、库存变化、资金变化 `[Repo]`（`server/src/services/v1PostingService.js`、`salesOrderService.js`、`purchasePostingService.js`、`inventoryService.js`、`paymentService.js`）。

用户在正式入账前确认关键业务事实 `[Repo]`（确认卡片 `server/src/utils/larkCards.js:184-205`、`:313`）。

这即是当前的 Decision。

## Decision

**AI 不拥有最终业务事实。** AI 只负责把非结构化输入转换成**候选**结构化信息；正式业务变更必须经过：

```text
AI Interpretation  →  Structured Draft  →  Validation  →  Human Confirmation
    →  Deterministic Business Execution  →  Bitable / Inventory / Payment Records
```

具体规则：

1. **只有用户确认动作才能触发正式入账。** 销售链路的入账调用点唯一，位于卡片动作 `confirm_sale` / `confirm_sale_pending` / `confirm_sale_delivered` 分支内 `[Repo]`（`server/src/services/larkMvpService.js:702`、`:709`）；采购到货同理，只在 `confirm_purchase_arrival` 分支内执行 `[Repo]`（`server/src/services/purchaseWebhookService.js:577`、`:585`）。
2. **确认人身份受限**：只有草稿的原始发送人可以确认 `[Repo]`（`larkMvpService.js:613`、`purchaseWebhookService.js:567`）。
3. **未确认不改动任何正式事实。** 缺字段时任务停在 `needs_info` 并追问，不生成正式记录 `[Repo]`（`larkMvpService.js:460`、`:467`）；取消只更新确认状态 `[Repo]`（`larkMvpService.js:644-652`）。销售确认但未交付时，库存明确不扣减 `[Repo]`（`larkMvpService.js:773`、`:785`）。
4. **库存只有一个写入口。** `[Repo]` `server/src/services/v1PostingService.js:6-8`：「Stock changes happen only through InventoryService: after explicit sales delivery or confirmed purchase arrival.」销售扣减只经 `InventoryService.applySale`（`salesDeliveryService.js:72`），采购增加只经 `InventoryService.applyPurchase`（`purchasePostingService.js:75`、`purchaseWebhookService.js:794`、`:823`）。其他模块不得直接创建库存流水或实时库存 `[Repo]`（`docs/module-boundaries.md:19`）。
5. **所有用户入口复用同一套业务执行规则。** 网页工作台的收款与交付直接复用与机器人相同的 `PaymentService` / `SalesDeliveryService` `[Repo]`（`server/src/services/salesFollowupService.js:13-14`，经 `server/src/routes/workbench.js:42`、`:55` 调用），只额外增加 `confirmStatus === '已入账'` 前置条件，不复制业务规则 `[Repo]`（`salesFollowupService.js:97`）。飞书工作流只允许承担提醒、审批和通知编排 `[Repo]`（`docs/project-progress.md:24-27`）。
6. **正式入账必须幂等、可恢复、可追踪。** 采购批次 / 采购申请 / 实时库存使用远端幂等键，重试前先按键回查，命中多条即停止转人工 `[Repo]`（`docs/idempotency-contract.md:27-53`；`server/src/infrastructure/idempotencyKey.js:7-8`、`:43`）；库存变动使用来源明细 ID 做幂等键并保留可恢复日志 `[Repo]`（`inventoryService.js:60-61`、`:67`、`:195`、`:254`）。

> 这是正式入账的**架构约束 / Target Requirement**，不代表当前所有正式入账链路都已完全实现远端幂等：当前实现覆盖仍不完整，具体缺口见 Uncertainty 5。

**不得**让大模型直接决定最终库存、资金或正式业务账；**不得**让不同入口各自维护一套库存、资金和订单状态逻辑。

## Why

1. **库存与资金要求确定性。** 验收标准直接写成「用户未点击确认时，不改变库存和资金」「入账后回读多维表格，库存流水变化后数量与实时库存一致」`[Repo]`（`docs/project-progress.md:103-111`）。幂等契约的原则同样是为确定性服务的：「宁愿停下来让人核对，也不因为『不确定』再写一笔采购事实」`[Repo]`（`docs/idempotency-contract.md:53`）。
2. **大模型输出具有概率性，因此只能当候选。** 代码把模型输出当作待校验输入而不是结论：后端重新计算合计、重新归一化颜色、重新比对成交金额与已收金额，不一致就退回追问 `[Repo]`（`server/src/services/doubaoService.js:144-171`；`server/src/services/larkMvpService.js:404-446`）。提示词层面也要求「不能编造货号、尺码、金额和支付方式；缺字段必须标记为 missing_fields」`[Repo]`（`docs/lark-agent-technical-design.md:88`）。Owner 的判断是概率模型不应决定真实业务数据 `[Owner]`。
3. **用户确认把语义误判挡在正式账之外。** 「系统解析后必须先展示确认卡片。只有用户确认，才写销售明细、扣减库存并生成资金流水」`[Repo]`（`docs/project-progress.md:70`）；「用户没确认 → 不改库存、不改资金」`[Owner]`。
4. **业务执行需要幂等、恢复和可审计。** 飞书写入是远端调用，本地日志覆盖不了它的全部结果，必须让远端带稳定标识并在重试前回查 `[Repo]`（`docs/idempotency-contract.md:5-23`）；采购卡片确认按 taskId 串行、锁内重读状态、写远端前先落 `posting`，`posting` 不是终态 `[Repo]`（`docs/idempotency-contract.md:76-88`）。这些要求只有确定性代码能满足。
5. **多入口必须共享业务规则，否则数据必然不一致。** 模块边界的目标是「依赖明确的业务接口，而不是让一个模块改写另一个模块的内部字段或让页面直接计算业务结果」`[Repo]`（`docs/module-boundaries.md:3`）；现行禁令进一步点名机器人与工作台不得各维护一套规则 `[Repo]`（`docs/project-progress.md:146`）。工作台的复用实现就是这条规则的落地 `[Repo]`（`salesFollowupService.js:13-14`）。
6. **AI 能力可以替换 / 升级，核心业务规则不应随模型漂移。** 设计目标之一是「后续可以替换模型、缓存、消息卡片、飞书写入实现或某个业务 Skill」`[Repo]`（`docs/lark-agent-technical-design.md:26`）；`doubaoService.js` 只调用模型接口并返回数据，不 import 任何 Bitable 网关，因此换模型不触及入账规则 `[Repo]`（`doubaoService.js:1-5`、`:262`）。Owner 也明确该原则要适用于采购图片识别和未来其他 AI 入口 `[Owner]`。

## Reusable Principle

从本项目提炼：

> **AI 可以负责理解不确定性，但确定性的业务事实必须由可测试、可追踪、可恢复的程序规则产生。**
>
> **Probabilistic interpretation, deterministic execution.**

在本项目中，这条原则对应三件可验证的具体事 `[Repo]`：

1. AI 只产出候选草稿，不产出业务事实；
2. 只有确定性业务服务能改变库存与资金；
3. 高风险变更前保留人工确认边界。

它适用于任何「输入不确定、但结果必须确定」的企业业务：库存、财务、订单状态、审批、CRM、ERP。**边界说明**：本 ADR 的证据只来自本项目的销售与采购链路；把该原则外推到其他业务领域是合理推断，不是本仓库已证明的事实。

## Consequences

### Positive

- **AI 输入方式可以持续扩展，而核心业务规则不动。** 新增输入只需要产出候选草稿并接入同一执行层 `[Repo]`：网页工作台就是复用同一业务服务而不是另写一套（`salesFollowupService.js:13-14`）。
- **模型误判不会直接变成库存 / 资金事实。** 入账调用点只存在于确认动作分支内 `[Repo]`（`larkMvpService.js:702-709`、`purchaseWebhookService.js:577-585`）。
- **销售、采购、网页工作台共享业务执行层**，多入口不会各自演化出不同算法 `[Repo]`（`docs/module-boundaries.md`；`docs/project-progress.md:146`）。
- **核心链路可单测、可审计、可恢复。** 仓库有对应的确定性测试与 CI `[Repo]`（`server/test/` 26 个测试文件；`.github/workflows/server-tests.yml` 在 PR 上跑 `pnpm test`）；任务状态与库存日志持久化在本地存储中，可按阶段恢复 `[Repo]`（`server/src/infrastructure/jsonTaskStore.js:12`、`inventoryService.js:254`）。
- **大模型供应商未来可以替换。** 模型调用被隔离在一个服务内，业务服务不依赖具体模型 `[Repo]`（`doubaoService.js:1-5`、`:419`）。

### Trade-offs

- **多了一层草稿 / 确认状态。** 用户必须完成一次确认动作，卡片交互和状态回写都是额外实现成本 `[Repo]`（`larkMvpService.js:460`、`:474`）。
- **后端必须维护更明确的业务状态机。** 采购确认是 `awaiting_confirmation → posting → posted`，`posting` 还是可恢复的中间态；库存操作另有 `prepared → ledger_created → completed` 日志 `[Repo]`（`docs/idempotency-contract.md:76-88`；`inventoryService.js:230`、`:340`、`:345`）。
- **AI 与业务执行之间需要稳定的数据 Contract。** 模型输出的结构、后端的归一化与校验规则必须同步演进，改一个字段要一起改提示词、归一化、校验和测试 `[Repo]`（`doubaoService.js:195-262`；`larkMvpService.js:448`）。
- **开发成本高于「模型解析后直接写表」。** 幂等键、恢复日志、串行队列、人工核对出口都要额外实现 `[Repo]`（`idempotencyKey.js`、`keyedSerialQueue.js`、`docs/idempotency-contract.md`）。
- **确认动作本身有失败模式。** 双击、飞书重投、用户不点都会产生新的边界问题，需要串行队列和重复投递保护来兜底 `[Repo]`（`larkMvpService.js:305`、`:630`；`docs/idempotency-contract.md:87-88`）。
- **幂等覆盖并不完整，这是已付出的代价。** 采购入库明细与销售侧正式入账没有远端幂等键，依赖本地任务记录与内容比对 `[Repo]`（`purchasePostingService.js:48-61`；`salesOrderService.js:99-118`）；库存串行队列是进程内的，多实例并发不在其保护范围内（见 Uncertainty）。

### Future Constraints

- 新增 AI 能力（新的输入形式、新的模型、新的识别场景）**不得**直接写正式库存或资金。
- 新增用户入口（新的机器人、页面、外部系统）**不得**复制核心业务规则，必须复用后端业务服务。
- AI 输出必须先转成**受约束的结构化 Contract**，并经业务层校验后才能进入正式写入。
- 正式入账必须经过业务层校验，且保持幂等、可恢复、可追踪。
- 涉及高风险数据的操作必须保留确认 / 授权边界；回调、事件、自动化都不得绕过它。
- 如果未来要改变「AI 与确定性执行」的责任边界，应当**新建 ADR**，并明确是否 Supersede ADR-001。

## Uncertainty

1. **日期与合入范围。** V1 代码 2026-09-23 起在分支上开发，2026-10-01 才经 PR #13 进入 `main`；不能据此说「该架构 2026-09-23 已上线」。同时 `docs/project-progress.md:45` 记录 V1「尚需完成服务器部署、新应用配置、Schema 校验和真实飞书端到端验收」，因此**仓库无法证明该架构已在生产多维表格上真实运行过**，只能证明它已被实现并被测试约束。
2. **采购入口曾存在文档与代码漂移（已在本 PR 中最小修正）。** 修正前，`AGENTS.md:6`、`docs/project-progress.md:35`、`docs/feishu-v1-operations.md:13` 描述「机器人私聊连续发送到货图片」，但当前代码拒绝非文字消息并回复「机器人当前只接收销售文字；采购请使用采购表单」`[Repo]`（`larkMvpService.js:248-249`），机器人采购图片流程已无任何调用点且有回归测试钉住 `[Repo]`（`server/test/larkMvpService.test.js:77`）；现行到货识别由多维表格记录变更事件触发 `[Repo]`（`larkEvents.js:75-76`、`:122` → `purchaseWebhookService.js:409`、`:425`）。**本 ADR 按代码描述**；相关 Current-State 文档已按此修正，历史文档未改动。
3. **更早方案是否真正运行过无法证明。** 旧微信链路的写入实现与配置已随 PR #16 删除，只能从 Git History 获取；无法证明它当时是否独立计算过库存 / 资金规则，也无法证明 Supabase 是否在生产运行过。
4. **Option A 只能证明「未被采纳」，不能证明「从未尝试」。** 记录为被拒绝的设计选择。
5. **幂等覆盖不对称。** 采购批次、采购申请、实时库存有远端幂等键，采购入库明细与销售侧正式入账没有；且库存串行队列是进程内的（`keyedSerialQueue.js`），多实例并发不在保护范围内。该差异不应被读成「全链路已完全幂等」。
6. **资金表述不一致。** `docs/feishu-v1-operations.md:14` 明确「当前不使用独立资金流水和供应商往来表」，而 `docs/project-progress.md:35` 使用「资金流水 / 供应商往来款」措辞。本 ADR 只按可证的写入目标描述：销售明细、收款记录、库存流水、实时库存、采购入库。

## Evidence

| # | Evidence | 证明什么 |
| --- | --- | --- |
| 1 | `docs/project-progress.md:18-27`（当前架构共识：后端 = 解析、校验和可靠入账引擎；涉及库存和资金的正式入账必须由后端统一执行）、`:70`（只有用户确认才写销售明细、扣库存、生成收款）、`:103-111`（验收标准：未确认不改库存和资金、可追溯、可安全重试）、`:146`（不得让工作台 / 工作流 / 机器人各维护一套规则） | 责任边界与验收判据是现行文档共识 |
| 2 | `docs/lark-agent-technical-design.md:23-26`、`:33`、`:58`、`:71-78`（AI / Workflow / Domain Rules / User Confirmation 角色表；「需要语义理解的交给 AI，需要稳定执行的交给代码，需要关键决策的交给用户确认」） | 该边界在 V1 设计基线中已被明确写出（注意：该文档第 2–11 节属方案推演，但角色划分与当前代码一致） |
| 3 | `docs/module-boundaries.md:3`、`:9`、`:19`（模块接口与不变量；库存模块提供 `InventoryService.applySale` / `applyPurchase`；「其他模块不要直接创建库存流水或实时库存记录」）、`docs/idempotency-contract.md:39-53`、`:76-88`（写入顺序、结果未知分流、状态机） | 单一库存写入口与幂等 / 恢复契约 |
| 4 | `server/src/services/doubaoService.js:195-262`、`:322-405`（只调用模型、只返回 JSON，文件内不 import Bitable 网关）；`server/src/services/larkMvpService.js:404-446`（后端重新校验数量、货品精确匹配、金额合计）；`:448-467`（草稿与确认卡片） | AI 只做理解与抽取，后端做确定性校验，AI 不写表 |
| 5 | `server/src/services/larkMvpService.js:613`、`:702-709`、`:790`；`server/src/utils/larkCards.js:184-205`、`:313`；`server/src/services/purchaseWebhookService.js:567`、`:577-585` | 确认闸门：只有原始发送人的确认动作才会进入正式入账 |
| 6 | `server/src/services/v1PostingService.js:6-8`；`server/src/services/inventoryService.js:157`、`:174`；`server/src/services/salesDeliveryService.js:72`；`server/src/services/purchasePostingService.js:75`；`server/src/services/paymentService.js:37`；`server/src/services/salesFollowupService.js:13-14` | 库存变化只经 `InventoryService`；工作台与机器人复用同一执行层 |
| 7 | Commit `52f6786`（2026-09-23，引入确认卡片与 `confirm_sale` / `confirm_purchase` 闸门）；`f976f26`（2026-09-26，用记录变更订阅替代多维表格自动化工作流）；`f37cabc` / PR #12（2026-10-01，三个数据一致性 Blocker：确认串行、采购写入幂等、库存增加 Unknown Outcome）；`0d1fe8c` / PR #13（2026-10-01，V1 合入 `main`） | 该架构的形成与加固过程 |
