# 「生成报货单时按供应商拆分/分组」落地记录（2026-10-16 · 业务负责人拍板 **ⓐ**）

> **本文件的性质**：**实现记录**（改前逐字 → 改后逐字 → 依据）＋ **只读核查结论**（"生成报货单"到底是哪一下 ·
> 今天的表结构能不能表达"同一个批次号下多组"）＋ **验收标准与证据**。
> 设计来路：`docs/draft-save-resume-plan-2026-10-16.md`（S1 的设计）＋ Lead 的两页追加便条
> `.local/draft-plan/LEAD-ADDENDUM-2.md` / `-3.md`（**便条本身不进 git** ✗）。

---

## 0. 她的口径（逐字，**唯一权威**；别自己解释 ✗）

> 「在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
>  需要**按照供应商进行拆分和分组**。因为这个报货单是我们要**对接供应商**的，
>  所以**必须按照供应商进行分组**。」

⭐ 追问后她明确：**ⓐ「同一批次号下按供应商分组」** ✓
（**不是** ⓑ「每个供应商各开一个新批次号」✗）。
这道题原先挂在 `docs/pending-confirmations.md` 第 **②** 条（"供应商拆分后是几个批次号"）——
**本刀把它结掉**：口径 = ⓐ，实现 = 本文件。

---

## 1. 只读核查①：今天"生成报货单"到底是哪一下（**文件:行** ✓）

**结论：不在"扫码提交那一刻"，而在写入口内部——"计划冻结"那一步之后、任何远端写入之前。**

链路（补货/报货那条链，两处入口都汇到同一个写入口 ✓）：

| # | 哪一下 | 位置（本刀之后的 worktree 行号） |
| --- | --- | --- |
| ① | 扫码页 POST 收下这一单（**只**排后台 / 或交给引擎） | `routes/scanPage.js:2889`（N=1 ⇒ `schedulePurchaseWrite`）· `:2882`（N>1 ⇒ `submitMultiItemOrder`） |
| ② | N=1：后台那一跑调**既有写层** | `services/scanWriteService.js:1346 submitReplenish` → `:1482 purchase().publishPurchaseRequest(taskId, task)`（**冻结件：本刀一个字没动** ✗） |
| ③ | N>1：引擎"只调既有写入件" | `services/multiItemOrderService.js:449 await writer(plan.taskId, plan.payload, …)`（writer 的键名由 `config/multiItemOrder.js` 的 `chains[].writer` 给） |
| ④ | **写入口**（报货单真正被"生成"的地方） | `services/purchaseWebhookService.js:604 async publishPurchaseRequest` → `:1748 async confirmPurchaseRequest` |
| ⑤ | **批次号 + 计划冻结**（本刀**把分组也冻结在这里**） | `purchaseWebhookService.js:1663 async ensurePostingPlan`（→ `:1667` 落盘 `posting_plan`） |
| ⑥ | 建「采购主表」**那一行** | `purchaseWebhookService.js:1763 createOnceByKey('purchaseOrderBatch', …)`（幂等键 `purchase_batch:<taskId>`） |
| ⑦ | 逐条建「采购明细」 | `purchaseWebhookService.js:1819 createOnceByKey('purchaseRequest', …)` |
| ⑧ | **出报货单**（每组一张图 → 发群 → 回填「单据」） | `purchaseWebhookService.js:1888 this.deliverSupplierImages(taskId, task, posting)` → `:799 deliverSupplierImagesInner` |
| ⑨ | 退货那条链的对应一步 | `services/purchaseReturnService.js:118 submit` → `:269 webhooks.deliverSupplierImages(...)`（**同一个出图/发群件** ✓） |

⭐ 所以"生成报货单"= **④⑤ 那一下**（`publishPurchaseRequest` 里的"冻结计划"）——
它之后才有批次行、明细行、图与群消息。
🔴 ⇒ **分组必须落在 ⑤ 或更早**（本刀就落在 ⑤：`ensurePostingPlan` 里、**任何远端写入之前** ✓）。
落到 ⑧ 之后才拆就晚了：那一刻批次行/明细都已经按"一锅"写下去了 ✗。

---

## 2. 只读核查②：今天的表结构**能不能**表达"一个批次号下多组" ⇒ **能** ✓（一个新列都不用加 ✗）

三处落点**全部已有**（她 ADDENDUM-3 结论①：「**不需要新加列**」✗）：

