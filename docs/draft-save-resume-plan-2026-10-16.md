# 补货 / 退货 / 销售「存草稿 · 后续接着录」—— 只读核查 + 设计 + 判据草案（2026-10-16）

---

## ⭐⭐ 追加（业务负责人 2026-10-16 当天又两条 · **覆盖下面第 2/3 节的猜测** ✓ 以本节为准）

> 来源：Lead 的两页便条 `.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`
> （**便条本身不进 git** —— 它们是 Lead 的未提交工作记录 ✗）。业务负责人的话（逐字）：

> 「我们的**销售货品页上面也需要加一个按钮，叫「存报货草稿」**，我在我们的**采购主表**里面，
>  在「**到货状态**」中加了一个选项，叫做「**未报货**」，也就是我们的**草稿状态**。
>  然后**什么时候是从「未报货」到「未到货」**呢？就是**我们生成了这样一个报货的单子**。」

> 「只要是我们的**草稿**，只要核对到我们的**采购主表**里面还有**未报货**的记录，那么我们创建的这些草稿，
>  都要**归到这个报货批次号**里面。……**1. 批次号逻辑**：系统需要看一下在我们的采购主表里面，
>  **有没有未报货的批次号**。(a) **如果有，就沿用这个未报货的批次号**。(b) **如果没有，就新建一个批次号**。
>  **2. 供应商拆分逻辑**：在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
>  需要**按照供应商进行拆分和分组**。」

### 结论①：**不需要新加列** ✗ —— 下面第 2.3 节建议的 `数据状态` 列**作废**

- 她已经在**生产**「采购主表」的**「到货状态」**里加了第三个选项 **「未报货」** ✓
  （Lead 已用项目代码/SDK **只读**核到：生产选项 = **未到货 / 已到货 / 未报货**）。
- ⇒ **草稿 = 「采购主表」的一行，`到货状态 = 「未报货」`**，**不需要任何新列** ✓。
- ⚠️ **测试 Base 当时还没有这个选项**（仍是 未到货/已到货，这就是本文档第 2.2 节读到"只有两个"的原因）
  ⇒ **已补**（本刀只写测试 Base ✓ 走项目代码 + 官方 SDK、**没用飞书 CLI** ✗）：
  `采购主表.到货状态.options = ["未到货","已到货","未报货"]`（`field_id=fldErx7uUU`，实测回读 ✓）。
- ⚠️ 因此下面第 2.3 节整节、以及第 9 节的 **Q3**（请她加列）**都已作废** ✗ —— 保留原文只为留痕。

### 结论②：⭐ **供应商拆分是她的硬口径**（下面第 3 节当时没覆盖 ✗ ⇒ 补在这里）

| 问题 | 口径 | 落在哪一步 |
| --- | --- | --- |
| 一个未报货批次号下能不能混多个供应商？ | **能**（草稿阶段就是混的 ✓） | **存草稿**（本刀 S1：草稿行只记 `supplier_record_id`，**不拆** ✓） |
| 什么时候拆？ | **「生成报货单」那一下** | **S3**（本刀 S1 **不生成报货单** ✗） |
| 拆出来是几条单 / 几个批次号？ | ⭐⭐ **她 2026-10-16 已拍板：ⓐ「同一个批次号下按供应商分组」** ✓（**不是** ⓑ"每个供应商各开一个新批次号"✗）——**成对迁移**：<br>改前逐字：`supplierSplit.batchNoPolicy: 'undecided'`（S1 如实标未决，见第 9 节 Q7）<br>改后逐字：从 `config/supplierSplit.js` 读 ⇒ `'same_batch_no'`（真源在那边，本文件不抄第二份 ✗）<br>依据：她 2026-10-16 拍板 ⓐ（`docs/pending-confirmations.md` ② 的答案）| **已落地** ✓ —— 见 `docs/supplier-split-at-generation-2026-10-16.md`（生成那一步：`ensurePostingPlan` 冻结 `plan.supplier_groups`，**主表只 1 行**、号源只取 1 次；出图每组一张、重复生成只出一次）|

### 结论③：草稿生命周期（**按她这两条逻辑重画** ✓ 取代下面第 5 节那张表里的旧设）

```
① 存草稿（销售货品页 / 补货页 / 退货页 三处入口 ✓ 销售页那颗她点名叫「存报货草稿」✓）
   → 看「采购主表」有没有 `到货状态 = 「未报货」` 的**批次号**
     (a) 有 ⇒ **沿用** ✓（她的草稿归到同一个批次号 ✓）  (b) 没有 ⇒ **新建** ✓
   ⚠️ 并发：多个草稿同时"都没有"⇒ **不许各建一个新号** ✗ ⇒ **整段串行**（本刀 S1 已落，判据 AC-D7 ✓）
② 接着录（进去就提示 ✓ 她先前定的 ✓）
③ **生成报货单** ⇒ ⭐ **按供应商拆分/分组** ✓ ＋ **`未报货` ⇒ `未到货`** ✓（她先前的口径 ✓）
④ 三个副作用**只在"生成报货单"那一下**才发生（发群 / 出图 / 写库存）✓；**存草稿阶段一个都不许发生** ✗
   ⚠️ 「批次号对应供应商」也在③：**存草稿阶段就要出号**（她 ① 的口径），但**出号 ≠ 发群/出图/写库存** ✓
```

### 结论④：S1（**独立存储层**）已落地 —— 改前 → 改后

| 改前（本文件第 3 节的设计） | 改后（S1 实现） | 依据 |
| --- | --- | --- |
| 草稿落点 = 「采购主表」+ **新列 `数据状态=草稿`** | 草稿落点 = 「采购主表」+ **既有 `到货状态=「未报货」`**（**不加列** ✗） | 她 ADDENDUM-2 逐字（结论①） |
| 草稿本地存储"与会话共用一份"的候选 | **新建独立目录 `data/scan_drafts/`**（`JsonTaskStore` 形状 ✓，与会话**分开 TTL**） | 她「不会在当下想好」⇒ 12h 会话 TTL 太短；且会话过期会 `freshSession()` 丢 `orders` ✗ |
| 批次号"提交时才取号" | **存草稿时就定号**：有未报货的号 ⇒ 沿用；没有 ⇒ 新建（**整段串行**） | 她 ADDENDUM-3 第 ① 条逐字 |
| 供应商只在草稿里记着 | 同上 ＋ **拆分明文留到 S3**（`supplierSplit.batchNoPolicy='undecided'`） | 她 ADDENDUM-3 第 ② 条 + Lead："拆成几单要列成问题问她" ✗ |

⚠️ **上面这一节与下面正文冲突时，一律以本节为准** ✓（正文是**只读核查当时**的记录，留作历史）。

---

> **本步性质**：**只读核查 + 设计文档**（`docs/**`）✓ —— **`server/src/**` 一个字未改** ✗、
> 不碰 `config/scanWrite.js` / `routes/**` / `views/**` / `public/workbench/**` ✗、
> **未部署** ✗、**未动生产 Base**（只在测试 Base 上跑了一次只读字段探测）✓。
> **实现阶段由 Lead 排期**（本文件第八节给出建议顺序与依赖）。

> **本文件读代码的基线提交**：`4ed0d29`（= `origin/main`，已在 worktree `.local/draft-plan` 里核过
> `git rev-list --count HEAD..origin/main == 0`）。
> ⚠️ **同时如实记一个现场事实**：核查时**主工作区**停在 `90434bb`、比 `origin/main` **落后 7 个提交**
> （违反 AGENTS.md 第 9 条）⇒ 本文件所有"文件:行"**以 `4ed0d29` 为准**；
> 二者差异里与本需求相关的一条是：`4ed0d29` 带「加/删货那一半」的**草稿暂存 + POST 接住者**
> （`scanPage.js:334/346/362/1722`），而更早的 `0d80330` 那条支线没有它。
> ⇒ 核查结论按 `4ed0d29`（**较新的那一份**）写。

---

## 0. 她的话（逐字 · 本文件全部口径的唯一来源）

> 「我们的**补货和退货需要支持存草稿功能**。也就是说，我需要能先把信息存到**草稿**里。
>  因为我**往往不会在当下把所有要补或要退的货一次性想好**，所以需要支持**存草稿后续再处理**，
>  你看一下这个怎么处理？」

