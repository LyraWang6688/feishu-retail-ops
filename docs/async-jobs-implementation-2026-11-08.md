# 统一异步任务：实现记录（#948 / #950 / #947）

> 2026-11-08。设计口径以 [async-job-status-and-failure-notification-2026-11-08.md](async-job-status-and-failure-notification-2026-11-08.md) 为准；
> 本文只记录**实现落点、判据与边界**。分支 `feat/unified-async-jobs`；**未部署、未改生产 Base、未改集团/生产配置**。

## 1. 一句话

七类"先回成功回执、后台写库"的链路（销售 / 售后退货 / 采购补货 / 采购退货 / 采购验收 / 工作台交割单交付 / 工作台交割单付款）
现在都落到**同一套 job 模型 + 同一套重试分类 + 同一个失败通知出口**：
最终失败只发「邯美皮鞋运营群」，**页面不显示任何失败提示**（#947 的"页面失败提示"由 #948 的"发运营群"取代）。

## 2. 新增件（统一层）

| 文件 | 职责 |
|---|---|
| `server/src/config/asyncJobs.js` | 类型 / 状态值域 / `job_id` 前缀 / 重试次数与退避 / 通知群与文案 / **错误分类器**（唯一实现） |
| `server/src/services/asyncJobStore.js` | 统一 job 存储（`server/data/async_jobs/`，复用 `JsonTaskStore` 原子写 + 同 id 写互斥） |
| `server/src/services/asyncJobNotifier.js` | 失败群通知（渲染 / 发送 / 去重 / `chat_missing` / `notify.failed`；上海时间） |
| `server/src/services/asyncJobService.js` | 状态机 + **通用重试循环** + 通知编排 + 只读视图 + 启动补发 |
| `server/src/services/asyncJobRuntime.js` | 进程级单例（七类链路与状态接口看**同一份**存储 / 去重状态） |
| `server/src/services/asyncJobPurchaseRunner.js` | 采购三条链路 → 统一层的薄适配器（**先把写入口跑起来**，再并行落 job；统一层不可用 ⇒ 如实单次回落） |
| `server/src/routes/workbench/asyncJobs.js` | `GET /api/workbench/async-jobs/:jobId`（只读 / 只能查自己的 / 不返回 payload） |

**任务模型**（落盘字段）：`job_id` · `type` · `status` · `attempts` · `last_error` · `payload` · `result` ·
`created_at` / `started_at` / `finished_at` · `notified_at`（去重）· `owner_open_id`（状态接口鉴权）·
`operator_name` / `meta`（单号 / 批次 / 失败步骤）· `notify`（发送尝试次数与最后错误）。

**状态**：`queued → running → succeeded / partial_failed / failed`。`failed` 与 `partial_failed` 都触发群通知；
`partial_failed` 仍是终态、不重试，但没有额外状态开关。

**幂等**：`job_id` 由各链路**自己的幂等键**稳定派生（销售 `submitKey`、售后 `requestId`、采购 `submitKey`/`requestId`），
重试只更新同一条 job；重试复用原 `submitKey` / `requestId` / 幂等键，不产生第二条业务记录。

## 3. 七类链路接入点

