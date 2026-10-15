# 扫货品码却落到「资金页」—— 落点判定 + 本地复现（真机 2026-10-16 05:34）

> **来源与边界（先读这一段）**
> · 现象来源：业务负责人 2026-10-16 05:34（上海真机）**截图 + 逐字**：「我用你最新的线上版本测试了一下，
>   静态感觉很好，扫描了几个货品二维码，**但是有一个货品点击了之后出现的是这个资金页** ✗」
> · 线上日志：由 Lead 从服务器**只读**拉取（本文只引用它，**没有**在服务器上跑任何东西）。
> · 本文的"判定条件 / 复现结果"是**我方（agent）读代码 + 本地跑真路由**得到的事实，**不是她的口径** ✗。
> · 🔴 **本轮只定位 + 只加日志（尚未落地）· 一个判定都没改** ✗ —— 详见 §5 与 §6。
> · 行号基准：`21844e3`（= Lead 核实的**线上那个 commit**）。收尾时 `origin/main` 已到 `4036bf3`
>   （含 #708「删净 AI 分析」+ #706 文档），⚠️ **`routes/scanPage.js` 与 `config/scanPage.js` 在这两个
>   commit 里一个字都没被改**（已核 `git diff --name-only 21844e3..4036bf3`）⇒ **本文行号两者都适用** ✓。

---

## 0. 结论摘要（一段话）

扫货品码落到资金页，**只有一条路**：`GET /s/{编号}` 或 `GET /r/{记录ID}` 命中
`routes/scanPage.js:1154–1202` 那段"**刷新仍给资金页**"的接管，而它**同时**要求
① 没有 `?data=1`、② 有编号/记录 ID、③ 会话 `sale.paymentStep === 'pending'`、
④ **销售上下文**（`from` 为空串 ∨ `from=sales`）、⑤ 货品查得到、
⑥ 「有东西要付」（`lines>0` ∨ 有已建单号 ∨ `status !== 'submitted'`）。
线上 `SCAN_PAGE_SKELETON_ENABLED=true` + `firstEntryOnly=true` ⇒ **裸扫先回骨架屏**，
骨架自取那一发带 `?data=1`（**绕过接管**）⇒ **线上"裸扫"根本到不了资金页**；
能落到资金页的**只有她显式点「销售」那一下**（`?from=sales`）——与她逐字「**点击了之后**出现的是这个资金页」吻合 ✓。

⇒ **她那次的形状 = 会话里有一条 `paymentStep:'pending'` 的未完结单**（`status` 不是 `submitted`，
或草稿有行，或已有单号）。⚠️ 而**真正的毛病**是：**这条接管不认货品** ✗ ——
`pending` 里根本没有货品标识，所以她**扫的是 A 货品、点销售，看到的却是上一单（B/上一双）的资金页**；
在点「跳过 / 提交整单付款」之前，A 的货品页**出不来**。这是**真 bug（体验坑）** ✓（Lead 2026-10-16 裁决 ① 认可）。
**本轮不修**（修法要她点头，见 §5.2）✗。

---

## 1. 症状与现有日志的**盲区**（为什么要先加一条日志）

她拉的 5 条线上日志（只读）：

| 时间(+8) | 形状 | 编号 | 记录 ID | 结果 |
|---|---|---|---|---|
| 05:34:49 | `scan.page.viewed` | `832-321-H\|黑色\|A` | `rec28e01D2f4cG` | `?from…` · 6ms |
| 05:34:54 | `scan.page.viewed` | `832-321-H\|黑色\|A` | `rec28e01D2f4cG` | `?from…` · 7ms |
| 05:34:57 | `scan.page.viewed` | `832-569\|黑色\|A` | `rec28dZQ3BbcF3` | `?from…` · 11ms |
| 05:35:15 | `scan.page.skeleton` → `scan.page.viewed` | `832-313\|黑色\|A` | `rec28e2FUknc8c` | `?data…` · 724ms |
| 05:35:26 | `scan.page.skeleton` → `scan.page.viewed` | `815195B-6\|黑色\|A` | `rec28dNNHMlrjT` | `?data…` · 10ms |

