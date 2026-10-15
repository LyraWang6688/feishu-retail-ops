#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 用法：bash server/scripts/deploy_build.sh [--check-only]
#   （默认）      装依赖 → 【只读闸门：禁止写入清单】 → schema 校验（对着真 Base）
#   --check-only  只跑那条【只读闸门】（不装依赖、不校验 schema）——给用例 / 人工排查用
# ⚠️ 与 `deploy_run.sh` 的 `--check-only` 同一个先例：**加参数不改原来那条路** ✗
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    *) echo "未知参数：${arg}（可用：--check-only）" >&2; exit 2 ;;
  esac
done

cd "$PROJECT_DIR"

# ── 只读闸门：非测试环境必须配「禁止写入清单」（2026-10-15 加）───────────────────
# 起因（Lead 只读核过**线上** .env）：服务器上 `FEISHU_V1_FORBIDDEN_APP_TOKENS` /
#   `FEISHU_V1_PROD_APP_TOKEN` **都没配** ⇒ `e2e-run.mjs` / `ws-poke-event.cjs` /
#   `ws-subscribe.cjs` 的「生产 Base」闸门**在服务器上也是空转的** ✗ ——
#   而**服务器才是真正够得着生产 Base 的地方** ✗。
# 这是**配置缺口、不是代码缺陷** ⇒ 固化成部署闸门：**它自己会拦住下一次部署** ✓
#   （与既有 `v1:schema-check:*` 同一形状：先 `echo` 说明、失败即中止、只读）。
# 🔴 **只读**：只读环境变量与 `.env`（`dotenv` 默认 `override: false` ⇒ 不动已有环境变量）；
#   **不写任何 Base、不改 `.env`、不重启任何进程** ✓
# ⚠️ 判据用仓库**既有**的「测试环境」口径（与 `backfill-sales-status.mjs` / `ws-selftest.mjs` /
#   `e2e-run.mjs` 同一套，**不新造** ✗）：`FEISHU_TARGET_ENV=test`
#   **且** 目标 app_token **逐字等于** `FEISHU_V1_E2E_TEST_APP_TOKEN`（授权的测试 Base）。
#   ⇒ 只有【两边都成立】才算测试环境；**判不出"这是测试环境"时按非测试环境处理**（保守）✓
check_forbidden_tokens () {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const envPath = path.resolve(process.argv[1]);
try {
  // ⚠️ 没装依赖时（fresh clone 直接 --check-only）只按进程环境变量判定：
  //    这时 .env 里有值也会被判成"未配" ⇒ **偏保守（红）**，绝不会漏放 ✓
  if (fs.existsSync(envPath)) require("dotenv").config({ path: envPath, quiet: true });
} catch (error) {
  console.log(`  ⚠️ 读不到 dotenv（${error.message}）⇒ 只按进程环境变量判定（偏保守）。`);
}
const trim = (value) => String(value || "").trim();
const target = trim(process.env.FEISHU_V1_BITABLE_APP_TOKEN);
const authorizedTestBase = trim(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN);
const isTestEnv = trim(process.env.FEISHU_TARGET_ENV).toLowerCase() === "test"
  && Boolean(target) && Boolean(authorizedTestBase) && target === authorizedTestBase;
if (isTestEnv) {
  console.log("  ✓ 测试环境（FEISHU_TARGET_ENV=test 且目标 Base = 授权测试 Base）⇒ 这条闸门不适用，跳过。");
  process.exit(0);
}
const entries = [process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS, process.env.FEISHU_V1_PROD_APP_TOKEN]
  .flatMap((value) => String(value || "").split(","))
  .map((item) => item.trim())
  .filter(Boolean);
if (entries.length) {
  // ⚠️ 只报"配了几条"，**绝不打印 token 值**（那是凭证）。
  console.log(`  ✓ 非测试环境：禁止写入清单已配置（${entries.length} 条，值不打印）——脚本指向生产 Base 会被当场拒绝。`);
  process.exit(0);
}
console.error("  ✗ 非测试环境，但没有配「禁止写入清单」——写库 / 事件脚本的生产 Base 闸门此刻是【空转】的：");
console.error(`     · FEISHU_TARGET_ENV = ${trim(process.env.FEISHU_TARGET_ENV) || "（未设置）"}`);
console.error("     · 目标 Base 不是授权的测试 Base（或 FEISHU_V1_E2E_TEST_APP_TOKEN 未配）");
console.error("     · FEISHU_V1_FORBIDDEN_APP_TOKENS / FEISHU_V1_PROD_APP_TOKEN = 都为空");
console.error("  ⇒ 修法：在服务器 .env 里加一行（值 = 生产 Base 的 app_token，即与 FEISHU_V1_BITABLE_APP_TOKEN 同值）：");
console.error("       FEISHU_V1_FORBIDDEN_APP_TOKENS=<与 FEISHU_V1_BITABLE_APP_TOKEN 同值>");
console.error("     配好之后，任何指向生产 Base 的写库 / 事件脚本会被【当场拒绝】，而不是静默空转。");
process.exit(1);
' "$PROJECT_DIR/../.env"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Checking the write-protection list (read-only; 非测试环境必须有值)..."
  check_forbidden_tokens
  echo "(--check-only) 只跑只读闸门：跳过依赖安装与 schema 校验。"
  exit 0
fi

echo "Installing dependencies..."
pnpm install --frozen-lockfile

# 部署门槛：先拿即将上线的代码去核对线上多维表格的真实结构。
# 表结构改过但服务器没同步（或行为编码没补齐）时，这里直接失败并中止部署，
# 而不是等用户录单时才报 FieldNameNotFound / 行为配置缺失。
# 校验只读，不改任何飞书数据；需要 .env 里的目标 Base 与机器人凭证。
echo "Checking the write-protection list (read-only; 非测试环境必须有值)..."
check_forbidden_tokens

echo "Validating V1 schema against the live Base..."
pnpm run v1:schema-check:all

echo "Build completed."
