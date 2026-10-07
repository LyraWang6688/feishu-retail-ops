# 采购侧一批改动：表改名同步 · 报货批次号代码生成 · 到货状态落「报货批次」· 附件改回填 · 9 点推送【采购】区

> **业务负责人口径（逐字，2026-10-07）**
>
> 「首先，我们之前的**报货批次号是用手工填写的，后续要改为由后端代码来填写**。同时你可以看一下项目链路，
>  它其实**也会同步到报货批次里面**，所以改完之后也要同步。
>  同步完之后，**采购批次这个数据表主要控制的是该批次的到货情况（是退货还是采购）**。关于到货情况：
>  1. **每创建一条新记录时，默认值是「未到货」**
>  2. **当用户在话题群里说了到货之后，状态应该改成「已到货」**
>  所以**你每天 9 点发通知的时候，看未到货的情况就直接去那个表里查**，然后再把消息**深链**发到用户群里，
>  以及的话，你之前**下载完附件之后，不是要回填到那个供应商那边吗？现在不用往那边填写信息了，
>  你需要把这些信息挪到我们的"报货批次"里面**。你先理解一下这个逻辑，**报货批次里面的采购行为你不用管**」
>
> 补：批次号格式 = **`CGD-20261007-0003`**（前缀 CGD + 日期 + 序号）；「**就不会让用户自己填了，自动生成就可以了**」
> 补：两张表改名 —— 「供应商对接」→ **信息填写**、「单据信息」→ **具体信息**

> ⚠️ 本文件**先写"改完之后应该是什么样"（验收标准），再动手**（第 3 节）；
> 第 4 节是逐条对照与证据。第 5 节记**没做到 / 拿不到证据**的地方。

---

## 1. 改动前的现状（为什么必须改）

| 现状 | 后果 |
|---|---|
| `purchaseRequest`（表已改名「具体信息」）的「到货状态」「采购申请单」两列**已被业务负责人在生产表删掉**，代码里还指着它们 | 附件写回与到货状态回写**当场写失败**（`FieldNameNotFound`）；`v1:schema-check` 虽然会红，但线上服务不跑闸门 |
| `purchaseOrderBatch`（报货批次）生产真表 **7 列**（新增了「到货状态」「单据」「采购行为」），schema 只映了 4 列 | 新列读不到、写不进；9 点推送无从查「未到货」 |
| 报货批次号 `BH-YYYYMMDD-NNNN` 由 `nextBatchNo()` **在出单那一刻**生成，且**不写回**「信息填写」那一列 | 那一列仍是**她手填**的；她已拍板「不再手填」 |
| 归批键 = 她手填的「报货批次号」文本列（`readReportBatchNo`）；**空 → 每条记录各自成包** | 一旦她不填，一次提交 N 条 → **N 个号、N 张图**（她最在意的现象） |
| 9 点推送只有销售区 | 采购「未到货」那一批没人提醒 |

## 2. 决策与依据（写清楚为什么这么定）

| # | 决策 | 依据 |
|---|---|---|
| D1 | 归批采用**方案 A**：号在**入口**按包生成一次，并**写回这一包的空文本记录**（只写未到终态的；历史记录零改动）；归批链路其余一行不改 | 她的口径是"不再手填"，而**归批键就是那一列**。入口写回之后，既有的 `readReportBatchNo → handleReportBatch` 一个字都不用改，也不会退化成 N 个号 |
| D2 | 号在**串行队列**（`KeyedSerialQueue`，键 `purchase_report_batch_no`）里算 + 写回 | 并发保护**不能照抄销售**：销售的判据是"同号出现两次 = 撞号"，而采购**一号天然对应 N 条**，照抄会误报。PM2 单实例 ⇒ 进程内串行即可 |
| D3 | 计数字符串 = 「同前缀 + 同一天 + 正好 N 位数字」取 **max+1**，且**同时数**「信息填写」与「报货批次」两张表 | ① 只数"同前缀+同一天"⇒ 今天的旧号 `202610071` / `202610072` 不匹配、不参与；② 取 max+1 而不是条数+1 ⇒ 有空洞也不会撞号；③ 写回发生在「信息填写」，而"入口写回失败"时号只落在「报货批次」⇒ **两张表求并集**才不会撞号（退货也会消耗号，只数报货批次会与退货的号撞） |
| D4 | 到货状态值域**不写死中文**：字面量进配置，并**在部署闸门里对着真表字段元数据校验**（`property.options` 必须含这两个字面量） | 写一个飞书单选里不存在的值 ⇒ 飞书**自动新建选项** ⇒ 表被污染、9 点推送查「未到货」静默失效（AGENTS.md 第 11 条①的真实事故形态）。闸门是唯一能在部署前拦住它的地方 |
| D5 | 附件/图写回改为「报货批次」的**「单据」**（按批次号定位那一条批次记录） | 她的原话「把这些信息挪到我们的'报货批次'里面」 |
| D6 | 9 点推送 = **两区并存**：销售区（逐字不变，**不加**大区标题）+ 采购区（新增大区标题）；顺序可配（默认销售在前） | 「销售在前、采购在后」+「销售区逐字不变」两条同时成立 ⇒ 销售区只能是"没有标题的那一区" |
| D7 | 采购区深链**照抄销售侧现役实现**：本地映射 → `LarkMessageLinkResolver` → `buildSalesThreadLink`（`client/thread/open` + chat_id/thread_id） | 「不是 `client/message/link?message_id=`」；且销售侧那条是**今天真正管用**的一条（实测 `message_app_link` 飞书不回） |

