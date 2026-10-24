#!/usr/bin/env bash
# 【T120】用户气泡超长折叠：判据 + 与上游常数对齐 + 接入检查。
# 纯函数，不需要 Electron / DOM / 数据库。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-message-collapse-smoke.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/message-collapse-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
