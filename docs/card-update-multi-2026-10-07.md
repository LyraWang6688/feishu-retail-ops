# 「点了卡片没反应」根因修复：`config.update_multi = true`（2026-10-07）

> 结论先行：**这不是后端没跑，是卡片本身不是「共享卡片」。**
> 后端 `im.v1.message.patch` 明明成功（`lark.sales.card.update.succeeded`，342ms），
> 但她的界面上卡片纹丝不动 —— 因为飞书对**独享卡片**（`update_multi: false`，默认值）
> 的更新**只有操作者自己看得到**，她把卡片发在群里、她不是"操作者"。

---

## 一、现场事实（真机）

她点销售卡片「确认」后的日志：

```
07:44:16.533  lark.card.received { action: confirm_sale }
07:44:16.879  lark.sales.card.update.succeeded { stage:"processing", duration_ms:342 }
```

接口**成功**，人的眼睛看到的是"只有一个 toast、卡片没动"。她原话：

> 「**我点了，只是有个toast，卡片还是没有反应！**」

## 二、官方文档逐字（2026-10-07 curl 拉取）

- `im-v1/message/patch.md` 第 19 行：
  > 「你需在更新**前后**卡片的 `config` 属性中，均显式声明 `"update_multi":true`
  > （表示卡片为共享卡片，卡片的更新对所有接收的用户可见）」
  第 24 行：「不支持更新仅特定人可见的卡片」；
  第 25 行：「仅支持更新 14 天内发送的消息」
- `card-configuration.md`：
  > 「`update_multi`：true=共享卡片…；false=独享卡片，仅操作用户可见卡片的更新内容；**默认 false**」

⇒ **发送时（"更新前"）与 patch 的 payload 里（"更新后"）都要有 `update_multi: true`。**
本仓改动前 `update_multi` **全仓 0 命中** ⇒ 根因成立。

## 三、验收标准（先写「改完之后应该是什么样」，再动手）

| # | 验收标准 | 怎么验 |
| - | -------- | ------ |
| ① | 会被 patch 的 **14 张卡**，其 builder **直出**（= 首次发出的"更新前"那份）`config.update_multi === true` | 新增测试逐卡断言 |
| ② | 三条 patch 出口**真实打到飞书**的 `data.content`（JSON 解析后）里 `config.update_multi === true` | 用假 client 抓真实 payload |
| ③ | `secondDeliveryCard` **经 `settleSecondDeliveryOrder` 变换后**那份仍带该字段（最易漏：走深拷贝重建） | 变换后再断言 |
| ④ | **刻意不动**的 3 张卡（`saleLookupCard` ×2 分支 / `purchaseRequestConfirmationCard` / `salesDailyReportCard`）**不出现**该字段 | 反向断言 |
| ⑤ | 卡片**可见内容零变化** —— `header` / `elements` 逐字与改动前相同 | 逐字 deepEqual |
| ⑥ | 既有断言**一条不放宽**（唯一被触碰的是 `salesProcessingCard.test.js` 的整卡 deepEqual，**只允许 `config` 多一个字段**，仍是整卡精确 deepEqual） | 全量测试 |
| ⑦ | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** | CI + 本地各 2 次 |
| ⑧ | **回调链路不动**：仍走异步 `im.v1.message.patch`，**不改成"回调响应里返回新卡"** | 代码 review |

### ⑦ 的补充：回调链路口径（Lead 已拍板）

本仓走的是 `im.v1.message.patch`（**不是**"3 秒内回新卡"、**不是**"30 分钟 token 延时更新"），
它的**唯一硬前提**就是"更新前后都要 `update_multi`" ⇒ **加完字段，异步 patch 够用**，
延迟 = 一次 patch 往返。**不改成**"回调响应里返回新卡"（会撞 3 秒预算、且与终态 patch 打架）。

## 四、哪张卡会被 patch —— 全清单

### 4.1 要加 `update_multi` 的 14 张（13 个 builder / 13 行 `config`）

