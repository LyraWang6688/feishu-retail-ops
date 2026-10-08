#!/bin/bash
# ⚠️ 写这个脚本的输出时踩过的坑（2026-10-07 实测）：
#   变量后面【紧跟中文/全角符号】时必须写成 ${VAR}，不能写成 $VAR。
#   LANG=C.UTF-8 下 bash 会把全角括号的字节当成变量名的一部分，
#   于是 `commit=$APP_COMMIT（最多…）` 会输出成 `commit=��最多…` ——
#   值凭空消失、报错信息变乱码（下面是修好之后的写法）。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # server/：ecosystem.config.js 与 src/app.js 的基准目录
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"     # 仓库根：算「这一版是哪一版」的地方

CHECK_ONLY=0

usage() {
  cat <<'USAGE'
用法：bash server/scripts/deploy_run.sh [--check-only]

  （默认）      pm2 startOrReload 重启，然后做【部署后版本自检】——对不上就非零退出
                 ⭐ 2026-10-08 起：第一次自检对不上时，会**自动带上正确的 APP_***
                    再 `pm2 restart <name> --update-env` **一次**，然后重新自检；
                    仍对不上就照旧报红退出（**不循环、不静默**）。
  --check-only  跳过重启，只对【已经在跑的服务】做一次版本自检
                （只比 commit，不比重启时间：这次并没有部署，算出来的时间是"现在"）
                ⚠️ --check-only **刻意不重启**，所以它也不会自动刷 env（要修就手工执行下面那两步）
  -h|--help     看这段用法

版本自检为什么存在：2026-10-07 事故 —— pm2 显示 online，但进程里的 APP_* 还是上一次的
值，/health 于是回报旧 commit（f0a2f3f），而磁盘上的代码已经是 aff273e。
⇒「重启成功」不等于「版本生效」，所以必须自己去看一眼 /health，不一致就当场报错。
⚠️ 这条坑 2026-10-08 **同一天又复现两次**（v0.3.4 / v0.3.5 部署）：
   `pm2 startOrReload ecosystem.config.js --update-env` 回 ✓ 但 APP_* 没换新
   ⇒ 所以现在把这个"手工那 4 步"做进了脚本（只做一次，见上）。

可用环境变量覆盖（默认值够用，一般不用设）：
  DEPLOY_HEALTH_URL        默认 http://127.0.0.1:${PORT:-5000}/health
  DEPLOY_HEALTH_RETRIES    默认 10   重试次数（每一轮自检各自算）
  DEPLOY_HEALTH_INTERVAL   默认 1    每次之间等几秒
  DEPLOY_HEALTH_TIMEOUT    默认 5    单次 curl 超时秒数
  DEPLOY_HEALTH_AUTO_ENV_REFRESH  默认 1；设 0 = 关掉"自检失败自动刷一次 env"
  DEPLOY_HEALTH_AUTO_REFRESH_WAIT 默认 3；自动刷 env 之后等几秒再自检
  DEPLOY_SKIP_VERSION_CHECK=1  应急跳过自检（会打印醒目 ⚠️，不推荐；仅限明确知道在做什么）
  DEPLOY_SKIP_ENV_REFRESH=1    同 DEPLOY_HEALTH_AUTO_ENV_REFRESH=0（旧名，保留兼容）
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数：$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$PROJECT_DIR"

export PORT=5000
export NODE_ENV=production

# 把「部署的是哪一版」写进环境，/health 会回报出来。
# 打了 tag 的部署回报 tag 名；没打 tag 就回报 commit 短号，便于对账。
# ⚠️ 一律用 `git -C "$REPO_DIR"`：版本号只取决于【本脚本所在的这个检出】，
#    跟「脚本被调用时人在哪个目录」无关（2026-10-07 复核过：即使是原来的写法，
#    从 server/ 里跑 git 也能上溯到仓库根、拿到正确的 HEAD —— 但这个前提不该靠"碰巧"）。
APP_VERSION="$(git -C "$REPO_DIR" describe --tags --abbrev=0 2>/dev/null || echo untagged)"
APP_COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
APP_DEPLOYED_AT="$(date -Iseconds)"
export APP_VERSION APP_COMMIT APP_DEPLOYED_AT

# 应用名从 ecosystem.config.js 读（`pm2 restart <name> --update-env` 要用它）——
# ⚠️ **不硬编码**：改 pm2 应用名时这里要跟着走，硬编码会静默刷错进程。
APP_NAME="$(cd "$PROJECT_DIR" && node -e 'try{const c=require("./ecosystem.config.js");process.stdout.write(String((c.apps&&c.apps[0]&&c.apps[0].name)||""))}catch(e){}' 2>/dev/null || true)"

if [ "$APP_COMMIT" = "unknown" ] || [ -z "$APP_COMMIT" ]; then
  echo "⚠️  取不到 git commit（$REPO_DIR 不是 git 检出？或者机器上没有 git）。" >&2
  echo "    ⇒ 本次【无法做版本自检】：/health 回报什么都对不上号，请自行确认部署内容。" >&2
fi

echo "Starting server on port $PORT..."
echo "Deploying version $APP_VERSION (commit $APP_COMMIT) at $APP_DEPLOYED_AT"

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "(--check-only) 跳过 pm2 重启，只对已经在跑的服务做版本自检。"
else
  # ⚠️ 这里用 startOrReload + --update-env（2026-10-07 00:16 的那次改动）：
  #   应用【已在运行】时 `pm2 start` 不更新进程 env，那时 /health 会一直回报旧版本。
  #   ⚠️ 但【别再假设 startOrReload + --update-env 就一定成功】——
  #   2026-10-07 12:59 那次就是「pm2 报 ✓、进程 online，/health 仍报旧版本」；
  #   本地用 pm2 7.0.4 也稳定复现了（见
  #   docs/deploy-post-restart-selfcheck-2026-10-07.md 第 4 节）。
  #   所以【下面的自检才是这次真正的修复】—— 不能只靠这条命令"应该没问题"。
  pm2 startOrReload ecosystem.config.js --update-env
fi

# ---------------------------------------------------------------------------
# 部署后版本自检（2026-10-07 加）
#
# 「重启成功」≠「版本生效」：/health 报的是【进程里的 APP_* 环境变量】，
# 不是磁盘上的代码。这一步自己去请求 /health，把 commit（以及 deployed_at）
# 与刚算出来的值对一遍：
#   · 一致   → 打印 ✅ + 实际 JSON，退出码 0
#   · 不一致 → 打印 ❌（期望值/实际值/最后响应都在），【非零退出】
# 绝不允许静默放过 —— 这正是这次要修的那类"看起来部署成功了"的静默失效。
# ---------------------------------------------------------------------------

if [ "${DEPLOY_SKIP_VERSION_CHECK:-}" = "1" ]; then
  echo "⚠️  DEPLOY_SKIP_VERSION_CHECK=1 —— 已显式跳过【部署后版本自检】。" >&2
  echo "⚠️  /health 有没有换上新版本【未经验证】，请自己确认。" >&2
  exit 0
fi

HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:${PORT:-5000}/health}"
HEALTH_RETRIES="${DEPLOY_HEALTH_RETRIES:-10}"
HEALTH_INTERVAL="${DEPLOY_HEALTH_INTERVAL:-1}"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-5}"

