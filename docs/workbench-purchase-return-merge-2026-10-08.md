# 工作台首页【常用功能】：把「采购」「退货」**合并成一个入口**（2026-10-08）

> 业务负责人（逐字）：
> 「工作台需要修改一下，**采购和退货合并为一个入口**，**就用采购的链路**，
>  即**退货的链接没有了**～」

---

## 〇、先把现状核清（只读，不凭转述）

### ① 两个入口原先各指向哪里

| 首页卡片（改动前） | `id` | 图标 / 标题 | `href`（点一次落在哪） | 目标是什么 |
| --- | --- | --- | --- | --- |
| 第一张 | `purchase` | 🛒 采购 | `config/links.js` 的 `PURCHASE_REQUEST_FORM_URL` = `https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc` | **飞书表单外链**（「采购报货」表单）——**外链，直接跳出工作台**，中间**没有任何工作台页面** |
| 第二张 | `purchase-return` | ↩️ 退货 | `config/links.js` 的 `PURCHASE_RETURN_FORM_URL` = `https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnjsqt4D5URseSSXgecYlqGd` | **飞书表单外链**（「采购退货」表单）——同样是**外链** |
| 第三张（哨兵） | `inventory-adjustment` | 🧮 库存手工调整 | `/workbench/inventory-adjustment.html` | 工作台**内页**（盘点 / 换季调整，走 `/api/workbench/*`） |

- 三张卡的清单在 `server/public/workbench/config/home.js` 的 `COMMON_ENTRIES`，
  由 `features/common/index.js` 渲染（同窗口跳转、`rel="noopener"`）。
- **两个入口都只是"外链"**：既没有路由、也没有页签、也**不调任何接口**。
  （核过：`features/common/index.js` 与 `config/home.js` 里**零** `api.get`。）

### ② 「退货」那条链路里，有什么是「采购」那条**不给**的

核完整棵工作台（`server/public/workbench/**`）：

| 退货相关的东西 | 在哪 | 采购那边有没有 |
| --- | --- | --- |
| **采购退货飞书表单**（`PURCHASE_RETURN_FORM_URL`） | `config/links.js` 的 `PURCHASE_FORMS[1]` | ❌ **没有** —— 采购卡只给「采购报货」表单（`PURCHASE_FORMS[0]`） |
| 退货**列表 / 查询** | **不存在**（全仓核过：没有退货查询接口 / 页面 / 表格） | —— |
| 退货**子页签** | **不存在**。工作台里跟"采购"有关的页签只有**隐去的**「采购管理」一级 tab（`features/purchase/index.js`，`main.js` 注册但 `index.html` 没有按钮），它的子页签是「报货信息情况」「到货验收情况」——**没有退货** | ❌ |
| 退货**申请 / 记录** 页 | **不存在** | —— |
| 退货相关的**筛选** | **不存在** | —— |

⇒ **结论：「退货」那条链路在工作台里的全部内容 = 那一个飞书表单外链**。
它**没有**独立页面、没有子页签、没有列表、没有接口。工作台**唯一**同时装着
「报货 + 退货」两个表单的地方是**同一页**：

- `/workbench/purchase-return.html`（标题「采购和退货」）→ `features/purchase/links.js`
  按 `PURCHASE_FORMS` 渲染**两张外链卡**（报货 / 退货）。这也是 2026-10-07 拆分**之前**
  首页那一个合并入口指向的页面（口径留档 `docs/workbench-purchase-return-split-2026-10-07.md`）。

⇒ 所以「合并入口 + 不丢退货」只有一条路：**把首页那一个入口指回这一页**
（退货从【首页一级入口】降级为【采购页里的子入口】）。

---

## 一、改完之后应该是什么样（验收标准 · 先写后做）

