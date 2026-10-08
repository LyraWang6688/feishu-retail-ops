#!/bin/bash
# ---------------------------------------------------------------------------
# tag_release.sh —— 「版本管理 = 每次部署给被部署的 commit 打一个 tag」
#
# 业务负责人口径（2026-10-08，逐字）：「就是打个 tag」。
# ⇒ 版本号【以 tag 为准】，本脚本【不改 package.json】——
#   避免「为了打一个 tag 再改一行 package.json」多出一笔额外提交。
#
# 本脚本【不是部署脚本】，也不会部署任何东西：
#   · 它只做三件事：算下一个版本号 → 打 annotated tag → push 那一个 tag。
#   · 它不重启服务、不碰 .env、不碰 pm2。
#   · 部署仍然只能由业务负责人【当次】下令后，跑 deploy_build.sh + deploy_run.sh。
#
# 与 deploy_run.sh 的关系（只读地对齐口径，不改它的语义）：
#   deploy_run.sh 用 `git describe --tags --abbrev=0` 算 APP_VERSION，
#   /health 的 version 就来自这个值 ⇒ 打了 tag 之后，那一版才会报出正确的版本号。
#
# ⚠️ 写这个脚本的输出时踩过的坑（2026-10-08 实测，与 deploy_run.sh 顶部记的是同一个）：
#   LANG=C.UTF-8 下，`$VAR` 后面【紧跟全角标点】时，bash 会把那个全角字节
#   当成变量名的一部分 ⇒ 报 `next_tag�: unbound variable`（值凭空消失）。
#   ⇒ 本文件里凡是变量后面跟中文/全角符号的，一律写成 `${VAR}`，不写 `$VAR`。
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # server/
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"     # 仓库根：tag 打在哪个检出上
SHANGHAI_TZ="Asia/Shanghai"

usage() {
  cat <<'USAGE'
用法：
  bash server/scripts/tag_release.sh <commit-ish> "<一句话说明>"
  bash server/scripts/tag_release.sh "<一句话说明>"          # 打在本分支 HEAD 上

例子：
  bash server/scripts/tag_release.sh b75139a "到货卡片可见性 + 确认成交不再假成交 + 采购侧那批"
  bash server/scripts/tag_release.sh "修跨午夜的两条定时炸弹测试"

做什么：
  1. 取【最新 tag】（git describe --tags --abbrev=0）→ 算出下一个 patch 版本
     （例：v0.3.0 → v0.3.1；一个 tag 都没有时从 v0.1.0 开始）；
  2. 对【指定 commit】打 annotated tag：
       git tag -a <版本> <commit> -m "<版本> <上海时间> <说明>"
  3. git push origin <版本>（只推这一个 tag）。

不做（刻意的）：
  · 不改 package.json —— 版本以 tag 为准；
  · 不覆盖已存在的 tag（不 --force）；tag 已存在 → 报错退出；
  · 不提交、不推分支、不部署。

⚠️ 第一个参数若写成"已经存在的旧 tag 名"，它会当成 commit-ish 用
   （例：`tag_release.sh v0.3.0 "..."` = 对 v0.3.0 指向的那条 commit 打新 tag）。
   想打在本分支 HEAD 上就【只给说明一个参数】。

可用环境变量（默认值够用）：
  TAG_RELEASE_DRY_RUN=1    只打印将要执行的命令，什么都不写、什么都不推
  TAG_RELEASE_DATE="..."   覆盖 tag 说明里的时间戳（默认取证刻的上海时间）
  TAG_RELEASE_NO_FETCH=1   跳过 git fetch --tags（离线 / 断网时用；默认会先取一次远端 tag）
  TAG_RELEASE_ALLOW_OLD=1  允许对"不是 HEAD、也不在 HEAD 祖先链上"的老 commit 打 tag
USAGE
}

arg_commit=""
arg_message=""

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

