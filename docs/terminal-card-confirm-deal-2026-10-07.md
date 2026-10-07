# 「已入账」终态卡上的【确认成交】按钮（预定 / 现货未收清）

> 口径来源：业务负责人 2026-10-07 的口述（逐字见第 1 节），
> 落地方式是她拍板的 **甲**：「把【确认成交】按钮**做在那张已经在你手里的卡上**
> （就是"销售订单处理中/已入账"那张**终态卡**）—— **不新发消息**，你在原卡上点」。
>
> 本文件 = **验收标准（先写）+ 实现 + 逐条对照 + 证据**。
> 第 3 节是**动手前**对既有 complete 路径的核查结论（任务书明确要求如实报告）。

## 1. 业务负责人的口径（逐字）

> 「如果是这样的话，比方说**对于预付的单子或者代收的单子**，我们是否可以在**确定之后**，
>  给用户发送一个**消息卡片**？消息卡片的内容是确认"**是否成交**"。**如果点击"是"**（选项只能点"是"），
>  后续流程就继续。」
>
> 「一旦判定这一单是**预订或者现货未收**，入账之后就会给用户发一个消息卡片，确认该笔交易是否成交。
>  **只有当用户点击"是"的时候，才会触发我们后续的流程**。」
>
> ★ 实现方式（**甲**）：「把【确认成交】按钮**做在那张已经在你手里的卡上**……**不新发消息**，你在原卡上点」

⇒ 「卡片」= 机器人**已经发出去的那张**「销售订单已入账」终态卡（`stage: 'posted'`）；
   不新增任何"是否成交"的独立消息 / 新卡片。

## 2. 边界（不许碰的东西）

| 不许碰 | 原因 / 本次结果 |
|---|---|
| `purchaseWebhookService` / `purchaseArrivalConversationService` / `v1BitableSchema` / 到货链路 | 另有代理在改（`feat/arrival-landing-on-batch` 刚合，`feat/purchase-return-unified-parsing` 在跑）⇒ **一行未动** |
| `pendingDealPush*` | 任务书明确排除 ⇒ **一行未动** |
| `app.js` | 任务书明确排除；本次**不需要**改（没有新路由 / 新定时器 / 新 store）⇒ **一行未动** |
| 销售判据（现货 / 预定、颜色候选、金额口径） | 判据仍由 `config/salesTradeTypePolicy` / `config/salesMovements` 提供，本次**只引用**，不新立判据 |
| 业务表 | **一个字都没写**（本次只在本地任务记录 `server/data/lark_mvp_tasks/` 上落 `confirm_deal_*` 状态） |

其余卡片（确认卡 / 处理中卡 / 到货卡 / 采购卡 / 售后卡 / 第二次交付提醒卡）**输出逐字不变**（AC-10）。

## 3. ⭐ 动手前核查：既有 complete 路径的**实际行为**

任务书要求先核 `services/salesThreadProgressService.js` 的 complete 分支，
并对照 `AGENTS.md` 第 16 节记的那个已知缺口。**核查结论：两处缺口都已经修好了（2026-10-06 当天修的），
本次直接复用，没有改它的判断。**

核查对象 = `SalesThreadProgressService.applyComplete`（`src/services/salesThreadProgressService.js`）
＋ `handle` 的状态记录（同文件）：

| 第 16 节记的缺口 | 现状（改动前，`origin/main` = `d2b691a`） | 证据 |
|---|---|---|
| ① 「什么都没写就**不许**记成成功」 | ✅ **已修**。各 `apply*` 用 `asked: true` 声明"只回问了一句"，`handle` 据此记 `PROGRESS_TASK_STATUS.ASKING`（`progress_asking`），**不是** `progress_applied` | `salesThreadProgressService.js:183-189`；`config/salesProgressIntake.js:113-122`；`test/salesThreadProgress.test.js` 的「⭐『已完毕』问不出收款方式」用例（断言 `progress_asking`） |
| ② 「**先把"货那一半"做掉**（未交付→已交付 + 扣库存），再就"钱"回问一句」 | ✅ **已修**。问不出收款方式时先调 `deliverUndelivered`（唯一销售扣库存入口 `SalesDeliveryService.deliver`），再回 `replies.completeAskMethod` | 同上（用例断言 `delivered.length === 1` ＋ 回话里有「已交付」） |

