# 验收口径：「已完毕」问不出方式时的收口 ＋ 退款写她说的方式（2026-10-06）

> ⭐ 按业务负责人的流程（`AGENTS.md` 第 2 条）：**先写「按我们的链路应该实现的效果」，再跑，再逐条对照**。
> 口径出处：`AGENTS.md` **第 16 条**（业务负责人 **2026-10-06 拍板并纠正过口径**）。
> 本文件先写"应该是什么样"（第 0–2 节），跑完再把**实测证据**填进第 3 节。

## 0. 口径原文（AGENTS.md 第 16 条，逐字）

**(1) 收款方式：用户【会主动说】—— 系统不猜、也不设默认。**

> 「**不会，用户会说到交易方式的！**」
> 「如果涉及到收钱的话，**用户会直接告诉收款方式的**。比方说，
>  **定金通过微信收到，然后尾款通过微信收到，或者尾款通过现金收到**」

- ⭐ **用户说了方式 → 就用他说的**（可能一单里**每一笔方式不同**：定金微信、尾款现金）。
- 🔴 **不要"按默认方式收口"** —— 那是我理解错的版本，**别实现它**。
- ⚠️ **但仍要修那个真 bug**：现在光说「已完毕」时 `applyComplete` 只回问一句就 `return`，
  **钱货都不动**，上层却记成 `progress_applied`（**看起来成功了**）。两处都要改：
  - ① **状态如实**：什么都没写就不要记 `progress_applied`（用 `progress_asking` 之类）；
  - ② **先把"货那一半"做掉**（未交付→已交付 + 扣库存），再就"钱"回问一句。

**(2) 退款方式：写【她实际说的方式】，不沿用原单。**
「钱退现金」→ 记录里的「交易方式」就写**现金**；若她没说方式，再按现有逻辑处理并注释说明。

## 1. 本次**不做**的事（口径纠正后明确排除）

| 不做 | 为什么 |
| --- | --- |
| ❌ 新增"默认收款方式"配置项（`SALES_*_DEFAULT_*` 之类） | 第 16 条原话：「**不要"按默认方式收口"—— 那是我理解错的版本，别实现它**」 |
| ❌ 「优先沿用该单已有的收款方式」 | 同上；且她说「定金微信、尾款现金」——沿用会把**这一笔**的方式记成**上一笔**的 |
| ❌ 让"问不出方式"时**不交付**货 | 第 16 条②要求「先把货那一半做掉」 |
| ❌ 删掉 `settleCash` 的兜底（她没说方式时沿用原单） | 第 16 条(2)：「若她没说方式，再按现有逻辑处理」 |

## 2. 验收清单（逐条对照；✅ = 实测通过）

### (1) 话题里说「已完毕 / 成交」且**问不出**收款方式

前置：已入账的销售 + 一条「未收款」记录；`收款方式管理` 里**有多个**收款方式；
她这句话里**没提**方式。

| # | 应该发生什么 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1.1 | **货那一半先做掉**：未交付明细 → 「已交付」+ 扣库存 | 交付服务被调用，`detailRecordIds` = 未交付的那些 | ✅ `delivered.length===1`、`detailRecordIds===['detail_1']` |
| 1.2 | **钱那一半回问一句**（不替她挑方式、也不动钱） | 回复里含"这笔钱是怎么收的"；`收款明细` **没有** create / update | ✅ 两个数组都为空 |
| 1.3 | 🔴 **任务状态如实**：`progress_asking`（**不是** `progress_applied`） | `store.get(task_id).status` | ✅ `progress_asking`，`progress_reason='payment_method_missing'` |
| 1.4 | 日志写清"我在问她方式" | `sales.thread_progress.complete_asking_method` | ✅ 见第 3 节实测日志 |
| 1.5 | 她**说了**方式时行为不变：走 `SecondDeliveryService.confirm` | `confirm` 被调用，`method` = 她说的那个 | ✅ 「成交 微信」→ `method='微信'`（不是库里排第一的） |
| 1.6 | 钱货都齐时说「成交」→ 只补交付、不问她方式 | 回复不含"怎么收的" | ✅ 既有用例「已完毕…不重复写」仍绿 |
| 1.7 | 货早就交完了、只有钱没定 → **不空跑交付** | 交付服务**不**被调用 | ✅ `delivered===[]` |

