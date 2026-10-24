#!/usr/bin/env bash
# 台账 MC-068 §33 的真实函数故障注入回归 —— 直接打 moveFileSafe.ts，真文件系统 +
# 对特定 fs.promises 调用注入一次 EPERM/EXDEV（见 stubs 里 stub-fs.ts）。
# 只碰本脚本自建的临时目录，绝不指向真实用户路径。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-move-file-safe-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-move-file-safe-smoke-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "esbuild is missing; install workspace dependencies before running smoke tests" >&2
  exit 1
fi

# --alias:node:fs 把生产代码里的 node:fs 换成带注入的透传代理。
# 关键：桩自己用**裸** `"fs"` import 真实实现（不被这条 alias 命中），否则会自我递归。
# moveFileSafe 只 import node:fs/path/os/crypto + 叶子模块，无需 logger/dataRoot 桩。
"$ESBUILD" scripts/move-file-safe-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:node:fs=./scripts/move-file-safe-smoke/stub-fs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
