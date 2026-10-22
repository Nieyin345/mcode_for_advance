#!/usr/bin/env bash
# module-consent-copy-smoke — 安装权限卡按钮/脚注的时效词必须与 session 实现一致(T26)。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-module-consent-copy.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
mcode_esbuild scripts/module-consent-copy-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