| # | 验收标准 |
| --- | --- |
| **AC1** | 首页【常用功能】只有**一个采购类入口**：卡片标题**逐字** = `['采购', '库存手工调整']`（顺序也是这个）；**没有**任何一张卡的 `title` 是 `退货`；`COMMON_ENTRIES` 里**没有** `id = 'purchase-return'` 的条目 |
| **AC2** | **退货的独立链接没有了**：首页**没有任何一张卡**的 `href` 等于 `PURCHASE_RETURN_FORM_URL`（不再直连退货飞书表单） |
| **AC3** | ⭐ **功能没丢**：合并后从【采购】那一个入口**能到达退货** —— 采购卡 `href = /workbench/purchase-return.html`；真跑 `createPurchaseLinksModule()` 渲染那一页，卡片标题仍是 `['报货','退货']`、`href` 仍是 `[PURCHASE_REQUEST_FORM_URL, PURCHASE_RETURN_FORM_URL]` ⇒ 退货飞书表单**仍在、仍可达** |
| **AC4** | **不删后端 / 不删链接**：`config/links.js` 的 `PURCHASE_FORMS` 仍是两条（报货 / 退货），`PURCHASE_RETURN_FORM_URL` 仍被 `features/purchase/links.js` 引用；`server/src/**` **一行不动**；不动任何接口 |
| **AC5** | **配置先行**：入口清单（`id`/`icon`/`title`/`desc`/`href`/`arrow`/顺序）只来自 `config/home.js`；`features/common/index.js` 只负责画，不写死清单、不复制 URL |
| **AC6** | **哨兵：其它入口一个不动** —— `COMMON_ENTRIES` 里 `id = 'inventory-adjustment'` 那条**逐字不变**（`{id, icon, title, desc, href, arrow, wide}` 全等）；它的卡片渲染结果（href / arrow / `entry-wide`）也不变 |
| **AC7** | **老链接不坏**：`/workbench/purchase-return.html`（`purchase-return.html` 页 + `standalone.js` 注册 + `features/purchase/links.js`）**一个字没改**，不带参数打开仍然是两张表单卡 |
| **AC8** | **视觉**：桌面端两列（不留空位，与 2026-10-07 拆分前同一条规则）；手机上不覆盖 `base.css` 的窄屏规则 ⇒ 两个入口上下排、一屏可见 |
| **AC9** | **测试**：新用例在改动前**红**（贴输出）、改动后绿；全量 `node --test --test-concurrency=1` 连跑 **2 次** fail=0 |
| **AC10** | **CI**：`gh pr checks` 三项（`test` / `CodeQL` / `Analyze`）**pass**、`mergeStateStatus = CLEAN`；**禁止 `--admin`**；**开 PR ✗ 不合并 ✗ 不部署** |

---

## 二、改完之后的实际结构与文案（逐字）

```
常用功能
日常最常用的入口；点卡片直接去填写或操作

┌────────────────────────────────┐ ┌────────────────────────────────┐
│ 🛒                             │ │ 🧮                             │
│ 采购                           │ │ 库存手工调整                    │
│ 供应商报货、采购退货——          │ │ 盘点调整（改数量，盘多了加、      │
│ 点进去是两个飞书表单            │ │ 盘少了减）· 换季调整（门盒/样品   │
│ 进入 →                         │ │ ↔ 仓库，数量不变）               │
└────────────────────────────────┘ │ 进入 →                          │
                                   └────────────────────────────────┘
```

| 卡片 | `href` | 点进去之后 |
| --- | --- | --- |
| 🛒 采购 | `/workbench/purchase-return.html`（工作台内页） | 那一页是「采购和退货」：**报货**（→ `PURCHASE_REQUEST_FORM_URL`）、**退货**（→ `PURCHASE_RETURN_FORM_URL`）两张飞书表单卡 |
| 🧮 库存手工调整 | `/workbench/inventory-adjustment.html` | 与改动前**逐字一致** |

⚠️ **已知代价（有意，写在前面）**：报货由"首页点一次**直达**表单"变成"**点两次**"
（首页 →「采购和退货」页 →「报货」卡）。这是"合并成一个入口"的必然结果 ——
一个入口只能有一个 `href`；她的红线是**退货不能丢**，所以这里**不**把 `href`
直接写成报货表单外链（那样退货在工作台里就再也点不到了）。
若她要的是"退货链接**彻底**没有、报货仍是点一次直达"，只改 `config/home.js` 一行
（把 `href` 换成 `form('purchase-request').url`）即可 —— 见第八节。

---

## 三、关键 diff（一句话：只改入口层，`server/src/**` 一行不动）

改动文件（`git diff --stat`，**7 改 1 新**）：

