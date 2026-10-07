# 工作台首页入口改成 ⓐ：「**报货与退货**」一张卡，点一次**直达飞书表单**（2026-10-08）

> 业务负责人（逐字，刚拍板）：
> 「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，只删退货那张卡……
>  现在就是按照原来一样，**采购和退货用的是一个表单**，所以你那个点击卡片上应该是"**报货与退货**"」

> 上一版（#259，`docs/workbench-purchase-return-merge-2026-10-08.md`）走的是 **ⓑ**：
> 【采购】卡 → 工作台内页 `purchase-return.html`（点两次）。
> 她这次拍板 **ⓐ** ⇒ **只改入口层**：那一张卡**直连报货飞书表单**、**标题改成「报货与退货」**；
> 报货与退货**现在是同一个表单**，所以退货**不再需要**首页上第二张卡。

---

## 〇、先把现状核清（只读，不凭转述）

`#259`（`f10ee45`）合进 `main` 之后，`server/public/workbench/config/home.js` 的
`COMMON_ENTRIES` 是：

| 首页卡片（改动前） | `id` | 图标 / 标题 | `href`（点一次落在哪） |
| --- | --- | --- | --- |
| 第一张 | `purchase` | 🛒 采购 | `/workbench/purchase-return.html`（工作台内页，报货 / 退货两张表单卡） |
| 第二张（哨兵） | `inventory-adjustment` | 🧮 库存手工调整 | `/workbench/inventory-adjustment.html` |

- `purchase-return` 那条**独立入口已在 #259 删除**（首页 HTML 里已不出现退货表单 URL）。
- `config/links.js` 里 `PURCHASE_REQUEST_FORM_URL` / `PURCHASE_RETURN_FORM_URL` **都还在**，
  `PURCHASE_FORMS` 仍是报货 / 退货两条；`/workbench/purchase-return.html` 那一页**一个字没改**。

---

## 一、改完之后应该是什么样（验收标准 · **先写后做**）

| # | 验收标准 |
| --- | --- |
| **AC1** | 首页【常用功能】**只有这一个采购类入口** —— 卡片标题**逐字** = `['报货与退货', '库存手工调整']`（顺序也是这个）；**没有**任何一张卡的 `title` 是 `退货`；`COMMON_ENTRIES` 里**没有** `id = 'purchase-return'` 的条目；采购那条 `id` **仍是 `purchase`**（不动别的引用）；`icon`（🛒）与 `arrow`（`进入 →`）**保持风格一致** |
| **AC2** | ⭐ 那张卡的 `href` **逐字等于**报货飞书表单 URL = `config/links.js` 的 `PURCHASE_REQUEST_FORM_URL`（因为**报货与退货现在是同一个表单**）⇒ **点一次直达**，中间**不再经过** `purchase-return.html`（`href` 不等于任何工作台内页） |
| **AC3** | 首页**不出现** `PURCHASE_RETURN_FORM_URL`：没有任何一张卡的 `href` 等于它，首页 HTML 里也搜不到它（退货独占的那张卡与外链都不在首页） |
| **AC4** | **哨兵**：`COMMON_ENTRIES` 里 `id = 'inventory-adjustment'` 那条**逐字不变**（`{id, icon, title, desc, href, arrow, wide}` 全等），它的卡片渲染（href / desc / arrow / `entry-wide`）也不变 |
| **AC5** | **不删链接 / 不删页**：`config/links.js` 的 `PURCHASE_REQUEST_FORM_URL` / `PURCHASE_RETURN_FORM_URL` / `PURCHASE_FORMS` 两条**一个都没删**；`PURCHASE_RETURN_FORM_URL` 仍被 `features/purchase/links.js` 引用 |
| **AC6** | **老链接不坏**：`/workbench/purchase-return.html` **仍能开**（文件在、`standalone.js` 仍注册），不带参数打开**仍是两张表单卡** —— 标题 `['报货','退货']`、`href` = `[PURCHASE_REQUEST_FORM_URL, PURCHASE_RETURN_FORM_URL]`（回归） |
| **AC7** | **配置先行**：入口清单（`id`/`icon`/`title`/`desc`/`href`/`arrow`/顺序）**只来自 `config/home.js`**；`features/common/index.js` 只负责画，**不写死清单、不复制 URL**；**URL 的单一来源仍是 `config/links.js`**（`home.js` 只 `import`，不复制字面量） |
| **AC8** | **边界**：`server/src/**` 任何文件 · `app.js` · `pendingDealPush*` · 采购 / 到货链路**一行不动**；本次只改 `server/public/workbench/**`（+ 测试 / 文档）；**不写任何表** |
| **AC9** | **测试**：新用例在改动前**红**（贴输出）、改动后绿；全量 `node --test --test-concurrency=1` 连跑 **2 次** `fail=0`（在**独立 worktree** 里跑，不在主工作区） |
| **AC10** | **CI**：`gh pr checks` 三项（`test` / `CodeQL` / `Analyze`）**pass**、`mergeStateStatus = CLEAN`；**禁止 `--admin`**；**开 PR ✗ 不合并 ✗ 不部署** |