### 2.1 表改名与字段同步（生产 → 代码）

| 表 | 生产真表现状 | 代码同步 |
|---|---|---|
| 「信息填写」（原供应商对接，`tblo0ffzFt7vyQw2`） | 表名已改 | `schema.tableName` + 一切用户可见文案/注释 |
| 「具体信息」（原单据信息，`tbli1ygPtss5CWCH`） | 表名已改；**已删**「到货状态」「采购申请单」 | 同上 + **删** `arrivalStatus` / `attachment` 映射与全部写入点 |
| 「报货批次」（`tblwezby9wRea9qi`） | 7 列：报货批次号 / 创建时间 / 幂等键 / 更新时间 / **到货状态** / **单据** / 采购行为 | **加** `arrivalStatus`「到货状态」、`document`「单据」映射；「采购行为」**不映射、不读、不写**（她明确不用管） |

## 3. 验收标准（先写，后对照）

| # | 验收标准 |
|---|---|
| A1 | `schema` 的 `purchaseReport.tableName = 信息填写`、`purchaseRequest.tableName = 具体信息` |
| A2 | 全仓（`server/src`、`server/public`、`.env.example`、配置注释）**不再出现**「供应商对接」「单据信息」这两个旧表名（历史 docs 与 `docs/archive` 除外） |
| A3 | 表改名**不改任何链路**：分流/读写仍一律按 `tableId` |
| B1 | `purchaseRequest` 的 `arrivalStatus` / `attachment` 映射**删除** |
| B2 | 全仓**不再有任何**写/读 `purchaseRequest` 的「到货状态」「采购申请单」的代码路径（含 `routes/purchaseQuery.js` 的到货状态筛选、`purchaseQueryService` 的读取） |
| B3 | `purchaseOrderBatch` 新增映射：`arrivalStatus`「到货状态」、`document`「单据」；**没有**「采购行为」映射 |
| B4 | `server/scripts/validate_v1_schema.js` 能对「报货批次.到货状态」的**选项字面量**做校验（缺失即闸门判红），且不破坏既有 `schema-check` 用例 |
| C1 | 新号格式逐字 `CGD-20261007-0001`（前缀/日期格式/位数/时区**全部可配**） |
| C2 | **一个 webhook 报货包 = 一个号**：一次提交 N 条记录，只出一个号（不是 N 个） |
| C3 | 生成的号**写回**「信息填写」这一包的记录（只写空文本且未到终态的；**历史记录零改动**） |
| C4 | 号**同步**落进「报货批次」表的「报货批次号」（既有链路已写，钉住它） |
| C5 | 同天第 2 包 → `…-0002`；**跨天归零**；第 10 个 → `0010`（补零） |
| C6 | 计数只认「同前缀 + 同一天 + 正好 4 位」：今天的旧号 `202610071` / `202610072` **不参与**，第一个新号仍是 `0001` |
| C7 | **重投 / 重试不生成第二个号**（包内已有非空号 → 复用；同一条记录不会被写第二个号） |
| C8 | **并发不重号**：两包同时进来，得到两个不同的号（串行队列） |
| C9 | 日志：成功 `purchase.batch_no.generated { batch_no, sequence, today_count, task_id, source, attempts }`（`batch_record_id` 拿不到就不传）；撞号记 `purchase.batch_no.collision` |
| C10 | 群里识别批次号的正则**认得 `CGD-`**（`services/purchaseBatchNo.js`），群准入（`larkMvpService`）与话题/正文定位（`purchaseBatchLocator`）随之认得；`BH-` 作为历史格式**继续认** |
| C11 | 「认不出」的回复文案不再写死 `BH-`（前缀从配置来） |
| D1 | 新建「报货批次」记录时**显式写**「到货状态 = 未到货」（字面量来自配置） |
| D2 | 到货核对**确认成功**（`confirmArrival` 之后）→ 把该批次的「报货批次」记录改成「已到货」 |
| D3 | 到货状态写失败**不阻塞**入库链（入库事实已落地；只记 warn/error） |
| D4 | 值域来自配置 + 部署闸门按字段元数据核对（见 B4），service 里**不出现**中文字面量 |
| E1 | 出图后附件写回**「报货批次」的「单据」**（按批次号定位那一条批次记录） |
| E2 | 既有日志语义与「失败不阻塞主流程」的行为**不变**（`purchase.request.image.attachment_written` / `..._failed` / `attachment_exists` 语义保持） |
| F1 | 采购候选 = 「报货批次」里 到货状态 = 未到货（**直接查这张表**） |
| F2 | 采购区每行 = 批次号 + 供应商 +（有则）深链；**供应商从「信息填写」关联取**（编号 → 货品信息 → 供应商），取不到**不显示、不编** |
| F3 | 深链走本地映射 `server/data/purchase_group_messages/`（`chat_id` + `thread_id`）→ `LarkMessageLinkResolver` + `buildSalesThreadLink`；拿不到 → 行内不出现链接段 + 脚注 + 日志，**候选一条都不许因此丢掉** |
| F4 | 两区顺序可配（默认销售在前、采购在后）；**空区连标题都不出现**；两区都空 → **不发** |
| F5 | **销售区逐字不变**（哨兵用例：同一批候选，加/不加采购区，销售区那半逐字相同） |
| F6 | 采购区的大区标题 / 行格式 / 分隔符 / 脚注**全部可配**，service 里不写用户可见中文 |
| G1 | 前缀 / 日期格式 / 位数 / 时区 / 待处理状态字面量 / 标题 / 行格式 / 顺序 / 分隔符**全进 `config/`**，逻辑里不写死 `CGD-`、不写死中文 |
| G2 | `.env.example` 同步（注释版） |
| H1 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（在独立 worktree 里跑） |
| H2 | `gh pr checks` 见 **CLEAN**（三项：`test` / `Analyze (javascript-typescript)` / `CodeQL`）；**不用 `--admin`** |
| H3 | 既有断言**不放宽**；因口径变更必须改的，逐条说明"为什么不是放宽" |
| H4 | 🔴 不部署（等她当次命令）· 不写生产表 · 不改线上 `.env` |

