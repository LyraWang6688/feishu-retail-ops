# 「全到」类说法等价（都到了 / 都到货了 / 全部到货 …）—— 2026-10-07

> 状态：**实现中**（本文第 2 节的验收标准**先写**，代码后写；逐条对照见第 8 节）
> 分支：`fix/arrival-all-arrived-phrases`（独立 worktree `.local/arrival-all-arrived`）
> 范围：**只让"全到"的说法被正确识别**。判据（什么时候出卡片、什么时候不写表）**一个字不动**。

## 1. 起因（真机，2026-10-07 21:52 她自己撞到的）

```
她在 202610072 那个话题里发「都到了」   → ✅ 解析成 complete:true / same:true → 出卡片 → 确认后入库 12 行
她在 202610071 那个话题里发「都到货了」 → ❌ 解析成 complete:false / same:false
   → purchase.arrival.reconcile.no_arrival_content（"这句话里没有可核对的到货信息"）→ 不出卡片
```

两句话**意思完全一样**，只是多了「货」两个字，结果却是两种 ⇒ **说法差异导致的漏判**。
业务负责人口径：「**这个也可以做～**」（= 同意修）。

## 2. ⭐ 验收标准（**先写，再动手**；第 8 节逐条对照）

| # | 验收标准 | 判据（怎么算达标） |
|---|---|---|
| AC-1 | **提示词层**把「全到」的多种说法显式列为**等价**（`same:true`），并说明"多了『到货 / 齐 / 收到』这些字眼不算差异" | `parseArrivalReconciliation` 的提示词原文里能读到这些说法 + 等价的说明；有用例钉住原文 |
| AC-2 | 汇报里**写明解析在哪**（文件 / 行 + 是提示词还是代码） | 本文第 3 节 |
| AC-3 | **代码侧兜底（正）**：模型什么都没给出来（`same !== true` 且 `differences` 空）时，「都到了 / 都到货了 / 全部到货 / 都到齐了 / 都齐了 / 全到了 / 都收到了 / 全部到齐 / 齐了」以及**带标点 / 空白 / 语气词的变体** → 一律解析成**全部到齐**（`same:true`、`differences:[]`） | 9 条基础说法逐条 `same === true`（真机那句「都到货了」必须在内）+ 变体用例 |
| AC-4 | **兜底不越界（反）**：「到了 2 双」「8230 到了 1 双」「还有一双没到」「有一双没到」「38 码少一双」「没到」「都到了吗」「都到货了吗？」「39 码到了 4 双」、以及"多句里夹着具体内容"→ **不许** `same:true` | 逐条 `same === false`，并把**兜底不生效的原因**断言出来 |
| AC-5 | 兜底层**只补漏、不覆盖**模型的具体结论 | 模型给出 `differences` 时逐条保留（不被清空）；模型 `same:true` 时行为不变 |
| AC-6 | **判据零改动**：`purchaseArrivalConversationService` 的 `hasArrivalContent` / 出卡片 / 写表逻辑，以及 `purchaseWebhookService` / `config/v1BitableSchema` **一个字没动** | `git diff --stat` 只出现：`config/arrivalConversation.js`、`services/doubaoService.js`、测试、文档 |
| AC-7 | **配置先行**：词组清单进 `config/`，注释写明"这是为了兜住模型的漏判"；换清单不改代码 | 清单在 `config/arrivalConversation.js` 的 `ARRIVAL_ALL_PRESENT_PHRASES`；纯函数可按注入的清单工作（有用例证明） |
| AC-8 | **真机症状本身**：把**真实解析层**接进**真实 service**（模型返回"什么都没给出来"= 真机那次模型的形状）时，「都到货了」→ **出卡片**；「还有一双没到」→ `no_arrival_content`、**零卡片** | 集成用例断言 `card:true` / 卡片 1 张 / 计划 = 按申请数 / 零业务表写入 |
| AC-9 | **不写任何表、不部署** | 所有用例里 gateway 写入 = 0；没碰 `.env` 与生产 Base；没跑任何部署脚本 |
| AC-10 | **全量回归**：`node --test --test-concurrency=1` **连跑 2 次 fail=0** | 第 9 节贴原始输出 |

## 3. 解析在哪（AC-2）

