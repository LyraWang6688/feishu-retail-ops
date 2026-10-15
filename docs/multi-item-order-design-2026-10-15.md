# 「一单多货品」设计（单据草稿 + 批量提交 · 共用模块）

> 业务负责人 2026-10-15 晚（**逐字**，置顶）：
> 「不管是对**销售、补货还是退货**，**一单支持多个货品**的是**一个大头**。这个**一定要好好做**，**一定要配置化和模块化**」
>
> 同日她对字段口径的补充（逐字）：
> 「字段主要分两部分：(a) 我们项目中**需要自行写入**到多维表格数据表里的字段；(b) **飞书自带的自动字段**，
>  比如时间、公式字段，以及**跨表的查找引用**」
>
> 🔴 **本文只是设计，不含实现**：不改任何业务代码、不建分支外的任何东西。
> 文中每条结论都带 `文件:行`（基准：`main` = `ead7a3a`），供 Lead 复核与逐条与她核对。
> 写入字段的现状核对表见 `docs/scan-write-fields-audit-2026-10-15.md`（含 Lead #619 补的"时间列类型"结论）。

## 0. TL;DR

1. **一个引擎**（`services/multiItemOrderService.js`）＋ **一份链路配置**（`config/multiItemOrder.js` 里按 `chain` 分块）
   ⇒ 补货单 / 退货单（未来 采购申请单）**共用同一份实现**，两条链路**只差配置** ✓
2. **草稿**沿用既有会话（`scanSessionService`），但**一单一份会话键** `orderKey`（今日 `keyFor` 口径的延伸）
   ⇒ 从根上堵住今天用"指纹"绕开的那个坑（`AC-RK2/RK3`，见 §13）✗
3. **落库不新造写入口**：补货复用 `purchaseWebhookService.publishPurchaseRequest`（`:587`）＋
   退货复用 `purchaseReturnService.createPurchaseReturnService(...).submit`（`:47` / `:118`）；
   幂等仍走 `createOnceByKey`（`infrastructure/idempotencyKey.js:43`）✓
4. **异步**照 `saleWriteBackgroundService` 那一套（`:53` / `:65` / `:136`）—— 先回"批次号已创建"，后台续写；
   失败**如实可见** ✗。

## 1. 现状（单货品）· 代码依据

| 环节 | 现状 | 依据 |
|---|---|---|
| 入口动作 | 一个 POST 端点 + 两个动作：`replenish` / `return_purchase` | `config/scanWrite.js:55`（`ACTIONS`，`replenish:67`、`purchaseReturn:71`）；路由分派 `routes/scanPage.js:1924` / `:1993` |
| 表单载荷 | **单个** `productRecordId` + `number` + `entries[]`（本次勾的尺码/数量） | `routes/scanPage.js:2108-2126`（`replenishSizes` / `returnSizes` 两套字段名）；服务入参 `services/scanWriteService.js:1337`（`submitReplenish`）、`:1504`（`submitPurchaseReturn`） |
| 草稿 | 会话里的 `replenish` / `purchaseReturn` 两个**平行块** | `services/scanSessionService.js:376`（`completeReplenish`）、`:412`（`completePurchaseReturn`） |
| 幂等键 | `keyFor(prefix, sessionId, seq)`；轮次 +1 = 新的一单 | `services/scanSessionService.js:47`、`:137`（`submitKeyFor`） |
| 「换了货号还拿旧键」 | 用**指纹**（货号 + 逐行尺码/数量）区分"重放"与"新提交" | `services/scanWriteService.js:1329`（`replenishFingerprint`）、`test/scanPageWrite.test.js:1273`（`AC-RK2`）、`:1297`（`AC-RK3`） |
| 落库 | 补货：1 批次 + N 条明细（N = 勾了几行）；退货同理 + 扣库存 | `services/purchaseWebhookService.js:1588`（批次 `createOnceByKey`）`/ :1644`（明细 `createOnceByKey`）；`services/purchaseReturnService.js:208` |
| 幂等落点 | 「幂等键」是**真实文本列**（远端回查） | `config/v1BitableSchema.js:379`（`purchaseRequest.idempotencyKey`）、`:434` 段（`purchaseOrderBatch.idempotencyKey`）；`infrastructure/idempotencyKey.js:23`（`listByKey`） |
| 批次号 | `CGD-<上海日期>-<4 位序号>`，规则**已配置化** | `config/purchaseBatchNo.js:6`（格式样例）、`:23`（`prefix`）、`:39`（`recognizedPrefixes`） |
| 尺码规则 | 领域差异**已数据化**（`normal` / `special` / `checkMissingByDefault`） | `config/scanPage.js:763-765`（`REALM_SIZE_BEHAVIOR`：`replenish.checkMissingByDefault:true`）、`config/scanPage.js:516-575`（`SIZE_SEGMENTS` / 可录范围 男 38–48 · 女 34–43） |
| 异步 | **只有销售**有闸门；补货/退货同步 | `config/scanWrite.js:327`（`asyncWrite`）、`:336`（`SCAN_SALE_ASYNC_WRITE_ENABLED`，默认 `true`）；`services/saleWriteBackgroundService.js:53` |

