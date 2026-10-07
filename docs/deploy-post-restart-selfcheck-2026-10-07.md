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

## 2. 改了什么

只改 `server/scripts/deploy_run.sh`（＋本文档）。**没有**改 `app.js`、`ecosystem.config.js`、也没碰任何 e2e 脚本。

### 2.1 版本计算不再依赖「当前目录」

```diff
-export APP_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo "untagged")"
-export APP_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
-export APP_DEPLOYED_AT="$(date -Iseconds)"
+REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"     # 仓库根：算「这一版是哪一版」的地方
+APP_VERSION="$(git -C "$REPO_DIR" describe --tags --abbrev=0 2>/dev/null || echo untagged)"
+APP_COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
+APP_DEPLOYED_AT="$(date -Iseconds)"
+export APP_VERSION APP_COMMIT APP_DEPLOYED_AT
```

`cd "$PROJECT_DIR"`（=`server/`）**保持不变** —— 它既是 `ecosystem.config.js` 的基准目录，
也是 `src/app.js` 的工作目录。原因见第 4 节（"补一个 cd 到仓库根"会**弄坏部署**）。

### 2.2 重启之后加一段自检（本任务的主体）

```sh
pm2 startOrReload ecosystem.config.js --update-env      # ← 重启（未改动）

# ---- 部署后版本自检 ----
# 「重启成功」≠「版本生效」：/health 报的是【进程里的 APP_*】，不是磁盘上的代码。
if [ "${DEPLOY_SKIP_VERSION_CHECK:-}" = "1" ]; then      # 应急跳过，且必须吵
  echo "⚠️  DEPLOY_SKIP_VERSION_CHECK=1 —— 已显式跳过【部署后版本自检】。" >&2
  echo "⚠️  /health 有没有换上新版本【未经验证】，请自己确认。" >&2
  exit 0
fi

HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:${PORT:-5000}/health}"
HEALTH_RETRIES="${DEPLOY_HEALTH_RETRIES:-10}"            # 等它起来：重试 10 次
HEALTH_INTERVAL="${DEPLOY_HEALTH_INTERVAL:-1}"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-5}"

while [ "$attempt" -le "$HEALTH_RETRIES" ]; do
  if raw="$(curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>&1)"; then
    got_commit="$(json_field "$raw" commit)"             # 用 node 解析，不依赖 jq
    got_deployed_at="$(json_field "$raw" deployed_at)"
    if [ "$got_commit" = "$APP_COMMIT" ] && { ...deployed_at 也一致... }; then
      ok=1; break
    fi
  else
    last_err="$raw"                                      # 连不上/超时：错误留着，失败时打出来
  fi
  attempt=$((attempt + 1)); [ "$attempt" -le "$HEALTH_RETRIES" ] && sleep "$HEALTH_INTERVAL"
done

if [ "$ok" -eq 1 ]; then
  echo "✅ 部署后自检通过：/health 已回报【刚部署】的版本（commit=… deployed_at=…）"
  echo "   ${HEALTH_URL} → ${last_body}"                  # 打印实际 JSON
  exit 0
fi

echo "❌❌❌ 部署后自检失败：/health 仍在报【旧版本】，或服务没起来。" >&2
# 期望 / 实际 / 地址 / 最后一次响应 / curl 错误 / 排查命令 / 补救命令 / 应急跳过
exit 1                                                   # ← 非零退出：绝不静默放过
```

配套的小开关（都可覆盖，默认值就是线上要用的）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `DEPLOY_HEALTH_URL` | `http://127.0.0.1:${PORT:-5000}/health` | 自检打哪个地址（本地验证用得上） |
| `DEPLOY_HEALTH_RETRIES` / `_INTERVAL` / `_TIMEOUT` | `10` / `1` / `5` | 重试次数 / 间隔秒 / 单次 curl 超时秒 |
| `DEPLOY_SKIP_VERSION_CHECK=1` | 不设 | 应急跳过自检（打印醒目 ⚠️） |

