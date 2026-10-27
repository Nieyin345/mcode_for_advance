#!/usr/bin/env bash
# 【Office 深度集成】后台编辑器视图的内存治理判据。
# 纯函数判据 + 主进程/渲染端接线的源码形状；真实 MiB 与首帧耗时不在这里（见 O18）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-office-mem.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/office-memory-governance-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
