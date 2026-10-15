# 工作台 · 货品（domains 页）三处改动（业务负责人 2026-10-16 截图 + 亲口逐字）

**时间**：2026-10-16（上海时间）· **base**：`3267965`（`origin/main`）· **分支**：`test/wb-trim-20261016`
**范围**：`server/public/workbench/**`（工作台静态资源）＋ 判据。🔴 **未部署、未合并**。

---

## 一、她点的三处（逐字 → 改前 / 改后 / 依据）

| # | 位置（改前行号 = base `3267965`） | 改前逐字 | 改后逐字 | 依据 |
|---|---|---|---|---|
| ① | `public/workbench/config/domains.js:287`（`<input name="number">` 的 `placeholder`） | `'编号（货号\|颜色\|类别）或货号，例如 XHB8095'` | `'输入货号，例如 XHB8095'` | 她 2026-10-16 工作台 · 货品（domains 页）截图 + 逐字（**只换这一句**：⚠️ 标题与下拉选项文字不动） |
| ② | `public/workbench/config/numberPicker.js:52` 的 `texts.idle` → 由 `features/labels/number-picker.js` 的 `statusHost` 写进 `<div class="number-picker-status" data-view="number-status" role="status" aria-live="polite">` | `'输入编号 / 货号，我就列出匹配的编号（也可以直接手输完整编号）'` | `''`（**零请求时一个字符都不写**） | 她 2026-10-16 截图 + 逐字：「**那段文字说明删掉**」——这一格是**状态区**，只装真实状态 |
| ③ | `public/workbench/config/domains.js:301` / `:307` 两行 `arrow` | `arrow: '去扫码打印 →'` / `arrow: '打开标签打印页 →'` | **两行整行删掉** | 她 2026-10-16 逐字：「**是否就是多余的，点开入口卡片就可以实现跳转吧，需要你实际核对一下代码**」＋ 下面的**只读核实结论** |

⚠️ **明确不动**（她的边界）：字段标题（`fieldLabel: '编号 / 货号'`）· 下拉选项文字
（`texts.optionNoStock: '还没入库'` / `texts.optionUnknown: '入库情况未确认'` / `aria.listLabel`）·
两颗入口卡的 `icon` / `title` / `href` / `targetTemplate` / `buttonLabel` / `numberPicker` 开关。

---

## 二、⭐ ③ 的核实结论：**那两行箭头确实是多余的**（卡片本体自己就能跳）

**她让我"实际核对一下代码" ⇒ 只读核，证据两处：**

1. `public/workbench/features/domains/pages.js` 的 `cardsHtml`（改前 `:45–:51`）：
   配了 **`href`** 的卡渲染成
   ```html
   <a class="entry-card" href="…" rel="noopener"> …icon / <h3>标题</h3> / <div class="arrow"> … </a>
   ```
   ⇒ **整张卡就是那个链接**（卡体全在这个 `<a>` 里面），点卡片任意一处都会跳；
   `jumpTo` 那种则渲染成整张可点的 `<button class="entry-card card-button" data-jump="…">`。
2. `public/workbench/features/domains/pages.js` 的 `cardBody`（改前 `:35–:38`）：
   箭头就是卡体里的最后一行 `<div class="arrow">` —— 它**没有任何跳转职责**，
   只是一句"快点点我"的动作提示语。
3. 样式侧佐证：`workbenchMobileVisual.test.js:114` 钉着 `base.css` 的
   `.entry-card { display: flex; … }`（**入口卡片整块可点**）。

⇒ **结论：卡片本体已能跳 ⇒ 那两行箭头是多余的 ⇒ 删掉** ✓
（`workbenchFourTabs.test.js` AC2e 仍逐字钉着两颗 `href`，证明**跳转能力零变化**。）

### 实现方式（为什么动了渲染层 4 行）

`cardsHtml` 原来给 `arrow` 配了缺省回落（`card.arrow || '打开 →'` / `|| '进入 →'`）——
**只删配置里那两行 ⇒ 那一行会变成「进入 →」，等于没删** ✗。
⇒ 改成**只有配置里显式给了 `arrow` 才画那一行**（`cardBody` 里 `arrow ? … : ''`），
再把那两行配置删掉。**其余三条箭头（`去填配品销售表单 →` / `打开名录 →` / `去填写 →`）逐字不动** ✓
（本任务范围只有她点的那两行；那三条卡**同样是整张可点的 `<a>`** ⇒ 若她哪天也想去掉，
是**同一个改法、同一句依据**，但**本次不动**）。

### ⚠️ 同形状、本次不动的两处（如实标注，**不是**本次范围）

