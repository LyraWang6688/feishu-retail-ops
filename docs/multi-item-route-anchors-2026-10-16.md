# 「一单多货品」**路由半**锚点刷新（task-46 · 只读准备）

> ⭐ **本文件是【只读准备】的产物**：把 route 接线要用的锚点刷新到**当前** `origin/main`，
> 并记下**相比上一版（`8782da9`）变了什么** ⇒ 文件一让出（`routes/scanPage.js` 现在在 `retry-ui` 手里）
> **立刻能开工**，不用再核一遍。
>
> - **基准提交**：`origin/main = 7ec5d6b`（`docs: 两条 CI 红灯的体检…` #662）
> - **核对时间**：2026-10-16（上海）
> - 🔴 **本文件不提议改任何代码**：`routes/scanPage.js` / `views/scanPageRenderer.js` / `config/scanWrite.js`
>   都有主 ✗；`services/scanWriteService.js` **余量 0** ✗（见 §5-1）

---

## §1 行号位移：相比上一版锚点表（基准 `8782da9`）

P0 那几刀（老 `if` 拆包 / 死代码摘除）让**补货/退货那一段整体后移 58~59 行**，
其余锚点（`writeService` / `realmOfAction` / `respondWriteFailure`）**没动** ✓

| 锚点 | `8782da9`（旧表） | `7ec5d6b`（**现在**） | 位移 |
| ---- | ---------------- | ------------------- | ---- |
| `createScanWriteService(...)` | `:145` | **`:145`** | 0 ✓ |
| `realmOfAction` 两个动作名 | `:393-394` | **`:393-394`** | 0 ✓ |
| `respondWriteFailure` | `:645` | **`:645`** | 0 ✓ |
| 补货：`parseReplenishEntries(...)` 调用 | `:1931` | **`:1990`** | **+59** |
| 补货：**`submitReplenish` 落点** | `:1958` | **`:2017`** | **+59** |
| 补货：`markRealmUsed(...)` | `:1970` | **`:2029`** | +59 |
| 退货：`parseReturnEntries(...)` 调用 | `:2000` | **`:2059`** | +59 |
| 退货：**`submitPurchaseReturn` 落点** | `:2017` | **`:2076`** | +59 |
| 退货：`markRealmUsed(...)` | `:2029` | **`:2088`** | +59 |
| `parseReplenishEntries` 定义 | `:2107` | **`:2166`** | +59 |
| `parseReturnEntries` 定义 | `:2121` | **`:2180`** | +59 |
| `module.exports`（导出区） | `:2165` | **`:2223-2224`** | +58 |

⚠️ **教训**：「行号」不是契约，**位移是常态** ⇒ 每次开工**先 `git fetch` 再重核**（本文件只是把这一步提前做掉 ✓）。

---

## §2 当前锚点表（`origin/main = 7ec5d6b`）

### 2.1 `server/src/routes/scanPage.js`

| 行 | 内容 |
| -- | ---- |
| `:145` | `writeService = options.writeService \|\| createScanWriteService({ gateway, config: writeConfig })` —— **引擎挂它旁边** |
| `:393-394` | `realmOfAction`：`submitReplenish → 'replenish'` · `submitPurchaseReturn → 'purchase_return'` |
| `:645` | `respondWriteFailure(res, result, requestId)` —— **拒单复用它出人话** ✓ |
| `:1990` | 补货：`const entries = parseReplenishEntries(body, fields, writeConfig)` |
| `:2017` | 补货：**`await writeService.submitReplenish({...})`** ← **新分支就插在它【之前】** |
| `:2059` | 退货：`const entries = parseReturnEntries(body, fields, writeConfig)` |
| `:2076` | 退货：**`await writeService.submitPurchaseReturn({...})`** ← 同上 |
| `:2166` / `:2180` | 两个解析纯函数（新的分组解析器放它们**旁边**） |
| `:2223-2224` | 导出区（新解析器照既有权重导出，供用例直调 ✓） |
| —— | 🔎 **全文件 grep `multi_items` = 0 命中** ✓ ⇒ 路由半**确实还没接**（与 Lead 的判断一致 ✓） |

