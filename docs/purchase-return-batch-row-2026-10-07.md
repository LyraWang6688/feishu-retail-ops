# 退货批次也落「报货批次」一行（到货状态留空）· 退货单 PNG 有落点 · 9 点推送不受影响

> **业务负责人口径（逐字，2026-10-07 晚）**
>
> 「**为什么退货批次不可以像申请一样，也自动生成呢？并且也落到报货批次表里呢？
>  然后如果退货申请也要落到报货批次的话，那么到货状态，就需要你在报货的时候，写入未到货，
>  然后退货，不用写**，你再来理解一下～」
>
> ⇒ 三条：
> 1. **退货批次也自动生成批次号**（与报货同一套生成器/格式 `CGD-YYYYMMDD-NNNN`、同一套幂等）；
> 2. **退货也往「报货批次」写一行**（这样**退货单那张 PNG 才有落点**：写该行的「单据」附件）；
> 3. **报货**建那行时写 **到货状态 = 未到货**；**退货**建那行时 **到货状态留空**（不写）
>    —— 留空的目的：**退货批次不会混进每天 9 点的「未到货」推送**（推送只认字面量「未到货」）。

> ⚠️ 本文件**先写"改完之后应该是什么样"（第 4 节验收标准），再动手**；第 5 节是逐条对照与证据，
> 第 6 节是改过的既有断言逐条说明，第 7 节先红后绿，第 8 节 CI，第 9 节不确定处。

---

## 1. 改动前的现状（核过的代码位置）

| # | 现状 | 位置 |
|---|---|---|
| 1 | **报货**：`confirmPurchaseRequest` 用 `createOnceByKey('purchaseOrderBatch', …)` 建一行，幂等键 = 已落盘计划里的 `purchase_batch:<批次 task_id>`，并写「到货状态 = 未到货」（取值来自配置） | `services/purchaseWebhookService.js` `confirmPurchaseRequest` |
| 2 | **退货**：走 `handleReturnBatch` → `runReturnBatch`（整批）或 `processSupplierReturn`（单条），**一条「报货批次」行都不建** | 同上 `runReturnBatch` / `processSupplierReturn` |
| 3 | 于是 `writeSupplierImageAttachment` 找不到落点：`findDocument` → `!found` → 记一条 `purchase.batch.document.no_record` 的 warn，**连素材都不上传** | `writeSupplierImageAttachment` / `PurchaseOrderBatchService.writeDocument` |
| 4 | 批次号在**入口**（`accept` → `ensureIntakeBatchNo` → `ensureReportBatchNo`）按包生成并写回「信息填写」；**退货记录走的是同一条入口**（`kind` 也是 `supplier-report`）⇒ 退货**已经**消耗号（生成器计数 = 「信息填写」∪「报货批次」并集） | `ensureReportBatchNo` / `services/purchaseBatchNoGenerator.js` 文件头 ② |
| 5 | 两条「退货不建报货批次」的既有断言钉着旧行为 | `test/purchaseReturn.test.js`、`test/purchaseReturnBatch.test.js`、`test/purchaseWebhookService.test.js` |

## 2. 决策与依据

