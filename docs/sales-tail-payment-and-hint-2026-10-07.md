# 「下次收 X」= 尾款 ⇒ 成交额 = 定金 + 尾款；并修那句误导提示（2026-10-07 真机）

分支 `fix/sales-tail-payment` · 改动范围：销售解析提示词 + 定金/尾款词表 + 后端提示分流。

---

## 0. 起因（业务负责人 2026-10-07 22:59 真机，逐字）

她发的原话：

```
定制一双 37 码的 26632，定金交了 100 元，微信，下次收120元
```

改动前的逐字解析（`sales.ai.parsed`）与她的回复：

- `items: [{item_no:"26632", size:37, quantity:1, actual_amount:""}]`
- `payments: [{method:"微信", amount:100}]`
- `agreed_total: ""` · `owed: ""` · `missing_fields: []`
- 后端补一条缺项 `["items[0].actual_amount"]`
- 机器人回她：

```
销售信息还缺 2 处，请照着补一下～
1. 请给每双鞋都说一个成交金额：26632 37码
2. 已收的钱比这单成交金额还多，请核对一下收了多少～
```

**两个问题**：

1. 「下次**收**120元」没被认成尾款（`owed` 空），也没推出成交额；
2. 第 2 句在"成交额压根没解析出来"时是**误导**（她看到会莫名其妙）。

**对照（同一天、能认出来的反例）**：她说「定金微信交了 100 元，**下次欠** 128 元」→ 解析正确
（`payments[{100,微信}]` · `agreed_total:228` · `owed:128`）。差别只在「**欠**」vs「**收**」这个用词。

---

## 1. 验收标准（**先写，再动手**；逐条对照见第 7 节）

| 编号 | 验收标准（改完之后应该是什么样） |
| --- | --- |
| **AC-1** ⭐ | 她那句原话（逐字）在 `normalizeSalesResult` 里得到：`items[0].actual_amount = 220`、`agreed_total = 220`、`owed = 120`、`payments = [{method:'微信', amount:100}]`、`missing_fields = []` |
| **AC-2** | 哨兵：「26002-52 37 码，定金微信交了 100 元，**下次欠** 128 元」的既有行为**一字不变** —— `agreed_total 228` / `owed 128` / `payments [微信100]` / `missing_fields []` |
| **AC-3** | 哨兵：**只说定金、不说尾款**（如 `9A207-0 43码，定金微信 50`）→ `agreed_total` 仍为空、`items[0].actual_amount` 仍为空、仍报缺项、仍不入账。⭐「**只有定金不能当成交额**」这条既有规则**一个字没动** |
| **AC-4** | ⭐ **成交额缺失时**（`items` 的金额加起来还是 0、而她说了收到过钱）→ 渲染出来的提示**不再是**「已收的钱比这单成交金额还多」，而是「请说明这单成交金额（或定金+尾款分别是多少）」 |
| **AC-5** | 哨兵：**真**「已收 > 成交额」（成交额**有值**且确实小于已收）→ 仍报原来那句「已收的钱比这单成交金额还多，请核对一下收了多少～」 |
| **AC-6** | 哨兵：多双 / 混单（#231 / #234 那批用例：`salesMultiLineTradeType` / `salesMissingInfoText` / `doubaoSalesParser` 里的多明细断言）**不许回退** |
| **AC-7** | **配置先行**：新增/改动的**文案**与**词表**都在 `config/` 里；判断逻辑里不写死中文词；`.env.example` 与默认值逐字对应 |
| **AC-8** | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |

### 1.1 「尾款」同义说法（统一成 `owed`）

`下次收` / `下次付` / `还要收` / `还要付` / `再收` / `再付` / `尾款` / `余款` / `剩下` / `剩下的` /
`还差` / `补收` 等 —— **都当成 `owed`（未收的尾款）**。

⚠️ **方向词不改变性质**：她说的是「下次**收**」——收款方向的词在这里等于"**还没收到的钱**"，
**不许**因为方向是"收"就把它当成本次已收款。

### 1.2 定金 + 尾款 ⇒ 成交额 = 两者之和

`100 + 120 = 220`。这条与既有口径同源（既有「各分项之和 = 总额」是同一类推理；
这里的分项是**两次收款**），**不是新口径**。

### 1.3 后端提示怎么分流（两件事分开）

| 情形 | 提示 |
| --- | --- |
| **成交额没解析出来**（`actualTotal == 0`） | 「请说明这单成交金额（或定金+尾款分别是多少）」 |
| **已收 > 成交额**（`actualTotal > 0` 且 `covered > actualTotal`） | 原来那句：「已收的钱比这单成交金额还多，请核对一下收了多少～」 |