### 2.2 `server/src/views/scanPageRenderer.js`（**渲染半已合入 main** ✓）

| 行 | 内容（**这半已实现，路由必须对齐它的形状** ✗ 别重造） |
| -- | ---------------------------------------------------- |
| `:42-43` | `const { MULTI_ITEM_ORDER } = require('../config/multiItemOrder')` |
| `:1239` | `multiItemPayloadJson(items)` —— **载荷序列化**（形状 = 设计 §4.3） |
| `:1259-1263` | `multiItemBlockHtml(write, view)`：**`entries` 由路由在提交时合并**（见 §3-3 ✓） |
| `:1272` | 「已加货品」列表读 **`view.multi_items`**（拿不到 ⇒ **如实空态** ✓ 不编 ✗） |
| `:1287` | `<input type="hidden" name="${MULTI_ITEM_ORDER.field}" value="…">` ⇒ **首件 = 当前货品 + `entries: []`（空！）** |
| `:1337` / `:1462` | 补货块 / 退货块里都调了 `multiItemBlockHtml` ✓ |
| `:2001-2002` | 导出 `multiItemBlockHtml` / `multiItemPayloadJson`（供用例 ✓） |

**渲染出来的载荷逐字形状**（`multiItemPayloadJson` 只写这些键 ✓）：
```json
[{"product_record_id":"rec_x","number":"K1|黑色|A","item_no":"K1","color":"黑色",
  "supplier_record_id":"sup_x","entries":[]}]
```
- 明细键：`size`（**字符串**）· `quantity`（**`Number(...)`** ✓）
- 🔴 「再加一个货品」**不是按钮而是链接**：`${write.postAction}?add=1` ⇒ **零 JS** ✓
  （既有哨兵 `AC-W2` / `AC-6R5`：扫码页 HTML **一行 `<script>` 都不许有** ✗）
- 🔴 `MULTI_ITEM_ORDER.enabled === false` ⇒ 返回**空串** ⇒ **既有页面逐字不变** ✓

### 2.3 `server/src/config/multiItemOrder.js`

| 行 | 内容 |
| -- | ---- |
| `:31` | `enabled`（默认 **true** ✓） |
| `:34-35` | `maxProducts = 20` · `maxLines = 50` |
| **`:38`** | ⭐ **`field: readString(env,'SCAN_MULTI_ITEM_FIELD','multi_items')`** ← **渲染半已经加了** ✓ |
| `:43-50` | `detailKeyTemplate`（含**货品+尺码** ✓）· `asyncEnabled/TimeoutMs`（本步不用 ✓） |

### 2.4 `server/src/services/scanWriteService.js`（**一个字都不加** ✗）

- `split('\n').length = 1699`（`wc -l = 1698`）⇒ 判据 `oldLines < 1700` **余量 0** ✓
- `multiItemWriters` ✓ 与 `behavior: (chain) => …` ✓ **都已在 main**（切片 2a / 2b-i ✓）

---

## §3 改动清单（**9 处**，比上一版的 10 处**少 1 处** —— 见 §3-9 ✓）