### (1b) 「问一句」这条路上的**状态如实**（同一类假成功）

| # | 应该发生什么 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1.8 | 「收到 500」（没说方式）→ 回问一句 → `progress_asking` | `status` | ✅ `progress_asking` / `payment_method_missing` |
| 1.9 | 「收到微信 500」但方式表里没有 → 回问一句 → `progress_asking` | `status` | ✅ `progress_asking` / `payment_method_unknown` |
| 1.10 | 「这一笔还没入账」→ 只回问一句 → 也是 `progress_asking` | `status` | ✅ 同口径（同一段逻辑） |

### (2) 售后「钱退现金」→ 收款明细的「交易方式」写【现金】

| # | 应该发生什么 | 判据 | 结果 |
| --- | --- | --- | --- |
| 2.1 | 她说「退我现金」→ 方案里 `payment_method='现金'`；没说 → 空 | 方案字段 | ✅ 现金 / 微信 / 空 三例都对 |
| 2.2 | 执行后「交易方式」= **现金**（原单是微信也照写现金） | `fields['交易方式']` | ✅ `['method_cash']`，`method_source='spoken'` |
| 2.3 | 她**没说**方式 → 沿用原单方式（现有逻辑，带注释） | `fields['交易方式']` | ✅ `['method_wechat']`，`method_source='original'` |
| 2.4 | 执行器请求指纹含 `paymentMethod`：重试时方式变了不能被当成同一次 | `fingerprintOf` | ✅ 现金→微信 → 报「请求内容与上次不同」，零新增写入 |
| 2.5 | 她说了表里**没有**的方式 → **大声拦住**（不静默写成原单方式） | 错误/回话 + 零写入 | ✅ 方案期：回话含「收款方式管理」「刷卡」、业务表零写入、不出卡片；执行器侧：抛「收款方式管理中找不到：刷卡」、收款明细零写入 |

### 纪律项

| # | 要求 | 结果 |
| --- | --- | --- |
| 3.1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** | ✅ 876 / 876，连跑 2 次都 `fail 0`（共 12 次全绿，1 次偶发见第 5 节第 5 条） |
| 3.2 | **真启动一次**，`GET /health` 200 | ✅ `HTTP=200`（另 `/api/lark/events/health` 也 200），启动日志零 error |
| 3.3 | 未碰：`config/salesStatus*` 值域 · `v1BitableSchema.js` · `inventoryService.js` · `public/workbench/*` | ✅ 改动文件清单见第 4 节 |
| 3.4 | 未用飞书 CLI；未写生产 Base；未打印 secret | ✅ 全部为单元测试（假 Base）+ 本机真启动，无任何远端写入 |

## 3. 实测证据（跑出来的，不是推理的）

### (1) 「已完毕」不带方式时**真的发生了什么**

```
{"event":"sales.thread_progress.detected","kind":"complete","reason":"complete_cue:已完毕"}
{"event":"sales.thread_progress.complete_asking_method",
 "sales_entry_record_id":"entry_thread",
 "delivered_quantity":1,"delivered_detail_ids":["detail_1"],
 "hint":"她没说收款方式、「收款方式管理」里也不是唯一一个 → 先做货、钱回问一句，不猜方式"}
```

- 她收到的那句话（实测文案，`{count}` 已填 1）：
  > 好，还没交的 1 双记成已交付了。这笔钱是怎么收的？说一句（例：收到微信 500）我再记账。
- 本地任务记录（`data/lark_mvp_tasks`，**不写业务表**）：
  `status = progress_asking`、`progress_kind = complete`、`progress_reason = payment_method_missing`
  （**改动前**这里是 `progress_applied`，而钱货一个字都没动）
- 收款明细：**没有** create、**没有** update（一个字节都没写）。

### (2) 退款方式的实测落库值

```
{"event":"after_sales.cash.method","method_source":"spoken","spoken_payment_method":"现金","payment_record_id":"rec_3"}
{"event":"after_sales.executed","money_route":"cash","money_method_source":"spoken","money_method_id":"method_cash","stock_rows":["SALE_RETURN:门盒:1"]}
```

