# 陈旧 worktree / 孤儿分支 · 逐个判定（2026-10-16 · **只读**）

> 起因：`.local/` 下压着 ~27 个 worktree（AGENTS 第 14 条「工作流只加不减」的后果 ✗）。
> 本文件**逐个判定**：哪些"没东西可丢"· 哪些"有未提交/有独立提交，必须先看"· 哪些"内容已在 main、只是目录在" ✓
> 🔴 **本文只出表**：**我没有删/改/merge/push 任何东西** ✗（今晚出过"并发删掉执行者 worktree"的事故 ✗ ⇒ 由 Lead 拿去核后统一清 ✓）
> ⚠️ **判定口径**：`git merge-base --is-ancestor HEAD origin/main` 对 **squash 合并**会判"不在 main" ✗
> ⇒ 这类以 **PR state = MERGED** 为准 ✓；两者都判不出的 ⇒ **如实标"判不出"** ✗ 不猜 ✓

采集命令（只读 ✓）：`git worktree list --porcelain` · 每个目录 `status --porcelain` ·
`log --oneline origin/main..HEAD` · `git ls-remote --heads origin` · `gh pr list --state all`

## 1. 判定表

| ① 目录 | ② 分支 | ③ 未提交 | ④ 独立提交 | ⑤ 内容在 main？ | ⑥ 远端 | ⑦ 它当初是干什么的（从分支名 + 提交信息看） | ⑧ 结论 |
|---|---|---|---|---|---|---|---|
| **（根工作区）** | `main` | 0 | 0 | ✅ 就是 main | 有 | —— | ✅ **不要动**（主工作区 ✓）|
| `di1-check` | (detached) | 0 | 0 | ✅ 已含 | 无 | 一次性核查点（detached ✓）| ✅ **可以安全删**（无未提交、无独立提交 ✓）|
| `backlog-r26` | `docs/backlog-r26-and-stale-audit` | 0 | 0 | ✅ 已含 | 无 | 本件（正在写 ✓）| ⏳ 本任务自己的目录 |
| `pr478-2792` | (detached) | 0 | **1** | ❌ 不在 | 无 | 「采购明细里出现过的尺码」只读器（`purchaseSizeReader`）| 🔴 **必须先看**（detached + 独立提交 + 无 PR ⇒ 最容易被 `git gc`/清理吃掉 ✗）|
| `accept-async` | `feat/accept-async` | **1** | **1** | ❌ 不在 | 无 | 验收（工作台入口）也接异步：先回成功页 + 后台写库 | 🔴 **必须先看**（未提交 + 独立提交 + 无 PR ✗）|
| `arrival-batch` | `feat/accept-batch-final` | **3** | **4** | ❌ 不在（PR **#432 CLOSED** ✗）| 有 | 验收批量写：飞书调用 31→5、写入 10→2 + 分阶段打点 | 🔴 **必须先看**（有独立提交 + 3 处未提交 ✗）|
| `landing-diag` | `docs/scan-landing-diag-20261016` | **5** | **1** | ❌ 不在 | 无 | 扫货品码落资金页的**定位报告**（落点判定条件 + 真路由复现 + 根因）| 🔴 **必须先看**（5 处未提交 ✗）|
| `landing-reset` | `fix/scan-landing-reset-20261016` | **9** | 0 | ✅ 已含 | 无 | 切页签不被上一单顶走（陈旧残留清理）| ⚠️ **要人看**（9 处未提交 ✗ —— **改动本身没提交** ✗）|
| `pay-legacy` | `chore/payment-legacy-submit-migration` | 0 | **2** | ❌ 不在 | 无 | ⭐ 提交逐字：「**本地保命提交 · 不许 push**（Lead 已停手）」＋「迁完仍有 6 红，停手待 Lead 仲裁」| 🔴 **绝对保命**（**Lead 自己的仲裁现场** ✗）|
| `qr-batch` | `feat/qr-batch` | 0 | **1** | ❌ 不在 | **有** | 二维码回填脚本按 `record_id` 判定 + 白名单重生成 | 🔴 **必须先看**（独立提交 + **无 PR** ✗）|
| `rendered-log` | `feat/scan-page-rendered-log` | 0 | **1** | ❌ 不在 | **有** | 新增 `scan.page.rendered` 日志：「她看到的是哪一页 / 哪条判据命中」| 🔴 **必须先看**（独立提交 ✓；有远端 ⇒ 只是目录在）|
| `replenish-e` | `feat/replenish-default-check-and-button` | 0 | 2 | ⚠️ 判不出（PR **#540 MERGED** ✓ ⇒ 内容应已在 main）| 无 | 特殊尺码默认不勾 + 按钮文案「生成报货订单」| ✅ **内容已在 main ⇒ 目录可删**（squash 合并 ✓）|
| `replenish-trim` | `fix/replenish-trim-20261016` | **2** | **2** | ❌ 不在 | 无 | 补货页三处 + 尺码清单「一行 3 组」留档（含**静默失效**根因）| 🔴 **必须先看**（正是 R-27/R-28 ✓）|
| `rowseize` | `fix/row-size-from-stock-key` | 0 | **1** | ❌ 不在 | **有** | 库存行尺码从 `stock_key` 解析（性能）| 🔴 **必须先看**（独立提交 + 无 PR ✗）|
| `scan-accept-speed` | `feat/accept-timing-v1` | 0 | **1** | ❌ 不在（PR **#407 CLOSED** ✗）| **有** | 验收分阶段耗时打点（量出 83% 花在逐码库存写入）| 🔴 **必须先看** |
| `scan-accessory` | `feat/six-realms-and-accessory-page` | **1** | **1** | ❌ 不在（PR **#467 CLOSED** ✗）| **有** | 六个 tab 终序 + 配品页；退货离开扫码页 | 🔴 **必须先看**（未提交 + 独立提交 ✗）|
| `skelretry` | `fix/skeleton-retry` | **1** | **6** | ⚠️ 判不出（PR **#504 MERGED** ✓ ⇒ 内容应已在 main）| 无 | 骨架屏超时 ⇒ 慢提示 + 自动重试一次 + 手动重试 | ⚠️ **要人看那 1 处未提交**（其余内容应已在 main ✓）|
| `skipmin` | `feat/scan-minimal-success-skip` | **2** | 4 | ⚠️ 判不出（PR **#685 MERGED** ✓）| 无 | 成功页统一极简 + 资金页三处提示删除（Lead 保命提交现场 ✓）| ⚠️ **要人看那 2 处未提交**（含 `DO-NOT-TOUCH-second-writer.md` / `LEAD-ANSWER.md` ✗）|
| `speed2` | `refactor/filter-formula-v1` | **3** | **1** | ❌ 不在（PR **#394 CLOSED** ✗）| **有** | 过滤公式拼装抽成唯一实现 `bitableFilterFormula.js` | 🔴 **必须先看**（3 处未提交里含 `v1BitableGateway.js` ⇒ **像有人在写** ✗）|
| `sse-close-fix` | `fix/sse-close-before-await` | **1** | **1** | ⚠️ 判不出（PR **#605 MERGED** ✓）| 无 | SSE 断线清理提前到所有 `await` 之前 | ⚠️ **要人看那 1 处未提交** |
| `sync-validate` | `fix/sync-validate-empty-order` | **1** | **1** | ❌ 不在 | 无 | 补货/退货「尺码/数量/空单」三类校验搬回**同步路径**当场拦 | 🔴 **必须先看**（未提交 + 独立提交 ✗）|
| `texts-webhook2` | `test/guard-throw-exempt` | **3** | **2** | ❌ 不在（PR **#416 CLOSED** ✗）| **有** | 采购链路 6 条文案抽进 config（**74 文件**大迁徙 ✓）| 🔴 **必须先看**（体量最大 ✗）|
| `val-cp` | `docs/async-validation-checkpoints` | 0 | **1** | ❌ 不在 | 无 | 补货/退货/验收三条链路的【校验点清单】（异步改造前置准备）| ⚠️ **判不出内容是否已被吸收** ✗ ⇒ 人看（很可能已被 task-55/56 覆盖 ✓）|
| `voucher` | `feat/douyin-groupbuy-voucher` | **1** | **4** | ❌ 不在 | 无 | 抖音团购券结算（含把她 2026-10-16 晚的逐字例子 47.7 / 247.7 写成口径依据 ✓ = R-20 ✓）| 🔴 **必须保命**（4 独立提交 + 未提交 ✗；**与 R-20 直接相关** ✓）|
| `amount-realm-wire` 等**已不在列表**的旧目录 | —— | —— | —— | —— | —— | ⚠️ 本表只列**当前 `git worktree list` 里存在的**（`amount-realm-wire` / `annotate` / `mi7` / `money-v2` / `owed-auto` / `payment-status-inv` / `scan-realm` / `scan-timing` / `scan-accept-ux` 在 06:3x 这次采集**已不存在** ✗）| ⚠️ **如实**：它们的去向**我不知道** ✗（可能已被清理；**不是我删的** ✓）|

