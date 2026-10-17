# 验收进工作台（2026-10-14 业务负责人口径 · **先写 AC 再动手**）

> 本文是这条改动的**验收标准与边界真源**。她 2026-10-14 的口径（逐字）：
> 「**连它一起改造进工作台（变成工作台自己的页面）**」
>
> ⚠️ **诚实声明（Lead 2026-10-14 要求写清）**：这条改造**只搬"能在工作台做的那一半"** ✓；
> 「**扫码**」这一步**物理上仍在扫码页** ✗ —— 见 §三。**`/s/accept` 保留、仍能用，不许删** ✓
> （免得以后有人以为它该删）。

---

## 一、现状（逐行核过，2026-10-14）

| 事实 | 证据 |
| --- | --- |
| 工作台「采购 → 验收」**已经是工作台自己的页**（不是跳扫码页） | `public/workbench/config/domains.js:167` `{ id:'purchase-acceptance', label:'验收', kind:'orders', mode:'purchase' }` |
| 那一页 = 未到货批次排前 + 已到货折叠 + 每卡【验收到货】表单（实际金额 + 验收原话） | `public/workbench/features/orders/index.js` purchase 模式（`loadPurchaseOrders`） |
| ⇒ 落库走**整批一键**：`confirmArrival({ batchNo, actualAmount, acceptanceText, operatorOpenId })` | `src/routes/workbench.js:98` → `POST /api/workbench/purchase/arrivals/confirm` |
| ⭐ **真正跳扫码页的只有一颗按钮** | `public/workbench/features/orders/index.js:378` `<a data-action="scan-arrival" href="/s/accept?batch=…">扫码验收</a>`（URL 常量：`config/orders.js:154` `ARRIVAL_SCAN.pagePath='/s/accept'`） |
| 扫码页那张落地页（列未到货 + 手输批次号）与「连续扫 / 逐双录入」会话 | `src/views/scanPageRenderer.js` `renderAcceptancePage` / 自助页 · `services/scanWriteService.js`（**本刀不碰** ✗） |

## 二、本刀做什么（口径 (a)）

⭐ 把**那颗【扫码验收】按钮**改成**工作台内的一屏**（不再跳 `/s/accept`）：

1. 点【扫码验收】⇒ 打开**工作台内的"验收这一批"屏**（不换页、不跳扫码页 ✓）
2. 屏上给她**今天工作台已经能做的**那两件事：
   - **这一批的明细**（只读：报货批次 + 采购申请各尺码数量）
   - **到货确认**：实际金额 + 验收原话 ⇒【确认到货】⇒ **既有** `POST /api/workbench/purchase/arrivals/confirm`
     （⇒ `confirmArrival` ⇒ 加库存走**既有** `InventoryService.applyPurchase`，**绝不直连表** ✗）
3. 🔴 **逐双扫码录入那一半仍在扫码页**（见 §三）⇒ 屏上保留一条**次级**入口指回 `/s/{编号}?from=accept`
   （`/s/accept` **保留、仍能用** ✓ 只是工作台**不再强制从它进** ✓）

## 三、🔴 硬约束（为什么"扫码"那半搬不进来）

`public/workbench/config/orders.js:150-155` 原文：
> 「⚠️「验收模式」落在**扫码页**（`/s/accept`）：**标签二维码内容就是 `/s/{编号}`**，
>  这是唯一**不用换标签**的做法（**校验扫码也必须走那一页**）。」

⇒ 她**不用换标签** ⇒ 标签上印的就是 `/s/{编号}` ⇒ **"扫码"这一步物理上发生在扫码页** ✗
⇒ 能搬进工作台的是**"到货确认 + 入库"那一半** ✓；"扫码"那半留在 `/s/…` ✓
🔴 **`/s/accept` 不许删**（老链接 / 群话题核对仍在用 ✓）—— **本刀一个字不动它** ✓
   （配置 `ARRIVAL_SCAN` / `config/orders.js` / `routes/scanPage.js` 的验收路由**都保留** ✓
     只把"工作台从它进"这条**入口**退场 ✗）

## 四、验收标准（AC · **先写先红**）

### 工作台侧（本刀）
- **AC-AW1**：工作台「采购 → 验收」页里，**不再有**指向 `/s/accept` 的**主入口**按钮
  （`data-action="scan-arrival"` 原来是 `<a href="/s/accept…">` ⇒ **已退场**）
- **AC-AW1b** ⭐（Lead 2026-10-14 要求：这句要有**可验的断言**，判据不许松 ✗）：
  那一屏的 DOM 里 **没有**指向 `/s/accept` 的**提交/入口链接** ✓，
  而**有**提交到**既有** confirm 接口的表单（`ORDERS_API.arrivalConfirm` ✓）
  ⇒ 源码/DOM 两条断言都可真红（改动前：`features/orders/index.js` 里能 grep 到 `ARRIVAL_SCAN.pagePath` 的用法 ✗）
- **AC-AW2**：点【扫码验收】⇒ **在当前页打开"这一批"的验收屏**（不导航到扫码页）；
  屏上有：批次号 + 未到货/已到货状态 + 明细（只读）
- **AC-AW3**：屏上有**到货确认**表单（实际金额 + 验收原话）⇒ 提交走**既有**
  `POST /api/workbench/purchase/arrivals/confirm`（**不新开接口** ✓ · **不直连表** ✓）
- **AC-AW4**：`/s/accept` **仍能用**（次级入口/老链接照旧）⇒ **不许删**（源码哨兵：常量与路由都还在）
- **AC-AW5**：交互与文案纪律：每颗可点元素 **≥44px** · 点击**即时反馈**（既有 `data-action` 机制 ✓）·
  文案**全部走 `public/workbench/config/*`**（**不写死中文** ✗）
- **AC-AW6**：🔴 `test/workbenchNoManualText.test.js`（**不许有说明书文字**）**保持绿** ✓

### 既有哨兵（**改指向、不放宽** ✗）
- **AC-AW7**：凡"点验收会跳到 `/s/accept`"这类断言（`server/test/workbench*.test.js` 里 `scan-arrival` / `/s/accept` 那几条）
  ⇒ **改指向"工作台内一屏"**，并在注释里写明依据 = 她 2026-10-14 原话「连它一起改造进工作台
  （变成工作台自己的页面）」＋ 本文 §三 的硬约束 ✓
  **不许删 / 不许 skip / 不许 `assert.ok(true)`** ✓

### 回归
- **AC-AW8**：`confirmArrival` 的既有语义（整批一键 + 实际金额 + 验收原话）**一字不动** ✓
- **AC-AW9**：入库路径**只走** `InventoryService.applyPurchase`（源码哨兵：工作台侧没有直连表的写）✓

## 五、写作用域（本刀）

```
✅ server/public/workbench/config/domains.js · public/workbench/features/orders/** ·
   public/workbench/*.css|html（若必须）· server/test/workbench*.test.js · 本文档
🔴 不碰：src/views/scanPageRenderer.js（Lead 在另一分支动它）· routes/scanPage.js ·
   services/scanWriteService.js · config/scanWrite.js · 任何收款/付款口径
```

## 六、她点哪里、会看到什么（一句话）

工作台 →「采购」→「**验收**」→ 在某一批未到货的卡上点【**扫码验收**】⇒ **页面不跳走**，
原地展开**这一批的验收屏**（批次号 + 明细 + 实际金额 + 验收原话 +【确认到货】）⇒ 确认即到货 + 入库；
真要**逐双扫码录入**时，屏上那条次级入口照旧送她去 `/s/{编号}`（标签上那个 URL）✓
