# 「一单多货」接到【销售】领域 —— **只读核对 ＋ 设计取舍 ＋ 判据落点**（2026-10-16）

> 需求（业务负责人 2026-10-16 弹窗选定，逐字）：**「要：销售也接上」**
> 本文只记**只读核出来的事实**、**取舍**与**判据落点**；改动清单见 PR 说明。

---

## 0. 🔴 先说性质（**下一个人别再误判** ✗）

**销售今天就已经有自己的一单多件机制**（只读核过 `main b7ba07e`）：

```
货品页【➕ 还要加一双】   action=add_line    →  writeService.addSaleLine   →  session.sale.lines
货品页【✅ 提交这一单】   action=submit_order →  资金页（一个字都不写业务表 ✗）
资金页【提交整单付款 / 跳过】 payment_pay / payment_skip → **既有 submitSale**（读【全部】sale.lines ✓）
```

- `submitSale` 吃的是**会话里的全部草稿行**，不是"一件"：`services/scanWriteService.js:843 const lines = sale.lines || []`；
- **逐件尺码 / 金额按行落地**：`:852-869`（`resolvedLines`）· `:1066` 起逐行建明细；
- 「少付 ⇒ 自动记未收款」是**整单口径**，天然覆盖 N 件：`:909` `itemsCents = resolvedLines.reduce(…)` ·
  `:1053 if (itemsCents - paidCents > 0) owedCents = …`。

⭐ ⇒ **本刀的性质 = 给【销售货品页】补上那个"再加一个货品"入口 ＋「本单已加的货品」列表** ✓
**不是**新建机制 ✗ · **不是**"销售不支持多件" ✗

---

## 1. Lead 2026-10-16 裁决 = **甲′**（逐字照做）

```
销售的 N 件**进既有的 `session.sale.lines`**（经**既有** `action=add_line` → `writeService.addSaleLine` ✓）
  ⇒ 再**落回今天的资金页**那条路 ⇒ **既有 `submitSale`** ✓
  ⇒ 渲染层：货品页加「＋ 再加一个货品」入口 ＋「本单已加的货品」列表 ✓
  ⇒ `config/multiItemOrder.js` 里加 `chains.sales` **只用来描述这条链的形状**（前缀/上限/文案 ✓）**不参与落库** ✓
🔴 **不要**走 `submitMultiItemOrder` ✗ · **不要**改 `services/multiItemOrderService.js` ✗
🔴 `scanWriteService.js` 一个字不许动 ✗ · 补货/退货**零变化** ✗ · **N=1 逐字不变** ✗ · 券/少付**零变化** ✗
```

**为什么不给销售配引擎写入件（方案乙，已否）**：
- ✗ 与今天的**顺序**（先资金页收钱 ⇒ 再 `submitSale`）直接冲突 ⇒ 钱还没收就先落了货；
- ✗ `services/multiItemOrderService.js:500-501` 的 `resolveWriters` 是**硬编码两个键**
  （`config.chains.replenish.writer` / `config.chains.return.writer`）⇒ 要动那个**不授权**的文件；
- ✗ `scanWriteService.multiItemWriters()` 也**冻结**在那两个键上（`scanWriteService.js` 余量 0）⇒ 同样要改红线文件。

---

## 2. ⭐ 只读核出来的**三条实现约束**（都不是"猜"，都有判据钉着）

### ① 销售那一块**不能**复用 `multiItemBlockHtml`（既有判据会把调用点数成 3 ⇒ 红 ✗）

- `test/multiItemOrderRender.test.js` 的 **AC-MIR1**（`:52-54`）：
  `(rendererSource.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || []).length` **必须 `=== 2`**
  —— 原意是"补货 / 退货**各一处**、少一处就是某一块加不了第二个货品"✓
- ⇒ 销售那一块**必须**落在别处：**`views/scanPageRenderer.js` 的 `saleFormHtml`（`:1063` 起）**——
  那里**本来就有**一颗 `action=add_line` 的 submit（`:1102`）与一张已加货品的表（`:1097 draftLinesHtml`）✓
- ⇒ ⭐ **"形状与补货一致"的可执行判据** = **同一份文案配置**（`config/scanPage.js` 的
  `MULTI_ITEM_RENDER_TEXTS.addButton` / `.title`）＋ **同一个 `data-multi-add` 钩子** ✓
  （**零新增中文** ✓ 文案只有一处定义 ✓）

### ② 🔴 加货那颗**必须是本表单里的 submit**（GET 链接 = 天生带不走她刚填的尺码/金额 ✗）

- 今天补货/退货那块里那颗是 `<a href="…?add=1">`（`scanPageRenderer.js:1357`）—— **GET ⇒ 值必丢** ✗；
- 销售那张表单**已经是 POST**（`:1092` `<form method="post" …>`）⇒ 用它自己的第四颗 submit
  （**既有的** `action=add_line` ✓ `addAnotherButton` 那一颗）⇒ 她填的尺码 / 金额 / 备注**一起到** ✓
