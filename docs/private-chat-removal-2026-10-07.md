> ⚠️ **这一份是 ⓑ 版（留开关、"可显式恢复"），已被取代 —— 只作历史记录，不要按它实施。**
> 业务负责人 2026-10-07 随后拍板走 ⓐ：「**干净、彻底** …… **以后代码里【一行私聊都没有】**」。
> ⇒ `PRIVATE_CHAT_INTAKE_ENABLED` / `PRIVATE_CHAT_SEND_ENABLED`（本文第 6 节那两个"恢复口子"）
> 与测试 helper `test/helpers/enablePrivateChatForTests.js` **已整体删除**；
> 历史用例也已从"私聊入口 + 打开开关"**迁到群聊真入口**。
> **现行口径与验收标准见 [private-chat-removal-hard-2026-10-07.md](private-chat-removal-hard-2026-10-07.md)**，
> 决策理由见 [private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)。

# 🔴 私聊链路移除 —— 验收标准与实现记录（2026-10-07）

> 业务负责人口径（逐字）：「**以后私聊这条链路我们就没有了**」。
> 承接件：[private-chat-excision-todo.md](private-chat-excision-todo.md)（2026-10-06 的切除盘清）。
> 那份做的是「把私聊专属的东西切出来」，这一份做的是「**把入口关掉**」。

## 一、⭐ 先写「删完应该是什么样」（验收标准）

> 纪律：**先写预期 → 再跑 → 逐条对照**（`AGENTS.md` 协作纪律第 2 条）。

### A. 私聊入口（`chat_type === 'p2p'`）

| # | 预期 | 判据 |
| --- | --- | --- |
| A1 | 默认配置下，私聊**文字**消息 → **不建任务、不进 AI、不写任何表** | `store.create` 0 次、`recognizer.parseSalesText` 0 次、`gateway.create/update` 0 次 |
| A2 | 默认配置下，私聊消息 → 若 notice 开（**默认开**）**恰好回一句**固定文案；notice 关 → **一条消息都不发** | `im.message.create` 次数 = 1（notice 开）/ 0（notice 关），文案 = `PRIVATE_CHAT_DISABLED_NOTICE_TEXT` |
| A3 | 默认配置下，私聊**非文字/空文字** → 与 A1/A2 **同一档**（不再有「机器人当前只接收销售文字」/「没有读到销售文字」那两条私聊专属提示） | 两条旧文案在默认档下**永不出现** |
| A4 | `PRIVATE_CHAT_INTAKE_ENABLED=true` 时，私聊行为与**改动前逐字不变** | 建任务、进 AI、别名文案逐字相同；`reason` = `not_sales_candidate` / `unsupported_message_type` / `empty_sales_text` 等 |

### B. 群聊（回归 —— **逐字不变**）

| # | 预期 |
| --- | --- |
| B1 | 话题里（`thread_id` 有值）→ 一律处理、**不要求 @**；主群（`thread_id` 为空）→ 按 `resolveMainChatAdmission` 三条判据 |
| B2 | 群销售确认卡片 → `reply_in_thread: true` 进那个话题；群任务三条出口 payload 不变 |
| B3 | 群聊「已收到」仍然只有表情、**不回文字**；私聊（开关打开时）仍是表情 + 一句文字 |
| B4 | 群采购链路（采购申请 / 采购退货 / 到货核对）**一个字都不动** |

### C. 发送端口（「无群上下文」时不许静默发私聊）

| # | 预期 |
| --- | --- |
| C1 | `PRIVATE_CHAT_SEND_ENABLED=false`（默认）→ 对**非群任务**：`sendTaskText`/`sendTaskCard` 及 `SampleReplacementService` 的两个缺省出口**不发消息**，记 `lark.private_chat.send_skipped`，返 `null` |
| C2 | `=true` → 与改动前**逐字相同**（`sendText(open_id)` / `sendCard(open_id)`） |
| C3 | `SampleReplacementService.notifySampleReplacements`：**群销售 → 卡片回到那个话题**（`reply_in_thread`）；**无群上下文（工作台触发）→ 按开关不发私聊 + 记 `lark.private_chat.send_skipped`** ⚠️ 这是**有意的行为变化** |
| C4 | `PurchaseWebhookService.sendCard`（全仓无调用方）**已删除** |

### D. 配置形态

