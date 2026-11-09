# 统一基础设施与配置盘点（2026-11-08）

> 只读盘点，不是配置变更单。
>
> 当前基线：
>
> - main：`ab34e615`
> - 生产：`v0.7.2 / e8b2bb7`
> - 生产已包含 #978~#987；main 还包含 #988、#990~#1015 等（未部署）

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
partial_failed 也是终态，直接发群
页面不新增失败提示
```

### 1.2 统一配置项

配置真源：`server/src/config/asyncJobs.js`；样例：`.env.example` 的 `ASYNC_JOB_*`。

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| ~~`ASYNC_JOB_ENABLED`~~ | ~~统一异步层开关~~ ⭐ 2026-11-10 业务负责人「不需要加开关」⇒ **已删除，固定常开** | — |
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
| `NOTIFY_GROUP_CHAT_ID` | 失败通知群（统一通知目标），空则回落 `PURCHASE_CHAT_ID` | 空 |
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
| `server/src/config/notifications.js` | 通知目标 + 事件注册 + 发送形式 | 全部通知 |
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

### 3.9 统一通知配置（2026-11-09）

唯一入口：

```text
config/notifications.js
services/notificationCard.js
services/notificationService.js
```

目标只保留两个（业务负责人 2026-11-08 口径）：

```text
private → open_id（本人）
group   → chat_id（运营/采购群）
```

环境变量：

```text
NOTIFY_PRIVATE_OPEN_ID     # 回落 OBSERVABILITY_ALERTS_OPEN_ID
NOTIFY_GROUP_CHAT_ID       # 回落 PURCHASE_CHAT_ID
```

事件注册表：

```text
async_job_failed          group / card
observability_alert       private / card
lark_event_heartbeat      private / card
purchase_request_created  group / text（保留图片+@+话题）
purchase_return_created   group / text（保留图片+@+话题）
voucher_settlement        group / card
```

发送形式：

```text
card → Card JSON 2.0 + CardKit v1
       card.create → card_id
       im.message.create 引用 card_id
       card.update 编辑
