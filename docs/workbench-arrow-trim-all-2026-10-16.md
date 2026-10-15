# 工作台「多余的箭头行」清理全记录（2026-10-16）

> **一句话**：工作台里凡是**整张卡片本身就是链接**（`<a class="entry-card" href=…>` 把
> icon / 标题 / 箭头全包在里面）的卡，底下那行**箭头都没有任何跳转职责、纯多余** ⇒ 删。
> 2026-10-16 一天内分**三批**清完，`config/domains.js` 这套渲染里的 `arrow` 集合最终 = **空集**。

---

## 一、判据（三批用的是**同一个**判据）

**判定公式**（业务负责人 2026-10-16 亲口点的方式，我们把它固化成可检查的形状）：

> **整张卡片本身就是链接**（渲染出来是 `<a class="entry-card" href=…>`，
> 把 icon / 标题 / 箭头**全包在里面**）⇒ **底下那行箭头没有任何跳转职责、纯多余** ⇒ **删** ✓

**为什么**：配了 `href` 的卡在 `features/domains/pages.js` 的 `cardsHtml` 里被渲染成
`<a class="entry-card" href="…" rel="noopener">…</a>`（`.entry-card` 铺满卡面，
`test/workbenchMobileVisual.test.js:114` 钉着）⇒ **点卡片任意一处就是跳转**；
那行 `arrow` **在 `<a>` 里面**，只是一句"快点点我"的提示语。

**⚠️ 判据的准确边界（不许扩大化）**：

| 情形 | 那行字是什么 | 处置 |
| --- | --- | --- |
| 卡配了 `href`（整张卡是 `<a>`） | 纯提示语，**没有跳转职责** | **删** ✓ |
| 卡**没有** `href`（`disabled-card` / 「链接待配置」） | **不是链接**，那行是**卡面的如实交代** | **保留** ✗ 别顺手删 |
| 卡配了 `jumpTo`（同 tab 内切子页） | `<button>`，不是 `<a>` | 不在本条判据里（本次没碰） |

**🔴 只删"真能跳的卡"上那行**；**空 URL / 链接待配置**那种**原样保留** ✓。

---

## 二、三批改动逐条对照

### 第 ① 批 —— PR **#699**（「货品」页的「标签打印」两张卡）

* 位置：`server/public/workbench/config/domains.js` · `product-labels` 页的 `links`
* 改前逐字（两行）：

  ```js
  { icon: '📷', title: '扫码打印', href: '/workbench/label-print.html?scan=1', arrow: '去扫码打印 →' },
  { icon: '🖨️', title: '批量打印', href: '/workbench/label-print.html',        arrow: '打开标签打印页 →' },
  ```

* 改后逐字：**两行 `arrow` 整行删掉**（`href` / `icon` / `title` 一个字不动）
* **依据（她 2026-10-16 逐字）**：「**是否就是多余的，点开入口卡片就可以实现跳转吧，
  需要你实际核对一下代码**」
