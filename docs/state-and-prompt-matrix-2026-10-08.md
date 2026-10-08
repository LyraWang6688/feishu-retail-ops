# 状态 → 处理规则 → 提示 → 出口 总表（2026-10-08）

> **这份文档给谁看**：业务负责人（非技术）+ 工程师，用来对齐同一件事：
> **每个模块的入口是什么 → 入口之后系统内部处于哪个状态 → 每个状态走哪条处理规则 → 她实际会收到哪句话 → 结果落在哪里（出口）**。
>
> **规矩**：本文**只写代码里真实存在的东西**，每一条都带 `文件:行`。
> 代码里找不到的，一律写「**未找到**」——不写"应该是"、不写猜测。
> 提示文案**逐字照抄**代码里的中文原文（含标点、波浪号、emoji）。
>
> ⚠️ **本文档只读代码得出，没有改任何一行代码。**
> 本文档写于 `dbd0180`（`feat(labels): 工作台鞋盒标签打印页`）。

---

## 0. 先看这一张：入口在哪、怎么被认领

这是所有模块的**共同上游**。看懂了这张，下面每张模块表才有位置。

| 入口（HTTP / 事件） | 谁在收 | 认领判据 | 定义处 |
|---|---|---|---|
| `im.message.receive_v1`（群/话题消息） | `service.acceptMessage(event)` | 群聊 → 先判 `thread_id`（有值 = 话题，**免 @ 一律理**）；主群（`thread_id` 空）→ `@机器人` / 正文过销售闸门 / 正文有采购批次号，**三条任一条** | `server/src/routes/larkEvents.js:23`、`:42`；`server/src/services/larkMvpService.js:784`、`:803`、`:897` |
| `card.action.trigger`（卡片按钮 / 表单提交 / 下拉） | `service.handleCardAction(event)` | 按 `value.action` 分派（11 个动作名，见第 10 节与各模块表） | `server/src/routes/larkEvents.js:49`、`:74`；`server/src/services/larkMvpService.js:1992` |
| `drive.file.bitable_record_changed_v1`（多维表格记录变更） | `service.purchaseWebhooks.acceptMany(...)` | 只认**一张表**：`purchaseReport`（供应商报单）；只处理 `action === 'record_added'` | `server/src/routes/larkEvents.js:90`、`:137`、`:183` |
| `GET/POST /api/workbench/*`（网页工作台） | 各 controller | `API_KEY`（`x-api-key`）+ 飞书身份 | `server/src/app.js:78`；`server/src/routes/workbench.js` |
| 定时器（每天 9 点等） | `PendingDealPushService` | `PENDING_DEAL_PUSH_ENABLED` + 上海时区整点 | `server/src/services/pendingDealPushService.js`；`server/src/config/pendingDealPush.js:95` |

**⚠️ 关键事实（后面第 11 节会展开）**：`/api/lark/events` 收到的三类事件，**各自在 `larkEvents.js` 里硬编码分派**，
没有一个"入口注册表"。卡片动作那一路尤其明显——`handleCardAction` 是一串 `if (action === ...) return ...`
（`server/src/services/larkMvpService.js:2002`–`:2050`），**顺序有意义**（注释里写了"位置有意放在这里"）。

---

## 1. 销售录单（群聊自然语言 → 草稿 → 确认卡）

### 1.1 入口

| 入口 | 来源 | 认领处 |
|---|---|---|
| 主群自然语言（新开一笔） | `thread_id` 为空 + 过闸门 | `larkMvpService.js:897`（`resolveMainChatAdmission`）→ `:939`（`groupSalesFlow.handleGroupSalesMessage`） |
| 主群 `@机器人`（新开一笔） | `mentions` 命中机器人 open_id | `larkMvpService.js:898` |
| 话题里后续消息（绑定到**已定位那一笔**） | `thread_id` 有值 + 本地映射命中 | `salesGroupFlowService.js:50`（`locator.resolve`）→ `:56`（`dispatch('continueInThread')`） |
| 文里有采购批次号 | `CGD-…` / `BH-…` | `larkMvpService.js:905`（判成采购，**不进销售**） |
| 业务表变更事件 | —— | **未找到**（销售**没有**表事件入口；只能由群消息进） |

分派器 `SalesGroupFlowService` 的四个 return（决定"归销售还是交回采购"）：

| 判据 | 结果 | `文件:行` |
|---|---|---|
| 话题映射命中 | `handled:true, mode:'thread'` | `server/src/services/salesGroupFlowService.js:59` |
| 在话题里但没记过映射 | `handled:false, reason:'unmapped_thread'` → 交回采购 | `server/src/services/salesGroupFlowService.js:64` |
| 正文有采购批次号 | `handled:false, reason:'purchase_batch_no'` | `server/src/services/salesGroupFlowService.js:68` |
| 正文不像销售 | `handled:false, reason:'not_sales_text'` | `server/src/services/salesGroupFlowService.js:72` |

### 1.2 状态 → 处理规则 → 提示 → 出口 → 幂等

> ⚠️ **本模块的草稿状态没有枚举常量**——全部是散在 service 里的**字符串字面量**（见第 10 节第 1 条）。
> 下表的"取值"就是字面量原文。

| 入口 | 状态（取值 + 定义处 `文件:行`） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 群消息 | `'received'`（`larkMvpService.js:1022`） | `acceptSalesText` 建任务后立刻 `setImmediate` 入 sender 队列跑 `processSalesTask`（`:1040`）；`processSalesTask` 先问二次处理（`:1569`） | 无文字；加 `OneSecond` 表情（`:935`） | —— | 同一 `message_id` 已建任务即返 `duplicate`（`:1005`–`:1006`） |
| 群消息 | `'ignored'`（`:1640`） | AI 认出的意图不是 `sale` → 记状态 + 回引导语，**不建单** | `这个我还没学会～你可以说"卖一双 6035黑 42码 199"，或者"帮我查 6035 黑"`（`config/messageGate.js:35`–`:36`） | `sendTaskText`（`:1648`） | —— |
| 群消息 | `'parsing'`（`:1664`） | 建/复用销售主表记录，写 `sales_entry_record_id` | 无 | —— | `task.sales_entry_record_id` 存在则**复用**、不新建（`:1657`–`:1660`，日志 `lark.sales.entry.reused`） |
| 群消息 | `'needs_info'`（`:1942`） | 解析出缺项（`draft.missing_fields` 非空）→ 回缺项说明，**不发卡片** | 渲染器（`config/salesMissingInfoText.js`）逐条，原文例：<br>`销售信息还缺 {count} 处，请照着补一下～`（`:98`）<br>`请给每双鞋都说一个成交金额：{items}`（`:102`）<br>`{item} 没说货号，请补一下货号～`（`:117`）<br>`收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～`（`:125`）<br>`带定金的单一次只能记一双，请把这两双分开发送～`（`:131`–`:132`）<br>`尾款还没付就请补一句「尾款以后付」，已经付了就补一句实收金额～`（`:153`）<br>「货号没建档」那句在 `config/salesProductRegistration.js` | `sendTaskText`（`:1955`–`:1957`） | —— |
| 群消息 | `'ready_to_confirm'`（`:1942`、`:2362`、`:2449`、`:2646`） | 品项齐 → 渲染 `salesConfirmationCard` 发给**那条话题** | 卡片本身（卡面标题/按钮文案见 `utils/larkCards.js` 的 `salesConfirmationCard`） | `sendTaskCard`（`:1969`）→ `replyCardInThread`（`:557`） | —— |
| 卡片 `choose_sale_color` | 写回 `'ready_to_confirm'`（`:2449`） | 用她选的颜色查实时库存定类型，重渲染确认卡 | 读不到库存时：`暂时读不到库存，请再点一次颜色～`（`config/salesColorChoice.js:35`） | `publishSalesResultCard`（`:2450`）、失败时 `sendTaskText`（`:2409`） | —— |
| 卡片 `choose_sale_sample_replacement` | 写回 `'ready_to_confirm'`（`:2362`） | 记下"用哪个门盒补样品"，重渲染确认卡 | toast：`第 ${itemIndex + 1} 双将用 ${size}码的门盒补样品`（`:2368`） | `publishSalesResultCard`（`:2363`） | —— |
| 卡片 `modify_sale` | `'awaiting_correction'`（`:2340`） | 写主表确认状态「待修改」+ 换卡 + 回一句让她重发 | 卡面：`等待重新发送` / `原草稿不会入账；请重新发送完整销售信息。`（`:2344`）<br>话题：`请重新发送一条完整、正确的销售信息；原草稿不会入账。`（`:2346`）<br>toast：`请重新发送修正后的完整销售信息`（`:2348`） | `publishSalesResultCard`（`:2344`）+ `sendTaskText`（`:2346`） | 再点其它动作时被拦：`该草稿正在等待修正，请重新发送完整销售信息`（`:2317`） |
| 卡片 `cancel` | `'cancelled'`（`:2330`） | 写主表确认状态「已取消」+ 换成取消卡 | 卡面：`销售录单已取消` / `原草稿不会入账。`（`:2333`）<br>toast：`已取消`（`:2336`） | `publishSalesResultCard`（`:2333`） | 终态早退 `:2290` |
| 卡片 `confirm_sale` / `confirm_sale_pending` / `confirm_sale_delivered` | `'posting'`（`:2469`） | `postSale`（写主表/明细/收款）→ 交付 | 卡面先换成"处理中"卡（`config/salesProcessingCard.js`）；卡片改不动时补一句：`已收到确认，正在写入销售记录和收款，请稍候。`（`:2493`） | `updateSalesActionCard`（`:2490`）、回落 `sendTaskText`（`:2493`） | `'posting'` 再点 → `正在入账，请勿重复点击`（`:2315`）；有已写记录时禁止取消/修改（`:2321`–`:2327`） |
| 卡片 confirm（入账成功、交付完成） | `'posted'`（`:2613`） | 发绿色终态卡；按 `needsConfirmDeal` 决定要不要带【确认成交】按钮 | 卡面：`销售订单已入账` + `销售单号：…；N 条明细已写入。`（`:2621`–`:2622`）<br>toast 来自 `config/salesDeliverySummary.js` | `publishSalesResultCard`（`:2621`） | 交付失败条数落 `task.delivery_failures`（`:2578`）；`posting_record_ids` 逐条落盘（`:2519`–`:2525`） |
| 卡片 confirm（入账成功、交付未完成） | `'posted_delivery_pending'`（`:2552`） | 发橙色卡 + 那句"未交付"清单；带【确认成交】按钮 | 卡面：`订单已入账，部分交付` / `订单已入账，交付待处理` + `已交付 x/y 双；未交付：…`（`:2588`–`:2589`、`:2604`）<br>toast：`订单已入账，已交付 x/y 双；其余待处理`（`:2597`） | `publishSalesResultCard`（`:2587`、`:2603`） | 同上 |
| 入账抛错 | 退回 `'ready_to_confirm'` + `posting_error`（`:2646`） | 回退卡片（只留一个"继续处理"按钮） | 卡面：`销售明细和收款已记录，但进度同步尚未完成，库存未扣。…请稍后在原卡片重试，不要重新发送销售。`（`:2666`–`:2667`）<br>`入账失败；可能已有部分记录，库存未扣。…`（`:2668`）<br>toast：`销售记录已写入，进度待同步；库存未扣，请稍后在原卡片重试` / `销售尚未完成，请核对原卡片后重试；不要重新发送销售`（`:2674`–`:2676`） | `publishSalesResultCard`（`:2670`） | 注释明写"Posting services are idempotent"（`:2642`），靠下游服务自己的状态判据 |
| 任务级异常 | `'failed'`（`:2685`） | `handleTaskFailure` | `处理失败：${error.message}`（`:2686`） | `sendTaskText`（`:2686`） | —— |
| 空文本 / 只 @ 了机器人 | 不落状态 | `acceptGroupMessage` 直接转给采购流程问清楚（不回销售） | 见第 5 节 | `groupPurchaseFlow.handleGroupPurchaseMessage`（`:927`） | —— |

