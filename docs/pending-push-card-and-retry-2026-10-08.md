# 9 点推送：改成消息卡片 + 日志真实错误 + 失败自动重试（2026-10-08）

> ⚠️ 本文件按 AGENTS.md 第 2 条「先写验收标准，再动手」写成：第 2 节的验收标准在**改代码之前**写定，
> 第 4 节是改动后的逐条对照与证据（改动后回填）。

## 0. 业务负责人的口径（逐字，2026-10-08 上午）

> 「甲 ⭐ **改成消息卡片**（`interactive`）—— · 单号**加粗**、类型用彩色标签、【待收金额】突出显示 ·
>  长链接改成「**查看原话**」这样的**文字链接**（URL 藏起来，不再占一行）· 分区块加分割线、采购区单独一块 ·
>  客户端不支持时降级成纯文本（可用飞书的 fallback）」
>
> 「其实**不需要单号**，需要的是那个**编号和尺码信息**～这个才是最重要的，确实长链接需要改为「查看原话」这样的文字链接，
>  然后销售按照**预定和现货待收**分区，**不需要退货和换货的**，销售就是预定和现货待收的」
>
> 「① 日志 bug：`lark.sdk.error detail: [["[object]","[object]"]]` ⇒ 改成打**真实 code/msg** …
>  ② **推送失败自动重试**：失败后隔 **5/15 分钟**各重试一次，别一次失败就整天不发 … 可以一并修复～」

⚠️ 后一条口径（「**不需要单号**」）**优先于**前一条里的「单号加粗」——两条冲突时按后者。
⇒ 行内容里的「加粗」落在**货号 + 尺码**上（她说的「编号和尺码信息」=「销售明细.编号」关联的货号 + 尺码）。

### 0.1 真机证据（2026-10-08 09:05 那次失败）

- 失败：`sales.pending_deal_push.failed { error: "Request failed with status code 400" }`；
  日志只剩 `lark.sdk.error detail:[["[object]","[object]"]]`，看不到真正原因；
  手动补发才拿到 `code 1254607 · msg "Data not ready, please try again later"`。
- 二次伤害：09:05 失败 → 09:15 那班记 `already_ran_today` ⇒ 一整天不再发。
- 她看到的成品问题：长 applink 占满整行 · 标题重复计数（`（预定 / 现货待收）：5 笔（【预定】5 笔）`）·
  「待收 ￥0.00」（那笔其实已付清）· 一笔「待收 ￥—」且没有货号尺码。

## 1. 只读核查（动手前）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| `services/pendingDealPushService.js:365` | `msg_type:'text'` + `{text}` | 改默认发 `interactive` 卡片；文本模板留作**降级** |
| `config/pendingDealPush.js` | `headerTemplate` / `sectionTemplate` / `lineParts` / `footerTemplate` / `purchaseFooterTemplate` | 改造（见 2.5 配置项） |
| `services/secondDeliveryService.js:341` | `progressFromRecords` 对 `已换货` 抛错 → 整单跳过 + warn `未知销售明细履约状态` | 改成**显式规则**：含 已退货/已换货/已赔货 明细的单不进这两份「待处理」清单，记 info 不再记"未知" warn |
| `utils/larkLogger.js:36` | 非 Error 对象一律 `'[object]'`（SDK 正是 `logger.error([objA, objB])` 这个形状，见 `@larksuiteoapi/node-sdk/lib/index.js` 的 `formatErrors`） | 改成白名单投影（code/msg/log_id/method_id/status/method/url），**绝不**带 `config.data`（那里有 App Secret） |
| `services/pendingDealPushService.js:419` | 失败也留 `pending_deal_push_day_<day>` 记录 ⇒ 当天 `already_ran_today` | 改成按 `retry_delays_ms` 重试；第一次失败**不算跑过** |
| `services/purchaseWebhookService.js:175` | 已有 `larkErrorText`（只取 code/msg） | 收敛到共享的 `utils/larkError`（同一形状一处实现） |
| `utils/larkCards.js` | 既有 14 张卡 | 🔴 **一行不改**；新卡片渲染另立 `utils/pendingDealPushCard.js` |

