# 【确认成交】两条严重 bug 的修复：假成交 / 卡面永不修复

> 承接 `docs/terminal-card-confirm-deal-2026-10-07.md`（那张卡的设计、AC-1 ~ AC-10、文案表）。
> 本文件 = 这次修复的 **验收标准（先写）+ 关键 diff + 逐条对照 + 先红后绿 + CI + 待拍板**。
>
> ⚠️ 口径没有变过，**变的是实现** —— 上一版把「交付失败」只当**一句话**说，
> 没有当**成交结论**；并且把「卡面自愈」那道闸门放错了位置（早退在 patch 之前）。

## 1. 起因：两条 bug 的实测结论（先自己复核过）

### bug 1 🔴「假成交」（违反既有 AC-7）

**现象**：预订单 **全款已收（`收款明细` 里没有任何「未收款」）** ＋ **货还没到** ⇒ 她点【确认成交】→
toast 绿字「已成交：无待处理项」、卡面 patch 成绿色「销售订单已成交」、按钮消失、
任务记 `confirm_deal_settled`；**但明细仍「未交付」、库存一次都没扣**。

**根因（复核后的定位）**：上一版把"先做货"的前置闸门**挂在「有没有待收款」上**：

| 位置 | 现状（改动前） | 后果 |
|---|---|---|
| `salesThreadProgressService.js:411-431` | `if (pending.length) { …先做货 + 拦 short_stock… }` | **只有"有待收款"的单才会先做货** |
| `salesThreadProgressService.js:471-472` | `const hasPending = …; const method = hasPending ? … : ''` | 全款已收 ⇒ `hasPending=false` ⇒ `method=''` 直接 `confirm` |
| `salesThreadProgressService.js:510-536` | 交付失败只 `reply` 一句「还有 N 双交付未完成」就 `return { replied, result }` | 返回值**没有** `asked` / `short_stock` |
| `larkMvpService.js:2079` | `const settled = !outcome.asked` | `asked` 缺省 ⇒ `undefined` ⇒ **`settled = true`** |
| `larkMvpService.js:2094-2099` | `settled` ⇒ patch 成「已成交」 | 卡变绿、按钮消失、任务记 `confirm_deal_settled` |

⇒ 为什么"这个分支原来漏了"：AC-7 当初是**为"钱"写的**（防的是"货没到、钱却先记成已收"的**半成品账**），
所以闸门长在 `pending.length` 上。而**全款已收的单没有"钱"这一半要防**，它照样有"货"这一半 ——
于是这条路径**整段绕过了闸门**：交付失败的信息只走到了"回她一句话"，
**没有走进"成交结论"**（`asked` / `reason`）。

**实测对比（本机假 Base + 假飞书 client，走真 `LarkMvpService`）**：

- 货到了 → `已成交：交付 1 双` ✅
- 货没到 → `已成交：无待处理项` ❌（toast 假成功；明细仍未交付、库存没扣）

**覆盖缺口**：既有用例只覆盖"有待收款"那支（`test/terminalCardConfirmDeal.test.js:392-421`，
fixture `owed: 260`）⇒ 这个分支**没有测试**。本次补上（见 AC-11 ~ AC-15）。

### bug 2 🔴 第一次 patch 失败后，再点【确认成交】永远不会修复卡面

`larkMvpService.js:2060-2065` 的早退（任务已 `confirm_deal_settled` → 直接回 toast）**在 patch 之前**，
与同文件 `:2096-2098` 的注释「这是那张卡**唯一一次自愈的机会**」**自相矛盾** ——
第一次点击时 patch 失败（卡片被撤回 / 权限 / 网络），任务状态已经写成 `settled`；
之后再点，一律走早退，**永远不再试 patch**，那张卡就永远停在"还能点"的样子上。

## 2. 边界（不许碰的东西）