text → 普通文本；支持 replyToMessageId / reply_in_thread
```

已迁移 / 已删除：

```text
6 个事件全部接入统一入口
旧 im.v1.message.patch / interactiveCardFeedback 已删除
销售/售后/补样品/到货核对群话题卡片已删除
工作台到货确认、补样品写库、库存写入保留
```

注意：

```text
采购的图片仍是图片消息，文字通知走 text 格式并回到图片所在话题；
通知卡片不再带按钮回调（card.action.trigger 已退场）。
```

### 3.10 工作台 UI tab 配置（2026-11-10）

工作台所有层级的 tab 已经配置驱动，页面只负责渲染，不再写死 tab 名称/顺序：

| 层级 | 唯一配置 | 覆盖 |
| --- | --- | --- |
| 一级 tab | `public/workbench/config/tabs.js` 的 `MAIN_TABS` | 销售 · 库存 · 供应 · 资金 · 配置 · 创作 |
| 二级子页 tab | `public/workbench/config/domains.js` 的 `DOMAIN_TABS[*].pages` | 各领域下的子页（录单 / 订单列表 / 手工调整 / 标签打印 / 数据配置 / 消息通知…） |
| 三级子 tab | `public/workbench/config/inventoryAdjustment.js` 的 `INVENTORY_ADJUSTMENT_TABS` | 库存 → 手工调整：状态调整 / 盘点调整 / 换季调整 |
| 交割单页 tab | `public/workbench/config/sales-delivery.js` 的 `TABS` | 货未清 / 钱未清 / 钱货都未清 |
| 采购页 tab | `public/workbench/config/procurement.js` 的 `tabs` | 补货 / 上新 / 扫一扫（占位） |
| 扫码页领域 tab | `src/views/scanPageRealm.js` 的 `REALM_TABS` | 销售 / 补货 / 库存 / 退货 |

边界：

- 这是**代码配置**，不是运行时后台可编辑；加减 tab / 改名 / 改顺序仍需要改配置并部署；
- 每个 tab 对应的面板实现仍按 `id` 走代码，新增功能不能只加配置；
- 独立页顶部导航（返回完整工作台 / 库存手工调整 / 鞋盒标签打印）已按业务口径删除，不属于 tab 配置范围。

## 4. 哪些“统一化了”

| 层 | 统一配置/真源 | 覆盖 | 例外 |
| --- | --- | --- | --- |
| 异步 job 模型 | `config/asyncJobs.js` | 销售/售后/补货/退货/验收/交割单 | 无（#983 已接） |
| 异步重试分类 | `config/asyncJobs.js` | 同上 | 无（#984 已统一） |
| 失败通知 | `config/notifications.js` + `notificationService` | 6 个通知事件 | `failed` / `partial_failed` 都发 |
| 飞书写入并发 | `config/feishuWriteScheduler.js` | 所有 gateway 写 | 读请求 / 本地任务 |
| 飞书写入瞬时重试 | 同上 | 所有 gateway 写 | 5xx/超时交 job 层 |
| 库存操作键 | `STOCK_MOVEMENTS.operationKey` | 13 条行为 | 旧函数 deprecated 兼容 |
| 提交成功回执 | `config/submitToast.js` | 扫码 4 条链 + 工作台采购 | 无成功页；文案可配 |
| 日志事件 | `config/events.js` | 全仓日志 | 自动生成，禁止手改 |
| 表/字段映射 | `config/v1BitableSchema.js` | 所有飞书读写 | 改表必须同步 |
| 配置表缓存 | `config/configTables.js` + `configTableCache` | 8 张配置表 | 单实例；多实例未做 |
| 工作台 UI tab | `config/tabs.js` + `config/domains.js` + `config/inventoryAdjustment.js` | 一级 / 二级 / 三级 tab | 代码配置，改动需部署；独立页导航已删 |
| 通知目标 / 事件 / 卡片 | `config/notifications.js` + `notificationService` | 私聊/群聊 6 类事件 | 采购文字保留图片+@+话题 |

## 5. 仍需注意的缺口

### 已修复

```text
通知配置：6/6 事件已迁移；旧群话题卡片/旧 message.patch 已删净
      → PR #1001~#1015

#891  本地任务 createIfAbsent 并发覆盖
      ensureMain 查询失败被当成“没有”
      统一 asyncJobStore 同类并发问题
      → PR #988 已合并：JsonTaskStore 原子 createIfAbsent；
        salesJobStore / asyncJobStore 共用；
        ensureMain 查询失败直接抛，不再创建主表
```

仍缺：

```text
F4
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

## 7. 2026-11-09 多 AI 统一配置审计

5 个只读审计员分别检查：通知、异步任务、库存键、配置表缓存、写调度/回执/事件/schema。

结论：

```text
complete: 0
partial: 5
missing: 0
```

也就是：**主入口都已存在，但每个域都还有例外或未收口点**。

> 2026-11-09 晚更新：本节的 target 覆盖、partial_failed、groupBuyVoucher / scanPage 缓存、
> productSnapshot、交割单 toast 已由 #1026 / #1027 / #1023 / #1028 修复；下文逐项标注。

### 7.1 通知

已实现：

```text
private/group 两个目标
6 个事件注册
CardKit 卡片底座
asyncJobNotifier / alertNotifier 走统一服务
旧 message.patch 清零
```

缺口：

```text
NOTIFICATION_EVENTS[*].card 字段无消费者
```

已修复：

```text
#1027：显式 target 只覆盖收件人；enabled/reason 仍由 resolveNotification 决定
```

### 7.2 异步任务

已实现：

```text
统一状态机 / 重试 / 幂等键 / notified_at
failed 默认进群通知
```

缺口：

```text
notify 失败后没有后台重试（只有进程重启补发）
部分链路没有统一 job / 没有恢复
```

已修复：

```text
#1026 + 2026-11-09 收口：run() 的 partial 分支在 markPartialFailed 后调用 notifyIfNeeded
      failed / partial_failed 都发，不再需要 ASYNC_JOB_NOTIFY_STATUSES
```