**不碰**：销售录单/确认链路、采购报货/到货链路、`app.js`、`v1BitableSchema`、`inventoryService`、
`larkCards.js` 的既有卡片。**不写任何表**（只读核可以）。

### 1.1 飞书官方文档核查（curl，AGENTS.md 第 13 条）

- 卡片 JSON 1.0 全局字段里有 `fallback`（降级规则）：**它只展示飞书自己的占位图**
  「请升级客户端至最新版本后查看」，**不能**承载我们的纯文本
  （`/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure` 的「卡片全局降级规则 `fallback`」一节）。
- 卡片 JSON 1.0 富文本（`lark_md`）支持：`**粗体**`、`<font color='red'>`、
  `<text_tag color='blue'>标签</text_tag>`、`[文字链接](https://…)`（1.0 富文本组件文档的语法表）。
- 卡片元素里**没有** `{"tag":"a", href, text:{…}}` 这种独立超链接组件（1.0 / 2.0 的组件总览里都没有）。
  ⇒ 口径里那个形状用**官方支持的等价物**落地：`[查看原话](<深链>)`（URL 一样藏在文字后面）。

## 2. ⭐ 改完之后应该是什么样（验收标准，动手前写定）

### 2.1 AC-A 消息卡片

| # | 场景 | 期望（可执行判据） |
| --- | --- | --- |
| A1 | 发送形态 | `msg_type:'interactive'`，`content` 是卡片 JSON；`config.wide_screen_mode=true`；**不带** `update_multi`（本卡不 patch，与仓库既有纪律一致） |
| A2 | 头顶 | `header.title.content` = 表头文案（含**日期**与**总计**）；**只有一个区块时不带分区计数**（修「5 笔（【预定】5 笔）」那种重复）；两个区块时保留 `（【预定】x 笔 / 【现货待收】y 笔）` |
| A3 | 区块 | `【预定】` 在前、`【现货待收】` 在后（顺序仍由配置给，**不改**）；块标题加粗；每块一个 `div`，逐行一个 `div` |
| A4 | 分割线 | 相邻两个**有内容的**区块之间一个 `{"tag":"hr"}`；首块之前、尾块之后**没有**分割线 |
| A5 | 采购区 | 采购候选非空 → 加粗块标题 + 每批一行；为空 → **整块 + 它前面那条分割线都不出现** |
| A6 | 脚注 | 有深链缺失时一个 `note` 元素，内容是既有脚注文案（销售 / 采购各一行） |
| A7 | 每行内容 | `序号.` + **加粗的货号+尺码**（一单多件逐件列出，配品不拼「码」）+ 彩色类型标签 + **突出显示的待收金额** + `[查看原话](深链)`；🔴 **不出现单号** |
| A8 | 无裸 URL | 卡片里 URL 只出现在 markdown 链接的 `()` 里、或**不出现**；正文其余地方一个 `http` 都没有 |
| A9 | 待收为 0 | 渲染「**已付清**」，不再出现「待收 ¥0.00」 |
| A10 | 金额拿不到 | **整段不渲染**（既不出现 `¥—`，也不出现 `NaN`、更不出现 `¥0.00`） |
| A11 | 深链缺失的行 | 不出现链接段、**也不留空的 ` · `**；仍计入脚注计数 |
| A12 | 降级（纯文本） | `PENDING_DEAL_PUSH_MESSAGE_FORMAT=text` → `msg_type:'text'`，同一份内容的纯文本（分区、货号尺码、类型、待收/已付清、`查看原话 <URL>`）——**内容可读**，且**没有单号** |
| A13 | 自动降级 | 默认（card）下卡片**发送失败** → 用同一份纯文本**兜底发一次**；兜底成功 ⇒ 记 `sent`、`message_format:'text'`、`degraded:true`，并记一条含真实 code/msg/log_id/method_id 的 warn；兜底也失败 ⇒ 交给重试 |

> ⚠️ A12/A13 就是「客户端不支持时降级成纯文本」的落地方式：飞书的 `fallback` 字段**只能**给出它自己的
> 占位图（见 1.1），拿不到我们的文本 ⇒ 真正的降级是我们自己的纯文本模板 + 发送失败即回退。

### 2.2 AC-B 销售区候选口径（退货 / 换货 / 赔货不进）

