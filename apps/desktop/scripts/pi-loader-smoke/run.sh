#!/usr/bin/env bash
# piSdkLoader 文案语言回归。只驱动真 loadPiSdk 的两条失败路径:托管安装加载失败、
# 裸 specifier 装不上。换桩:logger(真模块拉 electron)、managedRuntimeRoots(取
# userData 根)、以及裸 pi specifier(本机 node_modules 里装着,必须桩成装不上)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pi-loader-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/pi-loader-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/runtimes/managedRuntimeRoots.js=./scripts/pi-loader-smoke/stubs/managedRuntimeRoots.ts \
  --alias:@earendil-works/pi-coding-agent=./scripts/pi-loader-smoke/stubs/piMissing.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