### 7.3 库存键

已实现：

```text
13 条行为都有 operationKey
三把键只有 keys.js 一个生成口
销售出库 / 采购退货已对齐「实时库存有记录就算有货」
```

缺口：

```text
getSaleResult 仍走旧 operationId
部分状态清单仍有第二份硬编码
```

已修复：

```text
#1028：销售出库 / 采购退货 consumes='*'，完全不看所属状态；
      findLiveInventoryIn / 单条 / 批量 / 账本 / 计划各路径统一按任意状态校验
```

### 7.4 配置表缓存

已实现：

```text
8 张表登记
读走 getConfigRows
TTL 单源
record_changed 失效
lastGood 告警
```

缺口：

```text
路由级 invalidate 没有测试
labelPrint 仍叠加自己的 60s product 缓存
部分定向读 / 批量读仍不进快照；按编号找货品已走 configTableCache
```

已修复：

```text
#1027：voucherPaymentService → getConfigRows('groupBuyVoucher')
      scanPageService readAllCapped → getConfigRows
      按 record_id 读货品 → getConfigRows('product')
      删除 productSnapshot（含 config / env / 测试）
```

### 7.5 写调度 / 回执 / 事件 / schema

已实现：

```text
bitable 写全部走 gateway → 调度器
调度器固定常开
events 自动生成
schema 表 ID 全部来自 env
```

缺口：

#### 附件上传

```text
uploadAttachment 直调 drive.media.uploadAll
没有走 feishuWriteScheduler
```

#### IM 发送

```text
notificationService / larkMvpService / purchase messaging
直接走 im.message.create / reply / image.create
不走 bitable 调度器
```

#### 提交 toast

统一入口是：

```text
config/submitToast.js
utils/submitToast.js
```

但仍有页面没有走：

```text
工作台「确认到货」：仍用 config/workbenchArrival.js 的「已提交成功，数据会更新」
售后：config/afterSalesPage.js 的「信息提交成功」＋页面自建 toast(2200ms)
旧成功页配置 config/scanPage.js 的 SALE_SUCCESS 仍存在
```

已修复：

```text
#1023：交割单提交 toast 走 config/submitToast.js
      轮询参数走 config/asyncJobs.js，删除前端本地 jobPoll
```

仍待收口：到货确认、售后 toast。

#### events

```text
单段事件名（ui.tap / multi_item_order.*）不会进入自动目录
运行时拼接的事件名无法静态生成
```

### 7.6 审计后的优先顺序

```text
P0：通知旧目标配置死读取 / text 分支已收口
P1：toast 收口（到货确认 / 售后）
P2：配置表缓存剩余例外（路由失效测试 / labelPrint 叠加缓存）
P3：events 单段事件名、附件/IM 写调度边界
```


## 8. 待统一：样例图同步到云盘（Issue #629，未实现）

现状：

- 「货品信息.样例图」只是多维表格附件字段；
- 代码只在 `larkMvpService.loadProductIndex` 里判断附件数组是否为空（`missingSampleImage`），**没有下载、转存、上传云盘**；
- 全仓唯一的 drive 上传是标签二维码 `tagQrCodeService` → `V1BitableGateway.uploadMedia()`，写回「货品信息.标签二维码」附件，不是云盘文件夹；
- 没有 `drive/v1/files/upload_all`，也没有附件下载 / 云盘复制逻辑。

要做「样例图自动同步到云盘」时，先定这 5 个配置项：

```text
1. 触发时机：货品记录变更事件（drive.file.bitable_record_changed_v1）还是定时全量补齐
2. 目标位置：云盘 folder_token；是否按货号 / 颜色建子目录
3. 命名规则：例如 货号|颜色|样例图.jpg
4. 幂等去重：本地记录（附件 token -> 云盘 file token）还是回写一列云盘文件 token
5. 失败处理：走统一 asyncJobs + 失败通知，不阻塞货品页面
```

在口径未定之前，这条**不纳入当前统一配置**；上面的 5 项定完后，再新增独立配置（建议 `config/sampleImageSync.js`）并登记到本文档。
