# 「待处理单推送」发送后置顶（Pin）实现与验收（2026-10-07）

业务负责人 2026-10-07 拍板（逐字）：

> 「② **打开「待处理单推送」，每天 9 点推一次预付/未付的单子** 是的，还是一个群，是的，是这个功能：
>  **是飞书的【置顶消息】（把那张卡片钉在群顶部）** → 那是另一个动作，我需要单独做（飞书有置顶接口）」

⇒ 三件事：① 每天 9 点推一次（**已有**调度，默认 `hour=9`）；② 目标是采购群；③ **新做「发送后把该消息置顶」**。

本文按「先写验收标准 → 再动手 → 逐条对照」的流程写（业务负责人定的测试流程）。

---

## 一、先核清：这条推送**推什么**（只读代码，未改口径）

候选单 = `PendingDealPushService.listPendingOrders` → **复用** `SecondDeliveryService.listPendingDeliveries`
（`server/src/services/secondDeliveryService.js:246`），口径只有一处实现：

| 条件 | 代码位置 | 说明 |
| --- | --- | --- |
| 已入账（销售状态 = 已写入） | `secondDeliveryService.js:263` `isPosted` | 没入账的不推 |
| 交易类型 ∈ {`SALE_UNPAID` 未付, `SALE_PREPAID` 预付} | `:29` `REMINDER_TRADE_TYPE_CODES` | **正是她说的两类**；现货/退货/换货不进 |
| 销售日在**最近 7 个上海自然日**内 | `:32` `REMINDER_WINDOW_DAYS = 7`、`:289` | 明细「销售日」优先，退回主表「录单日」 |
| 尚未完成履约（`progress.orderStatus !== '已完成'`） | `:301` | 「已完成」= 钱**且**货都清 |

`orderStatus` 的算法（`server/src/services/salesProgressService.js:41-56`）：

- `pendingAmount`（**待收金额 / 欠款**）= 成交金额 − 已收款 − 待平台结算；
- `pendingDeliveryQuantity`（未交付数量）= 明细条数 − 已交付条数；
- `orderStatus = 成交金额已知 && 已收款 == 成交金额 && 已交付 == 全部 ? '已完成' : '已确认'`。

**结论（覆盖是否够）**：

- ⭐ **预付**：`SALE_PREPAID` 在筛选项里；「未交付」（`fulfillmentStatus='未交付'` → `orderStatus!=='已完成'`）与「尾款未收」（`pendingAmount>0`）都会被选中。**覆盖**。
- ⭐ **未付**：`SALE_UNPAID` 在筛选项里；「欠款未收」（`pendingAmount>0`）会被选中。**覆盖**。
- ⚠️ **窗口限制**：只推**最近 7 个上海自然日**内录/售的单。超过 7 天仍没成交的老单**不在推送里**
  （这是「维度 1」原本就定的口径，不是本次引入的；是否要放宽窗口属于业务口径，未改）。
- 🔴 **文案里没有的内容**（如实报告，**未擅自扩范围**）：推送正文只有

  ```
  ⏰ 2026-10-06 最近 7 天未付 / 预付、尚未成交的销售单：2 笔
  1. XSD-A-1 · 待收 ¥1280.00 · <深链>
  2. XSD-B-2 · 待收 ¥300.50
  （1 笔的深链暂不可用：飞书接口未返回 message_app_link，见日志 sales.pending_deal_push.link.missing）
  ```

  **没有**：货号、成交金额、售出日期（只在表头有当天日期）、这一笔是**未付**还是**预付**、未交付数量、
  客户名。她问的「单号 / 货号 / 金额 / 欠款 / 时间」里，现在只有**单号**与**欠款（待收金额）**。
  ⇒ 若她要更多字段，那是**改文案口径**，需要她点头后再做（本文不含）。

---

## 二、curl 到的官方口径（2026-10-07，`curl` 拉官方文档，未用 web_search）

命令形态：`curl -sS -L "https://open.feishu.cn/document/<路径>.md?lang=zh-CN"`