```
 docs/README.md                                     |   1 +
 docs/workbench-requirements-2026-10-06.md          |  10 ++
 server/public/workbench/README.md                  |  14 ++-
 server/public/workbench/config/home.js             |  50 ++++----
 server/public/workbench/config/links.js            |  13 ++-
 server/public/workbench/features/common/common.css |  16 ++-
 server/public/workbench/features/common/index.js   |   9 +-
 server/test/workbenchHomeEntries.test.js           | 129 +++++++++++++++++----
 （新）docs/workbench-purchase-return-merge-2026-10-08.md
```

### 3.1 配置先行：`config/home.js`（**唯一的功能改动**）

```diff
-import { PURCHASE_FORMS } from './links.js';
-/** 按 id 取飞书表单… */
-function form(id) { … }
-
 export const COMMON_ENTRIES = [
   {
     id: 'purchase',
     icon: '🛒',
     title: '采购',
-    desc: '供应商报货——点一下直接打开飞书表单',
-    href: form('purchase-request').url,          // 直连报货飞书表单
-    arrow: '去填写 →',
-  },
-  {
-    id: 'purchase-return',                       // ← 退货那张独立卡，整条删掉
-    icon: '↩️',
-    title: '退货',
-    desc: '把货退给供应商——点一下直接打开飞书表单',
-    href: form('purchase-return').url,
-    arrow: '去填写 →',
+    desc: '供应商报货、采购退货——点进去是两个飞书表单',
+    href: '/workbench/purchase-return.html',     // 工作台内页（报货 + 退货两张表单卡）
+    arrow: '进入 →',
   },
   {
     id: 'inventory-adjustment',
     …（**逐字不动**：icon / title / desc / href / arrow / wide 全保留）…
   },
 ];
```

- `form()` 那个小助手随之**没有调用方**了 ⇒ 一起删掉（不留死代码）；`config/home.js`
  因此**不再 import `links.js`**（它不再直接消费表单 URL）。
- ⚠️ **`links.js` 里两个表单 URL 一个都没删**（`PURCHASE_FORMS` 仍是报货 + 退货两条），
  退货表单仍被 `features/purchase/links.js` 用着。

### 3.2 样式：`features/common/common.css`（两个入口的版式）

```diff
-@media (max-width: 760px) {
-  .quick-entries.entries-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
-  .quick-entries.entries-pair > .entry-card.entry-wide { grid-column: 1 / -1; }
-}
+/* 桌面端两列（默认三列会留一个空位） */
+.quick-entries.entries-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
+/* 手机上一列（覆盖上面那条；与 base.css 的窄屏规则一致） */
+@media (max-width: 760px) {
+  .quick-entries.entries-pair { grid-template-columns: minmax(0, 1fr); }
+}
```

- 这次**没有**改 `styles/base.css`（一行没动）；`entry-wide` 那条规则随"手机上单列"去掉
  （单列下本来就是整行）。⚠️ 配置里「库存手工调整」的 `wide: true` **一个字没动**
  —— 字段仍在、`entry-card entry-wide` 类仍照配渲染（有哨兵用例钉住）。

### 3.3 其余三处（**只有注释 / 说明，零行为改动**）

- `features/common/index.js`：只改了段注释（渲染逻辑一个字没动 —— 仍是"按 `COMMON_ENTRIES` 画"）。
- `config/links.js`：只改了段注释（消费方从"两个"改成一个）。
- `server/public/workbench/README.md` / `docs/README.md` / `docs/workbench-requirements-2026-10-06.md`：
  同步口径与索引。

### 3.4 改完之后的**真实 DOM**（真跑 `createCommonModule()`，390px 宽的手机口径）

```html
<section class="panel">
  <div class="panel-header">
    <div>
      <h2>常用功能</h2>
      <p class="subtitle">日常最常用的入口；点卡片直接去填写或操作</p>
    </div>
  </div>
  <div class="quick-entries entries-pair">
      <a class="entry-card" href="/workbench/purchase-return.html" rel="noopener">
        <div class="icon">🛒</div>
        <h3>采购</h3>
        <p>供应商报货、采购退货——点进去是两个飞书表单</p>
        <div class="arrow">进入 →</div>
      </a>
      <a class="entry-card entry-wide" href="/workbench/inventory-adjustment.html" rel="noopener">
        <div class="icon">🧮</div>
        <h3>库存手工调整</h3>
        <p>盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）</p>
        <div class="arrow">进入 →</div>
      </a>
  </div>
</section>
```

