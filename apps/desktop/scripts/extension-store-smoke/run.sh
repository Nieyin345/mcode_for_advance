#!/usr/bin/env bash
# 扩展专用数据区(报告 E12)的无头 smoke —— `@contracts/extensionStore` 的形状/校验/
# 配额,以及 `main/lib/extensionStore.ts` 的磁盘读写与 `main/ipc/extensions.ts` 的三条 handler。
#
# 桩:dataRoot(真那个 import electron)。@main/lib/extensionStore.ts 会用 appContext 的
# atomicWrite(纯 node:fs,不 import electron),所以不用换桩。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-extension-store.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-extension-store-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/extension-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/extension-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
