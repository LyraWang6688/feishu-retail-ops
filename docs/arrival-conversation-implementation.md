# 采购到货「群话题对话式核对」：实现与验收记录

> **这份文档是什么**：`docs/arrival-conversation-flow.md`（业务负责人 2026-10-06 定稿的**规格**）
> 的**实现记录**——代码落在哪、四张表各写了什么、「申请表一个字没变」是怎么钉住的、
> 以及**替她做的那 7 个决定**。
>
> **状态**：已实现，**未合并、未部署**（分支 `feat/arrival-conversation-flow`）。
> 部署前必须先问业务负责人「你现在在做测试吗？」（`AGENTS.md` 的时机纪律）。
>
> **规格里的「⚠️ 未定」怎么办**：业务负责人已授权「把这个做了」，所以未定项按 PR 里逐条
> 列出的**保守默认**落地，并在下面逐条标注**「这处待你确认」**——默认不等于她定了。

---

## 1. 接线方式（话题消息 → 核对 → 卡片 → 入库）

```
飞书群消息事件
  └─ routes/larkEvents.js → LarkMvpService.acceptMessage
       └─ 群聊准入：**先判 thread_id**（话题里免 @；主群才要求 @机器人）   ← 既有代码，未改
            └─ LarkMvpService.acceptGroupMessage → GroupPurchaseFlowService.handleGroupPurchaseMessage
                 └─ PurchaseBatchLocator.resolve（thread_id → parent_id → 批次号，四条路都不猜）  ← 既有代码，未改
                      └─ matched 分支 → ArrivalConversationService.noteTopicMessage   ← 本次新增的那一环
                           ├─ 只记进本地会话记录 data/arrival_conversations/（**不写业务表**）
                           ├─ 文字模型判「核对完了」（config/arrivalConversation.js 的提示词）
                           ├─ 判成 → 回复**她说话的那条消息**发确认卡片（落在同一话题里）
                           └─ 判成「全没到」→ 回一句规则说明，零写入、不发卡片
卡片回调（点「是」）
  └─ LarkMvpService.handleCardAction → ArrivalConversationService.matches(action)
       └─ ArrivalConversationService.handleCardAction
            └─ PurchaseWebhookService.ensureConversationArrival  ← 建/找回「采购到货」那一行 + 摆好草稿
                 └─ PurchaseWebhookService.confirmArrivalForConversation
                      └─ confirmArrivalLocked（**既有代码**：写「采购入库」+ inventory.applyPurchase + 到货确认状态）
            └─ 群里回一句结果 + 把那张卡片 patch 成「已入库」
```

**卡在哪一环**：`GroupPurchaseFlowService` 的 `matched` 分支（今天以前只记日志就返回）
接上了 `ArrivalConversationService`，`LarkMvpService.handleCardAction` 接上了卡片动作
`confirm_purchase_arrival`。**入库那一半一行都没重写**——复用的就是 `confirmArrivalLocked`。

**解耦**（`AGENTS.md` 的「重中之重」）：

| 关注点 | 落在哪 | 为什么 |
|---|---|---|
| 话怎么理解（记录 / 判意图 / 卡片） | **新增** `services/arrivalConversationService.js` | 规格 §4.2 明确要求"不要塞进 PurchaseWebhookService"；口径会变，表结构也会变，两件事的变更节奏不同 |
| 表怎么写 | `services/purchaseWebhookService.js`（原有能力 + 两个新方法） | 业务表的写入只有这一处实现 |
| 卡片长什么样 | `utils/larkCards.js` | 与其它卡片一致 |
| 开关 / 判据 / 文案 / 时区 | `config/arrivalConversation.js` + `config/purchaseArrivalIntake.js` | 配置先行：换一句话、换一个开关值都不用改代码 |
| 「是哪一批」 | `services/purchaseBatchLocator.js`（未改） | 既有能力，直接复用 |

**入口开关**：`PURCHASE_ARRIVAL_INTAKE_ENABLED`（⭐ **没有新加第二个开关**）。
这个模块当初就是**刻意保留给「对话到货」**的（`AGENTS.md` 原文：「将来恢复「对话到货」时
它是一个现成的、语义明确的开关」），本次把它接上了。判定规则不变：只有显式 `false` 才关，
空串/未配置/写错的值一律按开启。
> ⚠️ **待同步**：`AGENTS.md`「环境变量」一节仍写着这个变量"已无读取点"。
> 当时 `AGENTS.md` 正在 PR #91 里并发改动，本 PR **一个字都没碰它**；#91 合并后补一句即可。

