# 全局飞书写入调度器（issue #879）

> 2026-11-08 定稿并实现。对应 issue：[#879](https://github.com/LyraWang6688/feishu-retail-ops/issues/879)、
> task-16。**不部署、不合并**；部署需业务负责人当次明确指令。
>
> 关联：#948（统一异步任务：job 级重试 / 状态 / 失败通知）· #961（库存操作键统一配置化：
> 重试复用同一把 operationKey）。本文记录**为什么这么切、边界在哪、怎么验证**。

## 1. 问题（真实伤口）

销售异步 worker / 工作台交付 / 售后各自有 FIFO，但**跨模块**仍会同时写飞书：

```text
销售 worker + 采购入库 + 工作台交付 同时写飞书
  → 1254607 Data not ready
  → HTTP 400（飞书把 data-not-ready 这类也走 400）
  → 某一方失败（生产测试里真实出现过 v1.sale.post_failed 400）
```

FIFO 只能保证"自己内部不互打"。所以问题不是"没有队列"，而是**没有共享调度器**。

## 2. 切法：调度点放在网关（唯一出口），不重写任何业务写表逻辑

`V1BitableGateway` 是全仓**唯一**直连飞书的地方（既有纪律）。所以：

```text
业务层（销售 worker / 采购入库 / 交付 / 库存调整 …）
        ↓ 调既有 gateway.create / createBatch / update / updateBatch / delete / deleteBatch
V1BitableGateway.scheduledWrite(tableKey, operation, work, { correlation })
        ↓
services/feishuWriteScheduler.js（全局单例：分组串行 + 有限并发 + 瞬时错误重试）
        ↓
飞书 OpenAPI
```

- **只调度写**：`listAll / get / getBatch / listByFilter` 等读请求**不进**调度器（否则页面变慢）。
- **不改业务规则**：不重写 `submitSale` / `InventoryService` 写表逻辑；每个 `work` 闭包就是原来那一行
  `client.bitable.appTableRecord.*` 调用（`assertSuccess` 移进闭包，让调度器能看见飞书的拒绝）。
- **始终开启**：没有环境变量开关；网关固定走全局调度器（测试可注入 `null` 关闭）。

## 3. 并发语义

默认按「**表 + 操作类型**」分组（`liveInventory:create` / `salesEntry:update` …）：

| 维度 | 语义 |
|---|---|
| 组内 | **严格串行 FIFO**（同一张表同一种操作绝不并发 —— 这正是 1254607 / 写冲突的来源） |
| 组间 | 全局最多 `FEISHU_WRITE_MAX_CONCURRENCY` 个请求同时在飞（默认 **3**） |
| 库存 | `stock_key` 串行**原样保留**（仍在 `InventoryService.runForStock`，本层只调度单次 HTTP 写，**不全局锁死**） |

分组开关（排查 / 灰度）：`FEISHU_WRITE_GROUP_BY_TABLE` / `FEISHU_WRITE_GROUP_BY_OPERATION`。

> 为什么默认 3：整条链路锁成 1 会让批量写（一批 5 码 = 多张表多次写）明显变慢；
> 3 既给飞书留出并发余量，又把"跨模块同时打同一张表"这条主要撞车路径消掉。
> 极限保守可以设 1（用例里有专门断言"并发=1 时全局严格串行"）。

## 4. 重试语义（**只重试确定没写进去的**）

| 分类 | 判据 | 是否在这一层重试 |
|---|---|---|
| 飞书"再等一下" | code `1254607` 数据未就绪 / `1254290` 限流 / `1254291` 写冲突 | ✅ |
| 限流 | HTTP 429 | ✅ |
| **瞬时 400** | HTTP 400 且 msg 是 data-not-ready / 系统繁忙 / 频率 这类（飞书把这一类也走 400） | ✅ |
| 永久错误 | 字段名 / 权限 / 参数 / 其它 400 | ❌ 一次就抛 |
| **结果未知** | 5xx / 网络超时 / 连接重置 | ❌ **这一层不重试**（可能已经写进去了）⇒ 交给 #948 的 job 级重试 |

- 判据实现：`config/feishuWriteScheduler.js` 的 `classifyFeishuWriteError`（可配：
  `FEISHU_WRITE_RETRY_LARK_CODES` / `FEISHU_WRITE_TRANSIENT_400_PATTERN` / 次数 / 退避）。
- **飞书 code 必须先于 HTTP 400 判**：真机上 data-not-ready 是「HTTP 400 + code 1254607」两层形状，
  先看 400 会把可重试错误误判成永久错误。
- 退避：指数递增（默认 600ms → 1200ms … 封顶 8s），`FEISHU_WRITE_RETRY_BASE_MS` 可配（0 = 立即重试）。

### 为什么重试不会重复建单 / 重复扣库存

调度器**只重放同一个闭包**：payload 在调度外算好（每张表每种操作的请求体在入队前就固定），
关联键（`task_id` / `order_no` / `batch_no` / `tap_id` / `operationKey`）由业务层**早就算好并冻结**。
调度器**不生成任何业务键**，重试也不会重新走"取号 / 建单"逻辑 ⇒ 天然复用同一把
`job_id` / `submitKey` / `operationKey`（#948 / #961 的幂等层原样生效）。

> 用例 `AC-WG3`：第一次 `1254607` 被拒 ⇒ 第二次请求逐字相同 ⇒ **只落一条记录**。

## 5. 日志（排查三件事：等了多久 / 同时几个 / 试了几次）

| 事件 | 级别 | 关键字段 |
|---|---|---|
| `feishu.write.applied` | info | `table_key` `operation` `group_key` `queue_wait_ms` `duration_ms` `attempts` `concurrency_limit` `active_count` `queue_depth` + 关联键 |
| `feishu.write.retry` | warn | `attempt` `max_attempts` `reason`（feishu_code / http_status / transient_400）`code` `status` `delay_ms` + 关联键 |
| `feishu.write.failed` | error | `attempts` `retryable` `reason` `code` `status` `queue_wait_ms` + 关联键 |

关联键由调用方经 `options.correlation` 传（白名单口径见 `utils/correlationFields`）；
调度器**不透明**透传，不查表、不推导。

## 6. 覆盖的写路径（全部经网关，一个不漏）

- **销售异步 worker**：主表 `create` / 明细与收款 `createBatch` / 库存 `createBatch`、`delete`
- **采购入库**：`purchaseRequest` 批次更新 / 库存流水与实时库存 `createBatch`、`getBatch`（读不调度）
- **工作台交付 / 付款**：销售状态 `update` / 收款 `create`、`update` / 库存扣减
- **库存调整（人工）**：库存流水 `create` / 实时库存 `create`、`delete`
- **售后 / 补样品**：同上
- **标签打印队列 / 二维码回写**：`update` / `updateByTableId`

## 7. 测试（本次实现自带）

- `server/test/feishuWriteScheduler.test.js`（单元）：配置 / 错误分类 / 退避 / 分组串行 / 有限并发 /
  重试重放同一闭包 / 日志字段 / 单例开关。
- `server/test/feishuWriteSchedulerGateway.test.js`（集成 × 跨模块）：
  - 写经调度器、读不经过（占满写额度后读仍立即返回）；
  - **销售 + 采购 + 库存同时写**：全局同时在飞 ≤ 配置值、同表同操作串行、且确实用到了并发；
  - 重试复用同一份 payload / 关联键，只落一条；
  - 永久错误不重试；
  - 同一 `stock_key` 并发两次只扣一次（幂等原样保留）；
  - 不同 `stock_key` / 不同表可以并行（不全局锁死）。

## 8. 边界（如实标）

- **不改业务规则、不重写 `submitSale` / `InventoryService` 写表逻辑**；只在网关入口处加调度层。
- 读请求不调度（避免页面变慢）；`getBatch` 也**不进**（它只是"读之前确认"）。
- 5xx / 网络超时不在这一层重试（结果未知）—— 交给 job 级重试；这一条是**故意的**，不是漏做。
- 单进程内调度：多实例部署时各进程各有一份额度（本仓当前单进程 PM2 部署；若将来多实例，
  要改成跨进程协调 —— 那不是本卡范围）。
- **未部署**；部署需业务负责人当次明确指令。
