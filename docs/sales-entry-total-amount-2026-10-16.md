# 「销售主表 · 总金额」同步记录（业务负责人 2026-10-16）

> 起因：业务负责人在**生产**「销售主表」里加了一列「**总金额**」。
> 她的铁律（2026-10-05）：「我这边在**生产表里面做的任何更改**，**你都要改**啊」
> ⇒ 本刀 = **同步 schema** ＋ **接进写入**（映射与写入点一起做，不许只做一个，见 AGENTS）。

---

## 0. 她的原话（逐字照抄）

> 「我在**销售主表**里面加了一个**货币字段**，叫做「**总金额**」。
>  这个就是用来记录我们「**一单多货**」时需要判断的**累计金额**，也是**它的写入地方**。」

⇒ 三个事实从这句话里直接落地：
① 名字**逐字** =「总金额」（一个字都不许改）；
② 语义 = **累计金额**（"一单多货时要判断"的那个数）；
③ **她点明了写入地方** = 这一列本身（`销售主表`，**不是**明细那一侧）。

---

## 1. 只读事实

### 1a. 生产「销售主表」的那一列

| 项 | 值 |
|---|---|
| 表 | 销售主表（env 键 `FEISHU_V1_SALES_ENTRY_TABLE_ID`）· `tableId` `tblLjFe3NjU61xKB` |
| 列名 | 「**总金额**」（逐字） |
| `type` | **2**（数字） |
| `property` | `{"currency_code":"CNY","formatter":"0"}` —— 就是她说的"**货币字段**" |

⚠️ **诚实标注**：以上是 **Lead 用项目 SDK 只读核生产表**得到的事实，**不是我核的**——
本机**没有生产凭证**（AGENTS 第 8 条："禁止在本机配置与生产环境有关的凭证或者多维表格"），
所以**本机够不着生产 Base**。我**没有**、也**不可能**在本机复核这一列
（本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` 与 `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值** = 测试 Base）。
⇒ 真表若与此不符，`v1:schema-check:*` 会**当场报红**（不静默）—— 这正是要闸门的原因。

### 1b. 测试 Base 的「销售主表」

**结论：测试 Base 的那张表上，本来（截至本刀）【没有】「总金额」这一列。**

证据（**只读**，走项目自己的脚本 → 官方 SDK `appTableField.list`，**一个字都没写**）：

```
$ node server/scripts/list-v1-fields.js salesEntry
=== salesEntry  销售主表  table_id=tblchUNgfH7o0ydr  字段数=17 ===
     销售单号 | Text | field_id=fldgTRwCZW | 主字段
     录单人 | User
     确认状态 | SingleSelect
     销售状态 | SingleSelect
     资金状态 | SingleSelect
     库存状态 | SingleSelect
     收款状态 | Formula
     交付数量 | Formula
     待交付数量 | Formula
AUTO 录单日 | CreatedTime（飞书自动：创建时间）
AUTO 更新时间 | ModifiedTime（飞书自动：最后更新时间）
     交易类型 | SingleLink
     赠品 | Text
     售后次数 | Number
     库存流水 | DuplexLink
     销售明细 | DuplexLink
     收款明细 | DuplexLink
```

- ⚠️ **测试表与生产表 `table_id` 不同**（生产 `tblLjFe3NjU61xKB` / 测试 `tblchUNgfH7o0ydr`）
  —— 这是正常的（同一张逻辑表在不同 Base 里 id 不同），**不是**发现了两张表。
- ⇒ **闸门方向不对称**（AGENTS 第 11 条③）：我加映射之后，
  在**测试 Base** 上跑 `v1:schema-check:sales` **会红**（报"缺少 V1 字段：总金额"），
  而**在服务器上对着生产跑**才是这条判据的**真绿**。
- 🔴 **处置（本刀）**：**只报不写** —— 我**没有**去改测试 Base。
  写测试 Base 是允许的（AGENTS 第 1 条），但本刀的写作用域是
  `server/src/config/**` · `server/src/services/**` · `server/test/**` · `docs/**`，
  **不含** `server/scripts/**`（补列脚本要落在那里）。
  仓库里已有同形状的先例 —— 分支 `chore/test-base-voucher-column`
  的 `server/scripts/test-base-add-voucher-column.mjs` ＋
  `docs/test-base-voucher-column-2026-10-16.md`（**未合入 main**）。
  ⭐ **待办**：照那份的形状补一个一次性脚本把「总金额」建到测试 Base（**等 Lead 点头**）。