⇒ 现状能跑通，但**三件事被写死了**：① 一次提交只认一个货品；② 两条链各写一套草稿/幂等/落库调用；
③ "换货号用旧键"只能靠指纹补丁。本设计的靶子就是这三件。

## 2. 设计总览：一个引擎 + 一份链路配置

```
            ┌──────────────────────── 共用引擎（本设计新增） ────────────────────────┐
            │  services/multiItemOrderService.js                                      │
            │   ① 草稿读写（单头 + N 货品 × M 行）   ② 校验（全部规则来自 config）      │
            │   ③ 批量落库 + 幂等 + 单号（**只调既有写入件**）                        │
            └───────────────▲───────────────────────────────▲─────────────────────────┘
                            │ chain = 'replenish'            │ chain = 'return'
            ┌───────────────┴───────────────┐  ┌────────────┴────────────────────────┐
            │ config/multiItemOrder.js       │  │ （同一份文件里的另一个 chain 块）    │
            │  · behaviorCode / taskPrefix   │  │  · behaviorCode / taskPrefix        │
            │  · 可补范围 / 尺码规则 / 数量   │  │  · 可退范围（= 实时库存实际有数）   │
            │  · 每单上限 / 文案 / 幂等口径   │  │  · …（同名同义，只换值）            │
            └────────────────────────────────┘  └─────────────────────────────────────┘
                            │                                │
                    purchaseWebhookService            purchaseReturnService
                    .publishPurchaseRequest(:587)     .createPurchaseReturnService(:47).submit(:118)
```

**为什么是"引擎 + chain 配置"**：两条链路**只差**：行为编码、任务前缀/目录、可操作范围的取数口径（补货=她勾、
退货=实时库存实际有数）、落库调用哪个既有件、文案。把这五项放进 `config` 后，引擎里**没有一处 `if (补货) … else …`** ✓
（与她「少写散落的 if-else，优先配置规则和状态驱动」同源）。

## 3. 模块边界（一个模块干三件事）

> 名字沿用仓库既有风格（服务在 `services/`、参数在 `config/`）；**接口是草案**，实现时以评审为准。

```js
// services/multiItemOrderService.js（新增；**只做编排与校验，不碰业务表**）
createMultiItemOrderService({ sessions, config, chains, gateway, purchase, purchaseReturn, logger, now })

// ① 草稿读写
openDraft({ openId, chain, requestId })                  // 没有就建；返回 { orderKey, draft }
addItem({ openId, chain, orderKey, item, requestId })    // item = { productRecordId, number, itemNo, color,
                                                          //          entries:[{ size, quantity }] }
removeItem({ openId, chain, orderKey, productRecordId, requestId })
setEntries({ openId, chain, orderKey, productRecordId, entries, requestId })
readDraft({ openId, chain, orderKey })                    // 渲染用（只读）
// ② 校验（纯函数，便于单测；返回 { ok, code, message, details }）
validateDraft({ draft, chainConfig, stockView })          // §8 的规则表
// ③ 批量落库 + 幂等 + 单号
submitDraft({ openId, chain, orderKey, submitKey, requestId, timing })
      // ⇒ { ok, reused, deferred, orderNo, batchNo, detailCount, background? }
```

**模块不做的事**（保持"一个 service 只干一件事"）：
- 不直连 `gateway.create/update`（**写入只经既有业务件**：`purchaseWebhookService` / `purchaseReturnService` / `inventoryService`）；
- 不解析 HTTP 表单（那是 `routes/scanPage.js` 的事）；
- 不渲染页面（`views/scanPageRenderer.js`）；
- 不认识"飞书表格字段名"（映射仍只有 `config/v1BitableSchema.js` 一处）。