⇒ 现在的情形（成交额空 + 已收 100）**不许**再报「已收比成交额多」。

---

## 2. 改动的落点

| 落点 | 改什么 |
| --- | --- |
| `server/src/config/salesDepositTerms.js`（**新**） | 尾款说法**词表**（配置先行）：time words / verbs / aux / markers / 生产者文案常量 |
| `server/src/services/doubaoService.js`（**提示词**） | 规则 9.1 把尾款同义说法列全；新增"定金 + 尾款 ⇒ 成交额 = 两者之和" |
| `server/src/services/doubaoService.js`（`depositTerms` / `DEPOSIT_CLAUSE_BOUNDARY` / `moneyNotSettled`） | 正则**从配置词表生成**，认「下次收 / 再收 / 补收 …」 |
| `server/src/services/doubaoService.js`（`normalizeSalesResult`） | 「只说了定金、没说尾款」→ 缺项文案换成"请说明这单成交金额（或定金+尾款分别是多少）"（生产者原话在 config） |
| `server/src/services/larkMvpService.js`（**1 行**） | 接线层的「已收 > 成交额」判据加 `actualTotal > 0` |
| `server/src/config/salesMissingInfoText.js` | 新文案（消费者侧模板）+ 映射 + 「同一件事只留一行」的合并 |
| `.env.example` | 新文案键 |

---

## 3. 先红后绿（证据）

### 3.1 ⭐ 她这句原话：改动前**必须失败**

在**未改动的 `origin/main`（`d2b691a`）**上单独建了一个一次性 worktree 跑新用例（`git rev-parse --short HEAD` = `d2b691a`）：

```
$ node --test --test-concurrency=1 test/salesTailPayment.test.js
✖ AC-1 她那句原话：「下次收 120」= 尾款 ⇒ 成交额 220、owed 120、缺项为空
✔ AC-2 哨兵：「下次欠 128」的既有行为**逐字不变**（成交额 228 / owed 128 / 缺项为空）
✔ AC-3 哨兵：只说定金、不说尾款 → 成交额仍为空（「只有定金不能当成交额」没动）
✖ AC-9 「下次收 120 元」也算尾款（owed 120 / 成交额 220）
✔ AC-9 「下次付 120 元」也算尾款（owed 120 / 成交额 220）
✖ AC-9 「还要收 120 元」…
✖ AC-9 「还要付 120 元」…
✖ AC-9 「再收 120 元」…
✖ AC-9 「再付 120 元」…
✔ AC-9 「尾款以后付 120 元」…
✖ AC-9 「余款下次收 120 元」…
✖ AC-9 「剩下的下次收 120 元」…
✖ AC-9 「还差 120 元」…
✖ AC-9 「补收 120 元」…
✖ 模型把「下次收 120」错记成一笔收款 → 后端按她明说的尾款剔掉它
ℹ tests 15   pass 4   fail 11

✖ AC-1 …
  AssertionError [ERR_ASSERTION]: 「下次收 120」必须认成 owed（未收的尾款）
  '' !== 120
```

⭐ **注意那两条绿**：AC-2（「下次**欠** 128」）与 AC-3（只给定金）在改动前就是对的
—— 这正是"哨兵"的意义：**它们不许因为这次改动而变**。

### 3.2 ⭐ 后端那句误导：改动前**真的就是她收到的那两行**

同一个一次性 worktree（未改动的 `main`）上，把"只说了定金"这一单跑**真实的** `processSalesTask`：

```
$ node --test --test-concurrency=1 test/zzRedBaselineEvidence.test.js
✖ RED-④a … AssertionError: 实际 2 行：
销售信息还缺 2 处，请照着补一下～
1. 请给每双鞋都说一个成交金额：26632 37码
2. 请说明这单成交金额或定金加尾款分别是多少
2 !== 1

✖ RED-④b 端到端（只说了定金）→ 回复里不许有「已收的钱比这单成交金额还多」
  AssertionError: 成交额是空的，这句话是误导：
销售信息还缺 2 处，请照着补一下～
1. 请给每双鞋都说一个成交金额：26632 37码
2. 已收的钱比这单成交金额还多，请核对一下收了多少～
```

最后那两行**与她真机收到的那条回复逐字同形**（她那条的货号是 26632 37 码）——
这就是本次要修掉的那个误导。

### 3.3 改动后

