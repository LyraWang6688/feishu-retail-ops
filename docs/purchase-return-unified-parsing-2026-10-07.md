# 采购退货解析并入「采购（报货）」那条路线（2026-10-07）

业务负责人口径（逐字）：

> 「所以现在我们**不分报货还是退货，都是按照同样的逻辑**：**如果数量说明不写，数量就默认为一双**。
>  你需要**把退货原有的那个解析路线删掉**，然后再把**采购的那个加上退货**就可以了」
> 「它除了是删数量映射，它也**删除了"不需要再去实时库存表里找数量有哪些尺码"的逻辑**，对不对？」
> 库存不够时：「**按照这个**」= 保持现状：**退能退的 + 把差额回报给她**。

生产真表事实（业务负责人 2026-10-07 22:2x 只读核过；本机看不到生产，以她给的结果为准）：

- 「信息填写」（`tblo0ffzFt7vyQw2`）现在 14 列，**「数量」列已被她删除**；
- 「尺码」= 关联「尺码管理」，**`multiple = true`（多选）**，实测形状 `38,40,41`
  （`text` / `record_ids` 都是数组）；
- 「所有尺码」[Lookup] 是飞书自动算的 ⇒ 代码不读不写。

---

## 〇、一句话

**解析只有一条路**：勾选的**多个尺码各展开成一条明细**，数量从**「数量说明」**解析、
**说明不写 ⇒ 每个勾选尺码默认 1 双**；退货与报货**共用这一段**，「采购行为」只区分**走哪条链路**
（报货出采购申请；退货扣库存 + 出退货单）。
**「去实时库存反推有哪些尺码」整段删除**；实时库存只用来回答「这一项最多能退几双」
（口径：退能退的 + 把差额回报给她）。

---

## 一、改完之后应该是什么样（验收标准）

| # | 验收标准 |
| - | -------- |
| AC1 | `V1_BITABLE_SCHEMA.tables.purchaseReport.fields` **没有** `quantity`（「信息填写.数量」已从生产表删除）⇒ 部署闸门不再对着这一列判红 |
| AC2 | 退货**复用报货那条解析**：`parseReportQuantities`（多选尺码逐个展开 + `buildPurchaseQuantities` 从「数量说明」解析），**数量说明没写 ⇒ 每个勾选尺码默认 1 双**；退货**不再有自己的解析路线**（`parseReportReturnQuantities` / `parseReportItems` / `parseReturnQuantity` 全删） |
| AC3 | 一行**多尺码** ⇒ 展开成**多条退货明细**：一尺码一行「具体信息」、一次库存扣减、图上每个尺码一行 |
| AC4 | ⭐ `planPurchaseReturn`（「按货号捞实时库存行 → 从那些行反推 `bySize`（有哪些尺码、各几双）」）**整段删除**；尺码与数量**只来自表单** |
| AC5 | ⭐ **库存不够的既有业务行为保留**：她说退 3 双、库存只有 2 双 ⇒ **退 2 双 + 把"差 1 双"回报给她**（差额提示仍回复退货单图那条根消息 = 同一个话题）；一双都没有时照旧「不扣库存、不标终态、告诉她没处理」 |
| AC6 | **真正写库存减少那一刀一个字不改**：仍由 `InventoryService.applyChange` 按注册表 `STOCK_MOVEMENTS[STOCK_PURCHASE_DECREASE].consumes = ['门盒','样品','仓库']` 挑行 |
| AC7 | 采购行为（报货 / 退货）**仍靠行为编码区分**（`config/purchaseBehaviors.js` / `purchaseReportBehaviorPolicy`）；只是"怎么解析"统一 |
| AC8 | 全仓不再引用「信息填写.数量」：`purchaseWebhookService.js` 里**零**处 `fields.quantity`（守门用例钉住） |
| AC9 | 全仓不再有"从实时库存反推尺码"的调用点（守门用例钉住 `planPurchaseReturn` 不存在、全仓零引用） |
| AC10 | 报货侧（采购申请）行为**一个字节不变**：出图/写单据/终态/不碰库存（哨兵用例） |
| AC11 | 全量 `node --test --test-concurrency=1` 连跑 **2 次** fail=0 |

---

## 二、关键 diff

改动文件（`git diff --stat`，**8 改 2 新**）：

