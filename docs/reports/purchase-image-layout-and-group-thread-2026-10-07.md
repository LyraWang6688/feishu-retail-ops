# 采购单 / 退货单出图排版 + 图与文字落在同一个话题（2026-10-07）

> **本文件的第一节在【动任何代码之前】写下**（`AGENTS.md` 第 2 条：先写"应该是什么样"再跑）。
> 业务负责人 2026-10-07 真机测试后当面提的两点（她的原话见下）。
> ⚠️ 本任务**不部署**（她明确：「禁止你和子代理自行部署，必须得到我的命令」）。

## 0. 她的原话（逐字，本任务的唯一口径来源）

> 「需要优化的点在于，我们**图片底部有共多少条以及合计多少双的不需要了**，
>  需要把**合计多少双的放在，供应商那一行**，然后**报货批次不用显示**，
>  所以在供应商那一行是 **供应商 报货日期和合计数量**，是否明白，
>  **同样退货单也需要改**，你可以**出个示例图**，
>  然后目前你看下截图，机器人确实是 **@了经办人**，但是**不是在一个话题下回复的**，
>  而是发了两条消息**，你看下怎么处理成**同一个话题回复**，我刚才那句到货是在话题里回复的」

⇒ 拆成两件事：
- **A｜出图排版**：底部「合计 N 条 / M 双」那一行**删掉**；「合计 M 双」移到**供应商那一行**；
  那一行变成 `供应商 · 报货日期 · 合计 M 双`；**报货批次号不再显示**；**退货单同样改**。
- **B｜图与文字落同一个话题**：@经办人那条文字要与那张图**在同一个话题里**，不是两条并列消息。

---

## 1. ⭐ 验收标准（**先写下来的**，跑之前先写）

### A｜出图排版（采购单 + 退货单，同一个渲染器）

| # | 判据 | 期望 |
| --- | --- | --- |
| A1 | 底部那条合计 | **不存在**。整张图里**没有任何**「合计」文本落在表格下面；图高不含 FOOTER |
| A2 | 供应商那一行 = 三个字段 | `供应商：<名>　　报货日期：<YYYY/MM/DD>　　合计：<M> 双`（顺序就是这个） |
| A3 | 「合计」用的是**双数** | `合计：13 双`；**「N 条」一个字都不出现**（她明确说条数不需要了） |
| A4 | 报货批次号 | 图上**不再出现**「报货批次」四个字，也不出现批次号文本（`202610071` 不出现在副标题） |
| A5 | 退货单 | 同一排版族：副标题也是 `供应商 · 报货日期 · 合计 M 双`；标题仍用**退货单自己的**「邯美皮鞋退货单」；**不显示批次** |
| A6 | 空明细 | **不画「合计：0 双」**（沿用"合计和为 0 不许出现"的老口径）；供应商/日期照画 |
| A7 | 没维护供应商 | 不画「供应商：」这一段（不是「未填写」那种像警告的文案）；日期与合计照画 |
| A8 | 配置先行 | 副标题里放哪些字段、每个字段的文案、字段间分隔符**全在 `config/purchaseRequestImageLayout.js`**；渲染逻辑不写死字符串 |
| A9 | 其余排版不动 | 列（颜色 \| 尺码×数量）、列宽、字号、分组行、斑马纹、竖线、换行规则、两个标题——**逐字节不变** |
| A10 | 图上数字 = 口径 | `合计：M 双` 的 M == `summarize().totalPairs` == 图上各格 `×N` 之和 |

### B｜图与文字落在同一个话题

| # | 判据 | 期望 |
| --- | --- | --- |
| B1 | 第 1 条（图） | 仍是**顶层消息**（`im.message.create`，`receive_id=chat_id`）——它是这个话题的**根** |
| B2 | @经办人那条文字 | `im.message.reply` **回复第 1 条图**，且 `data.reply_in_thread === true` |
| B3 | 多供应商时的第 2 张图 | 同样 `reply` 第 1 条图 + `reply_in_thread === true`（落在**同一个**话题） |
| B4 | 退货差额提示 | 挂在同一话题时也带 `reply_in_thread === true` |
| B5 | 不带回复对象时 | 顶层 `create` 的 payload **一个字段都不多**（与改动前逐字相同） |
| B6 | 表事件触发也能建话题 | 触发是**多维表格记录变更**（群里没有"她的那条消息"）——话题根只能是**我们自己发的第 1 条图**；须有官方文档 + 本仓既有做法作证据（见第 3 节） |

