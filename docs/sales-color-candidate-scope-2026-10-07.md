# 颜色候选的范围：现货 / 未付只推「在售」，预付推全部（配置先行 · 第四刀）

> 她的原话（业务负责人 2026-10-07，逐字）：
> 「你可以的思考是对的：**现货和未付是需要看在售的颜色，但是预付是需要看这个货号的颜色，
>  还是要配置先行，要模块化进行设置**～」
>
> 三条：① 现货 / 未付的候选**只推在售**；② 预付推**该货号的全部颜色**（不按在售过滤 ——
> 预付本来就是卖没货的 / 要调货的）；③ 判据**配置先行、模块化**（不许把 `SALE_PREPAID` /
> 「在售」这类判断散落在逻辑里）。

## 1. 配置放在哪、长什么样（⭐ 选 `salesTradeTypePolicy`，不选 `salesColorChoice`）

**范围（推哪些）配在 `server/src/config/salesTradeTypePolicy.js`** —— 与 `productInfo` /
`stock` **同一个按交易类型的冻结注册表**：

```js
const SALES_COLOR_OPTIONS_SCOPE = Object.freeze({
  inStockOnly: 'inStockOnly',   // 只推在售（明确标成不在售的去掉了）
  allColors: 'allColors',       // 不过滤：这个货号的全部颜色都推
});

SALE_CASH:    { productInfo: true,  stock: true,  colorOptionsScope: 'inStockOnly' },
SALE_UNPAID:  { productInfo: true,  stock: true,  colorOptionsScope: 'inStockOnly' },
SALE_PREPAID: { productInfo: true,  stock: false, colorOptionsScope: 'allColors' },
// 兜底（空编码 / 没见过的编码）：{ productInfo: true, stock: true, colorOptionsScope: 'inStockOnly' }
salesColorOptionsScopeFor(tradeTypeCode)  // ← 逻辑层唯一的取用口
```

**为什么放这里**（而不是 `salesColorChoice`）：

1. **同一件事只有一处**：范围是"**按交易类型**的行为"。它和 `productInfo` / `stock` 是同一
   维度的策略，放在同一个对象里 ⇒ 将来加一种交易类型**不可能漏掉**范围这一项（改那个对象时
   就在眼前）；拆到另一个文件就会出现"两个都按交易类型、但要记得两边都改"的漂移。
2. **默认档有地方放**：`SALES_PARSE_POLICY_DEFAULT` 本来就在这个文件里 —— 范围的默认
   （认不出编码 → `inStockOnly`，与 `stock: true` 同一个取向：宁可只推在售）与它天然邻接。
3. `salesColorChoice.js` 的文件头写明了"**只管显示**"；它的键是**文案**（`SALES_COLOR_*_LABEL`），
   不是交易类型。把"按交易类型的范围注册表"塞进去会让那个文件同时管两件事。

**`salesColorChoice.js` 仍然负责这件事的两件"值域 / 文案"**（都属于候选这一块，且它已经是
候选配置的家）：

- `SALES_PRODUCT_STATUS_OFF_SHELF = ['下架']` —— 「货品状态」里**哪些取值算不在售**。
  生产表里改了选项名 → 只改这一处；逻辑里**不出现**「下架」这两个字（也不出现 `=== '预付'`）。
- `SALES_COLOR_SCOPE_EMPTY_TEXT`（env 可覆盖，默认
  「货品信息里 {item_no} 的颜色都下架了，没有在售的颜色可选，请核实～」）+
  `formatColorOptionsScopeEmptyText()` —— 候选被过滤空时回她的那句话（与
  `salesProductRegistration.formatMissingProductText` 同一套占位符写法；**空串 = 用默认**）。

## 2. 过滤实现在哪、为什么零新增请求

