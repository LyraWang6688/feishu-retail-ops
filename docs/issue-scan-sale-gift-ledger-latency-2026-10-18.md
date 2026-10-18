# 扫码销售链路问题说明（赠品未落表 / 库存流水关联销售为空 / 提交耗时与白屏）

> 面向代码评审 / 外部 AI 的独立说明。系统背景、线上观测数据、根因定位、候选方案与待评审问题。
> 日期：2026-10-18；线上 commit `e72b2ee`（本次部署的是纯重构，行为与之前一致）。

## 1. 系统背景（最小必要信息）

- 业务：线下鞋店「邯美皮鞋」，销售/补货/退货/库存都在网页扫码页上录入。
- **飞书多维表格（Bitable）是唯一事实源**；后端是确定性执行引擎（校验 / 幂等 / 写表 / 联动），Node.js + Express。
- 扫码页流程（销售，一次真实操作）：
  1. **货品页**：扫二维码（`/r/{recordId}` 或 `/s/{编号}`），选尺码/数量、填「实收金额」→ 点【提交（1 双）】
  2. **资金页**：显示总金额，填收款行（方式+金额，可多行）和「赠品」（可不填）→ 点【提交这一单】
  3. **成功页**
- 关键设计：**「货 / 钱分离」**（2026-10-16 业务口径）
  - **货那一跑**：建销售主表 + 单号 + 销售明细 + （现货则）交付/扣库存；**不写钱、不置资金状态**
  - **资金页那一跑**：同一把 `submitKey` 续写同一单，写收款明细 + 资金状态；再检查交付（已交付则跳过）
  - 两跑都经过 `scanWriteService.submitSale` 的**同一把串行队列** `queue.run('sale:' + sessionId)`
- 相关表（生产）：
  - 销售主表 `salesEntry` = `tblLjFe3NjU61xKB`
  - 销售明细 `salesDetail` = `tblxW5WMKDULyolA`
  - 收款明细 `paymentRecord` = `tblTpLOtTLhWxXvm`
  - 库存流水 `inventoryLedger` = `tbl7Xo4OPmaN2NdP`
  - 实时库存 `liveInventory` = `tblTr5qgiZXPADLP`
- 写飞书的单次 create/update 实测约 **2–4 秒**（跨境/接口延迟），这是所有优化的硬约束。

## 2. 本次真实操作与观测数据（线上只读日志 + 只读回读）

操作：货品 `92608|黑色|A`、39 码、1 双、实收 ¥99；资金页填「微信 99」+ 赠品「一双鞋垫」；生成订单 **XSD-20261018-0001**。

### 2.1 时间线（上海时间）

| 时间 | 事件 |
|---|---|
| 13:58:13 | 提交销售页（`scan.sale.submitting`：line_count=1, payment_count=0, 未付） |
| 13:58:19 | 创建销售主表 `reczz28OlZ6LOC3R`（3.8s） |
| 13:58:21 | 生成单号 XSD-20261018-0001 |
| 13:58:23 | 主表状态更新；**后台「货那一跑」入队**；页面回资金页（`page=pay`） |
| 13:58:40 | 创建销售明细 `reczz28OlZU3vcjQ`（39 码 / 实收 99） |
| 13:59:21 | 创建库存流水 `reczz28OlaBnTBPD`（销售减少 1 双） |
| 13:59:38 | 实时库存扣到 0（`recvw7x87LVc8p`） |
| 13:59:40–42 | 明细履约=已交付；主表库存状态=已写入 |
| **13:59:49** | 后台货跑完成（`background_done`，86.4s）；同时资金页 POST 开始 |
| 14:00:11 | 创建收款明细 `reczz28Olb4lNEPG`（微信 99 / 已收款） |
| 14:00:20 | `v1.sale.posted`（钱落库完成） |
| 14:00:36 | 成功页（`page=success`），整笔资金页请求 **87.2s** |

### 2.2 耗时分解（`scan.sale.timing`，单位 ms）

| 阶段 | submit_ms | queue_wait | lookup | prepare | master | status | detail | stock |
|---|---|---|---|---|---|---|---|---|
| 请求1（销售页提交） | 9615 | 0 | 4 | 4 | **7389** | **2220** | 0 | 0 |
| 后台（货那一跑） | 86439 | 1 | 0 | 4 | 0 | 0 | **21886** | **64546** |
| 请求2（资金页提交） | 87238 | **40605** | 0 | 8 | 0 | 0 | **30414** | **16200** |

飞书写表耗时汇总（同两 trace）：

| 操作 | 次数 | 合计 |
|---|---|---|
| 销售主表 update | **11** | **22.8s** |
| 销售明细 create | 1 | 4.0s |
| 收款明细 create | 1 | 4.0s |
| 库存流水 create | 1 | 3.9s |
| 销售主表 create | 1 | 3.8s |
| 销售明细 update | 1 | 2.3s |

### 2.3 回读结果（只读）

