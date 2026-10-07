# 销售「信息还缺」追问文案：不泄漏内部字段名 · 一次只说一件事 · 每条给具体动作

**日期**：2026-10-07（真机 18:38）
**起因**：业务负责人在群里发了一条销售（两笔），收到的回复她只问了一句 —— **「这个提醒是什么意思？」**
**性质**：**只改「面向用户的文案」**。判据（什么情况下报缺项 / 不出卡片 / 不入账）**一个字没动**。

> ⚠️ **读之前先看这条**：第 **1~13** 节写的是 **#234 合入之前**的事实（分支 `c63a832`）——
> 里面那句「定金单暂只支持一条明细…」、以及第 6 节那段**改后的逐字文案**，都是**当时**的样子。
> **2026-10-07 稍后 PR #234（「一单多明细」）合入 `origin/main`（`2d852c3`）**，
> **删掉了那句话的生产者**、**新增了另一句** ⇒ 文案与守卫**跟着上游同步过一次**。
> ⭐ **当前有效的事实以第 14 节为准**（那一节含：冲突逐行解法、新句子→新文案对照表、
> 映射与守卫一致性证据、AC-S1~AC-S10 逐条对照）。第 1~13 节**保留原文**，作为那次真机事故的记录。

---

## 1. 真机原文（她 18:38 收到的，逐字）

> 销售信息还缺：定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额、items[0].actual_amount、items[1].actual_amount、payments[0].method、请逐件说明成交金额、已收金额和待平台结算金额不能超过本单成交金额。请补充后重新发送完整销售信息。

她的输入（一条消息里两笔）：

```
119 元，微信。
卖了 31678，40 码。
定制一双 6681-1，42 码，定金 50 元，下次付 39 元
```

## 2. 三个问题（她的话就是判据）

1. 🔴 **内部技术字段名漏给用户看** —— `items[0].actual_amount` / `items[1].actual_amount` / `payments[0].method`。**本轮最严重**。
2. 🔴 **4~5 句不相干的话堆成一段**（用「、」串起来），读不出"到底该做什么"。
3. 🔴 **笼统**：结尾「请补充后重新发送完整销售信息」**没有具体动作**。

## 3. 逐句溯源（改动前：每一句是谁拼出来的）

拼接点是 `server/src/services/larkMvpService.js:1907`：

```js
`销售信息还缺：${draft.missing_fields.join('、')}。请补充后重新发送完整销售信息。`
```

`draft.missing_fields` 由两层拼成：解析层 `normalizeSalesResult` 先给一份，接线层 `processSalesTask` 再追加几条。

| # | 她看到的那一句 | 生产者 | 位置 |
|---|---|---|---|
| 1 | `定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额` | `deposit.issues.push(...)` | `server/src/services/doubaoService.js:284` |
| 2 | `items[0].actual_amount` | `missing.add(\`items[${index}].${key}\`)` | `server/src/services/doubaoService.js:368` |
| 3 | `items[1].actual_amount` | 同上（index = 1） | `server/src/services/doubaoService.js:368` |
| 4 | `payments[0].method` | `missing.add(\`payments[${index}].${method}\`)` | `server/src/services/doubaoService.js:384` |
| 5 | `请逐件说明成交金额` | `missingFields.push('请逐件说明成交金额')` | `server/src/services/larkMvpService.js:1839` |
| 6 | `已收金额和待平台结算金额不能超过本单成交金额` | `missingFields.push(...)` | `server/src/services/larkMvpService.js:1844` |
| — | 外壳「销售信息还缺：…。请补充后重新发送完整销售信息。」 | 模板字符串 | `server/src/services/larkMvpService.js:1907` |

> ⚠️ 上表是 **#234 合入前**的行号与事实。**#234 之后**：第 1 条的生产者已被**删除**（不再产生）、
> 换成了新的一句，第 4 条的 index 从 `[0]` 变成 `[1]` —— **以第 14 节为准**。

> ⭐ 复现方式（离线、零远端请求）：用与上面缺项**逐条对得上**的解析结果喂 `normalizeSalesResult`，
> 再走一遍真实的 `processSalesTask`（打桩 `sendTaskCard`/`sendTaskText`），
> 打印出的群消息与她的真机原文**逐字相同**。

## 4. 验收标准（先写在动手之前）

| 编号 | 标准 | 怎么验 |
|---|---|---|
| **AC-1** | 她那句输入产生的**群回复**里，不出现 `items[数字]` / `payments[数字]` / 下划线字段名（正则 `/items\[\d+\]\|payments\[\d+\]\|_[a-z]+/`） | 渲染器单测 + 端到端单测 + 全量形状守卫单测 |
| **AC-2** | **一次只说一件事**：每条缺项**独立一行**，行内不许用「；」把几句串起来（她那条场景逐字无「；」） | 断言「按编号分行」＋「不含 ；」 |
| **AC-3** | 每条缺项都给**具体动作** | 定金那条逐字含「分开发送」；缺金额那条含「成交金额」＋两个货号；缺收款方式那条含「收款方式」 |
| **AC-4** | 「定金单暂只支持一条明细」这条**不再说「明细」**，改说人话（一双鞋 / 一件货），并**当场给分开发的例子** | 断言不含「明细」、含「一双」、含两个货号 |
| **AC-5** | **判据一个字没动**：同样输入仍然 `needs_info`、仍然不发确认卡片、仍然不入账；`draft.missing_fields` **逐字不变**（仍是那 6 条） | 端到端单测：`status === 'needs_info'`、`sendTaskCard` 未被调用、`draft.missing_fields` 逐字等于改动前那 6 条 |
| **AC-6** | **配置先行**：所有面向用户的句子都在 `config/salesMissingInfoText.js`（含占位符），逻辑里不写死中文 | 单测：改 env 能改文案（含空串回落） |
| **AC-7** | 其它缺项场景**既有行为不破**：缺货 standalone、货号未建档、颜色全下架三条路径**逐字不变**；#231 的「你说的总额 X 与各件金额之和 Y 对不上，请确认每件多少钱～」**保留** | 既有用例 + 新增守卫用例 |
| **AC-8** | 「内部字段名形状」有**一条守卫测试**：把仓库里**所有** `missing_fields` 生产形状列一遍，渲染后出现 `items[..]` / `payments[..]` / 下划线字段名 / 「明细」/ 「；」 就**失败** | 新增 `salesMissingInfoText.test.js` |