- **状态从哪来**：`services/v1ReferenceResolver.js` 的销售多颜色分支（`matchMode: 'sales'`）
  在给候选时**顺手带上**那条记录的「货品状态」：`options[].status`。
  依据是"**谁给候选、谁带状态**"——候选来自「货品信息」，状态就是这张表上的公式列。
- **候选那一层**：`larkMvpService.resolveProductInfoForSale` 把 `status` 原样带进
  `colorOptions`（读不到 → `''`）。
- **过滤**：`larkMvpService.colorOptionsInScope({ options, scope })` → `{ kept, dropped }`
  —— **纯函数**，方法体内没有任何 `gateway` / `listAll`；判据是 `status` **落在配置的
  "不在售"取值域里**。
- **接线**：`processSalesTask` 的明细循环里，A 出候选之后、标「有货 / 无货」之前过滤。
- **零新增远端请求的证据**（`server/test/salesColorOptionsScope.test.js`）：
  · ⑧ 把 `service.gateway` 换成"任何属性访问都抛错"的 Proxy，`colorOptionsInScope` 照常工作；
  · ⑩ 同一份输入、只改「货品状态」造出**丢 0 个 / 丢 1 个 / 全丢**三种情形，
    三者的读表次数**完全一样**（`product: 2` / `liveInventory: 1`，都是录单本来就有的读：
    解析 A + 建档索引 + 实时库存并行预读）。

## 3. 四个边界（我的选择 + 理由）

### ① 只有 1 个颜色且它「下架」⇒ **保持既有行为**（单色直接定下来，不走候选过滤）

理由：候选这一层只在"A 给出**多个**颜色"时才存在（`resolveProduct` 单色直接回 `recordId`）。
她的口径说的是"**候选**推哪些颜色"，单色根本没有候选这一步；"单色下架也要拦"是**另一条口径**，
按 brief 要求**停下报告**、不自行改。
测试 ④ 钉住：单色下架 ⇒ 直接定下来、不摆候选、不因此拦单、不记过滤日志。

### ② 过滤后候选为空 ⇒ **不静默**：`needs_info` + 可配文案，且**不再跑 B**

- 文案进 `missing_fields`（任务落 `needs_info`，不出确认卡片），并且**单独成句**回复她
  （不套"销售信息还缺…请补充后重新发送"那层流程说明 —— 那层话对这件事没有帮助）。
- **不再跑 B**：跑也只会得到两种更差的结果 —— B 从「实时库存」兜底再摆一次候选（把刚过滤掉的
  颜色又捞回来），或回一句"库存里没有…"（那是**症状**不是**原因**）。日志用既有的
  `lark.sales.stock_existence.skipped`，`reason: 'color_options_out_of_scope'` 说明"为什么没查"。
- 测试 ⑤ 用**对抗 fixture**（两个颜色都是下架，但「实时库存」里**还有**这两条记录）证明
  不会被捞回来：候选为空、B 零调用、卡片零张、她收到那句话。

### ③ 「货品状态」读不到（空 / 认不出的取值）⇒ **保留**候选（判据是"明确不在售才去掉"）

理由：状态是**飞书公式**列；读不到（列没配 / 这次没算出来）**不等于下架**。把"没有证据"
当成"负向证据"正是 `AGENTS.md` 第 17 条禁的；而且现货 / 未付在**她选完颜色之后**还会跑 B，
那里会给出"这个尺码到底有没有货"的定论 —— 误留一个卖不了的颜色会被 B 拦住，
误丢一个能卖的颜色却是一条**死路**。
附带好处：候选为空那句话可以说得很准（空 = **每个**候选都被**明确**标成下架）。
测试 ⑦ 钉住：状态空串 ⇒ 候选保留、`kept: 2 / dropped: 0`。

### ④ 过滤只作用于 **A 的候选**（B 兜底那条路不参与）

B 兜底的候选来自「实时库存」，身上**没有**「货品状态」⇒ 无可过滤，行为一个字不改
（测试 ⑨ 钉住）。