* 只读核实：`cardsHtml` 把配了 `href` 的卡渲染成整张可点的 `<a>` ⇒ 卡片本体自己就能跳
* ⭐ **同一次还把渲染层改了**（关键，否则等于没删）—— 见 `features/domains/pages.js` 的 **`cardsHtml` / `cardBody`**：
  * `cardBody`：**永远画一行** → **只有 `arrow` 为真才画那一行**

    ```js
    // 改前逐字（形状）：  <div class="arrow">${escapeHtml(arrow)}</div>`;
    // 改后逐字：          ${arrow ? `
    //         <div class="arrow">${escapeHtml(arrow)}</div>` : ''}`;
    ```

  * `cardsHtml` 两个调用点：**把兜底文案从实参里去掉**

    ```js
    // 改前逐字：  cardBody(card, card.arrow || '打开 →')      （jumpTo 那条）
    //             cardBody(card, card.arrow || '进入 →')      （href 那条）
    // 改后逐字：  cardBody(card, card.arrow)                  （两条都只剩 card.arrow）
    ```

  ⚠️ **留兜底 = 删了配置那行反而显示默认箭头 ⇒ 等于没删** ✗（#699 把这两层**都**清了）
* 受影响的既有判据（成对迁移，**改前逐字 → 改后逐字 → 依据**）：
  `test/workbenchTrimThreeFixes20261016.test.js` 的 **AC-TR3**（新增，含反向哨兵）
* 当时**没点**的三处（留作下一批）：`去填配品销售表单 →` / `打开名录 →` / `去填写 →`

### 第 ② 批 —— PR **#703**（首页入口卡 ＋ 信息查询两张外链卡）

* 位置：`features/common/index.js` ＋ `config/home.js`、`features/query/index.js`、`config/query.js`
* 改前逐字 → 改后逐字：
  * `features/common/index.js`：`<div class="arrow">${escapeHtml(entry.arrow || '进入 →')}</div>`
    → **只有显式给了 `arrow` 才画**；`config/home.js` 两行 `arrow: '进入 →'` **整行删掉**
  * `features/query/index.js`：`cardBody(section, '进入 →')` → **`cardBody(section)`**
* ⚠️ **空 URL 的 `disabled-card`（「链接待配置」）按它自己的语义保留** ✓
  —— 它**不是链接**（`<div class="entry-card disabled-card" aria-disabled="true">`），
  那行是**卡面的如实交代**，不是"快点点我"的提示语 ⇒ 别顺手删 ✗
* **依据（她 2026-10-16 逐字）**：「**虽然我看不到，但是没用，所以也可以删除掉！**」
* 判据：新增 `test/workbenchArrowTrimTwo20261016.test.js`（AC-AR1..AC-AR4）
  ＋ 两条既有判据成对迁移（`workbenchHomeEntries.test.js`、`workbenchTwoTabsAndQueryEntries.test.js`）
* 🔴 当时**没点**的那三处箭头一个字不动（AC-AR4 就是那条范围哨兵）

### 第 ③ 批 —— 本次（`config/domains.js` 的**最后三处**）

* **依据（她 2026-10-16 逐字）**：「**我也没看到，可以删除**」
* 位置：`server/public/workbench/config/domains.js`（三处，行号为动手前 `origin/main` 上核过的）

| # | 子页（`domain/page`） | 卡片标题 | 改前逐字（整行） | `origin/main` 行号 | 改后逐字 |
| --- | --- | --- | --- | --- | --- |
| 1 | `sales` / `sales-accessory` | 配品销售 | `arrow: '去填配品销售表单 →',` | `:133` | **整行删掉** |
| 2 | `purchase` / `purchase-suppliers` | 供应商名录 | `arrow: '打开名录 →',` | `:236` | **整行删掉** |
| 3 | `product` / `product-new` | 货品上新 | `arrow: '去填写 →',` | `:263` | **整行删掉** |

* 三张卡**都是"整张卡就是链接"**（核实证据见下面第四节）：`href` / `icon` / `title` /
  `directJump` **一个字没动** ⇒ **跳转能力零变化** ✓
* 🔴 **没有 `disabled-card` 要留**：核过 domains 这套渲染里**一张空 URL 的卡都没有**
  （`page.cards ∪ page.links` 里 `href` 与 `jumpTo` 皆空的卡 = **0 张**）✓
* 🔴 **没有跨页复用**：这三张卡只出现在 `config/domains.js` 这一份配置里
  （`features/common` / `features/query` 那两套渲染各有自己的卡，本次一个字没碰）✓
* 渲染层 `features/domains/pages.js` **本来就是** #699 改好的"只有显式给了 `arrow` 才画"形状
  ⇒ **本次一行都不用改**（核过：`cardsHtml` 传 `card.arrow`，`cardBody` 按真值判断，
  **没有任何 `|| '… →'` 兜底**）✓

---

## 三、删完之后 `domains.js` 的 `arrow` 集合

```
改前（三批之前）：['去扫码打印 →', '打开标签打印页 →', '去填配品销售表单 →', '打开名录 →', '去填写 →']
第 ① 批后：      ['去填配品销售表单 →', '打开名录 →', '去填写 →']
第 ③ 批后（现在）：[]            ← 空集
```

**逐字结论**：`config/domains.js` 的 domains 这套渲染
（所有 `page.cards ∪ page.links`）里，`arrow` 过滤后 = **`[]`（空数组）**，
且**源码里（去注释后）再没有任何 `arrow:` 键** ✓。

---

## 四、三张卡"是不是整张卡可点"的证据（本次 · 只读核实）

`#699` 那次她要求"**需要你实际核对一下代码**"——本次照做，用的是**真渲染**（把前端模块
复制成 `.mjs` 后 `cardsHtml([card])`），不是读注释：

| 卡片 | 渲染出的锚点（逐字） | 卡体是否在 `<a>` 里 |
| --- | --- | --- |
| 配品销售 | `<a class="entry-card" href="https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnCUHxarWSWhoQRiv6qJeKWh" rel="noopener">` | `icon` ✓ `h3` ✓ 箭头 ✓ **全在里面** |
| 供应商名录 | `<a class="entry-card" href="https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnpZB0eX27B773hsrsyYf3gb" rel="noopener">` | `icon` ✓ `h3` ✓ 箭头 ✓ **全在里面** |
| 货品上新 | `<a class="entry-card" href="https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m" rel="noopener">` | `icon` ✓ `h3` ✓ 箭头 ✓ **全在里面** |

⇒ **三张卡都"整张就是那个链接"** ⇒ 那行箭头没有跳转职责 ⇒ **删** ✓。

**跳转的另一条路照旧**（本次没碰）：三个子页都是 `kind: 'links'` + `directJump: true`
（「点一次就到」），点**子 tab** 也会直接跳（`features/domains/nav.js` 的
`resolveTabClick` / `directJumpUrlForPage`）⇒ 卡片本体可点只是**同一目标的第二入口**。

---

## 五、判据（本次新增 / 迁移）

