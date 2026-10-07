# 放开「定金单只支持一条明细」：一张单多明细 · 交易类型按明细行 · 整单多选

> 业务负责人口径（2026-10-07，逐字）：
> 「它就应该**分两条销售明细，然后三条收款明细**，为什么分不了呢？**这就是一个人买的呀**」
> 「如果我们的交易类型可以多选的话，实际上这一笔是不是**既属于现货，又属于预付**呀？
>  **在销售明细里面分开，它是现货还是预付款，不就可以了吗？**」
> 「那个"交易类型"字段，它是一个**关联引用字段**……**如果它包括多种交易类型，你多选就行了**。
>  **但是实际到我们的销售明细里面，就这一单它是什么，那就是什么**」

---

## 0. 先写「改完之后应该是什么样」（验收标准）

### 真机场景（她 2026-10-07 18:37 一条消息 = 一张单）

```
119 元，微信。
卖了 31678，40 码。
定制一双 6681-1，42 码，定金 50 元，下次付 39 元
```

| # | 验收标准 | 怎么验 |
| --- | --- | --- |
| **AC-1** | 解析出 **一张单**：`items.length === 2` | `normalizeSalesResult` 单测 |
| **AC-2** | 明细① 31678 40码 成交 **119**，类型 **现货**（`SALE_CASH`） | 同上，逐字段断言 |
| **AC-3** | 明细② 6681-1 42码 定制 成交 **89**（定金 50 + 尾款 39），类型 **预付**（`SALE_PREPAID`） | 同上 |
| **AC-4** | 收款 **3 条**：119 微信 已收款 / 50 微信 已收款 / 39 未收款 | 入账后读「收款明细」 |
| **AC-5** | 销售订单（主表）交易类型 = **去重后的多个**（现货 + 预付，2 个关联） | 读「销售主表.交易类型」 |
| **AC-6** | 每一条明细行的交易类型**各自单选**（行① 现货、行② 预付） | 读「销售明细.交易类型」逐行 |
| **AC-7** | **不拆单**：销售主表只新增 **1** 条记录 | 读「销售主表」记录数 |
| **AC-8** | 现货件**被交付 + 扣库存**（履约状态=已交付、库存流水 1 条） | 交付后逐条断言 |
| **AC-9** | 预付件**不交付**（履约状态仍=未交付、无库存流水） | 同上 |
| **AC-10** | 错误 / 缺项为空（`missing_fields === []`，`failureReason === ''`） | 同上 |
| **AC-11** | 「定金单暂只支持一条明细」这条判据**确实被放开**：该串**不再出现在源码里**，真机场景不再报它 | 源码级断言 + 行为断言 |
| **AC-12** | 单类型单（只有现货 / 只有未付 / 只有预付，且**一条明细**）行为**逐字不变**（哨兵） | 既有用例 + 显式哨兵 |
| **AC-13** | 金额口径（#231：总额 = 各分项之和；对不上就问、不入账）**不破** | 既有用例 + 显式断言 |
| **AC-14** | 「跑不跑 B / 交不交付」的判据**取值从整单改成逐明细**，来源仍是配置 | 单测：混合单里现货件跑 B、预付件不跑 |

### 明确**不变**的东西（同一条改动里不许动）

- 赠品不参与金额；收款方式由她说的算；只有定金不能当成交额；
- 缺项追问路径（她那种输入若还缺东西 → 照旧走既有缺项路径）；
  **但「多明细 + 定金」本身不再是缺项**；
- 交付 / 扣库存 / 入账的**底层写入口径**（只改「按哪一行的类型决定」这一层）；
- 单类型单的对外表现（文案、写入形状、交付与否）。

---

## 1. 「定金单只支持一条明细」判据在哪

**位置**：`server/src/services/doubaoService.js:284`，在 `normalizeSalesResult` 内、
`depositTerms(sourceText)` 那段里的**只有尾款时**分支：

```js
if (deposit.tailAmount && items.length !== 1) {
  // 定金 + 尾款的推导只对「整单一条明细」成立：多行时无法判断尾款属于哪一件。
  deposit.issues.push('定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额');
}
```

它是一条**整单粒度**的护栏：`items.length !== 1` 就拒绝，于是真机那条消息
（2 条明细 + 定金 + 尾款）直接进缺项、**不出卡片**。

提示词里**没有**这条判据；`larkMvpService` 里也没有。全仓唯一出处就是这一处
（`grep -rn "定金单暂只支持一条明细"` 只命中它 + 测试）。

---

## 2. 改法（分层）