- ⚠️ 另一条并行线（`.local/multi-item2` · `feat/multi-item-get-half-20261016`「**表单半**」，
  **未合、未推、当时正在写**）正是把补货/退货那颗 GET 链接改成**同表单第二颗 submit**
  （新增 `addWireEnabled`（默认 `false`）/ `wire.addAction` 等配置）—— 本刀**不依赖**它 ✓（销售走的是既有 `add_line`）。

### ③ ⭐ `chains.sales` 会落进 `multiItemOrderWriters.test.js` 的遍历 ⇒ 需要**成对迁移**

- `test/multiItemOrderWriters.test.js` **AC-RT7b**（`:62-69`）：`for (const chain of Object.keys(cfg.chains))`
  ⇒ `assert.equal(typeof writers[cfg.chains[chain].writer], 'function')`。
- 今天 `chains` 只有 `replenish` / `return`；加 `sales` 之后，`writers[sales.writer]` **必然** `undefined`
  （`multiItemWriters()` 是**冻结件**里的访问器，加不了 `sales` 这一支 ✗）⇒ **那条判据会红** ✗。
- ⇒ 🔴 必须做一次**成对迁移**（本仓的既有机制：改前逐字 → 改后逐字 → 依据 ✓），且**只许更严**：
  - 纯描述链（`persists === false`）**不许**配写入口（反向钉住 ✓）；
  - **落库链集合**钉死 = `{replenish, return}`（多一个就红 ✓）。
- ⚠️ 这与"既有判据一条不许删/skip/放宽"**不冲突**：它是**依据 Lead 甲′ 裁决**的成对迁移，
  **判据集合变大**（不是放宽）✓ —— PR 说明里逐字写「改前 → 改后 → 依据」。

### ④ 🔴 `scanWriteService.js` 冻结（余量 0）

- 既有 `test/scanWriteServiceFrozen.test.js`：`FROZEN_SHA256 = 199551e14c97db74…`（写死 ✓）。
- ⇒ 本刀**一个字都不许动**它 ✓；新判据 AC-SM-F1 与它**核同一个指纹**（两处同时红 = 真的被改了 ✓）。

---

## 3. ⭐ 前置门控（**Lead 明的**：那三个文件有人在写 ✗）

| 分支 / worktree | 结论（2026-10-16 07:00 复核） | 证据 |
| --- | --- | --- |
| `feat/multi-item-get-half-20261016`（`.local/multi-item2` · **表单半**） | **未合、未推、正在写** | `git ls-remote --heads origin feat/multi-item-get-half-20261016` **空**（远端分支不存在 ⇒ 无 PR）· 工作区 `M` ×2 + `??` ×1 · tip `fa483e5` |
| `fix/scan-landing-reset-20261016`（`.local/landing-reset`） | **PR #717 OPEN**（未合） | `gh pr view 717` ⇒ `state=OPEN` |

⇒ 那三个文件（`views/scanPageRenderer.js` / `routes/scanPage.js` / `config/multiItemOrder.js`）
**当时都还被占着** ⇒ 按门控**不碰** ✗。等待期间只做**不占那三个文件**的事：
✅ 只读核清销售那条链（本文）＋ ✅ 先写判据（`test/multiItemOrderSalesChain.test.js`，**test-only** ✓）。

---

## 4. 判据落点（**先写判据** ✓ 她定的流程）

`server/test/multiItemOrderSalesChain.test.js` —— **AC-SM-A…F ＋ 上限**（13 条，全绿；其中 2 条是**待激活闸门**）：

| AC | 内容 | 今天的颜色 |
| --- | --- | --- |
| **AC-SM-A**（＋probe） | 销售货品页有「＋ 再加一个货品」入口 ＋「本单已加的货品」列表（**形状与补货一致**：同一份文案配置 ＋ 同一个 `data-multi-add` 钩子） | ⏳ **待激活**（探针证明检测器**真能红** ✓） |
| **AC-SM-A2** | `chains.sales` 只描述形状：前缀/上限**复用既有配置**、**不参与落库**（`writers.sales` 必须 `undefined`、`writer` 不许指到 `purchase`/`purchaseReturn`） | ⏳ **待激活** |
| **AC-SM-B** / **B2** | 填了首件**尺码 + 金额** ⇒ 点加货 ⇒ 值在 `sale.lines` 里且**逐字没变**；两件**不许串**（A=40/240、B=41/260 一一对应） | ✅ 绿（**能真红**：丢了/串了/换位 ⇒ 红 ✓） |
| **AC-SM-C** / **C2** | 多件 ⇒ 走**既有** `addLine`/`submitSale`，落库的**逐件 货品/尺码/实收金额**绑在同一行上；且**引擎 0 次**（`submitMultiItemOrder` 只有 2 处调用 ✓） | ✅ 绿 |
| **AC-SM-D** | **N=1 ⇒ 老路**（`submit_order` ⇒ 资金页 ⇒ `submitSale`）＋ **券判定参数逐字不变**（`resolveRows([{method:'微信',amount:'240'}])` · `adjustLineAmounts(['240'], 0)`） | ✅ 绿 |
| **AC-SM-E** | 多件（500）少付（300）⇒ **自动记一条未收款 200**（她 2026-10-16 裁的 A ✓；方式留空 ✓） | ✅ 绿 |
| **AC-SM-F1/F2/F3** | 补货 / 退货 / 库存**行为不变**：两个红线文件**逐字节指纹**（`scanWriteService.js` = 既有冻结基线、`multiItemOrderService.js` 记基线）＋ 两条链配置值 + 两处渲染调用 + 两处 `groups.length > 1` 分流 + 现货交付扣库存/预订不碰库存 | ✅ 绿 |
| **AC-SM-LIMIT** | 上限 = `SESSION.maxLines`（**50**，配置 ✓）⇒ 第 51 件**人话拦住 ＋ 零业务表写入**（会话草稿也不多一行 ✓） | ✅ 绿 |

