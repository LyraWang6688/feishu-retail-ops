# 群聊入口「冻结」说明 + 清除方案（2026-10-11）

> 业务负责人：「**你再派一个固定的 agent 吧。这个 agent 就是负责清除我们的群聊入口，让他先去整理一下**」
> 本文件 = 第一阶段**清点结果 + 方案 + 验收标准**（**这一步没删任何代码**）。执行前需她点头。

## 0. 背景口径（她定的）
- **扫码页 = 货品流转的数据录入**；**工作台 = 查询 / 订单补充 / 售后**（2026-10-11）。
- 她已定：话题群入口**保留 + 冻结**（不删、不迭代），与扫码入口**只共享业务处理层**；扫码侧**不读写** `data/lark_mvp_tasks/`。
- 她认的三步：**冻结 → 补齐 → 跑顺 1~2 周再删**。
- 🔴 **9 点推送必须保留！**（她原话）—— 那是**出站推送**，与"群聊录入入口"是两件事。

## 1. 入口清单（群聊/话题/卡片 inflow）
| # | 位置 | 作用 |
| --- | --- | --- |
| A1 | `routes/larkEvents.js:23-48` | `im.message.receive_v1` → `acceptMessage` |
| A2 | `routes/larkEvents.js:49-88` | `card.action.trigger` → `handleCardAction` |
| A3 | `routes/larkEvents.js:90-176` | 表变更事件：只剩「货品信息→标签二维码」⇒ **与群聊无关，不动** |
| A4/A5 | `services/larkMvpService.js:833-877` / `:927-940` | 群准入（**先判 `thread_id`**）+ 主群三条判据 |
| A6 | `larkMvpService.js:952-991` | `acceptGroupMessage`（表情确认 → 销售/采购分派） |
| A7 | `services/salesGroupFlowService.js:42-83` | 销售/采购路由分派 |
| A8 | `services/groupPurchaseFlowService.js:50-81` | 采购群消息 → 到货核对 |
| A9/A10 | `larkMvpService.js:1017-1076` / `:1595+` | `acceptSalesText` / `processSalesTask`（AI 解析） |
| A11 | `larkMvpService.js:1599-1609` | 话题进展二次处理 → `salesThreadProgressService` |
| B | `larkMvpService.js:2047-2129` | 卡片动作分派（补样品/到货核对/二次交付/确认成交/**团购券确认到账**/售后/销售确认） |
| C | `larkMvpService.js:684-760` | 群出口（只在 `chat_type==='group'` 发） |

## 2. ⚠️ 群聊独有能力（**删之前必须先补齐**）
| 能力 | 群聊 | 扫码页 | 工作台 |
| --- | --- | --- | --- |
| 自然语言录单 | ✅ | ✅ 扫码表单 | ❌（不承担录入） |
| 对话式追问缺项 | ✅ `larkMvpService.js:1952-1990` | ⚠️ 仅提交时校验 | ❌ |
| 话题进展二次处理（"收到微信 500"） | ✅ `salesThreadProgressService.js:111-176` | ❌ | ⚠️ 只能整单补（`routes/workbench.js:157,170`） |
| 自然语言查销售记录 | ✅ `saleLookupService` | ❌ | ❌（自建查询接口 2026-10-08 已删） |
| 售后退/换/赔 | ✅ | ❌ | ✅ |
| 二次交付 | ✅ | ❌ | ✅ |
| 补样品（门盒↔样品） | ✅ `sampleReplacementService.js:171+` | ❌ | ⚠️ 没有专门按钮 |
| **对话式到货核对（差异 / 实际金额）** | ✅ `purchaseArrivalConversationService.js:228+` | ❌ | ⚠️ **只有「按申请数全额验收」** ⇒ **🔴 最硬缺口** |
| 采购退货 | ❌ 代码里已无入口 | ❌ | ❌ |