| # | 位置（`7ec5d6b`） | 改什么 | 落哪条判据 |
| - | ---------------- | ------ | ---------- |
| 1 | `scanPage.js:145` 之后 | 懒建引擎：`options.multiItemOrder` 优先，否则 `createMultiItemOrderService({ sessions: writeService.sessions, config: resolveMultiItemOrderConfig(), writers: writeService.multiItemWriters() })`；顶部加 2 个 `require` | —— |
| 2 | `:2166` / `:2180` 旁 | 新纯函数 `parseMultiItemGroups(body)`：读**配置的** `field`（`:38` ✓）⇒ `JSON.parse`；**失败 / 不是数组 ⇒ `[]`** | **RT6** |
| 3 | **`:1990` 与 `:2017` 之间**（补货） | ① 把这次表单的 `entries`（既有 `parseReplenishEntries` 的结果）**合并进"首件"** ✓ ② `groups.length > 1` ⇒ 走引擎并 `return` | **RT1** · **RT2** |
| 4 | **`:2059` 与 `:2076` 之间**（退货） | 同上（`parseReturnEntries` 的结果并入首件）；**另把整单金额写进草稿 `order_amount`** | **RT1/RT2/RT4** |
| 5 | 引擎分支内 | `behavior: await writeService.multiItemWriters().behavior(chain)` ⇒ **明细照写「采购行为」两列** | **RT8** |
| 6 | 引擎分支内 | 拒单 ⇒ `respondWriteFailure(res, result, requestId)`（`:645` ✓） | **RT3** |
| 7 | 引擎分支内 | 成功页**复用今天那条形状与文案**（`sendHuman(200, {…successReturnFields…})`；批次号 + `summary.detail_count`），**不发明新文案** ✗ | 成功响应 |
| 8 | `:2223` 导出区 | 导出 `parseMultiItemGroups`（照 `parseReplenishEntries` 的既有风格 ✓） | —— |
| 9 | **`config/multiItemOrder.js:38`** | ✅ **不用改** —— 渲染半已经把 `field` 加好了 ✓（**这一处从我上一版的清单里删掉** ✓） | —— |
| 10 | 新 `test/multiItemOrderRoute.test.js` | 注入假 `writeService`（`sessions` / `submitReplenish` / `submitPurchaseReturn` / `multiItemWriters()`）+ 假 `options.multiItemOrder` | RT1..RT6 + RT8 |

### ⭐ §3-3 的"合并首件"是关键（**读渲染半才发现的**）
渲染器把**首件**（= 当前货品）连同 **`entries: []`（空）** 一起渲进 hidden 字段，
并在 `scanPageRenderer.js:1259` 逐字注明「**`entries` 由路由在提交时合并** ✓」⇒
路由半**必须**把这次表单提交的尺码/数量（`sizes` + `qty_<尺码>` / `return_sizes` + `return_qty_<尺码>`）
填进**首件**的 `entries` ✗ 否则多货品单会**丢掉第一个货品的数量** ✗
（⚠️ 这也是"≤1 组 ⇒ 回落老路径"能成立的前提：首件 + 空 entries 仍然只有 1 组 ✓）

### ⭐ 另一处**新增**（GET 渲染时，同样属于路由半）
`:1272` 的「已加货品」列表读 `view.multi_items` ⇒ 路由在 **GET** 渲染补货/退货页时要把
**草稿里已加的货品**塞进 `view.multi_items`（现在恒为 `[]` ⇒ 永远空态 ✓ 不报错、但**看不到已加的** ✗）。
⇒ 建议与改动 3 合并成一处（同一段代码里读草稿 ✓）

---

## §4 验收标准（8 条 · 先写后做 ✓ 每条能真红）

| AC | 钉什么 |
| -- | ------ |
| **RT1** | 分组 >1 ⇒ **引擎被调**（`openDraft` 1 · `addItem` N · `submitDraft` 1）且**老函数 0 次** |
| **RT2** 🍎 | **重中之重**：`≤1` 组 ⇒ **老函数被调且参数 `deepEqual` 今天那份** + **引擎 0 次**（等价靠**代码路径同一条** ✓ 不许在引擎里凑形状 ✗） |
| **RT3** | 拒单（`duplicate_line` / `too_many_products` / `too_many_lines`）⇒ 400 + **人话**（`respondWriteFailure` ✓）+ **零写入** |
| **RT4** | 退货分组 >1 且**整单金额缺失/非数字** ⇒ 拦（沿用既有 `purchaseAmountMissing/Invalid` ✓）+ **零写入** |
| **RT5** | 源码哨兵：`routes/*` **不许出现写链路服务名** ✗（只用 `writeService.multiItemWriters()` ✓）**不放宽**该既有判据 |
| **RT6** | `multi_items` **JSON 坏 / 不是数组 / `≤1` 组** ⇒ **回落老路径、引擎 0 次** |
| **RT7** | ✅ **已在切片 2a 落地**（`multiItemWriters()` 两次调用引用相等 ✓ `test/multiItemOrderWriters.test.js`） |
| **RT8** | 分组 >1 写出的明细里 **`behavior_record_id` / `behavior_kind` 真有值** —— ⚠️ 断言**落库载荷**（假写入件收到的 payload）里真有那两列 ✓ 不是"引擎返回里有" ✓ |

