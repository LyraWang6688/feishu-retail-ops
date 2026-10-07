# 🔴 私聊链路移除 · ⓐ 彻底版（代码里一行私聊都不留）—— 验收标准

> 业务负责人 2026-10-07 拍板（逐字）：
> 「把那些测试全部迁到"**群聊入口**"（**干净、彻底**）：
>  约 20+ 条测试要改输入方式（私聊 → 群里发消息 + 话题）。
>  改完 CI 才能绿；工作量大，但**以后代码里【一行私聊都没有】**」
>
> 决定落档：[private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)。
> 上一版（ⓑ，留开关 + 测试 helper）的实现记录：[private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md)。
> 本次在它的 tip 上另开分支 `feat/remove-private-chat-hard`，**把 ⓑ 的开关与 helper 全删掉**。

## 一、⭐ 先写「删完应该是什么样」（验收标准）

> 纪律：**先写预期 → 再跑 → 逐条对照**（`AGENTS.md` 协作纪律第 2 条）。

### A. 私聊**入口**：代码里一行私聊链路都没有

| # | 预期 | 判据 |
| --- | --- | --- |
| A1 | 私聊（`chat_type === 'p2p'`）文字消息 → **只记一条日志**，**不建任务、不进 AI、不写任何表、不加表情** | `store.create` 0 次、`recognizer.parseSalesText` 0 次、`gateway.create/update` 0 次、`messageReaction.create` 0 次 |
| A2 | 私聊被挡下时**只回一句**固定文案（对方是人，不能让她以为机器人坏了）；文案关掉 / 留空 → **一条都不发** | `im.message.create` 次数 = 1（默认）/ 0（关掉、留空） |
| A3 | 私聊**非文字 / 空文字** → 与文字**同一档**；旧的两条私聊专属提示（「机器人当前只接收销售文字」/「没有读到销售文字」）**在代码里已删除** | 两条旧文案全仓 `grep` 零命中（测试文件里的"已删除"注释除外） |
| A4 | `PRIVATE_CHAT_INTAKE_ENABLED` **这个变量不存在了**：`config/privateChat.js` 不再导出 `isPrivateChatIntakeEnabled`；全仓无读取点 | `grep PRIVATE_CHAT_INTAKE_ENABLED src/` 零命中 |
| A5 | `acceptMessage` 里 `p2p` 只是「不是群 → 记日志 → 返回」，**没有任何 if/else 分档** | 人读代码：p2p 分支 ≤ 15 行，无 `isXxxEnabled()` |

### B. 私聊**发送出口**：`chat_type !== 'group'` 的发送分支**删掉**

| # | 预期 | 判据 |
| --- | --- | --- |
| B1 | `sendTaskText` / `sendTaskCard` 对**非群任务**：**不发**、记一条日志、返 `null` —— 不再有"发到 `sender_open_id`"的代码 | `im.message.create` 0 次；`im.message.reply` 0 次；日志命中 |
| B2 | 群任务（`chat_type === 'group'`）走**话题那条路**，payload **逐字不变**（`reply_in_thread: true` + 同 `message_id`） | `replies[i].path.message_id === task.message_id`、`data.reply_in_thread === true` |
| B3 | `PRIVATE_CHAT_SEND_ENABLED` **这个变量不存在了** | `grep PRIVATE_CHAT_SEND_ENABLED src/` 零命中 |
| B4 | `SampleReplacementService` 的两个**缺省**出口（工作台自己 new 的实例）同样**不发私聊** | `im.message.create` 0 次 + 日志 |

### C. 群聊链路（回归 —— **逐字不变**）

| # | 预期 |
| --- | --- |
| C1 | **先判 `thread_id`**：话题里有值 → **一律处理、不要求 @**；主群（空）→ 三条准入判据（@ / 像销售 / 带批次号） |
| C2 | 群销售：主群新开一笔 → 在她那条消息下**开话题 + 回卡片**（`reply_in_thread: true`）；话题里后续消息 → **绑定到同一笔**、不新建 |
| C3 | 群聊「已收到」仍然**只有表情、不回文字** |
| C4 | 群采购链路（采购申请 / 采购退货 / 到货核对）**一个字都不动** |
| C5 | 卡片出口（确认卡片 / 售后卡片 / 补样品卡片）**逐字不变** |

