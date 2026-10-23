#!/usr/bin/env bash
# T43: 文档 AI 设计流水线 —— 真 GenOffice CLI、真子进程、真文件。
#
# 判据：六格式读取、大文件不整读且不切半个字符、render-probe 门禁措辞、
#       docx/xlsx 创建、pptx spec 围栏、build_deck 可达性、目录一致性。
# `--mutate=no-fence` / `--mutate=no-probe` 跑变异模式。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t43-design.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t43-design-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

MUTATE_ARG=""
if [[ "${1:-}" == --mutate=* ]]; then MUTATE_ARG="$1"; fi

"$ESBUILD" scripts/t43-document-ai-design-pipeline-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs" $MUTATE_ARG