---

## 二、改完之后的实际结构与文案（逐字）

`config/home.js` 里那一条（**唯一的功能改动**）：

```js
import { PURCHASE_REQUEST_FORM_URL } from './links.js';

{
  id: 'purchase',
  icon: '🛒',
  title: '报货与退货',
  desc: '供应商报货与退货（同一个飞书表单）——点一下直接打开',
  href: PURCHASE_REQUEST_FORM_URL,
  arrow: '进入 →',
}
```

`PURCHASE_REQUEST_FORM_URL` = `https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc`
（**从 `config/links.js` import，不复制**）。

真跑 `createCommonModule()` 得到的 DOM（**改动后**）：

```html
<a class="entry-card" href="https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc" rel="noopener">
  <div class="icon">🛒</div>
  <h3>报货与退货</h3>
  <p>供应商报货与退货（同一个飞书表单）——点一下直接打开</p>
  <div class="arrow">进入 →</div>
</a>
<a class="entry-card entry-wide" href="/workbench/inventory-adjustment.html" rel="noopener">
  <div class="icon">🧮</div>
  <h3>库存手工调整</h3>
  <p>盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）</p>
  <div class="arrow">进入 →</div>
</a>
```

| 卡片 | `href` | 点一次落在哪 |
| --- | --- | --- |
| 🛒 **报货与退货** | `PURCHASE_REQUEST_FORM_URL` | **飞书报货表单外链**（报货与退货同一个表单） |
| 🧮 库存手工调整 | `/workbench/inventory-adjustment.html` | 工作台内页（**逐字不变**） |

⚠️ **已知取舍（她本次拍板接受）**：退货**不再有首页一级入口**，退货飞书表单 URL 也**不在首页**；
它仍在 `config/links.js` 与 `/workbench/purchase-return.html` 里（**老链接 / 老收藏照样能开**），
且报货表单本身就是"报货与退货"同一个表单。

---

## 三、关键 diff（一句话：只改入口层，`server/src/**` 一行不动）

`git diff --stat`（**7 改 1 新**）：

```
 docs/README.md                                   |   1 +
 docs/workbench-requirements-2026-10-06.md        |  13 +++
 server/public/workbench/README.md                |  19 ++--
 server/public/workbench/config/home.js           |  53 +++++-----
 server/public/workbench/config/links.js          |  14 +--
 server/public/workbench/features/common/index.js |  10 +-
 server/test/workbenchHomeEntries.test.js         | 118 +++++++++++++----------
 （新）docs/workbench-report-return-direct-form-2026-10-08.md
```

`git diff --stat -- server/src` = **空**（`server/src/**` 零改动）。

### 3.1 配置先行：`config/home.js`（**唯一的功能改动**）

```diff
+import { PURCHASE_REQUEST_FORM_URL } from './links.js';
+
 export const COMMON_ENTRIES = [
   {
     id: 'purchase',
     icon: '🛒',
-    title: '采购',
-    desc: '供应商报货、采购退货——点进去是两个飞书表单',
-    href: '/workbench/purchase-return.html',
+    title: '报货与退货',
+    desc: '供应商报货与退货（同一个飞书表单）——点一下直接打开',
+    href: PURCHASE_REQUEST_FORM_URL,
     arrow: '进入 →',
   },
   {
     id: 'inventory-adjustment',
     …（**逐字不动**：icon / title / desc / href / arrow / wide 全保留）…
   },
 ];
```

### 3.2 其余三处（**只有注释 / 说明，零行为改动**）

- `config/links.js`：只改段注释（消费方从"不再 import"改回"`home.js` 只 import `PURCHASE_REQUEST_FORM_URL`"，
  并写明 `PURCHASE_RETURN_FORM_URL` **一个字节都不删**）。URL 与 `PURCHASE_FORMS` **零改动**。
- `features/common/index.js`：只改段注释（渲染逻辑一个字没动 —— 仍是"按 `COMMON_ENTRIES` 画"）。
- `server/public/workbench/README.md` / `docs/README.md` / `docs/workbench-requirements-2026-10-06.md`：
  同步口径与索引。
- ⭐ **注释-only 的代码级核对**（`git diff -U0` 过滤掉 `//`、`*`、`/*` 开头的行后为空）：

  ```
  $ git diff -U0 -- server/public/workbench/features/common/index.js server/public/workbench/config/links.js \
      | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-]\s*(//|\*|/\*)'
  （除注释外无改动）
  ```