- 销售主表：总金额 99、金额核对 99、确认状态 已确认、资金/库存 已写入、收款状态 已收清、交付 1、待交付 0
- 销售明细：39 码、实收 99、已交付、明细ID `XSD-20261018-0001-01`
- 收款明细：微信、99、已收款
- **异常：销售主表「赠品」= 空；库存流水「关联销售」= 空**

## 3. 问题一：资金页填的「赠品」没写进销售主表

### 现象
资金页「赠品（可不填）」填了「一双鞋垫」，提交成功、页面无报错，但销售主表「赠品」列为空。

### 根因（代码路径）

资金页的赠品输入字段名是 `gift`（`config/scanWrite.fields.gift = 'gift'`）。
资金页提交进入 `routes/scanPage/handlers/payment.js`，它给写层准备的 `pendingLine` 是：

```js
// payment.js 约 225-234 行
pendingLine: pendingView?.found ? {
  ...,
  gift: String(pendingInfo.gift || ''),   // ← 来自会话（第一次提交时保存的），不是资金页输入
} : null,
```

而写层只在「会话里一行都没有」时才用 `pendingLine` 建行：

```js
// scanWriteService.js 约 833 行
if (pendingLine && pendingLine.size && !(sale.lines || []).length) {
  const added = await sessions.addLine(sessionId, { ..., gift: String(pendingLine.gift || '') });
}
```

本次「货那一跑」已经建好了行（`sale.lines` 非空），所以 `pendingLine.gift` 根本不会被使用；
而货那一跑在她填赠品之前就已把主表赠品**写成空串**：

```js
// salesOrderService.js 约 291-294 行（每次 confirm 都写，含空串）
await this.gateway.update('salesEntry', salesEntryRecordId, {
  gift: orderGift,
  ...(orderAmountsKnown ? { totalAmount: totalCents / 100 } : {}),
}, { correlation });
```

结论：**资金页的 `body[fields.gift]` 从未被读取**，会话/明细里的 gift 又是第一次提交时的空值 ⇒ 主表赠品空。

### 候选修复
- 方案 A（最小改）：资金页读出 `body[fields.gift]`，作为「本单赠品」传给写层（新增显式入参，如 `orderGift`），资金页那一跑写主表时优先使用；`pendingInfo.gift` 仍作旧路径兜底。
- 方案 B：资金页提交前把赠品写回会话行，再走既有 `line.gift` 合并逻辑（改动面更大，但保持"赠品来自行数据"的既有语义）。
- 需要评审：赠品语义是「整单一条」（主表一列），从支付页录入是否应视为整单赠品；方案 A 的幂等/重试（用户改赠品后重提）如何与 `existingGift !== orderGift ⇒ 抛错` 的既有保护共存。

## 4. 问题二：库存流水「关联销售」为空

### 现象
库存流水记录了「销售减少 1 双」，但「关联销售」列空白。

### 证据
生产表字段元数据（只读 API）：

```
关联销售  type=21(关联)  table_id=tblLjFe3NjU61xKB  (= 销售主表 salesEntry)
```

而代码写的是**销售明细** record id：

```js
// inventoryService.js 约 148 行
[MOVEMENT_SALE_DECREASE]: { ledgerSource: 'salesDetail', ... }

// inventoryService.js 约 720-723 行（写流水）
...(movement.ledgerSource
  ? { [movement.ledgerSource]: relation(plan.item.sourceRecordId) } : {}),
```

`.item.sourceRecordId` 来自 `applySale({ salesDetailRecordId })`（salesDeliveryService 只传明细 id）。
飞书该字段指向销售主表，写进去的明细 id 解析不到 ⇒ 显示空白。

### 既有设计约束
- `ledgerSource` 同时承担两件事：① 写「关联销售」列；② 幂等回查（`findLedger(ledgerSource, sourceRecordId, behaviorRecordId)`）。
- 代码里已有「`ledgerSource`（可查） vs `ledgerLink`（只写不查）」的分离先例（采购入库→`purchaseBatch`），见 `inventoryService.js` 约 165-174 行。
- 本次销售交付已有 `salesEntryRecordId`（`salesDeliveryService.deliver` 的入参），可以透传到 `inventory.applySale`。

### 候选修复
- 方案 A：给销售减少/销售退货等注册 `ledgerLink = { field: 'salesEntry', inputKey: 'salesEntryRecordId', ... }`，写「关联销售」= **销售主表 id**；`ledgerSource` 保持 `'salesDetail'`（或改为 null）仅用于幂等。需要改 `v1BitableSchema` 的字段语义键（目前 `salesDetail: '关联销售'`）。
- 方案 B：把生产字段改回指向「销售明细」（不推荐：字段由业务方维护，且她要的"关联销售"语义可能本来就是订单）。
- 需要评审：幂等（按明细 id 回查）与远端关联（主表 id）分离后，重建/恢复路径（`findLedger`、`resumePending`、本地 operation store）是否有遗漏；`ledgerSource: null` 是否会削弱跨进程幂等。

