#!/usr/bin/env bash
# 【MC-069】文档编辑并发一致性 —— 直接驱动生产的 agentDocumentOps(Excel/PDF/DOCX),
# 用本机 tmp 下的无意义夹具。需要既有 Python + openpyxl + pypdf + Pillow + pandoc。
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-doc-ops-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; dependencies must be prepared separately" >&2; exit 1; fi

"$ESBUILD" scripts/doc-ops-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 【MC-069 残余】跨进程 E1 夹具:另打一份**独立的子进程入口**,由 smoke 用
# `spawn(node, [$OUT/child-writer.mjs, ...])` 各起一个真 OS 进程并发改同一 Excel。
"$ESBUILD" scripts/doc-ops-smoke/child-writer.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/child-writer.mjs" --log-level=error

MCODE_DOC_OPS_CHILD_ENTRY="$OUT/child-writer.mjs" node "$OUT/smoke.mjs"