## 4. 逐条对照（实现与证据）

| # | 结论 | 证据 |
|---|---|---|
| A1 | ✅ | `config/v1BitableSchema.js` 的 `purchaseReport.tableName = 信息填写`、`purchaseRequest.tableName = 具体信息`；用例 `purchaseTableRenameSync.test.js`「A1 schema 表名…」 |
| A2 | ✅ | 全仓改名（`server/src` 全部注释/错误文案、`server/public/workbench/features/purchase/index.js` 的**用户可见**文案）。用例「A2 旧表名不再出现在用户可见文案与代码里」逐文件扫描（历史沿革注释是唯一豁免，且豁免条件写死在用例里） |
| A3 | ✅ | 分流/读写仍全部按 `tableId`：`routes/larkEvents.js` 的 `purchaseIntake`、`v1BitableGateway.table()` 都没动；全量用例（1194 条）就是这条的证据 |
| B1 | ✅ | schema 里 `purchaseRequest.arrivalStatus` / `attachment` 两行**已删**（用例「B1/B3 字段映射同步」） |
| B2 | ✅ | 写入点/读取点全删：`writeSupplierImageAttachment` 重写（不再读写 `purchaseRequest.attachment`）、`purchaseQueryService` 的 `arrival_status` 改读**「报货批次」**、`routes/purchaseQuery.js` 的筛选仍透传但现在读的是批次上那一列。用例「B2 已删列全仓不再有写入/读取点」扫描 `src/**.js`（去注释后）确认没有任何 `attachment:` 写入/`fields.attachment` 读取 |
| B3 | ✅ | `purchaseOrderBatch.fields` 新增 `arrivalStatus: '到货状态'`、`document: '单据'`；**没有** `behavior`；`purchaseReport.fields.supplier = '供应商'`（只读投影）。同一条用例逐条断言 |
| B4 | ✅ | `scripts/validate_v1_schema.js` 新增 `validateSelectOptionContracts`（**只读** `appTableField.list` 的 `property.options`）：字段不是单选 / 缺选项 → 判红；字段不存在 → 交给 `validateTables`（不重复报）。用例「B4 闸门…」三种情形（绿 / 缺「已到货」 / 不是单选）+ 字段缺失时不在这里报错 |
| C1 | ✅ | `services/purchaseBatchNoGenerator.js` + `config/purchaseBatchNo.js`；用例「① 格式逐字：`CGD-20261007-0001`」（注入 `now` = 2026-10-07 上海） |
| C2 | ✅ | 号在**入口**按包生成一次（`PurchaseWebhookService.ensureReportBatchNo` + `context.packageRecordIds`，同包只做一次）。用例「① 一个 webhook 报货包 = 一个号」：3 条记录 → 一个号 |
| C3 | ✅ | 写回只写「空文本 **且** 未到终态」的记录（`writeReportBatchNo`）。用例「没有手填批次号：入口生成一个号并写回…」+ C7 的重投/重试用例 |
| C4 | ✅ | `confirmPurchaseRequest` 建「报货批次」时写的仍是同一个号；用例「没有手填批次号…」断言「信息填写」与「报货批次」是**同一个号** |
| C5 | ✅ | 用例「② 同天第 2 包 → 0002」「④ 补零：第 10 个 → 0010」「③ 跨天归零」 |
| C6 | ✅ | 用例「⑫ 旧号零改动、且不参与计数」（`202610071` / `202610072` / `BH-…` / 5 位序号都不匹配，今天下一个号仍是 0001） |
| C7 | ✅ | 用例「⑤ 重投不生成第二个号」「⑤ 重试不生成第二个号」「⑤ 同一条记录被并发两次投递抢到 → 复用先写进去的那个号（记 collision）」 |
| C8 | ✅ | `KeyedSerialQueue`（键 `purchase_report_batch_no`）+ 生成器内的"本进程已发集合"两道。用例「⑥ 并发不重号：两包几乎同时进来」 |
| C9 | ✅ | `purchase.batch_no.generated { batch_no, sequence, today_count, task_id, source, attempts, date_part }`（`task_id` 拿不到就不传；**没有** `batch_record_id`——入口这一刻还没有那条记录，**不编**）；撞号记 `purchase.batch_no.collision`（两处：生成器内、入口队列重读）；另有 `purchase.batch_no.written_back` / `write_back_failed` / `intake_failed` |
| C10 | ✅ | `config/purchaseBatchNo.js` 的 `recognizedPrefixes` 默认 `CGD-,BH-`；`buildBatchNoPattern` 用它建正则，`services/purchaseBatchNo.js` 的 `extractBatchNos` 每次按当前配置现建。而**群准入**（`larkMvpService.resolveMainChatAdmission` 第 833 行）与**定位**（`purchaseBatchLocator.resolve` 第 196 行）都只经 `extractBatchNos` ⇒ 两处自动跟着认 `CGD-`。用例「⑬」两条 + `purchaseBatchNo.test.js` 既有 BH- 用例（**一条没删**） |
| C11 | ✅ | 「认不出」的两句回复搬进 `config/groupPurchase.js`（`PURCHASE_GROUP_NO_BATCH_REPLY` / `PURCHASE_GROUP_AMBIGUOUS_BATCH_REPLY`），里面的「批次号是什么开头」由 `{prefixes}` 从**识别前缀**填（默认 `CGD / BH`）—— 不再写死 `BH-`。`GroupPurchaseFlowService` **在构造函数里解析**（不在模块加载时求值，避开 dotenv 顺序那个老事故）。用例「⑬「认不出」的回复文案不再写死 BH-…」+「⑬ 定位不到时回的那句话来自配置」 |
| D1 | ✅ | `confirmPurchaseRequest` 新建批次记录时写 `arrivalStatus: this.orderBatches.pendingStatus`（= 配置里的「未到货」）。用例「⑦ 新建「报货批次」记录时显式写「未到货」（值来自配置，不是中文字面量）」+「⑦ 值域来自配置：换一套字面量，写进去的就是那一套」 |
| D2 | ✅ | `PurchaseArrivalConversationService.confirmLocked` 在**入库落库之后**调 `notifyBatchArrived(task.batch_no)` → `PurchaseOrderBatchService.markArrived` → 按批次号定位那一行并写「已到货」。用例「⑧ 点「是」入库成功之后 → …改成「已到货」」 |
| D3 | ✅ | `notifyBatchArrived` **永不抛**（吞成 warn）；用例「⑧ 写「已到货」失败**不阻塞**：入库已经成功，任务照旧 posted」 |
| D4 | ✅ | 字面量只在 `config/purchaseArrivalStatus.js`（可配、写完/空串/两值相同都当场抛）；部署闸门对着真表 `property.options` 核对（B4）。service 里没有「未到货 / 已到货」这两个中文字面量（除注释） |
| E1 | ✅ | `PurchaseOrderBatchService.writeDocument`：按「报货批次号」定位那一行 → 同名图已在「单据」里就跳过 → 否则**已有附件原样带上**再追加。用例「图片写回：写到「报货批次.单据」，重复执行不新增第二条附件」「多个供应商：…（两张图都在同一行的「单据」里）」 |
| E2 | ✅ | 日志语义不变（`purchase.request.image.attachment_written` / `attachment_exists` / `attachment_write_failed`）+「失败不阻塞」（用例「先发图再写表：写附件失败时图仍然发出，任务仍然是 posted」，模拟点已改到 `purchaseOrderBatch.document`） |
| F1 | ✅ | `services/purchasePendingBatchService.js` 直接 `listAll('purchaseOrderBatch')` 过滤 `到货状态 = 未到货`。用例「F1 候选直接查「报货批次」：只有 到货状态 = 未到货 的进候选」 |
| F2 | ✅ | 供应商从**「信息填写」**同一批次的记录上取（去重、保序），取不到就那一段整段不出现。用例「F2 供应商从「信息填写」关联取…」 |
| F3 | ✅ | 本地映射（`data/purchase_group_messages` 的 `chat_id` + `thread_id`）→ `buildSalesThreadLink` → `LarkMessageLinkResolver`（与销售侧**同一个**解析器）。用例「F3 深链走本地映射…」+「F3 采购候选读表失败：不拖垮销售那半边」 |
| F4 | ✅ | 顺序 = `settings.areas`（默认 `sales,purchase`，可用 `PENDING_DEAL_PUSH_AREA_ORDER` 改，**漏写的不丢**）；空区返回空串 ⇒ 连标题都不出现；两区都空 → 早退不发。用例「F4 空区连标题都不出现…」「F4 只有销售候选时…」「F4 两区都空 → 不发」「F4 顺序可配」 |
| F5 | ✅ | 销售区 = `buildSalesArea`（原 `buildText` 的正文，**只多了一行"标题默认空串"**）；哨兵用例「⑪ 销售区逐字不变（哨兵）：同一批销售候选，加不加采购区，销售那半逐字节相同」+ 既有 `pendingDealPush*.test.js` 全绿 |
| F6 | ✅ | 采购区的标题/行格式/分隔符/供应商连接符/脚注**全部进 `config/pendingDealPush.js`**（`PENDING_DEAL_PUSH_PURCHASE_*`）；service 里没有用户可见中文。用例「D1 大区/采购区的标题、行格式、分隔符、脚注都可配；写错在**解析配置时**就抛」 |
| G1 | ✅ | 前缀/日期格式/位数/时区/识别前缀 → `config/purchaseBatchNo.js`（`PURCHASE_BATCH_NO_*`）；到货状态两个字面量 → `config/purchaseArrivalStatus.js`；大区/采购区文案 → `config/pendingDealPush.js`；「认不出」的两句回复 → `config/groupPurchase.js`（`PURCHASE_GROUP_NO_BATCH_REPLY` / `_AMBIGUOUS_BATCH_REPLY`）。逻辑里没有 `CGD-` 字面量、没有用户可见中文。用例「③/④/② 配置先行：前缀 / 日期格式 / 位数 / 时区 / 识别前缀都是配置」 |
| G2 | ✅ | `.env.example` 加了三段注释版配置（采购区 / 报货批次号 / 到货状态）＋ 两句「认不出」的回复文案 |
| H1 | ✅ | 独立 worktree `.local/worktrees/purchase-batch-no` 里 `node --test --test-concurrency=1` **连跑 2 次**：`tests 1194 / pass 1194 / fail 0`（两次相同） |
| H2 | （见第 6 节：CI 结果） | `gh pr checks` 三项；**没有**用 `--admin` |
| H3 | ✅ | 见第 6 节「改动过的既有断言」逐条说明 |
| H4 | ✅ | 没有部署、没有写任何生产表、没有改线上 `.env`；本文件里的所有真实远端调用都是**只读**（`scripts/list-v1-fields.js` 打的字段元数据） |

