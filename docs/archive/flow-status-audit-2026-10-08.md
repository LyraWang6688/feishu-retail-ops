# 四条链路现状核查（只读，2026-10-08）

> 起因：业务负责人 2026-10-08 说「**关于我们的换货、退货、抖音团购券，还有我们二次交付的这个逻辑，
> 我觉得其实还没有跑通**」，并担心后续改动会**动到中间的数据处理逻辑**。
>
> 本文回答两件事：
> ① 这四条链路**现在到底通没通** —— 每一条都给 `文件:行` 的代码路径、测试覆盖、**线上日志**证据；
> ② 哪一段是**中间数据处理逻辑**，将来加扫码入口时**一行都不许改**（第八节清单）。

---

## 〇、方法与证据边界（先说清楚我在哪一步只能说"我还没查到"）

| 项 | 本次做法 |
| --- | --- |
| 代码 | **只读**。本地工作区 `dbd0180`，`git rev-list --count HEAD..origin/main = 0`（与 `origin/main` 齐） |
| 线上 | `ssh 43.143.239.42` **只跑 `grep` / `cat` / `ls` / `head` / `tail` / `wc`**；**没有** pm2 / git / 重启 / 写操作 |
| 日志文件 | `/home/ubuntu/.pm2/logs/box2bitable-server-out.log`（stdout）**＋** `box2bitable-server-error.log`（stderr）|
| 日志窗口 | out：`2026-05-31T15:50:17Z` → `2026-10-08T09:54Z`；**无轮转、单文件**，跨重启连续（`server.started` 154 次） |
| 时间换算 | 服务器 TZ = `Asia/Shanghai`，但日志 `ts` 是 **UTC**。本文**一律换算成 +8**（关键处两个都给） |
| 事实表 | 🔴 **本次没有读任何 Base**（硬约束：线上只跑 grep/cat）。⇒ 凡是结论是「**没写 / 没发生**」的地方，我只说**日志这一层的结论**，并明确标注「**未核事实表**」（见第十节）。文中引用 `docs/push-blocks-caliber-2026-10-08.md` 里 2026-10-08 15:00 的只读实测数据时，都会写明那是**别人的核对结果、不是本次核的** |
| ⚠️ 方法坑 | 我必须记一笔：**失败事件只在 error 日志里**（`logWarn`/`logError` 走 stderr）。只看 out 日志会得出「二次交付 0 失败」的**错误结论** —— 实际有 2 次硬失败。下文所有计数**两份日志都算了** |

### 线上代码就是本地这份代码

抽查部署目录 `/opt/box2bitable/server/src/`（`cat`/`grep`）：

- `config/afterSales.js:121` 有 `newLineFulfillmentStatus: AFTER_SALES_FULFILLMENT.DELIVERED`；
- `services/secondDeliveryService.js:18/357/361` 有 `isAfterSalesFulfillment` / `reason: 'after_sales_fulfillment'`；
- `services/paymentService.js:82` 有 `settlePlatformReceipt`，**全仓（含 routes / public）没有任何调用方**。

⇒ 线上 = 本地 HEAD 的语义。（部署时间戳见下面每条链路，用来判断"那次真机跑的是不是补丁后的代码"。）

---

## 一、结论速览

| # | 链路 | 一句话结论 | 线上跑过几次 | 最近一次（+8） |
| --- | --- | --- | --- | --- |
| 1 | **换货** | **通了**（真机 1 次全链成功）；但 2026-10-08 的「新明细行 = 已交付」补丁**线上一次都没跑到**（真机那次比补丁早 8 分钟） | 1 | 2026-10-08 00:03:38 |
| 2a | **退货（销售退货）** | **没通 —— 线上从来没跑过**（执行器 0 次；`SALE_RETURN` 库存动作只有换货那条腿的 1 次） | **0** | — |
| 2b | **退货（采购退货）** | **通了**（出单 → 扣库存 → 出图发群 → 回填附件，全链成功，**0 失败**） | 6 条记录 + 1 个整批（5 条） | 2026-10-07 23:45:43 |
| 3 | **抖音团购券 / 待平台结算** | **半通**：**写入侧通了**（券 → 收款明细 `待平台结算`）；**结算侧根本不存在** —— 没有入口、没有按钮，「确认到账」0 行代码 | 写入 1 笔 / 结算 **0** | 写入：2026-09-27 16:20:54；结算：**从未** |
| 4 | **二次交付** | **半通**：「收尾款 + 交付」通了（4 次，**全部**来自群话题说「成交」）；**「每日提醒卡」这一半没通**（**0 次发送成功**，2 次 HTTP 400 硬失败）⇒「点卡片成交」这条腿线上**从未被走过** | 成交 4 / 提醒卡发送 0 | 成交：2026-10-08 14:31:28；提醒卡：2026-10-08 09:05:20（失败） |

**最大风险点（详见第九节）**：
⭐ **「二次交付成交提醒卡」从上线到现在一次都没发出去过** —— 2 天（10-06 / 10-08）都以
`Request failed with status code 400` 硬失败，而**当天失败后按天认领把这一天的标记落成 `failed` ⇒ 当天不再重试**；
同一天同一秒（09:05:20）**9 点待处理单推送也以同样的 400 失败**。
**真正该看见的"还没成交的单"根本没进群**，而失败原因（飞书的真实 `code`/`msg`/`log_id`）**至今没有落到日志上**
（打真实错误的补丁所在文件在线上是 **2026-10-08 15:32 +08** 的版本，**晚于**当天 09:05 那次失败；
且当天已认领为 `failed`、不再重跑 ⇒ 补丁还没被触发过）。

---

## 二、链路 1：换货（`已换货` / 新明细 `已交付`）

### 2.1 代码路径（入口 → 状态 → 规则 → 写哪些表）

| 段 | 位置 | 做什么 |
| --- | --- | --- |
| ① 入口（意图分流） | `server/src/services/larkMvpService.js:1630-1633` | `isAfterSalesIntent(intent)` → `afterSalesFlow.handle(task, parsed)`。**只有这一条入口**（群 / 群话题；私聊已在 2026-10-07 移除） |
| ② 编排·动作收敛 | `server/src/services/afterSalesFlowService.js:146` `handle()`；动作判定 `config/afterSalesFlow.js:86 resolveAfterSalesAction` | 原话/AI 的「换」→ `action = 'exchange'`；认不出 → `after_sales.action.unresolved` + 回问 |
| ③ 定位原明细 | `afterSalesFlowService.js:217 locateOriginal()` | 话题里先按 `task.sales_entry_record_id` **限定在这一笔**；否则按货号/颜色 `saleLookupService.findCandidates`。命中多条 → 候选卡（无按钮、带序号） |
| ④ 组装方案（**只读、不写**） | `afterSalesFlowService.js:305 buildPlan()`；换出去那一双：`:426 resolveOutgoing()` | 两种换货：**同款换码**（`new_item_no` 空或等于原货号 ⇒ 货号/颜色/金额取原明细）／**换另一双**。`new_size` 必须有；金额不推算（同款取原明细成交金额、异款取货品单价） |
| ⑤ 出确认卡片 | `afterSalesFlowService.js:183-189`；文案 `utils/larkCards.afterSalesConfirmationCard` | `status = confirming`；**钱没解析出来就抛错拦住**（`:172-181`），不默认、不追问 |
| ⑥ 她点确认 | `larkMvpService.js:2046-2048` → `afterSalesFlowService.js:511 handleCardAction` → `:573 confirmAfterSales` | `running` → `executor.execute(...)`（`:599`）；失败 → 回 `confirming` + 重试卡 + `after_sales.failed` |
| ⑦ **执行器（唯一写库处）** | `server/src/services/afterSalesService.js:176 execute` → `:182 normalizeRequest` → `:266 runWithGate` → `:319 run` | 幂等总闸门 + 断点续做；四件事顺序：主表 → 明细 → 原明细状态 → 钱 → 库存 |
| ⑧ 换货的动作语义（**配置驱动**） | `server/src/config/afterSales.js:114-129` | `tradeTypeCode: SALE_EXCHANGE`（库存方向=**不影响**）· 原明细 → `已换货` · **新明细行 → `已交付`**（`:121`）· 两条库存动作：旧鞋 `SALE_RETURN`（+，回 `restockState`）、新鞋 `SALE_CASH`（−，门盒） |
| ⑨ 库存 | `afterSalesService.js:771 applyStock` → `:787 inventory.applyChange`；注册表 `server/src/services/inventoryService.js:183-204` | 一律经 `InventoryService`（全仓唯一库存写入口），幂等键 `operationId(kind, sourceRecordId)` + 远端「库存操作键」 |

**状态流转**（本地任务记录，`data/after_sales_operations/`）：
`running → completed`（`afterSalesService.js:365-369`）；重复确认 → `after_sales.skipped.already_done`（`:283`）。

**写哪些表 / 哪些字段**：