🔴 **这 5 条日志回答不了"渲染了哪一页"**，原因是**结构性的**：
`scan.page.viewed` 是 `service.lookup()` **里面**打的（`server/src/services/scanPageService.js:1356`
＝ 没命中缓存那次；命中缓存则 `:1070`）——
而"资金页接管"那条路**也必须先 `service.lookup()`**（`routes/scanPage.js:1167`，为了拿到 `found`）
⇒ **资金页与货品页在她日志里长得一模一样** ✗✗。她说的"每一次都打了 `scan.page.viewed`"因此
**只能证明"服务端查过货品"**，证明不了落点 ✓ —— 这也正是本任务要补的那条日志（§5.1）。

---

## 2. ① 落点判定条件（逐条 · 文件:行）

### 2.1 GET 上**有且仅有一条**路能渲染资金页

全仓 `sendPaymentStep(...)` 共 7 处调用：`:1195`（**GET**）、`:1544` `:1656` `:1718` `:2118` `:2207` `:2348`
（**全部在 POST 处理器里** ⇒ 扫码 GET 到不了）。⇒ **GET 唯一的资金页出口 = `:1195`**。

`GET /s/:number` / `GET /r/:recordId`（同一条 handler，`:1122`）里，三个 gate 依次是：

**Gate A —— 骨架屏（先抢）**：`routes/scanPage.js:1144–1149`

| # | 条件 | 文件:行 | 触发它需要的输入 |
|---|---|---|---|
| A1 | `config.skeleton.enabled === true` | `:1144`；取值 `config/scanPage.js:773`（`SCAN_PAGE_SKELETON_ENABLED`，默认 `false`） | 线上 `.env` = `true`（她日志里的 `scan.page.skeleton` 就是证据 ✓） |
| A2 | `req.query.data !== '1'` | `:1144` | **不带** `data=1` 的那一发（＝首次进入） |
| A3 | `!(firstEntryOnly && hasRealmQuery)` | `:1145`；`firstEntryOnly` 取值 `config/scanPage.js:774`（默认 `true`） | **不带** `?from=`（裸扫）。⚠️ **带了 `?from=` ⇒ 骨架被跳过 ⇒ 直接走 Gate B** |
| A4 | URL 上有编号或记录 ID | `:1146` | 扫的是 `/s/…` 或 `/r/…` |
| ⇒ | **渲染骨架屏** | `:1148` | 数据由骨架里那段脚本再 `fetch('?data=1')` 拿回来 |

**Gate B —— 资金页接管**：`routes/scanPage.js:1154–1202`（**唯一出口 `:1195`**）

| # | 条件 | 文件:行 | 触发它需要的输入 |
|---|---|---|---|
| B1 | `req.query.data !== '1'` | `:1154` | **不是**骨架自取的那一发。⭐ **`?data=1` 会整段绕过接管** ⇒ 线上"裸扫"永远看不到资金页 |
| B2 | URL 上有编号或记录 ID | `:1155` | 同 A4 |
| B3 | 会话 `sale.paymentStep === 'pending'`（也读顶层 `paymentStep`） | `:1157`、`:1166` | 会话文件 `server/data/scan_sessions/*.json` 里 `"sale":{"paymentStep":"pending"}`。**写它的只有一处**：`:2076`（她点「提交这一单」那一下）；另外 `:1731`/`:1965` 写 `'created'`（点资金页两颗按钮之后）、`:1218` 清成"键不存在"（残标记） |
| B4 | **销售上下文**：`String(from \|\| '') === ''` ∨ `String(from) === 'sales'` | `:1165`、`:1166` | `?from=sales`（或空 `from`）。⚠️ 别的领域（库存/补货/退货）**一律不接管**（10-14 晚那条修法 ✓）；⚠️ 认不出的 `from` 值**不算**销售上下文（回落销售领域但**不接管**） |
| B5 | `service.lookup({…}).found === true`（**并且这一步就会打 `scan.page.viewed`**） | `:1167–1168` | 这一款查得到（她 5 次都查得到 ✓） |
| B6 | **「有东西要付」**：`lines.length > 0` **∨** `order_no`/`master_record_id` 非空 **∨** `status !== 'submitted'` | `:1184–1194` | 三种形状任取其一（见 §3 的四个会话夹具） |
| ⇒ | **渲染资金页** | `:1195` | ⭐ **只到这一步才落到资金页** |
| else | 残标记（`pending` + 0 行 + 没单号 + `status:'submitted'`）⇒ **清标记 + 照常出货品页** | `:1216–1234`（warn **`scan.payment_step.stale_cleared`**） | 10-15 晚 #598/#601 那两个修法 ✓ **线上 commit `21844e3` 已含** ⇒ 这一形状**不会**落到资金页 ✓ |

