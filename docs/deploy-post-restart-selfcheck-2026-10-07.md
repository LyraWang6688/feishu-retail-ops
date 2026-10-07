# 部署后版本自检 —— 不让 `/health` 再骗人（2026-10-07）

> 本文件是这次改动的**验收标准 + 给人看的自检手册 + 根因证据**。
> 相关脚本：`server/scripts/deploy_run.sh`（本次唯一改动的脚本）。
> ⚠️ 本次**没有**在服务器上执行任何部署/重启，全部验证在本地沙箱完成。

## 0. 要修的事故

2026-10-07 12:59（+08）在服务器（`/opt/box2bitable`，PM2 app `box2bitable-server`，PORT=5000）
跑 `server/scripts/deploy_run.sh` 部署：

- 脚本**重启成功**、PM2 显示 online；
- 但 `/health` 仍报**早上那次**的版本：
  `{"version":"v0.3.0","commit":"f0a2f3f","deployed_at":"2026-10-07T00:15:39+08:00"}`
- 磁盘上代码是新的（`git HEAD = aff273e`）；
- `pm2 env 0 | grep APP_` 也仍是旧值 ⇒ 这次重启**没有把新的 `APP_*` 环境变量带进进程**；
- 手动 `export … ; pm2 restart box2bitable-server --update-env` 之后 `/health` 才报对。

**核心结论（本任务要写死的）**：**「重启成功」≠「版本生效」**。
`/health` 报什么，取决于**进程里的 `APP_*` 环境变量**，而不是磁盘上的代码。
所以部署脚本必须**在重启之后自己去核对一次**，不一致就**当场非零退出**。

## 1. 验收标准（动手前先写死，逐条对照）

### A. `/health` 一致 → 通过路径
- **A1** 重启后脚本自动请求 `http://127.0.0.1:${PORT:-5000}/health`，**带重试**（默认 10 次 / 每次间隔 1s，可用环境变量覆盖），以容纳服务启动耗时。
- **A2** `/health` 的 `commit` 与刚算出的 `git rev-parse --short HEAD` **一致**时：打印 `✅` ＋ **实际 JSON 原文**，**退出码 0**。
- **A3** 比较用的「期望值」就是本次 export 出去的那三个值（`APP_VERSION` / `APP_COMMIT` / `APP_DEPLOYED_AT`），不是重新算一遍的别的值。

### B. `/health` 不一致 → 失败路径（本任务的全部意义）
- **B1** `commit` 不一致 → 打印**醒目** `❌`（含期望值与实际值），并提示排查 `pm2 env`，**退出码非 0**。
- **B2** `/health` **连不上 / 超时 / 不是 JSON**：重试耗尽后**同样非零退出**，并打印最后拿到的响应或 curl 错误（**不得静默**）。
- **B3** `deployed_at` 也不一致 → 同样非零退出。
  （理由：**同一个 commit 重新部署**时 `commit` 相同，只有 `deployed_at` 能证明「这次的 env 真的换新了」。）
- **B4** 上述失败**不允许**被 `|| true`、`set +e`、`2>/dev/null` 之类吞掉；最后一次尝试的响应必须出现在输出里。

### C. 版本计算不再依赖「当前目录」
- **C1** `APP_VERSION` / `APP_COMMIT` 改为 `git -C "$REPO_DIR" …` 计算，`REPO_DIR` 由脚本自身位置推出（`$SCRIPT_DIR/../..`），**从任何 cwd 调用结果一致**。
- **C2** **保留** `cd "$PROJECT_DIR"`（= `server/`）——`ecosystem.config.js` 与 `src/app.js` 都以 `server/` 为基准，**不能**改成 cd 到仓库根（那会让 pm2 找不到 ecosystem 文件）。
- **C3** 拿不到 commit（不是 git 检出 / 没有 git）时：打印**醒目 ⚠️** 说明「本次无法做版本自检」，但**不阻断**部署（与旧行为一致，不引入新的失败面）。

### D. 可本地验证（不碰服务器）
- **D1** 提供 `--check-only`：**跳过 pm2**，只对「已经在跑的服务」跑一次自检。
- **D2** `DEPLOY_HEALTH_URL` 可覆盖 → 本地起一个假 `/health` 就能把 ✅ / ❌ **两条路径都真跑一遍**。
- **D3** 不引入新依赖：只用服务器上必然有的 `curl`（以及 node 应用自带的 `node`），**不依赖 `jq`**。

### E. 文档
- **E1** `docs/` 里有这篇「部署后怎么自检」，含：正常输出长什么样、失败时人该做什么、应急跳过开关。
- **E2** 脚本内部有对应注释（为什么必须有这一步）。

### F. 作用域与纪律
- **F1** 只改 `server/scripts/deploy_run.sh` ＋ 新增本文档；🔴 **不碰** `e2e-group-thread.mjs` / `e2e-run.mjs` / `test/e2e-group-thread.test.js`。
- **F2** 本地把 ✅ / ❌ 两条路径真跑通（真实 curl + 真实 pm2 + 真实 `/health` JSON 形状）。
- **F3** 开 PR，`gh pr checks` = **CLEAN**，**不用 `--admin`**，**不合并**。

### G. 根因判断必须有证据（不许猜）
- **G1** 「cwd 不是仓库根 ⇒ git 拿不到正确 commit」这个假设：**实测结论**（含命令与输出）。
- **G2** `pm2 startOrReload <ecosystem文件> --update-env` 与 `pm2 restart <app名> --update-env`
  两条路径上 `APP_*` **到底有没有进进程**：**沙箱实测** ＋ pm2 源码位置。

---

（下面各节在实现与验证完成后补上：改动说明 · 自检手册 · 根因证据 · 本地验证记录 · 只能等下次部署真验的部分。）
