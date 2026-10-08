#!/usr/bin/env bash
# Headless smoke for **同一件浏览器工具三个 provider 的入参必须一致** —— 见 main.ts 文件头。
#
# 这一套是**源级不变量**:不跑代码、不起 Electron、不连网。它读三份 provider 源码
# (`claude-sdk` / `codex-sdk` / `pi-sdk`)再互相对账,所以没有桩、没有数据根 ——
# 文件挪走了就应该红(说明扫描器看不懂了,得补它)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-tool-parity.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/browser-tool-parity-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