| 表（语义键） | 写什么 | 位置 |
| --- | --- | --- |
| 「销售主表」`salesEntry`（**新建一条**，沿用原单号） | `原话` · `销售单号`=原单 · `解析状态`=解析成功 · `确认状态`=已确认 · `销售状态`/`资金状态`=未写入 · `交易类型`=关联 `SALE_EXCHANGE` · `录单人` | `afterSalesService.js:454-469` |
| 「销售明细」`salesDetail`（**新建**出货那一行） | `销售单号`=**原主表**（不是新主表）· `编号` · `尺码` · `成交金额` · `交易类型`=`SALE_EXCHANGE` · **`履约状态`=已交付** | `:592-602`；`履约状态` 只在动作声明了才带（`:601`，`:542`） |
| 「销售明细」（**改原行**） | `履约状态` → **已换货** | `:645-657` |
| 「收款明细」`paymentRecord` | **只在差价 ≠ 0 时写**：`关联销售单`=新主表 · `交易方式`=**她说的**（没说才沿用原单）· `交易方向`=收入/退回 · `收款金额`（正数）· `收款状态`=已收款 · **`收款时间`**=点击时刻 | `:687-719` |
| 「库存流水」`inventoryLedger` | **2 行**：`销售退货`(+1) ＋ `现货销售`(−1)，数量都写正数，方向由「库存行为」表达 | 经 `inventoryService` |
| 「实时库存」`liveInventory` | 旧鞋 **+1** 行（`门盒` 或 `样品`，她没说 → 默认门盒）· 新鞋 **−1** 行（固定门盒） | 同上 |
| 「销售主表」（新主表）四个状态维度 | `销售状态` / `资金状态` / `库存状态` = 已写入；库存失败 → `库存状态`=扣减失败 | `:342`、`:346-348`；取值 `server/src/config/salesStatusDimensions.js:71` |
| ⛔ **原「销售主表」一字不动** | 有**两条守门用例**逐字段快照钉住 | `afterSalesService.js:349-352`；用例 `afterSalesService.test.js:377 / :395` |

### 2.2 测试覆盖 —— 是"真覆盖"还是"只覆盖壳"

| 测试文件 | 用例数 | 判定 | 说明 |
| --- | --- | --- | --- |
| `server/test/afterSalesService.test.js` | 28 | ✅ **真覆盖** | 假 Base **按真 schema 做语义名→中文列名映射**，逐表计写入次数、逐字段快照比对。关键用例：`退货（cash 退款）：六处写入各一次，原主表一字未动`（`:274`）、`换货：旧鞋回库 + 新鞋出门盒，两条流水方向相反`（`:590`）、`换货：新换出去的那条明细「履约状态」= 已交付`（`:694`）、`配置先行：只有换货声明「新明细行的履约状态」`（`:733`）、`重复执行两次：六处写入都只发生一次`（`:416`） |
| `server/test/afterSalesFlow.test.js` | 39 | ✅ **真覆盖**（编排层） | 覆盖两条入口、序号上下文、钱不能猜（`⚠️ 没解析出钱怎么走 → 抛明确的错拦住`，`:649`）、`同款换码（业务负责人真机那句）`（`:1201`）、非群出口不回落私聊（`:1111`） |
| `server/test/afterSalesCard.test.js` / `afterSalesGroupThread.test.js` | 10 / 4 | ✅ 真覆盖 | 卡片结构与话题回复路由 |
| **实测** | **81 条全绿** | — | 本次在本地跑 `node --test test/afterSales*.test.js`：`tests 81 / pass 81 / fail 0` |
| 🔬 **测试 Base 真链路 E2E** | 场景 ⑤⑥ | ✅ **真覆盖（测试 Base，非生产）** | `server/scripts/e2e-sales-group-scenarios.mjs:890 起`（⚠️ **该脚本目前是未提交状态**）；结果留档 `docs/reports/e2e-sales-group-2026-10-06.md:114 / :127`：退货「原明细→已退货、四字段全写、1 条流水、回门盒 +1」✅；换货「原明细→已换货、2 条流水方向相反」✅ |

❌ **覆盖不到的东西（如实说）**：
1. 上述单测**全部在进程内跑假 Base**，**一次真飞书 API 都不打** ⇒ 飞书侧的
   `FieldNameNotFound` / `400` 这类"只在真表上才炸"的失败**测不到**（AGENTS.md 第 5 条那类事故就是靠"真启动一次"抓的）。
2. 那条 E2E 是 **2026-10-06** 跑的，**早于** 2026-10-08 的「新明细行 = 已交付」补丁 ⇒
   **补丁本身没有任何一层测试之外的真机验证**（单测有，真表没有）。
3. **钱那一腿（`settleCash` 写「收款明细」）在测试 Base E2E 里跑过，但在生产上一次都没跑过**（见下）。

### 2.3 线上日志证据（换货）

**成功 1 次 · 失败 0 次**（out + error 两份日志都查过：`grep after_sales\.` 在 out 日志里只有 **7 行**，在 error 日志里**零**行）。

```
2026-10-07T16:03:38.434Z  after_sales.executed
  action=exchange  original_sales_order_no=XSD-20261007-0054
  original_sales_entry_record_id=reczz28KXdaDKu5h  original_sales_detail_record_ids=[reczz28KXf12Qldf]
  master_record_id=reczz28KZz7gUsB3  detail_count=1  original_details_marked=1
  money_route=none  diff_amount=0  stock_rows=["SALE_RETURN:门盒:1","SALE_CASH:门盒:1"]
```
⇒ **2026-10-08 00:03:38 +08**（UTC 16:03:38）。同秒 `after_sales.confirmed` + 卡片 `stage=completed` patch 成功。

**这条真机跑的是补丁【之前】的代码** —— 这是本节最重要的一条：

| 事件 | 时间（+8） |
| --- | --- |
| 换货真机执行 | 2026-10-08 **00:03:38** |
| 补丁 commit `e864afa`「新换出去的那条明细补履约状态=已交付」 | 2026-10-08 **00:11:33**（合入 00:18:17） |
| 部署到 `/opt`（`config/afterSales.js` mtime） | 2026-10-08 **12:12:47**（重启 12:13:11） |

⇒ 真机那次**必然**还是"新明细行履约状态留空"的旧行为（AGENTS.md 里记的那条真机事实
「XSD-20261007-0054 的新明细 reczz28KZzAY4BBi 当时是空的」与日志时间线一致）。
**补丁后的行为只在假 Base 单测里验过，没有任何线上/真表证据。**

**旁证（这条换货单确实进了"售后已排除"规则）：**
```
2026-10-08T04:13:30.428Z  sales.second_delivery.reminder.order_skipped
  sales_entry_record_id=reczz28KXdaDKu5h  reason=after_sales_fulfillment  fulfillment_status=已换货
```
⇒ **2026-10-08 12:13:30 +08**。说明 10-08 的排除规则**已在线上生效**（它与「新明细行=已交付」同一天合入，
12:13:11 那次部署把它们一起带上了 `/opt`）。

**库存侧计数（全窗口）**：`inventory.change.applied` 543 条里，`kind` 分布：
`STOCK_PURCHASE_INCREASE 298` · `STOCK_SALE_DECREASE 77` · `STOCK_PURCHASE_DECREASE 36` ·
**`SALE_RETURN 1`** · **`SALE_CASH 1`** · …
⇒ `SALE_RETURN` 全窗口**只有 1 次**，就是这笔换货的旧鞋回库腿。**销售退货（退货动作）一次都没有。**

### 2.4 结论：**通了（1 次真机全链成功）**，但卡在两处

1. ✅ 主表 / 明细 / 原明细状态 / 2 条库存流水 / 实时库存 / 四个状态维度 —— **都落了**（日志 + 库存计数可对）。
2. ⚠️ **钱那一腿（差价 ≠ 0）线上 0 次** —— 这笔差价是 0，`money_route: none`。所以「收款明细 + 交易方式 = 她说的那个」这条**在生产上是未验证**的。
3. 🔴 **「新明细行 = 已交付」补丁线上未验证**（真机比补丁早 8 分钟）—— 这条正是她 2026-10-08 真机看到"新明细那一格是空的"之后要的修复。

---

## 三、链路 2a：退货（**销售退货**）

### 3.1 代码路径

与换货**共用同一个执行器**，只是动作不同 —— 动作语义在 `server/src/config/afterSales.js:104-113`：

| 项 | 退货（`AFTER_SALES_ACTIONS.RETURN`） |
| --- | --- |
| 交易类型 | `SALE_RETURN`（「行为管理」里库存方向 = **增加**） |
| 原明细「履约状态」 | → **已退货** |
| 新明细行 | **写**（退回商品的**复制行**，金额取原值且为正）；`newLineFulfillmentStatus` **不声明** ⇒ 不写 `履约状态`（`:601`） |
| `newLines` | **必须为空**（`:194-196`） |
| 退回的鞋回哪 | **必填** `restockState`（门盒/样品），她没说 → 默认门盒（`afterSalesFlow.js:256`） |
| 库存 | **1 行** `SALE_RETURN` 增加；`consumes: null` ⇒ 只在指定状态**新增**一行 |
| 钱 | 差价 ≠ 0 时必须走 `cash`；**`prepaid`（钱先存着）已下线**（`:327`、`:765`） |