---

## 2. 四张表各写了什么

| # | 表 | 写入点 | 内容 |
|---|---|---|---|
| ① | **采购到货** | `ensureConversationArrival` → `gateway.create('purchaseArrival', …)` | **点「是」那一刻才建**，一行：`报货批次号`（关联）· `到货日`（= 点「是」那一刻的时间戳）· `验收原话`（= 最后那句"核对完了"的原话）· `验收人`（点「是」的人）· `确认状态`（建时 `待确认`，入库后 `已确认`） |
| ② | **采购入库** | `confirmArrivalLocked`（既有） | 每个「货品+尺码」一行：`数量` = **实际**双数 · `采购行为` = 采购入库 · `采购到货批次` 关联 ① 那一行 · `采购申请` 挂回对应申请行 |
| ③ | **库存流水** | `InventoryService.applyPurchase` → `STOCK_PURCHASE_INCREASE`（既有） | 一个尺码一行：`变动数量` = 该尺码实际双数 · `库存行为` = 采购增加 · `关联采购` 指向 ② 的入库行 |
| ④ | **实时库存** | 同上 | 按实际双数增加（**一双一条**是既有粒度，不是本次改的） |
| ✗ | **单据信息**（采购申请表） | **没有任何写入点** | 🔴 一个字都不改（见第 4 节） |

关键代码（`services/purchaseWebhookService.js`，建 ① 那一行）：

```js
const created = await this.gateway.create('purchaseArrival', {
  batch: relation(batchRecordId),
  // ④ 到货日 = 她点「是」那一刻（时间戳原样存进日期字段）。
  arrivalAt: occurredAt,
  // ⑦ 验收原话 = 最后那句"核对完了"的原话（默认：最省，也够追溯）。
  acceptanceText,
  inspector: person(operatorOpenId),
  confirmStatus: '待确认',
});
```

⚠️ **① 的"找到"优先于"新建"**：先看任务草稿里有没有 `arrival_record_id`，再按
`报货批次号` 关联回查远端，都没有才 `create`。所以重复点「是」/ 手势重投**不会**在
「采购到货」写出第二行。

---

## 3. 「采购申请表一个字都没变」是怎么钉住的

**代码侧**（`services/purchaseWebhookService.js`）：原来 `confirmArrivalLocked` 会逐条
把 `未到货/部分到货/全部到货/超额到货` 写回采购申请行（规格 §4.2 待改 1）。**这段已整体删除**：

```js
// ⚠️ 2026-10-06：「采购申请表的到货状态回写」**已删除**。
// 业务负责人的口径（docs/arrival-conversation-flow.md §3，原话）：
//   「采购申请表已经是一个历史数据了……按实际数量入库即可，不需要改表本身」
// 而「单据信息」（= 采购申请表）**一个字都不许变**是她的红线，
// 因此到货状态没有任何地方可写——写了就是改表本身。
```

连带删掉了只被它使用的 `number()` 小工具（留着就是一个再也没有调用点的声明）。

**测试侧**（`test/arrivalConversation.test.js`，三条独立断言，缺一不可）：

```js
// ① 全表快照：内容与顺序都要一模一样。
const requestsBefore = JSON.parse(JSON.stringify(harness.records.purchaseRequest));
await clickYes(harness, conversationIdOf());
assert.deepEqual(harness.records.purchaseRequest, requestsBefore);

// ② 没有任何对采购申请表的写操作（create / update / delete）。
assert.deepEqual(
  harness.gateway.writes.filter((write) => write.tableKey === 'purchaseRequest'), [],
  '「单据信息」一个字都不许写',
);

// ③ 到货状态列不可被改写（哪怕写成同一个值也算改）。
for (const write of harness.gateway.writes) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(write.fields || {}, arrivalStatusField), false,
    `不允许出现写到货状态的写入：${JSON.stringify(write)}`,
  );
}
```

`harness.gateway` 是**会记账的假网关**——每一次 `create/update/delete` 都进 `writes`，
所以「零写入」不是靠"看代码觉得对"，而是跑出来的事实。既有的
`test/purchaseWebhookService.test.js` 里那两条入库用例也一并改成前后快照 `deepEqual`
（原来是只盯 `到货状态` 一个字段）。

---

