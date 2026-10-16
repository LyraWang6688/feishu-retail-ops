#!/usr/bin/env bash
# worktree 审计/清理（2026-10-16 定 · 起因：业务负责人追问"为什么会存在这些 worktree / 后续怎么避免"）
#
# 用法：
#   bash server/scripts/audit-worktrees.sh            # 只审计（默认，不改任何东西）
#   bash server/scripts/audit-worktrees.sh --clean    # 清掉「提交都已在 main」的（会先留档 diff）
#
# 判据（🔴 不许用祖先关系 —— 本仓用 --squash 合并，分支提交换了身份、祖先判据会永久拒绝）：
#   git cherry origin/main <branch>   ⇒  `-` 已在 main ✓   `+` 真的没合 ✗（不删）
# 安全底线（四条，见 docs/worktree-cleanup-rule-2026-10-16.md）：
#   ① 有 `+` ⇒ 不删  ② 有未提交 ⇒ 先看一眼  ③ 绝不用 --force 于有 `+` 的  ④ 要清先留档 diff
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
git fetch origin --prune -q
CLEAN="${1:-}"
SALVAGE="docs/branch-salvage-auto"
[ "$CLEAN" = "--clean" ] && mkdir -p "$SALVAGE"
printf '%-22s %-8s %-8s %-8s %s\n' WORKTREE 未提交 没合 近期活动 判定
for d in $(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep '/.local/'); do
  w=$(basename "$d"); b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  u=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  plus=$(git cherry origin/main "$b" 2>/dev/null | grep -c '^+')
  act=$(find "$d/server" -type f -newermt '-20 minutes' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$act" != "0" ]; then st="在跑（不动）"; elif [ "$plus" = "0" ]; then st="可清（已合）"; else st="有没合（不动）"; fi
  printf '%-22s %-8s %-8s %-8s %s\n' "$w" "$u" "$plus" "$act" "$st"
  if [ "$CLEAN" = "--clean" ] && [ "$act" = "0" ] && [ "$plus" = "0" ]; then
    git diff origin/main.."$b" > "$SALVAGE/$w.patch" 2>/dev/null || true
    git worktree remove --force "$d" >/dev/null 2>&1 && echo "  ✅ 已清 $w（留档 $SALVAGE/$w.patch）"
    git branch -D "$b" >/dev/null 2>&1 || true
  fi
done
echo
echo "提示：清完请把留档登记进 docs/README.md（索引哨兵 docsIndexCompleteness 兜着）"