| 层 | 文件 / 行 | 是什么 |
|---|---|---|
| 提示词 | `server/src/services/doubaoService.js` 第 **757–792** 行（`parseArrivalReconciliation` 里的 `prompt` 模板） | **提示词**："差异只有三类"的第 1 类、以及规则 2（`same`）里列的是哪些说法 |
| 解析（代码归一） | 同方法第 **806–826** 行（`differences` 过滤 + `result`） | **代码**：把模型 JSON 收敛成 `{complete, same, differences}` |
| 判据（**本次不改**） | `server/src/services/purchaseArrivalConversationService.js` 第 **300** 行 `hasArrivalContent = parsed.differences.length > 0 \|\| parsed.same === true`、第 **301–316** 行 | **代码**：没有内容 → `purchase.arrival.reconcile.no_arrival_content`、不发卡片、不写表 |

⇒ 「都到货了」被漏判的**直接原因在提示词**（模型没把它认成"完全一样"）：`same=false` +
`differences=[]` → 撞上第 300 行的判据 → 不发卡片。

⇒ **本次兜底加在解析层（`doubaoService.parseArrivalReconciliation` 的返回值里）**，
也就是**第 300 行那条判据之前**：让模型漏掉的"全到"说法在**解析结果**里就变成 `same:true`，
由既有判据接住。这样 **`purchaseArrivalConversationService` 一行都不用改**
（该文件在另一个代理手上，见第 10 节边界）。

（下面第 4–9 节是改动与证据。）

## 4. 关键 diff（AC-1 / AC-3 / AC-5 / AC-7）

三处改动，**都在"解析"这一层**（`server/src/services/doubaoService.js` ＋ `server/src/config/arrivalConversation.js`）：

### 4.1 提示词（模型层）：把「全到」的说法列全，并点明"多了字眼不算差异"

```diff
 差异只有三类：
-1. 完全一样（例如「都到了」「一件不差」「跟单子一样」）
+1. 完全一样（例如「都到了」「都到货了」「全部到货」「都到齐了」「都齐了」「全到了」「都收到了」「全部到齐」「齐了」「一件不差」「跟单子一样」）
 2. 实际比申请多（例如「多了两双 39」「39 码到了 4 双」）
 3. 实际比申请少（例如「少了两双 38」「38 码只到了一双」）
@@ 规则 2 @@
-2. same：她说「完全一样 / 都到了 / 一件不差 / 没有差异」时填 true，此时 differences 留空数组。
+2. same：她说「完全一样 / 都到了 / 都到货了 / 全部到货 / 都到齐了 / 都齐了 / 全到了 / 都收到了 / 全部到齐 / 齐了 / 一件不差 / 没有差异」时填 true，此时 differences 留空数组。
+   ⚠️ 这些说法是**同一个意思（整批全到）**，只是她的字眼不同：只要她**没有说出具体货号、尺码或双数**，
+   多了「到货 / 齐 / 收到」这样的字眼**不算差异** —— 一律 same=true、differences=[]。
+   ⚠️ 反过来，只要她给的是**具体内容**（例：「39 码到了 4 双」「少了两双 38」「8230 到了 1 双」
+   「还有一双没到」），就必须按第 2 / 3 类算具体差异，**不许**当成"整批全到"。
```

⚠️ **提示词里没有动类别**：差异仍然只有三类（一样 / 多 / 少），**没有**新增第四类，也没有放宽
"有具体内容"的判断。

### 4.2 代码侧兜底（关键）：模型**什么都没给出来**时才补一句"这是全到"

```diff
+    const modelSaidSame = parsed?.same === true;
+    // ⭐ 代码侧兜底：**只在模型什么都没给出来时**生效 —— 模型给出了具体差异（或自己说了 same）时，
+    //    这里一个字都不动（不覆盖模型的结论）。
+    const bareAllArrived = (modelSaidSame || differences.length > 0)
+      ? { matched: false, reason: 'model_already_gave_content' }
+      : detectBareAllArrivedTranscript(messages, ARRIVAL_ALL_PRESENT_PHRASES);
     const result = {
-      complete: parsed?.complete === true,
-      same: parsed?.same === true,
+      complete: parsed?.complete === true || bareAllArrived.matched,
+      same: modelSaidSame || bareAllArrived.matched,
       differences,
     };
```

判定本体（`detectBareAllArrivedStatement`，纯函数）**逐步收口**，任一步不过就不兜底：