**另外两条核查（对本次实现有直接影响的）：**

1. 「成交」**只有一处实现**：`applyComplete` 把"钱 + 货"整体交给 `SecondDeliveryService.confirm`
   （点每日提醒卡的「成交」按钮走的也是它）。本类**不自己收钱、不自己扣库存**。
   本次的卡片按钮点击**就是转到 `applyComplete`**，没有另造一套。
2. ⚠️ **`SecondDeliveryService.confirm` 的顺序是"先收钱、再交货"**（`secondDeliveryService.js:83-85`
   的注释是这么写的，且是有意的：预定单"钱没记上就不该把货记成已交付"）。
   于是**预定单在货还没到时点「成交」**，会先把那条「未收款」写成「已收款」（含收款时间）、**然后**交付失败。
   ⇒ 这正是本次任务第 4 条要挡的「半成品账」：**货没到就一分钱都不该先记上**。
   本次的落地方式见第 5 节（`completeDealFromCard`：**有待收款时先做货**），
   **没有**去改 `SecondDeliveryService` 的顺序（它还被每日提醒卡那条链路用着，改它等于改别人的行为）。

## 4. ⭐ 验收标准（**动手前先写**）

### 卡片：按钮**只在需要它的单子上**出现

- **AC-1** 预定单（明细交易类型 = `SALE_PREPAID`，未交付）的「已入账」终态卡上**有**这个按钮。
- **AC-2** 现货单 + **有欠款**（`draft.owed` 非空，或已存在「未收款」占位）的终态卡上**有**这个按钮。
- **AC-3** **现货 + 已交付 + 已结清**（不欠钱、货也交了）的终态卡上**没有**这个按钮 ——
  卡面与改动前**逐字相同**（不打扰干净的单一）。
- **AC-4** 卡面上**只有一个**按钮，文案 `确认成交`；**没有**「取消 / 否 / 稍后」这类第二个选项。
  按钮文案、提示文案、已成交文案**全部来自 `config/`**（`SALES_CONFIRM_DEAL_*`），逻辑里不写死中文。

### 点击：走既有的「成交」那一套

- **AC-5** 点一下 → 走**既有**的 complete 分支（`SalesThreadProgressService.applyComplete`）：
  ① 未交付明细 → 已交付 **＋ 扣库存**；② 待收 → 已收（**含「收款时间」＝ 点击时刻**）；
  ③ 钱货两清后卡片刻变「已成交」。
- **AC-6** **幂等**：重复点 / 网络重试**不许**重复交付、**不许**重复扣库存、**不许**重复写收款；
  第二次返回「已经成交，无需重复处理」。
- **AC-7** ⭐ **预定单交付时库存不足（货还没到）→ 不许静默失败**：
  回话 / 卡片要**明确说清**（文案走配置，逐字见第 7 节），
  且**不写半成品账**：不写收款、不把明细写成「已交付」、不写库存、**卡片不变灰**（还要能再点）。
- **AC-8** 点成功后，**被点的那张卡**（不是新消息）被 patch 成「已成交」的样子：
  标题 `销售订单已成交` ＋ 一行 ✅ 已成交说明 ＋ 按钮消失；
  patch payload 里 `config.update_multi === true`（沿用既有 patch 机制与已修好的共享卡片配置）。
- **AC-9** **回调 3 秒内先响应**：`card.action.trigger` 的 handler **同步返回** toast，
  重活在 `setImmediate` 里跑 —— 沿用既有做法，**没有**把它拖成同步重活。

### 只改这张卡

- **AC-10** 除「已入账终态卡」外，其余卡片的输出**逐字不变**：
  确认卡 / 处理中卡 / 取消 / 待修正 / 到货卡 / 采购卡 / 售后卡 / 第二次交付提醒卡
  （`cardVisibleGolden.json` 的 17 张卡快照 + `cardUpdateMulti.test.js` 的 `config` 断言**一条都没放松**）。

## 5. 实现（关键 diff）

