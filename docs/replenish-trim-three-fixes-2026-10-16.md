# 补货（报货）页三处 ＋ 尺码清单「一行 3 组」（业务负责人 2026-10-16 真机截图 + 逐字）

**时间**：2026-10-16（上海时间）· **base**：`aa311cd`（`origin/main`，已 rebase 到最新）
**分支**：`fix/replenish-trim-20261016` · **worktree**：`.local/replenish-trim`
**范围**：`server/src/views/scanPageRenderer.js` ＋ `server/src/config/scanPage.js` ＋ `server/test/**`（＋ 本文件）。
🔴 **未部署、未合并**（她 2026-10-07 口径：禁止自行部署；PR 交 Lead）。

---

## 一、她点的那三处（逐字 → 改前 / 改后 / 依据）

她的原话（逐字，2026-10-16 真机截图 · **补货（报货）tab** · 货品 `832-500`）：

> 「这个是**报货的页面，还是需要填写金额啊** ✗，以及**不需要的文字说明给删除** ✗，
>   **生成报货订单按钮文字改为补货** ✗」

| # | 位置（改前） | 改前逐字 | 改后逐字 | 依据 |
|---|---|---|---|---|
| ① | `views/scanPageRenderer.js` `replenishFormHtml` 里那一行 `${purchaseAmountRowHtml(write)}` | 补货表单**无条件**画出「整单金额（必填）」那个输入框 | `${rp.amountRow ? purchaseAmountRowHtml(write) : ''}` —— **按配置**决定画不画；缺省 **false** ⇒ **页面上不再有那个框** | 她逐字「这个是报货的页面，**还是需要填写金额啊**」＋（背景）她早定的「**补货不问金额**」 |
| ② | 同上 · `multiItemBlockHtml(write, view)` 那一处（补货调用点） | 说明段（`t.hint`）＋「本单已加的货品」标题（`t.title`）＋空态（`t.empty`）**照旧渲染** | `multiItemBlockHtml(write, view, 'replenish')` ⇒ 走**精简档**（三处都不渲染）；⭐ **已加货品列表本身保留**（有第二个货品时才出现） | 她逐字「**不需要的文字说明给删除**」＋ 她在**退货 tab** 那次弹窗选的是「**说明 + 整块都删**」⇒ 同一形状 |
| ③ | 同上 · 提交按钮 `${escapeHtml(t.replenishButton)}` | `生成报货订单`（来自写侧 `SCAN_WRITE.texts.replenishButton`） | `${escapeHtml(rp.submitLabel)}` = **`补货`**（新配置 `SCAN_PAGE.replenishForm.submitLabel`） | 她逐字「**生成报货订单按钮文字改为补货**」 |

### ① 的关键背景：这是「页面」与「校验」不一致（她看到的正是那个矛盾）

- **校验**那一半**早就改过了**：`SCAN_WRITE.purchaseAmount.requiredByRealm.replenish === false`
  （`config/scanWrite.js:178`，她 2026-10-16「补货不问金额」，#689 已上线）；
- **但页面还在画那个框** ⇒ 她截图里看到的就是**"后端不要求、页面却让你填"** ✗。
- ⇒ 本刀只关"**画不画**"（渲染侧），**不动校验**（`config/scanWrite.js` 是红线 ✗）；
  改完两半**一致**：页面上没有的框，后端也不因为它空而拦 ✓
  （判据 AC-RP2c 就是钉这个"两半一致"的 ✓）。
- ⚠️ 新开关是**显式布尔**（`readFlag`）：清空 / 写 `false` 就**真关掉**，
  **不用** `process.env.X || fallback` 那种"清空关不掉"的形状 ✗。
- 🔴 **退货 / 验收的金额渲染一个字没动**：它们走 `RETURN_FORM` ＋ `returnFormHtml`
  里那一处**无条件**的 `${purchaseAmountRowHtml(write)}` ✓（AC-RP5a 逐字钉着 ✓）。

---

## 二、第四处（⭐ **来源 = Lead ADDENDUM，不是她原话直接落的**）：尺码清单「一行 3 组」

Lead 2026-10-16 06:00 真机截图 + 她的逐字：

> 「我记得我要把**补货的尺码 × 数量，不用一行一个尺码，而是改为一行 3 组尺码 × 数量**这样的模式」

