# 统一基础设施与配置盘点（2026-11-08）

> 只读盘点，不是配置变更单。
>
> 当前基线：
>
> - main：`409d9d5b`
> - 生产：`v0.7.0 / 947a107`
> - 生产已包含 #978 / #979 / #980 / #981；main 还包含 #982 抖音只读客户端、#983 交割单统一 job、#984 售后重试统一、#986 配置表缓存统一（均未部署）

## 1. 统一异步任务（#978）

### 1.1 已统一的部分

```text
config/asyncJobs.js
services/asyncJobStore.js
services/asyncJobService.js
services/asyncJobNotifier.js
services/asyncJobRuntime.js
services/asyncJobPurchaseRunner.js
```

统一 job 形状：

```text
job_id
type: sales | after_sales | purchase_replenish | purchase_return | purchase_acceptance | sales_delivery | sales_payment
status: queued | running | succeeded | partial_failed | failed
attempts / last_error / payload / result
created_at / started_at / finished_at / notified_at
```

已接入：

```text
销售
售后退货
采购补货
采购退货
采购验收
工作台交割单交付 / 付款（#983）
```

失败通知：

```text
默认只对 failed 发「邯美皮鞋运营群」
partial_failed 只记日志/状态，默认不发群
页面不新增失败提示
```

### 1.2 统一配置项

配置真源：`server/src/config/asyncJobs.js`；样例：`.env.example` 的 `ASYNC_JOB_*`。

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| `ASYNC_JOB_ENABLED` | 统一异步层开关 | `true` |
| `ASYNC_JOBS_DIR` | 统一 job 存储目录 | `server/data/async_jobs` |
| `ASYNC_JOB_MAX_ATTEMPTS` | 最大尝试次数 | `3` |
| `ASYNC_JOB_RETRY_BASE_MS` | 指数退避基数 | `800` |
| `ASYNC_JOB_RETRY_MAX_DELAY_MS` | 单次退避上限 | `10000` |
| `ASYNC_JOB_RETRYABLE_PATTERN` | 可重试文案正则 | 内置（5xx/超时/网络/限流） |
| `ASYNC_JOB_PERMANENT_PATTERN` | 永久错误文案正则 | 内置（400/字段/权限/参数） |
| `ASYNC_JOB_RETRYABLE_FEISHU_CODES` | 可重试飞书码 | `1254607,1254290,1254291` |
| `ASYNC_JOB_PERMANENT_FEISHU_CODES` | 永久飞书码 | 内置 |
| `ASYNC_JOB_PERMANENT_RESULT_CODES` | 业务拒绝码 | 内置 |
| `ASYNC_JOB_NOTIFY_ENABLED` | 失败通知开关 | `true` |
| `ASYNC_JOB_ALERT_CHAT_ID` | 失败通知群，空则回落 `PURCHASE_CHAT_ID` | 空 |
| `ASYNC_JOB_NOTIFY_STATUSES` | 哪些终态发群 | 默认 `failed` |
| `ASYNC_JOB_NOTIFY_MAX_ERROR_LENGTH` | 群消息错误截断 | `200` |
| `ASYNC_JOB_NOTIFY_DEDUPE_HOURS` | 通知去重窗口 | `168`（7 天） |
| `ASYNC_JOB_ALERT_TITLE` | 群消息标题 | `【异步写入失败】` |
| `ASYNC_JOB_POLL_INTERVAL_MS` / `MAX_MS` | 预留轮询参数（页面当前不用） | 2000 / 60000 |

**不是环境变量、而是代码值域**：

```text
job type
job status
JOB_ID_PREFIX
类型中文名 / 失败步骤文案
```

### 1.3 售后重试（#984 后已完全统一）

售后重试次数 / 退避**只读**：

```text
ASYNC_JOB_MAX_ATTEMPTS
ASYNC_JOB_RETRY_BASE_MS
ASYNC_JOB_RETRY_MAX_DELAY_MS
```

旧配置已退场：

```text
AFTER_SALES_JOB_MAX_ATTEMPTS
AFTER_SALES_JOB_RETRY_MS
```

不再有旧 env 优先级兜底。

### 1.4 工作台交割单（#983 后已接入）

```text
sales_delivery
sales_payment
```

统一走：

```text
asyncJobService
GET /api/workbench/async-jobs/:jobId
```

保留：

```text
页面级 FIFO（先点先跑）
交割单页面自己的失败 toast（业务负责人明确要求）
旧 sales_delivery_jobs 的 queued/running 启动迁移到统一 async_jobs
```

所以现在除了“页面自己的失败 toast”外，交割单的 job 状态 / 重试 / 失败群通知也已统一。

## 2. 全局飞书写调度器（#879 / #980 / #981）

### 2.1 调度点

