#!/usr/bin/env bash
# Headless smoke for the workflow quality gate (WF-05 schema / WF-08 import-export /
# WF-09 validation report, plan v2 G7 / Phase 4).
#
# Bundles scripts/workflow-validation-smoke/main.ts with esbuild (tsconfig paths
# apply) and runs it in plain node. The module under test is a pure function
# module: no electron, no DB, no fs — the node-type catalog is injected as a
# fixture map, which is exactly how the main process injects loadNodeTypes().
#
# 例外是后面 4g/4h 两段:它们 import 真正的内置清单(`nodeTypes.ts`)来断言**真货**
# 的文案与参数表 —— 那两件事在夹具上断言等于在测抄本。为此 run.sh 带了 stubs +
# banner,见下面的注释。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-wfvalidation-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 给 sql.js 的 asm 构建一个真的 require(同 automation-smoke / run-store-smoke)。
# 两个 `--alias` 是**对着内置节点清单那一段**加的:冒烟现在要 import
# `@main/orchestration/nodeTypes.js` 来断言真货的 `usage` 与参数表,而那个模块为了
# 「资料」下拉会读库(`loadLibraryTypes`)、为了装插件会读 Electron 的 `app`
# (transitively pulls in `electron/index.js`,它底下是 `require('fs')`)—— 在纯 node 的
# ESM 里那两样都起不来,所以按 automation-smoke 同一套把它俩换成桩。
"$ESBUILD" scripts/workflow-validation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
