# 日志可读性：写入类日志补「能串起来」的键 ＋ 库存键两种写法并列（2026-10-07）

> 业务负责人 2026-10-07 拍板：**「日志改下吧！」**
> 起因是 `XSD-20261007-0004`（15:43–15:45）那条销售：一条业务链被劈成两半 ——
> 带 `task_id` 的那半（`lark.sales.*` / `lark.card.*`）能串起来，**真正写库的那半**
> （`sales.status.written` / `bitable.record.created` / `v1.sale.posted` /
> `inventory.change.applied`）一个键都没有，只能靠 `sales_entry_record_id`
> 或时间窗口手工去接。第一遍按 `task_id` grep → **"看不到"明细/收款/库存** → 差点误判。

> ⚠️ 本文档**故意没有**加进 `docs/README.md`：那份索引此刻正被另一个并行代理
> （`fix/card-update-multi`）编辑，改它会把"两个代理改同一个文件"变成合并冲突。
> 索引补齐由 Lead 在合并后一并做。

---

## 零、方案选择：**ⓑ 业务键 为主 ＋ ⓐ task_id 在拿得到的地方一起给**（不选 ⓒ）

**做法**：一个**显式的、可选的** `correlation` 参数，沿既有调用链往下传，
最终由「网关层」与「业务日志」原样合并进日志字段。它不是新的架构层，
只是把调用方**已经知道**的那几个键带下去。

**为什么是它（三条理由，逐条对应 brief 让我判断的地方）**：

1. **ⓒ（`AsyncLocalStorage`）在这个代码库里会给出【错的】键，不只是更复杂。**
   - 库存引擎有三处**跨请求重放**：`runForStock` / `SalesOrderService.queue` /
     `KeyedSerialQueue`。`resumePending(stockKey)` 会把**上一条（甚至上一次重启前）**
     尚未完成的操作，放在**当前这次请求**里继续执行。
   - 若键是从 ALS 里读的，这次重放写下的 `inventory.change.applied` / 流水日志，
     会被贴上**当前请求**的 `task_id` —— 排查时"这行日志指向了另一笔单"，
     比"没有键"更坏。
   - 显式传参天然没有这个问题：重放用的键来自**它自己那条本地任务记录**（见下）。
2. **ⓐ 单独用不够**：`task_id` 只存在于 `larkMvpService` 的本地任务层；
   `SalesOrderService` / `InventoryService` 是**启动时构造的单例**，
   把 `task_id` 放进实例字段 = 并发请求互相覆盖（跨请求泄漏）。
3. **ⓑ 单独用不够**：`order_no` 只在读过「销售主表」之后才知道（好在**零额外请求**：
   `SalesOrderService` / `SalesDeliveryService` / `SecondDeliveryService`
   本来就已经读了那条主表记录）。而 `task_id` 是她**实际用来 grep 的那个键**，
   只给 `order_no` 等于让她换一套习惯。

**ⓑ/ⓐ 一起给的是同一组白名单键**（`task_id` / `order_no` / `sales_entry_record_id`），
任何一个都能单独串起整条链；三个都在时最省事。

**网关层怎么处理的（brief 专门问的那件事）**：
`V1BitableGateway.create/update` 与 `V1BitableGateway` 一样**保持通用** ——
它只多收一个**不透明的** `correlation` 包，合并进日志；它**不查表、不推导、不认识
`order_no` 是什么**。所以：
- ✅ 不需要在业务层再补一条"带 task_id + record_id"的重复日志；
- ✅ 网关层没有变成业务耦合（它连"销售"这个词都不认识）；
- ✅ 不传 `correlation` 的调用方（含采购链路）行为**逐字不变**。

