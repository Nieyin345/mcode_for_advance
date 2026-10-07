#!/usr/bin/env bash
# Headless smoke for 监控采集(main/monitoring 三件套,PAR-C / v2 §4-G6)。
#
# 不碰数据库也不碰 electron:数据根由 deps 注入到 mktemp 目录,logger 换成
# stderr 桩(见 stubs/logger.ts)。单进程即可 —— 持久化验的是 NDJSON 文件
# 本身(写入后按行重读,坏行跳过),不需要跨进程。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-monitoring-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# stubs 换掉 import 了 electron 的 logger;@contracts 与其余 @main/* 走 tsconfig
# 的 paths(与 runtime-state-smoke 同一套)。
"$ESBUILD" scripts/monitoring-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/monitoring-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
