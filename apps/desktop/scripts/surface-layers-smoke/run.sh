#!/usr/bin/env bash
# 【T121】Surface 0–3 分层回归。
#
# 这套**不 import 任何主进程代码** —— 它读 `src/renderer/styles.css`、
# `tailwind.config.js` 与几个组件源码，断言「层次关系」与「接线位置」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-surface-layers.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/surface-layers-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
