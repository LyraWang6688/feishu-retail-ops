# 订单列表读路径性能修复（2026-10-16）

> 起因：生产 PM2 日志里 `GET /api/workbench/sales/orders`（日志里是 `GET /sales/orders`）
> 最慢五条 **42317 / 32824 / 31045 / 27478 / 27462 ms**（27~42 秒）。
> 同一批日志里扫码页 `GET /rec28dN2LCoM9h` 服务端只有 `≈4ms`
> （`inventory_ms:3` · 会话/产品/尺码 `0` · `render_ms:0~1`）⇒ **扫码页不是瓶颈，本次一行不动**。

## 一、定位：42 秒花在哪

### 1.1 入口与真实链路（先只读核过）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 路由 | `server/src/routes/workbench.js:413`（`router.get('/sales/orders')`） | 只调一句 `followup.listOrders()` |
| service | `server/src/services/salesFollowupService.js` 的 `listOrders()` → `buildOrdersList()` | 真正的取数 |
| 缓存 | `server/src/services/workbenchOrdersCache.js`（TTL `WORKBENCH_ORDERS_CACHE_MS`，默认 30s） | 命中即 **0 次飞书读** |

⚠️ **任务书里猜的 `v1WorkbenchService` 不在 `/sales/orders` 这条路上**：
`v1WorkbenchService.getSalesReport` / `getTodaySales` 自 2026-10-08 起**已无生产调用方**
（`AGENTS.md` 的 2026-10-08 条目已记录），本接口走的是 `SalesFollowupService`。

### 1.2 生产日志里**没有**这个接口的分段耗时事件

grep 过：本接口只有两条 warn —— `workbench.sales.orders.read_retry`（瞬时错误自动重试）
与 `workbench.sales.orders.order_skipped`（单条数据不自洽跳过）。
**没有任何 `orders.timing` / `order.list.timing` 之类的分段事件**
⇒ 唯一的真数据是 HTTP 层的 `http.request.completed.duration_ms`（`server/src/app.js:71-82`）。
⇒ 所以下面把"**打了几次飞书**"数出来（用假网关计数，改前/改后都数）。

### 1.3 数出来的调用次数（假网关，本机夹具）

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| **无待补样品**（最常见） | **6 次**：5 张业务表（`salesEntry` / `salesDetail` / `paymentMethod` / `paymentRecord` / `product`）**并行** + `sizeManagement` 1 次 | **6 次**（不变） |
| **4 条待补样品** | **11 次**：上面 6 次 + `sizeManagement` **再读 1 次** + `liveInventory` **串行读 4 次** | **7 次**：6 次 + `liveInventory` **1 次** |

调用序（改前，4 条待办）：

```
salesEntry → salesDetail → paymentMethod → paymentRecord → product
→ sizeManagement → liveInventory → liveInventory → liveInventory → liveInventory → sizeManagement
```

### 1.4 根因（两条，都不是"数据多"，是"读法"）

**① 🔴 N+1 + 串行（主犯）**：`buildOrdersList` 里，**每一条"待补样品"明细**都会独立走

```
samplePending.candidatesFor(productRecordId)
  → InventoryService.sampleReplacementCandidates()
  → this.gateway.listAll('liveInventory')      ← 每问一次就整表读一次
```

而这几问在 `Promise.all(orderDetails.map(async …))` 里**逐个 `await`** ⇒ **串行 N 次整表读**。
「实时库存」是**一双一行**、店里最大的一张表（含附件列），单次整表读本就要数秒
⇒ **N 次串行 = 十几到几十秒**，与线上 27~42 秒同量级。

⚠️ 量级佐证：业务负责人 2026-10-12 那条待办通知里 `sample`（待补样品）**= 8** ⇒ 改前 **8 次串行整表读**。

**② 尺码表被读两遍（次犯）**：`SalesFollowupService` 与它内部 `SalesDeliveryService` 里的
`InventoryService` **各 new 了一个 `SizeReferenceService`**（缓存是按实例的）
⇒ 同一张「尺码管理」小表一次请求读两遍。

**③ 顺带**：`liveInventory` 那次整表读**不带 `field_names`** ⇒ 把这 9 列（含附件列）整份拉回来，
而算候选只要 **编号 / 尺码 / 所属状态** 三列。

**没有分页缺失**：`gateway.listAll` 是 `page_token` 串行翻页（`page_size: 500`），
不是"只读第一页"——这一层**本次不动**（飞书游标只能一路往后取，并行翻页没有收益）。

## 二、改了什么（**只改"怎么取数"，没改"取到什么"**）

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `server/src/services/inventoryService.js` | 把候选计算剥成**纯函数** `candidatesFromLiveRecords(productRecordId, liveRecords, {excludeRecordIds})`；`sampleReplacementCandidates` 新增**可选** `options.liveRecords`（给了就用，不给就照旧自己读） | 让调用方复用同一批记录 ⇒ 读表次数从 N 变 1。**判据逐行同义** |
| `server/src/services/samplePendingService.js` | `candidatesFor` 透传可选 `liveRecords` | 把快照从订单列表一路带到库存层。**不传 ⇒ 与以前逐字同行为**（`fill()` 就不传，它要"此刻"的真实库存） |
| `server/src/services/salesFollowupService.js` | ① 有待办时**先读一次** `liveInventory` 当快照（失败 ⇒ warn + 退回逐条读，不打断整页）；② 每条待办把快照透传下去；③ `fieldOptions` 支持 `ORDER_SUPPORT_FIELD_KEYS`；④ 尺码访问器**先建好**再传给交付服务 | 主修（N+1 → 1）＋ 按需取字段 ＋ 尺码去重 |
| `server/src/services/salesDeliveryService.js` | `InventoryService` 与交付服务**共用同一个尺码解析访问器** | 消掉「尺码管理」读两遍 |
| `server/src/config/workbenchOrders.js` | 新增 `ORDER_SUPPORT_FIELD_KEYS = { liveInventory: ['product','size','state'] }` | 配置先行。**单独一份**、不并进 `ORDER_FIELD_KEYS` —— 后者被既有判据 AC5a **逐字**钉着，并进去等于**放宽判据** |