| # | 场景 | 期望（可执行判据） |
| --- | --- | --- |
| B1 | 明细含 `已退货` | 该单**不进** 9 点推送的销售区 |
| B2 | 明细含 `已换货` | 同上（今天正是它在打「未知销售明细履约状态」的 warn） |
| B3 | 明细含 `已赔货` | 同上 |
| B4 | 日志 | 记一条 **info** `…reminder.order_skipped { reason:'after_sales_fulfillment', fulfillment_status }`；**不再**出现 `未知销售明细履约状态` 的 warn |
| B5 | 判据来源 | 三个字面量只从 `config/afterSales.js` 的 `AFTER_SALES_FULFILLMENT` 取（`AFTER_SALES_FULFILLMENT_EXCLUDED`），不在 service 里写第二份中文 |
| B6 | 不误伤 | 明细 `未交付` / `已交付`（含 `部分交付`）的单**照旧**进候选；「成交提醒」卡片那条链路的候选集合与改动前**一样**（今天它也是跳过这些单） |

> ⚠️ 这条是**口径变更**，不是放宽：改动前这些单**也是**被跳过的（`progressFromRecords` 抛错 →
> 调用方 catch → `order_skipped`），只是日志把它说成"未知"。现在把它写成明确规则、日志如实说。

### 2.3 AC-C 日志真实错误

| # | 场景 | 期望（可执行判据） |
| --- | --- | --- |
| C1 | `lark.sdk.error` | 打出飞书返回的真实 `code` / `msg` / `log_id` / `method_id`（来自 `error.response.data`，`log_id` 可退 HTTP 头 `x-tt-logid`）；**任何字段都不许是 `[object]`** |
| C2 | SDK 那个形状 | `@larksuiteoapi/node-sdk` 的 `formatErrors` 传的是**两个普通对象**组成的数组；投影后仍是真实四项（用真形状钉住） |
| C3 | 密钥 | 🔴 投影**绝不**带 `config.data`（那里是 App Secret）；既有 CANARY 用例继续绿 |
| C4 | 推送失败日志 | `sales.pending_deal_push.failed` 带 `code` / `msg` / `log_id` / `method_id` + `error`（message） |
| C5 | 成交提醒失败日志 | `sales.second_delivery.reminder.failed` 同样带四项（同形状一处修） |
| C6 | 成功路径 | 发送返回 `code !== 0` 时抛的错也带这四项（不靠 message 猜） |

### 2.4 AC-D 失败自动重试（幂等）

| # | 场景 | 期望（可执行判据） |
| --- | --- | --- |
| D1 | 第一次失败 | 当天记录 `status:'failed'`、`sent` **不为 true**、`attempts:1`、`next_retry_at = 首次失败时刻 + 5 分钟`；日志 `will_retry:true` |
| D2 | 未到点 | `now < next_retry_at` → `skipped, reason:'retry_waiting'`，**一条消息都不发** |
| D3 | 到点 | `now >= next_retry_at` → 真重试（第 2 次尝试）；再失败 ⇒ `attempts:2`、`next_retry_at = 首次失败 + 15 分钟` |
| D4 | 第二次到点 | 第 3 次尝试；再失败 ⇒ `retries_exhausted`，**当天不再试**（后续任何 now 都 `skipped, reason:'retries_exhausted'`） |
| D5 | 重试成功 | 记 `status:'completed'`、`sent:true`、`message_id`；**同一天再调** → `already_ran_today`，`creates.length` 不再增长（**绝不重复发**） |
| D6 | 定时器 | 注入的 `scheduleRetry` 依次被以 `[300000, 900000]`（ms）调用；重试回调内部吞异常（不产生 unhandledRejection） |
| D7 | 配置 | `PENDING_DEAL_PUSH_RETRY_DELAYS_MS`（默认 `300000,900000`）可配：空串 = 不重试；非法值启动时抛错 |
| D8 | 非失败终态不重试 | `no_pending_order` / `no_chat` / `link_unavailable` / `disabled` 与改动前一致：当天不再试 |
| D9 | 崩溃窗口 | 记录停在 `running`（进程崩在两次写之间）⇒ 与改动前一致：当天不再发（第二天自愈），不引入重复发送 |

