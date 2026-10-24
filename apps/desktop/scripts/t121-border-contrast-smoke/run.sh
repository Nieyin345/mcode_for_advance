#!/usr/bin/env bash
# 【T121】边框层级对比度回归。
#
# 这套**不 import 任何主进程代码** —— 它只读 `src/renderer/styles.css`，
# 算 WCAG 对比度，断言「关系」而不是「值」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t121-border.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t121-border-contrast-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
