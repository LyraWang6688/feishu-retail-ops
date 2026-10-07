# 换货的两种情形：同款换码走不通（真机 2026-10-07 23:06）

> 业务负责人的口径（逐字）：
> 「我们一般换货的情况是这样子：**1. 换尺码（尺码不合适）  2. 换另一双鞋**（这双鞋可能
>  不太喜欢，又换了另一双）。如果换货是这两种情况的话，目前我们的提示词是能够涵盖的吗？」
>
> 她已确认要修（「好的，你派人做吧！」），三项改动都点头了：
> **甲** 提示词补"同款换码"规则 · **乙** 接线层放宽判据 · **丙** 追问话术分情况。

## 1. 真机事实（2026-10-07 23:06，她的原话与机器人的两次回复）

```
她发：「6C98012-15L 换成41码」
解析（sales.ai.parsed 逐字）：intent="exchange" ✅ · action="" · new_item_no="" · new_color="" · new_size=""
                              items=[{item_no:"6C98012-15L", size:""}]   ← 货号被填进【销售字段 items】了
机器人回：「换成哪一双？发我货号和颜色。」
她回：「6C98012-15L」（回答追问）
机器人回：「这个我还没学会～你可以说"卖一双 6035黑 42码 199"，或者"帮我查 6035 黑"」
```

两条独立的问题：

1. **同款换码被拦死**：`afterSalesFlowService.resolveOutgoing` 的判据是"必须有 `new_item_no`"
   —— 而"换尺码"本来就不该有新货号（同款换码，货号还是原那双）。
2. **追问之后不接上下文**：她补的那句（只说一个货号）掉进了"这个我还没学会"的兜底。
   ⚠️ **这一条本件不做**（见第 8 节：先核过，销售链路**没有**这套多轮机制）。

## 2. 验收标准（动手之前先写的）

| # | 改完之后应该是什么样 |
|---|---|
| AC-1 | 她发「6C98012-15L 换成41码」→ 解析出 `intent=exchange` / `action=exchange` / `item_no=6C98012-15L`，且 `new_size=41`（new_* 至少一个非空）→ **不再**回「换成哪一双」，**直接出确认卡片**（同款换码：换的就是原那双、新尺码 41；差价 0、不动钱） |
| AC-2 | 换另一双「把 6035 黑 38 换成 1366-33 黑 40」→ `new_item_no=1366-33`、`new_color=黑`、`new_size=40` 各就各位，新的一双照旧解析出来（这条路一个字不改） |
| AC-3 | 售后（return / exchange）的**规范化结果里不许出现销售字段** `items` / `payments` / `agreed_total`（守门） |
| AC-4 | 追问话术分情况（文案走 `config/`）：三者全空 → 「换成哪一双？发我货号，**或者只说新尺码也行**。」；有货号/颜色、只缺尺码 → 「换的那双 X 多大码？」（逐字沿用） |
| AC-5 | 真「什么都没说」（只发「换一双」）→ **仍然追问**，不许放宽到瞎猜 |
| AC-6 | 既有的退货（`return`）用例**不许回退**（哨兵） |
| AC-7 | 提示词第 13 条**逐字**写明两种换货 + 各一个逐字例子（真机那句 + 换另一双）+ 重申"return/exchange 不许把货号填进 items" |
| AC-8 | 放宽判据**不等于猜**：一个字段都不替她填；金额不许用标价/原价**推算** |
| AC-9 | ⚠️ 追问后的多轮接续（她真机第二句）**本件不做** —— 先核多轮现状，若没有就停下来汇报（见第 8 节） |
| AC-10 | 排查日志看得见：`sales.ai.parsed` / `sales.ai.normalized` 里要有 `new_color` / `new_size` / `new_amount`（真机那次日志只有 `new_item_no`，"new_size 空没空"只能靠猜） |

## 3. 逐条对照