**Gate C —— 正常渲染**：`:1247–1307`
`service.lookup()`（`:1247`）→ 领域（显式 `?from=` 优先，裸扫时才用她最近做过的领域 `:1316–1321`）
→ `renderScan(...)`（`:1295`；每个领域带 `realm-block--<领域>` 标记）→ `sendHtml`（`:1307`）。
失败出口：空编号 `:1255`（`bad_number`，400）· 查不到 `:1259`（`not_found`，404）· 未预期异常 `:1308`（`failed`）。

### 2.2 接管里**没有**的那些判据（我逐个核过）

| 候选（brief 里点名的） | 核实结果 |
|---|---|
| `req.query.step` | 🔴 **全仓没有这个读取点**（`grep "query?.step" src/` 空）⇒ **不是**触发条件 |
| `?from=` 的取值 | ✓ **是**条件之一，但只认**恰好** `''` 或 `'sales'`（`:1165`）—— 库存/补货/退货/货品**都不接管** |
| 会话/任务里的"已提交过"标记 | ⚠️ **恰恰相反**：`status:'submitted'` + 0 行 + 没单号 ⇒ 走**清残标记**那一支（`:1216–1234`）⇒ **给货品页**，**不给**资金页（线上已含此修法 ✓） |
| 骨架那条 `?data=1` 与第一次请求的差异 | ✓ **是**关键差异：`?data=1` **绕过接管**（`:1154`）⇒ 同一会话下"裸扫"与"点销售"**落点不同** |
| `pendingMode` / `saleKey` 残留 | 🔴 与落点无关：`pendingMode` 是**资金页上那一档**（A2a 改造后按金额自动定，`:1588` 起），`saleKey` 是幂等键（`config/scanWrite.js:257`）—— 都不参与"渲染哪一页" |
| 别的缓存 | 🔴 `scanPageService` 的缓存只按 **number / recordId** 存"**found:true** 的视图"（`:1066–1087`、`:1370–1373`）⇒ 缓存只能省飞书读，**改不了落点**；她日志里的 `scan.page.cache_miss` 也印证这次没命中 |

### 2.3 ⭐ 骨架屏 × 接管：**线上"裸扫"到不了资金页**（这条最容易看漏）

线上 `SCAN_PAGE_SKELETON_ENABLED=true`、`firstEntryOnly=true`（默认）：
· **裸扫**（无 `from`）⇒ Gate A 命中 ⇒ **骨架屏**（200）⇒ 骨架脚本再取 `?data=1`
  ⇒ Gate B 的 **B1 不成立** ⇒ 直接走 Gate C ⇒ **货品页** ✓
· **点「销售」**（`?from=sales`）⇒ Gate A 的 A3 不成立（有 `from`）⇒ Gate A 跳过
  ⇒ Gate B 五项全中（若 B3/B6 成立）⇒ **资金页** ✗

