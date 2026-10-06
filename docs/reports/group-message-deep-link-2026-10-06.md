# 「消息深链」到底怎么拿（2026-10-06 查证）

> 目标：把「某笔销售当初那条群消息」变成可点的深链，做「维度 1：每天 9 点推最近 7 天
> 未付 / 预付、尚未成交的销售单」时每笔一行带上它。
>
> 纪律：**只用 curl 拉官方文档 + 项目 SDK 实测**，不用 `web_search`，**不用飞书 CLI**；
> 只读、只碰测试群 `oc_9f2cb1ff23ee442a5facbb1fc24ae1f9`。

## 一句话结论

**今天拿不到。** 官方今天能给 `message_app_link` 的**只有发送响应**
（`im.message.create` / `im.message.reply` 的 `data.message_app_link`）——
也就是"发出去的那一刻"才知道，必须**当时存进本地映射**。
对**已经发过的**历史消息，现有公开接口**没有**任何办法把它取回来，
AppLink 协议里**也没有**"打开某条消息 / 打开某个话题"这种协议。

所以「维度 1」的推送里，历史单**暂时只有单号 + 金额**，深链是空的（代码不拼假 URL）。

## 实测一：`im.v1.message.get` **不返回** `message_app_link`

用项目 SDK（`@larksuiteoapi/node-sdk@1.74.0`）+ `.env` 里的**测试应用**凭证，
打测试群里**真实存在**的两条消息
（id 取自 `docs/reports/procurement-e2e-2026-10-06.md` 第 281–282 行）：
顶层图片 `om_x100b637ed0fe90a4b1b23a428b18a2b`（`thread_id = omt_19a1212a17cf5cb7`）、
机器人 reply 的那条 `om_x100b637ed0f7d0a4b3472297ffdcdc7`。

五种调用方式，**全部** `code=0` 且 `message_app_link === undefined`：

| 调用 | 结果 |
| --- | --- |
| `client.im.message.get({ path: { message_id } })` | code=0，字段列表无 `message_app_link` |
| `… , params: { with_app_link: true }`（布尔） | 同上 |
| `… , params: { with_app_link: 'true' }`（字符串） | 同上 |
| `… , params: { with_sender_name: true }` | 同上 |
| 绕过封装，对 `/open-apis/im/v1/messages/:id?with_app_link=true` 发原始 GET | 同上 |

实测返回的字段（顶层那条）：
```
body, chat_id, create_time, deleted, message_id, message_position,
msg_type, sender, thread_id, thread_message_position, update_time, updated
```
⭐ 注意 `message_position = "29"`、`thread_message_position = "-1"`、`thread_id` **都有值**
—— 说明这个接口的"位置"信息是通的，**单单 `message_app_link` 这个字段没有被填**。
（reply 那条多了 `parent_id` / `root_id` / `mentions`，一样没有 `message_app_link`。）

## 实测二：`im.v1.message.list` **没权限，走不通**

```
client.im.message.list({ params: { container_id_type: 'chat',   container_id: oc_9f2c… } })
client.im.message.list({ params: { container_id_type: 'thread', container_id: omt_19a1… } })
```
两条都返回：
```
code: 230027
msg: Lack of necessary permissions, ext=need scope: im:message.group_msg
```
`im:message.group_msg`（获取群组中所有消息）是**开发者后台的权限**，代码里绕不过去；
而且它本来也只能拿**会话历史**，不是"按 message_id 取深链"的正解。

## 实测三：官方文档里根本没有这个字段，也没有这种 AppLink

curl（末尾加 `.md?lang=zh-CN` 拿纯文本）：

- `…/document/server-docs/im-v1/message/get.md` —— 响应体字段表**没有** `message_app_link`
- `…/document/server-docs/im-v1/message/list.md` —— 同上
- `…/document/server-docs/im-v1/message/create.md` —— 同上
- `…/document/server-docs/im-v1/message/reply.md` —— 同上
- `…/document/im-v1/message/thread-introduction.md` —— 只讲 `thread_id` 怎么用，**没有**任何"点开话题"的链接