**写哪些表/字段**：同上表 2.1，区别只是
① 原明细写 `已退货`；② 新建的是**退回商品的复制明细行**（`交易类型=SALE_RETURN`，`成交金额`取原值正数，`销售单号`仍关联**原主表**）；
③ 库存只有 1 行（+1）；④ 收款方向为 `退回`。

⛔ **`prepaid` 通路已整段下线**：它的唯一落点「客户往来货款」被业务负责人 **2026-10-08 整表删除** ⇒
`assertPrepaidAvailable()`（`afterSalesService.js:765`）在**任何写入之前**大声失败（`:327`）。

### 3.2 测试覆盖

- 单测：`afterSalesService.test.js` 里 `return` 是**主用例**（28 条里多数以 `action: 'return'` 为基线）——
  `退货（cash 退款）：六处写入各一次`（`:274`）、`部分退货：先退明细 A、再退明细 B`（`:535`）、
  `同一批明细重复调用只写一次；同一条明细再退一次仍被拦住`（`:558`）、
  `⛔ 资金 prepaid：表已被删 → 在任何写入之前大声失败`（`:800`）。
- 编排层：`afterSalesFlow.test.js` `入口 A：先查 → 说「第 2 笔，退货，钱先存着」`（`:331`）、
  `她说了「退我现金」/「退给她 230，微信退」`（`:580`）。
- 真链路 E2E（**测试 Base**）：`docs/reports/e2e-sales-group-2026-10-06.md:114` 场景 ⑤ **全项 ✅**，其中
  **钱那一腿也真跑过**：「1 条退款（交易方向 = 退回，带收款时间）」→ 实测 `交易方向=退回 · 金额 150 · 有收款时间` ✅
  （`:122`）；库存 `销售退货 1`、实时库存回门盒 +1 ✅。原话是「退一双 2070-9 黑 39码，**钱退现金**」。
- ✅ 判定：**真覆盖**（含差分、幂等、**真退款**），但同样**只到假 Base / 测试 Base，没到生产**。

### 3.3 线上日志证据（销售退货）

- `after_sales.executed` 全窗口 **1 条，action=exchange** ⇒ `action=return` **0 条**。
- `inventory.change.applied`：`SALE_RETURN` **1 条**（就是那笔换货的旧鞋腿）。
- `error` 日志里 `after_sales` **0 行**（不是失败，是**从来没跑**）。
- 售后写出的「收款明细」：那唯一一次 `money_route=none` ⇒ 售后链路写「收款明细」**线上 0 次**。
- 全窗口 grep「退回」两个字：**只有 1 行**，而且是那笔换货的卡片文案
  （`2026-10-07T16:02:26.719Z … action=choose_after_sales_restock … result="退回的鞋将放到「门盒」"`）
  ⇒ **没有任何一条「收款明细.交易方向 = 退回」**（退款/退货的钱那一腿线上从未发生）。

**结论：没通 —— 线上从来没有跑过一次销售退货。** 卡在"没有真机输入"这一步（不是代码报错：
日志里既没有 `after_sales.failed`，也没有 `after_sales.plan.needs_info` 之外的退货痕迹）。
⚠️ **未核事实表**：我没有去「销售主表/销售明细」逐条确认"没有任何一行交易类型=销售退货"
（硬约束：只读日志）。上面三条**都是日志层证据**，指向同一个结论；要 100% 收口需要在服务器上
用项目代码只读核一次「销售明细.交易类型」的取值分布。

---

## 四、链路 2b：退货（**采购退货**）—— 与销售退货是**完全不同的一条链**

### 4.1 代码路径

| 段 | 位置 | 做什么 |
| --- | --- | --- |
| ① 入口 | 飞书多维表格「信息填写」`record_added` → `server/src/routes/larkEvents.js:138`（表 ID 从 schema 读）→ `:183 acceptMany` | 一次表单提交的多条收成**一包** |
| ② | `server/src/services/purchaseWebhookService.js:485 accept` / `:529 acceptMany` → `:667 process` | |
| ③ **分流**（关键） | `purchaseWebhookService.js:685-716`；行为判定 `:2066 readReportBehaviorKind` + `services/purchaseReportBehaviorPolicy.js` | 先看「采购行为」：`采购退货` → **不走报货归批、不写到货/入库**，进 `handleReturnBatch` |
| ④ 归批（退货自己一套） | `:2238 handleReturnBatch` → `:2274 flushReturnBatch` → `:2369 runReturnBatch`；窗口 `config/purchaseReturnBatchWindow.js` | 「到齐 ＋ 重试 3 次读不到就算处理完」；进程内两套 Map、两把锁，**刻意不与报货共用** |
| ⑤ 解析（**与报货同一条路**） | `:428 parseReportQuantities` + `services/purchaseQuantityPolicy.js` | 尺码多选逐个展开；「数量说明」不写 ⇒ 每个勾选尺码 1 双（`:2552-2557` 注释是口径） |
| ⑥ 核对计划（**只读 + 冻结**） | `:2112 planReturnFromItems` → `:2166 ensureReturnPlan` | 拿"她说要退的"比"当前实时库存**行数**"；`taken = min(declared, available)`。**必须冻结**：复跑再算会多扣 |
| ⑦ 落库 | `:2621 applySupplierReturn` | 逐尺码：写「报货信息」→ 扣库存 → 回写报单终态 |
| ⑧ 出图/发群/回填 | `:2719 ensureReturnBatchRecord` → `:2744 deliverReturnImages` → `utils/... writeSupplierImageAttachment`（`:1864`） | 标题「邯美皮鞋采购退货单」；图发采购群、写进「报货批次.单据」 |
| ⑨ 差额提示 | `:2785 sendReturnNotice`（文案 `:222 buildPurchaseReturnNotice`） | **回复那张退货单的话题根**（不新开话题、不发私聊） |
| ⑩ 重启恢复 | `:2198 recoverPendingReturnBatches` | 只认 `batch_kind === 'purchase-return'` 的 `batch_waiting` |

**写哪些表 / 哪些字段**：

| 表（语义键） | 写什么 | 位置 |
| --- | --- | --- |
| 「报货信息」`purchaseRequest`（**新建，一尺码一行**） | `采购行为` · `编号` · `尺码` · `数量`（= 实际退掉的双数） · **`幂等键`** = `purchase_return:<报单记录id>:<尺码>` | `:2638-2652` |
| 「库存流水」`inventoryLedger` | 每尺码 1 条：库存行为 = **采购减少**（`STOCK_PURCHASE_DECREASE`，方向=减少）；🔴 **不带来源关联**（`ledgerSource: null`） | `:2660-2672`；注册表 `inventoryService.js:175-180` |
| 「实时库存」`liveInventory` | 按注册表 `consumes = ['门盒','样品','仓库']` **逐行删除**（一双一行） | `inventoryService` |
| 「信息填写」`purchaseReport` | `处理状态` → **已生成申请** ＋ `关联采购申请` = 刚写的报货信息行 | `:2684-2689` |
| 「报货批次」`purchaseOrderBatch` | **新建一行**（`createForReturnBatch`，`:93`）：`报货批次号` + `幂等键` = `purchase_batch:<批次号>`；🔴 **不写「到货状态」**（留空 ⇒ 不进 9 点「未到货」推送） | `:2719-2731`；`services/purchaseOrderBatchService.js:93` |
| 「报货批次.单据」 | 退货单 PNG 附件 | `:1864 writeSupplierImageAttachment` |

⛔ **它明确不碰**：「采购到货」/「采购入库」（两表已被业务负责人删除）、资金任何一张表。

### 4.2 测试覆盖

| 测试文件 | 用例数 | 判定 | 亮点用例 |
| --- | --- | --- | --- |
| `server/test/purchaseReturn.test.js` | 11 | ✅ 真覆盖 | 逐尺码扣减 / 差额 / 终态挡重复 |
| `server/test/purchaseReturnBatch.test.js` | 12 | ✅ 真覆盖 | 归批到齐、一次出图一次发群、单条失败不拖整批 |
| `server/test/purchaseReturnBatchRow.test.js` | 7 | ✅ 真覆盖 | 退货批次也建「报货批次」行、不写到货状态 |
| `server/test/purchaseReturnUnifiedParsing.test.js` | 10 | ✅ 真覆盖（含**守门**） | ③ `守门：schema 里没有「信息填写.数量」；全仓没有对它的读取点`、⑥ `守门：不再有"从实时库存反推尺码"的计划器` |
| **实测** | **40 条全绿** | — | `node --test test/purchaseReturn*.test.js`：`tests 40 / pass 40 / fail 0` |

⚠️ 与链 1/2a 同样：**全部是假 Base 单测**；真飞书那一层靠线上日志（下面）兜。

### 4.3 线上日志证据（采购退货）

**成功 · 失败 0**：`purchase.return.*` 在 `error` 日志里 **0 行**（无 `record_failed`、无 `batch.no_records`）。