**本次刻意不覆盖的**：采购链路（`purchaseWebhookService` / 采购申请 / 采购入库）。
理由：那条链路的源文件正被并行代理分析/占用（`fix/card-update-multi` 的计划文档里
把它列为 patch 出口之一），强行插手违背并行纪律。⇒ 采购侧的 `bitable.record.created`
**仍然没有关联键**，如实写在下面 AC7。扩展点只有两处（见文末「扩展点」）。

---

## 一、验收标准（先写「改完之后应该是什么样」，再动手）

### ① 让「一条业务链」能用一个键串起来

| # | 验收标准 | 怎么验 |
| - | -------- | ------ |
| **AC1** | 确认卡片路径（销售入账 ＋ 交付）里**由业务代码打出的写入日志，每条都带 `task_id` ＋ `sales_entry_record_id`**，并在拿得到时带 `order_no` | 新增测试 `captureLogs` 抓**真实日志行**逐条断言；覆盖 `sales.status.written` / `v1.sale.posted` / `bitable.record.created` / `bitable.record.updated` / `sales.inventory.applied` / `inventory.change.applied` |
| **AC2** | **既有字段一个都不少**（`sales_entry_record_id` / `table_key` / `table_id` / `record_id` / `duration_ms` / `dimensions` / `operation_id` / `kind` / `stock_key` / `movement_quantity` / `direction` / `ledger_record_id` …） | 同一条测试同时断言新旧字段；既有测试**一条不放宽** |
| **AC3** | **不改变任何业务行为**：写入顺序、事务边界、远端请求的**内容**都不变，新增的只有日志字段 ＋ 一份本地任务记录上的 `correlation` | 既有全量测试全绿；新增测试对账"远端收到的 record fields 与改动前逐字相同" |
| **AC4** | **不引入跨请求泄漏**：关联键是**每次调用显式传入的普通对象**，绝不落在任何 service 实例字段上（那些 service 是启动时构造的单例） | 代码 review ＋ 新增测试：同一实例并发跑两笔单，两笔的日志各带各自的键 |
| **AC5** | **测试可注入**：`correlation` 是普通入参，测试直接传就能断言，不需要 mock 任何全局 | 新增测试就是这么写的 |
| **AC6** | 日志里的关联键**只允许白名单键**（`task_id` / `order_no` / `sales_entry_record_id`），非白名单键（例如有人顺手塞了 token）**一律不进日志** | 新增单测 `correlationFields`：塞 `app_secret` / 任意键进去，断言输出里没有 |
| **AC7** | 拿不到关联键时**不写空字段**（不出现 `"task_id":""`），也**不抛错** —— 例如采购链路本次不接，它的 `bitable.record.created` 仍然没有关联键 | 新增单测：`correlation` 全空 / 空串 / 非对象 → 输出 `{}`；网关层不传第三参 → 日志里不出现这三个键 |
| **AC8** | **网关层不被业务耦合**：`v1BitableGateway` 只接收不透明的 `correlation` 并原样合并，自己不做任何业务查表/推导 | 代码 review；网关层新增代码里没有 `sales`/`order_no` 的任何业务判断 |

### ② 库存键两种写法并列

| # | 验收标准 | 怎么验 |
| - | -------- | ------ |
| **AC9** | `inventory.change.applied` **同时**给：`stock_key`（内部 `rec…\|尺码\|状态`，**原值一个字符都不动**）＋ `stock_key_label`（飞书自己算好的 `货号\|颜色\|类别\|尺码`） | 新增测试逐字断言两个字段 |
| **AC10** | `stock_key_label` **零额外请求**：直接取**这次已经读到的**「实时库存」记录上的「库存键」公式值（不重新拼、不额外读表） | 新增测试用计数 gateway 断言 `get/listAll` 调用次数与改动前相同 |
| **AC11** | 同一张表里的其它库存日志（`inventory.state.transitioned` / `inventory.sample.promoted`）**同样两种都给** | 新增测试 |
| **AC12** | 取不到人类可读那串时，给 `stock_key_label_source: 'unavailable'`，**不猜、不用 `rec…` 拼一个看起来像的** | 新增测试：实时库存记录上没有「库存键」列 → 只有 `stock_key` ＋ `source: 'unavailable'` |
| **AC13** | 既有 `stock_key` / `ledger_record_id` 断言**一条不放宽** | 既有测试全绿 |