### 1.3 这个模块里"没有对应提示"的状态

| 状态 / 情形 | `文件:行` | 为什么说它没提示 |
|---|---|---|
| `'received'` | `larkMvpService.js:1022` | 建完任务只加一个 `OneSecond` 表情，**没有文字**；她被"晾"到 AI 出结果 |
| `'parsing'` | `larkMvpService.js:1664` | 只写本地状态；解析 + 读库存那段（可能十几秒）**一句提示都没有**（日志 `lark.sales.processing.started` 只进日志） |
| `'ignored'` 的空文本那一支 | `larkMvpService.js:924`–`:934` | 话题里只 @ 了机器人、没写字 → 转采购流程，**销售侧一个字都不回** |
| 群聊发图片/文件 | `larkMvpService.js:821`–`:828` | **静默忽略**（注释：「群里回一句"我只接收文字"同样会刷屏」） |
| 主群消息没过三条判据 | `larkMvpService.js:811`–`:817` | **完全静默、零远端调用**（业务上是有意的；但"她以为发了、其实没被理"这件事没有反馈） |
| 重复投递 | `larkMvpService.js:1006` | 返 `duplicate`，**不回话** |

### 1.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 销售卡片 | `larkMvpService.js:1968`–`:1970` | `task.chat_type === 'group'` 才发；否则 `skipNoGroupContext('card', task)` 返 `null`（**"按来源选出口"不存在**：只有"群 / 没有群"两档） |
| 话题回复 | `larkMvpService.js:544`–`:545` | `options.threadId` 有值才带 `reply_in_thread`；`threadId` 由**调用方**传（`:533` 注释明写"判据在调用方"） |
| 深链 | `larkMvpService.js:723`–`:730` | 只认 `chat_type === 'group'`；**话题级深链**（不含 message_id），且只在 `writeThreadLink` 时写一次 |
| 「销售单号读不到」 | `larkMvpService.js:2299` | 硬编码字符串 `'请在销售主表核对'`（配置里另有一份 `config/salesConfirmDeal.js:87` `orderNoFallback`，**两处并存**） |

### 1.5 业务表上的四个状态维度（**这一块反而有集中定义**）

销售主表四列的值域与"代码要写的值"**有唯一一处定义**（与本地任务状态不同）：

| 维度（真实列名） | 值域 | 代码写入值 | `文件:行` |
|---|---|---|---|
| `确认状态`（`userAction`） | 未确认 / 已确认 / 已取消 / 待修改 | `pending`/`confirmed`/`cancelled`/`toModify` | `server/src/config/salesStatusDimensions.js:38`、`:51`、`:72`–`:74` |
| `销售状态`（`sales`） | 未写入 / 部分写入 / 已写入 / 写入失败 | 同四值 | `:39`、`:52`、`:75`–`:77` |
| `资金状态`（`funds`） | 未写入 / 已写入 / 写入失败 | 同三值 | `:40`、`:53`、`:78`–`:80` |
| `库存状态`（`stock`） | 未写入 / 部分写入 / 已写入 / 写入失败 | 同四值 | `:41`、`:54`、`:81`–`:83` |

写入器：`SalesStatusWriter.write`（`server/src/services/salesStatusWriter.js:39`），允许写的键白名单 `STATUS_KEYS`（`:21`）。
「账做完了没有」的判据唯一：`isPosted(postedOf(...))`，认 `已入账` / `已写入` 两个值（`salesStatusDimensions.js:66`–`:67`）。

---

## 2. 确认成交（卡片按钮）+ 二次交付（成交提醒卡）

### 2.1 入口

| 入口 | 动作名（常量） | 分派处 |
|---|---|---|
| 【确认成交】按钮（做在**已入账终态卡**上，不新发消息） | `confirm_sale_deal`（`SALES_CONFIRM_DEAL_ACTIONS.CONFIRM`，`config/salesConfirmDeal.js:30`） | `larkMvpService.js:2039`–`:2042`；进 `cardActionQueue` 串行队列 |
| 「第二次交付」每日提醒卡上的【成交】 | `confirm_second_delivery`（`SECOND_DELIVERY_ACTION`，`utils/larkCards.js:1083`） | `larkMvpService.js:2032`–`:2033` → `handleSecondDeliveryAction`（`:2061`） |
| 按钮**出现**的判据（不是点击入口） | `needsConfirmDeal`（纯函数） | `config/salesConfirmDeal.js:160`；四个渲染点共用 `confirmDealOptionFor`（`larkMvpService.js:2100`） |

### 2.2 状态 → 处理规则 → 提示 → 出口 → 幂等

| 入口 | 状态（枚举名 + 取值 + 定义处 `文件:行`） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（config 键 + 中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 【确认成交】 | `SETTLED = 'confirm_deal_settled'`（`config/salesConfirmDeal.js:37`） | 钱货两清；`threadProgress.completeDealFromCard`（`salesThreadProgressService.js:526`）→ `applyComplete`（`:587`）→ `secondDelivery.confirm`（`:633`） | toast：`这一单已经成交，无需重复处理`（`alreadyToast`，`config/salesConfirmDeal.js:94`）<br>成交成功：`已成交：{summary}`（`successToast`，`:95`）<br>summary 组成：`补收款 ￥N` / `交付 N 双` / `无待处理项`（`larkMvpService.js:2220`–`:2228`）<br>卡面：`销售订单已成交`（`settledTitle`，`:76`）+ `✅ 已成交{clock}`（`settledText`，`:77`）+ `销售单号：{orderNo}；已成交。`（`settledMessage`，`:79`）<br>有未交付时追加：`仍未交付 {count} 双，请到工作台核对。`（`settledUndelivered`，`:85`） | patch**她点的那张卡**：`settleConfirmDealCard`（`larkMvpService.js:2257`）→ `updateSalesActionCard`（`:2277`）；话题回话：`sendTaskText`（经 `salesThreadProgressService.reply`，`:696`） | ① 任务状态早退（`larkMvpService.js:2130`，**仍然补一次卡面自愈** `:2142`）；② `SecondDeliveryService`/`PaymentService`/`SalesDeliveryService` 自己的状态判据；③ `cardActionQueue` 串行（`:2040`） |
| 【确认成交】 | `SHORT_STOCK = 'confirm_deal_short_stock'`（`config/salesConfirmDeal.js:39`） | **一个字节都不写**（不写钱、不写交付、卡片不变灰） | toast / 话题：`这双还没到货（或库存不够），先走到货入库，到货之后再到这张卡上点「确认成交」。`（`shortStock`，`:90`；发出点 `salesThreadProgressService.js:543` 与 `:657`） | toast + 话题回话 | 注释明写 `written: false`（`salesThreadProgressService.js:550`、`:665`）；到货后重点一次是安全的 |
| 【确认成交】 | `ASKING = 'confirm_deal_asking'`（`config/salesConfirmDeal.js:41`） | "货那一半"先做掉，钱**回问一句**（不替她挑方式） | toast：`货已经记成交了；这笔钱是怎么收的？说一句我再记账`（`askingToast`，`:92`）<br>话题另一句：`好，还没交的 {count} 双记成已交付了。这笔钱是怎么收的？说一句（例：收到微信 500）我再记账。`（`config/salesProgressIntake.js:126`–`:127`，`completeAskMethod`） | toast + 话题回话（`salesThreadProgressService.js:612`–`:614`） | 交付走 `deliverUndelivered`（`:439`）——只挑"未交付"的行 |
| 【确认成交】 | `FAILED = 'confirm_deal_failed'`（`config/salesConfirmDeal.js:43`） | 吞错、记状态、记 `confirm_deal_reason` | toast：`这次确认成交没做完：{reason}`（`failedToast`，`:98`） | toast（`larkMvpService.js:2214`–`:2215`）；日志 `lark.sales.confirm_deal.failed`（`:2211`） | —— |
| 按钮出现判据 | `needed / reason` 四档：`delivery_failed` / `undelivered` / `unsettled` / `completed`（`config/salesConfirmDeal.js:158`） | `needsConfirmDeal` 判"要不要这个按钮" | 按钮文案：`确认成交`（`buttonLabel`，`:72`）<br>按钮上方小字：`点一次「确认成交」才会继续走后续流程。`（`hint`，`:74`） | 作为 `confirmDeal` 选项传给卡片渲染（`larkMvpService.js:2110`） | 四个出口共用同一判据（`:2097`–`:2098` 注释） |
| 【成交】（二次交付卡） | **没有状态枚举**（`secondDeliveryService` 直接写业务表；**未找到**任务状态机） | `handleSecondDeliveryAction`（`larkMvpService.js:2061`）→ `secondDelivery.confirm`（`:2062`） | `这一单已经成交，无需重复处理`（`:2075`）<br>`已成交：补收款 ￥N，交付 N 双`（`:2087`）<br>部分交付：`已成交：…；还有 N 双交付未完成，请到工作台待交付列表核对`（`:2084`–`:2085`） | patch 卡片（`SecondDeliveryService.markCardSettled`，见 `:2058` 注释） | `result.alreadyCompleted` 短路（`:2074`） |
| 二次交付卡本身 | 卡片文案（无状态名） | —— | 标题：`待成交 / 待收款`（`config/secondDeliveryCard.js:22`）<br>`未收 {amount}`（`:27`）<br>`未交付 {count}/{total} 双`（`:28`）<br>`待核对`（`:30`）<br>空卡：`今天没有待成交的单`（`:32`）<br>`✅ 已成交{clock}`（`:34`）<br>类型读不出时的兜底：`待处理`（`:25`） | 发到**她所在的那个群/话题**（见第 11 节） | —— |

### 2.3 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `FAILED` 时**卡片不改** | `larkMvpService.js:2202`–`:2216` | 只弹 toast + 写本地状态；`settleConfirmDealCard` 只在 `settled` 时调。**卡片停在"还能点"的样子**，靠她再点一次触发自愈 |
| `ASKING` 时**卡片不改** | `larkMvpService.js:2196`–`:2201` | 同上：橙色"还能点"的卡 + 一句 toast |
| `alreadyDone`（钱货本来就齐） | `larkMvpService.js:2188`–`:2194` | toast 用 `alreadyToast`（"这一单已经成交，无需重复处理"），**但仍会把卡改成"已成交"**（`:2179`–`:2186`）——语义上是自愈，不是真重复 |
| `handleSecondDeliveryAction` 的 `parts` 为空 | `larkMvpService.js:2087` | 靠硬编码 `'无待处理项'` 兜底（**不在 config 里**） |