- 她说「退我现金」→ `收款明细.交易方式 = ['method_cash']`（原单是 `method_wechat`）。
- 她没说方式 → `收款明细.交易方式 = ['method_wechat']`（沿用原单），`money_method_source = "original"`。

## 4. 本次改动的文件（写作用域）

- `server/src/services/salesThreadProgressService.js` —— (1) 主改动：`applyComplete` 先做货再问钱、
  抽出 `deliverUndelivered`（与"交付进展"共用一段）、各"只回问一句"的分支标 `asked`
- `server/src/config/salesProgressIntake.js` —— (1) 配置先行：新增文案 `completeAskMethod`
  ＋ 状态名常量 `PROGRESS_TASK_STATUS`
- `server/src/config/afterSalesFlow.js` —— (2) 「她说的收款方式」词表 + `resolveAfterSalesPaymentMethod`
- `server/src/services/afterSalesFlowService.js` —— (2) 方案带上 `payment_method`、核实它存在、传给执行器
- `server/src/services/afterSalesService.js` —— (2) `settleCash` 写她说的方式（没说才沿用原单）、进指纹
- `server/test/salesThreadProgress.test.js` · `server/test/afterSalesFlow.test.js` ·
  `server/test/afterSalesService.test.js` —— 对照上表
- `server/scripts/e2e-sales-status.mjs` —— 自测脚本的"终态"清单补上新状态 `progress_asking`
  （不补的话它会干等 4 分钟、把"她在等一句方式"报成"超时"）

## 5. 已知不确定处（如实说）

1. **顺序**：`AGENTS.md` 第 16 条①要求"先做货、再就钱回问一句"，本次**只在"问不出方式"这条路上**
   按这个顺序做（先 `deliver`、再无钱回问）。她**说了**方式时走的仍是
   `SecondDeliveryService.confirm`，它内部是**先收款、再交付** —— 那是既有实现里写明的业务口径
   （"钱没记上就不该把货记成已交付"），且点卡片那条路也用同一个 `confirm`；
   本次**没有**动它的顺序（动了会同时改掉点卡片那条路）。
2. **售后确认卡片的文案**：cash 一律显示「退现金」（`larkCards.afterSalesSettlementLabels`）——
   她说"退我微信"时卡片仍写"退现金"。本次按第 16 条只改**记录里的交易方式**，卡片文案未动。
3. **"什么都没写"的边界**：本次把三类"只回问一句 / 只让她先去入账"的结果都标成
   `progress_asking`（没说方式、方式表里没有、这一笔还没入账）。而
   「收款和交付都已经齐了，我没有重复写」与「这一单已经是成交状态了」这两类**终态**仍是
   `progress_applied` —— 它们不是"回问一句"，且对应回复本身已如实说明；如果业务负责人认为
   它们也该算 `progress_asking`，改一处即可（`nothing_pending` / `already_completed`）。
4. **方式词表**：`config/afterSalesFlow.js` 里那份词表与销售话题链路的
   `config/salesProgressIntake.paymentMethodAliases` 是同一批说法，**两处各自持有一份是刻意的**
   （解耦：任一条链路被拿掉，另一条还活着）。改说法要两处一起改，已有用例钉住售后这一份。
5. ⚠️ **观察到 1 次偶发**（不是本改动引入的，如实记）：连跑过程中有 **1 次**全量结果变成
   `tests 811 / pass 810 / fail 1`，其余 **12 次**都是 `876 / 876 / fail 0`（含 2 次**不带 `.env`**、
   更接近 CI 条件的跑法）。811 = 876 − 66，而 `test/purchaseWebhookService.test.js` 恰好 66 条用例
   —— 看起来是那个**文件级**偶发失败（该文件本机**未被本次改动碰过**；本仓库历史上也有
   `fix/purchase-return-test-race` / `fix/return-batch-test-race` 这类竞态修复分支）。
   单独连跑该文件 6 次都是全绿，没能复现；**CI（`gh pr checks`）是绿的**，以 CI 为准。
   取词用"**最后一个命中**"（"退给她 230，微信退"这类方式在句末的说法才对）。