### ③ 流程纪律

| # | 验收标准 |
| - | -------- |
| **AC14** | 独立 worktree 里 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（不在主工作区跑全量） |
| **AC15** | `gh pr checks` 看到 **CLEAN**；**不用 `--admin`**；开 PR ✗ 不合并 ✗ 不部署 |
| **AC16** | 不部署、不 `pm2 restart`、不碰服务器、**不写生产表** |

---

## 二、改后的日志样例（销售 `XSD-20261007-0004`，节选；顺序即真实顺序）

```json
{"ts":"2026-10-07T07:43:12.101Z","level":"info","event":"sales.status.written","sales_entry_record_id":"recXXX","dimensions":["sales","funds"],"task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004"}
{"ts":"2026-10-07T07:43:12.402Z","level":"info","event":"bitable.record.created","table_key":"salesDetail","table_id":"tblxW5WMKDULyolA","record_id":"recDet1","duration_ms":231,"task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004","sales_entry_record_id":"recXXX"}
{"ts":"2026-10-07T07:43:12.688Z","level":"info","event":"bitable.record.created","table_key":"paymentRecord","table_id":"tbl...","record_id":"recPay1","duration_ms":204,"task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004","sales_entry_record_id":"recXXX"}
{"ts":"2026-10-07T07:43:12.910Z","level":"info","event":"v1.sale.posted","sales_entry_record_id":"recXXX","detail_count":1,"payment_count":1,"step":"posting","inventory_applied_by_this_step":false,"inventory_planned":true,"inventory_step":"after_delivery","task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004"}
{"ts":"2026-10-07T07:43:13.201Z","level":"info","event":"bitable.record.created","table_key":"inventoryLedger","table_id":"tbl7Xo4OPmaN2NdP","record_id":"recLed1","duration_ms":188,"task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004","sales_entry_record_id":"recXXX"}
{"ts":"2026-10-07T07:43:13.395Z","level":"info","event":"inventory.change.applied","operation_id":"STOCK_SALE_DECREASE|recDet1","kind":"STOCK_SALE_DECREASE","stock_key":"rec28ecYW0lkvL|38|门盒","stock_key_label":"5801-38|灰色|B|38","stock_key_label_source":"live_inventory","movement_quantity":1,"direction":"减少","target_quantity":0,"ledger_record_id":"recLed1","live_record_ids":["recLive1"],"task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004","sales_entry_record_id":"recXXX"}
{"ts":"2026-10-07T07:43:13.660Z","level":"info","event":"sales.inventory.applied","sales_entry_record_id":"recXXX","ledger_ids":["recLed1"],"behaviors":["STOCK_SALE_DECREASE"],"applied_detail_count":1,"already_delivered_detail_count":0,"failed_detail_count":0,"live_record_ids":["recLive1"],"sample_consumed_detail_ids":[],"stock_status":"已写入","task_id":"sale_om_9f2c1a","order_no":"XSD-20261007-0004"}
```

**改前 vs 改后，一次 grep 的差别**：
```bash
# 改前：只有 lark.* 那半看得见
grep '"task_id":"sale_om_9f2c1a"' pm2.log   # → 看不到 salesDetail / paymentRecord / inventoryLedger
grep 'XSD-20261007-0004' pm2.log            # → 一行都没有（单号只出现在 sales.order_no.generated）

# 改后：一个键，整条链（卡片 → 入账 → 明细 → 收款 → 流水 → 实时库存 → 正向证据）
grep 'XSD-20261007-0004' pm2.log            # 或 grep '"task_id":"sale_om_9f2c1a"'
```