改动文件（4 个源文件 ＋ 2 个新文件 ＋ 1 个 `.env.example`）：

### ① 按钮**出现条件**：`src/config/salesConfirmDeal.js`（新）

```js
const needsConfirmDeal = ({ draft = {}, deliveryFailures = [] } = {}) => {
  if (Array.isArray(deliveryFailures) && deliveryFailures.length) {
    return { needed: true, reason: 'delivery_failed' };   // 上次交付失败过 = 货其实没交出去
  }
  const codes = items.map((item) => itemTradeTypeCode(item, draft?.trade_type_code));
  if (codes.some((code) => !deliversForTradeType(code))) {
    return { needed: true, reason: 'undelivered' };        // 预定：不交付
  }
  if (hasOutstandingMoney(draft)) return { needed: true, reason: 'unsettled' };  // 有欠款
  return { needed: false, reason: 'completed' };           // 现货已交付已结清 → 不打扰她
};
```

- 「货」那一维的判据**不写死编码**：`itemTradeTypeCode`（`config/salesTradeTypePolicy`）
  ＋ `deliversForTradeType`（`config/salesMovements`）—— 类型口径换掉时这里自动跟着走。
- 「钱」那一维**不拿「成交 − 已收」去猜**：入账层只在她**明说欠多少**时才补那条「未收款」占位
  （`salesOrderService`：「她说欠才算欠；后端不拿差额去猜是还价还是欠款」）
  ⇒ 「有未收款」⇔「`draft.owed` 非空」，所以按钮**不会出现在"其实没什么可做"的单上**。

### ② 按钮**画在哪**：`src/utils/larkCards.js`（`salesStatusCard` 多一个可选开关）

```js
const salesStatusCard = (draft, title, message, template = 'blue', options = {}) => ({
  ...
  elements: [
    { tag: 'markdown', content: itemLines(...) || '销售订单' },
    ...(options.productInfoGaps ? productInfoGapsElements(draft) : []),
    { tag: 'note', elements: [{ tag: 'plain_text', content: message }] },
    ...(options.confirmDeal ? confirmDealElements(options.confirmDeal) : []),   // ← 新增
  ],
});
```

`confirmDealElements({ salesEntryRecordId, draftId, settledAt })`：`settledAt` 有值 → 一行
「✅ 已成交（HH:MM 点击）」；否则 → 一行提示（可配，空串则不出）＋ **一个**按钮
（`确认成交`，动作名 `confirm_sale_deal`，取值带 `sales_entry_record_id` ＋ `draft_id`）。
**默认关** ⇒ 没显式打开的调用点逐字节不变（既有 golden 用例照旧全绿）。

### ③ 按钮**画在哪几个出口**：`src/services/larkMvpService.js`（判据只写一处，四处共用）

```js
confirmDealOptionFor(task, { deliveryFailures = [] } = {}) {
  const decision = needsConfirmDeal({ draft: task?.draft, deliveryFailures });
  logInfo('lark.sales.confirm_deal.card', { task_id, sales_entry_record_id,
    with_button: decision.needed, reason: decision.reason, delivery_failure_count });
  if (!decision.needed) return null;
  return { salesEntryRecordId: task.sales_entry_record_id, draftId: task.task_id };
}
```

四个「已入账终态卡」出口**都**传它（同一状态必须给出同一张卡）：
`posted`（绿色终态）· `duplicate_terminal`（她重复点确认）· `delivery_partial` ·
`delivery_failed`（橙色的"部分交付 / 交付待处理"）。**取消 / 待修正那两张不传**（原草稿不会入账）。

### ④ **点击接线**：`handleCardAction` → `handleConfirmDealAction` → 既有 complete 分支

```js
// larkMvpService.handleCardAction：放在 `if (!draftId) throw` **之前**，与销售草稿共用串行队列
if (action === SALES_CONFIRM_DEAL_ACTIONS.CONFIRM) {
  return this.cardActionQueue.run(draftId || String(value?.sales_entry_record_id || ''), () =>
    this.handleConfirmDealAction(value, operatorOpenId, event, context));
}
```

