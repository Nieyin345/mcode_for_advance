#!/usr/bin/env bash
# 【F005】闭环五环：装 → 列出 → 调用 → 结果正确 → 卸载。
#
# 隔离方式照抄 vscode-l1-smoke：临时 dataRoot + 临时 egress consent 存储，
# 不碰真实用户数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-vsix-e2e.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
mcode_esbuild scripts/vsix-end-to-end-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