```
 docs/README.md                                |   1 +
 server/src/config/v1BitableSchema.js          |  16 +-
 server/src/services/purchaseWebhookService.js | 278 ++++++++++++++------------
 server/test/purchaseLogCorrelation.test.js    |  12 +-
 server/test/purchaseReturn.test.js            | 240 +++++++++-------------
 server/test/purchaseReturnBatch.test.js       |  38 +++-
 server/test/purchaseReturnBatchRow.test.js    |  18 +-
 server/test/purchaseWebhookService.test.js    |  29 ++-
 （新）docs/purchase-return-unified-parsing-2026-10-07.md
 （新）server/test/purchaseReturnUnifiedParsing.test.js
```

### 2.1 schema（`server/src/config/v1BitableSchema.js`）— AC1

```diff
-        // 「数量」（number）是「采购退货」那种报货的数量来源；…
-        quantity: '数量',
+        // ⚠️ 「数量」映射**已删除（2026-10-07）**：…她的口径（逐字）：「不分报货还是退货，
+        //    都是按照同样的逻辑：如果数量说明不写，数量就默认为一双。…」
+        //    ⇒ 数量一律从「数量说明」解析（不写 = 每个勾选尺码 1 双）；
+        //      尺码一律来自「尺码」（关联「尺码管理」，multiple = true 多选）。
+        //    ⚠️ 「具体信息.数量」是**另一张表**的列，仍在（那是采购申请/退货明细的双数）。
```

### 2.2 解析只有一条路（`purchaseWebhookService.js`）— AC2 / AC7

**删掉** `parseReportReturnQuantities`（"读「数量」列、无尺码"）、承接分流的壳 `parseReportItems`、
文件头的 `parseReturnQuantity`；两处调用点改成**直接**调同一条：

```diff
-        // 按行为分流解析：采购申请 = 尺码 + 数量说明；采购退货 = 数量、无尺码。
-        details = await this.parseReportItems(fields, reportTable, behaviorKind);
+        // 解析**不分行为**：尺码（多选，逐个展开）+ 数量说明（不写 ⇒ 每个尺码 1 双）。
+        details = await this.parseReportQuantities(fields, reportTable);
```

（另一处 `processSupplierReport` 同样改成 `this.parseReportQuantities(fields, table)`；`behaviorKind`
只剩"走哪条链路 / 写在明细上的行为标记"两个用途。）

### 2.3 ⭐「退回明细展开」怎么实现的（含多码）— AC3

**没有任何新代码**——**复用报货那条已经验证过的解析**：

1. `parseReportQuantities(fields, reportTable)`：
   `getSizeReferences().resolveLinkedCells(fields['尺码'])`
   —— 复数接口，**多选关联会一次返回多个** `{ size, recordId }`（`sizeReferenceService.js:94`，
   `linkedRecordIds` 把 `record_ids` / `text` 两种数组形状都吃下）。
2. 把解析出来的整数尺码 + 「数量说明」交给 `buildPurchaseQuantities`（`purchaseQuantityPolicy.js:74`）：
   - 逐个尺码去重、保序 → `orderedSizes`；
   - **说明为空 → 直接 `orderedSizes.map(size => ({ size, quantity: 1 }))`（= 缺省一双）**；
   - 说明非空 → 模型只给"例外"，规则层合并（提到未勾选的尺码 / 同一尺码两个数 → 抛可重试的 mismatch）。
3. `items = parsed.map(item => ({ ...item, size_record_id: recordIdBySize.get(item.size) }))`
   —— 每个尺码各自带**自己的关联 record_id**，后面写「具体信息」的「尺码」列直接用它。
4. 退货侧 `prepareSupplierReturn` 把 `items` 交给 `planReturnFromItems` → `plan.sizes`
   （逐尺码声明/可退/实退），再 `returnEntries = plan.sizes.filter(quantity > 0)`；
   `applySupplierReturn` **逐条**处理：一尺码一行「具体信息」（幂等键
   `purchase_return:<记录id>:<尺码>`）＋ 一次 `inventory.applyChange`。
   ⇒ **N 个尺码 = N 条退货明细**（`itemDocIds` / `items` / `returnEntries` 三者一一对应，
   出图时 `requestIdByItemKey` 也按同一顺序编号）。

### 2.4 删掉"从实时库存反推尺码"，换成"只数能退几双"— AC4 / AC5 / AC6

`planPurchaseReturn`（整段删除）→ `planReturnFromItems`：