⇒ **她那次只可能是"点销售"那一下**（`?from=sales`）。她日志里
`832-321-H` 那两条 5 秒间隔的 `?from…`（`:49` / `:54`）正好是这个形状：
先看别的领域（货品页 ✓）、再点销售（资金页 ✗）。

---

## 3. ② 本地复现（**走真路由**，不是"看着像"）

**方法**（脚本见附录 A）：`express` 挂**真的** `createScanPageRouter()`（`/s` 与 `/r` 双挂载，与 `app.js` 同形），
只把 `service.lookup` / `writeService` / `gateway` 换成夹具（与既有 `test/scanPaymentStepStale.test.js` 同一手法）；
每次请求打印**渲染出来的第一个 `data-view`** 与"这一页是什么"（判据：资金页 `data-view="payment-step"`
〔渲染层 `views/scanPageRenderer.js:1860`〕· 骨架 `data-view="scan-skeleton"` · 领域块 `realm-block--<领域>`）。

**会话夹具**（都是**生产真路径写得出来**的形状，见 `services/scanSessionService.js`）：

| 夹具 | 内容 | 生产里怎么长出来 |
|---|---|---|
| 无标记 | `{status:'submitted', lines:[], paymentStep:'created'}` | 上一单点过资金页按钮（`:1731`/`:1965`）后 `completeSale`（`scanSessionService.js:347`） |
| 刚提交后离开资金页 | `{paymentStep:'pending', status:'draft', lines:[], submitPending:{…}}` | 她点了「提交这一单」（`:2073–2109`：`paymentStep:'pending'` + `status:draft` + `submitPending`），**没点**资金页那两颗按钮就离开 |
| 本单已加 N 双 | `{paymentStep:'pending', status:'draft', lines:[{…}]}` | 同上，但草稿里还留着行（`addLine`，`scanSessionService.js:208`） |
| 残标记 | `{paymentStep:'pending', status:'submitted', lines:[]}` | 10-15 20:22 那次形状（`completeSale` 清 `lines`/`order_no` 但**没清** `paymentStep`） |

### 3.1 线上取值（`SCAN_PAGE_SKELETON_ENABLED=true`）——**她要的那个形状**

| 会话状态 | 请求形状 | 第一个 `data-view` | **渲染出的页** |
|---|---|---|---|
| 无标记 | 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** ✓ |
| 无标记 | `?from=sales` | `draft-bar` | **货品页·销售** ✓ |
| 无标记 | `?from=inventory` | `draft-bar` | **货品页·库存** ✓ |
| 无标记 | `?data=1` | `draft-bar` | **货品页·销售** ✓ |
| 无标记 | `/r/{recordId}` 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** ✓ |
| **刚提交后离开资金页** | 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售**（`?data=1` 绕过接管 ✓） |
| ⭐ **刚提交后离开资金页** | **`?from=sales`** | `payment-step` | 🔴 **资金页** ✗（**复现成功**） |
| 刚提交后离开资金页 | `?from=inventory` | `draft-bar` | **货品页·库存** ✓ |
| 刚提交后离开资金页 | `?data=1` | `draft-bar` | **货品页·销售** ✓ |
| 刚提交后离开资金页 | `/r/{recordId}` 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** ✓ |
| **本单已加 N 双** | 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** |
| ⭐ **本单已加 N 双** | **`?from=sales`** | `payment-step` | 🔴 **资金页** ✗（**复现成功**） |
| 本单已加 N 双 | `?from=inventory` | `draft-bar` | **货品页·库存** ✓ |
| 本单已加 N 双 | `?data=1` | `draft-bar` | **货品页·销售** ✓ |
| 本单已加 N 双 | `/r/{recordId}` 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** |
| 残标记 | 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售**（`scan.payment_step.stale_cleared` ✓） |
| 残标记 | **`?from=sales`** | `draft-bar` | **货品页·销售** ✓ ← **修法生效的正面证据** |
| 残标记 | `?from=inventory` | `draft-bar` | **货品页·库存** ✓ |
| 残标记 | `?data=1` | `draft-bar` | **货品页·销售** ✓ |
| 残标记 | `/r/{recordId}` 裸扫 | `scan-skeleton` → `draft-bar` | 骨架 → **货品页·销售** ✓ |