（**改动前**同一段 DOM 里是三张卡：采购 → 报货飞书表单、**退货 → 退货飞书表单**、库存手工调整。）

点【采购】之后落在 `/workbench/purchase-return.html`（**一个字没改**）：

```
采购和退货
点下面两个按钮，直接打开对应的飞书表单填写

┌──────────────────────┐  ┌──────────────────────┐
│ 🛒 报货               │  │ ↩️ 退货               │
│ 供应商报货——填完直接    │  │ 把货退给供应商，填完   │
│ 生成报货单   去填写 →  │  │ 直接生成退货单 去填写 → │
└──────────────────────┘  └──────────────────────┘
```

⚠️ **本会话拿不到真浏览器截图**（如实记）：沙箱把 Chrome / qlmanage 一律 `SIGTRAP` / 
`sandbox initialization failed` 杀掉（`bash-20009` / `bash-20013` 两个后台任务都是这个结局），
所以**版式只做了静态核对**（CSS 规则逐字 + 上面那份真跑的 DOM），**没有像素级截图**。

---

## 四、逐条对照（验收标准 vs 实测）

| # | 验收标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| AC1 | 首页只有一个采购类入口：卡片标题**逐字** `['采购','库存手工调整']`、没有 `title='退货'` 的卡、`COMMON_ENTRIES` 里没有 `id='purchase-return'` | ✅ | `workbenchHomeEntries.test.js` 用例 1（`deepEqual(titles, ['采购','库存手工调整'])` ＋ `filter(title==='退货').length===0` ＋ `filter(id==='purchase-return').length===0`）；`cards.length===2` |
| AC2 | 退货的独立链接没有了：首页没有任何卡的 `href === PURCHASE_RETURN_FORM_URL`，首页 HTML 里不出现退货表单 URL | ✅ | 用例 1 后半段（两条断言）；DOM dump 里也搜不到 `shrcnjsqt4D5…` |
| AC3 | ⭐ 功能没丢：`purchase.href === '/workbench/purchase-return.html'`，且那一页仍渲染 `['报货','退货']` → `[PURCHASE_REQUEST_FORM_URL, PURCHASE_RETURN_FORM_URL]` | ✅ | 用例 2（真跑 `createPurchaseLinksModule()`，`deepEqual(titles/hrefs)`）；`docs/workbench-purchase-return-split-2026-10-07.md` 的 AC4 用例也在（老链接那一条） |
| AC4 | 不删后端 / 不删链接：`PURCHASE_FORMS` 仍两条、`PURCHASE_RETURN_FORM_URL` 仍被引用；`server/src/**` 一行不动 | ✅ | 用例 2 ③；`git diff --stat -- server/src` **空**；`git status` 里没有任何 `server/src/**` 文件 |
| AC5 | 配置先行：清单只来自 `config/home.js`，模块只画 | ✅ | 用例 3（渲染结果与 `COMMON_ENTRIES` 逐条 `deepEqual`）；`features/common/index.js` 里没有任何 URL / 清单（`git diff` 只有注释） |
| AC6 | 哨兵：`inventory-adjustment` 那条**逐字不变**（含 `wide`），它的卡片渲染也不变 | ✅ | 用例 4（与测试里写死的 `INVENTORY_ADJUSTMENT_ENTRY` **全等**）；`git diff` 里那一段**零改动**（diff 只碰了 `purchase` 那条与 `purchase-return` 整条） |
| AC7 | 老链接不坏：`purchase-return.html` / `standalone.js` / `features/purchase/links.js` 一个字没改，仍是两张表单卡 | ✅ | 用例 6（`existsSync` ＋ `data-view` ＋ `standalone.js` 注册 ＋ 真跑模块 `deepEqual`）；`git status` 里这三个文件**都不在**改动清单里 |
| AC8 | 视觉：桌面两列 / 手机一列（两个入口上下排、一屏可见） | ⚠️ **静态核对** | `common.css` 的规则逐字（见 3.2）；**没有像素级截图**（本会话沙箱杀浏览器，见 3.4 末） |
| AC9 | 测试：改动前红、改动后绿；全量 2 次 fail=0 | ✅ | 见第五、六节 |
| AC10 | CI 三项 pass ＋ `mergeStateStatus=CLEAN`；没用 `--admin`；**不合并、不部署** | ✅ | 见第七节 |