> ⚠️ 上面样例里那条 `sales.status.written`（`dimensions: ["sales","funds"]`）是**入账开始那一次**，
> 它发生在**读销售主表之前** —— 所以那条**只有 `task_id` ＋ `sales_entry_record_id`，没有 `order_no`**。
> 这是有意的：把写入顺序调过来只为多一个日志字段，本次明确不做。读过主表之后的所有日志都有单号。

## 三、`stock_key_label` 到底怎么来的（brief 专门问的「有没有额外请求」）

**零额外请求** —— 而且**根本不重新拼**：

「实时库存」表里那条记录上**本来就有**飞书算好的「库存键」公式列
（`货号|颜色|类别|尺码`，`stockKeyField` 见 `v1BitableSchema.tables.liveInventory.fields.stockKey`）。
库存引擎在写流水之前**已经**把这张表读进来挑了要扣的那几双
（`applyChange` 的 `listAll('liveInventory')`；状态变更与补样品也一样），
所以 `stock_key_label` 就是**那几双里第一双的「库存键」原文** —— 抄的，不是算的。

因此它有三个好处：
1. **不可能漂移**：`货号/颜色/类别` 的取值规则在飞书那一侧，代码这边一个字都不抄；
2. **与表里逐字相同**：她拿这个串去多维表格搜，搜得到；
3. **零成本**：不读表、不请求、不影响任何时序。

**哪几种情况会没有它**（`stock_key_label_source: 'unavailable'`，如实空着）：
- 这一款**在店里一双都没有**（采购入库第一双新品）：实时库里没有任何记录可抄，
  这时引擎手上只有 `product_record_id`，**拼不出货号/颜色/类别** —— 要拼就得多读一次
  「货品信息」，本方案**选择不读**（宁可少一个字段，也不在写库路径上多一次请求）。
- 那张表里该记录的「库存键」列为空 / 不是 4 段（飞书公式没算出来）。

## 四、逐条对照（实现后回填 · 证据 = 新增的 `server/test/logCorrelation.test.js` 10 条用例）