### 3.2 对照：`SCAN_PAGE_SKELETON_ENABLED=false`（骨架关）

同表里唯一变化：**裸扫也直接落到 Gate B** ⇒「刚提交后离开资金页」与「本单已加 N 双」的
**裸扫**也出资金页 ✗（线上不是这个开关值，列出来只为说明"为什么骨架那条不能忽略"）。

### 3.3 从复现能读出的三条

1. **复现成功** ✓：`?from=sales` + `paymentStep:'pending'` + 「有东西要付」⇒ **资金页**；
   而且**与请求的是哪个货品无关** —— 夹具里我扫的是 `832-321-H`，会话里那条 pending 单可以是任何一单。
2. **`?data=1` 是一道"豁免"** ✓：她日志里第 4/5 条（`?data…`）**结构上不可能是资金页**
   ⇒ 那两款她的体验是正常的（与她"静态感觉很好"一致）。
3. **残标记形状已被修住** ✓（清标记 + 货品页）⇒ 线上 `21844e3` 含 #598/#601
   ⇒ **"她只是重扫了一个已提交过的货品"这个解释不成立**（那种形状给的是货品页，不是资金页）。

### 3.4 复现结果的**边界**（如实说）

· 我是用**夹具会话**复现的（本地没有她手机上的那份会话文件）⇒ 复现证明的是
  "**这条代码路径确实会把货品码渲染成资金页**"，**不能**证明她那次会话**具体**是哪个夹具。
· 具体是"刚提交后离开"还是"本单已加 N 双"、还是"有已建单号"，**必须先有 §5.1 那条日志**（或读她的会话文件）。

---

## 4. ③ 结论：她那次最可能是哪种

**推理链**（每一步都有上面的判据撑着）：

1. 落点只能来自 `:1195`（GET 唯一出口）⇒ 会话里**必然**有 `paymentStep:'pending'`（B3）。
2. 该 pending 必须满足 B6（否则走清残标记那一支，出货品页）⇒
   **`lines>0` ∨ 有单号 ∨ `status !== 'submitted'`**。
3. 线上含 #598/#601 ⇒ `status:'submitted'`+0 行+没单号那种**会被清掉** ⇒
   她的 `status` **不是** `submitted`（就是 `draft`），**或者**草稿有行，**或者**已有单号。
4. 线上骨架开着 ⇒ 裸扫到不了接管（B1）⇒ 她**点了「销售」**（`?from=sales`，B4）。
5. ⇒ **最可能：她那次会话里有一条"她点过「提交这一单」但没走完资金页"的单**
   （`paymentStep:'pending'` + `status:'draft'`，`:2073–2109` 的产物）；
   它可能是**本次测试里刚点出来的**，也可能是**上一次（10-15 20:22 那种）留下来的** ——
   会话 TTL 是 **12 小时**（`config/scanWrite.js:267`）⇒ 10-15 20:22 的标记到 10-16 08:22 都还有效 ✓。
6. ⭐ **为什么"她只看到一款出问题"**：因为只有**显式 `?from=sales`** 那一发会接管；
   她另一款（日志第 2/3/5 条）要么点的是别的领域、要么走的是 `?data=1` ⇒ 都是货品页 ✓。

⚠️ **仍不能 100% 定死的那一点**：`pending` 是"她刚点出来的"还是"上一轮残留的"。
两种都会让她看到资金页，但**修法含义不同**（前者是流程体验坑，后者要额外看清理逻辑）。
⇒ 需要 §5.1 的日志（或 Lead 按 open_id 读她会话文件）。

---

## 5. ④ 建议