命令行参数：

```
bash server/scripts/deploy_run.sh               # 部署（重启 + 自检）
bash server/scripts/deploy_run.sh --check-only  # 不重启，只对【已经在跑的】服务做一次自检
bash server/scripts/deploy_run.sh --help
```

⚠️ `--check-only` **只比 commit**（这次并没有部署，脚本里算出来的 `deployed_at` 是"现在"，
拿它比会把自检变成永远失败 —— 这是本地实测踩到后改的）；真正部署时**commit 和 deployed_at 都比**，
后者专门用来抓「同一个 commit 重新部署」那种"commit 一样、env 其实没换新"的情况。

## 3. 部署后怎么自检（给人看的手册）

### 3.1 正常情况下（自检会自己做，你只需要看一眼）

```text
$ bash server/scripts/deploy_run.sh
Deploying version v0.3.0 (commit aff273e) at 2026-10-07T13:05:00+08:00
[PM2] Applying action reloadProcessId on app [box2bitable-server](ids: [ 0 ])
[PM2] [box2bitable-server](0) ✓
🔎 部署后自检：等 http://127.0.0.1:5000/health 回报 commit=aff273e（最多 10 次，每次间隔 1s）...
✅ 部署后自检通过：/health 已回报【刚部署】的版本（commit=aff273e  deployed_at=2026-10-07T13:05:00+08:00）
   http://127.0.0.1:5000/health → {"status":"ok","version":"v0.3.0","commit":"aff273e",...}
```

### 3.2 失败时（退出码非 0，就是 2026-10-07 那次事故的形状）

```text
❌❌❌ 部署后自检失败：/health 仍在报【旧版本】，或服务没起来。
     （比对项：commit + deployed_at）
     期望：commit=aff273e  version=v0.3.0  deployed_at=2026-10-07T13:05:00+08:00
     实际：commit=f0a2f3f  version=v0.3.0  deployed_at=2026-10-07T00:15:39+08:00
     地址：http://127.0.0.1:5000/health（试了 10 次，每次间隔 1s）
     最后一次 /health 原始返回：{"status":"ok","version":"v0.3.0","commit":"f0a2f3f",...}
```

**照这个顺序做**：

```bash
curl -sS http://127.0.0.1:5000/health          # 1. 亲眼看一下：commit 是不是刚部署的那个
pm2 describe box2bitable-server | head -40     # 2. 看运行状态（online？restarts？uptime？）
pm2 logs box2bitable-server --lines 50         # 3. 看启动有没有报错

# 4. 让新 env 真正进进程（2026-10-07 实测有效的一条）
pm2 restart box2bitable-server --update-env

# 5. 只自检一次（不重启、无副作用）
bash server/scripts/deploy_run.sh --check-only   # 期望 ✅
```

⚠️ **一句话解释为什么会失败**：`/health` 报的是**进程里的 `APP_*` 环境变量**，
而 `pm2 startOrReload <生态文件> --update-env` 在"应用已经在跑"时**可能不把这些 export 带进进程**
（本机 pm2 7.0.4 稳定复现；第 4 节有实测表和源码位置）。所以**失败不是自检误报，是部署真的没生效**。

### 3.3 想手动核对（不跑脚本）

```bash
curl -sS http://127.0.0.1:5000/health            # 权威探针：它读的就是进程的 process.env
git -C /opt/box2bitable rev-parse --short HEAD   # 磁盘上的代码是哪一版
```

⚠️ **`pm2 env 0 | grep APP_` 不是权威探针**：它打的是 pm2 内部 `pm2_env` 的**顶层键**
（`pm2/lib/API/Extra.js` 里 `Common.safeExtend({}, l.pm2_env)`），不是子进程真正的环境。
2026-10-07 那次它恰好也停在旧值，所以看起来对；但**判据请以 `/health` 为准**。

### 3.4 应急（明确知道自己在做什么）

```bash
DEPLOY_SKIP_VERSION_CHECK=1 bash server/scripts/deploy_run.sh   # 跳过自检，会打印醒目 ⚠️
```