| # | builder | `larkCards.js` 行 | 谁 patch 它 | patch 出口 |
| - | ------- | ----------------- | ----------- | ---------- |
| 1 | `salesConfirmationCard` | 384 | 修改/取消/重试时改同一张卡 | `patchCardMessage` |
| 2 | `salesStatusCard` | 410 | 取消 / 待修正 / 部分交付 / 已入账 / 重复终态 | `updateInteractiveCard` |
| 3 | `salesProcessingCard` | 445 | 点确认后那一次立即更新（`stage: 'processing'`） | `updateInteractiveCard` |
| 4 | `sampleReplacementCard` | 464 | 补样品选择/刷新 | `updateInteractiveCard` |
| 5 | `sampleReplacementStatusCard` | 469 | 补选结果 | `updateInteractiveCard` |
| 6 | `sampleReplacementProcessingCard` | 475 | 补选处理中 | `updateInteractiveCard` |
| 7 | `purchaseArrivalReconcileCard`（是/否） | 622 | 她补充/修正到货 → **重算并更新那一张** | `patchCardMessage`（经 `safeUpdateCard`） |
| 8 | `purchaseArrivalReconcileStatusCard` | 635 | 点「是」成功 / 入库失败 → 终态 | `patchCardMessage`（经 `safeUpdateCard`） |
| 9 | `purchaseStatusCard` | 655 | 采购申请 处理中 / 已生成 / 未完成 / 已取消 | `updatePurchaseActionCard` |
| 10 | `afterSalesConfirmationCard` | 767 | 改回库状态（`stage: 'restock_chosen'`） | `updateInteractiveCard` |
| 11 | `afterSalesResultCard` | 799 | 售后完成终态 | `updateInteractiveCard` |
| 12 | `afterSalesStatusCard` | 831 | 售后状态回执 | `updateInteractiveCard` |
| 13 | `afterSalesRetryCard` | **无自己的 `config` 行** | 失败重试卡 | `updateInteractiveCard` |
| 14 | `secondDeliveryCard` | 896 | 点「成交」→ 把那一单的按钮换成灰字 | `updateInteractiveCard`（经 `settleSecondDeliveryOrder`） |

⚠️ **第 13 张 `afterSalesRetryCard` 没有自己的 `config` 行**：它在 `:820` 调
`afterSalesConfirmationCard(taskId, plan)` 后**只改 `header` 与 `elements`**，`config` 是继承来的
⇒ 改 `afterSalesConfirmationCard`（第 10 行）**自动覆盖它**，所以只需改 **13 行**。

⚠️ **`secondDeliveryCard` 的坑**：patch 打的是 `settleSecondDeliveryOrder(card, …)` 变换后那份，
它内部 `JSON.parse(JSON.stringify(card))` **深拷贝重建** ⇒ `config` 会被原样带过去。
测试必须**对变换后的那份**断言（③），不能只测 builder 直出。

### 4.2 刻意**不动**的 3 张（不出现 `update_multi`）

| builder | 位置 | 为什么不动 |
| ------- | ---- | ---------- |
| `saleLookupCard` | `larkCards.js:503` / `:523`（两个分支） | **只发不 patch**（`saleLookupService.replyCardByTask` / `afterSalesFlowService.replyCardByTask` 都是发新卡 + 存 `card_message_id`，从不 patch） |
| `purchaseRequestConfirmationCard` | `larkCards.js:547` | **无调用方**（免确认链路已退场，`git log -S` 可查） |
| `salesDailyReportCard` | `utils/salesDailyReportCard.js:76` | **只 `create` 从不 patch** |

⇒ 反向断言钉住：「刻意不动」不是"忘了"，是**有意的**，将来谁顺手加上会在这条测试上挂掉。

### 4.3 三条 patch 出口（SDK 层只有三处）

| 出口 | 位置 | 覆盖的卡 |
| ---- | ---- | -------- |
| `LarkMvpService.patchCardMessage` | `larkMvpService.js:475` | 到货核对卡（经 `arrivalConversation.updateCard` 注入）、销售确认卡 |
| `updateInteractiveCard`（共享基础设施） | `infrastructure/interactiveCardFeedback.js:10` | 销售/样品/售后/第二次交付（`larkMvpService.updateSalesActionCard` / `updateAfterSalesCard`、`sampleReplacementService.updateCard`、`secondDeliveryService`） |
| `PurchaseWebhookService.updatePurchaseActionCard` | `purchaseWebhookService.js:2963` | 采购申请状态卡（自己一份 patch） |