### 新增：`server/test/workbenchArrowTrimAll20261016.test.js`

| AC | 钉住什么 |
| --- | --- |
| **AC-ATA1** | 三条箭头**全部退场**（配置面 + 渲染面两路）；**旧文案塞回即红**（两路都判，且证明"塞回 ⇒ 渲染面立刻画出那句话"）|
| **AC-ATA2** | 🔴 **跳转能力零变化**：三张卡**仍然整张可点**（`<a class="entry-card" href=… rel="noopener">` 把 icon / 标题包在里面）＋ `href` 仍逐字来自 `config/links.js` ＋ `directJump` 照旧 |
| **AC-ATA3** | 🔴 **范围哨兵**：domains 这套渲染里的 `arrow` 集合 = **空集**；源码里再无 `arrow:` 键；**卡片集合 / 五条 href 逐字不变**（只删了那三行）|
| **AC-ATA4** | **判据没被放宽**：给了 `arrow` ⇒ **照画且逐字**；没给 ⇒ **一行都不画**；🔴 **不许再长出 `|| '… →'` 兜底** |

### 成对迁移（**改前逐字 → 改后逐字 → 依据 = 她 2026-10-16 逐字 · 未删 / 未 skip / 未放宽**）

| 文件 | 判据 | 改前逐字 | 改后逐字 |
| --- | --- | --- | --- |
| `test/workbenchArrowTrimTwo20261016.test.js` | **AC-AR4** | `assert.deepEqual(arrows, ['去填配品销售表单 →','打开名录 →','去填写 →'].sort(), …)`（"逐字仍在"） | `assert.deepEqual(arrows, [], …)`（"必须没有"）+ 源码里三句逐字不在 |
| `test/workbenchTrimThreeFixes20261016.test.js` | **AC-TR3 ⑤** | `assert.deepEqual(allArrows, ['去填配品销售表单 →','去填写 →','打开名录 →'].sort(), …)` | `assert.deepEqual(allArrows, [], …)` |
| `test/workbenchAccessoryTab.test.js` | **AC-D1 ③** | `assert.ok(String(page.cards[0].arrow \|\| '').length > 0, '动作文案来自配置 ✓')` | `assert.equal(page.cards[0].arrow, undefined, …)` |

> ⚠️ 三处都是**变强，不是放宽**：从"**必须有**那句话"翻成"**必须没有**"。
> 跳转能力由各自用例的**其它断言**（`href` / `resolveTabClick` / AppLink / 表单 URL）**完全钉住**，未动 ✗。

---

## 六、证据（本次）

* **两遍全量**（`cd server && rm -rf data && node --test --test-concurrency=1 --test-force-exit $(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)`）：
  **EXIT=0 ×2**，两遍都是 **2861 / pass 2857 / fail 0 / skipped 4**
  （= #703 的 2857 − 0 条被删用例 ＋ 4 条新增用例；两条被迁移的用例是**改断言**、不是删用例）。
* 两遍之间 `git diff | shasum -a 256` **逐字一致**（自证未改代码）：
  `092cfb5f0c3fdbd252183ba309ac8e4a2de9f32d006ea01383e5cfd7ab9fda18`（两遍前后各取一次，四次全同）。
* **变异 ≥2 组真红**（本次做了 **4 组**）＋ 逐个 `cmp` **逐字节还原**：
  1. 把 `去填配品销售表单 →` 那行**塞回配置** ⇒ **5 条真红**
     （AC-D1 / AC-ATA1 / AC-ATA2 / AC-ATA3 / AC-AR4）；
  2. 给渲染层加回兜底 `arrow \|\| '打开 →'` ⇒ **4 条真红**（AC-ATA1 / AC-ATA2 / AC-ATA4 / AC-TR3）；
  3. 让"给了 `arrow` 也不画"（`arrow ?` → `false ?`）⇒ **3 条真红**（AC-ATA1 / AC-ATA4 / AC-TR3）；
  4. 动一张**不相干的卡**（`批量打印` 的 `href`）⇒ **2 条真红**（AC-ATA3 范围哨兵 / AC-TR3）。
* 🔴 **未部署**（业务负责人 2026-10-07 口径：禁止自行部署）。

---

## 七、相关文件

* 配置（唯一来源）：`server/public/workbench/config/domains.js`
* 渲染层：`server/public/workbench/features/domains/pages.js`（`cardsHtml` / `cardBody`）
* 判据：`server/test/workbenchArrowTrimAll20261016.test.js`（本次）
  · `workbenchArrowTrimTwo20261016.test.js` · `workbenchTrimThreeFixes20261016.test.js`
  · `workbenchAccessoryTab.test.js` · `workbenchHomeEntries.test.js`
  · `workbenchTwoTabsAndQueryEntries.test.js`
* 相关记录：`docs/workbench-domains-trim-three-fixes-2026-10-16.md`（#699）
  · `docs/workbench-two-tabs-and-external-query-2026-10-08.md`（信息查询两张外链卡的由来）
