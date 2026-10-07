# 工作台首页【常用功能】：把「采购」和「退货」拆成两个独立入口（2026-10-07）

> 业务负责人（逐字）：
> 「另外**常用功能首页就单独出来采购和退货**吧，这样**不需要多点一次**～」

## 〇、现状核查（先读代码，不凭转述）

| 问题 | 核查结论 |
| --- | --- |
| 首页入口清单是配置还是硬编码？ | **硬编码**：`server/public/workbench/features/common/index.js` 里的 `const ENTRIES = [...]`（两条：`采购和退货` → `/workbench/purchase-return.html`；`库存手工调整` → `/workbench/inventory-adjustment.html`）。**没有** `config/` 里的入口清单；`config/links.js` 只管**飞书表单外链**（`PURCHASE_FORMS`，两条：报货 / 退货）。 |
| `purchase-return.html` 是"两个标签页"吗？ | **不是**。它是**一页两张卡**（`features/purchase/links.js` 按 `PURCHASE_FORMS` 渲染两个外链大按钮），没有 tab / 没有 URL 参数。所以「再切一次 tab」的实际代价是**再点一次卡**。 |
| 到飞书表单现在要几下？ | **两下**：首页点「采购和退货」→ 页内点「报货」/「退货」。 |
| 「退货」有两个页吗（采购退货 / 销售退货）？ | **只有一个真入口**：采购退货飞书表单。`features/sales/index.js` 里「退换货管理」是**规划中占位符**（无链接、无接口）。⇒ 本次「退货」= **采购退货**。 |
| 服务端 | 纯静态托管：`app.js` 第 79 行 `app.use('/workbench', express.static(workbenchPath, { index: 'index.html' }))`。**无构建步骤，改文件即生效。** |

## 一、验收标准（**先写，后动手**）

- **AC1 两个独立入口**：常用功能首页出现 **采购 / 退货** 两张**各自独立**的卡（不再是合并的「采购和退货」），顺序 **采购 → 退货 → 库存手工调整**。
- **AC2 点一次直达**：采购卡点一次 → **直接落在采购（报货）飞书表单**；退货卡点一次 → **直接落在采购退货飞书表单**。即 `href` 等于 `config/links.js` 的 `PURCHASE_REQUEST_FORM_URL` / `PURCHASE_RETURN_FORM_URL`，**中间不再经过 `purchase-return.html`**（去掉的正是那一次多余的点击）。
- **AC3 配置先行**：首页入口清单（`id` / `icon` / `title` / `desc` / `href` / `arrow` / 顺序）由配置文件 `config/home.js` 提供，模块只负责画；**表单 URL 的唯一来源仍是 `config/links.js`**（换链接只改那一个文件）。
- **AC4 老链接不坏**：`/workbench/purchase-return.html`（**不带参数**，或带任意查询串 / 哈希）行为**完全不变** —— 仍能打开，仍显示「报货」「退货」两张飞书表单卡。⇒ **默认视图 = 两张都显示**（就是今天的行为，零回归）。
- **AC5 手机端一屏可见**：手机上 **采购 / 退货 并排一行、库存手工调整整行在下**，三个入口在 iPhone 可视区（≈700px）内**不用滚动就能全看到**；每张卡**整卡可点**，高度 ≥44px。
- **AC6 样式复用**：只用既有类（`.panel` / `.quick-entries` / `.entry-card` / `.arrow`），**不新造风格**；`styles/base.css` **一行不动**；样式改动只落在 `features/common/common.css`（「常用功能」自己的样式文件）。
- **AC7 不动后端**：`server/src/**` **一行不动**；不新增 / 不修改任何接口；只动工作台静态资源与前端配置。
- **AC8 测试**：新增 `server/test/workbenchHomeEntries.test.js` —— **真跑仓库里的前端 ESM 模块**（复制成 `.mjs` 只改 import 文件名，逻辑一个字不改），断言渲染出的入口清单（名称、顺序、href、无 `target="_blank"`）；全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**。
- **AC9 两处一致**：一级 tab（`index.html` 的常用功能）与独立页（`common.html`）渲染同一份清单（`createCommonModule` 的 `focused` 分支**不改**）。

## 二、实现方式（一句话）

首页入口清单**抽成配置** `config/home.js`（采购、退货两条的 `href` 直接引用 `config/links.js` 的两个表单 URL），
`features/common/index.js` 改为**按配置渲染**；手机上用 `common.css` 让「采购 / 退货」并排、库存整行。
**`purchase-return.html` 一个字不改**（老链接兼容）。

## 三、改后首页的实际结构 / 按钮文案（逐字）

```
常用功能
日常最常用的入口；点卡片直接去填写或操作

┌───────────────────────┐ ┌───────────────────────┐
│ 🛒                    │ │ ↩️                    │
│ 采购                  │ │ 退货                  │
│ 供应商报货——点一下     │ │ 把货退给供应商——       │
│ 直接打开飞书表单       │ │ 点一下直接打开飞书表单  │
│ 去填写 →              │ │ 去填写 →              │
└───────────────────────┘ └───────────────────────┘
┌─────────────────────────────────────────────────┐
│ 🧮                                              │
│ 库存手工调整                                     │
│ 盘点调整（改数量，盘多了加、盘少了减）· 换季调整   │
│ （门盒/样品 ↔ 仓库，数量不变）                    │
│ 进入 →                                          │
└─────────────────────────────────────────────────┘
```