| 不许碰 | 本次结果 |
|---|---|
| 采购侧任何文件（`purchaseWebhookService` / `purchaseOrderBatchService` / 到货链路 / `v1BitableSchema`） | **一行未动** |
| `pendingDealPush*` | **一行未动** |
| `app.js` | **一行未动**（不需要改：没有新路由 / 新定时器 / 新 store） |
| 销售类型判据 / 颜色候选 | **一行未动**（本次只引用既有判据） |
| 样品补选那条链 | **一行未动**（她 2026-10-07 已拍板"不用修"） |
| 业务表 | **一个字都没写**（本次只动本地任务记录 `server/data/lark_mvp_tasks/` 上的 `confirm_deal_*`） |
| 部署 | 🔴 **严禁**（她明令：每次都要她当次命令） |

## 3. ⭐ 验收标准（**动手前先写**）

> 记号沿用上一份文档：AC-1 ~ AC-10 已由 `docs/terminal-card-confirm-deal-2026-10-07.md` 定义且**本次不许回退**；
> 下面是本次新增 / 补强的。

### bug 1：交付失败**也是成交结论**（补强 AC-7）

- **AC-11** 预定单 **全款已收（没有任何「未收款」）** ＋ 明细**未交付** ＋ **库存不足（货没到）**，
  点【确认成交】⇒ 卡片回调的 toast **不许**是 success、**不许**出现「已成交」字样；
  必须是 warning，内容**逐字** = `SALES_CONFIRM_DEAL_SHORT_STOCK`
  （「这双还没到货（或库存不够），先走到货入库，到货之后再到这张卡上点「确认成交」。」）。
- **AC-12** 同一场景，**卡片不许变灰**：不许 patch 出标题 = `SALES_CONFIRM_DEAL_SETTLED_TITLE`
  的卡；那张卡上「确认成交」按钮**还在**（她到货后还要能再点）。
- **AC-13** 同一场景，任务记录 `confirm_deal_status = confirm_deal_short_stock`
  （**不是** `confirm_deal_settled`），并落一条 `sales.confirm_deal.short_stock` warn，带 `written: false`。
- **AC-14** 同一场景 **零写库**：`收款明细` 一条不动（本来就没有待收款）、明细仍 `未交付`、
  库存**一次都没扣**（`applySale` 调用数 = 0）；线程里也要有一句明确提示（逐字来自配置）。
- **AC-15** 同一场景，**货到了再点一次** ⇒ 这次真成交：明细 → `已交付`、扣一次库存、
  toast success（`已成交：交付 1 双`）。这正是"宁可没成交、让她到货后再点"的意思 ——
  上一次什么都没写 ⇒ 重试是安全的。

### bug 2：卡面自愈（不重复写库）

- **AC-16** 第一次点击时 **patch 失败**（成交已写完、任务已 `confirm_deal_settled`，但卡面还是旧的），
  再点一次【确认成交】⇒ 早退分支**也尝试 patch 一次卡面**：卡面被改成「已成交」的样子
  （标题 = `SETTLED_TITLE`，打在**同一张卡** `path.message_id` 上）；
  **且不重复写库**：业务表写次数与第一次点击后**完全一致**；
  本地任务记录也不再改（`confirm_deal_at` 保持第一次的值）；
  toast 仍是 `SALES_CONFIRM_DEAL_ALREADY_TOAST`。
  ⚠️ **有意**的行为变化：重复点击现在**会**重发一次同样的 patch（自愈成本极低；只在任务状态已 settled 时发生）。

### 顺带（问题 4，小）

- **AC-17** 成交那一行说明（绿色卡的 note）里，**把"仍未交付 N 双"写进去**：
  交付只成了一半（`delivery.failures.length > 0` 而这一单仍算成交）时，
  note = `SALES_CONFIRM_DEAL_SETTLED_MESSAGE` ＋ `SALES_CONFIRM_DEAL_SETTLED_UNDELIVERED`（`{count}` = 失败条数）；
  没有未交付时**一个字都不多加**（既有那条 AC-8 的断言逐字不变）。
  文案走 `config/salesConfirmDeal.js`（可配），并同步 `.env.example`（既有回归用例钉住键集合与默认值逐字一致）。

### 问题 3：**不改**，只给她两个选项（见第 8 节）

## 4. 实现（关键 diff）