| 链路 | 入口 | 统一 job | 重试 | 最终失败通知 |
|---|---|---|---|---|
| 销售 | `services/salesAsyncWorker.js`（扫码页异步销售） | `sale_job_*`（与链路同一个 id）；owner = 扫码人 | 有：`asyncJobService.run`；重试前 `clearSale` + 按冻结 payload 重加行 ⇒ **不重复加行**；`submitSale` 仍拿同一把 `submitKey` | ✔（`failed` / `partial_failed`） |
| 售后退货 #943/#947 | `services/afterSalesAsyncService.js` + `routes/workbenchOrderActions.js` | `after_sales_job_*`（同一 id）；owner = 工作台登录人 | 有（既有循环，分类器统一） | ✔（`#947` 的页面提示由它取代） |
| 采购补货 #946 | 扫码页 `routes/scanPage/handlers/purchase.js` + `purchaseWriteBackgroundService` | `purchase_replenish_job_*` | 有（适配器统一循环） | ✔ |
| 采购退货 | 扫码页同上（`purchase_return` 链） | `purchase_return_job_*` | 有 | ✔ |
| 采购验收 #944 F3 | `routes/workbench/purchase.js`（确认到货） | `purchase_acceptance_job_*`；owner / 操作人 / 批次号都从路由带下来 | 有 | ✔ |
| **交割单交付** | `routes/workbenchSalesDelivery.js` → `salesDeliveryAsyncService` | `delivery_job_*`；owner = 工作台登录人 | 有（业务异常不重试；瞬时写由飞书写调度器重试） | ✔（`failed` / `partial_failed`） |
| **交割单付款** | 同上 | `payment_job_*`；owner = 工作台登录人 | 同上 | 同上 |

采购三条链路共用既有 `purchaseWriteBackgroundService`（**不另造后台件**）；`jobRunner` 与 `jobMeta` 都是**注入**，
不注入时逐字保持"单次"旧行为（既有用例不动）。

## 4. 重试口径（`config/asyncJobs.classifyThrownError` / `classifyResultOutcome`）

- **重试（临时错误）**：飞书 5xx / 请求超时 / 网络错误 / 限流（429）/ 飞书限流与写冲突码；
- **不重试（永久错误）**：HTTP 400 / 401 / 403 / 404 / 422、字段不存在、权限不足、参数错误、业务拒绝，
  以及链路显式返回的 `{ok:false, code}` 业务拒绝（`item_invalid` / `not_in_batch` / `write_disabled`…）；
- 次数 / 退避全部配置化（`ASYNC_JOB_MAX_ATTEMPTS` / `ASYNC_JOB_RETRY_BASE_MS` / `ASYNC_JOB_RETRY_MAX_DELAY_MS`，指数退避封顶）；
- 抛出的"未知异常"归类为**可重试**（与售后改前"除 400 外都重试"一致，且重试安全 —— 幂等键不变）。

## 5. 失败通知（唯一出口）

- 群：`ASYNC_JOB_ALERT_CHAT_ID` 优先，否则**复用既有** `PURCHASE_CHAT_ID`（邯美皮鞋运营群）；
- 未配置群 ⇒ 记 **`async_job.notify.chat_missing`**，不静默成功、不写 `notified_at`；
- **同一 job 只发一次**：发送成功才写 `notified_at`；发送失败记 `async_job.notify.failed`，
  **不改变业务任务状态**，下次启动 `startAsyncJobService()` 会补发（`start()` 只扫 `failed && !notified_at`）；
- 文案：类型 / 单号或批次 / 操作人 / 失败步骤 / 错误（截断）/ 任务ID / 时间（**上海时间**）；
  拿不到的字段**不写**（不编），默认不 @人，**不发 payload**；
- 服务启动时 `running` 残留只记 `async_job.recover.running_orphaned` 让运维看见（**不猜它到底写没写成**）。

## 6. 状态接口

`GET /api/workbench/async-jobs/:jobId`

- 挂在工作台**既有** `requireWorkbenchAccess` 之后（未启用认证 503 / 未登录 401 / 白名单外 403）；
- **只能查自己的**：`owner_open_id` 不是当前登录人 ⇒ 一律 404（不泄露存在性）；
- 只回状态机字段（`job_id/type/status/attempts/last_error/created_at/started_at/finished_at/notified_at`），
  **不返回 payload / meta / owner / result**；`job_id` 非法 ⇒ 400。
- 页面**不调用**它（失败提示不进页面）；它是排查 / 运营后台用。

## 7. #950 的两处收口