## 5. 方案选择：**分行列出**（不是「只回最该做的那一条」）

两条路都允许，**选「分行列出」**，理由三条：

1. **判据不动**是本次硬约束。分行只是**换渲染**，`missing_fields` 一个字不改（AC-5 可直接逐字断言）；
   而「只回最该做的那一条」要在渲染层**丢掉**信息，风险更大、且她修完一条还要再等一轮。
2. **不增加往返次数**：门店老板在手机上，一次说清 3~4 件事比来回 4 轮更省事；
   「一次只说一件事」她指的是**读起来**（不要用「；」串成一句长话），不是"只能告诉她一件"。
3. **同类合并成一条**：`items[0].actual_amount`、`items[1].actual_amount` 与泛化那句
   `请逐件说明成交金额` 本来就是**同一件事**（"每双各说一个成交金额"），
   渲染层把它们**合成一行**按双列出 —— 这正是她抱怨的"堆成一段"的正解。

## 6. 改后的文案（她那条场景，逐字）

```
销售信息还缺 4 处，请照着补一下～
1. 带定金的单一次只能记一双，请把这两双分开发送～
（例如第一条只说「31678 40码」，第二条只说「6681-1 42码」的定金）
2. 请给每双鞋都说一个成交金额：31678 40码、6681-1 42码
3. 收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～
4. 已收的钱比这单成交金额还多，请核对一下收了多少～
```

（上面是按配置默认值渲染的逐字结果，测试里 `HER_EXPECTED_TEXT` 钉的就是它。）

> ⚠️ **#234 合入后这一段的第 1 行变了**（那句的生产者已被删除）—— **当前逐字见第 14.4 节**。

**她那条里的 6 条机器缺项 → 4 行文案**（同类合并）：

| 机器缺项（`missing_fields`，**一个字没改**） | 变成哪一行 |
|---|---|
| `定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额` | 第 1 行（人话 + 分开发送 + 例子） |
| `items[0].actual_amount` + `items[1].actual_amount` + `请逐件说明成交金额` | 第 2 行（**同一件事，合成一条**） |
| `payments[0].method` | 第 3 行 |
| `已收金额和待平台结算金额不能超过本单成交金额` | 第 4 行 |

## 7. 改到的文件（**只有这 6 个**）

> ⚠️ 这是 **#234 合入前**的清单。**上游同步又动了 4 个文件**（含 1 个 #234 的测试）—— 见第 14.3 节。

| 文件 | 改了什么 |
|---|---|
| `server/src/config/salesMissingInfoText.js` | **新增**：全部文案 + 占位符 + 渲染器（逻辑里不写死中文） |
| `server/src/services/larkMvpService.js` | 接线：回复文案（`:1907` 那一支）＋「解析失败原因」列，都改走渲染器（**+24 / −2**） |
| `server/test/salesMissingInfoText.test.js` | **新增**：15 条守卫用例（含全形状守卫） |
| `server/test/larkMvpService.test.js` | 2 条既有断言的**逐字**更新（见第 9 节，都是**收严**） |
| `.env.example` | 25 个 `SALES_MISSING_INFO_*` 文案键 + 说明 |
| `docs/README.md`、本文档 | 文档索引 + 本记录 |

## 8. 边界（明确没碰的东西）

- 🔴 没碰：`pendingDealPush*`、`dailyReport*`/战报、`app.js`、颜色候选那批、交付 / 扣库存 / 入账口径。
- 🔴 没碰 `normalizeSalesResult` 的**校验逻辑**：`missing_fields` 的产生条件与内容**一个字没改**
  （#231 的「总额 vs 各件之和」条目原样保留 —— 它属于"已经是人话且有具体数字"的那一类，
  渲染层**原样透传、不改写一个字**）。
- 🔴 没有 `--admin`、没有部署、没有写生产表、没有改线上 `.env`。
- ⚠️ 顺带把「解析失败原因」列（`failureReason`）也走了同一份渲染器（它原来是
  `missing_fields.join('、')`，同一批代码标识符也在**表格里给她看**）。只是**换渲染**，
  写不写这个字段、什么时候写，判据没动。

## 9. 既有用例改动逐条说明（**为什么不是放宽**）