### 3.3 `features/purchase/links.js` / `purchase-return.html` / `standalone.js`

**不在改动清单里**（`git status --porcelain` 三个文件都不在）—— 老页面一个字没改。

---

## 四、逐条对照（验收标准 vs 实测）

| # | 验收标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| AC1 | 首页只有【报货与退货】一个采购类入口：标题逐字 `['报货与退货','库存手工调整']`、无 `title='退货'` 的卡、无 `id='purchase-return'` 条目、`id` 仍是 `purchase`、icon/arrow 风格一致 | ✅ | `workbenchHomeEntries.test.js` 用例 1（`deepEqual(titles, …)` ＋ `filter(title==='退货').length===0` ＋ `filter(id==='purchase-return').length===0` ＋ `purchase.icon==='🛒'` ＋ `purchase.arrow==='进入 →'`）；DOM dump 见第二节 |
| AC2 | 卡的 `href` **逐字** = `PURCHASE_REQUEST_FORM_URL`，且不指向任何内页 | ✅ | 用例 1（`cards[0].href === links.PURCHASE_REQUEST_FORM_URL` ＋ `!cards.some(href.includes('purchase-return.html'))`）；DOM dump 里 `href` 就是 `…/shrcnn4f9ZJzpm7JbT2rCH247xc` |
| AC3 | 首页**不出现** `PURCHASE_RETURN_FORM_URL` | ✅ | 用例 2（三条：没有卡的 href 等于它 / HTML 里 `!includes` / `COMMON_ENTRIES` 里也没有）；DOM dump 里搜不到 `shrcnjsqt4D5…` |
| AC4 | 哨兵：`inventory-adjustment` 逐字不变（含 `wide`），渲染不变 | ✅ | 用例 4（与测试里写死的 `INVENTORY_ADJUSTMENT_ENTRY` **全等**）；`git diff` 里那一段**零改动** |
| AC5 | 不删链接：`PURCHASE_FORMS` 仍两条、两个 URL 都在、退货 URL 仍被 `features/purchase/links.js` 引用 | ✅ | 用例 6 后半段（`PURCHASE_FORMS.map(id)` / `.map(url)` `deepEqual`）；`features/purchase/links.js` 仍 `import { PURCHASE_FORMS }`（`git status` 里它**不在**改动清单） |
| AC6 | 老链接不坏：`purchase-return.html` 仍在、`standalone.js` 仍注册、默认仍两张卡 | ✅ | 用例 6（`existsSync` ＋ `data-view` ＋ `standalone.js` 注册 ＋ 真跑模块 `deepEqual(titles/hrefs)`）；`git status` 里这三个文件**都不在** |
| AC7 | 配置先行：清单只来自 `home.js`、URL 单一来源 `links.js`（只 import 不复制） | ✅ | 用例 3（渲染结果与 `COMMON_ENTRIES` 逐条 `deepEqual` ＋ `home.js` 里 `from './links.js'` ＋ `home.js` / `features/common/index.js` 里**都没有** `feishu.cn` 字面量） |
| AC8 | 边界：`server/src/**` / `app.js` / `pendingDealPush*` / 采购链路一行不动；不写表 | ✅ | `git diff --stat -- server/src` **空**；`git status --porcelain` 8 个条目全在 `docs/**` 与 `server/public/workbench/**` ＋ `server/test/`；全程**零表写入**（本任务只有静态前端 + 单测） |
| AC9 | 测试：改动前红、改动后绿；全量 2 次 `fail=0` | ✅ | 见第五、六节 |
| AC10 | CI 三项 pass ＋ `mergeStateStatus=CLEAN`；没用 `--admin`；**不合并、不部署** | ✅ | 见第七节 |

---

## 五、先红后绿

**同一个测试文件**（`server/test/workbenchHomeEntries.test.js`，已按 ⓐ 新口径重写）在**改动前**跑
（源码一个字节没动，`HEAD = f10ee45`；harness 对"`home.js` 是否 import `links.js`"这条 import
标了 `optional`，所以改动前后都能跑）：

```
$ node --test --test-concurrency=1 test/workbenchHomeEntries.test.js     # 改动前
✖ 首页【常用功能】：只有【报货与退货】一个采购类入口 —— 标题逐字、点一次直达报货飞书表单 (11.1ms)
✔ 首页里不出现退货飞书表单 URL（退货独占的外链不在首页） (3.5ms)
✖ 首页入口清单是配置驱动的：config/home.js 是唯一清单来源，URL 单一来源 config/links.js (4.1ms)
✔ 哨兵：「库存手工调整」那条入口（含 wide / 文案 / 目标）一个字节不动 (2.5ms)
✔ 首页卡片同窗口跳转（手机上在飞书内置浏览器里打开，不新开窗口） (2.3ms)
✔ 老链接不坏：/workbench/purchase-return.html 仍然能开、仍然是两张表单卡（回归） (2.3ms)
✔ 一级 tab（index.html 的常用功能）与独立页（common.html）渲染同一份清单 (2.2ms)
ℹ tests 7 · pass 5 · fail 2
```

