# `routes/scanPage.js` 拆分设计（阶段一 · 只读盘点 · 2026-10-16）

> 她的原话（逐字）：
> 「① **`routes/scanPage.js` 按关注点拆**：`scanPage/posting.js`（写库入口）· `scanPage/drafts.js`（存草稿/接着录）·
>  `scanPage/payment.js`（资金页）· `scanPage/realm.js`（领域解析与落点）· `scanPage/multiItem.js`（多货品）·
>  `scanPage/index.js`（只做挂载）… ③ **配置先行** ＋ **一个 service 只干一件事**」
> ＋「**好的，可以进行拆分**」✓
> 起因：她说「**你说有热点文件的核心在于你的模块拆分还不够模块化**」✗ —— 本文件 **3376 行**，今晚 4 件事全撞它 ✗

**基线**：`origin/main` = `f13e998`（本文所有行号都在这版上**实测**取得 ✓ 不许凭记忆 ✗）
**阶段一红线**：`routes/**` **一个字都没动** ✓（见文末 `git diff --name-only` 为空 ✓）；真拆在**阶段二** ✓

---

## 1. 现状：一份 3376 行的文件，其实已经"长好了缝"

只读后可以确认：文件**内部本来就是分区**的（注释里有 `── … ──` 分隔 ✓），只是全塞在一个文件 + 一个闭包里 ✗。
⇒ 拆分**不是重构**，而是**把已有的段落搬到各自文件**（纯搬运 ✓ 零行为变化 ✓）。

### 1.1 模块级（文件顶部与底部）

| 行号区间 | 内容 | 去向 |
|---|---|---|
| `1-38` | `'use strict'` + 顶部文件注释 | `index.js`（或 `shared.js`） |
| `40-70` | **全部 `require`**（含 `../views/scanPageRenderer` / `../views/scanPageRealm` / `../services/*` / `./workbench` ✗ 见 §4 风险） | 各自文件按需 require ✓ |
| `72-109` | 模块级小工具与注释块（`sendHtml` 等） | `shared.js` |
| `110` | `const isDataNotReady = (error) => …`（**导出符号** ✓） | `shared.js`（再由 `index.js` 转出 ✓） |
| `116-…` | **`const createScanPageRouter = (options = {}) => {`**（工厂起点） | 保留在 `index.js` ✓ |
| `117-124` | 注入的**共享依赖**：`config` / `writeConfig` / `gateway` / `service` / `renderScan` / `renderMessage` … | 见 §3「共享状态怎么搬」✓ |
| `3240-3370` | **模块级纯函数**：`parseReplenishEntries`(3240) · `parseReturnEntries`(~3277) · `mergeFirstItemEntries`(3301) · `parseMultiItemGroups`(~3320) · `asList`(3351) · `parsePaymentRows`(3362) | 按关注点分开：补货/退货解析 ⇒ `posting.js`；多货品 ⇒ `multiItem.js`；`parsePaymentRows`/`asList` ⇒ `payment.js`/`shared.js` ✓ |
| `3371-3376` | **`module.exports`**：`createScanPageRouter, isDataNotReady, parseReplenishEntries, parseReturnEntries, parsePaymentRows, parseMultiItemGroups, mergeFirstItemEntries` | `index.js` **原样转出**（薄壳 ✓ 见 §5） |

### 1.2 路由注册（**顺序不许变** ✗）

| 行号 | 注册 | 去向 |
|---|---|---|
| `1362` | `router.get('/', …)`（首页/领域跳转） | `realm.js`（或 `index.js`） |
| `1403` | `router.post(config.tapFeedback?.reportPath \|\| '/ui-tap', …)` | `shared.js`（埋点，横切 ✓） |
| `1420` | `router.get(realmScanSignaturePath, …)` | `realm.js` |
| `1455` | `router.post(realmScanSignaturePath.replace(/[^/]+$/, 'scan-report'), …)` | `realm.js` |
| **`1472`** | **`router.get(ROUTE_PATTERNS, …)`**（整页渲染 / 领域页 / 最小页，到 `1819`） | `render.js`（**建议加这一个文件** ✓ 见 §2 理由） |
| **`1820`** | **`router.post(ROUTE_PATTERNS, uiTapResultMiddleware('scan'), …)`**（**全部写动作**，到 `3207`） | 按 §1.3 的**动作分区**拆给 `drafts/payment/posting/multiItem` ✓ |
| `3208` | `router.post('/', (req,res) => …)`（兜底） | `index.js`（挂载层） |