| 用例 | 原来 | 现在 | 为什么不是放宽 |
|---|---|---|---|
| `larkMvpService.test.js`「她没说定金收了多少…（这一条不放宽）」 | `assert.match(messages[0], /请明确已经收到的定金金额/)` | `assert.equal(messages[0], '销售信息还缺 1 处，请照着补一下～\n1. 请说一句这次收了多少定金～')` | 判据那两条**原样保留**（`task.draft.missing_fields` 仍含原话、仍 `needs_info`、仍 `cards.length === 0`）。文案从"正则匹配 12 个字"改成**整段逐字相等**，是收严。 |
| `larkMvpService.test.js`「缺货之外还有别的问题时，才用完整的补充说明」 | `/请逐件说明成交金额/` | `/请给每双鞋都说一个成交金额：26632 37码、26632 36码/` **＋新增**「不许含 `items[\d+]`/`payments[\d+]`/下划线字段名」＋「不许含 `；`」 | 由 6 个字的片段匹配 → **含两个货号的整句逐字匹配**，并**新增**两条形状禁令。原来的 `/库存里没有 …/`、`/销售信息还缺/` 两条一条没删。 |

其余 1114 条用例**一条未改**（含 `doubaoSalesParser.test.js` 里那些逐字钉 `missing_fields`
的用例 —— 它们仍然绿，正好证明**机器契约没动**）。

## 10. 先红后绿

**红**：把 `server/src/services/larkMvpService.js` 临时还原到改动前（配置与测试都留着），
`node --test test/salesMissingInfoText.test.js test/larkMvpService.test.js` → **4 条红**：

```
✖ 她没说定金收了多少（预付 + 也没库存）→ 仍然要求补充定金金额（这一条不放宽）
✖ 缺货之外还有别的问题时，才用完整的补充说明
✖ ④ 判据没变：她的输入仍然 needs_info、仍然不回卡片、仍然不入账
✖ ④ 表里的「解析失败原因」也不漏代码标识符（同一份渲染器）
```

关键那条红出来的 `actual` **逐字等于她 18:38 收到的原文**：

```
销售信息还缺：定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额、
items[0].actual_amount、items[1].actual_amount、payments[0].method、请逐件说明成交金额、
已收金额和待平台结算金额不能超过本单成交金额。请补充后重新发送完整销售信息。
```

**绿**：还原接线后，同两个文件 **114 / 114 pass、fail 0**；全量 **1114 / 1114 pass、fail 0（连跑 2 次）**。

## 11. 配置项（`config/salesMissingInfoText.js` → `SALES_MISSING_INFO_*`）

- 取值规则同 `salesColorChoice` / `salesProductRegistration`：**没设** → 默认值；
  **设了** → 用设的值；**设成空串 / 只有空白 → 回落默认**（这是她那一刻唯一能看到的解释）。
- **多行**：`.env` 里用 `\n` 两个字符表示换行（`.env` 文件写不了真换行）。
- **占位符**：`{count}`（行数）· `{index}` · `{item}` / `{items}` · `{itemNo}` / `{size}` /
  `{accessoryName}` · `{firstItem}` / `{secondItem}`（定金例子的两件）· `{quantity}`。
- 25 个键的默认值只定义一处（`DEFAULTS_BY_KEY`），`.env.example` 那一段与它**逐字对应** ——
  有一条守门用例（新加文案忘了写文档、或两处改歪了 → 测试红）。
- ⭐ 环境变量层的值会被 `trim()`（`config/envValue` 既有规矩）⇒ 行首编号这类**末尾要空格**的文案
  从 env 配就留不住空格，要空格请用默认值或改成分隔符写法（如 `{index}、`）。

## 12. 验收标准 + 逐条对照

| 编号 | 标准 | 结论 | 证据 |
|---|---|---|---|
| **AC-1** | 她那句输入产生的群回复不含 `items[数字]` / `payments[数字]` / 下划线字段名 | ✅ | `salesMissingInfoText.test.js` ①（正则 `/\bitems\[\d+\]\|payments\[\d+\]\|_[a-z]+/`）+ 端到端 ④（`messages[0]` 逐字相等） |
| **AC-2** | 一次只说一件事：一件事一行，行内不用「；」串句 | ✅ | ②（4 个编号行、无 `；`、结构断言）；⑤（**所有已知形状**渲染后都不含 `；`） |
| **AC-3** | 每条缺项都给具体动作 | ✅ | ③：`请把这两双分开发送`（还给了两个货号的例子）、`请给每双鞋都说一个成交金额：…`、`请补一句是微信、现金还是支付宝` |
| **AC-4** | 「定金单」那条说人话、一眼知道怎么办 | ✅ | ④：不含「明细」、含「一次只能记一双」、含「分开发送」、含两个货号 |
| **AC-5** | 判据一个字没动 | ✅ | ④：`status === 'needs_info'`、`cards === []`、写入只有 `create:salesEntry` + `update:salesEntry`、`draft.missing_fields` **deepEqual** 她那条的 6 条原话（⚠️ 那 6 条的**内容**随 #234 同步过一次，见 14.4；"条数 + 判据"没变，且现在有 ④ 那条**锚在真实解析层**的断言把 fixture 钉死） |
| **AC-6** | 配置先行，逻辑里不写死中文 | ✅ | ⑥：改 env 就改文案；空串回落；`\n` 换行；`renderSalesMissingInfo` 函数体内**没有任何中文字面量**（只有分类正则） |
| **AC-7** | 其它场景既有行为不破 | ✅ | ⑦（缺货 standalone 逐字不变）；⑤(c) 15 条"已经是人话"的**逐字透传**；`doubaoSalesParser.test.js` 全绿（`missing_fields` 未动）；全量 1114 绿 |
| **AC-8** | 一条守卫测试：出现标识符形状就失败 | ✅ | ⑤：`KNOWN_MISSING_FIELD_SHAPES`（38 种已知形状）逐条 + 一次性全喂，断言不含 `items[..]`/`payments[..]`/`_[a-z]`/「明细」/「；」，且**一句都不许被吞掉** |