## 4. 根因判断与证据

### 4.1 假设 A「脚本没 cd 到仓库根 ⇒ git 拿到别的仓库/空值」→ **不成立**

- 脚本**确实没有** cd 到仓库根：`PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"` = `server/`。
- 但 `server/` 在仓库里，git 会自己上溯到 toplevel，**拿到的 commit 是对的**（只读实测）：

  ```console
  $ cd server && pwd && git rev-parse --short HEAD && git rev-parse --show-toplevel
  /Users/…/feishu-retail-ops/server
  aff273e
  /Users/…/feishu-retail-ops
  $ git describe --tags --abbrev=0
  v0.3.0
  ```
- **更硬的反证**：事故现场 `/health` 报的是**上一次部署的整组值** —— `f0a2f3f` **和**
  `2026-10-07T00:15:39+08:00`。如果 git 那两行坏了，`APP_COMMIT` 会变成 `unknown`（脚本有 `||` 兜底），
  而 `APP_DEPLOYED_AT` 仍会是**新的**时间。观察到的是"**整组都是旧的**" ⇒ 不是"值算错了"，
  而是"**这次算出来的新值根本没进进程**"。
- ⚠️ **但 `cd "$PROJECT_DIR"` 不能改**：`ecosystem.config.js` 与 `src/app.js` 都以 `server/` 为基准。
  我实测踩过反面：一旦在仓库根调用 pm2，pm2 直接回
  `[PM2][ERROR] File ecosystem.config.js not found`（见 5.2）。
  ⇒ 所以「补一个 cd 到仓库根」这类改法会**弄坏部署**。
- 仍然做了低成本加固：版本号改用 `git -C "$REPO_DIR"` 计算（`REPO_DIR` 由脚本自身位置推出），
  从**任何** cwd 调用结果一致 —— 把这类怀疑永久消掉。

### 4.2 假设 B（真因）「`pm2 startOrReload <生态文件> --update-env` 不带新 env 进进程」→ **成立（本地复现）**

沙箱里（真 pm2 **7.0.4**、fork 模式、同一个 app）实测：

| 命令（app **已在运行**） | 进程重启了吗 | `/health` 的 commit | `pm2_env.env.APP_*` | `pm2_env` **顶层** `APP_*` |
|---|---|---|---|---|
| `pm2 startOrReload ecosystem.config.js --update-env` | 是（↺ 0→1） | **旧值** `d01b701` | **空（没有 APP_*）** | 旧值 `d01b701` |
| `pm2 restart box2bitable-server --update-env` | 是（↺ 1→2） | **新值** `EXP2BBB` | 新值 | 新值 |

而第一条命令 pm2 自己打印的是 **✓**：

```text
[PM2] Applying action reloadProcessId on app [box2bitable-server](ids: [ 0 ])
[PM2] [box2bitable-server](0) ✓
```

**pm2 说 ✓，`/health` 还是旧值** —— 与事故现场一模一样（`git HEAD=aff273e`，`/health` 仍报 `f0a2f3f`）。

**为什么（源码位置）**：fork 模式下，子进程的环境变量**只取 `pm2_env` 的顶层标量键**，
嵌套的 `pm2_env.env`（一个对象）**被显式跳过**：

```js
// pm2 7.0.4 · lib/God/ForkMode.js:95-99
var spawn_env = {};
for (var k in pm2_env) {
  if (pm2_env[k] !== null && pm2_env[k] !== undefined && typeof pm2_env[k] !== 'object')
    spawn_env[k] = pm2_env[k];        // ← typeof === 'object' 的 key（含嵌套 env）被丢掉
}
var options = { env: spawn_env, … };  // ← 真正给子进程的环境
```

⇒ **任何"只写进 `pm2_env.env`"的更新，都到不了应用进程**。
两条命令的区别恰恰是**新 env 落到哪个位置**（实测见上表）：
`restart <app名>` 那条会让顶层与嵌套 env 都拿到新值；生态文件那条（`_startJson` → `reloadProcessId`）不给。