### C｜🔴 定位链路必须仍然可用（本任务最重要的回归点）

| # | 判据 | 期望 |
| --- | --- | --- |
| C1 | 发完就记映射 | `purchase.group.message.remembered` 照记：图那条 + 文字那条，`batch_no` / `message_id` / `thread_id` / `chat_id` 都在 |
| C2 | **话题里后续说话** | 事件只带 `thread_id` → `PurchaseBatchLocator.resolve` **`source='thread_id'` 命中同一批**（`purchase.group.batch.located`） |
| C3 | **引用那条图** | 事件带 `parent_id` = 图那条的 `message_id` → `findByMessageId` 命中同一批 |
| C4 | thread_id 落到映射里 | 文字那条回复的响应回带 `thread_id` → 必须写进映射（**没有 `reply_in_thread` 就飞书不回带**） |
| C5 | 不许退化成猜 | 引用不是我们发的消息 / 没记过的话题 → 仍然明确"认不出"，**绝不猜最近一笔** |

### D｜纪律

| # | 判据 | 期望 |
| --- | --- | --- |
| D1 | 不部署 | 只改代码 + 跑测试 + 开 PR；`deploy_*` / `pm2` / 线上 `.env` 一律不碰 |
| D2 | 不碰别人的文件 | `server/src/services/doubaoService.js` **一行不碰**（另一个 agent 在改）；`server/scripts/e2e-group-thread.mjs` 也不碰（在 `fix/e2e-group-thread-clean-run` 的 worktree 里被改着） |
| D3 | CI | `gh pr checks` 到 **CLEAN**；**不用 `--admin`**；不合并、不部署 |
| D4 | 测试 | 现行断言**不放宽**；渲染/发送相关断言按**新口径**重写并补新用例；全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |

---

## 2. 「改之前」的排版（她截图里的现状）

```
        邯美皮鞋采购单
   供应商：三星   报货批次：202610071   2026/10/07
   ┌──────┬────────────────────────┐
   │ 说明 │ 尺码×数量              │
   │ 8230 │ 黑色 38码×1、40码×1…   │
   └──────┴────────────────────────┘
            合计：12 条 / 13 双          ← 🔴 这一行不要了
```

## 3. 「改之后」的样子（示例图见第 6 节）

```
        邯美皮鞋采购单
   供应商：三星　　报货日期：2026/10/07　　合计：13 双     ← 供应商这一行 = 供应商 + 报货日期 + 合计（双数）
   ┌──────┬────────────────────────┐                     🔴 不显示「报货批次」
   │ 说明 │ 尺码×数量              │                     🔴 底部那行合计删掉
   │ 8230 │ 黑色 38码×1、40码×1…   │
   └──────┴────────────────────────┘
```
退货单同上，只把标题换成「邯美皮鞋退货单」。

## 4. ⭐ 「表事件触发能否建话题」的查证结论与证据

**结论：能。** 话题是不是建起来，取决于**我们那次 `im.message.reply` 有没有带
`reply_in_thread: true`**，与"触发这次发送的是不是人的消息"**无关**——飞书不需要群里存在
"她的那条消息"。**话题的根 = 我们自己发的第 1 条消息（那张图）**，这正是本链路的形状。

证据（三份，两份官方文档 + 本仓既有做法）：

1. **回复消息 API**（`POST /open-apis/im/v1/messages/:message_id/reply`）的请求体里
   `reply_in_thread` 是**接口自己的字段**（boolean，默认 `false`）：
   「是否以话题形式回复。**取值为 true 时将以话题形式回复**。」
   响应体里的 `thread_id`：「消息所属的**话题 ID**（**不返回说明该消息不是话题形式的消息**）」。
   → 也就是说：**带它 → 就是话题消息、响应回带 thread_id**；不带 → 不是话题消息。
   这条与"发送是被什么触发的"没有任何关系，接口里也没有任何"必须回复人的消息"的前提。
   实测文档：`curl -sSL 'https://open.feishu.cn/document/server-docs/im-v1/message/reply.md?lang=zh-CN'`