## 4. 草稿：存哪 · 形状 · 会话键口径

### 4.1 存哪
**沿用既有会话**（`services/scanSessionService.js`；落盘 `data/scan_sessions/`，与群聊的 `lark_mvp_tasks/` **隔离**：
`AC-R7`（`test/scanPurchaseReturn.test.js:631`）钉着这一点）。**不新建存储** ✗。

### 4.2 一单一份会话键（今天的 `sessionKey` 口径）
- 现有键形态：`keyFor(prefix, sessionId, seq)`（`scanSessionService.js:47`）⇒ 今天补货/退货是**轮次键**，
  所以才需要 `replenishFingerprint`（`scanWriteService.js:1329`）来区分"同键不同草稿"。
- 新设计：**草稿 id = `orderKey`**，由会话在同一"单据草稿"生命周期内**保持不变**，提交成功后**换一把新的**
  （等价于今天的 `seq+1`，但**绑在草稿上**而不是绑在"轮次"上）：
  ```js
  orderKey = `${chainPrefix}:${sessionId}:${seq}`   // 与 keyFor 同形，前缀仍走 config
  ```
  ⇒ 她连着做**第二单**时，第一单的 `orderKey` 已经轮换 ⇒ **第 2 单不可能被第一单的"假成功"吸收** ✓

### 4.3 草稿形状（单头 + N 货品 × M 行）
```js
// session.orders[orderKey]
{
  chain: 'replenish' | 'return',           // 单据类型（决定用哪块 config）
  open_id,                                 // 她（会话本来就按 open_id 分）
  created_at, updated_at,                   // **本地**时间（业务表时间列照旧交给飞书）
  submit_key: orderKey,                    // 幂等键（本单唯一；提交时原样带回去核对）
  items: [                                 // N 个货品
    {
      product_record_id, number, item_no, color,
      supplier_record_id,                  // 补货出图要（读货品信息）
      entries: [ { size, quantity } ],     // M 行（**同货号同尺码只许一行** ⇒ §8）
    },
  ],
  // 提交后回填（重试接着写同一张单的判据）
  batch_record_id: '', batch_no: '', detail_ids: [], status: 'draft' | 'submitting' | 'submitted' | 'failed',
}
```
- **兼容**：现有 `replenish` / `purchaseReturn` 两个平行块**暂不删除**；新草稿写进 `orders[orderKey]`，
  过渡期两者并存（见 §12 迁移路径）。

## 5. 状态机

```
      openDraft/addItem/setEntries
draft ─────────────────────────────► draft（可反复改；每次改动 refresh updated_at）
  │  submitDraft（空单/重复行/超上限/退货超库存 ⇒ 拦在 draft，人话 + 零写入）
  ▼
submitting ──（同步路径：全部写完）────────────► submitted（orderKey 轮换 = 可开下一单）
  │   │
  │   └─（异步路径：批次号先出）──► submitting（后台续写）
  │                                     ├─ 成功 ⇒ submitted + 记 background_done
  │                                     └─ 失败 ⇒ failed（**如实**：订单一列落「写入失败」+ 工作台「未完成，可点重试」）
  └─ 异常 ⇒ failed（可重试：**同一把 submitKey** ⇒ 接着同一张单写，不重复建单/不重复扣）
```
- 迁移自既有语义：`statuses: { draft, submitted }`（`config/scanWrite.js:226`）+「写入失败」（`salesStatusDimensions` 口径）；
  失败的**可见性**照销售那条（`saleWriteBackgroundService.js:136` `markSaleWriteFailed`）。

## 6. 落库：1 张单（批次）+ N 行明细（**不新造写入口**）

| 链路 | 复用哪个既有件 | 依据 | 一次提交产生 |
|---|---|---|---|
| 补货 | `purchaseWebhookService.publishPurchaseRequest(taskId, task)` | `services/purchaseWebhookService.js:587`；批次 `createOnceByKey` `:1588`；明细 `createOnceByKey` `:1644` | **1 行采购主表** + **N 行采购明细**（N = 全部货品的全部尺码行） |
| 退货 | `purchaseReturnService.createPurchaseReturnService(...).submit(taskId, draft)` | `services/purchaseReturnService.js:47` / `:118`；明细 `createOnceByKey` `:208` | **1 行采购主表（采购行为=退货）** + **N 行采购明细** + 扣库存（经 `InventoryService`） |
| 库存 | 一律经 `inventoryService`（扣减/删除实时库存 + 写库存流水） | `services/inventoryService.js:1258-1271`（流水）、`:1299`（删实时库存行） | 每一行扣一次 |
| 出图/回填 | 复用既有出图链路，**标题/后缀来自配置** | `config/scanWrite.js:425-426`（`PURCHASE_RETURN.imageTitle` / `fileNameSuffix`）；回填 `services/purchaseOrderBatchService.js:451` | 1 张单图 + 写回「单据」列 |