### 4.1 先红后绿（证据）

新建的 4 个用例文件先在**改动前**的代码上跑（`git worktree add --detach .local/worktrees/red-baseline origin/main`，
把 4 个用例文件拷过去跑）—— **4/4 失败**，失败原因就是"这套契约在旧代码里不存在"：

```
ℹ tests 4
ℹ pass 0
ℹ fail 4
Error: Cannot find module '../src/services/purchasePendingBatchService'
Error: Cannot find module '../src/services/purchaseOrderBatchService'
Error: Cannot find module '../src/services/purchaseBatchNoGenerator'
Error: Cannot find module '../src/config/purchaseArrivalStatus'
```

（那个临时 worktree 已按纪律清掉，不留残留。）

改完之后在**本分支**上同样这 4 个文件：**4/4 通过**（`tests 1194 / pass 1194 / fail 0` 的全量两次里包含它们）。

## 5. 我没做到 / 拿不到证据的地方（如实说）

### 5.1 ⚠️ 「报货批次.单据」的字段**类型**我核不了（本机没有生产凭证）

- 我要核的是：生产真表「报货批次」的「单据」到底是不是 **Attachment（type 17）**；
  以及「到货状态」的**逐字选项**是不是「未到货 / 已到货」。
- **核不了的原因**：按 AGENTS.md 第 8 条，本机 `.env` 只有**测试 Base**；而**测试 Base 落后于生产**
  —— 我只读核过（`node server/scripts/list-v1-fields.js purchaseOrderBatch`）：
  测试「报货批次」仍是**旧的 4 列**（报货批次号 / 创建时间 / 幂等键 / 更新时间），
  **没有**「到货状态」「单据」「采购行为」；测试「具体信息」里那两列（到货状态 / 采购申请单）**还在**。
