# 退货链路：「一单多货品」＋「生成退货单按供应商分组」落地记录（task-64 · 2026-10-16）

> **本文件的性质**：**实现记录**（改前逐字 → 改后逐字 → 依据）＋ **只读核查结论**
>（退货这条链"到底有没有真正接线" · "每行的供应商从哪来"）＋ **验收标准与证据** ＋ **边界（未做项）**。
> 前一份（补货那条链的同一条口径）：`docs/supplier-split-at-generation-2026-10-16.md`
> —— 它的 §3.6 / §5 把"退货链路的多货品支持"**如实标成未做**，本文件就是那一条的**收口** ✓。

---

## 0. 她的口径（逐字，**唯一权威**；别自己解释 ✗）

> 2026-10-16 15:12（问"退货链路的「多货品 + 供应商拆分」要不要做"）：
> 「**退货的多货品 + 供应商拆分要做**」✓
>
> 2026-10-16 14:32（供应商拆分的形状）：⭐ **同一批次号下按供应商分组** ✓
> （**不是** ⓑ「每个供应商各开一个新批次号」✗）

⇒ 组的那一半**复用**已经进 main 的那一套：`services/supplierSplitService.js`（纯函数 ✓）＋
`config/supplierSplit.js`（`batchNoPolicy: 'same_batch_no'` ✓）—— **没有另造第二套** ✗。

---

## 1. 只读核查①：退货这条链**原来到底有没有真正接线**（结论 + 文件:行）

| 环节 | 改动前 | 位置 |
| --- | --- | --- |
| 路由把 N>1 交给引擎 | ✅ **已接线** | `routes/scanPage/index.js` 退货分支 `groups.length > 1` ⇒ `submitMultiItemOrder({ chain: 'return' })` |
| 引擎配置 | ✅ 在 | `config/multiItemOrder.js` 的 `chains.return`（`writer: 'purchaseReturn'`） |
| 引擎 → 写入件 | ✅ 挂上了 | `services/scanWriteService.js` 的 `multiItemWriters().purchaseReturn → purchaseReturnService.submit` |
| 🔴 **写入件本身（`purchaseReturnService`）** | ❌ **没接线**（**只认单货品**） | `services/purchaseReturnService.js` 的 `ensurePlan` / `submit` |

**没接线的四条后果（都是"改前逐字"级别的真账）**：

1. **可用量按批次级货品查**（`ensurePlan` 里 `includes(draft.product_record_id)`）——
   引擎的多货品载荷里 `planSubmission` 在 `single === false` 时把**批次级货品留空**
   ⇒ 每一行 `available = 0` ⇒ `takenCount = 0` ⇒ **`skipped: 'no_stock'`、一个字都不写**；
   而引擎那把 `submitDraft` **不看写入件的返回值**（只看抛不抛）⇒ 草稿照样被标成 `submitted`
   ⇒ **她看到成功页、账上啥也没有** ✗。
   ⭐ **真账**（本 worktree 上"改前"跑出来的日志，一字未改）：
   ```json
   {"event":"scan.purchase_return.plan_frozen","task_id":"scan_return_scan_return_x_rs5",
    "batch_no":"CGD-20261016-0001","declared_count":4,"taken_count":0,"shortfall":4,
    "sizes":"41码:0/2,42码:0/1,41码:0/1"}
   {"event":"scan.purchase_return.shortfall","task_id":"scan_return_scan_return_x_rs5",
    "reason":"no_stock_at_all","note":"所有尺码的实时库存都是 0 ⇒ 不建批次行、不写明细、不扣库存"}
   ```
   （客观库存是够的：`prod_A` 41 码 2 双 ＋ 42 码 1 双、`prod_B` 41 码 1 双 ⇒ 本该退 4 双。）
2. **每条明细 / 每张图带的是批次级供应商**（`relation(draft.product_record_id)`、
   `supplier_record_id: draft.supplier_record_id`）⇒ 多货品时是空串 ⇒
   **混供应商的退货整单落进「未标注供应商」那一张** ✗（**错账级后果** ✓）。