### D. 测试：**迁到真入口**，不许用"造任务"绕过

| # | 预期 |
| --- | --- |
| D1 | `test/helpers/enablePrivateChatForTests.js` **已删除**；全仓无 `require('./helpers/enablePrivateChatForTests')` |
| D2 | 历史用例的输入改成 **群消息（主群 @ 或话题里）**，走 `larkMvpService.acceptMessage` 的**群分支** → `SalesGroupFlowService` 真分派 |
| D3 | 断言改成「**回复回到那个话题**」（`reply_in_thread: true` / 同 `thread_id`） |
| D4 | **没有**任何用例再用 `chat_type: 'p2p'` 当**输入**（除"私聊已移除"那组） |
| D5 | 若有个别用例必须直接造任务 → 在测试里**写明原因** |

### E. 全局门禁

| # | 预期 |
| --- | --- |
| E1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |
| E2 | **真启动一次** `GET /health` → 200 |
| E3 | CI：`server tests`（job `test`）**CLEAN** ＋ CodeQL 通过；**不用 `--admin`** |

## 二、开关怎么处理（取舍）

| 变量 | 处置 | 为什么 |
| --- | --- | --- |
| `PRIVATE_CHAT_INTAKE_ENABLED` | 🔴 **删**（代码 + 文档 + `.env.example`） | 它就是 ⓑ 的"可显式恢复"。留着 = 代码里还有私聊入口分支，与"一行私聊都没有"直接冲突 |
| `PRIVATE_CHAT_SEND_ENABLED` | 🔴 **删** | 同上：留着 = "默认不发"的分支还在，等于私聊出口还在 |
| `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` | ✅ **留** | 对方是**人**：机器人一条不回会让人以为坏了。这是**文案层**、不是链路层 |
| `PRIVATE_CHAT_DISABLED_NOTICE_TEXT` | ✅ **留** | 同上；文案要能改而不动代码（配置先行） |

⇒ `config/privateChat.js` 从"四个开关"收敛成"**一句话的开关 + 那句话**"，
**入口与发送两件事上再没有任何配置**。

## 三、测试怎么迁的（逐文件）

> 原则：**走群聊真入口**（`larkMvpService.acceptMessage` 的群分支 → `SalesGroupFlowService`），
> **不再有"打开私聊"的档位**。两条真入口路径：
> · **主群 @ 机器人**（`thread_id` 为空）→ 新开一笔，回复时创建话题；
> · **话题里（`thread_id` 有值）** → 免 @，按本地映射定位到那笔销售。