Lead 弹窗问到的三条（逐字，**按这个做**）：

```
① 草稿存哪   ⇒ 「存到飞书表里（带"草稿"状态）」
② 怎么找回   ⇒ 「进去就提示，接着录」（再进补货/退货页 ⇒ 顶部提示"你有一份草稿，接着录吗？"）
③ 同时几份   ⇒ 「只留一份当前草稿」
   ⚠️ 但同一次对话里她前一句说「补货往往分几个供应商」✗ 却选了"只留一份"
      ⇒ 可能**没注意到"第二份会覆盖第一份"** ⇒ **做成配置开关**
        `draftScope: 'single' | 'per_supplier'`，**缺省 `single`**（按她选的）
      ⇒ 她改主意**不用重写**；**不替她决定成 `per_supplier`** ✗
```

---

## 1. 现状核查①：今天的草稿链路怎么工作（文件:行）

### 1.1 引擎：`services/multiItemOrderService.js`（「一单多货品」草稿 + 批量提交）

| 能力 | 位置 | 说明 |
|---|---|---|
| 开草稿 | `:102 openDraft` | 键 = `` `${chainConfig.orderKeyPrefix}:${sessionId}:${seq}` ``（`:110`） |
| 加货 | `:134 addItem` | 同货品**覆盖**那一件（`:143`–`:154`）；写进 `session[ordersField][orderKey].items` |
| 改行 | `:163 setEntries` | 按 `productRecordId` 替换 `entries` |
| 删货 | `:179 removeItem` | 按 `productKeyOf` 过滤 |
| 读草稿 | `:124 readDraft` | 读不到 ⇒ `{ok:false, code:'draft_missing'}` |
| 校验 | `:200 validateDraft` | **纯函数**：尺码/数量/重复行/上限/退货库存 `cap+report` |
| 算载荷 | `:291 planSubmission` | 1 批次 + N×M 明细；明细幂等键 `purchase_request:{taskId}:{productKey}:{size}` |
| 提交 | `:361 submitDraft` | 幂等：`status==='submitted'` ⇒ 直接还结果（`:373`）；成功后 **`orderKey` 轮换**（`:446`–`:451`） |

草稿**形状**（`emptyDraft`，`:83`–`:99`）：

```js
{
  chain, open_id, created_at, updated_at,
  submit_key: orderKey,        // ⭐ 幂等键 = 本单的 orderKey（不是表单里的 submit_key）
  order_key: orderKey,
  items: [{ product_record_id, number, item_no, color, supplier_record_id,
            entries: [{ size, quantity }] }],
  order_amount: '',            // 退货必填（`chains.return.amountRequired`）
  batch_record_id: '', batch_no: '', detail_ids: [],
  status: 'draft',             // 配置 `config.session.draftStatus`
  chain_prefix: 'scan_replenish' | 'scan_return',
}
```

**两条链只差配置**（`config/multiItemOrder.js` 的 `chains`，`:118`–`:180`）：

| | 补货 `replenish` | 退货 `return` |
|---|---|---|
| `orderKeyPrefix` | `scan_replenish`（`scanWrite.js:428` 的 `SCAN_REPLENISH_KEY_PREFIX`） | `scan_return`（`:458`） |
| `taskIdPrefix` | `scan_replenish`（`scanWrite.js:429`） | `scan_return`（`:467`） |
| `behaviorCode` | `PURCHASE_ORDER`（`:426`） | `PURCHASE_RETURN`（`:465`） |
| `defaultQuantity` / `maxQuantity` | 1 / 99（`:439` / `:437`） | 1 / 99（`:476` / `:474`） |
| `amountRequired` | `false` | `SCAN_PURCHASE_AMOUNT_REQUIRED`（缺省 true） |
| 明细带「采购行为」 | 是（`payload.withBehavior`） | 否 |
| writer | `writers.purchase` → `purchaseWebhookService.publishPurchaseRequest` | `writers.purchaseReturn` → `purchaseReturnService.submit` |

上限：`maxProducts = 20`、`maxLines = 50`（`config/multiItemOrder.js:33`–`:34`，`SCAN_MULTI_ITEM_*`）。

### 1.2 会话：`services/scanSessionService.js` + `infrastructure/jsonTaskStore.js`

| 事实 | 位置 | 结论 |
|---|---|---|
| 会话 id = `scan_session_` + `sha256(open_id)` 前 16 位 | `scanSessionService.js:40` | **按人**（不按货品）⇒ 扫 A / 扫 B 是**同一份本单** |
| 落盘目录 | `config/scanWrite.js:252` `data/scan_sessions/`（`SCAN_SESSION_DIR`） | **本机 JSON**，一文件一人 |
| **TTL** | `config/scanWrite.js:267` `SCAN_SESSION_TTL_MS` 缺省 **12 小时**（60s ~ 7 天） | ⭐ **草稿的生死线** |
| 过期语义（`ensure`） | `scanSessionService.js:114`–`:130` | 过期 ⇒ **`freshSession()` 新建一份空的**（`:57`）⇒ **`orders` 整段丢掉** ✗ |
| 续期（`touch`） | `:146` | 每次 `store.update` 都把 `expires_at` 推到 now+TTL |
| 续上（`revive`） | `:177`–`:205` | **只用于"提交"**：原样保留 `sale`/进度，只延 `expires_at` + 采纳她手上的键 |
| 写互斥 | `jsonTaskStore.js:59 _serializeWrite` | 同 id 的读-改-写串行（不同 id 互不影响）✓ |

> ⚠️ **已只读核对本机真实会话文件**（`server/data/scan_sessions/scan_session_057836b3ffaf7504.json`）：
> 它**没有 `orders` 字段** —— 也就是说「一单多货品草稿」这段结构**在本机从未被写过**
> （与下面 1.4 的结论一致：它今天的入口是关着的）。

### 1.3 路由半：`routes/scanPage.js`（已有的「加/删货暂存」，**今天还是关着的**）

- 「已加货品」暂存：`session.orders['<chain>:pending']`，形状 `{ orderKey, items }`
  —— 读 `:334 readMultiItemPending` / 写 `:346 writeMultiItemPending` / 清 `:362 clearMultiItemPending`；
  ⚠️ **键与引擎那份不同**（引擎用 `orderKey`，暂存用 `<chain>:pending`）⇒「同一容器、两个键」。
- 喂渲染层：GET 里 `view.multi_items = pending.items`（`:1627`，**只在补货/退货两块**）。
- 加/删货的 **POST 接住者**：`:1722`–`:1771`（`isMultiItemAdd` / `isMultiItemRemove` ⇒ 写暂存 ⇒ **303 PRG**）。
- 🔴 **今天不可达**：那两个动作只在 `multiItemWire` 非空时才认（`:1689`）+ `:2719` 附近的 `wireAddAction` 判定，
  而 `multiItemWire` 缺省 `null`（`:272`–`:274`），由 `SCAN_MULTI_ITEM_ADD_WIRE` 打开
  （`config/multiItemOrder.js:54`，**缺省 `false`**）；`.env` / `.env.example` 里**都没有这个键**。

### 1.4 ⭐ 今天的草稿到底"存"了什么：**只在"提交那一瞬"才有草稿** ✗

| 事实 | 位置 | 后果 |
|---|---|---|
| `openDraft` / `addItem` **只被 `submitMultiItemOrder` 调** | `scanPage.js:380`–`:410`（`openDraft` 在 `:392`） | 页面**打开时零草稿**（`openDraft` 不在 GET 里 ✗） |
| `submitMultiItemOrder` 只在 **`groups.length > 1`** 时进 | `scanPage.js:2881`（补货）/ `:2975`（退货） | **N=1 走老路径**：`scanWriteService.submitReplenish` **当场校验 + 当场出单**，`picked` 为空即 400（`scanWriteService.js:1394`–`:1401`） |
| 老路径的"草稿"= 表单里那一个 hidden `multi_items` | renderer `multiItemBlockHtml`（`:1321`） | **只活在这一次请求里**；刷新/换设备就没了 ✗ |
| 「已加货品」暂存虽在会话里，但入口开关关着 | 见 1.3 | 今天**加不出来第二件** |

