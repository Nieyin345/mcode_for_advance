#!/usr/bin/env bash
# Headless smoke for ARC-009 的桌面刷新通知 outbox(settingSync)。纯逻辑,不碰 electron 真窗口。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-setting-notify-outbox.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# settingSync 只 import @contracts/* 与 logger —— logger 换成 stubs 里那份(不写文件、不拉 electron)。
"$ESBUILD" scripts/setting-notify-outbox-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