两张卡的目标（`href`）—— **点一次就到**，中间没有中转页：

| 卡片 | href |
| --- | --- |
| 采购 | `https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc`（采购报货表单） |
| 退货 | `https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnjsqt4D5URseSSXgecYlqGd`（采购退货表单） |
| 库存手工调整 | `/workbench/inventory-adjustment.html` |

## 四、逐条对照（**验收标准 vs 实测**）

| # | 验收标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| AC1 | 采购 / 退货 两张独立卡，顺序 采购 → 退货 → 库存手工调整 | ✅ | `server/test/workbenchHomeEntries.test.js` 用例 1（`assert.deepEqual(titles, ['采购','退货','库存手工调整'])`）；真浏览器 DOM dump |
| AC2 | 各点一次**直达**飞书表单，不再经过 `purchase-return.html` | ✅ | 用例 1：`href === links.PURCHASE_REQUEST_FORM_URL / PURCHASE_RETURN_FORM_URL`，且 `!cards.some(href.includes('purchase-return.html'))` |
| AC3 | 入口清单配置化，表单 URL 单一来源 `links.js` | ✅ | 新增 `config/home.js`（`COMMON_ENTRIES`）；用例 2：渲染结果与配置逐条一致；`home.js` 只**引用** `links.js`，不复制 URL |
| AC4 | 老链接 `purchase-return.html`（不带参数）不坏 | ✅ | 该文件 **git diff 为空**；用例 4 真跑 `createPurchaseLinksModule()`，两张卡仍是 `[采购报货表单, 采购退货表单]`、标题仍是 `['报货','退货']`；390×844 截图与改前一致 |
| AC5 | 手机端一屏内三个入口全可见 | ✅ | 390×844（+2x DPR）截图：`common.html` 内容止于 ≈710/844，`index.html` 的「常用功能」tab 止于 ≈735/844 —— 都不用滚动 |
| AC6 | 复用既有样式，`base.css` 一行不动 | ✅ | `git diff -- server/public/workbench/styles/` 为空；`common.css` 只把「两个入口两列」改成「手机上采购/退货并排、库存整行」（`entries-two` → `entries-pair` + `entry-wide`） |
| AC7 | 不动后端 / 接口 | ✅ | `git diff -- server/src/` **为空**；改动只有 `public/workbench/**` + `docs/` + 一个前端测试 |
| AC8 | 测试 + 全量 2 次 fail=0 | ✅ | 新测试 5/5 过；全量 `node --test --test-concurrency=1` 两次均 **1145 pass / 0 fail** |
| AC9 | 一级 tab 与独立页同一份清单 | ✅ | 用例 5：`focused:true` 与缺省渲染出的卡片清单 `deepEqual` |

## 五、直达方式与老链接兼容（结论）

- **直达方式**：**不用 URL 参数 / 哈希**。核查过 `purchase-return.html` **不是"一个 html 两个 tab"**，
  而是**一页两张卡**（没有 tab、没有参数解析）—— 所以"用 `?tab=` 落在对应视图"这条前提不成立。
  真正少一次点击的做法是**首页卡片的 `href` 直接等于飞书表单 URL**：点一次 = 到表单，一跳到位。
- **老链接兼容结论**：`/workbench/purchase-return.html` —— **带不带参数都一样**：
  页面照常打开，**默认视图 = 「报货」「退货」两张表单卡都显示**（与改动前逐字一致）。
  本次**没有给这个页面加任何参数处理**，所以不存在"某个参数组合落错视图"的风险。
- 想改回"先回工作台内页"只改 `config/home.js` 里那一行的 `href`，模块不用动。

## 六、手机端怎么保证的

- **采购 / 退货并排一行**（2 列），**库存手工调整整行**（`entry-wide` → `grid-column: 1 / -1`），
  只在 `@media (max-width: 760px)` 生效；桌面端走 `base.css` 默认的三列布局。
- 卡片沿用既有 `.entry-card`（`padding: 18px`、整卡 `<a>` 可点），高度远超 44px 触控下限。
- 外链**同窗口跳转**（不加 `target="_blank"`）+ `rel="noopener"`：手机 / 飞书内置浏览器里体验最好。

## 七、不确定 / 待她确认

1. **「退货」= 采购退货**（退给供应商的表单），**不是销售退货**。
   核查：工作台里**只有**这一个真退货入口；`features/sales/index.js` 的「退换货管理」是**规划中占位符**
   （无链接、无接口）。结合她当时在测采购链路，判定为采购退货 —— **若她要的是销售退货，请指出**。
2. **采购卡的标题逐字用「采购」**（她的原话「单独出来采购和退货」）。
   那张表单的**正式名是「采购报货」**（2026-10-06 从「采购申请」改名）。
   若她更想看到「采购报货」/「报货」，改 `config/home.js` 一行即可（已完成配置化）。