---

## 2. schema 同步（改前逐字 → 改后逐字 → 依据）

文件：`server/src/config/v1BitableSchema.js`，`tables.salesEntry.fields`。

**改前逐字**（`afterSalesCount` 之后直接是 2026-10-09 那段"5 列已删除"的注释）：
```js
        afterSalesCount: '售后次数',
        // ─────────────────────────────────────────────────────────────────────
        // 🔴🔴 2026-10-09（**已拍板，已落地**）：**这 5 列她在生产表里删掉了，
```

**改后逐字**（在两者之间**只加**了一个语义键；注释记了口径与依据）：
```js
        afterSalesCount: '售后次数',
        // ⭐ 2026-10-16：**「总金额」**（业务负责人在生产「销售主表」**新增**的列）。
        //   ……（口径 / 写入点 / 依据，见源码注释）
        totalAmount: '总金额',
        // ─────────────────────────────────────────────────────────────────────
        // 🔴🔴 2026-10-09（**已拍板，已落地**）：**这 5 列她在生产表里删掉了，
```

**依据**：她 2026-10-16 那句（本文件第 0 节，逐字）＋ AGENTS《生产表里的任何更改都要同步到代码》。
🔴 **中文只出现在配置里**（`src/config/**`），逻辑里一行都没有
（`noHardcodedChinese` 的扫描范围本身就不含 `config/`，新加的日志串走 `logInfo/logWarn` = 豁免类）。

### 2b. `v1SchemaScopes` 要不要改？—— **不用**

- `salesEntry` **已经在** `V1_SCHEMA_SCOPES.sales` 里（`server/src/config/v1SchemaScopes.js`）；
- 闸门的算法是「**schema 里的字段名 ⊆ 真表的字段名**」，按 **tableId** 查（`validateTables`）；
- ⇒ 新增一个映射**自动**被闸门盯上，**不需要**在 scopes 里再做任何声明。
  ⚠️ 反向也成立：**漏了映射闸门不会报**（她那个字段就永远空着）—— 这就是本刀必须做映射的原因。

---

## 3. 写入点选在哪？（复用既有的一次写库，不新增请求）

### 3a. 先只读核了两件事

① **今天的销售提交写没写别的金额列？**
- 明细级：`销售明细.实收金额`（`actualAmount`）—— **逐行**写（她要的"每一双都要填实收金额"）。
- 整单级：**没有**任何一个"订单金额"列被写过（`销售主表` 上没有任何金额列）。

② **有没有既有的"订单级金额"字段（`order_amount`）？**
- 有，但**不在销售链上**：`order_amount` 是**采购**那两条链的（补货 / 退货）草稿与载荷字段
  （`services/multiItemOrderService.js` · `services/scanWriteService.js` ·
  `services/purchaseReturnService.js` 的 `draft.order_amount` → `purchaseOrderBatch` 的「实际金额」）。
- ⇒ **不能复用**（它是退货链的单头金额，消费者是采购写入件，与「销售主表」不是同一张表）。
- ⚠️ 顺带核过：这两条采购链所在的 `scanWriteService.js` 是**冻结文件**（余量 0）⇒ 本刀**一个字没碰**。

### 3b. 选点 = `services/salesOrderService.js` 的 `_confirm`，与**赠品**同一次 PATCH

**为什么是这里**：
- 它是**所有销售入账的唯一出口**：群聊（`v1PostingService.postSale`）·
  扫码（`scanWriteService.submitSale`）· 工作台 · **将来的一单多货销售**
  （按 `.local/multi-item-sales` 的只读核对：销售的 N 件进既有的 `session.sale.lines` ⇒
  仍旧落回**既有 `submitSale`** ⇒ 仍旧到这里）⇒ **不用第二条写入点**（两处各写必然漂移）。
- 这里**本来就有一次**对「销售主表」的 PATCH（赠品那一次）⇒ 把「总金额」并进**同一个 payload**
  ⇒ **不新增一次请求** ✗（她最在意的"少打飞书"+ 本仓提速口径）。