⚠️ **本处与本任务原 brief 的「不许动：尺码行」冲突** —— Lead 已裁决：**ADDENDUM 优先**，
原 brief 那句**作废**（它原本的用意是"防扩大范围 ✗"，而她这次**明确要求**改 ✓）。
🔴 PR / 本页都**单独标注**这一处的来源 = **Lead ADDENDUM**（不等于她原话直接落的那三处）。

### 🔎 根因：这不是"没做"，是一条**静默失效**（2026-10-14 起就没生效过）

补货那个清单的真实渲染色（改前）：

```html
<ul class="purchase-size-grid purchase-sizes" data-view="purchase-sizes" style="--size-cols: 3">
```

两条规则**同时**命中它，且**特异性相同**（都是单类选择器）：

| 规则 | 位置（改前） | 声明 | 效果 |
|---|---|---|---|
| `.purchase-size-grid` | `views/scanPageRenderer.js:249` | `grid-template-columns: repeat(var(--size-cols, 3), minmax(0, 1fr))` | **3 列** ✓（2026-10-14「一行 3 个」那次加的） |
| `.purchase-sizes` | `views/scanPageRenderer.js:256` | `grid-template-columns: minmax(0, 1fr)` | **1 列** ✗（**旧一列版式的残留**，没删） |

⇒ 同特异性下**后出现的那条赢** ⇒ `.purchase-sizes` 在**后面** ⇒ **实际渲染成一行一个** ✗。

**结论**：「一行 3 组」**从 2026-10-14 加进去那天起就没生效过** ✗ —— 她截图里"一行一个尺码"
**不是她记错** ✓；我们那次**改了一个静默失效的东西** ✗（`--size-cols: 3` 与
`SCAN_PAGE.purchaseSizes.columnsPerRow = 3` 一直都在，只是被 CSS 级联顶掉了）。

### 修法（最小且够）

- **把那个已无消费者的旧类 `purchase-sizes` 从补货那两个 `<ul>` 上摘掉**
  （`data-view="purchase-sizes"` **锚保留** ✓ ⇒ 全仓 6+ 处拿它当锚的既有用例不受影响 ✓）；
  ⇒ `.purchase-sizes` 规则随即**没有任何消费者** ⇒ 3 列规则**真正生效** ✓
- 🔴 **`STYLE` 里一行 CSS 文本都没动** ✓ ⇒ 也就不碰
  `test/fixtures/hardcodedChineseWhitelist.json` 里那份整块 CSS 留档 ✓（风险最小 ✓）
- ⚠️ **没选**的另外两条路（Lead 已批准我的判断 ✓）：
  ① 删掉 `.purchase-sizes` 规则；② 改它的列数 —— 两者都要动 `STYLE` 的 CSS 文本，
  会连带那个白名单夹具 ⇒ 面积和风险都更大 ✗。
- 🔴 **功能零变化**：勾选 / 数量输入 / 字段名 / 提交顺序 / 库存数量 / 缺码·现货标记语义
  **一个字都没改** ✗（本刀只动那一个 `class` 属性里的一个旧类名 ✓）——
  钉在 AC-RP8（同一个 POST 载荷字段名与顺序**逐字相同**）＋ AC-RP9（组内元素逐字仍在）✓

### ⚠️ 只报不删（Lead ③ 的口径：他另定 ✓）

跟 `.purchase-sizes` 同源的**三条残留规则**已**没有任何消费者**（旧一列版式的残骸），
本刀**只列出、不删** ✗：

- `.purchase-size`（`views/scanPageRenderer.js:257`）
- `.purchase-size__size`（`:258`）
- `.purchase-size__count`（`:259`）

（它们服务的那个"一行一个 + 右侧数量"的老版式早已不再渲染 —— 全仓没有
`class="purchase-size"` 的单数用法 ✓。删不删由 Lead 另定 ✓。）

---

## 三、判据（**成对迁移** ＋ **反向哨兵** ＋ 探针）

新增 `server/test/replenishTrimThreeFixes.test.js`（**18 条**）：

