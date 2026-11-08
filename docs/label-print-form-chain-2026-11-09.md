# 「批量打印」飞书表单 → 自动打印（2026-11-09）

> 业务负责人口径（逐字/确认）：
> - 「点「批量打印」进的是飞书表单链接，后续就只用这个了」
> - 「选择编号打印那个页面也不需要了，可以直接删除，因为点击批量打印的时候，只选择一个就可以了」
> - 「每个货号各打各的（一个失败不拖累其他）」✓
> - 「同一条表单记录汇总一条通知」✓
> - 「跳过并通知（A、B 照常打印；C 跳过；同一条汇总通知里写 C 跳过：没库存/没编号）」✓
> - 「店里电脑离线 → 排队等它上线」✓
> - 「临时错误重试 **3 次**」（首次失败后再试 3 次 = 最多 4 次尝试）✓

## 一、链路

```
她点「批量打印」→ 打开飞书表单（写「标签打印」表：打印货号【关联·多选】、打印日【自动】）
  → 提交（新增一条记录）
  → 飞书 drive.file.bitable_record_changed_v1 事件 → POST /api/lark/events
  → 按 table_id 分派（config/v1BitableSchema.js 的 labelPrintRequest.tableId，不写死表 ID）
  → services/labelPrintFormIntakeService.js：
       读这条记录的「打印货号」→ 每个货品记录 ID
       → 每个货号各排一次既有打印队列（labelPrintQueueService.enqueueSingle，source=form）
       → 店里那台 Windows 电脑（小助手）领任务 → SumatraPDF 出纸
  → 失败/跳过 ⇒ 同一条记录**汇总一条**通知 → 运营群（config/notifications.js 的 label_print_failed）
```

## 二、口径与实现落点

| 口径 | 实现 |
| --- | --- |
| 一条表单勾多个货号，各打各的 | `processRecord` 对每个货品记录 ID 独立 `enqueueSingle`，逐个 catch（一个失败不拖累其他） |
| 坏货号（没编号 / 没库存 / 记录没了）⇒ 跳过 | 队列回 **400**（她的数据问题）⇒ `kind: 'skipped'`，计入汇总通知，不重试 |
| 失败 / 跳过 ⇒ 同一条记录汇总一条通知 | `notifySummary()` 只调一次 `notificationService.send('label_print_failed', { lines })` |
| 临时错误重试 3 次 | `config/labelPrintForm.js` 的 `retries: 3`（env `LABEL_FORM_INTAKE_RETRIES`）；退避复用 `config/asyncJobs` 的 `retryDelayMs`（0.8s / 1.6s / 3.2s，上限 10s）；永久错误（403 / 飞书永久码）不重试 |
| 店里电脑离线 | **不判失败**：任务留在队列（现有机制：掉线 90s 算未连接、任务保留 7 天），电脑上线自动领走补打 |
| 幂等 | 幂等键 `label_form:<表单记录ID>:<货品记录ID>`（队列 `submitKey` 去重：同一个 key 只会有一个任务；失败任务不参与复用）；另加**本地去重窗口**（默认 10 分钟，飞书事件重投不再处理/不再通知） |
| 「打印日」 | 飞书自动字段（默认值 = 记录创建时间）；schema **刻意不映射**，本链路**没有任何写表路径**（只 `gateway.get` 读一条表单记录 + 入队） |
| 只认新增 | `config/labelPrintForm.js` 的 `triggerActions: ['record_added']`；编辑 / 删除不触发打印 |

## 三、配置与环境变量

- `config/v1BitableSchema.js`：新增表 `labelPrintRequest`（tableName「标签打印」，只映射 `product: '打印货号'`）。
- `config/labelPrintForm.js`：重试次数 / 通知条数上限 / 去重窗口 / 通知文案（服务层不写中文）。
- `config/notifications.js`：新增事件 `label_print_failed`（group / text / 标题【标签打印】）。
- `config/labelPrintQueue.js`：`SOURCES.form = 'form'`。
- `.env.example`：`FEISHU_V1_LABEL_PRINT_REQUEST_TABLE_ID`（生产 `tblcUksCp3EmbmBa`；测试 Base `tblrdbgGFTWurzjP`）。
- 测试预加载 `test/support/table-id-env.js`：`FEISHU_V1_LABEL_PRINT_REQUEST_TABLE_ID=tbl_test_label_print_request`。

## 四、验收（先写先红）

`server/test/labelPrintFormIntake.test.js`：

- **AC-FF1** 一条表单勾多个货号 ⇒ 每个货号各排一次队（source=form、幂等键逐货号）
- **AC-FF2** 坏货号（400）⇒ 跳过、其他照打；同一条记录只发**一条**通知（含跳过原因）
- **AC-FF3** 临时错误重试 3 次后成功 ⇒ 共 4 次尝试、间隔 0.8/1.6/3.2 秒、**不通知**
- **AC-FF4** 重试 3 次仍失败 ⇒ 失败汇总一条通知（含「已重试 3 次仍失败」+ 原因）
- **AC-FF5** 永久错误（非 400）⇒ 不重试、计失败、通知一次
- **AC-FF6** 同一条表单记录事件重投 ⇒ 去重（不再打、不再通知）
- **AC-FF7** 只认 `record_added`；编辑 / 删除不触发
- **AC-FF8** 「打印日」不映射；本链路没有任何写表路径
- **AC-FF9** 关联字段解析（数组对象 / 字符串 / recordId / 嵌套数组；认不出不猜）
- **AC-FF10** 事件分派按 schema 的 table_id（不写死表 ID）

## 五、边界

- 本链路**不写生产 Base**、不部署；上线需业务负责人当次明确指令。
- 本链路不负责「打印出来没有」的物理确认：打印机坏 / 没纸由店里电脑侧体现（任务失败/卡住），需人工看一眼。
- 真实 Base 的**端到端**验证（测试 Base 写一条表单记录 → 走项目代码 → 队列出任务）在部署前用测试 Base 单独做，不复用生产。