```diff
-  async planPurchaseReturn({ productRecordId, declared, size = null }) {
-    // ① 按货号(+尺码) 把实时库存的行捞出来（matching）
-    // ② 从那些行上 resolveLinkedCell 反推 bySize（有哪些尺码、各几双）
-    const bySize = new Map();
-    for (const recordId of take) { … bySize.set(linked.size, …) }
-    const sizes = [...bySize.entries()].map(([entrySize, quantity]) => ({ size: entrySize, quantity }));
+  async planReturnFromItems({ productRecordId, items }) {
+    // 尺码/数量**只来自表单**（items = parseReportQuantities 的结果）
+    const consumableStates = STOCK_MOVEMENTS[MOVEMENT_PURCHASE_DECREASE].consumes || [];
+    const liveRecords = await this.gateway.listAll('liveInventory');
+    const sizes = (items || []).map((item) => {
+      // 只数"这个货品 + 这个尺码 + 可退状态"的行数 —— **不解析库存行上的尺码**
+      const available = liveRecords.filter((record) => (
+        linkedRecordIds(record.fields?.[liveTable.fields.product]).includes(productRecordId)
+        && linkedRecordIds(record.fields?.[sizeField]).includes(item.size_record_id)
+        && consumableStates.includes(textValue(record.fields?.[stateField]))
+      )).length;
+      const taken = Math.min(item.quantity, available);
+      return { size: item.size, quantity: taken, declared, available, taken, shortfall, surplus };
+    }).sort((l, r) => l.size - r.size);
+    … 总数 = 逐尺码求和
```

- **真正扣库存那一刀一个字没改**：仍是 `inventory.applyChange({ kind: MOVEMENT_PURCHASE_DECREASE, … })`
  → 引擎按注册表 `consumes = ['门盒','样品','仓库']` 挑行（`inventoryService.js:156`）。
  本次只是把**同一份 `consumes`** 读来数 `available`（`config/salesMovements.js` /
  `inventoryService.js` 的 `STOCK_MOVEMENTS` **一行未动**）。
- `ensureReturnPlan` 的入参：`{ declared, size }` → `{ items }`；**冻结版本仍是 `1`**，
  旧形状（`sizes[] = { size, quantity }`）读 `entry.quantity` 照样读得出 —— 部署重启不会把
  在跑的退货算成 0 双。

### 2.5 差额回报（多尺码版）— AC5

`buildPurchaseReturnNotice({ itemNo, color, plan })`（不再传单一 `size`）：逐尺码归一化，
`shortfall = taken < declared` 的逐条说、`surplus > 0` 的逐条说；**所有尺码都退不掉**时仍是
「采购退货没处理：… 在实时库存里一双都没有，我没有扣库存，也没有把这条记录标成已处理」。
对得上时**不发**（图本身就是回执）。

---

## 三、逐条对照（验收标准 → 实现 → 证据）

