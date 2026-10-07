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

## 三、逐条对照（跑完填）

见 `## 四、执行结果`。