```text
V1BitableGateway.create / createBatch / update / updateBatch
/ delete / deleteBatch / updateByTableId
        ↓
services/feishuWriteScheduler.js
        ↓
飞书 OpenAPI
```

读请求不进调度器。

### 2.2 语义

```text
默认按「表 + 操作类型」分组
组内严格串行
组间最多 FEISHU_WRITE_MAX_CONCURRENCY 个同时在飞
库存 stock_key 串行仍保留在 InventoryService.runForStock
调度器固定常开（#981 已移除 FEISHU_WRITE_SCHEDULER_ENABLED）
```

### 2.3 统一配置项

配置真源：`server/src/config/feishuWriteScheduler.js`；样例：`.env.example` 的 `FEISHU_WRITE_*`。

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| `FEISHU_WRITE_MAX_CONCURRENCY` | 全局最大同时在飞写请求 | `3`（1~32） |
| `FEISHU_WRITE_GROUP_BY_TABLE` | 是否按表分组 | `true` |
| `FEISHU_WRITE_GROUP_BY_OPERATION` | 是否按操作类型分组 | `true` |
| `FEISHU_WRITE_RETRY_MAX_ATTEMPTS` | 单次 HTTP 写重试次数 | `3` |
| `FEISHU_WRITE_RETRY_BASE_MS` | 退避基数 | `600` |
| `FEISHU_WRITE_RETRY_MAX_DELAY_MS` | 退避上限 | `8000` |
| `FEISHU_WRITE_RETRY_LARK_CODES` | 可重试飞书码 | `1254607,1254290,1254291` |
| `FEISHU_WRITE_TRANSIENT_400_PATTERN` | 瞬时 400 文案正则 | 内置 |

重试边界：

```text
重试：1254607 / 1254290 / 1254291 / HTTP 429 / 瞬时 400（data-not-ready 等）
不重试：5xx / 网络超时（结果未知，交给 job 层幂等重试）
```

### 2.4 调度器不负责的

```text
本地 JSON 任务的创建 / 状态更新
主表查询失败后的恢复
读请求
跨进程协调
```

## 3. 库存操作键（#961 / #979）

### 3.1 统一配置位置

```text
server/src/services/inventory/movements.js
  STOCK_MOVEMENTS[behavior].operationKey
```

`operationKey` 字段：

```text
kind
sourcePrefix
sourceFields
sourceFallbacks
separator
perItem
missingMessage
fieldMessages
operations（同一行为另一条通路的独立键）
```

### 3.2 统一入口

```text
server/src/services/inventory/keys.js

operationSourceIdOf(movement, input)
operationIdOf(movement, input)
operationItemKeyOf(movement, input, sequence)
validateOperationKeyConfigs(...)
```

### 3.3 覆盖行为

```text
销售扣减
采购增加
采购减少
销售增加 / 销售退货 / 赔货 / 现货销售
人工调增 / 人工调减
转冻结 / 转释放 / 样品转门盒 / 门盒转样品
补样品（同一行为的另一条通路）
```

共 13 条行为。

### 3.4 兼容

```text
旧 purchaseIncreaseSourceId / purchaseReturnSourceId / samplePromotionId
保留 deprecated 一版，内部只调统一入口
```

### 3.5 注意

```text
不要自己拼 operationKey
新增库存行为必须先在 STOCK_MOVEMENTS 声明 operationKey
缺字段明确抛错，绝不编 id
```

### 3.6 统一提交回执（toast）

配置真源：

```text
server/src/config/submitToast.js
server/src/utils/submitToast.js
```

统一口径（业务负责人 2026-10-29）：

```text
数据提交成功，后台自动写入
以后没有成功页
```

配置项（`.env.example` 的 `SUBMIT_TOAST_*`）：

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| `SUBMIT_TOAST_TEXT` | 统一 toast 文案 | `数据提交成功，后台自动写入` |
| `SUBMIT_TOAST_PATH` | 303 回跳的站内路径 | `/workbench/` |
| `SUBMIT_TOAST_PARAM` | URL 里的 toast 参数名 | `toast` |
| `SUBMIT_TOAST_NOTICE_KEY` | 单号/排查参数名 | `done` |
| `SUBMIT_TOAST_MAX_LENGTH` | 文案截断上限 | `120` |

覆盖入口：

```text
扫码销售
扫码补货
扫码采购退货
扫码多货
工作台采购页提交
```

共用实现：

```text
utils/submitToast.js 的 redirectWithSubmitToast()
public/workbench/shared/toast.js 显示 5 秒
```

边界：

```text
只允许站内相对路径
文案不带单号
成功页已退场
失败提示不在这里（统一异步失败发运营群）
```

### 3.7 其他共享配置

