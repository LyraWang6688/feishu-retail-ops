# 埋点体检表 · 2026-10-15（task-48）

> 业务负责人 2026-10-15 深夜：「**我认可你说的埋点**」—— 她关心的原话是「**方便我们的排查**」✓
> 本表 = 现有埋点**逐条体检**（现状 `文件:行` ＋ 缺口 ＋ **本次是否实施 / 为什么**），
> 实施部分**只新增埋点/日志**：**不改任何业务语义、不放宽任何判据** ✗

## 0. 一页结论

| # | 方向 | 现状 | 缺口 | 本次 |
|---|---|---|---|---|
| **a** | 前端流畅性（点击→结果耗时） | ✅ `ui.tap.result` 已带 **状态 + 原因码 + 耗时**（`src/utils/uiTapReport.js:51-64`）| 骨架停留时长 ✗ · 卡片跳变次数 ✗ | ⭐ **已实施**（`fluency:skeleton` / `fluency:card_swap`）|
| **b** | 一次点击 → 一次写入 | ✅ 点击带 `tap_id`（`src/config/uiTap.js` 的 `fields.tapId`；客户端 `core/api-client.js:53` 随体回去）| **写库日志里没有 `tap_id`** ✗（不在关联键白名单里）| ⭐ **白名单已加 `tap_id`** ＋ 取用口 `tapIdFromRequest(req)`；**剩下 1 行/调用点的接线在写路径（不在本任务写作用域）⇒ 见 §2 待办** |
| **c** | 前端 404 / JS 报错统一入口 | ❌ 无（今晚是"爬资源"才发现的 ✗）| 全部 | ⭐ **已实施**（`fluency:error`：`window.onerror` + `unhandledrejection` + fetch 404/5xx）|
| **d** | "看着像坏了"的动作 | ⚠️ 只有 `ui.tap`（"她点了"），没有"页面给了什么" | realm 进入 / 表单展开 | ⭐ **已实施**（`fluency:realm` / `fluency:form`）|
| **e** | 日志轮转与保留 | ⚠️ `server/ecosystem.config.js` **没有任何 log 配置** ⇒ PM2 默认日志、**无轮转** ✗；仓库里也没有 logrotate 配置 | 现状 + 建议天数 | ⭐ **已给建议**（§4；**只报不改线上** ✓）|

## 1. 现有埋点清单（体检 · 逐条给 `文件:行`）

| 事件 | 打在哪 | 带什么 | 现状评价 |
|---|---|---|---|
| `ui.tap` | `src/utils/uiTapReport.js:97` | `target` / `tap_id` / `page` /（有上一次时）`since_ms` | ✅ 好：**只记我们的标识**、不含表单值 ✓ |
| `ui.tap.repeated` | 同上（窗口判在**服务端** `:23-30`）| 同上 | ✅ 判据在服务端（客户端不可信）✓ |
| `ui.tap.result` | 同上（`uiTapResultMiddleware`）| **HTTP 状态 + 原因码 + 耗时** | ✅ 这就是"点击→出结果耗时"的**已有一半** ✓ |
| `scan.*` 计时 | `services/scanPageService.js` 的 `logTiming` | `total_ms` / `render_ms` / `sizes` | ✅ 扫码页那半已有 ✓ |
| `bitable.record.created/updated` | `services/v1BitableGateway.js` | `table_key` / `record_id` ＋（白名单）关联键 | ✅ 写库那半的**主日志** ✓ |
| `inventory.change.applied` / `.failed` | 库存引擎 | 库存键 | ✅ |
| `v1.sale.posted` | 销售落库 | `detail_count` / `payment_count` ＋关联键 | ✅ |
| `*.failed`（各链路）| 各 service | 人话原因码 | ✅ |
| 前端 404 / JS 报错 | —— | —— | ❌ **以前一条都没有** ⇒ 本次补 ✓ |

## 2. 本次实施（只新增，不改业务语义 ✗）

| 新增 | 文件 | 怎么判 |
|---|---|---|
| `fluency:skeleton`（骨架停留 ms ＋ `level:slow` 打标）| `public/workbench/shared/ui-fluency.js` | `test/uiFluencyTelemetry.test.js` AC-LOG1（**能真红**：删掉上报 ⇒ 红）|
| `fluency:card_swap`（卡片整块跳变次数）| 同上 | 同上 |
| `fluency:realm` / `fluency:form`（她点进去看到了什么）| 同上 | 同上 |
| `fluency:error`（404 / JS 报错**统一入口**）| 同上 ＋ `installFluencyObservers` | AC-LOG1 ＋ AC-LOG2 |
| 阈值 / 命名空间 / 白名单 | `public/workbench/config/telemetry.js`（`FLUENCY_TELEMETRY`）| AC-LOG5（换值不用改代码 ✓）|
| **`tap_id` 进关联键白名单**（b 的贯穿）| `src/utils/correlationFields.js` | AC-LOG4（**不新造键名** ✓）|
| `tapIdFromRequest(req)`（写路径的取用口）| 同上 | AC-LOG1b（body/query 取到；**取不到不编** ✗）|

