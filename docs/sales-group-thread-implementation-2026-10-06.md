# 实现说明：销售链路搬进群聊话题（2026-10-06）

> 口径在 `docs/sales-purchase-group-thread-2026-10-06.md`（业务负责人逐字确认）。
> 这份只写**实现落在哪几个文件、为什么这么切**，给后续排查用。

## 一句话

销售链路本身（识别原话 → 发销售卡片 → 确认 / 取消 / 修改 → 入账 → 交付）**一行没改**；
改的只是**承载场所**（私聊 → 群聊话题）与**输出寻址**（发给谁 → 回复到哪条话题）。

## 三处新增 / 改动

| 位置 | 干什么 |
| --- | --- |
| `server/src/services/salesGroupThreadLocator.js`（新） | `thread_id` / `parent_id` ↔ **销售主表 record_id** 的**本地**映射（`server/data/sales_group_threads/`） |
| `server/src/services/salesGroupFlowService.js`（新） | 只回答"这条群消息归销售还是采购、是哪一笔"；认不出就原样交回采购链路 |
| `server/src/services/larkMvpService.js` | 群聊分派（先问销售）、渠道感知的输出（`sendTaskText` / `sendTaskCard`）、`reply_in_thread` |

## 为什么"不建业务表"但仍要一份本地映射

业务负责人的原话是「**这个话题不用存**」——意思是**不要建「话题 ↔ 记录」的业务表、
不要给业务表加列**。但机器人要能从话题**反查回是哪一笔销售**，就必须有一份路由映射，
所以它和采购那侧（`server/data/purchase_group_messages/`）一个模式：**只写本地任务记录**，
**不碰她的多维表格**。两个目录**分开**（销售 / 采购各一份），将来按任务翻盘不会互相干扰。

## 回复怎么回到话题

用**项目现有的 SDK 与调用方式**：`this.client.im.message.reply`，在 `data` 上加
`reply_in_thread: true`（`@larksuiteoapi/node-sdk` 的类型里本来就有这个字段）。
主群里那条**第一条带它的回复会创建话题**，响应里回带 `thread_id` —— 我们就是拿它写的映射。

- 私聊：`replyText` / `replyCard` 的 payload **一个字段都没变**（不带 `reply_in_thread`）。
- 群聊：`sendTaskText` / `sendTaskCard` 走 `replyTextInThread` / `replyCardInThread`。

## 分派顺序（为什么采购没被影响）

1. `thread_id` / `parent_id` 命中**销售**本地映射 → 销售；
2. 在话题里但销售查不到 → **原样交给采购**（它自己回"认不出"，销售不抢答）；
3. 主群 @ 机器人：正文里有采购批次号 `BH-…` → 采购；
4. 主群 @ 机器人且过销售闸门（`config/messageGate`，与私聊**同一把尺子**）→ **新开一笔销售**；
5. 其余 → 采购（行为与改动前逐字相同）。

## 话题里后续的消息

定位到的那笔销售会写进任务（`sales_entry_record_id`），`processSalesTask` 看到它就
**沿用同一条销售主表记录**（不再新建，即"一条销售记录 = 一个话题"），
也**不写**那笔单的「解析状态 / 解析摘要」等中间态（避免盖掉她原单的摘要）。

## 工作台 401（她遇到的）

- `core/auth.js`：`/me` 返回 **401**（认证已启用但没 session）→ 自动跳
  `/api/auth/feishu/start`；并 `export showLoginButton()` 做兜底。
- `main.js`：tab 监听**移到鉴权之前**（原来 401 抛错后一个监听都没绑上 → 三个 tab 点了没反应）。
- `standalone.js`：5 个独立子页同一条兜底。
- ⚠️ `LARK_WEB_AUTH_ENABLED=false` 时 `/me` 是 **200**（`enabled:false`），**不跳**登录。