| AC | 钉什么 | 怎么**真红** |
|---|---|---|
| **AC-RP1** | 补货块里**没有**「整单金额」那一块 | **两处哨兵**：配置里的**字面量**（`整单金额（必填）`）＋ 那个输入的**字段名**（`name="purchase_amount"`）⇒ 塞回即红 ✓ |
| **AC-RP2a** | 校验那一半：`requiredByRealm.replenish === false`（显式布尔）· 退货 / 验收仍 `true` | 改档位 ⇒ 红 ✓ |
| **AC-RP2b** | **行为**：一个空金额真的 POST 进补货 ⇒ **200 + 真进写入口一次** | 返回 400 / 没进写入口 ⇒ 红 ✓ |
| **AC-RP2c** | ⭐ **两半一致**（页面画不画那个框 ⟺ 后端要不要求它） | 两半不一致（她截图里那个矛盾）⇒ 红 ✓ |
| **AC-RP3a/b/c** | 说明段 / 「本单已加的货品」标题 / 「还没有加第二个货品。」**都不渲染** | 三处塞回即红 ✓ |
| **AC-RP3d** | ⭐⭐ **正向**（防"删过头"）：**有第二个货品时列表仍要出现** | 把那行删掉 ⇒ 红 ✓ |
| **AC-RP3e** | 那三句中文**只有一处家**（config）＋ 补货那一处**显式传** `'replenish'` | 改回"不传" ⇒ 红 ✓ |
| **AC-RP4** | 按钮文案 = 「**补货**」（来自配置） | 旧名 `生成报货订单` 塞回 ⇒ 红 ✓ |
| **AC-RP5a** | 🔴 **退货**那一块**逐字未动**（仍要整单金额 ＋ 按钮仍是「退货」＋ 那三处仍不渲染） | 给它也加开关 / 把三处改回去 ⇒ 红 ✓ |
| **AC-RP5b** | 🔴 **销售**那一块逐字未动 | 顺手把多货品块接到销售上 ⇒ 红 ✓ |
| **AC-RP5c** | ⭐ **验收如实标注**：`accept` 已从 `REALMS` 退场 ⇒ **没有"那一块"可比对**，**不假装比对** ✓（旧 `?from=accept` 渲染的就是销售那一块，逐字相同 ✓） | `accept` 若回到 `REALMS` ⇒ 红（提醒补上真正的块比对）✓ |
| **AC-RP7** | ⭐⭐ 补货尺码清单**实际生效的列数 = 3**：**真渲染**取那个 `<ul>` 的**真实类列表** ＋ 在**真 `STYLE`** 里按**源码顺序**解析级联（同特异性取最后一条）⇒ **结构断言**：生效规则 = `.purchase-size-grid`、声明 = `repeat(var(--size-cols, 3), …)`、**每行组数 = 3**、10 组（`36…45`）⇒ 同一行前 3 组 = 36/37/38、最后一行不满 | ⭐ **反向哨兵**：把 `purchase-sizes` 类塞回 ⇒ **红** ✓（这就是那次静默失效的哨兵 ✓） |
| **AC-RP8** | ⭐⭐ **功能零变化**：补货表单控件的**字段名与出现顺序逐字相同**（`action` → `page_build` → `submit_key` → 每个尺码的 `sizes`＋`qty_<码>` → `multi_items`） | 改名 / 调序 / 漏一个尺码 ⇒ 红 ✓ |
| **AC-RP9** | ⭐⭐ 组内元素逐字仍在（尺码字 ＋ 「×」数量 ＋ **现货/缺码**标记 ＋ 每格 ≥44px） | 删掉标记 ⇒ 红 ✓ |
| **AC-RP10** | ⭐ 范围哨兵：**销售 / 退货 / 库存**三个领域的清单**逐字未动**（不许出现 3 列网格类 / `--size-cols` / 补货的格子元素）＋ 源码里 3 列网格类**只该在补货那两处** | 顺手接给别的领域 / 复制到别处 ⇒ 红 ✓ |
| **AC-RP11** | ⭐ **探针**：上面那几个检测器**真能红**（喂坏样本 ⇒ 必须报出来） | 检测器空跑 ⇒ 红 ✓ |

⚠️ **编号映射**（Lead 要求的追加判据原名是 `AC-RP6..RP9`，但 `AC-RP6` 已被本文件的探针占用）：
追加的 `AC-RP6 → 本文件 AC-RP7` · `AC-RP7 → AC-RP8` · `AC-RP8 → AC-RP9` · `AC-RP9 → AC-RP10`；
原来的探针让位改名为 **AC-RP11**（内容与口径**一个字没变** ✗ 只改名 ✓）。

### 成对迁移（**每条都写了「改前逐字 → 改后逐字 → 依据」在用例注释里**；🔴 **无删 / 无 skip / 无放宽**）