if [ "$CHECK_ONLY" -eq 1 ]; then
  # --check-only 回答的是「此刻在跑的是不是本仓库这一版」，所以【只比 commit】：
  # 这次并没有部署，脚本里算出来的 APP_DEPLOYED_AT 是"现在"，跟进程里那次部署的
  # 时间必然对不上 —— 拿它比会把自检变成永远失败（本地实测踩到过）。
  COMPARE_DEPLOYED_AT=0
  MODE_LABEL="版本自检（--check-only）"
else
  # 真正部署时【还要比 deployed_at】：只比 commit 的话，
  # 「同一个 commit 重新部署」会让自检误判成通过（commit 一样，但 env 明显没换新）。
  COMPARE_DEPLOYED_AT=1
  MODE_LABEL="部署后自检"
fi

# 从 /health 的 JSON 里取一个字段。用 node（这是个 node 应用，服务器上必然有），
# 不依赖 jq；解析失败就回空串 —— 空串一定对不上，只会判成失败，不会误判成通过。
json_field() {
  printf '%s' "$1" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const value = body[process.argv[1]];
        process.stdout.write(value === undefined || value === null ? "" : String(value));
      } catch (err) {
        process.stdout.write("");
      }
    });
  ' "$2" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 自检循环（抽成函数：自动刷 env 之后要**再跑一次**，两次的判据必须共用同一份实现）