3. **明细幂等键不含货品**（`purchase_return_doc:{taskId}:{size}`）⇒ 两个货品**同尺码**会
   **撞同一把键**（第二行被 `createOnceByKeys` 当成重放**吸收** ✗）。
4. **批次行的「采购行为」只认 `draft.behavior_record_id`**（引擎的多货品载荷里是**空串**）
   ⇒ 建出来的退货批次**没有采购行为** ⇒ 工作台按"读不到行为记录 ⇒ 现状=采购申请"分流 ✗。

⭐ **结论**：`chains.return` 那一半（配置 / 路由 / 写入件挂载）**是接的**；
**写入件里边没接**（只支持单货品）⇒ 本卡把它接上。

---

## 2. 只读核查②：**每行的供应商从哪来**（结论：代码读「货品信息.供应商」✓ · 不发明列 ✗）

| 候选来源 | 核查结论 |
| --- | --- |
| 扫码页载荷里的 `supplier_record_id` | ❌ **永远是空串**：`views/scanPage/multiItemBlock.js` 从 `view.supplier_record_id` 取，而那个键**从来没被赋过值**（`services/scanPageService.js` 的 `lookup` 返回的 view 里没有它；`routes/scanPage/index.js` 的 `draftItemsOf` 也只是照抄 `view?.supplier_record_id ?? ''`） |
| 「采购明细.供应商」 | ⛔ **公式列（只读）** ⇒ 代码**不写**（写了会被忽略 / 甚至整条 create 失败）——她 ADDENDUM-3 结论① |
| 「采购主表.供应商」 | ⛔ **SingleLink，代码只读不写**（她自己维护） |
| ⭐ **「货品信息.供应商」** | ✅ **就是它**：**既有的**那条关联列（`v1BitableSchema.tables.product.fields.supplier` = 「供应商」）；**单货品那条路**（`services/scanWriteService.js` 的 `submitPurchaseReturn`）读的**同一个字段**（`linkedRecordIds(product.fields[supplier])[0]`），只是那里是**批次级**、这里**逐行**读 |

⇒ **本卡没有新增任何列、没有写「货品信息」、没有写那两处只读列** ✓；
"每行的供应商"= **代码**按每行的货品 record_id 读**已有**那条关联列（同一货品只读一次 ✓ 拿不到就如实空着 ⇒
出图那边照旧出「未标注供应商」那一张，**不猜** ✗）。

---

## 3. 改前逐字 → 改后逐字 → 依据（`services/purchaseReturnService.js`，唯一改动的源码文件）