## 4. 替她做的 7 个决定（**默认 ≠ 她定了**）

| # | 未定项 | 本次采用的保守默认 | 实现位置 | 备注 |
|---|---|---|---|---|
| ① | 实际到货 **>** 申请数量 | **照实际数量入库** ＋ 在群里回一句说明（「这次比申请多了 X 双」）＋ **不回写申请表** ＋ 打日志 | `ArrivalConversationService.evaluate` 算 `overage`；`config/arrivalConversation.overageNotice` | ⚠️ **这处待你确认**：卡片上（点确认**之前**）也会显示这句，让你有机会发现数说错了 |
| ② | 实际到货 **= 0**（全没到） | **拒绝入库** ＋ **不改任何表** ＋ 在话题里回一句「这次一双都没到 —— 如果是要取消/改数量，请改表再发一次」；**按规则记 info 日志**（不是 error），并发**不发**确认卡片 | `ArrivalConversationService.evaluate` 的 `quantity <= 0` 分支 + `handleCardAction` 的兜底 | 规则来自「`inventory.applyPurchase` 不接受 0」；卡片回调那一路也再拦一次（零写入） |
| ③ | 只到**部分尺码** | **只记实际到的**；未到的尺码**不留任何记录**（不写入库行、不写流水、不写实时库存） | `ArrivalConversationService.resolveActual`（`quantity <= 0` 直接丢掉） | 与"按核对结果入库"一致 |
| ④ | 「到货日」跨天取哪一天 | **取她点「是」那一刻**的日期（上海时区）；表里存那一刻的时间戳，日志另给 `arrival_date`（yyyy-mm-dd） | `handleCardAction` 里 `occurredAt = this.now()`；`config/arrivalConversation.arrivalDateOf` | 有测试钉住"上海 10-06 00:30 要算 10-06，不是 UTC 的 10-05" |
| ⑤ | 卡片按钮 | **只有「是」**一个；不加「否 / 再想想」 | `utils/larkCards.arrivalConfirmationCard` | 规格正文只写了「是」；测试断言按钮数 == 1 |
| ⑥ | 「到货状态」回写到哪 | 🔴 **不回写任何地方**（连带删掉既有的回写代码，见第 3 节） | `confirmArrivalLocked` | 「超额到货」这个选项值现在**没有任何写入点**——这是与她的红线对齐，不是漏改 |
| ⑦ | 「用户原话」放哪个字段 | 用已映射的「**验收原话**」（`v1BitableSchema.purchaseArrival.fields.acceptanceText`），**取最后那句"核对完了"的原话** | `ArrivalConversationService.evaluate` 的 `finalizingText` | ⚠️ **这处待你确认**：**不是**拼接、也不是逐句覆盖。要全存需要**加一列**或**改成拼接**——本 PR 没做 |

### 另外三个「实施层的决定」（不是业务口径，但也要她知道）

1. **① 那行「采购到货」在点「是」时才建**，核对期间一行都不建。
   规格 §5.1 明确要求「核对期间『采购到货』表还没有新行」，而 §4.2 待改 2 说
   "入话题核对时先建/找到那一条到货记录"——两句冲突时按**验收标准**走（它是她的原话口径）。
2. **卡片动作名沿用被删掉的那个** `confirm_purchase_arrival`（规格 §4.2 说"名字沿用或另起，实施时定"）。
   语义没变，卡片与分派共用 `config/arrivalConversation.ARRIVAL_CONFIRM_ACTION` 一个常量。
3. **没有"新品建档"这条路**：对话里她只说数量，没有识别出来的新货品信息。
   草稿里 `pending_creation: []`（建档那一步就是空跑），**不猜**、也不复活已退场的识别链路。

### 一个**没定**、只能先这样处理的点

- **模型调用失败时**（网络/配置/返回不是 JSON）：只记 `purchase.arrival.conversation.understand_failed`
  一条 warn，**不回复、不猜、不写表**，会话留在"收集中"。
  理由：她还在核对过程中，机器人主动追问会刷屏（规格 §1「机器人不主动追问」）；
  她再说一句就会重试。⚠️ **这处待你确认**：要不要在连续失败时回一句"我没听懂"。

---

## 5. 验收标准逐条对照（规格 §5）

跑法：`cd server && node --test --test-concurrency=1`（测试文件：`test/arrivalConversation.test.js`）。

### 5.1 核对期间（还没点「是」）