### 2.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 成交后的卡面 | `larkMvpService.js:2277` | `updateSalesActionCard`（内部优先用回调带回来的 `open_message_id` = 她点的那张卡） |
| 成交回话 | `larkMvpService.js:2156`–`:2159` | 本地任务读不到时**硬造一个** `{ chat_type: 'group' }` 的任务壳（宁可回错地方也要把业务做完） |
| 二次交付卡发到哪 | `pendingDealPushService.js` + `config/pendingDealPush.js` | **按配置的固定群**（`PENDING_DEAL_PUSH_CHAT_ID`），**不是**按这次成交的来源 |

---

## 3. 销售进展（收款 / 交付的补充对话）

### 3.1 入口

| 入口 | 判据 | 处 |
|---|---|---|
| 话题里的自然语言 | `task.chat_type === 'group'` ＋ `task.sales_entry_record_id` 非空 | `salesThreadProgressService.js:177`（不在群话题/没定位到销售 → `handled:false`，原样往下走销售原话解析） |
| 上游先放宽入口闸门 | `threadSaleProgress` 为真时**绕过**销售闸门 | `larkMvpService.js:994`–`:996` |

### 3.2 判据结果（`PROGRESS_KINDS`）与状态（`PROGRESS_TASK_STATUS`）

两个枚举都在 `server/src/config/salesProgressIntake.js`：

| 枚举名 | 取值 | 定义处 |
|---|---|---|
| `PROGRESS_KINDS.PAYMENT` | `'payment'` | `config/salesProgressIntake.js:216` |
| `PROGRESS_KINDS.DELIVERY` | `'delivery'` | `:217` |
| `PROGRESS_KINDS.COMPLETE` | `'complete'` | `:218` |
| `PROGRESS_KINDS.AMBIGUOUS` | `'ambiguous'` | `:219` |
| `PROGRESS_KINDS.NONE` | `'none'` | `:220` |
| `PROGRESS_TASK_STATUS.APPLIED` | `'progress_applied'` | `:140` |
| `PROGRESS_TASK_STATUS.ASKING` | `'progress_asking'` | `:142` |
| `PROGRESS_TASK_STATUS.ASKED_UNKNOWN` | `'ignored'` | `:144` |
| `PROGRESS_TASK_STATUS.FAILED` | `'progress_failed'` | `:146` |
| `PROGRESS_TASK_STATUS.NOTICE` | `'progress_notice'` | `:150` |

> ⚠️ `ASKED_UNKNOWN` 的**取值是 `'ignored'`**（与销售草稿的 `'ignored'` 同字面量、不同含义）——排查时按值 grep 会串。

### 3.3 状态 → 处理规则 → 提示 → 出口 → 幂等

| 入口 | 状态（枚举 + 取值 + 定义处） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（config 键 + 中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 话题消息，kind = `none` | **不落状态**（返 `handled:false`） | `classify` 判不出进展 → 交回销售原话解析 | 无 | —— | —— |
| 话题消息，kind = `ambiguous` | `ASKED_UNKNOWN = 'ignored'`（`:194`） | 只回问一句，**不回退**当新原话 | `这是在说这笔的收款进展吗？如果是，把「收了多少、什么方式」说一遍（例：收到微信 500）。`（`replies.ambiguous`，`:110`） | `reply`（`:192`）→ `sendTextToTask`（`:696`→`:698`） | —— |
| 话题消息，kind ∈ {payment, delivery, complete}，**`textTrigger=false`（默认）** | `NOTICE = 'progress_notice'`（`:216`） | **零写库**：只回一句"请点卡片" | `这单请在卡片上的【确认成交】点一下～`（`replies.textNotice`，`:108`；空串回退默认 `:187`） | `reply`（`:315`） | **节流**：同一话题 `textNoticeWindowMs`（默认 300000ms）内只回一次（`:283`–`:313`，记录落 `data/sales_progress_notices/`）；读写失败 fail-open（`:308`、`:330`） |
| 话题消息，`textTrigger=true`（旧行为）→ payment | `APPLIED`（`:249`）或 `ASKING`（`:249`） | `applyPayment`（`:345`）：核方式 → 读主表 → 算待收 → 翻「未收款」或新建收款 → `progress.sync` | `收到多少？说个数我再记（例：收到微信 500）。`（`needAmount`，`:111`）<br>`这笔钱是怎么收的？微信还是现金？`（`needMethod`，`:112`）<br>`这一笔还没入账，先把上面那张确认卡片点一下，我再记这笔进展。`（`notPosted`，`:114`）<br>`好，记上了：{method} 收 {amount}。`（`paymentDone`，`:115`）<br>`这一笔的收款和交付都已经齐了，我没有重复写。`（`nothingPending`，`:119`） | `reply`（`:353`、`:357`、`:363`、`:370`、`:415`） | 「未收款」占位翻写成「已收款」+ 写收款时间（`:407`–`:412`）；多条待收款直接抛错（`:392`） |
| 同上 → delivery | `APPLIED` / `ASKING` | `applyDelivery`（`:453`）：挑未交付明细 → `delivery.deliver` | `好，还没交的 {count} 双记成已交付了。`（`deliveryDone`，`:116`） | `reply`（`:467`） | 只挑 `fulfillmentStatus !== '已交付'`（`:443`） |
| 同上 → complete | `APPLIED` / `ASKING` | `applyComplete`（`:587`）：问方式 → 先做货 → `secondDelivery.confirm` | `好，这一单成交了：{summary}。`（`completeDone`，`:117`）<br>`这一单已经是成交状态了，我没有重复写。`（`completeAlready`，`:118`）<br>`好，还没交的 {count} 双记成已交付了。这笔钱是怎么收的？…`（`completeAskMethod`，`:126`–`:127`） | `reply`（`:612`、`:639`、`:682`） | `already_completed` 短路（`:638`）；一条都没交成 → 算**未成交**（`:656`–`:671`，注释 bug 1） |
| 写入抛错 | `FAILED`（`:258`） | 记状态 + 记原因 | `这次进展我没记上：{reason}`（`failed`，`:120`） | `reply`（`:257`） | —— |

### 3.4 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `NOTICE` 被节流吃掉那次 | `salesThreadProgressService.js:306` | `replied:false`，**她那边什么都看不到**（有意：防语音重复刷屏） |
| `NOTICE` 被节流时**仍然写状态** | `:215`–`:220` | 状态写 `progress_notice` 且带 `notice_replied:false`，但**没有对用户可见的反馈** |
| `reply` 失败 | `:696`–`:705` | 只记 `sales.thread_progress.reply_failed` warn；**她一个字都收不到**（注释：不能因此判进展失败） |
| `mark` 失败 | `:707`–`:714` | 只记 warn；状态没落盘 |

### 3.5 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 回话 | `salesThreadProgressService.js:93`–`:94` | 缺省 `skipNoGroupContext('text', task)` → 非群任务**只记 skip、返 null，一个远端调用都不做** |
| 业务写入 | `salesThreadProgressService.js:361`、`:446`、`:633` | 全部走 `gateway` / `PaymentService` / `SalesDeliveryService`；本类**不直接发消息到别的群**，也不认 `chat_id` |

---

## 4. 售后（确认卡 / 结果卡 / 重试卡 / 取消）

### 4.1 入口

| 入口 | 认领处 |
|---|---|
| 话题 / 主群里说"退货 / 换货 / 赔货" | `larkMvpService.js:1630`–`:1634`（`isAfterSalesIntent`）→ `afterSalesFlow.handle(task, parsed)`（`afterSalesFlowService.js:146`） |
| 卡片 `confirm_after_sales` | `larkMvpService.js:2046`–`:2048`（先过 `isAfterSalesCardAction`）→ `afterSalesFlow.handleCardAction`（`afterSalesFlowService.js:511`） |
| 卡片 `cancel_after_sales` | 同上 → `cancelAfterSales`（`:539`） |
| 卡片 `choose_after_sales_restock` | 同上 → `chooseRestock`（`:524`） |
| ⚠️ 没有"选资金走向"的卡片按钮 | 注释明写"钱怎么走不用卡片按钮"（`config/afterSalesFlow.js:25`–`:26`、`afterSalesFlowService.js:508`–`:509`） |

动作名常量：`AFTER_SALES_CARD_ACTIONS`（`config/afterSalesFlow.js:19`–`:24`）。

### 4.2 状态 → 处理规则 → 提示 → 出口 → 幂等

| 入口 | 状态（枚举名 + 取值 + 定义处 `文件:行`） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（config 键 + 中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 群消息（售后） | `ASKING = 'after_sales_asking'`（`config/afterSalesFlow.js:38`） | **六处**都落它：① 动作分不清（`afterSalesFlowService.js:151`）② 序号用不了（`:243`）③ 没说退哪一双（`:257`）④ 候选 0 条（`:277`）⑤ 候选多条（`:290`）⑥ 换货缺信息（`:686`） | `我没分清是退货、换货还是赔货，再说一次好吗？`（`:152`）<br>`退哪一双？发我货号，比如"6035 黑"。`（`:258`）<br>`我这儿只有 N 笔，没有你说的第 N 笔。`（`:242`）<br>换货：`换成哪一双？发我货号，或者只说新尺码也行。`（`AFTER_SALES_ASK_TEXTS.needNewItem`，`config/afterSalesFlow.js:241`）<br>`换的那双 {itemNo}{color} 多大码？`（`needNewSize`，`:243`）<br>`货品表里找不到 {itemNo}{color}，核对一下货号。`（`newProductNotFound`，`:245`）<br>`换的那双 {itemNo}{color} 多少钱？`（`needNewAmount`，`:247`）<br>候选 0 条复用查询卡文案（见 4.6） | `sendTextToTask`（`:152`、`:244`、`:258`、`:687`）；候选卡走 `replyCardByTask`（`:276`、`:289`） | —— |
| 群消息（售后） | `CONFIRMING = 'after_sales_confirming'`（`config/afterSalesFlow.js:39`） | 方案齐 → 出确认卡等她点 | 卡面：标题 `请确认售后`（`utils/larkCards.js:1009`）；按钮 `确认`（`:1005`）/ `取消`（`:1006`）；多条匹配警告 `⚠️ 换的那双在货品表里匹配到多条，已取第一条，请核对`（`:1002`） | `replyCardByTask`（`afterSalesFlowService.js:189`） | —— |
| 卡片 `confirm` | `RUNNING = 'after_sales_running'`（`config/afterSalesFlow.js:40`） | 防连点占位 → 调执行器 `executor.execute` | 无（`RUNNING` 是内部占位） | —— | `RUNNING` 再点 → `正在写入，请稍候`（`:581`） |
| 卡片 `confirm` 成功 | `DONE = 'after_sales_done'`（`config/afterSalesFlow.js:41`） | 记结果 → 换结果卡 | 卡面：`{动作}已完成`（`utils/larkCards.js:1042`）+ `已写入` 清单（明细 / 收款明细 / 客户往来货款 / 库存，`:1026`–`:1037`）<br>toast：`${plan.action_label}已完成`（`:613`） | `publishCard`（`:603`） | 再点 → 直接回结果卡 + `这一笔售后已经做完了，不会重复写`（`:574`–`:578`）；执行器另有总闸门（注释 `:568`–`:571`） |
| 卡片 `confirm` 失败 | 退回 `CONFIRMING` + `after_sales_error`（`:617`–`:619`） | 发**重试卡**（= 确认卡 + 原因，按钮**保留**） | 卡面标题：`{动作}没做成`（`utils/larkCards.js:1063`）<br>`原因：{reason}`（`:1065`，空时 `未知错误`）<br>脚注：`核对后点「确认」重试；同一笔不会重复写。`（`:1067`）<br>toast：`${plan.action_label}没做成：${error.message}`（`:627`） | `publishCard`（`:622`） | 执行器自带断点续做 + 总闸门（注释 `:616`） |
| 卡片 `cancel` | `CANCELLED = 'after_sales_cancelled'`（`config/afterSalesFlow.js:42`） | 只改本地状态，**不调执行器、不写业务表**（注释 `:538`） | 卡面：`已取消售后` / `这一笔没有执行，也没有写任何记录。`（`:547`–`:548`）<br>toast：`已取消`（`:551`） | `publishCard`（`:546`） | 已 `DONE` 时不许取消：`这一笔已经做完了，不能取消；要退的话请重新说一次`（`:541`） |
| 卡片 `restock` | 状态**不变**（仍 `CONFIRMING`），只改 `after_sales_plan.restock_state`（`:530`–`:531`） | 重渲染确认卡 | toast：`退回的鞋将放到「${state}」`（`:535`） | `publishCard`（`:532`） | `task.status !== CONFIRMING` → `这张卡片已经处理过了`（`:525`–`:526`） |
| 卡片 confirm（钱没定） | 状态**不改**（直接抛） | **大声拦住**：不调执行器、不写业务表 | 抛错原文：`这一笔还没确定钱怎么走（… / …），不能执行；请把"钱怎么走"一起说一遍，重新说一次`（`:593`–`:594`） | —— | 业务表零写入（注释 `:557`–`:566`） |