#   · 成功 → return 0
#   · 失败 → return 1；`got_*` / `last_body` / `last_err` 保留**最后一次**的结果供报错用
# ---------------------------------------------------------------------------
wait_for_version() {
  local attempt=1 ok=0 raw=""
  last_body=""
  last_err=""
  got_version=""
  got_commit=""
  got_deployed_at=""

  echo "🔎 ${MODE_LABEL}：等 ${HEALTH_URL} 回报 commit=${APP_COMMIT}（最多 ${HEALTH_RETRIES} 次，每次间隔 ${HEALTH_INTERVAL}s）..."

  while [ "$attempt" -le "$HEALTH_RETRIES" ]; do
    if raw="$(curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>&1)"; then
      last_err=""
      last_body="$raw"
      got_version="$(json_field "$raw" version)"
      got_commit="$(json_field "$raw" commit)"
      got_deployed_at="$(json_field "$raw" deployed_at)"
      if [ "$got_commit" = "$APP_COMMIT" ] &&
         { [ "$COMPARE_DEPLOYED_AT" = "0" ] ||
           [ -z "$APP_DEPLOYED_AT" ] ||
           [ "$got_deployed_at" = "$APP_DEPLOYED_AT" ]; }; then
        ok=1
        break
      fi
    else
      # 连不上 / 超时 / HTTP 非 2xx：把 curl 的话留着，失败时打出来。
      last_err="$raw"
      last_body=""
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -le "$HEALTH_RETRIES" ]; then
      sleep "$HEALTH_INTERVAL"
    fi
  done

  [ "$ok" -eq 1 ]
}

