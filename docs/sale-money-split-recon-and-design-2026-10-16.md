# task-62「货 / 钱分离」—— 只读核查 ＋ 设计 ＋ 判据（2026-10-16）

> 本文件是 **task-62** 的只读核查 + 设计 + 判据。**阶段一** base = `origin/main` **`b24a046`**；
> **阶段二** base = `origin/main` **`0c31748`**（2026-10-16 20:3x +8）。
> ⭐ **阶段一到阶段二的变化只有一条**：两件待裁决的事**都批了**（见 **第 11 节**）——
> ① **冻结文件解禁**（**一次性、只为本卡**）⇒ `services/scanWriteService.js` 的 `submitSale` 加了
> `deferFunds` 那**一条路**（**成对迁移**：冻结哨兵基线 `199551e1…` → `49772bda…`）；
> ② **AC-MS4 口径按今天取**：**跳过 = 恰一条【未收款】（差额 = 累计）**（不是"0 行"✗）。
> 🔴 **routes 改动仍然一条都没有实施**（`routes/scanPage/**` 被别的单元占着 ⇒ 按派活书**停手报 Lead**）——
> 本文件第 5 节那份"逐处 before→after"**照旧是方案**（现在它要调的那个 `deferFunds` **已经就位** ✓）。
> ⚠️ 阶段一已落的内容（`services/**` ＋ `config/**` ＋ AC-MSG1…MSG8）**逐字未动**，只是又被阶段二**加了一层**。
> 🔴 本卡**至今一个字节都没碰**：`routes/scanPage.js` / `routes/scanPage/**` · `views/**` · `config/scanWrite.js`。

---

## 0. 先说三条结论（其中第 ① 条**推翻了派活书里的一个前提**）

### ① 🔴 `submitSale` **就在**冻结文件里（派活书的"真值"是错的）

派活书里写：

> ⭐ **`submitSale` 这个名字其实不在冻结文件里** ✗ —— `services/scanWriteService.js`（1698 行 · sha `199551e1…` ✓）
> 里**没有** `submitSale` 函数 ✓ ⇒ 代码里那些「`submitSale`」大多是 **config/views 里的注释描述** ✗

**实测（今天 main `b24a046`）：**

```
$ wc -l server/src/services/scanWriteService.js
    1698 server/src/services/scanWriteService.js
$ shasum -a 256 server/src/services/scanWriteService.js
199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca   ← 与派活书写的那把 sha 一致 ✓
$ grep -n "const submitSale = async" server/src/services/scanWriteService.js
693:  const submitSale = async ({
```

- 行数 ✓、sha ✓ 都与派活书一致，**但** `submitSale` **确实定义在这个文件里**（`:693`），
  而且是**唯一的建单入口**（`:1668` 的 `module.exports` 里也把它导出）。
- 派活书那句大概是 `grep "function submitSale"` 扫出来的 —— 它是
  `const submitSale = async ({…}) => {…}` 这个**箭头函数赋值**的形状，不是函数声明。
- ⭐ **这条差别直接改变本卡的最大技术约束**：把"建单"提前到货品页，
  **要么动冻结文件**（`:693` 那一处接缝，见第 7 节选项 B），
  **要么在 `services/**` 另写一条平行的建单路**（会与冻结文件里的"行解析 / 会话 / 排队 / 异步"漂移，见选项 A）。

### ② 今天"点资金页那颗按钮才建单"的形状，**和我核到的一模一样**

```
【今天】点货品页【提交这一单】 ⇒ **业务表零写入** ⇒ 资金页（表里一个字都没有）
        点资金页【提交整单付款 / 跳过】 ⇒ **才建单**：主表 ＋ 明细 ＋ 收款 ＋ 库存 **一起写**
```

不是推测 —— `server/test/scanSaleE2E.test.js` 的 **AC-E2E-6 第 1 步**就用真路由断言过这条：

```
assert.equal(rowsOf(e2e, 'salesEntry').length, 0, '第1步：**一个字都不写**（主表 0）');
assert.equal(rowsOf(e2e, 'salesDetail').length, 0, '第1步：明细 0');
assert.equal(rowsOf(e2e, 'inventoryLedger').length, 0, '第1步：库存流水 0');
```

（今天本地实测：`/usr/local/bin/node --test --test-concurrency=1 test/scanSaleE2E.test.js` ⇒ **55 pass / 0 fail**。）

### ③ ⭐ "跳过"今天**不是**"收款明细 0 行"，而是**恰一条【未收款】**

这是本卡的**判据口径**上唯一必须她/Lead 拍一下的地方 —— **2026-10-16 晚已拍**（见第 11 节 ②）：
`server/test/scanSaleE2E.test.js` 的 AC-E2E-4 / AC-E2E-6 / AC-E2E-8 三条都断言：

```
assert.equal(rowsOf(e2e, 'paymentRecord').length, 1, '第4步：资金全空 ⇒ **恰写一条**【未收款】');
```

依据是她 **2026-10-16 晚**的裁定「**客户少付 ⇒ 自动记一条【未收款】（差额）**」
＋ 她 2026-10-14 逐字「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」。
⇒ 派活书 AC-MS4 里那句「跳过 ⇒ **收款明细 0 行**」与"**与今天'跳过'同值**"**两句不可能同时成立**。
**裁定：按今天的口径取后者**（= 恰一条【未收款】、差额 = 累计）—— 那条"0 行"的说法**作废**，
不是"她想要但会改口径"的待裁决项了（第 6 节 AC-MS4 那一行已按裁定改写 ✓）。

---

## 1. 今天真正的调用链（**逐行实测**，base `b24a046`）

### 1.1 三步走

| 步骤 | 入口（`routes/scanPage/index.js`） | 真正写库的地方 | 业务表写入 |
| --- | --- | --- | --- |
| ① 货品页【提交这一单】 | `action === actions.submitOrder`（`:3015` 起） | **没有**（分支里 `return sendPaymentStep(...)` `:3184`；它后面那段 `writeService.submitSale({…})` `:3191` 带 `// eslint-disable-next-line no-unreachable` ⇒ **死代码**） | **0**（只写本地会话：`saveDraftLines({ lines, paymentStep:'pending', status:draft, submitPending })` `:3050`） |
| ② 资金页【提交整单付款】 | `action === config.paymentStep.payAction`（`:2462` 起）· 闸门 `payPending = (…paymentStep…) === 'pending'` `:2470` | `writeService.submitSale({…})` **`:2654`** | 主表 1 ＋ 明细 N ＋ 收款 M ＋（差额）【未收款】1 ＋（现货）库存 |
| ③ 资金页【跳过】 | `action === config.paymentStep.skipAction`（`:2835` 起）· 闸门 `skipPending = 'pending' \|\| 'created'` `:2840` | `writeService.submitSale({ payments: [], … })` **`:2887`** | 主表 1 ＋ 明细 N ＋ **【未收款】1**（差额 = 累计）＋（现货）库存 |
| （刷新） | GET 里：会话 `paymentStep === 'pending'` ⇒ **仍给资金页**（`:1795-1903`，带领域限制） | 无 | 0 |