| 文件 | 原来的输入（私聊） | 现在的输入（群聊） | 断言怎么改 |
| --- | --- | --- | --- |
| `larkMvpService.test.js`（6 条） | `chat_type: 'p2p'` 直接 `acceptMessage` | 新增 `groupEvent()` helper（默认**主群 @ 机器人**）；去重 / 排序 / 富文本 / 图片 / 闸门 / 表情 6 条都改成它 | `result.taskId`→`result.sales.taskId`、`result.type`→`result.sales.type`、`second.reason`→`second.sales.reason`；图片那条：旧文案「请用采购表单」→ `group_unsupported_message_type` + **零回复**；表情那条删掉私聊那半（群聊只表情、不回文字） |
| `larkMvpService.test.js`（下游 5 条） | **直接造任务** + `service.sendText` 桩 | 造任务**不变**（原因见下） | 桩改成**任务感知**出口 `service.sendTaskText` / `service.sendTaskCard`（私聊回落已删） |
| `messageGate.test.js` | `textEvent` = 私聊 | `textEvent` = **主群不 @**（准入第二条判据就是同一把尺子 `isSalesCandidate`） | `not_sales_candidate`→`group_not_sales_text`；`result.taskId`→`result.sales.taskId`；回执桩改 `sendTaskText` |
| `afterSalesGroupThread.test.js`（2 条） | `privateEvent` | **主群 @ 机器人** | 「卡片不带 `reply_in_thread` / 候选不限定某笔」→「卡片**带** `reply_in_thread` / 候选**仍**不限定（主群还没定位到某笔）」；文字问句从 `create`（主动发私聊）→ `reply` + `reply_in_thread: true` |
| `salesThreadProgress.test.js`（1 条） | `privateEvent` | **主群 @ 机器人** | `task.chat_type` `undefined`→`'group'`；`accepted.taskId`→`accepted.sales.taskId`；补 `mode === 'new'` |
| `salesGroupThread.test.js`（3 条） | `privateEvent` | **主群 @ 机器人** | ①「新一笔不绑定已定位销售 + 卡片回话题」②「主群不 @ 日常聊天静默」③「群里只有表情、不回『已收到』文字」 |
| `groupSalesAutodetect.test.js`（2 条） | `privateEvent` | **主群 @ 机器人** ＋ **严格模式下的**话题**消息** | 录单端到端改成群（建单 1 条 / 表情 / 卡片回话题 / 不进采购）；「strict 只管主群」改成「strict 下**话题里仍然免 @**」 |
| `larkEvents.test.js`（1 条） | 私聊非文字回旧提示 | 走**路由处理器** `im.message.receive_v1` 的私聊 image | 改成「不建任务 + 只回一句 notice + 旧提示不再出现 + 同步回 `{}`」 |
| `groupThreadReplyRouting.test.js` | 补样品出口的"私聊逐字不变" | **非群任务** | 原来 `sent[2]/[3]` 的 `create` 断言 → 两个端口返 `null` + `sent.length === 2`（一条都不发） |
| `salesMessageLink.test.js` | "私聊任务不写映射不写表" | `chatType: ''` | `messageId === null` + `creates` 为空（原来断言 `om_private_1`） |
| `sampleReplacementRecovery.test.js`（2 条） | ① 靠 `sendCard` 回落 ② 缺省回落私聊 | ① 注入 `sendCardToTask` ② 改成**缺省出口不发** | ② 的 `direct.length === 1` → `0`（并断言补选本身照旧生效） |
| `privateChatRemoval.test.js` | 501 行、测四个开关 | **重写**成 22 条 | A 入口 / B 发送出口 / C 补样品 / D 群聊回归；新增「开关设成 `true` **没有任何作用**」两条 |
| `test/helpers/enablePrivateChatForTests.js` | 10 个文件在顶部 require | **文件删除**，10 处 require 全删 | — |

### ⚠️ 仍在使用"直接造任务"的用例（**逐条说明原因**）

它们**原本就是造任务**（`store.create(...)` 后直接调 service 的下游方法），不是本次为图省事新加的；
原因是这几条测的是**下游链路**，消息入口那一段已由别的用例覆盖：

| 用例 | 为什么造任务 |
| --- | --- |
| `larkMvpService.test.js` ·「selling a sample sends a per-order size choice card…」 | 直接调 `service.notifySampleReplacements`（补样品业务链路），**不经过消息入口** |
| `larkMvpService.test.js` ·「unsupported text is parsed but does not create a sales entry record」 | 造 `sale` 任务后调 `processSalesTask`（测"认不出意图"这一档） |
| `larkMvpService.test.js` ·「sale final-card patch failure sends a new result card…」 | 造 `ready_to_confirm` 任务后调 `handleCardAction`（测"卡片补发"分支） |
| `larkMvpService.test.js` ·「库存里没有这个尺码时不发确认卡片…」/「缺货之外还有别的问题时…」 | 造 `sale` 任务后调 `processSalesTask`（测"缺货时回哪一句话"） |
| `sampleReplacementRecovery.test.js`（3 条） | 造 `sample_replacement` 任务，测服务自身的刷新 / 端口接线 |

⇒ 这 5+1 条**都把"任务感知的出口"打桩**（`sendTaskText` / `sendTaskCard` / `sendCardToTask`），
**不再依赖已经被删掉的私聊回落**；每一条的桩旁边都写了"为什么在这里打桩"。

## 四、逐条对照（验收标准 → 结果）

### A. 私聊入口

| # | 预期 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 私聊文字 → 不建任务 / 不进 AI / 不写表 / 不加表情 | ✅ | `privateChatRemoval.test.js`「A1+A2 …」 |
| A2 | 私聊只回一句固定文案；关掉 / 留空 → 一条都不发 | ✅ | 同上 + 「A2 notice 关掉…」 |
| A3 | 非文字 / 空文字同一档；旧的两条提示不再出现 | ✅ | 「A3 私聊**非文字 / 空文字**…」；`grep` 全仓只剩注释 |
| A4 | `PRIVATE_CHAT_INTAKE_ENABLED` 不存在、无读取点 | ✅ | `grep src/` 零命中；「A4 ⭐ …**没有任何作用**」 |
| A5 | p2p 分支只有"记日志 + 回一句"，无分档 | ✅ | `larkMvpService.acceptMessage` 里 p2p 段 12 行、无 `isXxxEnabled()` |

