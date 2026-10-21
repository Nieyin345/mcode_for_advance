#!/usr/bin/env bash
# 【ARC-006 Gate C 第一片】WorkflowDoc → Node-RED flow 迁移器（纯函数）+ 无损备份。
# 不联网、不起 Electron、不碰用户数据根：备份指向本套自己的 mktemp 目录。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-flow-migration.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-flow-migration-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "scripts/lib/esbuild-path.sh"

# 【T10 后续】本套现在还 import `executorOwnership`，它拉进落盘实现
# （`fileExecutorOwnershipStore.ts`），后者 import `@main/lib/dataRoot.js` 与
# `@main/lib/logger.js` —— 两个都 import electron，无头里跑不起来。
# 与其它套件一致：两个换桩，并给 esbuild 补 require/__dirname。
# DATA 同时喂给 MCODE_FLOW_MIGRATION_DATA（备份落盘）与 MCODE_SMOKE_DATA_ROOT（dataRoot 桩）。
mcode_esbuild scripts/flow-migration-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_FLOW_MIGRATION_DATA="$DATA" MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