2. **消息管理概述**（root_id / parent_id 的语义）：
   「**在话题内回复的消息，都是在回复根消息，所以 `root_id` 和 `parent_id` 均是指根消息的 `message_id`**。」
   → 我们回复的是**第 1 条图**，所以**图就是那个话题的根消息**，文字落在它下面。
   实测文档：`curl -sSL 'https://open.feishu.cn/document/server-docs/im-v1/message/intro.md?lang=zh-CN'`

3. **本仓既有做法（销售链路，已上生产）**：`larkMvpService.replyMessage(..., { inThread: true })`
   就是 `client.im.message.reply` + `data.reply_in_thread = true`；
   `salesGroupThreadLocator` 的注释写着「`im.message.reply` 带 `reply_in_thread: true` 时响应里就有
   （**主群第一条回复时飞书才创建这个话题**）」，并**拿响应里的 thread_id 写映射**；
   `docs/sales-group-thread-implementation-2026-10-06.md` 同样写着
   「主群里那条**第一条带它的回复会创建话题**，响应里回带 `thread_id`」。
   → 那条链路同样是**机器人主动发**（她 @ 机器人后由后端发卡片），**不依赖"回复某条人工消息"才建话题**。

⚠️ **不能在本机实测**：真发要向**生产采购群**发消息（严禁），所以结论来自
**官方文档 + 本仓已上生产的同款做法**；真机确认要等她部署后在群里看（部署只能她下令）。

**顺带一条稳健性**：如果采购群其实是**话题群**，那么 `create` 发的图本身就已经带回 `thread_id`；
文字那条带 `reply_in_thread: true` 回复图 → 仍落在**图所在的那个话题**。
⇒ 两种群类型下，改动都指向"图与文字同一个话题"。

## 5. 实现落点

| 文件 | 改了什么 |
| --- | --- |
| `server/src/config/purchaseRequestImageLayout.js` | 副标题字段清单（`SUBTITLE_FIELDS`：供应商 / 报货日期 / 合计）+ 文案（`TOTAL_PAIRS_LABEL`）+ 分隔符 `SUBTITLE_SEPARATOR`；删除底部合计那一套（`SHOW_TOTAL` / `TOTAL_LABEL` / `FOOTER_*`） |
| `server/src/services/purchaseRequestImageService.js` | 副标题按**配置**逐字段渲染（不再写死字符串）；删掉底部合计的绘制与表高；`batchNo` 仍收下（留痕），但**不渲染** |
| `server/src/services/purchaseWebhookService.js` | `sendImage` / `sendText` 新增 `options.inThread`（= `reply_in_thread: true`）；采购群「图 + 文字」与「退货差额提示」的回复一律带上它 |

## 6. 示例图（走项目自己的渲染代码）

- `docs/prototypes/purchase-order-2026-10-07.png`（采购单）
- `docs/prototypes/purchase-return-2026-10-07.png`（退货单）

生成方式：`server/scripts/render-purchase-image-prototype.mjs` —— 直接 `require` 项目渲染器
（`renderPurchaseRequestPng`），**不是自己 P 图**，所以示例图 == 她实际会看到的图。

## 7. 逐条对照（跑完回填）

### A｜出图排版