| 动作 | 接口 | 文档路径（实查 200） |
| --- | --- | --- |
| 置顶 | `POST https://open.feishu.cn/open-apis/im/v1/pins`，body `{"message_id":"om_…"}` | `server-docs/im-v1/pin/create` |
| 取消置顶 | `DELETE https://open.feishu.cn/open-apis/im/v1/pins/:message_id` | `server-docs/im-v1/pin/delete` |
| 查群内置顶 | `GET https://open.feishu.cn/open-apis/im/v1/pins?chat_id=…` | `server-docs/im-v1/pin/list` |
| 概述 | 字段说明（无数量上限口径） | `uAjLw4CM/ukTMukTMukTM/reference/im-v1/pin/pin-overview` |

- **权限（scope）**：置顶与取消**任一项即可**调用 ——
  `im:message`（获取与发送单聊、群组消息）· **`im:message.pins:write_only`**（添加、取消 Pin 消息）·
  `im:message:send_as_bot`（以应用的身份发消息）。查列表要 `im:message.pins:read` / `im:message:readonly` / `im:message`。
  ⇒ 本实现只用 **置顶 + 取消**，对应最小权限是 `im:message.pins:write_only`（现网若已有 `im:message` 也够）。
- **前提**：应用要开**机器人能力**；**机器人必须在那个群里**（否则 230002 / 230045）。
- **使用限制**：同一条消息的 Pin / Unpin 均 ≤ **5 QPS**；操作者不可见的消息无法 Pin。
- **重复 Pin**：消息已被 Pin 时，接口**返回该 Pin 的操作信息**（即幂等，不报错）。
- **取消一条没被 Pin（或已撤回）的消息**：**返回成功**（`msg: success`）⇒ 重试取消是安全的。
- ⚠️ **数量上限**：官方文档**没有**写「一个群最多能置顶几条」。
  `list` 接口的 `page_size` 上限 50 **只是分页大小**，不是条数上限。⇒ **按"没有可依赖的上限"设计**：
  这正是必须做**「先 unpin 上一条，再 pin 新的」**的理由（否则每天一条、越堆越多）。
- **错误码（相关）**：
  - `230046 No Permission to Pin/Unpin messages in the chat` —— 该群设置**仅群主/群管理员可 Pin** ⇒ 机器人身份不够。
  - `230027 Lack of necessary permissions` —— 缺权限 / 未授权。
  - `230047` —— 同一条消息 Pin/Unpin 触发限流。
  - `230002` 机器人不在群 · `230045` 群不存在 · `230011` 消息已撤回 · `230050` 消息对操作者不可见。
  ⇒ 这些**全都是"置顶失败但不该影响推送"**的现实理由（业务口径上置顶只是增强）。
- **SDK 口径（本仓 `@larksuiteoapi/node-sdk@1.74.0`，已核 typings）**：
  `client.im.pin.create({ data: { message_id } })` → `{ code, msg, data: { pin } }`；
  `client.im.pin.delete({ path: { message_id } })` → `{ code, msg, data: {} }`；
  `client.im.pin.list({ params: { chat_id, … } })`。本实现只用前两个（不引 `im:message.pins:read`）。

---

## 三、实现

- **新增** `server/src/services/larkMessagePinService.js`：只干一件事 —— 维护「群里我们置顶的是哪一条」，
  保证**最多一条**。`pinLatest({ messageId, chatId, day })` **永不抛**，返回 `{ pinned, reason, previousMessageId }`。
  顺序：**先 `delete` 上一条 → 成功后才 `create` 新的**。
- **本地状态**：与按天认领记录**同一个 store、同一个目录** `server/data/pending_deal_push`，
  记录 id = `pending_deal_push_pin_state`，字段 `pinned_message_id` / `chat_id` / `day` / `pinned_at`。
- **改** `server/src/services/pendingDealPushService.js`：消息发出并拿到 `message_id` 之后调上面这个服务；
  `pin` 的一切结果只进日志与返回值，**不影响** `pushedOrderCount` / `messageId` / 按天认领落盘。
- **改** `server/src/config/pendingDealPush.js`：新增显式布尔 `PENDING_DEAL_PUSH_PIN_ENABLED`（默认 **false**）。
- **改** `.env.example`：同步新变量 + 打开时要配哪些。
- 🔴 **不碰** `app.js`（pin 配置经 `settings` 流进服务，定时器那行一个字都不用改）⇒ 与正在改 `app.js` 删战报的代理**零交集**。

---

## 四、验收标准（**动手前先写死**）