### 4.3 售后执行器的动作枚举（另一层契约，别和任务状态混）

| 枚举名 | 取值 | 定义处 |
|---|---|---|
| `AFTER_SALES_ACTIONS.RETURN` | `'return'` | `config/afterSales.js:16` |
| `AFTER_SALES_ACTIONS.EXCHANGE` | `'exchange'` | `:17` |
| `AFTER_SALES_ACTIONS.COMPENSATION` | `'compensation'` | `:18` |

中文标签：`AFTER_SALES_ACTION_LABELS`（`config/afterSalesFlow.js:98`–`:102`）＝ `退货` / `换货` / `赔货`；认不出时 `actionLabelOf` 兜底 `'售后'`（`:104`）。

"钱怎么走"的收敛：`AFTER_SALES_SETTLEMENT_ALIASES`（`:116`–`:130`）→ `cash` / `prepaid`；
⚠️ **刻意没有默认值**（`:193`–`:211` 一整段注释解释为什么）。

### 4.4 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `RUNNING` | `afterSalesFlowService.js:597` | 状态落了，**没有任何回话**；只有她**再点一次**才会收到 `正在写入，请稍候`（`:581`） |
| `chooseRestock` 的失败路径 | `afterSalesFlowService.js:529` | `throw new Error('退回的鞋只能选「门盒」或「样品」')` —— 抛错只进日志（`routes/larkEvents.js:83`），**toast 是路由固定那句 `已收到，正在处理`** |
| `handleCardAction` 里的四种抛错 | `afterSalesFlowService.js:515`、`:517`、`:518` | `售后卡片缺少任务 ID` / `这次售后已经过期，请重新描述一次` / `只能由原始发送人确认该售后` —— **同样只进日志，用户看不到** |
| 计划里没有方案 | `afterSalesFlowService.js:587` | `throw new Error('这次售后没有可执行的方案，请重新描述一次')` —— 同上 |
| `handle` 里的结算抛错 | `afterSalesFlowService.js:179`–`:180` | 抛给上游 → `handleTaskFailure` 才会回一句 `处理失败：${error.message}`（`larkMvpService.js:2686`） |

### 4.5 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 回卡 | `afterSalesFlowService.js:701`–`:709` | 先 `replyCardToTask`（缺省只在 `chat_type === 'group'` 时回她那条消息，`:127`–`:131`），失败再 `sendCardToTask`（缺省 `skipNoGroupContext`，`:132`–`:133`） |
| 回文字 | `afterSalesFlowService.js:134`–`:135` | 缺省 `skipNoGroupContext('text', task)` → **没有群上下文 = 没有去处** |
| 换问话术 | `config/afterSalesFlow.js:238`–`:248` | 全部硬编码在配置里（**好**）；但 `afterSalesFlowService.js:152`/`:258` 那两句**反过来写死在 service 里**（没进配置） |
| 收款方式词表 | `config/afterSalesFlow.js:171`–`:178` | 与 `config/salesProgressIntake.js:94`–`:101` **两处各持一份**（注释 `:165`–`:167` 明说这是刻意的，改要改两处） |

### 4.6 售后复用「销售查询」的卡片文案

候选卡片 `saleLookupCard` 由 `utils/larkCards.js` 渲染，文案在 `config/saleLookup.js`（天数默认 5 天、候选 TTL 10 分钟，见该文件头 `:4`）。
**未找到**该卡片中文文案的 config 键清单（它在 `utils/larkCards.js` 的 `saleLookupCard` 里直接拼）。

---

## 5. 采购报货（供应商报单 → 免确认生成采购申请）

### 5.1 入口

| 入口 | 认领判据 | 处 |
|---|---|---|
| 多维表格「报货信息」表新增记录 | `tableId === V1_BITABLE_SCHEMA.tables.purchaseReport.tableId` ＋ `action === 'record_added'` | `routes/larkEvents.js:137`–`:139`、`:154`、`:164` |
| 同一包多条 → 一起处理 | 同一 `action_list` 收成一包 | `routes/larkEvents.js:148`–`:171`（`recordsByIntake`）、`:183`（`acceptMany`） |
| 群话题里说批次号 / 引用采购单 | 定位器四条**按顺序** | `services/purchaseBatchLocator.js:98`（thread）/`:88`（parent）/`:134`（batch_no）/`:209`（认不出） |

### 5.2 状态 → 处理规则 → 提示 → 出口 → 幂等

| 入口 | 状态（取值 + 定义处 `文件:行`） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 表事件 | `'queued'`（`purchaseWebhookService.js:510`） | `accept` 建任务 → `setImmediate` 入队 `process`（`:511`） | 无 | —— | `'completed'` / `['queued','processing','awaiting_confirmation','posting','posted','cancelled']` 全部**当重复忽略**（`:497`、`:505`） |
| 表事件 | `'processing'`（`:682`） | `process`：先按「采购行为」分流（退货 / 采购申请）→ 读报货批次号 → 归批 | 无 | —— | —— |
| 表事件 | `'batch_waiting'`（`:735`） | 已登记进批次 → 等这一包**到齐** | 无 | —— | 归批键 = 「报货批次号」；到齐由 `recordPackageDone` 记账（`:500`、`:507`） |
| 表事件 | `'posted'`（`:756`、`:1327`） | 采购申请写成（**免确认**）→ 出 PNG → 发采购群 @经办人 | 群消息：`{supplier} 这批 {pairs} 双，图可以直接转给供应商。`（`config/purchaseGroupNoticeText.js:54`）+ `@经办人`（`mention`，`:59`；拿不到 open_id 就**不加 @**，`:116`–`:120`）<br>供应商空时：`未标注供应商`（`unknownSupplier`，`:61`） | `sendText` 到 `PURCHASE_CHAT_ID`（`purchaseWebhookService.js:1344`–`:1346`、`:1428`）；图 + 附件写回见 `:1512`–`:1595` | `accept` 与 `process` **两道** `posted` 早退（`:497`、`:677`）；`'已生成申请'` 写回报货行（`:1221`、`:2685`、`:3446`） |
| 表事件 | `'completed'`（`:1000`、`:2317`） | 这一条"处理完了"但不进图（读不到 / 早生成过 / 对不上） | 对不上时群里提示（见 `:1989` 的 `notice`） | —— | `'completed'` 早退（`:497`、`:669`） |
| 表事件 | `'cancelled'`（`:756`） | 报货行被标 `已取消` | 无 | —— | —— |
| 表事件 | `'failed'`（`:761`、`:2446`） | 可重试失败：**刻意不改报货记录状态**（注释 `:764`–`:768`） | 无 | —— | 重收 webhook 会重跑（`:767`） |
| 群消息（认不出） | 不落状态 | `GroupPurchaseFlowService.handleGroupPurchaseMessage` 返 `resolved:false` | `这条消息我没认出来是哪一批采购单～你引用一下我发的采购单，或者把批次号（{prefixes} 开头的那个）说给我。`（`DEFAULT_NO_BATCH_REPLY`，`config/groupPurchase.js:54`）<br>`我分不清你说的是哪一批～引用一下我发的采购单，或者把批次号（{prefixes} 开头的那个）说给我。`（`DEFAULT_AMBIGUOUS_BATCH_REPLY`，`:55`） | `replyText`（`groupPurchaseFlowService.js:69`）——在**原消息下引用回复**，话题里则回那条话题 | 定位器**绝不猜"最近一笔"**（`purchaseBatchLocator.js:226`–`:231` 注释） |
| 群消息（认得出） | 不落状态 | 转交到货核对（**只在群里回结果，不先垫一句"我找到了"**） | 无（注释 `groupPurchaseFlowService.js:54`–`:56`） | `dispatchToArrival`（`:89`） | —— |

### 5.3 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `accept` 判成重复 | `purchaseWebhookService.js:498`、`:506` | 只记日志，**群里/她那边零反馈** |
| `processing` / `batch_waiting` | `:682`、`:735` | 状态在推进，但**没有任何用户可见反馈**（她只能等图） |
| `record_unreadable` | `:696`–`:699` | 只记 warn；这一条**不进图、不通知任何人** |
| `mismatch` | `:1163`、`:1989` | ⚠️ **2026-10-08 Lead 抽查纠正**：`:1989` 那条**不是静默** —— 它上一行（`:1988`）就是 `await this.sendPurchaseGroupNotice(notice)`，**会发到采购群**；`:1163` 是批量那条（另有 `notifyQuantityMismatches` 发群）。⇒ 本行原来写「未找到发送点」，**是错的**，已纠正。 |
| `PURCHASE_CHAT_ID` 没配 | `:1420`–`:1424`、`:1663`–`:1669` | 她那边**什么都收不到**（只在日志里大声警告） |

### 5.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 发到哪个群 | `purchaseWebhookService.js:1334`–`:1346` | **只认 `PURCHASE_CHAT_ID` 这一个群**（+ 测试用沙箱 chatId）。**没有"按来源选出口"**：采购单固定发那个群 |
| 群内回复 | `purchaseWebhookService.js:135` | `options.inThread === true` → `reply_in_thread: true`；**由调用方给 `inThread`** |
| 图 | `purchaseWebhookService.js:1512`–`:1595` | `receive_id_type` 由调用方传（注释 `:1512` 明写"参数名必须跟着 receive_id 的实际类型走"） |
| 免确认 | `purchaseWebhookService.js`（`publishPurchaseRequest` 注释） | **报单是唯一免确认的链路**（AGENTS.md 记录的产品负责人要求） |

