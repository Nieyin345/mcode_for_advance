#!/usr/bin/env bash
set -euo pipefail
# HERE 必须在 cd 之前算好：cd 之后 $0 仍是调用者给的相对路径，
# 用它拼路径会得到 apps/desktop/apps/desktop/... 这样的假红。
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"

# 多工作表 fixture 是**生成物**（不入库）：它由 python 手写 OOXML，
# 保证没有 openpyxl 依赖。生成失败不算套件失败 —— main.ts 会打印 SKIP，
# 不会把「没跑」说成「通过」。
FIXTURES="$HERE/fixtures"
if [ ! -f "$FIXTURES/multi-sheet.xlsx" ]; then
  for py in python python3 py; do
    if "$py" -X utf8 "$HERE/multi-sheet-fixture.py" "$FIXTURES" >/dev/null 2>&1; then break; fi
  done
fi

OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-library-index.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/library-document-index-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
