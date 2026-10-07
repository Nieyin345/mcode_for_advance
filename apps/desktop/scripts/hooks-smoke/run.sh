#!/usr/bin/env bash
# Headless smoke for the hook capability (matching + the hooks.json format).
#
# Everything asserted is pure — no electron, no DOM, no filesystem. See main.ts for
# what is and is not covered (HookRunner itself is exercised by hand).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-hooks-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 存放层(`main/hooks/store.ts`)真的会写文件,所以这一份是真的跑 —— 只是把它脚下的
# 数据根换成临时目录。那两个模块 import 了 electron,换掉(见 stubs/)。
"$ESBUILD" scripts/hooks-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/hooks-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/hooks-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
