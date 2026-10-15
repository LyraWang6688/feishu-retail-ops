# 补货不问金额 ＋ 「实收金额（可不填）」文案对齐 —— 只读盘点与改动计划（2026-10-16）

> 本文件**只做只读盘点**（一行代码都没改 ✓，凡我这次动过的文件都列在文末「本文件不动什么」里 ✓）。
> 目的是把两件 P1 的**改动清单 / 判据草案 / 迁移清单**钉死，好让**持有那些文件的人**一次改对 ✓。

## 0. 她的口径（逐字，别改写 ✗）

```
① 「补货不问金额」（退货 + 验收仍要金额 ✓）
② 销售那行标签现在写着「实收金额（可不填）」✗ —— 与她"每一双都要填"冲突
   ⇒ 文案与校验必须一致 ✓
```

## 1. 【补货不问金额】只读盘点

### 1.1 闸门只有一处定义（两个 helper）

| 位置 | 内容 |
|---|---|
| `server/src/routes/scanPage.js:599` | `const purchaseAmountMissing = (body) => { if (writeConfig.purchaseAmount?.required === false) return false; return String(body?.[writeConfig.fields.purchaseAmount] ?? '').trim() === ''; }` |
| `server/src/routes/scanPage.js:617` | `const purchaseAmountInvalid = (body) => { … raw === '' ⇒ false（空的那条由上面那道管 ✓）; return !Number.isFinite(Number(raw)); }` |
| `server/src/routes/scanPage.js:625` | `purchaseAmountInvalidPage(...)`（**不是数字**也当场拦 ✓ 400 + 人话 ✓） |

⇒ ⭐ **唯一的开关键是配置**：`server/src/config/scanWrite.js:135-140` 的 `PURCHASE_AMOUNT`
```js
const PURCHASE_AMOUNT = Object.freeze({
  required: readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED', true),   // ← 默认【必填】
  field: readString(process.env, 'SCAN_PURCHASE_AMOUNT_FIELD', 'purchase_amount'),
});
```

### 1.2 调用点（**两处**，就是"共用"的证据）

| 位置 | 属于哪条链路 | 调用 |
|---|---|---|
| `routes/scanPage.js:2015-2016` | **补货**（`actions.replenish` 那一支） | `purchaseAmountMissing` ＋ `purchaseAmountInvalid` |
| `routes/scanPage.js:2063-2064` | **退货**（`action === actions.purchaseReturn`，`:2052`） | 同上，**同一个 helper、同一个字段** |
| 验收（`acceptFinish` 那一支） | **没有**金额闸门 ✓（本次只读未发现 ✓） |

⇒ 🔴 **关键结论：补货与退货共用同一道闸门 ＋ 同一个配置键** ✗
（旁证：`config/scanWrite.js:179` 注释「补货 / 退货**共用同一个 `name`**」；
`services/purchaseReturnService.js:169-171` 记着她 **2026-10-14 晚逐字**「**退货整单金额（必填），与补货同一套配置**」✓）

⇒ ⇒ ⭐ **所以「补货不问金额」不能靠把 `SCAN_PURCHASE_AMOUNT_REQUIRED=false` 关掉** ✗
—— 那会把**退货也一起放开** ✗，直接违背她 2026-10-14 那句 ✓

### 1.3 改动清单（建议，**配置先行** ✓）

| # | 文件:行 | 改什么 | 一行说明 |
|---|---|---|---|
| A1 | `config/scanWrite.js:135-140`（`PURCHASE_AMOUNT`） | 由**单一 `required`** 改成**按链路分档**（例：`requiredByRealm: { replenish: false, return: true, accept: true }`，并**保留** `required` 作为兜底/兼容键 ✗ 不改名） | 一个键换值就切换"哪条链路要求金额"，**不改逻辑** ✓（配置先行 ✓） |
| A2 | `routes/scanPage.js:599` / `:617` | helper 加一个"当前链路"入参（`realm` 已在作用域 ✓），按 A1 的分档判断 | 补货调用点传 `replenish`、退货传 `return` ⇒ **只对补货放开** ✓ |
| A3 | `routes/scanPage.js:2015-2016` | 传 `replenish` | 补货那一支：分档为 `false` ⇒ 不拦 ✓ |
| A4 | `routes/scanPage.js:2063-2064` | 传 `return` | 退货那一支：分档为 `true` ⇒ **行为一个字不变** ✓ |
| A5 | `services/scanWriteService.js` | **一个字都不改** ✗ | 写库那段（`draft.order_amount`）由退货链路在用 ✓ 补货本来就**不写金额**（`config/multiItemOrder.js:87` 逐字记着「**补货不写金额**（她 2026-10-15 已裁）」✓） |
| A6 | `views/scanPageRenderer.js:1199`（`purchaseAmountRowHtml`） | 补货那一屏**不再渲染**这个输入（或渲染成"不要求"的形态） | 只读发现：该片段**补货 / 退货共用**（`:1192-1195` 注释逐字）⇒ 必须**按链路**决定渲染 ✓ 别把退货那个框一起删 ✗ |