### 2.5 AC-E 配置项（配置先行）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `PENDING_DEAL_PUSH_MESSAGE_FORMAT` | `card` | `card` / `text`；认不出来的值启动时抛错 |
| `PENDING_DEAL_PUSH_RETRY_DELAYS_MS` | `300000,900000` | 首次失败后的重试时刻（偏移量，ms）；空串 = 不重试 |
| `PENDING_DEAL_PUSH_LINK_TEXT` | `查看原话` | 文字链接的可见文案 |
| `PENDING_DEAL_PUSH_AMOUNT_TEMPLATE` | `待收 {amount}` | 纯文本降级里的金额段 |
| `PENDING_DEAL_PUSH_PAID_UP_TEXT` | `已付清` | 待收为 0 时的文案 |
| `PENDING_DEAL_PUSH_CARD_HEADER_COLOR` | `blue` | 卡片标题配色 |
| `PENDING_DEAL_PUSH_CARD_AMOUNT_COLOR` | `red` | 金额高亮配色 |
| `PENDING_DEAL_PUSH_PREPAID_TAG_COLOR` / `…_CASH_PENDING_TAG_COLOR` | `blue` / `orange` | 类型彩色标签的配色 |

（卡片标记骨架 `card.sectionTitleTemplate` / `lineParts` / `itemTemplate` / `tagTemplate` / `linkTemplate`
也都在 `config/pendingDealPush.js` 的 `PENDING_DEAL_PUSH_DEFAULTS.card` 里，与既有 `blockCountsTemplate`
同一档：**改文案不碰 service**。）

### 2.6 AC-F 测试要钉住的九条（业务负责人点名）

① 卡片 JSON 结构（分区 / 分割线 / 文字链接 / 无裸 URL）· ② 行内容 = 货号+尺码+类型+待收+查看原话 ·
③ 退货/换货/赔货的单不进（逐条）· ④ 待收 0 → 「已付清」· ⑤ 深链缺失 → 无链接 + 脚注计数 ·
⑥ 日志含真实 code/msg/log_id · ⑦ 重试：失败后 5/15 分钟各一次、成功即停、不重复发、全失败当天不再试 ·
⑧ 降级 fallback 仍可读 · ⑨ 采购区为空不出现、有则一块

### 2.7 AC-G 边界

| # | 期望 |
| --- | --- |
| G1 | `app.js` 一行不改（新行为全在 service / config 内部；定时器仍每 tick 调 `sendDailyPush`） |
| G2 | `larkCards.js` 一行不改；新卡片渲染在 `utils/pendingDealPushCard.js` |
| G3 | `v1BitableSchema` / `inventoryService` / 销售录单链路 / 采购报货到货链路一行不改 |
| G4 | 只读：不新增任何写表调用（本服务本来就只读表 + 发消息 + 写本地任务记录） |
| G5 | 既有「销售区逐字哨兵」的改动**逐条给出理由**（口径变更说明，见 4.3） |

## 3. 先红后绿（改动前真的红）

在**未改动的 `main`（`dea3a34`）**上另建一个 detached worktree，只把三个**新**用例文件
（＋那张纯渲染件 `utils/pendingDealPushCard.js`，好让失败停在**断言**上而不是"模块不存在"）放进去跑：

```
$ node --test --test-concurrency=1 test/pendingDealPushCard.test.js test/pendingDealPushRetry.test.js test/pendingDealPushExclusion.test.js
ℹ tests 20
ℹ pass 2
ℹ fail 18
```

- 18 条红，形如：`① 默认形态 = 消息卡片`（实际 `text`）、`service.buildCardLine is not a function`、
  `D1 首次失败 + 5 分钟`（改动前那一天直接记 `already_ran_today`）、
  `B1/B2/B3 …不许进候选`（`AFTER_SALES_FULFILLMENT_EXCLUDED` 还不存在）。
- **2 条绿**是**故意的**：`B6 不误伤`（未交付 / 已交付 的单照旧进候选）是**前后都必须成立**的回归哨兵 ——
  它现在绿，说明这次改动没有把正常单一起排除掉。

## 4. 逐条对照（实现后）

### 4.1 关键改动清单