```js
// larkMvpService.handleConfirmDealAction（只做接线 + 幂等短路 + 卡片更新 + 如实回话）
const outcome = await this.threadProgress.completeDealFromCard({ task: clickTask });
const settled = !outcome.asked;          // asked = 只回问了一句、业务表一个字没写
...
if (settled) { await this.settleConfirmDealCard(task, event, config, context); ... }
```

```js
// salesThreadProgressService.completeDealFromCard：**有待收款时先做货**（防半成品账）
const pending = await this.pendingPaymentsFor(salesEntryRecordId);
if (pending.length) {
  const delivery = await this.deliverUndelivered(salesEntryRecordId, { correlation });
  if (delivery.delivered?.failures?.length) {
    await this.reply(task, this.confirmDeal.shortStock);      // 明确说清、**一个字节都不写**
    return { replied: true, asked: true, reason: 'short_stock', result: { failures } };
  }
  deliveredBefore = { count: delivery.count, detailRecordIds: delivery.detailRecordIds };
}
return this.applyComplete(task, { deliveredBefore });          // ← 与她说「已完毕 / 成交」同一条路
```

- `applyComplete` 多了一个**可缺省**的 `deliveredBefore`：只用来把**回话与日志**说全
  （"货已经在点之前做掉了"），**不碰任何写入、不改任何判断**；不传 = 逐字不变。
- 「有没有待收款」的取法统一到 `pendingPaymentsFor`（一处实现，两条链路共用），
  避免两边各写一个 `=== '未收款'` 而慢慢走歪。

### ⑤ **卡片更新**：`settleConfirmDealCard`

```js
const card = salesStatusCard(task.draft, config.settledTitle,
  fill(config.settledMessage, { orderNo: task.posting_result?.sourceNo || config.orderNoFallback }),
  'green',
  { productInfoGaps: true,
    confirmDeal: { salesEntryRecordId, draftId, settledAt: Date.now(), config } });
return this.updateSalesActionCard(task, event, card, { stage: 'confirm_deal_settled', ... });
```

- 走**既有**的 patch 出口 `updateInteractiveCard`（默认取回调里的 `open_message_id`
  = **她点的那张卡**）；`salesStatusCard` 本来就带 `update_multi: true`（共享卡片）。
- **重新渲染**而不是存一份旧卡：那张卡的输入（`task.draft` ＋ `posting_result.sourceNo`）
  就在本地任务上，重渲染的内容与原来逐字一致，只是按钮换成说明。
- 卡片改不动（撤回 / 权限）**永不影响成交结果**（成交这时已经写完；失败只记一条 warn）。

## 6. 逐条对照

| 验收标准 | 结论 | 钉住它的用例 |
|---|---|---|
| AC-1 预定单有按钮 | ✅ | `终态卡：预订单的「已入账」卡上有且只有…` |
| AC-2 现货有欠款有按钮 | ✅ | `终态卡：现货 + 有欠款 → 有按钮；…` |
| AC-3 现货已交付已结清**没有**按钮 | ✅ | 同上（第二段断言 `cardButtons === []` ＋ 卡面不含「确认成交」）；＋ `只改这张终态卡` 里"不带开关时一个按钮都没有" |
| AC-4 只有一个按钮、无取消/否、文案可配 | ✅ | `…卡上有且只有一个按钮`（断言按钮数 = 1、文案、无「取消/否/稍后/不成交」）＋ 两条配置用例（显式 config / `process.env` 两条路都换得动） |
| AC-5 点一下 → 已交付 + 扣库存 + 已收（含收款时间） | ✅ | `点【确认成交】预定单：未交付→已交付 + 扣库存 + 待收→已收（含收款时间）`；现货那条断言行 0 次扣库存 |
| AC-6 重复点不重复写 | ✅ | `幂等：同一张卡连点两次…`（写次数 / patch 次数 / 扣库存次数都不变）＋ `幂等（第二道）：任务状态被抹掉也拦得住…` |
| AC-7 库存不足 → 明确提示、不写半成品账 | ✅ | `预定单货还没到（库存不足）…`（断言回话含配置原文、`未收款` 未变、`收款时间` 为空、明细仍 `未交付`、卡片未变灰、任务状态 `confirm_deal_short_stock`）＋ `货到了再点一次：这次真成交` |
| AC-8 同一张卡 patch 成「已成交」 | ✅ | `点成功后：被点的那张卡被 patch 成「已成交」…`（`path.message_id === om_card`、标题、`update_multi`、按钮消失、**没有新发卡片**） |
| AC-9 回调 3 秒内先响应 | ✅ | `卡片回调：handler 同步返回 toast…`（同步断言 + 重活当时**还没跑完**） |
| AC-10 其余卡片逐字不变 | ✅ | 既有 `cardUpdateMulti.test.js`（17 张卡 golden ＋ 14 张的 `config`）＋ 本文件 `只改这张终态卡：…都没有这个按钮` |
| 附加：**多个收款方式时不猜方式** | ✅ | `多个收款方式时不猜方式：货做掉了、钱回问一句、不写收款、卡片不变灰` |