| # | 决策 | 依据 |
|---|---|---|
| D1 | 退货批次的号**不重新生成**：入口已经按包生成并写回「信息填写」（`readReportBatchNo` 读到的就是它）⇒ 退货建行时**复用同一个号** | 她的口径是"退货批次也自动生成"，而**号在入口就已经生成了**（第 1 节 #4）；在退货那一侧再生成一次会得到**第二个号**，正是要避免的 |
| D2 | 建行落在 **`PurchaseOrderBatchService`**（新增 `createForReturnBatch`），由 `PurchaseWebhookService` 在**出图之前**调 | 「报货批次」那一行的读写本来就归这个 service（模块化）；出图之前建行，PNG 才有落点 |
| D3 | 建行用 `createOnceByKey`，**幂等键与报货同族**（前缀 `purchase_batch:`），但身份取**批次号**：`purchase_batch:<批次号>` | 报货那条的键是 `purchase_batch:<批次 task_id>`。退货这边**不能用 task_id**：一个退货批次重试时"领头的那条记录"可能换人（先投 A 还是 B 不定），换人就会算出**另一个键**、多建一行；**批次号才是这一包的稳定身份**（归批键就是它） |
| D4 | 退货建行**只写 批次号 + 幂等键**，**不写「到货状态」**（连 `arrivalStatus` 这个键都不进 `values`） | 她逐字：「**退货，不用写**」。留空 ⇒ 9 点推送（只认字面量「未到货」）**看不见它** |
| D5 | 建行只发生在**这一批真的有单子要出图**时（`runReturnBatch`：`requestIds.length > 0`；`processSupplierReturn`：`docIds.length > 0`） | 这一行的**唯一用途**是"退货单 PNG 的落点"（她的口径）。⚠️ 判据**不能**写成 `preparedList.length > 0`：`taken = 0`（一双都没退掉）的记录**也会**进 `preparedList`，但它没有 `docIds`、没有图 ⇒ 不该建空行（这一条由两套既有断言钉住，见第 6 节 #8） |
| D5b | 建行前**先按批次号回查**（`findByBatchNo`），命中就复用那一行、**绝不改它的到货状态** | 同一包里**混着**采购申请与采购退货时，两边是**两个归批批次、同一个批次号**；只按幂等键回查会各建一行（她的表里一个号出现两行） |
| D6 | 建行失败**不阻塞**出图/发群/流水（catch → warn） | 与既有「附件写失败不阻塞主流程」同一条纪律；库存与单据那时已经落地 |
| D7 | 退货行**不走**「改到货状态」那条路（到货核对本来就对退货话题直接退场） | 既有边界：`ARRIVAL_BATCH_KINDS.PURCHASE_RETURN` 已在到货核对入口被挡掉 |
| D8 | 用户可见文案里的旧表名「采购到货」→ **「到货验收」**（只改她点到的两处 ＋ 那句 toast＋两处会出现在她眼前的报错原文） | 她 2026-10-07 已把「采购到货」改名「到货验收」；AGENTS.md：生产表改名要同步用户可见文案 |
| D9 | `utils/larkCards.js` 那处默认标题 **本次不动**（另一个在跑的任务正在改这个文件） | task brief 明确：只改 `larkCards.js` 以外的，那处跳过并在汇报里写清 |

## 3. 不做什么（边界）

- 🔴 不碰销售侧任何文件、`utils/larkCards.js`、`pendingDealPush*`、`app.js`；
- 🔴 **不改「报货」那条链的既有行为**（只确认它仍然写「未到货」）；
- 🔴 `doubaoService` 的提示词/助手名不动（改它等于改解析行为）；
- 🔴 「报货批次」的「采购行为」列不读、不写、不映射（Lookup/公式，她的）；
- 🔴 不写任何生产表（只读核都没有做写操作）· 不部署。

## 4. 验收标准（**先写，后对照**）