| # | 位置 | 改前逐字 | 改后逐字 | 依据 |
| --- | --- | --- | --- | --- |
| ① | `ensurePlan` 的可用量 | `linkedRecordIds(record?.fields?.[liveTable.fields.product]).includes(draft.product_record_id)` | `…includes(productRecordId)`（= **这一行**那个货品） | 她 15:12「退货的多货品要做」；多货品时批次级是空串（见 §1-1） |
| ② | 计划（`plan.items`） | `{ size, declared, available, taken, shortfall }` | **多货品时**多带逐行身份：`{ product_record_id, supplier_record_id, product_number, item_no, color, size, … }`（**单货品一个字都不加** ✓） | 重试要**逐字复用**同一份身份（幂等的物理基础）；展示字段一起冻 ⇒ 第二跑不回头读已被换成 `drawItems` 的草稿 |
| ③ | 逐行供应商 | 无（只有批次级） | 行上带的优先 ⇒ 没有就 `resolveSupplierByProduct(productRecordId)`（读「货品信息.供应商」）⇒ 再没有才回落批次级 | §2 的核查结论；**不新增列** ✗ |
| ④ | 批次行「采购行为」 | `behaviorRecordId: draft.behavior_record_id` | `draft.behavior_record_id \|\| plan.behavior_record_id`（草稿没带 ⇒ `ensurePlan` 里按 `config.behaviorCode` 解析一次、**冻进计划**） | `test/scanPurchaseReturn.test.js` 的 AC-R2（主表要写退货那一档）＋该文件里就写明的"读不到行为 ⇒ 按现状=采购申请分流" |
| ⑤ | 明细 `product` | `relation(draft.product_record_id)` | `relation(line.product_record_id)` | 同 ①（多货品时批次级是空串） |
| ⑥ | 明细幂等键 | `purchase_return_doc:{taskId}:{size}` | **多货品时** `purchase_return_doc:{taskId}:{productRecordId}:{size}`（单货品**逐字不变** ✓） | §1-3（同尺码撞键 ⇒ 静默少一行） |
| ⑦ | 库存入参 `productRecordId` | `draft.product_record_id` | `lineOf(item).product_record_id` | 同 ①；库存引擎 `purchaseReturnSourceId` 也是按「批次身份\|**货品**\|尺码」三元组幂等 ✓ |
| ⑧ | `drawItems`（喂出图） | 7 个键，货品 / 供应商取**批次级** | 7 个键，取**逐行**（`lineOf(item)`） | ⭐ 分组的物理基础：既有出图链路 `deliverSupplierImages` → `supplierReportGroups` → `supplierSplitService.groupItemsBySupplier` **按 `draft.items[*].supplier_record_id` 分桶** ⇒ 每行自带自己的供应商就分成几组 ✓（**复用，不另造第二套** ✗） |
| ⑨ | `returnStockApplied` 日志 | `{task_id, batch_no, size, quantity, doc_id, …}` | 多一个**只读**键 `product_record_id` | 多货品时那一行是哪个货品要能一眼看出（写入类日志带关联键的口径 ✓） |
| ⑩ | `returnPlanFrozen` 日志 | `{task_id, batch_no, declared_count, taken_count, shortfall, sizes}` | 多三个**只读**键：`row_identity` · `supplier_count` · `supplier_missing`（＋ `behavior_source`） | 排查"这次是不是多货品 / 几家拿到了供应商"——**不猜**（拿不到就是拿不到 ✓） |

🔴 **单货品 ⇒ 与今天逐字一致**（硬红线）：判据是 `needsRowIdentity(items, draft)` ——
**批次级有货品 且 逐行只有一个货品** ⇒ 上面 ②③⑥⑧ 全部走**老形状**；
`test/purchaseReturnMultiItem.test.js` 的 **AC-RS2 / AC-RS2b** 逐字钉着它（计划键集 / 明细幂等键 /
`drawItems` 的 7 个键 / 图 1 张 · 单据 1 张 · 群消息 2 条）。

---

## 4. 判据（**先写后做**；`server/test/purchaseReturnMultiItem.test.js`，9 条全绿）