### 2.1 配置层（配置先行）

- `config/salesMovements.js`（既有冻结注册表）新增 `deliversForTradeType(code)`：
  「这一行的交易类型要不要交付」——由 `SALES_MOVEMENTS[code].delivery` 推出，
  **不散落 `=== '预付'`**。
- `config/salesTradeTypePolicy.js`（既有冻结注册表）新增：
  - `itemTradeTypeCode(item, orderTradeTypeCode)`：**逐明细**的交易类型编码。
    明细自带 `trade_type_code` / `trade_type` 优先 → 退回整单 → 再退回 `SALE_CASH`（与解析层同一兜底）。
  - `orderTradeTypeCodes(items, orderTradeTypeCode)`：**整单去重后的多个编码**
    （按明细行出现顺序，天然去重）。
- `config/salesDeliverySummary.js`（新增）：混合单的「交付结果」文案
  （全交付 / 全未交付 / 部分交付）。单类型单用的仍是**逐字不变**的两句。

### 2.2 解析层 `doubaoService.normalizeSalesResult`

- 提示词规则 2 改成**逐明细**：`items[].trade_type`，并把「定金属于它紧挨着的那一件」说清；
  整单 `trade_type` 保留（全同 → 同值）。
- 规范化：每件明细落 `trade_type`（中文）+ `trade_type_code`（`SALE_CASH/UNPAID/PREPAID`）。
- **删掉那条整单护栏**，换成：定金 + 尾款落到**那一件预付明细**上
  （`itemTradeTypeCode === 'SALE_PREPAID'` 且**唯一**）；
  说不清（0 件或多件预付）→ 报一句**新的**、可补的缺项（不是原来那句）。
- 多明细时的收款处理：**保留**别的收款（如现货那笔 119），只修正定金那笔的方式、
  并丢掉「未付的尾款」那笔（尾款不是已收款）。

### 2.3 接线层 `larkMvpService`

- 逐明细算自己的 `trade_type_code`，据此：
  - **跑不跑 B（实时库存）**：`salesParseRuns(itemCode,'stock')` —— 逐明细；
  - **颜色候选范围**：`salesColorOptionsScopeFor(itemCode)` —— 逐明细；
  - `needs_color` 的颜色选择回来时（`choose_sale_color`）也用**该行**的类型判。
- 主表「交易类型」写**去重后的多个关联**（`orderTradeTypeCodes`）。
- 交付：只把**该交付的那些明细行**的交割 id 交给 `delivery.deliver`；
  全都不交付 → **不调用**（与既有纯预付单逐字相同）。

### 2.4 入账层 `salesOrderService`

- 每条明细行写**自己的**交易类型关联（由 `input.items[].tradeTypeCode` 解析；
  缺省 → 退回读主表第一条，与既有行为**逐字相同**）。
- 主表交易类型不再假设单条（读回来的关联列表照旧用 `linkedRecordIds`）。

### 2.5 明确**不碰**

`pendingDealPush*` / 战报 / `app.js` / 颜色候选那批。

⚠️ **已知的下游影响（本次刻意不改，按边界要求上报）**：
`secondDeliveryService` 给「待处理单推送」分区时用**整单第一个**能认出的交易类型
（`tradeTypeIds.find(...)`）。混合单（现货 + 预付）里若现货在前，这一单会**落不到**
「预付 / 未付」两个区块里 —— 这是**新增场景的新缺口**（改动前混合单根本不出单），
不是既有行为回退。修它要动 `pendingDealPush*`，**属于本次边界外**，需要另开一条串行任务。

---

## 3. 逐条对照（验收标准 → 实现 → 证据）

验收用例落在 `server/test/salesMultiLineTradeType.test.js`（10 条）。
② 里那批走的是**真实链路**：真 `V1ReferenceResolver` + 真 `SalesOrderService` +
真 `SalesDeliveryService` / 真 `InventoryService`，只有「发卡片 / 发文字」两个出口打桩。