## 13. CI / 全量

- 全量 `node --test --test-concurrency=1`（在**独立 worktree** 里跑，非主工作区）：
  **连跑 2 次，1114 / 1114 pass、fail 0**（`HEAD=c63a832`、`behind=0`）。
- PR 上的 **CI 三项**（`gh pr checks 233`，全部 pass）：

```
Analyze (javascript-typescript)  pass  1m6s   https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37610059688/job/112754887436
CodeQL                           pass  3s     https://github.com/LyraWang6688/feishu-retail-ops/runs/112755248301
test                             pass  37s    https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37610062030/job/112754890080
```

- `gh pr view 233 --json mergeStateStatus,mergeable,state` → `{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}`
  （**没有**用 `--admin`）。
- CI 上 `pnpm test` 的实际输出（`test` job 日志尾部）：

```
1..1114
# tests 1114
# pass 1114
# fail 0
# duration_ms 22661.133085
```

## 14. 上游变更同步（PR #234 合入后）—— 验收标准（**先写在动手之前**）

**上游已变**：PR **#234**（「一单多明细」）已于 2026-10-07 合入 `origin/main`（`2d852c3`）。
它**删掉了**原来那条整单护栏（`doubaoService.js` 原 `:281-284`）：

```js
if (deposit.tailAmount && items.length !== 1) {
  deposit.issues.push('定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额');
}
```

⇒ **「多明细 + 定金」现在是合法输入**，**那句话不再产生**。同时 #234 **新增**了一句追问
（`config/salesTradeTypePolicy.js` 的 `SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`）——
「哪一件是付了定金的那件说不清」时问一句。本轮只做两件事：**冲突并存 + 映射同步**，
**一行 #234 语义都不改**。

| 编号 | 标准 | 怎么验 |
|---|---|---|
| **AC-S1** | 分支包含 `origin/main`（`2d852c3`）**全部提交**，且**不改写已推送历史**（用 merge，不用 rebase ⇒ 无需 force-push） | `git merge-base --is-ancestor 2d852c3 HEAD` 通过；`git log --oneline` 有 merge 提交；`git rev-list --count HEAD..origin/main` = 0 |
| **AC-S2** | 已知冲突（`larkMvpService.js` **相邻两行**）**两行并存**：`failureReason:` 取 #233 版、`...(tradeTypeRecordIds.length …)` 取 #234 版 | 逐行看 `git diff`（冲突解法表见下节） |
| **AC-S3** | 「定金单暂只支持一条明细…」的映射**保留为历史兜底**，并**补注释标明「上游已删除，仅防历史任务重放」**；且**新输入不再产生**该句 | 注释逐字存在；用例：同一份输入走 `normalizeSalesResult` **不再**产出该句 |
| **AC-S4** | #234 **新增**的那句（`SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`）**有人话映射**（不再原样透传），并且**可配**（进 `DEFAULTS_BY_KEY` + `.env.example`） | 单测：该形状渲染后 **≠ 原文**；`.env.example` 键集合与配置一致 |
| **AC-S5** | **映射表 ⇄ 形状守卫双向一致**：`MAPPED ∪ PASSTHROUGH == KNOWN`，且两者 **⊆ KNOWN** —— 不许出现"映射里有、形状列表里没有"或反之 | 新增一致性用例逐条断言（含 `KNOWN` 无重复、无遗漏） |
| **AC-S6** | 守卫覆盖**所有当前生产者形状**（含 #234 新句）；任何已知形状渲染后都不含 `items[..]` / `payments[..]` / `_[a-z]` / 「明细」/「；」，且**一句都不许被吞掉** | 全形状守卫用例（一次性全喂 + 逐条单独喂） |
| **AC-S7** | 既有断言**不放宽**（收严可以）；她那一条的 fixture 与**真实解析层输出逐字同步** | `HER_PARSED_MISSING_FIELDS` 改为真实输出，并**新增**断言 `deepEqual normalizeSalesResult(...).missing_fields` 把它钉住（比原来更严） |
| **AC-S8** | 受影响用例 + 全量 `node --test --test-concurrency=1` **连跑 2 次、fail = 0**（在**独立 worktree** 内跑，不在主工作区） | 两次运行的实际输出 |
| **AC-S9** | `gh pr checks 233` **三项全 pass**，`mergeStateStatus: CLEAN`（**禁止 `--admin`**） | gh 实际输出 |
| **AC-S10** | **没碰** #234 语义（交易类型逐明细 / 主表多选 / 交付判据 / 金额口径），也没碰 `pendingDealPush*`、`dailyReport*`、`app.js`、颜色候选那批 | `git diff --stat` 文件清单与逐行 diff |

