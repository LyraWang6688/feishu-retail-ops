# 「接收群聊 @ 机器人消息」权限清单（2026-10-06）

**测试应用**：`cli_aa3341b397389cd4`（机器人名「来财备份」）
**问题**：私聊事件能收到（`chat_type: p2p` ✓），群里 @ 机器人收不到（0 条）。
**结论**：**测试应用缺一条「群聊 @ 机器人」的应用身份权限**。系统按权限决定推不推，
所以缺这条时事件**根本不会推送**（不是"推来了被代码丢掉"）。

---

## ⭐ 一句话答案

去「开发配置 > 权限管理 > 开通权限」勾上：

> **`im:message.group_at_msg:readonly`**

一键开通链接（格式取自平台 99991672 错误原话，会把该权限直接带出来）：

```
https://open.feishu.cn/app/cli_aa3341b397389cd4/auth?q=im:message.group_at_msg:readonly&op_from=openapi&token_type=tenant
```

若还想接收**其他机器人** @ 本机器人的消息，再加 `im:message.group_at_msg.include_bot:readonly`。

---

## ① 权限表（中文名 | scope | 她有没有 | 依据）

| 权限中文名（后台显示）               | scope                                            | 她有没有     | 依据                                                                     |
| ------------------------------------ | ------------------------------------------------ | ------------ | ------------------------------------------------------------------------ |
| 获取群组中用户@机器人消息            | `im:message.group_at_msg:readonly`               | ❌ **缺**    | 官方《接收消息》事件表；同文档权限要求段称「接收群聊中@机器人消息事件」  |
| 获取用户在群组中@机器人的消息（历史版本） | `im:message.group_at_msg`                     | ❌ 缺（可选） | 同上，与上面**二选一**即可                                                |
| 获取群组中其他机器人和用户@当前机器人的消息 | `im:message.group_at_msg.include_bot:readonly` | ❌ 缺（可选） | 同上，若要连**机器人**发的 @ 也收才需要                                   |
| 读取用户发给机器人的单聊消息         | `im:message.p2p_msg:readonly`                    | ✅ 有        | receive.md；她截图确认，且私聊实测通                                      |
| 获取单聊、群组消息                   | `im:message:readonly`                            | ✅ 有        | `im/v1/message/list.md`、`get-2.md` 权限要求；她截图确认                  |
| 获取与上传图片或文件资源             | `im:resource`                                    | ✅ 有        | `im/v1/image/create.md` 权限要求；她截图确认                              |
| 获取群组信息                         | `im:chat:readonly`                               | ❌ 缺（旁证） | **实测 99991672**（见下）；`group/overview.md`                            |

依据出处（官方文档，2026-10-06 实抓）：

- 《接收消息》`https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md`
- 《获取会话历史消息》`https://open.feishu.cn/document/server-docs/im-v1/message/list.md`
- 《获取消息中的资源文件》`https://open.feishu.cn/document/server-docs/im-v1/message/get-2.md`
- 《上传图片》`https://open.feishu.cn/document/server-docs/im-v1/image/create.md`
- 《群组概述》`https://open.feishu.cn/document/server-docs/group/overview.md`
- 《申请 API 权限》`https://open.feishu.cn/document/server-docs/application-scope/introduction.md`

## ②「接收消息 v2.0」事件一共涉及哪些权限

官方《接收消息》原文：**「订阅该事件所需的权限，开启其中任意一项权限即可订阅」**，
但**推送什么内容由权限决定**（原文：**「系统会根据应用接收消息相关权限，判断可推送的信息」**）。

| 用途                     | 需要的权限（任一）                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| 单聊消息                 | `im:message.p2p_msg` 或 `im:message.p2p_msg:readonly`                                     |
| 群聊**@机器人**（仅用户） | `im:message.group_at_msg` 或 **`im:message.group_at_msg:readonly`**                       |
| 群聊 **@机器人**（含其他机器人） | `im:message.group_at_msg.include_bot:readonly`                                      |
| 群聊**所有消息**（仅用户） | `im:message.group_msg`                                                                  |
| 群聊**所有消息**（含机器人） | `im:message.group_msg.include_bot:read`                                              |
| 群内其他机器人消息       | `im:message.group_bot_msg:readonly`                                                      |
| 群聊所有用户聊天消息     | `im:message.group_msg:readonly`                                                          |
| 字段权限（可选）         | `contact:user.employee_id:readonly`（获取用户 user ID）                                  |

⭐ 原文还有一句正好对上她的现象：

> **「如果需要同时接收单聊消息和群聊消息，需要分别申请对应的单聊消息权限和群聊消息权限」**