| # | 验收标准 | 实现位置 | 证据（用例 / 断言） |
| --- | --- | --- | --- |
| AC-1 | 一张单、`items.length === 2` | `doubaoService.normalizeSalesResult` | `AC-1~AC-10` 场景用例 |
| AC-2 | 明细① 31678 40码 成交 **119**、类型 **现货** | 同上（逐明细 `trade_type` / `trade_type_code`） | 同上：`['31678',40,119,'现货','SALE_CASH']` |
| AC-3 | 明细② 6681-1 42码 成交 **89**、类型 **预付** | 定金+尾款落到**那一件预付明细**（`depositTargetIndex`） | 同上：`['6681-1',42,89,'预付','SALE_PREPAID']` |
| AC-4 | 收款 **3 条**：119 已收 / 50 已收 / 39 未收 | 解析层保留多笔收款 + 既有「owed ↔ 成交−已收」对账补未收款 | 同上：`[[119,'已收款'],[50,'已收款'],[39,'未收款']]` |
| AC-5 | 主表交易类型 = **去重多选**（现货+预付） | `larkMvpService` 用 `orderTradeTypeCodes` 解析出多个记录 id，`relation([...])` 写入 | 同上：`交易类型 === ['bhv_cash','bhv_prepaid']` |
| AC-6 | 明细行**各自单选** | `salesOrderService` 逐行 `tradeTypeRecordIdForItem(item.tradeTypeCode)` | 同上：`[['bhv_cash'],['bhv_prepaid']]` |
| AC-7 | **不拆单**（主表 1 条） | 未改建单入口（仍然一条销售主表 + 多条明细） | 同上：`entryRows.length === 1` |
| AC-8 | 现货件交付 + 扣库存 | `larkMvpService` 只把可交付行的 detail id 交给 `delivery.deliver` | `AC-8/AC-9`：履约状态 `['已交付','未交付']`、库存流水 1 条、`关联销售=[现货行]`、门盒那双被扣掉 |
| AC-9 | 预付件不交付 | 同上（预付行不进 `deliverableDetailIds`） | 同上：预付行履约状态仍 `未交付`、它没有库存流水 |
| AC-10 | 缺项 / 错误为空 | 删掉那条整单护栏 | 同上：`missing_fields === []`、`task.status === 'posted'` |
| AC-11 | 那条判据**确实被放开** | `doubaoService.js` 里的护栏已删；新增「哪一件是预付说不清」的可补追问（进 config） | `AC-11`（逐文件断言：`src/` 下只剩历史注释那一处）＋ `AC-11b` |
| AC-12 | 单类型单**逐字不变**（哨兵） | `itemTradeTypeCode` 的整单回落 + `deliverableItemIndexesOfDraft` 的老草稿兜底 | `AC-12`（现货 / 未付 / 预付 各一条）＋ `AC-12b`（取值）＋ `AC-12c`（交付结果那两句话**逐字**） |
| AC-13 | 金额口径（#231）**不破** | **未动**：总额 = 各分项之和；对不上只报缺项、绝不改金额 | `doubaoSalesParser.test.js` 里「总额 + 各分项」「分项之和 ≠ 总额」「多双只给整单实收」等既有用例**全绿**（一个字没改） |
| AC-14 | 判据取值**从整单改成逐明细**、来源仍是配置 | `salesParseRuns` / `salesColorOptionsScopeFor` 逐行取 `itemTradeTypeCode` | `AC-14`：`stockLookups === ['31678']`（预付那件一次都不查） |

### 3.1 单类型单「逐字不变」的哨兵证据

- `AC-12` 三条：整单 `trade_type_codes` 仍只有一个；主表关联长度 1；明细行关联长度 1；
  履约状态分别为 现货=已交付 / 未付=已交付 / 预付=未交付（与改动前一致）。
- `AC-12b`：`orderTradeTypeCodes(items, code) === [code]`、`itemTradeTypeCode(item, code) === code`；
  **认不出来 → 空串**（不兜成现货 —— 这条恰好是既有用例 `⑥b` 钉住的，见下）。
- `AC-12c`：`salesDeliverySummaryFor(1,1).card === '已交付并扣库存。'`、
  `(0,1).card === '尚未交付，库存未扣减。'`（**逐字沿用**改动前写死在 `larkMvpService` 的两句）。

### 3.2 ⚠️ 因口径变更改掉的**既有**用例（逐条说明为什么不是放宽）