- ⇒ **代码按"是附件"实现**（这是她的口径能唯一推出的一种），并由**部署闸门**在服务器上核对选项；
  但「单据」的类型**必须由能读生产的人再确认一次**（`node server/scripts/list-v1-fields.js purchaseOrderBatch`）。
  **若不是附件 → 停下报告，不要改成别的写法**。

### 5.2 ⚠️ 退货单的附件**现在没有落点**（需要她拍板）

- 她要求「把这些信息挪到'报货批次'里面」，采购申请那一半照做到了；
  但**退货批次不建「报货批次」行**——这是**既有边界**，`purchaseReturn.test.js` 里
  「退货不建报货批次（第 5 张表）」那条断言一直钉着它（本次**没有**放宽/删掉它）。
- ⇒ 退货单的 PNG 现在**写不进去**：附件那一步记一条 `purchase.batch.document.no_record` 的 warn，
  图照常发到群里。⚠️ **这不是本次改动引入的回归**：她已把「具体信息.采购申请单」那一列删掉，
  退货单在生产上**本来也写不进去**（会 FieldNameNotFound）。
- **要真正回填，得先定一件事**：退货批次要不要也在「报货批次」里有一行？
  - 若**要**：建议那一行只写「报货批次号 + 幂等键」，**「到货状态」留空**（退货没有"到不到货"这回事；
    写「未到货」会把它混进 9 点推送的【采购】区），「采购行为」仍是她的（代码不碰）。
  - 若**不要**：那就维持现状（图只在群里，不回填），我把那三处断言里的注释改成"长期如此"。

