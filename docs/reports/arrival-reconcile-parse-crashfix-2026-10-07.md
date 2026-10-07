# 「到货核对」一解析就崩（`text is not defined`）修复记录 · 2026-10-07

> 线上现象（业务负责人 2026-10-07 14:11（+8）真机测试，服务器生产日志逐字）：
> ```json
> {"ts":"2026-10-07T06:11:58.373Z","level":"warn","event":"purchase.arrival.reconcile.parse_failed",
>  "task_id":"arrival_reconcile_53ce68877412d0580e83226d","error":"text is not defined"}
> ```
> 换算上海时间：`2026-10-07T06:11:58.373Z` → **2026-10-07 14:11:58（+8）**。
> 她在**采购单图片的话题**里回复到货情况 → 话题认出、批次定位 `202610071` 都对
> （`purchase.group.thread.bound` / `purchase.batch.located` / `arrival.reconcile.started`）→
> **解析这一步崩了** → 没有卡片、没有下文。

---

## 一、验收标准（**动手之前先写**）

> 纪律：先写「改完之后应该是什么样」，再改代码，最后逐条对照（对照结果见第六节）。

| # | 验收标准 | 判据（怎么算达标） |
| - | -------- | ------------------ |
| A1 | `parseArrivalReconciliation` 不再抛 `ReferenceError: text is not defined` | 用**假 client 打桩**（不走真模型）跑真实方法：合法 JSON 与脏数据两条路都不出现 `text is not defined` |
| A2 | 所有调用点都改成仓库既有的 `textValue`，**一处不剩** | `grep -n 'text(' server/src/services/doubaoService.js` 为 **0 行**；`textValue` 从 `./v1BitableGateway` require（不新造 helper） |
| A3 | 不引入循环依赖 / 加载副作用 | `require('./v1BitableGateway')` 不（直接或间接）require `doubaoService`；空环境下 require 不抛错；`.env` 加载顺序回归用例仍绿（AGENTS.md 第 5 条） |
| A4 | 正常路解析正确 | 合法 JSON（含 more/less/same 三类差异）→ `complete` / `same` / `differences` 都对，字段经 `textValue` 归一 |
| A5 | 脏数据路**如实报错** | 非 JSON / 空回复 → 抛「到货核对解析失败: …」；**不是** `ReferenceError` |
| A6 | 字段缺失路不崩 | `{}` / `null` → 缺省收敛（`complete:false`、`same:false`、`differences:[]`），非法条目被过滤 |
| A7 | ⭐ **这个 bug 再犯，CI 立刻红** | 新增回归用例：**先**在未修的代码上跑 → 红（`text is not defined`）；修完 → 绿 |
| A8 | 🔴 **业务口径一个字都不动** | 三类差异（一样/多/少）、`complete` 判定（只认模型）、入库规则**都没改** |
| A9 | 同类问题排查结论 | 对 `doubaoService.js` 与到货/采购链路做作用域感知静态扫描，结论如实写清 |
| A10 | 全量测试 2 次 fail=0 | `node --test --test-concurrency=1` 连跑 **2** 次，两次都 `fail 0` |
| A11 | 开 PR、CI `CLEAN`、不合并、不部署 | `gh pr checks` 全 pass、`mergeStateStatus` = `CLEAN`；**禁止** `--admin`、**禁止**部署 |

---

## 二、根因与证据

`server/src/services/doubaoService.js` 的 `parseArrivalReconciliation`（`:542`）里用的是
**没有定义的 `text(...)`**。`git show HEAD:server/src/services/doubaoService.js` 实测：