⚠️ **明细的行序与幂等**：每个货品的每个尺码行，幂等键 = **配置的模板**（§10），
碰撞回查走 `createOnceByKey`（`infrastructure/idempotencyKey.js:43`）；命中已有行 ⇒ **整段 `values` 不重发** ✓

## 7. 幂等：一把 `submitKey`（本单唯一）

- `submitKey = orderKey`（本单唯一，提交后轮换）⇒ 重放/连点**只写一次** ✓
- 远端幂等：批次与每条明细都落「幂等键」**真实文本列**（`v1BitableSchema.js:379` / `:434` 段）⇒ 本地记录丢了也能回查。
- 与今天的差别：**新增"每货品一行"的模板**（见 §10 配置），使得"N 货品"天然可分、可回查。
- 判据沿用：`AC-RK1`（连点只建 1 个批次，`test/scanPageWrite.test.js:1258`）、
  `AC-PAW3`（同键串行+并发各两跑，`test/scanPurchaseAmountWrite.test.js:276`）、`AC-R6/R6b`（`test/scanPurchaseReturn.test.js:568` / `:593`）。

## 8. 校验（全部规则来自 config，逐条给依据）

| # | 规则 | 配置键（新增） | 现状依据 |
|---|---|---|---|
| 1 | 🔴 **同货号 + 同尺码不许重复行** | （规则本身，无键） | 今天不存在（单货品天然不重复）⇒ **新判据**，见 §13 |
| 2 | **退货每行 ≤ 该尺码实时库存** | `return.exceedPolicy: 'cap+report'` | `AC-R5`（超库存如实回报，`test/scanPurchaseReturn.test.js:495`）、`AC-R5b`（一双都退不成 ⇒ 拦住零写入，`:546`） |
| 3 | **补货/退货数量默认与上限** | `defaultQuantity` / `maxQuantity` | `config/scanWrite.js:384` / `:386`（补货）、`:421` / `:423`（退货）；`AC-PA*` 同族 |
| 4 | **每单上限（货品数 / 行数）** | `maxProducts` / `maxLines` | 今天只有**单货品**的 `maxSizes`（`config/scanWrite.js:383` / `:420`）；销售的 `maxLines` 在 `SESSION.maxLines`（`:225`）⇒ 新键沿用同形 |
| 5 | **空单不许提交** | （规则） | `test/scanPurchaseReturn.test.js:546`（`AC-R5b` 的"不建空批次"）与既有"本单为空"拒绝同形 |
| 6 | **"没填 ≠ 填 0"** | `emptyQuantity: 'use-default'` | `config/scanWrite.js:386`（勾了不填按 1 双算；`test/scanPageWrite.test.js:1074` `⑪`） |
| 7 | **可补/可退范围** | `allowedScope`（补货 = 货品信息可售；退货 = 实时库存实际有数量的尺码） | 退货那条：`docs` 口径 + `#611`（只列有数量的尺码）/`#614`（有库存必须列出） |
| 8 | **尺码规则（普通码全展示 / 特殊码有货才展示 / 补货页特殊码没货默认不勾选）** | `config/scanPage.js` 的 `SIZE_SEGMENTS` + `REALM_SIZE_BEHAVIOR[n].checkMissingByDefault` | `config/scanPage.js:516-575`、`:763-765`；`test/realmSizeBehaviorConfig.test.js:40`（`AC-RB-1`：`replenish.checkMissingByDefault=false` ⇒ 不再默认勾） |
| 9 | **整单金额（退货必填 · 补货已裁"不写金额"）** | `PURCHASE_AMOUNT.required` | `config/scanWrite.js:135-140`（`required:137`）；`test/scanPurchaseAmountRequired.test.js`（`AC-PA1…PA6`）、`test/scanPurchaseAmountWrite.test.js`（`AC-PAW1…PAW6`） |