case "$#" in
  0)
    echo "❌ 缺少参数：<一句话说明>（可再给一个 <commit-ish>）。" >&2
    echo "" >&2
    usage >&2
    exit 2
    ;;
  1)
    arg_commit="HEAD"
    arg_message="$1"
    ;;
  2)
    arg_commit="$1"
    arg_message="$2"
    ;;
  *)
    echo "❌ 参数太多（共 ${#} 个）：说明要用引号包成一个参数。" >&2
    echo "" >&2
    usage >&2
    exit 2
    ;;
esac

if [ -z "$arg_message" ]; then
  echo "❌ 说明不能是空串 —— 这行说明会写进 tag 说明里，是给人看的。" >&2
  exit 2
fi

if [ ! -d "$REPO_DIR/.git" ] && [ ! -f "$REPO_DIR/.git" ]; then
  echo "❌ ${REPO_DIR} 看起来不是 git 检出，打不了 tag。" >&2
  exit 1
fi

GIT="git -C $REPO_DIR"

# ---------------------------------------------------------------------------
# 1. 先把远端 tag 取回来 —— 否则「最新 tag」可能过时，
#    算出来的版本号会跟远端撞车（撞车下面会报错退出）。
#    取不到（离线）只警告，继续用本地 tag，不因为网络断掉就干不了活。
# ---------------------------------------------------------------------------
if [ "${TAG_RELEASE_NO_FETCH:-}" != "1" ]; then
  echo "🔎 先取一次远端 tag（git fetch --tags）..."
  if ! $GIT fetch --tags --quiet origin 2>/dev/null; then
    echo "⚠️  git fetch --tags 失败（离线？）—— 继续用【本地已有的 tag】算版本号。" >&2
    echo "    ⚠️ 若远端有本地没有的更新 tag，算出来的版本号可能撞车；下面会检查。" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 2. 解析要打 tag 的 commit
# ---------------------------------------------------------------------------
if ! commit_sha="$($GIT rev-parse --verify --quiet "$arg_commit^{commit}")"; then
  echo "❌ 认不出这个 commit-ish：${arg_commit}" >&2
  echo "   在 ${REPO_DIR} 里对它做不了 rev-parse。请给分支名 / 短号 / 全号 / HEAD 之一。" >&2
  exit 1
fi
commit_short="$($GIT rev-parse --short "$commit_sha")"
commit_subject="$($GIT log -1 --format=%s "$commit_sha")"

head_sha="$($GIT rev-parse --verify --quiet 'HEAD^{commit}' || true)"

# ---------------------------------------------------------------------------
# 2b. ⭐ 形状闸门：这个 commit 是不是"现在这一版"？
#     2026-10-08 实测踩到的坑：把【已经存在的旧 tag 名】当第一个参数传进去，
#     脚本会老老实实对那条【旧 commit】打一个新版本号 —— 版本号往前走了，
#     代码却还是旧的（本地复现时误打出一个指向旧版本的 v0.3.1，已删除）。
#     所以这里显式比一下，并且【默认拒绝】对"老 commit"打新版本号。
# ---------------------------------------------------------------------------
head_on_target=0
if [ -n "$head_sha" ]; then
  if [ "$head_sha" = "$commit_sha" ] || $GIT merge-base --is-ancestor "$commit_sha" "$head_sha" 2>/dev/null; then
    head_on_target=1
  fi
fi

if [ "$head_on_target" = "1" ]; then
  if [ "$head_sha" = "$commit_sha" ]; then
    echo "✅ 目标就是本分支 HEAD（${commit_short}）。"
  else
    behind="$($GIT rev-list --count "${commit_sha}..${head_sha}" 2>/dev/null || echo '?')"
    echo "⚠️  目标不是 HEAD：它是 HEAD 的祖先，落后 ${behind} 个提交（${commit_short}）。"
    echo "    ⇒ 你很可能想打的是 ${head_sha:0:7}（HEAD）而不是它。确认后再继续。"
  fi
  echo ""
