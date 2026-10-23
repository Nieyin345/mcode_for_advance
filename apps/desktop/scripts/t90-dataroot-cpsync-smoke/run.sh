#!/usr/bin/env bash
# T90：dataRoot 的 cpSync 在非 ASCII 路径上会不会崩（子进程取证）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t90.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t90-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  --alias:electron=./scripts/t90-dataroot-cpsync-smoke/stubs/electron.ts
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts
  --log-level=error
)

# 父进程：调度器
"$ESBUILD" scripts/t90-dataroot-cpsync-smoke/main.ts \
  "${COMMON[@]}" \
  --outfile="$OUT/main.mjs"

# 子进程探针：真正碰 cpSync 的那一个
"$ESBUILD" scripts/t90-dataroot-cpsync-smoke/probe.ts \
  "${COMMON[@]}" \
  --outfile="$OUT/probe.mjs"

# 父进程通过 main.mjs 旁边的 probe.mjs 找子进程（见 main.ts 的 PROBE 常量）。
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/main.mjs"