1. **疑问**（`?` / `？` / `吗`）→ 不算（"都到了吗"是问句，不是到货反馈）；
2. 去空白与标点（`\p{P}` / 全角空格 / 换行）后为空 → 不算；
3. **否定词**（`没 / 未 / 不 / 少 / 差 / 缺 / 剩 / 退 / 漏 / 空`）→ 不算；
4. **有具体内容**（阿拉伯数字/字母 正则 ＋ 中文数量字 ＋ 数量单位）→ 不算；
5. **整句必须能被清单词完整切分**（贪心最长匹配，清单外任何一个字 → 不算）；
6. 切出来的词里**至少要有一个"全到"标记**（`全部/整批/全都/全齐/收齐/全/都/到齐/齐`）
   **和一个到货动词**（`到齐/到货/收到/到了/来了/全齐/收齐/齐/到`）→ 才算 `bare_all_arrived`。

多条消息（话题里的累积原话）再包一层 `detectBareAllArrivedTranscript`：
① 整段拼起来就是裸说法；**或** ② **最新一句**是裸说法、且**其它消息里没有任何具体内容**
（否则她可能正在说具体差异、只是模型没解析出来 —— 那时**绝不兜底**）。

`purchase.arrival.reconcile.parsed` 日志补两个排查字段：
`bare_all_arrived`（兜底是否生效）与 `bare_all_arrived_reason`
（`bare_all_arrived` / `model_already_gave_content` / `concrete_content` / `negation` /
`question` / `out_of_vocabulary` / `no_complete_word` / `no_arrival_word` /
`other_message_has_concrete_content` / `empty…`）。

### 4.3 为什么兜底放在解析层，而不是那条判据前一行

`hasArrivalContent` 那条判据在 `purchaseArrivalConversationService.js` 第 300 行 ——
**那个文件在另一个代理手上**（写采购 / 到货的写入链路），任务书明确"不要碰"。
把兜底做在**解析层**（`parseArrivalReconciliation` 的返回值里），
等价于"在判据之前"生效：判据读到的是**已经归一成 `same:true` 的结果**，
于是**既有判据（`differences 非空 || same === true`）原样接住**，
**那个文件一行都不用改**（AC-6）。判据本身**一个字没动**。

## 5. 配置项（AC-7）

`server/src/config/arrivalConversation.js` 新增导出 `ARRIVAL_ALL_PRESENT_PHRASES`（冻结对象）：

| 键 | 值 | 作用 |
|---|---|---|
| `completeWords` | `全部 / 整批 / 全都 / 全齐 / 收齐 / 全 / 都 / 到齐 / 齐` | "整批全到"的意思标记（至少一个） |
| `arrivalWords` | `到齐 / 到货 / 收到 / 到了 / 来了 / 全齐 / 收齐 / 齐 / 到` | 到货动词（至少一个） |
| `fillerWords` | `已经 / 完毕 / 了 / 啦 / 呢 / 啊 / 哦 / 呀 / 嘛 / 哈` | 允许多出来的语气词（**不含数量信息**） |
| `negationWords` | `没 / 未 / 不 / 少 / 差 / 缺 / 剩 / 退 / 漏 / 空` | 命中 → **不兜底** |
| `questionMarkers` | `? / ？ / 吗` | 命中 → **不兜底**（问句不是到货反馈） |
| `numberWords` | `零 一 二 两 三 四 五 六 七 八 九 十 半 几` | 命中 → **不兜底**（有具体数量） |
| `quantityUnitWords` | `双 / 个 / 件 / 只 / 箱 / 码 / 号 / 款 / 色 / 对` | 命中 → **不兜底**（有具体数量/货号） |
| `concreteContentPattern` | `[0-9０-９A-Za-z]` | 命中 → **不兜底**（阿拉伯数字 / 货号字母） |

- 文件里的注释**逐字写明**："**这是为了兜住模型的漏判**，不是新业务规则"（用例 AC-7 ① 钉住这句话）。
- **没有加任何环境变量**：这不是开关（开关会让"忘了配"变成静默失效），是一份**行为词表**。
- 纯函数 `detectBareAllArrivedStatement(text, phrases)` 支持**注入清单** ⇒ 换清单不改代码
  （用例 AC-7 ②：把 `满 / 进了` 加进清单，`满进了` 立刻被认出来）。

## 6. 兜底的正 / 反向用例清单（AC-3 / AC-4）

用例文件：`server/test/arrivalAllArrivedPhrases.test.js`（新增，13 条）。

