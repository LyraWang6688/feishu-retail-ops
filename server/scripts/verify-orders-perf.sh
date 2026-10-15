#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 「部署后怎么验」—— `GET /api/workbench/sales/orders` 的耗时（2026-10-16）
#
# 为什么需要这个脚本：这次**不许自行部署**（业务负责人测试期间的铁律），
# 所以"改后到底几秒"只能等她把这次改动部署上去之后，在服务器上量。
#
# 🔴 只读：只 grep PM2 日志 + 可选 curl 一次 `/health`。**不重启、不改 .env、不写任何表。**
#
# 改前基线（生产 PM2 日志，`http.request.completed` 的 `duration_ms`）：
#   最慢五条 = 42317 / 32824 / 31045 / 27478 / 27462 ms（27~42 秒）
#
# 用法（在服务器上，`ssh 43.143.239.42` 之后）：
#   bash server/scripts/verify-orders-perf.sh                 # 看最近 500 行日志的汇总
#   bash server/scripts/verify-orders-perf.sh 2000            # 看最近 2000 行
#   PM2_LOG=/root/.pm2/logs/box2bitable-server-out.log bash server/scripts/verify-orders-perf.sh
#
# 判据（她/他来看这两行数字即可）：
#   · `GET /sales/orders` 的 duration_ms **中位数** 与 **最大值** —— 改后应**明显**低于 27~42 秒；
#   · 同时确认 `liveInventory` 的整表读**不再随待补样品条数线性增长**
#     （改后每个请求**至多 1 次**；日志里没有 `liveInventory` 的逐次读事件，
#      所以这条靠"同一个 request_id 下 `bitable.record.*` 的条数"间接看，
#      或直接用下面的 `--timing` 建议（见 docs 第六节））。
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

LINES="${1:-500}"
PM2_LOG="${PM2_LOG:-}"

if [ -z "$PM2_LOG" ]; then
  # PM2 的日志路径按进程名找；找不到就列出来让人自己指定
  for candidate in \
    "$HOME/.pm2/logs/box2bitable-server-out.log" \
    "/root/.pm2/logs/box2bitable-server-out.log" \
    "/www/wwwroot/feishu-retail-ops/logs/out.log"; do
    if [ -f "$candidate" ]; then PM2_LOG="$candidate"; break; fi
  done
fi

if [ -z "$PM2_LOG" ] || [ ! -f "$PM2_LOG" ]; then
  echo "找不到 PM2 日志。请显式指定：PM2_LOG=<路径> bash $0 $LINES" >&2
  echo "（先跑 pm2 logs --nostream 或 pm2 describe box2bitable-server 看日志路径）" >&2
  exit 2
fi

echo "日志：${PM2_LOG}（最近 $LINES 行）"
echo

# ── 1. /sales/orders 的耗时分布 ──────────────────────────────────────────────
echo "── GET /sales/orders 的 duration_ms ──────────────────────────────"
tail -n "$LINES" "$PM2_LOG" \
  | grep '"event":"http.request.completed"' \
  | grep '"path":"/sales/orders"' \
  | grep -o '"duration_ms":[0-9]*' \
  | cut -d: -f2 \
  | sort -n \
  | awk '
      { v[NR]=$1; sum+=$1 }
      END {
        if (NR==0) { print "  （这段日志里没有 /sales/orders 请求）"; exit }
        printf "  次数        = %d\n", NR
        printf "  最小        = %d ms\n", v[1]
        printf "  中位数      = %d ms\n", (NR%2 ? v[(NR+1)/2] : int((v[NR/2]+v[NR/2+1])/2))
        printf "  最大        = %d ms\n", v[NR]
        printf "  平均        = %d ms\n", int(sum/NR)
        slow=0
        for (i=1;i<=NR;i++) if (v[i] > 10000) slow++
        printf "  >10s 的条数 = %d\n", slow
      }'

echo
echo "  ⚠️ 改前基线：最慢五条 42317 / 32824 / 31045 / 27478 / 27462 ms"
echo "     中位数应在数秒级；若仍普遍 >10s ⇒ 把这条日志发给 Lead（附 request_id）。"

# ── 2. 有没有撞上读重试（瞬时错误才会出现，不是性能问题）────────────────────
echo
echo "── workbench.sales.orders.read_retry（飞书瞬时错误自动重试）────────"
COUNT_RETRY=$(tail -n "$LINES" "$PM2_LOG" | grep -c 'workbench.sales.orders.read_retry' || true)
echo "  条数 = $COUNT_RETRY"
[ "$COUNT_RETRY" -gt 0 ] && echo "  （有重试 ⇒ 那一次的耗时会偏高，属飞书瞬时错误，不是本优化要管的东西）"

# ── 3. 待补样品快照读失败（是否退回了逐条读）─────────────────────────────────
echo
echo "── workbench.sales.sample_pending.live_snapshot_unreadable ────────"
COUNT_SNAP=$(tail -n "$LINES" "$PM2_LOG" | grep -c 'live_snapshot_unreadable' || true)
echo "  条数 = $COUNT_SNAP"
[ "$COUNT_SNAP" -gt 0 ] && echo "  （有 ⇒ 那几次退回「每条待办各自读一次」（待办照常显示，只是慢一点））"

echo
echo "提示：单条请求想看得更细，用 request_id 串起来："
echo "  tail -n $LINES \"$PM2_LOG\" | grep '<request_id>'"
