#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-nav-motion.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
# 【T64】真 import TabBarChrome 的 handleTabListKeyDown 做行为断言（不再读源码文本）。
# monaco 装配与本次判据无关，换空壳只是让它能被 bundle —— 仓库既有做法，见
# chat-copy-payload-smoke/run.sh 的同名 alias。
"$ESBUILD" scripts/arc005-navigation-motion-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@renderer/lib/monacoSetup.js=./scripts/chat-linecount-smoke/monaco-stub.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