⚠️ 有意思的是：**SDK 的类型声明里有** `message_app_link`
（`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts` 里 `create` / `reply` / `get` / `list`
的返回类型都有），但**文档与实测**都对不上 `get`/`list`。
一开始的推测是"消息对象 schema 是共用的，**只有发送接口真的会填它**" ——
⚠️ **这个推测在实测四里被证伪了**（发送接口也没填）。

AppLink 协议（把 `…/sitemap/sitemap.xml` 拉下来，过滤出全部 34 条 applink 文档）：
`open-a-native-app` · `open-an-approval-page` · `open-a-bot` · `open-a-chat-page` ·
`open-a-gadget` · `open-a-workplace` · `open-an-h5-app` · `open-calender/*` · `open-docs` ·
`open-lark` · `open-scan-function` · `open-the-sso-login-page` · `open-the-web-view-…` · `open-todo/*`
—— **没有一条**是"打开某条消息 / 打开某个话题"。

唯一和聊天有关的那条，原文（`…/supported-protocol/open-a-chat-page.md`）：
```
协议：https://applink.feishu.cn/client/chat/open
参数：openId（否）· openChatId（否，oc_ 开头）——「openID 与 openChatId 仅能填写其中一个参数」
```
⇒ 只能**打开群**，**定位不到某条消息，也进不了某个话题**（2026-10-06 晚又 curl 复核过一遍，没变）。

## 🔴 实测四（2026-10-06 晚 · 验证"发送响应里到底有没有"）

**结论：这个应用当前一次都没拿到过 `message_app_link` —— 发送接口也没有。**

做法：用**项目代码 / 项目 SDK**（测试应用凭证，**不是飞书 CLI**）在**测试群**
`oc_9f2cb1…` 里真发了 6 条，把响应的 `data` 键**逐个打出来**：

| 调用 | `data` 里有什么 | `message_app_link` |
| --- | --- | --- |
| `im.message.create`（主聊天，文本） | body, chat_id, create_time, deleted, message_id, msg_type, sender, thread_id, update_time, updated | **没有这个键** |
| `im.message.create`（主聊天，interactive 卡片） | 同上 | **没有这个键** |
| `im.message.reply`（不进话题，文本） | …+ parent_id, root_id | **没有这个键** |
| `im.message.reply`（进话题 `reply_in_thread:true`，文本） | …+ parent_id, root_id | **没有这个键** |
| `im.message.reply`（进话题，interactive 卡片）⭐ 销售卡片走的就是这条 | …+ parent_id, root_id | **没有这个键** |
| `im.message.get`（刚发出去的那两条，带 / 不带 `with_app_link`） | items[0] 有 message_position / thread_id / thread_message_position | **没有这个键** |

⇒ ⚠️ 光靠"发消息那一刻存 `message_app_link`"这条路**今天是空转的**：代码就位、能存就存，
但这个应用/租户**暂时不会回带**这个字段。

⭐ **但她在 2026-10-06 给了一条真实可用的话题深链格式**（记在
`docs/module-split-and-main-flow-2026-10-06.md` 第八节，本仓库已代码化到
`server/src/config/salesThreadLink.js`）：

```
https://applink.feishu.cn/client/thread/open
  ?open_chat_id=<群 chat_id>&open_thread_id=<话题 thread_id>
  &openchatid=<群 chat_id>&openthreadid=<话题 thread_id>&thread_position=-1
```

> 「**点开之后就直接可以看到那条消息的所有沟通内容**」

⭐ **两个 id 我们手上都有**（群消息事件里有 `chat_id`；`im.message.reply` 带
`reply_in_thread:true` 的响应里、以及事件里都有 `thread_id`）⇒ **不用等飞书回带**，
`chat_id + thread_id` 一拼就是那条话题本身，**新单立刻可用**。

⚠️ 与她明确否掉的"自己拼假链接"的区别：这里拼的是**她给的真实格式**、参数是**我们自己
发消息时真拿到的两个 id**；而且**缺任意一个 id 就返回空、留空**，绝不用空值拼出一条
点开是别处的链接。


## 所以「维度 1」的深链怎么落地