| 事件 | 次数 | 最近一次（+8） |
| --- | --- | --- |
| `purchase.return.stock_applied` | **36** | 2026-10-07 23:45:26 |
| `purchase.return.posted`（单条路径） | **6** | 2026-10-06 12:52:16 |
| `purchase.return.batch.posted`（整批） | **1** | **2026-10-07 23:45:43** |
| `purchase.return.notice`（差额提示） | **5** | 2026-10-07 23:45:43 |
| `purchase.return.batch.record_ensured`（退货批次行） | 1 | 2026-10-07 23:45:34 |
| `purchase.return.record_failed` / `batch.no_records` | **0** | — |

**最近一次整批（最强的"全链通了"证据，逐行）**：
```
2026-10-07T15:44:57.620Z  purchase.return.stock_applied  size=43 quantity=1 doc_id=reczz28KZgE8djPk ledger_record_id=… batch_no=CGD-20261007-0001
2026-10-07T15:45:34.843Z  purchase.return.batch.record_ensured  batch_no=CGD-20261007-0001 batch_record_id=reczz28KZh82K4EP reused=false
2026-10-07T15:45:36.822Z  purchase.request.image.group_sent  chat_id=oc_5036…  image_message_id=om_x100b6352dccce0a4c3f46f9cc7c43be
2026-10-07T15:45:42.306Z  purchase.request.image.attachment_written  record_id=reczz28KZh82K4EP file_name=三星-退货单.png written=true
2026-10-07T15:45:43.487Z  purchase.return.batch.posted  record_count=5 item_count=12 doc_count=12 failed_record_count=0
```
⇒ **2026-10-07 23:45:43 +08**：5 条报单记录 → 12 双 → 12 张单据 → 1 张 PNG 发到采购群 → 回填到「报货批次」那一行，**0 失败**。
差额提示也回在**同一个话题**（`reply_to_message_id` 与上图那条同值）。

**一条"跑通了但业务结果为 0"的历史记录（不该当成成功）**：
```
2026-10-05T15:15:43.283Z  purchase.return.notice  declared=1 available=0 taken=0 shortfall=1 sent=true
2026-10-05T15:15:43.283Z  purchase.return.posted  declared=1 available=0 taken=0 size_count=0 doc_count=0
```
⇒ 2026-10-05 23:15:43 +08：她说退 1 双，但实时库存里**一双都没有** ⇒ 库存没扣、单据没写，只给她发了一条差额提示。
这是**设计如此**（"尽力处理 + 把差额告诉她"），但要看清：**这一条不是"退货成功"**。

### 4.4 结论：**通了**（6 条记录 + 1 个整批 5 条，出单/扣库存/发群/回填附件全链成功，0 失败）

⚠️ 两点如实记：
1. **最近一次是 2026-10-07 23:45 +08**；2026-10-08 一整天**没有任何采购退货活动**
   （可能是没人提交，也可能是表单入口的问题 —— 日志只回答"链路上没有东西进来"）。
2. `/opt/box2bitable/server/src/services/purchaseWebhookService.js` 的 mtime = **2026-10-08 17:51:40 +08**
   （`server.started` 17:52:18 +08）⇒ **退货链路的最新一版代码是今天 17:51 才上的**，
   而最近一次退货真机是 **10-07 23:45** ⇒ **最新一版在退货链路上一次都没跑过**（本次核查时距部署仅几分钟）。

---

## 五、链路 3：抖音团购券 / 待平台结算

**这一条要拆成两半看 —— 两半的状态完全不同。**

### 5.1 写入侧（券 → 收款明细 `待平台结算`）**通了**

| 段 | 位置 | 做什么 |
| --- | --- | --- |
| ① AI 提示词 | `server/src/services/doubaoService.js`（规则 10，`:755` 附近；`:703` 明确「团购券只是一种**支付方式**，不影响 trade_type」） | 只把**实付给门店的**现金/微信放进 `payments`；**券的购买价与面值都不是门店已收现金** |
| ② **券经济学（确定性，不靠模型）** | `server/src/services/groupBuyVoucherPolicy.js:35 applyGroupBuyVoucherPolicy` | 一单一双、一单一券的硬闸门（`:42-62`）；实付现金从**她原话**里正则取（`:24`）；`net = 实付 + 平台结算款`（`:81-84`）；**写出的收款明细 = 实付各行（已收款）＋ 一条 `{method:'抖音团购券', amount:结算款, status:'待平台结算'}`**（`:96`） |
| ③ 券目录（**配置先行**，不写死券种） | `server/src/config/groupBuyVouchers.js:24 findVoucher`（按「售价 + 面值」匹配）← 读「团购券管理」表（只取**在售**）：`larkMvpService.js:1447` 起 | 89.9 抵 100 → 结算 85.4 |
| ④ 真正落表 | `server/src/services/paymentService.js:37 record()`（`status='待平台结算'` 合法，`:42`）／`:100 recordInitialBatch()` | 🔴 **`待平台结算` 时刻意不写「收款时间」、也不写「交易方向」**（`:43`、`:54-55` 与注释）：钱还没到，方向还没发生 |
| ⑤ 读/聚合 | `server/src/services/salesProgressService.js:28-49`（`platformPendingAmount`、`paymentStatus='待平台结算'`）· `server/src/config/salesCardFacts.js:35 / :156-186`（三段文案里"已收/还欠"扣掉待结算）· `utils/larkCards.js:442-455` | 卡片显示「待平台结算：抖音团购券 ￥85.4」 |
| ⑥ **常量** | `PENDING_SETTLEMENT_STATUS = '待平台结算'` 唯一定义在 `server/src/config/salesCardFacts.js:35`；`config/pendingPushCandidates.js:43 / :80` **只是转发**（注释写明"第二步团购券块要用"） | |

**测试**：`groupBuyVouchers.test.js` **3 条**（只覆盖券目录匹配，配置层）；
券策略与落表的真覆盖在 `doubaoSalesParser.test.js`（50 条，含 `:262 / :431` 断言 `payments[1].status === '待平台结算'`）、
`larkMvpService.test.js:610 / :618`（卡片出现「待平台结算」、目录只认在售）、`salesMvp.test.js:228`。
✅ 判定：**写入侧真覆盖**（含"下架券不能算结算金额"这种守门用例）。

**线上证据（写入侧通了，但只有 1 笔、而且是【私聊时代】的）**：
```
2026-09-27T08:18:15.472Z  sales.ai.normalized  task_id=sale_de504e349399758e242c
  payments=[{method:"微信",amount:19,status:"已收清"},{method:"抖音团购券",amount:85.4,status:"待平台结算"}]
  agreed_total=104.4  voucher={purchase_price:89.9, face_value:100, settlement_amount:85.4}
2026-09-27T08:19:50.574Z  bitable.record.created  table_key=paymentRecord  record_id=recvwphJA2o2Ny   ← 19 元微信
2026-09-27T08:19:54.124Z  bitable.record.created  table_key=paymentRecord  record_id=recvwphKpH9Lvn   ← 85.4 待平台结算
2026-09-27T08:20:04.999Z  v1.sale.posted  sales_entry_record_id=recvwphlyazUNj  detail_count=1  payment_count=2
2026-09-27T08:20:54.586Z  lark.sales.posting.completed  source_no=XSD-20260927-0143  result=posted
```
⇒ **2026-09-27 16:20:54 +08**，单号 `XSD-20260927-0143`，两行收款明细（19 微信 + 85.4 待平台结算）。
全窗口 `团购券` 只有这 1 次成单（另 1 条是"请说明团购券之外实收金额"的追问）。
⚠️ 那笔走的是**已被移除的私聊入口**（2026-10-07 起入口只有群 / 群话题）⇒
**当前入口下，团购券一次都没被真实录入过。**

### 5.2 结算侧（`待平台结算` → `已收款` / 「确认到账」）🔴 **根本不存在**

| 项 | 现状 |
| --- | --- |
| 服务方法 | `server/src/services/paymentService.js:82 settlePlatformReceipt(recordId, receivedAt)` —— **写得挺完整**（幂等：已是「已收款」直接返回；只允许从 `待平台结算` 走；补 `交易方向=收入`、写 `收款时间`） |
| **调用方** | 🔴 **全仓零调用方**（`grep -rn settlePlatformReceipt server/src server/public` 只有定义那一行；`server/test` 里 2 处、`server/test/salesMvp.test.js:228`、`secondDeliveryService.test.js:279`） |
| 卡片动作 | **不存在**。`routes/larkEvents.js:49 card.action.trigger` 的分派里没有「确认到账」；`larkCards.js` 里没有任何相关按钮常量 |
| 9 点推送的【团购券待结算】块 | **不存在**。`config/pendingDealPush.js` 的区块只有 `undelivered` / `deliveredUnpaid`（两个判据）；全仓搜 `团购券待结算` / `确认到账` = **0 命中** |
| 设计文档 | 有，而且是**明确的"第二步"**：`docs/push-blocks-caliber-2026-10-08.md` **第六节**（取数、分组=结算日、按钮只带结算日、幂等、只在群里可用），第五节结尾自己写着「**第二步**：【团购券待结算】块 + 「确认到账」按钮」；commit `02580a7`（2026-10-08 15:03）只是**改文档**，`--stat` 只有 1 个 md 文件 |
| 线上日志 | **0 次**：out/error 两份日志里 `settle`/`platform`/`voucher` 相关事件只有 `lark.sales.confirm_deal.already_settled`（与团购券无关） |