report_success() {
  if [ "$COMPARE_DEPLOYED_AT" -eq 1 ]; then
    echo "✅ ${SUCCESS_LABEL}：/health 已回报【刚部署】的版本（commit=${got_commit}  deployed_at=${got_deployed_at}）"
  else
    echo "✅ ${SUCCESS_LABEL}：此刻在跑的就是本仓库这一版（commit=${got_commit}）"
  fi
  echo "   ${HEALTH_URL} → ${last_body}"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  SUCCESS_LABEL="版本自检通过"
else
  SUCCESS_LABEL="部署后自检通过"
fi

if wait_for_version; then
  report_success
  exit 0
fi

# ---------------------------------------------------------------------------
# ⭐ 2026-10-08 加：第一次自检没对上 → **自动刷一次 env，再自检一次**
#
# 起因（同一天两次真实部署）：`pm2 startOrReload ecosystem.config.js --update-env` 回 ✓、
# 进程 online，但进程里的 APP_* 还是上一次的 ⇒ /health 报旧 commit（详见脚本顶部说明）。
# 业务负责人 2026-10-08 拍板：「自检失败时自动带上正确的版本号再刷一次 env，然后重新自检
# （只重试一次，仍失败就照旧报红、不循环不静默）」。这就是下面这段。
#
# 三条边界：
#   · 只做**一次**：再失败就走原来的报红退出（绝不循环重启）；
#   · `--check-only` **不做**：那个模式的语义是"只自检、不重启"；
#   · 应用名取自 ecosystem.config.js（`APP_NAME`），取不到就不做（退回手工那两步）。
# ---------------------------------------------------------------------------
AUTO_ENV_REFRESH="${DEPLOY_HEALTH_AUTO_ENV_REFRESH:-${DEPLOY_SKIP_ENV_REFRESH:+0}}"
AUTO_ENV_REFRESH="${AUTO_ENV_REFRESH:-1}"
AUTO_REFRESH_WAIT="${DEPLOY_HEALTH_AUTO_REFRESH_WAIT:-3}"
AUTO_REFRESH_DONE=0

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "" >&2
  echo "ℹ️  --check-only 模式：刻意**不重启**，因此也不会自动刷 env。要修就手工执行：" >&2
  echo "      pm2 restart ${APP_NAME:-<应用名>} --update-env   # 先 export APP_VERSION/APP_COMMIT/APP_DEPLOYED_AT" >&2
  echo "      bash server/scripts/deploy_run.sh --check-only" >&2
elif [ "$AUTO_ENV_REFRESH" != "1" ]; then
  echo "" >&2
  echo "ℹ️  已显式关掉自动刷 env（DEPLOY_HEALTH_AUTO_ENV_REFRESH=${AUTO_ENV_REFRESH}）—— 按部署失败处理。" >&2
elif [ -z "$APP_NAME" ]; then
  echo "" >&2
  echo "⚠️  取不到 pm2 应用名（ecosystem.config.js 里读不到 apps[0].name）⇒ 不做自动刷 env，" >&2
  echo "    请按下面的提示手工处理。" >&2
else
  AUTO_REFRESH_DONE=1
  echo "" >&2
  echo "⚠️  第一次自检没对上：进程里的 APP_* 还是旧的（2026-10-07 / 10-08 反复出现的形状）。" >&2
  echo "    ⇒ 自动带上正确的版本号刷一次 env，再自检一次（只这一次）：" >&2
  echo "       pm2 restart ${APP_NAME} --update-env" >&2
  echo "       （APP_VERSION=${APP_VERSION}  APP_COMMIT=${APP_COMMIT}  APP_DEPLOYED_AT=${APP_DEPLOYED_AT}）" >&2
  pm2 restart "$APP_NAME" --update-env || true
  sleep "$AUTO_REFRESH_WAIT"
  if wait_for_version; then
    SUCCESS_LABEL="部署后自检通过（自动刷 env 之后）"
    report_success
    exit 0
  fi
  echo "" >&2
  echo "❌❌❌ 自动刷 env 之后【仍然】对不上：说明问题不是『env 没换新』这么简单。" >&2
  echo "     ⇒ 按部署失败处理（**不再重试**，避免把线上转成重启循环）。" >&2
fi

# ---- 失败：这里【必须】非零退出，不许静默放过 ----
echo "" >&2
echo "❌❌❌ ${MODE_LABEL}失败：/health 仍在报【旧版本】，或服务没起来。" >&2
if [ "$AUTO_REFRESH_DONE" -eq 1 ]; then
  echo "     （本次已自动执行过一次 \`pm2 restart ${APP_NAME} --update-env\` 并重新自检 —— 仍未对上）" >&2
fi
if [ "$COMPARE_DEPLOYED_AT" -eq 1 ]; then
  echo "     （比对项：commit + deployed_at）" >&2
else
  echo "     （比对项：commit；--check-only 不比重启时间）" >&2
fi
echo "     期望：commit=${APP_COMMIT}  version=${APP_VERSION}  deployed_at=${APP_DEPLOYED_AT}" >&2
echo "     实际：commit=${got_commit:-<空>}  version=${got_version:-<空>}  deployed_at=${got_deployed_at:-<空>}" >&2
echo "     地址：${HEALTH_URL}（试了 ${HEALTH_RETRIES} 次，每次间隔 ${HEALTH_INTERVAL}s）" >&2
if [ -n "$last_body" ]; then
  echo "     最后一次 /health 原始返回：$last_body" >&2
fi
if [ -n "$last_err" ]; then
  echo "     最后一次请求的错误：$last_err" >&2
fi
cat >&2 <<EOF

     ⇒ 这说明【进程里的 APP_* 环境变量没换成新的】（或者服务根本没起来）。
       这正是 2026-10-07 那次事故的形状：pm2 显示 online，/health 却报旧 commit。

       排查（只读，先别急着重启）：
         curl -sS ${HEALTH_URL}
         pm2 describe box2bitable-server | head -40
         pm2 logs box2bitable-server --lines 50
       让新 env 生效（2026-10-07 实测有效的一条）：
         pm2 restart box2bitable-server --update-env
       改完再自检一次（只自检，不重启）：
         bash server/scripts/deploy_run.sh --check-only
       应急跳过（本次不校验版本，会打印醒目警告）：
         DEPLOY_SKIP_VERSION_CHECK=1 bash server/scripts/deploy_run.sh

     ⚠️ 本次部署【没有通过自检】——请按"部署没成功"处理。
EOF

exit 1