```
$ git show HEAD:server/src/services/doubaoService.js | grep -n 'text('
548:      .map((row) => `${text(row.item_no) || '（未知货号）'} / ${text(row.color) || …
597:        item_no: text(item?.item_no),
598:        color: text(item?.color),
600:        type: text(item?.type).toLowerCase(),

$ git show HEAD:server/src/services/doubaoService.js | grep -o 'text(' | wc -l
5          # 4 行 / 5 个调用点（`:548` 那一行里有两个）
```

文件里既没有 `const text = …`，也没有 require 它 ⇒ 调用即
`ReferenceError: text is not defined` ⇒ 被 `purchaseArrivalConversationService` 的
`catch` 记成 `purchase.arrival.reconcile.parse_failed`（日志里的 `error:"text is not defined"`）。

仓库里的**唯一正确实现**是 `textValue`（`server/src/services/v1BitableGateway.js:19`），
别的 service 就是这么引的（例：`purchaseArrivalConversationService.js:2`）。

> **为什么没有测试拦住**：`test/arrivalConversation.test.js` 用的是**假 recognizer**
> （`async parseArrivalReconciliation(input) { … }`），真实方法**从来没被任何用例执行过** ——
> 于是"变量未定义"这种崩溃一路漏到线上。本 PR 补上真实方法的用例。

---

## 三、修法（最小改动）

1. `doubaoService.js` 顶部加 `const { textValue } = require('./v1BitableGateway');`
2. 上述 **4 行 / 5 个调用点**的 `text(` → `textValue(`（`:548` 两个 + `:597/:598/:600` 各一个）。

**循环依赖查证**（AGENTS.md：如实说明）：`v1BitableGateway` 的模块依赖是
`@larksuiteoapi/node-sdk` / `node:fs` / `node:path` / `config/v1BitableSchema` /
`config/larkAgent` / `utils/larkLogger` / `utils/logger` —— **没有任何一条回到
`doubaoService`**；`doubaoService` 的调用方是 `larkMvpService` 与 `purchaseWebhookService`，
它们本来就 require `v1BitableGateway`。⇒ **不构成循环依赖，不需要另找实现**。

加载副作用实测：

```
$ env -i PATH="$PATH" HOME="$HOME" node -e "require('./src/services/v1BitableGateway'); …"
gateway loads with empty env: OK            # v1BitableSchema 的 appToken 是 getter，不在 import 阶段抛错
$ node -e "require('./src/services/doubaoService')"   # 也不抛
```

`.env` 加载顺序（AGENTS.md 第 5 条）：`doubaoService` 只被 `.env` 之后的业务 require 链
拉起，`test/appDotenvLoadOrder.test.js` 在两次全量里都绿。

---

## 四、回归测试（本次最重要的产出之一）

新增 `server/test/doubaoArrivalReconcileParse.test.js`（10 条），**用假 client 打桩真实方法**
（`service.clients.text = { chat: { completions: { create } } }`，不走网络、不碰真模型、
CI 上不需要真 key）：

| 用例 | 拦住什么 |
| ---- | -------- |
| 正常路①三类差异 more/less/same | 三类都能解析出来；**提示词里必须有申请明细与累积原话**（崩的就是拼明细那一步）；type 大小写归一；`same` 的 quantity 归 0 |
| 正常路②markdown 包裹的 JSON | 既有行为不许退化 |
| 正常路③飞书单元格形状（`{text}` / `[{text}]`） | 证明用的是既有的 `textValue`（裸 `String()` 会得到 `[object Object]`） |
| 脏数据路①非 JSON | 抛「到货核对解析失败」，**断言不是 `ReferenceError`、不含 `text is not defined`** |
| 脏数据路②空回复 | 同上（模型被拦/截断） |
| 脏数据路③缺输入 | 「原话不能为空」「缺少采购申请明细」，且不崩 |
| 字段缺失路① `{}` / `null` | 缺字段不崩，缺省收敛 |
| 字段缺失路②非法条目 | `quantity=0` / 缺数量 / 非数字尺码 / 非整数 / `size<=0` / 未知 type / `same` 带差异数 / `null` 全被过滤，只留合法那条 |
| ⭐ 防复发①（运行时） | 只要实现里再出现未定义的 `text`，这次调用立刻 `ReferenceError: text is not defined` |
| ⭐ 防复发②（源码级） | 去注释后 `doubaoService.js` 里不许再出现裸的 `text(` 调用；且必须从 `./v1BitableGateway` 取 `textValue` |

**先红后绿（A7 的直接证据）**——在**未修**的代码上跑**同一份**用例
（`git stash push server/src/services/doubaoService.js` → 跑 → `git stash pop`）：

```
✖ 正常路①②③ · ✖ 脏数据路①② · ✖ 字段缺失路①② · ✖ ⭐ 防复发①②
  ReferenceError: text is not defined
      at server/src/services/doubaoService.js:548:21
ℹ tests 10   ℹ pass 1   ℹ fail 9
```

**9/10 红**，唯一的例外是「脏数据路③：缺输入」—— 它在碰到 `text(` **之前**就抛了
「原话不能为空」，正好说明红是因为那一行、而不是因为用例本身写错。
修完之后：`ℹ tests 10  ℹ pass 10  ℹ fail 0`。

---

## 五、同类问题排查（A9）

仓库里**没有 eslint**（`server/package.json` 只有 `node --test`），所以写了一个
**作用域感知的粗粒度扫描器**（`/tmp/undef-scan2.js`，约 60 行）：
按"类成员"把文件切成作用域区域，找出「被调用，但模块级 / 当前作用域里都没有定义」的名字；
注释、字符串、模板字面量都被抹掉，**但保留 `${…}` 插值里的代码**（线上这个 bug 正好藏在
`` `${text(row.item_no)} …` `` 的插值里，不保留插值就抓不到）。

它**确实能抓到这个 bug**（证明不是空跑）：

```
# 对线上那份（HEAD）
doubaoService.js:548: 调用了 `text(`  —— 所在方法（第 542 行起）作用域里没有它   ← 2 个
doubaoService.js:597: 调用了 `text(`
doubaoService.js:598: 调用了 `text(`
doubaoService.js:600: 调用了 `text(`
共 5 处可疑

# 对到货/采购链路的 8 个文件（修完之后）
server/src/services/doubaoService.js
server/src/services/purchaseArrivalConversationService.js
server/src/services/purchaseBatchLocator.js
server/src/services/purchaseWebhookService.js
server/src/services/inventoryService.js
server/src/services/larkMvpService.js
server/src/config/arrivalConversation.js
server/src/services/arrivalCostPolicy.js
→ 只剩 1 处：purchaseWebhookService.js:3303 `prefixString(` —— 已人工核对为**扫描器假阳性**：
  那里是 `` `${prefix}${String(max + 1).padStart(4, '0')}` `` 两个相邻插值被拼在一起，
  `prefix` 就在上面两行定义（`:3300`）、`String` 是内置；全文件 `grep prefixString` 无此名字。
```

**结论：到货/采购链路上没有别的"用了没定义的变量/函数"**（本次只发现并修掉 `text` 这一处）。
补充说明：对整个 `src/` 全量扫还有 27 处命中，逐条人工核对后**全部是同一形状的假阳性**
（相邻模板插值被拼接、以及 2 空格缩进的对象字面量/类成员被误当作作用域边界，
例：`v1ReferenceResolver.js` 的 `normalizeColor`/`generateCorrections`、
`saleLookupService.js` 的 `asText`/`fieldValue`/`asOptionalNumber`、
`salesOrderNo.js` 的 `readExistingNos`/`writeOrderNo` —— 核过**都在各自文件里定义过**，
后两个是解构形参）。这个扫描器是**启发式**的，不是编译器 / linter，结论按此理解。

---

## 六、逐条对照与实测输出

| # | 结果 | 证据 |
| - | ---- | ---- |
| A1 | ✅ | 新增「防复发①」+ 两条脏数据路：修完 10/10 绿，全程无 `text is not defined` |
| A2 | ✅ | `grep -n 'text(' server/src/services/doubaoService.js` → **0 行**；`git diff` 显示 **4 行 / 5 个调用点**全改为 `textValue`，`textValue` 来自 `./v1BitableGateway` |
| A3 | ✅ | 空环境 require 实测 OK；`git diff` 只加了 1 行 require（+注释）；`appDotenvLoadOrder.test.js` 两次全量都绿 |
| A4 | ✅ | 正常路①（more/less/same 三类）+ 提示词断言（申请明细 + 累积原话） |
| A5 | ✅ | 脏数据路①②：`assertParseFailed` 同时断言"是解析失败"且"**不是** ReferenceError / 不含 text is not defined" |
| A6 | ✅ | 字段缺失路①② |
| A7 | ✅ | 先红（`pass 1 / fail 9`，失败原因是 `ReferenceError: text is not defined @ :548`）后绿（`pass 10 / fail 0`）；另有源码级钉子 |
| A8 | ✅ | `git diff` 全文只有：1 行 require + 4 行调用点（`text(`→`textValue(`）+ 注释；差异三类、`complete` 判定、入库规则**零改动** |
| A9 | ✅ | 见第五节：链路内仅 `text` 一处，已修；剩余命中均为已核对的扫描器假阳性 |
| A10 | ✅ | 见下（2 次 920/920） |
| A11 | ⏳ | PR / CI 结果见本节末尾与 PR 描述 |

**全量测试（A10）**：`HEAD=d682b22`、`HEAD..origin/main = 0`（对齐最新 main），

```
===== RUN 1 =====  exit=0   ℹ tests 920  ℹ pass 920  ℹ fail 0   duration_ms 25317
===== RUN 2 =====  exit=0   ℹ tests 920  ℹ pass 920  ℹ fail 0   duration_ms 25136
```

（改动前是 910 条，本次新增 10 条回归用例。）

**CI（A11）**：本地不合并、不部署 —— 结果以 `gh pr checks` 为准，见 PR。