## 3. 必须保留（🔴 删的时候不许碰）
- **K1【待处理单】** `pendingDealPushService.sendDailyPush:1135`
- **K2【二次交付提醒】** `secondDeliveryService.sendDailyReminder:664`
- **K3【团购券待结算 +「确认到账」】** ⚠️ 它的按钮回调**挂在群卡片分派里**（`larkMvpService.js:2106-2120`）⇒ 删卡片分派时**不能整块删**
- **K4 共享业务处理层**（销售入账/收款/交付/售后/库存/网关）—— 扫码 + 工作台在用
- **K5 本地映射与幂等**：`data/purchase_group_messages/`（**9 点推送深链在用**）· `sales_group_threads` · `second_delivery_reminder` · `purchase_webhook_tasks` · `scan_sessions`（扫码自有）
- **K6 共用件**：`utils/shanghaiDailyScheduler` · `pendingDealPushCard` · `secondDeliveryReminder` · `interactiveCardFeedback` · `config/salesThreadLink`
- **K7 扫码 / 工作台入口** —— 一条都不许动

## 4. 数据 / 配置 / 飞书侧
- 目录：`lark_mvp_tasks`(空) · `purchase_group_messages`(4) · `second_delivery_reminder`(5) · `scan_sessions`(扫码自有) …
- 配置：`config/groupAdmission.js` · `config/groupPurchase.js` · `config/messageGate.js`（**群专用**）
- `.env`：`PURCHASE_CHAT_ID`（⚠️ **一键两用**：入站定位 + 出站采购卡片）· `LARK_BOT_OPEN_ID` · `PENDING_DEAL_PUSH_*`（默认关，**生产才开**）
- **飞书侧人工**（代码里**没有退群能力**）：① `im.message.receive_v1` 订阅留不留 ② `card.action.trigger` 留不留（留=老卡按钮仍可点）③ 机器人是否退群 ④ `im:message` 权限

## 5. 三步方案
1. **冻结（现在）**：本文件 + （建议）群专属文件头写"冻结、勿加功能" + 1 条 sentinel 测试「冻结期不许新增群入口」；**零代码改动**。
2. **补齐**：按第 2 节的 ❌/⚠️ 逐项补（**第一个 = 到货差异**）—— 每条先写验收标准再实现。
3. **删除**（建议 5 个提交，先易后难）：
   C1 卡片里纯销售草稿分支 → C2 群话题到货核对（**留工作台 `confirmArrival`**）→ C3 群采购入站定位（**留 `purchase_group_messages` 存储**）→ C4 群销售入站 → C5 收尾孤儿（`groupAdmission` / `messageGate`）。

## 6. 验收标准
- **A 群聊清干净**：全仓 grep 不到群准入/分派符号；`lark.group.message.accepted` 0 条；
- **B 9 点推送还活着**：手工触发 `sendDailyPush({now})` / `sendDailyReminder({now})` / `confirmVoucherSettlement`，群里收到三条卡片；
- **C 扫码/工作台没受影响**：`scanPageWrite` / `workbenchOrders` / `voucherSettlement` / `secondDeliveryService` / `pendingDealPush*` 全绿；
- **D 迁移不删覆盖**（照私聊先例）：群专属用例改成"入口不存在"断言，不整文件删。

## 7. ⏳ 待她定的（挡住下一步）
| # | 问题 |
| --- | --- |
| **R3（最硬）** | 群冻结后**到货差异（少了/多了）没有入口** ⇒ **先在工作台补"按实际到货数逐行填"**，还是**明确"不记差异"**？ |
| R2 | **采购退货**：代码里已无入口 ⇒ 现在还需要吗？（需要 ⇒ 按结构化做一个） |
| R1 | **自然语言查单**：工作台自建查询接口已删（改走 Base 外链）⇒ 以后查单只走 Base 外链？ |
| R4 | **机器人要不要退话题群**？（不可逆；9 点推送发的是另一个群，理论上不冲突） |
| R5 | 9 点推送深链依赖群映射 ⇒ 老映射长期保留？（丢了只降级成脚注） |
| R6 | `PENDING_DEAL_PUSH_ENABLED` 默认关、生产才开 ⇒ 需在生产核实三块真的都在跑 |