同一批用例在本分支上：`salesTailPayment.test.js` **15/15 通过**，
`zzRedBaselineEvidence.test.js`（临时拷进来跑完即删）**2/2 通过**。

---

## 4. 边界（明确没碰）

- 🔴 **不碰**采购侧任何文件（`purchaseWebhookService` 等由另一代理在改）；
- 🔴 **不碰** `pendingDealPush*`；🔴 **不碰** `app.js`；
- 🔴 **不碰**终态卡 / 按钮相关代码（另一代理在做）；
- 🔴 **不碰**销售的类型判据（现货 / 预定由库存定）与颜色候选；
- 🔴 **不写任何表**（本次改动零写库）。
- ⚠️ **`larkMvpService.js` 动了一处共 8 行**（第 1803 行那个判据）：这正是"后端提示"的生产者，
  躲不开。改动只有 `actualTotal > 0` 这一个条件 ＋ 注释；**终态卡 / 按钮那一段一行没碰**。
  另一代理的分支也改这个文件 —— 两边改的是**相隔很远的区域**（他改卡片动作处理，我改录单缺项拼装），
  ⚠️ 合并时**必须重跑一次全量**（AGENTS.md 的"同名方法静默覆盖"教训）。

---

## 5. 纪律

- 严禁部署（她明令：每次都要当次命令）；严禁写生产表 / 改线上 `.env`；
- 独立 worktree + 临时软链 `.env`（验完删）；
- 必须 `gh pr checks` 看到 CLEAN；禁止 `--admin`；**合并由她来**；
- 全量测试连跑 2 次 fail=0，且**不在主工作区**跑全量。

---

## 6. ⭐ 她这句原话改后的**逐字段解析**

输入（逐字）：`定制一双 37 码的 26632，定金交了 100 元，微信，下次收120元`
模型逐字给的那份（真机 `sales.ai.parsed`）：`items[0].actual_amount=""` · `payments[{微信,100}]` ·
`agreed_total=""` · `owed=""` · `missing_fields=[]`

`normalizeSalesResult(模型输出, 原话)` 改后：

```json
{
  "intent": "sale",
  "trade_type": "预定",
  "items": [{
    "item_no": "26632", "color": "", "size": 37, "quantity": 1,
    "actual_amount": 220,
    "trade_type": "预定", "trade_type_code": "SALE_PREPAID",
    "gift": false, "gift_description": ""
  }],
  "payments": [{ "amount": 100, "method": "微信" }],
  "agreed_total": 220,
  "owed": 120,
  "total_paid": 100,
  "total_covered": 100,
  "payment_method": "微信",
  "missing_fields": []
}
```

对照改动前（`actual_amount:""` · `agreed_total:""` · `owed:""` · 缺 `items[0].actual_amount`）：
**成交额 220 = 定金 100 + 尾款 120；owed 120；已收只有定金那 100；缺项为空。**
下游（`salesFundTypeDecoupling` 端到端）也就变成 **收款 [[100, 已收款], [120, 未收款]]、欠款 120**。

---

## 7. 逐条对照（验收标准 → 实现 → 证据）

