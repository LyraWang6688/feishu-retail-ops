#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "Installing dependencies..."
pnpm install --frozen-lockfile

# 部署门槛：先拿即将上线的代码去核对线上多维表格的真实结构。
# 表结构改过但服务器没同步（或行为编码没补齐）时，这里直接失败并中止部署，
# 而不是等用户录单时才报 FieldNameNotFound / 行为配置缺失。
# 校验只读，不改任何飞书数据；需要 .env 里的目标 Base 与机器人凭证。
echo "Validating V1 schema against the live Base..."
pnpm run v1:schema-check:all

echo "Build completed."