---

## 6. 采购到货核对（群话题 + 卡片表单）

### 6.1 入口

| 入口 | 动作/判据 | 处 |
|---|---|---|
| 群话题里说实际到货 | 定位器命中批次 → `handleTopicMessage` | `groupPurchaseFlowService.js:89`；`purchaseArrivalConversationService.js:228` |
| 卡片「是」 | `confirm_arrival_reconcile`（`ARRIVAL_CONVERSATION_ACTIONS.CONFIRM`，`config/arrivalConversation.js:23`） | `larkMvpService.js:2018`–`:2019`；`purchaseArrivalConversationService.js:529` |
| 卡片「否」 | `reject_arrival_reconcile`（`:24`） | 同上；`purchaseArrivalConversationService.js:823` |
| 卡片表单「提交」 | `submit_arrival_reconcile`（`:29`） | `larkMvpService.js:2010`–`:2011`（`form_value` 在 `event.action.form_value`，`:1997`）；`purchaseArrivalConversationService.js:572` |

### 6.2 状态 → 处理规则 → 提示 → 出口 → 幂等

> ⚠️ **本模块的状态也是字符串字面量**，在 `purchaseArrivalConversationService.js` 里直接写（**没有枚举常量**）。

| 入口 | 状态（取值 + 定义处） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（config 键 + 中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 话题消息 | `'collecting'`（`purchaseArrivalConversationService.js:287`） | 建会话任务，追加 `transcript`，调模型算计划 | 解析不出内容时：`这句里我没听出到货的变化。跟单子一样就说一句「都到了」；有多的少的，说一下货号、尺码和双数。`（`replies.noArrivalContent`，`config/arrivalConversation.js:241`）<br>`这批单子我没找到可以核对的采购申请明细，先不动。`（`noRows`，`:255`）<br>`我没把你说的话对上这批采购申请的明细，先不入库。…`（`unmatched`，`:249`）<br>`这个尺码你说少的双数比申请数还多，我算出来是负数，先不入库。…`（`negative`，`:253`）<br>已入库后再说：`这一批已经入过库了，我没有再动任何表。要改请告诉我该改哪一条。`（`afterPosted`，`:262`） | `safeReplyText`（`:280`）→ `replyText` 到那条话题 | 任务 id **只跟批次有关**（`taskIdForBatch`，`:18`–`:19`），重复投递不新起任务 |
| 话题消息 / 表单提交 | `'awaiting_confirmation'`（`:470`） | 算好计划 → 发「是/否」卡片（**回到她说话的那个话题**）；旧卡**尽力作废** | 卡面（`config/arrivalConversation.js`）：<br>标题 `本次到货核对完毕，确认入库吗？`（`:173`）<br>按钮 `是`（`:174`）/ `否`（`:175`）<br>`按你说的实际到货`（`:176`）<br>`点「是」我就按实际数量入库；点「否」我这次什么都不写。`（`:177`）<br>`这双没到，不入库`（`zeroActualNote`，`:180`）<br>`标「这双没到」的行我不会入库，也不会写库存流水。`（`zeroRowsNote`，`:181`）<br>表单（`ARRIVAL_FORM_DEFAULTS`，`:43`–`:93`）：label `实际到货情况`（`:54`）、placeholder `例：都到了 / XHB8095 黑 38 码少 2 双 / XHB8096 棕 39 码多 1 双`（`:56`）、label `实际金额`（`:86`）、placeholder `例：12800 或 12800.50（这一次供应商的金额）`（`:88`）、提交按钮 `提交`（`:64`）<br>旧版本降级：`你的飞书版本太低（输入框需 V6.8 以上），直接在话题里回一句实际到货情况就行。`（`:62`）<br>作废旧卡：`这张核对卡片已经作废` / `这张上的数量不要用了：我已经按你最新那句话重出一张新卡，**请用最新那张**（它就发在你刚说话的消息下面）。`（`:197`–`:198`） | `replyCard(messageId, card, { threadId })`（`:439`）；`retirePreviousCard`（`:465`） | 每次都在**她说那句话的话题里重发一张新卡** + 尽力作废旧卡（注释 `:193`–`:195`） |
| 表单提交 | 写 `actual_amount`（`handleFormSubmitLocked`，`:663`） | 服务端解析金额（必填、非负、纯数字）→ 当作"她在话题里说的那句话"喂给**同一条** `handleTopicMessageLocked`（`:688`） | 空提交：卡面 `没收到内容：请在上面的输入框里写一句实际到货情况，再点「提交」。`（`card.submitMissingNote`，`:204`）+ 回执 `没看到「实际到货情况」的内容 —— 请在上面的输入框里写一句，再点「提交」。`（`replies.submitMissing`，`:292`）<br>没填金额：卡面 `没收到「实际金额」：请在上面的金额输入框里填一个数字（必填），再点「提交」。`（`:209`）+ 回执 `没收到「实际金额」—— 这一次供应商的金额是必填的，请在上面的金额输入框里填一个数字，再点「提交」。`（`amountMissing`，`:296`）<br>金额非法：卡面 `「实际金额」只能填**不小于 0 的数字**（例：12800 / 12800.50）：请改一下再点「提交」。`（`:210`）+ 回执 `「实际金额」只能填**不小于 0 的数字**（例：12800 或 12800.50）—— 这次提交我没有处理，你改一下再点「提交」。`（`amountInvalid`，`:300`）<br>成功出卡：`已收到你填的实际到货情况，我按它核对了一遍 —— 最新那张核对卡片就发在你的消息下面。`（`submitReceived`，`:305`）+ 卡面 `已提交` / `你填的实际到货情况我已经收到，并按它重算了一遍 —— 最新那张核对卡片就发在你这条消息下面，**请用最新那张**（点它上面的「是」才会入库）。`（`:215`–`:216`）<br>没算出结果：`已收到你填的实际到货情况。这次我没能按它算出核对结果（没有入库、也没有写数据）—— 你改一句再点「提交」，或者直接在话题里说一句，我重算一遍。`（`submitReceivedNoCard`，`:309`）<br>重投：`这次提交我已经处理过了，没有重复核对、也没有重复写。`（`submitDuplicate`，`:311`）<br>链路关着：`到货核对现在没有开着，这次提交我没有处理。`（`disabled`，`:314`） | 卡面 patch + `safeReplyText`；卡面刷新失败时兜底：`这条核对卡片我没能刷新成功，请以我这条话为准；要是看不到按钮，就在这个话题里再说一句实际到货，我重出一张。`（`cardUpdateFailed`，`:282`） | 同一张卡片消息 id 的重投按 `submitDuplicate` 幂等（`:311`）；`parseActualAmount` 服务端闸门（`:46`–`:56`） |
| 卡片「否」 | `'rejected'`（`:832`） | **零业务表写入**，只回一句 + patch 卡面 | 回话：`好，那先不入库`（`replies.rejected`，`:229`）<br>卡面标题：`这次没有入库`（`card.rejectedTitle`，`:192`） | `safeReplyText` + patch 卡（`:823`–`:832`） | 终态卡收掉「是 / 否」（注释 `:191`） |
| 卡片「是」 | `'posting'`（`:984`） | 建草稿 → `confirmArrival`（写「报货批次」验收原话 / 确认状态 + 逐条加库存） | —— | —— | `posted` 早退（`:888`）；金额闸门在**任何写入之前**（`:913`，注释 `:910`） |
| 卡片「是」成功 | `'posted'`（`:1001`） | 置终态 → 把批次行改成「已到货」（`notifyBatchArrived`，`:198`）→ 回结果 | 回话（`config/arrivalConversation.js`）：<br>`已按实际到货入库：{rowCount} 条明细 / 共 {total} 双（报货批次号 {batchNo}）。`（`summary.posted`，`:221`）<br>`已按实际到货入库：…；另有 {zeroCount} 条实际 0 双（没到），这 {zeroCount} 条我没有入库（报货批次号 {batchNo}）。`（`postedWithZero`，`:223`）<br>`这批单子你说下来一件都没到（{zeroCount} 条明细全是 0 双），我没有入库、也没有写库存流水（报货批次号 {batchNo}）。`（`postedNothingArrived`，`:225`）<br>重复点：`这一批已经入库了，我没有重复写。`（`alreadyPosted`，`:231`） | `safeReplyText`（`:1010` 附近） | **三层**：`posted` 早退（`:888`）+ `visibleAlreadyPosted`（`:893`）+ `confirmArrival` 自己的幂等（`draft.inventory_applied` 落盘 + `inventoryService.purchaseIncreaseSourceId` 三元组，`:352`–`:361`） |
| 卡片「是」缺金额 | 状态**不改**（before `:984`） | 可见失败：patch 卡 + 回文字 | `这批还没收到这一次的供应商金额 —— 请先在卡片表单里填上「实际金额」再点「提交」，我才会按实际到货入库（我不会写一个空的「实际金额」）。`（`amountMissingOnConfirm`，`:303`）；橙色（不是红色，注释 `:922`–`:924`） | `visibleFailure`（`:918`） | 位置在任何写入之前 ⇒ **一个字都没动**（`:910`） |
| 卡片「是」任务丢了 | 状态**不改** | 可见失败 | `这条到货核对记录我已经找不到了，没法入库。你把「都到了」或差异再说一句，我重新核一遍。`（`taskMissing`，`:274`） | `visibleFailure`（`:883`） | —— |
| 卡片「是」还没算出来 | 状态**不改** | 可见失败 | `我这边还没算出这一批的核对结果，你再说一句实际到货，我重算一遍。`（`notConfirmedYet`，`:235`） | `visibleFailure`（`:900`） | —— |
| 卡片「是」入库抛错 | **停在 `posting`**（注释 `:989`，"再点一次从断点继续"） | 卡面 patch 成红色终态（`card.failedTitle`）+ 话题回文字 | 卡面标题：`到货验收核对没成功`（`card.failedTitle`，`:187`）<br>回话：`入库没成功：{error}。请再点一次「是」，我会从断点接着写，不会重复入库。`（`inboundFailed`，`:272`） | `visibleFailure`（`:995`） | 断点重试；入库幂等由 `confirmArrival` 保证（注释 `:873`–`:876`） |

### 6.3 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `'posting'` 期间 | `purchaseArrivalConversationService.js:984` | 状态落了，**她那边没有"正在入库"的反馈**（对比销售那条有 `config/salesProcessingCard.js`） |
| 卡片动作的**所有 toast** | `config/arrivalConversation.js:285`–`:288`（注释） | ⚠️ **配置里明写**：卡片动作路由的同步响应**固定**是 `已收到，正在处理`（`routes/larkEvents.js:87`），所以下面那些 toast **她那边看不见**，只进 `lark.card.handled` 日志。**可见反馈一律做在卡片上 / 话题回话上** |
| `hasActualAmount` 与 `parseActualAmount` 的 0 | `purchaseArrivalConversationService.js:59`–`:63` vs `:52`–`:54` | 两处口径一致（`> 0`，0 也当"没填"），但 `config/arrivalConversation.js:298`–`:299` 的注释还写着"0 是允许的"——**注释与代码不同步**（代码是对的，注释是旧的） |