**改前逐字**：
```js
      await this.gateway.update('salesEntry', salesEntryRecordId, { gift: orderGift }, { correlation });
```
**改后逐字**：
```js
      const orderAmountsKnown = expected.every((item) => item.amountKnown);
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        gift: orderGift,
        ...(orderAmountsKnown ? { totalAmount: totalCents / 100 } : {}),
      }, { correlation });
```
**依据**：她 2026-10-16「也是**它的写入地方**」＋ 本仓"同一笔写库、不许两处各写"。

### 3c. 与既有算法的关系：**零冲突**

| 既有口径 | 本刀的影响 |
|---|---|
| 「实收金额**逐行**」（她 2026-10-16） | **不动**。逐行那一次 `create` 一个字节没改。 |
| 「少付 ⇒ **自动**记一条【未收款】」（她 2026-10-16 裁的 A） | **不动**。差额仍 = `totalCents − paidCents`。 |
| 券：差额按**面值** / 明细按**平台结算款** / 状态**待平台结算** | **不动**。券的调整在**入口**（`voucherPaymentService`）就把行金额换成净额 ⇒ 总金额跟着**调后**的行金额走。 |
| 「累计不可知 ⇒ **不编**」（`no_known_total`，2026-10-11 方案甲） | **沿用同一条**：有行没填实收金额 ⇒ **一个字都不写**。 |

---

## 4. 累计口径（含券 / 少付 / 多件）

```
总金额（销售主表，元） = Σ 该单【所有明细行】的「实收金额」
                        = salesOrderService._confirm 里**既有的** totalCents / 100
```

- **它不是一个新算法**：`totalCents` 就是"每件实收合计"，上面「少付 ⇒ 未收款」用的也是它
  ⇒ ⭐ **总金额 − 收款合计 ≡ 那条【未收款】的金额**（"还差多少钱"只有这一个算法，天然自洽）。
- **多件**：N 行就加 N 行（按**分**相加，不用浮点比 ⇒ 0.1 + 0.2 那类误差不会写歪）。
- **券**：行金额在入口已被调成净额（成交额 − 面值 + 结算款）⇒ 累计跟着调后的值走，**本层不认识券**。
- **少付**：**不改累计**（累计是"应收/实收合计"，不是"已收"）；差额单独由那条【未收款】表达。
- 🔴 **不写 0**：有行没填实收金额 ⇒ 累计**不可知** ⇒ **那一格留空**，并记一条
  `sales.entry.total_amount.skipped`（`reason=line_amount_missing`）——
  ⚠️ **不是静默跳过**。写 0 会把"她还没填"说成"这一单收了 0 元"，那是**错账**。
  另：每个已知行金额都 > 0（既有校验 `actualAmountCents <= 0` 当场抛）⇒
  算得出来时 `totalCents` **必然 > 0**（负值也进不来）。

### 4b. ⭐ 她同一天加的**第二列**「金额核对」—— 正是这条口径的**交叉校验**

> 她的原话（2026-10-16 逐字，由 `cca66a7` 带进 main）：
> 「我加了一个在**销售主表**里面加了一个**查找引用字段**。它是多维表格的**自动字段**，
>  叫做「**金额核对**」，是为了**判断你的累计金额有没有填对**。」

- 那一列是 **type 19 · ui `Lookup` · 只读**（飞书自动算），登记在
  `v1BitableSchema.salesEntry.readOnlyFields.amountCheck`（**绝不进 `fields`** —— `fields` 就是写白名单）；
  判据见 `server/test/salesEntryReadOnlyFields.test.js` 的 AC-RO1…AC-RO4。
- ⇒ **她自己在表里就能看出「总金额」填对没填对** ⇒ 本刀的口径必须是
  **能被那一列对上的那个数**：Lookup 引用的对端表就是「**销售明细**」（回填字段「销售单号」）
  ⇒ 「总金额 = Σ 明细行「实收金额」」正是它要比的那个和 ✓（两边口径互相印证，不是我们猜的）。
- ⚠️ **一处如实说明**：有行没填实收金额时，我们**留空**（不写部分和）——
  此时「金额核对」会显示**部分和**（Lookup 只加有值的那几行）。两者不一致是**有意的**：
  留空 = "还没填完"，她一眼看得出**不是错账**；若改成写"部分和"，那是一个
  **看起来正确、其实不是累计**的数 —— 更坏 ✗。（她要"缺金额也先写部分和"的话，那是一条**新口径**。）