她只有单聊那条 → 单聊通、群聊不通。**这不是 bug，是权限没配全。**

## ③ 机器人「在群里」还需要什么

1. **应用开启机器人能力**（《接收消息》前提条件第一条）。
2. **订阅「消息与群组」分类下的「接收消息 v2.0」事件**（前提条件第二条）—— 她已勾 ✓。
3. **机器人必须被拉进那个群**。《获取会话历史消息》原文：「应用需开启机器人能力，**机器人需在群组中**」。
   只在后台勾权限、机器人不在群里，同样收不到。
4. ⚠️ **权限勾完不一定立刻生效**：需审核权限要**创建版本并提交审核**，管理员通过后才生效；
   免审权限申请后立即生效（《申请 API 权限》）。
5. ⚠️ **长连接是集群模式**：同一应用有多个长连接客户端在线时，事件只随机推给**其中一个**。
   排查「0 条」前先确认只有一个客户端在线（项目 `.dsh-probe/FINDINGS.md` 记录，可查 `event/v1/connection.get`）。
6. 🔴 **项目侧还有第二道闸**：`LARK_BOT_OPEN_ID` 没配时，**主群消息一律不处理**（话题消息仍处理）。
   见 `server/src/services/larkMvpService.js` 第 386-401 行。事件收得到但代码会静默丢弃并打
   `lark.group.message.ignored / bot_open_id_unconfigured`。

## ④ 实测证据（只读接口，测试应用凭证）

用测试应用凭证调**只读**接口探错误码，全部返回「缺什么」而不改动任何数据：

| 接口                                          | 返回                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /open-apis/bot/v3/info`                  | `code=0` ✅（机器人名「来财备份」）                                                |
| `GET /open-apis/im/v1/chats/:chat_id`         | **99991672** 缺 `[im:chat:readonly, im:chat, im:chat:read]`                        |
| `GET /open-apis/im/v1/chats`                  | **99991672** 缺 `[im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read]` |
| `GET /open-apis/im/v1/messages/mget`          | `99992354`（message_id 不存在）⇒ **消息读权限已具备**，否则会是 99991672            |

99991672 原话（含中文）：

> Access denied. One of the following scopes is required: [...]
> **应用尚未开通所需的应用身份权限：[...]，点击链接申请并开通任一权限即可：**
> `https://open.feishu.cn/app/cli_aa3341b397389cd4/auth?q=...&op_from=openapi&token_type=tenant`

## ⚠️ 唯一未 100% 确定的一点：中文名有两处官方用词

同一个 scope `im:message.group_at_msg:readonly`，官方文档里出现过**两个**中文名：

- 《接收消息》**事件表**：「**获取群组中用户@机器人消息**」
- 《接收消息》**权限要求段**：「**接收群聊中@机器人消息事件**」

判断：后台「权限管理」里更可能是前者（事件表是按权限注册表自动生成的，且同表把
`im:message.group_at_msg` 标为「历史版本」，说明它跟随当前命名）。
**但这一点无法在本地核实**（后台权限管理页是动态渲染，抓不到静态文案）。
⇒ **以后台实际显示为准**；按 **scope 名**勾最稳，或用上面的 `/auth?q=` 链接直接带出来。

## 🔍 她自己怎么在后台找到它

1. 「开发配置 > 权限管理 > 开通权限」，搜索关键词 **「群」** 或 **「@」** 或 **「机器人」**；
2. 或看「事件与回调 > 事件订阅 > 接收消息 v2.0」那一行 → 展开 **「查看其他权限 ▼」**
   （她之前截图里就有这个展开项，里面列全了 ② 里的 9 条）；
3. 或直接用 `/auth?q=im:message.group_at_msg:readonly` 链接。

---

## 方法与边界（自证）

- 全程**未使用飞书 CLI**；**未调任何写接口**（没有发消息、没有改表、没有起第二个长连接）。
- 只读接口用**测试应用凭证**（`LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`，来自 `.env`）。
- **未打印任何 secret / token 值**（⚠️ 一次 axios 异常转储曾把**临时** `tenant_access_token`
  带进本地工具输出，非长期凭证，后续已改为只取响应体）。
- ⚠️ 更正一条旧结论：`.dsh-probe/FINDINGS.md` 说「本机抓不到 feishu.cn」——**不准确**。
  `web_fetch` 工具因 DNS 解析到非公网 IP 而拒绝，但 **`curl` 直连 `open.feishu.cn` 正常（HTTP 200）**，
  官方文档可正常读取。（**不含**使用飞书 CLI。）