|  | 检查项 | 用例 | 结果 |
|---|---|---|---|
| □ | 机器人**只记录**，**一张表都不写** | `§5.1 核对期间：只记录，四张表 + 采购申请表一个字都没写` | ✅ 断言 `gateway.writes` 为空 + 全表快照 `deepEqual` |
| □ | 话题里说话**免 @** | `接线：话题里没 @ 机器人也进到货核对…` | ✅ 走真 `LarkMvpService.acceptMessage`，`mentions: []` 也进流程 |
| □ | 不重复发卡片 / 不重复回话 | `③④ 卡片已经发出去之后再说话…`、`§5.1 …同一条消息被飞书重投…` | ✅ 卡片 1 张、`replyText` 0 次、模型只调 1 次 |

### 5.2 点「是」之后（**这是入库点**）

|  | 检查项 | 用例 | 结果 |
|---|---|---|---|
| ① | 「采购到货」新增 1 行：到货日 + 验收原话 + 确认状态=已确认 | `§5.2 ① 采购到货：新增 1 行…` | ✅ |
| ② | 「采购入库」按**实际**数量写入库行 | `§5.2 ②③④ …都按实际数量写…` | ✅ 36 码实际 3（申请 2）入库也是 3 |
| ③ | 「库存流水」尺码数 = 行数，变动数量 = 实际双数，关联采购指向 ② | 同上 | ✅ |
| ④ | 「实时库存」按实际数增加 | 同上 | ✅ 3 + 1 = 4 条 |
| ⑤ | 🔴「单据信息」**一个字都没变**，到货状态列不可改写 | `🔴 §5.2 ⑤ …全表快照 + 到货状态列不可改写` | ✅ 三条断言（见第 3 节） |
| ⑥ | 群里回一句结果 + 卡片变「已入库」 | `§5.2 ⑥ 群里回一句结果 + 那张卡片变成「已入库」` | ✅ 文本回执 + patch 掉按钮 |

### 5.3 异常（规格里未定，按保守默认落地）

|  | 场景 | 用例 | 结果 |
|---|---|---|---|
| □ | 实际 > 申请 | `异常① 实际 > 申请…` | ✅ 照实际入 + 群里说明（卡片上也先说） |
| □ | 实际 = 0 | `异常② 实际 = 0…`、`异常② 兜底 …` | ✅ 拒绝 + 回话 + 零写入（**规则**，按 info 记） |
| □ | 只到部分尺码 | `异常③ 只到部分尺码：未到的尺码不留任何记录` | ✅ |
| □ | 重复点「是」/ 重复投递 → 幂等 | `§5.2 重复点「是」…`、`幂等（任务层）…` | ✅ 会话层 + 任务层各一道 |

### 其它已覆盖的不变量

- 入口开关关掉时：一句话都不记、一张表都不写（`对话到货开关…`）。
- 认不出是哪一批时：不进到货核对、不调模型、反问那一句（`接线：认不出是哪一批时…`）。
- 模型给的行号越界/数量非法：忽略并记日志，绝不自己编一条明细（`异常③ 模型给的行号越界…`）。
- 行号全都对不上基准：不入库、回一句（与"全没到"分开）（`模型给的行号全都对不上基准…`）。
- 模型调用失败：不猜、不写、不追问（`模型调用失败…`）。

---

## 6. 已知的坑与边界

- **已知 flaky（不是本次引入）**：`test/purchaseReturnBatch.test.js` 的
  「⑦ 单独一条（窗口内没有同伴）…」（归批窗口 vs 出图竞态，`images.calls.length` 偶发 0）。
  另有他人在修，本次**不碰它**；遇到就重跑。
- **本地数据目录**：会话记录写在 `server/data/arrival_conversations/`（**不写业务表**，
  与 `data/purchase_group_messages/` 同一个性质：机器人的路由/上下文信息）。
  该目录不入库（`server/data` 本来就不在版本库里）。
- **未做真实写入 E2E**：本机没有测试 Base 的凭证（`.env` 不存在），所以本次只跑
  **项目代码的离线测试**。要跑真机自测，按 `AGENTS.md` 第 7 条走
  `server/scripts/e2e-run.mjs`（测试 Base，禁用 CLI），且**部署/合并前先问她**。
- **`AGENTS.md` 一行待同步**：见第 1 节末尾（`PURCHASE_ARRIVAL_INTAKE_ENABLED` 已有读取点）。