### 1.2 建单那一下到底在哪（**服务层**）

```
routes/scanPage/index.js:2654 / :2887
  └─ services/scanWriteService.js  submitSale (:693)            ← 🔴 冻结文件
       ├─ 排队 queue.run(`sale:${sessionId}`)  ← 幂等 / 连点保护就在这一层（同一把 submitKey）
       ├─ 会话 sessions.get / revive / completed（重放直接还上一次的结果）
       ├─ 每件实收 / 收款行 / 付款情况校验（校验失败 ⇒ 一个字都不写表）
       ├─ 建主表：createEntry(gateway, …) = services/salesEntryService.createSalesEntryWithOrderNo
       │        （:1149 调用；`createEntry` 在 :160 注入；单号生成/撞号复查在里面）
       ├─ sessions.saveSaleProgress({ master_record_id, order_no })   ← ⭐ 幂等的 resume 判据
       ├─ status().write(master, { userAction: '已确认' })
       ├─ sales().confirm({ salesEntryRecordId, items, payments, owed? })
       │        = services/salesOrderService.js  _confirm (:47)   ← ⭐ 货 + 钱都在这一处
       │             ├─ 主表：gift / totalAmount(总金额) / tradeType
       │             ├─ 销售明细 N 行（逐件实收 actualAmount）
       │             ├─ status: sales=已写入
       │             ├─ 收款明细：payments ＋（差额>0）一条【未收款】
       │             └─ status: funds=已写入
       └─ deliverStockLines(...)  (:608) → services/salesDeliveryService.deliver（现货扣库存）
            ⚠️ 它开头要 `isPosted(postedOf(entry))`（**只认「资金状态」**）⇒ **必须钱先写完**
```

### 1.3 几个**决定设计形状**的既有事实（都实测过）

1. **主表 record_id 在会话里 = "续写"判据**：`submitSale` 里 `let salesEntryRecordId = String(sale.master_record_id || '').trim()`
   ⇒ **有值就跳过建主表**（`if (!salesEntryRecordId) { createEntry… }`）。
   ⭐ 这意味着：**只要"货那一跑"把 `master_record_id`/`order_no` 落进会话，
   资金页那一跑原样调 `submitSale` 就会自动"续写同一张单"** —— 不必改资金页那条路。
2. **收款那一半的幂等是"整表比对"**：`PaymentService.recordInitialBatch` 结尾是
   `if (existing.some((record) => !used.has(record.record_id))) throw new Error('已有收款与当前销售草稿不一致，已停止自动重试')`
   ⇒ 🔴 **货那一跑绝不能先写一条占位【未收款】**（否则资金页那一跑必被这条拦死）。
   本卡已把这条做成**能真红的判据**：`test/saleMoneySplitGoodsHalf.test.js` 的 **AC-MSG5**。
3. **「资金状态」是下游的总闸门**：`isPosted(postedOf(entry))` **只读「资金状态」**，
   而工作台订单列表（`salesFollowupService.listOrders` `:255`）、补记收款（`:465`）、
   交付（`salesDeliveryService.deliver` `:68`）、二次交付、待处理推送都拿它当闸门。
   ⇒ 货那一跑**必须让「资金状态」停在「未写入」**（如实：钱还没写），
   而**库存扣减只能留在钱那一跑之后**（`deliverStockLines` 要求 `isPosted`）。
4. **"待补充"是读侧算出来的**，不是表里的一个值：`services/workbenchOrderSections.js`
   `fundsMissing = !payments.some((p) => String(p?.method ?? '').trim())`
   ⇒ "收款明细 0 行（或只有【未收款】）"⇒ 判进**待补充** ✓。
5. **异步（`SCAN_SALE_ASYNC_WRITE_ENABLED` 缺省 `true`）**：`submitSale` 在
   **第一次**（`wasResume === false`）且没带 `noDefer` 时，**建完主表就立刻返回**
   （成功页那句「本单已创建成功（单号）」），余下的明细/收款/库存交给**后台的同一跑**
   （同一把 `submitKey` ⇒ 走续写路径）。⇒ **"货那一跑"如果走 `submitSale`，"单号一出立刻回"这条已经现成**。

---

## 2. 要改成什么（她的逐字口径）

> 「我们实际上**货和资金是可以分开的**，但用的是**一个销售单号把它们绑定在一块**。
>  我们的**销售主表和销售明细，只要货品信息那一页填完，里面的金额就是定了的**。但金额定了之后，
>  **什么时候付款、分几次付、付款方式是什么，是在资金页里面去确定的**：
>  • **如果资金页里写了，收款明细就能写** • **如果资金页里没写，那就是待补充状态**」
> —— 她随后明确选：**「按你说的：货品页填完就建单」**。

```
【今天】点资金页那颗按钮 ⇒ 才建单（货+钱一起写）⇒ 到资金页时表里一个字都没有
【要改成】
  ① 提交货品信息（进资金页那一刻）⇒ 就建单：
     创建销售单号 ＋ 主表（总金额 ＋ 现货/预订 ＋ 赠品/交易类型 …照旧）＋ 明细（逐件实收）
     🔴 不写收款明细（钱那一半还没发生）
  ② 资金页 ⇒ 用同一个销售单号：写了 ⇒ 写收款明细；跳过 ⇒ 待补充
```

---

## 3. 开关（**本轮已落**）

