# 文档 ↔ 代码 漂移审查（只读）

> **基线 commit**：`bc19927`（2026-10-07）
> **维护**：审查侧（每次审查后更新上方 commit）
> **性质**：**只读诊断**。本文件不改动任何既有文档；修复动作由执行侧执行。
> **覆盖范围**：AGENTS.md（审查侧自核）＋ 12 份文档（分线核查）＋ `.env.example` ＋ `server/package.json`。
> **复核标记**：`✅` = 审查侧亲自回代码复核过；`○` = 分线报来（附 `file:line`，可抽查）。

---

## 0. 怎么用这份文档

- 按**危险度**排，不按文档排：先看 §1–§2（会把下一个 agent 带偏的），再按 §6 派活。
- 每条给：`文档:行` → 声明 → **代码实际** → 判定 → **怎么修**。
- 标 `Needs Verification` 的**先别动**（需要生产真表 / 实跑测试才能定）。
- ⚠️ 本文只记"文档与代码不一致"，**不代表代码有问题**——多数情况是**文档没跟上**。

---

## 1. 🔴 第一优先：私聊「回不回消息」——代码＋测试 vs 三处文档

**这不是"文档过时"，是"文档与代码相反"**，而且测试里引着业务负责人 2026-10-07 的最新决定。

| 来源 | 说法 | 复核 |
|---|---|---|
| **代码** | **默认回一句**：`config/privateChatNotice.js:19` `readFlag(env,'PRIVATE_CHAT_DISABLED_NOTICE_ENABLED', **true**)`；实现在 `larkMvpService.js:741-747` → 发「这个机器人现在只在群里工作，请到群里说～」 | ✅ |
| **测试** | 用例名与断言都写着"回一句"：`test/privateChatRemoval.test.js:186`、`:201 assert.equal(sent.length, 1)`、`:202 /请到群里说/` | ✅ |
| **业务负责人的最新决定（写在测试里）** | `test/privateChatRemoval.test.js:200`：「（**回一句请到群里说的开关**）保留就可以」 | ✅ |
| `docs/private-chat-removal-2026-10-07.md:21` | 私聊「一条消息都不回」「`im.message.create` **0 次**」 | ✅ |
| 同上 `:64` | 「没有开关、没有回执」 |  |
| 同上 `:104` | 用例钉住「也不回消息」 |  |
| `docs/private-chat-excision-todo.md:174` | 「一条消息都不回——**没有"统一回一句文案"这回事**」 |  |
| 同上 `:178` | 「`PRIVATE_CHAT_*` **刻意不引入**」 |  |
| `.env.example:150-151` | 同样写「也不回消息」 |  |

**判定**：**代码 ＋ 测试是对的；上述三处文档 + `.env.example` 全错**（文档停在决定变更之前）。

**怎么修**：
1. 三处文案改为「私聊**只回一句固定提示**（默认开）」，并写清这是 2026-10-07 的决定。
2. `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` / `PRIVATE_CHAT_DISABLED_NOTICE_TEXT` **补进 `.env.example`**（当前 0 处）。
3. ⚠️ **不要**照文档把那一句回复删掉——那是行为变更。

---

## 2. AGENTS.md 的 7 处漂移

### 2.1 文档 vs 代码（6 处）

| # | AGENTS.md 说 | 代码实际 | 复核 |
|---|---|---|---|
| 1 | 群聊判据在 `larkMvpService.js` **第 372–402 行**（细分 386-387 / 390-401） | 群分支在 **677**、`resolveMainChatAdmission` 在 **771**（调用在 684）→ 漂约 **300 行** | ✅ |
| 2 | 准入判据**两条** | 主群**三条**（@ ／ 销售闸门 ／ 批次号）＋ 话题一条 | ✅ |
| 3 | 没配 `LARK_BOT_OPEN_ID` 时**一条主群消息都不处理** | 默认 `GROUP_MAIN_CHAT_REQUIRE_MENTION = false`（**放宽**）；仅显式打开才"一条都不处理" → **与默认行为相反** | ✅ |
| 4 | 采购单发采购群「带 **@所有人**」 | 代码 4 处明确「**不再 @所有人**」、改 @经办人 | ✅ |
| 5 | `confirmArrival` / `ensureArrivalProducts`「**没有生产调用方**（孤儿能力，等「对话到货」接）」 | **是活的**：`config/arrivalConversation.js` 默认 `enabled: true`；`PurchaseArrivalConversationService` 已完整接线（构造 + 卡片动作 + 群话题入口） | ✅ |
| 6 | 私聊消息「不建任务、不进 AI、不读表、不写表、**也不回消息**」 | 私聊**会回一句**（见 §1） | ✅ |