| 文件 | 改了什么 |
| --- | --- |
| `server/src/config/pendingDealPush.js` | 新增发送形态 / 重试窗口 / 金额段 / 已付清 / 链接文案 / 卡片配色等旋钮；`blocks` 加 `tagColor`；`lineParts` 去单号；新增 `card` 标记骨架 |
| `server/src/utils/pendingDealPushCard.js` | **新件**：卡片骨架（纯函数：标题 / 块 / 块间 `hr` / 脚注 / 段与段的拼法） |
| `server/src/services/pendingDealPushService.js` | `buildCard` + `buildCardLine`；`deliver`（卡片 → 纯文本降级）；`resolveAttempt` 状态机与 5/15 分钟重试；失败日志带真实四项 |
| `server/src/utils/larkError.js` | **新件**：`code / msg / log_id / method_id` 的唯一取用口（含 HTTP 头 `x-tt-logid`） |
| `server/src/utils/larkLogger.js` | 普通对象不再 `[object]`，改白名单投影（SDK `formatErrors` 那个形状） |
| `server/src/config/afterSales.js` | `AFTER_SALES_FULFILLMENT_EXCLUDED` + `isAfterSalesFulfillment`（退/换/赔三个字面量的唯一来源） |
| `server/src/services/secondDeliveryService.js` | 候选里显式排除售后件（info 日志，不再"未知"warn）；失败日志带真实四项 |
| `server/src/services/purchaseWebhookService.js` | `larkErrorText` 收敛成 `utils/larkError` 的薄壳（形状不变） |
| `.env.example` | 新旋钮 + 口径（卡片 / 重试 / 已付清 / 无单号）写进模板 |
| 🔴 未动 | `app.js` · `utils/larkCards.js` · `config/v1BitableSchema.js` · `services/inventoryService.js` · 销售录单/采购链路 |

### 4.2 逐条对照

| # | 期望 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 卡片形态 | ✅ | `pendingDealPushCard.test.js` ①：`msg_type:'interactive'`、`wide_screen_mode`、无 `update_multi` |
| A2 | 标题含日期与总计、单区块不重复计数 | ✅ | ① / A2 两条用例 |
| A3 | 预定在前、现货待收在后、块标题加粗 | ✅ | ① 断言 `**【预定】1 笔**` 与元素顺序 |
| A4 | 块间分割线（首尾没有） | ✅ | ① `['div','div','hr','div','div']`；⑨ 空采购区时**一条 hr 都没有** |
| A5 | 采购区为空不出现、有则一块 | ✅ | ⑨ |
| A6 | 脚注 note | ✅ | ⑨ / A5（销售 + 采购各一行） |
| A7 | 行 = 货号+尺码 + 类型标签 + 待收 + 查看原话，**无单号** | ✅ | ②（逐字 `1. **JC002 40码** · <text_tag…> · <font…> · [查看原话](url)`；断言卡片里不含 `XSD-P-1`） |
| A8 | 无裸 URL | ✅ | ② 把 markdown 链接目标挖掉后断言正文无 `http`；⑤ 缺深链时整个卡片无 `http` |
| A9 | 待收 0 → 已付清 | ✅ | ④ |
| A10 | 金额拿不到 → 整段不渲染 | ✅ | ④（无 `¥` / `NaN`；也不留空 ` · `） |
| A11 | 深链缺失 → 无链接段 + 脚注计数 | ✅ | ⑤ |
| A12 | `format=text` 可读 | ✅ | ⑧（逐字：无单号、`查看原话 <URL>`） |
| A13 | 卡片发送失败 → 自动纯文本兜底 | ✅ | ⑧（`['interactive','text']` 两次 create、`degraded:true`、`sent:true`、日志带四项） |
| B1–B3 | 退/换/赔 的单不进（逐条） | ✅ | `pendingDealPushExclusion.test.js` 逐状态 loop |
| B4 | 记 info、不再"未知"warn | ✅ | 同文件断言 `reason:'after_sales_fulfillment'` 且日志里**没有**「未知销售明细履约状态」 |
| B5 | 判据只从配置取 | ✅ | 同文件读源码断言 service 里没有那三个字面量 |
| B6 | 不误伤（未交付 / 已交付 照旧） | ✅ | 同文件（且这一条在**改动前也是绿的**） |
| C1 | `lark.sdk.error` 真实四项、无 `[object]` | ✅ | `larkLogger.test.js` 两条新用例 |
| C2 | SDK `formatErrors` 那个"两个普通对象"形状 | ✅ | 同文件 `sdkErrorPair()` 形状 |
| C3 | 绝不带 `config.data`（密钥） | ✅ | 既有 CANARY 用例（含真 SDK 网络失败那一条） |
| C4 | 推送失败日志带四项 | ✅ | `pendingDealPushRetry.test.js` D1（`code 1254607 / msg / log_id / method_id`） |
| C5 | 成交提醒失败日志带四项 | ✅ | 代码同形；`second_delivery` 既有用例全绿（无新用例，见 4.5） |
| C6 | `code !== 0` 抛的错也带四项 | ✅ | `larkResponseError`（`utils/larkError`） |
| D1 | 首次失败不算跑过、+5 分钟 | ✅ | D1（`status:'failed'`、`sent:false`、`next_retry_at`、`will_retry:true`） |
| D2 | 没到点不发 | ✅ | D1（`retry_waiting`，`creates.length` 不变） |
| D3 | 到点重试、再失败 +15 分钟 | ✅ | D1 |
| D4 | 两次用完 → 当天不再试 | ✅ | D1（`retries_exhausted`；第二天**新的一天**照常第一次尝试） |
| D5 | 成功即停、绝不重发 | ✅ | D5（第 3 次成功 ⇒ 再调 `already_ran_today`，`creates.length` 不变） |
| D6 | 定时器按 5/15 分钟被调用 | ✅ | D1（`scheduled == [300000, 900000]`） |
| D7 | 窗口/次数配置化 | ✅ | D7 两条（默认 / 自定义 / 空串 = 不重试 / 非法抛错 / 一个窗口 ⇒ 只重试一次） |
| D8 | 非失败终态不重试 | ✅ | D8 |
| D9 | 崩在 `running` 不重发 | ✅ | D9 |
| G1–G4 | 边界 | ✅ | `git diff --name-only` 里没有 `app.js` / `larkCards` / `v1BitableSchema` / `inventoryService`；没有新增写表调用 |