---

## 五、先红后绿

**同一个测试文件**（`server/test/workbenchHomeEntries.test.js`）在改动**前**跑
（`HEAD = ff56632`，未改任何源码；harness 对"`home.js` 还 import `links.js`"这条 import
标了 `optional`，所以改动前后都能跑）：

```
$ node --test --test-concurrency=1 test/workbenchHomeEntries.test.js     # 改动前
✖ 首页【常用功能】：只剩【采购】一个采购类入口 —— 「退货」那张独立卡没有了 (11.4ms)
✖ ⭐ 合并后从【采购】入口能到达退货：入口 → 「采购和退货」页 → 退货飞书表单 (3.9ms)
✔ 首页入口清单是配置驱动的：config/home.js 是唯一清单来源
✔ 哨兵：「库存手工调整」那条入口（含 wide / 文案 / 目标）一个字节不动
✔ 首页卡片同窗口跳转（手机上在飞书内置浏览器里打开，不新开窗口）
✔ 老链接不坏：/workbench/purchase-return.html 仍然能开、仍然是两张表单卡
✔ 一级 tab（index.html 的常用功能）与独立页（common.html）渲染同一份清单
ℹ tests 7 · pass 5 · fail 2
```

两条红的**逐字原因**（就是"退货那张卡还在"这件事）：

```
AssertionError: 首页必须只剩【采购】一个采购类入口（采购/退货已合并，不再是三张卡）
  actual:   [ '采购', '退货', '库存手工调整' ]
  expected: [ '采购', '库存手工调整' ]

AssertionError: 「采购」卡必须指向 /workbench/purchase-return.html（采购和退货页）
  actual:   'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc'
  expected: '/workbench/purchase-return.html'
```

⚠️ 另外 5 条**改动前就该绿**（哨兵 / 老链接 / 配置驱动 / 同窗口跳转 / 两处同清单）
—— 它们本来就是为了"别把别的东西改坏"。

**改动后**（`config/home.js` 落地的第一刀就转绿，没有再动别的）：

```
$ node --test --test-concurrency=1 test/workbenchHomeEntries.test.js     # 改动后
✔ …7 条全绿…
ℹ tests 7 · pass 7 · fail 0
```

---

## 六、全量两轮

⚠️ 按纪律**不在主工作区跑全量**，在**独立 worktree**
（`.local/worktrees/workbench-merge-entry`，分支 `feat/workbench-merge-purchase-return-entry`）里跑：

```
$ git rev-parse --short HEAD         # 3e13e62（rebase 到 origin/main 8247f0d 之后）
$ node --test --test-concurrency=1   # 第 1 轮
ℹ tests 1354 · pass 1354 · fail 0 · duration_ms 34939.07
$ node --test --test-concurrency=1   # 第 2 轮
ℹ tests 1354 · pass 1354 · fail 0 · duration_ms 36423.77
```

（本次测试文件从 **5 条**用例变成 **7 条**（改了 1 条口径 + 新增 1 条"能到达退货" + 1 条哨兵）⇒ +2。
我动手之后 `main` 前进了 5 个提交（PR #258「到货卡片表单」把总数从 1338 拉到 **1352**），
所以 rebase 之后是 1352 + 2 = **1354** —— 与上面两轮一致。
⚠️ rebase **前**那一版（`c635e7e`）也连跑 2 次 `pass 1340 / fail 0`；rebase 只解了
`docs/README.md` 一处"两张表都要留"的冲突（**零代码改动**），rebase 后重跑的两轮见上。）

---

## 七、CI 三项

PR **#259**（分支 `feat/workbench-merge-purchase-return-entry`），
`gh pr checks 259`（head = `faab1d6`：rebase 到 `origin/main 8247f0d` 之后的那个提交）：

```
Analyze (javascript-typescript)	pass	1m4s	https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37657629823/job/112916682977
CodeQL	                        pass	2s  	https://github.com/LyraWang6688/feishu-retail-ops/runs/112917097814
test	                        pass	1m7s	https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37657634739/job/112916694362
```

`gh pr view 259 --json mergeStateStatus,mergeable,headRefOid`
→ **`mergeStateStatus = CLEAN`**、`mergeable = MERGEABLE`、`headRefOid = faab1d63…`。

