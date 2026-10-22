#!/usr/bin/env bash
# T24: 文档 AI 工具面（发现 / Markdown 载体 / QA 门禁 / 出图）—— 真 GenOffice CLI、真子进程、真文件。
#
# 判据：编辑后必须回 qa（detail.issues）；render 必须出真 PNG；Markdown 表格不许退化。
# `--mutate` 跑变异模式（把 runQaGate 换成恒 null），要求进程以 1 退出并出现 ★ 变异的 FAIL。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t24-tool-surface.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t24-tool-surface-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

MUTATE_ARG=""
if [[ "${1:-}" == "--mutate" ]]; then MUTATE_ARG="--mutate=no-qa"; fi

"$ESBUILD" scripts/t24-document-tool-surface-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs" $MUTATE_ARG