### A. 配置
- A1 `PENDING_DEAL_PUSH_PIN_ENABLED` 是**显式布尔**：没设 → 默认 `false`；设成空串 → `false`（关，不回退默认）；`1/true/yes/on` → 开；认不出来的值 → **启动即抛错**。
- A2 配置默认对象**只多一个键** `pinEnabled:false`，既有 6 个键与取值一个都不变。
- A3 `.env.example` 有该项，并写清「打开推送时要同时配哪几个变量」。

### B. 推送本身（回归，必须一字不变）
- B1 发送、文案、按天认领、候选筛选、深链解析：行为与今天完全一致。
- B2 `pinEnabled=false` → **一次 pin/unpin 远端调用都不发**。
- B3 群 id 为空 / 总开关关 / 没有候选单 → 与今天完全一致（`no_chat` / `disabled` / `no_pending_order`）。

### C. 置顶（新能力）
- C1 消息发出且拿到 `message_id` → 调 `client.im.pin.create({ data: { message_id } })`。
- C2 本地状态里有"上一条我们置顶的消息" → **先** `client.im.pin.delete({ path: { message_id: 旧 } })`，**且顺序在 create 之前**。
- C3 首次（状态里没有旧 id）→ 只 `create`，**不调** `delete`。
- C4 `create` 成功后把新 `message_id` 落本地状态（`pinned_message_id`）。
- C5 `delete` **失败**（code≠0 或抛异常）→ 记 warn `sales.pending_deal_push.pin.unpin_failed`，
  **本次不置顶新的**（宁可旧的那条还挂着，也绝不让置顶堆积），状态**保留旧 id**，**推送本身算成功**。
- C6 `create` 失败 → 记 warn `sales.pending_deal_push.pin.failed`（带 code/msg），**不抛、不重试**，
  `sendDailyPush` 仍返回 `pushedOrderCount>0`。
- C7 client 没有 `im.pin` → 记 warn，不抛，推送照常。
- C8 状态读写失败（store 抛）→ 记 warn，不抛；读状态失败时**宁可本次不置顶**（不知道旧的哪条 = 盲目 pin 会堆积）。
- C9 `sendDailyPush` 返回值新增 `pinned` / `pinReason`，**既有字段语义不变**。
- C10 同一天第二次调用：既不发送、也不置顶（按天认领优先）。
- C11 业务错误码（如 `230046` 仅群主/管理员可置顶）走 C6 的 warn，不重试、不影响推送。

### D. 日志（可查，且不带中文）
- D1 成功：`sales.pending_deal_push.pin.succeeded { day, message_id }`；取消旧的：`…pin.unpinned { day, message_id }`。
- D2 失败：`…pin.unpin_failed` / `…pin.failed` / `…pin.client_missing` / `…pin.state_read_failed` / `…pin.state_write_failed`。
- D3 每次发送原有那条 `sales.pending_deal_push.sent` **补上** `pinned` / `pin_reason`。

### E. 边界与纪律
- E1 不碰 `app.js` / 战报相关文件 / 私聊链路 / 销售·采购·库存·入账业务口径。
- E2 **既有断言不放宽**（唯一改动：默认配置 `deepEqual` 里**加** `pinEnabled:false`，仍是严格全等）。
- E3 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（在独立 worktree 跑，不在主工作区）。
- E4 不部署、不写生产表、不改线上 `.env`、**不在真机试置顶**（用假 client 断言）。

---

## 五、打开时需要的环境变量（给 Lead）

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `PENDING_DEAL_PUSH_ENABLED` | `true` | 起定时器（默认 false，线上现状就是没开） |
| `PENDING_DEAL_PUSH_CHAT_ID` | **采购群的 `oc_…`**（= 线上 `PURCHASE_CHAT_ID` 的同一个值） | 🔴 **必须显式配**：这条推送**没有** `PURCHASE_CHAT_ID` 回落，留空 = 记 `sales.pending_deal_push.chat_missing`、一条都不发 |
| `PENDING_DEAL_PUSH_PIN_ENABLED` | `true` | 发出后把那条消息置顶（默认 false） |
| `PENDING_DEAL_PUSH_HOUR` | `9`（默认，可不配） | 每天 9 点（北京时间） |
| `PENDING_DEAL_PUSH_INTERVAL_MS` | `600000`（默认，可不配） | 10 分钟一 tick，按天认领 |

⚠️ 飞书侧前置：应用需有 `im:message.pins:write_only`（或已有的 `im:message`）权限；
**机器人已在该采购群**；该群**不能设置成"仅群主/群管理员可 Pin"**（否则 230046）。