> ⭐ 冲突解法（**AC-S2**，机械解、两边语义都不动）：原来相邻的两行各自被一边改过 ——

| 行 | #233 的版本 | #234 的版本 | 解法 |
|---|---|---|---|
| `failureReason:` | `missingInfoLines.join('\n')` | （未改） | **取 #233 版** |
| `...(tradeTypeRecordIds.length …)` | （未改） | `...(tradeTypeRecordIds.length ? { tradeType: relation(tradeTypeRecordIds) } : {})` | **取 #234 版** |
| 结果 | — | — | **两行并存**，一行都不删、都不改写 |

### 14.1 为什么用 **merge** 而不是 rebase（选择与理由）

**选 merge**（`git merge origin/main`，产生 merge 提交 `7fa6a2e`），理由三条：

1. ⭐ **这就是本仓库的既有做法** —— `origin/main` 的历史里有 **3 个** `Merge remote-tracking branch
   'origin/main' into <分支>` 提交（`9e8b567` / `16facc1` / `f07109b`），**rebase 提交 0 个**
   （`git log origin/main | grep -ci rebase` = 0）。
2. ⭐ **这是一条【已开 PR 的分支】** —— rebase 会改写**已推送**的历史，必须 force-push；
   merge **不改写任何历史**、**不需要 force-push**，风险最低（任务书也明说"不确定就用 merge"）。
3. ⭐ **它把"上游已变"这件事本身留在了历史里** —— 以后 `git log` 一眼看得到
   "这条分支在哪一刻并入了 #234"，而不是把两个改动揉成一条看不出因果的线性历史。

### 14.2 冲突逐行解法（AC-S2 证据）

`git merge --no-edit origin/main` 只报了**一个**冲突文件（`server/src/services/larkMvpService.js`），
其余（含 `docs/README.md`、`doubaoService.js`、`salesTradeTypePolicy.js`）**全部自动合并**。
冲突 hunk 就是任务书说的那**相邻两行**：

```text
<<<<<<< HEAD
        failureReason: draft.missing_fields?.length ? missingInfoLines.join('\n') : '',
        ...(tradeTypeRecordId ? { tradeType: relation(tradeTypeRecordId) } : {}),
=======
        failureReason: draft.missing_fields?.length ? draft.missing_fields.join('、') : '',
        // 「交易类型」是**多选**关联字段：一个 id 就是单选（长度 1），多个就是多选。
        ...(tradeTypeRecordIds.length ? { tradeType: relation(tradeTypeRecordIds) } : {}),
>>>>>>> origin/main
```

**解法 = 两行并存**（一行都不删、都不改写语义）：

```js
        // ⭐ 这一行是 #233 的（缺项文案人话化）：渲染成分行的人话。
        failureReason: draft.missing_fields?.length ? missingInfoLines.join('\n') : '',
        // ⭐ 这一行是 #234 的（一单多明细）：交易类型**按明细行**收集、主表**多选**。
        // 两行来自不同的改动，各自都是对的、互不相干 —— 所以**两行并存**，一行都不删。
        // 「交易类型」是**多选**关联字段：一个 id 就是单选（长度 1），多个就是多选。
        ...(tradeTypeRecordIds.length ? { tradeType: relation(tradeTypeRecordIds) } : {}),
```

> ⚠️ 顺带一个**必须**取 #234 版的硬理由：`tradeTypeRecordId`（单数）在 #234 之后**已经不存在**
> （`grep -n "tradeTypeRecordId\b" src/services/larkMvpService.js` → **无匹配**）。
> 若机械地"取 HEAD"，那一行会变成 **`ReferenceError`** —— 这不是风格选择，是对错问题。

**AC-S1**：`git rev-list --count HEAD..origin/main` = **0**；`git merge-base --is-ancestor 2d852c3 HEAD` ✅；
`git log --oneline` 里有 `7fa6a2e Merge remote-tracking branch 'origin/main' into fix/sales-missing-info-wording`。
**全程没有 `--force`、没有 force-push、没有改写已推送历史。**

### 14.3 改到的文件（本轮上游同步：**4 个**）

| 文件 | 来源 | 改了什么 |
|---|---|---|
| `server/src/config/salesMissingInfoText.js` | #233 新增 | ＋1 条**新映射**（`deposit_target_ambiguous`，2 个 env 键）＋旧映射**降级为历史兜底并补「上游已删除」注释** |
| `server/test/salesMissingInfoText.test.js` | #233 新增 | fixture 与**真实解析层输出**同步＋**新增 4 条用例**（一致性 / 一增 / 一删 / fixture 锚定）＋形状清单补齐 6 条 |
| `.env.example` | #233 新增段 | ＋2 个键；旧那两条**标注为历史兜底** |
| `server/test/salesMultiLineTradeType.test.js` | **#234 新增** | ⚠️ **只动了 `AC-11` 里那张"旧护栏残留白名单"的判定方式**（**收严**，见 14.5）—— 其它 13 条 AC 一个字未改 |

🔴 **#234 的生产代码一行未改**：`doubaoService.js` / `salesTradeTypePolicy.js` / `salesOrderService.js` /
`salesMovements.js` / `salesDeliverySummary.js` / `v1ReferenceResolver.js` —— `git diff --name-only` **全空**。

### 14.4 ⭐ 新句子 → 新文案对照表（逐字）+ 她那一条改后的完整文案

