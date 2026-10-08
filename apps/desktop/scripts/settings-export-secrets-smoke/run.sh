#!/usr/bin/env bash
# settings-export-secrets-smoke — 设置导出不得带上密钥类的设置键(见 main.ts 文件头)。
#
# `settingsTransfer.ts` 是纯模块(不 import electron),esbuild 打包后直接 node 跑,
# 不需要 --alias。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-settings-export-secrets.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
"$ESBUILD" scripts/settings-export-secrets-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
