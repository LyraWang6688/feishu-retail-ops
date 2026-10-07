# 「点确认」这件事在卡片上一眼可见（ⓐ 方案）

业务负责人 2026-10-07 拍板（逐字）：

> 「**我点击了确认后，卡片其实没变化，就会很让我迷惑，到底点击没点击**，
>  目前消息卡片更新是在什么时候呢？看着像是整个流程走完才变化」

她**只选了 ⓐ**：「**只用A就可以了！**」
（ⓐ = 「点确认后立刻卡片刻变【明显不同】：标题『⏳ 正在写入…』+ 把明细变灰/加"处理中"」；
她**不要** ⓑ 分阶段进度、**不要** ⓒ 只加一句提示。）

## 已查清的事实（复核过，本次不重复查）

- 2026-10-07 15:27:42.900 她点「确认」→ **0.3 秒后**代码就更新了卡片：
  `lark.sales.card.update.succeeded stage:"processing"`（API 层成功）。
- 15:29:24.454 才更新到 `stage:"posted"`（「销售订单已入账」）—— **间隔 1 分 42 秒**。
- **她没看出变化的原因**：中间那版 `salesStatusCard(task.draft, '销售订单处理中', …)`
  的**明细行与确认卡片一模一样**（`itemLines(draft.items, 'actual_amount')`），
  只有顶部标题和一行 note 变了。

## 改完之后应该是什么样（验收标准）

| # | 标准 | 怎么验 |
| --- | --- | --- |
| 1 | 点「确认」后**那一次**更新（`stage: 'processing'`）的卡片，**标题是醒目的"处理中"**（默认含 `⏳` 与「处理中」「正在写入」，**可配**） | 测试断言 `header.title.content` 等于配置里的 `title`；默认值断言含 `处理中` |
| 2 | ⭐ **明细区与确认卡片明显不同**：整段明细被 `<font color='…'>` 包住变灰（颜色可配），**并且**多一行醒目的处理中提示（文案可配） | 断言明细元素内容 ≠ `salesConfirmationCard` 的明细内容，且以 `<font color='grey'>` 开头、`</font>` 结尾；断言存在处理中提示行 |
| 3 | **保留**现有那句 note（「已收到确认，正在写入销售记录和收款；请勿重复点击。」） | 断言 note 元素逐字等于原句 |
| 4 | **按钮收起**的既有行为保留（处理中卡片没有任何按钮） | 断言元素里没有 `action` / `column_set` |
| 5 | `stage` 仍是 `'processing'`（日志与既有测试依赖它） | 断言 `lark.sales.card.update.succeeded` 日志里的 `stage === 'processing'` |
| 6 | `stage:'posted'` 的**终态卡逐字未变**（她满意那张） | 断言 posted 卡片的 header / 明细 / note 与改动前逐字相同（`salesStatusCard` 渲染没有被动过） |
| 7 | 配置先行：标题 / 颜色 / 处理中那行文案 / note 全部可配，逻辑里**没有**写死的中文字面量 | 新增配置模块 `server/src/config/salesProcessingCard.js`；单测直接传 env 验证覆盖生效 |
| 8 | 🔴 只改显示：`postSale` / 状态写入 / 明细 / 收款 / 库存**一个字节都没动** | diff 只碰卡片渲染 + 新增配置 + 测试 + 文档 |

## 边界（不做的事）

- ⛔ 不做「分阶段进度更新」（ⓑ）—— 她明确不要。
- ⛔ 不改「已入账」终态卡（`stage:'posted'`）的文案与结构。
- ⛔ 不改「样品补选」流程的卡片（`sampleReplacementCard` / `sampleReplacementProcessingCard` 等）。
- ⚠️ 只有**销售确认**这条链路（`confirm_sale` 家族 → `updateSalesActionCard(..., {stage:'processing'})`）被改。

## 定位（为什么是这么改）

- 老写法：`salesStatusCard(task.draft, '销售订单处理中', '已收到确认，…')` —— 一个**通用**结果卡渲染器。
- 新写法：新增**专用**渲染器 `salesProcessingCard(draft, resolvedConfig)` ＋ 专用配置模块。
  `salesStatusCard` **一行不动** ⇒ 取消 / 待修正 / 部分交付 / 已入账 / 重复终态这些卡片的
  字节级输出**完全不受影响**（标准 6 靠这一条成立）。
