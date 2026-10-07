# 群聊 / 话题 · 六场景自动化 E2E —— 验收标准（**跑之前先写下来的**）

- **写下来的时间**：2026-10-07 12:40（上海 +08）—— **在任何一次运行之前**（本节只写"应该是什么样"）
- **业务负责人的口径（逐字）**：「按照我们**销售和采购都在群聊**，**一个事件在一个话题里完事**的逻辑来做，
  你看看是不是可以把**自动化测试**给做了」
- **一句话**：把「**一条群消息 / 一个话题 → 一整条业务链路走完**」做成**可重复运行**的自动化测试。
- **跑的目标 Base**：`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的**测试 Base**（指纹 `GqMMbh…`）。
  🔴 **生产 Base 只读，一个字都不写**；闸门「写入目标 ≠ 授权测试 Base → 拒绝运行」保留。
- **脚本**：`server/scripts/e2e-group-thread.mjs`
  （复用 2026-10-06 那份销售群聊端到端脚本的 harness，扩到采购报单 / 采购退货 / 补样品）
- **机器可读证据**：`server/data/selftest/group-thread-e2e/report.json`

## 0. 硬纪律（逐条）

1. **走项目代码**：直接 require 项目源码、调**项目自己的入口**——
   `LarkMvpService.acceptMessage` / `LarkMvpService.handleCardAction` /
   `PurchaseWebhookService.accept('supplier-report', …)` /
   `SampleReplacementService`（经 `LarkMvpService` 的渠道出口）。
   ⚠️ **不是**用 CLI 手工拼结果。
2. 🔴 **不用飞书 CLI**（**包括"读表验证"**）：验证一律走项目自己的只读路径
   （`V1BitableGateway` 的 `get/listAll/listFields`）——脚本自己把结果打印出来。
3. 🔴 **只写测试 Base**；生产 Base 只读。
4. **先写验收标准 → 再跑 → 逐条对照**；达不到就如实说"未达标 + 差在哪"。
5. **不硬编码任何 token/secret**：闸门从 `.env` 读值比对（本次顺手把
   `e2e-run.mjs` / `ws-poke-event.cjs` / `ws-subscribe.cjs` 里硬编码的生产 token 改成读 `.env`，**闸门不删**）。
6. 跑之前 `git fetch origin --prune && git pull --ff-only origin main`；
   判据 `git rev-list --count HEAD..origin/main == 0`；打印 `git rev-parse --short HEAD`。

## 1. 六个场景的验收标准（每个 = 一个话题里闭环）

> 术语：**四字段** = 销售主表上的「确认状态 / 销售状态 / 资金状态 / 库存状态」，
> 值域由 `server/src/config/salesStatusDimensions.js` 定义（本次预期：`已确认 / 已写入 / 已写入 / 已写入`）。

### ① 销售录单（话题里发文字 → 识别 → 确认卡片 → 确认 → 入账 → 交付 → 扣库存）

**输入**：群话题里发一条自然语言（不带 @、不引用）：「卖一双 `<货号>` `<颜色>` `<尺码>`码，微信 `<价>`」

| # | 判据 | 期望 |
| --- | --- | --- |
| 1.1 | 机器人回复**落在这条话题里** | 出站 `im.message.reply` 的 `data.reply_in_thread === true`，且 `path.message_id` = 她那条消息 |
| 1.2 | 飞书回带的 `thread_id` 被记进本地路由映射 | `SalesGroupThreadLocator.findByMessageId(她那句话)` 能查到 `thread_id` 与 `sales_entry_record_id` |
| 1.3 | 解析出确认卡片 | 任务 `status = ready_to_confirm`，`card_message_id` 非空 |
| 1.4 | **销售明细**写成什么样 | **1 条**：履约状态=`已交付`，成交金额=`<价>` |
| 1.5 | **收款明细**写成什么样 | **1 条**：收款状态=`已收款`，金额=`<价>`，交易方式=`微信`，**收款时间非空** |
| 1.6 | 销售主表四字段 | `已确认 / 已写入 / 已写入 / 已写入` |
| 1.7 | **库存方向** | 实时库存「门盒」**−1**；库存流水 **1 条**：库存行为=`销售减少`、变动数量=`1`（方向由行为表达） |
| 1.8 | **有没有多余消息** | 这个话题里**只有该发的**：1 条确认卡片回复（+ 入账后的结果卡片，仍是 reply_in_thread）；**0 条** `im.message.create`（即没有任何主动私聊/顶群消息） |
| 1.9 | 自证日志事件 | `v1.sale.posted` · `inventory.change.applied` · `sales.delivery.completed` |

### ② 销售退货（话题里说「退…」→ 定位那笔销售 → 确认 → 退货入账 + 库存加回）

**输入**：**同一个话题**里再说一句：「退一双 `<货号>` `<颜色>` `<尺码>`码，钱退现金」（不带 @、不引用）

| # | 判据 | 期望 |
| --- | --- | --- |
| 2.1 | 只凭 `thread_id` 就能定位到**同一笔**销售 | 日志 `sales.group.sale.located` 的 `source = thread_id`；任务上的 `sales_entry_record_id` 与原单一致（**不是"最近一笔"**） |
| 2.2 | 售后**出确认卡片**（同一话题，`reply_in_thread: true`） | 任务 `status = after_sales_confirming`，`card_message_id` 非空 |
| 2.3 | 确认后 **原销售明细** | 履约状态 → `已退货` |
| 2.4 | 售后**主表**（新单）四字段 | 交易类型=`销售退货`；`已确认 / 已写入 / 已写入 / 已写入` |
| 2.5 | **库存方向** | 实时库存「门盒」**+1**；库存流水 **1 条**：库存行为=`销售退货`、变动数量=`1`（方向=增加） |
| 2.6 | **收款明细** | **1 条**：交易方向=`退回`，金额=原价，**收款时间非空** |
| 2.7 | **有没有多余消息** | 都在**同一个话题**里；0 条主动私聊 |
| 2.8 | 自证日志事件 | `after_sales.confirmed` · `after_sales.executed` · `inventory.change.applied` |

### ③ 换货（新鞋出库 SALE_CASH + 旧鞋入库）

**输入**：同一话题里说：「换一双 `A`，换成 `B`，钱退现金」

| # | 判据 | 期望 |
| --- | --- | --- |
| 3.1 | 原销售明细 | 履约状态 → `已换货` |
| 3.2 | 售后主表四字段 | 交易类型=`销售换货`；`已确认 / 已写入 / 已写入 / 已写入` |
| 3.3 | **新鞋出库**的行为编码 | 库存流水里有一条行为=`现货销售`（编码 **`SALE_CASH`**）、变动数量=`1` |
| 3.4 | **旧鞋入库** | 另一条行为=`销售退货`、变动数量=`1` |
| 3.5 | **库存方向** | 旧鞋所在一行「门盒」**+1**、新鞋那一行「门盒」**−1**，两双**净 0**；库存流水 **2 条** |
| 3.6 | 差价 = 0 → 不动钱 | 收款明细 **0 条** |
| 3.7 | **有没有多余消息** | 都在同一个话题里；0 条主动私聊 |

### ④ 采购报单（「数量说明」变更事件 → 免确认生成采购申请 → 发采购群 → 图写回附件）

**输入**：测试 Base「供应商对接」**新增 1 条**（= 线上"记录变更事件"的同一个入口）：
编号=`<货品>`、尺码=`38`+`39`、数量说明=`「38 码 3 双，39 码 2 双」`、采购行为=采购申请（`PURCHASE_ORDER`）、报货批次号
→ 调 **`PurchaseWebhookService.accept('supplier-report', recordId)`**（生产上由 `routes/larkEvents.js` 的事件分派调用）

| # | 判据 | 期望 |
| --- | --- | --- |
| 4.1 | **免确认** | 任务直接落终态（`posted`），**不出现确认卡片、不等任何人点** |
| 4.2 | **「单据信息」写成什么样** | **2 行**：`38 码 → 3 双`、`39 码 → 2 双`；每行「幂等键」以 `purchase_request:<taskId>:` 开头；「采购行为」=采购申请 |
| 4.3 | 「供应商对接」那条记录回填 | 处理状态=`已生成申请`，且「关联采购申请」指向那 2 行 |
| 4.4 | 发的**哪个群 / 什么消息** | 发到 `PURCHASE_CHAT_ID`（采购群），**1 条图片消息**（`msg_type=image`），带 @所有人（`mention_all`） |
| 4.5 | 图**写回附件** | 「单据信息」里**同一批次只留一条**记录带附件（`attachment_written`），附件字段=「采购申请单」 |
| 4.6 | **库存方向** | **不动库存**（采购申请 ≠ 入库）：实时库存 0 变化、库存流水 0 条 |
| 4.7 | **有没有多余消息** | 采购群**只有那 1 条图**（+ 该发的文字），没有 @人以外的人、没有私聊 |
| 4.8 | 自证日志事件 | `purchase.webhook.accepted` · `purchase.report.posted` · `purchase.request.created` · `purchase.request.image.group_sent` · `purchase.request.image.attachment_written` |

### ⑤ 采购退货（→ 采购退货入账 + 库存减）

**输入**：测试 Base「供应商对接」**新增 1 条**：编号=`<货品>`、数量=`2`（number，**没有尺码**）、
采购行为=**采购退货**（能识别成退货的行为记录）、报货批次号
→ 调 `PurchaseWebhookService.accept('supplier-report', recordId)`

| # | 判据 | 期望 |
| --- | --- | --- |
| 5.1 | 分流判对 | 走**退货**那条链路（日志 `purchase.return.batch.joined` / `purchase.return.posted`），**不走**采购申请、不走采购到货/入库 |
| 5.2 | **退货单据写成什么样** | 「单据信息」新增：采购行为=采购退货、数量=`2`；生成一张采购退货单 PNG |
| 5.3 | **库存方向** | 实时库存该货品 **−2 行**（状态无关：门盒/样品/仓库都能退）；库存流水：库存行为=`采购减少`（`STOCK_PURCHASE_DECREASE`）、变动数量=`2`、方向=减少 |
| 5.4 | **有没有多余消息** | 采购群 1 条退货单图（+ 需要的那句文字）；0 条主动私聊 |
| 5.5 | 自证日志事件 | `purchase.webhook.accepted` · `purchase.return.batch.posted` · `purchase.return.posted` · `purchase.return.stock_applied` · `inventory.change.applied` |

### ⑥ 补样品（群销售触发 → 卡片回到那条销售话题；**不许发私聊**）

**输入**：群话题里卖一双 **门盒 = 0、样品 ≥ 1** 的鞋（交付时只能消耗样品）

| # | 判据 | 期望 |
| --- | --- | --- |
| 6.1 | 交付时**真的消耗了样品** | 库存任务里 `sampleConsumedQuantity > 0`（库存流水行为=`销售减少`） |
| 6.2 | 补样品卡片**回到那条销售话题** | 出站 `im.message.reply` 的 `reply_in_thread === true`，且 `path.message_id` = **她那句销售消息** |
| 6.3 | 🔴 **不许发私聊** | **0 条** `im.message.create`（`receive_id` 是 `open_id`）；**0 条** `lark.private_chat.send_skipped` 兜底记录 |
| 6.4 | 补样品任务落状态 | 本地任务 `sample_<销售明细id>`：`card_message_id` 非空、`notice_sent = true` |
| 6.5 | **有没有多余消息** | 这个话题里只有：确认卡片 + 结果卡片 + 补样品卡片（都是 reply_in_thread），没有另开话题/另发群 |

## 2. 怎么一键重跑

```bash
cd server
# 只读盘点（挑数据用；不写任何表）
node scripts/e2e-group-thread.mjs inspect
# 跑全部六个场景（写测试 Base；飞书外发全部拦住，只记录出站 payload）
node scripts/e2e-group-thread.mjs run
# 只跑某几个（key 见上：s1..s6；另有 e1..e5 是销售侧的补充场景）
node scripts/e2e-group-thread.mjs run --only s4,s5,s6
# 打印项目代码自己打的结构化日志（自证"项目代码真的跑过"）
node scripts/e2e-group-thread.mjs run --only s1 --show-logs
```

⚠️ 默认**不外发**：IM 走记录型替身（出站 payload 原样记下来当证据）。
`--real-im` 才真发（本机不需要，也没配测试群）。

## 3. 逐条对照（跑完回填）

> 本节在**跑完之后**回填：每个场景的 ✅/❌ + 实际值 + 日志事件证据。