| 项 | 值 |
| --- | --- |
| 变量名 | `SCAN_MONEY_SPLIT_ENABLED` |
| 缺省 | **`false`（关）** ⇒ **关着 = 与今天逐字一致**（硬红线） |
| 形状 | **显式布尔**（走 `config/envValue.readFlag`：空串/`false`/`0`/`no`/`off` ⇒ 关；认不出的值**当场抛**）——**不写** `process.env.X \|\| 默认` |
| 读取时机 | **调用时读**（`resolveSaleMoneySplitConfig(env)`），**不是模块加载快照** ⇒ 不踩"早于 `dotenv.config()` 求值"那个静默失效（AGENTS.md《改动 app.js 顶部的 require 顺序》） |
| 落点 | `server/src/config/saleMoneySplit.js`（新件，纯配置、零依赖） |

同文件还登记了会话标记 `SESSION_MARKERS.goodsCreated = 'goods_created'`（与今天的 `pending` / `created` 三个状态分开，不许混用）。

---

## 4. 改动面清单

### 4.1 阶段一**已做**（`services/**` ＋ `config/**` ＋ 测试，**没碰任何禁区**）

| 文件 | 改了什么 | 关着时的影响 |
| --- | --- | --- |
| `server/src/config/saleMoneySplit.js` | **新增**：开关 + 会话标记（见第 3 节） | **无**（没人读它 ⇒ 行为零变化） |
| `server/src/services/salesOrderService.js` | `_confirm` 支持 `input.fundsDeferred === true`：**只写「货」那一半**（主表总金额/赠品/交易类型 ＋ 明细 ＋ 销售状态），**不写收款明细、不置资金状态、不调 `progress.sync`**；失败那一支**也不写资金维**；货那一跑**带收款就当场抛** | **逐字不变**（`=== true` 显式布尔；不传就是今天的路） |
| `server/test/saleMoneySplitGoodsHalf.test.js` | **新增 8 条**判据（AC-MSG1…MSG8，见第 6 节末） | — |
| `docs/README.md` | 登记本文件（`docsIndexCompleteness.test.js` 的 **AC-DI1** 强制：新文档漏登记 ⇒ 红） | **无**（纯文档） |

### 4.1b 阶段二**已做**（🔴 **授权解冻**冻结件一处 ＋ 判据 ＋ 文档；**routes 仍然一个字没动**）

| 文件 | 改了什么 | 关着时的影响 |
| --- | --- | --- |
| `server/src/services/scanWriteService.js`（🔴 **冻结件 · 成对迁移**） | `submitSale` 加 `deferFunds`（**显式布尔**）：① 入参多传 `fundsDeferred: true` 给业务层；② **不扣库存**（`deliver` 要"资金状态已写入"，这一跑必然拒 ⇒ 如实报 `requested: 0`）；③ **不记 `completed`**，改记会话标记 `goods_created`（否则资金页那一跑会被当"重放"吸收 ⇒ 静默丢账 ✗）；④ 货那一跑**带收款 ⇒ 当场抛**（连主表都不建）；⑤ 后台那一跑**必须**带同一个 `deferFunds` | **逐字不变**（不传 / `false`：`confirm` 入参**连键都不出现** · 照扣库存 · 照记 `completed`；AC-MSD1 用"两次写库流水 + 入参 `deepEqual`"钉住 ✓） |
| `server/test/scanWriteServiceFrozen.test.js`（冻结哨兵） | **成对迁移基线**：`199551e1…`（1699 行）→ `49772bda…`（1770 行）＋ 新增 **AC-FRZ4 解冻台账**（改前 sha → 改后 sha → 依据，**只改常量不写台账 ⇒ 红**） | 哨兵**继续存在**（没删/没停用/没放宽 ✓，只是基线随授权那一刀一起搬 ✓） |
| 另外 **5 份同一基线副本**（都在注释里写着"与冻结哨兵同一个值"）：`scanPageSplitParity` · `scanDraftRouteWiring` · `scanDraftSaveResume` · `multiItemLogsAndRealmScan` · `supplierSplitAtGeneration` | 同一把新 sha ＋ 各自一行"改前 → 改后 → 依据" | 判据形状**一条没改**（仍是"逐字节比"✓）；`multiItemOrderSalesChain` 是**读哨兵常量**的 ⇒ 自动跟随 ✓ |
| `server/test/saleWriteBackgroundExtract.test.js` | 那条 `oldLines < 1700`（**剥离效果的代理指标**）在授权新增之后不再成立 ⇒ 改成**登记确切行数 1770** | 真判据（"两处实现只在新文件里"）**一个字没动** ✓；代理指标从"不等式"变"等式"⇒ **更严** ✓ |
| `server/test/saleMoneySplitDeferFunds.test.js` | **新增 7 条**判据（AC-MSD1…MSD7，见第 6.2 节） | — |

### 4.2 至今**没做**（🔴 需要 Lead 排让 / 裁决）

| 要改的地方 | 为什么没做 |
| --- | --- |
| `routes/scanPage/index.js`（+ 它将来拆出的子文件） | 🔴 **被【拆分单元 1】/【task-64】占着** ⇒ 按派活书**停手报 Lead**。改动方案见第 5 节（逐处 before→after）——⚠️ 它要调的那个 `deferFunds` **现在已经就位** ✓ |
| `views/**` · `config/scanWrite.js` | 🔴 各有主（派活书明列） |
| `docs/owner-requests-backlog.md`（她的逐字总账） | 本刀**没写**：那份文件在跑的其他任务也在动（最近一次是 `b7ba07e` 补 R-26…R-30），**怕撞**；她的逐字已完整落在本文件第 2 节 ＋ 第 11 节。若 Lead 要登记成 R-31，我再来（第 10 节"未做项"） |
| `.env.example` 登记 `SCAN_MONEY_SPLIT_ENABLED` | 开关**至今没有读取方**（routes 没接线）⇒ 登记了反而像"已经能开"。等接线那一刀**与接线同笔**登记 ✓ |

---

## 5. routes 改动方案（**逐处 before → after · 未实施**）

> 目标：**开关关着时逐字节/逐参数与今天一致**；开着时"货品页填完就建单"。
> ⚠️ 下面给的是**选项 B（动冻结件）**的形状；选项 A（不动冻结件）的差异在第 7 节标出。

### 改动 A —— 货品页【提交这一单】（`submitOrder` 分支，`:3015` 起；插入点在 `:3150` 的跳转前置判定**之后**、`:3184` 的 `return sendPaymentStep(...)` **之前**）