| 编号 | 验收标准 | 实现落点 | 证据（用例） | 结果 |
| --- | --- | --- | --- | --- |
| **AC-1** ⭐ | 她那句原话 ⇒ 成交额 220 / owed 120 / payments[微信100] / 缺项为空 | `depositTerms`（`TAIL_PATTERNS[1]` 认 `下次收`）+ 既有「定金 + 尾款 = 成交额」推导 | `salesTailPayment.test.js` AC-1（含逐字段 `deepEqual`） | ✅ 改动前**红**（`'' !== 120`），改后绿 |
| **AC-2** | 哨兵：「下次欠 128」既有行为逐字不变（228 / 128 / [] ） | **一行没改**那条路（`欠` 本来就在词表里） | `salesTailPayment.test.js` AC-2（两条：模型给了 / 模型漏给） | ✅ 改动前后都绿 |
| **AC-3** | 哨兵：只说定金 → 成交额仍为空、仍报缺项 | 「只有定金不能当成交额」那条判据**一个字没动** | `salesTailPayment.test.js` AC-3 | ✅ 改动前后都绿（**不改判据**） |
| **AC-4** ⭐ | 成交额缺失时提示**不再是**"已收比成交额多"，改问「请说明这单成交金额（或定金+尾款分别是多少）」 | 解析层产 `SALES_DEPOSIT_TOTAL_UNKNOWN`；接线层判据加 `actualTotal > 0`；渲染层把两句**合成一行**并带上清单 | `salesMissingInfoText.test.js` AC-④ ×2（渲染层 + **真实** `processSalesTask`） | ✅ 改动前**红**（未改动的 main 上复现出她收到的那两行），改后绿 |
| **AC-5** | 哨兵：真「已收 > 成交额」（成交额有值）仍报原来那句 | 接线层 `actualTotal > 0 && covered > actualTotal` | `salesMissingInfoText.test.js` AC-⑤（跑真实 `processSalesTask`） | ✅ 绿（改动前后都该绿 —— 收严哨兵） |
| **AC-6** | 多双 / 混单（#231 / #234 那批）不许回退 | —— | `salesMultiLineTradeType` / `salesMissingInfoText` / `doubaoSalesParser` 全绿；`salesFundTypeDecoupling` 新增「下次收」形状 ×2（现货 / 预定）也全绿 | ✅ 全量 1257 通过 |
| **AC-7** | 配置先行：文案与词表进 `config/` | `config/salesDepositTerms.js`（新，词表＋生产者文案）＋ `config/salesMissingInfoText.js`（新文案＋映射＋合并）＋ `.env.example` 两个新键 | `salesMissingInfoText.test.js` ⑥（`.env.example` ⇄ 默认值逐字一致）；⑤（形状守卫 ⇄ 映射表双向一致，含新形状） | ✅ |
| **AC-8** | 全量连跑 2 次 fail=0 | —— | 见第 8 节 | ✅ |
| **AC-9** | 尾款同义说法矩阵（下次收 / 下次付 / 还要收 / 还要付 / 再收 / 再付 / 尾款 / 余款 / 剩下 / 剩下的 / 还差 / 补收）都算 `owed` | `config/salesDepositTerms` 的 `TAIL_PATTERNS` × 三类词表 | `salesTailPayment.test.js` AC-9（12 条，逐条断言 owed / 成交额 / payments / 缺项） | ✅ 改动前 9 条红，改后全绿 |

### 7.1 顺带收紧的两处（都属于"词表统一"，不是放宽）

1. **`MONEY_NOT_SETTLED_WORDS`**（原来写死在 `normalizeSalesResult` 里）搬进 config，
   并把「下次收 / 下次付 / 还要收 / 还要付 / 再收 / 再付 / 补收 / 补付 / 还差」补进去：
   她说"下次收"同样表示**这单的钱还没结清** —— 不补的话「收了 100，下次收 120」会被
   静默算成"这单就值 100"（把 120 算丢）。**方向是收紧（宁可不套用还价口径），不是放宽。**
2. **`FUTURE_MARKERS`** 补上「再收 / 补收 / 补付 / 还欠 / 还差」：
   「还差 120」这种**本身就表示没付清**的说法，不该再追问"尾款是否已支付"。
   ⚠️ 光秃秃的「付」**没有**放进去 ——「尾款付 140 元」那种说不清算没算付的，**仍然要问**（既有用例钉着）。

---

## 8. 证据汇总

### 8.1 全量测试（**在独立 worktree 里跑，不在主工作区**）

```
$ cd .local/worktrees/tail-payment/server && node --test --test-concurrency=1
ℹ tests 1257   ℹ pass 1257   ℹ fail 0     （第 1 次）
ℹ tests 1257   ℹ pass 1257   ℹ fail 0     （第 2 次）
```

其中 **20 条是本次新增**：`salesTailPayment.test.js` **15 条**（新文件）、
`salesMissingInfoText.test.js` **3 条**（AC-④ ×2 + AC-⑤）、
`salesFundTypeDecoupling.test.js` **2 条**（新形状 × 现货 / 预定两种）。
⚠️ 我**没有**单独在 `origin/main` 上跑过一次全量（那要再建一个 worktree 跑 33 秒），
所以这里**不报"基线是多少条"** —— 只报改动后这一支的实测数字。

### 8.2 配置项（新增 / 改动）

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `SALES_MISSING_INFO_ITEM_AMOUNT_UNKNOWN_TOTAL_TEXT` | `请说明这单成交金额（或定金+尾款分别是多少）：{items}` | 成交额没解析出来时那句（带她的清单） |
| `SALES_MISSING_INFO_UNKNOWN_TOTAL_TEXT` | `请说明这单成交金额（或定金+尾款分别是多少）` | 取不到任何一件货说法时的退路 |

代码侧词表（`config/salesDepositTerms.js`，**不是环境变量**，是"改词表不改逻辑"的配置）：
`TIME_WORDS` · `AUX_WORDS` · `VERB_WORDS`（本次补 `收`）· `TAIL_NOUN_WORDS` · `OWED_HEAD_WORDS` ·
`FUTURE_MARKERS` · `CLAUSE_BOUNDARY_WORDS` · `MONEY_NOT_SETTLED_WORDS` · `SALES_DEPOSIT_TOTAL_UNKNOWN`。