## 9. 单号口径（她今天定：**维持现状**）

- **采购侧就叫「批次号」** ✓：字段名一直是「报货批次号」（`v1BitableSchema.js:369`），主表字段「录入数量」等照旧；
- 前端那句提示 **显示批次号**（不是"销售单号"那种 `XSD-…`）；
- **各处叫法一致** ✗：渲染层文案**只从 `config` 取**（`config/scanWrite.js:490` 的 `TEXTS`；现有
  `replenishDoneBody` / `replenishBatchLine` 已按"批次号"说话）；
- 生成规则**已配置化**：`config/purchaseBatchNo.js:6` / `:23` / `:39`（前缀、识别前缀都在配置里，逻辑不写死）。

## 10. 配置清单（**全部进 config** ✓——她点名的第一条）

新增 `config/multiItemOrder.js`（或按仓库既有习惯并入 `config/scanWrite.js` 的新块；**二选一，评审定**）：

| 组 | 键 | 默认（建议） | env（示例） | 说明/依据 |
|---|---|---|---|---|
| 共用 | `enabled` | `false`（先影子跑，见 §12） | `SCAN_MULTI_ITEM_ENABLED` | **显式布尔**（`readFlag`，禁 `||` 兜底） |
| 共用 | `maxProducts` | `20` | `SCAN_MULTI_ITEM_MAX_PRODUCTS` | 每单货品数上限（新） |
| 共用 | `maxLines` | `50` | `SCAN_MULTI_ITEM_MAX_LINES` | 每单行数上限；与 `SESSION.maxLines`（`scanWrite.js:225`）同形 |
| 共用 | `submitKeyTemplate` | `'multi_item:{sessionId}:{seq}'` | `SCAN_MULTI_ITEM_KEY_TEMPLATE` | 幂等键口径（新） |
| 共用 | `idempotency.detailKeyTemplate` | `'purchase_request:{taskId}:{productKey}:{size}'` | `SCAN_MULTI_ITEM_DETAIL_KEY` | 明细幂等键（新，替代今天按行序的拼法） |
| 共用 | `batchNo` | 复用 `config/purchaseBatchNo.js` | —— | **不新造生成器** ✗ |
| 共用 | `async.enabled` | `false`（第二步再开） | `SCAN_MULTI_ITEM_ASYNC_ENABLED` | 照 `SALE.asyncWrite`（`scanWrite.js:327`） |
| 共用 | `async.timeoutMs` | `180000` | `SCAN_MULTI_ITEM_ASYNC_TIMEOUT_MS` | 同 `SALE.asyncWrite.backgroundTimeoutMs`（`:340`） |
| 共用 | `texts.*` | 见 §9 | `SCAN_MULTI_ITEM_TEXT_*` | 全部文案（不散写中文 ✗） |
| 补货 | `chain.behaviorCode` | `PURCHASE_ORDER` | `SCAN_REPLENISH_BEHAVIOR_CODE` | **沿用现状**（`scanWrite.js:373`） |
| 补货 | `chain.taskPrefix` | `scan_replenish` | `SCAN_REPLENISH_TASK_PREFIX` | `scanWrite.js:376` |
| 补货 | `chain.defaultQuantity/maxQuantity` | `1` / `99` | `SCAN_REPLENISH_DEFAULT_QUANTITY` / `_MAX_QUANTITY` | `scanWrite.js:386` / `:384` |
| 退货 | `chain.behaviorCode` | `PURCHASE_RETURN` | `SCAN_RETURN_BEHAVIOR_CODE` | `scanWrite.js:412` |
| 退货 | `chain.taskPrefix` | `scan_return` | `SCAN_RETURN_TASK_PREFIX` | `scanWrite.js:414` |
| 退货 | `chain.scope` | `live_stock_only` | `SCAN_RETURN_SCOPE` | 退货=实时库存实际有数（她 2026-10-15 口径） |
| 退货 | `chain.exceedPolicy` | `cap+report` | `SCAN_RETURN_EXCEED_POLICY` | 超库存如实回报（`AC-R5`） |
| 退货 | `chain.amount.required` | `true` | `SCAN_PURCHASE_AMOUNT_REQUIRED` | **沿用现状**（`scanWrite.js:137`） |
| 尺码 | （沿用）`SIZE_SEGMENTS` / `REALM_SIZE_BEHAVIOR` | —— | —— | `config/scanPage.js:516-575` / `:763-765`（**不搬、不重写** ✓） |

