# 行为管理改按【行为编码】查找 + 点到货卡片失败必须有可见反馈（2026-10-07）

> 业务负责人 2026-10-07 逐字两条：
> ① 「**是的，我确实是把生产表上的中文名称给改了，所以你就用英文编码吧，这个不会动！**」
> ② （发来「到货核对卡片」截图）「**卡片点击后也是没有任何反应**」
>
> ⚠️ 先写「改完之后应该是什么样」（验收标准），改完逐条对照。**本文档就是那份验收标准。**
> 🔴 本文档不含任何生产表写入、不含部署（她明令测试期间禁止自行部署）。

## 0. 现场证据（2026-10-07 真机，生产）

- 她点「是」后日志：`lark.card.handled … outcome:"error","result":"入库没成功：行为管理中\"采购入库\"必须且只能有一条记录"`。
- 根因：`server/src/services/purchaseWebhookService.js` 的 `confirmArrivalLocked` 里按**中文名**找行为：
  `textValue(record.fields?.[behaviorTable.fields.name]).trim() === '采购入库'`，`length !== 1` 直接抛。
- 她生产表「行为管理」（20 条）里那条是：**行为名称 =「入库」· 行为编码 = `PURCHASE_IN` · 库存方向 = 增加 · 所属环节 = 采购**；**表里没有一条叫「采购入库」** ⇒ 必然抛错。
- ⭐ 本仓已有正确范式：`inventoryService.resolveStockBehavior` 按 `fields.code` 匹配。

## 1. ⚠️ 与任务书口径的一处**不一致**（如实报告，已按事实实现）

任务书写着「查 `inventoryService` 的 `MOVEMENT_*` / `STOCK_MOVEMENTS` 注册表里 采购入库 对应的编码 —— 生产表里是 `PURCHASE_IN`」。
**实读代码：注册表里没有 `PURCHASE_IN`。** 注册表里那条叫 `MOVEMENT_PURCHASE_INCREASE = 'STOCK_PURCHASE_INCREASE'`，
生产表里它对应的是**库存环节**的「采购增加」，**不是**采购环节的那条「入库 / `PURCHASE_IN`」。

生产「行为管理」表按「所属环节」分成两套编码（`docs/todo-behavior-lexicon-sale-cash.md` 第 1 节，2026-10-07 实读）：

| 所属环节 | 编码 | 这条行为是干什么的 |
| --- | --- | --- |
| 采购 | `PURCHASE_ORDER` 报货 · **`PURCHASE_IN` 入库** · `PURCHASE_RETURN` 退货 | 单据层面的采购动作 |
| 库存 | `STOCK_SALE_DECREASE` 销售减少 · **`STOCK_PURCHASE_INCREASE` 采购增加** · … | 库存引擎语义（`STOCK_MOVEMENTS` 注册表） |

「采购入库」表上的「采购行为」挂的是**采购环节**那条 ⇒ 正确编码 = `PURCHASE_IN`。
若改成 `MOVEMENT_PURCHASE_INCREASE`（`STOCK_PURCHASE_INCREASE`），等于把入库行挂到**另一条行为记录**上，是行为变化（不是本次要的"只换查找方式"）。
⇒ 实现方式：把 `PURCHASE_IN` 收进**一个**配置常量（`server/src/config/purchaseBehaviors.js`），全仓只有这一处字面量；
**不**塞进 `STOCK_MOVEMENTS`（它不是库存动作，塞进去会污染 `validateStockBehaviors()` 的闸门语义）。

## 2. 验收标准（改完之后应该是什么样）

### A. 行为管理：按编码找，不按中文名

| # | 验收标准 | 判据 |
| --- | --- | --- |
| A1 | 生产表现状（名称=「入库」、编码=`PURCHASE_IN`、**没有**「采购入库」这个名字）下，她点「是」**入库成功**，不再抛"必须且只能有一条记录" | 测试：行为表只有 `PURCHASE_IN`/名称「入库」→ 入库行写出、库存调用发生 |
| A2 | 查找**只**按「行为编码」，中文名随便改都不影响 | 测试：名称「入库」与名称「采购入库」两条用例结果一致 |
| A3 | 编码 **0 条** → **如实抛错**（不静默、不放行），文案里带编码、告诉她补哪条 | 测试：`behavior: []` → reject，消息含 `PURCHASE_IN` |
| A4 | 编码 **≥2 条** → **如实抛错**（不任取第一条） | 测试：两条同编码 → reject，消息含「重复/只能有一条」 |
| A5 | 只有别的编码（例如 `STOCK_PURCHASE_INCREASE`）→ **抛错**，不许拿库存环节那条顶替 | 测试：只给 `STOCK_PURCHASE_INCREASE` → reject，且不写任何入库行 |
| A6 | 源码级防漂移：`confirmArrivalLocked` 里**不再**按中文名比较；改走共享常量；查找用的编码 = 配置里那**一个**常量 | 测试：读源码断言 |
| A7 | 「库存方向」核对（**只核，不改表**）：`PURCHASE_IN` 方向=增加，`STOCK_MOVEMENTS['STOCK_PURCHASE_INCREASE']` 方向=增加 → **一致**；但两条**不是同一条记录**，不许互相替代 | 测试 + 本文档第 3 节 |
| A8 | **用户可见文案**里的中文名一个字不动（卡片标题、群里回话、`SALE_RETURN: '退回入库'` 这类标签） | 只改"按名找记录"那一处 |

