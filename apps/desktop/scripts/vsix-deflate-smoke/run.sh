#!/usr/bin/env bash
# 【F002】VSIX 的 DEFLATE 读取回归。
#
# 这套**不碰磁盘、不联网** —— 自己用 `node:zlib` 造 ZIP（STORE / DEFLATE 两种），
# 直接喂 `readMinimalVsix`，验「能不能读」与「限制有没有被放宽」。
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-f002-vsix.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/vsix-deflate-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main=./src/main --alias:@contracts=../../packages/contracts/src \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