**唯一"待结算"的现状数据（引用，非本次核）**：`docs/push-blocks-caliber-2026-10-08.md:48` 记着
2026-10-08 15:00 左右只读实测：「「待平台结算」**1 条**：09-27 核销、应到账 10-02（**逾期 6 天**）、85.4」。
⚠️ **这是 Lead 当时的核对结果，不是本次核的**；要收口需要再只读核一次「收款明细」。

### 5.3 结论：**半通**

- ✅ **写进去**：券 → 「收款明细」（`待平台结算`）+ 金额口径（平台结算款）—— 代码完整、单测真覆盖、线上有 1 笔历史数据。
- 🔴 **收回来：没有**。`待平台结算` 这笔钱**今天在系统里没有任何办法变成「已收款」** ——
  没有按钮、没有入口、没有定时任务，`settlePlatformReceipt` 是个**没有调用方的孤儿**。
  按她的口径（"点按钮 → 收款状态改已收款 + 更新收款时间"），**连这一步都还没有实现**。
- ⚠️ 这也解释了为什么"团购券没跑通"：**能卖的半条通了，能结的半条连代码都还没有**。

---

## 六、链路 4：二次交付（成交后收尾款）

**这一条有 3 个入口 + 1 个提醒腿，必须分开看。**

### 6.1 代码路径

**① 提醒腿（每天 9:00 +8 发群卡）**
```
server/src/app.js:125-126  new SecondDeliveryService() + startSecondDeliveryReminder({run})
  → server/src/utils/secondDeliveryReminder.js:30（setInterval 10 分钟 + 过了 9 点才跑，:22 手动 +8 换算）
  → server/src/services/secondDeliveryService.js:510 sendDailyReminder
  → :521 _sendDailyReminder（:535 按天认领；:542 listPendingDeliveries；:551 读收款方式；:561 出卡）
  → :286 listPendingDeliveries（候选 = 最近 7 天 且 已入账 且 progress.orderStatus !== '已完成'）
  → :490 sendCardToChat（群 id 来自 PURCHASE_CHAT_ID，:11 config/groupPurchase）
  → 卡片 server/src/utils/larkCards.js:1128 secondDeliveryCard（按钮 action = SECOND_DELIVERY_ACTION，:1083）
```
**② 她的点击（卡上「成交·微信」）**
```
routes/larkEvents.js:49 card.action.trigger
  → services/larkMvpService.js:2032（action === SECOND_DELIVERY_ACTION）
  → :2061 handleSecondDeliveryAction（带上被点的那条 message id 与 reminder_day）
  → secondDeliveryService.js:96 confirm → :102 _confirm
       ① :156 payments.collectPendingReceipt（未收款 → 已收款 + 收款时间 + 交易方向=收入）
       ② :168 delivery.deliver（未交付 → 已交付 + 扣库存）／:172 progress.sync（没有未交付时只算进度）
  → :217 markCardSettled（把那一条的按钮换成灰字；:1172 settleSecondDeliveryOrder）
```
**③ 群里直接说「已完毕 / 成交」（**线上 4 次全部走这条**）**
```
services/salesThreadProgressService.js:176 handle → :587 applyComplete（:633 secondDelivery.confirm）
  —— 注释写得很清楚：钱货都不在本类实现，「成交只有一处实现」（:570）
  —— 钱没法定时：先做"货那一半"（:606 deliverUndelivered）再回问一句（决策见 AGENTS.md 第 16 条(1)）
```
**④ 工作台（写入类，2026-10-08 明确保留）**
```
routes/workbench.js:81 POST /api/workbench/sales/payments  → salesFollowupService.js:80 addPayment
routes/workbench.js:94 POST /api/workbench/sales/deliveries → salesDeliveryService.js:26 deliver
```

**状态与规则**：
- 候选判据**不看交易类型**（2026-10-07 口径大改，`secondDeliveryService.js:40-44`）——只看**履约是否完成**；
  现货 + 欠钱 的主表类型是 `SALE_CASH`，老判据会**整类漏掉**（真实的静默漏单）。
- 「已完成」= 货交完 **且** 钱收清（`salesProgressService.progressFromRecords`，`orderStatus` 是**算出来的 JS 字段**，表里没有这一列）。
- **退/换/赔过的单不进候选**（2026-10-08 新增）：`secondDeliveryService.js:355-366`，判据唯一来源 `config/afterSales.js:68-76 isAfterSalesFulfillment`。
- 幂等：① 未收款/已交付状态本身（底层两个写操作）；② 卡片侧 `status=done` 短路；③ 同一张单串行（`KeyedSerialQueue`，`:73`）。
- 「只推一次」只有**按天**这一层（`:524-539`）——同一天先落认领再发（崩在中间只会**少推一次**，不会重复刷屏）；**跨天照发**（她明确否掉了"按单只推一次"）。

**写哪些表 / 字段**：

| 表 | 写什么 | 位置 |
| --- | --- | --- |
| 「收款明细」 | `收款状态` 未收款 → **已收款** · `交易方式`（按钮带上来，缺了报错**不猜**）· **`收款时间`** = 点击那一刻 · `交易方向` = 收入 | `paymentService.js:74-79` |
| 「销售明细」 | `履约状态` 未交付 → **已交付**（逐条） | `salesDeliveryService.js:93` |
| 「库存流水」 | 每交付一条明细 1 条 `STOCK_SALE_DECREASE`（减少） | `salesDeliveryService.js:89 → inventoryService.applySale` |
| 「实时库存」 | 按注册表 `consumes=['门盒','样品']` 删除行；卖到样品触发补样品候选 | 同上 |
| 「销售主表」 | **只写「库存状态」**（已扣减/部分扣减/扣减失败）—— 由 `SalesStatusWriter` 统一写（`salesDeliveryService.js:118`） | `config/salesStatusDimensions.js:71` |
| 飞书群消息 | 每日卡片 + 点完的卡片 patch（`markCardSettled`，`:217`） | |

### 6.2 测试覆盖

| 测试文件 | 用例数 | 判定 |
| --- | --- | --- |
| `server/test/secondDeliveryService.test.js` | 28 | **分两档**（见下） |
| `server/test/secondDeliveryPendingItems.test.js` | 8 | ✅ 真覆盖（9 点推送要的货号/颜色/尺码增强，且钉住"关着时返回形状逐字不变"） |
| `server/test/terminalCardConfirmDeal.test.js` | 20（含在 56 里） | ✅ 真覆盖（终态卡「确认成交」） |
| **实测** | **56 条全绿** | `node --test test/secondDeliveryService.test.js test/secondDeliveryPendingItems.test.js test/terminalCardConfirmDeal.test.js`：`tests 56 / pass 56 / fail 0` |

**✅ 真覆盖的部分（成交那一半）**：`现货待收单点「成交」：只补收款，库存与明细履约状态一个字都不动`（`:101`）、
`预定单点「成交」：补收款 + 明细未交付转已交付 + 扣库存`（`:155`）、`同一张单连点两次「成交」`（`:213`）、
`未收款那条不写交易方向；变成已收款的那一刻才写「收入」`（`:247`）、
`点完「成交」：被点那一单的按钮换成一行灰字，卡片里别的单一个字都不动`（`:621`）、
`交付只成了一半：不变灰`（`:728`）、`东八区小时换算：UTC 01:00 就是北京 9 点`（`:813`）。

**⚠️ 只覆盖到"壳"的部分（发卡那一腿）**：`每日提醒：只推「尚未完成履约 + 7 天内」，卡片发到采购群`（`:424`）——
它断言的是**"我们把这张卡交给了（被 mock 的）`client.im.message.create`"**，
**飞书对卡片内容的真实校验（schema 不合法 / 元素超限 …）完全测不到**。
⇒ **线上就是这么挂的（HTTP 400），而 28 条用例全绿。这是"壳覆盖"最典型的一处。**

**E2E（测试 Base）**：`server/scripts/e2e-sales-group-scenarios.mjs:732 起` 场景 ③④ 覆盖了
**群里说「已完毕 / 成交」**那条路（`docs/reports/e2e-sales-group-2026-10-06.md:16-17` ✅）；
**提醒卡的发送 / 点击、工作台两个接口、团购券** —— **都没有 E2E**。

### 6.3 线上日志证据（二次交付）

**A. 成交（收尾款 + 交付）：4 次成功 · 0 次失败**

| 时间（+8） | 单号 | 走的入口 | 收了钱 | 本次交付明细数 | order_status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-08 00:43:52 | XSD-20261008-0007 | 群话题「成交」 | 0 | 1（卡片回话说「交付 2 双」= 该单累计已交付数） | — |
| 2026-10-08 01:22:03 | XSD-20261008-0019 | 群话题「成交」 | 0 | 1 | — |
| 2026-10-08 01:30:33 | XSD-20261008-0023 | 群话题「成交」 | ￥100（微信） | 0（本来就已交付） | **已完成** |
| **2026-10-08 14:31:28** | XSD-20261008-0027 | 群话题「成交」 | 0 | 1 | — |

