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
最自洽的解释：消息对象 schema 是共用的，**只有发送接口真的会填它**。

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
⇒ 只能**打开群**，**定位不到某条消息，也进不了某个话题**。

## 所以「维度 1」的深链怎么落地

代码里已经按"三级去找、找不到就给空"实现（`server/src/services/larkMessageLinkResolver.js`）：

1. **本地映射里存的** `app_link` —— 唯一可靠来源。需要销售群链路在**发消息时**
   把 `create`/`reply` 响应里的 `data.message_app_link` 一起写进
   `sales_group_threads` 记录（`SalesGroupThreadLocator.rememberSaleThread` 的字段位已留好）。
2. **现查** `im.message.get` 读 `message_app_link`（开关 `PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED`，
   默认开）—— 今天是空跑，但飞书哪天开始返回就**自动生效，不用改代码**。
3. **运营自己填的模板** `PENDING_DEAL_PUSH_LINK_TEMPLATE`（默认**空**）。

🔴 三级都拿不到就**返回空 URL**，绝不自已拼一条"看起来能定位、点开却不在话题里"的链接。

## 待真机验 / 需要她做的

1. **"点进去在不在话题里"无法在不发真消息的前提下确证** —— 需要她点一次真链接。
   而真链接要等第 1 步（发消息时存 `message_app_link`）落地后才有。
2. **要不要申请 `im:message.group_msg` 权限**：申请了 `im.message.list` 才能用，
   但按上面的结论它**也不返回** `message_app_link`，所以**不建议为这个功能去申请**。
3. ⭐ 如果她希望历史单也能点，有两条路，都要她拍板：
   - **a.** 销售群链路改成"发消息时存 app_link"（一条记录的字段，改动很小），
     之后**新开**的话题单就能点；历史单仍然点不了。
   - **b.** 用**飞书官方的 AppLink 生成和诊断工具**（`https://webview.feishu.cn/applinktool`）
     看看有没有未公开的"消息"协议 —— 有的话填进 `PENDING_DEAL_PUSH_LINK_TEMPLATE` 即可，
     不用改代码。

## 复现命令

```bash
curl -sS -L "https://open.feishu.cn/document/server-docs/im-v1/message/get.md?lang=zh-CN" | grep -i app_link   # 无输出
curl -sS -L "https://open.feishu.cn/document/common-capabilities/applink-protocol/supported-protocol/open-a-chat-page.md?lang=zh-CN"
curl -sS -L "https://open.feishu.cn/sitemap/sitemap.xml" | grep -o "https://open.feishu.cn/document/[^<]*applink[^<]*" | sort -u
```
SDK 实测脚本（一次性、未入库）：用测试应用凭证建 `lark.Client`，调用见上文两个小节。