**怎么修**：1–5 属「群聊/到货链路描述」整段重写；第 5 条**最危险**——按文档会把它当死代码删掉，而**它会写「采购入库」并动库存**。第 6 条见 §1。

### 2.2 代码侧漏改（1 处）

| # | 代码 | 问题 | 复核 |
|---|---|---|---|
| 7 | `GET /api/lark/events/health` 仍返回 `mode: 'p2p+group'`（`routes/larkEvents.js:260`） | 私聊已移除，这个"事实描述"过期；排查的人会以为私聊还开着 | ✅ |

---

## 3. 其他文档的漂移

### 3.1 `README.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:3`、`:29` | AI 模型是「豆包 (Doubao)」 | `config/llmModels.js` 只有 DeepSeek；`.env.example` 例为 `api.deepseek.com` | ✅ |
| `:3`、`:6`、`:15`、`:24`、`:63` | 飞书**私聊**机器人是销售正式入口 | 私聊链路 2026-10-07 移除；入口 = 群聊/话题 | ○ |
| `:8` | 「当前功能状态」指向 `project-progress.md` | 该文件本身已过时（见 3.6） | ○ |

### 3.2 `docs/README.md`（索引本身）
| 文档:行 | 声明 | 实际 | 复核 |
|---|---|---|---|
| `:3` | 「说明每一份文档现在是什么状态」 | **17 份顶层文档未登记**（含 `todo-behavior-lexicon-sale-cash.md`）；`docs/reports/`（15 份）完全未收 | ○ |
| `:13` | 把 `handoff.md` 标为「现行事实（Current）」 | handoff 基线停在 `f036d91`（2026-10-02），含多处已被代码否掉的内容 | ○ |
| `:15`/`:16`/`:17`/`:20`/`:21` | 把 project-progress、feishu-v1-operations、module-boundaries、workbench-query-contract、sales-line-plan 标为 Current | 五份均有下述漂移 | ○ |

### 3.3 `docs/module-boundaries.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:18` | 采购 `applyPurchase`「**受现有开关控制**」 | **无开关**：`purchaseWebhookService.js:241` `this.enablePurchaseInventory = true`；`ENABLE_PURCHASE_INVENTORY` / `ENABLE_SALES_INVENTORY` 全仓 **0 读取点** | ✅ |

### 3.4 `docs/workbench-query-contract.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:36` | `purchase/requests` 每行含 `reported_at` | 代码不返回（`purchaseQueryService.js:66-81`）；映射已删；**前端仍读它**（`public/workbench/features/purchase/index.js:41`）→「报单时间」列**恒空** | ○ |
| `:36`/`:38` | 未记新增 `report_behavior`、`report_behavior_name` 与 `reportBehavior` 精确筛选 | `purchaseQueryService.js:76-80`、`routes/purchaseQuery.js:16` | ○ |
| `:7` | 今日销售响应字段清单 | 现还含 `from`/`to`/`is_range`（`v1WorkbenchService.js:239-243`） | ○ |

### 3.5 `docs/sales-line-plan.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:255-258` | `v1WorkbenchService` 用 `asText` 读尺码、待 `codex/workbench-modular-ui` 改 | **已修**：`v1WorkbenchService.js:131-141` 走 `createSizeReferenceAccess` / `resolveLinkedCell`；该分支已不存在 | ○ |
| `:253` | 服务器代码比集成分支旧 | main 已合并（`HEAD..origin/main = 0`） | ○ |
| 状态表 | C1/C2/C4 标「已决策未做」 | 已有实现件（`config/salesMovements.js`、`afterSalesService`、`afterSalesFlowService`） | ○ |
| `:271` | `findLiveInventory` 死代码仍按数字读尺码 | **仍准确** ✅（`v1ReferenceResolver.js:230-242`，无调用方） | ○ |
| `:20` | 示例库 41 条 | 需读测试 Base | Needs Verification |

### 3.6 `docs/project-progress.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:33`、`:43` | 飞书**私聊**是 V1 销售主入口 | 现入口是群聊/话题 | ○ |
| `:91` | 用真实采购**图片**完成全链路验收 | 拍照识别 2026-10-05 已退场 | ○ |
| `:92` | 核对「资金流水」「供应商往来款」 | schema 里**没有** moneyLedger / supplierPayable 两张表（对应两个环境变量 0 读取点） | ○ |
| `:167` | 「飞书私聊销售文字录单 \| 待部署」 | 已群聊化 | ○ |
| `:34`/`:71`/`:118`/`:121` | 「资金流水」措辞 | 现无独立资金流水表 | ○ |