> 读法：**每一行的"依据"列都能点开对**；新增的键全部走 `readFlag/readString/readInt`（**显式布尔**，不写 `||` 兜底）。

## 11. 异步方案（照 `saleWriteBackgroundService`；**第二步再做**）

销售那条已经跑通，直接照抄结构（**不新发明** ✗）：
- 调度器：`createSaleWriteBackgroundService`（`services/saleWriteBackgroundService.js:53`）→ 新模块里做同形的
  `createMultiItemOrderBackgroundService({ submitDraft, config, logger })`；
- 句柄：`await result.background` 让调用方"等后台那一跑"（销售那条 `:65` 起，含 `pendingSaleBackgrounds` `:37` / `:46`）；
- 失败如实：`markSaleWriteFailed`（`:136`）同形 ⇒ 单据落「**写入失败**」+ 工作台「未完成，可点重试」（复用既有 `isOrderIncomplete` 判据）；
- 观测不缩水：`scan.sale.timing` 的 `phase: 'request' | 'background'` 那套（`config/scanWrite.js:868` `TIMING`）⇒ 多货品单**两段都打**。

## 12. 迁移路径（三步，每步都能独立上线/回滚）

| 步 | 做什么 | 开关 | 判据 |
|---|---|---|---|
| **① 影子** | 新增引擎 + `config`；**只读**跑校验（把"她这次会提交什么"算出来进日志）；**不写库** | `SCAN_MULTI_ITEM_ENABLED=false`（校验旁路） | 新单测（§13 的"新判据"）＋**既有判据全绿** |
| **② 并存** | 多货品入口上线（`entries` 改成按货品分组）；旧的"单货品即时提交"**保留**为"N=1 特例" | `SCAN_MULTI_ITEM_ENABLED=true` | 既有判据**逐字保留**（§13）+ N=1 与旧路径**逐字等价**的新回归 |
| **③ 收口** | 旧路径删除（连同它那套 `replenishFingerprint`）；`chain` 配置成为唯一差异来源 | —— | 删除项列清单 + 判据迁移完毕 |

> 关键纪律：**每一步都"既有判据一条不许丢"**（她/L​ead 的硬约束）⇒ 逐条对照见 §13。

## 13. 判据迁移表（**既有判据一条不许丢**）

> 左列 = 现有判据（`文件:行`）；右列 = 多货品下的**新判据**（措辞按"多货品"改写，**语义不变或更强**）。