⇒ ⭐ **结论（重要，避免把"已有"说过头）**：
**"会话里的 `multi_items` 草稿"这句描述需要订正** —— 引擎**有**草稿能力（正是我们要复用的 ✓），
但**今天没有任何一条可达路径会去写它**；而**能写的那条路（加/删货暂存）入口是关的**，
且它写的是**另一个键**（`<chain>:pending`）。
⇒ 本需求真正要做的是：**把草稿从"提交时的一次性中间态"变成"可存、可找回、可继续"的一等公民** ✓

### 1.5 单货品那条老路径（`services/scanWriteService.js`）—— 与本需求的关系

- `:1346 submitReplenish`：`queue.run('sale:'+openId)` ⇒ 校验 ⇒ 组 `draft`（`is_batch:true` + `items`）
  ⇒ `publishPurchaseRequest()` ⇒ `completeReplenish`（轮换 `replenish.key`）。
- `:1513 submitPurchaseReturn`：同形；`orderAmount` 落「采购主表.实际金额」。
- 两条都有**指纹幂等**（`replenishFingerprint`，`:1338`）：同一份草稿连点 = 复用；**换了内容 = 新的一次**。
- 它们**只在提交时被调用**（`scanPage.js:461` / `:471` 的 `runRest`）—— **没有任何"保存"入口** ✓。

---

## 2. 现状核查②：「草稿」落在哪张表哪一列

### 2.1 今天补货 / 退货各自写进哪里（只读核对）

**补货**（`purchaseWebhookService.publishPurchaseRequest` `:587` → `confirmPurchaseRequest` `:1575`）：

| 落点 | 写什么 | 位置 |
|---|---|---|
| 采购主表 `purchaseOrderBatch`（真表名「采购主表」`tblwezby9wRea9qi`） | `batchNo` / `idempotencyKey = purchase_batch:{taskId}` / **`arrivalStatus = 未到货`** / `quantity`(录入数量) / `behavior` | `:1607`–`:1624` |
| 采购明细 `purchaseRequest`（真表名「采购明细」`tbli1ygPtss5CWCH`） | `batchNo`(关联) / `product` / `size` / `quantity` / `detailId`(`{批次号}-01`) / `idempotencyKey = purchase_request:{taskId}:{idx}` | `:1648`–`:1678` |
| 副作用 | ① 出图 `deliverSupplierImages` ② **发采购群 @经办人** ③ 回填「单据」附件 | `:1723` 起 |

**退货**（`purchaseReturnService.submit` `:118` → `orderBatches.createForReturnBatch` `:132`）：

| 落点 | 写什么 | 位置 |
|---|---|---|
| 采购主表 | `batchNo` / `idempotencyKey = purchase_batch:{批次号}` / `behavior`(退货档) / `quantity`(录入数量=taken 合计) —— ⚠️ **不写「到货状态」** | `purchaseOrderBatchService.js:151`–`:167` |
| 采购主表（再一次 update） | **`actualAmount` = 整单金额**（她 2026-10-15 裁决ⓐ） | `purchaseReturnService.js:185` → `purchaseOrderBatchService.writeOrderAmount` |
| 采购明细 | 每码一条：`batchNo` / `product` / `size` / `quantity = taken` / `detailId` / `idempotencyKey = purchase_return_doc:{taskId}:{size}` | `:208`–`:229` |
| 库存 | `inventory.applyPurchaseReturn`（**真的扣库存**） | `:230`–`:241` |
| 副作用 | ① 出「采购退货单」PNG ② **发采购群** ③ 回填「单据」 | `:266`–`:281` |

### 2.2 两张表今天**真实有**哪些列（只读探测，测试 Base）