| 落点 | 只读核到的形状 | "多组"落在哪 |
| --- | --- | --- |
| 「采购主表」`purchaseOrderBatch`（真表 **14 列**） | `报货批次号`(主字段) · `到货状态`(单选) · **`供应商`(SingleLink → 供应商管理)** · **`单据`(Attachment)** · `录入数量` · `采购行为` · `报货日`(自动) · `到货日`(自动) · `验收人`(自动) … | **一行**（= **一个批次号** ✓）。多组**共用这一行** —— 她的 ⓐ 就是"**单内分组**" |
| 「采购明细」`purchaseRequest`（真表 **10 列**） | `采购明细ID` · `报货批次号`(DuplexLink) · `编号`(→货品) · `尺码` · `数量` · `幂等键` · **`供应商`(Formula —— 只读，代码不写)** … | **每个尺码一行**，行上的供应商由**货品关联/公式**带出来 ⇒ 明细**天然逐行带供应商** ✓ |
| 「单据」（附件列） | 附件字段**支持多文件**；`services/purchaseOrderBatchService.js:429 writeDocument` 是"**已有附件原样带上再追加**" | **每个供应商各一张**报货单 PNG，都挂在**同一行**上 ✓ |

⭐ 结论：**能表达**，且**不需要她加列/改结构** ⇒ **不必停手**（brief 里那条"若不能 ⇒ 停手报我"不触发 ✓）。
"分组"落在：**主表一行**（同一批次号）＋ **明细行各带自己的供应商** ＋ **「单据」里每组一张图**。
⚠️ 两条**不许**越界：
· 主表的 `供应商` 是 **SingleLink、代码只读不写**（她自己维护；`v1SchemaProductionSync2026_10_09` 钉着"全仓没有写入点"）
  ⇒ 本刀**不写它** ✗；
· 明细的 `供应商` 是 **Formula（只读）** ⇒ 代码也不写 ✗（写了会被忽略 / 甚至整条 create 失败）。

---

## 3. 改前逐字 → 改后逐字 → 依据

### 3.1 口径落定：S1 明留未决的那一处（`config/scanDraft.js`）

| | 逐字 |
| --- | --- |
| **改前** | `const SUPPLIER_SPLIT = Object.freeze({ stage: 'generate_report', batchNoPolicy: 'undecided' });` |
| **改后** | `const SUPPLIER_SPLIT = Object.freeze({ stage: DECIDED_SUPPLIER_SPLIT.stage, batchNoPolicy: DECIDED_SUPPLIER_SPLIT.batchNoPolicy });`（`DECIDED_SUPPLIER_SPLIT` = `require('./supplierSplit').SUPPLIER_SPLIT`） |
| **依据** | 业务负责人 **2026-10-16 拍板 ⓐ**（"同一批次号下按供应商分组"）＋ S1 自己写的"S1 未决 ⇒ 要列成问题问她"（`docs/pending-confirmations.md` ②） |

### 3.2 新增：`config/supplierSplit.js`（**配置先行**）

- `batchNoPolicy`：**只认 `same_batch_no`**（她的 ⓐ）；ⓑ（`new_batch_no_per_supplier`）**刻意不是可选项**
  —— 认不出的值**当场抛** ✓（写成可选 = 把她没选的方案留在配置里 ✗）。
- `stage: 'generate_report'`（拆的那一下）、`unspecifiedKey`（拿不到供应商落哪个桶）、
  `groupKeyTemplate: 'supplier_group:{batchKey}:{supplierKey}'`、
  `documentKeyTemplate: 'supplier_document:{batchNo}:{supplierKey}'`、
  三个事件名（`supplier.split.grouped` / `.group_already_reported` / `.mismatch`）。
- 🔴 **不 require** `config/scanWrite.js`（红线：那个文件一个字不动 ✗），也**不被它 require**（单向 ✓）。

### 3.3 新增：`services/supplierSplitService.js`（**一个模块只干一件事**）

- `splitBySupplier({ items, batchNo, batchKey, taskId })` ⇒
  `{ policy, stage, batchCount: 1, batchNo, groups: [{ supplier_record_id, supplier_key, group_key, document_key, indexes, items, detail_count, pair_count }] }`
  —— 🔴 **`batchCount` 恒为 1**（她选的 ⓐ 的物理含义 ✓ 判据 AC-SS3 钉着）；