## 4. 正向证据日志

```
lark.sales.color_options.filtered {
  task_id, trade_type, trade_type_code, item_no, size,
  scope,                 // inStockOnly | allColors（只有 inStockOnly 才记这条）
  kept, dropped,         // 各几个
  dropped_colors,        // 丢了哪些（颜色名）—— "为什么没给我这个颜色"的直接答案
}
```

- 只在**过滤真的跑过**（`scope === inStockOnly` 且有候选）时记一条；预付不过滤 ⇒ 不记（避免噪音）。
- ⚠️ 写这一刀时踩过一个坑（已被测试 ① 抓住）：**别用 `!kept.includes(option)` 反推 dropped**
  —— `kept` 是**副本**，对象身份永远不相等，`dropped_colors` 会把留下的颜色也列进去。
  所以 `colorOptionsInScope` 直接回 `{ kept, dropped }`。

## 5. 验收标准 + 逐条对照

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 现货 / 未付：明确「下架」的颜色**不出现在候选** | ✅ | 测试 ①②（候选只剩「黑色」，卡片里没有「巧克力」） |
| 2 | 预付：**同样输入**下全部颜色都出现（不按在售过滤） | ✅ | 测试 ③（两个颜色都在，且照旧不标「有货 / 无货」） |
| 3 | 单色（且下架）**保持既有行为** | ✅ | 测试 ④（直接定下来、card 1 张、无过滤日志） |
| 4 | 过滤后为空：**不静默**，给可配文案 + `needs_info` | ✅ | 测试 ⑤（`needs_info`、零卡片、文案含货号）+ `salesColorChoice` 配置单测 |
| 5 | 过滤后为空：**不跑 B**、不把下架色捞回来 | ✅ | 测试 ⑤（B 零调用 + 对抗 fixture + `skipped.reason`） |
| 6 | 认不出的交易类型编码 → 取**最保守**默认 | ✅ | 测试 ⑥（配置层）+ ⑥b（服务层 `trade_type_code=''` → `inStockOnly`） |
| 7 | 过滤**零新增远端请求** | ✅ | 测试 ⑧（爆炸 gateway）+ ⑩（三种情形读表次数相同） |
| 8 | 「有货 / 无货」标注**保持不变**（只给跑 B 的类型标；预付不标） | ✅ | 测试 ①（`available` + 卡片「黑色（有货）」）、③（无 `stock_status`） |
| 9 | 配置先行：逻辑里**没有**中文字面量 / `=== '预付'` | ✅ | `SALES_PRODUCT_STATUS_OFF_SHELF` / `colorOptionsScope` / `salesColorOptionsScopeFor`；`grep` 复核（见 PR） |
| 10 | 正向证据日志（字段齐全） | ✅ | 测试 ①（逐字段 `deepEqual`）+ ⑤（`dropped=2`、两个颜色名） |
| 11 | #227 的「A 定颜色 → 选完才跑 B」结构**一个字没动** | ✅ | 测试 ① 断言"她没选颜色 ⇒ B 零调用"；`select` 之后的 B 由既有用例继续钉住 |
| 12 | 既有断言**不放宽** | ✅ | 只把 fixture 收紧（候选带上生产真有的「货品状态」列、默认档 deepEqual 加上范围）；全量 `node --test --test-concurrency=1` **连跑 2 次** `1096 / pass 1096 / fail 0`（已并入最新 `origin/main` 的合并态） |

## 6. 与第三刀的关系（有意保留的东西）

- 候选仍然**先给她选**、选完才跑 B（`docs/ab-color-first-design-2026-10-07.md`）；
- 候选上的「有货 / 无货」后缀照旧只由**已读进来的**实时库存索引算（`config/salesColorChoice`）；
- 预付选完颜色**仍然不跑 B**（`stock: false` 未动）；
- 交付 / 扣库存 / 入账写入口径**一个字没动**。