⚠️ **注册顺序 = 语义**（Express 先匹配先处理 ✓）：`GET /` → `tapFeedback` → 领域扫 → **`GET ROUTE_PATTERNS`** → `POST ROUTE_PATTERNS` → `POST /`
⇒ 搬运后必须在 `index.js` 里**按同一顺序**调用各 `registerXxx(router, ctx)` ✓ **不许换序** ✗

### 1.3 `POST ROUTE_PATTERNS`（1820-3207）内部的动作分区（**这就是最自然的拆分缝** ✓）

| 行号区间 | 动作 | 去向 |
|---|---|---|
| `1820-1960` | 前置：取 `params` / `body` / `realm` 解析 / 会话 / 埋点 / 预取（`parseReplenishEntries` 与 `parseReturnEntries` 在这里分派 `1914-1915`） | `shared.js`（`resolveRequestContext` 之类 ✓） |
| `1961-2026` | `actions.printLabel`（打印这一款） | `realm.js`（领域动作）或 `shared.js` |
| `2027-2057` | `actions.addLine`（**加入本单** = 存草稿） | **`drafts.js`** ✓ |
| `2058-2079` | `actions.addAccessory`（配品加进本单 = 存草稿） | **`drafts.js`** ✓ |
| `2080-2090` | `actions.clearDraft`（清空本单） | **`drafts.js`** ✓ |
| `2091-2463` | **资金页 · 提交整单付款**（`config.paymentStep?.payAction`） | **`payment.js`** ✓ |
| `2464-2643` | **资金页 · 跳过（稍后去工作台补）** | **`payment.js`** ✓ |
| `2644-2992` | **提交销售单**（写库入口：建单/明细/收款） | **`posting.js`** ✓ |
| `2993-3092` | **补货报单** | **`posting.js`** ✓ |
| `3096-3207` | **采购退货** | **`posting.js`** ✓ |
| 贯穿 | **多货品**（`multiItemOrderConfig` 270-278 · `multiItemWire` 279-290 · `multiItemOrder` 337-359 · `parseMultiItemGroups`/`mergeFirstItemEntries`） | **`multiItem.js`** ✓ |

### 1.4 工厂内 helper（缩进 2）与它们的去向

| 行号 | helper | 去向 |
|---|---|---|
| `125-136` | 注入的 `service` / `renderScan` / `renderMessage` / … | `index.js` 建 `ctx` ✓ |
| `137-150` | `renderSuccess` | `shared.js` |
| `191-221` | `step2WriteOf`（资金页 → 写库的桥） | `payment.js` |
| `222-230` | `logRendered` | `shared.js` |
| `258-269` | `writeService`（**共享状态** ✗ 见 §3） | `ctx` ✓ |
| `270-290` | `multiItemOrderConfig` / `multiItemWire` | `multiItem.js` |
| `293-301` | `resolveLarkJsapi` | `realm.js` |
| `304-312` | `realmScanTriggered` | `realm.js` |
| `337-359` | `multiItemOrder` | `multiItem.js` |
| `507-579` | **`purchaseBackground` / `schedulePurchaseWrite`**（后台那一跑的接线） | `posting.js` |
| `672-696` | `router`（工厂自己建 router） | `index.js` ✓ |
| `739-777` | `loadPendingBatches` / `arrival` | `posting.js`（或 `realm.js`） |
| `778-823` | `sendHuman` / `badNumberPage` | `shared.js` |
| `826-830` | `realmOf*`（`a ===` 分派） | `realm.js` |
| `877-969` | `sendSuccess` / `notFoundPage` / `respondFailure` | `shared.js` |
| `1018-1171` | `purchaseAmountMissingPage` / `purchaseAmountMissing` / `purchaseAmountInvalidPage` / `purchaseEntryInvalidPage` / `respondWriteFailure` | `posting.js`（都是"写入口的拦截/回话"✓） |
| `1204-1234` | `invalidateInventorySnapshot` / `openIdOf` | `shared.js` |
| `1290-1308` | `resolveLabelPrintQueue` | `realm.js` |
| `1388-1418` | `ROUTE_PATTERNS` / `realmScanSignaturePath`（**常量**） | `realm.js`（导出给 index 注册 ✓） |