```js
// ── 改前逐字（唯一出口，:3184）─────────────────────────────────────────────
        // ⭐ 资金页：还没建单 ⇒ `orderNo: ''`（**不编** ✗）· `count` 用草稿行数 ✓
        return sendPaymentStep(res, req, {
          paymentMethods: await candidatePaymentMethods(req),
          realm,
          submitKey: body[fields.submitKey],
          count: pendingDraftLines.length,
        });
```

```js
// ── 改后（虚线：只在她点【提交这一单】这条路、且开关开着时多一段）────────────
        // ⭐ 资金页：还没建单 ⇒ `orderNo: ''`（**不编** ✗）· `count` 用草稿行数 ✓
        // ⭐⭐ task-62（货/钱分离）：开关开着 ⇒ **在这一刻就建单**（货那一半），
        //    钱那一半留给资金页；关着 ⇒ 下面这段一个字都不跑（逐字同今天）。
        let goodsOrderNo = '';
        if (moneySplitEnabled()) {
          const goods = await writeService.submitSale({
            openId, requestId, submitKey: body[fields.submitKey],
            payments: [],                       // 🔴 货那一跑不许带收款
            deferFunds: true,                   // ⭐ 新开关（选项 B 需要它进冻结件）
            lineAmounts,                        // 与今天同一个取值口径
            pendingLine: submitView?.found ? { … } : null,
            timing: saleTiming,
          });
          if (!goods.ok) { /* 如实：sale_partial_failed ⇒ 半成页 + 重试；否则 respondWriteFailure */ }
          goodsOrderNo = String(goods.order_no || '');
        }
        return sendPaymentStep(res, req, {
          paymentMethods: await candidatePaymentMethods(req),
          realm,
          submitKey: body[fields.submitKey],
          count: pendingDraftLines.length,
          // ⭐ 开着时如实给她单号（关着时 `''` ⇒ **页面 HTML 逐字节不变**）
          ...(moneySplitEnabled() ? { orderNo: goodsOrderNo } : {}),
        });
```

### 改动 B —— 资金页两个动作（`:2654` / `:2887`）：**理论上一个字都不用改**

因为货那一跑已经把 `master_record_id` / `order_no` 落进会话（`submitSale` 自己会落），
资金页那一跑再调**同一个** `submitSale` 就自动 `wasResume = true` ⇒ 跳过建主表、续写同一张单。
要核的只有两条（都在第 8 节的问题清单里）：
· `payPending` / `skipPending` 的闸门（`:2470` / `:2840`）还认不认 `pending`？（**建议保持**：她刷新仍要停在资金页）
· 成功页那句「本单已创建成功（单号）」的**异步分支**（`:2778` 的 `createdResult.deferred`）
  在续写那一跑恒为 `false` ⇒ 页面会变成"普通成功页"。**这是可见变化**，要她/Lead 拍（第 8 节 Q3）。

### 改动 C（可选，视 Q1 裁决）—— 跳过时"收款明细 0 行"

若她要**跳过 ⇒ 收款明细 0 行**（与今天"恰一条【未收款】"不同）⇒ 那是一次**口径变更**：
落点在 `services/scanWriteService.js`（`if (itemsCents - paidCents > 0) owedCents = …`）
或 `services/salesOrderService.js`（`owedCents = … ? outstandingCents : 0`）——
**两处都在本轮禁区/敏感面上，且会动 3 条既有 E2E 判据** ⇒ **必须先拿到她逐字才能动**（第 8 节 Q1）。

---

## 6. AC-MS1…MS7 **各自怎么证**（先写后做）

| AC | 怎么证（**能真红**） | 现在能不能做 |
| --- | --- | --- |
| **AC-MS1** 开关关 ⇒ 与今天**逐字一致** | ① **页面 HTML 逐字节**：E2E 走"提交（资金全空）⇒ 资金页"那一路，把返回的 HTML 与 base 的**同一路**做 `sha256` 对比（开关关 ⇒ 必须相同）；② **写入点/顺序/参数 `deepEqual`**：在 `test/scanSaleE2E.test.js` 的夹具里给 `writeService.submitSale` 套一层记录器，比对 base 与改后的**调用序列**（次数/顺序/每个参数逐字）；③ **全量 334 个测试文件两遍 EXIT=0**（回归面） | ② ③ 现在可做；① 需要 routes |
| **AC-MS2** 进资金页那一刻 ⇒ 主表 1 ＋ 明细 N ＋ 总金额/现货预订已在 · **收款明细 0 行** | 走真路由：`getPage → addLine ×2 → POST submit_order`，然后断言 `rowsOf(e2e,'salesEntry').length===1` · `salesDetail.length===2` · `salesEntry.总金额===300` · `salesDetail[].actualAmount===…` · `salesDetail[].交易类型` 在 · **`paymentRecord.length===0`** · `salesEntry.资金状态==='未写入'` | **需要 routes**（本轮已用 **AC-MSG3** 在**服务层**把"0 行 / 资金状态只出现未写入"钉红 ✓） |
| **AC-MS3** 资金页写了 ⇒ 收款明细 N 行 ＋ **仍是同一个销售单号** | 同一条 E2E 接着 POST `payment_pay`（现金 100）⇒ `paymentRecord` = 收款 1 ＋【未收款 1（差额 200）】；`salesEntry` **仍然只有 1 条**、`order_no` **与 MS2 那一刻逐字相同**（换号 ⇒ 红） | **需要 routes**（服务层两跑同号已由 **AC-MSG4** 钉住 ✓） |
| **AC-MS4** 跳过 ⇒ 收款明细 ＋ **待补充** | ⭐⭐ **口径已裁定（2026-10-16 晚，见第 11 节 ②）：按今天取 ⇒ 恰一条【未收款】（差额 = 累计）**，读侧 `workbenchSectionOf` 判进 `supplement`。判据：`scanSaleE2E.test.js` 的 **AC-E2E-4 / AC-E2E-6 / AC-E2E-8** 三条**一条都不许删/放宽**（"资金全空 ⇒ 恰写一条【未收款】"）；依据 = 她 2026-10-16 晚「客户少付 ⇒ 自动记一条【未收款】（差额）」＋ 2026-10-14「包括本次付款为 0」。⚠️ 派活书原来那句"跳过 ⇒ 收款明细 **0 行**"**作废** ✗（它需要改口径、要动上面 3 条既有判据 ⇒ 没做、也不该做） | **需要 routes**（判据本身已在既有 E2E 里 ✓） |
| **AC-MS5** **幂等**：连点两次 / 刷新 / 返回再点 ⇒ **只建一单** | 三条真红路径：① **连点两次提交**（并发两个 POST `submit_order`）⇒ `salesEntry.length===1`（货那一跑以会话里的 `master_record_id` 为闸门 ⇒ 第二次不新建）；② **刷新**（GET，会话 `paymentStep='pending'`）⇒ 仍给资金页、**零新增写入**；③ **返回再点**（同一把 `submitKey` 再 POST `submit_order`）⇒ 不新建第二张单；④ 点两次资金页（`payment_pay` + `payment_skip` 各一次）⇒ `completed` 命中 ⇒ `reused`、**不写第二遍** | **需要 routes**（服务层"两跑一条单"已由 **AC-MSG4** 钉住；"带收款就抛"由 **AC-MSG6** 钉住） |
| **AC-MS6** 部分失败 ⇒ **可见 ＋ 可重试**（不假成功） | 让明细第 2 行写入抛错：断言页面**不是**成功页（走 `sale_partial_failed` 那条既有页：带单号 + "重试"指引）、`salesEntry.销售状态==='部分写入'`；再点一次提交 ⇒ **接着同一张单**把第 2 行写掉（幂等续写） | **需要 routes**（服务层"失败不写资金维 / 销售维如实"已由 **AC-MSG7** 钉住 ✓） |
| **AC-MS7** 少付⇒未收款 · 券三口径 · 库存扣减**不变** | 三条既有判据**一条都不许删/放宽**：`scanSaleE2E.test.js` 的 AC-E2E-8（少付⇒恰一条【未收款】）· `scanSaleTwoLayerMoney.test.js` 的券三条（差额按面值 / 收款按结算款 / 状态待平台结算）· AC-E2E-5（现货扣库存、预订不扣）；另加"改后逐字"断言：这几条在**开关开着**的新链路上跑出的端状态与**开关关着**的今天**同值**（除 MS2 明说要提前的那几列） | 券那一条 ⚠️ **有真实冲突**（第 8 节 Q2）；其余需要 routes |