### A-2. 同类排查结论（全仓扫「按行为中文名匹配」）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| `purchaseWebhookService.confirmArrivalLocked`（原 3225 行） | ❌ **按中文名** `fields.name === '采购入库'` | ✅ 本次改为按编码（唯一一处"按名找行为记录"） |
| `inventoryService.resolveStockBehavior` / `resolveSamplePromotionBehavior` | ✅ 已按 `fields.code` | 不动 |
| `v1ReferenceResolver.resolveBehavior` / `resolveSalesTradeType` | ✅ 已按 `code` | 不动 |
| `purchaseReportBehaviorPolicy.classifyReportBehavior` | ⚠️ 名称含「退货」是**兜底信号之一**，但它**不是"按名找记录"**（记录已经由关联字段指好了，这里只做分类，且编码优先、读不到退回顾问申请） | 不动（属用户/规则口径，改它是行为变化） |
| `v1ReferenceResolver.resolvePaymentMethod` / `resolveSupplier`、`larkMvpService.listAccessories` / `listGroupBuyVouchers`、`secondDeliveryService.paymentMethodNames` | 按 **name** 找，但那几张表**本来就是按名字录的**（收款方式 / 供应商 / 配品 / 券目录），不是"行为管理" | 不动 |
| `larkCards.js` 的 `SALE_RETURN: '退回入库'` 等中文标签 | 用户可见文案 | 🔴 不动 |

### B. 点到货卡片：失败/成功都要有【可见反馈】

现状（改前，读代码得到的事实）：

| 场景 | 改前做了什么 | 她看得见吗 |
| --- | --- | --- |
| 点「是」→ 入库抛错 | `logError('purchase.arrival.reconcile.confirm_failed')` + `safeReplyText(this.replyTarget(event,task), '入库没成功：…')`（**不带 `threadId`** ⇒ 不带 `reply_in_thread`，不落话题）+ toast(error)。**卡片原样不动** | ❌ 卡片不变、toast 一闪而过 ⇒「点了没反应」 |
| 点「是」→ 「采购到货」建行失败 | **只 toast**（连回文字都没有），记 `arrival_create_failed` | ❌ |
| 点「是」但任务没有计划 / 任务找不到 | **只 toast** | ❌ |
| 点「是」→ 成功 | 回文字（**同样不带 `threadId`**）+ 卡片 patch 成绿色终态 | ⚠️ 卡片会变，但回话可能不落话题 |
| 点「否」 | 回文字（**不带 `threadId`**）+ 卡片**不动**（有意：她还能再点「是」） | ⚠️ 同上 |

| # | 验收标准 | 判据 |
| --- | --- | --- |
| B1 | 点「是」入库抛错 → **那张卡片被 patch 成红色终态**，文案含「入库没成功：<错误原文>」+ 下一步提示（可配） | 测试：`updated` 1 条、`header.template==='red'`、note 含错误原文、无按钮 |
| B2 | 同一失败**同时**在话题里回一条文字（带 `threadId` ⇒ `reply_in_thread`），文案与卡片同源、可配 | 测试：`replied` 1 条、`options.threadId` 有值 |
| B3 | 失败日志不破坏：仍是 `purchase.arrival.reconcile.confirm_failed`（error，含原文）；新增 `purchase.arrival.reconcile.failure_notice`（含 `card_patched`/`replied`）——"她到底看没看到"从此可核 | 测试：捕获日志断言两条事件 |
| B4 | **不把失败写成成功**：任务状态停在 `posting`（可从断点重试），返回 toast 仍是 `error` | 测试 |
| B5 | 「采购到货」建行失败 → 同样 patch 卡片 + 回文字（不再只 toast） | 测试 |
| B6 | 任务找不到 / 还没算出计划 → 同样 patch 卡片 + 回文字（不再只 toast） | 测试 |
| B7 | 重复点「是」（已入库）→ 卡片 patch 成绿色终态（幂等、不重复入库）；**不再只 toast** | 测试：入库行数不变 |
| B8 | 成功路径：卡片绿色终态 + 回文字，两者都回到**本任务的话题**（`threadId`） | 测试：`options.threadId === 'omt_1'` |
| B9 | 所有失败/成功文案都来自 `config/arrivalConversation.js`，改文案不碰逻辑 | 测试：覆盖配置后文案跟着变 |
| B10 | 失败文案保留错误原文（`{error}` 插值），不吞、不美化 | 测试 + B1 |
| B11 | 点「否」**保持卡片有按钮**（她还能再点「是」，这是既定口径），只补 `threadId` 让那句回话落回话题 | 既有用例「点「否」之后再点「是」」不放宽 |