### B. 私聊发送出口

| # | 预期 | 结果 | 证据 |
| --- | --- | --- | --- |
| B1 | 非群任务：不发、记日志、返 `null` | ✅ | 「B1 非群任务…」`lark.private_chat.removed` + `stage: send` |
| B2 | 群任务走话题，payload 逐字不变 | ✅ | 「B2 群任务的三条出口 payload **逐字不变**…」 |
| B3 | `PRIVATE_CHAT_SEND_ENABLED` 不存在、无读取点 | ✅ | `grep src/` 零命中；「B3 ⭐ …**没有任何作用**」 |
| B4 | `SampleReplacementService` 缺省出口同样不发 | ✅ | 「C3 ⭐ 工作台那条路…」 |

### C. 群聊链路（回归）

| # | 预期 | 结果 | 证据 |
| --- | --- | --- | --- |
| C1 | **先判 `thread_id`**；主群三条判据 | ✅ | 「D1 ⭐ **先判 `thread_id`**…」+「D1 主群准入的三条判据都在」 |
| C2 | 主群新开一笔 → 开话题 + 回卡片；话题续接 → 绑定同一笔 | ✅ | 「D1 话题里不 @ 也处理…」+ `salesGroupThread.test.js` A/C 组 |
| C3 | 群聊「已收到」只有表情、不回文字 | ✅ | `salesGroupThread.test.js`「B：群里「已收到」只有 OneSecond 表情…」 |
| C4 | 群采购链路一个字不动 | ✅ | 采购那批用例（`larkMvpService.test.js` 群聊①…、`arrivalConversation.test.js`）**逐字未改**，全绿 |
| C5 | 卡片出口逐字不变 | ✅ | 「B2 群任务的三条出口 payload **逐字不变**…」 |

### D. 测试迁移

| # | 预期 | 结果 |
| --- | --- | --- |
| D1 | helper 已删、无引用 | ✅ `grep enablePrivateChatForTests` 零命中（`test/helpers/` 目录已空、已删） |
| D2 | 历史用例走群聊真入口 | ✅ 见第三节逐文件表 |
| D3 | 断言改成"回复回到那个话题" | ✅ 见第三节逐文件表 |
| D4 | 没有用例再拿 `chat_type: 'p2p'` 当**输入**（除"私聊已移除"那组） | ✅ `grep "chat_type: 'p2p'"` 只剩 `privateChatRemoval.test.js` 的 `privateEvent` |
| D5 | 造任务的用例都写明原因 | ✅ 见第三节"仍在使用直接造任务的用例"表 |

### E. 全局门禁

| # | 预期 | 结果 |
| --- | --- | --- |
| E1 | 全量 `node --test --test-concurrency=1` 连跑 2 次 fail=0 | ✅ 在 `e23ab0e` 上两次都是 `tests 897 / pass 897 / fail 0` |
| E2 | 真启动一次 `GET /health` → 200 | ✅ `PORT=39187 node src/app.js` → `HTTP=200`，`{"status":"ok","version":"0.3.0",...}` |
| E3 | CI `server tests` CLEAN ＋ CodeQL | ⏳ 见 PR（提交后补） |

## 五、私聊实测行为（本次实现后的形状）

| 场景 | 行为 |
| --- | --- |
| 私聊发销售文字 | **不建任务、不进 AI、不读表、不写表、不加表情**；只回一句「这个机器人现在只在群里工作，请到群里说～」 |
| 私聊发图片 / 文件 / 空文字 | 与上条**同一档**（不再是「机器人当前只接收销售文字」/「没有读到销售文字」） |
| 私聊完全静默（想要） | `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED=false`（或把文案设成空串）→ **一条都不发** |
| 想恢复私聊 | **没有开关**；代码里也没有那段逻辑，只能从 git 历史取回 |
| 日志 | 每条被挡下的私聊 → `lark.private_chat.removed`（`stage:intake`、`notice_sent`） |
| 没有群上下文的任务要发消息 | 不发 → `lark.private_chat.removed`（`stage:send`、`kind:card|text`） |