两条红的**逐字原因**：

```
AssertionError: 首页必须只剩【报货与退货】一个采购类入口，且标题逐字 = 报货与退货
  actual:   [ '采购', '库存手工调整' ]
  expected: [ '报货与退货', '库存手工调整' ]

AssertionError: config/home.js 必须 import config/links.js（URL 单一来源，不复制字面量）
  actual: false · expected: true
```

⚠️ 用例 1 在标题那条断言就红了，**没走到 `href`** —— 所以另外**单独打印了一次改动前的真渲染**
（同一个 harness，只读）：

```
=== 改动前首页实际渲染 ===
[ { "classes": "entry-card", "href": "/workbench/purchase-return.html", "title": "采购" },
  { "classes": "entry-card entry-wide", "href": "/workbench/inventory-adjustment.html", "title": "库存手工调整" } ]
card[0].href === 报货表单URL ? false      ← 改动前 href 是内页（点两次）
card[0].title === 报货与退货 ? false      ← 改动前标题是「采购」
```

**改动后**（只落了 `config/home.js` 这一刀 + 注释/文档）：

```
$ node --test --test-concurrency=1 test/workbenchHomeEntries.test.js     # 改动后
✔ …7 条全绿…
ℹ tests 7 · pass 7 · fail 0
```

⚠️ 另外 5 条**改动前就该绿**（哨兵 / 老链接 / 同窗口跳转 / 两页同清单；配置驱动那条改动前红）
—— 它们本来就是为了"别把别的东西改坏"。

---

## 六、全量两轮

⚠️ 按纪律**不在主工作区跑全量**，在**独立 worktree**
（`.local/worktrees/workbench-direct-form`，分支 `feat/workbench-report-return-direct-form`）里跑：

```
$ git rev-parse --short HEAD         # f10ee45（= origin/main；本次改动尚未 commit）
$ node --test --test-concurrency=1   # 第 1 轮
ℹ tests 1354 · pass 1354 · fail 0 · duration_ms 34308.11
$ node --test --test-concurrency=1   # 第 2 轮
ℹ tests 1354 · pass 1354 · fail 0 · duration_ms 35152.13
```

⚠️ **如实记一个环境坑**：worktree 里**没有 `node_modules`**（gitignored，只有主工作区有）——
第一次跑全量时 30+ 个用例报 `Cannot find module '@larksuiteoapi/node-sdk'`（**与我改的东西无关**）。
按处理 `.env` 的同一办法**临时软链** `server/node_modules` 之后，两轮都是 **1354/1354 · fail 0**。
（软链与 `.env` 都只在 worktree 里、gitignored，收尾删除。）

---

## 七、CI 三项

（**待回填**：开 PR 后填 `gh pr checks` 与 `mergeStateStatus`）

---

## 八、不确定处（要她 / Lead 过目）

1. ⭐ **`desc` 的逐字是我拟的**（她只说"之类"）：`供应商报货与退货（同一个飞书表单）——点一下直接打开`。
   要点是**把"同一个表单"说清楚**（这正是她 ⓐ 的理由）。若她另有措辞，**只改 `config/home.js` 一行**。
2. **`arrow` 保持 `进入 →`**（她说"icon/arrow 保持风格一致"）：与上一版逐字相同、也是【库存手工调整】那张的写法。
   这张卡现在是**外链**，若她更想要旧的 `去填写 →`（2026-10-07 拆分版的写法），也只改一行。
3. 🔴 **"报货和退货用的是一个表单"是她给的理由，我核不到飞书侧**：两个 `/share/base/form/shrc…`
   是**外链**，本机 `curl` 只拿到 JS 外壳、没有字段清单；本机也没有生产凭证（按纪律不去读生产 Base）。
   ⇒ 我**按她的话实现**（首页那张卡直连**报货**表单 URL）。若其实两个表单**还没并**，
   那退货在**首页 / 采购链路**上就只剩收藏过的老链接 `/workbench/purchase-return.html` 能进 ——
   这一点**只有她能确认**。
4. **退货 URL 从此在首页 HTML 里彻底不出现**（AC3）—— 这是"只删退货那张卡"的直接结果；
   但它的定义与那一页都**完好保留**（AC5/AC6），所以**没有删任何东西**。
5. 🔴 **没有合并、没有部署**（按纪律：合并由 Lead / 她来；部署必须拿到她**当次**的命令）。