---

## 5. 单货品（N=1）写不写？—— **建议：写**（依据如下；若要"留空"请她点头）

依据（逐条）：
1. 她的口径说的是「**累计金额**」= 该单**所有行**实收之和 —— 它是一个**和**，N=1 时那个和
   就是这一行的实收，**定义上没有"不适用"这一档**；她**没有**给 N=1 划例外。
2. 写入点是**唯一出口**；为一个 `N < 2` 的判据在这里分叉，是本仓一贯禁止的"按情形分支"
   （配置先行 / 不许散落 `if`）✗。分叉出来的效果是"这一列**有时空着**"，
   而她**分不清**"空"是"没算出来"还是"不适用" —— 正是 AGENTS 反复点名的**静默空列**。
3. **数据风险为零**：N=1 时的值就是**那一行**的实收金额（与"实收金额逐行"自洽），**不是猜测**。

⚠️ **这一条属于"不许自己定"那一类** ⇒ 已如实写进回报，**请 Lead 与她确认一句**：
「单件的那一单，销售主表的「总金额」要不要也填上？」（若要留空：一行分支 + 一条配置。）

---

## 6. 判据（能真红）

`server/test/salesEntryTotalAmount.test.js`（10 条，**测试名 = AC**）：

| AC | 钉住什么 |
|---|---|
| AC-TA0 | schema：`salesEntry.fields.totalAmount === '总金额'`（逐字）；`salesDetail` 那侧**没有**；全仓别处不许再映射「总金额」 |
| AC-TA1 | 多行 3 件（含券调过的行 + 少付）⇒ 总金额 = 各行实收之和（**按分**），且 **总金额 − 收款合计 = 那条【未收款】**（与"还差多少钱"自洽） |
| AC-TA1b | 券：行金额被入口调小 ⇒ 总金额跟着**调后的行金额**走（本层不重新发明口径） |
| AC-TA2 | 有行没填实收金额 ⇒ **一次都不写**（那一格**留空**，**不是 0**）＋ 如实记 skip；赠品/明细等既有行为一个字不变 |
| AC-TA3 | 零 / 负值 ⇒ **既有校验照旧拦**（人话）＋ 总金额**一个字没写**（没有任何 PATCH 带它） |
| AC-TA4 | **同一笔写库**：总金额与赠品在**同一条 PATCH** 里 ⇒ 不新增请求 |
| AC-TA5 | 重试幂等：同一单跑两次 ⇒ 总金额值相同、明细不重复、【未收款】不重复挂 |
| AC-TA6 | N=1 **也写**（附上面的依据） |
| AC-TA7 | **反向哨兵（源码）**：写入行逐字在位（删掉 ⇒ 红）＋ skip 日志在位 ＋ **全仓只有一处**写 `totalAmount`（多了会漂移） |
| AC-TA8 | **成对迁移**：`amountsKnown` 收敛成**一个来源**；既有 `owed` 三段判据一字不动 |

### 6b. 成对迁移（改前逐字 → 改后逐字 → 依据）

同一个事实（"有没有行没填实收金额"）原来在 `_confirm` 里被**算了两遍**。
本刀新增的「总金额」也要用它 ⇒ 收敛成**一处**：

- **改前逐字**（「差额」那一段，唯一一处）：
  ```js
      const amountsKnown = expected.every((item) => item.amountKnown);
  ```
- **改后逐字**：判断挪到「总金额」那一段，`amountsKnown` 改成引用：
  ```js
      const orderAmountsKnown = expected.every((item) => item.amountKnown);   // 「总金额」段（唯一来源）
      …
      const amountsKnown = orderAmountsKnown;                                  // 「差额」段（引用）
  ```
- **依据**：**只许有一个来源**（`AC-TA8` 钉着"`expected.every(...amountKnown)` 全仓只出现一次"）。
  ⚠️ **判据集合只增不减**：既有的 `outstandingCents` / `no_known_total` / 「少付 ⇒ 自动记未收款」
  三段**一个字都没动**（AC-TA8 也把这三段逐字钉住）。

### 6c. 变异自证（≥2 组，真红后逐字节还原）

