# 销售「信息还缺」追问文案：不泄漏内部字段名 · 一次只说一件事 · 每条给具体动作

**日期**：2026-10-07（真机 18:38）
**起因**：业务负责人在群里发了一条销售（两笔），收到的回复她只问了一句 —— **「这个提醒是什么意思？」**
**性质**：**只改「面向用户的文案」**。判据（什么情况下报缺项 / 不出卡片 / 不入账）**一个字没动**。

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

**她那条里的 6 条机器缺项 → 4 行文案**（同类合并）：

| 机器缺项（`missing_fields`，**一个字没改**） | 变成哪一行 |
|---|---|
| `定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额` | 第 1 行（人话 + 分开发送 + 例子） |
| `items[0].actual_amount` + `items[1].actual_amount` + `请逐件说明成交金额` | 第 2 行（**同一件事，合成一条**） |
| `payments[0].method` | 第 3 行 |
| `已收金额和待平台结算金额不能超过本单成交金额` | 第 4 行 |

## 7. 改到的文件（**只有这 6 个**）

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

其余 1113 条用例**一条未改**（含 `doubaoSalesParser.test.js` 里那些逐字钉 `missing_fields`
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

**绿**：还原接线后，同两个文件 **112 / 112 pass、fail 0**；全量 **1113 / 1113 pass、fail 0（连跑 2 次）**。

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
| **AC-5** | 判据一个字没动 | ✅ | ④：`status === 'needs_info'`、`cards === []`、写入只有 `create:salesEntry` + `update:salesEntry`、`draft.missing_fields` **deepEqual** 她那条的 6 条原话 |
| **AC-6** | 配置先行，逻辑里不写死中文 | ✅ | ⑥：改 env 就改文案；空串回落；`\n` 换行；`renderSalesMissingInfo` 函数体内**没有任何中文字面量**（只有分类正则） |
| **AC-7** | 其它场景既有行为不破 | ✅ | ⑦（缺货 standalone 逐字不变）；⑤(c) 15 条"已经是人话"的**逐字透传**；`doubaoSalesParser.test.js` 全绿（`missing_fields` 未动）；全量 1113 绿 |
| **AC-8** | 一条守卫测试：出现标识符形状就失败 | ✅ | ⑤：`KNOWN_MISSING_FIELD_SHAPES`（38 种已知形状）逐条 + 一次性全喂，断言不含 `items[..]`/`payments[..]`/`_[a-z]`/「明细」/「；」，且**一句都不许被吞掉** |

## 13. CI / 全量

- 全量 `node --test --test-concurrency=1`（在独立 worktree 里跑）：**连跑 2 次，1113 / 1113 pass、fail 0**。
- PR 上的 `gh pr checks` / `mergeStateStatus`（`CLEAN` 才算过）见 PR 正文与收尾汇报。