| 文件 : 用例 | 改前逐字（断言） | 改后逐字（断言） | 是放宽吗 |
|---|---|---|---|
| `multiItemOrderReturnTrim` **AC-RT6** | 补货块里那三处**必须还在** ＋ 按钮 `生成报货订单` | 那三处**必须没有** ＋ 按钮 = 「补货」 | ✗ **变强**（"必须有"→"必须没有"） |
| `multiItemOrderReturnTrim` **AC-RT6b** | 两处调用 = `['…(write, view)', "…(write, view, 'return')"]` | = `["…(write, view, 'replenish')", "…(write, view, 'return')"]` | ✗ 换指向（缺省档仍逐字不变 ✓） |
| `scanPurchaseAmountRequired` **AC-PA2** | 补货 / 退货**各恰有 1 个**「整单金额」输入 | 退货恰 1 个 · **补货 0 个**（标签也 0） | ✗ **变强**（1 → 0） |
| `scanPurchaseAmountRequired` **AC-PA5 ④** | 「两处都无条件调那个片段」（数到 2） | 定义仍 1 处 ＋ **退货那一处无条件** ＋ **补货那一处按配置** 三条分开钉 | ✗ **变强**（三处精确钉住） |
| `scanPageSixRealms` **AC-6R4** | 补货块含 `生成报货订单` | 含 `配置里的「补货」</button>` ＋ **旧名必须没有** | ✗ **变强** |
| `scanPageRealms` 补货那一段 | `生成采购申请`（来自**写侧夹具**的值）裸词出现在整页 | `配置里的「补货」</button>` 逐字 ＋ **写侧夹具那个旧值绝不许出现在页面上** | ✗ **变强**（裸词 → 逐字 + 反向） |
| `multiItemOrderRender` **AC-MIR1** | 补货那一处**不传 mode** | 补货那一处**必须恰好传 `'replenish'`**（传空 / 传 `'return'` 都红） | ✗ **变强** |
| `multiItemOrderRender` **AC-MIR3** | 顺序串 `${rows}\n${purchaseAmountRowHtml(write)}\n${multiItemBlockHtml(write, view)}\n<button…` | 拆成两条：顺序串（`rows` → **金额行那一格** → 多货品块 → 提交按钮）＋ **那一格按配置** | ✗ 顺序仍逐字钉住（那一格位置留着 ⇒ 开关一开金额行回原位 ✓） |

---

## 四、证据（本地 · **两遍全量**）

- **两遍全量**：`cd server && rm -rf data && node --test --test-concurrency=1 --test-force-exit $(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)`
  —— 两遍都是 **`EXIT=0`**、都是 **`tests 2728 / pass 2724 / fail 0 / skipped 4`** ✓
  （base `aa311cd` ⇒ 本 PR **＋18 条** = 新增的 `replenishTrimThreeFixes.test.js` ✓）。
  ⚠️ `scanMoneyPageTwoStepVerify.test.js` 按 Lead 的既有口径**排除**（与本刀无关 ✓）。
- **两遍之间未改的自证**：跑前 / 两遍之间 / 跑后，`git diff | shasum -a 256` **三次输出完全相同**
  ✓（⚠️ 这里**故意不写那个哈希字面量** —— 本文件本身在 `git diff` 里，写进去就"自己改自己"形成自指 ✗；
  实际取值记在 PR 描述里 ✓）。
- **⭐ 范围哨兵（逐字节）**：用同一套 fixture 分别加载 **base `aa311cd`** 与**本刀**的渲染器，
  对每个领域那一块取 `sha256` 前 16 位：

  | 领域 | base | 本刀 | |
  |---|---|---|---|
  | `sales` | `22b7960ff8e19319` | `22b7960ff8e19319` | **未动** ✓ |
  | `inventory` | `be7f18b5f311a202` | `be7f18b5f311a202` | **未动** ✓ |
  | `purchase_return` | `d0bb80d7ce4db68a` | `d0bb80d7ce4db68a` | **未动** ✓ |
  | `product` | `ed0fc60815b4c823` | `ed0fc60815b4c823` | **未动** ✓ |
  | `replenish` | `b260b5710cbd9e86` | `5599e03ed98309ea` | 改了（本刀的目标 ✓） |
  | `accept` | `NO_BLOCK` | `NO_BLOCK` | 无此领域（已退场 ✓） |

  ⇒ 她这次**没点**的四个领域**逐字节未动** ✓（比"逐字抽查"更强 ✓）。