**（a）#234 改动/新增的缺项文案，逐条核对**（`doubaoService.js` 侧只有"一增一删"）：

| # | 生产者原文（逐字） | 现在还有吗 | 映射后的文案（逐字） |
|---|---|---|---|
| 1 | `定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额` | ❌ **#234 已删除生产者**（"多明细 + 定金"现在是**合法输入**） | **保留**为历史兜底：`带定金的单一次只能记一双，请把这两双分开发送～` ＋ 续行 `（例如第一条只说「31678 40码」，第二条只说「6681-1 42码」的定金）`（正好两件时）；不是两件时 `带定金的单一次只能记一双，请把这几双分开发送～` |
| 2 | `这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪双是预付、每双多少钱～` | ✅ **#234 新增**（`config/salesTradeTypePolicy.SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`） | `这一单里哪双是付了定金的那双，我有点拿不准～请对着「31678 40码、6681-1 42码」逐双说清楚哪双是预付、每双多少钱～`（**点出这一单的每一双**）；一件货都取不出来时 `这一单里哪双是付了定金的那双，我有点拿不准～请逐双说清楚哪双是预付、每双多少钱～` |
| 3 | `成交价与定金加尾款不一致，请核对` | ✅ 仍在（#234 只是把它挪进了 `else` 分支，**文案一个字未改**） | `成交价和「定金 + 尾款」对不上，请核对一下～` |
| 4 | `items[0].actual_amount` / `items[1].actual_amount` / `payments[1].method` | ✅ 仍在（**index 从 `payments[0]` 变成 `payments[1]`** —— 多明细时定金那笔不再独占 `payments`） | 与 #233 时相同：`请给每双鞋都说一个成交金额：31678 40码、6681-1 42码` / `收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～` |

> ⭐ 逐个找法（**不是猜**）：`grep -n "issues\.push\|missing\.add\|missingFields\.push" src/` 列出全部生产者，
> 再对 `2d852c3^1 → 2d852c3` 做逐行 diff —— `doubaoService.js` 侧只有上面第 1、2 条是增/删，第 3、4 条只是**位置**变了。
> ⚠️ 第 2 条**原本会"原样透传"**（它不含标识符 /「；」/「明细」，**过得了**守卫），
> 所以这条映射是**必须的**：不接它，她就看不到"到底是哪几双"。

**（b）她那一条（`HER_PARSED()`）改后的完整文案，逐字**：

```text
销售信息还缺 4 处，请照着补一下～
1. 这一单里哪双是付了定金的那双，我有点拿不准～请对着「31678 40码、6681-1 42码」逐双说清楚哪双是预付、每双多少钱～
2. 请给每双鞋都说一个成交金额：31678 40码、6681-1 42码
3. 收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～
4. 已收的钱比这单成交金额还多，请核对一下收了多少～
```

机器清单（`draft.missing_fields`，**判据没动**）随之变成这 6 条（= 真实 `normalizeSalesResult` 输出）：

```text
这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪双是预付、每双多少钱～
items[0].actual_amount
items[1].actual_amount
payments[1].method
请逐件说明成交金额
已收金额和待平台结算金额不能超过本单成交金额
```

⭐ 这条清单现在**锚在真实解析层上**（新增用例 ④）：
`assert.deepEqual(HER_PARSED_MISSING_FIELDS, HER_PARSED().missing_fields)` ——
上游谁再改 `missing_fields` 的**字**，这条**立刻红**（比原来"手抄一份、只跟接线层对上"更严）。
这也是**先红**的证据：合并后**未同步**时它是红的（`actual` 里第 1 条正是**原样透传**的新句、
第 4 条是 `payments[1].method`）。

### 14.5 ⚠️ 唯一一处"动了 #234 的测试"：`AC-11` 白名单（**是收严，不是放宽**）

#234 的 `AC-11` 原本断言「全 `src/` 里含那句旧护栏的文件**只许一个**（`salesTradeTypePolicy.js`）」。
按业务负责人"**保留为历史兜底、补注释标明上游已删除**"的要求，那句话**必然**还要出现在
`src/config/salesMissingInfoText.js`（**文案配置**，不是判据）里 ⇒ **那张白名单必须动**，
否则只能二选一：要么放弃历史兜底，要么删掉 #234 的保护。两者都不该做。

⇒ 改成**按角色 + 必须有标记**判定，**三条都比原来严**：

| 维度 | 原来 | 现在 | 严在哪 |
|---|---|---|---|
| `src/services/`（判据 / 生产者的家） | 没有单独约束 | **一个字都不许有** | **新增**一条独立禁令 |
| 每个残留文件 | **不要求任何标记** | **必须**带自己的**显式历史标记**（`salesTradeTypePolicy.js` → `不是**原来那条整单护栏`；`salesMissingInfoText.js` → `上游已删除`） | 原来只要文件名对就行；现在"没说清这是历史"就红 |
| 白名单 | 硬编码 1 个文件 | 1 → 2 个文件，**且加一个必须同时给出标记** | 加文件的门槛变高 |

**变异测试证明它真的会咬**（改完立刻还原、`shasum` 校验一致）：

```text
变异 A：拿掉 #234 新句的人话映射        → ✖ ② ③ ④ ⑤ 守卫…（多条红）
变异 B：删掉「上游已删除」标记          → ✖ AC-11 那条整单判据在解析层已删除  (fail 1)
变异 C：把旧护栏加回 doubaoService.js   → ✖ AC-11 那条整单判据在解析层已删除  (fail 1)
还原校验：CFG restored OK / PARSER restored OK
```