| # | 达标？ | 证据 |
| - | ------ | ---- |
| **AC1** | ✅ | 用例「端到端：确认入账 → 交付…」用**真实 `V1BitableGateway`**（只把飞书 client 换成内存假 Base）抓真实日志：`sales.status.written` / `v1.sale.posted` / `sales.inventory.applied` / `inventory.change.applied` / `sales.delivery.completed` 每条都带 `task_id` ＋ `sales_entry_record_id`（读过主表之后的那几条还带 `order_no`）；`bitable.record.created` 的 `salesDetail` / `paymentRecord` / `inventoryLedger` 三条也都带。最后一条断言是"一句话验收"：同一个 `task_id` 能一把 grep 到上述**每一个**事件 |
| **AC2** | ✅ | 每条用例都同时断言既有字段：`dimensions` / `detail_count` / `payment_count` / `step` / `inventory_applied_by_this_step` / `table_key` / `table_id` / `record_id` / `duration_ms` / `kind` / `movement_quantity` / `direction` / `target_quantity` / `ledger_record_id` / `live_record_ids` / `stock_status` / `from_state` / `to_state` / `size` / `collected_amount` / `collected_payment_ids`…；**既有测试一条都没改**（全量 975 条全绿，见 AC14） |
| **AC3** | ✅ | 关联键只走 `options` 参数：**既有业务 `input` 形状一个字段都没变** —— 这不是我嘴上说的，是**既有测试里那两条逐字 `deepEqual`**（`secondDeliveryService.test.js` 断言 `applySale` 入参与 `secondDelivery.confirm` 入参）在证明：我第一版把 `correlation` 塞进 `input` 时它们**当场挂了**，改成尾部 `options` 后一次通过、且一个字都没动 |
| **AC4** | ✅ | 用例「同一个 service 实例连跑两笔单」：并发跑两笔不同单，`v1.sale.posted` 各带各自的 `task_id` / `order_no`，不串台。关联键**不进任何实例字段**（service 是启动时构造的单例） |
| **AC5** | ✅ | `correlation` 就是普通入参，10 条用例全部直接传 |
| **AC6** | ✅ | 用例「correlationFields：只放行白名单…」：塞进 `app_secret` / `authorization` / 任意键，输出里**一个都没有**，且序列化结果不含 `secret` |
| **AC7** | ✅ | 用例「没有的键【不出现】」：空串 / `null` / `undefined` / 非对象 → `{}`；网关层用例断言**不传关联键时三个键一个都不出现**（不是空串）。采购链路本次不接，它的日志确实没有关联键（见「不确定处」） |
| **AC8** | ✅ | 网关层新增代码只有两行 `const correlation = correlationFields(options.correlation)` ＋ 两处 `...correlation` —— 没有 `sales` / `order_no` 的任何业务判断；`correlationFields` 也不查表、不读本地任务 |
| **AC9** | ✅ | 用例：`stock_key === 'product_rec\|40\|门盒'`（**原值不动**）＋ `stock_key_label === '5801-38\|灰色\|B\|38'` 同时断言 |
| **AC10** | ✅ | 用例里给网关的 `get/listAll/create/update` 全部挂了计数器：整条链跑完，**`product` 表的读取次数 = 0**；`stock_key_label` 逐字等于实时库存记录上那串 |
| **AC11** | ✅ | 两条用例分别跑 `transitionState`（转冻结）与 `promoteToSample`，断言 `inventory.state.transitioned` / `inventory.sample.promoted` 同样两种键都给，且 `product` 读次数仍为 0 |
| **AC12** | ✅ | 用例「拿不到人类可读那串时如实说 unavailable」：实时库存没有「库存键」列 → `stock_key` 照旧在、`stock_key_label` **不出现**、`stock_key_label_source === 'unavailable'` |
| **AC13** | ✅ | 既有 `stock_key` / `ledger_record_id` 断言全绿（`salesMvp.test.js` 那三条库存日志用例未改动） |
| **AC14** | ✅ | worktree 内 `node --test --test-concurrency=1` **连跑 2 次**：`tests 975 / pass 975 / fail 0`（改动前基线 965，新增 10 条） |
| **AC15** | ✅ | 见 PR（`gh pr checks` 输出贴在下面对照里；未用 `--admin`、未合并、未部署） |
| **AC16** | ✅ | 全程没有 `deploy_*.sh` / `pm2` / 服务器操作；本机 **没有写任何真实 Base**（全部用例都用内存假 Base，`FEISHU_V1_BITABLE_APP_TOKEN` 指向 `test_app_token`） |

### 补一条 AC1 的**例外**（如实说，别当成没做到）

`order_no` **不是每一行都有**，这是**有意**的、有原因的：
`v1.sale.posted` 之前那两次「入账中」状态写入发生在**读销售主表之前**
（原顺序：先写状态 → 再读主表拿交易类型），而单号只在那条主表记录上。
**为了补一个日志字段去把写入顺序调过来 —— 明确不做**（brief 红线：不改写入顺序）。
⇒ 从读主表那一刻起的每一条都有单号；那两次只有 `task_id` ＋ `sales_entry_record_id`
（这两个键在这一层永远知道）。新测试对这条边界有**显式断言**，不是漏测。

## 五、扩展点（将来接采购链路时只改这两处）

1. `utils/correlationFields.js` 的 `CORRELATION_KEYS` 白名单加 `purchase_batch_no`；
2. `purchaseWebhookService` 在调 `gateway.create(...)` 与
   `inventory.applyPurchase({...}, { correlation: { purchase_batch_no } })` 时把关联键传下去
   —— 下游（`v1BitableGateway` / `inventoryService`）**已经全部就位**，不用再改。