| # | 判据 | 断言什么（**都能真红** ✓） |
| --- | --- | --- |
| **AC-RS1** | 一单退货 **2 个货品（不同供应商）** ⇒ 出单**按供应商分成 2 组** | **真链路**：扫码页 POST（hidden `multi_items`）→ 真路由 → 真引擎 → 真写入件 → 真 `deliverSupplierImages`；主表**只 1 行**（号源只取 1 次）· 2 行明细各带**自己的**货品、都挂同一个批次行 · **2 张图**、每组只含该供应商的行 · 「单据」2 张（`documentFileNameOf`）· 群消息 4 条 · 批次行「采购行为」= 退货那一档 · 两张图共用**同一个批次号** |
| **AC-RS2** | **单货品退货 ⇒ 与今天逐字一致** | `shortfalls` 逐字 5 个键（`deepEqual`）· 计划**不多**任何键（`plan.items` deepEqual）· 明细幂等键 `purchase_return_doc:{taskId}:41` 逐字 · 主表 1 / 单据 1 / 图 1 / 群消息 2 / 号源 1 |
| **AC-RS2b** | 同上，但走**真链路**（扫码页 POST，不带 hidden 多货品载荷） | 递给出图那一步的 `draft.items` **逐字 `deepEqual`**（7 个键）+ 批次级 `supplier_record_id` 照旧 |
| **AC-RS3** | ⭐ **混供应商不再落到「未标注供应商」** | 载荷逐字 = 引擎 `planSubmission` 给的那份（**逐行供应商是空的** ✓）；提交后出图**分成 2 组**、组名 = 表里那两家、**没有任何一张标着「未标注供应商」**；「货品信息」**零写入** · 明细不写公式列「供应商」· 主表不写 SingleLink「供应商」 |
| **AC-RS4** | **幂等**：同一组重复 ⇒ **图 +0 · 群消息 +0 · 附件 +0** | 重放同一个 task（同一份冻结计划）⇒ 渲染 0 次新增 · 群消息 0 条新增 · 上传 0 次 · 「单据」还是 2 张 · 库存不重复扣 · 主表不增行 · 号源不再取 |
| **AC-RS4b** | **探针**：AC-RS4 不是空跑 | 手动把「单据」里**乙供应商**那张图拿掉 ⇒ **必须只补那一组**（甲那组不再重出） |
| **AC-RS5** | **库存**：多货品退货 ⇒ 扣库存**逐条正确** | 4 双（A 41×2 / A 42×1 / B 41×1）⇒ 实时库存**一条不剩**、库存流水**三条**逐条数量正确（`prod_A\|1` / `prod_A\|2` / `prod_B\|1`）· 明细 3 行逐行正确 · 采购明细ID **不重号** |
| **AC-RS6** | 🔴 **冻结件逐字节没动** | `services/scanWriteService.js` 的 sha256 = `199551e1…35ca`（与 main 一致 ✓）＋ `chains.return.writer === 'purchaseReturn'` ＋ 分组口径仍是 `same_batch_no` |
| **AC-RS6b** | 🔴 退货 service **不直连写库**、分组**只用那一处** | 源码哨兵：无 `gateway.update/delete(`；复用点齐（`applyPurchaseReturn` / `createOnceByKey` / `createForReturnBatch` / `deliverSupplierImages`）；**剥掉注释后**不出现「未标注供应商」（不另造第二套口径 ✗） |

**变异（每组都真跑过：改一处 ⇒ 指定用例红；改回来 ⇒ `shasum -c` 逐字节一致 ✓）**：

| 组 | 那一处改成什么 | 谁红 |
| --- | --- | --- |
| ① | `ensurePlan` 的可用量退回**批次级** `draft.product_record_id`（= 改前逐字） | **AC-RS1 / RS3 / RS4 / RS4b / RS5**（AC-RS2 仍绿 —— 单货品那条路靠"同一行代码 + 同一个值"成立 ✓） |
| ② | `drawItems` 的 `supplier_record_id` 退回**批次级**（= 改前逐字） | **AC-RS1 / RS3 / RS4 / RS4b**（这就是 AC-RS3"退回旧写法 ⇒ 红"那一条 ✓） |
| ③ | 明细幂等键去掉货品（`…:{taskId}:{size}`） | **AC-RS1 / RS4 / RS5**（两个货品同尺码撞键 ⇒ 静默少一行 ✓） |
| ④ | 批次行「采购行为」不回落到计划里冻结的那一个 | **AC-RS1**（`采购行为` 空 ⇒ 红 ✓） |

**两遍数字与自证**（在**最新 `origin/main` = `b24a046`** 上跑的）：

| | 命令 | 结果 |
| --- | --- | --- |
| 第 1 遍 | `CI=true pnpm test`（系统 node `/usr/local/bin/node`，与 CI 的 Node 20 同一档） | **tests 2940 / pass 2933 / fail 0 / skipped 7 · EXIT=0** |
| 第 2 遍 | 同上 | **tests 2940 / pass 2933 / fail 0 / skipped 7 · EXIT=0** |
| 依赖门禁 | `pnpm audit --prod --audit-level=high` | 见 PR 的 CI（与 `pnpm test` 同一个 job ✓） |