| # | 验收标准 |
|---|---|
| A1 | 退货包（入口 `accept`）建「报货批次」**1 行**；该行的「报货批次号」＝「信息填写」那一列上的号（同一个 `CGD-YYYYMMDD-NNNN`） |
| A2 | 退货行的**「到货状态」是空的**：`values` 里**连这个键都没有**（不是"写了空串"） |
| A3 | 退货行的「幂等键」非空，且**与报货同族**（`purchase_batch:` 前缀） |
| A4 | **报货**包建的那一行仍然写「到货状态 = 未到货」（口径差异对钉） |
| B1 | **退货单 PNG 写到那一行的「单据」**：上传 1 次、`单据` 里 1 个 file_token、文件名以 `-退货单.png` 结尾 |
| B2 | 既有附件语义不变：**同名图 → 连上传都不做**（跳过）；**多供应商 → 已有附件带上再追加**（两张图都在同一行的「单据」里） |
| B3 | 没有落点时（真的没有号 / 建行失败）行为不变：**只 warn、不上传**，图照常发到群里 |
| C1 | 退货行（「到货状态」空）**不进** 9 点推送的候选；候选里只有字面量「未到货」的那些批次 |
| D1 | **重投**（同一条记录再收一次 webhook）不生成第二个号、不建第二行、不重复上传 |
| D2 | **重试/重跑**（把处理状态与任务状态手动改回未处理再跑一遍）同样只有 1 行、1 份附件 |
| E1 | **退货与报货不会拿到同一个号**：先跑一个退货包、再跑一个报货包，两行批次号不同（并集计数） |
| F1 | 「退货单」这条链路的**其余行为逐字不变**：扣库存、写「具体信息」、出图标题、发群（图 + 一句话）都不动 |
| G1 | 用户可见文案里的旧表名同步成「到货验收」：`config/arrivalConversation.js` 的卡片失败标题与 `replies.arrivalCreateFailed`、`purchaseWebhookService` 那句 toast |
| G2 | `utils/larkCards.js` **不改**（另一个任务在改它）· `doubaoService` 提示词不改 · 「报货批次.采购行为」不读不写 |
| H1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（在独立 worktree 里跑） |
| H2 | `gh pr checks` 见 **CLEAN**（`test` / `Analyze (javascript-typescript)` / `CodeQL`）；**不用 `--admin`**；**不开合并**（合并由业务负责人来做） |
| H3 | 既有断言**不放宽**；因**口径变更**必须改的逐条说明"为什么不是放宽"（第 6 节） |
| H4 | 🔴 不部署（等她当次命令）· 不写生产表 · 不改线上 `.env` |

## 5. 逐条对照（实现与证据）

> 全部证据来自**独立 worktree** `.local/worktrees/purchase-return-batch-row`
> （基于 `origin/main` = `6880923`，本机 `.env` / `server/node_modules` 用临时软链，验完删）。
> 新增用例文件 `server/test/purchaseReturnBatchRow.test.js`（7 条）。

