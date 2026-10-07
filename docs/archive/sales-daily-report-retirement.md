# Sales Daily Report Retirement（销售战报退役 · 2026-10-07）

## 1. 退役时间

2026-10-07。业务负责人当天逐字：

> 「① **砍掉销售战报**（每天 8 个时段那套）· 开关我已经关了；**连代码一起删**」

## 2. 原用途

每个交易日北京时间 **9 / 12 / 15 / 18 / 21 点 ＋ 22 点（当日收官）**，往群里推一张**消息卡片**：

- **销售单数** = 「销售明细」里「履约状态」命中配置取值的**条数**；
- **销售金额** = 「收款明细」里「已收款」、**收款时间是当天、截至推送那一刻**的金额合计。

发到群的**主聊天**（`create`，不进话题）；同一天同一时段**只推一次**（按时段认领）；
**过掉的时段不补推**（12 点的数字不能在 13 点当成当时的快照发出去）。

## 3. 退役原因

1. 业务负责人 2026-10-07 决定砍掉这条推送（线上开关 `SALES_DAILY_REPORT_PUSH_ENABLED` 已置 `false`
   并重启，日志 `sales.daily_report.disabled`）。
2. 她拍板的方式是「**连代码一起删**」——**不留开关、不留「冻结」状态**
   （与 2026-10-01 微信小程序退役、2026-10-07 私聊链路移除是同一种做法）。
3. 继续留着只会增加维护成本与 Agent Context 噪声 —— 文档与变量清单里到处是
   「可通过开关停用」的说法，会误导后续判断。

## 4. 本次删除的内容

**调度接线（`server/src/app.js`）**

- 两行 require：`./services/salesDailyReportService`、`./config/salesDailyReportPush`
- `resolveSalesDailyReportPushConfig()` 起的整段 `if (enabled) { … } else { … }`，
  含两个启动日志事件 `sales.daily_report.enabled` / `sales.daily_report.disabled`
  （`sales.daily_report.started` 由共享轮询器按 `eventPrefix` 打，随接线一起消失）
- ⚠️ **保留**：`startShanghaiDailyScheduler` 这一行 require，与**待处理单推送**
  （`pendingDealPush`）的整段接线 —— 两条链路**共用同一个轮询器**

**整文件删除**

| 文件 | 说明 |
| ---- | ---- |
| `server/src/config/salesDailyReportPush.js` | 时间点 / 群列表 / 开关 / 两个筛选值的配置 |
| `server/src/services/salesDailyReportService.js` | 取数 + 发卡片 + 按时段认领 + 「过期时段不补推」 |
| `server/src/utils/salesDailyReportCard.js` | 战报卡片纯渲染（`cardTextPlain` / `slotLabel` 也是它专用的，无别处引用） |

**测试**

- 删除 `server/test/salesDailyReportPush.test.js`（战报专属，497 行）
- `server/test/cardUpdateMulti.test.js`：反向断言里追加的 `salesDailyReportCard` 条目随卡片一起删，
  **其余断言逐字不动**（含 `UNPATCHABLE_CARD_SCENARIOS.length === 3`）
- 新增 `server/test/shanghaiDailyScheduler.test.js`：把**共用轮询器**的多整点用例从被删文件里**搬出来**
  （那几条盯的是共享件，不是战报语义 —— 不能让共享件的覆盖随着删文件一起归零）

**环境变量**（从 `.env.example` 移除；代码中已无任何读取点）

`SALES_DAILY_REPORT_PUSH_ENABLED` · `SALES_DAILY_REPORT_PUSH_CHAT_IDS` ·
`SALES_DAILY_REPORT_PUSH_HOURS` · `SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR` ·
`SALES_DAILY_REPORT_PUSH_INTERVAL_MS` · `SALES_DAILY_REPORT_FULFILLED_STATUSES` ·
`SALES_DAILY_REPORT_PAYMENT_STATUS`

⚠️ 线上 `.env` 里那个开关**一个字都没动**（本机 `.env` 同样没动）。
退役后这些变量**没有任何读取点** —— 恢复这条推送 = **重新实现**，不是翻一个开关。

## 5. 保留的共用件（**没有跟着删**）

| 共用件 | 谁还在用 |
| ------ | -------- |
| `server/src/utils/shanghaiDailyScheduler.js` | **待处理单推送**（`pendingDealPush`，单整点模式）；「第二次交付」另有自己的同款轮询器（`secondDeliveryReminder`） |
| `server/src/config/envValue.js` | `pendingDealPush` / `salesProcessingCard` / `productInfoGaps` / `salesColorChoice` / `salesProductRegistration` / `privateChatNotice` |
| `server/src/utils/larkCards.js` | 其余全部卡片 |

⭐ 本次只删了注释里对已删模块的引用（`envValue` / `productInfoGaps` / `salesProcessingCard` / `larkCards`），
**这些文件的行为与导出一行都没变**。

## 6. 历史源码

旧源码不再保留在仓库工作树中，可通过 Git History 获取（退役前最后一个包含战报的提交是 `2ba75aa`）。

本目录**不复制**旧源码。

## 7. 当前替代入口

| 入口 | 承担的工作 |
| ---- | ---------- |
| 待处理单推送（`pendingDealPush`，每天 9 点，`PENDING_DEAL_PUSH_ENABLED`） | 未付 / 预付未成交订单的每日提醒 |
| 飞书网页工作台（`GET /workbench`、`/api/workbench/sales/*`） | 销售查询：今天的销售、订单列表、补记收款、交付 |

