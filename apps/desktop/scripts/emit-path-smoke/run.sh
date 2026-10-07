#!/usr/bin/env bash
# Headless smoke for **事件发出点的通路选择** —— 见 main.ts 文件头。
#
# 这一套不装任何东西:它扫主进程源码,把「谁把事件发出去、走的是哪条路」找出来,
# 再拿 `HOOK_EVENT_OF` 对账。所以没有桩、没有临时数据根 —— 它读的就是仓库里
# 那份源码,读不到就应该红(那说明文件挪走了,不是"没得测")。
#
# 因为只 import 契约包(不 import 任何 `@main/*`),esbuild 不会碰到 electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-emit-path-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/emit-path-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