## 7. 文案（逐字，`config/salesConfirmDeal.js` 的默认值）

| 场景 | 逐字 |
|---|---|
| 卡上唯一的按钮 | `确认成交` |
| 按钮上方提示 | `点一次「确认成交」才会继续走后续流程。` |
| 点完后的卡片标题 | `销售订单已成交` |
| 点完后那行说明 | `✅ 已成交{clock}`（`{clock}` = `（HH:MM 点击）`，上海时间） |
| 点完后卡片 note | `销售单号：{orderNo}；已成交。` |
| ⭐ **预定单**货还没到（库存不足） | `这双还没到货（或库存不够），先走到货入库，到货之后再到这张卡上点「确认成交」。` |
| 货做了、钱问一句（多个收款方式） | `货已经记成交了；这笔钱是怎么收的？说一句我再记账` |
| 第二次点 / 重试 | `这一单已经成交，无需重复处理` |
| 成交成功 | `已成交：{summary}`（例 `已成交：补收款 ￥260，交付 1 双`） |
| 失败 | `这次确认成交没做完：{reason}` |

> ⚠️ **预定单库存不足时，回话里同时还会有一句**（既有 `salesProgressIntake.replies` 的口径不变）：
> 交付失败那条 warn 日志带 `written: false`，可据此证明"这次什么都没写"。

## 8. 配置项（`.env.example` 同段落逐字同步，有回归用例钉住）

`SALES_CONFIRM_DEAL_BUTTON_LABEL` · `_HINT` · `_SETTLED_TITLE` · `_SETTLED_TEXT` ·
`_SETTLED_CLOCK` · `_SETTLED_MESSAGE` · `_ORDER_NO_FALLBACK` · `_SHORT_STOCK` ·
`_ASKING_TOAST` · `_ALREADY_TOAST` · `_SUCCESS_TOAST` · `_NOTHING_TEXT` · `_FAILED_TOAST`（共 13 个）。

- 取值规则走 `config/envValue`：**没设** → 默认值；**设了**（含空串）→ 显式取值；调用时才解析。
- 「留空她就看不懂这张卡」的几句（按钮 / 提示 / 已成交标题与说明 / 货没到 / 汇总兜底）
  空串时回退默认值。
- 「这一单要不要按钮」的**判据不是环境变量**（它是业务口径，在 `needsConfirmDeal` 里）。

## 9. 幂等怎么挡的（三道，任一道单独都够用）

1. **任务状态（第一道，最快）**：`task.confirm_deal_status === 'confirm_deal_settled'` ⇒
   在 `handleConfirmDealAction` 入口**直接短路**：不写库、不 patch、回 `这一单已经成交，无需重复处理`。
   状态值域在 `CONFIRM_DEAL_TASK_STATUS`（`settled` / `short_stock` / `asking` / `failed`）。
2. **底层两个写操作自己的状态判据（第二道，本地记录丢了也管用）**：
   · 收款：`PaymentService.collectPendingReceipt` **只认「未收款」**，不再是待收款就抛「此记录已不是待收款」；
   · 交付：`SalesDeliveryService._deliver` 对**已是「已交付」**的明细走 `duplicate` 分支，
     **不会再调 `inventory.applySale`**（扣库存只可能发生一次）。
   · 两者都空 ⇒ `SecondDeliveryService._confirm` 直接回 `alreadyCompleted`。
   ⇒ 有用例专门把任务标记**抹掉**再点一次，断言"写次数与扣库存次数都不变"。