## 8. 不要做的事

- 不要重建 `salesDailyReportService` / `salesDailyReportCard` / `config/salesDailyReportPush`。
- 不要把 `SALES_DAILY_REPORT_*` 加回来：代码里已经没有任何读取点。
- 不要为了「以后可能要」留一个开关 —— 恢复这条推送是**重新实现那条链路**，不是翻一个开关。

## 9. 验收标准（先写「删完之后应该是什么样」）＋ 逐条对照

| # | 验收标准 | 怎么验 | 结论 |
| - | -------- | ------ | ---- |
| A1 | `app.js` 里战报接线归零（require / `resolveSalesDailyReportPushConfig` / `sales.daily_report.*` 全无），**待处理单推送那条接线逐字保留** | `grep` ＋ `git diff` | ✅ 达标：`git diff server/src/app.js` 只有 **-25 行**，全部是战报的 require（3 行）＋ `if/else` 那一段（22 行）；`pendingDealPush` 的 require 与 `startShanghaiDailyScheduler` 整段**一个字节没动** |
| A2 | `config/salesDailyReportPush.js`、`services/salesDailyReportService.js`、`utils/salesDailyReportCard.js` **三个文件都不存在** | `ls` / `git status` | ✅ 达标：`git status` 三个 `D`（共 -582 行） |
| A3 | `SALES_DAILY_REPORT_*` 在 `.env.example` 与全仓代码里 **0 命中**（无读取点） | `grep` | ✅ 达标：`.env.example` 删掉 31 行（含注释）；除 docs/AGENTS 的「已退役」说明外，全仓无读取点 |
| A4 | 战报专属测试文件删除；`cardUpdateMulti.test.js` **只少**了引用已删卡片的那一条，其余断言（`length === 3` / 14 张卡 / golden 17 张）**逐字不变** | `git diff` | ✅ 达标：删掉 497 行 / 27 条用例；`cardUpdateMulti` 删掉 1 个 import ＋ 数组里追加的那 1 项，`length === 3` 与其余断言逐字不变（该文件用例数 8 → 8） |
| A5 | 共享轮询器的**多整点回归覆盖没有归零** | 新增 `server/test/shanghaiDailyScheduler.test.js` | ✅ 达标：把被删文件里那条**多整点**用例原样搬出（断言字面与判定强度逐字相同），新增文件 1 条 |
| A6 | `shanghaiDailyScheduler.js` / `envValue.js` / `larkCards.js` 的**行为与导出逐字不变**（只删注释里对已删模块的引用）；`pendingDealPush*` / `secondDelivery*` **一行不改** | `git diff` | ✅ 达标：`git diff -U0` 过滤后，这 4 个文件**没有一行非注释改动**；`pendingDealPush*` / `secondDelivery*` / `shanghaiDailyScheduler.js` **不在改动清单里** |
| A7 | `.env`（本机与线上）**未修改** | 无写操作 / `git status` | ✅ 达标：全程**没有写** `.env`（只在 worktree 里临时 `ln -s` 进来跑测试，收尾已删）；线上更是没碰 |
| A8 | `AGENTS.md`：战报相关描述删除或标「已退役」；「已删除变量」清单加入 `SALES_DAILY_REPORT_*` | `grep` | ⚠️ 达标（有一处要说明）：`AGENTS.md` **原本就没有**战报的描述句（动手前 grep 过：`战报` / `daily_report` / `SALES_DAILY` 在 AGENTS.md 里 0 命中），所以只**新增**了「已删除变量」那段（+10 行，7 个变量 + `utils/shanghaiDailyScheduler` 仍是共用件的说明） |
| A9 | 按本仓既有模式留退役足迹（照 `docs/archive/legacy-wechat-retirement.md`）；两份战报专属文档标「已退役」；`docs/README.md` 索引同步 | 读文件 | ✅ 达标：新增 `docs/archive/sales-daily-report-retirement.md`（同款 1–8 节结构）；两份专属文档加「⚠️ 已退役（2026-10-07）」抬头；`docs/README.md` §4 历史文档加 3 行；顺带修正 `module-split-and-main-flow`（(c) 划掉）与两处指向已删模块的现行性描述（`card-update-multi` / `sales-confirm-processing-card-visible`） |
| A10 | `grep -rn "daily_report\|SALES_DAILY_REPORT\|salesDailyReport" server/` = **0 命中** | 实测 | ✅ 达标：`grep -rn ... server/` 退出码 1（0 命中） |
| A11 | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** | 实测 | ✅ 达标：**第 1 次 1039/1039 pass、fail 0；第 2 次 1039/1039 pass、fail 0**（改动前基线 1065/1065；差值 **−26** = 删 27 条战报用例 ＋ 搬回 1 条共享轮询器用例，账对得上） |
| A12 | PR CI 三项 CLEAN（`gh pr checks`），未用 `--admin`，**未合并、未部署** | `gh pr checks` | ✅ 达标：PR **#228** 的 `gh pr checks` 三项全 `pass` —— `Analyze (javascript-typescript)` / `CodeQL` / `test`，`mergeStateStatus = CLEAN`；**没有用 `--admin`**，PR **未合并**、**未部署** |