- `public/workbench/features/query/index.js:78`（「信息查询」两张外链卡）与
  `public/workbench/features/common/index.js:45`（首页入口卡）**各自有独立的一套** `cardBody` /
  缺省箭头（`'进入 →'`）—— 它们**不经过** `features/domains/pages.js` ⇒ 本次**一个字没改** ✓；
  `workbenchTwoTabsAndQueryEntries.test.js` 里 `arrow === '进入 →'` 那几条判据**逐字仍绿** ✓。

---

## 三、🔴 扫码页那处**同名文案**：不在本次范围（**只报不改**）

- `src/views/scanPageRealm.js:158` 的 `labelSingleButton: '打开标签打印页 →'` 是**扫码页（realm）**
  的一颗按钮 —— 她这次说的是**工作台**的 domains 页 ⇒ **本次一个字都没碰** ✓。
- 它同时也是 `test/fixtures/hardcodedChineseWhitelist.json` 里 `views/scanPageRealm.js` 那一档的
  存量债条目 —— ⚠️ **别把它当成工作台这处**、别顺手删 ✓。
- **顺手只读多看一眼（只报不改）** —— 逐行读完，结论：**它不属于同一个形状** ✓
  · `src/views/scanPageRenderer.js:603`：`const pageLink = '<a class="btn btn--ghost" href="…" rel="noopener">'
    + REALM_TEXTS.labelSingleButton + '</a>'` ⇒ 那串字是**这颗 `<a>` 自己的标签**
    （它就是那颗按钮、也是那一条链接的**唯一**可点处），**不是**卡片里多出来的
    "卡片已可点、箭头多余"那种**第二行提示语** ✗；
  · 而且它只在**兜底分支**才出现：`:606`（`print` 没接上）与 `:616`（队列明确关掉）
    —— 队列正常时那一块渲染的是**打印队列表单**（`:1578` 才把 `page.print` 递进来）✓。
  ⇒ **不建议**按本次的理由动它 ✓（要动得先把 realm 那一屏"队列可用 / 不可用"两态读清，属另一件活）。

---

## 四、判据（**成对迁移** + **反向哨兵**）

**成对迁移**（每条都写了「改前逐字 → 改后逐字 → 依据」在用例注释里）：

| 文件 : 用例 | 改前逐字（断言） | 改后逐字（断言） |
|---|---|---|
| `test/productNumberPicker.test.js` AC-U1（"输入关键字 ⇒ keyword 传给服务端"） | `assert.match(String(host.elements[STATUS].textContent), /输入编号/, '只把"你输入、我就列"那句提示摆出来');` | `assert.equal(String(host.elements[STATUS].textContent), '', '⭐ 零请求 ⇒ 状态区**一个字都不写**（她那句使用说明已删）');` |
| 同上 AC-U2b 结尾 | `assert.ok(String(NUMBER_PICKER.texts.idle \|\| '').includes('输入编号'), '空关键字的提示语也在配置里');` | `assert.equal(NUMBER_PICKER.texts.idle, '', '⭐ 零请求那一档 = **空串**（那句使用说明配置里也不许再有）✓');` |
| 同上 AC-U7（懒加载） | `assert.ok(String(host.elements[STATUS].textContent).length > 0, '进页面先给一句人话（不白屏）');` | `assert.equal(String(host.elements[STATUS].textContent), '', '⭐ 进页面状态区**一个字都不写**（那句使用说明已删）✓');` |
| 同上 AC-U7（空关键字聚焦那一下） | `assert.match(String(host.elements[STATUS].textContent), /输入编号/, '换成"你输入、我就列"的提示语');` | `assert.equal(String(host.elements[STATUS].textContent), '', '零请求 ⇒ 状态区**一个字都不写**（她那句使用说明已删）');` |
| `test/labelPrintProducts.test.js` AC-F2（**服务端**那一半） | 断言**本身没动**（仍 `deepEqual(empty, { total: 0, truncated: false, numbers: [] })`），只把失败消息里的"前端显示…"改成"前端不再写那句提示语" | —— |

🔴 **不是放宽** ✗：② 的四条全部从「**必须有**那句提示语」翻成「**必须没有**」——是**变强**，不是 skip。

**反向哨兵**（新增 `test/workbenchTrimThreeFixes20261016.test.js`，4 条）：
`AC-TR1` = 旧 placeholder **塞回配置（去注释后）或渲染面就红**；
`AC-TR2` = 旧提示语**塞回两个源码文件就红** ＋ 状态区 `role="status" aria-live="polite"` **没被删**
＋ **真实状态 10 档逐条仍在**（正在读 / 匹配数 / 没找到 / 读不到 / 选中三种）；
`AC-TR3` = 两行旧箭头**塞回配置或渲染面就红** ＋ 卡片仍渲染成 `<a href>`（**整张可点**）
＋ 缺省 `arrow` **不再**补默认文案 ＋ **其余三条箭头逐字还在**（范围哨兵）；
`AC-TR4` = 扫码页那处**逐字不动**（只报不改）。