| # | 结论 | 证据 |
|---|---|---|
| AC-1 | ✅ 达标 | `server/test/afterSalesFlow.test.js`「⭐ 同款换码（业务负责人真机那句）」：用**逐字原话**跑完整编排 → `texts` 为空（不再追问）、出 1 张确认卡片、`new_lines=[p3/size_41/230]`、`diff_amount=0`、`requires_settlement=false`、点确认后执行器收到的 `settlement=null` / `diffAmount=0`。⚠️ 一处判断见第 9 节（金额取原明细的成交金额） |
| AC-2 | ✅ 达标 | 同上文件「换另一双：新货号 / 新颜色 / 新尺码各就各位」+ `server/test/doubaoExchangeParse.test.js`「② 换另一双」；既有用例「换货：解析"换成的那一双"（差价建议 70）」原样通过 |
| AC-3 | ✅ 达标 | `doubaoExchangeParse.test.js` 两条守门：真机那句（`new_size=41`）与**真机那次的模型输出形状**（货号被塞进 `items`）→ 规范化结果里 `'items' in result === false` |
| AC-4 | ✅ 达标 | 配置 `AFTER_SALES_ASK_TEXTS`（`config/afterSalesFlow.js`）；用例逐字断言「换成哪一双？发我货号，或者只说新尺码也行。」与「换的那双 1366-33棕 多大码？」 |
| AC-5 | ✅ 达标 | 用例「新货号 / 新颜色 / 新尺码三者全空 → 仍然追问，不瞎猜」：`cards` 为空、文案逐字、任务落 `after_sales_asking` |
| AC-6 | ✅ 达标 | 新增哨兵「⑥ 退货（return）不受换货改动影响」+ `afterSalesFlow.test.js` 既有的 20 余条 `return` 用例全部原样通过（退货路径一行未改） |
| AC-7 | ✅ 达标 | 用例「提示词第 13 条：逐字写明…」逐条 `includes` 断言（含两个逐字例子与"不许把货号填进 items"） |
| AC-8 | ✅ 达标 | 判据只回答"她有没有说换给她的那一双"；缺项仍逐项问（`need_new_size` / `need_new_amount`）；`new_amount` 只认她说的，标价只作为**换另一双**时卡片上的**建议值**（改动前的既有口径，未动） |
| AC-9 | ✅ 按口径停下汇报 | 见第 8 节（销售链路没有这套机制 ⇒ 本件不发明；`docs/todo-followup-supplement-multiturn.md` 那份队列里的最小改法**排在换货这件之后**） |
| AC-10 | ✅ 达标 | `doubaoExchangeParse.test.js`「排查日志带上 new_color / new_size / new_amount」：抓 `sales.ai.parsed` / `sales.ai.normalized` 两条日志断言 `new_size=41` |

## 4. 三处改动（逐字）

### 甲 提示词（`server/src/services/doubaoService.js`，规则 13）

在 `new_item_no / new_color / new_size / new_amount 是**换给/赔给她的那一双**…` 之后**插入**
（顺序：先说清两组字段，再分清两种换货；其余规则一字未动）：

```
    ⭐ 换货（action="exchange"）有**两种**，先分清是哪一种，再填上面两组字段：
      · **换尺码（同款换码）**——尺码不合适，还是**同一双鞋**、只换一个码：
        item_no / color 填**原来那双**；new_item_no **可以留空**（也可以等于原货号）；
        **必须填 new_size = 新尺码**（她说的那个新码）。
        ⚠️ 她说「换成 41 码」**就是换尺码**，**不是**"没说要换哪双" ——
           这种话里 new_size 必须填出来，不许留空、也不许把 41 当成原那双的 size。
        例：「6C98012-15L 换成41码」⇒
          {"intent":"exchange","action":"exchange","item_no":"6C98012-15L","color":"","size":"",
           "new_item_no":"","new_color":"","new_size":41,"new_amount":"","settlement":"","diff_amount":""}
      · **换另一双**——这双不喜欢了，换**另一双鞋**：new_item_no = 新货号；
        她说得出新颜色 / 新尺码 / 新金额就一起填进 new_color / new_size / new_amount。
        例：「把 6035 黑 38 换成 1366-33 黑 40」⇒
          {"intent":"exchange","action":"exchange","item_no":"6035","color":"黑","size":38,
           "new_item_no":"1366-33","new_color":"黑","new_size":40,"new_amount":""}
        ⚠️ 换另一双时，她没说的那一项留空，**不要拿原那双的颜色/尺码去补**、也不要猜。
    🔴 intent="return" 或 "exchange" 时**不许把货号填进 items**（items / payments / agreed_total
      都是**销售字段**，售后结果里一个都不许出现）——上面两个例子里从来没有 items。
```

### 乙 接线层放宽判据（`server/src/services/afterSalesFlowService.js` → `resolveOutgoing`）

```diff
-  async resolveOutgoing(parsed = {}) {
-    const itemNo = String(parsed.new_item_no || '').trim();
-    const color = String(parsed.new_color || '').trim();
-    if (!itemNo) return { ok: false, reason: 'need_new_item', message: '换成哪一双？发我货号和颜色。' };
-    const size = positiveInteger(parsed.new_size);
-    if (!size) return { ok: false, reason: 'need_new_size', message: `换的那双 ${itemNo}${color} 多大码？` };
+  async resolveOutgoing(parsed = {}, original = {}) {
+    const spokenItemNo = …; const spokenColor = …; const spokenSize = positiveInteger(parsed.new_size);
+    // 三者全空 = 她没提"换给她的那一双"的**任何**信息 → 回一句问她（只有这一档才问）。
+    if (!spokenItemNo && !spokenColor && !spokenSize) return { … needNewItem };
+    // 同款换码 = 她没给新货号，或给的就是原货号（提示词第 13 条：可以留空、也可以等于原货号）
+    const sameItem = !spokenItemNo || (originalItemNo && spokenItemNo.toLowerCase() === originalItemNo.toLowerCase());
+    const itemNo = spokenItemNo || originalItemNo;
+    const color = spokenColor || (sameItem ? originalColor : '');
```