else
  echo "❌ 目标 commit 既不是本分支 HEAD，也不在 HEAD 的祖先链上：${commit_short}" >&2
  echo "   ${commit_subject}" >&2
  echo "   ⇒ 给一个【部署的那一版】打 tag，通常就是 HEAD（省略 commit-ish 即可）。" >&2
  echo "      真要对这条老 / 旁支 commit 打 tag，加 TAG_RELEASE_ALLOW_OLD=1 重跑。" >&2
  if [ "${TAG_RELEASE_ALLOW_OLD:-}" != "1" ]; then
    exit 1
  fi
  echo "⚠️  TAG_RELEASE_ALLOW_OLD=1 —— 已显式放行，继续。" >&2
  echo ""
fi

# ---------------------------------------------------------------------------
# 3. 取最新 tag 并算下一个 patch 版本
#    取法用「只读的 `git describe --tags --abbrev=0`」（与 deploy_run.sh 同一条口径），
#    它认不出来的环境（没有 tag / describe 不可用）就退回 `git tag --sort=-v:refname`。
# ---------------------------------------------------------------------------
latest_tag="$($GIT describe --tags --abbrev=0 2>/dev/null || true)"
if [ -z "$latest_tag" ]; then
  latest_tag="$($GIT tag --sort=-v:refname | head -n 1)"
fi

if [ -z "$latest_tag" ]; then
  next_tag="v0.1.0"
  echo "ℹ️  当前一个 tag 都没有 ⇒ 从 v0.1.0 开始。"