## 2. 汇总

**✅ 可以安全删（没东西可丢）**：`di1-check` ·（`replenish-e` / `skelretry` / `skipmin` / `sse-close-fix` 的**内容已在 main**，
但各自**还有 1~2 处未提交** ⇒ **先看那几处再看要不要删** ✗）

**🔴 必须先看（有独立提交且不在 main、或带未提交）**：
`pr478-2792`(detached) · `accept-async` · `arrival-batch` · `landing-diag` · `landing-reset`(**9 处未提交**) ·
`pay-legacy`(**Lead 的仲裁现场**) · `qr-batch` · `rendered-log` · `replenish-trim` · `rowseize` ·
`scan-accept-speed` · `scan-accessory` · `speed2` · `sync-validate` · `texts-webhook2` · `voucher`

**⚠️ 判不出「内容是否在 main」**（squash 合并 ⇒ 以 PR state 为准，但**未逐文件比**）：`replenish-e` /
`skelretry` / `skipmin` / `sse-close-fix` · `val-cp`（连 PR 都没有 ✗）

**🏷 关于"它当初是干什么的"**：上表第 ⑦ 列**逐条给了** ✓（取自分支名 + 该分支最后一条提交的标题 ✓ 不是我编的 ✓）

## 3. 边界（如实 ✓）

- 🔴 **我没删/没改/没 merge/没 push 任何 worktree 或分支** ✗ · **没碰任何 `server/src/**`** ✓ · 未部署 ✓
- ⚠️ ⑤ 列的"内容在 main"对 **squash 合并**的分支是**推断**（依据 PR state = MERGED ✓），**未逐文件比对** ✗
- ⚠️ `git merge-base --is-ancestor` 会把 squash 分支判成"不在 main" ✗ ⇒ **不要只看这一列就删** ✓
- ⚠️ 直接 `git diff origin/main` 会把 main 的新东西显示成"删了一堆" ✗ ⇒ 本表一律用 **`origin/main..HEAD` / `origin/main...HEAD`** ✓
