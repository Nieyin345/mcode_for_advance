#!/usr/bin/env bash
# 【T129】扩展线的文档诚实性回归。
#
# 这套**不 import 任何主进程实现**（除了 contracts 的 schema）—— 它读文档、读源码文本、
# 跑两次 `git grep`，验的是「文档说的和代码做的是不是一回事」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS，且要 import `@contracts/modules`）。
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t129-honesty.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t129-extension-honesty-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@contracts=../../packages/contracts/src \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