> 第 4 列 = `collected_payment_ids` 的长度；第 5 列 = `delivered_detail_ids` 的长度（都是日志原字段）。
> ⚠️ 卡面回话里的「交付 N 双」用的是 `result.delivery.deliveredQuantity` = **该单累计已交付数**，
> 与"本次交付明细数"不是同一个数（0007 那单/次就是 2 vs 1）—— 引用时别混。

原始行（最近一次）：
```
2026-10-08T06:31:28.006Z  sales.second_delivery.completed
  sales_entry_record_id=reczz28KogoBUbHn  order_no=XSD-20261008-0027  method=""
  collected_payment_ids=[]  collected_amount=0  delivered_detail_ids=["reczz28KoizZTIga"]
  delivery_failed_count=0  fulfillment_status=已交付  task_id=sale_d7f6056750bfc5ff46f3
```
**4 次全部来自群话题 `confirm_sale_deal`**（每次前面都有 `lark.card.received action=confirm_sale_deal`
→ `sales.thread_progress.completed` → `lark.sales.confirm_deal.handled status=confirm_deal_settled`）。

**B. 「提醒卡」的硬证据 —— 它压根没发出去过**

```
2026-10-07T16:43:52.563Z (error.log)  sales.second_delivery.card_settled.skipped
  sales_entry_record_id=reczz28KaMja5Dsr  reason=missing_reminder_day
2026-10-07T17:22:03.702Z (error.log)  … reason=missing_reminder_day
2026-10-07T17:30:33.741Z (error.log)  … reason=missing_reminder_day
2026-10-08T06:31:28.005Z (error.log)  … reason=missing_reminder_day
```
⇒ **4 / 4 次成交都带 `reminder_day = ""`** ⇒ **不是点在每日提醒卡上的**（那条腿需要 `reminder_day`）。
⇒ **「点提醒卡成交」这条腿线上从未被走过。**

按天认领记录的**落盘事实**（`cat /opt/box2bitable/server/data/second_delivery_reminder/*.json`）：

| 天 | `status` | 内容 | 时间（+8） |
| --- | --- | --- | --- |
| 2026-10-05 | `completed` | `reason: no_pending_order`，`pushed: []` | 23:27:47 |
| 2026-10-06 | 🔴 **`failed`** | `error: "Request failed with status code 400"` | **09:09:38** |
| 2026-10-07 | `completed` | `reason: no_pending_order`，`pushed: []` | 09:05:51 |
| 2026-10-08 | 🔴 **`failed`** | `error: "Request failed with status code 400"` | **09:05:20** |

对应 error 日志（**只有 error 日志里有**）：
```
2026-10-06T01:09:38.399Z  warn   sales.second_delivery.reminder.failed  day=2026-10-06  error="Request failed with status code 400"
2026-10-06T01:09:38.399Z  error  sales.second_delivery.reminder.tick_failed  error="Request failed with status code 400"
2026-10-08T01:05:20.416Z  warn   sales.second_delivery.reminder.failed  day=2026-10-08  error="Request failed with status code 400"
2026-10-08T01:05:20.416Z  error  sales.second_delivery.reminder.tick_failed  error="Request failed with status code 400"
```
⇒ **2026-10-06 09:09:38 +08** 与 **2026-10-08 09:05:20 +08**。
**`sales.second_delivery.reminder.sent` 全窗口 0 次**（out 日志里没有任何 sent 事件；
也没有 `chat_missing` / `methods_missing` ⇒ 群 id 与收款方式都是配好的，**卡是发出去被飞书拒了**）。

**C. 同一秒，"9 点待处理单推送"也炸了同样的 400**（重要相关性）：
```
2026-10-08T01:05:20.416Z (error)  sales.pending_deal_push.failed  day=2026-10-08  error="Request failed with status code 400"
2026-10-08T01:05:20.416Z (error)  sales.pending_deal_push.reminder.tick_failed  …
```
⇒ 两条 9 点推送**在同一秒、以同样的 400 失败**。
（群是不是同一个**未核**：成交提醒读 `PURCHASE_CHAT_ID`（`config/groupPurchase.js`），
9 点推送读 `PENDING_DEAL_PUSH_CHAT_ID`（`config/pendingDealPush.js:469`）—— 两个环境变量都在服务器 `.env` 里，
本次**没读 `.env`**，不猜。）

**D. 反复出现的错误**（本链路相关）：
`Request failed with status code 400` —— **10-06 与 10-08 各一次，2/2 的失败都是它**，
而且**没有任何一次带上飞书的真实 `code`/`msg`/`log_id`**（当天那版代码还没打这些字段）。
⇒ 这是"反复出现、但至今没有根因证据"的错误。
（⚠️ 对比：代码里已经有取真实错误的唯一口子 `server/src/utils/larkError.js` + `secondDeliveryService.js:586 larkErrorFields`，
**但线上那份 `secondDeliveryService.js` 的 mtime 是 2026-10-08 15:32:xx +08** ⇒ 这个修复**晚于**当天 09:05 那次失败，
而当天已认领为 `failed`、不再重跑 ⇒ **它到现在还没被触发过一次**。）

### 6.4 结论：**半通**

- ✅ **收尾款 + 交付这一半通了**：4 次真机成功、0 失败、0 重复写（幂等靠"未收款 / 未交付"两个状态）。
- 🔴 **"每日提醒卡"这一半没通**：**0 次发送成功、2 次硬失败（HTTP 400）**。
  后果是**"还没成交的单"根本不会出现在群里** —— 提醒的入口就是断的；
  「点卡片成交」这条腿也因此**线上从未被走过**（4 次全是群话题那条）。
- ⚠️ 对应她 2026-10-08 报的「**确认成交的按钮点了没反应，导致多次提交**」：
  那次（14:31:28 +08）服务端其实**两次都成功**（`lark.sales.card.update.succeeded` ×2，
  间隔 0.4 秒，第二次 `already_settled`），业务数据没重复写 —— 问题在**她看不见卡面变化**（客户端/显眼度），
  与"提醒卡发不出去"是**两件独立的事**，别混在一起修。

---

## 七、线上日志证据总表（只读，两份日志都算过）

| 链路 | 成功 | 失败 | 最近一次成功（+8） | 最近一次失败（+8） |
| --- | --- | --- | --- | --- |
| 1 换货 | `after_sales.executed` **1**（exchange） | **0** | 2026-10-08 00:03:38 | — |
| 2a 销售退货 | **0** | **0**（没跑过，不是失败） | — | — |
| 2b 采购退货 | `posted` **6** ＋ `batch.posted` **1**（5 条 / 12 双） | **0** | 2026-10-07 23:45:43 | — |
| 3 团购券（写入） | `v1.sale.posted` 中含券 **1** 笔（2 行收款明细） | **0** | 2026-09-27 16:20:54 | — |
| 3 团购券（**结算**） | **0**（无入口、无代码） | **0** | — | — |
| 4 二次交付·成交 | `sales.second_delivery.completed` **4** | **0** | 2026-10-08 14:31:28 | — |
| 4 二次交付·提醒卡 | `reminder.sent` **0** | `reminder.failed` **2** | —（从未成功） | **2026-10-08 09:05:20** |

> 服务器当前时间：`2026-10-08 17:53 +08`（本次核查起点）／最后一次看到的日志行 `2026-10-08 17:54 +08`。日志窗口：`2026-05-31T15:50Z` → `2026-10-08T09:54Z`，**无轮转**。

**反复出现的错误（全链路视角）**：
`Request failed with status code 400`（二次交付提醒卡 ×2、9 点待处理单推送 ×1）——
**同一秒出发、至今没有真实 code/msg**（是不是同一个群**未核**：两者读的群环境变量不同）。这是唯一一条"反复出现、且根因未知"的错误。

---

## 八、「后续绝不能被碰的中间处理逻辑清单」

> 🔴 业务负责人的担心原话是「怕改动会**动到中间的数据处理逻辑**」。
> 下面这些是**四条链路的中间处理逻辑**。**将来加扫码入口时，这清单里的函数一行都不许改**；
> 需要新入口 → **新写一个薄薄的入口层**，调这里已有的公开方法（或者在**新的**配置里加一个映射），
> **不要**在下面这些函数里加分支。

### 8.1 模块 A：售后（换货 / 退货 / 赔货）—— 链 1、2a