---

## 2. 建议的最终形状（**在她给的六件基础上 +1** ✓ 附理由）

```
server/src/routes/scanPage/
├── index.js       // ⭐ 只做挂载：建 ctx ⇒ 按【原顺序】依次 register ⇒ module.exports 原样转出（薄壳 ✓）
├── shared.js      // 横切：send*/respond*/openIdOf/埋点/errCode 判定/isDataNotReady/asList
├── realm.js       // 领域解析与落点：realmOf*/ROUTE_PATTERNS/领域页 GET/扫码上报/打印
├── drafts.js      // 存草稿 / 接着录：addLine/addAccessory/clearDraft + 会话读写
├── payment.js     // 资金页：pay/skip 两支 + step2WriteOf + parsePaymentRows
├── posting.js     // 写库入口：submitOrder(2644)/replenish(2993)/purchaseReturn(3096) + 拦截页 + 后台接线
├── multiItem.js   // 多货品：multiItemOrder* + parseMultiItemGroups/mergeFirstItemEntries
└── render.js      // ⭐ 我加的：GET 整页渲染（1472-1819）＝ 她没点名但那 348 行是**另一种关注点**（只读渲染 ✗ 不写库）
```
⭐ **加 `render.js` 的理由**：她给的六件里 **`index.js`（挂载）** 之外没有"渲染"这一档 ✗ ⇒ 若把 `1472-1819`（整页 GET + 领域页 + 最小页 + 骨架）塞进 `realm.js`，那个文件会既"解析领域"又"渲染整页"✗ —— 与她自己那句「**一个 service 只干一件事**」冲突 ✓ ⇒ 单开 `render.js` 更贴她的原则 ✓（**请你确认** ✓；若你要严格按六件，我把它并回 `realm.js` ✓）

---

## 3. 共享状态怎么搬（**这是拆分成败的关键** ✗）

工厂闭包里有 6 类共享物（实测）：

| 共享物 | 现状 | 搬法 |
|---|---|---|
| `config`（`SCAN_PAGE`）· `writeConfig`（`SCAN_WRITE`） | `116-124` 从 `options` 取，或 `require` 默认值 | 建一个 **`ctx`** 对象（`{ config, writeConfig, gateway, service, renderScan, renderMessage, writeService, multiItemOrderConfig, … }`）⇒ 每个子模块导出 `registerXxx(router, ctx)` / `createXxx(ctx)` ✓ **不 require config**（配置仍从 `index.js` 一处注入 ✓ 配置先行 ✓） |
| `service`（只读取数） | `options.service \|\| createScanPageService(...)` | 同上：进 `ctx` ✓（**用例注入点不许丢** ✗ —— 74 个文件里有注入假 service 的 ✓） |
| `writeService` | `258-269` 建一次、被多支共用 | 进 `ctx` ✓（**注**：`services/scanWriteService.js` 一个字不动 ✗） |
| `gateway` | `options.gateway \|\| new V1BitableGateway()` | 进 `ctx` ✓ |
| 渲染函数 `renderScan` / `renderMessage` / … | `options.render?.scan \|\| renderScanPage` | 进 `ctx` ✓（**注入点必须保留** ✗ 有用例钉"渲染抛错也必须回人话页"✓） |
| 局部可变状态（会话缓存 / 快照失效标记 / 后台登记） | 闭包里的 `let` / `Set` | ⚠️ **逐个点名**（阶段二第一步先列全 ✗）—— 若某个 `let` 跨子模块读写 ⇒ 用 `ctx.state = {}` 承载 ✓ **不要**引入模块级可变单例 ✗（那会破坏"用例可注入"✓） |

---

## 4. 风险点（**逐条给**✓）

1. 🔴 **`require` 循环**：本文件 `60` 行 `require('./workbench')`（`requireWorkbenchAccess`）⇒ 若把路由拆成多个文件、又让它们互相 `require`，容易成环 ✗
   ⇒ **规避**：子模块**只**导出工厂/注册函数、**只**依赖 `ctx`（**禁止**子模块之间互相 require ✓）；`index.js` 是唯一的 require 汇聚点 ✓
