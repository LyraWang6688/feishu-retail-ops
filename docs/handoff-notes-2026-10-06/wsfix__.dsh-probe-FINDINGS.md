> **归档说明（2026-10-06 清理任务）**：本文件原为 worktree `/private/tmp/wsfix` 里的未跟踪文件
> `.dsh-probe/FINDINGS.md`（2026-10-06 12:23）。它是**排查报告**（笔记类），按业务负责人
> 「把有价值的交接笔记收进 docs/、其余连同 worktree 一起清掉」收录。
>
> ⚠️ **唯一的改动**：Base 的 `app_token` 值做了**遮蔽**（只留前 8 位 + `…`）——
> 与同目录另一份 FINDINGS 一致，避免再复制一份 token；其余**一字未改**。
> ⚠️ 它是**当时的排查记录，不是当前口径**。

# 定位：本地长连接 0 事件（2026-10-06 12:18–12:23 上海时间）

工作区：`/tmp/wsfix`（分支 `chore/ws-test-app-credentials`，commit `e44458b`）。
主工作区 `main`（`2c05128`）**一个字未改**。全程只用项目代码 / 官方 SDK；**未用飞书 CLI**；
只写测试 Base（`FEISHU_V1_E2E_TEST_APP_TOKEN` 那个）；**未打印任何 secret / token 值**。

测试应用 app_id：`cli_aa3341b397389cd4`（凭证来自 `LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`）。

---

## ① 测试应用的机器人在哪些群

- `GET /open-apis/im/v1/chats`（tenant_access_token，测试应用）→ **99991672**：
  缺 `[im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read]`。
  ⇒ **群列表查不到**；缺的就是上面这几个 scope。
- `GET /open-apis/bot/v3/info` ✅ **成功**：
  - `app_name` = **「来财备份」**
  - `open_id` = `ou_cd858f2fde7c25cb778b4e0c94874098`
  - `activate_status` = 2

⭐ **「来财备份 属于别的应用」这个怀疑，证据不支持**：测试应用自己的机器人就叫「来财备份」。
（无法 100% 排除重名，但没有任何迹象支持"它是另一个应用"。）

顺带探到的权限现状（全部返回 99991672，只报"缺什么"）：

| 能力 | 缺的 scope |
| --- | --- |
| 读群列表 | `im:chat:readonly` / `im:chat` / `im:chat.group_info:readonly` / `im:chat:read` |
| 读消息 API | `im:message.history:readonly` / `im:message:readonly` / `im:message` |
| 订阅表事件 | `drive:drive` / `docs:doc` / `sheets:spreadsheet` / `docs:event:subscribe` |
| 读应用配置 | `admin:app.info:readonly` / `application:application:self_manage` |

✅ 有 bitable 读写：下面 3 条记录都真写进测试 Base 了。

## ② 长连接：能建立；但"能不能收到事件"本次**没能证明**

- `node scripts/ws-listen.mjs --seconds 200` → `{"state":"connected","reconnectAttempts":0}`，退出码 0。
- 窗口 **12:19:30–12:22:50**，用项目代码 `V1BitableGateway`（官方 SDK client + 测试应用凭证）
  往测试 Base「供应商对接」成功写入 **3 条**：
  `reczz28JzTZ0bnEZ`(12:19:46) · `reczz28JzTzyWzFI`(12:20:10) · `reczz28JzWNzHFFS`(12:22:25)
- 收到 `drive.file.bitable_record_changed_v1`：**0 条**（日志里连一条 `📥` 都没有）。
- 第 3 次是**单实例净测试**：先确认 `event/v1/connection.get → online_instance_cnt = 1`
  （另一个长连接实例于 12:22:18 退出）→ 再写入 → 仍 0 条。

⚠️ **这个「0」不足以判「长连接不通」**：
- 表事件**没订阅上**：`POST /open-apis/drive/v1/files/<测试Base>/subscribe?file_type=bitable`
  → **99991672**，缺 `[drive:drive, docs:doc, sheets:spreadsheet, docs:event:subscribe]`。
- SDK 类型注释原文（`types/index.d.ts`）：`drive.file.bitable_record_changed_v1` =
  「**被订阅的多维表格**记录发生变更时，将会触发此事件」。
⇒ 负面结果**同时被"没订阅这张表"解释**，不能据此说长连接坏。

⭐ 对排查很关键的一条（先前的"0 条"可能是假阴性）：
- 我连上期间 `event/v1/connection.get → online_instance_cnt = 2`（有第二个长连接实例在线），
  它 12:22:18 退出后才变 1。
- 项目今天的自测报告转述 SDK 文档：「长连接为**集群模式、不支持广播**：同一应用部署多个客户端时，
  **只有随机一个客户端会收到**」（⚠️ 这段 SDK 原文在本机 `node_modules` 里**没找到**，
  只能标"项目报告转述，未能直接核实"）。
- ⇒ **当时若有第二个 ws-listen 在跑，事件可能被另一个收走**。
  报"0 条"之前应先确认只有一个客户端在线（`event/v1/connection.get`，只读，可查）。

## ③ 话题群会不会导致不推 —— 查到什么 / 没查到什么

**没查到（官方明文）**：
- 本机抓不到 feishu.cn（解析到非公网 IP，`web_fetch` 直接报错），**没有拿到官方对"话题群"的明文说明**。
- 本机 SDK `@larksuiteoapi/node-sdk@1.74.0` 类型定义里，`im.message.receive_v1` 的注释只有
  「机器人接收到用户/机器人发送的消息后触发此事件」，**没有"话题群不推"的字样**；payload 里带 `thread_id`。
- SDK 里**唯一**明确提到话题群的 IM 事件是 `im.chat.member.user.added_v1`：
  「新用户进群（**包含话题群**）时触发此事件」→ 至少说明"话题群"不是 IM 事件的一刀切排除项。
- SDK 有 `getChatMode(chatId)` → `'p2p' | 'group' | 'topic'`，把 topic 当普通群模式处理。

**查到（项目自己的实测）**：
- 仓库记录（`AGENTS.md`「群聊入口」/ `docs/arrival-conversation-flow.md`）：2026-10-05 **真机实测**——
  她在**话题**里发消息时 `mentions` 为空，事件**照样推给了（生产）应用**。

⇒ 只能说：**没有官方明文可引；SDK 注释 + 项目实测都不支持"话题群不推"**。这是**推断**，不是定论。

## 结论 + 下一步

- 最可能的答案**不是**"机器人不在群里"（它的名字就是「来财备份」），
  而是**这个测试应用还没配好"收事件"**。
- 请业务负责人在该测试应用后台看两屏：
  1. **事件订阅**里到底勾了哪些事件（至少要勾 **接收消息 `im.message.receive_v1`**）；
  2. **订阅方式**是「长连接」还是「请求地址」。
- 另需补权限（⚠️ 这一句是**推断**，具体以后台提示为准）：群聊 @ 机器人消息的接收权限
  （形如 `im:message.group_at_msg:readonly`）＋ `docs:event:subscribe`（或 `drive:drive`），
  然后对**测试 Base** 重新订阅一次。

测试 Base 里多了 3 条「供应商对接」探针记录（按纪律：测试 Base 可写、无需删）。

可复跑脚本 / 证据：`.dsh-probe/`（`probe-chat-list.mjs` · `probe-bot-info.mjs` · `probe-write.mjs` ·
`probe-conn.mjs` · `probe-msgscope.mjs` · `ws-run.log`）
