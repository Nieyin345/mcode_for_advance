#!/usr/bin/env bash
# maint-audit-smoke —— 全计划回访(2026-09-27)直接修掉的两个跨任务遗留项的回归网:
#   §1 MINERU_PY 的 itemId 落点消毒(真 python 跑,http_json 桩掉,不联网);
#   §2 sessionStore 覆盖旧提问时先把旧 requestId 按 dismissed 回掉。
# 打包方式:§2 要真 store,照抄 session-store-smoke 的 external(monacoSetup);
# §1 只多 import 一个 @main/workflows/assets.js(自包含,mineru-py-smoke 同法)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-audit-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-audit-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