| # | 判据 | 结果 | 证据（用例 / 代码） |
| --- | --- | --- | --- |
| A1 | 底部那条合计不存在；表格下面没有任何 text；图高不含 FOOTER | ✅ | `purchaseRequestImageService.test.js` ④「底部那条合计**整条删掉**」：`belowTable` 为空、`height == TABLE_TOP + 表高 + BOTTOM_PADDING` |
| A2 | 副标题 = `供应商：X　　报货日期：Y　　合计：M 双` | ✅ | ④「副标题 =…」逐字节断言 `供应商：金猴　　报货日期：2026/10/07　　合计：6 双` |
| A3 | 「合计」用双数；**「N 条」不出现** | ✅ | ④ 断言 `!svg.includes('条')`；`totalSegmentsOf(svg) === ['合计：6 双']`；示例图上就是 `合计：13 双` |
| A4 | 报货批次不显示（四个字 + 批次号文本都不出现） | ✅ | ⑤「报货批次**不再显示**」：`!svg.includes('报货批次')` 且 `!svg.includes('B-1')` |
| A5 | 退货单同口径；标题用它自己的 | ✅ | ⑤「标题文案」：`RETURN_TITLE = 邯美皮鞋退货单`，且 `subtitleTextOf(退货) === subtitleTextOf(采购)` |
| A6 | 空明细不画「合计：0 双」 | ✅ | ⑥「空明细不崩」：`!svg.includes('合计')`；④ 纯函数用例 `totalPairs: 0 → ''` |
| A7 | 没维护供应商 → 不画「供应商：」那一段 | ✅ | ⑤：没有供应商时副标题 = `报货日期：…　　合计：6 双` |
| A8 | 配置先行 | ✅ | 字段清单/文案/分隔符/字号/截断宽度全在 `config/purchaseRequestImageLayout.js`（`SUBTITLE_FIELDS` / `SUBTITLE_SEPARATOR` / `SUBTITLE_FONT_SIZE` / `SUBTITLE_FIELD_MAX_WIDTH`）；渲染器只按配置拼串，**一个业务字符串都没写死**；④ 用例直接对配置断言 |
| A9 | 其余排版不动 | ✅ | 列宽/字号/分组/斑马纹/竖线/换行/标题的用例**全部保留并通过**（33 条，0 放宽）；采购单与退货单仍"逐字节只差标题" |
| A10 | 图上数字 = summarize 口径 | ✅ | ④ 断言 `quantityTotalOf(svg) === 6` 且等于副标题里的数 |

### B｜图与文字落在同一个话题

| # | 判据 | 结果 | 证据 |
| --- | --- | --- | --- |
| B1 | 第 1 条（图）仍是顶层 `create`（话题根） | ✅ | A 用例：`image.params.receive_id_type === 'chat_id'`、`image.data.reply_in_thread === undefined` |
| B2 | @经办人那条 = `reply` 第 1 条 + `reply_in_thread: true` | ✅ | A 用例：`text.path.message_id === 'om_sent_1'`、`text.data.reply_in_thread === true` |
| B3 | 多供应商第 2 张图也 `reply` + `reply_in_thread` | ✅ | 新增用例「多供应商 → 第 2 张图也回复第 1 条并进同一个话题」：4 条出站里后 3 条都是 `reply_in_thread: true`、都 `path.message_id === 'om_sent_1'` |
| B4 | 退货差额提示同话题 | ✅ | `purchaseReturn.test.js`「差额提示必须带 `reply_in_thread`」（第 417-421 行） |
| B5 | 不带回复对象时 payload 一个字段都不多 | ✅ | 新增用例「发送器的 `inThread` 契约」：`reply` 不传 `inThread` → `Object.keys(data) === ['content','msg_type']`；顶层 `create` → `['content','msg_type','receive_id']` |
| B6 | 表事件触发也能建话题（查证结论 + 证据） | ✅（文档级） | 见上面第 4 节：官方 `reply` 文档 + `消息管理概述` + 本仓已上生产的销售链路。⚠️ **真机确认要等她部署后在群里看**（本机不许向生产群发消息） |

### C｜定位链路仍可用（最重要的回归点）

| # | 判据 | 结果 | 证据 |
| --- | --- | --- | --- |
| C1 | 发完就记映射（图 + 文字两条） | ✅ | A 用例：`mappings.length === 2`，`batch_no` / `chat_id` 都在；日志 `purchase.group.message.remembered` |
| C2 | 只凭 `thread_id` 命中同一批 | ✅ | 新增用例「C：定位回归钉子」：`resolve({threadId:'omt_sent_thread'}) → status=matched, source='thread_id'` |
| C3 | 引用那条图（`parent_id`）命中 | ✅ | A 用例 + 既有「C：发到群的两条消息都能用 message_id 反查回批次」 |
| C4 | `thread_id` 落到映射里 | ✅ | **替身照官方语义建模**：只有带 `reply_in_thread` 的回复才回带 `thread_id` ⇒ `mappings` 里 `om_sent_2`（文字）的 `thread_id === 'omt_sent_thread'`。⚠️ 这条是**真正的钉子**：少传那个字段，这条用例必挂 |
| C5 | 不许退化成猜 | ✅ | C 用例：`threadId:'omt_never_seen'` → `not_found`（`source='thread_id'`）；引用不是我们的消息 → `not_found`（`source='parent_id'`） |