- 判据：**`new_item_no` / `new_color` / `new_size` 三者任一有值即算齐全**，只有**三者全空**才回追问。
- ⚠️ **不猜**：一个字段都不替她填；缺尺码/缺金额仍逐项问；`diff_amount` 仍然只认她说的
  （`buildPlan` 里那两行没动）。
- ⚠️ 唯一一处"取原单的值"：**同款换码时**新那一双的**成交金额取原明细的成交金额**
  （同一双鞋换个码、钱不变 ⇒ 差价 0、不动钱）。理由与边界见第 9 节。

### 甲′ 排查日志（`server/src/services/doubaoService.js` → `salesParseSnapshot`）

```diff
   new_item_no: String(result.new_item_no || '').slice(0, 80),
+  // ⭐ 真机那次日志里**只有 new_item_no**（为空），new_size 到底空没空只能靠猜。
+  new_color: String(result.new_color || '').slice(0, 40),
+  new_size: result.new_size,
+  new_amount: result.new_amount,
```

（纯日志字段，不改任何判据与写入。）

### 丙 追问话术（`server/src/config/afterSalesFlow.js` → `AFTER_SALES_ASK_TEXTS`）

```js
const AFTER_SALES_ASK_TEXTS = Object.freeze({
  needNewItem: '换成哪一双？发我货号，或者只说新尺码也行。',
  needNewSize: ({ itemNo = '', color = '' } = {}) => `换的那双 ${itemNo}${color} 多大码？`,
  newProductNotFound: ({ itemNo = '', color = '' } = {}) => `货品表里找不到 ${itemNo}${color}，核对一下货号。`,
  needNewAmount: ({ itemNo = '', color = '' } = {}) => `换的那双 ${itemNo}${color} 多少钱？`,
});
```

- ⭐ 四句**全部**搬进配置（原来硬编码在 service 里），改文案不用碰逻辑。
- ⚠️ **只改了换货这四句**。**没改**的两条（如实汇报）：
  · 「我没分清是退货、换货还是赔货，再说一次好吗？」（`action_unresolved`）
  · 「退哪一双？发我货号，比如"6035 黑"。」（`no_item_info`）
  以及「这一笔没有成交金额，退多少钱？」/「「收款方式管理」里没有「X」…」都**保持原样**
  —— 它们是"还没定位到那一笔"的问法，与这次"换给她的那一双"的放宽判据无关。

## 5. 配置项

| 配置 | 位置 | 说明 |
|---|---|---|
| `AFTER_SALES_ASK_TEXTS` | `server/src/config/afterSalesFlow.js` | 换货"新的一双"缺信息时的四句用户可见文案（新增，**无环境变量**） |

⚠️ **没有新增任何环境变量 / 开关**（这次不需要）。

## 6. 先红后绿证据

**改动前**（`origin/main` `d2b691a`，新增用例先落地、源码未改）：

```
$ node --test test/doubaoExchangeParse.test.js test/afterSalesFlow.test.js
✖ ⭐ 同款换码（业务负责人真机那句）：「6C98012-15L 换成41码」→ 不再问"换成哪一双"，直接出确认卡片
    actual: [ '换成哪一双？发我货号和颜色。' ]   expected: []
✖ 同款换码：她只说了新颜色（没有新货号）→ 也算"有信息"，缺尺码就只问尺码
    actual: [ '换成哪一双？发我货号和颜色。' ]   expected: [ '换的那双 1366-33棕 多大码？' ]
✖ 换货：新货号 / 新颜色 / 新尺码三者全空（她只说"换一双"）→ 仍然追问，不瞎猜（文案逐字）
    actual: '换成哪一双？发我货号和颜色。'   expected: '换成哪一双？发我货号，或者只说新尺码也行。'
✖ 提示词第 13 条：逐字写明"换尺码（同款换码）"与"换另一双"两条规则
    AssertionError: 提示词要逐字写出「换尺码（同款换码）」这一种
ℹ tests 43 / pass 39 / fail 4
```

**改动后**：同两条命令 → 全绿（`server/test/doubaoExchangeParse.test.js` + `server/test/afterSalesFlow.test.js`）。