⚠️ **诚实边界**：pm2 7.x 内部重构过（`God/ForkMode.js` / `God/ClusterMode.js`），
我**没有**逐行追完"哪一步把 env 展平到顶层"；但**上表是实测的**，且与
「子进程 env 只取顶层非对象键」这条源码**互相印证**：症状（`✓` 但 `/health` 旧）、
两条命令的差异、源码三者对得上。

**顺带纠正探针**：业务负责人当时用的 `pm2 env 0 | grep APP_` 打的是 `pm2_env` 的**顶层键**，
不是子进程真实环境（`pm2/lib/API/Extra.js` 的 `env()` 用 `Common.safeExtend({}, l.pm2_env)`）。
这次它凑巧反映了问题（顶层恰好也停在旧值），但**它不该当判据** —— 判据是 `/health`。

**也解释了为什么"手动救回来"有效**：`pm2 restart box2bitable-server --update-env`
走的正是能把新 env 送进进程的那条路（本地 C3 用例：补救后 `--check-only` 立刻 ✅）。

## 5. 本地怎么验的（没碰服务器）

> 🔴 本次**没有**在服务器上执行任何部署 / 重启 / 改动；`deploy_run.sh` 只在本地沙箱里跑过。
> 沙箱里的 pm2 是 `/tmp` 下的一次性安装（`PM2_HOME=/tmp/…`，与真实 pm2 无关），用完即弃。

### 5.1 沙箱长什么样（`/tmp/dhc`）

- 一个**一次性 git 仓库**：`server/scripts/deploy_run.sh`（**被测脚本原文**）、
  `server/ecosystem.config.js`（app 名仍叫 `box2bitable-server`，端口用 5123 —— 本机 5000 被 macOS 占了）、
  `server/health-app.js`。
- `health-app.js` 的 `/health` JSON **逐字照抄** `server/src/app.js:88-96`（同一批字段、同一个 `|| ''` 回落）。
  ⚠️ **没有**跑真实 `app.js`：它启动时会挂定时任务（`startShanghaiDailyScheduler` 的销售战报推送等），
  在本机跑会产生**没必要的真实外发副作用**。这是本次验证**保真度上唯一的缺口**（见 5.4）。
- 真实 `pm2`（7.0.4，装到 `/tmp/pm2exp`）＋ 真实 `curl`。
- ⚠️ 给 pm2 打了两处 **shim**（都在 `/tmp` 的安装里，不在仓库）：`pidusage` 与 `TreeKill`。
  原因：本机沙箱**禁止 spawn `/bin/ps`**，而这两处都会调 `ps`，导致 pm2 daemon 直接崩
  （`PM2 error: spawn EPERM`）。两处都只影响"CPU/内存显示"与"怎么杀掉进程树"，
  **不碰本次被测的 env 传递路径**。

### 5.2 逐条用例（`/tmp/dhc/run-checks.sh`，最终 **8/8 PASS**）

| 用例 | 期望 | 实际 |
|---|---|---|
| C1 全新部署（默认路径） | ✅ rc0 | ✅ rc0，`/health` 报新 commit |
| C2 **事故复现**：改了 commit 再部署 | **rc≠0 ⇔ `/health` 没换新**（绝不静默） | rc=1，`/health` 仍是旧 commit；pm2 自己却打了 `✓` |
| C3 按手册补救（`pm2 restart <名字> --update-env`）→ `--check-only` | ✅ rc0 | ✅ rc0 |
| C4 真正部署时 `deployed_at` 也参与比对 | 同 commit、时间旧 → ❌ rc1 | ❌ rc1（`比对项：commit + deployed_at`） |
| C5 `/health` 连不上 | ❌ rc1，且打印 curl 错误 | ❌ rc1 + `curl: (7) Failed to connect … port 5999` |
| C6 `DEPLOY_SKIP_VERSION_CHECK=1` | rc0 但**醒目警告** | rc0 + 两条 ⚠️ |
| C7 非 git 检出（拿不到 commit） | ⚠️ 但不阻断 | ⚠️ + rc0（`commit=unknown`） |
| C8 未知参数 | rc2 + 用法 | rc2 + usage |