3. **串行队列（并发双击）**：卡片动作在 `this.cardActionQueue.run(draftId || salesEntryRecordId, …)`
   里跑（同一张卡连点排成一前一后），`SecondDeliveryService` 内部还有一把按销售单号
   （`KeyedSerialQueue`）的锁。**幂等键**（排查用）：`sales_entry_record_id`
   ＋ 日志 `lark.sales.confirm_deal.handled` 的 `status / reason`。

## 10. 先红后绿证据 / 全量 2 次 / CI

### 先红（改动前／只加配置与用例时）

- 第一次跑（连新配置模块都还没有）：`require` 直接 `MODULE_NOT_FOUND`（红）。
- 把**判据配置**先落盘、其余实现还没上时再跑一次（这样红的是**行为**而不是"文件不在"）：

```
$ cd server && node --test test/terminalCardConfirmDeal.test.js
✔ 判据：预定（未交付）→ 要按钮；现货 + 欠款 → 要；现货已交付已结清 → 不要
✖ 终态卡：预订单的「已入账」卡上有且**只有**一个按钮…        （卡面上只能有一个按钮 0 !== 1）
✖ 终态卡：现货 + 有欠款 → 有按钮；现货 + 已交付 + 已结清 → **没有**按钮
✖ 点【确认成交】预定单：未交付→已交付 + 扣库存 + 待收→已收   （'未交付' !== '已交付'）
✖ 点【确认成交】现货欠款单：只补收款，**一点库存都不碰**
✖ 幂等：同一张卡连点两次…
✖ 幂等（第二道）：任务状态被抹掉也拦得住…
✖ 预定单货还没到（库存不足）：明确提示、不写收款、不写已交付、卡片不变灰
✖ 预定单货到了再点一次：这次真成交（上一次什么都没写，重试是安全的）
✖ 点成功后：**被点的那张卡**被 patch 成「已成交」…
✖ 配置先行：按钮 / 提示 / 已成交 / 货没到 四段文案都能用环境变量换
ℹ tests 13  ℹ pass 3  ℹ fail 10
```

（当时还通过的 3 条是**不依赖本功能**的：纯判据、回调同步响应、其余卡片没有这个按钮 ——
它们本来就该绿，正说明红的是"这个功能还没做"而不是测试写歪了。）

### 后绿

```
$ cd server && node --test test/terminalCardConfirmDeal.test.js
ℹ tests 15  ℹ pass 15  ℹ fail 0
```

### 全量 2 次（`node --test --test-concurrency=1`，**在独立 worktree 里跑**，代码冻结后再跑）

```
$ cd .local/confirm-deal/server && echo "HEAD=$(git rev-parse --short HEAD) BEHIND=$(git rev-list --count HEAD..origin/main)"
HEAD=d2b691a BEHIND=0
$ node --test --test-concurrency=1          # 第 1 次
ℹ tests 1252   ℹ pass 1252   ℹ fail 0   ℹ cancelled 0     (exit 0)
$ node --test --test-concurrency=1          # 第 2 次
ℹ tests 1252   ℹ pass 1252   ℹ fail 0   ℹ cancelled 0     (exit 0)
```

（1252 = 既有 **1237** 条 ＋ 本文件新增的 **15** 条；两次都 exit 0。**没有在主工作区跑全量**。）

### CI 三项实际输出（`gh pr checks 244`，PR #244）

```
$ export XDG_CACHE_HOME=/tmp/ghcache GH_CACHE_DIR=/tmp/ghcache
$ gh pr checks 244
Analyze (javascript-typescript)	pass	1m14s	.../job/112860697710
CodeQL                         	pass	7s   	.../runs/112861228758
test                           	pass	56s  	.../job/112861134221

$ gh pr view 244 --json mergeStateStatus,mergeable,statusCheckRollup
{"checks":[
  {"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},
  {"name":"test","status":"COMPLETED","conclusion":"SUCCESS"},
  {"name":"CodeQL","status":"COMPLETED","conclusion":"SUCCESS"}],
 "mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}
```