| # | 现有判据（文件:行） | 多货品下的新判据 | 处置 |
|---|---|---|---|
| 1 | `⑪ 一键补货：勾了不填数量按 1 双算`（`test/scanPageWrite.test.js:1074`） | **每个货品、每个尺码**勾了不填都按 1 双算 | 扩维保留 |
| 2 | `⑥ 勾选尺码 + 填数量 → 生成采购申请`（`:472`） | 同上，且**多货品一次提交**；供应商逐货品取 | 扩维保留 |
| 3 | `⑧ 路由：补货表单 ... 结果页（批次号 + 条数）`（`:821`） | 结果页批次号 + **总条数**（跨货品合计）+ 先提示"批次号已创建"（异步档） | 逐字保留 + 异步档新增 |
| 4 | `AC-RK1 同一份草稿连点两次 ⇒ 只建 1 个批次`（`:1258`） | 同（一把 `submitKey`）；**跨货品也是 1 个批次** | 逐字保留 |
| 5 | `AC-RK2 草稿变了（换货号）后用旧键提交 ⇒ 建第二个批次`（`:1273`） | ⭐ **改成**：`orderKey` 已轮换 ⇒ **不需要指纹**也建第二个批次；**并新增**"同 `orderKey` 下**加一个货品**再提交 ⇒ 仍是同一单（不重复建单）" | **语义更强**（§4.2 的动机） |
| 6 | `AC-RK3 连续 3 个货号（都用第一把键）⇒ 3 个批次`（`:1297`） | 多货品下：**一次提交 3 个货品 ⇒ 1 个批次 + 3N 行**；**三次提交（各自一轮）⇒ 3 个批次** | 语义重述，两个方向都钉 |
| 7 | `AC-PA1…PA6`（整单金额一套配置 / 两表单各一个输入 / 空 ⇒ 400 零写入 / 非空照旧 / 源码哨兵 / 落表） | 空/非空判据**逐字不动**；新增"N 货品下金额仍是**整单一个**" | 逐字保留 + 新增 |
| 8 | `AC-PAW1`（退货金额逐字落「实际金额」） | 同（N 货品也是**一个**整单金额） | 逐字保留 |
| 9 | `AC-PAW2`（空 / 非数字 ⇒ 400 + 人话 + 零写入） | 同 | 逐字保留 |
| 10 | `AC-PAW3`（同键串行+并发 ⇒ 恰一个批次、金额不重复写坏） | 同；**并发提交同一 `orderKey`** 也必须只落一次 | 逐字保留（并发面扩大） |
| 11 | `AC-PAW4`（金额没写进去 ⇒ 如实失败；同键重试接着写） | 同；**部分货品写完**时重试 ⇒ 已落的不重发（`createOnceByKey`） | 逐字保留 |
| 12 | `AC-PAW5`（只碰「实际金额」一列） | 同 | 逐字保留 |
| 13 | `AC-PAW6`（补货不写金额；调用方只有退货一处） | 同（多货品不改变"哪条链写金额"） | 逐字保留 |
| 14 | `AC-R1`（退货表单与补货同形：同一端点 / 勾尺码+填数量 / 自带幂等键） | 同形不变；**载荷从"一个货品"变"按货品分组"** | 逐字保留（形状扩维） |
| 15 | `AC-R2`（退货明细不写行为列 + 批次只写批次号+幂等键） | 同（**每一行**都不写行为列） | 逐字保留（行数扩维） |
| 16 | `AC-R3`（退货批次不进"到货验收情况"面板） | 同 | 逐字保留 |
| 17 | `AC-R4`（真扣库存：三状态各一双全退；重放不重复扣） | 同；**多货品多尺码**每一行扣一次 | 逐字保留（行数扩维） |
| 18 | `AC-R5`（超库存：报 5 库存 3 ⇒ 明细 3 + 差额如实回报） | 同；**逐行**判定，差额逐行如实回报 | 逐字保留（行数扩维） |
| 19 | `AC-R5b`（一双都退不成 ⇒ 拦住、零写入） | 同；**整单里只要有货品行全退不成** ⇒ 按配置（`exceedPolicy`）决定"拦住"还是"如实少退" | 逐字保留 + 配置面 |
| 20 | `AC-R6 / R6b`（幂等 / 中途失败重试） | 同 | 逐字保留 |
| 21 | `AC-R7`（入口隔离：不碰 `lark_mvp_tasks/`） | 同（新草稿仍落 `data/scan_sessions/`） | 逐字保留 |
| 22 | `AC-R8`（源码哨兵：不直连写库、库存只在 `InventoryService`） | **加强**：新引擎里也**一处都不许**直连 `gateway.create/update` | 加强 |
| 23 | `AC-R9`（失败有人话、内部错误不回显） | 同 | 逐字保留 |
| 24 | `AC-R10`（退货单出图走既有链路，标题/后缀来自配置） | 同 | 逐字保留 |
| 25 | `AC-RB-1…4`（改配置即改行为 / 三领域行为不变 / 源码哨兵 / 表结构显式枚举） | 同；新增 `multiItemOrder` 块的**同形哨兵**（显式布尔、只收真实轴） | 逐字保留 + 新增 |
| 26 | `config/scanWrite.js` 的 `SESSION.maxLines` 相关用例 | 同（新 `maxLines` 与它同形，不冲突） | 逐字保留 |
| 27 | 尺码规则（普通码/特殊码/默认勾选）用例 | 同（**沿用 `SIZE_SEGMENTS` / `REALM_SIZE_BEHAVIOR`，不搬不改**） | 逐字保留 |

**新判据（必须新写，且能真红）**：
1. **同货号 + 同尺码重复行** ⇒ 拦住 + 人话 + 零写入（§8 #1）；
2. **N 货品一次提交 ⇒ 1 批次 + N×M 行**（行数、幂等键逐字可查）；
3. **第 2 单不被第 1 单吸收**（`orderKey` 轮换）—— 今天靠指纹，新的靠键（§4.2）；
4. **并发提交同一 `orderKey`** ⇒ 只落一次（§7）；
5. **异步档**：批次号先出 + `background` 句柄 + 失败落「写入失败」+ 两段 `timing`（§11）。

## 14. 风险清单