| # | 预期 |
| --- | --- |
| D1 | `config/privateChat.js` 是 **CommonJS**（`require` / `module.exports`），能被 `require` 而不抛语法错 |
| D2 | `larkMvpService.js` 里有 `PRIVATE_CHAT` 的 `require`（不再有 `ReferenceError: PRIVATE_CHAT is not defined`） |
| D3 | 取值规则**复用 `config/envValue`** 的显式布尔：**没设 → 默认值；空串 → false（= 关掉）；认不出的值 → 当场抛错** |
| D4 | 默认：`intake=false`（私聊入口关）、`send=false`（不发私聊）、`notice=true`（回一句文案） |
| D5 | ⭐ **每次调用时读 env**（惰性），**不依赖 import/require 顺序**——见第三节的理由 |

### E. 全局门禁

| # | 预期 |
| --- | --- |
| E1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |
| E2 | **真启动一次** `GET /health` → 200（`app.js` 顶部 require 顺序那个坑只有真启动看得见） |
| E3 | CI `server tests`（job `test`）**CLEAN** ＋ CodeQL 通过 |

## 二、实现（三条缺陷各自怎么修的）

> 全部在独立 worktree（`/private/tmp/nop2p.nTr5em`，分支 `feat/remove-private-chat`）里做，
> **单写入者**。

### 缺陷 ①：`PRIVATE_CHAT` 没有 require → `ReferenceError`

- **现象**：`larkMvpService.js` 在 `acceptMessage` / `sendTaskText` / `sendTaskCard` 里用了
  `PRIVATE_CHAT.*`，但**整个文件没有它的 require**。全量测试一跑就是
  `ReferenceError: PRIVATE_CHAT is not defined`（`acceptMessage:722`、`sendTaskCard:546`）。
- **修法**：在 `config/groupAdmission` 那一组 require 下面补
  `const { ... } = require('../config/privateChat');`（**CommonJS**，与仓库其它 config 一致）。

### 缺陷 ②：`config/privateChat.js` 写成 ESM → 根本 require 不了

- **现象**：`import { readFlag, readString } from './envValue.js';` + `export const ...`。
  本仓库 `server/package.json` **没有 `"type": "module"`**，全部是 CommonJS
  （73 个测试文件全是 `require`）⇒ 这个文件一被 require 就是语法错。
- **修法**：改成 `const { readFlag, readString } = require('./envValue');` +
  `module.exports = { ... }`，取值规则**直接复用 `config/envValue`**
  （空串 = false、认不出的值抛错），**不自己再写一套**。

### 缺陷 ③：阶段①剩下两处（见下）

## 三、⭐ `PRIVATE_CHAT` 的形态：为什么改成「每次调用时读 env」

- **父代理的半成品**：模块级 `Object.freeze({ intakeEnabled: readFlag(...) })` ——
  **加载那一刻**就把值定死了。
- **为什么不能用它**：那批历史用例是**拿私聊当入口**测下游的，要它们继续跑就得让
  `PRIVATE_CHAT_INTAKE_ENABLED=true` **在被 require 之前**生效 ——
  也就是**依赖 require 顺序**。ESM/CJS 的求值顺序是隐式的、重排一次就静默失效，
  失败方式还是「用例莫名其妙开始测另一个分支」。
- **改成什么**：`config/privateChat.js` 导出**解析函数**，服务在**每次调用时**读，
  与仓库既有三个开关（`config/groupAdmission.js` 的 `resolveMainChatRequireMention`、
  `config/groupPurchase.js` 的三个 `resolve*`、`config/purchaseArrivalIntake.js` 的
  `isPurchaseArrivalIntakeEnabled`）**完全同形**：
  ```js
  isPrivateChatIntakeEnabled(env = process.env)
  isPrivateChatSendEnabled(env = process.env)
  resolvePrivateChatNotice(env = process.env)   // { enabled, text }
  ```
- **收益**：① 与仓库既有「配置先行」的写法一致；② 消除 require 顺序依赖；
  ③ `env` 可注入 → 单测能直接传 env，不污染全局；④ 运行时改 env 立即生效（运维友好）。
- **代价**：每条消息多几次 `String.trim().toLowerCase()` —— 可以忽略。

### 测试怎么救（helper 还是惰性读？）