> ⭐ **2026-10-06 晚已按业务负责人的话落地**（她：「我们现在不需要历史消息的补拉了。我们只要
> 后续的消息能够取回来就行」「我在多维表格的销售主表里加了一列叫做**消息链接**，可以写入这里～」）：
> **从今往后**新建的单，在**发销售卡片那一刻**把 `data.message_app_link` 同时写进
> ① 本地映射 `data/sales_group_threads/` 的 `app_link`、② 销售主表的「消息链接」列
> （实现：`server/src/services/salesMessageLinkService.js`，由 `larkMvpService.bindGroupSaleThread` 调）。
> ⚠️ 存的是**我们回复的那条（卡片）消息**的链接 —— 话题根是**她**发的，飞书不会把它的链接给我们；
> 我们这条回复就在**同一个话题**里（主群第一条带 `reply_in_thread` 的回复就是创建那个话题的那条），
> 所以点开同样落在那个话题。**老单不补**：拿不到就留空。
>
> ✅ **所以那一列现在就有值了**（不再依赖飞书回带）：发销售卡片时，
> 飞书给了 `message_app_link` 就用飞书的；没给（实测四：当前都不给）就按**她给的话题格式**
> 用 `chat_id + thread_id` 拼一条 —— 两条都是**真链接**，存进本地映射（`app_link` / `thread_link`
> 分开存，便于排查哪条来源）与销售主表「消息链接」列。两个 id 都没有时**留空**。

代码里按"**三级**去找、找不到就给空"实现（`server/src/services/larkMessageLinkResolver.js`）：

1. **本地映射里存的飞书深链** `app_link`（发送响应给的，飞书回带时才有）；
2. ⭐ **本地映射里存的话题深链** `thread_link`（按她给的格式拼的）—— **今天真正管用的那条**，
   零远端调用；
3. **现查** `im.message.get` 读 `message_app_link`（开关 `PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED`，
   默认开）—— 今天是空跑，但飞书哪天开始返回就**自动生效，不用改代码**。

🔴 三级都拿不到就**返回空 URL**，绝不自己拼一条"看起来能定位、点开却不在话题里"的链接。
🔴 曾经还有第三级「运营自己填的 URL 模板」`PENDING_DEAL_PUSH_LINK_TEMPLATE` ——
   业务负责人 2026-10-06 明确「不要补历史、也不要拼链接」之后**已整个删除**
   （配置 / 代码 / 用例 / 文档一起删）。**不要再加回来**：要么真链接、要么不显示。

## 待真机验 / 需要她做的

1. 🔴 **这件事现在卡在飞书侧，不在代码**：实测四里 6 种发送/读取方式**全都没有** `message_app_link`。
   要让她"点一下回到那个话题"，需要**飞书侧**给出回带这个字段的条件，或者一个能定位
   消息/话题的 AppLink 协议。建议用**飞书官方「AppLink 生成和诊断工具」**
   （`https://webview.feishu.cn/applinktool`）问一次；代码这边已经待命。
2. **要不要申请 `im:message.group_msg` 权限**：申请了 `im.message.list` 才能用，
   但按上面的结论它**也不返回** `message_app_link`（且实测四里 `get` 同样不返回），
   所以**不建议为这个功能去申请**。
3. 历史单（2026-10-06 之前开的）**点不了** —— 她已明确不补，故「消息链接」列对它们是空的。
   新单同样先空着（原因见上），**拿不到就留空，绝不伪造**。
   若哪天她想要历史单也能点，唯一现实的路是用**飞书官方的 AppLink 生成和诊断工具**
   （`https://webview.feishu.cn/applinktool`）找未公开的"消息"协议；
   ⚠️ 但**代码里已经没有"填个模板就生效"的口子了**，要走这条路得先跟她确认再加回配置。

## 复现命令

```bash
curl -sS -L "https://open.feishu.cn/document/server-docs/im-v1/message/get.md?lang=zh-CN" | grep -i app_link   # 无输出
curl -sS -L "https://open.feishu.cn/document/common-capabilities/applink-protocol/supported-protocol/open-a-chat-page.md?lang=zh-CN"
curl -sS -L "https://open.feishu.cn/sitemap/sitemap.xml" | grep -o "https://open.feishu.cn/document/[^<]*applink[^<]*" | sort -u
```
SDK 实测脚本（一次性、未入库）：用测试应用凭证建 `lark.Client`，调用见上文两个小节。