---

## 六、逐条对照（改完之后**实际**是什么样）

证据统一取自：`server/test/pendingDealPushPin.test.js`（新，假 client，**不打真机**）、
`server/test/pendingDealPush.test.js`（既有回归）、真实日志行（跑用例时打出来的）。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| A1 显式布尔、默认 false、空串=关、认不出抛错 | ✅ | 用例「置顶开关是显式布尔…」（`PIN=true/1/空/false/钉住` 五种取值） |
| A2 默认配置只多一个键，其余一字不变 | ✅ | 用例「配置默认值…」仍是 `assert.deepEqual` **严格全等**（只加了 `pinEnabled:false`） |
| A3 `.env.example` 同步 | ✅ | `.env.example` 新增 10 行（含"为什么默认关 / 打开时的行为 / 失败不影响推送"） |
| B1 推送行为一字不变 | ✅ | 既有 14 条用例**全部逐字未改**通过（唯一改动是默认配置那一个键） |
| B2 置顶关着 → 零 pin 调用 | ✅ | 用例「置顶关着（默认）」断言 `calls === ['message.create']`、`pinReason='pin_disabled'` |
| B3 无候选单 / 未配群 → 与今天一致 | ✅ | 用例「没有候选单…」「没配群 id…」断言 `calls` 为空、`reason` 不变 |
| C1 发出后调 `im.pin.create` | ✅ | 用例「首次置顶…」：`calls = ['message.create','pin.create']` |
| C2 **先 unpin 上一条、再 pin 新的**（顺序） | ✅ | 用例「第二天…」：`['message.create','pin.delete','pin.create']` 顺序断言 |
| C3 首次只 create、不 delete | ✅ | 用例「首次置顶…」`calls[1].payload = { data: { message_id: 'om_day1' } }` |
| C4 pin 成功后落本地状态 | ✅ | `pending_deal_push_pin_state.json` 的 `pinned_message_id / chat_id / day` 逐字断言 |
| C5 unpin 失败 → 不 pin 新的、状态保留、推送仍成功 | ✅ | 用例「上一条 unpin 失败（230046）…」：`pushedOrderCount=1`、`pinReason='previous_unpin_failed'`、状态仍 `om_day1` |
| C6 pin 失败 → 只 warn、不抛、不重试 | ✅ | 用例「pin 抛异常…」「pin 返回业务错误码（230027）…」（`pin.create` 只被调 1 次） |
| C7 client 没有 `im.pin` | ✅ | 用例「client 没有 im.pin…」：`pinReason='client_missing'`、推送照常 |
| C8 状态读写失败 | ✅ | 用例「状态读不出来…」（`state_unavailable`）「状态写不进去…」（`pinned=true` 仍成立） |
| C9 返回值新增 `pinned`/`pinReason`，既有字段不变 | ✅ | 既有用例断言 `pushedOrderCount/messageId/reason/missingLinkCount` 全部通过 |
| C10 同一天第二次：不发送也不置顶 | ✅ | 用例「上一条 unpin 失败…」末尾断言 `reason='already_ran_today'`；既有「按天认领」用例通过 |
| C11 业务错误码 → warn、不重试 | ✅ | create 路径测 `230027`、delete 路径测 `230046`（两者共用 `code!==0 → 失败` 同一分支） |
| D1/D2 日志事件齐全 | ✅ | 实跑输出里逐条可见（见下方日志样例），字段不含中文 |
| D3 `…push.sent` 补 `pinned`/`pin_reason` | ✅ | `"event":"sales.pending_deal_push.sent",…,"pinned":false,"pin_reason":"pin_failed"` |
| E1 不碰 `app.js` / 战报 / 私聊 / 口径 | ✅ | `git diff origin/main -- server/src/app.js` **为空**；改动仅 7 个文件 |
| E2 既有断言不放宽 | ✅ | 既有文件只有 1 处改动（默认配置 deepEqual **加**一个键），仍是严格全等 |
| E3 全量连跑 2 次 fail=0 | ✅ | 见第七节 |
| E4 未部署 / 未写生产表 / 未改线上 .env / 未真机试置顶 | ✅ | 全程假 client；无任何 `deploy_*` / `pm2` / 生产表调用 |

### 实跑出来的日志（节选，逐字）