- `groupItemsBySupplier(items)`：**出图分桶的唯一一处**（老形状逐字兼容：`key` / `supplierRecordId` / `items` / `indexes`）；
- `documentFileNameOf(supplierName, suffix)`：**单据文件名的唯一一处**（"这一组已经出过"的判据与落点必须同名 ✓）；
- 🔴 **纯函数**：不 require gateway / `v1BitableSchema` / 冻结件，**逻辑里没有任何中文字面量**（源码哨兵 AC-SS7b ✓）。

### 3.4 `services/purchaseWebhookService.js`（写入口：把分组**冻结在生成那一步**）

| 位置 | 改前逐字 | 改后逐字 | 依据 |
| --- | --- | --- | --- |
| `publishPurchaseRequest` | `async publishPurchaseRequest(taskId, task) { return this.confirmPurchaseRequest(taskId, task, {}, { skipCardUpdate: true }); }` | 多一个**可选**实参 `options`，把调用方在**调写入口之前**算好的 `supplierGroups` 带进"计划冻结"（`publishPurchaseRequest(taskId, task, options)`） | 她要"**生成之前**就把组算好" |
| `ensurePostingPlan` | `items: items.map(...)` 里**没有**供应商；函数签名 `(taskId, task)` | 每条明细冻结 `supplier_record_id`（明细没带才退回批次级）+ 落 `plan.supplier_groups`（**组键 / 单据键跟着计划一起落盘** ⇒ 重试逐字复用）；签名 `(taskId, task, options = {})` | 分组要**在任何远端写入之前**定下来（⑤ 在 ⑥⑦⑧ 之前 ✓）＋ 幂等（重试换键 = 没幂等 ✗） |
| `confirmPurchaseRequest` | `const plan = await this.ensurePostingPlan(taskId, task);` | `const plan = await this.ensurePostingPlan(taskId, task, { supplierGroups: options.supplierGroups });` | 同上一行 |
| `posting` | `{ request_ids, request_id_by_item_key, batch_record_id, batch_no }` | 多 `batch_key` ＋ `supplier_groups: plan.supplier_groups \|\| []` | 出图那一步要用**同一份**组（一一对应） |
| `groupItemsBySupplier` | 类里那个私有 `Map` 遍历 | 委托给 `supplierSplitService.groupItemsBySupplier(items, this.supplierSplit)`（**行为一个字没变**：同一趟遍历、同样的首次出现顺序、空供应商同样归一组） | 分桶口径**只有一处** |
| `deliverSupplierImagesInner` | `for (const group of this.groupItemsBySupplier(items)) { … render → send → writeAttachment }` | ① 组从 `this.supplierReportGroups(task, posting)` 来（**优先用计划冻结的组键/单据键**，拿不到才按同一口径现算）；② 每组**发之前**先判"这一组的报货单是不是已经出过"（`orderBatches.findDocument(batchNo, fileName)`）⇒ **已经出过就跳过**（连图都不渲染）；③ 返回 `summary` 多 `already_reported` / `group_count` / `batch_count: 1` | AC-SS4「同一组重复生成 ⇒ **只出一次**」；且判据只用**已经落库的事实**（不引新状态 ✓） |
| ⚠️ 上一条的**代价**（如实写） | — | 每组多**一次只读**（`findDocument`：问"这一批的「单据」里有没有这张图"，就是既有"重复执行**连上传都不做**"用的**同一把判据** ✓）。**写什么、发什么一个字节都没变** ✓；拿不到批次身份 / 这次查询失败 ⇒ **当它没出过**（宁可多发一次，也**绝不静默少发一家** ✗ —— 少发才是真事故） |
| `writeSupplierImageAttachment` | `const safeName = …; const fileName = \`${safeName}-${fileNameSuffix}.png\`;` | `const fileName = documentFileNameOf(supplierName, fileNameSuffix);`（缺省后缀改为模块常量 `DEFAULT_DOCUMENT_FILE_SUFFIX = '采购单'`，值没变） | 文件名拼法**只能有一处**，否则"已经出过"永远判不出来 ✗ |
| `confirmPurchaseRequest` 的返回 | `{ toast, ...posting }` | 多一个**附加**字段 `image_delivery`（发了几组 / 哪几组已经出过）—— 既有键名一个没动 ✓ | 让"生成"这一步的产物**可查**（AC-SS4 直接断言它） |

### 3.5 `services/multiItemOrderService.js`（引擎：**调写入口之前**把组算好）

