#!/usr/bin/env bash
# T107：cpSync 的第三种形态 —— 非 ASCII 源 + 目标已有同名文件。
#
# 父进程（main.ts）自己从不碰非 ASCII 的 cpSync，只 spawnSync 探针读输出。
# 探针是 .mjs，不需要 esbuild —— 它只用 node:fs。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t107.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

# 父进程要 TS → 打包；探针是纯 JS，直接拷过去（它靠 __dirname 找同目录）。
"$ESBUILD" scripts/t107-cpsync-preexisting-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/main.mjs" --log-level=error

cp scripts/t107-cpsync-preexisting-smoke/probe.mjs "$OUT/probe.mjs"

node "$OUT/main.mjs"