⚠️ 判据**一条都不许删 / skip / 放宽** ✗ —— 要改就写成"改前逐字 → 改后逐字 → 依据"的**成对迁移** ✓

---

## 5. 落地（**本刀** · 依据 = Lead 裁决**甲′**，逐字见判据文件头）

### 5.1 产品代码改了哪三处（**只有两处产品代码** ＋ 两处判据）

| 文件 | 改了什么 | 依据 |
| --- | --- | --- |
| `config/multiItemOrder.js` | 新增 **`chains.sales`**（**纯描述链**）：`orderKeyPrefix = SCAN_WRITE.session.saleKeyPrefix` · `maxLines = SCAN_WRITE.session.maxLines` · `taskIdPrefix/behaviorCode = ''`（销售不落这条链）· `amountRequired: false`（金额挂在**每件实收**上 ✓）· **`persists: false`** ＋ **`writer: ''`**（🔴 不许配写入口） | 她 2026-10-16「**要：销售也接上**」＋ 甲′ |
| `views/scanPageRenderer.js`（`saleFormHtml`） | **本单已有货品**时，那颗既有的 `action=add_line` submit 换成 **「＋ 再加一个货品」＋ `data-multi-add` 钩子**（**同一颗按钮、同一个动作** ⇒ **不新增第二颗同义按钮** ✗）；并渲「本单已加的货品」标题（列表沿用**既有** `draftLinesHtml` ⇒ 每行一个 `line_amount` ✓）。**本单为空 ⇒ 这一屏逐字回到今天**（既有领域判据 AC-W1/AC2/AC5/AC7 一条都不动 ✓） | 同上（"形状与补货一致" = 同一份 `MULTI_ITEM_RENDER_TEXTS` ＋ 同一个钩子 ✓） |
| `test/multiItemOrderWriters.test.js`（**AC-RT7b**） | **成对迁移**：落库链集合**钉死 = {replenish, return}**（原文那句 writer 键判据**逐字保留**）＋ 新增**纯描述链反向钉**（`persists === false` ⇒ 不许有 `writer`、也不许出现在 `multiItemWriters()` 那批里） | `multiItemWriters()` 住在**冻结件** `scanWriteService.js`（余量 0 ⇒ 加不了 `sales` 这一支 ✗） |
| `test/multiItemOrderSalesChain.test.js`（**AC-SM-A / A2**） | **成对迁移（⏳ 待激活 ⇒ ✓ 真判据）**：撤掉那两条"没实现就 `return`"的早退（**5 条既有 assert 一条没删/没松** ⇒ **更严** ✓）。⚠️ 不撤的后果是**静默假绿**：把入口删掉判据照样通过 ✗（= #711 点名清过的那种自足替身闸门） | 本刀就是"接线那一刀" ⇒ 闸门必须变真判据 ✓ |

### 5.2 🔴 没碰的东西（硬红线）

- `services/scanWriteService.js` —— **一个字没动**（AC-SM-F1 用**既有冻结基线**逐字节核 ✓）；
- `services/multiItemOrderService.js` —— **一个字没动**（AC-SM-F1 记的指纹 ✓；Lead 明文不授权 ✗）；
- `routes/scanPage.js` —— **一个字没动**（销售这条链**不新增写入路径**：`submitMultiItemOrder` 仍**只有**补货/退货 2 处调用 ✓ AC-SM-C2；`groups.length > 1` 仍**只有** 2 处 ✓ AC-SM-F2）；
- `config/scanWrite.js` · `routes/workbench.js` · `public/workbench/**` —— 没碰 ✓。

### 5.3 三条口径为什么"没变"（证据 = 判据，不是嘴说）

- **资金页**：销售多货品的提交**照旧**先到资金页（AC-SM-C 断言"到资金页为止 `salesEntry` **零写入**" ✓）；
- **券**：AC-SM-D 用**只记账**的券解析器把 N=1 的参数**逐字**钉住（`resolveRows([{method:'微信',amount:'240'}])` ＋ `adjustLineAmounts(['240'], 0)` ✓）；
- **少付自动记未收款**：AC-SM-E 断言多件（500）少付（300）⇒ 收款明细 = `[200, 300]` 且那条 200 **方式留空** ✓
  （口径在**冻结件** `scanWriteService.js:1047-1053`：`itemsCents` = **全部行累加** ⇒ 天然覆盖 N 件 ✓）。
