# 已合并远端分支 + worktree 清理日志

生成时间：2026-10-06 21:2x (Asia/Shanghai)
仓库：/Users/wangying/Documents/workplace/feishu-retail-ops
主工作区分支：main @ 834006a

## 0. 盘点（dry-run）

- `git fetch origin --prune -q` 已执行，exit 0。
- 远端分支（不含 main）：106
- `git branch -r --merged origin/main`：**95** 个已合并
- 未合并：**11** 个，与白名单逐字一致（见 merged.txt / unmerged_computed.txt）
- 本地 worktree：105（含主工作区）
- 本地分支：116，其中名字在已合并列表里的 **95** 个

## 1. worktree 分类

| 类别 | 数量 | 处理 |
| --- | --- | --- |
| 干净 + 分支在已合并列表 | 75 | 删除 worktree |
| 有未提交改动（dirty） | 14 | 跳过（其中 10 个分支在已合并列表） |
| 干净 + 分支不在已合并列表 | 11 | 跳过（含白名单） |
| detached HEAD | 4 | 跳过（不占分支，未授权处理） |
| 主工作区 | 1 | 跳过 |

- 75 个待删 worktree 全部满足：`git status --porcelain` 为空、分支名在已合并列表、
  `git rev-list --count origin/main..<branch>` = 0、`git cherry origin/main <branch>` 无 `-`/`+`。

## 2. 实际执行结果

### 2.1 worktree 删除（`git worktree remove <path>`，未用 --force）
- 目标 75 个，成功 **75**，失败 0。
- worktree 总数：105 → **30**

### 2.2 远端分支删除（`git push origin --delete`，5 批 × 17）
- 目标 85 个，**全部删除成功**（每批 exit=0）。
- 远端 heads：107（含 main）→ **22**
- 批次记录见 remote_delete_results.txt

### 2.3 本地分支删除（`git branch -d`）
- 目标 85 个，成功 **85**，失败 0。
- 本地分支：116 → **31**

## 3. 跳过的（未删任何东西）

### 3.1 有未提交改动的工作区（10 个，分支在已合并列表里）→ worktree 与远端/本地分支均保留
| worktree | 分支 |
| --- | --- |
| /private/tmp/after-sales | feat/after-sales-executor |
| /private/tmp/arrival-card | feat/arrival-card-and-async-create |
| /private/tmp/arrive-send | feat/arrive-then-send |
| /private/tmp/as-money | fix/after-sales-settlement-choice |
| /private/tmp/discount | fix/discount-vs-debt |
| /private/tmp/e2e-reply | fix/e2e-run-im-reply-and-batch-records |
| /private/tmp/group-purchase | feat/group-purchase |
| /private/tmp/purchase-return | feat/purchase-return |
| /private/tmp/schema-fix | fix/arrival-schema-align |
| /private/tmp/wsfix | chore/ws-test-app-credentials |

（内容均为 untracked：HANDOFF-*.md 交接笔记 / probe 脚本 / node_modules，无 tracked 文件被修改）

### 3.2 有未提交改动的工作区（4 个，分支不在已合并列表）
/private/tmp/ci-flaky (fix/return-batch-test-race) · /private/tmp/repro (repro/return-404)
.local/wt-e2e-scenarios (test/e2e-sales-scenarios) · .local/wt-pending-push (feat/pending-deal-daily-push)

### 3.3 干净但分支不在已合并列表（11 个，含白名单）
- /private/tmp/arrival  →  feat/arrival-conversation-flow
- /private/tmp/decouple  →  refactor/decouple-creation-and-stock
- /private/tmp/field-alias  →  fix/sales-confirm-field-alias
- /private/tmp/four-dim  →  feat/sales-status-dimensions-write
- /private/tmp/pr67-fix  →  fix/pr67-race
- /private/tmp/proc-e2e-sync  →  docs/procurement-e2e-status-sync
- /private/tmp/return-batch-clean  →  feat/return-batch-window-and-topic
- /private/tmp/schema2  →  fix/supplier-report-schema-align
- /private/tmp/schema3  →  fix/purchase-schema-after-table-change
- /private/tmp/status-abc  →  feat/sales-status-write-backfill
- /Users/wangying/Documents/workplace/feishu-retail-ops/.local/wt-aftersales-thread  →  feat/after-sales-thread

### 3.4 detached HEAD（4 个，不占分支，未授权处理）
/private/tmp/arrival-probe · /private/tmp/decouple-probe · /private/tmp/field-audit · /private/tmp/merge-purchase

### 3.5 主工作区
/Users/wangying/Documents/workplace/feishu-retail-ops（未动）

## 4. 白名单 11 个未合并分支：完好无损

远端 11/11 存在；其中 10 个的 origin ref 与本地 ref 逐一 SHA 相同（逐个核对过）：
- dependabot/npm_and_yarn/server/minor-and-patch-e010e89128（远端独有，无本地分支）
- docs/procurement-e2e-status-sync e94046c
- feat/after-sales-thread d533194
- feat/arrival-conversation-flow c68bfc4
- feat/return-batch-window-and-topic 6cf3be0
- feat/sales-status-dimensions-write 602d8d6
- feat/sales-status-write-backfill 3c1def3
- fix/purchase-schema-after-table-change 3b649e3
- fix/sales-confirm-field-alias 7f8a9e3
- fix/supplier-report-schema-align 1496e01
- refactor/decouple-creation-and-stock 0c4fc4d

## 5. 收尾核对

- 远端 heads = 22 = main(1) + 白名单(11) + 因脏 worktree 保留(10)；无多余分支。
- HEAD 仍为 834006a，主工作区 `git status --porcelain` 与开始时**完全一致**（同样 5 行未跟踪）。
- 无 force push / reset / stash；未改任何代码、未提交、未开 PR。

## 6. 未决 / 不确定处

- 3.1 那 10 个分支（远端 + 本地）按"被 worktree 占用 → 先清 worktree"的字面纪律**保留**。
  技术上这 10 个远端分支已确认合并进 origin/main，删除**不会丢任何内容**
  （它们的工作区只有未提交的 untracked 笔记/脚本）。是否删除待业务负责人/上级决定。
- fix/arrival-notice-first：本地分支 tip 与 origin 不同，但两者都是 origin/main 的祖先
  （`origin/main..branch` = 0，cherry 无 +/-），判定为已合并，已处理。
- /private/tmp/* 下的 worktree 目录已被 git 解除登记；`/private/tmp` 由系统自行回收。