1. **`trade_type_unknown` 日志误报（#946 遗留）**：`buildReplenishView` 现在分开计数
   `tradeTypeUnknownRows` / `alreadyReportedRows`（`skippedRows` 保留为总数，向后兼容）；
   `procurementPageService.loadReplenish` **只对 `tradeTypeUnknownRows > 0`** 记
   `procurement.page.trade_type_unknown`（"已经报过货"是正常业务事实，不再被当成"认不出交易类型"）；
   `replenish_loaded` info 里附带 `skipped_rows` / `already_reported_rows`（只报事实）。
2. **#944 F3 / #947**：采购验收 / 售后后台最终失败都进统一通知（见第 3 节）；页面**不新增**失败 toast/弹窗。

## 8. 测试与证据

- 新增单测：
  - `test/asyncJobs.test.js`：状态流转 / 临时与永久错误 / 重试幂等（同一条 job）/ 通知去重 /
    发送失败可重试 / 群未配置 / 文案（上海时间、不发 payload）/ 只读视图 / store 边界；
  - `test/asyncJobStatusApi.test.js`：401 / 只查自己 / 404 / 400 / 不返回 payload / 挂闸门之后；
  - `test/asyncJobChains.test.js`：五条既有链路真实服务接入（交割单两条见 `salesDeliveryAsync.test.js`）（售后重试与通知、销售重试不重复加行、
    采购三条链路同一适配器、工作台验收路由 owner/批次/操作人 真接线）；
  - `test/procurementPageData.test.js` + `test/procurementPageService.test.js`：#950 计数拆分与告警口径。
- 既有 `async/after-sales/采购` 测试全部保持绿（含 `purchaseAsyncTiming` 的"先回她"时序判据）。
- 门禁：全量 `node --test`（见 PR 描述）/ `size:check` / `observability:events:check` / `playwright test`。

## 8.1 交割单交付 / 付款接入（2026-11-08）

- 类型配置：`ASYNC_JOB_TYPES.SALES_DELIVERY = 'sales_delivery'` / `SALES_PAYMENT = 'sales_payment'`；
- 前缀：`delivery_job_*` / `payment_job_*`；
- 交付/付款的业务提交仍走 `salesDeliveryAsyncService` 的页面级 FIFO；
- job 状态、重试、失败通知改由本统一层管理；写请求再经飞书写调度器；
- 页面仍保留交割单原有的失败 toast（此前业务负责人要求“失败原因要给她看到”），与运营群通知并存；
- 提交受理 toast 文案读 `config/submitToast.js`（通过读接口返回 `submit_toast`，页面不再写死「已提交成功」）；
- 页面轮询间隔/超时读 `config/asyncJobs.js` 的 `ASYNC_JOBS.poll`（通过读接口返回 `job_poll`，页面不再自建 `jobPoll`）；
- 启动时会把旧的 `server/data/sales_delivery_jobs` 中 queued/running 的 job 迁移到统一 job 存储（同一 job_id；已完成的不会重放）。

## 9. 边界 / 未做（如实）

- **不部署**（等业务负责人明确指令）；**不合并**；生产 Base **零写入**；不新增/修改生产配置。
- **页面不显示失败**：刻意不加失败 toast / 弹窗 / 轮询（#947 原方案被 #948 取代）。
- **`partial_failed` 也发群**（与 `failed` 同一张卡片）：销售"主表写了但库存/明细失败"会进运营群；
  不再有 `ASYNC_JOB_NOTIFY_STATUSES` 开关。
- **采购链路进程重启不自动续跑 job**：统一层把残留 `running` 如实记录（不猜）；
  她的重试路径仍是"再点一次（同一把 submitKey ⇒ 幂等）"。销售 / 售后保持既有重启续跑。
- **销售重试的幂等前提**：重跑前 `clearSale` + 按冻结 payload 重加行（真实 `scanSessionService` 有这个方法；
  没有的注入实现会跳过清理，仅影响测试替身）。
- `GET /api/workbench/sales/after-sales/jobs/:jobId`（售后旧状态接口）**保留**（排查兼容），
  新的统一接口是本文第 6 节那条。
