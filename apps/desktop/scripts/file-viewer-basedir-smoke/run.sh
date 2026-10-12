#!/usr/bin/env bash
# file-viewer-basedir-smoke — 【MC-086】目录 linked 里翻进子文件时,图片 baseDir 必须是
# 该 md 自己所在目录。直接驱动导出的 loadViewData(只依赖 api.library.*/api.file.*,无头换桩)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-file-viewer-basedir.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/file-viewer-basedir-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/file-viewer-basedir-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/file-viewer-basedir-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/file-viewer-basedir-smoke/iconsStub.cjs \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