改动文件（3 个源文件 ＋ 1 个 `.env.example` ＋ 1 个测试文件 ＋ 本文档）：

### ① bug 1：交付失败**也纳入成交结论** —— `services/salesThreadProgressService.js`（`applyComplete`）

```js
const result = await this.secondDelivery.confirm({ salesEntryRecordId, method, operatorOpenId }, { correlation });
if (result.alreadyCompleted) { … }

// ⭐⭐ 一条都没交出去（货还没到）⇒ **不算成交**：不许说已成交、不许把卡变灰。
//    判据是"**这次一条都没交成**"（deliveredQuantity === 0），**不是**"有失败" ——
//    部分交付（A 双交出去、B 双没货）是既有语义，那种情况仍算成交，只在回话/卡面里如实写。
const deliveredThisCall = Number(result.delivery?.deliveredQuantity || 0);
const failedCount = result.delivery?.failures?.length || 0;
if (failedCount && !deliveredThisCall) {
  await this.reply(task, this.confirmDeal.shortStock);          // 配置文案：到货入库后再点
  logWarn('sales.confirm_deal.short_stock', {
    task_id, sales_entry_record_id, failed_count: failedCount, reason: failures[0].error,
    written: false,                                             // ← 可证"这次什么都没写"
    hint: '货还没到 → 不写钱、不写交付、卡片不变灰；到货入库后再到这张卡上点确认成交',
  });
  return { replied: true, asked: true, reason: 'short_stock', result: { failures } };
}
// 部分交付时（既有语义）如实说"还有 N 双交付未完成" —— 与改动前逐字相同。
if (failedCount) parts.push(`还有 ${failedCount} 双交付未完成，请到工作台核对`);
```

- `asked: true` 是**关键**：上层 `settled = !outcome.asked` ⇒ `false` ⇒ 不 patch 卡、toast 走
  `config.shortStock`、任务记 `confirm_deal_short_stock`。
- **为什么选"改返回值"而不是"再做一次前置库存检查"**：`completeDealFromCard` 的
  `deliverUndelivered` 是**真交付**（会写「已交付」+ 扣库存），不是只读检查 ——
  在"全款已收"这条路上先把货交掉、再去 `confirm` 里发现"钱货都齐了（`alreadyCompleted`）"，
  会把**正常成交**那条路（货到了 → `已成交：交付 1 双`）变成
  「这一单已经成交，无需重复处理」并丢掉交付数量。
  两条路**写的字节完全一样**（都是交付引擎那一次尝试），差别只在"谁签发这个结论" ——
  所以选**改动最小、且不动 `SecondDeliveryService` 顺序**的那条。
- `completeDealFromCard` 的前置闸门（`pending.length` 时先做货）**一个字没动** ——
  它是为"钱"写的，防的是"货没到、钱却先记成已收"的半成品账，仍然必要。

### ② bug 2：早退分支也补一次卡面 —— `services/larkMvpService.js`

```js
if (task?.confirm_deal_status === CONFIRM_DEAL_TASK_STATUS.SETTLED) {
  // ⭐⭐ 早退之前先补一次卡面（自愈）—— 与下面 settled 分支的注释本是同一句话的两半。
  //    只补卡面：settleConfirmDealCard 只调 im.message.patch，不碰 gateway、也不 store.update。
  const cardPatched = await this.settleConfirmDealCard(task, event, config, context);
  logInfo('lark.sales.confirm_deal.already_settled', { task_id, sales_entry_record_id, card_repatched: cardPatched });
  return { toast: { type: 'info', content: config.alreadyToast } };
}
```

**幂等怎么保住的**：

- 早退分支**不执行任何**业务写路径 —— 不调 `completeDealFromCard`、不调 `store.update`
  （`confirm_deal_at` 保持**首次点击**的值，用例逐字 `deepEqual` 钉住）；
- 唯一的副作用是 `im.message.patch`（`updateInteractiveCard`：只调飞书、无网关写、无本地写），
  而且 patch 的内容是 `task.draft` **重新渲染**出来的「已成交」卡 —— 与首次点击那次**逐字相同**，
  重复 patch 是幂等的；