| # | 结论 | 证据 |
|---|---|---|
| A1 | ✅ | 退货包（入口 `accept`）→ 「报货批次」**恰好 1 行**，`报货批次号` 与「信息填写」那一列**逐字相同**（入口生成的 `CGD-YYYYMMDD-NNNN`） |
| A2 | ✅ | 该行**没有** `到货状态` 这个键（`hasOwnProperty(...) === false`，不是"写了空串"）：单供应商 / 多供应商两处都断言了 |
| A3 | ✅ | `幂等键 === 'purchase_batch:' + 批次号`（与报货同族的前缀、身份取批次号，见 D3） |
| A4 | ✅ | 报货包那一行仍然 `到货状态 === '未到货'`（与退货行并排断言，防止"顺手带坏"） |
| B1 | ✅ | 退货行建成之后，既有 `writeSupplierImageAttachment`（一字未改）上传 **1 次**、`单据 === [{file_token: …}]`、文件名以 `-退货单.png` 结尾 |
| B2 | ✅ | 同名图 → **连上传都不做**（`uploads` 不增、`单据` 还是一张）；多供应商 → `单据` 里**两个 file_token**（第二张把第一张带上） |
| B3 | ✅ | 没有号（旧数据 / 入口没写回）→ **不建行、不上传**，图照常发（这条在改动前的代码上**也是绿的**——它钉的是"没落点时的既有行为"） |
| C1 | ✅ | 把退货跑完之后的**同一份假表**喂给 `PurchasePendingBatchService.listPendingBatches()`：候选里**只有报货那一批**（未到货），退货行一条都不进 |
| D1 | ✅ | 同一条记录再 `accept` 一次 → `duplicate: true`、号不变、**行数还是 1**、`uploads` 不变 |
| D2 | ✅ | 把 `处理状态` 与任务状态都改回未处理再 `process` 一遍 → 号不变、**行数还是 1**、`单据` 还是一条、`uploads` 不变 |
| ⑦（额外） | ✅ | **同一批次号已经有一行**（同一包里"采购申请"那半边先建过）→ 退货**复用**那一行、不建第二行、且**不改它的到货状态**（原来「未到货」就还是「未到货」），退货单图落在那一行上 |
| E1 | ✅ | 先跑退货包、再跑报货包：两个号**不同**，两行各自在表里（生成器数两张表的并集） |
| F1 | ✅ | 退货链路的其余行为**一字未改**：`purchaseReturn.test.js`（扣库存 / 写「具体信息」/ 出图标题 / 发群话术 / 重复处理不重复扣）与 `purchaseReturnBatch.test.js`（归批 / 一个话题 / 跨批不误合）**全绿**；本次只动了"建行"那一步 |
| G1 | ✅ | `config/arrivalConversation.js` 的 `card.failedTitle = 到货验收核对没成功`、`replies.arrivalCreateFailed` 以 `「到货验收」这一行没建成：` 开头；`purchaseWebhookService` 的 toast 逐字断言 `到货验收已入库`；两处会被拼进"她看得见的回话/提示"的报错原文（`到货验收草稿…` / `「到货验收」新建记录…`）也改了 |
| G2 | ✅ | `utils/larkCards.js` **一个字没动**（`git diff --name-only` 里没有它）；`doubaoService` 没动；「报货批次.采购行为」仍然不读不写不映射 |
| H1 | ✅ | 独立 worktree 里 `node --test --test-concurrency=1` **连跑 2 次**：`tests 1209 / pass 1209 / fail 0`（两次相同）。⚠️ 这是**修掉第 7.1 节那个用例抢跑之后**重跑的两次（修之前本地两次也是全绿——所以本地绿不算数，CI 才算） |
| H2 | ✅ | `gh pr checks` 三项见第 8 节；**没有**用 `--admin`；**没有合并**（合并由业务负责人来做）；**没有部署** |
| H3 | ✅ | 改过的既有断言逐条见第 6 节；**没有一条是放宽**（其中两条比原来更严） |
| H4 | ✅ | 没有部署、没有写任何表（读表只用 `scripts/list-v1-fields.js` 的**只读**接口 `appTableField.list`）、没有改 `.env`（worktree 里是临时软链，收尾删） |

### 5.1 关键 diff（一图看懂）

```text
server/src/services/purchaseOrderBatchService.js
+ const purchaseBatchRowKey = (batchNo) => `purchase_batch:${batchNo}`;   // 与报货同族
+ async createForReturnBatch(batchNo, { correlation }) {
+   const existing = await this.findByBatchNo(batchNo);        // ① 先按批次号回查（一批一行）
+   if (existing) return { reused: true, recordId: existing.record_id, … };
+   const batch = await createOnceByKey({                      // ② 才建
+     tableKey: 'purchaseOrderBatch', keyValue: purchaseBatchRowKey(batchNo),
+     values: { batchNo, idempotencyKey },                     // ⚠️ 没有 arrivalStatus
+   });
+ }

server/src/services/purchaseWebhookService.js
  runReturnBatch:   const requestIds = preparedList.flatMap((p) => p.docIds);
+                   if (requestIds.length) await this.ensureReturnBatchRecord(batchNo, {…});   // 出图之前
                    const delivery = await this.deliverReturnImages(…);
  processSupplierReturn: if (prepared.docIds.length) {
+                   await this.ensureReturnBatchRecord(prepared.draft.batch_no, {…});
                    delivery = await this.deliverReturnImages(…);
                 }
+ async ensureReturnBatchRecord(batchNo, {…}) { try { … } catch (e) { logWarn('purchase.return.batch.record_failed') } }

server/src/config/arrivalConversation.js
- failedTitle: '采购到货核对没成功'                  → '到货验收核对没成功'
- arrivalCreateFailed: '「采购到货」这一行没建成：…'  → '「到货验收」这一行没建成：…'
purchaseWebhookService.js: '采购到货已入库' → '到货验收已入库'（+ 两处报错原文）
```