### 6.1 本轮已落地的**服务层**判据（8 条，全绿）

`server/test/saleMoneySplitGoodsHalf.test.js`：

| AC-MSG | 钉什么 |
| --- | --- |
| MSG1 | 开关：缺省 `false` · 显式布尔（空串/`false`/`0` = 关；认不出的值抛） · **调用时读**（改了就认） · 会话标记三态分开 |
| MSG2 | **关着（不传 / 显式 `false`）⇒ 表状态与写库流水 `deepEqual`**；今天的形状照旧（明细 2 / 收款 1 +【未收款 1】/ 资金状态=已写入）；返回值键集合与今天逐字相同 |
| MSG3 | **开着** ⇒ 总金额 + 明细 + 销售状态照写；**收款明细 0 行**；`paymentRecord` 写入层**一次都没被叫**；**资金状态只出现过「未写入」**；不调 `progress.sync` |
| MSG4 | **两跑一条单**：明细不重复 · 总金额同值 · 收款 = 她填的 +【未收款 1（差额）】· 资金状态由钱那一跑收口 · 主表只有 1 条 |
| MSG5 | 🔴 **反向证据**：若照今天口径在货那一跑先写占位【未收款】⇒ 资金页那一跑被 `已有收款与当前销售草稿不一致` **拦死**（证明那条占位行不能写） |
| MSG6 | 🔴 货那一跑带 `payments` / 带 `owed>0` / 带 `totalPaid+paymentMethod` ⇒ **当场抛**；`owed: 0` 放行且照样不写钱 |
| MSG7 | 🔴 半截失败 ⇒ 只写「销售」那一维，**资金状态绝不被写成「写入失败」**（销售维如实报"部分写入"） |
| MSG8 | 源码哨兵：`=== true` 显式布尔 · 那条【未收款】构造**逐字未动** · 分离的 `return` 在它**之前** · 失败支显式跳过资金维 · 那条构造**全仓只有一处** |

### 6.2 阶段二已落地的**提交层**判据（7 条，全绿）

`server/test/saleMoneySplitDeferFunds.test.js`（**真** `SalesOrderService` / `SalesDeliveryService` /
`InventoryService`＋内存网关 ⇒ "钱一行没写""库存一双没扣"都是**跑出来的** ✓）：

| AC-MSD | 钉什么 |
| --- | --- |
| MSD1 | ⭐ **关着（不传 / 显式 `false`）⇒ 逐字同形**：两跑的**写库流水逐条 `deepEqual`** ＋ 交给业务层的**入参逐字相同**（`fundsDeferred` **连键都不出现**）· 收款 1 条 / 资金状态已写入 / 现货照扣 / `completed` 照记 1 条 / `goods_created` **不许出现**（只屏蔽"她点确认那一刻"那个时间列 ⇒ 其余每个字段都逐字比 ✓） |
| MSD2 | ⭐ **货那一跑**（`deferFunds: true`）⇒ 主表 1（**总金额 300**）＋ 明细 2（逐件实收 200/100）＋ 销售状态已写入；**收款 0 行** · **资金状态停在「未写入」** · 库存维没碰 · `confirm` 入参只多 `fundsDeferred: true`（**不带 `owed`**）· 会话记 `goods_created` 且**没有 `completed`** |
| MSD3 | 🔴 **进资金页但没提交 ⇒ 库存一双未扣**：交付服务**一次都没被叫** · 实时库存门盒还在 · 库存流水 0 条 · 明细未交付 · 没有假的"库存没扣成"日志；**对照**：资金页那一跑（不带 `deferFunds`）才扣、且**同一个销售单号** ✓ |
| MSD4 | 🔴 **异步那一跑也必须 `deferFunds`**：第一次那一跑如实带 `deferred` ＋ `funds_deferred`；后台跑完 ⇒ 明细在、**收款仍 0 行**；进业务层那一次的入参也带 `fundsDeferred` ✓（去掉 `saleRestInput` 里那一行 ⇒ 后台就会写一条【未收款】＝把钱写了 ✗） |
| MSD5 | 🔴 **货那一跑不记 `completed`**（改记 `goods_created`）⇒ ① 同一把键再点一次**不建第二张单、不重复明细**；② 资金页那一跑（**同一把 `submitKey`**）**不是"重放"**⇒ 钱真的写上了、库存这时才扣、资金状态由它收口 ✓（若记了 `completed` ⇒ 钱永远写不上 = 静默丢账 ✗） |
| MSD6 | 🔴 货那一跑**带收款 ⇒ 当场抛**，且**一个字都不写表**（主表 0 / 明细 0 / 收款 0 / 根本没进业务层）✓ |
| MSD7 | 🔴 源码哨兵：接缝逐字（`deferFunds = false` · `=== true` · 两个 `fundsDeferred ?` 展开 · 那条闸门文案 · `owedCents = 0` · 库存 `requested: 0` · `goods_created`）· 分离分支在 `completeSale` **之前** · 服务层**不读**那个开关 · 🔴 **本卡没接线**（`routes/**` 里没有 `deferFunds` / 没有开关 —— 下一刀接线时必须**显式**改这一条 ✓） |