⚠️ **A6 的注意**：`purchaseAmountRowHtml` 是**共用片段**（退货也在用 ✓）⇒ 只能"按链路决定是否渲染"，不能整段删 ✗。

## 2. 【「实收金额（可不填）」文案对齐】只读盘点

### 2.1 文案在哪

| 位置 | 逐字 |
|---|---|
| `config/scanWrite.js:498` | `amountLabel: '实收金额（可不填）'` |
| `config/scanWrite.js:499` | `amountPlaceholder: '留空按货品单价'` |
| `config/scanWrite.js:530` | `accessoryAmountLabel: '配品实收金额（可不填）'` |

### 2.2 校验"真实"是什么（**三条一起看才准**）

1. **路由层闸门**（她在真机上看到的那一句）：
   `routes/scanPage.js:1771` `if (writeConfig.lineAmountRequired !== false && lineAmounts.some((v) => String(v ?? '').trim() === ''))`
   ⇒ **带着的份里有空项 ⇒ 400 + 资金页 + 人话**
   （人话逐字：`config/scanWrite.js:512` `lineAmountRequiredNote: '每一双都要填「实收金额」（那是和客户商定好的价格），填好再提交。'` ✓）
2. **写服务层**：`services/scanWriteService.js:874-880` 的墓碑注释逐字记着
   「每件实收**不再兜底读「单价」**（业务负责人 2026-10-11 选"方案甲"）…留空 ⇒ **那一列就留空**」
   ⇒ ⭐ **「留空按货品单价」这条兜底已退场** ✗（她 2026-10-16 才又提"需要这个功能"，属**另一刀**）
3. **她的最新口径**（2026-10-16）：「**每一件的实收金额没有提交，是没办法跳转到资金页的**」
   ＋「如果**留空的话，就按照货品单价**」

⇒ ⇒ 🔴 **两处不一致（都要修）**：
- `amountLabel` 的「（**可不填**）」**与闸门冲突** ✗（闸门是"带着的份里不许有空项" ✓）
- `amountPlaceholder` 的「**留空按货品单价**」**与现状冲突** ✗（兜底已退场 ⇒ 留空**不会**按单价 ⇒ 现在这句是**假承诺** ✓）

### 2.3 建议文案（与校验一致 ✓，具体措辞请她/Lead 定 ✗）

| 键 | 现状逐字 | 建议（**与校验一致**） |
|---|---|---|
| `amountLabel` | `实收金额（可不填）` | `每件实收金额`（**去掉"可不填"** ✓） |
| `amountPlaceholder` | `留空按货品单价` | ⚠️ **取决于第二刀**：兜底恢复 ⇒ 保留；**不恢复** ⇒ 改成「请填这一件的实收金额」✗ 不许留假承诺 ✓ |
| `accessoryAmountLabel` | `配品实收金额（可不填）` | 同上，去掉"可不填" ✓ |

## 3. 判据草案（每条"能真红" ✓）

> 建议**新开** `server/test/purchaseAmountByRealm.test.js`（别把 `scanPurchaseAmountRequired.test.js` 撑大 ✗，
> 但那份里的判据要按 §4 **逐条迁移** ✓）

