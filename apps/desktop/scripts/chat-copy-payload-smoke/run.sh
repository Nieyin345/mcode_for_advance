#!/usr/bin/env bash
# chat-copy-payload-smoke — 消息气泡「复制」文本 vs 真正发给模型的那份(见 main.ts 文件头)。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-chat-copy-payload.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
"$ESBUILD" scripts/chat-copy-payload-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@renderer/lib/monacoSetup.js=./scripts/chat-linecount-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