### 5.3 ⚠️ 本机 `v1:schema-check` 会红（测试 Base 落后于生产），必须在服务器上跑

- 加了「到货状态」「单据」两个映射之后，**在本机跑** `pnpm run v1:schema-check:purchase`
  会报「「报货批次」缺少 V1 字段: 到货状态、单据」——**这是预期的**：测试 Base 还没有这两列。
- ⇒ 部署前**必须在服务器上**跑 `pnpm run v1:schema-check:all`（那才对着生产）。
  ⚠️ 我**没有**改测试 Base 的字段（怕把测试 Base 改成和生产不一致的形状，也怕写坏她对齐好的测试环境）。

### 5.4 ⚠️ 历史批次行的「到货状态」是空的（不会进 9 点推送）

- 新建的批次行会写「未到货」；但**这次部署之前**已经存在的批次行**一个字都没动**
  （她的口径是"历史记录零改动"），所以它们的「到货状态」是**空**的
  ⇒ **9 点推送不会列出它们**（推送只认字面量「未到货」，**不猜**"空 = 未到货"）。
- 影响面有限（历史批次基本都到货/结清了）。要不要把历史行补成「未到货」，**请她定**——
  那是往生产表写数据，我不会自己动手。

### 5.5 ⚠️ 没有真启动一次服务（只跑了单测）

- 本次**没有改 `app.js`**，也没有改任何 require 顺序，所以 AGENTS.md 第 5 条那条"必须真启动"的
  触发条件不成立。⚠️ 但我**也没有**真启动验证：本机 `.env` 会让它连上测试应用、并起定时器
  （「第二次交付提醒」等），这一轮我不想在她的群里触发任何东西。⇒ 部署闸门 + 服务器上的
  `v1:schema-check:all` 仍然是唯一那一道真闸门。

### 5.6 「附件追加而不是覆盖」这个假设

