# 打印请求 → 飞书「标签打印」表（2026-11-17 · 业务负责人）

> 业务负责人 2026-11-17 的口径：
> 「扫码打印、库存调整打印的打印请求，也写进这张『标签打印』数据表；**只是记录请求**」。
>
> ⇒ 写「打印货号 + 打印日（飞书自动）+ 来源 + **申请次数**」；**不写状态 / 打印时间 / 失败原因**。
>   匹配键 = **打印货号 + 来源**：搜到 ⇒ 申请次数 +1；没有 ⇒ 新建、次数 = 1。
>   「申请次数」= **打印任务创建次数**，不是物理出纸成功次数。
>   一次**新建打印任务**才写；队列复用（防连点）不重复写；表单来源不写第二行（表单记录本身就是请求）。

## 一、目标表

表：[标签打印](https://scnzoiwpgxik.feishu.cn/base/QrXlbwXMLaJ2TNsxSfFcIA3rnwh?table=tblcUksCp3EmbmBa)（tblcUksCp3EmbmBa，配置信息文件夹）

表当前字段（2026-11-17 下午，业务负责人已加好）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 打印货号 | 单向关联 → 货品信息 | 表单请求用它选货；服务端请求记录也用它指到具体货品 |
| 打印日 | 日期（默认记录创建时间） | 飞书自动字段；代码不写 |
| **来源** | 单选 | 批量打印 · 扫码打印 · 库存调整打印 · 销售录单打印 · 验收录单打印 |
| **申请次数** | 数字 | 同一「打印货号 + 来源」每新建一个打印任务 +1 |

- 建议**来源默认值 = 批量打印**；默认值不生效也没关系 —— 监听端把「来源为空」也按表单请求处理。
- ⚠️ 在「批量打印」表单里**隐藏「来源」这个题**（它只给系统写，不该让填表的人选）。
- 现有那条存量记录（2026-11-17 08:41 的 M5216|灰色|男）来源/次数为空即可 —— 批量打印表单**不参与申请次数**，这条不动。
- 加完后跑 pnpm run v1:schema-check:all；代码里的映射在 server/src/config/v1BitableSchema.js 的 labelPrintRequest.fields.source / fields.count。

## 二、写什么 / 不写什么

| 场景 | 是否写 | 来源值 | 说明 |
| --- | --- | --- | --- |
| 扫码打印（新任务） | ✅ 搜索/新建 | 扫码打印 | 关联扫到的那条货品；有行就 +1 |
| 库存调整打印（新任务） | ✅ 搜索/新建 | 库存调整打印 | 关联这次调整的货品；有行就 +1 |
| 销售录单打印（新任务） | ✅ 搜索/新建 | 销售录单打印 | 资金页成功后，本单每款鞋各一次 |
| 验收录单打印（新任务） | ✅ 搜索/新建 | 验收录单打印 | 验收 job 成功后，本次每款各一次 |
| 补打（非表单来源） | ✅ 搜索/新建 | 沿用原来源 | 新任务 = 新请求；原任务不改 |
| 批量打印（表单提交） | ❌ 不参与 | 批量打印（表单记录） | 表单记录本身就是批量请求；一行多货号，无法按货号计数 |
| 连点 / 队列复用 | ❌ 不写 | — | 只认**新建任务** |

**不写**：状态、打印时间、失败原因、打印设备、任务 ID。这些仍只在服务端队列与日志里；本表只回答“谁在什么时候请求打了哪个货、申请了几次”。

**匹配键 = 打印货号 + 来源**；打印货号是关联列，飞书 filter 对关联列实测不生效 ⇒ 实现上读整表后按 record_id + 来源在本地匹配（表大后再加文本匹配键）。

## 三、⚠️ 为什么必须有「来源」：防重复打印

这张表同时是「批量打印」表单的**输入表**：

   新记录 → bitable record_added
         → routes/larkEvents.js 按 table_id 分派
         → labelPrintFormIntakeService
         → 读「打印货号」→ 每个货号入队打印

如果服务端把扫码/库存的请求记录也写进去，监听端会把它当成一次新的批量打印请求，**再打一遍**。

因此：

- 服务端写的记录**一律带「来源」**（扫码打印 / 库存调整打印 / 销售录单打印 / 验收录单打印）；
- [labelPrintFormIntakeService.js](../server/src/services/labelPrintFormIntakeService.js) 只处理：
  - 「来源」为空（加字段前的存量记录、或默认值没生效的表单记录）；
  - 「来源」= 批量打印；
- 其他来源一律 skipped_source：**不入队、不发通知**。

## 四、实现落点

| 件 | 落点 |
| --- | --- |
| 配置 | server/src/config/labelPrintRequestLog.js（开关 / 表语义键 / 来源文案） |
| 写入器 | server/src/services/labelPrintRequestLogService.js（listAll 搜索 → update 次数+1 / create 次数=1，best-effort） |
| 队列挂钩 | server/src/services/labelPrintQueueService.js：createJob 与 reprint 成功后**异步**写；复用任务不写 |
| 单例装配 | server/src/services/labelPrintQueueRuntime.js：把写入器注入共享队列 |
| 来源标记 | 扫码 SOURCES.scan；库存调整 SOURCES.inventory；销售 SOURCES.sale；验收 SOURCES.acceptance；表单 SOURCES.form |
| schema 映射 | labelPrintRequest.fields.source = '来源'；fields.count = '申请次数' |
| 开关 | LABEL_PRINT_REQUEST_LOG_ENABLED（默认 true；关掉后队列照常打印，只是不写飞书） |

## 五、边界

- **best-effort**：飞书写失败只记 label_print.request_log.failed warn；**不阻塞、不回滚打印**。
- 队列 JSON（server/data/label_print_jobs）仍是打印任务的唯一事实源；本表只是请求台账。
- ⚠️ 这个 Base 开了**高级权限**：服务端应用需要对「标签打印」表有**编辑权限**；没有编辑权限时只会记 warn，打印不受影响，但请求记录写不进去。
- 写飞书走 v1BitableGateway + feishuWriteScheduler；调度器只重试“确定没写进去”的瞬时错误，5xx/超时不在这一层重试。
- 本链路**不写生产 Base 数据**（实现/测试阶段）；「来源」「申请次数」字段已由业务负责人加好，部署需当次明确指令。

## 六、验收（先写先红）

server/test/labelPrintRequestLog.test.js：

- **AC-RL1** 第一次扫码打印 ⇒ 新建：打印货号（关联）+ 来源=扫码打印 + 次数=1；
- **AC-RL2** 同货品 + 同来源再请求 ⇒ 只给原行次数 +1，不新建；
- **AC-RL3** 不同来源 ⇒ 同货品各记各的；
- **AC-RL4** 销售录单 / 验收录单来源文案与表选项一致；
- **AC-RL5** 表单来源 ⇒ 跳过（不参与次数）；
- **AC-RL6** 没有货品记录 ID / 来源不认识 ⇒ 跳过；
- **AC-RL7** 搜索/建行失败 ⇒ 返回 ok:false，**不抛错**；
- **AC-RL8** 开关关掉 ⇒ 一次飞书都不打。

server/test/labelPrintFormIntake.test.js：

- **AC-FF12** 来源=扫码打印 / 库存调整打印 ⇒ 跳过、不入队、不通知；
- **AC-FF13** 来源=批量打印 / 为空 ⇒ 照常处理。

server/test/labelPrintQueue.test.js：

- **AC-LOG1** 新建任务写一行；同一请求复用不再写。