### 14.6 ⭐ 映射表 ⇄ 形状守卫的一致性证据（AC-S5 / AC-S6）

原来**有 6 条形状既不在 `MAPPED` 也不在 `PASSTHROUGH`**（index=1 的 5 条 + `第2件…` 1 条）——
即"形状列表里有、映射表里没有"，等于**那 6 条没人守**。本次**补齐**，并加了一条**双向一致性用例**：

- `KNOWN_MISSING_FIELD_SHAPES`（**当前**生产者形状，**40** 条）
- `HISTORICAL_MISSING_FIELD_SHAPES`（**历史**形状，1 条：#234 已删的那句）
- `ALL_GUARDED = KNOWN + HISTORICAL`（**41** 条）
- `MAPPED`（**26** 条）＋ `PASSTHROUGH`（**15** 条）= **41** = `ALL_GUARDED` ✅

用例 `⑤-一致性` 逐条断言：① 四张清单**各自无重复**；② `KNOWN ∩ HISTORICAL = ∅`；
③ `MAPPED`/`PASSTHROUGH` **⊆** `ALL_GUARDED`（防"映射里有、形状没有"）；
④ `MAPPED ∩ PASSTHROUGH = ∅`（防两边都放）；⑤ **反过来**每一条形状**正好**归入其一
（防"形状里有、映射里没有"）；⑥ 两清单合起来**排序后正好等于** `ALL_GUARDED`。

⭐ 另有一条 `⑤ 上游已变（增）` 直接 `require('../src/config/salesTradeTypePolicy')` 取
`SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS` **常量本身**来断言（形状清单里必须是它、必须被映射），
所以**生产者改了字 → 立刻红**，不会悄悄退化成原样透传。

> ⚠️ 更正一处旧数字：第 4 节 AC-8 与本文件早前写的「**38 种**已知形状」是**当时数错了**
> （实际 40 条）。本轮把它拆成 `KNOWN`(40) + `HISTORICAL`(1)，并由一致性用例**强制**与映射表对齐。

### 14.7 AC-S1~AC-S10 逐条对照

| 编号 | 结论 | 证据 |
|---|---|---|
| **AC-S1** 含 `2d852c3` 全部提交、未改写历史（merge） | ✅ | `rev-list --count HEAD..origin/main` = 0；`merge-base --is-ancestor 2d852c3 HEAD` ✅；merge 提交 `7fa6a2e`；**无 force-push** |
| **AC-S2** 冲突两行并存、两边语义都不改 | ✅ | 14.2 逐行解法；`tradeTypeRecordId`（单数）全仓无匹配 → 取 #234 版是**必须**的 |
| **AC-S3** 旧句降级为历史兜底并带「上游已删除」注释；新输入不再产生 | ✅ | 用例 `⑤ 上游已变（删）`；`salesMissingInfoText.js` 注释「上游已删除，仅防历史任务重放」；AC-11 变体 B 红 |
| **AC-S4** #234 新句有人话映射、可配 | ✅ | 14.4(a) 第 2 行；用例 `⑤ 上游已变（增）`；`.env.example` 键集合一致用例 ⑥ 绿 |
| **AC-S5** `MAPPED ∪ PASSTHROUGH == KNOWN` 双向一致 | ✅ | 14.6；用例 `⑤-一致性`（六条断言） |
| **AC-S6** 守卫覆盖全部当前生产者形状（含新句）且不泄漏 | ✅ | 用例 `⑤ 守卫`（一次性全喂 + 逐条单独喂，41 条）；形状清单里的新句**逐字 = 生产者常量** |
| **AC-S7** 既有断言不放宽；fixture 与真实解析层同步 | ✅ | 新增用例 `④ fixture 与真实解析层输出逐字同步`（`deepEqual` 真实 `normalizeSalesResult`）；第 9 节的"收严"说明仍成立 |
| **AC-S8** 受影响用例 + 全量连跑 2 次 fail=0 | ✅ | 见 14.8（`node --test --test-concurrency=1`，worktree 内，**1128 / 1128 × 2**） |
| **AC-S9** `gh pr checks` 三项全 pass、`CLEAN`、未用 `--admin` | ✅ | 见 14.8 |
| **AC-S10** 没碰 #234 语义与禁碰清单 | ✅ | 14.3：`git diff --name-only` 里**没有**任何 #234 生产代码；`pendingDealPush*`/`dailyReport*`/`app.js`/颜色候选 **git status 全空** |

### 14.8 全量 / CI（本轮实际输出）

- 受影响用例（`salesMissingInfoText` + `larkMvpService` + `doubaoSalesParser` +
  `salesMultiLineTradeType` + `salesPrepaidColorResolution`）：**全绿**。
- 全量 `node --test --test-concurrency=1`（**在独立 worktree 内**跑，非主工作区；
  `HEAD=7fa6a2e`、`behind=0`）：**连跑 2 次，1128 / 1128 pass、fail 0**。

```text
run 1: ℹ tests 1128  ℹ pass 1128  ℹ fail 0  ℹ duration_ms 19848.676292
run 2: ℹ tests 1128  ℹ pass 1128  ℹ fail 0  ℹ duration_ms 18959.973375
```