---

## 7. 两个实现选项 + **选了哪个**（⭐ 2026-10-16 晚：**选 B，已批准解冻**）

### 选项 A：**完全不动冻结件**，在 `services/**` 新写一条"货那一跑"

- 新增 `services/saleGoodsIntakeService.js`：调 `salesEntryService.createSalesEntryWithOrderNo` 建主表 →
  `SalesOrderService.confirm({ fundsDeferred: true })` 写明细 → 把 `master_record_id`/`order_no` 落进会话。
- 守：`services/scanWriteService.js` **一个字节都不动** ✓（本卡红线）。
- 🔴 代价（**必须写清**）：它会**复制**冻结件里那一段业务逻辑 —— 逐件实收解析 / 配品行 / 赠品 /
  交易类型 / `pendingLine`（"选尺码 + 提交"两下就是一单）/ 会话键 / `KeyedSerialQueue` 排队 /
  **异步把明细转后台**。这些**每一处都要与冻结件保持同步**，而它们正是最容易漂的地方
  （仓库自己的教训：同名方法静默覆盖、两份实现慢慢走歪）。
  另外它**不共享 `submitSale` 的那把队列** ⇒ 与后台那一跑并发时有**双写明细**风险。
- ⇒ 这个选项**能做**，但我不建议（"解耦"变成了"复制"）。

### 选项 B（**采用** ✅）：在冻结件 `submitSale` 上开**一处接缝**

```js
// services/scanWriteService.js —— 实际落地的形状（阶段二 ✓）
const submitSale = async ({ …, deferFunds = false, … }) => {
  const fundsDeferred = deferFunds === true;               // 显式布尔
  const saleRestInput = { …, ...(fundsDeferred ? { deferFunds: true } : {}) };  // 后台那一跑必须带上
  …
  if (fundsDeferred && usedPayments.length > 0) throw new Error('…货那一跑不许带收款：…');  // 一个字都不写
  if (fundsDeferred) owedCents = 0;                        // 没有"钱的结论"
  const result = await sales().confirm({ …, ...(fundsDeferred ? { fundsDeferred: true } : {}) }, …);
  const stock = fundsDeferred ? { requested: 0, delivered: 0, failed: 0, reasons: [] }  // 货那一跑不扣库存
    : await deliverStockLines({ … });
  if (fundsDeferred) {                                     // 不记 completed（否则资金页那一跑被吸收 ✗）
    await sessions.saveSaleProgress(sessionId, { [SESSION_MARKERS.goodsCreated]: true });
    return { ok: true, reused: false, funds_deferred: true, stock, ...summary };
  }
  await sessions.completeSale(…);                          // 关着 ⇒ 逐字同今天
};
```

- 好处：**单源**（行解析/会话/排队/异步一处都不复制）· 货那一跑天然享受"单号一出立刻回"（她的 ⑰ 口径）
  · 资金页那一跑**一个字不用改**（`wasResume` 自动续写）。
- 代价：**动了冻结件** ⇒ 必须走第 11 节 ① 那套**授权 + 成对迁移 + 台账**（已按四条条件做完 ✓）。
- ⚠️ 第 8 节 Q3①（成功页文案）与这一刀**绑在一起**：货那一跑如果走异步，页面拿到的仍是今天那句
  「本单已创建成功（单号）」（`deferred: true` 那条既有分支）；资金页那一跑变成**续写**
  ⇒ 普通成功页。**这仍然是"要她点头"的可见变化**，在 routes 接线那一刀才落地（见第 10 节 ③）。

### 我的建议（**已被采纳**）

🔴 ~~停手报 Lead~~ ⇒ **Lead 拿到了裁决**（第 11 节）：**(A) 批准改冻结文件**（一次性、只为本卡），
并要求走"冻结哨兵成对迁移 + 改动面最小（只加 `deferFunds` 那一条路）+ 库存等资金页那一跑"四条条件
⇒ 本卡按**选项 B** 落地 ✓。那条 `_confirm({ fundsDeferred })` 接缝对两个选项都是必需件（A 直接调它；
B 由 `submitSale` 透传），所以它先落在 `services/**` **没有浪费** ✓。

---

## 8. 未决问题 —— **Q1 已裁定**，其余仍然要一句话

| # | 问题 | 我的建议 / 影响 |
| --- | --- | --- |
| **Q1** ✅ | **"跳过"到底写不写那条【未收款】？** | ✅ **已裁定（第 11 节 ②）：按今天 ⇒ 恰一条【未收款】（差额 = 累计）**，依据 = 她 2026-10-16 晚 + 2026-10-14 逐字；派活书那句"0 行"**作废** ✗。AC-MS4 已按此改写 ✓ |
| **Q2** ⚠️ | **券与"金额在货品页定死"冲突**：券的差额按**面值**算，现在的做法是把 `(面值 − 结算款)` 从**货品那一侧**（明细实收金额）扣掉（`voucherPaymentService.adjustLineAmounts`）。若货那一跑已把明细金额写死，资金页那一跑**改不动**它 ⇒ 现有券算法对不上（会被明细一致性判据拦住） | **仍未决**（不在本轮两件裁决里）：三种解法都要她/Lead 拍 —— ⓐ 资金页那一跑**改**已写明细的实收金额（新写路径）ⓑ 券不扣货品侧、只影响差额（**改了既有口径**）ⓒ 有券的单"货那一半"延后到资金页（等于券不走分离） |
| **Q3** ⚠️ | **成功页文案与库存时机**：① 货那一跑返回"单号一出立刻回"（`deferred`）；② 资金页那一跑变成**续写**（`wasResume=true` ⇒ **不再走异步分支**）⇒ 成功页会从"本单已创建成功（单号）"变成普通成功页；③ 库存扣减只能留在资金页那一跑之后（`deliver` 要 `isPosted`） | ③ ✅ **已裁定**（她/Lead 明确「**货那一跑不扣库存**，等资金页那一跑才扣」＋ 判据 AC-MSD3 ✓：进资金页但没提交 ⇒ 库存一双未扣）；① ② 仍要点头（**只在 routes 接线那一刀可见**，见第 10 节 ③） |
| **Q4** | **资金页那份表单上的"每件实收"会不会被改？** 今天资金页那张表单**不带** `line_amount`（回落到会话里她提交时填的那份）。若她在资金页看不到金额、也没有改的口子，那 MS2 写的明细金额就是**终值** ✓；若将来资金页要能改，MS2 的明细会被第二次 PATCH（要另立判据） | 本期按"不改"设计；写进本文件当边界 |

