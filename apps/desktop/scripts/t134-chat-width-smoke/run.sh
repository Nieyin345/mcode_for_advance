#!/usr/bin/env bash
# 【T134】聊天正文 672 / 输入框 768 —— 上游 max-w-2xl / max-w-3xl 的布线。
#
# 这套不 import 产品代码、不起 Electron —— 它读 uiPrefs.ts 与 ChatPane.tsx，
# 断言两张宽度表的取值、分工与 fallback 同步。
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t134-width.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t134-chat-width-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
