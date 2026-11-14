# 统一异步任务状态、重试与失败通知机制

> 2026-11-08 定稿。对应 issue：[#948](https://github.com/LyraWang6688/feishu-retail-ops/issues/948)。

## 1. 背景

当前销售、售后、采购补货、采购退货、采购验收都已采用“先回成功回执，后台异步写库”的模式。

问题在于：**成功回执只代表服务端已接收/已入队，不代表飞书表已经写成功。**

现状：

| 链路 | 自动重试 | 失败状态 | 失败通知 |
|---|---|---|---|
| 销售提交 | 否，只跑一次 | 主表标记“部分失败” | 无 |
| 售后退货 #943 | 是，3 次 | `failed` + `last_error` | 无（#947） |
| 采购补货 #946 | 否 | `last_error` | 无 |
| 采购退货 | 否 | `last_error` | 无 |
| 采购验收 #944 | 否 | `last_error` | 无（F3） |

用户可能看到「数据提交成功，后台自动写入」，但实际写入失败，且没人知道。

## 2. 目标

建立一套**所有异步链路共用**的任务状态、重试与失败通知机制。

明确不做：

- 不在页面显示失败提示；
- 不改变成功 toast 文案；
- 不恢复群聊/私聊录入入口；
- 不部署。

## 3. 统一任务模型

### 3.1 状态

```text
queued
  ↓
running
  ↓
succeeded
  ↓
failed
```

允许的中间/终态：

```text
partial_failed   // 部分写入成功，部分失败
failed           // 终态，重试耗尽
succeeded        // 终态，全部写入成功
```

### 3.2 任务字段

```text
job_id          统一任务 id
type            sales | after_sales | purchase_replenish | purchase_return | purchase_acceptance
status          queued | running | succeeded | partial_failed | failed
attempts        已尝试次数
last_error      最后一次错误
payload         冻结的提交内容
result          业务写入结果
created_at
started_at
finished_at
notified_at     失败群通知时间（用于去重）
```

### 3.3 存储

新增统一存储：

```text
server/src/services/asyncJobStore.js
```

底层复用现有 `services/infrastructure/jsonTaskStore`，目录：

```text
server/data/async_jobs/
```

一条任务一个 JSON 文件，文件名由 `job_id` 决定。

要求：

- 写入原子性沿用 `JsonTaskStore`；
- 每个任务只允许一个 worker 执行；
- 重试只更新同一任务，不新建任务；
- 任务完成后保留，供排查与重试；
- 不把敏感凭证写进 payload。

## 4. 统一配置

新增：

```text
server/src/config/asyncJobs.js
```

建议配置项：

```js
{
  retry: {
    maxAttempts: 3,
    baseMs: 800,
    maxDelayMs: 10000,
  },
  poll: {
    intervalMs: 2000,
    maxMs: 60000,
  },
  notify: {
    chatId: process.env.NOTIFY_GROUP_CHAT_ID || process.env.PURCHASE_CHAT_ID,
    enabled: true,
    dedupeHours: 7 * 24,
  },
  texts: {
    groupTitle: '【异步写入失败】',
    // 其它文案放这里，service 不写死中文
  },
}
```

**群选择**：

- 复用 `PURCHASE_CHAT_ID`（文档中即「邯美皮鞋运营群」）；
- 如需单独群，配 `NOTIFY_GROUP_CHAT_ID`（统一通知配置；旧文里的 `ASYNC_JOB_ALERT_CHAT_ID` **从未接线**），未配置时回落到 `PURCHASE_CHAT_ID`；
- 未配置群 → 记 `async_job.notify.chat_missing`，不静默成功。

## 5. 重试规则

只重试临时错误：

```text
飞书 5xx
请求超时
网络错误
限流
```

不重试：

```text
400 校验错误
字段不存在 / 权限不足
参数错误
业务规则拒绝
```

重试要求：

- 复用原 `submitKey` / `requestId` / 幂等键；
- 不允许因为重试产生第二条业务记录；
- 每次失败更新 `attempts` / `last_error`；
- 达到上限后置 `failed`，进入通知流程。

## 6. 失败通知

### 6.1 触发时机

只在**最终失败**时发：

```text
status = failed
notified_at 为空
```

不在每次重试时发。

### 6.2 发送目标

```text
飞书群：PURCHASE_CHAT_ID（邯美皮鞋运营群）
```

使用项目现有机器人客户端发送文本；不新开机器人、不恢复群聊入口。

### 6.3 消息格式

```text
【异步写入失败】
类型：售后退货
单号/批次：XSD-20261108-0012
操作人：王颖
失败步骤：写交易明细
错误：飞书字段不存在
任务ID：async_job_xxx
时间：2026-11-08 12:34:56
```

要求：

- 单号/批次号能拿到才写，拿不到不编；
- 默认不 @人；
- 不把完整 payload 发群（避免泄露）；
- 错误信息截断到配置上限。

### 6.4 去重

- 按 `job_id` 去重；
- 发送成功才写 `notified_at`；
- 同一任务重试/重启后不重复发；
- 发送失败：不写 `notified_at`，记日志，允许后台重试发送。

### 6.5 发送失败

发送失败不能影响业务任务状态；只记：

```text
async_job.notify.failed
```

并要求后续可重试。

## 7. 状态接口

新增只读接口：

```text
GET /api/workbench/async-jobs/:jobId
```

要求：

- 必须登录（沿用工作台鉴权）；
- 只能查自己的任务；
- 返回：

```json
{
  "job_id": "async_job_xxx",
  "type": "after_sales",
  "status": "failed",
  "attempts": 3,
  "last_error": "飞书字段不存在",
  "created_at": "...",
  "finished_at": "..."
}
```

不返回完整 payload、不返回敏感字段。

## 8. 页面行为

### 成功

保持现有统一 toast：

```text
数据提交成功，后台自动写入
```

由 `config/submitToast.js` + `utils/submitToast.js` + `shared/toast.js` 负责。

### 失败

```text
页面不显示失败提示
不弹红色 toast
不新增失败入口
```

失败记录只发运营群。

### 草稿

- 成功确认前不提前丢草稿；
- 失败后可重新提交；
- 采购页继续保持 fetch 提交，成功后按方案 A 回工作台。

## 9. 各链路接入点

| 链路 | 现有入口 | 接入方式 |
|---|---|---|
| 销售 | `saleWriteBackgroundService` / `salesJobStore` | 统一 store 适配；后台失败写 failed；通知 |
| 售后退货 | `afterSalesAsyncService` | 已有重试；补 notifier / 统一状态 |
| 采购补货 | `purchaseWriteBackgroundService` | 补自动重试；失败写 failed；通知 |
| 采购退货 | `purchaseWriteBackgroundService` | 同上 |
| 采购验收 | `purchaseWriteBackgroundService` | 同上 |

## 10. 实施顺序

```text
1. asyncJobs 配置 + asyncJobStore + 状态接口
2. 失败通知 notifier + 去重 + 测试
3. 售后接入（试点，补 #947）
4. 销售接入
5. 采购补货 / 退货 / 验收接入
6. 统一成功 toast 方案 A 接入采购页
```

## 11. 测试

### 单测

- 状态流转：queued → running → succeeded / failed
- 重试：临时错误重试，永久错误不重试
- 幂等：同一 submitKey 重放不重复写
- 通知：最终失败发一次；同 job 不重复发；发送失败可重试
- 群未配置：记 `chat_missing`，不静默成功
- 状态接口：鉴权、只能查自己、不返回敏感字段

### 真实测试 Base

- 售后、销售、采购各跑一条失败注入（mock 飞书 5xx）
- 验证只发一条群消息
- 验证业务表没有重复写入

### 群消息验证

- 测试群或测试 Base 环境发送一条真实消息
- 生产群只在用户明确授权后验证

## 12. 验收标准

```text
1. 每条异步链路都有统一 job_id 和状态
2. 最终失败后运营群收到一条结构化消息
3. 同一 job 不重复发群消息
4. 临时错误自动重试，永久错误不重试
5. 重试不产生重复业务写入
6. 页面仍只显示成功 toast，不显示失败提示
7. 群发送失败有日志、可重试
8. 单测 + 测试 Base 验证 + 一条真实群消息验证
```

## 13. 非目标

- 不做页面失败提示；
- 不做失败重试按钮；
- 不恢复群聊录入；
- 不修改成功 toast 文案；
- 不在本卡内部署。

---

## 2026-11-14 补丁：#50 / #44（running 收敛 · 终态补发 · 优雅退出）

> 审计记录 #50 / #44 的修复落点；不改变本文既有状态机语义。

- **`running` 残留收敛**：进程重启后，`running` 且 `started_at` 超过 `ASYNC_JOB_RUNNING_STALE_MINUTES`（默认 30）的 job ⇒
  置 `failed`（`last_error` 写明"需人工核对"）+ 发失败通知；启动时跑一次，之后每 `ASYNC_JOB_RECOVER_INTERVAL_MS`（默认 15 分钟）巡检。
  事件：`async_job.recover.running_reaped`（已加入观测告警 critical events），汇总 `async_job.recover.reaped`。
- **启动补发集合**：由 `NOTIFY_STATUSES = [failed, partial_failed]` 统一给出（原来只筛 failed ⇒ #44）；
  `notified_at` 仍是唯一去重依据。
- **优雅退出**：`SIGTERM/SIGINT` ⇒ 停接新连接 → 等正在跑的异步 job 收尾（`asyncJobService.shutdown`）→ 刷写入审计队列（`flushWriteAudit`）→ 退出；
  总超时 `APP_SHUTDOWN_TIMEOUT_MS`（默认 10s，超时也退出）。
- **未处理异常**：`unhandledRejection` 记 `process.unhandled_rejection`（不退出）；`uncaughtException` 记 `process.uncaught_exception` 后走同一条优雅退出。
- **库存手工调整并发**：`InventoryPairAdjustmentService.adjustPairs / setSeason` 按货品/品类加**进程内串行锁**（`utils/keyedLock`），
  避免两个 job 同时"先读后写"导致重复增减（PM2 单实例前提不变）。