---

## 9. 证据（本轮实测）

| 跑什么 | 结果 |
| --- | --- |
| `shasum -a 256 server/src/services/scanWriteService.js` | `199551e1…` = 派活书那把 ✓（**本卡一个字节都没动它**） |
| `git -C <repo> rev-list --count HEAD..origin/main` | `0`（动手前已对齐 origin/main `b24a046`） |
| `/usr/local/bin/node --test --test-concurrency=1 test/scanSaleE2E.test.js`（主工作区 · 只读复现） | **55 pass / 0 fail**（把"提交 ⇒ 零写入 / 资金页才建单 / 跳过恰一条未收款"三条既有事实复现出来） |
| `/usr/local/bin/node --test --test-concurrency=1 test/saleMoneySplitGoodsHalf.test.js`（worktree `.local/money-split`） | **8 pass / 0 fail**（AC-MSG1…MSG8） |
| **全量两遍**（`server/` 根 · `node --test --test-concurrency=1` · 系统 node `/usr/local/bin/node` v24.14.1） | 第 1 遍：`tests 2939 · pass 2932 · fail 0 · skipped 7 · EXIT=0`（155.9s）<br>第 2 遍：`tests 2939 · pass 2932 · fail 0 · skipped 7 · EXIT=0` |
| 两遍之间自证未改 | `git diff \| shasum -a 256` 两遍都是 `cd250f279bb577539e16398d8f826bfb9c1124c2b77a0c27c251de18ef1dd4c0` ✓ |
| `CI=true pnpm audit --prod --audit-level=high` | `No known vulnerabilities found` · EXIT=0 |
| **变异 5 组（真红）** | M1 尾部分离分支关掉 ⇒ **fail 3** · M2 失败支照旧写资金维 ⇒ **fail 2** · M3 去掉"货那一跑不许带收款"闸门 ⇒ **fail 1** · M4 开关缺省翻 `true` ⇒ **fail 1** · M5 显式布尔改 truthy ⇒ **fail 1** —— 每组之后**还原并逐字节核对**：`salesOrderService.js` = `c018bcb9…`、`saleMoneySplit.js` = `201fb4e1…`（与变异前逐字节相同 ✓） |
| 冻结件（阶段一） | `services/scanWriteService.js` sha `199551e1…` **没变**（阶段一一个字节都没动 ✓） |

### 9.1 阶段二实测（**解冻那一刀**）

| 跑什么 | 结果 |
| --- | --- |
| `shasum -a 256 server/src/services/scanWriteService.js` | 改前 `199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca`（1699 行）⇒ 改后 `49772bdaffc82411b427f5f5b26a9d74ca937e317fb4fbdebfd33492b7fd2c12`（1770 行）· 依据 = 第 11 节 ① |
| 冻结哨兵（改完**还没**成对迁移时） | **必然红**（AC-FRZ1 / AC-FRZ2 都红 ⇒ 证明那个哨兵**确实认得出**改动 ✓，不是空跑） |
| `test/scanWriteServiceFrozen.test.js`（成对迁移后） | **4 pass / 0 fail**（AC-FRZ1…FRZ4；新增的 AC-FRZ4 = **解冻台账**：只改常量、不写台账 ⇒ 红 ✓） |
| 同一份基线的其他副本 | `scanPageSplitParity` · `scanDraftRouteWiring` · `scanDraftSaveResume` · `multiItemLogsAndRealmScan` · `supplierSplitAtGeneration` · `saleWriteBackgroundExtract` · `multiItemOrderSalesChain` 一起跑：**75 pass / 0 fail** ✓ |
| `test/saleMoneySplitDeferFunds.test.js`（新 7 条） | **7 pass / 0 fail**（AC-MSD1…MSD7 ✓） |
| 新判据那一条（**库存一双未扣**） | AC-MSD3 断言：交付服务**一次都没被叫** · 实时库存门盒还在 · 库存流水 0 条 · 明细未交付 · 没有假的"库存没扣成"日志；**对照**那一跑（资金页，不带 `deferFunds`）才扣 ✓ |
| 引用 `scanWriteService` 的**全部**用例 | `grep -rln scanWriteService test/*.js`（48 个文件）⇒ **533 tests · 528 pass · 1 fail**；唯一那条失败 = `aiParsingRemoval.test.js` 的 **AC-11**（它比 `git show HEAD:`，而这一刀**当时还没提交**）⇒ **提交后即为绿**（见下一条提交的复跑 ✓） |
| **变异 4 组（真红）** | M1 货那一跑照旧扣库存（去掉那个分支）⇒ **fail 5** · M2 后台那一跑不带 `deferFunds` ⇒ **fail 5** · M3 货那一跑照记 `completed`（分离分支整段不跑）⇒ **fail 5** · M4 去掉"货那一跑不许带收款"那条闸门 ⇒ **fail 2** —— 每组之后**从备份还原**并逐字节核对：`scanWriteService.js` 仍 = `49772bda…2c12` ✓ |
| **全量两遍**（`server/` 根 · `node --test --test-concurrency=1` · 系统 node `/usr/local/bin/node` v24.14.1） | ⏳ **跑完补登**（那两遍必须在**提交之后**跑：`aiParsingRemoval` 的 AC-11 比的是 `git show HEAD:`）—— 数字与真 EXIT 补在下面 ⬇️ |
| **全量两遍（补登）** | 第 1 遍：`tests —— · pass —— · fail —— · skipped —— · EXIT=——`<br>第 2 遍：`tests —— · pass —— · fail —— · skipped —— · EXIT=——`（**下一条提交**里填真数字，不在跑之前编 ✗） |
| 两遍之间自证未改（补登） | 两遍之间工作树干净（`git status --porcelain` 空）＋ 冻结件 sha 两遍同值 ✓ |