**副作用排查**：C2 之后我用 `pm2 jlist` 对过账（`pm2_env.env` 空、顶层停在旧值），
确认 C2 的失败**不是**"服务没起来"或"端口冲突"，而是**env 没换**——正是要抓的那件事。

### 5.3 本地验证顺手抓到的一个真 bug（已修）

写提示文案时踩到 bash 的一个坑，**在我自己的脚本里**：

```console
$ X=d01b701
$ echo "commit=$X（最多）"     → commit=��最多）        # 值没了，括号变乱码
$ echo "commit=${X}（最多）"   → commit=d01b701（最多）  # 对
```

`LANG=C.UTF-8` 下，`$VAR` **紧跟全角括号**时 bash 会把括号的字节吃进变量名。
后果是**失败时最关键的两个值印不出来** —— 正好毁掉这次要做的"看得见的报错"。
已全部改成 `${VAR}` 并在脚本顶部写了注释。

### 5.4 只能等下次**真正部署**才能真验的部分（如实说）

1. **线上 pm2 的版本与行为**：我的复现是 pm2 **7.0.4**。线上装的是哪版我没动过、也读不到，
   版本不同表现可能不同（但**自检本身与版本无关**：它只问 `/health` 对不对）。
2. **真实 `app.js` 的启动**：沙箱用的是形状一致的 stub（见 5.1），没跑真 app（定时任务副作用）。
3. **真实端口与前置链路**：沙箱用 5123；线上是 5000（脚本默认 URL 就是 `${PORT:-5000}`），
   Nginx 是否在中间不影响 `127.0.0.1` 直连。
4. **真实 `pm2` 命令的输出与退出码**：沙箱里 pm2 是被 shim 过的（见 5.1）。
5. **首次在服务器上跑 `--check-only`**：属于"下一次部署"的一部分，本次没有执行。

## 6. 建议的下一步（**未在本 PR 实施**，需要业务负责人点头）

自检落地后，"版本没生效"会**当场暴露**；但**根因还在**：只要 `startOrReload <生态文件>` 这条路
在"应用已在运行"时不带新 env，每次重复部署都会自检失败（然后按手册手动 `pm2 restart` 补救）。
把根因也修掉的话，本地沙箱已验证过的写法是：

```sh
# 建议（未实施）：
if pm2 describe box2bitable-server >/dev/null 2>&1; then
  pm2 restart box2bitable-server --update-env    # 已在跑：走【实测确认能把 env 送进进程】的那条
else
  pm2 start ecosystem.config.js --update-env     # 全新机器：先起
fi
```

**为什么这次不动它**：
① 它改变**部署行为**（走 `describe` 分支、重启语义变化），而"重启会中断正在跑的业务写入"是
   2026-10-05 立过规矩的事 —— 该由业务负责人拍板，不该由子代理顺手改；
② 线上 pm2 版本未知（我的复现是 7.0.4），换命令属于更激进的一步；**自检会如实报出真实情况**，
   先落地自检、拿到一两次真实部署的记录，再决定要不要换，风险更低。

## 7. 不确定 / 待确认

- `docs/README.md`（文档索引）**本次没有改** —— 它正被另一条并行任务（私聊链条收尾）修改，
  按"会碰同一个文件就串行"的纪律我不动它；建议 Lead 在合适时机补一行索引。
- `--check-only` 只比 `commit`。如果将来想让它也能"对某一次具体部署"做对账，
  需要把那次部署的 `deployed_at` 传进来（例如 `DEPLOY_EXPECTED_DEPLOYED_AT`）—— 这次没做，避免加变量。
- 线上 pm2 版本（见 5.4 第 1 条）是唯一"结论可能随环境变"的地方。