- 一批**多供应商**时，两张图都挂在**同一行**的「单据」里：代码把**已有附件原样带上**再追加新的那张
  （只传新 token 会冲掉别人的图）。⚠️ 这条依赖飞书"附件字段写入时，传入已有 file_token 会保留它"的
  行为，我**没有**在真表上验证过（本机不能写生产；测试 Base 没有这一列）。
  ⇒ 部署后**第一批多供应商的报单**要看一眼「单据」里是不是两张图都在（日志
  `purchase.request.image.attachment_written` 的 `document_count` 会给出结论）。

## 6. 测试与 CI 证据

### 6.1 本地全量（独立 worktree `.local/worktrees/purchase-batch-no`，**不在主工作区跑**）

`node --test --test-concurrency=1`，**连跑 2 次**：

```
=== run 1 ===
ℹ tests 1196
ℹ pass 1196
ℹ fail 0
=== run 2 ===
ℹ tests 1196
ℹ pass 1196
ℹ fail 0
```

（改动前的基线是 `tests 1154 / pass 1154`；本次新增 42 条用例。）

### 6.2 CI（PR #238）

`gh pr checks 238` 三项全绿，`gh pr view 238 --json mergeStateStatus` = **CLEAN**：

| 检查 | 结果 | 耗时 |
|---|---|---|
| `test`（server tests） | ✅ pass | 59s |
| `Analyze (javascript-typescript)`（CodeQL） | ✅ pass | 1m16s |
| `CodeQL` | ✅ pass | 3s |

**没有**用 `--admin`；**没有合并**（合并由父代理做）。

### 6.3 改动过的既有断言（逐条说明"为什么不是放宽"）

| 用例 | 改动 | 为什么不是放宽 |
|---|---|---|
| `purchaseWebhookService.test.js`「多尺码一次报单…」 | `startsWith('BH-')` → `assert.match(/^CGD-\d{8}-\d{4}$/)` | 口径变更（她定的新格式）。断言**收严**：从"前缀对"变成"整条格式逐字对" |
| 同文件「图片写回：取「明细ID」最小的那条…」 | 改名 + 落点从「具体信息.采购申请单」改为**「报货批次.单据」**（`documentTokens`） | 目标列已被她从生产表删除；"只写一条 / 重跑不新增 / 不重复上传"三条**一条没删**，还多了"多供应商两张图都在同一行"的新断言 |
| 同文件「先发图再写表：写附件失败…」 | 失败模拟点从 `purchaseRequest.attachment` 改到 `purchaseOrderBatch.document`；末句断言改成「单据里 0 个 token」 | 同上：判据（图照发、任务仍 posted）不变，只是换了那一列的落点 |
| 同文件「没有手填批次号 → 单条处理」 | **口径变更**：改成「入口生成一个号并写回」（新断言更强：写回的那一列、与「报货批次」同一个号、格式合法）；另加一条"入口读不到记录 → 退回单条"的兜底用例 | 她拍板"不再手填"之后，"没有批次号 → 单条"这条路径**只能**由"入口写回失败"到达（生产同形）。旧断言钉的行为被**新断言取代**（不是删掉）：新断言多出"写回 + 同一个号"两条 |
| 同文件假 gateway | `uploadAttachment` 记 `token → 文件名`；`update` 给「单据」补 `name` | **更忠实于飞书**（附件单元格读回来带 `name`）。不加它"重复执行不新增第二条"在假 Base 上永远命中不了去重判据 = 测不到东西 |
| `purchaseReturn.test.js`「A 情况对得上…」 | 断言从"单据信息里有 1 条附件"改成"**退货没有报货批次行 ⇒ 附件没有落点，连素材都不上传**" | 口径变更 + 既有边界（同一文件里「退货不建报货批次（第 5 张表）」那条**一个字没动**）。如实记下缺口（5.2），不是放宽 |
| `purchaseReturn.test.js`「货品没维护供应商…」 | `gw.uploads[0]` 的断言 → `uploads === []` | 同上：退货没有落点 ⇒ 不白传素材。图照发/群消息照发的断言全在 |
| `purchaseReturn.test.js`「⚠️ 2026-10-07：报货批次号不再手填」夹具 | `rep_nosup` 夹具补上 `报货批次号` | 这个用例**直接调 `process()`**（绕过 `accept`），而生产上号由入口写回 ⇒ 夹具要给上与生产同形的形状（不是放宽任何断言） |
| `purchaseLogCorrelation.test.js` ① | ① 用例改成"入口写回失败 → 退回单条路径"（加一个只拦「报货批次号」写入的桩）；`BH-…0001` → `CGD-\d{8}-\d{4}`；附件行改成 `purchaseOrderBatch` | 口径变更。不变式（`task_id + batch_no` 一把 grep 串起来）**全在**；为了还能测到"单条路径"，造法跟着换成真实场景 |
| `purchaseLogCorrelation.test.js` ④ | 标题与造法改成"入口写回失败"（并新增两条正向证据断言：确实走了那条路、那一列确实还是空的） | 「拿不到就不传、不许编」这个不变式**一字未改**；旧造法（空夹具）在新口径下已经不可达 ⇒ 换成可达的造法 + 更强的前置断言 |
| `pendingDealPush.test.js` 配置默认值 | `deepEqual` 里补上新增的 7 个默认值键 | 全等断言**更严格**（多一个键就红），不是放宽 |
| `purchaseQueryService.test.js` | 夹具把「到货状态」从 `purchaseRequest` 挪到 `purchaseOrderBatch` | 口径变更（那一列已从「具体信息」删除）。断言口径不变：行上显示的仍是这一批的到货状态 |
| `validateV1Schema.test.js` | **一个字没改**（新增的取值契约在字段不存在时直接跳过） | 既有断言原样通过 |