| 文件 | 不许碰的符号 | 属于什么 | 为什么碰不得 |
| --- | --- | --- | --- |
| `server/src/config/afterSales.js` | `AFTER_SALES_ACTION_SPECS`(`:103`)、`AFTER_SALES_FULFILLMENT`(`:42`)、`AFTER_SALES_FULFILLMENT_EXCLUDED`(`:68`)、`isAfterSalesFulfillment`(`:75`)、`afterSalesBatchHash`(`:190`)、`afterSalesEventId`(`:199`)、`afterSalesOperationId`(`:212`)、`actionSpecOf`(`:143`) | **动作语义 + 幂等键** | 幂等键的**构造**（原单 + 动作 + 明细批次哈希）一旦变形，**同一笔售后会被写第二遍或永远写不进去** |
| `server/src/config/afterSalesFlow.js` | `AFTER_SALES_CARD_ACTIONS`(`:19`)、`AFTER_SALES_TASK_STATUS`(`:37`)、`resolveAfterSalesAction`(`:86`)、`resolveAfterSalesSettlement`(`:141`)、`resolveAfterSalesPaymentMethod`(`:180`)、`resolveAfterSalesRestockState`(`:258`)、`afterSalesContextId`(`:274`)、`AFTER_SALES_ASK_TEXTS`(`:238`) | **意图/口径词表 + 卡片动作名 + 本地上下文键** | 卡片动作名是**回调契约**；`afterSalesContextId` 是跨消息序号上下文的键 |
| `server/src/services/afterSalesService.js` | `normalizeRequest`(`:182`)、`runWithGate`(`:266`)、`run`(`:319`)、`readOriginal`(`:390`)、`ensureMaster`(`:445`)、`buildPlan`(`:503`)、`ensureDetailRows`(`:577`)、`markOriginalDetails`(`:645`)、`settleCash`(`:687`)、`applyStock`(`:771`)、`stockSourceRecordIdOf`(`:816`) | **执行器：唯一写库处 + 幂等 + 断点续做** | ① 它是四条链路里**唯一**写售后事实的地方；② 断点续做靠"每个阶段写完就落盘 + 按位置复用"（`:606`、`:471`、`:720`）；③ `stockSourceRecordIdOf` 决定库存幂等键的来源行 |
| `server/src/services/afterSalesFlowService.js` | `handle`(`:146`)、`locateOriginal`(`:217`)、`buildPlan`(`:305`)、`resolveOutgoing`(`:426`)、`handleCardAction`(`:511`)、`confirmAfterSales`(`:573`)、`executorRequest`(`:632`) | **编排：定位 → 方案 → 卡片 → 转交执行器** | 「钱不能猜」（`:172`）与「话题内不跨单捞」（`:264`）都在这里；`executorRequest` 是编排层与执行器之间的**唯一契约** |
| `server/src/services/salesStatusWriter.js` | `write`(`:39`) | **状态维度唯一写入口** | 四个维度的名字/取值在 `config/salesStatusDimensions.js`；绕开它写就会写出表里不存在的选项 |

### 8.2 模块 B：库存（**四条链路全都经它**）

| 文件 | 不许碰的符号 | 属于什么 | 为什么碰不得 |
| --- | --- | --- | --- |
| `server/src/services/inventoryService.js` | `STOCK_MOVEMENTS`(`:128`；售后三条 `:183 / :192 / :199`，采购减少 `:175`)、`applyChange`、`applySale`(`:474`)、`operationId`、`executeOperation`、`runForStock` / `resumePending` | **库存行为注册表 + 实时库存增减 + 幂等 + 跨请求重放** | ① 注册表 = 方向 / 消耗哪些状态 / 是否触发补样品，**改它等于改业务**；② 幂等键是「来源行 record_id」；③ 它**跨请求重放**（AGENTS.md 明确记着 `AsyncLocalStorage` 被否掉的正是这个原因）⇒ 任何"从上下文悄悄取键"的改动都会把**上一笔单**挂到**当前请求**上 |

### 8.3 模块 C：退货单侧（**仅在采购退货**）

| 文件 | 不许碰的符号 | 属于什么 | 为什么碰不得 |
| --- | --- | --- | --- |
| `server/src/services/purchaseWebhookService.js` | `accept`(`:485`)、`acceptMany`(`:529`)、`process`(`:667`；**分流在 `:685-716`**)、`parseReportQuantities`(`:428`)、`processSupplierReturn`(`:2828`)、`handleReturnBatch`(`:2238`)、`flushReturnBatch`(`:2274`)、`runReturnBatch`(`:2369`)、`prepareSupplierReturn`(`:2530`)、`applySupplierReturn`(`:2621`)、`planReturnFromItems`(`:2112`)、`ensureReturnPlan`(`:2166`)、`ensureReturnBatchRecord`(`:2719`)、`deliverReturnImages`(`:2744`)、`sendReturnNotice`(`:2785`)、`recoverPendingReturnBatches`(`:2198`)、`readReportBehaviorKind`(`:2066`) | **采购退货的归批 / 核对冻结 / 幂等 / 出图发群** | ① `:685` 的**分流顺序**：退货必须在批次号之前分走，否则会被报货归批"补终态"**把库存扣减整个吞掉**（注释 `:687-689` 写得很清楚）；② `ensureReturnPlan` 的**冻结**是重试不多扣库存的唯一保障；③ `applySupplierReturn` 的落库顺序（报货信息 → 库存 → 出图）决定幂等来源行 |
| `server/src/services/purchaseQuantityPolicy.js` | 数量说明解析 | **报货/退货共用的解析** | 报货与退货**故意同一条解析**（她 2026-10-07 的口径） |
| `server/src/services/purchaseReportBehaviorPolicy.js` | `classifyReportBehavior` | **采购行为分流** | 读不到时"退回现状、不发明规则"（`:2056-2059`） |
| `server/src/services/purchaseOrderBatchService.js` | `createForReturnBatch`(`:93`) | **退货批次那一行** | 幂等键 `purchase_batch:<批次号>`；**刻意不写「到货状态」** |
| `server/src/config/purchaseReturnBatchWindow.js` · `server/src/config/reportBatchWindow.js` | 两个窗口 | **归批窗口（退货/报货各一份）** | 刻意不共用（解耦） |
| `server/src/routes/larkEvents.js` | `:138` 采购入口表分派 · `:154` 只认 `record_added` | **多维表格事件入口** | **表 ID 从 schema 读，不许写死**（写死的现象是"采购没反应、也不报错"） |
| `server/src/infrastructure/idempotencyKey.js` | `createOnceByKey` | **远端幂等写**（报货信息行 / 报货批次行） | 「幂等键」列是本地记录丢失后**唯一**的远端回查依据 |

### 8.4 模块 D：团购券

| 文件 | 不许碰的符号 | 属于什么 | 为什么碰不得 |
| --- | --- | --- | --- |
| `server/src/services/groupBuyVoucherPolicy.js` | `applyGroupBuyVoucherPolicy`(`:35`) | **券经济学（确定性，不靠模型）** | 它决定"写几条收款明细、金额各是多少"；金额算错就是**账错** |
| `server/src/config/groupBuyVouchers.js` | `findVoucher`(`:24`)、`voucherKey`(`:16`) | **券目录匹配（售价+面值）** | 只看面值会把 49.9 与 89.9 混成一张（注释 `:22`） |
| `server/src/config/salesCardFacts.js` | `PENDING_SETTLEMENT_STATUS`(`:35`)、`salesCardFactsFor`(`:132`) | **`待平台结算` 的唯一字面量 + 三段文案口径** | 全仓只有这一处定义；别处只许 `require` 转发 |
| `server/src/services/paymentService.js` | `record`(`:37`)、`recordInitialBatch`(`:100`)、`settlePlatformReceipt`(`:82`) | **收款明细的唯一写入口（含"待结算不写时间/方向"）** | 「未到账不写收款时间、不写方向」是**记账口径**，不是实现细节 |
| `server/src/services/salesProgressService.js` | `progressFromRecords`（`:28-49`） | **已收 / 待平台结算 / 还欠 的唯一算法** | 卡片、9 点推送、工作台三处**共用这一份**；改它三条一起变 |

### 8.5 模块 E：二次交付