| 位置 | 改前逐字 | 改后逐字 | 依据 |
| --- | --- | --- | --- |
| `planSubmission` 返回 | `{ ok, batchCount: 1, taskId, payload, details, summary }` | 多 `supplierGroups`（**按供应商分的组：`supplier_key` / `indexes` / `detail_count` / `pair_count`**）；`summary` 多 `supplier_group_count` / `supplier_keys` | 她要"**生成报货单之前**按供应商分组"——引擎就是这句话里"调写入口之前"的那一半 ✓ |
| `submitDraft` 调写入件 | `await writer(plan.taskId, plan.payload);` | `await writer(plan.taskId, plan.payload, { supplierGroups: plan.supplierGroups });` | 把那一份组**交给**写入口（写入口优先用它、并按草稿**交叉核对**：对不上 ⇒ 当场 warn ✓ 不静默挑一个 ✗） |
| 🔴 **载荷本身** | `payload = { is_batch, product_record_id, …, items }` | **一个字段都没动** ✗ | 她/Lead 的硬红线：**单供应商 ⇒ 与今天逐字一致**（AC-SS2 的 `deepEqual` 就是哨兵 ✓） |

### 3.6 ⭐ 一处**如实标未做**（不是本刀范围）

退货那条链（`purchaseReturnService`）**只支持单货品**：它给每条明细写的是 `draft.supplier_record_id`
（批次级），多货品时那个值是空串 ⇒ 混供应商的**退货**目前会落到"未标注供应商"那一张。
这属于"退货链路的多货品支持"（**另一个话题** ✗），本刀**没动它**、也**没有假装它已经支持** ✓。

---

## 4. 判据（**先写后做**；`server/test/supplierSplitAtGeneration.test.js`，10 条全绿）

| # | 判据 | 断言什么（**都能真红** ✓） |
| --- | --- | --- |
| **AC-SS1** | 一个批次号下 **3 个供应商** ⇒ 报货单**分成 3 组** | 渲染器被调 **3** 次；每次入参里**只有一个供应商的行**；三家不重不漏；每组行数 = `[2,1,2]`；「单据」里 **3 张**；群消息 **6 条**（3×图+文字）；`image_delivery.group_count = 3`、`batch_count = 1` |
| **AC-SS2** | **单供应商** ⇒ 与今天**逐字一致** | `planSubmission` 的 **`payload` 逐字 `deepEqual`**（分组**不往载荷里加字段**）＋ 真链路只 1 张图 / 1 个附件 / 2 条消息 / 主表 1 行 |
| **AC-SS3** | 分组**不新增批次号** | 主表**只 1 行**；号源**只取 1 次**；3 行明细的「报货批次号」指向**同一个**批次记录；`splitBySupplier(...).batchCount === 1`（改前：ⓑ 会变成 3 行 / 3 个号 ⇒ 红） |
| **AC-SS4** | **幂等**：同组重复生成 ⇒ **只出一次** | 重放（同一个 task）后：图 **0** 次新增、群消息 **0** 条新增、附件 **0** 次上传、`already_reported = 3 家`、`sent = []`、主表仍 1 行、号源仍只 1 次 |
| **AC-SS4b** | 探针：AC-SS4 **不是空跑** | 手动把「单据」里那张图**拿掉**（= 其实没出过）⇒ **必须重出**（否则就是静默少发一家 ✗） |
| **AC-SS5** | **存草稿阶段零副作用**（混 3 个供应商也一样） | ⭐ **成对迁移过一次**（见下面的 ⚠️）：她的**三个副作用**（发群 / 出图 / 写库存）＋「单据」附件写入 **0 次**；草稿行**只 1 行**（那一行，`到货状态 = 未报货`）；草稿里 **3 个供应商都还在**（存草稿**不拆** ✓ —— 拆的那一下是「生成报货单」） |
| ⚠️ AC-SS5 的**成对迁移**（main 上的 #735 改过 S1 的明细口径） | — | **改前逐字**：`assert.equal((gateway.tables.purchaseRequest \|\| []).length, 0, '🔴 **不建采购明细**（草稿不是报货单 ✗）');`<br>**改后逐字**：钉"3 行草稿明细的**幂等键前缀 = 草稿专用** `scan_draft_detail:*`（与真出单那套 `purchase_request:*` 分得开 ✓）"＋她点名的那三个副作用仍为零<br>**依据**：她 2026-10-16 逐字「**草稿也写明细**」⇒ #735（S2）已把 S1 的 `AC-D1`（"采购明细 0 次"）成对迁移 ⇒ 本文件**不许**再钉"0 行" ✗（旧断言会与 main 上那条口径打架，而且"明细"本来就**不是**她点名的那三个副作用之一 ✓） |
| **AC-SS6** | ⭐ **口径落定哨兵** | `resolveScanDraftConfig({}).supplierSplit === 'generate_report'`；`config/scanDraft.js` 导出的 `SUPPLIER_SPLIT.batchNoPolicy === 'same_batch_no'`（**`undecided` 不许回来** ⇒ 写回去就红）；`SUPPLIER_SPLIT_BATCH_NO_POLICY=new_batch_no_per_supplier`（ⓑ）**当场抛**；组键稳定可算；空供应商落 `unspecified` 桶；`documentFileNameOf` 两例逐字 |
| **AC-SS7** | 🔴 源码哨兵：**冻结件逐字节没动** | `services/scanWriteService.js` 的 sha256 = `199551e1…35ca`（与 main 一致） |
| **AC-SS7b** | 源码哨兵：分组模块**不认识飞书** | `services/supplierSplitService.js`（剥掉注释后）**不出现** `gateway` / `v1BitableSchema` / `scanWriteService` / `createOnceByKey` / `store.update`，且**一个中文字面量都没有** |