见 PR 说明（本文件只留结论）：三组变异（①拿掉写入行 ②累计只取第一行 ③缺金额时写 0）
都**真红**，还原后 `git diff` 与改前**逐字节一致**。

---

## 6d. 受影响的既有判据 —— **成对迁移**（两条，都是"字段逐字对照"类）

跑全量测试时**当场变红**的正是这两条（说明它们真的在守门 ✓）。按规矩：
**只做加法、判据的严格度不变**（仍是全等），并把 改前逐字 → 改后逐字 → 依据 写进代码注释。

### ① `server/test/v1BitableGateway.test.js` —— 「生产真表列名快照」守门用例

- 它的判据：`for (const name of Object.values(schema.tables[tableKey].fields))` ⇒
  **名字必须在快照里**，否则报 `still maps deleted field …`（= "映射指到一个生产上没有的列" ⇒ 静默失效）。
- **改前逐字**：
  ```js
    salesEntry: ['收款状态', '录单日', '确认状态', '销售单号',
      '销售状态', '资金状态', '库存状态',
      '录单人', '待交付数量', '交付数量', '交易类型', '赠品',
      '售后次数'],
  ```
- **改后逐字**：同一行的 `'售后次数'` 之后加 `'总金额'`（`'售后次数', '总金额'],`）。
- **依据** = 她 2026-10-16 逐字（本文件第 0 节）＋ Lead 的**生产只读**核对
  （`appTableField.list`：名字「总金额」· `type=2` · `property={"currency_code":"CNY","formatter":"0"}`）。
  ⚠️ **本机没有生产凭证** ⇒ 这条快照**我核不到生产**（如实标注，按 Lead 给的只读事实同步）。
- ⚠️ **没有放宽**：循环仍要求"schema 里每个映射名都在快照里"；这次是快照**跟着真表**加了一个名字。

### ② `server/test/salesRecordIds.test.js` —— `AC-REG 其余字段一字未变`

- 它的判据：`assert.deepEqual(Object.keys(entry.fields).sort(), [ … ].sort())`
  —— **这一单写到销售主表的列，逐个对上**（多一列 ⇒ 红）。
- **改前逐字**：
  ```js
    assert.deepEqual(Object.keys(entry.fields).sort(), [ENTRY.orderNo, ENTRY.tradeType, ENTRY.userAction, ENTRY.gift, ENTRY.sales, ENTRY.funds].sort(),
      '主表这次写到的列：销售单号(原有) / 交易类型(新) / 确认状态 / 赠品 / 销售状态 / 资金状态 —— 没有多出来的列');
  ```
- **改后逐字**：期望数组末尾加 `ENTRY.totalAmount`，并在下一行**新增一条**数值断言
  `cell(entry, ENTRY.totalAmount) === 240`（这一单只有一行、实收 240）。
- **依据** = 她 2026-10-16 逐字（同上）：那一列**就是**她的口径要写的 ⇒ 它出现在"写到的列"里是**预期**。
- ⚠️ **没有放宽**：仍是 `deepEqual` 全等（少一列 / 多一列都红），而且**多加了一条**数值断言。

---

## 7. 未做 / 待办（如实标注）

1. ⚠️ **测试 Base 缺「总金额」列** ⇒ 本机跑 `v1:schema-check:sales` 会红（对着生产才是真绿）。
   **待办**：照 `chore/test-base-voucher-column` 的形状补一个一次性脚本（**等 Lead 点头**，
   本刀写作用域不含 `server/scripts/**`）。
2. ⚠️ **生产那一列我核不到**（本机物理够不着生产，AGENTS 第 8 条）⇒ 第 1a 节是 Lead 的只读事实。
3. ⚠️ **售后单（`afterSalesService` 新建的销售主表）不写「总金额」**：
   它走自己的 `create`，**不经** `_confirm`，而且它的行金额语义不同（赔货行 = 明确的 0）。
   本刀**不动**它；要不要给它也算一个"累计"，**等她说**。
4. ⚠️ **N=1 是否留空**：见第 5 节，**请她点头**。
5. ⚠️ `server/src/services/scanWriteService.js` · `routes/scanPage.js` · `views/scanPageRenderer.js` ·
   `config/scanPage.js`：**本刀一个字都没碰**（前两个是红线/冻结，后两个有人在排队写）。
