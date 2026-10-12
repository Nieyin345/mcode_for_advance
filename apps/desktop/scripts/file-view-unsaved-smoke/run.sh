#!/usr/bin/env bash
# file-view-unsaved-smoke — 【UI-012】fileViewStore 的「有未保存改动就拦住离开」契约。
#
# 纯 zustand store(不需要 React 渲染):直接驱动 open()/close() 的离开确认闸、
# 「保存我」回调的登记与调用。不起浏览器、不写盘。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-file-view-unsaved.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/file-view-unsaved-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