| AC | 实现落点 | 证据（用例 / 命令） | 结论 |
| -- | -------- | ------------------ | ---- |
| AC1 | `v1BitableSchema.js` 删 `purchaseReport.fields.quantity` | `purchaseReturnUnifiedParsing.test.js` ③（`hasOwnProperty(report,'quantity') === false`）；`git grep -n "quantity: '数量'" -- src/config` 只剩 `purchaseRequest` / `purchaseInbound` / `inventoryLedger` | ✅ |
| AC2 | 删 `parseReportReturnQuantities` / `parseReportItems` / `parseReturnQuantity`；两处调 `parseReportQuantities` | 守门 ⑥（三个方法 `typeof === 'undefined'`）；② 用例（说明不写 ⇒ 各 1 双；写了 ⇒ 按说明） | ✅ |
| AC3 | 2.3（`resolveLinkedCells` 多选 → 逐尺码一行单据/一次扣减/图上一行） | ① 用例：`[size_38,size_40,size_41]` ⇒ 3 行「具体信息」＋ 3 行流水＋图上 3 行 | ✅ |
| AC4 | 2.4（删 `planPurchaseReturn`，新增 `planReturnFromItems`，只数不反推） | 守门 ⑥（全仓零 `planPurchaseReturn`；`planReturnFromItems` 存在）；`planReturnFromItems` 里**没有** `resolveLinkedCell(库存行.尺码)` | ✅ |
| AC5 | 2.4 + 2.5 | ④（3 双 / 库存 2 ⇒ 退 2 + 差 1 回报）、④（多尺码：有货那码照退、没货那码回报）、④（一双都没有 ⇒ 不写单据/不出图/不标终态）；`purchaseReturn.test.js` 差额提示回话题 + `reply_in_thread` | ✅ |
| AC6 | 2.4（写库存那一刀未动） | `purchaseReturn*.test.js` 全用**真 `InventoryService`**：仓库/样品/门盒都被扣（③ 用例 13 行扣到 0）；`git diff` 里 `config/salesMovements.js` / `inventoryService.js` **零改动** | ✅ |
| AC7 | `process()` / `runReturnBatch` / `runReportBatch` 仍按行为编码分流 | `purchaseReturnBatch.test.js` 混着采购申请与采购退货；`purchaseWebhookService.test.js` 两条分流用例；`purchaseReturn.test.js` 行为读不到 ⇒ 退回采购申请、不误扣库存 | ✅ |
| AC8 | 删掉两处 `fields.quantity` 读取 | 守门 ③（src 全量扫 `.fields.quantity`，**只允许**「具体信息」那两处，计数写死） | ✅ |
| AC9 | 删掉 `planPurchaseReturn` 全段 | 守门 ⑥（src 全量扫 `planPurchaseReturn` 零命中） | ✅ |
| AC10 | 报货链路的解析调用换成同名函数、其余一行未改 | ⑤ 哨兵（同一行输入两条链路解析出同一组）；「采购申请」用例（不动库存、图无 title、单据行为=采购申请）；`purchaseWebhookService.test.js` 76/76 全绿 | ✅ |
| AC11 | — | 见第六节：两轮全量均 `pass 1244 / fail 0` | ✅ |

---

## 四、先红后绿证据

**新增用例**（`server/test/purchaseReturnUnifiedParsing.test.js`，10 条）在**改动前**跑：

```
$ node --test --test-concurrency=1 test/purchaseReturnUnifiedParsing.test.js   # 改动前（HEAD d2b691a）
✖ ① 退货一行勾了 3 个尺码（多选）→ 展开成 3 条退货明细，一尺码一行单据
✖ ② 数量说明不写 ⇒ 每个勾选尺码默认一双；写了 ⇒ 按说明里的数
✖ ② 退货**不再读「数量」这一列**：表上残留一个「数量」值也影响不了解析
✖ ④ 她说退 3 双、库存只有 2 双 ⇒ 退 2 双 + 把「差 1 双」回报给她
✖ ④ 多尺码各自核对：有货的那一码照退，没货的那一码只回报差额
✖ ④ 库存一双都没有：不写单据、不出图、不标终态，明确告诉她没处理
✔ ⑤ 同一行输入（尺码多选 + 数量说明）在两条链路上解析出**同一组**（尺码, 数量）   ← 哨兵（改动前就该绿）
✔ ⑤ 采购申请那条链路行为不变（出采购申请、不碰库存、不是退货单）              ← 哨兵
✖ ③ 守门：schema 里没有「信息填写.数量」；全仓没有对它的读取点
✖ ⑥ 守门：不再有"从实时库存反推尺码"的计划器；退货计划器的尺码只来自表单
ℹ tests 10 · pass 2 · fail 8
```

失败原因（各自对应被删/被改的那一处）：
- ①/②/④ 系列：旧代码 `parseReportReturnQuantities` 读已不存在的「数量」列 → `任务 failed`
  （或声明数读成 `undefined`）；②「残留数量=99」那条在旧代码下 `declared` 读到 99 → 断言对比 `1` 红。
- ③ 守门：旧代码 `purchaseReport.fields.quantity === '数量'` → 红。
- ⑥ 守门：旧代码里 `planPurchaseReturn` / `parseReportReturnQuantities` / `parseReturnQuantity`
  全在 → 报 `['src/services/purchaseWebhookService.js']` → 红。

**改动后**：

```
$ node --test --test-concurrency=1 test/purchaseReturnUnifiedParsing.test.js
ℹ tests 10 · pass 10 · fail 0
```

---

## 五、既有退货用例的逐条处置（33 条一个不丢）