- **两个都用了，但主次分明**：
  - **惰性读**是**技术上**的解法（去掉顺序依赖）；
  - **helper 仍然是显式的唯一入口**：`test/helpers/enablePrivateChatForTests.js`
    把「哪些用例是靠私聊入口测下游的」这件事**写在一个文件里**，
    而不是让每个用例各自抄一行 `process.env.X = 'true'`。
    它是 **CommonJS**，被 `require` 时立刻生效（也导出同名函数，便于用例中途再开）。
    因为配置是惰性读的，**它放在文件顶部只是"读起来清楚"，不是"必须第一个"**。
- **历史用例的定位**：它们转为回归「**开关打开时行为逐字不变**」——
  覆盖没丢，而且现在**同时钉住了两个方向**（默认关 = 不处理；显式开 = 老行为）。
- **另加**：钉「默认关 = 私聊不处理」的新用例（见第五节）。

## 四、阶段①剩下两处怎么切的

### ① `SampleReplacementService`（补样品提醒）

- **改动前的形态**：`notifySampleReplacements` 直接
  `this.sendCard(operatorOpenId, ...)` / `this.sendText(operatorOpenId, ...)` ——
  **硬编码私聊收件人**，绕过了这个 service 已经有的两个「任务感知」出口。
- **改成**：`notifySampleReplacements(deliveryResult, operatorOpenId, { handledDetailIds, channelTask })`
  - **加渠道感知入参** `channelTask` = **触发这次交付的那条销售任务**（群销售时才有）；
  - 发送改走**已有的** `sendCardToTask` / `sendTextToTask`，`sendTarget = channelTask || 补样品任务`；
  - **群销售 → 卡片回复进那个话题**（`reply_in_thread: true`）；
  - **缺省出口加开关守卫**：非群任务且 `PRIVATE_CHAT_SEND_ENABLED=false` →
    **不发、记 `lark.private_chat.send_skipped`（`reason: no_group_context`）、返 `null`**；
  - 端口返 `null`（= 明确说"这条不发"）时**不写 `notice_sent`**：
    没发出去就不算发过，将来有了渠道还能再发一次。
- ⚠️ **为什么把「那条**销售**任务」交给出口、而不是补样品任务**（实现时踩到的坑）：
  出口会顺手记「话题 ↔ 销售」的**本地路由映射**，映射的 key 是**她那句话的 `message_id`**、
  值里带**那笔销售的 `record_id`**；把补样品任务交出去会把那条映射的
  `sales_entry_record_id` 冲成空 → 之后那个话题里的消息就定位不回那笔销售了。
  ⚠️ 同理**不复制** channel 字段到补样品任务上（会带来同一类覆盖）。
- ⚠️ **`operatorOpenId` 不能换成 `channelTask.sender_open_id`**：它是"**本次操作的人**"
  （工作台那条路根本没有 channelTask），二者在极端情况下可能不是同一个人。
  私聊分支的收件人仍然是补样品任务上的 `sender_open_id`（= `operatorOpenId`），与改动前一致。
- ⚠️ **有意的行为变化**：**工作台触发**的那条路（`routes/workbench.js` 自己 new 的
  `SampleReplacementService`，**没有群上下文**）→ 默认**不再往私聊发补样品卡片**，
  只记一条 skip 日志。理由：私聊已经没有了，"静默发私聊"正是这次要切掉的东西。
  要恢复：`PRIVATE_CHAT_SEND_ENABLED=true`。

### ② `PurchaseWebhookService.sendCard`（死代码）

- **核实**：全仓 `grep` → 定义处 `:1156` 之外**零调用方**
  （只有 `:1282` 一行**注释**提到"要回滚成确认卡片就换回它"）。
  采购申请那条路现在走**群**（`sendText(chatId, …, 'chat_id')` / `sendPurchaseGroupNotice`）。
- **处置**：**整段删除**，并在原处留一段注释说明"为什么删 / 要用回来怎么办"。
  留着它的成本是"下个读代码的人以为还有一条私聊链路"。

### ③ 顺带清掉的孤儿（删 `sendTodaySales` 之后失去调用方的）