### 8.3 提示词改了哪几句（逐字）

`server/src/services/doubaoService.js` 的 `parseSalesText`（销售解析那段）：

1. **规则 9 新增一条**（"定金 + 尾款 ⇒ 成交金额 = 定金 + 尾款"）：
   > `- ⭐ **定金 + 尾款 ⇒ 成交金额 = 定金 + 尾款**（"两次收款"之和，与第 6 条"各分项之和 = 总额"`
   > `  是同一类推理，**不是新口径**）。例：「定金交了 100 元，下次收 120 元」→ agreed_total = 220、`
   > `  actual_amount = 220、payments 只有定金那 100、owed = 120。`
2. **规则 9.1 抬头放宽 + 补同义说法与"方向词不改变性质"**：
   > `9.1 owed（欠款金额）只在**她明说还没收 / 还没付**时才填：`
   > `   ⭐⭐ **尾款的同义说法一律算 owed（未收的尾款）** ——「下次收 / 下次付 / 还要收 / 还要付 / 再收 / 再付 /`
   > `   尾款 / 余款 / 剩下 / 剩下的 / 还差 / 补收」**都填进 owed**，并把这笔金额**排除在 payments 之外**。`
   > `   🔴 **方向词不改变性质**：她说的是「下次**收** 120 元」——「收」在这里指**这笔钱还没到手、下次收**，`
   > `   **不是**这次已经收到的钱。**绝不要**把「下次收 / 还要收 / 再收 / 补收」的那笔金额写进 payments。`
   > `   例（照这个判断）：「定制一双 37 码的 26632，定金交了 100 元，微信，下次收120元」`
   > `   ⇒ items=[{item_no:"26632",size:37,quantity:1,actual_amount:220}]、payments=[{amount:100,method:"微信"}]、`
   > `      agreed_total=220、owed=120。`

⚠️ 提示词只改了这两处 ＋ 抬头那一行；**"仅有定金不能作为成交金额"那句原样保留**（在规则 9 里）。

### 8.4 后端提示怎么分流的

```js
// larkMvpService.processSalesTask
const coveredAmount = Number(parsed.total_covered ?? parsed.total_paid ?? 0);
if (!parsed.voucher_policy_blocked && actualTotal > 0 && coveredAmount > actualTotal) {
  missingFields.push('已收金额和待平台结算金额不能超过本单成交金额');   // 真·已收 > 成交额
}
// 成交额没解析出来（actualTotal === 0）时**不进这里**；
// 该问的那句由解析层给（只说了定金 ⇒ SALES_DEPOSIT_TOTAL_UNKNOWN）或上面那行「请逐件说明成交金额」。
```

渲染层再把「成交额没解析出来」那句与「请给每双鞋都说一个成交金额」**合成一行**：

```
销售信息还缺 1 处，请照着补一下～
1. 请说明这单成交金额（或定金+尾款分别是多少）：26632 37码
```

---

## 9. ⚠️ 不确定处 / 需要她知道的事

1. **`larkMvpService.js` 与另一代理的分支有同文件改动**（见第 4 节末尾）：本次只动第 1803 行
   那一处判据（8 行），与终态卡 / 按钮无关；但**两边都改这个文件** ⇒ 谁后合谁要重跑全量。
2. **非定金场景的"下次收"**：确定性的尾款识别仍挂在 `depositTerms` 上（要求原话里有「定金」）。
   写「收了 100，下次收 120」（**没有**定金）时：提示词会让模型输出 `owed:120` ⇒ 走既有
   「成交额 = 实收 + 欠款」得到 220；**模型漏给**时，因为 `MONEY_NOT_SETTLED_WORDS` 已含「下次收」，
   系统会**回头问她**（而不是把 120 算丢）。**我没有**在非定金场景加一条确定性金额提取 ——
   超出本次范围，且会多出误判风险。**如果她希望这类也自动算出 220，请告诉我，我再加一条。**
3. **「剩下的」这种名词说法**仍沿用既有的"要跟一个时间词"守门（「剩下的 140 元」会追问
   "尾款是否已支付"）—— 与「尾款付 140 元」同一条既有规则，**本次没放宽**。
4. 本机 **没有跑真实表**、**没有用飞书 CLI**、**没有写任何表**：全部证据来自项目代码的单测与端到端用例。