**变异（≥2 组，真红后再逐字节还原）**

| 组 | 变异（整行 / 整句，不用子串锚点） | 结果 | 还原 |
|---|---|---|---|
| M1 | `config/domains.js`：把 `placeholder: '输入货号，例如 XHB8095',` **整行**换回 `placeholder: '编号（货号\|颜色\|类别）或货号，例如 XHB8095',`（命中恰好 1 次） | `AC-TR1` **红**（旧 placeholder 塞回配置） ✓ `EXIT=1` | `cmp` **逐字节一致** ✓ |
| M2 | `config/numberPicker.js`：把 `idle: '',` **整行**换回 `idle: '输入编号 / 货号，我就列出匹配的编号（也可以直接手输完整编号）',`（命中 1 次） | **4 条红**：新建的 `AC-TR2` ＋**三条已迁移判据同时红**（`AC-U1` / `AC-U2b` / `AC-U7`）✓ `EXIT=1` | 同上 ✓ |
| M3 | `config/domains.js`：在「扫码打印」那张卡的 `href: '/workbench/label-print.html?scan=1',` **整行之后整行插回** `arrow: '去扫码打印 →',` | `AC-TR3` **红**（旧箭头塞回配置 + 渲染面 + 其余三条箭头范围哨兵）✓ `EXIT=1` | 同上 ✓ |

（三组都是**整行 / 整句**替换，不是子串锚点；每组都用 `cmp` 逐字节还原 ⇒ **文件逐字节一致** ✓，
`git diff | shasum -a 256` 每次都回到同一个值；还原后再跑一次相关文件 = **58 / pass 58 / fail 0** ✓。）

---

## 五、② 的**判断**（brief 把"真实状态留不留"交给我定）

- **删**：`idle`（`''`）—— 它是**使用说明 / 提示语**：她**进页面什么都没干**就先看到它，
  正是她截图点名的那段文字 ✗。
- **留**（逐字不动）：`loading`（正在读）· `ready`（**匹配数** = 她点名要留的那类）·
  `empty`（"没找到"）· `failed`（**真实报错**）· `noStock` / `pickedOk` / `picked` / `pickedUnknown`
  （选中之后那一句）。理由：这些只在**真出了那件事**时才出现，是"系统现在怎么了"的如实交代，
  **不是**"这个页面怎么用" ✗。
- ⚠️ `empty` / `failed` 里那半句「（也可以）直接手输」**保留**：它是"这条路还活着"的**出口**，
  不是用法说明；且拉不到 / 没匹配到时**必须在状态区说**，否则就是她最恨的
  「点了没反应 / 死界面」✗（既有 4 条判据就钉着它：`productNumberPicker.test.js` AC-U3 ×3
  ＋ AC-U7 超时那一条，**一条没动**）。
- ⚠️ **状态区那一格没删**：`renderStatus()` 那一行**保留**（挂载时把这一格算清楚 ——
  现在算出来的正好是空串，能把残留清掉）✓。

---

## 六、证据（本地）

- **两遍全量**：`cd server && rm -rf data && node --test --test-concurrency=1 --test-force-exit $(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)`
  —— 两遍都是 **`EXIT=0`**，两遍都是 **`tests 2827 / pass 2823 / fail 0 / skipped 4`**
  （base `3267965` 是 `2823 / 2819 / 0 / 4` ⇒ **+4 = 本 PR 新增的 4 条 AC-TR 判据** ✓）。
- **两遍之间未改的自证**：跑前 / 两遍之间 / 跑后，`git diff | shasum -a 256` **三次输出的哈希完全相同**
  ✓（⚠️ 这里**故意不写那个哈希字面量** —— 本文档本身在 `git diff` 里，写进去就会"自己改自己"形成自指 ✗；
  实际取值记在 PR 与本地日志里 ✓）。
  （新加的两个文件先 `git add -N` ⇒ 也被这个 hash 覆盖 ✓；**这两遍跑的就是本 PR 的最终树** ✓）。
- **变异 3 组**：见上面第四节，三组都**真红**且**逐字节还原** ✓。
- **CI 四件**：`Analyze (actions)` · `test` · `Analyze (javascript-typescript)` · `CodeQL` —— 见 PR。
- 🔴 **未部署**（她 2026-10-07 的口径：禁止自行部署）· 🔴 **未合并**（报 Lead 定）。
