#!/usr/bin/env bash
# subagent-usage-i18n-smoke — 子代理用量串上的硬编码英文(见 main.ts 文件头)。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-subagent-usage-i18n.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
"$ESBUILD" scripts/subagent-usage-i18n-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@tabler/icons-react=./scripts/subagent-usage-i18n-smoke/iconsStub.cjs \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