- 两遍之间 `git diff | shasum -a 256` **完全一致** ✓（`c5eae447…ae0c6`）；
- 7 个 skip 是**既有**的（缺 `FEISHU_V1_E2E_TEST_APP_TOKEN` 的 E2E / 两个"第 3 步才启用"的源码哨兵 /
  收款方式表那三条）—— 本卡**没有新增任何 skip** ✓。

---

## 5. 边界（**没做**的事，如实标 ✓）

- 🔴 **不碰 `services/scanWriteService.js`**（余量 0 的冻结件）：`sha256` 与 main **逐字节一致** ✓（AC-RS6）。
- 🔴 **不碰 `config/scanWrite.js` / `views/**` / `config/supplierSplit.js` / `services/supplierSplitService.js`**
  —— 分组那一套**直接用已经进 main 的那一份** ✓（本卡一行都没改它们）。
- 🔴 **没加任何列、没改表结构**；**没写生产 Base**（本卡全是单测，零真表调用 ✓）；**未部署** ✗。
- ⚠️ **未做（如实标）①：退货出图在**线上**还没接线** —— 核到的事实：
  `purchaseReturnService` 的 `webhooks` 只有 **用例**注入（`test/scanPurchaseReturn.test.js` 的 AC-R10 等），
  **生产接线一处都没有**（`routes/scanPage/index.js` → `createScanWriteService({gateway, config})`
  没给 `purchaseReturnOptions`；全仓 `purchaseReturnOptions` 只有 `scanWriteService.js:235` 那一处读取点）
  ⇒ 线上退货那一步**永远**走 `returnImageFailed` 的 `reason: 'no_image_pipeline'`（只记一条 warn、图不发）。
  ⭐ 这是**本卡之前就存在**的缺口（单货品那条路同样受影响），**不是**多货品引入的；
  修它 = 给那条链接上真的 `PurchaseWebhookService`（一行量级的接线，但**改动线上行为**）
  ⇒ **超出本卡写作用域**（`scanWriteService.js` 冻结 / `routes/*` 有"不许出现写链路服务名"的既有哨兵）
  ⇒ **停手报 Lead**，本卡**没有动它** ✗。
  判据侧的影响：AC-RS1/RS3/RS4 用的是**真的** `deliverSupplierImages`（注入成 `webhooks`，与 AC-R10 同一种做法）
  ⇒ "分成几组 / 每组哪些行 / 幂等"这三件事**都真跑过** ✓；**"线上会不会真的发出去"取决于上面那一处接线**。
- ⚠️ **未做（如实标）②：多货品退货"一双都退不成"时引擎仍会给她成功页** ——
  写入件如实返回 `skipped: 'no_stock'` 且**零写入** ✓，但
  `services/multiItemOrderService.js` 的 `submitDraft` **只看写入件抛不抛**（不看返回值）⇒ 草稿被标 `submitted`。
  单货品那条路不受影响（`scanWriteService.submitPurchaseReturn` **会**看 `skipped` ⇒ 给人话 ✓）。
  修它要动**共用引擎**（补货那条链也在用）+ 路由的失败出口 ⇒ 与补货侧的行为一起判 ⇒ **本卡没动**，报 Lead ✗。
  判据侧：本卡 AC-RS5 覆盖的是"库存够 ⇒ 逐条正确"，**没有**把这一条钉成"已修" ✓。
- ⚠️ **未做（如实标）③：补货侧同一条形状** —— 核到 `publishPurchaseRequest` 那条（引擎）载荷里
  `supplier_record_id` 同样是空的（扫码页不给），所以**扫码页的多货品补货**也会落进
  「未标注供应商」那一组（供应商报单那条入口不受影响：草稿里逐行带着供应商 ✓）。
  这与本卡**同源**（"每行的供应商从哪来"），但落在**补货**那条链上 ⇒ 不在本卡写作用域，报 Lead ✗。