- **变异 6 组**（**整行 / 整句**替换，不用子串锚点；每组都**真红**后再**逐字节还原**）：

  | 组 | 变异（**整行**） | 结果 | 还原 |
  |---|---|---|---|
  | M1 | `config/scanPage.js`：`amountRow: readFlag(… 'SCAN_PAGE_REPLENISH_AMOUNT_ROW_ENABLED', false)` **整行**换成 `…, true)` | **红**：`AC-RP1` ＋ `AC-RP2c` ✓ `EXIT=1` | `cmp` **逐字节一致** ✓ |
  | M2 | `config/scanPage.js`：`submitLabel: '补货',` **整行**换成 `submitLabel: '生成报货订单',` | **红 4 条**：`AC-RP4` / `AC-RP11` / `AC-RT6` / `AC-6R4` ✓ `EXIT=1` | 同上 ✓ |
  | M3 | `views/scanPageRenderer.js`：`${multiItemBlockHtml(write, view, 'replenish')}` **整行**换成不传 mode | **红 7 条**：`AC-RP3a/3b/3c/3d/3e` / `AC-RT6` / `AC-RT6b` ✓ `EXIT=1` | 同上 ✓ |
  | M4 | 同上：精简档那条 `listHtml` **整行**换成 `''`（= 连列表一起删） | **红 4 条**：`AC-RP3d` / `AC-RP11` / `AC-RT4` / `AC-RT7` ✓ `EXIT=1` | 同上 ✓ |
  | M5 | 同上：`<ul class="purchase-size-grid" data-view="purchase-sizes"…>` **整行**把旧类塞回（`class="purchase-size-grid purchase-sizes"`） | **红**：`AC-RP7` ✓ `EXIT=1` | 同上 ✓ |
  | M6 | `config/scanPage.js`：`columnsPerRow: 3,` **整行**换成 `columnsPerRow: 1,` | **红**：`AC-RP7` ✓ `EXIT=1` | 同上 ✓ |

  ⇒ 六组都是**整行 / 整句**替换（不是子串锚点 ✓）；每组都用 `cmp` 逐字节还原 ⇒ **文件逐字节一致** ✓。
- **CI 四件**：`Analyze (actions)` · `test` · `Analyze (javascript-typescript)` · `CodeQL` —— 见 PR。
- 🔴 **未部署**（她 2026-10-07 的口径）· 🔴 **未合并**（报 Lead 定）。

---

## 五、如实标注（没做 / 不在本刀范围）

1. 🔴 **「验收」没有对应的页面领域**：`accept` **已从 `REALMS` 退场**（她「`/s/accept` 这条路要彻底拆掉」）
   ⇒ Lead 的 AC-RP10 原本写"销售 / 退货 / **验收**清单逐字未动"，但**验收没有可渲染的那一块** ✗
   ⇒ 本刀**如实处理**：范围哨兵覆盖 **销售 / 退货 / 库存**（＋上表的**逐字节**比对覆盖 `product`），
   **验收**则钉它**仍在**的那两处 —— 校验档位 `requiredByRealm.accept === true`（一个字没动 ✗）
   ＋ 旧 `?from=accept` 与 `?from=sales` **渲染出逐字相同的那一块** ✓（AC-RP5c）。
   **不假装比对一个不存在的块** ✗。
2. **三条残留 CSS 规则只报不删**（`.purchase-size` / `__size` / `__count`，见第二节末）✓
3. `config/scanWrite.js` 的 `replenishButton`（`'生成报货订单'`）**一个字没动** ✗（红线）——
   ⚠️ **如实说明**：改完之后**它在本仓已没有任何读取点**（渲染侧改读 `SCAN_PAGE.replenishForm.submitLabel`）。
   本刀**不能**删它（那个文件不在写作用域内 ✗）⇒ 留作历史值；要不要清理由 Lead 另定 ✓
   （另有判据 `AC-RP4` 结尾逐字钉着它**不许被本刀改动** ✓）。
4. `LEAD-ADDENDUM.md` / `LEAD-APPROVE.md` 两份 Lead 便条在 worktree 根，**按 Lead 要求不入库** ✗
   （本 PR 只 `git add` 上述显式路径 ✓）。
5. 🔴 **没碰**（红线）：`routes/**` · `config/scanWrite.js` · `services/**` · `scanWriteService.js`。
   补货的**提交行为**（动作名 / 幂等键 / 字段名与顺序 / 库存数量 / 缺码·现货标记）**一个字没改** ✗
   （AC-RP8 / AC-RP9 钉着 ✓）。