## 7. 关键 diff / 取数结论（汇报用）

| 块 | 关键落点 |
|---|---|
| 表改名 | `config/v1BitableSchema.js`（两个 `tableName`）+ 全仓文案（含工作台 `features/purchase/index.js`） |
| schema 字段 | 删：`purchaseRequest.arrivalStatus` / `.attachment`（+ 三个写入/读取点）；加：`purchaseOrderBatch.arrivalStatus` / `.document`、`purchaseReport.supplier` |
| 批次号 | 新增 `config/purchaseBatchNo.js` + `services/purchaseBatchNoGenerator.js`；`PurchaseWebhookService.ensureIntakeBatchNo/ensureReportBatchNo/writeReportBatchNo`（入口按包写回）；`nextBatchNo()` 改成生成的兜底 |
| 归批怎么解决 | **方案 A**：`acceptMany` 把整包 `ids` 放进 `context.packageRecordIds` → `accept` 第一次调用 `ensureReportBatchNo`（一包只做一次）→ 先读这一包已有非空号（有则复用）→ 否则进 `KeyedSerialQueue` **重读**再算号并写回**空文本且未到终态**的记录。归批链路（`readReportBatchNo → handleReportBatch → runReportBatch`）**一行没改**。幂等证据：用例「⑤ 重投」「⑤ 重试」「⑤ 并发抢同一条（复用先写进去的那个号）」 |
| 到货状态 | 新增 `config/purchaseArrivalStatus.js` + `services/purchaseOrderBatchService.js`；建记录时写 `pendingStatus`；`PurchaseArrivalConversationService.notifyBatchArrived`（永不抛）+ `larkMvpService` 接线；闸门新增取值契约校验 |
| 附件 | `writeSupplierImageAttachment` 重写（先 `findDocument` 判"有没有落点/有没有同名图"→ 再上传 → `writeDocument` 追加）；`purchaseOrderBatchService.attachmentTokens/attachmentNames` 是唯一实现 |
| 推送 | `config/pendingDealPush.js`（`areas` / `salesAreaTitle` / `purchaseAreaTitle` / `purchaseLineParts` / `purchaseLineSeparator` / `purchaseSupplierSeparator` / `purchaseFooterTemplate`）；`pendingDealPushService.buildSalesArea/buildPurchaseArea/buildText/attachPurchaseLinks`；新增 `services/purchasePendingBatchService.js` |
| 供应商从哪取 | 「信息填写」（`purchaseReport`）里**同一批次号**的记录上的「供应商」列（真表里是 Lookup）→ 去重保序 → 渲染时才拼 |
| 深链 | 本地映射 `data/purchase_group_messages/`（`PurchaseBatchLocator.listGroupMessages()` 整目录读一次）→ 挑第一个 `chat_id` + `thread_id` 都全的记录 → `buildSalesThreadLink`（与销售侧同一个 `config/salesThreadLink`）→ `LarkMessageLinkResolver`（与销售侧同一个解析器；还会兜底现查 `message_app_link`） |
| 配置项 | `PURCHASE_BATCH_NO_PREFIX` / `_DATE_FORMAT` / `_DIGITS` / `_TIMEZONE` / `_PREFIXES`；`PURCHASE_ARRIVAL_STATUS_PENDING` / `_ARRIVED`；`PENDING_DEAL_PUSH_AREA_ORDER` / `_SALES_TITLE` / `_PURCHASE_TITLE` / `_PURCHASE_LINE_PARTS` / `_PURCHASE_LINE_SEPARATOR` / `_PURCHASE_SUPPLIER_SEPARATOR` / `_PURCHASE_FOOTER_TEMPLATE` |