（⚠️ 上表那次红是**改动前**录的，当时这两个文件共 43 条；最后那条"排查日志"用例是改完之后补的
（它测的是新增的日志字段），所以本件最终这两个文件是 44 条。
⚠️ 真机那第二句「6C98012-15L」的多轮接续**没有**对应用例 —— 本件不做，见第 8 节。）

## 7. 全量与 CI

| 项 | 结果 |
|---|---|
| 全量第 1 次（worktree 内，`node --test --test-concurrency=1`） | `tests 1290 / pass 1290 / fail 0`（38.4s） |
| 全量第 2 次 | `tests 1290 / pass 1290 / fail 0`（45.9s） |
| CI（`gh pr checks`） | 见 PR 里的实际输出（**必须 CLEAN**；未用 `--admin`） |

⚠️ 分支已 rebase 到当时的 `origin/main`（`e2ec040`，含 #244 / #245 / #246）：
与上游在 `docs/README.md`（索引表同一段）与 `server/src/services/doubaoService.js`
（规则 9 的"定金/尾款"那段）**各冲突一次，均已解决** —— 本件规则 13 的改动与上游规则 9 的改动并存、
索引两行都留。⚠️ 上面**全量 2 次是 rebase 之后**的数字（1290 = 上游新增用例 ＋ 本件 10 条）。

⚠️ 全量**只在独立 worktree 里跑**，没在主工作区跑。
⚠️ 未部署、未合并（业务负责人明令：部署必须拿到她**当次**的命令）。

## 8. 丁（追问之后接着上一轮）：核过 → 本件不做

**先核的结论：销售链路没有"缺信息→追问→她补充→接上"的多轮机制**（基于 `origin/main` `d2b691a`）：

1. 每条用户消息 = 一个新任务（`larkMvpService.acceptSalesText`：`idFor('sale', message.message_id)`），
   全仓没有"按人 / 按话题找回上一轮未完成任务"的查询。
2. `needs_info` **只是一个状态标记、没有任何读取点**（`larkMvpService.js` 写完再无人引用）；
   回她的原话是「销售信息还缺…**请补充后重新发送完整销售信息**」（`config/salesMissingInfoText`）
   ⇒ 设计上就是"重新说完整一句"，不是"接着上一轮"。
3. 唯一跨消息的本地状态只有两样，都不是"续接上一轮解析"：
   · `data/sales_group_threads`（thread_id → 哪一笔销售，**只做路由**）；
   · `data/lark_mvp_tasks` 里按人的 `after_sales_ctx_<hash>`（**10 分钟 TTL**），
     **只装候选列表** `pending_candidates`，供「第 2 笔」对上号。
4. `docs/lark-agent-technical-design.md` 7.1.1「补充与修改流程」开头就标注该文档"部分内容尚未实现"。

⇒ 按任务书的口径（「若没有 → **先停下汇报**，不要自己发明一套大的」），**本件一行都不写**。
已另立队列（`docs/todo-followup-supplement-multiturn.md`：复用上面第 3 条那套**已有**的按人本地记录
扩一个 `pending_supplement` 字段，不新起状态机），并**排在本件合并之后**（两件都与
`larkMvpService` / `afterSalesFlowService` / `config` 有交集 ⇒ 串行）。

## 9. 不确定 / 需要知道的判断

1. ⭐ **同款换码时，新那一双的成交金额取"原明细的成交金额"**（而不是「货品信息.单价」）。
   理由：同一双鞋换个码、钱不变 ⇒ 差价 0、不动钱（这正是 AC-1「直接出卡片」的前提）；
   若改用标价，标价与当初成交价不一致时会**凭空造出一个差价**，于是又要在钱上拦住她。
   ⚠️ **这不是"用标价/原价推算"**：原明细的成交金额是**这一笔的既有事实**（卡片上她会核对）；
   原明细连成交金额都没有时，**绝不拿标价顶**，直接问她「换的那双 X 多少钱？」。
2. **"等于原货号"也算同款换码**：`new_item_no` 与 `item_no` 相同（忽略大小写）时按同款换码处理
   —— 依据就是提示词第 13 条那句「new_item_no 可以留空（**也可以等于原货号**）」。
3. **提示词能不能真的让模型填出 `new_size`，本地用例证明不了**（本机不调模型）。
   本件能钉住的是：① 提示词**逐字**写了这条规则（用例断言）；② 规则一旦按预期输出，
   接线层**真的走得通**（真机那句的逐字编排用例）。真机验证仍需她那边说一句。
4. **`config/afterSalesFlow.js` 里的注释与 `docs/` 是不是要同步**：本文件即同步件；
   `AGENTS.md` 未改（这次没有新的**长期纪律**，只有一次判据放宽与四句文案）。