三处都是 `JSON.stringify(card)` 整卡替换 ⇒ 只要 builder 带字段，payload 就带字段。

## 五、实现（配置先行 · 唯一组装点）

本仓改动前有 **16 处内联** `config: { wide_screen_mode: true }`、**没有公共点**。
新增**唯一组装点**（放在卡片模块 `utils/larkCards.js` 顶部，因为 13 个 builder 都在这里）：

```js
// 飞书「更新卡片」的唯一硬前提：patch 前后都必须是共享卡片。
const patchableCardConfig = () => ({ wide_screen_mode: true, update_multi: true });
```

**为什么是工厂函数，而不是共享的冻结常量**：
`const X = Object.freeze({...})` 会让 14 张卡**共用同一个对象引用**。将来某张卡要单独调
`card.config` 时，改动会**串到所有卡片上**；而在非严格模式下**改不动、也不报错**，
属于最难查的静默失效。工厂函数每张卡拿到**自己的一份**，语义上"每张卡各自独立"，
仍然只有一个字段清单的组装点（DRY 不丢）。

13 行改成 `config: patchableCardConfig(),`（`salesStatusCard` 等箭头函数直出 `config:` 的写法保持原样）。

## 六、逐条对照（实测结果）

改动文件：`server/src/utils/larkCards.js`（+ 既有断言、+ 新测试），**没有动**任何 patch 出口
（`larkMvpService` / `interactiveCardFeedback` / `purchaseWebhookService` / `secondDeliveryService`）。

| # | 验收标准 | 结论 | 证据 |
| - | -------- | ---- | ---- |
| ① | 14 张卡直出带 `update_multi` | ✅ 达标 | 新增用例「14 张会被 patch 的卡片…」（14 张逐张 `deepEqual` 整个 config）；另用**改动前**的模块渲染同一批输入，14 张的 `config.update_multi` 全部是 `undefined` ⇒ 根因在改动前确实存在 |
| ② | 三条 patch 出口的真实 payload 带该字段 | ✅ 达标 | 新增 3 条用例分别打桩 `client.im.v1.message.patch`，解析 `data.content` 后 `deepEqual` 整个 config：`patchCardMessage`（到货核对卡）/ `updateInteractiveCard`（出事那张 `salesProcessingCard`）/ `updatePurchaseActionCard`（`purchaseStatusCard`） |
| ③ | `settleSecondDeliveryOrder` 变换后仍带 | ✅ 达标 | 新增用例：变换后 `config` 仍在；并**再走一次真实出口**抓 payload。深拷贝（`JSON.parse(JSON.stringify(card))`）确实把字段带过去了 |
| ④ | 刻意不动的卡不出现该字段 | ✅ 达标 | 新增用例覆盖 **4 张**：`saleLookupCard` 两个分支、`purchaseRequestConfirmationCard`、`salesDailyReportCard`（只 `create` 从不 `patch`）⇒ `'update_multi' in config === false` |
| ⑤ | 卡片可见内容零变化 | ✅ 达标 | ①用 `git show origin/main:server/src/utils/larkCards.js` 取**改动前**模块，对 **17 张卡**逐张 `deepEqual({header, elements})` —— **全部逐字相同**；②把改动前那份冻结成 `server/test-support/cardVisibleGolden.json`，新增用例每次跑都对照它；③另断言顶层键只有 `config/header/elements` |
| ⑥ | 既有断言一条不放宽 | ✅ 达标 | 全仓只有 `server/test/salesProcessingCard.test.js:120` 那条整卡 `deepEqual` 被触碰，**仍是整卡精确 deepEqual**，只有 `config` 期望值从 `{wide_screen_mode:true}` 变成本次的 `{wide_screen_mode:true, update_multi:true}`；`header`/`elements` 一个字节都没动 |
| ⑦ | 全量连跑 2 次 `fail=0` | ✅ 达标 | 本分支 worktree 内 `node --test --test-concurrency=1`：**第 1 次 973/973 pass、fail 0；第 2 次 973/973 pass、fail 0** |
| ⑧ | 回调链路不动（不改成"回调里回新卡"） | ✅ 达标 | **零改动**：`larkMvpService.patchCardMessage` / `interactiveCardFeedback.updateInteractiveCard` / `purchaseWebhookService.updatePurchaseActionCard` / `secondDeliveryService` 与 `routes/larkEvents.js` **一行未改**。仍走异步 `im.v1.message.patch`，延迟 = 一次 patch 往返 |