```json
{"event":"sales.pending_deal_push.pin.succeeded","day":"2026-10-07","message_id":"om_day2","previous_message_id":"om_day1"}
{"event":"sales.pending_deal_push.pin.unpinned","day":"2026-10-07","message_id":"om_day1"}
{"event":"sales.pending_deal_push.pin.unpin_failed","day":"2026-10-07","message_id":"om_day1","error":"No Permission to Pin/Unpin messages in the chat (Code: 230046)","hint":"上一条取消置顶失败 → 本次不置顶新的（避免置顶堆积），状态保留，明天再试；推送本身不受影响"}
{"event":"sales.pending_deal_push.pin.failed","day":"2026-10-06","message_id":"om_day1","error":"Lack of necessary permissions (Code: 230027)","hint":"置顶失败不影响推送本身（消息已发出）；不重试，明天照常推"}
{"event":"sales.pending_deal_push.pin.client_missing","day":"2026-10-06","message_id":"om_day1","hint":"飞书 client 没有 im.pin（create/delete），本次不置顶；推送照常"}
{"event":"sales.pending_deal_push.pin.state_write_failed","day":"2026-10-06","update_error":"disk full","create_error":"disk full","hint":"置顶已成功但本地状态没记上：下一次可能不会取消这一条（置顶会多一条），需要人工看一眼"}
{"event":"sales.pending_deal_push.sent","day":"2026-10-06","order_count":1,"order_ids":["sale_a"],"message_id":"om_day1","pinned":false,"pin_reason":"pin_failed"}
```

⭐ 注意 `pin.succeeded` 里的 `previous_message_id`：它就是"**这一次先取消了哪一条**"——
置顶到底堆没堆，grep 这一条即可。

---

## 七、CI 与全量测试的实际输出

本地（**独立 worktree** `.local/worktrees/pending-deal-pin`，HEAD = 提交 `2ba75aa`+本分支改动）：

```
=== FULL RUN 1 ===   ℹ tests 1081  ℹ pass 1081  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
=== FULL RUN 2 ===   ℹ tests 1081  ℹ pass 1081  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
```

PR #229 的 `gh pr checks`（`mergeStateStatus: CLEAN`）：

```
Analyze (javascript-typescript)   pass   55s
CodeQL                            pass    3s
test                              pass   47s
```

真启动面（不改 `app.js`，但要确认新 require 没破坏加载顺序）：`node -e "require('./src/app.js')"` → `app.js loaded OK`；
再用**真配置 + 真 service** 构造过一次：`pinEnabled:true` 解析正确、`pin service wired: true`、
`store.dir` 与按天认领同一个目录、`client` 复用同一个实例（不新建连接）。

---

## 八、不确定处（如实列出）

1. ⚠️ **官方没有写"一个群最多能置顶几条"** —— 我把 `create/delete/list` 三篇 + 概述都 curl 过了，
   只有"同一条消息 ≤5 QPS"和 `list.page_size ≤50`（那是分页）。所以"不会堆积"是**靠我们自己
   unpin 上一条**保证的，不是靠平台上限；万一 unpin 连续失败，宁可**不置顶新的**（C5），
   也不会出现"机器人一天钉一条、越钉越多"。
2. ⚠️ **机器人是否真的能在这个群里 Pin**：与"群是否设成仅群主/管理员可 Pin"有关（230046），
   **只有真机能验**；本次按纪律**没有在真机试**。若打开后日志出现 `pin.failed` / `pin.unpin_failed`，
   先看错误码：230046 = 群设置，230027 = 应用缺 `im:message.pins:write_only` 权限。
3. ⚠️ **`PENDING_DEAL_PUSH_CHAT_ID` 没有 `PURCHASE_CHAT_ID` 回落**（见第一节末与第五节的表）——
   这是**既有事实**，不是本次引入的；我**没有**擅自加回落（那会改目标群口径）。要加的话是一行配置的事，
   需要业务负责人点头。
4. ⚠️ **推送文案仍然只有 单号 + 待收金额（+深链）**：没有货号 / 成交额 / 售出日期 /
   未付 vs 预付标注 / 未交付数量。她问的"够不够"里，**筛选口径够（预付+未付都覆盖）**，
   但**信息量不够**。扩字段=改口径，未做，等她点头。
5. ⚠️ 「7 天窗口」是老口径（只在最近 7 个上海自然日内找单），**超过 7 天仍没成交的单不会进推送**。
   她这次没提窗口，我没动。