- patch 失败仍然只记 warn、**不影响回话**（既有语义不变）。

### ③ 顺带（问题 4）：成交那行说明带上「仍未交付 N 双」—— 三处小改

```js
// config/salesConfirmDeal.js：新增一个可配文案（`{count}` = 没交成的条数）
settledUndelivered: '仍未交付 {count} 双，请到工作台核对。',

// larkMvpService：从**这次成交的结果**里数（不额外读表；拿不到 = 0，不猜）
confirmDealUndeliveredCount(outcome = {}) {
  return Number(outcome.result?.delivery?.failures?.length || 0);
}

// settleConfirmDealCard：有值时追在 `settledMessage` 后面，没有时**一个字都不加**
undeliveredCount > 0
  ? `${settledNote}${fillConfirmDeal(config.settledUndelivered, { count: undeliveredCount })}`
  : settledNote,
```

⇒ `.env.example` 同步新增 `SALES_CONFIRM_DEAL_SETTLED_UNDELIVERED`（既有回归用例
钉住"`.env.example` 的键集合与默认值必须与配置逐字一致"）。

## 5. 逐条对照

| 验收标准 | 结论 | 钉住它的用例 |
|---|---|---|
| **AC-11** 全款已收 + 货没到 → toast **不是** success、**不含**「已成交」、**逐字** = `SHORT_STOCK` | ✅ | `🔴 bug1：全款已收 + 货没到 → **不许**说已成交…`（`notEqual(type,'success')` ＋ `!content.includes('已成交')` ＋ `equal(content, config.shortStock)`） |
| **AC-12** 同场景**卡不变灰**、不 patch、按钮还在 | ✅ | 同上（`!isSettledCard(client)` ＋ `client.patched.length === 0`） |
| **AC-13** 任务记 `confirm_deal_short_stock` ＋ 落 `written:false` 的 warn | ✅ | 同上第 ④ 条（状态）＋ 第 ⑤ 条（抓日志断言 `sales.confirm_deal.short_stock` × 1、`written === false`、`failed_count === 1`、`task_id === 'sale_1'`） |
| **AC-14** 同场景零写库（不写收款 / 不写已交付 / 不真的扣库存） | ✅ | 同上（`salesDetail` / `paymentRecord` 写次数不变、明细仍 `未交付`、`appliedSaleCalls === 0`）＋ 连点两次那条 |
| **AC-15** 货到了再点 → 真成交（交付 + 扣库存 + 已收） | ✅ | `bug1 对照：全款已收 + **货到了** → 正常成交…`（`success` ＋ `交付 1 双` ＋ `已交付` ＋ 扣库存 1 次 ＋ 卡变灰） |
| **AC-16** patch 失败后再点能自愈，且不重复写库 | ✅ | `🔴 bug2：第一次 patch 失败后，**再点一次**能把卡面修好，且不重复写库`（`patched.length 0→1`、打在 `om_card`、标题 = `settledTitle`、按钮消失、`gateway.writes` 不变、`appliedSaleCalls` 不变、任务记录 `deepEqual` 不变） |
| **AC-17** 成交那句说明含「仍未交付 N 双」；没有未交付时一字不加 | ✅ | `成交后变绿那句说明里含「仍未交付 N 双」…`（note 逐字）；`bug1 对照…`（全交付时卡面不含「仍未交付」） |
| **不许回退**：有待收款那支（`owed: 260`） | ✅ | 既有 `预定单货还没到（库存不足）…` ＋ `预定单货到了再点一次…` ＋ `点【确认成交】预定单…` ＋ `点【确认成交】现货欠款单…` 全绿 |
| **不许回退**：幂等（不重复交付 / 扣库存 / 写收款） | ✅ | `幂等：同一张卡连点两次…`（唯一的有意变化：第二次**多补一次卡面 patch**，写库次数不变）＋ `幂等（第二道）…` |
| **不许回退**：AC-1 ~ AC-6、AC-8 ~ AC-10（卡片 / 文案 / 3 秒 / 其余卡片逐字） | ✅ | 同文件其余用例 ＋ `cardUpdateMulti.test.js` ＋ `cardVisibleGolden.test.js` 全绿 |

