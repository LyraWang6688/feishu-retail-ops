# 并行开发协作约定（Lead + 其他 AI 同时在这个仓库干活时用）

> 起因：2026-10-15 晚，业务负责人说「**其他 AI 也在开发，你看下怎么互不影响**」。
> 这份是**可执行的**约定：谁先做、谁等谁、碰同一文件怎么办、怎么合、怎么上线。
> ⚠️ 它是**工作方式**的约定，不是业务口径；业务口径以 `docs/remaining-queue-*.md` 与她的原话为准。

## 0. 一句话总纲
**一个工作区一个写者；碰同一文件就串行；main 动得快 ⇒ 自己的分支必须天天 rebase；发布永远等她当次点头。**

## 1. 开工前（每次，不许跳）
```
1) `git fetch origin --prune` ⇒ 看 `origin/main` 到哪了（它动得快：可能几分钟一个提交）
2) `git worktree add .local/<名字> origin/main` ⇒ **只在自己的 worktree 里改** ✓
   软链 `server/node_modules` ＋ 拷 `server/.env`（少一样出"假红"）
3) `gh pr list --state open --json number,headRefName,files`（或 `gh pr view <N> --json files`）
   ⇒ ⭐ **看别人正在改哪些文件**；
   ⭐ 同时 `git worktree list` ＋ 对每个 `.local/*` 跑 `git -C <dir> status --porcelain`
   ⇒ **有未提交改动的 worktree = 有人正在写 ⇒ 绝不进别人的 worktree 里 commit ✗**
4) 列出**我这个任务会碰的文件**，与上面两份清单比对：
   · 无交集 ⇒ 可以并行 ✓（仍各用各的 worktree ✓）
   · 有交集 ⇒ **串行**：等对方合了再开始 ✗
```

## 2. 高风险文件（默认视为"有人在动"）——碰之前先问
```
🔴 `server/src/views/scanPageRenderer.js`
🔴 `server/src/routes/scanPage.js`
🔴 `server/src/config/scanWrite.js` / `server/src/config/scanPage.js`
🔴 `server/src/services/scanWriteService.js`
🔴 `server/public/workbench/**`（前端 features/config 同一批）
🔴 `server/test/fixtures/hardcodedChineseWhitelist.json`
🔴 `AGENTS.md`
⇒ 想动它们：先在共享任务板/消息里打招呼（说明文件 + 目的 + 预计顺序），**或干脆排在别人的活后面** ✓
```

## 3. 干活时的三条铁律（沿用仓库既有纪律）
```
· **只 `git add` 自己改的显式路径** ✓（不许 `git add -A` / `stash` / `checkout .` / `reset --hard` ✗）
· **绝不进别人的 worktree 里 commit** ✗（AGENTS §11② 有过真实事故）
· **不许边跑测试边改文件** ✗；**不许用脚本批量替换改测试** ✗（今晚真实踩过：11 红被翻成 17 红）
```

## 4. 合并（要快，别拖）
```
1) push 前先 `git fetch && git rebase origin/main`（main 动得快 ⇒ 长分支必冲突 ✗）
2) **全量两遍 EXIT=0**（`cd server && node --test --test-concurrency=1 --test-force-exit`）
3) `gh pr create` ⇒ 等 CI：`gh pr checks <N>`（**只有 `CLEAN` 才合** ✗ 不许 `--admin` ✗）
4) 合完立刻：**删分支 ＋ 删 worktree ＋ 主工作区 `git pull --ff-only`**（判据 `git rev-list --count HEAD..origin/main` = 0 ✓）
⇒ 分支**越短命越好**：宁可小步多次合，也别攒一个动 20 个文件的大 PR ✗
```

## 5. 发布（这条最要紧 —— 她反复强调过）
```
🔴 **部署必须她【当次】说「发」** ✗（授权一次一次算，绝不复用）
🔴 **同一时间只允许一个人发布** ✗：发布前先确认没有别人正在合/正在发（看是否有开放 PR、是否有新提交在几分钟内出现）
🔴 发布前查「最近 2 分钟有没有业务写入」（`bitable.record.*` / `inventory.change.applied` / `v1.sale.posted` 等）
🔴 顺序固定：`git reset --hard origin/main` ⇒ `deploy_build.sh`（红 ⇒ **绝不重启** ✗）⇒ `deploy_run.sh`
   ⇒ `/health` 版本对上 ⇒ `node scripts/deploy-selfcheck-routes.mjs`（3/3 ✓）
```

## 6. 已经"没人用但故意保留"的文件（**别再当死代码删** ✗）
```
· `server/src/config/purchaseArrivalIntake.js` —— 刻意保留（无读取点）；将来恢复"对话到货"用
· `server/src/services/purchaseSizeReader.js` —— 文件头注明"当前无生产引用"＋ **有测试钉着"必须保留"**
· `server/src/utils/writeTargetGuard.js` —— 写库脚本的防误写闸门（脚本 + 测试在用）
· 已删模块的名字只许留在**注释 / 文档 / "必须没有它"的哨兵**里 ✓
```

## 7. 想清死代码时的**正确判据**（免得误删）
```
✅ 先剥注释再匹配；**测试和 scripts 里的引用也算"被使用"**
✅ `.env.example` 里的键可能是**按前缀动态拼**出来读的（例：`salesMissingInfoText.js` 的 `PREFIX`）
   ⇒ 别因为"grep 不到"就判死 ✗
✅ HTML 里的 `<script src>` 也算引用（例：`public/workbench/standalone.js` 被 `inventory-adjustment.html` 用着）
✅ `package.json` / `*.sh` / `docs/**` 里提到的手工脚本 = 活的（人会在终端里跑）
⇒ 只报"**全仓零提及**"的，并且**删之前先问业务负责人** ✓
```