⚠️ **如实记两件事**：
1. **第一次推上来时 `mergeStateStatus` 是 `DIRTY` / `CONFLICTING`** —— 不是 CI 的问题：
   我动手之后 `origin/main` 前进了 **5 个提交**（PR #258 到货卡片表单），
   两边都往 `docs/README.md` 的现行事实表里加行 ⇒ **只有那一处文本冲突**。
   处理：**rebase**（不是 merge）到 `origin/main`，**保留两行**（谁的一行都没丢），
   然后 `git push --force-with-lease`（**没有** `--admin`、**没有**绕闸门）；
   rebase 后全量重跑 2 次（**1354/1354 ×2**，见第六节）。
2. 本节之后**还有一次 docs-only 的提交**（把 CI 证据写进本文件，**零代码 / 零测试改动**）——
   它的三项 CI 也跑完了（见 PR 的 check 列表：最终 head 仍是三项全绿 + `CLEAN`）。

🔴 **没有合并、没有部署**（按纪律：合并由业务负责人 / Lead 来；部署必须拿到她**当次**的命令）。

---

## 八、不确定处（要她 / Lead 过目）

1. ⭐ **口径的两种读法，我选了"不丢功能"那一种 —— 请她确认**：
   她那句「**就用采购的链路**，即**退货的链接没有了**」有两种读法：
   - **我实现的（ⓑ）**：首页那**一张**【采购】卡 → 工作台内页「采购和退货」，
     报货 / 退货两个表单卡都在里面 ⇒ 退货**降级成采购页里的子入口**，**功能不丢**；
     **代价**：报货从"首页点一次**直达**表单"变成"**点两次**"（这与她 2026-10-07
     「不需要多点一次」相反）。
   - **另一种（ⓐ）**：把【采购】那张卡的 `href` 直接保持为**报货飞书表单**、只把
     【退货】那张卡删掉 ⇒ 报货仍点一次直达，但**退货在工作台首页 / 采购链路上就再也点不到了**
     （只剩收藏过的 `/workbench/purchase-return.html` 老链接、以及「库存手工调整」页导航里
     那个「采购和退货」链接还能绕过去）。
   - **为什么我选 ⓑ**：本次任务书里的红线是「⚠️ **不许把功能弄丢**」；而且**核过**
     退货在工作台里的**全部内容就是那一个飞书表单**（没有退货列表 / 子页签 / 接口），
     所以"合并成一个入口 + 不丢退货"只有指回那一页这一条路。
   - **切换成本**：若她确认要 ⓐ，只改 `config/home.js` 里 `purchase.href` **一行**
     （换回报货表单 URL，并把 `import { PURCHASE_FORMS }` / `form()` 加回来），
     测试相应改 2 条断言即可 —— **不用改任何别的文件**。
2. **退货表单是否已被她在飞书侧合并进「报货」表单** —— **我核不到**（那两张
   `/share/base/form/shrc…` 是飞书外链，本机 `curl` 只拿到 JS 外壳，没有字段清单；
   本机也没有生产凭证，按纪律不去读生产 Base）。若她已经把两个表单并成一个（退货在报货表单里
   选「采购行为」），那 ⓐ 也**不会丢功能** —— 这一点**只有她能确认**；我按"未知 ⇒ 不删功能"处理。
3. **首页那张卡的标题逐字用「采购」**（任务书口径：用「采购」这个名字 / 图标）。
   点进去那一页的标题仍是「采购和退货」（**刻意没改**：老链接 / 老页面不坏，且它确实装着两个表单）。
   若她想让里面那页也叫「采购」，那是**另一个改动**（会碰到 `purchase-return.html` 与
   `inventory-adjustment.html` 的导航文案），我没有擅自动。
4. **手机上从"两张并排 + 库存整行"改成"上下两行"**：`entry-wide` 那条 CSS 规则去掉了
   （单列下无意义），但配置里「库存手工调整」的 `wide: true` **没动**（哨兵），
   于是这个字段**现在不影响版式**——已在 `common.css` 与 `home.js` 注释里写明。
   若她更想要"手机上采购 / 库存并排一行"，把 `common.css` 的窄屏那条改回 `repeat(2, …)` 即可。
5. 🔴 **没有部署、没有合并**（按纪律：合并由她 / Lead 来，部署必须拿她**当次**的命令）。
