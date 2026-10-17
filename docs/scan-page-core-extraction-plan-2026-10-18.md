# 扫码路由「核心职责」深拆方案（只读依赖清单）

> 状态：**只读盘点**（本文件不改变任何生产代码）。
> 基线：`server/src/routes/scanPage/index.js` = **3,263 行**（main `1c730a54`），
> 前三刀已抽出 `actions.js` / `renderContext.js` / `sessionFlow.js`（合计约 210 行，均为外围助手）。
> 结论承接业务负责人/评审的判断：**"拆分在推进，但核心职责仍集中"** —— 本文件给出下一阶段的施工图。

## 1. 现状：主干仍在同一个 POST 闭包里

`router.post(ROUTE_PATTERNS, uiTapResultMiddleware('scan'), async (req, res) => {` 从 **:1947** 开始，
动作分支与体量（自动统计）：

| 分支 | 起始行 | 行数 | 依赖的工厂级变量 | 写库/服务调用 |
|---|---|---|---|---|
| `payment_pay`（资金处理） | 2224 | **392** | 20 个 | `writeService.submitSale` / `saveDraftLines` |
| `submit_order`（销售提交） | 2616 | **401** | 19 个 | `writeService.submitSale` / `sessions` / `saveDraftLines` |
| `replenish`（补货提交） | 3017 | 105 | 22 个 | `schedulePurchaseWrite`（后台） |
| `purchase_return`（退货提交） | 3122 | 143 | 27 个 | `schedulePurchaseWrite`（后台） |
| 其余小动作（打印/加货/配品/清空） | 2084–2223 | 约 140 | 3–11 个 | `addSaleLine` / `clearDraft` / 打印队列 |

**四个主干分支合计 ≈ 1,041 行**，且都共享同一个闭包作用域（`req/res/view/writeService/config/...`）。
这就是"职责集中"的具体形态：改资金/销售/采购，必须在这一整个大闭包里定位与回归。

## 2. 每个分支依赖的工厂级名字（自动提取，供 ctx 设计）

### 2.1 `payment_pay`（392 行）
`config, successReturnFields, writeConfig, gateway, service, voucherPayments, candidatePaymentMethods,
step2WriteOf, respondSettlementBlock, sendPaymentStep, writeService, sendHuman, realmOfAction,
markRealmUsed, sendSuccess, respondWriteFailure, invalidateInventorySnapshot, openIdOf`
（另有 `body/fields/view/realm/requestId` 等局部量）

### 2.2 `submit_order`（401 行）
`config, successReturnFields, writeConfig, service, renderScan, candidatePaymentMethods, sendPaymentStep,
writeService, buildWriteContext, sendHuman, realmOfAction, markRealmUsed, sendSuccess,
respondWriteFailure, invalidateInventorySnapshot, openIdOf, backTargetFor, lookupInputOf`

### 2.3 `replenish`（105 行）
`config, successReturnFields, writeConfig, service, multiItemOrderConfig, submitMultiItemOrder,
schedulePurchaseWrite, realmOfAction, markRealmUsed, sendSuccess, notFoundPage,
purchaseAmountMissingPage, purchaseAmountMissing, purchaseAmountInvalid, purchaseAmountInvalidPage,
purchaseEntryInvalidPage, respondWriteFailure, invalidateInventorySnapshot`

### 2.4 `purchase_return`（143 行）
在 `replenish` 的基础上另用：`router, sendHuman, badNumberPage, respondFailure, unknownActionFailure`
（与补货高度同形，适合成对搬）

**共性依赖（几乎每个分支都用到）**：`writeConfig`、`config`、`sendSuccess/respondWriteFailure/sendHuman`、
`realmOfAction/markRealmUsed`、`invalidateInventorySnapshot`、`openIdOf`、`scanTargetOf/backTargetFor`。

## 3. 建议的 handler 契约（ctx）

每个 handler 一个模块，只接收**显式 ctx**，不读外部闭包：

```js
// routes/scanPage/handlers/<name>.js
module.exports = async function handleX(ctx) {
  // ctx = {
  //   req, res, requestId, body, fields, view, realm, openId,
  //   config, writeConfig, writeService, gateway, service,
  //   helpers: { sendSuccess, sendHuman, respondWriteFailure, respondSettlementBlock,
  //              notFoundPage, badNumberPage, respondFailure, unknownActionFailure,
  //              purchaseAmountMissing/Invalid/Page, purchaseEntryInvalidPage,
  //              realmOfAction, markRealmUsed, invalidateInventorySnapshot,
  //              openIdOf, scanTargetOf, backTargetFor, lookupInputOf,
  //              successReturnFields, buildWriteContext, candidatePaymentMethods,
  //              sendPaymentStep, step2WriteOf, voucherPayments },
  //   session: { writeService, multiItemOrderConfig, submitMultiItemOrder,
  //              schedulePurchaseWrite, markRealmUsed },
  // }
};
```

- **路由只做分派**：`if (action === ...) return handleX(ctx)`；不再承载业务流程。
- ctx 里**不允许出现"新行为"**：只是把现有闭包变量显式传进去；顺序/日志/文案/303/成功页逐字不变。
- 共享 helper（如 `respondSettlementBlock`、`sendPaymentStep`）继续留在路由层，作为 ctx 成员注入；
  **不强行一起搬**（避免"为拆而拆"引入第二套实现）。

## 4. 施工顺序（从小到大，先证明契约）

| 阶段 | 搬什么 | 预计行数 | 为什么先做 |
|---|---|---|---|
| **P0** | `handlers/purchase.js`：**补货 + 退货成对搬** | ~248 | 两者同形、依赖清单已对齐；先验证 ctx 契约/判据迁移方式 |
| **P1** | `handlers/payment.js`：`payment_pay` | ~392 | 资金处理是最大热点之一；单独模块后可独立回归 |
| **P2** | `handlers/salesSubmit.js`：`submit_order` | ~401 | 与 payment 共享部分 helper，P1 之后依赖已显式化 |

> 与最初"资金→销售→采购"的顺序略有调整：先用较小的采购对验证"ctx + 判据迁移"这套施工方法，风险更低；
> 方法验证后再搬两个 400 行的大分支。

## 5. 每刀的验收标准（硬性）

1. **只搬不改**：调用顺序、日志事件/字段、用户可见文案、HTTP 状态、303 Location、成功页 逐字不变。
2. 全量套件 **Node 24 / Node 20** 全绿；页面**逐字节尺子**（508,287 / 12 页 sha）不变。
3. 既有行为用例**一条不删**；因搬移需要看两处源码的哨兵，按"改前逐字 → 改后逐字 → 依据"成对迁移。
4. 聚合器 `test/support/scanPageSource.js` 同步把新模块并入（否则"按源码文本钉行为"的判据会瞎）。
5. 每刀独立 PR；合并后 `index.js` 行数下降必须如实记录（目标 P2 后 ≤ ~1,800 行）。

## 6. 风险与不做的事

- **不做**：为拆而拆（把 `respondSettlementBlock` 等成熟 helper 再包一层）、引入第二套成功页/文案、改执行顺序。
- **风险**：闭包变量多（20+/分支）、POST 内共享的 `let` 状态（如草稿/金额中间值）需逐条确认能否显式化；
  某些 helper 与 `view`/`session` 强耦合，需通过 ctx 传值而不是重算。
- **回退**：每刀都是独立 PR；若尺子/行为用例出现一字差异，按"回退该刀、保留前序"处理。