### 3.7 `docs/handoff.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:23`、`:47` | 正式入口 = 私聊；「采购发到货图片 → 豆包解析」 | 私聊已移除、图片识别已退场 | ○ |
| `:59` | `doubaoService.js` 含 `recognizeLabels` | 已删（仅剩注释） | ○ |
| `:197` | 测试名 `arrival with no images throws recognition failure` | 全仓 grep 不到 | ○ |
| `:203-208` | 用 `purchaseArrival/识别状态` 讲写入顺序硬化 | 该字段已删、`processArrival` 已删 | ○ |
| `:223` | `processArrival`/`compareArrival`/`confirm_purchase_arrival` 链路 | 均已删除 | ○ |
| `:25`、`:308` | 「216 passed」 | 现 **74** 个 `*.test.js`；确切通过数未跑 | Needs Verification |
| `:190` | 报告 feishu-v1-operations 开关漂移「待修」 | **仍成立**（至今未修） | ○ |
| `:300` | `FEISHU_SYNC_CONCURRENCY` / `FEISHU_RETRY_*` 仍在仓库 | 仍在 | ○ |

### 3.8 `docs/feishu-v1-operations.md`
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `:11` | V1 当前入口（销售：飞书私聊机器人） | 群聊/话题 | ○ |
| `:13`/`:16`/`:19` | 库存联动默认关闭，用 `ENABLE_SALES_INVENTORY` / `ENABLE_PURCHASE_INVENTORY` 启用 | 两变量 **0 读取点**；采购侧硬编码 `true` | ✅ |

### 3.9 ADR
| 文档:行 | 声明 | 代码实际 | 复核 |
|---|---|---|---|
| `ADR-001:84`/`:104`/`:154`/`:183` | 引用 `purchasePostingService.js`（含 `:75`、`:48-61`） | **文件不存在**，全仓 0 引用 | ○ |
| `ADR-001` 多处行号 | 抽查 20 处，仅 `v1PostingService.js:6` 命中 | 其余全部错位 | ○ |
| `ADR-001:144` | 「server/test/ **26** 个测试文件」 | 实际 **74** 个 | ○ |
| `ADR-001:168` | 引 `larkMvpService.js:248-249` 私聊拒绝文案 | p2p 段已删 | ○ |
| `ADR-002:74` | `saleLookupService.test.js:240`（零写入断言） | 实际在 `:260`；`:240` 是颜色候选 | ○ |
| `ADR-002:75` | 证据 `bootstrapReportAlerts` | **全仓无实现** | ○ |
| `ADR-003:121` | `llmModels.js`「文字与图片**两组**模型独立配置」 | 只剩一组：`KINDS = { text }` | ✅ |
| `ADR-003:121` | 引 `project-progress.md:38` | 实际在 `:39` | ○ |
| `ADR-003:123`/`:129` | ADR-002 与 `saleLookupService` **尚未进 main** | 二者都已在 main | ○ |

### 3.10 配置与脚本
| 项 | 声明/历史 | 实际 | 复核 |
|---|---|---|---|
| `.env.example` **7 个孤儿变量** | 0 读取点 | **仍未修**：`:22` `FEISHU_SYNC_CONCURRENCY`、`:23` `FEISHU_RETRY_MAX`、`:24` `FEISHU_RETRY_BASE_MS`、`:25` `FEISHU_RETRY_MAX_DELAY_MS`、`:105` `FEISHU_V1_PURCHASE_BATCH_TABLE_ID`、`:277` `FEISHU_V1_MONEY_LEDGER_TABLE_ID`、`:278` `FEISHU_V1_SUPPLIER_PAYABLE_TABLE_ID` | ✅ |
| `server/package.json:17` | `sales:sample` → `scripts/write_sales_sample.js` | **脚本不存在** | ✅ |
| 版本 vs tag | 是否不一致 | `0.3.0` == tag `v0.3.0` **编号一致** ✅；但 tag 落后 HEAD 10 个提交 | ○ |
| `PRIVATE_CHAT_DISABLED_NOTICE_*` | — | 新增配置，**未写入 `.env.example`** | ✅ |

---

## 4. 哪些文档是可信的（**不要重写**）