| 既有用例 | 改动 | 为什么**不是放宽** |
| --- | --- | --- |
| `doubaoSalesParser.test.js`「a deposit order with several lines is refused instead of dropping the unpaid balance」 | 改名 + 改成「不再拒绝」：断言**不含**旧报错串、`items[0].actual_amount === 240`、`agreed_total === 279`、`owed === 140` | 原来这一单**算不出应收**（`agreed_total === ''`，240 被静默算丢）且整单被拒；现在应收落到那一件鞋上、整单 = 各分项之和。**从"丢钱"改成"钱算对了"**，是收严 |
| `doubaoSalesParser.test.js`「[当前行为·待修复] mixing an accessory into a deposit order loses the receivable and demands a size」 | `agreed_total` 由 `''` → `279`（其余断言保留） | 同上：**应收不再被丢掉**；`items[1].size` 那条**保留**（"腰带没被标成配品"是**配品识别**的问题，不属本次口径，故意不动） |
| `salesPrepaidColorResolution.test.js` 的 `A_PROVIDES_CANDIDATES_ITEM` | 由常量改成函数，把新增的 `trade_type` / `trade_type_code` **逐字写进期望** | 仍然是**精确 deepEqual**（字段一个不多一个不少）。原来靠"整单一个类型"，混合单根本表达不出来；现在**逐行**断言得更死 |
| `salesProcessingCard.test.js`（未改，只是我一度弄红） | **一行没改** | 它钉的是"老草稿（明细不带类型、`delivery_status='未交付'`）"必须仍说「尚未交付」—— 我据此给 `deliverableItemIndexesOfDraft` 加了**整单兜底**，反而把这条既有断言保住了 |

### 3.3 先红后绿

在 `origin/main`（未改任何代码）的临时 worktree 里只放新用例 + 一个纯配置新文件，跑：

```
✖ AC-1~AC-10 …  ✖ AC-8/AC-9 …  ✖ AC-14 …  ✖ AC-11 …  ✖ AC-11b …
✖ AC-12（现货）× 3 …
ℹ tests 10 · pass 1 · fail 9
```

AC-1 的实际报错（**就是她描述的那个现状**）：

```
AssertionError: 不许再有缺项：
["定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额",
 "items[1].actual_amount",
 "库存里没有 6681-1 42码（这个货号现在一双都没有）",
 "请逐件说明成交金额"]
```

本分支：`pass 10 · fail 0`。

### 3.4 CI 三项实际输出（PR #234，head `15b2405`）

```
Analyze (javascript-typescript)  pass  57s
CodeQL                           pass   2s
test                             pass  53s
gh pr view 234 --json mergeStateStatus → CLEAN
```

### 3.5 全量测试

`cd server && node --test --test-concurrency=1`（在**独立 worktree**里跑，不在主工作区）：

| 次 | tests | pass | fail |
| --- | --- | --- | --- |
| 1 | 1108 | 1108 | 0 |
| 2 | 1108 | 1108 | 0 |
| 3（AC-11 收严后） | 1108 | 1108 | 0 |

---

## 4. ⚠️ 不确定处 / 明确没做的

1. **与 `fix/sales-missing-info-wording` 有真实合并冲突**（**实测**，不是推测）：
   只有 `server/src/services/larkMvpService.js` **1 处** —— 同一个 `update` 的相邻两行
   （它改 `failureReason`，我改下一行 `tradeType`）。`docs/README.md` **能自动合**。
   冲突解法是纯机械的两行并存。**已上报 Lead 定序，本 PR 不自行合并。**
   ⚠️ 另核过：它**没有**碰 `doubaoService.normalizeSalesResult`（brief 里担心的那个点不存在）。
2. **「定金收 50 的收款方式」来自模型**：她那条原话只在开头说了「微信」，定金那句没说方式。
   期望里 50 是微信 ⇒ **依赖 AI 把整条消息的收款方式带到定金那笔上**（`payments[1].method`）。
   后端**没有**做"从别的收款方式推断定金方式"（那属于"猜"，AGENTS.md 第 16 条禁止）。
   若真机上模型给 `method:""`，会走既有缺项路径问「请明确本次定金的支付方式」——**不会静默写错**。
3. **待处理单推送的分区**在混合单上会漏（见 2.5）。**按边界没动** `pendingDealPush*`。
4. **明细行的交易类型不参与幂等比对**：`salesOrderService` 的行匹配仍然比
   `关联货品 / 尺码 / 成交金额 / 赠品`（**这一层刻意没动**，避免把重试变成"与草稿不一致"）。
   后果：改动**之前**已经写过、且当时按"主表第一条"写错类型的明细行，重试时**不会被纠正**。
   新股不受影响。
5. **`relation()` 现在也认数组**（多选关联的写入形状只定义一处）。既有调用点全传字符串，
   行为不变；已由全量测试覆盖。
6. **本地 worktree 的 `.env` / `server/node_modules` 两个临时软链仍然留着** ——
   因为合并冲突的 rebase 收尾还要在这个 worktree 里跑测试。收尾（合并后按 AGENTS.md 第 14 条
   删 worktree）时一并删掉即可；它们都是 gitignored，不会进提交。