---

## 10. 未做项（**如实登记**）

### 10.1 阶段一登记的（状态更新）

1. 🔴 **routes 改动一处都没做**（第 5 节是方案）：`routes/scanPage/**` 被【拆分单元 1】/**task-64** 占着 ⇒ 等 Lead 排让（**阶段二仍然没做** ✓ —— 写作用域就是"不碰 `routes/**`"）。
2. ✅ ~~冻结件没动（等裁决）~~ ⇒ **阶段二已按授权解冻**（第 11 节 ①）：只加 `deferFunds` 那一条路 ＋ 哨兵成对迁移 ＋ 台账 ✓。
3. **AC-MS1…MS7 里真正跑路由的那几条**（MS1① · MS2 · MS3 · MS4 · MS5 · MS6）**仍然没有落地**：它们要 routes；
   现在**服务层**已经有两层判据：MSG1…MSG8（业务层 `_confirm`）＋ MSD1…MSD7（提交层 `submitSale`）。
4. **`.env.example` 没登记 `SCAN_MONEY_SPLIT_ENABLED`**：开关还没有读取方（没人接线）⇒ 登记了反而像"已经能开"。
   等 routes 接线那一刀**与接线同笔**登记。
5. **`docs/owner-requests-backlog.md` 没登记她的逐字**（那份文件在跑的其他任务也在动 ⇒ 怕撞；本文件第 2/11 节已留存逐字）。
6. ✅ ~~Q1~~ ⇒ **已裁定**（第 11 节 ②）：跳过 = **恰一条【未收款】**；✅ ~~Q3③ 库存时机~~ ⇒ **已裁定**：货那一跑不扣库存（判据 AC-MSD3 ✓）。

### 10.2 阶段二结束时**仍然未决 / 未做**

7. ⚠️ **Q2（券与"金额在货品页定死"的冲突）**仍要她/Lead 一句话（第 8 节）。
8. ⚠️ **Q3①②（成功页文案）**仍要点头 —— 但它**只在 routes 接线那一刀才可见**（服务层今天不渲染任何页面 ✓）。
9. 🔴 **`routes/**` 一个字都没碰**（阶段二的写作用域就是"不碰它"）：`grep -rn deferFunds src/routes` **0 命中**，
   而且 `test/saleMoneySplitDeferFunds.test.js` 的 **AC-MSD7 ④** 把这条**钉成了判据**（下一刀接线时必须**显式**改它 ✓）。
10. **`views/**` · `config/scanWrite.js` · `routes/workbench.js`** 一个字都没碰（各有主）✓。

---

## 11. ⭐ 阶段二：两件待裁决**都批了**（2026-10-16 晚）

### ① 冻结文件解禁 —— **(A) 批准**（**一次性、只为本卡**）

> **业务负责人 2026-10-16 明确拍板「允许改冻结文件」**（**一次性** · **只为本卡**）。

四条条件（**逐条怎么落的**）：

| 条件 | 落地 |
| --- | --- |
| 1) **必须显式开关、缺省关** | 开关仍在**调用方**（`config/saleMoneySplit.js` 的 `SCAN_MONEY_SPLIT_ENABLED`，缺省 `false` · 显式布尔 · **调用时读**）；**服务层只认显式参数** `deferFunds === true` ⇒ 不传 / `false` = 与今天**逐字节一致**（AC-MSD1 用"两次写库流水 + 业务层入参 `deepEqual`"钉住 ✓） |
| 2) **冻结哨兵必然红 ⇒ 成对迁移 ＋ 台账 ＋ PR 正文贴授权** | **改前逐字**：sha `199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca`（1699 行）⇒ **改后逐字**：sha `49772bdaffc82411b427f5f5b26a9d74ca937e317fb4fbdebfd33492b7fd2c12`（1770 行）· **依据 = 业务负责人 2026-10-16 明确「允许改冻结文件」（一次性、只为本卡）**。哨兵**继续存在**（没删/没停用/没放宽 ✓）＋ 新增 **AC-FRZ4**（台账：只改常量、不写台账 ⇒ 红）＋ 同一份基线的 5 份副本**一起搬**（各带一行"改前 → 改后 → 依据"）✓ ＋ **PR 正文贴了这条授权** ✓ |
| 3) **改动面最小：只加 `deferFunds` 那一条路 ⇒ 既有三处调用方行为一行都不许变** | 既有三处调用方（`routes/scanPage/index.js:2654` 提交整单付款 / `:2887` 跳过 / `:3191` 死代码）**都不传 `deferFunds`** ⇒ 走今天的路（AC-MSD1 逐字同形 ＋ 全量回归面里那几条 routes E2E 全绿 ✓）；`deferFunds` 只被**新路**用（本卡**还没接线** ✓） |
| 4) **`deliverStockLines`：货那一跑不扣库存（等资金页那一跑才扣）** | 落成 `const stock = fundsDeferred ? { requested: 0, delivered: 0, failed: 0, reasons: [] } : await deliverStockLines(…)` ⇒ **判据 AC-MSD3**：「**进了资金页但没提交 ⇒ 库存一双未扣**」（交付服务一次都没被叫 / 实时库存不动 / 流水 0 条 / 没有假失败日志）—— **能真红**（变异 M1 ⇒ **fail 5** ✓） |

### ② AC-MS4（派活书里那句"跳过 ⇒ 收款明细 0 行"）—— **按今天的口径取**

> **裁定（2026-10-16 晚）**：「**跳过**」= ⭐ **恰一条【未收款】（差额 = 累计）** ✓ —— **不是"0 行"** ✗。
> **依据** = 她 2026-10-16 晚「**客户少付 ⇒ 自动记一条【未收款】（差额）**」
> ＋ 她 2026-10-14「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」；
> 既有 `test/scanSaleE2E.test.js` 的 **AC-E2E-4 / AC-E2E-6 / AC-E2E-8** 三条钉着这条（**一条都不许删/放宽** ✓）。

⇒ 第 6 节 **AC-MS4 那一行已按此改写** ✓（派活书那句"0 行"作废 ✗）。**没有**任何改动落到写库口径上
（今天怎么算差额、怎么补那条【未收款】，一个字都没动 ✓）。