**正（→ 必须 `same:true`）**：`都到了`（真机 202610072，钉住别回退）· `都到货了`（⭐真机 202610071，本次新增）·
`全部到货` · `都到齐了` · `都齐了` · `全到了` · `都收到了` · `全部到齐` · `齐了` · `全都到了` ·
`到齐了` · `全齐了` · `都收齐了` · `都到了啦`（语气词）· `都到货了。`（标点）· `都 到 货 了`（空格）·
`['你好 小来财', '都到货了']`（话题里先有闲聊）。

**反（🔴 必须 `same:false`、仍走原来的差异比对 / 追问）**：`到了 2 双` · `8230 到了 1 双` ·
`还有一双没到` · `有一双没到` · `38 码少一双` · `39 码到了 4 双` · `没到` · `都到了吗` ·
`都到货了吗？` · `都到了，XHB8095 差一双` · `嗯，我看看` · `你好` ·
`['39 码多一双', '都到货了']`（多句里夹着具体内容）。

**只补漏、不覆盖（AC-5）**：模型给出 `differences` 时**逐条保留**；模型自己 `same:true` 时行为不变。

**集成（AC-8）**：真实解析层 ＋ 真实 `PurchaseArrivalConversationService`（gateway **写就抛错**）：
`都到货了` → `card:true`（1 张卡、计划 = 按申请数 38→2 / 39→2、**零业务表写入**）；
`还有一双没到` → `no_arrival_content`、**零卡片**、**零写入**、任务里**不生成 plan**。

## 7. 先红后绿证据（AC-3 / AC-4 / AC-8）

**改动前**（`HEAD=f3bd452`，只加测试文件、未改任何源码）：
`node --test --test-concurrency=1 test/arrivalAllArrivedPhrases.test.js` → **tests 13 / pass 5 / fail 8**，
其中真机那句与真机症状本身：

```
✖ AC-3 正②（真机原句单钉）：「都到货了」→ same:true（本次新增的那条）
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  ...
✖ AC-8 ①（真机症状）：「都到货了」→ 出卡片（改动前：no_arrival_content、一张卡片都没有）
  {"event":"purchase.arrival.reconcile.no_arrival_content","task_id":"arrival_reconcile_a417d07210d41410bc03d38d",
   "batch_no":"BH-20261007-0001","message_count":1,"parse_complete":false,
   "note":"这句话里没有可核对的到货信息：不发卡片、不写业务表"}
  AssertionError [ERR_ASSERTION]: 「都到货了」必须出卡片
  + actual - expected
  + undefined
  - true
```

⇒ 红的是**真机那条现象本身**（`no_arrival_content` 日志 + 不出卡片），不是"用例写错了"。

**改动后**：同一条命令 → **tests 13 / pass 13 / fail 0**（第 9 节贴原始输出）。

## 8. 验收标准逐条对照（AC-1 ~ AC-10）

| # | 验收标准 | 结论 | 证据 |
|---|---|---|---|
| AC-1 | 提示词把多种「全到」说法列为等价，并说明"多了到货/齐/收到这些字眼不算差异" | ✅ 达标 | 用例 `AC-1`（逐字断言 8 个说法 + `同一个意思（整批全到）` + `不算差异`）；第 4.1 节 diff |
| AC-2 | 汇报写明解析在哪（文件 / 行 + 提示词还是代码） | ✅ 达标 | 第 3 节表格（提示词 `doubaoService.js:868/882`，代码归一 `:929`，判据 `purchaseArrivalConversationService.js:300`） |
| AC-3 | 兜底（正）：16 种说法 / 变体一律 `same:true` | ✅ 达标 | 用例 `AC-3 正①/②/③` |
| AC-4 | 兜底不越界（反）：含具体内容 / 否定 / 疑问 → 不许 `same:true` | ✅ 达标 | 用例 `AC-4 反①/②/③`（13 条逐条钉住 + 4 个"为什么不算"的原因） |
| AC-5 | 只补漏、不覆盖模型的具体结论 | ✅ 达标 | 用例 `AC-5 ①/②`（`differences` 逐条保留） |
| AC-6 | 判据零改动：不碰 `purchaseArrivalConversationService` / `purchaseWebhookService` / `v1BitableSchema` | ✅ 达标 | `git diff --stat`：只有 `config/arrivalConversation.js`、`services/doubaoService.js`、`test/doubaoArrivalReconcileParse.test.js` ＋ 2 个新文件（测试 / 文档） |
| AC-7 | 配置先行 + 注释写明"兜住模型的漏判" | ✅ 达标 | 用例 `AC-7 ①/②`；第 5 节 |
| AC-8 | 真机症状：真实解析层 + 真实 service，「都到货了」出卡片；「还有一双没到」仍不出 | ✅ 达标 | 用例 `AC-8 ①/②` |
| AC-9 | 不写任何表、不部署 | ✅ 达标 | 集成用例的 gateway **写就抛错**（`written` 必须为空）；全程没跑任何部署脚本、没碰 `.env` 与生产 Base |
| AC-10 | 全量连跑 2 次 fail=0 | ✅ 达标 | 第 9 节 |