### 6.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 回卡 / 回话 | `purchaseArrivalConversationService.js` 构造参数 | `replyText` / `replyCard` / `updateCard` **由 `larkMvpService` 注入**（`larkMvpService.js:324`–`:340`）；本类**不认识 `chat_id`**，只传 `{ threadId }` |
| 卡片一律回到"她说那句话的话题" | `purchaseArrivalConversationService.js:437`–`:439` | 每次都在**她这条消息下**发新卡（不是 update 旧卡）——注释 `:193`–`:195` 说明了为什么改成这样 |
| 发到货图/单 | `purchaseWebhookService.js:1344` | 与采购单**同一个群**（`PURCHASE_CHAT_ID`） |

---

## 7. 库存操作（`data/inventory_operations` 的状态机与幂等）

### 7.1 入口

| 入口 | 谁调 | 处 |
|---|---|---|
| 销售交付扣库存 | `SalesDeliveryService.deliver` → `inventory.change` | `services/salesDeliveryService.js` |
| 销售下单（现货行） | 同上 | —— |
| 采购到货加库存 | `PurchaseWebhookService.confirmArrival` → `inventory.applyPurchase` | `purchaseWebhookService.js`；`larkMvpService.js:309`–`:310` |
| 采购退货扣库存 | 报货链路的退货分支 | `purchaseWebhookService.js:700`–`:711` |
| 售后（退货回库 / 换货出库 / 赔货出库） | `AfterSalesService` → `InventoryService` | `services/afterSalesService.js` |
| 补样品（门盒 → 样品） | `SampleReplacementService` → `inventory.promoteToSample` | `sampleReplacementService.js:161`、`:226` |
| 工作台盘点 / 换季调整 | `workbenchInventoryAdjustment.js` → `inventoryAdjustmentService` | `routes/workbenchInventoryAdjustment.js:42`、`:56` |

### 7.2 状态 → 处理规则 → 提示 → 出口 → 幂等

> ⚠️ **本状态机也没有枚举常量**；取值是字面量，落在 `server/data/inventory_operations/`（`JsonTaskStore`，`inventoryService.js:387`–`:392`）。

| 入口 | 状态（取值 + 定义处） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示 | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 各类业务写入 | `'prepared'`（`inventoryService.js:585`、`:696`、`:857`） | `applyChange` / `promoteToSample`：解析行为、算目标状态、**先落本地任务** | **无**（库存操作**没有**面向她的提示；结果由上游那条链路自己回话） | —— | 本地任务落盘是**第一层**幂等（`operation_id`） |
| 各类业务写入 | `'ledger_created'`（`:765`、`:917`、`:978`） | 写「库存流水」→ 记 `ledger_record_id` | **无** | `gateway.create('inventoryLedger', ...)` | **第二层**：落盘 + 按来源回查流水（`:741` 注释"数量类动作的第三层幂等靠「按来源回查流水」"） |
| 各类业务写入 | `'completed'`（`:803`、`:924`、`:1062`） | 写「实时库存」→ 置终态 | **无** | `gateway.create/update('liveInventory', ...)`；`createOnceByKey` + `OPERATION_ITEM_KEY_FIELD`（`:7`） | **第三层**：`operation.status === 'completed'` 早退（`:488`、`:730`、`:876`、`:935`）；实时库存每条一个「库存操作键」（`operationItemKey`，`:380`） |
| 崩溃恢复 | `resumePending`（`:821`–`:825`） | 找出同一 `stock_key` 下**未完成**的操作，倒序重放 | **无** | 同上 | `runForStock` 按 `stock_key` 串行（`:460`–`:469`） |
| —— | 幂等来源键 | `purchaseIncreaseSourceId` = `purchase_increase:${批次记录id｜批次号｜到货任务id}|${货品 record_id}|${尺码}` | —— | —— | `:352`–`:361`；**一个都拿不到时当场抛错**（`:357`），绝不编一个 id |

### 7.3 这个模块里"没有对应提示"

**全部状态都没有面向用户的提示** —— 这是**设计如此**：`InventoryService` 是纯能力层，
回话由上游（销售 / 采购 / 售后 / 补样品 / 工作台）负责。
但它带来一个真实后果：**库存写失败了，是上游那句话在替它说话**；上游没说就等于静默。

### 7.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 本地任务目录 | `inventoryService.js:390` | `data/inventory_operations`（**硬编码相对 `__dirname`**，不可配） |
| 远端表 | `inventoryService.js:401` | 白名单 `['behavior','sizeManagement','inventoryLedger','liveInventory']` |
| 行为编码 | `config/salesMovements.js` / `STOCK_MOVEMENTS` | 行为编码是契约；**注释要求"库存写入只经 InventoryService"** |

---

## 8. 9 点待处理单推送（按天任务状态）

### 8.1 入口

| 入口 | 判据 | 处 |
|---|---|---|
| 定时器（服务内，非 cron） | 每 `PENDING_DEAL_PUSH_INTERVAL_MS`（默认 600000 = 10 分钟）tick 一次 | `config/pendingDealPush.js:100` |
| 真正的发送时刻 | 上海时间到达 `PENDING_DEAL_PUSH_HOUR`（默认 9 点） | `config/pendingDealPush.js:96`；`services/pendingDealPushService.js:176`（每次 tick 才解析配置） |
| 开关 | `PENDING_DEAL_PUSH_ENABLED` | `config/pendingDealPush.js:41` |

### 8.2 状态 → 处理规则 → 提示 → 出口 → 幂等

> ⚠️ **状态也是字面量**，落在按天任务（`dayTaskId`）上。

| 入口 | 状态（取值 + 定义处） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（config 键 + 中文原文） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| tick | `'running'`（`pendingDealPushService.js:811`、`:814`） | 认领这一天 → 采候选 → 发 | —— | —— | 再 tick 时 `in_progress` 早退（`:759`） |
| tick | `'completed'`（`:826`、`:857`、`:880`、`:889`） | 四种收尾：无候选 / 深链不可用 / 没配群 / **发送成功** | 发送成功后群里的卡片/文本由 `config/pendingDealPush.js` 的模板渲染（标题：`PENDING_DEAL_PUSH_SALES_TITLE` / `PURCHASE_TITLE` 等，`:83`–`:84`） | `sendCardToChat` / `sendTextToChat`（`:663`、`:681`）→ `deliver`（`:708`）→ **发到 `PENDING_DEAL_PUSH_CHAT_ID`**；可选置顶 `pinMessage`（`:733`） | `record.sent` 或 `status === 'completed'` → `already_ran_today`（`:758`）——**"失败不算跑过"**（注释 `:810`） |
| tick | `'failed'`（`:937`） | 发失败 → 记 `attempts` + `next_retry_at` | —— | —— | 重试时刻 = 首次失败后 **5 分钟 / 15 分钟**各一次（`DEFAULT_RETRY_DELAYS_MS`，`config/pendingDealPush.js:111`） |
| 重试判定 | 四个"不重试"原因 | `resolveAttempt`（`:756`） | —— | —— | `already_ran_today`（`:758`）/ `in_progress`（`:759`）/ `retry_disabled`（`:760`）/ `retries_exhausted`（`:762`）；未到点 → `retry_waiting` + `next_retry_at`（`:768`） |
| 进程重启 | 不丢 | `resolveAttempt` 按 `next_retry_at` 补（注释 `:162`） | —— | —— | 定时器丢失不影响（`:162`） |

### 8.3 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| `no_pending_order` | `:826` | 今天没有候选（`reason: 'no_pending_order'`）→ **群里什么都不发**（有意：不发空卡） |
| `link_unavailable` | `:857` | 深链缺失 → 整批**不发**（`reason: 'link_unavailable'`），她在群里**看不到任何东西** |
| `no_chat` | `:880` | 没配群 → 不发（同 `PURCHASE_CHAT_ID` 那个坑的形状） |
| 两次重试都失败 | `:929`–`:944` | `will_retry:false` → **当天彻底静默**，第二天照常进候选 |

### 8.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 发到哪个群 | `pendingDealPushService.js:149`（`this.chatId`） | **只认 `PENDING_DEAL_PUSH_CHAT_ID` 一个群**（销售待处理 + 采购未到货**共用同一个群**） |
| 消息格式 | `config/pendingDealPush.js:103`–`:105` | `card` / `text`；卡片不可用时**降级成文本**（`degraded: true`，`:719`） |

---

## 9. 补样品 / 换码（卡片）

⚠️ **换码本身没有独立模块**——"换尺码"走的是**售后（换货）**那条链路（`config/afterSalesFlow.js:226`–`:228` 记录了业务口径：「1. 换尺码 2. 换另一双鞋」），没有自己的卡片或状态。
下面是**补样品**（她点"样品已售出 → 请补选"）那一条。

### 9.1 入口

| 入口 | 动作名 | 处 |
|---|---|---|
| 补样品卡「选尺码」 | `choose_sample_replacement` | `larkMvpService.js:2002`–`:2003` → `sampleReplacementService.js:171` |
| 补样品卡「刷新尺码」 | `refresh_sample_replacement` | 同上 |
| **销售确认卡**上先选好门盒 | `choose_sale_sample_replacement` | `larkMvpService.js:2351`–`:2369`（走**销售草稿**状态机，不是本模块） |
| 工作台触发（**没有群上下文**） | —— | `routes/workbench.js`（注释 `sampleReplacementService.js:56`–`:58`） |

### 9.2 状态 → 处理规则 → 提示 → 出口 → 幂等

| 入口 | 状态（取值 + 定义处） | 状态 → 处理规则（函数名 + 做什么 + `文件:行`） | 状态 → 提示（中文原文 + `文件:行`） | 出口（`文件:行`） | 幂等点 |
|---|---|---|---|---|---|
| 交付发现样品售出 | `'pending'`（`sampleReplacementService.js:114`） | `notifySampleReplacements` 建任务 → 查候选 → 发补选卡 | 发卡失败时补一句：`${productNumber} 的样品已售出，但补选卡片发送失败；销售库存已扣减，请联系管理员核对补选任务。`（`:145`） | `sendCardToTask`（`:136`）→ 群销售回**那条销售话题**；工作台触发 → `skipNoGroupContext` 返 `null`（`:59`–`:60`、`:140`） | `task?.status === 'completed'` 跳过（`:108`）；`card_message_id` / `notice_sent` 已存在则跳过（`:109`） |
| 卡片 choose/refresh | 状态**不变**（只有卡片 patch） | `handleCardActionUnlocked`：先 patch 成"处理中"卡 | 处理中卡文案：`正在刷新可选尺码，请稍候。` / `已收到选择，正在调整库存状态，请勿重复点击。`（`:196`）<br>卡片改不动时：`已收到补样品操作，正在处理，请稍候。`（`:202`） | `updateCard`（`:195`）；补发走 `publishCard`（`:63`） | `cardActionQueue.run(draftId, ...)`（`:176`） |
| 卡片 refresh | 状态**不变** | 重查候选 → 重发卡 | 成功：`可选尺码已刷新`（`:213`）<br>卡片改不动：`尺码已查询，但卡片更新失败，请稍后重试`（`:213`）<br>查询失败：卡面 `刷新尺码失败：${error.message}。请点击刷新重试。`（`:219`）+ toast `刷新尺码失败：${error.message}`（`:222`） | `publishCard`（`:209`、`:220`） | —— |
| 卡片 choose | `'completed'`（`:230`） | `inventory.promoteToSample` → 置终态 | 成功：`${size}码已从门盒转为样品，库存总数不变。`（`:232`）+ toast `${product_number} ${size}码已补作样品`（`:234`）<br>重复点：`${task.result?.size}已补作样品，库存总数不变。`（`:187`）+ toast `该样品已补选`（`:189`）<br>失败：卡面 `补选未完成：${error.message}。请核对后重试。`（`:246`）+ toast `补选未完成：${error.message}`（`:249`） | `publishCard`（`:231`、`:247`） | `status === 'completed'` 早退（`:185`）；`promoteToSample` 自己的库存幂等（见第 7 节） |