**隐私红线（AC-LOG2）**：新埋点**只**允许白名单里的键（`FLUENCY_ALLOWED_KEYS`）；
`path` 只留 `origin + pathname`、**query 一律丢掉** ✗；**不读表单值 / localStorage / 提交体**（源码哨兵钉住 ✓）。

### 2.1 🔴 缺口（**没实施，写明为什么** · AC-LOG5）

| 缺口 | 为什么没做 | 建议 |
|---|---|---|
| **写库日志真正带上 `tap_id`**（"一次点击 → 一次写入"的最后一跳）| 需要写路径把 `tapIdFromRequest(req)` 合进 `options.correlation`（`routes/workbench*.js` / 各 write service）——**这些文件不在本任务写作用域**（任务书写的是 utils + public + test + docs）⇒ 我**没有碰** ✗ | ⭐ 我这边**已经把它变成 1 行**：`gateway.update(..., { correlation: mergeCorrelation({...}, tapIdFromRequest(req)) })`。**要你点头**我再开一刀（预计 ≤ 5 处调用点）|
| **四个新事实各用一个"独立事件名"**（现在是 `target` 命名空间 `fluency:`）| 独立事件名要改 `src/config/uiTap.js` 的 `EVENTS` ＋ 上报路由的白名单（**不在写作用域** ✗）| 现在这版**服务端一行都不用改**、数据照样能 grep（`grep '"target":"fluency:error"'`）⇒ 够用；要独立事件名随时可加 ✓ |
| **前端"卡片跳变"的自动探测**（自动判断哪次渲染是"整块替换"）| 自动探测需要接管各 feature 的渲染时机（`public/workbench/features/**` 多处），**容易变成"改业务代码"** ✗ | 现在是**显式调用**（`cardSwapped()`，谁真发生跳变谁调）—— 更可控；要不要自动探测**等你定** ✓ |

## 3. 怎么用（她/我们排查时的三条 grep）

```bash
# ① 她点了什么、点成了没有（同一 tap_id 串起来）
grep '"event":"ui.tap"'            # 她点了哪些
grep '"event":"ui.tap.result"'     # 结果 + 耗时 + 原因码
# ② "看着像坏了" / 卡住
grep '"target":"fluency:skeleton"' # 骨架停留多久（level:slow = 超过 1s）
grep '"target":"fluency:error"'    # 前端 404 / JS 报错（带 path，不带 query ✓）
# ③ 写库那半（同一个 tap_id / order_no）
grep '"order_no":"XSD-2026…"' app.log
```

## 4. 日志轮转与保留（e · **只报不改线上** ✗）

**现状（只读核的）**：
- `server/ecosystem.config.js`：`grep -n "log\|out_file\|error_file\|max_size\|retain"` ⇒ **一条都没有** ⇒
  PM2 走**默认**（`~/.pm2/logs/*-out.log` / `*-error.log`，**不轮转、不封顶**）✗
- 仓库内**没有任何 logrotate 配置**（`find -name "*logrotate*"` 空）；线上 `/etc/logrotate.d/` 这次**没看**（不在本机）⇒ 如实说：**线下看不到，需要在服务器上核一眼** ✓
- Nginx 那边同理（`server/ops/nginx/**` 只是反代/allowlist 片段，没有日志切割）

**建议（要她在服务器上定，我不动）**：
| 项 | 建议值 | 理由 |
|---|---|---|
| 单文件上限 | **10 MB** | 一台小机器，别把盘写满 |
| 保留份数 / 天数 | **14 天**（或 30 份）| 她的排查窗口 = 当天/前一天；14 天足够回溯"上周那单怎么写的"|
| 做法（二选一）| ⓐ `pm2 install pm2-logrotate` ＋ `pm2 set pm2-logrotate:max_size 10M` / `:retain 14` / `:compress true`；ⓑ 在 `server/ecosystem.config.js` 的 `apps[0]` 加 `max_size: '10M'` + `retain: 14` | ⓐ 不动仓库代码；ⓑ 走配置（但会改部署文件 —— **部署是她的地盘** ⇒ 我只提，不动 ✗）|
| Nginx | 在 `server/ops/nginx/**` 那份 server 段加 `access_log` 轮转（交给系统 logrotate）| 反代日志量不大，但要防止长年累积 |
| ⚠️ 本地任务记录 | `server/data/lark_mvp_tasks/*.json` / `scan_sessions/*.json` **也会长**（幂等与"重启补跑"要看）| 建议**至少 30 天**、且**清之前先确认没有未完成任务**（清错会丢补跑线索 ✗）|

## 5. 判据与证据

- 新增用例 `server/test/uiFluencyTelemetry.test.js`（5 条）：**每条都能真红**（删掉对应上报/放开白名单/换掉键名 ⇒ 红）✓
- **业务判据 0 行放宽**：本刀**只新增**（`logger.js` 未改；`correlationFields.js` 只**加**了一个键与一个取用口）✓
- 两遍全量 EXIT=0 ×2（数字见 PR）· CI 四件全绿 ✓
- 🔴 未部署 · 生产 Base 只读 · **没改线上日志配置** ✓