⚠️ **一处需要说清楚的对既有用例的修改**：`test/doubaoArrivalReconcileParse.test.js` 的
`提示词③` 原来**逐字钉住旧的那句 same 清单**（只有「都到了 / 一件不差 / 没有差异」）——
本改动把清单补全后它必然红。已把那条断言改成**头尾锚定**（`完全一样 / 都到了 / 都到货了 …没有差异」时填 true`），
**它钉住的意图没变**（same 仍是"完全一样"这一类、没有新增第四类差异），逐字清单改由本文件 AC-1 钉。

## 9. 全量 2 次 + CI

**全量（在【独立 worktree】里跑，`server/` 下 `node --test --test-concurrency=1`，连跑 2 次）**：

```
HEAD=dde137d 后的代码（分支 fix/arrival-all-arrived-phrases）
=== RUN 1 ===
run1 exit=0
ℹ tests 1222
ℹ pass 1222
ℹ fail 0
=== RUN 2 ===
run2 exit=0
ℹ tests 1222
ℹ pass 1222
ℹ fail 0
=== 两次的 ✖ 行（应为空）===
（空）
```

⚠️ 没有在主工作区跑全量（主工作区还有别的任务在用；这条纪律按 AGENTS.md 执行）。

**新用例单独跑**：`node --test --test-concurrency=1 test/arrivalAllArrivedPhrases.test.js`
→ `tests 13 / pass 13 / fail 0`（改动前同一条命令：`tests 13 / pass 5 / fail 8`）。

**CI（三项实际输出）**：见 PR 上的 `gh pr checks` 输出（`test` / CodeQL）。
⚠️ 合并由业务负责人做，本分支**不合并、不部署**。

## 10. 边界与不确定处

- **写作用域**（遵守任务书的边界）：本分支只碰
  `server/src/config/arrivalConversation.js`、`server/src/services/doubaoService.js`、
  `server/test/arrivalAllArrivedPhrases.test.js`（新）、
  `server/test/doubaoArrivalReconcileParse.test.js`（只改一条**提示词逐字断言**）、`docs/`。
  🔴 **未碰**：`services/purchaseWebhookService.js`、`services/purchaseArrivalConversationService.js`、
  `config/v1BitableSchema.js`（在另一个代理手上）、销售侧、`pendingDealPush*`、`app.js`。
- 🔴 **没写任何表**（集成用例的 gateway 写就抛错）、**没部署**、**没改线上 `.env`**、**没碰生产 Base**。
- ⚠️ **不确定处 1（保守取舍）**：**光说「到了」不算"全到"**（可能是"只到了一件"），
  仍然交给模型 —— 这正是"绝不放宽"的取舍。若业务负责人希望「到了」也算全到，改 config 一个词即可
  （但要她拍板）。
- ⚠️ **不确定处 2（词表长度）**：兜底用的是**整句完整切分**，所以
  「都到货了哦耶」「都到货了哈哈哈」（清单外语气词）不会被兜底 —— 走模型。
  加语气词进 `fillerWords` 就能覆盖，但每加一个词都是**多一分误判风险**，
  所以只收了她实际说过的（`了/啦/呢/啊/哦/呀/嘛/哈`）＋旧收尾话术「完毕」。
- ⚠️ **不确定处 3（模型层无法在 CI 里验）**：提示词只钉"原文在不在"；
  模型认不认得出**只有真机能证**。真机复现步骤：在某一批采购单的话题里只发一句
  **「都到货了」** → 应出卡片；日志应有
  `purchase.arrival.reconcile.parsed` 且 `"bare_all_arrived":false`（模型这次认出来了）
  或 `"bare_all_arrived":true`（兜底接住）——**两种情况都出卡片**。
- ⚠️ **不确定处 4**：本机（含 CI）都**没有**跑真模型；集成用例用的是"假 client + 真解析层"，
  所以它证的是"解析层 → 判据 → 出卡片"这条**代码链**，不是模型行为。