### 2.1 为什么"不许改行为"这条守住了

- **用户看到的东西一个字节没变**：`listOrders()` 的返回形状、字段、顺序、分段
  （`orders` / `methods` / `details` / `payments` / `sample_pending_lines` …）**全部未动**；
  改的只是"那张表读几次、读哪几列"。判据 **AC-P5** 拿同一批 `liveInventory` 记录，
  断言改前改后候选清单逐字相同。
- **分页 / 筛选 / 排序 / UI 一律没碰**（`orders.filter(isPosted).map(…).reverse()` 原样保留）。
- 「只留门盒 > 0 的码」那道过滤**仍在 `salesFollowupService` 原处**，没有挪进库存层。

## 三、判据（**先写后改**，`server/test/workbenchOrdersReadPath.test.js`）

| 判据 | 钉住什么 | 改前 | 改后 |
| --- | --- | --- | --- |
| AC-P1 | 一次请求里 `liveInventory` **至多整表读 1 次**（4 条待办也是 1） | ✖ 4 | ✔ 1 |
| AC-P2 | **没有任何一张表被读两次**（调用序不出现重复表名） | ✖ | ✔ |
| AC-P3 | 快照读**按需取字段**（编号/尺码/所属状态 三列） | ✖ | ✔ |
| AC-P4 | 整表读**总次数 ≤ 7**（4 条待办） | ✖ 11 | ✔ 7 |
| AC-P5 | 候选清单**逐字不变** + 整份结果逐字相同 | — | ✔ |
| AC-P5b | **没有待办 ⇒ 一次 `liveInventory` 都不读**（不给无待办的请求加读） | ✔ | ✔ |
| AC-P6 | 快照读**失败** ⇒ 如实退回逐条读（待办不丢、候选不变） | — | ✔ |

⚠️ 判据走的是**生产同路**（不注入 `samplePending`，让 service 自己装配 `this.delivery.inventory`）
—— 否则测的是夹具、不是 `routes/workbench.js:65` 那条真路。

### 3.1 变异（≥2 组，均真红，还原逐字节一致）

| 变异 | 内容 | 结果 |
| --- | --- | --- |
| M1 | 快照不透传（`liveRecords` 去掉） | ✖ AC-P1 / P2 / P3 / P4 |
| M2 | 库存引擎不再共用尺码解析 | ✖ AC-P2 / P4 |
| M3 | `ORDER_SUPPORT_FIELD_KEYS.liveInventory` 置空 | ✖ AC-P3 |
| M4 | 快照读失败不兜底（去掉 try/catch） | ✖ AC-P6 |

还原后三个文件 **sha256 逐个与变异前一致**，`git diff -- server/src | shasum -a 256` 仍是
`5d81ab1beaf725f3a62a1cad849f5903928d7d53132a0092514aab38da7353a7`。

## 四、量出来（改前 / 改后）

- **本机（假网关计数，`server/test/workbenchOrdersReadPath.test.js`）**：
  `liveInventory` **4 → 1**；总整表读 **11 → 7**；`sizeManagement` **2 → 1**。
- **生产真耗时**：本次**不部署**（业务负责人测试期间的铁律），所以只能给"部署后怎么验"——
  见 `server/scripts/verify-orders-perf.sh`。基线：**27~42 秒**。

## 五、我**没做**的（如实）

1. **没有在真生产上量到秒数** —— 不许部署，秒数只能等部署后由脚本取。
2. **`scanWriteService.js` / `scanPage.js` / `views/**` / `config/scanWrite.js` 一个字没动**（哈希核对过）。
3. **没有改 `listAll` 的分页语义、没有加缓存 TTL、没有动排序/筛选**（本次只去掉重复读）。
4. **RS 之外的一点**：`sizeManagement` 那次读**没有**加 `field_names`
   （它读的是 `SizeReferenceService` 自己的口径，加列收益可忽略，且会把"读两次"变"读两次、payload 小一点"
   —— 不解决 N+1，故没做）。
5. **全套里的 3 条红**（`scanMoneyPageTwoStepVerify.test.js` 的 V1/V2/V5 · V3 · V4）
   是**既有、与本次无关**：它在**改动前的 pristine 代码**上同样红（已实测），
   形态是"对活体测试 Base 断言零写入，被并发写污染"。

## 六、进一步建议（没硬改，等她/他定）

- **要给这个接口加一条分段耗时日志**（例如 `workbench.sales.orders.timing`，带
  `entry_ms` / `detail_ms` / `payment_ms` / `product_ms` / `live_ms` / `total_ms`）——
  这次排查**全靠数调用次数**，因为没有分段事件；下一次一眼就能看出"是飞书慢还是我们读得多"。
- **`liveInventory` 若继续长**（一双一行），可考虑像扫码页那样走 `listByFilter`
  只读该货品的行；但**候选要"这一款所有码"**，语义上本来就是"按货品读"，可以做成
  `filter=CurrentValue.[编号].contains("<record_id>")` —— **本次没动**（先拿数据再定）。