这些不是“某一个业务域自己的配置”，而是跨模块共用、改一处会影响多条链路。

| 配置/真源 | 作用 | 主要消费者 |
| --- | --- | --- |
| `server/src/config/envValue.js` | 所有 env 读取的唯一规则（空串/默认/非法值） | 各 config 模块 |
| `server/src/config/events.js` + `docs/observability-events.md` | 日志事件目录唯一真源（自动生成） | logger / 观测 / 告警 |
| `server/src/config/v1BitableSchema.js` | 表 ID / 字段名 / 语义键唯一真源 | gateway / 写服务 / 读服务 |
| `server/src/config/salesStatusDimensions.js` | 销售“写入状态”字段与值域唯一真源 | 销售写服务 / 后台标记 |
| `server/src/config/groupPurchase.js` | `PURCHASE_CHAT_ID` 等群配置 | 采购分发 / 统一失败通知 |
| `server/src/config/observability.js` | 观测日报 / 日志轮转参数 | 后台脚本 |
| `server/src/config/alerts.js` | 观测告警开关 / 阈值 / 收件群 | `alertMonitor` |
| `server/src/config/timing.js` | 请求耗时埋点链路与慢阈值 | 请求中间件 |
| `server/src/config/submitToast.js` | 统一提交回执 | 扫码页 / 工作台采购 |
| `server/src/config/configTables.js` | 配置表注册表 + 统一 TTL | configTableCache / larkEvents |

### 3.8 配置表缓存（#986 后）

统一入口：

```text
server/src/services/configTableCache.js
server/src/config/configTables.js
```

规则：

```text
懒刷新：TTL 到期后的下一次读取才重读，没有后台定时器
TTL：由 configTables.js 集中给定，调用方不再传
失效：飞书 record_changed 按 CONFIG_TABLE_KEYS 统一失效
lastGood：重读失败继续用最后一次成功，并打 config_table_cache.last_good_used
告警：该事件已加入观测告警 criticalEvents
```

覆盖的配置表：

```text
paymentMethod / sizeManagement / behavior / accessory
supplier / groupBuyVoucher / product / color
```

支付方式的读路径：

```text
paymentMethodsService → getConfigRows
salesFollowupService 订单列表 → getConfigRows（不再直读）
scanWrite/createService → getConfigRows
v1ReferenceResolver → getConfigRows
```

仍不支持：

```text
多进程共享缓存 / 跨进程失效（当前单实例 PM2）
```

## 4. 哪些“统一化了”

| 层 | 统一配置/真源 | 覆盖 | 例外 |
| --- | --- | --- | --- |
| 异步 job 模型 | `config/asyncJobs.js` | 销售/售后/补货/退货/验收/交割单 | 无（#983 已接） |
| 异步重试分类 | `config/asyncJobs.js` | 同上 | 无（#984 已统一） |
| 失败通知 | `asyncJobNotifier` + `ASYNC_JOB_*` | 同上 | `partial_failed` 默认不发 |
| 飞书写入并发 | `config/feishuWriteScheduler.js` | 所有 gateway 写 | 读请求 / 本地任务 |
| 飞书写入瞬时重试 | 同上 | 所有 gateway 写 | 5xx/超时交 job 层 |
| 库存操作键 | `STOCK_MOVEMENTS.operationKey` | 13 条行为 | 旧函数 deprecated 兼容 |
| 提交成功回执 | `config/submitToast.js` | 扫码 4 条链 + 工作台采购 | 无成功页；文案可配 |
| 日志事件 | `config/events.js` | 全仓日志 | 自动生成，禁止手改 |
| 表/字段映射 | `config/v1BitableSchema.js` | 所有飞书读写 | 改表必须同步 |
| 配置表缓存 | `config/configTables.js` + `configTableCache` | 8 张配置表 | 单实例；多实例未做 |

## 5. 仍需注意的缺口

```text
#891  P0
  - 本地任务 createIfAbsent 并发覆盖
  - ensureMain 查询失败被当成“没有”
  - 统一 asyncJobStore 同类并发问题

F4
  - partial_failed 默认不发群
  - “少退几双”仍可能没人看到

回填
  - 销售明细.采购明细 回填失败只记日志
  - 不重试、不通知

配置表缓存
  - 当前单实例；多实例跨进程失效未做

交割单
  - 已接统一 job；前端 waitJob 超时仍建议观察调度排队
```

## 6. 验证命令

```bash
cd server
CI=true FEISHU_TARGET_ENV=test node --require ./test/support/table-id-env.js \
  --test --test-concurrency=1 test/*.test.js
./node_modules/.bin/playwright test
node scripts/check-file-size.mjs
node scripts/observability-events.mjs --check
```

---

边界：本文只做盘点；未部署、未改配置、未改业务代码。