**变异（开工当天逐条验红）**：`≤1` 也走引擎 ⇒ RT2 红 ✓ · 去掉首件 entries 合并 ⇒ RT1/成功页红 ✓ ·
`JSON.parse` 不兜错 ⇒ RT6 红 ✓ · 拒单直接写 ⇒ RT3 红 ✓ · 不传 `behavior` ⇒ RT8 红 ✓

---

## §5 红线（开工当天照此自查）

1. 🔴 **`services/scanWriteService.js` 一个字不加** ✗ —— `split('\n').length = 1699`（须 <1700，**余量 0**）；
   要加就**先在别处腾行**或**先报 Lead** ✓ **不动那条判据** ✗（它在**正确地**起作用 ✓）
2. 🔴 **零 JS 哨兵**（`AC-W2` / `AC-6R5`）：扫码页 HTML **一行 `<script>` 都不许有** ⇒ 路由半**也不许**加脚本 ✓
3. 🔴 **N=1 与旧路径逐字等价** —— 靠**走同一个函数、同一份参数** ✓ 不许"在引擎里算出一样的形状" ✗
4. 🔴 **`multiItemOrder.enabled = false` ⇒ 页面逐字不变**（渲染半已保证 ✓ 路由半也要保证：引擎分支只在 >1 组时进 ✓）
5. 🔴 **`routes/*` 不出现写链路服务名** ✓（RT5）· 判据**不放宽** ✗（要改就写「改前逐字 → 改后逐字 → 依据」）
6. 交付：两遍全量 **EXIT=0 ×2** · **CI 四件全绿** · PR → **回报 Lead（不合并）** ✓ · 🔴 **严禁部署**

---

## §6 开工当天的复核命令（把行号重核一遍，别硬套本文件 ✗）

```bash
git fetch origin --prune && git rev-list --count HEAD..origin/main   # 必须 0
git log --oneline -1 origin/main
grep -n "parseReplenishEntries\|submitReplenish\|parseReturnEntries\|submitPurchaseReturn\|respondWriteFailure" server/src/routes/scanPage.js
grep -n "multi_items\|MULTI_ITEM_ORDER" server/src/routes/scanPage.js          # 现在应为空 ✓
node -e "const s=require('fs').readFileSync('server/src/services/scanWriteService.js','utf8');console.log(s.split('\n').length)"  # 须 <1700
grep -n "multiItemBlockHtml\|multiItemPayloadJson\|MULTI_ITEM_ORDER.field" server/src/views/scanPageRenderer.js
```

## §7 复用件（都在 main ✓ 直接用，别重造 ✗）

- 引擎：`services/multiItemOrderService.js` → `createMultiItemOrderService` / `openDraft` / `groupPayload` / `addItem` / `submitDraft`（拒单返 `{ok:false, code, message}`）
- 写入件：`services/scanWriteService.js` → `multiItemWriters()`（`{purchase, purchaseReturn, behavior}` · **引用相等** ✓）
- 配置：`config/multiItemOrder.js`（`enabled` / `maxProducts` / `maxLines` / `field` / `chains` / `texts` / `events`）
- 判据：`test/multiItemOrderStep1.test.js`（AC-MI1..MI9）· `test/multiItemOrderEntry.test.js`（AC-ENT1..ENT7）· `test/multiItemOrderWriters.test.js`（AC-RT7/RT8a）
