#!/usr/bin/env bash
# Headless smoke for **引擎报上来的命令清单** —— 见 main.ts 文件头。
#
# 适配器可以在无头下直接实例化(只 import 契约包 + fileSnapshot,后者是纯 fs),
# 所以这一套不用桩、不用临时数据根:造一个 ctx 收事件,喂真实的 SDK 消息进去,
# 看事件有没有出来。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-engine-commands-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/engine-commands-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