### C. 纪律

| # | 验收标准 |
| --- | --- |
| C1 | 🔴 不部署（无 `deploy_*.sh` / `pm2` / 服务器操作）、不写生产表 |
| C2 | 独立 worktree + 临时 `.env` 软链（验完删） |
| C3 | 全量 `node --test --test-concurrency=1` 连跑 **2 次**，`fail 0`；且**不在主工作区跑** |
| C4 | 既有断言**一条都不放宽** |
| C5 | `gh pr checks` 看到 `CLEAN`；**不用 `--admin`**；只开 PR，不合并 |

## 3. A7 的核对结论（方向语义，只核不改）

| 记录 | 所属环节 | 编码 | 注册表声明的方向 | 生产表方向 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 「入库」 | 采购 | `PURCHASE_IN` | —— （**不在** `STOCK_MOVEMENTS`：它是"采购行为"，只挂单据关联） | 增加 | 与库存引擎"增加"一致，不冲突 |
| 「采购增加」 | 库存 | `STOCK_PURCHASE_INCREASE` | `direction: '增加'`（`MOVEMENT_PURCHASE_INCREASE`） | 增加 | 与注册表一致 |

⇒ **两张表两条记录，方向都是"增加"，语义一致**；入库行挂前者、库存流水由 `InventoryService` 挂后者。
🔴 不改表、不改方向语义。

## 4. 改完之后的行为（实现摘要）

- `server/src/config/purchaseBehaviors.js`（新）：`PURCHASE_BEHAVIORS.INBOUND = 'PURCHASE_IN'` —— 采购环节行为编码的**唯一**来源。
- `purchaseWebhookService.confirmArrivalLocked`：`fields.code === PURCHASE_BEHAVIORS.INBOUND`；0 条 / ≥2 条分别抛**可执行**的错。
- `config/arrivalConversation.js`：新增可配失败文案（`replies.inboundFailed` / `arrivalCreateFailed` / `taskMissing`、`card.failedTitle`）。
- `purchaseArrivalConversationService`：
  - 新增"可见失败"出口：patch 卡片（红色终态）+ 回文字（带 `threadId`）+ 日志；
  - 点「是」的四条失败路径与「重复点」路径都走它；
  - 成功路径的回话补 `threadId`；点「否」只补 `threadId`，卡片不动。

## 5. 逐条对照（改完实测，2026-10-07 上海时间）