## 5. 问题三：页面切换慢 / 资金页提交白屏

### 观测
- 销售页提交 → 资金页：**9.6s**（主表创建 3.8s + 单号/状态写 3.5s + 确认状态 update 2.2s）
- 资金页提交 → 成功页：**87.2s**，其中：
  - **排队等待 40.6s**：资金页那一跑与后台货跑共用 `queue.run('sale:' + sessionId)`，必须等货跑 86.4s 结束；
  - 明细/收款/状态 30.4s（第二次 confirm 重新写总金额/赠品/状态、建收款行、progress.sync）；
  - 再次交付检查 16.2s（货跑已交付，但资金页那一跑仍走 `deliverStockLines`）。
- 后台货跑 86.4s 中：
  - 明细/交易类型/状态 21.9s；
  - **库存交付 64.5s**（引用读取 + 库存引擎 operation 写流水/实时库存 + 状态写 + progress）。
- 主表 11 次 update 合计 22.8s（每次约 2.1s）。

### 白屏原因
资金页提交是一个**同步表单 POST**：浏览器导航后等待服务器响应；这 87.2s 内页面没有可渲染内容 ⇒ 白屏。按钮上的"正在提交，请不要重复点…"在导航后也看不到。

### 业务方额外要求
- 资金页**不需要**显示销售单号和说明文字，只需要「货品页加总的总金额」；希望借此减少耗时。
- 页面切换等待要有反馈，不要白屏。

### 候选优化（按收益）
1. **资金页那一跑不重复写货**：检测会话已有 `goodsCreated`（主表/明细/交付已完成）⇒ 只写收款 + 资金状态，跳过赠品/总金额/明细/再次交付。预期省 30–45s。
2. **拆解后台交付 64.5s**：`deliver` 目前会重新 list/read 销售明细、尺码引用、实时库存；把已读数据/已知 id 复用、减少重复读；目标 ≤20s。这样她填资金页时后台已完成，queue_wait 接近 0。
3. **合并状态写**：`salesEntry` 一次 update 同时写多维度状态（现在每次维度一个 PATCH，11 次），目标每跑 1–2 次，省 10–15s。
4. **资金页精简**：去掉单号/提示文案，只留总金额 + 收款行 + 赠品；收款方式列表避免每次实时读表（缓存/配置化）。
5. **白屏兜底**：提交改为 JS `fetch` + 全屏进度提示（或至少保留按钮态），不依赖整页导航。

目标：资金页提交 → 成功页从 **87s** 降到 **~15s**；销售页提交 → 资金页从 9.6s 降到 ~5s。

## 6. 请评审 AI 重点回答的问题

1. 「货/钱分离」两跑共用一把串行队列导致资金页必须等后台货跑——除了缩短货跑，是否有更稳的并发方案（例如按阶段拆锁：建单锁 / 明细锁 / 资金锁），同时不破坏幂等与"同一 submitKey"语义？
2. 资金页的赠品应作为「整单赠品」持久化到哪一层：会话行、主表、还是独立的订单赠品字段？如何与既有的"赠品变化 ⇒ 停止重试"保护共存？
3. 库存流水「关联销售」：应该写主表 id 还是明细 id（业务字段实际指向主表）？`ledgerSource`（幂等）与 `ledgerLink`（远端关联）拆分是否是正确抽象？有没有更简单的做法？
4. 飞书单次写 2–4s 的硬约束下，11 次主表 update 的合并策略：状态维度能否一次 PATCH 全写？是否有"先本地聚合、后一次落库"的通用模式可以复用？
5. 同步 POST 长事务（87s）的 UX：改用异步任务 + 轮询/推送，还是先返回"处理中"页再由前端轮询成功？哪个更符合"不许假成功"的原则？
6. 是否有遗漏的隐患（例如赠品幂等、关联字段写错表、队列锁粒度、日志可观测性）？

## 7. 代码位置索引

- 扫码销售提交：`server/src/routes/scanPage/handlers/salesSubmit.js`
- 资金页提交：`server/src/routes/scanPage/handlers/payment.js`（`pendingLine.gift` 在 ~232 行）
- 写服务主流程：`server/src/services/scanWriteService.js`（异步闸门 ~1222、confirm ~1258、交付 ~1320、gift 建行 ~851）
- 销售入账：`server/src/services/salesOrderService.js`（赠品合并/写入 ~247-294、收款 ~460、posted 日志 ~482）
- 交付/库存：`server/src/services/salesDeliveryService.js`（applySale ~121、履约 ~125、delivery.completed ~190）
- 库存引擎：`server/src/services/inventoryService.js`（movement 注册表 ~144、写流水 ~720、幂等回查 ~1819）
- 字段映射：`server/src/config/v1BitableSchema.js`（`salesEntry.gift` ~180、`inventoryLedger.salesDetail` ~584）
- 资金页视图：`server/src/views/scanPage/paymentBlock.js`（gift 输入）