**变异（每组都真跑过：改一处 ⇒ 指定用例红；改回来 ⇒ 逐字节一致）**：

| 组 | 那一处改成什么 | 谁红 |
| --- | --- | --- |
| ① | 删掉 `deliverSupplierImagesInner` 里"这一组已经出过 ⇒ 跳过"那一段（前置 `findDocument` 判据） | **AC-SS4**（重放又渲染 3 次）· AC-SS4b 仍绿（它证的是相反方向） |
| ② | `supplierSplitService.splitBySupplier` 的 `batchCount: 1` ⇒ `groups.length`（= ⓑ 的口径） | **AC-SS3** |
| ③ | `multiItemOrderService.planSubmission` 的 `payload` 里塞一个 `supplier_groups` | **AC-SS2** |
| ④ | 删掉 `resolveSupplierSplitConfig` 对取值的那道校验 | **AC-SS6** |

**两遍数字与自证**（在**rebase 到最新 `origin/main`（含 #734 / #735）之后**跑的两遍 ✓）：

| | 命令 | 结果 |
| --- | --- | --- |
| 第 1 遍 | `pnpm test` | **2841 tests / 2834 pass / 0 fail · EXIT=0** |
| 第 2 遍 | `pnpm test` | **2841 tests / 2834 pass / 0 fail · EXIT=0** |
| 依赖门禁 | `pnpm audit --prod --audit-level=high` | `No known vulnerabilities found` · EXIT=0 |

- 两遍之间 `git diff | shasum -a 256` **完全一致** ✓（变异期间也逐字节还原：三个源文件 `shasum -c` OK ✓）。
- ⚠️ **基线漂移如实记**：本刀开在 `origin/main = 2471282`（S1 #732 之后）；
  跑完第一轮时 main 已经前进到 `243410a`（**#734** docs pending ＋ **#735** S2：三处入口/提示条/**草稿也写明细**）
  ⇒ **rebase 到最新 main 后重跑两遍**（上面的数字就是 rebase 之后的），
  并按 #735 的口径把 **AC-SS5 成对迁移**（见 §4 那一行）✓。
  🔴 **不 rebase 的后果会是真的**：旧断言"草稿不写明细"会与 main 上那条口径**打架** ✗。

---

## 5. 边界（本刀**没做**的事，如实标 ✓）

- 🔴 **不碰** `services/scanWriteService.js`（冻结件，余量 0）：`sha256` 与 main **逐字节一致** ✓（AC-SS7）。
- 🔴 **不碰** `views/scanPageRenderer.js` / `config/scanPage.js`（"三处入口"另有排期 ✗）——
  本刀**不需要**改路由：分组在"写入口的计划冻结"那一步（**任何远端写入之前** ✓），
  引擎那一半（N>1）也在**调写入口之前**把组算好 ✓ ⇒ `routes/scanPage.js` **一个字没改** ✗。
- **未加任何列**（她 ADDENDUM-3 结论① ✓）；**未写生产 Base**（本刀全是单测，**零真表调用** ✓）。
- **未部署**（她在测试期间 ⇒ 只开 PR，不合并、不部署 ✗）。
- **退货链路的多货品支持**：**未做**（见 §3.6 的如实标注 ✗）。
- **S2/S3 的其余部分**（渲染提示条 / `?resume=1` / "存草稿"那颗按钮）**未做** —— 那是草稿那条线的另一半（另有排期 ✓）。