### 5.1 ⭐ 加一条 `scan.page.rendered`（**已批准** ✅ · **尚未落地** ✗ · 只加日志/零判定改动）

**为什么值得**：现在"渲染了哪一页"**一条日志都没有** ✗（§1）⇒ 她每次报这个现象，
都只能像这次一样靠**推理**。这条日志一上，下一次 grep 一个词就定性 ✓。

**字段设计**（Lead 2026-10-16 裁决 ② 已批准）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `page` | `skeleton` \| `pay` \| `goods` \| `success` \| `not_found` \| `bad_number` \| `failed` | ⭐ **就是"她看到的是哪一页"** |
| `trigger` | `skeleton_first_entry` · `pending_mark:lines` \| `pending_mark:order` \| `pending_mark:status_not_submitted` · `realm:<领域>:<explicit\|remembered\|default>` · `write_ok` · `lookup_not_found` · `lookup_bad_number` · `render_failed` · `payment_step` | ⭐ **哪条条件命中**（`pending_mark:*` 直接回答"为什么给了资金页"） |
| `query_keys` | `Object.keys(req.query).sort()` | **只字段名** ✗ 不记值（与 `app.js:80` 同一口径） |
| `number` | 本次扫的编号 / 记录 ID | 与 `scan.page.viewed` 同口径 |

**出口清单（7 个 · 行号 = `21844e3`）**：

| # | 出口 | 位置 | 记什么 |
|---|---|---|---|
| 1 | GET 骨架屏 | `:1148` 之前 | `page:'skeleton'`, `trigger:'skeleton_first_entry'` |
| 2 | **资金页** | `sendPaymentStep`（`:192`）内部、`sendHtml` **之前** | `page:'pay'`；GET 那一处（`:1195`）传 `pending_mark:lines\|order\|status_not_submitted`，别的调用点回落 `payment_step` |
| 3 | GET 正常渲染（货品页） | `:1307` `sendHtml` 之前 | `page:'goods'`, `trigger:'realm:<领域>:<explicit\|remembered\|default>'` |
| 4 | 成功页 | `sendSuccess`（`:598`）内部（**加第 4 个可选参数 `req`**，8 个调用点各传一个 `req`） | `page:'success'`, `trigger:'write_ok'` |
| 5 | 空编号人话页 | `:1255` 之前 | `page:'bad_number'` |
| 6 | 查不到人话页 | `:1259` 之前 | `page:'not_found'` |
| 7 | GET 未预期异常 | `:1308` 之前 | `page:'failed'` |

**纪律（写进判据，能真红）**：事件名进 `config/scanPage.js` 的 `EVENTS.rendered`（配置先行）；
`logRendered` 必须在 `sendHtml` **之前**；🔴 **`services/scanWriteService.js` 一个字不许动**（冻结）。

**⭐ 这一刀已经写好并测过（**未提交、未落地**）**：11 条判据（AC-RL1…RL10）**先红后绿**
（实现前 11/11 红 ⇒ 实现后 11/11 绿）；补丁与用例**留档**在
`.local/landing-diag/landing-diag-rendered-log.patch` ＋ `…-rendered-log.test.js`（未跟踪文件，**不在 main** 上）。
它在本轮全量里的表现见 §6。**等 `routes/scanPage.js` 让出（`multi-item` 那刀合并）即可落地** ✓。

> ⚠️ **2026-10-16 收尾更新**：`multi-item`（一单多货「**路由半**」）**已合并 = #710**
> —— `server/src/routes/scanPage.js` **+188 行（纯插入）**、`config/scanPage.js` **未动**。
> 我核过：本补丁在新的 `origin/main` 上 `git apply --check` **仍然干净通过** ✓
> （四个关键锚点 `sendPaymentStep` / `salesContext` / 「有东西要付」三选一 / `sendSuccess` 都**原样还在**）。
> ⚠️ 但**本文行号整体后移了** ⇒ 落地那一轮**按锚点文本定位**（别只认行号）；
> ⚠️ 若还有「**写入半**」在同一个文件上跑，仍须先与 Lead 确认文件占用（本仓铁律 ✓）。