| # | 结论 | 证据（测试 / 事实） |
| --- | --- | --- |
| A1 | ✅ | `入库①：行为表里只有编码 PURCHASE_IN、**没有**中文名「采购入库」→ 照样入库（她的现场）` |
| A2 | ✅ | `入库②：中文名乱改都不影响`（「采购入库」/「入库」/「随便叫一个名字」三种名字结果逐字一致） |
| A3 | ✅ | `入库③：编码 0 条 → 如实抛错`（错误含 `PURCHASE_IN`；入库行 0、库存 0 调用） |
| A4 | ✅ | `入库④：编码重复 → 如实抛错，不任取第一条` |
| A5 | ✅ | `入库③` 里行为表**只给** `STOCK_PURCHASE_INCREASE` → 照样抛错（不顶替） |
| A6 | ✅ | `入库⑤：源码级钉子`（`confirmArrivalLocked` 里无 `fields.name`、无 `'采购入库'` 字面量、无 `PURCHASE_IN` 字面量，只有 `PURCHASE_BEHAVIORS.INBOUND`） |
| A7 | ✅ | `入库⑥`（`PURCHASE_BEHAVIORS.INBOUND !== MOVEMENT_PURCHASE_INCREASE`）＋ 本文第 3 节 |
| A8 | ✅ | 只改了"按名找记录"一处；`larkCards` 的中文标签、卡片/回话文案一个字没动 |
| B1 | ✅ | `可见失败①`：`updated[0].card.header.template === 'red'`、标题「采购到货核对没成功」、note 含错误原文、无按钮 |
| B2 | ✅ | `可见失败①`：`replied[0].options.threadId === 'omt_1'`，且回话内容与卡片 note **同源** |
| B3 | ✅ | `可见失败①`：`confirm_failed`（error，含 `PURCHASE_IN`）＋ `failure_notice`（`card_patched:true`/`replied:true`）两条都在 |
| B4 | ✅ | `可见失败①`：toast 仍 `error`；任务停在 `posting`；入库行 0 |
| B5 | ✅ | `可见失败③：「采购到货」这一行都没建成 → 也 patch 卡片 + 回文字` |
| B6 | ✅ | `可见失败④`（任务找不到）＋ `可见失败⑤`（还没算出计划，橙色，`toast.type === 'info'`） |
| B7 | ✅ | `可见终态⑥：重复点「是」→ 卡片再 patch 成绿色终态`（库存/入库行数不变） |
| B8 | ✅ | `可见终态⑦：成功 → 终态卡与回话都落回本话题` |
| B9 | ✅ | `可见失败②：失败文案可配`（`replies.inboundFailed` 覆盖后 toast/回话/卡片同步变） |
| B10 | ✅ | `可见失败①②`：`{error}` 真被填上（断言 `includes('{error}') === false`），错误原文完整保留 |
| B11 | ✅ | `点「否」`用例新增断言 `harness.updated` 为空（**卡片保留按钮**）＋ `threadId`；`点「否」之后再点「是」`原断言不放宽 |
| C1 | ✅ | 全程没有 `deploy_*.sh` / `pm2` / 服务器操作；没有写任何表（本机也没有生产凭证） |
| C2 | ✅ | 独立 worktree `.local/fix-behavior-code-and-arrival-feedback`（分支 `fix/behavior-code-lookup-and-arrival-failure-feedback`）＋ 临时 `.env` 软链 |
| C3 | ✅ | `node --test --test-concurrency=1` 连跑 2 次：**965 tests / pass 965 / fail 0**（两次一致）；都在 worktree 里跑，**没在主工作区跑全量** |
| C4 | ✅ | 既有用例一条没改语义（只给 `点「否」` **加**断言）；旧文案的断言本来就不存在（已 grep 核过） |
| C5 | ⏳ | 见 PR（`gh pr checks`）—— 本文件写完时 PR 刚开 |

## 6. 新增测试钉住了什么（14 条）

`server/test/purchaseWebhookService.test.js`（+6）：
1. 改名后照样入库（她的现场）；2. 中文名随便改结果一致；3. 编码缺失如实抛错且不写表/不动库存；
4. 编码重复如实抛错且不任取一条；5. 源码级：按编码、用共享常量、service 里不许再出现字面量；
6. 编码单一来源与"两个环节不是同一条行为"的防漂移断言。

`server/test/arrivalConversation.test.js`（+8）：
失败①（卡片红色终态+回话+threadId+两条日志+toast error+停在 posting）、失败②（文案可配）、
失败③（到货行建失败）、失败④（任务找不到）、失败⑤（还没算出计划，橙色）、
终态⑥（重复点「是」幂等且可见）、终态⑦（成功两处都落回话题）、终态⑧（已入库后又点「否」→ 绿色终态、不改账）。
另给既有 `点「否」` 用例**加**了"卡片必须保留按钮"的断言。

## 7. 没做到 / 不确定

1. **没有做真机验证**：按她的命令**禁止部署**，所以"她点一次就看得见"这件事
   只能在单测级（记录型 gateway）证明；线上的 `im.message.patch` 权限/接口是否真的能改卡片，
   仍然要靠一次真实点击才能最终确认。⚠️ 若线上 patch 一直失败，`failure_notice` 里的
   `card_patched:false` 会把这件事暴露出来，同时**那条文字回话**（`reply_in_thread`）仍是兜底。
2. **`PURCHASE_IN` 与 `STOCK_PURCHASE_INCREASE` 的分工**是**按代码事实 + 测试 mock + 文档**推断的
   （`PURCHASE_IN` = 采购环节的「入库」，正是「采购入库」的「采购行为」要挂的那条）。
   ⚠️ 没有读生产表验证（本机没有生产凭证、且纪律禁止写生产；只读核表也不在本任务授权范围内）。
   若她确认那条「采购入库」行挂的其实是 `STOCK_PURCHASE_INCREASE`，**只需改
   `config/purchaseBehaviors.js` 里那一个常量**，逻辑一行都不用动。
3. 「还没算出计划」（`not_confirmed_yet`）这条路径**在她的真实操作里不该出现**
   （卡片只有在算出计划之后才会发），这里只是把"点了没反应"的兜底补上，颜色用橙色区分于失败。

