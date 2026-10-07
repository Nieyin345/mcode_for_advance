#!/usr/bin/env bash
# MAINT-2026-09 / M01 的独占探针套件(只由 M01 这个对话维护)。
#
# 与既有两套的分工:db-migrate-smoke 走"老库升级补列",db-persistence-smoke 走
# "写盘失败的保全/重试/去重";这一套走**导出之后外键级联是否真的还在触发**、
# **关闭→重开的一致性**与**未完成运行的重启归位**。
#
# 真建库、真落盘、真重开,但数据根是 mktemp 出来的临时目录(见 stubs/dataRoot.ts:
# 环境变量没设就抛 —— 指错地方等于拿空库盖掉用户的聊天记录)。不联网、不起 Electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m01-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-maint-m01-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild 是 vite 的传递依赖(不是直接依赖),找不到再退回 npx。
source "$(dirname "$0")/../lib/esbuild-path.sh"

# banner 那一行是给 sql.js 的 asm 构建用的(它内部 require("node:fs"),而 ESM 输出
# 没有 require)。electron 相关的两个模块换成 stubs/,被测代码一行未改。
"$ESBUILD" scripts/maint-m01-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/maint-m01-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/maint-m01-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"

