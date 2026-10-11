#!/usr/bin/env bash
# hooks-native-note-smoke — 钩子面板「原生 hooks 不在这里生效」那句说明是否存在且完整
# (见 main.ts 文件头)。打包真 i18n core,读 HooksPanel 源码,不起浏览器、不写盘。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-hooks-native-note.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
"$ESBUILD" scripts/hooks-native-note-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
