#!/usr/bin/env bash
# 【T128】hover / active 分档回归。
#
# 这套**不 import 主进程代码** —— 只读 `src/renderer/styles.css`、
# `tokens.cds.css`、`components/ui/button.tsx`、`tailwind.config.js`，
# 算 WCAG 对比度并断言**关系**（active ≠ hover、阶梯单调、类真的接上）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t128-hover.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

mcode_esbuild scripts/t128-hover-active-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