| 文档 | 可信部分 |
|---|---|
| `idempotency-contract.md` | 三个幂等键格式 + 状态机 ✅ |
| `inventory-size-reference-contract.md` | 方法签名、30 秒缓存、E2E 防误写 ✅ |
| `workbench-query-contract.md` | orders / payments / 交付 `failures` 字段 ✅（仅 3.4 三处漂移） |
| `feishu-v1-operations.md` | 日志事件名、库存流水字段名、nginx、`app.listen(host)`、PM2 名 ✅（仅"入口 + 开关"漂移） |
| `adr/ADR-002` | 三分法、只读 service 定位 ✅（仅 2 处证据行号） |
| `handoff.md` §7.1 / §7.2 | 两条自述**仍准**（报告没错，是没人去修） |
| `sales-line-plan.md:271` | `findLiveInventory` 死代码仍按数字读尺码 ✅ |
| `todo-behavior-lexicon-sale-cash.md` | 代码侧全对 ✅ |

> **结论**：6 份契约/运维文档里 **4 份只错在"入口 + 开关"几个点上** —— 修的成本是**改几行**，不是重写。真正需要**整段重写**的只有：**AGENTS.md 的群聊段**、**两份私聊文档**、**ADR-001 的引用**。

---

## 5. 「照哪份文档做，会做错什么」

| 想做的事 | 会信哪份 | 会做错什么 |
|---|---|---|
| 接模型 / 算模型预算 | README | 按「豆包」去接，实际只有 DeepSeek |
| 做销售入口验收 | README / handoff / project-progress | 验**私聊**——那个入口已经没了 |
| 打开"库存联动" | feishu-v1-operations / module-boundaries | 去设 `ENABLE_*_INVENTORY`——**设了没用** |
| 采购页做「报单时间」列 | workbench-query-contract | 依赖永不返回的 `reported_at`，列恒空 |
| 理解库存写入口 / 幂等缺口 | ADR-001 | 去读**已删除**的文件 + 一堆错行号 |
| 判断测试覆盖度 | ADR-001 / handoff | 以为只有 26 / 216 条，实际 74 个文件 |
| 维护环境变量 | `.env.example` | 继续维护 **7 个死变量** |
| 处理私聊 | 两份私聊文档 | 按"不回消息"改 → **把该留的提示删掉** |
| 规划资金联动 | project-progress | 去找**不存在**的「资金流水 / 供应商往来款」表 |

---

## 6. 修复优先级（可派活）

| 优先级 | 事项 | 成本 |
|---|---|---|
| **P0** | ① §1 私聊三方矛盾（三处文档 + `.env.example`） ② §2.1 第 5 条（在役能力被写成孤儿） ③ §2.2 `health.mode` | 各几行 |
| **P1** | §2.1 第 1–4 条（AGENTS.md 群聊段整段重写）；ADR-001 加 **Erratum**（按其治理规则只修正引用，不改写 Decision） | 半天 |
| **P2** | §3.1–§3.8 的入口/开关类逐条修正；§3.10 清 7 个孤儿变量 + 修 `sales:sample`；`docs/README.md` 补索引 | 半天 |
| **P3** | `docs/project-progress.md`、`handoff.md` 的旧描述：**建议归档处理**（加"历史"标注或移入 `docs/archive/`），而不是逐句改 | 决策 |

---

## 7. 根因与建议

**根因**：文档按"功能"组织，但**改动的收尾清单里没有"这次动了哪些文档"这一项**——所以每次只更新"新加的东西"，旧描述留在原地。证据：AGENTS.md 刚更新过（新增私聊移除段，准确），但同一份文档里 §2.1 的 5 处一字未改。

**建议（治根）**：在收尾流程里加一步——**这次改动碰了哪些链路 → 对应哪几份文档要同步**（可用 §5 那张表当索引）。

---

## 8. 未验证事项（先别动）

- `docs/sales-line-plan.md:20` 的「41 条真实案例」——需读测试 Base。
- `handoff.md` 的「216 passed」与当前通过数——需实跑 `pnpm test`（本次未跑）。
- `docs/todo-behavior-lexicon-sale-cash.md` 的「生产行为管理全表 20 条 / 所属环节=库存」——需读生产真表。
- tag 落后 HEAD 10 个提交是否有意（版本纪律属业务决定）。

---

*本文件只记录漂移与判断，不改动任何既有文档。修复由执行侧按 §6 派活；修复后请更新上方 commit。*