### 4.3 既有「销售区逐字哨兵」的改动 —— 逐条为什么是**口径变更**

| 用例 | 改动前的断言 | 改动后 | 为什么是口径变更（不是放宽） |
| --- | --- | --- | --- |
| `pendingDealPush.test.js`「配置默认值」 | `lineParts: ['{index}. {orderNo} {tag}', …]` | `['{index}. {item}', '{tag}', '{amount}', '{link}']` | 她逐字「**不需要单号**」；「编号和尺码信息」提到最前。断言仍然**严格全等**，还多钉了 `messageFormat` / `retryDelaysMs` / `card` / 每个区块的 `tagColor` |
| 同上「正常推」 | `msg_type:'text'` + `1. XSD-A-1 【预定】 · … · <裸 URL>` | `msg_type:'interactive'` + 卡片可见字 `1. B26002-52 37码 · 【预定】 · 待收 ¥1280.00 · 查看原话 <URL>` | 她逐字「甲 **改成消息卡片**」「长链接改成「**查看原话**」这样的**文字链接**」 |
| 同上「金额未知」 | `待收 ¥—` | **整段不渲染** | 她点名的 nit：「金额拿不到时不要渲染「￥—」」 |
| `pendingDealPushSections.test.js` 各条 | 表头带 `（【预定】1 笔）`、行首是单号、`[深链]` 裸 URL | 单区块标题不重复计数、行首是货号尺码、`查看原话 URL` | 同上两条 + 她真机看到的「5 笔（【预定】5 笔）」重复计数 |
| `pendingDealPushPurchaseSection.test.js`「⑩ / F4」 | 销售脚注夹在销售区尾部、`https://…` 裸链 | 两个缺失脚注合并到卡片末尾那一条 `note`；采购行 `查看原话 https://…` | 卡片结构是「… → 采购区 → **脚注**」（口径第 1 条）；文字链接口径同上 |
| 同上「⑪ 销售区逐字哨兵」 | 名称「**逐字不变**」 | 改名「销售区的**纯文本渲染**在加不加采购区时**逐字节相同**」 | 行内容本身已按口径改（去单号、加「查看原话」），但**哨兵的作用没变**：`combined.slice(0, salesText.length) === salesText` 仍然逐字节相等 |
| 同上「F4 顺序可配」 | 断言首行是`最近 7 天待处理的销售单…`（销售表头） | 断言首块是 `【采购】…`、且**没有**销售表头 | `areas` 可配时销售区可能不在最前；表头那句写的是"待处理的**销售单**"，采购区在顶上时套用它是错的（4.4 判断③） |
| `pendingDealPushSections.test.js`「配置可配」 | 自定义行模板 `欠 {amount}` | 模板改 `{amount}`（不再重复写「待收」） | `{amount}` 现在是**整段**（`待收 ¥…` / `已付清`；读不出来整段没有）—— 要让"待收 0 → 已付清"和"读不出来 → 整段消失"两条口径成立，金额段只能由一处渲染。**语义在 `.env.example` 与 config 注释里写明了** |
| `larkLogger.test.js` | `describe({config:{data:CANARY}}) === '[object]'` | 断言"不是 `[object]`"且**不含 CANARY** | 业务负责人点名的①：`[object]` 等于什么都没说；关键红线（绝不带 `config.data`）**断言保留** |