🔴 **没有用 `--admin`**；合并由派活人做。

## 12. 只改这张终态卡：本次 diff 的文件清单（自证边界）

```
 M .env.example                                      (+37：13 个 SALES_CONFIRM_DEAL_* 与说明)
 M server/src/services/larkMvpService.js             (+190/-12：按钮判据接线 / 点击接线 / 卡片更新 / 四个出口)
 M server/src/services/salesThreadProgressService.js (+109/-6：completeDealFromCard ＋ applyComplete 的可缺省尾参)
 M server/src/utils/larkCards.js                     (+57：confirmDealElements / salesStatusCard 的新可选开关)
?? server/src/config/salesConfirmDeal.js             (新：判据 + 文案 + 任务状态)
?? server/test/terminalCardConfirmDeal.test.js       (新：15 条用例)
?? docs/terminal-card-confirm-deal-2026-10-07.md     (本文件)
```

**没有**碰：`purchaseWebhookService` · `purchaseArrivalConversationService` · `purchaseOrderBatchService` ·
`pendingDealPush*` · `app.js` · `v1BitableSchema` · `routes/larkEvents.js` · 任何 `config/*` 既有文件。

## 11. 不确定处（要她 / 派活人拍板或知情的）

1. ⭐ **收款方式只有一个按钮、带不了方式**。所以点【确认成交】时：
   · 「收款方式管理」里**只有一个** → 用那一个（这不是默认值，是"没有第二种可能"）；
   · **有多个**（线上多半如此）→ 按她 2026-10-06 的口径**不猜、不设默认**
     （`AGENTS.md` 第 16 条(1)）⇒ **货做掉、钱回问一句**
     （回话是既有的「这笔钱是怎么收的？…」，本功能另加一句配置文案）。
   ⇒ **如果她的期望是"点一下钱也一起记上"**，那需要她定一个方式来源（卡上再加方式按钮 /
   默认方式 / 用原话里说过的方式）——**这三条都被她此前的口径否掉过**，所以要她点头才能做。
2. ⚠️ **两条路径的"钱货顺序"不一样**：每日提醒卡的「成交」是**先收钱再交货**（`SecondDeliveryService` 原样），
   而本按钮在**有钱要收**时是**先做货、再收钱**（为满足任务书第 4 条"不写半成品账"）。
   两条路径都落在同一套底层能力上，但顺序不同 —— 若要统一，需她拍板（会动每日提醒卡那条链路）。
3. ⚠️ **多明细时可能"部分交付"**：`SalesDeliveryService` 是**逐条**交付的，
   如果一单里 A 双交成功、B 双没货，A 那双会被真实写成「已交付」（货确实给出去了）。
   这一刻**钱一定不写**、卡片也不变灰；这属于既有交付语义，不是本次引入的。
4. ⚠️ `applyComplete` 新增了可缺省的尾部参数 `deliveredBefore`（只为把回话/日志说全）。
   既有调用点不传 ⇒ 行为逐字不变（`test/salesThreadProgress.test.js` 全绿）。
5. ⚠️ 卡片"已成交"是**重新渲染**：依赖本地任务上的 `task.draft` / `posting_result`。
   本地任务被清理掉时卡片改不了（只记 `lark.sales.confirm_deal.card.skipped`），
   **成交结果不受影响**。
6. ⚠️ **没有做真机点按验证**（本机不配生产凭证、不碰生产表；也没有在测试群里真发一张卡）。
   链路正确性由"走项目代码"的用例钉住（真 `LarkMvpService` → 真 `SalesThreadProgressService`
   → 真 `SecondDeliveryService` / `SalesDeliveryService` / `PaymentService` ＋ 假 Base / 假飞书 client
   抓真实 patch payload）；**真机点按需要她在测试群里试一次**。
7. ⚠️ 我把按钮**同时**挂在"部分交付 / 交付待处理"那两张橙色卡上（依据是她第 4 条那句
   「先走到货入库，**再到这张卡上点确认成交**」）。若她认为只该出现在绿色「已入账」终态卡上，
   收窄成一处即可（删掉那两个 `confirmDeal:` 传参，判据与用例都不用动）。