| 文件 | 处置 |
| ---- | ---- |
| `purchaseReturn.test.js`（14 → 11） | 夹具从「数量 + 无尺码」改成「尺码（多选）+ 数量说明」；<br>**删**「尺码选了多个 ⇒ 停下来要她拆记录」（新口径下多选正是**要支持**的 ⇒ 换成 ① 展开用例）；<br>**删**「A 情况只填数量」（那条解析路线已删除）；<br>**新增**「只退她说的那个尺码/双数，别的尺码按兵不动」「同一尺码剩 2 双要告诉她」 |
| `purchaseReturnBatch.test.js`（12 → 12） | `twoRecordFixture` 的 `数量: 6/7` 改成等价的「两尺码 + 说明里的双数」（**退掉的双数与库存扣减形状一个字不变**，断言 4 行单据 / 13 行实时库存扣到 0 全部保留） |
| `purchaseReturnBatchRow.test.js`（7 → 7） | `returnRecord` 默认 `尺码: ['size_36']`，`数量: 1` 的夹具删掉（数量说明不写 = 1 双） |
| `purchaseWebhookService.test.js`（76） | 退货那条分流用例：断言从"数量取自「数量」字段、不解析说明里的 9 双"**反过来**——"数量取自「数量说明」（= 9 双）"；混批用例同上 |
| `purchaseLogCorrelation.test.js`（5） | 两条退货夹具改成「尺码 + 数量说明」（一条带差额、一条是旧数据无批次号），断言（关联键一个不少）**一个字没改** |

---

## 六、全量两轮 + 闸门说明

```
$ git rev-parse --short HEAD        # 本次改动提交（基于 d2b691a）—— 全量两轮就是在这一棵代码上跑的
$ node --test --test-concurrency=1  # 第 1 轮
ℹ tests 1244 · pass 1244 · fail 0 · duration_ms 35131.723291
$ node --test --test-concurrency=1  # 第 2 轮
ℹ tests 1244 · pass 1244 · fail 0 · duration_ms 35255.346791
```

**Schema 闸门（本机 vs 生产）**：

```
$ node scripts/validate_v1_schema.js purchase      # 本机（指向**测试 Base**）
“报货批次”缺少 V1 字段: 到货状态、单据、验收原话、确认状态
```

⚠️ **这一条红是【改动前就有的】**：在**主工作区（未改动的 main）**跑同一条命令，
输出**逐字相同**（本地测试 Base 落后于生产，「报货批次」那 4 列还没补 —— 与本次改动无关，
见 `docs/purchase-batch-no-arrival-and-push-2026-10-07.md` 第 8 节）。
本次**删掉**一个映射不会让闸门变红（闸门只校验 "schema 里的名字 ⊆ 表里的名字"），
**生产上那条「信息填写缺少 V1 字段: 数量」的红只能由部署闸门（服务器上对着生产）验证** ——
本机**没有**生产凭证，是刻意的（AGENTS.md 第 8 条）。

---

## 七、CI 三项实际输出

开 PR 后回填（`gh pr checks` 的 test / CodeQL Analyze 三项，以及 `mergeStateStatus`）。

---

## 八、不确定处 / 我的解释（要她或 Lead 过目）

1. **AC4 与 AC5 的交界**：她说的"删掉去实时库存找有哪些尺码"删的是**反推**（尺码不再从库存来）；
   但"库存只有 2 双 / 差 1 双"要说得出来，就必须**数一次**这个尺码的可退行数。
   ⇒ 新计划器**只数数、不反推**：`size` 一律来自表单，实时库存只回答"这一项最多能退几双"。
   这是我对「退能退的 + 回报差额」与「删掉反推」两条口径的**交集解释**（代码注释里也写明了）。
   若她的意思是"连数都不许数（不够就让库存引擎抛错、整条不处理）"，那 AC5 的"退能退的"就做不到 ——
   这两条只能这样共存。
2. **`surplus`（她说得比库存少）的提示保留**：这属于"对不上要说出来"的同一族既有行为，
   本次没有要求删，故保留（文案不变：`还剩 N 双没退（总数是 M 双）`）。
   注意新口径下 `surplus` **只按她勾选的尺码**算（别的尺码不在这次退货里 ⇒ 不算"还剩"），
   这与旧口径（无尺码时按整个货号算）**有意不同**，因为"要退哪些尺码"现在是她明确勾的。
3. **旧冻结计划的兼容**：`return_plan.version` 仍是 `1`（不升级版本号）——升级会把在跑的退货
   重算一遍，而重算时库存可能已经被扣过。旧形状靠 `entry.quantity` 读；旧计划只有单尺码，
   计划级总数兜底即该项的数。