### ⑥ 那条既有断言的最终形态（改动后逐字）

`server/test/salesProcessingCard.test.js`（新增的注释 + 期望值里多出来的那个字段）：

```js
  // 逐字钉住：元素类型仍是 markdown（没有 <font> 包裹）、note 仍是她熟悉的那句。
  //
  // ⚠️ 2026-10-07：这张卡片的 `config` **有意多了一个 `update_multi: true`**。
  //    断言仍然是**整卡精确 deepEqual**（没有放宽成分字段断言），只是把多出来的那个
  //    字段写进期望值 —— header / elements 一个字节都没动。
  //    为什么必须加（详见 utils/larkCards.js 的 `patchableCardConfig` 注释）：
  //      飞书 `im.v1.message.patch` 要求「更新**前后**卡片的 config 中均显式声明
  //      `update_multi: true`」，否则更新**只有操作用户自己可见** ——
  //      这正是线上"点了确认、接口成功、卡片纹丝不动"的根因。
  //    ⇒ **对她可见的内容（header / elements）逐字不变**（= 她满意的部分）；
  //      `config` 加字段只是"更新能不能被她看见"的必要条件，与显示内容无关。
  assert.deepEqual(card, {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '销售订单已入账' } },
    elements: [
      { tag: 'markdown', content: '1. A100 38码 × 1 ￥99\n2. A100 39码 × 1 ￥99' },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。' }] },
    ],
  });
```

### 新增测试钉住了什么（`server/test/cardUpdateMulti.test.js`，8 条）

| 用例 | 钉住的契约 |
| ---- | ---------- |
| 「14 张会被 patch 的卡片…」 | 14 张卡**直出**的 `config` **逐字**等于 `{wide_screen_mode:true, update_multi:true}`（多/少一个字段都挂） |
| 「刻意不 patch 的卡片…」 | 4 张只发不改的卡 `config` **逐字**是 `{wide_screen_mode:true}`，且 `'update_multi' in config === false` |
| 「卡片可见内容零变化…」 | 17 张卡的 `header`/`elements` 与**改动前冻结的 golden** 逐字相同；顶层只允许 `config/header/elements` 三个键 |
| 「patch 出口 ①…」 | `LarkMvpService.patchCardMessage` 真实调 SDK 的 `data.content` 解析后 config 正确 |
| 「patch 出口 ②…」 | `updateInteractiveCard`（出事那条路径）同上 |
| 「patch 出口 ③…」 | `PurchaseWebhookService.updatePurchaseActionCard` 同上 |
| 「secondDeliveryCard 经 settleSecondDeliveryOrder…」 | 深拷贝变换后仍带；`header` 逐字不变；再走真实出口的 payload 也带 |
| 「现场复现：她点「确认」后…」 | 走 `handleCardAction` 真实链路，抓**两次**真实 patch payload（processing + posted）都带 ⇒ 直接复现并钉住她的现场 |

### 一个实现选择（说明理由）

**用工厂函数 `patchableCardConfig()`，不用共享的冻结常量** `Object.freeze({...})`：
共享常量会让 14 张卡共用**同一个对象引用**——将来某张卡单独调 `card.config` 会**串到所有卡**，
而在非严格模式下对冻结属性赋值**既改不动、也不报错**（最难查的静默失效）。
工厂函数每张卡拿到自己的一份，字段清单仍只有一处定义（DRY 不丢）。

## 七、⚠️ 老卡片可能仍不刷新（必须如实说，不许当作"已解决"）

官方要求「更新**前后**都要有 `update_multi`」。**部署前已经躺在群里、正等她点的老卡**，
发出时 `config.update_multi` 是 `false`（默认）⇒ 按文档字面**可能仍然不动**。
⇒ 本修复只保证**部署后新发的卡**。
要核清必须**真机试老卡**；本机**禁部署、禁写生产表** ⇒ 目前只能说
「**我还没查到这一步**」，**不下结论**。