**变异 ≥2 组（都在 `origin/main` `4036bf3` 的临时 worktree 里做，做完还原逐字节一致）**：

| 变异 | 内容 | 结果 |
|---|---|---|
| M1 | 把 `pending_mark:*` 三选一**压成**恒 `'pending_mark:lines'`（= 丢掉"是哪条判据命中"） | 🔴 **AC-RL3 / AC-RL4 红**（2 条） |
| M2 | 从 `logRendered` 的载荷里**删掉 `query_keys`** | 🔴 **AC-RL1 / AC-RL2 / AC-RL8 红**（3 条） |
| M3 | **删掉货品页那个出口的 `logRendered(...)`** | 🔴 **AC-RL1 / AC-RL5 / AC-RL6 / AC-RL7 / AC-RL8 红**（5 条） |
| —— | 三组全部还原 ⇒ **11/11 绿**（还原后 md5 回到补丁态 ✓） | ✅ |

⇒ 判据**不是空跑**（"塞回去必红" ✓），且**不是在测实现细节**：
M2/M3 红的正是"她能不能从日志里看出落点"这件事本身 ✓。

### 5.2 根因修法（**只报不改** ✗ · 要她点头 · 与 Lead 裁决 ④ 一致）

**根因**：接管**只认会话、不认货品**（`pending` 里没有任何货品标识；
`submitPending` 只有 `size`/`amount`/`gift`，见 `:2093–2108`）⇒
**扫 A 货品、点销售，看到的是上一单的资金页**；在点掉两颗按钮之一（或 12h TTL）之前，
A 的货品页**出不来**。

**最小复现**：会话 `{sale:{paymentStep:'pending', status:'draft', lines:[]}}` + `GET /r/<任意记录ID>?from=sales`
⇒ 200 + `data-view="payment-step"`（§3.1 第 7 行）。

**两个候选修法（都要她选）**：
- **(a) 接管前先校验"这一单是不是当前这个货品"**（不是 ⇒ 不顶，出当前货品页）
  —— 需要一个"pending 属于哪个货品"的落点：`submitPending` 里补 `product_record_id`
  （**加字段，不改判定顺序**）；⚠️ 一单多货（多双）时要按"本单涉及的那些货品"判，不能只认最后一个。
- **(b) 重扫同一个货品时"从头开始"**（清 pending）
  —— ⚠️ 与"刷新不丢她刚填的"（10-14 那条口径）冲突风险最大，**改之前必须问她**。
- ⭐ 我倾向 **(a)**（只收紧、可增量加字段、不碰"刷新仍给资金页"那条既有体验），但**等她拍板** ✓。

### 5.3 需要补的线上证据（只读 · 按价值排序）

1. ⭐ **她会话文件**：`grep -l '"paymentStep":"pending"' server/data/scan_sessions/*.json`
   （⚠️ **别按编号搜** ✗ —— 会话文件里**不存货品编号**：编号只在 `lines` 里，而 0 行时 `lines` 是空的
   ⇒ 按编号搜必然搜不到，这正是第一次"只有 2 个文件"的原因），
   打开看 `sale.status` / `sale.lines` / `sale.order_no` / `sale.submitPending` 四个键
   ⇒ **一眼定性**是"刚提交"还是"残标记"还是"有单号"。
2. `grep 'scan.payment_step.stale_cleared' <05:34 前后>`：有 ⇒ 那次残标记**被清过**（修法在工作 ✓）；
   没有 + 她确实看到了资金页 ⇒ 形状是 `status:'draft'`（§4 第 5 点）。
3. `grep 'scan.page.rendered'`（**上 §5.1 之后**）—— 以后这一条就够了 ✓。

---

## 6. ⑤ 全量回归（本轮证据 · 如实）