| 判据 | 钉什么 | 怎么真红 |
|---|---|---|
| **AC-PA1** | **补货**：不填整单金额 ⇒ **照样能提交**（200 + 采购申请落库 ✓ 不拦） | 把分档改回 `required: true` ⇒ 红 ✓ |
| **AC-PA2** | **补货**：金额填了**不是数字**（如 `abc`）⇒ ⚠️ 按分档"不要求" ⇒ **也不该拦**（**要她/Lead 定**：不要求就别校验 ✓） | 同上 |
| **AC-PA3** | **退货**：不填整单金额 ⇒ **拦住 + 人话 + 零写入** ✓ | 把退货分档改成 `false` ⇒ 红 ✓ |
| **AC-PA4** | **退货**：填了非数字 ⇒ 拦住 + 人话 ✓（既有 `purchaseAmountInvalid` 行为不变 ✓） | 删掉那道判定 ⇒ 红 ✓ |
| **AC-PA5** | **验收**：本来就没金额闸门 ⇒ **不受本次改动影响**（回归哨兵 ✓） | 给分档加"验收要求金额"并让它生效 ⇒ 红 ✓ |
| **AC-PA6** | **配置先行**：分档全在 config（源码里不许出现链路名字面量当判据 ✗） | 把 `replenish` 逻辑写死在 `routes/**` ⇒ 红 ✓ |
| **AC-LB1** | 销售那行标签**不含「可不填」**（配品同 ✓） | 把「（可不填）」塞回 ⇒ 红 ✓ |
| **AC-LB2** | 标签/占位**与闸门口径一致**：当 `lineAmountRequired !== false` 时，占位**不得**承诺"留空按单价" ✗（除非兜底那一刀已恢复 ✓） | 把 `留空按货品单价` 塞回 ⇒ 红 ✓ |
| **AC-LB3** | 源码哨兵：`config/scanWrite.js` 里不许再出现旧列名字面量（既有 AC-11 同款 ✓ 别重复造 ✗ —— 直接复用 `scanSaleTwoLayerMoney.test.js:1227` 那条 ✓） | — |

## 4. 要迁移的既有判据清单（**逐条"改前逐字 → 改后逐字 → 依据"** ✓ 不许删/skip ✗）

| 文件 | 为什么会被牵动 |
|---|---|
| `server/test/scanPurchaseAmountRequired.test.js` | 全篇假定"补货必填" ⇒ 按 AC-PA1/AC-PA3 **分档**后必须逐条改写（改前逐字 → 改后逐字 → 依据 = 她这句「补货不问金额」） |
| `server/test/multiItemOrderEntry.test.js` · `multiItemOrderStep1.test.js` | 补货那一屏的形态（含金额框）⇒ 若 A6 按链路改渲染，这里的断言要跟着迁 ✓ |
| `server/test/returnBlockFirstScreen.test.js` | 退货首屏 ⇒ **应保持不变** ✓（拿来当"没伤到退货"的反向哨兵 ✓） |
| `server/test/scanPageWrite.test.js`（AC-E2E-16） | 标题逐字写着「每件实收旁边写明『**可以留空**』」⇒ 与 §2.3 改文案**直接冲突** ⇒ 必须迁移 ✓（改前逐字 → 改后逐字 → 依据 = 她 2026-10-16「每一双都要填」） |
| `server/test/scanSaleTwoLayerMoney.test.js:1227`（AC-11） | 不许出现旧列名字面量（如「成交金额」）⇒ **改文案时别踩** ✓ |

## 5. 风险 / 需要她或 Lead 裁的点

1. **A6（补货那一屏要不要彻底不渲染金额框）**：她会看到少一个框 ⇒ 属**用户可见变化** ⇒ 建议**先问一句**（"补货这一屏还留金额框吗？"）✓
2. **`amountPlaceholder`**：与**第二刀（留空按单价兜底）**耦合 ⇒ 要么两刀一起定文案，要么**先只去掉「可不填」**、占位暂不动 ✗（免得又出现"假承诺"✓）
3. **AC-PA2（补货填了非数字）**：她的口径只说"不问金额" ⇒ "不问"是否也包括"不校验格式" ⇒ 需要一句确认 ✓

## 6. 本文件不动什么（写作用域，避免撞车 ✗）

- `server/src/routes/scanPage.js` · `server/src/views/scanPageRenderer.js` · `server/src/config/scanWrite.js`
  ⇒ **本次只读** ✓；实施时必须由**持有者**（P1 那条线）来做 ✓
- `server/src/services/scanWriteService.js` ⇒ **一个字都不改**（余量 0 行 ✓）
- 本 PR **只加这一个文档** ✓（不含任何代码/测试改动 ✓）