### 4.4 需她 / Lead 知情的判断（4 处）

1. **`{tag:'a', href, text:{content:'查看原话'}}` 不是飞书卡片组件** ——
   官方 1.0 / 2.0 组件总览里都没有独立超链接元素（1.1 是 curl 实查）。落地用的是官方支持的
   markdown 文字链接 `[查看原话](<深链>)`，效果一样（URL 藏起来、点得动）。
2. **飞书的 `fallback` 字段承载不了纯文本** —— 它只展示系统占位图
   「请升级客户端至最新版本后查看」。所以"降级成纯文本"落成**我们自己的两个出口**
   （`PENDING_DEAL_PUSH_MESSAGE_FORMAT=text` ＋ 卡片发送失败自动改发文本），
   **没有**给卡片加 `min_client_version` 降级规则（加了反而会把正常卡片降级成占位图）。
3. **只有采购候选时卡片没有标题**：表头那句写的是"待处理的**销售单**"，销售一笔都没有时套用它在说假话；
   采购区自己的加粗块标题就是抬头。（销售区不在最前时同理，见 4.3 最后两行。）
4. **成交提醒（`second_delivery`）只修日志、没加自动重试** —— 她点名②时说的是「推送」，
   而成交提醒是**另一条链路**（卡片上的「成交」按钮会写库），按"最小改动"只同步了①的日志修复。
   ⚠️ **代价**：那条提醒仍有"一次失败就整天不发"的形状（它与本次改的 9 点推送各有一套按天认领）。
   要一起加是另一件改动（把 `resolveAttempt` 那套抽成共用件），**等她的口令**。

### 4.5 证据：全量、CI

| 项 | 结果 |
| --- | --- |
| 全量第 1 次 | `node --test --test-concurrency=1` → **1387/1387 pass, fail=0** |
| 全量第 2 次 | 同上 → **1387/1387 pass, fail=0** |
| 全量第 3 次 | 同上 → **1387/1387 pass, fail=0** |
| CI 三项（PR #265） | `test` **pass**（56s）· `CodeQL` **pass**（3s）· `Analyze (javascript-typescript)` **pass**（1m9s）；`gh pr view 265 --json mergeStateStatus` = **CLEAN** |

⚠️ **一次没能复现的抖动**：在此之前的一次全量里，输出尾部出现过一条
`AssertionError … actual: null / expected: true / operator: '=='`（`assert.ok` 形状，**测试名没抓到**）；
随后连跑 3 次都是 1387/1387 fail=0，**无法复现**，也**不在本次新增的用例形态里**
（新用例没有 `assert.ok(<可能为 null 的值>)`）。如实记在这里，供后续排查参考。

⚠️ 本机**没有**真机飞书客户端：卡片的真机视觉效果（彩色标签、金额高亮、分割线）**未在手机上验过**，
按飞书官方文档的语法实现；部署后建议她先看一眼。
