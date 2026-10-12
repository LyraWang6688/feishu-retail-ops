#!/bin/bash
# 哨兵用例「跨分钟边界偶发红」复现循环（只跑那一条用例，快）
# 用法: bash tools/sentinel-loop.sh <轮数>
cd "$(dirname "$0")/../server" || exit 1
N="${1:-120}"
LOG="/tmp/flaky-sentinel.log"
: > "$LOG"
fails=0
for i in $(seq 1 "$N"); do
  sec=$(date +%S)
  out=$(node --test --test-name-pattern=哨兵 --test-reporter=spec test/deployRunAutoEnvRefresh.test.js 2>&1)
  code=$?
  # 只在用例真的跑了的时候才判红（避免 pattern 不匹配导致的假红）
  ran=$(printf '%s' "$out" | grep -c "哨兵")
  if [ "$code" -ne 0 ]; then
    fails=$((fails+1))
    echo "RUN $i sec=:$sec exit=$code ran=$ran" >> "$LOG"
    printf '%s\n' "$out" | tail -30 >> "$LOG"
    echo "-----" >> "$LOG"
  else
    echo "RUN $i sec=:$sec exit=0 ran=$ran" >> "$LOG"
  fi
done
echo "TOTAL_RUNS=$N FAILS=$fails LOG=$LOG"