## 6. 先红后绿证据（**改动前**）

```
$ cd server && node --test test/terminalCardConfirmDeal.test.js        # 改动前
[先红-实测] toast = {"type":"success","content":"已成交：无待处理项"}
            | 卡片标题 = "销售订单已成交"
            | 按钮数 = 0
            | 任务状态 = confirm_deal_settled
            | 明细 = 未交付
            | 扣库存次数 = 1（**尝试**次数；`applySale` 抛错 ⇒ 没真的扣成）
✖ 幂等：同一张卡连点两次 → 第二次只回「已经成交」…            （1 !== 2：旧断言"第二次不该再 patch"）
✖ 🔴 bug1：全款已收 + 货没到 → **不许**说已成交、**卡不变灰**、零写库、明确提示
      AssertionError: 货没交出去就不许报成功  actual: 'success'  expected: 'success'
✖ bug1：货没到一次都没成交（连点两次都拦得住…）                actual: 'success'
✖ 🔴 bug2：第一次 patch 失败后，**再点一次**能把卡面修好…      0 !== 1（早退分支没补 patch）
✖ 成交后变绿那句说明里含「仍未交付 N 双」…                     actual: '销售单号：XSD-1；已成交。'
ℹ tests 20  ℹ pass 15  ℹ fail 5
```

> 这 5 条红里，**1 条**是"旧断言与 bug 2 直接冲突"（旧断言正是把自愈机会关掉的那句），
> **4 条**是本次要修的行为。红的是**行为**，不是"文件不在"。

### 后绿

```
$ cd server && node --test test/terminalCardConfirmDeal.test.js        # 改完
ℹ tests 20  ℹ pass 20  ℹ fail 0
```

### 全量 2 次（`node --test --test-concurrency=1`，在**独立 worktree** 里跑，代码冻结后）

```
$ cd .local/worktrees/confirm-deal-fix/server
$ echo "HEAD=$(git rev-parse --short HEAD) BEHIND=$(git rev-list --count HEAD..origin/main)"
HEAD=266b56d BEHIND=0
$ node --test --test-concurrency=1          # 第 1 次
ℹ tests 1296  ℹ pass 1296  ℹ fail 0  ℹ cancelled 0    (exit 0)
$ node --test --test-concurrency=1          # 第 2 次   ← 见第 7 节
```

（1296 = 本分支 HEAD 上的既有用例 ＋ 本文件新增的 **5** 条。
⚠️ **没有在主工作区跑全量**。）

## 7. CI 三项 + 全量 2 次

（跑完后填）

## 8. ⭐ 待她拍板：问题 3 的两个选项（本次**一行未改**）

**分歧点**：卡面那句「还欠 ￥X」是**算出来的**，而后端的成交按钮只认**她明说的欠款**。

- 卡面：`config/salesCardFacts.js:174` —— 「还欠 = 成交额 − 已收 − 待平台结算（封底 0）」，
  是**算出来**的（`salesCardFacts` 的注释也写了"只做加法与减法"）。
- 后端判据：`config/salesConfirmDeal.js:137-168` 的 `hasOutstandingMoney` ——
  **只认** ① `draft.owed`（她明说欠多少时入账层才补那条占位）或 ② 表里真有一条「未收款」。
  注释里写明理由：「钱没结清」判据**刻意不拿「成交 − 已收」去猜**：她可能是在还价 / 抹零 / 分期。

⇒ 于是存在一个口径分叉：**卡面显示"还欠 260"，但"未收款"里没有那条占位**时，
【确认成交】按钮**不会出现**（`needsConfirmDeal` 判 `completed`），也就永远点不了。
两个选项（**要她拍板，我不自己改**）：