日志：建行成功记 `purchase.return.batch.record_ensured { batch_no, batch_record_id, reused, idempotency_key }`
（复用时多一个 `matched_by: 'batch_no'`）；建行失败记
`purchase.return.batch.record_failed { batch_no, task_id, error, hint }`。

## 6. 改动的既有断言（逐条说明：口径变更 vs 放宽）

| # | 文件 / 用例 | 原来钉什么 | 现在钉什么 | 为什么是**口径变更**、不是放宽 |
|---|---|---|---|---|
| 1 | `purchaseReturn.test.js`「退货不建报货批次（第 5 张表）」 | `gw.records.purchaseOrderBatch === undefined` | **恰好 1 行**；`报货批次号 === 'B-1'`（= 这一包在「信息填写」上的号）；`hasOwnProperty('到货状态') === false` | 她 2026-10-07 晚逐字推翻了"退货不建行"：「**退货批次也……落到报货批次表里**」。断言从"**没有**这一行"换成"这一行的**三个字段逐字长这样**"——对「到货状态」仍然是**禁止出现**（不是"允许任意值"），对行数从 0 变成**恰好 1**（**更严**） |
| 2 | 同文件「退货不建报货批次 → 附件没有落点（既有边界）」 | `purchaseOrderBatch === undefined` + `uploads === []` | `uploads.length === 1` + `单据 === [{file_token: 'file_token_1'}]` | 这一刀的**目的**就是"退货单那张 PNG 要有落点"。断言从"一张素材都不传"换成"**恰好传一次**、且**恰好**写进那一个 file_token"（多传一次 / 多写一条都会红） |
| 3 | 同文件「货品没维护供应商…」末尾 | `assert.deepEqual(gw.uploads, [])` | 行数 1、号一致、`单据` 一条、`uploads` 1 | 同上；这条用例的**主线**（"没维护供应商也要能出单"）一个字没改 |
| 4 | `purchaseReturnBatch.test.js`「退货不写别的表…」 | `purchaseOrderBatch === undefined` | 恰好 1 行、号 = `202610061`（本包号）、`到货状态` 键**不许出现**；`purchaseArrival` / `purchaseInbound` 仍是 `undefined` | 同 #1。归批 / 一个话题 / 库存流水那几条断言**一条没动** |
| 5 | `arrivalConversation.test.js` 卡片失败标题 | `'采购到货核对没成功'` | `'到货验收核对没成功'` | 她当天已把表改名「到货验收」；**逐字**断言既没变严也没放宽，只是字面量换成新表名 |
| 6 | `arrivalConversation.test.js` 可见失败③ | `/「采购到货」这一行没建成：飞书 500…/` | `/「到货验收」这一行没建成：飞书 500…/` | 同上（"错误原文一个字不吞"这条语义不变） |
| 7 | `purchaseWebhookService.test.js` 入库幂等 | 第二次 `confirmArrival` 的返回值**没被断言** | **新增**：`again.toast.content === '到货验收已入库'` | **新增断言**（不是改）：把她点的那句 toast 的**新表名钉死** |
| 8 | `purchaseWebhookService.test.js`「采购退货一条…」（`taken = 0` → 0 行）与「混着采购申请和采购退货…」（1 行） | 0 行 / 1 行 | **一条都没改**（仍是 0 / 1） | ⭐ 这是**刻意保住的既有断言**：建行判据是"**真有单子要出**"（`docIds` 非空），所以"一双都没退掉"与"混包里退货那半边没有图"两种情况都**不建空行**（那一行的用途就是给图当落点）。**没有图就凭空多一行，反而是错** |

## 7. 先红后绿（证据）

新增用例先在**未改动的 `origin/main`**（`6880923`，detached worktree
`.local/worktrees/purchase-return-batch-row-red`）上跑一遍 —— **5 红 2 绿**：