## 六、群聊链路未受影响的证据

1. **采购那批用例一个字没改**照样全绿：`larkMvpService.test.js` 的「群聊①…C④…B…」、
   `arrivalConversation.test.js`、`groupThreadReplyRouting.test.js` 的采购三条。
2. **销售群链路的原有用例**（`salesGroupThread.test.js` 的 A/B/C 组、`salesThreadProgress.test.js`
   的话题那批、`afterSalesGroupThread.test.js` 的话题那两条）**断言未改**，只改了私聊那几条。
3. **准入顺序**没动：`acceptMessage` 仍然 `if (message.chat_type === 'group')` 在最前面，
   里面仍然**先读 `thread_id`** 再读 `mentions`；本次只把它后面的 p2p 段改写。
4. 「B2 群任务的三条出口 payload **逐字不变**」直接钉住群任务的 `reply_in_thread` / 同 `message_id`。

## 七、⚠️ 已知的"还没删"（**超出本次 brief 的范围，请父代理定夺**）

本次按 brief 的清单删干净了**入口**与**任务感知出口**（`larkMvpService` 那条生产装配线上
已经没有任何"发到 `sender_open_id`"的代码）。但**另外三个 service 的"缺省端口"**里还留着
旧的私聊回落 —— 它们在**生产上永远用不到**（`larkMvpService` 构造时都注入了任务感知出口），
只在"别人自己 new 这个 service"（目前只有测试 / 工作台那条）时才会走到：

| 位置 | 现状 | 备注 |
| --- | --- | --- |
| `src/services/saleLookupService.js:99` | `sendCardToTask` 缺省 → `sendCard(task?.sender_open_id, card)` | 生产已注入 `larkMvpService.sendTaskCard` |
| `src/services/saleLookupService.js:383` | `replyCardByTask` 的**非群**分支 → `sendCard(task.sender_open_id, card)` | 私聊入口没了以后这条分支实际不可达 |
| `src/services/afterSalesFlowService.js:114,116` | `sendCardToTask` / `sendTextToTask` 缺省 → 私聊 | 生产已注入 |
| `src/services/salesThreadProgressService.js:70` | `sendTextToTask` 缺省 → `options.sendText?.(task?.sender_open_id, …)` | 生产已注入；`options.sendText` 生产上也不传 → 实际是空操作 |
| `src/services/larkMvpService.js:343` | `sendCard(openId, card)` —— 上面那三处缺省端口的底层实现 | 删掉它需要同时处理 `SampleReplacementService` 构造器里 `if (!sendCard \|\| …)` 的兜底分支，**风险大于收益**，本次不动 |

**为什么本次不动**：① brief 的删除清单只列了 `sendTaskText` / `sendTaskCard` 的
`chat_type !== 'group'` 分支；② 这 5 处**在生产链路上不可达**（都已被显式注入覆盖）；
③ 改它们要连带改 `saleLookupService.test.js` / `afterSalesFlow.test.js`
（约 20 条断言依赖这些缺省端口），属于"另一个 PR 的体量"。
**建议下一步**：单独一个 PR 把这 5 处缺省端口改成"拒绝并记日志"，同时把两个测试文件改成显式注入。

## 八、⚠️ 不确定 / 需要人看一眼的地方

1. **文案那句留不留**：我选择**留**（`PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` + `..._TEXT`），
   理由在第二节。如果业务负责人希望"私聊**一个字都不回**"，那只需把
   `PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` 设成 `false`（**不用改代码**）。
2. **`not_p2p` → `not_group_or_p2p`**：既不是群也不是私聊的消息（生产上不该出现），
   返回值里的 `reason` 从 `not_p2p` 改成 `not_group_or_p2p`。这是一处**可观测契约的字面变化**，
   但**行为不变**（仍然静默忽略、零远端调用），且全仓没有依赖这个字符串的地方。
3. **CI 的 `CodeQL`**：本次没有新增网络 / 文件 / 命令执行面，只是删代码 + 改测试；
   但仍要等 PR 上的三项实际输出（见 PR）。