else
  if [[ "$latest_tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"
    next_tag="v${major}.${minor}.$((patch + 1))"
  else
    echo "❌ 最新 tag 不是 v<主>.<次>.<修> 的形状：${latest_tag}" >&2
    echo "   本脚本只按 patch + 1 递增，不敢猜 —— 请先人工给它一个规范版本号。" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 4. 幂等 / 安全闸门：本地已有同名 tag → 报错退出（不覆盖、不 --force）
# ---------------------------------------------------------------------------
if $GIT rev-parse -q --verify "refs/tags/$next_tag" >/dev/null; then
  echo "❌ tag 已存在：${next_tag}" >&2
  echo "   它指向：$($GIT rev-list -n 1 "$next_tag" | cut -c1-7)" >&2
  echo "   ⇒ 本脚本【不覆盖、不 --force】。请自己确认：是换个版本号，还是人工删掉重打。" >&2
  exit 1
fi

# 远端已有同名 tag（比如别人推过了）→ 也只报错，不硬推。
if remote_tag="$($GIT ls-remote --tags origin "refs/tags/$next_tag" 2>/dev/null)"; then
  if [ -n "$remote_tag" ]; then
    echo "❌ 远端 origin 上已经有这个 tag：${next_tag}" >&2
    echo "   ${remote_tag}" >&2
    echo "   ⇒ 不推、不 --force。请先跟人确认要打的是哪个版本号。" >&2
    exit 1
  fi
else
  echo "⚠️  查不到 origin 上的 tag（网络或权限）—— 直接 push，若已被占用 git 会拒绝。" >&2
fi

# ---------------------------------------------------------------------------
# 5. 提示：工作区有未提交改动【不影响打 tag】（tag 指向 commit，与工作区无关）
# ---------------------------------------------------------------------------
dirty="$($GIT status --porcelain 2>/dev/null | head -n 20 || true)"
if [ -n "$dirty" ]; then
  echo "⚠️  工作区有未提交改动 —— 这些改动【不会】进这个 tag（tag 只指向 commit）。"
  echo "    这个 tag 打的是 commit 里的内容，不是你现在磁盘上的内容。"
  echo "    若你以为「打 tag = 发布我刚改的东西」，请先把改动提交并合并，再对那个 commit 打 tag。"
  echo "$dirty" | sed 's/^/      /'
  echo ""
fi

# ---------------------------------------------------------------------------
# 6. 组装 tag 说明并打 tag
# ---------------------------------------------------------------------------
stamp="${TAG_RELEASE_DATE:-$(TZ="$SHANGHAI_TZ" date '+%Y-%m-%d %H:%M:%S %z')}"
tag_message="$next_tag $stamp $arg_message"

echo "最新 tag      ：${latest_tag:-<无>}"
echo "下一个版本    ：${next_tag}"
echo "打在这个 commit：${commit_short}  ${commit_subject}"
echo "tag 说明      ：${tag_message}"
echo ""

if [ "${TAG_RELEASE_DRY_RUN:-}" = "1" ]; then
  echo "🧪 TAG_RELEASE_DRY_RUN=1 —— 只打印，不执行："
  echo "   git -C ${REPO_DIR} tag -a ${next_tag} ${commit_sha} -m \"${tag_message}\""
  echo "   git -C ${REPO_DIR} push origin ${next_tag}"
  exit 0
fi

$GIT tag -a "$next_tag" "$commit_sha" -m "$tag_message"
echo "✅ 已打 tag：${next_tag} → ${commit_short}"

$GIT push origin "$next_tag"
echo "✅ 已推送：origin ${next_tag}"
echo ""

# ---------------------------------------------------------------------------
# 6b. ⭐ 顺手建一个 **GitHub Release**（2026-10-08 加）
#
# 起因（业务负责人逐字）：「**打完tag你也没发布啊～**」—— 她看的是 GitHub 的
# **Releases 页**，而本脚本原先只 `git push` 了 **tag**：tag ≠ Release，
# 于是 Releases 页一直停在上一版（当时停着 v0.3.2），看起来就像"没发布"。
#
# ⇒ 现在打完 tag 就顺手 `gh release create`（**只影响 GitHub 的展示，不动代码、不部署**）。
#    · 没装 gh / 没登录 ⇒ **只警告**，给出可照抄的手工命令（不让这件事挡住打 tag）；
#    · 想跳过：`TAG_RELEASE_SKIP_GH_RELEASE=1`。
# ---------------------------------------------------------------------------
if [ "${TAG_RELEASE_SKIP_GH_RELEASE:-}" = "1" ]; then
  echo "ℹ️  TAG_RELEASE_SKIP_GH_RELEASE=1 —— 跳过建 GitHub Release（tag 已推）。"
elif command -v gh >/dev/null 2>&1; then
  # Release 说明 = 这次的一句话 + 从上一个 tag 到本次 commit 的提交清单（给人看）。
  release_notes="$arg_message"
  if [ -n "$latest_tag" ]; then
    commits="$($GIT log --oneline --no-merges "${latest_tag}..${commit_sha}" 2>/dev/null | head -n 40 || true)"
  else
    commits="$($GIT log --oneline --no-merges -n 40 "$commit_sha" 2>/dev/null || true)"
  fi
  if [ -n "$commits" ]; then
    release_notes="${release_notes}

$(printf '%s' "$commits" | sed 's/^/- /')"
  fi
  if gh release create "$next_tag" --title "${next_tag} · ${arg_message}" --notes "$release_notes" >/dev/null 2>&1; then
    echo "✅ 已建 GitHub Release：${next_tag}（Releases 页会立刻显示这一版）"
  else
    echo "⚠️  GitHub Release 没建成（tag 已推，不影响部署）。手工建：" >&2
    echo "      gh release create ${next_tag} --title \"${next_tag}\" --notes \"${arg_message}\"" >&2
  fi
else
  echo "ℹ️  本机没有 gh（或没登录）⇒ 跳过建 GitHub Release；手工建：" >&2
  echo "      gh release create ${next_tag} --title \"${next_tag}\" --notes \"${arg_message}\"" >&2
fi
echo ""
echo "ℹ️  之后那一版部署时，deploy_run.sh 的版本自检就会算出 APP_VERSION=${next_tag}，"
echo "    /health 的 version 会跟着报出来。"
echo "ℹ️  记得把这一版补进 docs/releases.md（只记录【已部署】的版本）。"