```
ℹ tests 7
ℹ pass 2
ℹ fail 5
✖ A/B/C 退货包：入口生成号 → 建「报货批次」1 行（号一致 · 到货状态**空**）· 退货单 PNG 写进「单据」
    AssertionError: 退货包也要建「报货批次」一行（A1）   actual: 0 / expected: 1
✖ A4/C1/E1 报货行写「未到货」· 退货行不进 9 点推送候选 · 退货与报货不会拿到同一个号
    Error: 等待「两行「报货批次」都建好」超时
✖ D 重投 + 重跑：还是 1 行 / 1 份附件（同名图跳过，连上传都不做）   actual: 0 / expected: 1
✖ B2 一批两个供应商的退货：两张退货单都写进**同一行**的「单据」
    AssertionError: 同一包 = 一个批次 = 一行   actual: 0 / expected: 1
✖ G 到货那条链路的用户可见文案：旧表名「采购到货」→「到货验收」
    actual: '采购到货核对没成功' / expected: '到货验收核对没成功'
```

两条**在旧代码上就该绿**（回归哨兵）：`B3 没有批次号的旧退货数据…`（钉"没落点时的既有行为"）
与 `⑦ 同一个批次号已经有一行…`（钉"复用已有行"）。

改完之后在**本分支**上同一个文件：**7/7 通过**；相关既有用例文件一起跑 **204/204 通过**。

> ⭐ 中途还抓到一次**真问题**（不是测试写错）：最初的实现把建行判据写成
> `preparedList.length > 0`，而 `runReturnBatch` 里**"一双都没退掉"（`taken = 0`）的记录
> 也会进 `preparedList`**（只是没有 `docIds`）⇒ 上面 #8 那两套既有断言立刻**变红**。
> 判据改成 `docIds` 非空之后两处自动恢复绿 —— **这就是"既有断言不放松"的护栏在起作用**。

### 7.1 ⭐ CI 上**真红过一次**（本地全绿）：用例自己的等待判据抢跑，已修

- 第一次 CI：`tests 1209 / pass 1208 / fail 1`，红的是我新写的
  `B2 一批两个供应商的退货…` —— `assert.equal(ctx.images.calls.length, 2)` 读到 **1**。
- **根因（是用例的问题，不是产品的问题）**：那条用例等的是
  「两条记录的 `处理状态 = 已生成申请`」，而这个状态是在 `applySupplierReturn` 里**逐条**写的；
  两张图却在**整批**写完之后才由 `deliverReturnImages` 渲染/发群/回填附件
  ⇒ 断言**抢在出图之前**跑了（本地刚好躲过，CI 的调度让它露出来 —— 正是 AGENTS.md 第 15 条
  「本地测试通过 ≠ CI 通过」的形态）。
- **修法**：判据改成「整批任务落定 **且** 那一行的「单据」里两张图都回填到位」
  （这两件事都在出图**之后**）。本地**连跑 12 次 7/7**。
- 同一形态的自查：另外 6 条用例的等待判据都是「任务落定」或「附件已回填」，没有这个问题。

## 8. CI 三项实际输出

`gh pr checks 241`（**第二次** CI，修完抢跑之后；`mergeStateStatus = CLEAN`）：

```
Analyze (javascript-typescript)	pass	1m10s	https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37630181983/job/112822092927
CodeQL	pass	4s	https://github.com/LyraWang6688/feishu-retail-ops/runs/112822576263
test	pass	50s	https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37630189596/job/112822111618
```

`gh pr view 241 --json mergeStateStatus` → `{"mergeStateStatus":"CLEAN","headRefName":"feat/purchase-return-batch-row",
"url":"https://github.com/LyraWang6688/feishu-retail-ops/pull/241"}`。

⚠️ 第一次 CI 的输出（那次 `test` 红的）：
```
test	fail	1m0s	https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37629867055/job/112821007576
Analyze (javascript-typescript)	pass	59s	…/job/112820995941
CodeQL	pass	6s	…/runs/112821388452
```
⇒ 修完（第 7.1 节）重跑，三项全绿；**没有用 `--admin`、没有合并、没有部署**。

## 9. 不确定 / 没做到的地方

### 9.1 ⚠️ 「到货状态」在**飞书侧**有没有"字段默认值"—— 本机核不了（最关键的一条）

