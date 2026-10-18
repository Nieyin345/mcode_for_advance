#!/usr/bin/env bash
# 【ARC-006 Gate E】宿主侧可执行体清单（engineNodeRegistry）的无头回归：
# 安装审核 / 卸载事务 / pending-remove 恢复 / network 共享判据 / 坏清单 fail-closed。
# 见 main.ts 文件头。
#
# 本套件不碰 sql.js / 设置表，也不 import electron：清单只读写套件自己 mktemp 出来的
# 引擎数据目录。dataRoot/logger 桩照例挂上 —— 万一被测链路上有模块意外触碰数据根，
# 会在没设 MCODE_SMOKE_DATA_ROOT 时直接抛，不会回落到用户真数据。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-engine-node-registry.XXXXXX")
DATA=$(mktemp -d "${TMPDIR:-/tmp}/mcode-engine-node-registry-data.XXXXXX")
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/engine-node-registry-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