### 9.3 这个模块里"没有对应提示"

| 情形 | `文件:行` | 说明 |
|---|---|---|
| 工作台触发（没有群上下文） | `sampleReplacementService.js:136`–`:141` | `sendCardToTask` 返 `null` → **卡片根本没发出去**，只记 `lark.private_chat.send_skipped`；`notice_sent` **不写**（`:140`），所以将来有群上下文还能再发 |
| 群销售那条链路里补样品卡发失败 | `:142`–`:146` | 会补一句文字；但**如果这句也发不出去**（`.catch(() => undefined)`，`:145`）→ 完全静默 |

### 9.4 这个模块里"写死的出口"

| 出口 | `文件:行` | 写死成什么 |
|---|---|---|
| 卡片去哪 | `sampleReplacementService.js:134` | `sendTarget = channelTask || task` —— **"按来源选出口"在这里做了一半**：有 `channelTask`（群销售任务）就回那条话题；否则用本任务，而本任务没群字段 → 只记 skip |
| 本地任务目录 | `sampleReplacementService.js:27`–`:29` | `data/lark_mvp_tasks`（**和销售草稿共用一个目录**，用 `type: 'sample_replacement'` 区分） |

---

## 10. 全部状态枚举一览（这就是"有没有一张总表"的答案）

**答案：没有总表。** 全仓只有 **3 个** 状态枚举是集中定义的（都在 `config/`），其余全是散落的字符串字面量。

### 10.1 有集中定义的（3 个 + 2 个值域表）

| 枚举 / 值域表 | 取值 | 定义处 | 消费者 |
|---|---|---|---|
| `PROGRESS_TASK_STATUS` | `progress_applied` / `progress_asking` / `ignored` / `progress_failed` / `progress_notice` | `server/src/config/salesProgressIntake.js:138`–`:151` | `salesThreadProgressService.js` |
| `CONFIRM_DEAL_TASK_STATUS` | `confirm_deal_settled` / `confirm_deal_short_stock` / `confirm_deal_asking` / `confirm_deal_failed` | `server/src/config/salesConfirmDeal.js:35`–`:44` | `larkMvpService.js:2130`–`:2209` |
| `AFTER_SALES_TASK_STATUS` | `after_sales_asking` / `after_sales_confirming` / `after_sales_running` / `after_sales_done` / `after_sales_cancelled` | `server/src/config/afterSalesFlow.js:37`–`:43` | `afterSalesFlowService.js` |
| `SALES_STATUS_VALUE_DOMAINS` + `SALES_STATUS_WRITE_VALUES` | 四列十一个值（见 1.5） | `server/src/config/salesStatusDimensions.js:50`–`:84` | `SalesStatusWriter`、6 处 `isPosted` 闸门 |
| `AFTER_SALES_ACTIONS`（动作，不是任务状态） | `return` / `exchange` / `compensation` | `server/src/config/afterSales.js:15`–`:19` | `afterSalesService` |
| `PROGRESS_KINDS` | `payment` / `delivery` / `complete` / `ambiguous` / `none` | `server/src/config/salesProgressIntake.js:215`–`:221` | `salesThreadProgressService.classify` |

### 10.2 散落成字符串字面量的（**没有枚举、没有总表**）

| 状态机 | 取值（全部是字面量） | 主要出现处 |
|---|---|---|
| **销售草稿任务**（`type: 'sale'`） | `received` / `parsing` / `needs_info` / `ready_to_confirm` / `ignored` / `awaiting_correction` / `posting` / `posted_delivery_pending` / `posted` / `cancelled` / `failed` | `server/src/services/larkMvpService.js:1022,1640,1664,1942,2316,2330,2340,2362,2449,2469,2552,2613,2646,2685` |
| **销售进展任务**（同一目录，`status` 字段） | 见 10.1 的 `PROGRESS_TASK_STATUS`（**有枚举**） | `salesThreadProgressService.js` |
| **采购报单任务**（`purchase_supplier-report_…`） | `queued` / `processing` / `batch_waiting` / `awaiting_confirmation`（**留存的历史值**）/ `posting`（**留存的历史值**）/ `posted` / `completed` / `cancelled` / `failed` | `server/src/services/purchaseWebhookService.js:497,505,510,669,677,682,732–738,744–759,761,1000,1327,2317,2446,2496,2694,3454,3683` |
| **采购到货核对任务**（`arrival_reconcile_…`） | `collecting` / `awaiting_confirmation` / `rejected` / `posting` / `posted` | `server/src/services/purchaseArrivalConversationService.js:277,287,470,673,823,832,888,984,1001` |
| **库存操作**（`inventory_operations`） | `prepared` / `ledger_created` / `completed` | `server/src/services/inventoryService.js:585,696,765,857,917,978,803,924,1062` |
| **9 点推送按天任务** | `running` / `completed` / `failed` | `server/src/services/pendingDealPushService.js:811,814,826,857,880,889,937` |
| **补样品任务** | `pending` / `completed` | `server/src/services/sampleReplacementService.js:114,230` |
| **售后跨消息上下文**（按人记） | `after_sales_context` | `server/src/services/afterSalesFlowService.js:668` |

> ⚠️ 值得单独指出：`'ignored'` 这个**字面量被两个完全不同的状态机共用**
> （销售草稿 `larkMvpService.js:1640` 与销售进展 `salesProgressIntake.js:144`），
> 排查时按值 grep 会串台。

---

## 11. 真相：三处分散

### 11.1 状态枚举**分散**在哪些文件（有没有一张总表？）

**没有总表。** 现状是"三有、七无"：

**三个状态机有集中的枚举定义**（都在 `server/src/config/`，都是 `Object.freeze`）：
1. `salesProgressIntake.js:138` `PROGRESS_TASK_STATUS`
2. `salesConfirmDeal.js:35` `CONFIRM_DEAL_TASK_STATUS`
3. `afterSalesFlow.js:37` `AFTER_SALES_TASK_STATUS`

**另外有一张"业务表值域总表"**（这是唯一一张真正的总表，但它只管**销售主表那四列**）：
4. `salesStatusDimensions.js:50`–`:84` `SALES_STATUS_VALUE_DOMAINS` + `SALES_STATUS_WRITE_VALUES`

**七个状态机完全没有枚举**，取值以**字符串字面量**散在 service 里（详见 10.2）：

| # | 状态机 | 定义在哪个文件（就是那个 service 自己） | 字面量个数 |
|---|---|---|---|
| 1 | 销售草稿任务 | `services/larkMvpService.js` | 11 |
| 2 | 采购报单任务 | `services/purchaseWebhookService.js` | 9 |
| 3 | 采购到货核对 | `services/purchaseArrivalConversationService.js` | 5 |
| 4 | 库存操作 | `services/inventoryService.js` | 3 |
| 5 | 9 点推送按天任务 | `services/pendingDealPushService.js` | 3 |
| 6 | 补样品任务 | `services/sampleReplacementService.js` | 2 |
| 7 | 售后跨消息上下文 | `services/afterSalesFlowService.js` | 1 |

**为什么这件事要紧（不是洁癖）**：
- 同一份状态在**本地任务 JSON** 里，但**没有任何一份文件能回答"销售单可能处于哪些状态"** ——
  要回答"某状态有没有对应提示"，只能把 `larkMvpService.js`（2698 行）通读一遍；
- 状态名**不在配置里** ⇒ 改名字要改 service，与 AGENTS.md《底层工程原则》"配置先行"相悖；
- 字面量跨状态机重名（`'ignored'`、`'posting'`、`'completed'`、`'posted'`、`'cancelled'`、`'awaiting_confirmation'`）
  ⇒ grep 出来的结果永远要人工分辨是哪一条链路。

### 11.2 入口解析**各自为政**的地方（群聊 / 卡片回调 / 工作台）

**三套入口，三套判据，互不知道对方存在。**

| 入口 | 在哪儿解析 | 它认识什么 | 它不认识什么 |
|---|---|---|---|
| **群聊消息** | `larkMvpService.acceptMessage`（`:784`）→ 三条判据（`:803`、`:897`）→ `SalesGroupFlowService`（`salesGroupFlowService.js:42`）/ `GroupPurchaseFlowService`（`groupPurchaseFlowService.js:44`） | `chat_type` / `thread_id` / `mentions` / 正文正则 / 销售闸门 | 卡片、草稿状态、工作台 |
| **卡片回调** | `larkMvpService.handleCardAction`（`:1992`）→ 一串 `if (action === ...)` | **只有 `value.action` 这个字符串** | 她是从哪个群/话题点的（只有 `event.context.open_message_id`，`:1998` 注释"表单容器的提交回调多带一个 form_value"） |
| **工作台（HTTP）** | `routes/workbench.js` / `workbenchInventoryAdjustment.js` / `purchaseQuery.js` | `x-api-key` + 飞书身份 + query/body 参数 | 群、话题、卡片；**没有群上下文**（`sampleReplacementService.js:56`–`:58` 明写这一点） |
| **多维表格事件** | `routes/larkEvents.js:90` | `file_token` / `table_id` / `action_list` | 一切消息语义 |

**各自为政的具体证据**：

| 事实 | `文件:行` |
|---|---|
| 卡片动作分派是**顺序敏感的一串 if**，注释明写"位置有意放在这里" | `larkMvpService.js:2014`–`:2020`、`:2028`–`:2030`、`:2035`–`:2038` |
| 卡片动作的同步响应**全局固定**一句 `已收到，正在处理`（不论什么业务） | `routes/larkEvents.js:87` |
| 群聊准入的判据在 `larkMvpService`，销售/采购的**分派**在两个独立 service，闸门词表又在第三个文件 | `larkMvpService.js:897` / `salesGroupFlowService.js:42` / `groupPurchaseFlowService.js:44` / `config/messageGate.js:19` |
| 「主群要不要 @」这条判据**只影响主群**，话题免 @ 是**硬编码**的（不是判据） | `larkMvpService.js:804`、`:809` |
| 采购入口的表 ID **从 schema 读**（这是好的做法，且注释解释了为什么） | `routes/larkEvents.js:137`–`:139` |
| 工作台**自己 new** `SampleReplacementService`，用的是缺省出口（没有群上下文） | `sampleReplacementService.js:56`–`:58` 注释 |
| 售后的跨消息上下文**按人**记（`after_sales_context_<hash>`），群话题那条路则靠**话题映射** | `config/afterSalesFlow.js:274`–`:277` vs `salesGroupFlowService.js:50` |

### 11.3 出口**硬编码**在哪些 service