> 用法（项目自己的只读接口，**不用飞书 CLI**）：
> `node server/scripts/list-v1-fields.js purchaseOrderBatch purchaseRequest`
> ⚠️ 本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` == `FEISHU_V1_E2E_TEST_APP_TOKEN`
> ⇒ **读到的只是测试 Base**；生产真表要在**服务器上**跑同一个脚本（见第七节待办）。

**采购主表（测试 Base，14 列）**：
`报货批次号`(Text·主字段) · `报货日`(**AUTO** CreatedTime) · `幂等键`(Text) · `到货日`(**AUTO** ModifiedTime)
· `到货状态`(**SingleSelect：未到货 / 已到货** —— 实测 options 逐字这两个 ✓) · `单据`(Attachment)
· `采购行为`(SingleLink) · `供应商`(SingleLink) · `验收人`(**AUTO** CreatedUser) · `录入数量`(Number)
· `实际数量`(Number) · `实际金额`(Number) · `采购明细`(DuplexLink) · `库存流水`(DuplexLink)

**采购明细（测试 Base，10 列）**：
`采购明细ID`(Text·主字段) · `采购行为`(**Lookup —— 只读，代码不许写**) · `编号`(SingleLink) · `尺码`(SingleLink)
· `数量`(Number) · `供应商`(**Formula —— 不写**) · `幂等键`(Text) · `更新时间`/`报货日`(**AUTO**)
· `报货批次号`(DuplexLink)

### 2.3 ⭐ 结论：**没有一列语义上等于「草稿」** ⇒ 需要她加一列（一句话在下面）

逐个候选看过，**都不能直接当"草稿标记"用**：

| 候选列 | 能不能直接用 | 为什么 |
|---|---|---|
| `到货状态`（单选：未到货/已到货） | ✗ 不推荐 | 它的语义是**到货情况**（她 2026-10-07 逐字：「主要控制的是该批次的到货情况」）。塞第三档「草稿」= **污染到货口径**；⚠️ 而且往单选写新值飞书会**自动建选项**（AGENTS.md 第 11 条① 的真实事故形态）。**除非她本人说"就加在到货状态里"**。 |
| `幂等键`（Text） | ✗ 不可靠 | 它的键空间已被 `purchase_batch:*` / `purchase_request:*` / `purchase_return_doc:*` 占着；草稿**没有批次身份** ⇒ 拿它当标记要另编前缀，且草稿一旦获号就会**变成真的批次行**（她反对的"假成功"）。 |
| `录入数量` / `实际数量` / `实际金额` | ✗ | 是业务数字；草稿期还没定数。 |
| `单据`(附件) / `采购行为` / `供应商`(关联) / `采购明细`(双向关联) | ✗ | 类型不对，且会触发下游读方。 |
| 采购明细侧（`数量`/`幂等键`/…） | ✗ | 采购明细**行 = 已经出单的明细**；草稿塞进去会被工作台查询与对账读到。 |

⭐ **她只需在「采购主表」（`tblwezby9wRea9qi`）上做一件事（一句话）**：

> **在「采购主表」里新增一列 `数据状态`（单选），选项只加两个：`草稿`、`已提交`；
>  并给这一列设默认值 `已提交`**（这样今天所有历史行与今后正常出单的行都自动是"已提交"，
>  只有我们显式写 `草稿` 的才是草稿）。

（备选：类型用 **Checkbox「草稿」** 也行 —— 勾上=草稿，不勾=正常。单选更利于她后来加"已作废"之类的档。）

⚠️ **本步不写生产表** ✗：加列由她做；加完我们**只**同步 `config/v1BitableSchema.js` 一行映射
＋ 跑一次 `pnpm run v1:schema-check:purchase`（那是对着真表的闸门）。

---

## 3. 设计方案（三条口径都按她答的做）

### 3.1 存哪（她答：**飞书表 + "草稿"状态**）

> 🔴 **本小节的两条已被上面的追加覆盖** ✗（留痕）：
> · 落点**不是**新列 `数据状态`，而是**既有**「到货状态 = 「未报货」」（她 ADDENDUM-2 逐字）；
> · 草稿行**不是"批次号留空"**，而是**存草稿时就定号**（有未报货的号 ⇒ 沿用；没有 ⇒ 新建 ✓
>   —— 她 ADDENDUM-3 第 ① 条）。
> ⚠️ 「幂等键用 `draft:{chain}:{sessionId}:{seq}`」也已改成 **`scan_draft:{sessionId}:{bucket}`**
>   （前缀独立 ⇒ 不与 `purchase_batch:*` 撞 ✓；`bucket` 在 `single` 下就是 `single` ✓）。

**双写，且以本地为准**——两个落点各司其职，别混：

| 落点 | 存什么 | 谁读 | 为什么两个都要 |
|---|---|---|---|
| **A. 本地会话/独立文件**（`data/scan_drafts/` 新建一个 `JsonTaskStore`，**不与会话共用 TTL**） | **完整草稿**（形状 = 引擎 §1.1 那份 `items` + `order_amount` + `orderKey`） | **服务端**（渲染"接着录"、校验、提交幂等） | 提交要的是**结构化、可续写**的一份；表里的东西不可靠到能当提交依据（并发/回读延迟） |
| **B. 采购主表一行**（`数据状态 = 草稿`，批次号留空 / 幂等键用 `draft:{chain}:{sessionId}:{seq}`） | **给她看的快照**：供应商 + 每货品每尺码的数量 + 整单金额（退货）+ 更新时间 | **她**（在 Base 里直接看/接着录） | 这就是她那句「存到飞书表里」；也是"换手机也能看到"的另一条腿 |

**为什么草稿行要写进「采购主表」而不是「采购明细」**：
① 她说的是"存到飞书表"（单头那一行**一眼看得完**，明细要展开）；
② 明细行 = **已经出单的明细**，塞草稿会让工作台查询/对账读到"不存在的采购事实" ✗；
③ 主表那一行天然带「供应商」（她已经在这张表上有 `供应商` 列，`v1BitableSchema.js:462` 注释：**只读不写**）
—— ⚠️ 注意：那一列**代码今天不写**，草稿要写它的话**要么破例、要么不写供应商**（见第六节 Q3）。

**草稿行的"零副作用"四条**（见 §5）：不建明细、不加库存、不出图/不发群、不占批次号。

### 3.2 状态怎么标（不参与统计、不触发发群 / 写库存）

> 🔴 **本小节的取值已被上面的追加覆盖** ✗（留痕）：草稿行写的是 **`到货状态 = 「未报货」`**
> （她的原话："也就是我们的草稿状态"），**不是** `数据状态 = 草稿`、**也不是**"到货状态留空"。
> ⇒ 下面那两条推论（"到货状态空 ⇒ 9 点推送捡不到"）**按新取值重核**：
> · 9 点推送的候选是 `到货状态 == 未到货`（`purchasePendingBatchService:135`）
>   ⇒ `未报货` **同样不在候选里** ✓（**判据要钉住它**：谁把候选改成"按数据状态"就要重核 ✓，
>   落点 = `test/scanDraftSaveResume.test.js` 的 AC-D1/AC-D6 那一组 ＋ S2/S3 时的 `AC-DR8`）；
> · 工作台查询那条（Q5）**仍待她拍**。

- 草稿行：`数据状态 = 草稿`，`到货状态` **留空**（**不写**「未到货」✗ —— 写了就进"未到货"口径）。
- **已核对：草稿行不会被 9 点推送捡走** —— `purchasePendingBatchService` 的候选是
  `equalsFormula(到货状态, 未到货)`（`:135`，`pendingStatus` `:65`）⇒ 草稿行（到货状态空）**不在候选里** ✓
  （⚠️ 这是**现有代码的巧合保证**，实现时要**补一条判据钉住**，见 §7 AC-DR8）。
- 工作台查询（`purchaseQueryService` `:97`/`:151`）**会**读到这一行（它按批次号/到货状态投影）
  ⇒ 要么在读取处**按「数据状态 ≠ 草稿」过滤**，要么接受"工作台可能看到她自己的草稿行"。
  🔴 **这条要她拍板**（第六节 Q5）。
- 提交那一刻：把草稿行「数据状态」改成 `已提交` **或**把它置为「已作废」+ 另建正常批次行
  —— ⚠️ 建议**后者**（批次号/幂等键是**业务事实的标识**，草稿行不是事实，不该升格成事实）
  ⇒ **待她拍**（第六节 Q6）。

### 3.3 找回（她答：**进去就提示，接着录**；不点就正常新建）

今天补货 / 退货的**唯一入口**是货品页：`GET /s/:number?from=replenish`（`scanPageRealm.js` 的 `REPLENISH_REALM`）
与 `?from=purchase_return`（`PURCHASE_RETURN_REALM`）—— **没有** `/replenish` 这种独立落地页
（`/accept` 那种只存在于已被拆掉的验收领域，`scanPageRealm.js:60`–`:72` 有记录）。

**方案（改动最小、不动"零 JS"约定）**：

1. GET 渲染时，若该人该链**有草稿** ⇒ 在 **`multiItemBlockHtml` 之前**插一条人话卡
   （文案进配置，**不散写中文** ✗）：
   > **「你有一份没录完的补货草稿（3 个货品 / 5 行，最后更新 10-16 20:31）」** ＋ 两颗粒子：
   > 【接着录】= `<a href="?from=replenish&resume=1">`（GET、纯链接、零 JS）
   > 【不管它，重新开一单】= `<a href="?from=replenish&discard=1">`（⚠️ 需要她拍：见 Q4）
2. **点【接着录】** ⇒ 服务端把草稿读出来 ⇒ **该链的 `multi_items` 渲染成草稿里那几件**
   （当前扫到的这一款**不自动进草稿**；她要加就点「＋ 再加一个货品」）。
3. **不点**（直接扫、直接勾尺码提交）⇒ **与今天逐字一致** ✓（草稿原样留着，不动它）。
4. 草稿的**读写一律不碰业务表**（只有"草稿快照"那一条写入，见 3.1）。

⚠️ **已知取舍（如实写）**：这套"提示"只在**货品页**出现 ⇒ 她**必须先扫一个货品码**才看得到提示。
要"打开应用就有提示"就必须**新建一个落地页/入口**（第七节 Q1）。

### 3.4 只留一份 vs 按供应商（**配置开关**，缺省按她选的）

新增配置（`config/multiItemOrder.js` 或新建 `config/scanDraft.js`，**配置先行** ✓）：

| 键 | 取值 | 缺省 | 语义 |
|---|---|---|---|
| `SCAN_DRAFT_ENABLED` | 显式布尔（`readFlag`，**禁 `\|\|` 兜底**） | `false`（先影子/先关，见第八节） | 总开关 |
| `SCAN_DRAFT_SCOPE` | `single` \| `per_supplier` | **`single`**（她选的 ✓） | 同时留几份 |
| `SCAN_DRAFT_TTL_MS` | 整数（或 `0` = 永不过期） | **待她拍**（第六节 Q2） | 草稿留多久 |
| `SCAN_DRAFT_STORE_DIR` | 路径 | `data/scan_drafts` | 本地草稿目录（**与会话分开**） |
| `SCAN_DRAFT_TABLE_KEY` / `SCAN_DRAFT_STATUS_FIELD` / `SCAN_DRAFT_STATUS_VALUE` | 语义键 / 列名 / 取值 | `purchaseOrderBatch` / `数据状态` / `草稿` | 表侧落点（**她加完列再填**） |

- `single`：键 = `<chain>:<sessionId>` ⇒ **第二次"存草稿"覆盖第一份**。
  🔴 **这正是 Lead 留的疑问**：她说过「补货往往分几个供应商」⇒ 覆盖可能不是她要的。
  ⇒ **实现里必须把"覆盖发生了"这件事留痕 + 在提示条上如实说**
  （例：「（上一次那份补货草稿已被覆盖）」）——**不许静默覆盖** ✗。
- `per_supplier`：键 = `<chain>:<sessionId>:<supplier_record_id>` ⇒ 一个供应商一份；
  但**同一供应商的两份草稿仍会互相覆盖**（与 `single` 同样的边界，只是范围变小）。

---

## 4. 🔴 最大技术约束：**能不能绕开 `services/scanWriteService.js`（余量 0）？**

**结论：草稿这一半能完全绕开 ✓；提交那一半一个字都不用改 ✓（复用既有提交入口）。**

三条依据（都已只读核对）：

1. **会话写入不在 `scanWriteService.js` 里** —— 它在 `services/scanSessionService.js`
   （`store` / `ensure` / `touch` / `revive` / `completeReplenish` …）。
   `scanWriteService` 只是**持有**一个 `sessions` 引用（`:156`，`options.sessions || createScanSessionService(...)`）
   并把它**转出去**（`:1663 sessions,` 与 `:1667 saveDraftLines`）。
   ⇒ 草稿读写可以**直接用 `multiItemOrderService` + 一个新的 `scanDraftService`**
   （注入 `writeService.sessions`，与今天 `routes/scanPage.js:287` 建引擎的方式**同一种注入法**）。
2. **引擎不直连 gateway、不认识飞书表**（`multiItemOrderService.js:16` 的源码哨兵，`:496` 注释）
   ⇒ 草稿的**表侧写入**要落在**新件**里（`services/scanDraftService.js`），
   经 `gateway.create/update` 写「采购主表」——**与 `scanWriteService` 无关** ✓。
3. **提交仍走今天那条路**：`submitDraft` 的两个 writer 就是
   `purchaseWebhookService.publishPurchaseRequest` / `purchaseReturnService.submit`
   （`scanPage.js` 的 `writeService.multiItemWriters()`，`scanWriteService.js:242`–`:248`）
   ⇒ **"接着录完提交"与"一次性录完提交"走同一条写库路径** ✓（这正是 AC-DR5 能成立的物理基础）。

🔴 **唯一可能被迫动它的地方（务必在实现前确认）**：
`scanWriteService.js:1663` 导出的是 `sessions`，`:1667` 是 `saveDraftLines`；
若草稿要**复用老路径的 `replenish.key` / `purchaseReturn.key` 幂等键**（而不是 `orderKey`），
就需要在它里面加"存草稿"的口子 —— **不要走这条** ✗。
✅ **做法**：草稿一律用**引擎那套 `orderKey`**（`multi_item:{sessionId}:{seq}` 同源口径，`config/multiItemOrder.js:59`），
提交走 `submitDraft`；**老路径的 `submitReplenish` / `submitPurchaseReturn` 一行不改、继续服务 N=1 提交**。

---

## 5. ⭐ 幂等 / 不重复出单（草稿绝不能被当成"已提交"二次处理）

三个副作用必须**逐条**说清"草稿阶段绝不触发"：

| 副作用 | 今天在哪触发 | 草稿阶段 | 提交阶段（接着录完） |
|---|---|---|---|
| **① 出图 + 发群通知（@经办人）** | `purchaseWebhookService.deliverSupplierImages`（`confirmPurchaseRequest:1723` 调；退货在 `purchaseReturnService.js:266` 调） | 🔴 **绝不调**（草稿没有 `task`、没有 `batch_no`） | 调（与一次性录完**同一个函数**） |
| **② 写库存** | 补货：到货核对才加（`confirmArrival`）；退货：`inventory.applyPurchaseReturn`（`purchaseReturnService.js:230`） | 🔴 **绝不写** | 与一次性录完相同 |
| **③ 出批次号 / 出单号** | `ensurePostingPlan` 里 `this.nextBatchNo()`（`purchaseWebhookService.js:1560` 附近）/ 退货 `nextBatchNo()`（`purchaseReturnService.js:66`） | 🔴 **绝不取号**（草稿行批次号留空） | 提交时才取号（**取号唯一时机不变**） |

**幂等的三层安排**：

1. **草稿阶段**：写草稿是**幂等覆盖**（同键 ⇒ 覆盖，不产生第二份；`single` 下必然覆盖）。
   草稿行用 `idempotencyKey = draft:{chain}:{sessionId}:{seq}`（**前缀独立**，不与 `purchase_batch:*` 撞）。
2. **提交阶段**：**沿用引擎那套** —— `submitDraft` 先看 `draft.status === 'submitted'` ⇒ 直接还结果（`:373`）；
   成功后 `orderKey` **轮换**（`:446`）⇒ 第二单不会被第一单吸收 ✓。
   远端那层仍是 `createOnceByKey`（`infrastructure/idempotencyKey.js:53`）——同一把键只建一次 ✓。
3. **草稿 → 已提交的转换**：**一个方向，且只发生一次**：
   - 提交**成功之后**才允许把草稿行改成收尾态（建议「已作废」）；
   - 提交**失败/半截** ⇒ 草稿行**保持 `草稿`**、本地草稿保留（她还能接着录、同一把 `orderKey` 重试）；
   - 🔴 **执行顺序必须"先写业务事实、后收草稿行"**（反了就出现"草稿没了、单也没出"的空档 ✗）。

---

## 6. 过期与找回兜底

| 情形 | 期望行为 |
|---|---|
| 草稿在 TTL 内 | 正常提示、正常接着录 |
| 草稿过期 | **人话提示一句 + 重新开单**（不清不响 ✗ = 禁止）；本地草稿文件**归档而非删除**（便于排查，见 AC-DR10） |
| 表单/草稿格式坏（JSON 坏 / 字段缺） | **人话 + 不清不响** ✗：提示"这一份草稿读不出来，给你重新开一单"，**不抛 500、不静默吞** |
| 会话过期但草稿未过期 | 🔴 **草稿必须活着** ⇒ 这是**必须把草稿放到会话之外**的原因（`scanSessionService.ensure` 过期会 `freshSession()`，`orders` 整段丢 ✗） |
| 换设备 | 本地草稿按 **open_id** 存 ⇒ 同一飞书身份换手机**照样找得到** ✓（不是"跟着手机走"）；表里那行也一样 ✓ |
| 她主动丢弃 | 需要一个显式动作（【不管它，重新开一单】）——⚠️ 是"删掉"还是"留着不管"**待她拍**（Q4） |

---

## 7. 判据草案（**能真红**）

> 全部落在 `server/test/scanDraftSaveResume.test.js`（新建）+ 2 条源码哨兵。
> 每条都写明"**去掉哪一句就该红**"，避免"名字出现过 = 有判据"那种假绿（AGENTS.md 第 1b 条③）。

| # | 判据 | 断言什么（能真红） |
|---|---|---|
| **AC-DR1** | 存草稿 ⇒ **零副作用** | 存 1 次草稿，**假 gateway 的 `create` 调用次数 = 1**（只建/更新那**一条草稿行**，`tableKey='purchaseOrderBatch'`），**`purchaseRequest` 表 0 次**；`inventory.*` 0 次；`deliverSupplierImages` **spy 未被调用**；`nextBatchNo` **未被调用** |
| **AC-DR2** | 草稿行**带「未报货」、不带明细** | 🔴 **按追加节重写**：草稿行 values = `batchNo = 「沿用或新建的那个号」`、`到货状态 = 「未报货」`、`幂等键 = scan_draft:<会话>:<桶>`；**采购明细 0 次** —— 去掉"不建明细"那一句 ⇒ **红**（S1 已落：`AC-D1`） |
| **AC-DR3** | 找回 ⇒ **逐字还在** | 「接着录」渲染出的 `multi_items` 与存进去的那份**逐字 deepEqual**（尺码 / 数量 / 货号 / 颜色 / 供应商一个不差，顺序一致） |
| **AC-DR4** | 没有草稿 ⇒ **页面与今天逐字一致**（零回归） | 同一份 view + write 上下文，**开关关** 与 **开关开但无草稿** 渲染出的 HTML **逐字相等**（`assert.equal(htmlOff, htmlOnNoDraft)`）——**去掉**"无草稿不渲染提示"那一句 ⇒ 红 |
| **AC-DR5** | 接着录完提交 ⇒ 与"一次性录完"**逐字相同** | 两条路（A：一次提交 3 件；B：存草稿→读回→提交同样 3 件）产生**完全相同的 `plan`**（`taskId` / `payload` / `details[].idempotency_key` 逐字相等）+ 假 writer 收到的 `(taskId, payload)` **逐字相等** |
| **AC-DR6** | 幂等：同一份草稿提交两次 ⇒ 只出一次单 | 第二次 ⇒ `reused === true`；假 writer **只被调 1 次**；`orderKey` 轮换后第二单**不会**命中第一单 |
| **AC-DR7** | 草稿**绝不被当成"已提交"** | 一条 `status='draft'` 的草稿，在任何读路径下**都不进**任何"已提交/待处理"投影（含 `purchasePendingBatchService` 候选） |
| **AC-DR8** | 9 点推送**捡不到草稿行** | 喂一条"`到货状态 = 未报货`"的行给 `purchasePendingBatchService` 的筛选 ⇒ **不在候选里**（⚠️ 反向钉住：谁以后把候选判据改成"按数据状态"就要重核 ✓） |
| **AC-DR9** | `draftScope` 开关真生效 | `single`：存第 2 份 ⇒ 本地只剩 **1** 份且**有覆盖留痕**（`scan.draft.overwritten` 日志）；`per_supplier`：两个供应商 ⇒ **2** 份并存。**把 scope 值写死** ⇒ 红 |
| **AC-DR10** | 过期 / 坏格式 ⇒ **人话 + 不清不响** | 过期草稿：GET 页面 200 + 含"上一份草稿已过期"人话 + **文件仍在**（归档）；坏 JSON：200 + 人话 + **不抛**（`assert.doesNotThrow` 等价）+ **不删文件** |
| **AC-DR11** | 源码哨兵：**`scanWriteService.js` 一个字节没动** | 该文件 sha256 与 main 上一致（**余量 0 硬红线**：谁改一个字就红） |
| **AC-DR12** | 源码哨兵：**草稿不直连 gateway、不写业务表字段名** | `services/scanDraftService.js` / `multiItemOrderService.js` 里**不出现** `gateway.create/update` 之外的写库调用，也**不出现**中文列名字面量（列名只从 `v1BitableSchema` 取） |
| **AC-DR13** | 双写一致性：本地写成功、表写失败 ⇒ **不算存成功** | 表写抛错时：返回 `{ok:false}` + **人话**（"草稿没能存进飞书表，先别关这一页"），且**不静默当成功**（⚠️ 或按她拍的降级口径：允许"只存本地" ⇒ 那种情况必须**在提示条上如实说明**） |
| ⭐ **AC-DR14** | **批次号沿用 / 新建**（她 ADDENDUM-3 第 ① 条） | 表里有一行 `到货状态 = 未报货` ⇒ **沿用它的号**（且**一次号源都不调**）；没有 ⇒ **新建**。**去掉"回查未报货"那一步** ⇒ 红（S1 已落：`AC-D6a` / `AC-D6b`） |
| ⭐ **AC-DR15** | 🔴 **并发：两个草稿同时"都没有"⇒ 只出一个号** | 两个并发调用（都看到"没有未报货"）⇒ 号源**只被调一次**、两份草稿**同一个批次号**；把串行拆掉 ⇒ 红（S1 已落：`AC-D7` ＋ 探针 `AC-D7b`） |

**S1 的判据落点**（本刀 = 独立存储层，**测试文件 `server/test/scanDraftSaveResume.test.js`**，15 条全绿）：

| 本文件的草案 | S1 实现里的那一条 | 备注 |
| --- | --- | --- |
| AC-DR1（零副作用） | **AC-D1** | 假 gateway 记账：`create` 只落「采购主表」1 次；`purchaseRequest` 0 次；库存/出图/发群/写入口 0 次 ✓ |
| AC-DR3（找回逐字） | **AC-D2** | `deepEqual` ＋ 顺序逐位 ✓ |
| AC-DR4（零回归） | **AC-D3** | 视图**同一对象** ＋ 开关关/无草稿两条路渲出来逐字相等 ＋ 零文件写入 ＋ 零远端调用 ✓ |
| AC-DR9（scope） | **AC-D4 / AC-D4b** | `single` 覆盖留痕（`scan.draft.overwritten`）· `per_supplier` 两份并存 ✓ |
| AC-DR10（过期/坏格式） | **AC-D5a / AC-D5b** | 过期 ⇒ **归档**（文件仍在）＋ 人话 ＋ 不抛；坏 JSON ⇒ 文件**原地不动** ＋ 人话 ✓ |
| AC-DR13（表写失败） | **AC-D5c** | `{ok:false}` ＋ 人话 ＋ **不许静默当成功** ✓ |
| AC-DR11（冻结哨兵） | **AC-D8** | sha256 = `199551e1…5ca`（与 main 逐字节一致）✓ |
| AC-DR12（列名不写死） | **AC-D8b** | **代码里**（剥掉注释）一个中文列名都没有；`await gateway.create` 只有一处；不 require 冻结件 ✓ |
| ⭐ 新增（她两条逻辑） | **AC-D6a/b/c · AC-D7 · AC-D7b** | 见 AC-DR14 / AC-DR15 ✓ |
| AC-DR5 / DR6 / DR7 / DR8 | ⏳ **未做** —— 属于 **S3**（提交那一半 / 接着录完提交 / 9 点推送候选反向钉） | 如实标：**本刀未完成** ✗ |

**变异要求（每刀至少 2 组）**：AC-DR1 去掉"不建明细"那一句 ⇒ 红；AC-DR3 把 `entries` 顺序打乱 ⇒ 红；
AC-DR5 让 B 路多传一个 `submitKey` ⇒ 红；AC-DR9 把 `single` 改成 `per_supplier` 的键口径 ⇒ 红。

---

## 8. 建议实现顺序与排期（等哪些让出）

| 步 | 做什么 | 依赖 / 等谁 |
|---|---|---|
| **S0** | 她拍板 Q1–Q6（第六节）~~+ 她在表里加那一列~~（**已由她自己解决**：到货状态加了「未报货」✓ ⇒ **不需要加列** ✗） | **等 Lead 弹窗问她**（Q1 / Q2 / Q4 / Q5 / Q6 ＋ 新 Q7） |
| **S1** ✅**已做** | `services/scanDraftService.js`（新建）：草稿本地存/读/TTL/覆盖留痕 + 表侧那一行（`到货状态=未报货`）+ **批次号沿用/新建（整段串行）**；**新 `data/scan_drafts/` 存储**（不与会话共 TTL）＋ `config/scanDraft.js`（配置先行）＋ `test/scanDraftSaveResume.test.js`（15 条全绿） | 只新建文件 ⇒ **与在跑的热点文件零交集** ✓（写作用域就这三个文件 ＋ `docs/**`） |
| **S1b** ⏳**未做** | 把 `AC-DR5 / DR6 / DR7 / DR8` 那四条判据补上（提交半 / 9 点推送候选反向钉） | 它们要**路由半**或**既有服务的只读喂数** ⇒ 与 S3 一起做更省事 |
| **S2** ✅**已做（2026-10-16 本刀）** | 渲染半：三处入口（销售货品页 / 补货页 / 退货页，**共用她点名那句「存报货草稿」**）＋「你有一份草稿，接着录吗？」提示条（`views/scanPageRenderer.js` ＋ `config/scanPage.js`）；**同一刀改 S1 的明细口径**：「**草稿也写明细**」（`services/scanDraftService.js` ＋ `config/scanDraft.js`，明细幂等键独立前缀）；判据 = `test/scanDraftRenderEntry.test.js` ＋ `test/scanDraftSaveResume.test.js` 的 **AC-D1 成对迁移** / AC-D2b / AC-D2c / AC-D2d。**详见第 11 节** | ⚠️ **不碰 `routes/**`**（`supplier-split` 在用它）⇒ 【接着录】与「存草稿」的接线（S3）如实标**待接线** |
| **S3** | 路由半：GET 读草稿喂 `view`（吃 S1 的 `planView`）、`?resume=1` 采纳草稿、POST "存草稿"动作（**三处入口**：销售货品页那颗她点名的「**存报货草稿**」＋ 补货页 ＋ 退货页）；**生成报货单时按供应商拆分/分组** ＋ `未报货 ⇒ 未到货` | 🔴 **同一个 `routes/scanPage.js`**：与"总金额 / 金额核对 / 发生金额改名 / 销售多件 / 票据入口"**全都撞** ⇒ **必须串行**，等它们让出 ✓ |
| **S3b** | 生成报货单那一半：批次号**归属哪一方**、拆成**几条单 / 几个批次号**（⚠️ **她还没拍** ⇒ 先问她 Q7） | 等 Q7 |
| **S4** | 配置 + `.env.example` + 开关翻真（先测试 Base 真跑 1 轮） | 等 S1–S3 |
| **S5** | 全量测试 + 四件 CI + PR（**不合并**）；`v1:schema-check:purchase` 在**服务器**上对着生产跑一次 | 等 S4 |

🔴 **本步（只读 + docs）已完成**；S1 起由 Lead 排期。**本步未写任何 `server/src/**`** ✓。

---

## 9. ⭐ 要她拍板的清单（Lead 用弹窗问）

| # | 问题（给她的话） | 为什么要问 / 备选 |
|---|---|---|
| **Q1** | 你说的"**进去就提示**"—— 是**扫了货品码、进到补货/退货那一栏**的时候提示就行，还是要**单独做一个"补货 / 退货"首页**（不扫码、打开就有提示）？ | 今天补货/退货**没有独立入口**，只有"扫码 ⇒ 点【补货】/【退货】"。做独立入口 = 新增落地页（`GET /replenish` 之类），比前者大一圈 |
| **Q2** | **草稿留多久？** ⓐ 跟着会话 **12 小时** ⓑ **7 天** ⓒ **长期有效（不过期）**，要她自己删 | ⚠️ 她原话是"往往不会在当下想好"⇒ 12h 可能太短；⚠️ 但要防"半年前的草稿还冒出来" |
| ~~**Q3**~~ | 🔴 **已作废** ✗ —— 她**已经在生产**「采购主表」的「到货状态」里加了第三个选项 **「未报货」**（= 草稿状态）⇒ **不需要新加列** ✓（见文首追加节结论①） | 原问题（"要不要加 `数据状态` 列"）**不用再问她** ✗ |
| **Q4** | 提示条上除了【接着录】，要不要再给一颗【**不管它，重新开一单**】？点了这颗，**旧草稿是删掉、还是留着（只是先不用）**？ | 不给这颗 ⇒ 她就没法"这次先开新的一单"；给 ⇒ 要定义"删/留"（⚠️ **S1 的实现先按"归档不删除"做** —— 她拍之前**不删**任何东西 ✓） |
| **Q5** | ⭐ **"只留一份"会不会覆盖掉上一份？** —— 你说的"补货往往分几个供应商"和"只留一份"看起来是冲突的。现在按你选的**只留一份**做（第二次存草稿会覆盖第一份，我在页面上**如实提示"上一份已被覆盖"**）；要改成**按供应商各留一份**的话我有个开关，一句话就能切。 | Lead 留的疑问；**不替她决定成 per_supplier** ✓（配置开关 `SCAN_DRAFT_SCOPE`，缺省 `single`） |
| **Q6** | 草稿在你提交之后，**表里那一行怎么处理**？ⓐ 标成「已作废」留着（推荐：草稿不是业务事实，不该升格成批次）ⓑ 标成「已提交」继续当那一单用 ⓒ 直接删掉 | 影响她以后在表里看到的行数；也影响工作台查询 |
| ⭐ **Q7（新）** | **生成报货单时按供应商拆开之后，是几张单 / 几个批次号？** ⓐ **还是同一个批次号**（单号一张、里面按供应商分几组）ⓑ **每个供应商一个新批次号**（各出各的单） | ✅ **已拍板（她 2026-10-16）＝ ⓐ** —— 本问题**作废，不要再问她** ✗：口径落成 `config/supplierSplit.js` 的 `batchNoPolicy = 'same_batch_no'`（`config/scanDraft.js` 的 `supplierSplit.batchNoPolicy` 也从 `undecided` 改成从那边读 ✓），实现与判据见 `docs/supplier-split-at-generation-2026-10-16.md` |
| ⭐ **Q8（新）** | **提交之后草稿行怎么办、以及"她先点了别的入口"**：同一个人**同时**在补货页和销售页各存一份草稿 ⇒ 现在 `single` 口径下**后存的覆盖先存的**（哪怕不是同一条链）。要不要改成**按链（补货/退货/销售）各留一份**？ | 配置现在是 `SCAN_DRAFT_SCOPE` 的两个取值（`single` ／ `per_supplier`）；"按链各留一份"是第三个取值 —— 不影响本刀（S1 还没入口），但**S2/S3 接入口之前要拍** ✗ |

（另：第二条"怎么找回"问她是否接受"**必须先扫一个货品码**才看得到提示" —— 与 Q1 是同一件事的两面。）

---

## 10. 本设计**不做**的事（边界）

- 不动 `services/scanWriteService.js`（**余量 0 硬红线**）✗；不动 `config/scanWrite.js` / `routes/**` / `views/**` / `public/workbench/**` ✗（本步）。
- **不替她决定** `per_supplier` ✗、**不替她决定** TTL ✗、**不自己写生产表** ✗（加列请她做）。
- ~~不做"销售"那一条链的草稿（她只说了补货与退货）✗。~~ 🔴 **已作废**：她 ADDENDUM-2 逐字点了
  **销售货品页那颗「存报货草稿」** ⇒ 销售那条链**也在这套存储层里** ✓
  （S1 的实现本来就是**按链无关**的：`saveDraft` 只吃 `items` ＋ `supplierRecordId` ⇒ 三条链共用一份 ✓）。
- 不做多用户/多租户的草稿隔离（今天 `open_id` 一维就够；真要产品化再另说）。
- **不部署** ✗（已在测试期间）。

---

## 附：本文件引用的关键代码位置

```
services/multiItemOrderService.js    :83 emptyDraft  :102 openDraft  :134 addItem  :163 setEntries
                                     :179 removeItem :200 validateDraft :291 planSubmission :361 submitDraft
                                     :373 已提交幂等  :446 orderKey 轮换
config/multiItemOrder.js             :24 ordersField :38 session :59 submitKeyTemplate :54 addWireEnabled
                                     :62 asyncEnabled :101 texts :118 chains（两条链只差这一块）
config/scanWrite.js                  :252 scan_sessions 目录  :267 TTL 12h  :428/:458 幂等键前缀
                                     :426/:465 behaviorCode  :429/:467 taskIdPrefix
services/scanSessionService.js       :40 idOf  :57 freshSession  :114 ensure（过期⇒新的空的 ✗）
                                     :146 touch  :177 revive（只给提交用）  :376 completeReplenish
infrastructure/jsonTaskStore.js      :59 _serializeWrite（同 id 写互斥）
routes/scanPage.js                   :392 openDraft 调用  :334 readMultiItemPending  :346 writeMultiItemPending
                                     :362 clearMultiItemPending  :282 submitMultiItemOrder
                                     :1627 view.multi_items  :1722 加/删货 POST  :2881/:2975 groups.length>1
services/purchaseWebhookService.js   :587 publishPurchaseRequest  :1575 confirmPurchaseRequest
                                     :1607 建批次行（未到货+录入数量+采购行为）  :1648 采购明细  :1723 deliverSupplierImages
services/purchaseReturnService.js    :118 submit  :132 createForReturnBatch  :185 实际金额  :208 明细  :230 扣库存  :266 出图发群
services/purchaseOrderBatchService.js:132 createForReturnBatch  :201 setArrivalStatus  :264 writeOrderAmount
services/purchasePendingBatchService.js :65 pendingStatus :135 候选 = 到货状态==未到货
config/v1BitableSchema.js            :359 purchaseRequest（采购明细）  :427 purchaseOrderBatch（采购主表）
```

---

## 11. ⭐⭐ S2 已落地（2026-10-16 · **渲染半** ＋ **改 S1 的明细口径**）

> 范围（Lead 的 brief）：`views/scanPageRenderer.js` ＋ `config/scanPage.js`（渲染半）＋
> `services/scanDraftService.js` ＋ `config/scanDraft.js`（S1 的明细口径）。
> 🔴 **不碰 `routes/**`**（`supplier-split` 在用它）· **不碰 `services/scanWriteService.js`**（余量 0）
> · 不碰 `routes/workbench.js` / `public/workbench/**` / `config/scanWrite.js` ✗。

### 11.1 ⭐ 她的口径（2026-10-16，**逐字**）—— 本刀按它做

```
① 存草稿的逻辑分两种：「1. 销售页和补货页存补货草稿  2. 退货页存退货草稿」
② 保留 7 天 ✓ 只留一份 ✓
③ 「打印的时候，这一份要按照供应商来进行打印」⇒ 生成报货单/出图发群时按供应商分组（worktree `supplier-split` 在做）
④ ⭐⭐ 「草稿也写明细」⇒ 存草稿时：写「采购主表」1 行（到货状态 = 未报货）＋ 写「采购明细」若干行
   ⚠️ 这推翻了 #732 的一个假设（AC-D1 当时按"明细 0 次"写 ✗）⇒ AC-D1 已【成对迁移】
⑤ 生成报货单之后：那行草稿（主表那行）直接变成「未到货」（不另开新行 ✗ 不作废 ✗）—— **S3**
```

### 11.2 改前逐字 → 改后逐字（**成对迁移**，逐条）

| # | 改前逐字（#732 / S1 及更早） | 改后逐字（本刀 S2） | 依据 |
| --- | --- | --- | --- |
| ① | `AC-D1 **存草稿 ⇒ 零副作用**：…（**不写采购明细** / 不建明细行）` ＋ `assert.deepEqual(h.gateway.writesTo('purchaseRequest'), [], '不许建采购明细 ✗')` | `AC-D1 存草稿 ⇒ 零副作用：主表一行（未报货）＋ 明细 N 行，库存/出图/发群/写入口**一次都没有**` | 她 2026-10-16「**草稿也写明细**」 |
| ② | `services/scanDraftService.js` 文件头：「存草稿**只**做两件事：① 本地那份草稿；② 「采购主表」**那一行**…🔴 **绝不**：…**建采购明细**…」 | 同一段改成「存草稿做**三**件事：① 本地草稿；② 主表那一行；③ ⭐ 采购明细若干行」，并写明**明细是唯一被允许的例外** | 同上 |
| ③ | `config/scanDraft.js` 只有草稿行那一个落点（`tableKey` / `statusFieldKey`） | 多一对明细落点：`detailTableKey`（缺省 `purchaseRequest`）＋ `detailIdempotencyPrefix`（缺省 `scan_draft_detail`） | 同上（列名仍只从 `v1BitableSchema` 语义键取 ✗ 零中文列名字面量） |
| ④ | 页面**没有**任何「存草稿」入口、也没有提示条 | 三处入口（销售货品页 / 补货页 / 退货页）＋「你有一份草稿，接着录吗？」提示条；**两块都由 `page.draft` 闸门控制**（缺省 = 一个字节都不渲染 ✓） | 她 ADDENDUM-2「销售货品页上面也需要加一个按钮，叫「存报货草稿」」＋「补货和退货需要支持存草稿」＋「进去就提示，接着录」 |

⚠️ **不许自己定**的那一条（Lead 明确）：补货页 / 退货页那两颗**她没点名** ✗
⇒ 三处**共用同一句文案**（`SCAN_PAGE.draftEntry.saveLabel`，一处定义）；
**来源如实登记**：该取值**取用销售货品页那颗（她 2026-10-16 逐字点名的那一句）**，
补货 / 退货两处是**沿用**它，不是她的话。要分开命名 ⇒ 把这一处拆成三个键即可（**不改逻辑** ✓）。

### 11.3 落点（她自己那张表，逐字）

| 落点 | 写哪几列（语义键，全部来自 `config/v1BitableSchema.js`） | 幂等键 |
| --- | --- | --- |
| 「采购主表」`purchaseOrderBatch`（**一行**） | `batchNo` · `idempotencyKey` · `arrivalStatus = 未报货` | `scan_draft:{会话}:{桶}`（S1 既有 ✓） |
| 「采购明细」`purchaseRequest`（**N 行**，一行 = 一个「货品 × 尺码」） | `batchNo`（关联刚建的主表行）· `product` · `size`（**尺码管理那条记录的 id**）· `quantity` · `idempotencyKey` | `scan_draft_detail:{会话}:{桶}:{货品}:{尺码}` ⭐ |

⚠️ **不写**：`behavior`（「采购行为」是 Lookup，只读 ✗）· `detailId`（「采购明细ID」留给**真出单**那一步的分配器统一编号；草稿不占号）。
⚠️ **写不成的行如实留痕**（不静默 ✗）：数量不是正整数 / 尺码在「尺码管理」里找不到 ⇒ **跳过那一行** ＋ `scan.draft.detail_skipped`；写库失败 ⇒ `scan.draft.detail_write_failed` ＋ 返回值 `details.failed`。

### 11.4 判据（本刀新增 / 迁移，**每条都能真红**）

| AC | 在哪 | 断言什么 | 真红的方式（变异） |
| --- | --- | --- | --- |
| **AC-D2a** | `test/scanDraftRenderEntry.test.js` | 三处入口都在（销售货品页 / 补货页 / 退货页，各**恰好一颗**、且在**既有那张 `<form>` 里**）；库存页 / 标签页**没有** | 把 `draftEntry.realms` 改空 ⇒ 红 |
| **AC-D2a2** | 同上 | **名字走配置**：换一份 `draftEntry` ⇒ 三处文案 / 动作名一起变 | 让渲染层读模块级 `SCAN_PAGE`（不认传进来的 config）⇒ 红 |
| **AC-D2b** ⭐ | `test/scanDraftSaveResume.test.js` | 存一次 ⇒ 主表 **1 行**（未报货）＋ 明细 **N 行**（N = 货品数；一行 = 一个「货品 × 尺码」） | 明细行少一行 / 多一行 ⇒ 红 |
| **AC-D2c** ⭐ | 同上 | 同一份草稿存两次 ⇒ 明细**不翻倍**（第二次 `reused = N` / `created = 0`） | 幂等键里塞 `Date.now()` ⇒ 红 |
| **AC-D2c2** | 同上 | 改了数量再存 ⇒ 仍是同一份草稿（命中同一把键，不新增行） | 同上 |
| **AC-D2d** | 同上 | 零副作用仍成立：碰的表**只有**那两张（明细 = 被允许的例外）；发群 / 出图 / 写库存 / 真出单写入口 **0 次**；取号次数与只写主表时**逐字相同** | 顺手调一次库存 / 发群 ⇒ 红 |
| **AC-D2e** ⭐ | `test/scanDraftRenderEntry.test.js` | **没有草稿 ⇒ 与今天逐字一致**：不传 `page.draft`（= 今天所有调用方）**一个草稿字节都没有**；开关开但没草稿 ⇒ **只有入口、没有提示条**，去掉入口后与今天**逐字相等** | 把提示条改成无条件渲染 ⇒ 红 |
| **AC-D2f1/2** | 同上 | 提示条**有草稿才出**；【接着录】= 真链接（查询键 / 值走配置）；**不点它 = 正常新建**（页面里别的按钮 / 表单一个字不动） | 同上 |
| **AC-D2f3** ⚠️ | 同上 | **如实标「待接线」**：`routes/scanPage.js` 里**还没有**读 `?resume`（S3 才接）⇒ 今天生产页面上一个草稿字节都不出现（**没有"点了没反应"的死按钮** ✓） | 提前在渲染层接住 resume ⇒ 红 |

### 11.5 本刀**未做**的（如实标，别当成已完成 ✗）

- **【接着录】的 POST / GET 接线**（`?resume=1` 采纳草稿）：**S3**（本刀不碰 `routes/scanPage.js` ✗）。
- **「存报货草稿」那颗按钮的动作接住者**（`save_draft`）：**S3**（渲染层已按配置画好 ✓）。
- **生成报货单**：`未报货 ⇒ 未到货` ＋ **按供应商拆分 / 分组**（Q7 待她拍）：**S3 / `supplier-split`**。
- **提交之后草稿行怎么收尾**（Q6）· **按链各留一份**（Q8）：**待她拍**。
- ⚠️ **已知边界**（本刀没动那一半）：同一份草稿**第二次存** ⇒ 主表那一行仍按 S1 既有行为再 create 一次
  （**同一把幂等键**，`AC-D4` 的判据一个字没改）；S3 接"存草稿"时应先按幂等键回查 / 复用那一行。
  本刀只保证**明细不翻倍**（`AC-D2c`）✓。