- 配置在**调用时**解析（`resolveSalesProcessingCardConfig(process.env)`），不在模块加载时求值 ——
  避免 2026-10-06 那个 dotenv 加载顺序事故。

## 配置键

见 `server/src/config/salesProcessingCard.js`（键名 / 默认值 / 语义都在那里，且有 `.env.example` 说明）：

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `SALES_PROCESSING_CARD_TITLE` | `⏳ 销售订单处理中 · 正在写入…` | 卡片标题 |
| `SALES_PROCESSING_CARD_TEMPLATE` | `blue` | 卡片头颜色 |
| `SALES_PROCESSING_CARD_ITEM_COLOR` | `grey` | 明细区变灰用的飞书颜色名（空串 = 不套颜色） |
| `SALES_PROCESSING_CARD_PROGRESS_LINE` | `⏳ 正在写入销售记录与收款…` | 明细上方那行提示（空串 = 不出这行） |
| `SALES_PROCESSING_CARD_NOTE` | `已收到确认，正在写入销售记录和收款；请勿重复点击。` | 卡片底部 note（逐字沿用原句） |

取值规则与 `privateChatNotice` / `salesDailyReportPush` 同一套（`config/envValue`）：
**没设** → 默认值；**设了**（含空串）→ 显式取值。

## 改完之后长什么样（文字示意）

点「确认」后**立即**（0.3 秒那次更新）——

```
┌──────────────────────────────────────────┐
│ ⏳ 销售订单处理中 · 正在写入…              │   ← 标题（可配）
├──────────────────────────────────────────┤
│ ⏳ 正在写入销售记录与收款…                 │   ← 新增的醒目提示行（可配）
│ ⟨灰⟩ 1. A100 38码 × 1 ￥99                │   ← 明细整段变灰（颜色可配）
│      2. A100 39码 × 1 ￥99                │
│                                          │
│ 已收到确认，正在写入销售记录和收款；请勿重复点击。 │   ← note 逐字不变（可配）
└──────────────────────────────────────────┘
   （没有任何按钮 —— 与改动前一致）
```

对照「改之前」：标题只从「请确认销售订单」变成「销售订单处理中」、
明细**与确认卡片一模一样**、只有一行小字 note 变了 ⇒ 她看不出来。

## 逐条对照（实现 + 证据）

| # | 标准 | 证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 标题醒目「处理中/正在写入」且可配 | `config/salesProcessingCard.js` 默认标题；`test/salesProcessingCard.test.js` 断言标题来自配置且含 `处理中`/`正在写入` | ✅ |
| 2 | 明细区与确认卡片明显不同 | 明细套 `<font color='grey'>`（可配）＋ 多一行提示；测试用**两件明细**（此时两边明细文字本来相同）证明差别来自"变灰" | ✅ |
| 3 | note 逐字保留 | 默认值 = 原句；测试逐字断言 | ✅ |
| 4 | 按钮收起 | 新卡片不生成 `action` / `column_set`；测试断言无按钮 | ✅ |
| 5 | `stage` 仍是 `processing` | 调用点 `{ stage: 'processing' }` 未动；测试抓真实日志断言 `lark.sales.card.update.succeeded` 的 stage 依次为 `processing` → `posted` | ✅ |
| 6 | `posted` 终态卡逐字未变 | 终态卡仍走 `salesStatusCard`（**该函数一行未改**）；测试逐字 deepEqual 终态卡 | ✅ |
| 7 | 配置先行 | 5 个键 + `config/salesProcessingCard.js`；逻辑里无中文文案字面量（文案全在配置） | ✅ |
| 8 | 只改显示 | diff 仅：新配置模块 / `larkCards.js` 新增函数 / `larkMvpService.js` 那一行调用 + import / 测试 / 文档 / `.env.example` | ✅ |
| 9 | 无放宽既有断言 | 既有测试文件**一行未改**（原 `/处理中/` 断言保持通过） | ✅ |

## 边界（不做的事）

- ⛔ 不做「分阶段进度更新」（ⓑ）—— 她明确不要。
- ⛔ 不改「已入账」终态卡（`stage:'posted'`）的文案与结构。
- ⛔ 不改「样品补选」流程的卡片（`sampleReplacementCard` / `sampleReplacementProcessingCard` 等）。
- ⚠️ 只有**销售确认**这条链路（`confirm_sale` 家族 → `updateSalesActionCard(..., {stage:'processing'})`）被改。