· 线上 commit 已核实 = `21844e3`（含 #598/#601）⇒ **"旧构建"这条排除** ✓（Lead 2026-10-16 裁决 ③）。
· **第一遍**（`21844e3` + **带**日志补丁）：`tests 2893 / pass 2885 / fail 4 / skipped 4`，4 条都**与补丁无关**：
  1. `AC-DI1`（`test/docsIndexCompleteness.test.js`）—— 我的基点 `21844e3` 上
     `douyin-voucher-payment-rules-2026-10-16.md` **没进索引**（#704 漏登记）⇒
     **`4036bf3`（#706）已修** ✓（我已 ff 到 `4036bf3`）。
  2–4. `test/scanMoneyPageTwoStepVerify.test.js` 的 V1/V2/V5、V3、V4 —— e2e-verifier 的
     **真测试 Base 端到端**（本机 `.env` 有测试凭证才跑），失败形态是**共享测试 Base 的计数漂移**
     （例：`entry 564 vs 563`）＋"明细 `0 !== 1`"，**与"只加日志"没有因果关系**（补丁不写任何表）。
· **第二遍**（**最终树** = `4036bf3` + 本报告 + 索引登记，**不带**补丁）：
  `tests 2704 / pass 2697 / fail 3 / skipped 4` —— **还是同样那 3 条**真测试 Base 端到端，
  且 **`AC-DI1` 已转绿** ✓。（`2893 → 2704` 的差 = #708 删掉的 AI 分析判据，`git diff --stat` 有据 ✓。）
· **那 3 条在 CI 里不存在**：本机实测 `FEISHU_V1_E2E_TEST_APP_TOKEN= node --test test/scanMoneyPageTwoStepVerify.test.js`
  ⇒ `tests 3 / pass 0 / fail 0 / skipped 3 / EXIT=0` ✓（CI 没有测试 Base 凭证 ⇒ 它们**自跳过**，
  与文件头写的"缺凭证时明确跳过"一致 ✓）。
· ⚠️ **本轮没有做出"同一份代码两遍 `EXIT=0` ×2"** —— 因为补丁按裁决 ② **没有落地**；
  **落地那一轮必须补**（这也是 §5.1 清单里的一条）。本轮能给的是：
  **带补丁 / 不带补丁这两遍，失败集合完全一样** ⇒ 补丁没碰任何既有判据 ✓。

---

## 附 A：本地复现脚本（本轮用的那一个）

· 脚本：`.local/landing-diag/server/.dsh-tmp/landing-repro.cjs`（**未跟踪** · 临时件）
· 跑法：
  ```bash
  cd .local/landing-diag/server
  node .dsh-tmp/landing-repro.cjs                              # 骨架关
  SCAN_PAGE_SKELETON_ENABLED=true node .dsh-tmp/landing-repro.cjs   # 线上取值
  ```
· 它做的事：真 `createScanPageRouter()`（`/s` + `/r` 双挂载）· 4 种会话夹具 × 5 种请求形状
  ⇒ 打印**第一个 `data-view`** + 这一页是什么 + `lookup()` 次数 + 这一段落的日志事件名。

## 附 B：这一刀的留档（**未跟踪 · 不在 main**）

| 文件 | 内容 |
|---|---|
| `.local/landing-diag/landing-diag-rendered-log.patch` | `routes/scanPage.js` + `config/scanPage.js` 的全量补丁（236 行）—— 在 `4036bf3` 上 `git apply --check` **仍然干净通过** ✓ |
| `.local/landing-diag/landing-diag-rendered-log.test.js` | 11 条判据（AC-RL1…RL10）的用例原文 |
| A/B 等价证据 | 同一套复现（4 会话 × 5 请求）在**打补丁前 / 后**跑出来的**落点表逐行一致** ✓（补丁只多出日志，页面一模一样）—— 基线那次是在一个临时 detached worktree（`origin/main`）里跑的，跑完已还原 |