| 文件 | 不许碰的符号 | 属于什么 | 为什么碰不得 |
| --- | --- | --- | --- |
| `server/src/services/secondDeliveryService.js` | `confirm`(`:96`)、`_confirm`(`:102`)、`listPendingDeliveries`(`:286`)、`markCardSettled`(`:217`)、`sendDailyReminder`(`:510`)、`_sendDailyReminder`(`:521`)、`paymentMethodNames`(`:477`)、`resolveDetailSize`(`:467`)、`loadItemIndex`(`:430`) | **候选口径 + 先收钱后交货的顺序 + 按天认领 + 卡片变灰** | ① 候选口径**只有一处**（9 点推送与成交提醒共用 genealogy 的那一份，注释 `:66-67` 明确要求不要判两遍）；② `confirm` 里**顺序**是先收钱再交货；③ `markCardSettled` **永不抛、永不影响成交结果**（`:213-216`） |
| `server/src/services/salesDeliveryService.js` | `deliver`(`:26`)、`_deliver`(`:32`) | **全仓唯一的销售扣库存 / 写「已交付」入口** | 任何"顺便再扣一次"的改动都会造成重复扣减 |
| `server/src/services/paymentService.js` | `collectPendingReceipt`(`:59`) | **未收款→已收款的唯一入口** | 金额必须等于该记录（`:67`），不许在这里"算差额" |
| `server/src/services/salesThreadProgressService.js` | `applyComplete`(`:587`)、`completeDealFromCard`(`:526`)、`deliverUndelivered`(`:439`)、`resolveCompletePaymentMethod`(`:488`)、`pendingPaymentsFor`(`:497`) | **群话题「成交」判定的唯一处** | ① 「整单完成 = 等于点成交按钮」；② 钱没法定时**先做货再回问**（`:601-631`）；③ `pendingPaymentsFor` 是"有没有待收款"的**唯一取法** |
| `server/src/services/salesFollowupService.js` | `addPayment`(`:80`)、`listOrders`(`:25`) | **工作台写入类那一半** | 它自己带 `request_id` 幂等 + 状态机（`pending → recorded → completed`），别在别处复制一份 |
| `server/src/config/secondDeliveryCard.js` + `server/src/utils/larkCards.js` | `secondDeliveryCard`(`:1128`)、`secondDeliveryOrderLines`(`:1093`)、`settleSecondDeliveryOrder`(`:1172`)、`SECOND_DELIVERY_ACTION`(`:1083`) | **卡片渲染 + 按钮动作名 + 变灰** | 按钮 `value`（含 `reminder_day`）是**回调契约**；`settleSecondDeliveryOrder` 保证"别的单一个字都不动" |
| `server/src/utils/secondDeliveryReminder.js` | `startSecondDeliveryReminder`(`:30`)、`shanghaiHour`(`:22`) | **9 点定时器（+8 手动换算）** | 服务器是 UTC，改用本地时区取小时会**少推一天** |
| `server/src/infrastructure/interactiveCardFeedback.js` | `updateInteractiveCard`(`:35`) | **卡片 patch 的唯一实现** | `im.message.patch` 的细节与失败日志只该有一处 |

### 8.6 跨模块：**入口层与"中间逻辑"的分界线**

| 可以动的（**入口层**） | 不许动的（**中间逻辑**） |
| --- | --- |
| 新入口的**分发**：`routes/larkEvents.js` 的卡片动作分派表、`larkMvpService.handleCardAction` 的**动作 → 服务**映射、工作台新路由、新的卡片模板 | 上面 8.1–8.5 的**服务方法与配置**（尤其幂等键构造、状态取值、写库顺序、库存注册表） |
| **新增**配置文件里的新动作（例：一个新的 `action` 常量 + 一个新的 spec 条目） | 改**既有** spec 的语义字段（`tradeTypeCode` / `originalFulfillmentStatus` / `movements`） |
| 新入口自己的一层薄 service（它只做"解析用户输入 → 调已有方法"） | 在既有 service 里加 `if (来自扫码) …` 这类分支 |

---

## 九、风险点（按严重度）

| # | 风险 | 证据 | 影响 |
| --- | --- | --- | --- |
| 🔴 1 | **二次交付提醒卡从未发出过**：2 次 HTTP 400，0 次成功，当天失败后**当天不再重试** | `reminder_day_2026-10-06.json` / `2026-10-08.json` = `status:"failed"`；error 日志 2 条 `reminder.failed`；`reminder.sent` **0 次** | 「还没成交的单」**不会出现在群里** ⇒ 提醒这条腿是断的；「点卡片成交」也因此**从未被验证** |
| 🔴 2 | **同一个 400 至今没有根因证据**：日志只有 `Request failed with status code 400` | 两条 `reminder.failed` + 一条 `sales.pending_deal_push.failed`，**都没有** `code`/`msg`/`log_id` | 明天 9 点**很可能再炸一次**；而"打真实错误的补丁"所在文件在线上是 **15:32** 的版本（**晚于**当天 09:05 那次失败）、**当天已认领 ⇒ 还没被触发过** |
| 🟠 3 | **销售退货链路线上 0 次** —— 第一次真机就是生产首跑 | `after_sales.executed` 只有 exchange；`SALE_RETURN` 库存动作 1 次（换货那条腿） | 它一动**三件事**：原明细状态、库存 +1、收款明细（退回）。首跑出问题就是**生产事故** |
| 🟠 4 | **换货的「新明细行 = 已交付」补丁线上未验证** | 真机 2026-10-08 00:03:38 **早于** 补丁 00:11:33 / 部署 12:12:47 | 她真机看到的那个"空格"是否真被修好，**线上还没有证据**；而这条正是她 10-08 提的问题 |
| 🟠 5 | **团购券"收回来"这半条连代码都没有** | `settlePlatformReceipt` 零调用方；无「确认到账」动作；9 点推送无该区块；`docs/push-blocks-caliber-2026-10-08.md:59` 自述"第二步" | 那笔 85.4 会**永远停在「待平台结算」**，越积越多；她说的"跑通"在这一半**必然为假** |
| 🟡 6 | **换货后的单仍会出现在"按货号查可退候选"里** | `config/saleLookup.js:24-25`：排除判据只有 `销售状态=已退货/部分退货` 与 `交易类型=销售退货`；**不含** `履约状态=已换货` | 她可能再挑到已换过货的那一条；执行器的指纹闸门能拦住**同一批明细**，但**同单另一条明细**仍可再动 ⇒ 需要业务口径确认（是否符合"部分退货"预期） |
| 🟡 7 | **关键 E2E 脚本未提交**（`server/scripts/e2e-sales-group-scenarios.mjs`，1433 行，`git status` 显示 `??`） | `git status --porcelain` | 只有本机能跑；一旦工作区被清理，**链 1/2a 唯一的真链路回归手段就没了** |
| 🟡 8 | **最新一版代码刚部署（2026-10-08 17:51 +08），四条链路都还没在真机上跑过这一版** | `/opt/…/purchaseWebhookService.js` mtime `2026-10-08 17:51:40 +08`；`secondDeliveryService.js` mtime `2026-10-08 15:32` | 今天 17:51 之后的任何真机行为都还没被观察过 |

---

## 十、待办：把「我还没查到这一步」收口（需要读一次 Base，本次没做）

> 🔴 硬约束：本次**没有**读任何 Base（线上只跑了 grep/cat）。下面几条**必须**用项目代码**只读**核一次事实表/流水才能定论；
> 在那之前，本文的对应结论**只到日志这一层**。

| # | 要核什么 | 为什么（判据出处） |
| --- | --- | --- |
| 1 | 「销售明细.交易类型」的取值分布 —— 确认**没有任何一行**是 `销售退货` | 支撑"销售退货线上 0 次"（本文只有日志证据） |
| 2 | 「销售明细.履约状态」在 `XSD-20261007-0054`（新明细 `reczz28KZzAY4BBi` 那一类行）上**现在是不是 `已交付`** | 判 5.3 / 风险 4：补丁后**到底有没有**写进去（该行是补丁**之前**写的，**必然为空** —— 要核的是"之后有没有新样本"，目前没有） |
| 3 | 「收款明细」里 `收款状态 = 待平台结算` 的行数与金额 | 本文引用的是 `docs/push-blocks-caliber-2026-10-08.md:48`（**别人 15:00 的结果**） |
| 4 | 「库存流水」在 `CGD-20261007-0001` 这批上是不是**正好 12 条**、方向都是"采购减少" | 与 `purchase.return.batch.posted item_count=12 doc_count=12` 对账（日志只有计数，没有逐条） |
| 5 | 「报货批次」`reczz28KZh82K4EP` 的 `单据` 列里有 `三星-退货单.png`、且**没有**「到货状态」 | 验"退货批次行不写到货状态" |
| 6 | 飞书侧对那张失败卡片的真实拒绝原因（`code`/`msg`/`log_id`） | 风险 2：靠**下一次** 9 点 tick（补丁已上线）拿到真实四项 |

---

## 附：本次核查用到的只读命令（可复现）

```bash
# 仓库状态（只读）
git rev-parse --short HEAD && git rev-list --count HEAD..origin/main

# 线上（只读；严禁 pm2 / git / 写操作 / 重启）
ssh -o BatchMode=yes -o ConnectTimeout=10 43.143.239.42 \
  'grep -o "\"event\":\"after_sales[^\"]*\"" ~/.pm2/logs/box2bitable-server-out.log | sort | uniq -c'
ssh … 'grep "second_delivery\|purchase.return" ~/.pm2/logs/box2bitable-server-error.log'   # ⚠️ 失败事件只在 error 日志
ssh … 'cat /opt/box2bitable/server/data/second_delivery_reminder/reminder_day_2026-10-08.json'
ssh … 'grep -rn "settlePlatformReceipt" /opt/box2bitable/server/src /opt/box2bitable/server/public'
ssh … 'ls -la --time-style=full-iso /opt/box2bitable/server/src/config/afterSales.js'      # 比对"真机那次跑的是不是补丁后"

# 本地（只读跑测试）
cd server && node --test --test-concurrency=1 test/afterSales*.test.js
cd server && node --test --test-concurrency=1 test/secondDelivery*.test.js test/terminalCardConfirmDeal.test.js
cd server && node --test --test-concurrency=1 test/purchaseReturn*.test.js
```