| 选项 | 含义 | 代价 / 风险 |
|---|---|---|
| **A（现状）只认她明说** | 她说了"欠 260"或入账时已有「未收款」占位，才算"钱没结清"；卡面的"还欠"只是**展示**，不驱动任何写入 | 卡面说"还欠"、但没有入口去收（按钮不出现）；她若期望"卡面显示欠 = 可点按钮"就会觉得漏了 |
| **B 按算出来的差额收口** | 后端用「成交额 − 已收」算欠款，卡面显示欠 = 判定欠款 = 给按钮 | 会把她**还价 / 抹零 / 平台待结算 / 分笔**当成欠款，替她记账 —— 与她 2026-10-06 的口径（「她说欠才算欠；后端不拿差额去猜」）**直接冲突**，写错一笔钱的代价高于"按钮没出现" |

## 9. 不确定处

1. ⚠️ **"零写库"的准确边界**：这次真的一点都没写的是 —— **收款明细**（本来就没有待收款）、
   **销售明细.履约状态**、**库存流水 / 实时库存**（`applySale` 抛错，没扣成）。
   但**「销售主表.库存状态」那一格会被写成「写入失败」** —— 那是 `SalesDeliveryService._deliver`
   的**既有**行为（逐条交付后总要落一格库存状态），**改动前后的两条路径都一样**
   （有待收款那条前置闸门路径也是这么写的）。所以 AC-7 的"一个字节都不写"我一直按
   "不写钱、不写已交付、不真的扣库存"理解并这样断言；若她的口径是"连库存状态那一格都不许动"，
   需要在交付引擎里再加一层"预检阶段不落状态"——**那是另一件事**（会动所有交付调用方），要她点头。
2. ⚠️ **`applyComplete` 里还有一处同形状的老问题，我**没动**（不在本次 brief 的范围内）**：
   `hasPending && !method` 那条分支（她说「已完毕」+ 有待收款 + 收款方式不唯一）先做货、
   再回「好，还没交的 N 双记成已交付了」。**货没到时那句话是假的**（`deliverUndelivered`
   的 `failures` 在这里**没有被检查**）。它**不会造成"假成交"**（返回值带 `asked: true`，
   状态记 `progress_asking`），但"记成已交付了"这句是假的。
   【确认成交】按钮**走不到这里**（`completeDealFromCard` 的前置闸门会先把失败拦成 `short_stock`），
   所以只有"她直接在话题里说已完毕"那条路会碰到。**要不要顺手修，请她/派活人定。**
3. ⚠️ 本次**有意**改了既有行为两处（都已写进用例注释）：
   ① 重复点击会**再 patch 一次卡面**（bug 2 的自愈，业务表不写）；
   ② 交付只成了一半时，绿色卡的说明里**多一句**「仍未交付 N 双」。
   其余卡片 / 文案 / 顺序**一个字没动**。
4. ⚠️ **部分交付的 toast 仍是 success**：`已成交：交付 1 双`（不含"还有 N 双未完成"）。
   卡面说明里已经带上了那句（AC-17），但 toast 没带 ——
   `handleSecondDeliveryAction`（另一张每日提醒卡）在同场景下是 **warning**。
   两者不一致是**既有**的；要不要把【确认成交】的 toast 也改成 warning + 带上那句，请她拍板。
5. ⚠️ **问题 3（第 8 节）本次一行未改** —— 那是业务口径，等她拍板。
6. ⚠️ **没有真机点按验证**：本机不配生产凭证、不碰生产表，也没有在测试群里真发一张卡。
   链路正确性由"走项目代码"的用例钉住（真 `LarkMvpService` → 真 `SalesThreadProgressService`
   → 真 `SecondDeliveryService` / `SalesDeliveryService` / `PaymentService` ＋ 假 Base / 假飞书 client
   抓真实 patch payload 与真实结构化日志）。**真机点按需要她在测试群里试一次**。
7. ⚠️ 卡片自愈的**时机**：现在**每次**重复点击都会重发一次同样的 patch。
   成本极低（飞书 patch 幂等、内容逐字相同），但若她介意"重复点击会多一次接口调用"，
   可以只在**任务上有 `confirm_deal_card_patched` 标记**时才跳过一次 —— 那要多写一个本地字段，
   本次没有引入（少一个状态 = 少一处不一致）。