2. 🔴 **路由顺序**（Express 先匹配先处理）：`GET /` → `tapFeedback` → 领域扫 → `GET ROUTE_PATTERNS` → `POST ROUTE_PATTERNS` → `POST /`
   ⇒ 搬运后 `index.js` 里**按同一顺序**调用 ✓（阶段二用 §6 的渲染基线 + 既有判据兜 ✓）
3. ⚠️ **`app.js` 挂载**：`app.js` 挂的是 `require('./routes/scanPage')` ⇒ 若目录化（`routes/scanPage/index.js`）⇒ Node 解析规则**仍能命中** `index.js` ✓
   ⇒ 但**为稳妥**（且她在意"别出事"）：**首选薄壳**：保留 `routes/scanPage.js`（= 3~5 行 `module.exports = require('./scanPage/index')`）✓ 见 §5
4. ⚠️ **`module.exports` 的 7 个符号**（`createScanPageRouter` + 6 个纯函数）被 **74 个测试文件**按路径 require ✓ ⇒ 薄壳下**一个都不用改** ✓
5. ⚠️ **`ROUTE_PATTERNS` 等常量**若被测试直接引用 ⇒ 别丢 ✓（本节清单里没有测试直接引用它 ✓ 但薄壳更保险 ✓）
6. ⚠️ **`services/scanWriteService.js` 余量 0 行** ✗（哨兵 `< 1700`）⇒ 拆分**绝不许**顺手往它加行 ✗ 需要动 ⇒ **停手报 Lead** ✗

---

## 5. ⭐ 建议：**留薄壳**（判据零改动 ✓）

现状：**74 个测试文件** `require('../src/routes/scanPage')`，解构的符号是
`createScanPageRouter`（绝大多数）＋ `parsePaymentRows` / `parseReturnEntries` / `parseMultiItemGroups` / `mergeFirstItemEntries`（少数）✓

⇒ **建议**：
```
server/src/routes/scanPage.js           ← 保留：3~5 行薄壳 `module.exports = require('./scanPage/index');`
                                          （＋ 原文件的头注释略作指引 ✓）
server/src/routes/scanPage/index.js     ← 真身（只做挂载）
server/src/routes/scanPage/{shared,realm,drafts,payment,posting,multiItem,render}.js
```
⭐ **理由**：① **74 个测试文件 + `app.js` 一个字都不用改** ✓（她那条"零行为变化"最容易达成 ✓）
② 阶段二的**唯一验收标准**是"渲染逐字节相同"✓ —— 薄壳把"改 import 面"这个**额外风险**降到 0 ✓
③ 隔壁 `renderer-split` 也是这么定的 ✓ **两刀风格一致** ✓
④ 将来若想彻底去壳，**单独一刀**（那时一次性改 74 个 import ✓ 有判据兜 ✓）

---

## 6. 阶段二（真拆）的验收与纪律（**照 Lead 给的执行** ✓）

```
① 纯搬运、零行为变化（**唯一验收标准** ✓）
② 🔴 最强判据：`server/tools/task61-render-baseline.js`（同一份页面在 origin/main 与改后渲染 ⇒ `cmp` 逐字节 ✓）
   ⇒ 四个领域 × 两种状态 ＋ 消息页 ＋ 最小页 **全部逐字节相同** ✓（今晚基线 = **508,317 字节** ✓ 改完必须还是这个数 ✓）
③ 两遍 EXIT=0 ×2（**取真 EXIT** ✗ 别接管道）+ 两遍间 `git diff | shasum -a 256` 自证未改 + **变异 ≥2 组真红**
④ 既有判据**一条不许删/skip/放宽** ✓（薄壳 ⇒ 零改动 ✓）
⑤ `services/scanWriteService.js` 一字不动 ✗（要动 ⇒ 停手报 Lead ✗）
⑥ 🔴 阶段二**必须等 Lead 说「routes 让出来了」**（`draft-s3` 已合并）才开工 ✗
```

---

## 7. 阶段一红线自证

- **`git diff --name-only`**：只有 `docs/scan-page-split-plan-2026-10-16.md`（＋ `docs/README.md` 一行索引 ✓）
  ⇒ **`routes/**` 零改动** ✓（本阶段没有 `src/**` 任何改动 ✓）
- 本阶段**没有**跑主套件（只跑 `docsIndexCompleteness` 那条哨兵 ✓）；两遍全量属于**阶段二** ✓