她的原话是「这个出口有可能是**群聊里的话题**，也有可能是**扫码页**」。
**现状：出口只有"群话题"一种，而且"是不是群"是唯一的分支判据。"按来源选出口"没有被实现。**

| service | 出口 | 硬编码成什么 | `文件:行` |
|---|---|---|---|
| `larkMvpService` | 销售卡片 / 任务卡 / 任务文字 | `task.chat_type === 'group'` 才发；否则 `skipNoGroupContext` 返 `null` | `:662`–`:663`、`:680`–`:682`、`:701`–`:702`、`:1968`–`:1970` |
| `larkMvpService` | 话题回复 | `options.threadId` 有值才 `reply_in_thread`（`threadId` 由调用方给） | `:522`–`:545`、`:557` |
| `larkMvpService` | 采购卡片无话题回落 | `replyCard(messageId, card)` | `:442`（AGENTS.md 记录的三个 `replyCard` 调用方之一） |
| `afterSalesFlowService` | 回卡 / 发卡 / 回文字 | 三个缺省出口**全部** `chat_type === 'group'` 或 `skipNoGroupContext` | `:127`–`:135` |
| `salesThreadProgressService` | 回文字 | 缺省 `skipNoGroupContext('text', task)` | `:93`–`:94` |
| `purchaseWebhookService` | 采购单 / 图 / 通知 | **只认 `PURCHASE_CHAT_ID` 这一个群** | `:1334`–`:1346`、`:1420`–`:1428`、`:1663`–`:1669` |
| `purchaseArrivalConversationService` | 卡片 / 文字 | `replyCard` / `replyText` / `updateCard` **由注入方给**；自己只传 `{ threadId }` | `:439`、`:437`；注入点 `larkMvpService.js:324`–`:340` |
| `pendingDealPushService` | 推送 | **只认 `PENDING_DEAL_PUSH_CHAT_ID` 一个群** | `:149`、`:663`、`:681`、`:708` |
| `sampleReplacementService` | 补样品卡 | `sendTarget = channelTask \|\| task` —— **唯一一处"按来源"的雏形** | `:134`、`:59`–`:60` |
| `utils/privateChatSend.js` | 所有缺省出口 | **全仓唯一一处** `skipNoGroupContext`（记 `lark.private_chat.send_skipped` + 返 `null`） | `utils/privateChatSend.js`（AGENTS.md 记录为"只有一处定义"） |

**结论（事实层面）**：
1. **今天能选的出口只有两个**："那个群话题" 和 "没有去处（skip + null）"。
2. **没有任何一条链路按"这次输入是从哪儿来的"选出口** ——
   卡片回调那一路**根本没有来源信息**（只有 `open_message_id`），
   工作台那一路**天生没有群上下文**，多维表格那一路**只有表 ID**。
3. 唯一接近"按来源选出口"的是 `sampleReplacementService.js:134` 的 `channelTask || task`。

---

## 12. 接入"扫码入口"时要动哪里

> ⚠️ 本节**只列事实与最小接缝**，不设计新架构。
> 前置事实：**`/scan` 这个页面/路由今天不存在**（`server/src/app.js:73`–`:79` 只挂了 `/api/lark/events`、`/api/auth/feishu`、`/api/workbench`、`/workbench`）。

### 12.1 已经为扫码准备好的东西（**只差一个页面**）

| 已经存在的事实 | `文件:行` |
|---|---|
| 标签二维码里的 URL 模板：`https://workbench.bamamei.online/scan?no={itemNo}&size={size}&color={color}` | `server/src/config/labelPrint.js:98` |
| 该 URL 由**配置**渲染（占位符 `{itemNo}`/`{size}`/`{color}`），逻辑里一个数字都没写死 | `config/labelPrint.js:3`、`server/src/services/labelPrintService.js:220`、`:234` |
| 代码注释**明说**这个 URL 今天还没有对应页面、「照印，不用管 404」 | `config/labelPrint.js:92` |
| 工作台已有静态页挂载点：`app.use('/workbench', express.static(workbenchPath))` | `server/src/app.js:79` |
| 工作台已有**飞书身份认证**（`/api/auth/feishu/me` 等）与 `WORKBENCH_ALLOWED_OPEN_IDS` 白名单 | `server/src/routes/feishuWebAuth.js`；`app.js:75` |
| 工作台已有**库存只读**接口 `GET /api/workbench/inventory` | `server/src/routes/workbench.js:49` |
| 已有 `workbenchInventoryAdjustment` 路由里的**写入**形状可参考（POST + `handle(...)` 包装） | `server/src/routes/workbenchInventoryAdjustment.js:42`、`:56` |

### 12.2 最小改动点（按"必改 / 可选"分级，全部基于上面的事实）

**必改（3 处）**

| # | 改哪里 | 为什么必须 | 事实依据 |
|---|---|---|---|
| 1 | **新增一个 `/scan` 页面 + 挂载点** | 二维码今天指向一个 404；`app.js` 里没有任何 `/scan` | `config/labelPrint.js:92`（"还没有对应页面"）；`app.js:73`–`:79` |
| 2 | **在飞书开发者后台把 `/scan` 加进 H5 可信域名 / 网页应用主页** | ⚠️ AGENTS.md 第 13 条已实查：**安全设置 → H5 可信域名**漏了就打不开 | `AGENTS.md`「查飞书文档」第 ① 条 |
| 3 | **决定扫码进去之后是"只读看这一双"还是"要写"** | 今天 `/api/workbench/*` 的**写入**接口只有 3 个（无一是"按货号+尺码写"）；`/scan` 要写就得复用 `workbenchInventoryAdjustment` 那套 POST 形状 | `routes/workbench.js:81`、`:94`；`routes/workbenchInventoryAdjustment.js:42`、`:56` |

**可选 / 只在她要"扫码之后还能接着聊"时才需要（2 处）**

| # | 改哪里 | 说明 |
|---|---|---|
| 4 | **`/scan` 是否要能"回到那个群话题"** | 今天**没有任何接口能把"页面动作"送回某个群话题** —— 出口全部硬编码在 service 里（第 11.3 节）。若要做，最小接缝是**复用 `sendTaskText`/`sendCardToTask` 那套"任务感知出口"**：给一个带 `chat_type/chat_id/group_thread_id` 的**任务壳**即可（`larkMvpService.js:1011`–`:1018` 就是这个形状），**不需要新架构** |
| 5 | **`/scan` 的入口要带"来源"** | 今天 `handleCardAction` 只看 `value.action`（`:1993`）；若要新增一个卡片动作作为扫码入口，**必须加在 `:2002`–`:2050` 那串 if 里**，且注意它的**顺序敏感性**（注释 `:2014`、`:2028`、`:2035`） |

**🔴 明确不需要动的（避免过度设计）**

- **不需要**新建一个 `ScanService`：现有 `/workbench` 静态页 + `/api/workbench/*` 的形状已经够；
- **不需要**改 `labelPrint.js` 的 URL 模板（它已经是配置、已经带三个占位符）；
- **不需要**碰 `routes/larkEvents.js`（扫码是 HTTP 入口，不是飞书事件）；
- **不需要**动任何状态机（第 10 节那些状态是"任务"的状态，扫码页无任务）。

### 12.3 会挡路的两件事（如实说）

1. **`/scan` 页面今天没有身份与权限形状** —— 它必须**借用**工作台那套飞书身份（`feishuWebAuth.js`）或另设一个 `API_KEY` 闸门；**两条路今天都还没为它准备**（`app.js:98` 的 `API_KEY` 中间件保护 `/api/*`，而 `/scan` 若做成 `/api/scan` 就会被它挡，做成静态页则没有身份）。
2. **"出口有可能是扫码页"这条产品设想，在代码里今天没有任何落点** ——
   全仓 grep `scan` 只命中**标签打印**与**目录扫描**（`utils/uploadCleanup.js` 的 `scanned` 计数器），
   **没有一条业务链路把"输出"指向一个页面**。

---

## 13. 最重要的 5 条事实（给工程师对齐用）

1. **状态枚举没有总表：3 个在 config、7 个是散落的字符串字面量。**
   有枚举的是销售进展 / 确认成交 / 售后任务（`config/salesProgressIntake.js:138`、`config/salesConfirmDeal.js:35`、`config/afterSalesFlow.js:37`）；
   没有枚举的包括**销售草稿任务本身**（11 个字面量散在 `larkMvpService.js`：1022/1640/1664/1942/2316/2330/2340/2362/2449/2469/2552/2613/2646/2685）
   与采购报单 / 到货核对 / 库存 / 推送（第 10.2 节）。

2. **有状态、没提示的地方是真实存在的**：
   `'received'`（`larkMvpService.js:1022`）/ `'parsing'`（`:1664`）—— 建完任务到出卡片之间**只有表情、没有文字**；
   售后 `RUNNING`（`afterSalesFlowService.js:597`）—— 落了状态但只有**再点一次**才收到「正在写入，请稍候」；
   到货核对 `'posting'`（`purchaseArrivalConversationService.js:984`）—— **没有"正在入库"的反馈**；
   库存操作的全部三个状态（`inventoryService.js`）—— **完全没有面向用户的提示**。

3. **出口是写死的**：全仓出口**只有"群话题"一种**，判据**只有 `task.chat_type === 'group'`**；
   **没有任何一条链路按来源选出口**（第 11.3 节）。
   最"硬"的两处：采购单/图**只发 `PURCHASE_CHAT_ID`**（`purchaseWebhookService.js:1344`）、
   9 点推送**只发 `PENDING_DEAL_PUSH_CHAT_ID`**（`pendingDealPushService.js:149`）。

4. **卡片回调那条路的可见反馈几乎全靠卡片本身** ——
   路由的同步响应**全局固定**是 `已收到，正在处理`（`routes/larkEvents.js:87`），
   `config/arrivalConversation.js:285`–`:288` 的注释**明写**那一整块 toast「她那边看不见」，只进日志；
   所以**只做 toast 不做 patch 的失败路径 = 她什么都看不到**（售后有 5 处这样的抛错：`afterSalesFlowService.js:515/517/518/587/529`）。

5. **扫码入口今天只差一个页面**：
   二维码 URL 模板与三个占位符**已经可配、已经在印**（`config/labelPrint.js:98`，
   注释 `:92` 明说"`/scan` 是下一步做的，照印，不用管 404"），
   而 `app.js:73`–`:79` 里**没有 `/scan`**。最小改动 = **加一个页面 + 加挂载点 + 配 H5 可信域名**（第 12.2 节），
   **不需要新架构**。

---

## 14. 本文档的边界（没写进来的东西）

- **没有**列 `utils/larkCards.js` 里 14 张卡片的全部字段级文案（那需要另开一份"卡片说明书"）；
  本文只列了"某个状态会发哪张卡、卡上那句关键中文在哪一行"。
- **没有**列 `v1BitableSchema.js` 的字段映射（那是另一份契约，`v1:schema-check:*` 是它的闸门）。
- **没有**列工作台前端（`server/public/workbench/`）的页面状态机 ——
  工作台是**没有本地任务状态**的（全同步 HTTP），所以不在"状态 → 提示"的模型里。
- 所有「**未找到**」都是**真找不到**，不是省略。需要的话按那一节的 `文件:行` 去核。
