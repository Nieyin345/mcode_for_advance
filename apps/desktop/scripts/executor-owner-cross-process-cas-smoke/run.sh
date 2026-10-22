#!/usr/bin/env bash
# 【T4】executor owner 跨进程 CAS —— 起**真实 OS 子进程**（child-owner.ts）竞争生产
# `FileExecutorOwnershipStore`，另测启动对账、崩溃回收、损坏 fail-closed、同步/异步租约同一把锁。
# 全部目录都是 mktemp 临时目录；不碰用户真实数据根（dataRoot 桩没设环境变量就抛）。
set -euo pipefail
cd "$(dirname "$0")/../.."     # → apps/desktop

mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-t4-owner-cas.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t4-owner-cas-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source scripts/lib/esbuild-path.sh
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild unavailable" >&2; exit 1; fi

"$ESBUILD" scripts/executor-owner-cross-process-cas-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 独立子进程入口：进程级夹具，与生产同一份 FileExecutorOwnershipStore。
"$ESBUILD" scripts/executor-owner-cross-process-cas-smoke/child-owner.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/child-owner.mjs" --log-level=error

MCODE_T4_CHILD_ENTRY="$OUT/child-owner.mjs" MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