- 我们这条链路的保证是：**退货建行时 `values` 里连 `arrivalStatus` 这个键都不进**
  （测试逐字钉住）。如果那一列在飞书侧**没有**默认值，读回来就是**空** ⇒ 9 点推送看不见它。
- ⚠️ **但如果那一列配了默认值 = 「未到货」**，那么"不写"也可能被飞书填成「未到货」，
  退货批次就会**混进 9 点推送**——这正是她这条口径要防的。
- **为什么本机核不了**：按 AGENTS.md 第 8 条，本机 `.env` 指向**测试 Base**，而测试 Base 的
  「报货批次」**还只有旧的 4 列**（`node scripts/list-v1-fields.js purchaseOrderBatch` 的只读输出：
  报货批次号 / 创建时间 / 幂等键 / 更新时间），**根本没有「到货状态」这一列**。
- ⭐ **建议的核实办法**（只读、在服务器上、走项目代码 / 官方 SDK）：
  `appTableField.list` 拿「报货批次.到货状态」的字段元数据，看 `property` 里有没有默认值；
  或直接在生产上**只看**一条新建的退货批次行读回来是什么。
  ⚠️ 官方字段列表文档里，单选字段的 `property` 只有 `options`（**没有**默认值这一项），
  所以预期是"不写=空"；但这条**我没有在生产上核过**，不敢替她打包票。
- 🔴 **若核出来确实有默认值**：**停下来报告**，不要自己改成"写空串 / 写别的值"
  （往单选写空串同样会污染表，见 `PurchaseOrderBatchService` 的注释）。

### 9.2 ⚠️ 退货的「具体信息」行**没有**关联「报货批次」那一行（既有行为，本次没动）

- `applySupplierReturn` 写「具体信息」时**不带** `batchNo` 关联（报货那条带）。
  于是「报货批次」表上那列 **「采购行为」（Lookup/公式，她说是从明细来的）在退货批次行上
  可能显示为空** ⇒ 她那张表里"这一批是采购还是退货"未必看得出来。
- 本次**刻意没动**：她的口径是"那一行只写 批次号 + 幂等键"，而且她明确
  「报货批次里面的采购行为你不用管」。**要不要给退货的「具体信息」行补上批次关联，
  请她定**（补了 Lookup 才有值；不补就是现状）。

### 9.3 ⚠️ 同一包里**混着**"采购申请 + 采购退货"、而且**退货那半边也有图**时

- 两边是**两个归批批次、一个批次号**。本次让退货这边"先按批次号回查、命中就复用"，
  所以**报货先建行**的那种顺序只有 **1 行**（用例 ⑦ 钉住）。
- ⚠️ **反过来的顺序**（退货先建行、报货那边后建）**仍可能出现 2 行同号** ——
  报货那条链路的建行是 `createOnceByKey('purchase_batch:<它自己的 task_id>')`，
  它**看不见**退货那一行；要彻底解决必须改报货那条链路的建行（**本次边界明令不碰**）。
  ⇒ 这一条**如实报告**，"是否要给报货那条也加一步按批次号回查"请她/Lead 定。

### 9.4 没有真启动一次服务（只跑了 2 次全量单测）

- 本次**没有改 `app.js`**、也没有改任何 require 顺序，所以 AGENTS.md 第 5 条那条"必须真启动"
  的触发条件不成立；但我也**没有**真启动（本机 `.env` 会让它连上测试应用并起定时器）。
  ⇒ 部署闸门（`v1:schema-check:all`，**服务器上**对着生产跑）仍是唯一那道真闸门。

### 9.5 `utils/larkCards.js` 那处默认标题**没改**（按 brief 跳过）

- `utils/larkCards.js` 里群话题核对卡片的**默认标题**仍是 `'采购到货核对'`
  （卡片实际标题由 `config/arrivalConversation.card.title` 传，配置里那句是
  「本次到货核对完毕，确认入库吗？」，不叫旧表名）。
- brief 明确：另一个任务正在改这个文件 ⇒ **本次不动**，按她的要求在这里写清：**待补**。