| # | 风险 | 现在的护栏 / 新设计的处置 | 依据 |
|---|---|---|---|
| 1 | **撞号**（批次号 / 单号重复） | 生成器已有"撞号复查"；批次号规则在配置里 | `config/purchaseBatchNo.js:6`；`scanWriteService` 的 `onCollision` 同形（`salesEntryService.js` 段） |
| 2 | **草稿过期** | 会话有 TTL（12h）且**不再死路**：提交时 `revive` 续上（草稿/已落盘 id 保留） | `scanSessionService.js:177`（`revive`）；`scanWriteService.js:758` |
| 3 | **并发提交同一单** | 按 `open_id` 串行（`KeyedSerialQueue`）+ 一把 `submitKey` | `scanWriteService.js:1337`/`:1504` 的 `queue.run`；`AC-PAW3`/`AC-R6` |
| 4 | **明细翻倍**（重试写出第二遍） | 每个货品行一个**幂等键**（真实列）+ `createOnceByKey` 回查（命中即整段不重发） | `infrastructure/idempotencyKey.js:43`；`accounting` 见 `purchaseWebhookService.js:1610` 注释 |
| 5 | **异步失败重试** | 失败 ⇒ 单据「写入失败」+ 工作台「未完成，可点重试」；重试**走同一把 key** | `saleWriteBackgroundService.js:136`；`AC-PAW4` |
| 6 | **N 货品 → 幂等键撞车** | 明细键模板里必须含 `productKey` + `size`（§10），否则两个货品同尺码会撞 | **本设计新增**（今天按行序拼，单货品不出问题） |
| 7 | **出图/发群变慢**（N 变大） | 出图那段不阻塞成单（既有约定）；异步只做写表 | `purchaseOrderBatchService.js:451` 段注释（出图非阻塞） |
| 8 | **她一次勾太多** | 每单上限（`maxProducts`/`maxLines`）⇒ 人话拦住、零写入 | §10 |
| 9 | **"空单 / 全 0"** 被写成空批次 | §8 #5/#6：空单不许提交；"没填 ≠ 填 0" | `AC-R5b` |

## 15. 本设计**不做**的事（边界）

- **不写实现** ✗（本任务只出文档）；**不改业务代码**、不改既有用例。
- **不动**尺码规则、行为编码值域、状态值域、字段映射（`v1BitableSchema`）、批次号生成器 —— 一律**复用**。
- **不动**销售的既有异步链路（它是这套异步设计的参照物，不是改造对象）。
- **不新造**任何写库入口 / 不新开鉴权 / 不新增 HTTP 端点（仍是既有那个 POST 端点 + 两个动作）。
- **不碰** `data/lark_mvp_tasks/`（入口隔离，`AC-R7` 钉着）。

---

### 附：本设计引用的关键代码位置（一览）

| 主题 | 位置 |
|---|---|
| 会话草稿与键 | `services/scanSessionService.js:47`（`keyFor`）`:103`（`get`）`:114`（`ensure`）`:137`（`submitKeyFor`）`:177`（`revive`）`:208`（`addLine`）`:376`（`completeReplenish`）`:412`（`completePurchaseReturn`） |
| 两条链的服务入口 | `services/scanWriteService.js:1337`（`submitReplenish`）`:1504`（`submitPurchaseReturn`）`:1329`（指纹，③ 步删） |
| 落库（复用） | `services/purchaseWebhookService.js:587` / `:1588` / `:1644`；`services/purchaseReturnService.js:47` / `:118` / `:208`；`services/purchaseOrderBatchService.js:151` / `:206` / `:451` |
| 幂等 | `infrastructure/idempotencyKey.js:23` / `:43`；`config/v1BitableSchema.js:379` / `:434` 段 |
| 库存 | `services/inventoryService.js:1258-1271`（流水）`:1299`（删实时库存行）`:70`/`:77`（行为编码） |
| 异步（参照） | `services/saleWriteBackgroundService.js:37` / `:46` / `:53` / `:65` / `:136` |
| 配置 | `config/scanWrite.js:55` / `:143` / `:207` / `:236` / `:327` / `:361` / `:406` / `:490` / `:782` / `:868`；`config/scanPage.js:516-575` / `:763-765`；`config/purchaseBatchNo.js:6` / `:23` / `:39` |
| 路由 | `routes/scanPage.js:1924`（补货动作）`:1993`（退货动作）`:2108-2126`（表单解析） |
| 字段现状核对 | `docs/scan-write-fields-audit-2026-10-15.md` |