- PR 上的 **CI 三项**（`gh pr checks 233`）与 `mergeStateStatus`：见 **14.9**（含实际输出；
  `headRefOid = 0e46d7c`，三项全 pass，`CLEAN`，未用 `--admin`）。

### 14.9 PR #233 状态（本轮 push 后）

- **push 方式**：`git push origin HEAD:fix/sales-missing-info-wording` → `012fe50..0e46d7c`
  —— **fast-forward，没有 `--force`、没有 `--force-with-lease`**（因为走的是 merge，
  没改写任何已推送历史；push 前已确认 `origin/…` 是 `HEAD` 的祖先：**只有我在动这条分支**）。
- `gh pr checks 233`（`headRefOid = 0e46d7c`）—— **三项全 pass**：

```text
Analyze (javascript-typescript)  pass  1m17s  https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37613188452/job/112765158503
CodeQL                           pass  2s     https://github.com/LyraWang6688/feishu-retail-ops/runs/112765533846
test                             pass  51s    https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37613194807/job/112765174390
```

- `gh pr view 233 --json mergeStateStatus,mergeable,state,headRefOid` →

```json
{"headRefOid":"0e46d7cfe0652c1a0bf552c628d31b5f0acc51f6","mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}
```

⭐ 合并前对照：并入 #234 **之前**同一 PR 是 `mergeStateStatus: DIRTY`（就是那处冲突）；
本轮 merge 后变 **`CLEAN`**。**没有用 `--admin`。**

- CI 上 `pnpm test` 的实际输出（`test` job 日志尾部）：

```text
1..1128
# tests 1128
# pass 1128
# fail 0
# duration_ms 33714.000449
```

> ⚠️ **没有合并、没有部署**（合并由 Lead / 业务负责人做；部署必须拿她**当次**的命令）。

## 15. 不确定处 / 已知剩余面

- ⚠️ **`解析结果摘要`（`parseSummary`）里仍然是机器清单**（`JSON.stringify(draft)`，含
  `items[0].actual_amount`）。这是**有意保留**的：它是排查用的原始快照，不是给她看的文案
  （`failureReason` 那一列已经人话化了）。若她将来要看这一列，再单独议。
- ⚠️ 渲染器按**生产者原话的字头**认句子（`TEXT_TOPIC_PATTERNS`）。生产者哪天改了那几个字，
  对应条目会退化成"原样透传"（不会崩、也不会丢信息，只是文案回到改动前的样子）——
  守卫用例盯着"不许漏标识符 / 「明细」/「；」"，所以退化会被测出来。
- ⚠️ 行首编号文案从环境变量配时**末尾留不住空格**（`config/envValue` 会 `trim()`）——
  已在配置注释与 `.env.example` 里写明（默认值不受影响，`{index}. ` 照旧）。
- ⚠️ 我没有真机验证（**没有部署**）；上面全部是本地 + CI 的代码级证据。

### 15.1 本轮（上游同步）新留下的不确定处

- ⚠️ **唯一一处动了 #234 测试的地方**：`server/test/salesMultiLineTradeType.test.js` 的 `AC-11`
  里那张"旧护栏残留白名单"。改法**净收严**（新增 `src/services/` 全面禁令 + 每个残留必须带显式标记，
  见 14.5），但它**确实是"改了别人的断言"** ⇒ **请 Lead / 业务负责人复核这一处**。
  若口径是"宁可不留历史兜底、也不许碰 #234 测试"，那正确做法是**删掉 `deposit_multi_line`
  那条映射 + 历史形状条目**（一行配置 + 一条清单），AC-11 即可**原样恢复**；代价是
  "改动前落盘的 `needs_info` 老任务被重放"时那一条会退化成**原样透传**（含「明细」和「；」）。
- ⚠️ **"老任务重放"这条路径我没有实测**（没有构造一份改动前的任务 JSON 去跑 `resumePending`）。
  保值判断是**代码级**的：`missing_fields` 确实会落盘（本地任务 JSON + `parseSummary`），
  重放时确实会再走一次渲染。若认为重放不可能发生，这条兜底就可以删（见上一条）。
- ⚠️ **新映射的措辞是我拟的**（「请对着「…」逐双说清楚哪双是预付、每双多少钱～」），
  **没有经她真机确认**。它全部可配（`SALES_MISSING_INFO_DEPOSIT_TARGET_AMBIGUOUS_TEXT` /
  `..._GENERIC_TEXT`），要改不用动代码。⚠️ 我**刻意保留了原话的两个要点**（哪双是预付 /
  每双多少钱），因为"每双多少钱"在"两件都有金额、只是没说哪件是预付"的变体里**是唯一的问法**——
  删了会漏信息；代价是她那条场景里第 1、2 行**都**提到金额（轻微重复，但不是"堆成一段"）。
- ⚠️ 她那一条 fixture 里缺项从 `payments[0].method` 变成 `payments[1].method`：
  这是"一条消息两笔、定金那笔没说方式"在**多明细**下的**正确**形状（#234 之前定金那笔会独占
  `payments`，所以是 `[0]`）—— **不是新 bug**，是 #234 的预期行为。
- ⚠️ 第 4 节 AC-8 与旧文本里的「38 种已知形状」是**当时的漏数**（实为 40）。
  本轮已更正，并由 `⑤-一致性` 用例**强制**形状清单与映射表对齐，防止再数错。