### D｜纪律

| # | 判据 | 结果 |
| --- | --- | --- |
| D1 | 不部署 | ✅ 未跑任何 `deploy_*` / `pm2` / 线上 `.env` |
| D2 | 不碰别人的文件 | ✅ `doubaoService.js` 与 `e2e-group-thread.mjs` **一行未改**（见第 9 节的文件清单） |
| D3 | CI 到 CLEAN、不用 `--admin`、不合并 | ✅ 见第 8 节 |
| D4 | 测试不放宽、全量连跑 2 次 fail=0 | ✅ 见第 8 节 |

## 8. 测试与 CI（实际输出）

- 全量：`node --test --test-concurrency=1`（跑之前 `git rev-parse --short HEAD` + `HEAD..origin/main == 0`）—— 见汇报里贴的两次输出。
- CI：`gh pr checks <PR>` —— 见汇报。

## 9. 改动文件清单（写作用域，全部显式 `git add`）

| 文件 | 说明 |
| --- | --- |
| `server/src/config/purchaseRequestImageLayout.js` | 副标题配置；删掉底部合计那一套 |
| `server/src/services/purchaseRequestImageService.js` | 按配置渲染副标题；删掉底部合计绘制 |
| `server/src/services/purchaseWebhookService.js` | `reply_in_thread`（`inThread`） |
| `server/test/purchaseRequestImageService.test.js` | ④⑤⑥ 按**新口径**重写 + 新增副标题用例 |
| `server/test/purchaseWebhookService.test.js` | 新增 `reply_in_thread` / 多供应商 / 发送器契约 / 定位回归 4 组用例 |
| `server/test/purchaseReturn.test.js` | 差额提示必须 `reply_in_thread` |
| `server/scripts/render-purchase-image-prototype.js` | 出示例图（走项目渲染器） |
| `docs/prototypes/purchase-order-2026-10-07.png`、`docs/prototypes/purchase-return-2026-10-07.png` | 两张示例图 |
| `docs/reports/purchase-image-layout-and-group-thread-2026-10-07.md` | 本文件 |
| `docs/README.md` | 索引里加上上面这几件 |

🔴 **刻意没碰**：`server/src/services/doubaoService.js`（另一个 agent 在改）、
`server/scripts/e2e-group-thread.mjs`（`fix/e2e-group-thread-clean-run` 的 worktree 里正在改）。

## 10. ⚠️ 需要她确认 / 仍未确定的地方

1. **示例图的明细是"排版示例数据"**（`AGENTS.md` 第 10 条要求先说一声）：
   供应商「三星」、报货批次 202610071、合计 13 双 —— 这三个数**照她截图**；
   两个货号与各尺码的数量是我按"一双鞋就是整数双"编的**排版样本**，
   **不是**她生产表里的真实记录。仅用于看排版；要拿真实数据重出，改
   `server/scripts/render-purchase-image-prototype.js` 顶部的 `PURCHASE_ITEMS` / `RETURN_ITEMS` 即可。
2. **群文字那条消息没动**：她还是收到 `@经办人 金猴 这批 1 条（共 2 双），图可以直接转给供应商。`
   —— 她这次说的是"**图片底部**那条不要了"，我没动这条文字。
   ⚠️ 如果她连这条里的「N 条 / M 双」也不想要，说一声，一句话就能改。
3. **副标题里的日期标签两单共用一个「报货日期：」**（退货单也是「报货日期」）。
   她说的是"同样退货单也需要改"，我按"同一套排版族"处理；
   ⚠️ 若退货单要写「退货日期」，改 `SUBTITLE_FIELDS` 里那一行的 `label` 即可（配置先行）。
4. **真机验证只能她来做**：本机不允许向生产采购群发消息，
   所以"图与文字真的落在同一个话题里"这件事，**代码/文档/单测层面已闭环**，
   **飞书客户端的最终表现要她部署后在群里看一眼**（部署必须她下令）。
5. **如果采购群是话题群**：改动同样安全（图自带话题 → 文字带 `reply_in_thread` 回复它，仍在同一话题）。
   两种群类型我都推过一遍，见第 4 节末尾。