| 位置 | 是什么 | 处置 |
| --- | --- | --- |
| `larkMvpService.shanghaiDay` | 上海自然日算法，只有 `sendTodaySales` 用 | 删（工作台那侧的算法在 `v1WorkbenchService` 里，不受影响） |
| `larkMvpService` 的 `createWorkbenchService` require | 同上 | 删 |
| `larkMvpService` 的 `todaySalesCard` require | 同上 | 删 |
| `utils/larkCards.todaySalesCard` | 「今日销售」卡片（只有私聊菜单点得到） | 删（定义 + 导出） |

> ⚠️ 顺带发现但**没动**：`purchaseWebhookService.js` 的 `person` 解构导入**在 `main` 上就已经没有调用方**
> —— 那是既有问题，不属于本次改动面，留给单独一次清理。

## 五、新增测试（钉住新行为）

**新文件 `server/test/privateChatRemoval.test.js`（19 条）—— 它刻意 `不` require 测试 helper，
就是"生产默认档"的证据。**

| 用例 | 钉住什么 |
| --- | --- |
| 配置：没设 → 默认（入口关 / 不发私聊 / 回一句文案） | D4 |
| 配置：**空串 = 关掉**（不回退默认） | D3 |
| 配置：认得出的写法都认；**认不出的值当场抛错** | D3 |
| 配置：notice 文案可配；设成空串 → 空串 | D3 |
| A1+A2 私聊文字（默认）→ 不建任务 / 不进 AI / 不写表 / 不加表情；**只回那一句 notice** | A1 + A2 |
| A3 私聊**非文字 / 空文字**（默认）→ 与文字同一档；**旧的两条私聊提示不再出现** | A3 |
| A2 notice 关掉 → **一条消息都不发**；文案留空 → 同样不发 | A2 |
| A 私聊被挡下 → 记 `lark.private_chat.disabled`（不是静默失效） | A1 |
| C1 `send=false` → 非群任务**不发 + 记 skip + 返 null** | C1 |
| C2 `send=true` → 两者与改动前逐字相同 | C2 |
| C3 群销售的补样品提醒 → `reply_in_thread` 进**那条销售话题**，且**零主动私聊** | C3 |
| C3 私聊触发的补样品提醒 → 不发 + skip；**不记 `notice_sent`** | C3 |
| C3 ⭐ **工作台那条路**（`routes/workbench.js` 自己 new 的 service）→ 不发 + `reason: no_group_context` | C3 |
| C4 `PurchaseWebhookService.prototype.sendCard === undefined` | C4 |
| `sendTodaySales` / `handleBotMenu` / `todaySalesCard` 都不在了 | D/② |
| 路由不再注册 `application.bot.menu_v6`，但消息入口还在 | ② |
| B1 话题里不 @ 也处理（默认档）；任务带群上下文；采购那条路没被碰 | B1 |
| B2/B3 群任务的两条出口 payload 不变（都回那条消息的话题） | B2 |
| B1 主群准入三条判据不受私聊开关影响 | B1 |

**历史用例（10 个文件）在顶部 `require('./helpers/enablePrivateChatForTests')`** →
回归「**开关打开时行为与改动前逐字不变**」（覆盖没丢）：
`larkMvpService` / `messageGate` / `salesGroupThread` / `salesThreadProgress` /
`groupSalesAutodetect` / `afterSalesGroupThread` / `larkEvents` / `salesMessageLink` /
`groupThreadReplyRouting` / `sampleReplacementRecovery`。
⚠️ 只删了一条：`larkMvpService.test.js` 的「today sales menu returns only confirmed detail rows…」
—— 它测的 `sendTodaySales` 已经不存在了，留着只能靠"删掉入口再断言旧行为"维持。

## 六、怎么临时恢复私聊（运维口子）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PRIVATE_CHAT_INTAKE_ENABLED` | `false` | `true` = 重新接收私聊消息（建任务、跑链路） |
| `PRIVATE_CHAT_SEND_ENABLED` | `false` | `true` = 允许主动往私聊发消息（卡片 / 文字） |
| `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` | `true` | 私聊被挡下时是否回一句固定文案 |
| `PRIVATE_CHAT_DISABLED_NOTICE_TEXT` | `这个机器人现在只在群里工作，请到群里说～` | 上面那句文案 |

⚠️ 三个布尔都是**显式布尔**：**留空 = 关掉**（对 `NOTICE_ENABLED` 而言 = 不回文案）；
**认不出的值当场抛错**，不猜。**不要**写 `process.env.X || 默认值`。
